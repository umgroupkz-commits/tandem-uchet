-- 0049: меню заказов клиентов — бот приёма заказов Енешки
-- (docs/superpowers/specs/2026-10-16-eneshka-order-bot-design.md). Своя цена для заказов, отметка
-- «цена сверена» (без неё бот позицию не видит), стоп-лист, настройки окон готовности и доставки,
-- раздел бэк-офиса clients и служебное действие bot_menu.

create table if not exists tandem.order_menu (
  item_code        text primary key references tandem.items(code) on update cascade on delete cascade,
  title_ru         text not null check (btrim(title_ru) <> ''),
  title_kz         text,
  composition_ru   text,
  composition_kz   text,
  unit_label       text not null default 'шт' check (unit_label in ('кг', 'шт', 'сет')),
  price            numeric(12,2) not null check (price > 0),
  min_qty          numeric(10,3) not null default 1 check (min_qty > 0),
  step             numeric(10,3) not null default 1 check (step > 0),
  section          text not null default 'Выпечка' check (btrim(section) <> ''),
  ready_kind       text not null default 'stock' check (ready_kind in ('fresh', 'stock')),
  price_checked_by text,
  price_checked_at timestamptz,
  stop_until       date,
  sort_order       int not null default 0,
  active           boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       text
);
alter table tandem.order_menu enable row level security;
revoke all on tandem.order_menu from public;

insert into tandem.settings (key, value) values
  ('client_fresh_cutoff', '12:00'), ('client_fresh_ready', '18:00'), ('stock_ready_minutes', '120'),
  ('client_min_order', '7000'), ('client_hours_from', '09:00'), ('client_hours_to', '18:00'),
  ('client_max_days_ahead', '14'), ('client_pickup_points', 'eneshka'), ('client_prepay_rule', 'off'),
  ('client_confirm_remind_min', '15'), ('client_confirm_client_notice_min', '30'),
  ('kaspi_details_ru', ''), ('kaspi_details_kz', ''), ('couriers', ''),
  ('bot_key_hash', '')   -- sha256 ключа бота; пусто — bot_* принимают служебный ключ
on conflict (key) do nothing;

create or replace function tandem.setting(p_key text, p_default text default null)
returns text language sql stable set search_path to 'tandem', 'public' as $$
  select coalesce((select nullif(value, '') from tandem.settings where key = p_key), p_default)
$$;

create or replace function tandem.client_settings()
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from tandem.settings
   where key like 'client\_%' or key in ('stock_ready_minutes', 'kaspi_details_ru', 'kaspi_details_kz', 'couriers')
$$;

-- Строка меню для бэк-офиса; бот получает её же без цены кассы и служебных полей (cmenu_bot).
create or replace function tandem.cmenu_json(m tandem.order_menu)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('item_code', m.item_code, 'item_name', i.name, 'item_ok', coalesce(i.active and i.for_sale, false),
    'title_ru', m.title_ru, 'title_kz', m.title_kz, 'composition_ru', m.composition_ru, 'composition_kz', m.composition_kz,
    'unit_label', m.unit_label, 'price', m.price, 'min_qty', m.min_qty, 'step', m.step, 'section', m.section,
    'ready_kind', m.ready_kind, 'checked', m.price_checked_at is not null,
    'price_checked_by', m.price_checked_by, 'price_checked_at', m.price_checked_at,
    'stop_until', m.stop_until, 'stopped', m.stop_until is not null and m.stop_until >= tandem.local_now()::date,
    'sort_order', m.sort_order, 'active', m.active, 'updated_by', m.updated_by,
    'kassa_price', coalesce((select pp.price from tandem.item_prices pp where pp.point_id = 'eneshka' and pp.item_code = m.item_code), i.price))
  from tandem.items i where i.code = m.item_code
$$;

-- Стоп «сегодня нет»: до даты включительно; пустая дата снимает стоп. Ставят бэк-офис и точка.
create or replace function tandem.cmenu_stop(p_code text, p_until text, p_by text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_d date;
begin
  if nullif(btrim(coalesce(p_until, '')), '') is not null then
    v_d := tandem.to_date(p_until);
    if v_d is null then return tandem.err('validation', 'Дата стопа не похожа на дату'); end if;
  end if;
  update tandem.order_menu set stop_until = v_d, updated_at = now(), updated_by = left(p_by, 100) where item_code = p_code;
  if not found then return tandem.err('not_found', 'Позиции нет в меню заказов'); end if;
  return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(m) from tandem.order_menu m where m.item_code = p_code));
end $$;

-- Меню для бота: только включённое, сверенное и продаваемое; стоп виден флагом stopped.
create or replace function tandem.cmenu_bot()
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('ok', true,
    'now', to_char(tandem.local_now(), 'YYYY-MM-DD"T"HH24:MI'),
    'settings', tandem.client_settings(),
    'points', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order)
                          from tandem.points p
                         where p.id = any(string_to_array(replace(tandem.setting('client_pickup_points', 'eneshka'), ' ', ''), ','))), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(tandem.cmenu_json(m) - 'kassa_price' - 'price_checked_by' - 'price_checked_at' - 'item_name' - 'updated_by' - 'item_ok'
                                        order by m.section, m.sort_order, m.title_ru)
                         from tandem.order_menu m join tandem.items i on i.code = m.item_code
                        where m.active and m.price_checked_at is not null and i.active and i.for_sale and not i.training), '[]'::jsonb))
$$;

-- Раздел бэк-офиса «Заказы клиентов». Действия corder_* — в tandem.office_corders (0050).
create or replace function tandem.office_clients(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_code  text := nullif(btrim(coalesce(payload->>'item_code', '')), '');
  v_price numeric;
  v_min   numeric;
  v_step  numeric;
  v_unit  text := coalesce(nullif(payload->>'unit_label', ''), 'шт');
  v_kind  text := coalesce(nullif(payload->>'ready_kind', ''), 'stock');
  k text; v text;
begin
  if action like 'corder%' then return tandem.office_corders(action, payload, v_user); end if;

  if action = 'cmenu_list' then
    return jsonb_build_object('ok', true, 'settings', tandem.client_settings(),
      'rows', coalesce((select jsonb_agg(tandem.cmenu_json(m) order by m.section, m.sort_order, m.title_ru) from tandem.order_menu m), '[]'::jsonb));
  end if;

  if action = 'cmenu_save' then
    if v_code is null or not exists (select 1 from tandem.items where code = v_code and active and for_sale) then
      return tandem.err('validation', 'Позиция не найдена или не в продаже — в меню заказов только то, что продаётся'); end if;
    v_price := tandem.to_num(payload->>'price');
    if v_price is null or v_price <= 0 then return tandem.err('validation', 'Цена для заказов — число больше нуля'); end if;
    if nullif(btrim(coalesce(payload->>'title_ru', '')), '') is null then return tandem.err('validation', 'Название для клиента обязательно'); end if;
    if v_unit not in ('кг', 'шт', 'сет') then return tandem.err('validation', 'Единица — кг, шт или сет'); end if;
    if v_kind not in ('fresh', 'stock') then return tandem.err('validation', 'Готовность — «печём под заказ» или «с витрины»'); end if;
    v_min := coalesce(tandem.to_num(payload->>'min_qty'), 1);
    v_step := coalesce(tandem.to_num(payload->>'step'), 1);
    if v_min <= 0 or v_step <= 0 then return tandem.err('validation', 'Минимум и шаг — больше нуля'); end if;
    if v_unit <> 'кг' and (v_min <> trunc(v_min) or v_step <> trunc(v_step)) then
      return tandem.err('validation', 'У штучного и сетов минимум и шаг — целые'); end if;
    insert into tandem.order_menu as m (item_code, title_ru, title_kz, composition_ru, composition_kz, unit_label, price,
                                        min_qty, step, section, ready_kind, sort_order, active, updated_at, updated_by)
    values (v_code, btrim(payload->>'title_ru'), nullif(btrim(coalesce(payload->>'title_kz', '')), ''),
            nullif(btrim(coalesce(payload->>'composition_ru', '')), ''), nullif(btrim(coalesce(payload->>'composition_kz', '')), ''),
            v_unit, v_price, v_min, v_step, coalesce(nullif(btrim(coalesce(payload->>'section', '')), ''), 'Выпечка'), v_kind,
            coalesce((payload->>'sort_order')::int, 0), coalesce((payload->>'active')::boolean, true), now(), v_user.login)
    on conflict (item_code) do update set
      title_ru = excluded.title_ru, title_kz = excluded.title_kz, composition_ru = excluded.composition_ru,
      composition_kz = excluded.composition_kz, unit_label = excluded.unit_label, price = excluded.price,
      min_qty = excluded.min_qty, step = excluded.step, section = excluded.section, ready_kind = excluded.ready_kind,
      sort_order = excluded.sort_order, active = excluded.active, updated_at = now(), updated_by = excluded.updated_by,
      -- смена цены снимает отметку «сверена»: новую цену кто-то должен подтвердить заново
      price_checked_at = case when m.price = excluded.price then m.price_checked_at end,
      price_checked_by = case when m.price = excluded.price then m.price_checked_by end;
    return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(x) from tandem.order_menu x where x.item_code = v_code));
  end if;

  if action = 'cmenu_check' then
    update tandem.order_menu set price_checked_at = now(), price_checked_by = left(v_user.name, 100) where item_code = v_code;
    if not found then return tandem.err('not_found', 'Позиции нет в меню заказов'); end if;
    return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(x) from tandem.order_menu x where x.item_code = v_code));
  end if;

  if action = 'cmenu_stop' then
    return tandem.cmenu_stop(v_code, payload->>'until', v_user.login);
  end if;

  if action = 'client_settings_save' then
    if v_user.role not in ('owner', 'admin') then return tandem.err('forbidden', 'Настройки заказов меняют собственник и администратор'); end if;
    if jsonb_typeof(payload->'values') is distinct from 'object' then return tandem.err('validation', 'Нет значений'); end if;
    for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(payload->'values') loop
      if k in ('client_fresh_cutoff', 'client_fresh_ready', 'client_hours_from', 'client_hours_to') then
        if v !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return tandem.err('validation', 'Время — ЧЧ:ММ: ' || k); end if;
      elsif k in ('stock_ready_minutes', 'client_min_order', 'client_max_days_ahead', 'client_confirm_remind_min', 'client_confirm_client_notice_min') then
        if v !~ '^[0-9]{1,7}$' then return tandem.err('validation', 'Целое число: ' || k); end if;
      elsif k = 'client_prepay_rule' then
        if v not in ('off', 'fresh') and v !~ '^from_sum:[0-9]{1,7}$' then return tandem.err('validation', 'Предоплата — off, fresh или from_sum:N'); end if;
      elsif k = 'client_pickup_points' then
        if v = '' or exists (select 1 from unnest(string_to_array(replace(v, ' ', ''), ',')) p(id)
                              where not exists (select 1 from tandem.points x where x.id = p.id)) then
          return tandem.err('validation', 'Точки выдачи — коды существующих точек через запятую'); end if;
      elsif k in ('kaspi_details_ru', 'kaspi_details_kz', 'couriers') then
        if length(v) > 500 then return tandem.err('validation', 'Не длиннее 500 знаков: ' || k); end if;
      else
        return tandem.err('validation', 'Неизвестная настройка: ' || k);
      end if;
    end loop;
    insert into tandem.settings (key, value)
      select key, btrim(coalesce(value, '')) from jsonb_each_text(payload->'values')
    on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true, 'settings', tandem.client_settings());
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- Права раздела: смотреть — собственник, администратор, технолог, бухгалтер; править — без бухгалтера.
insert into tandem.role_permissions (role, section, action) values
  ('owner', 'clients', 'view'), ('owner', 'clients', 'edit'),
  ('admin', 'clients', 'view'), ('admin', 'clients', 'edit'),
  ('technologist', 'clients', 'view'), ('technologist', 'clients', 'edit'),
  ('accountant', 'clients', 'view')
on conflict do nothing;

-- tandem_office: раздел clients по имени действия и его диспетчер.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_office(text,jsonb)'::regprocedure);
  if position('''clients''' in d) > 0 then raise notice '0049: tandem_office уже знает раздел clients'; return; end if;
  n := replace(d, $a$    when action like 'user%'         then 'users'
  end;$a$, $a$    when action like 'user%'         then 'users'
    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'
  end;$a$);
  if n = d then raise exception '0049: якорь разделов tandem_office не найден — правку сделать вручную'; end if;
  d := n;
  n := replace(d, $a$  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;$a$, $a$  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  elsif v_section = 'clients' then
    return tandem.office_clients(action, payload, v_user);
  end if;$a$);
  if n = d then raise exception '0049: якорь диспетчера tandem_office не найден — правку сделать вручную'; end if;
  execute n;
end $mig$;

-- tandem_gate: служебное действие bot_menu (ключ бота — тот же служебный ключ settings.service_key_hash).
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_gate(text,jsonb)'::regprocedure);
  if position('''bot_menu''' in d) > 0 then raise notice '0049: tandem_gate уже знает bot_menu'; return; end if;
  n := replace(d, $a$'set_packaging','set_short_list');$a$, $a$'set_packaging','set_short_list','bot_menu');$a$);
  if n = d then raise exception '0049: якорь списка служебных действий tandem_gate не найден'; end if;
  d := n;
  -- ключ бота: при заданном bot_key_hash действия bot_* сверяются с ним, остальные — со служебным
  n := replace(d, $a$    select value into v_hash from tandem.settings where key = 'service_key_hash';$a$,
    $a$    select value into v_hash from tandem.settings
     where key = case when action like 'bot\_%' and coalesce((select value from tandem.settings where key = 'bot_key_hash'), '') <> ''
                      then 'bot_key_hash' else 'service_key_hash' end;$a$);
  if n = d then raise exception '0049: якорь выбора ключа tandem_gate не найден'; end if;
  d := n;
  n := replace(d, $a$coalesce(payload->'codes','[]'::jsonb))
    end;$a$, $a$coalesce(payload->'codes','[]'::jsonb))
      when 'bot_menu'       then tandem.cmenu_bot()
    end;$a$);
  if n = d then raise exception '0049: якорь case служебных действий tandem_gate не найден'; end if;
  execute n;
end $mig$;
