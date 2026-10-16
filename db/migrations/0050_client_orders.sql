-- 0050: заказы клиентов — бот приёма заказов Енешки. Заказ живёт только здесь; бот создаёт его
-- служебным ключом, точка и Telegram-кнопки двигают статусы по таблице переходов, журнал
-- client_order_events — источник «что изменилось» для бота (читает «события после номера N»).

create table if not exists tandem.client_orders (
  id               bigserial primary key,
  uid              uuid not null unique,
  no               int not null,
  no_date          date not null,
  point_id         text not null references tandem.points(id),
  channel          text not null default 'whatsapp' check (channel in ('whatsapp')),
  uzel_dialog_id   text,
  client_phone     text not null check (client_phone ~ '^[0-9]{10,15}$'),
  client_name      text,
  lang             text not null default 'ru' check (lang in ('ru', 'kz')),
  kind             text not null check (kind in ('delivery', 'pickup')),
  address          text,
  comment          text,
  for_date         date not null,
  ready_by         time not null,
  total            numeric(12,2) not null check (total >= 0),
  delivery_fee     numeric(12,2) not null default 0,
  prepay_suggested boolean not null default false,
  prepay_required  boolean not null default false,
  pay_kind         text check (pay_kind in ('cash', 'kaspi_qr', 'transfer', 'card')),
  courier          text,
  status           text not null default 'new' check (status in ('new', 'awaiting_prepay', 'paid', 'confirmed', 'cooking', 'assembled',
                     'handed_to_courier', 'on_the_way', 'delivered', 'awaiting_pickup', 'issued', 'rejected', 'cancelled', 'not_collected')),
  reason           text,
  check_uid        uuid,
  confirmed_by     text,
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (no_date, no)
);
create index if not exists client_orders_point_date_idx on tandem.client_orders (point_id, for_date);
create index if not exists client_orders_phone_idx on tandem.client_orders (client_phone, created_at desc);

create table if not exists tandem.client_order_lines (
  id        bigserial primary key,
  order_id  bigint not null references tandem.client_orders(id) on delete cascade,
  item_code text not null references tandem.items(code) on update cascade,
  title     text not null,
  unit      text not null,
  qty       numeric(10,3) not null check (qty > 0),
  price     numeric(12,2) not null check (price >= 0),
  sum       numeric(12,2) not null
);
create index if not exists client_order_lines_order_idx on tandem.client_order_lines (order_id);

create table if not exists tandem.client_order_events (
  id          bigserial primary key,
  order_id    bigint not null references tandem.client_orders(id) on delete cascade,
  at          timestamptz not null default now(),
  status_from text,
  status_to   text not null,
  by_kind     text not null check (by_kind in ('bot', 'point', 'office', 'telegram')),
  by_name     text not null,
  payload     jsonb not null default '{}'::jsonb
);
create index if not exists client_order_events_order_idx on tandem.client_order_events (order_id);

create table if not exists tandem.client_order_moves (
  status_from text not null,
  status_to   text not null,
  kinds       text[] not null,
  need        text check (need in ('reason', 'courier', 'pay')),
  only_kind   text check (only_kind in ('delivery', 'pickup')),
  primary key (status_from, status_to)
);
insert into tandem.client_order_moves (status_from, status_to, kinds, need, only_kind) values
  ('new', 'confirmed', '{point,telegram}', null, null),
  ('new', 'awaiting_prepay', '{point,telegram}', null, null),
  ('new', 'rejected', '{point,telegram}', 'reason', null),
  ('new', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('awaiting_prepay', 'paid', '{point,telegram}', null, null),
  ('awaiting_prepay', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('paid', 'cooking', '{point,telegram,office}', null, null),
  ('paid', 'cancelled', '{point,telegram}', 'reason', null),
  ('confirmed', 'cooking', '{point,telegram,office}', null, null),
  ('confirmed', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('cooking', 'assembled', '{point,telegram,office}', null, null),
  ('cooking', 'cancelled', '{point,telegram}', 'reason', null),
  ('assembled', 'handed_to_courier', '{point,telegram}', 'courier', 'delivery'),
  ('assembled', 'awaiting_pickup', '{point,telegram}', null, 'pickup'),
  ('assembled', 'cancelled', '{point,telegram}', 'reason', null),
  ('handed_to_courier', 'on_the_way', '{point,telegram}', null, 'delivery'),
  ('handed_to_courier', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('handed_to_courier', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('handed_to_courier', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('on_the_way', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('awaiting_pickup', 'issued', '{point,telegram}', 'pay', 'pickup'),
  ('awaiting_pickup', 'not_collected', '{point,telegram}', 'reason', 'pickup'),
  ('awaiting_pickup', 'cancelled', '{point,telegram}', 'reason', 'pickup')
on conflict do nothing;

alter table tandem.client_orders enable row level security;
alter table tandem.client_order_lines enable row level security;
alter table tandem.client_order_events enable row level security;
alter table tandem.client_order_moves enable row level security;
revoke all on tandem.client_orders, tandem.client_order_lines, tandem.client_order_events, tandem.client_order_moves from public;

create or replace function tandem.corder_status_name(p text)
returns text language sql immutable as $$
  select case p when 'new' then 'новый' when 'awaiting_prepay' then 'ждёт предоплаты' when 'paid' then 'оплачен'
    when 'confirmed' then 'подтверждён' when 'cooking' then 'готовится' when 'assembled' then 'собран'
    when 'handed_to_courier' then 'передан курьеру' when 'on_the_way' then 'в пути' when 'delivered' then 'доставлен'
    when 'awaiting_pickup' then 'ждёт клиента' when 'issued' then 'выдан' when 'rejected' then 'отказ'
    when 'cancelled' then 'отменён' when 'not_collected' then 'не забрали' else p end
$$;

-- Статусы, в которых заказ уже должна делать кухня (план и акт).
create or replace function tandem.corder_kitchen()
returns text[] language sql immutable as $$
  select array['confirmed', 'paid', 'cooking', 'assembled', 'handed_to_courier', 'on_the_way', 'delivered',
               'awaiting_pickup', 'issued', 'not_collected']
$$;

-- Проверка и расчёт заказа: единственное место правил (окна готовности, минимум, шаг, стоп, доставка).
-- Бот зовёт её как bot_order_quote до «да» клиента; создание и правка — через неё же.
create or replace function tandem.corder_check(payload jsonb)
returns jsonb language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_now    timestamp := tandem.local_now();
  v_today  date := v_now::date;
  v_date   date := tandem.to_date(payload->>'for_date');
  v_ready  time;
  v_kind   text := coalesce(payload->>'kind', '');
  v_point  text := nullif(btrim(coalesce(payload->>'point_id', '')), '');
  v_points text[] := string_to_array(replace(tandem.setting('client_pickup_points', 'eneshka'), ' ', ''), ',');
  v_from   time := tandem.setting('client_hours_from', '09:00')::time;
  v_to     time := tandem.setting('client_hours_to', '18:00')::time;
  v_cut    time := tandem.setting('client_fresh_cutoff', '12:00')::time;
  v_fready time := tandem.setting('client_fresh_ready', '18:00')::time;
  v_mins   int := tandem.setting('stock_ready_minutes', '120')::int;
  v_days   int := tandem.setting('client_max_days_ahead', '14')::int;
  v_min    numeric := tandem.setting('client_min_order', '7000')::numeric;
  v_rule   text := tandem.setting('client_prepay_rule', 'off');
  v_lines  jsonb := '[]'::jsonb;
  v_total  numeric := 0;
  v_fresh  boolean := false;
  v_stock  boolean := false;
  v_first  timestamp;
  v_qty    numeric;
  x        jsonb;
  m        record;
begin
  begin v_ready := (payload->>'ready_by')::time; exception when others then v_ready := null; end;
  if v_kind not in ('delivery', 'pickup') then return tandem.err('validation', 'Способ получения — доставка или самовывоз'); end if;
  v_point := coalesce(v_point, v_points[1]);
  if not (v_point = any(v_points) or left(v_point, 3) = 'zz_') or not exists (select 1 from tandem.points where id = v_point) then
    return tandem.err('validation', 'Эта точка заказы не выдаёт'); end if;
  if v_date is null or v_date < v_today or v_date > v_today + v_days then
    return tandem.err('validation', format('Дата заказа — с сегодняшнего дня и не дальше %s дней', v_days)); end if;
  if v_ready is null or v_ready < v_from or v_ready > v_to then
    return tandem.err('validation', format('Время готовности — с %s до %s', to_char(v_from, 'HH24:MI'), to_char(v_to, 'HH24:MI'))); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
    return tandem.err('validation', 'В заказе нет позиций'); end if;

  for x in select * from jsonb_array_elements(payload->'lines') loop
    select mm.*, (i.active and i.for_sale and not i.training) as sellable into m
      from tandem.order_menu mm join tandem.items i on i.code = mm.item_code
     where mm.item_code = x->>'item_code';
    if m.item_code is null or not m.active or m.price_checked_at is null or not m.sellable then
      return tandem.err('validation', 'Позиции нет в меню заказов: ' || coalesce(x->>'item_code', '—')); end if;
    if m.stop_until is not null and m.stop_until >= v_date then
      return tandem.err('stopped', format('«%s» на %s нет', m.title_ru, to_char(v_date, 'DD.MM'))); end if;
    v_qty := round(tandem.to_num(x->>'qty'), 3);   -- как хранится (numeric(10,3)): сумма считается от того же числа
    if v_qty is null or v_qty <= 0 then return tandem.err('validation', format('Количество «%s» — число больше нуля', m.title_ru)); end if;
    if m.unit_label <> 'кг' and v_qty <> trunc(v_qty) then return tandem.err('validation', format('«%s» — только целым числом', m.title_ru)); end if;
    if v_qty < m.min_qty then
      return tandem.err('validation', format('Минимум «%s» — %s %s', m.title_ru, replace(trim_scale(m.min_qty)::text, '.', ','), m.unit_label)); end if;
    if abs(round((v_qty - m.min_qty) / m.step) * m.step - (v_qty - m.min_qty)) > 0.0005 then
      return tandem.err('validation', format('«%s» — шагом %s %s от %s', m.title_ru, replace(trim_scale(m.step)::text, '.', ','), m.unit_label, replace(trim_scale(m.min_qty)::text, '.', ','))); end if;
    if exists (select 1 from jsonb_array_elements(v_lines) l where l->>'item_code' = m.item_code) then
      return tandem.err('validation', format('«%s» указан дважды', m.title_ru)); end if;
    v_fresh := v_fresh or m.ready_kind = 'fresh';
    v_stock := v_stock or m.ready_kind = 'stock';
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_code', m.item_code, 'title', m.title_ru, 'title_kz', m.title_kz,
      'unit', m.unit_label, 'qty', v_qty, 'price', m.price, 'sum', round(v_qty * m.price, 2), 'ready_kind', m.ready_kind));
    v_total := v_total + round(v_qty * m.price, 2);
  end loop;

  if v_date = v_today then
    if v_fresh and (v_now::time >= v_cut or v_ready < v_fready) then
      return tandem.err('slot', format('Свежие пироги на сегодня — заказ до %s, готовность к %s. Позже — на завтра',
                                       to_char(v_cut, 'HH24:MI'), to_char(v_fready, 'HH24:MI'))); end if;
    v_first := greatest(v_now, v_today + v_from) + make_interval(mins => v_mins);
    if v_stock and v_first > v_today + v_to then
      return tandem.err('slot', 'Сегодня уже не успеем — выберите завтра'); end if;
    if v_stock and v_today + v_ready < v_first then
      return tandem.err('slot', format('Сегодня — не раньше %s', to_char(v_first, 'HH24:MI'))); end if;
  end if;

  if v_kind = 'delivery' then
    if nullif(btrim(coalesce(payload->>'address', '')), '') is null then return tandem.err('validation', 'Для доставки нужен адрес'); end if;
    if v_total < v_min then
      return tandem.err('min_order', format('Доставка — от %s ₸, в заказе %s ₸. Можно забрать самому', trim_scale(v_min), trim_scale(v_total))); end if;
  end if;

  return jsonb_build_object('ok', true, 'quote', jsonb_build_object(
    'point_id', v_point, 'point_name', (select name from tandem.points where id = v_point),
    'kind', v_kind, 'for_date', v_date, 'ready_by', to_char(v_ready, 'HH24:MI'),
    'address', case when v_kind = 'delivery' then btrim(payload->>'address') end,
    'lines', v_lines, 'total', v_total, 'delivery_fee', 0,
    'prepay_suggested', (v_rule = 'fresh' and v_fresh) or (v_rule like 'from\_sum:%' and v_total >= substr(v_rule, 10)::numeric)));
end $$;

-- Запись в журнал — только через эту функцию: блокировка держится до конца транзакции, поэтому номера
-- событий выдаются в порядке фиксации, и бот, читающий «события после N», не пропустит ещё не зафиксированное.
create or replace function tandem.corder_event(p_order bigint, p_from text, p_to text, p_kind text, p_by text, p_payload jsonb)
returns void language plpgsql set search_path to 'tandem', 'public' as $$
begin
  perform pg_advisory_xact_lock(hashtext('tandem.client_order_events'));
  insert into tandem.client_order_events (order_id, status_from, status_to, by_kind, by_name, payload)
    values (p_order, p_from, p_to, p_kind, p_by, coalesce(p_payload, '{}'::jsonb));
end $$;

create or replace function tandem.corder_json(p_id bigint)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('id', o.id, 'uid', o.uid, 'no', o.no, 'no_date', o.no_date, 'point_id', o.point_id,
    'point_name', p.name, 'point_mode', p.mode, 'channel', o.channel, 'uzel_dialog_id', o.uzel_dialog_id,
    'client_phone', o.client_phone, 'client_name', o.client_name, 'lang', o.lang, 'kind', o.kind, 'address', o.address,
    'comment', o.comment, 'for_date', o.for_date, 'ready_by', to_char(o.ready_by, 'HH24:MI'), 'total', o.total,
    'delivery_fee', o.delivery_fee, 'prepay_suggested', o.prepay_suggested, 'prepay_required', o.prepay_required,
    'pay_kind', o.pay_kind, 'courier', o.courier, 'status', o.status, 'status_name', tandem.corder_status_name(o.status),
    'reason', o.reason, 'check_uid', o.check_uid, 'created_at', o.created_at, 'confirmed_by', o.confirmed_by,
    'confirmed_at', o.confirmed_at,
    'in_act', false,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('item_code', l.item_code, 'title', l.title, 'unit', l.unit,
                         'qty', l.qty, 'price', l.price, 'sum', l.sum) order by l.id)
                       from tandem.client_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'last_by', (select e.by_name from tandem.client_order_events e where e.order_id = o.id order by e.id desc limit 1))
  from tandem.client_orders o join tandem.points p on p.id = o.point_id where o.id = p_id
$$;

create or replace function tandem.corder_create(payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_uid   uuid;
  v_phone text := regexp_replace(coalesce(payload->>'client_phone', ''), '\D', '', 'g');
  v_q     jsonb;
  v_day   date := tandem.local_now()::date;
  v_id    bigint;
  v_no    int;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  if v_uid is null then return tandem.err('validation', 'Нужен uid заказа'); end if;
  -- одна блокировка на создание: повтор бота с тем же uid ждёт первый вызов и получает тот же заказ, а номер дня не двоится
  perform pg_advisory_xact_lock(hashtext('tandem.client_orders:create'));
  select id into v_id from tandem.client_orders where uid = v_uid;
  if v_id is not null then return jsonb_build_object('ok', true, 'repeat', true, 'order', tandem.corder_json(v_id)); end if;
  if length(v_phone) < 10 or length(v_phone) > 15 then return tandem.err('validation', 'Нужен телефон клиента'); end if;
  v_q := tandem.corder_check(payload);
  if not coalesce((v_q->>'ok')::boolean, false) then return v_q; end if;
  v_q := v_q->'quote';
  select coalesce(max(no), 0) + 1 into v_no from tandem.client_orders where no_date = v_day;
  insert into tandem.client_orders (uid, no, no_date, point_id, uzel_dialog_id, client_phone, client_name, lang, kind, address,
                                    comment, for_date, ready_by, total, prepay_suggested)
  values (v_uid, v_no, v_day, v_q->>'point_id', nullif(btrim(coalesce(payload->>'uzel_dialog_id', '')), ''), v_phone,
          left(nullif(btrim(coalesce(payload->>'client_name', '')), ''), 100),
          case when payload->>'lang' = 'kz' then 'kz' else 'ru' end, v_q->>'kind', left(v_q->>'address', 300),
          left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500),
          (v_q->>'for_date')::date, (v_q->>'ready_by')::time, (v_q->>'total')::numeric, (v_q->>'prepay_suggested')::boolean)
  returning id into v_id;
  insert into tandem.client_order_lines (order_id, item_code, title, unit, qty, price, sum)
    select v_id, l->>'item_code', l->>'title', l->>'unit', (l->>'qty')::numeric, (l->>'price')::numeric, (l->>'sum')::numeric
      from jsonb_array_elements(v_q->'lines') l;
  perform tandem.corder_event(v_id, null, 'new', 'bot', 'Бот', null);
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id));
end $$;

create or replace function tandem.corder_set_status(p_id bigint, p_to text, p_kind text, p_by text, payload jsonb, p_point text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  o        tandem.client_orders;
  t        tandem.client_order_moves;
  v_pay    text := nullif(payload->>'pay_kind', '');
  v_reason text := left(nullif(btrim(coalesce(payload->>'reason', '')), ''), 300);
  v_cour   text := left(nullif(btrim(coalesce(payload->>'courier', '')), ''), 100);
  v_by     text := left(nullif(btrim(coalesce(p_by, '')), ''), 100);
  v_chk    jsonb;
  v_check  uuid;
begin
  select * into o from tandem.client_orders where id = p_id for update;
  if o.id is null or (p_point is not null and o.point_id <> p_point) then return tandem.err('not_found', 'Заказ не найден'); end if;
  if v_by is null then return tandem.err('validation', 'Кто меняет статус — имя обязательно'); end if;
  if p_to is null or not exists (select 1 from tandem.client_order_moves where status_to = p_to) then
    return tandem.err('validation', 'Неизвестный статус: ' || coalesce(p_to, '—')); end if;
  select * into t from tandem.client_order_moves where status_from = o.status and status_to = p_to;
  if t.status_to is null then
    return jsonb_build_object('ok', false, 'error', 'conflict',
      'message', format('Заказ №%s уже «%s»%s', o.no, tandem.corder_status_name(o.status),
                        coalesce(' — ' || (select e.by_name from tandem.client_order_events e where e.order_id = o.id order by e.id desc limit 1), '')),
      'order', tandem.corder_json(o.id));
  end if;
  if not (p_kind = any(t.kinds)) then return tandem.err('forbidden', 'Этот шаг здесь не делается'); end if;
  if t.only_kind is not null and t.only_kind <> o.kind then
    return tandem.err('validation', case when o.kind = 'pickup' then 'Это самовывоз — курьера нет' else 'Это доставка — «ждёт клиента» не ставится' end); end if;
  if t.need = 'reason' and v_reason is null then return tandem.err('validation', 'Укажите причину'); end if;
  if t.need = 'courier' and v_cour is null then return tandem.err('validation', 'Укажите курьера'); end if;
  if t.need = 'pay' then
    if v_pay is null or v_pay not in ('cash', 'kaspi_qr', 'transfer', 'card') then return tandem.err('validation', 'Выберите способ оплаты'); end if;
    if (select mode from tandem.points where id = o.point_id) = 'checks' then
      v_chk := tandem.check_save(o.point_id, jsonb_build_object('uid', o.uid, 'date', tandem.local_now()::date, 'seller', v_by,
                 'pay_kind', v_pay, 'lines', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty, 'price', price) order by id)
                                               from tandem.client_order_lines where order_id = o.id)));
      if not coalesce((v_chk->>'ok')::boolean, false) then
        return tandem.err('check', 'Чек не пробит: ' || coalesce(v_chk->>'error', v_chk->>'message', 'ошибка')); end if;
      v_check := o.uid;
    end if;
  end if;
  update tandem.client_orders set status = p_to, updated_at = now(),
         reason = coalesce(v_reason, reason), courier = coalesce(v_cour, courier),
         pay_kind = coalesce(v_pay, pay_kind), check_uid = coalesce(v_check, check_uid),
         prepay_required = prepay_required or p_to = 'awaiting_prepay',
         confirmed_by = case when p_to in ('confirmed', 'awaiting_prepay') then v_by else confirmed_by end,
         confirmed_at = case when p_to in ('confirmed', 'awaiting_prepay') then now() else confirmed_at end
   where id = o.id;
  perform tandem.corder_event(o.id, o.status, p_to, p_kind, v_by, jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'courier', v_cour, 'pay_kind', v_pay)));
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id));
end $$;

-- Правка до «готовится»: строки, дата, час, адрес, комментарий. Только адрес и комментарий — без
-- проверки окон (правка адреса не должна упираться в отсечку, прошедшую после заказа).
create or replace function tandem.corder_edit(p_id bigint, payload jsonb, p_kind text, p_by text, p_point text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  o     tandem.client_orders;
  v_q   jsonb;
  v_by  text := left(nullif(btrim(coalesce(p_by, '')), ''), 100);
  v_big boolean := payload ? 'lines' or payload ? 'for_date' or payload ? 'ready_by' or payload ? 'kind';
  v_old jsonb;
begin
  select * into o from tandem.client_orders where id = p_id for update;
  if o.id is null or (p_point is not null and o.point_id <> p_point) then return tandem.err('not_found', 'Заказ не найден'); end if;
  if v_by is null then return tandem.err('validation', 'Кто правит — имя обязательно'); end if;
  if o.status not in ('new', 'awaiting_prepay', 'paid', 'confirmed') then
    return tandem.err('validation', 'Заказ уже готовится — правка только словами с кухней'); end if;
  -- сумма, о которой клиенту написали реквизиты или которую он уже оплатил, не меняется: только адрес и комментарий
  if v_big and o.status in ('awaiting_prepay', 'paid') then
    return tandem.err('validation', 'Заказ с предоплатой: состав, дату и время не правим — отмените и оформите заново'); end if;
  v_old := (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id) from tandem.client_order_lines where order_id = o.id);
  if v_big then
    v_q := tandem.corder_check(jsonb_build_object('kind', coalesce(payload->>'kind', o.kind), 'point_id', o.point_id,
             'for_date', coalesce(payload->>'for_date', o.for_date::text), 'ready_by', coalesce(payload->>'ready_by', to_char(o.ready_by, 'HH24:MI')),
             'address', coalesce(payload->>'address', o.address),
             'lines', coalesce(payload->'lines', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id)
                                                    from tandem.client_order_lines where order_id = o.id))));
    if not coalesce((v_q->>'ok')::boolean, false) then return v_q; end if;
    v_q := v_q->'quote';
    update tandem.client_orders set kind = v_q->>'kind', for_date = (v_q->>'for_date')::date, ready_by = (v_q->>'ready_by')::time,
           address = left(v_q->>'address', 300), total = (v_q->>'total')::numeric, prepay_suggested = (v_q->>'prepay_suggested')::boolean,
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
    delete from tandem.client_order_lines where order_id = o.id;
    insert into tandem.client_order_lines (order_id, item_code, title, unit, qty, price, sum)
      select o.id, l->>'item_code', l->>'title', l->>'unit', (l->>'qty')::numeric, (l->>'price')::numeric, (l->>'sum')::numeric
        from jsonb_array_elements(v_q->'lines') l;
  else
    if o.kind = 'delivery' and payload ? 'address' and nullif(btrim(coalesce(payload->>'address', '')), '') is null then
      return tandem.err('validation', 'Для доставки нужен адрес'); end if;
    update tandem.client_orders set address = coalesce(left(nullif(btrim(coalesce(payload->>'address', '')), ''), 300), address),
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
  end if;
  -- в журнале — что было и что стало: деньги и текст бота восстанавливаются по журналу
  perform tandem.corder_event(o.id, o.status, o.status, p_kind, v_by, (select jsonb_strip_nulls(jsonb_build_object('edited', true,
    'total_from', o.total, 'total_to', n.total, 'lines_from', v_old,
    'lines_to', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id) from tandem.client_order_lines where order_id = o.id),
    'for_date_from', o.for_date, 'for_date_to', n.for_date, 'ready_by_from', to_char(o.ready_by, 'HH24:MI'), 'ready_by_to', to_char(n.ready_by, 'HH24:MI'),
    'address_from', o.address, 'address_to', n.address)) from tandem.client_orders n where n.id = o.id));
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id));
end $$;

create or replace function tandem.corder_events(p_after bigint, p_limit int)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  with e as (select * from tandem.client_order_events where id > coalesce(p_after, 0) order by id limit least(greatest(coalesce(p_limit, 200), 1), 500))
  select jsonb_build_object('ok', true,
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'status_from', e.status_from, 'status_to', e.status_to,
                  'by_kind', e.by_kind, 'by_name', e.by_name, 'payload', e.payload, 'order', tandem.corder_json(e.order_id)) order by e.id) from e), '[]'::jsonb),
    'last', coalesce((select max(id) from e), coalesce(p_after, 0)))
$$;

create or replace function tandem.corder_list(p_point text, p_from date, p_to date)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('ok', true, 'orders', coalesce(jsonb_agg(tandem.corder_json(o.id)
           order by (o.status = 'new') desc, o.for_date, o.ready_by, o.no), '[]'::jsonb))
    from tandem.client_orders o
   where (p_point is null or o.point_id = p_point)
     and (o.for_date between p_from and p_to or o.status = 'new'
          or (o.for_date < p_from and o.status <> all(array['delivered', 'issued', 'rejected', 'cancelled', 'not_collected'])))   -- незакрытый заказ прошлых дней не пропадает
$$;

create or replace function tandem.corder_history(p_phone text)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  with o as (select * from tandem.client_orders where client_phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
              order by created_at desc limit 20)
  select jsonb_build_object('ok', true,
    'name', (select client_name from o where client_name is not null limit 1),
    'lang', (select lang from o limit 1),
    'orders', (select count(*) from o),
    'addresses', coalesce((select jsonb_agg(a) from (select address a, max(created_at) at from o where address is not null
                             group by address order by max(created_at) desc limit 3) x), '[]'::jsonb))
$$;

-- Действия точки (tandem_api уже проверил код точки).
create or replace function tandem.corder_point(action text, p_point text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_by    text := coalesce(left(nullif(btrim(coalesce(payload->>'seller', '')), ''), 100), 'Точка');
  v_today date := tandem.local_now()::date;
  v_id    bigint := tandem.to_num(payload->>'id')::bigint;
begin
  if action = 'corder_list' then return tandem.corder_list(p_point, v_today - 1, v_today + 14); end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id and point_id = p_point) then
      return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id));
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'point', v_by, payload, p_point); end if;
  if action = 'corder_edit' then return tandem.corder_edit(v_id, payload - 'pin' - 'point_id' - 'seller' - 'id', 'point', v_by, p_point); end if;
  if action = 'cmenu_point_list' then
    return jsonb_build_object('ok', true, 'rows', coalesce((select jsonb_agg(tandem.cmenu_json(m) - 'kassa_price' order by m.section, m.sort_order, m.title_ru)
                                                             from tandem.order_menu m where m.active and m.price_checked_at is not null), '[]'::jsonb));
  end if;
  if action = 'cmenu_stop' then return tandem.cmenu_stop(payload->>'item_code', payload->>'until', 'точка: ' || v_by); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function tandem.office_corders(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_id bigint := tandem.to_num(payload->>'id')::bigint;
begin
  if action = 'corder_list' then
    return jsonb_build_object('ok', true, 'orders', coalesce((select jsonb_agg(tandem.corder_json(o.id) order by o.for_date desc, o.ready_by, o.no)
      from tandem.client_orders o
     where o.for_date between coalesce(tandem.to_date(payload->>'date_from'), tandem.local_now()::date) and coalesce(tandem.to_date(payload->>'date_to'), tandem.local_now()::date)
       and (nullif(payload->>'point_id', '') is null or o.point_id = payload->>'point_id')
       and (nullif(payload->>'status', '') is null or o.status = payload->>'status')
       -- 0048: учебная учётка видит только заказы учебных точек — телефоны и адреса настоящих клиентов ей закрыты
       and (not v_user.training or o.point_id in (select id from tandem.points where training))), '[]'::jsonb));
  end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id
                    and (not v_user.training or point_id in (select id from tandem.points where training))) then
      return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status_from', e.status_from, 'status_to', e.status_to,
                   'status_name', tandem.corder_status_name(e.status_to), 'by_kind', e.by_kind, 'by_name', e.by_name, 'payload', e.payload) order by e.id), '[]'::jsonb)
                 from tandem.client_order_events e where e.order_id = v_id));
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'office', v_user.name, payload, null); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- tandem_gate: служебные действия бота.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_gate(text,jsonb)'::regprocedure);
  if position('''bot_order_create''' in d) > 0 then raise notice '0050: tandem_gate уже знает действия заказов'; return; end if;
  n := replace(d, $a$'set_short_list','bot_menu');$a$,
    $a$'set_short_list','bot_menu','bot_order_quote','bot_order_create','bot_order_events','bot_order_get','bot_order_cancel','bot_card_status','bot_client_history');$a$);
  if n = d then raise exception '0050: якорь списка служебных действий tandem_gate не найден (0049 применена?)'; end if;
  d := n;
  n := replace(d, $a$      when 'bot_menu'       then tandem.cmenu_bot()
    end;$a$, $a$      when 'bot_menu'       then tandem.cmenu_bot()
      when 'bot_order_quote'  then tandem.corder_check(payload)
      when 'bot_order_create' then tandem.corder_create(payload)
      when 'bot_order_events' then tandem.corder_events(coalesce(tandem.to_num(payload->>'after'), 0)::bigint, coalesce(tandem.to_num(payload->>'limit'), 200)::int)
      when 'bot_order_get'    then coalesce((select jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id)) from tandem.client_orders o
                                               where o.id = tandem.to_num(payload->>'id')::bigint or o.uid::text = payload->>'uid' limit 1),
                                             tandem.err('not_found', 'Заказ не найден'))
      when 'bot_order_cancel' then tandem.corder_set_status(tandem.to_num(payload->>'id')::bigint, 'cancelled', 'bot', 'Бот', payload, null)
      when 'bot_card_status'  then tandem.corder_set_status(tandem.to_num(payload->>'order_id')::bigint, payload->>'to', 'telegram', payload->>'by_name', payload, null)
      when 'bot_client_history' then tandem.corder_history(payload->>'phone')
    end;$a$);
  if n = d then raise exception '0050: якорь case служебных действий tandem_gate не найден'; end if;
  execute n;
end $mig$;

-- tandem_api: действия точки по заказам клиентов — под той же проверкой кода точки.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_api(text,jsonb)'::regprocedure);
  if position('tandem.corder_point' in d) > 0 then raise notice '0050: tandem_api уже знает заказы клиентов'; return; end if;
  n := replace(d, $a$'check_list','order_get','order_save') then$a$,
    $a$'check_list','order_get','order_save','corder_list','corder_get','corder_status','corder_edit','cmenu_point_list','cmenu_stop') then$a$);
  if n = d then raise exception '0050: якорь списка действий точки tandem_api не найден'; end if;
  d := n;
  n := replace(d, $a$  -- ---------- касса: чеки в течение дня ----------$a$, $a$  -- ---------- заказы клиентов (0050) ----------
  if action in ('corder_list','corder_get','corder_status','corder_edit','cmenu_point_list','cmenu_stop') then
    return tandem.corder_point(action, v_point, payload);
  end if;

  -- ---------- касса: чеки в течение дня ----------$a$);
  if n = d then raise exception '0050: якорь блока кассы tandem_api не найден'; end if;
  execute n;
end $mig$;

-- tandem_test_cleanup: заказы служебных точек (строки и журнал — каскадом) и остаток в leftovers.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_test_cleanup(text)'::regprocedure);
  if position('client_orders' in d) > 0 then raise notice '0050: уборка уже знает заказы клиентов'; return; end if;
  n := replace(d, $a$  delete from tandem.orders where left(point_id, 3) = 'zz_';$a$,
    $a$  delete from tandem.client_orders where left(point_id, 3) = 'zz_';   -- 0050: заказы клиентов служебных точек
  delete from tandem.orders where left(point_id, 3) = 'zz_';$a$);
  if n = d then raise exception '0050: якорь уборки заявок не найден'; end if;
  d := n;
  n := replace(d, $a$       + (select count(*) from tandem.users where login like 'zz\_test\_%')$a$,
    $a$       + (select count(*) from tandem.users where login like 'zz\_test\_%')
       + (select count(*) from tandem.client_orders where left(point_id, 3) = 'zz_')$a$);
  if n = d then raise exception '0050: якорь подсчёта остатков уборки не найден'; end if;
  execute n;
end $mig$;
