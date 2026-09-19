-- Касса: точка пробивает каждую продажу в течение дня (пятый режим точки — «checks»).
-- Чек — первичка. После каждого чека строки продаж и деньги дневного отчёта пересобираются
-- из чеков (tandem.check_rollup), и отчёт сразу проводит складской документ «Продажа»
-- (tandem.sale_sync) — остатки и сводка собственника живут в течение дня, а не с вечера.
-- Закрытие смены — обычное сохранение дневного отчёта: продавец вводит пересчёт наличных,
-- расходы и сверку, деньги и позиции уже подставлены.
-- Новый канал оплаты «карта» (терминал) — для всех точек: daily_reports.card.
-- tandem_api — тело из 0032, office_stock — из 0023, точечные замены (см. сборщик в истории).

alter table tandem.points drop constraint if exists points_mode_check;
alter table tandem.points add constraint points_mode_check
  check (mode = any (array['position','takeout','import','manual','checks']));

alter table tandem.daily_reports add column if not exists card numeric not null default 0;
alter table tandem.daily_reports add column if not exists closed_at timestamptz;

create table if not exists tandem.checks (
  id          bigint generated always as identity primary key,
  uid         uuid not null unique,              -- выдаёт планшет: повторная досылка не создаёт второй чек
  point_id    text not null references tandem.points(id),
  check_date  date not null,
  no          integer not null,                  -- номер внутри точки и дня
  seller      text,
  pay_kind    text not null check (pay_kind in ('cash','kaspi_qr','transfer','card')),
  total       numeric not null default 0,
  status      text not null default 'active' check (status in ('active','void')),
  void_reason text,
  edited      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (point_id, check_date, no)
);
create table if not exists tandem.check_lines (
  id         bigint generated always as identity primary key,
  check_id   bigint not null references tandem.checks(id) on delete cascade,
  item_code  text not null references tandem.items(code),
  item_name  text not null,
  qty        numeric not null check (qty > 0),
  price      numeric not null check (price >= 0),
  price_list numeric
);
create index if not exists check_lines_check_idx on tandem.check_lines(check_id);
alter table tandem.checks enable row level security;
alter table tandem.check_lines enable row level security;

-- v_daily: карта входит в выручку; новые колонки — в конец (create or replace иначе не даёт).
create or replace view tandem.v_daily as
 SELECT r.id, r.report_date, r.point_id, p.name AS point_name, p.mode, r.shift_by,
    r.cash, r.kaspi_qr, r.transfer,
    r.cash + r.kaspi_qr + r.transfer + r.card AS revenue_total,
    r.qr_statement, r.tr_statement,
    CASE WHEN r.qr_statement IS NULL THEN NULL::numeric ELSE r.kaspi_qr - r.qr_statement END AS diff_qr,
    CASE WHEN r.tr_statement IS NULL THEN NULL::numeric ELSE r.transfer - r.tr_statement END AS diff_transfer,
    r.cash_open, r.cash_handed,
    COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS podotchet,
    r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) AS cash_expected,
    r.cash_counted,
    CASE WHEN r.cash_counted IS NULL THEN NULL::numeric
         ELSE r.cash_open + r.cash - r.cash_handed - COALESCE(( SELECT sum(e.amount) FROM tandem.cash_expenses e WHERE e.report_id = r.id), 0::numeric) - r.cash_counted
    END AS diff_cash,
    COALESCE(( SELECT count(*) FROM tandem.cash_expenses e
          WHERE e.report_id = r.id AND (e.receipt_no IS NULL OR btrim(e.receipt_no) = ''::text)), 0::bigint) AS expenses_no_receipt,
    COALESCE(( SELECT sum((t.issued - t.returned) * COALESCE(t.price, 0::numeric)) FROM tandem.takeout_lines t WHERE t.report_id = r.id), 0::numeric) AS takeout_amount,
    COALESCE(( SELECT sum(s.qty * COALESCE(s.price, 0::numeric)) FROM tandem.sale_lines s WHERE s.report_id = r.id), 0::numeric) AS sales_amount,
    r.comment, r.created_at,
    r.card, r.closed_at,
    ( SELECT count(*) FROM tandem.checks c WHERE c.point_id = r.point_id AND c.check_date = r.report_date AND c.status = 'active') AS checks_count
   FROM tandem.daily_reports r
     JOIN tandem.points p ON p.id = r.point_id;

-- Деньги и строки продаж дня — из действующих чеков. Строка отчёта создаётся с первым чеком.
create or replace function tandem.check_rollup(p_point text, p_date date) returns bigint
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_id bigint;
begin
  insert into tandem.daily_reports (point_id, report_date) values (p_point, p_date)
    on conflict (point_id, report_date) do nothing;
  select id into v_id from tandem.daily_reports where point_id = p_point and report_date = p_date for update;
  update tandem.daily_reports d set
      cash     = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'cash'), 0),
      kaspi_qr = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'kaspi_qr'), 0),
      transfer = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'transfer'), 0),
      card     = coalesce((select sum(total) from tandem.checks where point_id = p_point and check_date = p_date and status = 'active' and pay_kind = 'card'), 0),
      updated_at = now()
    where d.id = v_id;
  delete from tandem.sale_lines where report_id = v_id;
  insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    -- Одна строка на позицию (в sale_lines название уникально внутри отчёта): цена — средняя по чекам,
    -- скидка видна как разница с ценой прейскуранта. Два кода с одним названием различаются кодом в скобках.
    select v_id, g.item_code,
           g.item_name || case when count(*) over (partition by g.item_name) > 1 then ' [' || g.item_code || ']' else '' end,
           g.qty, g.price, g.price_list
      from (select l.item_code, min(l.item_name) as item_name, sum(l.qty) as qty,
                   round(sum(l.qty * l.price) / sum(l.qty), 2) as price, max(l.price_list) as price_list
              from tandem.check_lines l join tandem.checks c on c.id = l.check_id
             where c.point_id = p_point and c.check_date = p_date and c.status = 'active'
             group by l.item_code) g
     order by g.item_name;
  return v_id;
end $$;

-- Пересборка отчёта + проведение продажи; сбой склада чек не отменяет (как в save_report).
create or replace function tandem.check_apply(p_point text, p_date date) returns void
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_id bigint;
begin
  v_id := tandem.check_rollup(p_point, p_date);
  begin
    perform tandem.sale_sync(v_id);
  exception when others then
    begin
      update tandem.documents set sync_note = 'Сбой при сохранении чека: ' || sqlerrm
             || ' — нажмите «Провести продажи за период»'
        where source_kind = 'daily_report' and source_id = v_id::text;
    exception when others then null;
    end;
  end;
end $$;

-- Новый чек или исправление существующего (тот же uid). Цена прейскуранта и название — из базы;
-- цена строки — от продавца (скидка), как в отчёте по позициям; без неё — цена прейскуранта.
create or replace function tandem.check_save(p_point text, payload jsonb) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_uid   uuid;
  v_date  date := nullif(payload->>'date','')::date;
  v_pay   text := payload->>'pay_kind';
  v_chk   tandem.checks;
  v_id    bigint;
  v_bad   text;
  v_total numeric;
  v_was   text;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'У чека нет номера устройства (uid)'); end if;
  if v_pay is null or v_pay not in ('cash','kaspi_qr','transfer','card') then
    return jsonb_build_object('ok', false, 'error', 'Не выбран способ оплаты'); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
    return jsonb_build_object('ok', false, 'error', 'В чеке нет позиций'); end if;
  if exists (select 1 from jsonb_array_elements(payload->'lines') x
              where coalesce(nullif(x->>'qty','')::numeric, 0) <= 0 or coalesce(nullif(x->>'price','')::numeric, 0) < 0) then
    return jsonb_build_object('ok', false, 'error', 'Количество должно быть больше нуля, цена — не меньше нуля'); end if;
  select string_agg(x->>'item_code', ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x
    left join tandem.items i on i.code = x->>'item_code' and i.active and i.for_sale
   where i.code is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'Позиции нет в продаже: ' || v_bad); end if;

  perform 1 from tandem.points where id = p_point for update;   -- нумерация чеков дня — по очереди
  select * into v_chk from tandem.checks where uid = v_uid;
  if v_chk.id is not null and v_chk.point_id <> p_point then
    return jsonb_build_object('ok', false, 'error', 'Чек принадлежит другой точке'); end if;
  if v_chk.id is not null and v_chk.status = 'void' then
    return jsonb_build_object('ok', false, 'error', 'Чек отменён, исправить его нельзя'); end if;
  if v_chk.id is null then
    -- День чека присылает планшет (у сервера время UTC); принимаем только соседние с сегодняшним.
    if v_date is null or v_date < current_date - 2 or v_date > current_date + 1 then
      return jsonb_build_object('ok', false, 'error', 'Дата чека не похожа на сегодняшнюю — проверьте дату на планшете'); end if;
    insert into tandem.checks (uid, point_id, check_date, no, seller, pay_kind)
      values (v_uid, p_point, v_date,
              coalesce((select max(no) from tandem.checks where point_id = p_point and check_date = v_date), 0) + 1,
              nullif(btrim(coalesce(payload->>'seller','')), ''), v_pay)
      returning id into v_id;
  else
    v_id := v_chk.id; v_date := v_chk.check_date;
    -- «Исправлен» ставится, только если чек действительно изменился: досылка после обрыва связи — не правка.
    select v_chk.pay_kind || '|' || string_agg(item_code || ':' || qty::text || ':' || price::text, ',' order by id) into v_was
      from tandem.check_lines where check_id = v_id;
    update tandem.checks set pay_kind = v_pay, updated_at = now() where id = v_id;
    delete from tandem.check_lines where check_id = v_id;
  end if;

  insert into tandem.check_lines (check_id, item_code, item_name, qty, price, price_list)
    select v_id, i.code, i.name, (x->>'qty')::numeric,
           coalesce(nullif(x->>'price','')::numeric, pp.price, i.price, 0), coalesce(pp.price, i.price)
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code'
      left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = p_point
     order by ord;
  select coalesce(sum(round(qty * price, 2)), 0) into v_total from tandem.check_lines where check_id = v_id;
  update tandem.checks set total = v_total,
         edited = edited or (v_was is not null and v_was <> (select v_pay || '|' || string_agg(item_code || ':' || qty::text || ':' || price::text, ',' order by id)
                                                              from tandem.check_lines where check_id = v_id))
   where id = v_id;

  perform tandem.check_apply(p_point, v_date);
  return jsonb_build_object('ok', true, 'check', (select jsonb_build_object('uid', uid, 'no', no, 'total', total,
           'date', check_date, 'edited', edited) from tandem.checks where id = v_id));
end $$;

create or replace function tandem.check_void(p_point text, payload jsonb) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_uid uuid;
  v_chk tandem.checks;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  perform 1 from tandem.points where id = p_point for update;
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point;
  if v_chk.id is null then return jsonb_build_object('ok', false, 'error', 'Чек не найден'); end if;
  if v_chk.status = 'active' then
    update tandem.checks set status = 'void', updated_at = now(),
           void_reason = nullif(btrim(coalesce(payload->>'reason','')), '') where id = v_chk.id;
    perform tandem.check_apply(p_point, v_chk.check_date);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function tandem.check_list(p_point text, p_date date) returns jsonb
language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('ok', true, 'date', p_date,
    'closed_at', (select closed_at from tandem.daily_reports where point_id = p_point and report_date = p_date),
    'totals', (select jsonb_build_object(
        'count', count(*), 'total', coalesce(sum(total), 0),
        'cash', coalesce(sum(total) filter (where pay_kind = 'cash'), 0),
        'kaspi_qr', coalesce(sum(total) filter (where pay_kind = 'kaspi_qr'), 0),
        'transfer', coalesce(sum(total) filter (where pay_kind = 'transfer'), 0),
        'card', coalesce(sum(total) filter (where pay_kind = 'card'), 0))
      from tandem.checks where point_id = p_point and check_date = p_date and status = 'active'),
    'checks', (select coalesce(jsonb_agg(jsonb_build_object(
        'uid', c.uid, 'no', c.no, 'seller', c.seller, 'pay_kind', c.pay_kind, 'total', c.total,
        'status', c.status, 'void_reason', c.void_reason, 'edited', c.edited, 'created_at', c.created_at,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'item_name', l.item_name,
                    'qty', l.qty, 'price', l.price, 'price_list', l.price_list) order by l.id), '[]'::jsonb)
                  from tandem.check_lines l where l.check_id = c.id)) order by c.no desc), '[]'::jsonb)
      from tandem.checks c where c.point_id = p_point and c.check_date = p_date));
$$;

create or replace function public.tandem_api(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_pin        text := coalesce(payload->>'pin','');
  v_point      text := payload->>'point_id';
  v_date       date;
  v_owner_pin  text;
  v_driver_pin text;
  v_id         bigint;
  v_res        jsonb;
  v_scopes     text[];
  v_cats       text[];
  v_q          text := btrim(coalesce(payload->>'q',''));
  v_from       date;
  v_to         date;
begin
  select value into v_owner_pin  from tandem.settings where key = 'owner_pin';
  select value into v_driver_pin from tandem.settings where key = 'driver_pin';

  if action = 'points' then
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', id, 'name', name, 'mode', mode, 'legal_entity', legal_entity) order by sort_order), '[]'::jsonb)
            from tandem.points where active);
  end if;

  if action = 'login' then
    if v_pin = v_owner_pin then
      return jsonb_build_object('ok', true, 'role', 'owner');
    end if;
    if v_pin = v_driver_pin then
      return jsonb_build_object('ok', true, 'role', 'driver');
    end if;
    if exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', true, 'role', 'point',
        'point', (select jsonb_build_object('id',id,'name',name,'mode',mode)
                  from tandem.points where id = v_point));
    end if;
    return jsonb_build_object('ok', false, 'error', 'Неверный код');
  end if;

  if action in ('items','get_report','save_report','aliases','check_save','check_void','check_list') then
    if v_pin <> v_owner_pin
       and not exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
  end if;

  if action = 'items' then
    select item_scopes, item_categories into v_scopes, v_cats
      from tandem.points where id = v_point;
    return jsonb_build_object('ok', true, 'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', code, 'name', name, 'category', category, 'unit', unit,
        'price', price, 'artikul', artikul, 'iiko_code', iiko_code,
        'rank', rank, 'short', short, 'has_chart', has_chart,
        'pack_factor', pack_factor, 'pack_unit', pack_unit, 'pack_price', pack_price)
        order by category, name), '[]'::jsonb)
      from (
        select i.code, i.name, i.category, i.unit,
               coalesce(pp.price, i.price)   as price,
               i.artikul, i.iiko_code, r.rank,
               coalesce(r.in_short_list,false) as short,
               coalesce(i.has_chart,false)     as has_chart,
               i.pack_factor, i.pack_unit, i.pack_price
        from tandem.items i
        left join tandem.item_rank   r  on r.item_code  = i.code and r.point_id  = v_point
        left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = v_point
        where i.active and i.for_sale
          and (
            case
              when v_cats is not null and cardinality(v_cats) > 0 then i.category = any(v_cats)
              when v_scopes is null or cardinality(v_scopes) = 0 then true
              else i.point_hint = any(v_scopes)
            end
          )
          and (v_q = '' or i.name ilike '%' || v_q || '%')
        order by i.category, i.name
        limit 5000   -- было 1200: у Актау после включения штучных товаров 1231 позиция, хвост списка пропадал
      ) s));
  end if;

  -- Карта соответствий для импорта: названия чужой программы → код номенклатуры.
  if action = 'aliases' then
    return jsonb_build_object('ok', true, 'aliases', (
      select coalesce(jsonb_object_agg(alias, item_code), '{}'::jsonb) from tandem.item_aliases));
  end if;

  if action = 'get_report' then
    v_date := (payload->>'date')::date;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb);
    end if;
    select id into v_id from tandem.daily_reports
      where point_id = v_point and report_date = v_date;
    return jsonb_build_object('ok', true, 'report', v_res,
      'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
          'purpose',purpose,'amount',amount,'receipt_no',receipt_no) order by id),'[]'::jsonb)
        from tandem.cash_expenses where report_id = v_id),
      'takeout', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'unit',unit,
          'issued',issued,'returned',returned,'price',price) order by id),'[]'::jsonb)
        from tandem.takeout_lines where report_id = v_id),
      'sales', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'qty',qty,
          'price',price,'price_list',price_list) order by id),'[]'::jsonb)
        from tandem.sale_lines where report_id = v_id));
  end if;

  if action = 'save_report' then
    v_date := (payload->>'date')::date;

    insert into tandem.daily_reports as d
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer, card,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, payload->>'shift_by',
       coalesce((payload->>'cash')::numeric,0),
       coalesce((payload->>'kaspi_qr')::numeric,0),
       coalesce((payload->>'transfer')::numeric,0),
       coalesce((payload->>'card')::numeric,0),
       nullif(payload->>'qr_statement','')::numeric,
       nullif(payload->>'tr_statement','')::numeric,
       coalesce((payload->>'cash_open')::numeric,0),
       coalesce((payload->>'cash_handed')::numeric,0),
       nullif(payload->>'cash_counted','')::numeric,
       payload->>'comment')
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer, card = excluded.card,
       qr_statement = excluded.qr_statement, tr_statement = excluded.tr_statement,
       cash_open = excluded.cash_open, cash_handed = excluded.cash_handed,
       cash_counted = excluded.cash_counted, comment = excluded.comment,
       updated_at = now()
    returning d.id into v_id;

    delete from tandem.cash_expenses where report_id = v_id;
    insert into tandem.cash_expenses (report_id, purpose, amount, receipt_no)
    select v_id, e->>'purpose', (e->>'amount')::numeric, nullif(e->>'receipt_no','')
    from jsonb_array_elements(coalesce(payload->'expenses','[]'::jsonb)) e
    where coalesce((e->>'amount')::numeric,0) > 0;

    delete from tandem.takeout_lines where report_id = v_id;
    insert into tandem.takeout_lines (report_id, item_code, item_name, unit, issued, returned, price)
    select v_id, nullif(t->>'item_code',''), t->>'item_name', coalesce(t->>'unit','шт'),
           coalesce((t->>'issued')::numeric,0), coalesce((t->>'returned')::numeric,0),
           nullif(t->>'price','')::numeric
    from jsonb_array_elements(coalesce(payload->'takeout','[]'::jsonb)) t
    where coalesce(t->>'item_name','') <> '';

    delete from tandem.sale_lines where report_id = v_id;
    insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    select v_id, nullif(s->>'item_code',''), s->>'item_name',
           coalesce((s->>'qty')::numeric,0), nullif(s->>'price','')::numeric,
           nullif(s->>'price_list','')::numeric
    from jsonb_array_elements(coalesce(payload->'sales','[]'::jsonb)) s
    where coalesce(s->>'item_name','') <> '' and coalesce((s->>'qty')::numeric,0) <> 0;

    -- Касса (режим «чеки»): первичка — чеки. Деньги по каналам и строки продаж отчёта
    -- пересобираются из них, присланное формой не учитывается; сохранение отчёта = закрытие смены.
    if (select mode from tandem.points where id = v_point) = 'checks' then
      perform tandem.check_rollup(v_point, v_date);
      update tandem.daily_reports set closed_at = now() where id = v_id;
    end if;

    -- Подпроект 4: отчёт порождает складской документ «Продажа». Сбой склада не должен
    -- мешать точке сдать отчёт — деньги важнее, продажу пересчитают из бэк-офиса.
    -- Сбой не прячется: пометка на документе (если он уже есть) и состояние в списке продаж.
    begin
      perform tandem.sale_sync(v_id);
    exception when others then
      begin
        update tandem.documents set sync_note = 'Сбой при сохранении отчёта: ' || sqlerrm
               || ' — нажмите «Провести продажи за период»'
          where source_kind = 'daily_report' and source_id = v_id::text;
      exception when others then
        null;
      end;
    end;

    select to_jsonb(v) into v_res from tandem.v_daily v where v.id = v_id;
    return jsonb_build_object('ok', true, 'report', v_res);
  end if;

  -- ---------- касса: чеки в течение дня ----------
  if action in ('check_save','check_void','check_list') then
    if (select mode from tandem.points where id = v_point) is distinct from 'checks' then
      return jsonb_build_object('ok', false, 'error', 'У этой точки касса не включена');
    end if;
    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;
    if action = 'check_void' then return tandem.check_void(v_point, payload); end if;
    return tandem.check_list(v_point, coalesce(nullif(payload->>'date','')::date, current_date));
  end if;

  if action = 'dashboard' then
    if v_pin <> v_owner_pin then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    v_from := coalesce((payload->>'from')::date, current_date - 30);
    v_to   := coalesce((payload->>'to')::date, current_date);
    return jsonb_build_object('ok', true,
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'mode',mode) order by sort_order),'[]'::jsonb)
                 from tandem.points where active),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0), 'card', coalesce(sum(d.card),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer + d.card) rev
              from tandem.daily_reports d join tandem.points p on p.id = d.point_id
              where d.report_date between v_from and v_to
              group by p.legal_entity) t),
      -- Что продано: топ-20 позиций по сумме (продажи + заборный лист)
      'top_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.item_name, 'qty', t.q, 'amount', t.amt,
          'discount', t.disc) order by t.amt desc), '[]'::jsonb)
        from (
          select item_name, sum(q) q, sum(amt) amt, sum(disc) disc from (
            select s.item_name, s.qty q, s.qty * coalesce(s.price,0) amt,
                   s.qty * greatest(coalesce(s.price_list, s.price, 0) - coalesce(s.price,0), 0) disc
            from tandem.sale_lines s
            join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to
            union all
            select t.item_name, (t.issued - t.returned) q,
                   (t.issued - t.returned) * coalesce(t.price,0) amt, 0
            from tandem.takeout_lines t
            join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to
          ) u group by item_name order by amt desc limit 20
        ) t),
      -- Кто не сдал отчёт за вчера
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = current_date - 1
            -- у кассы строка отчёта появляется с первым чеком; сданным он считается после закрытия смены
            and (p.mode <> 'checks' or d.closed_at is not null))),
      -- Расход сырья по техкартам за период: топ-15
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total) order by t.total desc), '[]'::jsonb)
        from (
          -- Карта берётся на дату отчёта, а не на сегодня: иначе новая версия карты
          -- переписала бы расход сырья за прошлые дни.
          select ing.name as ingredient_name, sum(cl.brutto / ch.output_amount * u.q) total from (
            select s.item_code, s.qty q, d.report_date rd
            from tandem.sale_lines s join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to and s.item_code is not null
            union all
            select t.item_code, (t.issued - t.returned), d.report_date
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and t.item_code is not null
          ) u
          join tandem.charts ch on ch.id = tandem.active_chart(u.item_code, u.rd)
          join tandem.chart_lines cl on cl.chart_id = ch.id
          join tandem.items ing on ing.code = cl.ingredient_code
          group by ing.name order by total desc limit 15
        ) t),
      -- Долги по реализации
      'realization', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
        from (select client_id, sum(delivered - paid - returned) debt
              from tandem.realization_ledger group by client_id) t
        join tandem.realization_clients c on c.id = t.client_id
        where t.debt <> 0));
  end if;

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие: ' || action);
end;
$$;

create or replace function tandem.office_stock(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_id    uuid := nullif(payload->>'id','')::uuid;
  v_type  text;
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_total int;
  v_rows  jsonb;
  v_num   text;
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_code  text := nullif(payload->>'code','');
  v_doc   record;   -- строка документа; имя не d, иначе plpgsql перехватывает алиас d в подзапросах
  v_from  uuid; v_to uuid; v_ca uuid; v_date date; v_reason text;
  v_ext_num text; v_ext_date date;
  v_csv   text; v_sum numeric;
  v_d1    date; v_d2 date; v_res jsonb; v_cnt jsonb := '{}'::jsonb; v_rep record;
begin
  -- ---------- журнал ----------
  if action = 'docs_list' then
    -- count(*) over () считается до limit, поэтому общее число берётся из max(cnt),
    -- а сама служебная колонка убирается из строк (to_jsonb(x) - 'cnt').
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select d.id, d.number, d.doc_type, d.doc_date, d.status, d.store_from, sf.name as store_from_name,
             d.store_to, st.name as store_to_name, d.counteragent_id, c.name as counteragent_name,
             d.reason, d.comment, d.total_sum, d.ext_number, d.ext_date,
             u.name as created_by_name, d.posted_at,
             count(*) over () as cnt
      from tandem.documents d
      left join tandem.stores sf on sf.id = d.store_from
      left join tandem.stores st on st.id = d.store_to
      left join tandem.counteragents c on c.id = d.counteragent_id
      left join tandem.users u on u.id = d.created_by
      where (nullif(payload->>'doc_type','') is null or d.doc_type = payload->>'doc_type')
        and (v_store is null or d.store_from = v_store or d.store_to = v_store)
        and (nullif(payload->>'status','') is null or d.status = payload->>'status')
        and (nullif(payload->>'date_from','') is null or d.doc_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or d.doc_date <= (payload->>'date_to')::date)
        and (v_q = '' or d.number ilike '%'||v_q||'%' or c.name ilike '%'||v_q||'%' or d.comment ilike '%'||v_q||'%')
        and tandem.user_doc_ok(v_user.id, d.store_from, d.store_to)
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  -- ---------- карточка ----------
  if action = 'doc_get' then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if not tandem.user_doc_ok(v_user.id, v_doc.store_from, v_doc.store_to) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- ext_number/ext_date/source_* приходят в ответ сами: карточка отдаёт to_jsonb(документа).
    return jsonb_build_object('ok', true, 'doc', (
      select to_jsonb(dd) || jsonb_build_object(
        'store_from_name', (select name from tandem.stores where id = dd.store_from),
        'store_to_name', (select name from tandem.stores where id = dd.store_to),
        'counteragent_name', (select name from tandem.counteragents where id = dd.counteragent_id),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'item_code', l.item_code, 'name', i.name,
                    'unit_id', coalesce(l.unit_id, i.unit_id), 'item_type', i.item_type, 'qty', l.qty, 'price', l.price, 'sum', l.sum,
                    'fact_qty', l.fact_qty, 'calc_qty', l.calc_qty, 'note', l.note, 'sort_order', l.sort_order,
                    'current_qty', (select qty from tandem.stock_balances b
                                    where b.store_id = coalesce(dd.store_from, dd.store_to) and b.item_code = l.item_code))
                    order by l.sort_order), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'item'),
        'consume', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'name', i.name, 'unit_id', l.unit_id,
                    'qty', l.qty, 'price', l.price, 'sum', l.sum, 'for_item', l.note) order by l.sort_order, i.name), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'consume'))
      from tandem.documents dd where dd.id = v_id));
  end if;

  -- ---------- сохранение черновика ----------
  if action = 'doc_save' then
    v_type := payload->>'doc_type';
    if v_type = 'sale' then
      return tandem.err('validation', 'Продажа создаётся отчётом точки, руками её не заводят'); end if;
    if v_type is null or v_type not in ('invoice_in','transfer','writeoff','production','inventory') then
      return tandem.err('validation', 'Неизвестный тип документа'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    v_date   := coalesce(nullif(payload->>'doc_date','')::date, current_date);
    v_from   := nullif(payload->>'store_from','')::uuid;
    v_to     := nullif(payload->>'store_to','')::uuid;
    v_ca     := nullif(payload->>'counteragent_id','')::uuid;
    v_reason := nullif(payload->>'reason','');
    -- Накладная поставщика — только у прихода; у прочих типов поля молча обнуляются.
    v_ext_num  := case when v_type = 'invoice_in' then nullif(payload->>'ext_number','') end;
    v_ext_date := case when v_type = 'invoice_in' then nullif(payload->>'ext_date','')::date end;
    if v_type = 'invoice_in' and (v_to is null or v_ca is null) then
      return tandem.err('validation', 'Приходу нужны склад и поставщик'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then
      return tandem.err('validation', 'Перемещению нужны два разных склада'); end if;
    if v_type in ('writeoff','production','inventory') and v_from is null then
      return tandem.err('validation', 'Укажите склад'); end if;
    if v_type = 'writeoff' and v_reason is null then
      return tandem.err('validation', 'Укажите причину списания'); end if;
    if v_type = 'invoice_in' then v_from := null; end if;
    if v_type in ('writeoff','production','inventory') then v_to := null; end if;
    -- Кладовщик с привязкой к складам создаёт документы только от своего склада.
    if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_type, v_from, v_to)) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' then
      return tandem.err('validation', 'Строки не переданы'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'lines') x
               where not exists (select 1 from tandem.items where code = x->>'item_code')) then
      return tandem.err('validation', 'В строках есть неизвестная позиция'); end if;
    if v_id is null then
      v_num := tandem.next_doc_number(v_type, v_date);
      insert into tandem.documents (doc_type, number, doc_date, store_from, store_to, counteragent_id, reason,
                                    comment, ext_number, ext_date, created_by, updated_by)
        values (v_type, v_num, v_date, v_from, v_to, v_ca, v_reason,
                payload->>'comment', v_ext_num, v_ext_date, v_user.id, v_user.id)
        returning id into v_id;
    else
      -- C1: документ берётся под лок до проверки статуса — иначе параллельное проведение
      -- успевало пройти между чтением статуса и перезаписью строк, и проведённый документ
      -- оставался с чужими строками.
      select * into v_doc from tandem.documents where id = v_id for update;
      if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
      if v_doc.status <> 'draft' then
        return tandem.err('validation', 'Проведённый документ не правится — сначала отмените проведение'); end if;
      if v_doc.doc_type <> v_type then return tandem.err('validation', 'Тип документа менять нельзя'); end if;
      -- и чужой черновик не перетащить на свой склад: проверяется и старый склад документа.
      if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
        return tandem.err('forbidden', 'Документ чужого склада'); end if;
      v_num := v_doc.number;
      update tandem.documents set doc_date = v_date, store_from = v_from, store_to = v_to, counteragent_id = v_ca,
        reason = v_reason, comment = payload->>'comment', ext_number = v_ext_num, ext_date = v_ext_date,
        updated_by = v_user.id, updated_at = now() where id = v_id;
      delete from tandem.document_lines where document_id = v_id;
    end if;
    insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, fact_qty, note, sort_order)
      select v_id, x->>'item_code',
             case when v_type = 'inventory' then coalesce(nullif(x->>'fact_qty','')::numeric, 0)
                  else coalesce(nullif(x->>'qty','')::numeric, 0) end,
             i.unit_id, nullif(x->>'price','')::numeric,
             case when v_type = 'inventory' then nullif(x->>'fact_qty','')::numeric end,
             nullif(x->>'note',''), (ord-1)::int
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';
    return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num);
  end if;

  -- ---------- предпросмотр / проведение / отмена / удаление ----------
  if action in ('doc_preview','doc_post','doc_unpost','doc_delete') then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is not null and not tandem.user_store_ok(v_user.id,
         tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- Продажа — зеркало отчёта точки: её не проводят, не отменяют и не удаляют руками,
    -- иначе склад разойдётся с отчётом. Пересчёт — действием doc_sales_sync.
    if v_doc.doc_type = 'sale' and action <> 'doc_preview' then
      return tandem.err('validation', 'Продажа ведётся отчётом точки — пересчитайте её во вкладке «Продажи»'); end if;
  end if;
  if action = 'doc_preview' then
    if not exists (select 1 from tandem.documents where id = v_id) then
      return tandem.err('not_found', 'Документ не найден'); end if;
    return jsonb_build_object('ok', true) || tandem.doc_preview(v_id);
  end if;
  if action = 'doc_post'   then return tandem.doc_post(v_id, v_user);   end if;
  if action = 'doc_unpost' then return tandem.doc_unpost(v_id, v_user); end if;
  if action = 'doc_delete' then
    -- C1: тот же лок, что и в doc_save, плюс status = 'draft' в самом delete —
    -- проведённый документ не может быть удалён даже при гонке с doc_post.
    select * into v_doc from tandem.documents where id = v_id for update;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if v_doc.status <> 'draft' then return tandem.err('validation', 'Удалять можно только черновики'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_doc.doc_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    delete from tandem.documents where id = v_id and status = 'draft';
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- продажи: отчёты точек и их документы ----------
  if action = 'doc_sales_list' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, current_date - 7);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'report_id', r.id, 'report_date', r.report_date, 'point_id', p.id, 'point_name', p.name,
        'point_mode', p.mode, 'store_id', p.default_store_id, 'store_name', st.name,
        'money', r.cash + r.kaspi_qr + r.transfer + r.card,
        'lines', (select count(*) from tandem.sale_lines s where s.report_id = r.id)
               + (select count(*) from tandem.takeout_lines t where t.report_id = r.id),
        'doc_id', d.id, 'number', d.number, 'status', d.status, 'cost', d.total_sum, 'sync_note', d.sync_note,
        'sale_sum', (select sum(l.sum) from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item'),
        'state', case when d.id is not null and d.status = 'posted' and d.sync_note like 'Отчёт изменён%' then 'locked'
                      when d.id is not null and d.status = 'posted' and d.sync_note like 'Сбой%' then 'stale'
                      when d.id is not null and d.status = 'posted' then 'posted'
                      when d.id is not null then 'draft'
                      when p.default_store_id is null then 'no_store'
                      when exists (select 1 from tandem.sale_lines s where s.report_id = r.id and s.item_code is not null)
                        or exists (select 1 from tandem.takeout_lines t where t.report_id = r.id and t.item_code is not null)
                        then 'pending'
                      else 'none' end)
        order by r.report_date desc, p.sort_order), '[]'::jsonb)
      from tandem.daily_reports r
      join tandem.points p on p.id = r.point_id
      left join tandem.stores st on st.id = p.default_store_id
      left join tandem.documents d on d.source_kind = 'daily_report' and d.source_id = r.id::text
      where r.report_date between v_d1 and v_d2
        and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
        and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
             or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                          and us.store_id in (p.default_store_id, d.store_from)))));
  end if;

  if action = 'doc_sales_sync' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Пересчитывать продажи может администратор, собственник или бухгалтер'); end if;
    v_d1 := nullif(payload->>'date_from','')::date;
    v_d2 := nullif(payload->>'date_to','')::date;
    if v_d1 is null or v_d2 is null or v_d2 < v_d1 then
      return tandem.err('validation', 'Укажите период'); end if;
    if v_d2 - v_d1 > 31 then return tandem.err('validation', 'Период не длиннее месяца'); end if;
    -- Пакет — одна транзакция: чужой лок ждём не дольше 5 секунд, а сбой одного отчёта не
    -- валит остальные (своя подтранзакция на каждый отчёт, ревью п. 3).
    perform set_config('lock_timeout', '5s', true);
    for v_rep in select r.id from tandem.daily_reports r join tandem.points p on p.id = r.point_id
                 where r.report_date between v_d1 and v_d2
                   and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
                   and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
                        or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                                     and us.store_id = p.default_store_id))
                 order by r.report_date, r.id loop
      begin
        v_res := tandem.sale_sync(v_rep.id);
      exception when others then
        v_res := jsonb_build_object('status', 'error');
        update tandem.documents set sync_note = 'Сбой пересчёта: ' || sqlerrm
          where source_kind = 'daily_report' and source_id = v_rep.id::text;
      end;
      v_type := coalesce(v_res->>'status', 'error');
      v_cnt := v_cnt || jsonb_build_object(v_type, coalesce((v_cnt->>v_type)::int, 0) + 1);
    end loop;
    return jsonb_build_object('ok', true, 'counts', v_cnt);
  end if;

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
             round(b.qty * b.avg_cost, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    -- Итог считается по всей отобранной выборке, а не по одной странице,
    -- иначе сумма под таблицей меняется при листании.
    select coalesce(sum(round(b.qty * b.avg_cost, 2)), 0) into v_sum
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV — тяжёлая строка на весь список, строится только по явному запросу экспорта.
    if coalesce((payload->>'export')::boolean, false) then
      select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' ||
             coalesce(string_agg(concat_ws(';', replace(s.name, ';', ','), b.item_code, replace(i.name, ';', ','), i.unit_id,
                                           b.qty, b.avg_cost, round(b.qty * b.avg_cost, 2)),
                                 E'\n' order by s.name, i.name), '')
        into v_csv
        from tandem.stock_balances b
        join tandem.stores s on s.id = b.store_id
        join tandem.items i on i.code = b.item_code
        where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
          and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
          and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    else
      v_csv := null;
    end if;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total/200.0)::int, 1), 'total_sum', v_sum, 'csv', v_csv);
  end if;

  if action = 'stock_moves' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name,
             m.qty, m.unit_cost, round(m.qty * m.unit_cost, 2) as sum,
             m.document_id, d.number, d.doc_type, count(*) over () as cnt
      from tandem.stock_moves m
      join tandem.documents d on d.id = m.document_id
      join tandem.stores s on s.id = m.store_id
      join tandem.items i on i.code = m.item_code
      where (v_store is null or m.store_id = v_store) and tandem.user_store_ok(v_user.id, m.store_id)
        and (nullif(payload->>'item_code','') is null or m.item_code = payload->>'item_code')
        and (nullif(payload->>'date_from','') is null or m.move_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or m.move_date <= (payload->>'date_to')::date)
      order by m.posted_at desc, m.id desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  if action = 'item_stock' then
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    return jsonb_build_object('ok', true,
      'balances', (select coalesce(jsonb_agg(jsonb_build_object('store_id', b.store_id, 'store_name', s.name,
                             'qty', b.qty, 'avg_cost', b.avg_cost) order by s.name), '[]'::jsonb)
                   from tandem.stock_balances b join tandem.stores s on s.id = b.store_id
                   where b.item_code = v_code and b.qty <> 0 and tandem.user_store_ok(v_user.id, b.store_id)),
      'moves', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code and tandem.user_store_ok(v_user.id, m.store_id) order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  -- Новые действия склада (отчёты) живут в office_stock_ext: их добавление не требует
  -- пересоздавать эту большую функцию целиком.
  return tandem.office_stock_ext(action, payload, v_user);
end $$;

create or replace function public.tandem_test_cleanup(p_pin text)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_charts int; v_left int;
  v_docs int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

  -- Движения держат документ (stock_moves_document_id_fkey on delete restrict) — с 0018
  -- они больше не уходят каскадом и снимаются здесь явно, до удаления самих документов.
  delete from tandem.stock_moves
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       or document_id in (
            select id from tandem.documents
              where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                           where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%'));

  -- Отчёты служебной точки теста zz_test (выключена, на экранах не видна): их продажи сидят
  -- на тестовых складах и уйдут ниже вместе с документами склада. Настоящие точки тест не трогает.
  delete from tandem.checks where point_id = 'zz_kassa';   -- касса теста: чеки, затем отчёты
  delete from tandem.daily_reports where point_id in ('zz_test', 'zz_kassa');

  -- Документы тестовых складов и позиций уходят первыми: на них ссылаются строки,
  -- а сами документы держат FK на stores и items.
  with d as (delete from tandem.documents
      where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                   where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%')
      returning 1)
    select count(*) into v_docs from d;
  delete from tandem.stock_balances
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  -- Счётчики номеров (doc_counters) не трогаем: номера документов не должны повторяться.

  delete from tandem.item_prices where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  delete from tandem.item_rank where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');

  -- Техкарты: сначала строки, где тестовая позиция стоит ингредиентом (в том числе в чужих
  -- картах — иначе FK не даст удалить позицию), затем сами карты тестовых блюд (строки уйдут каскадом).
  delete from tandem.chart_lines where ingredient_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  with d as (delete from tandem.charts where item_code in
      (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%') returning 1)
    select count(*) into v_charts from d;

  with d as (delete from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_items from d;

  -- склад по умолчанию точки ссылается на stores: сначала отвязать, иначе delete упрётся в FK
  update tandem.points set default_store_id = null
    where default_store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%');

  with d as (delete from tandem.item_groups where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_groups from d;
  with d as (delete from tandem.stores where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_stores from d;
  with d as (delete from tandem.counteragents where name like 'ZZ\_TEST\_%' returning 1)
    select count(*) into v_ca from d;
  -- сессии тестовых пользователей уходят каскадом (sessions_user_id_fkey on delete cascade)
  with d as (delete from tandem.users where login like 'zz\_test\_%' returning 1)
    select count(*) into v_users from d;

  delete from tandem.sessions where expires_at < now();

  select (select count(*) from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.item_groups where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.stores where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.counteragents where name like 'ZZ\_TEST\_%')
       + (select count(*) from tandem.users where login like 'zz\_test\_%')
    into v_left;

  return jsonb_build_object('ok', true, 'deleted', jsonb_build_object(
    'items', v_items, 'groups', v_groups, 'stores', v_stores,
    'counteragents', v_ca, 'users', v_users, 'charts', v_charts, 'documents', v_docs), 'leftovers', v_left);
end $$;

-- Служебная касса дымового теста (выключена), как zz_test.
insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_kassa', 'ZZ_TEST_касса', null, 'checks', 999, md5(random()::text), false,
        'Служебная касса дымового теста (tools/office-smoke.mjs). Не включать.')
on conflict (id) do nothing;

-- Учебная касса для маршрута проверки: ассортимент и цены — как у «Енешки-магазина».
insert into tandem.points (id, name, mode, pin, legal_entity, active, sort_order, item_scopes, item_categories)
  select 'ucheb_kassa', 'Учебная касса', 'checks', lpad((floor(random() * 9000) + 1000)::int::text, 4, '0'),
         legal_entity, true, 98, item_scopes, item_categories
    from tandem.points where id = 'eneshka'
  on conflict (id) do nothing;
insert into tandem.item_prices (point_id, item_code, price, source)
  select 'ucheb_kassa', item_code, price, 'copy:eneshka' from tandem.item_prices where point_id = 'eneshka'
  on conflict do nothing;
insert into tandem.item_rank (point_id, item_code, rank, source, in_short_list)
  select 'ucheb_kassa', item_code, rank, 'copy:eneshka', in_short_list from tandem.item_rank where point_id = 'eneshka'
  on conflict do nothing;

do $$
declare f text;
begin
  foreach f in array array['tandem.check_rollup(text,date)', 'tandem.check_apply(text,date)',
      'tandem.check_save(text,jsonb)', 'tandem.check_void(text,jsonb)', 'tandem.check_list(text,date)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on tandem.checks, tandem.check_lines to service_role;
  end if;
end $$;
