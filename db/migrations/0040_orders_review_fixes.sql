-- Заявки, исправления по ревью 0038:
-- 1) списание продажи больше не зависит от порядка проведения документов: вместо «сначала остаток готового»
--    явный признак items.sell_from_stock (ставится при выпуске по плану) — такая позиция всегда списывается сама;
-- 2) выпуск, отмеченный пекарем, раскладывается по точкам пропорционально заявкам — с кухни уходит испечённое;
-- 3) перемещение по плану не проводится раньше акта производства этого дня;
-- 4) документы до отсечки — только с явным подтверждением; заявки дня и создание документов — по очереди
--    (advisory lock); сбой создания откатывает всё; строже проверки ввода выпуска и заявки;
-- 5) готовое, проданное со склада точки, не попадает в «Расход для 1С» (его сырьё — в производстве кухни);
-- 6) сверка кода собственника через is distinct from: пустой код в настройках не открывает сводку.
-- tandem_api — из 0039, office_stock_ext — из 0038, doc_post — из 0024 (замена версии 0038), точечные замены.

-- Признак позиции: продаётся готовой со склада точки (выпускается на кухне актом производства и
-- приходит на точку перемещением). Продажа такой позиции всегда списывает саму позицию — не ингредиенты
-- по карте: сырьё уже списано актом производства на кухне. Ставится сам, когда позицию впервые
-- выпустили по плану заявок.
alter table tandem.items add column if not exists sell_from_stock boolean not null default false;

-- Подать или поправить заявку целиком. Пустой список строк отзывает заявку.
create or replace function tandem.order_save(p_point text, payload jsonb) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_date date;
  v_id   bigint;
  v_bad  text;
begin
  begin v_date := (payload->>'for_date')::date; exception when others then v_date := null; end;
  if v_date is null then return jsonb_build_object('ok', false, 'error', 'Не указан день заявки'); end if;
  -- Заявки дня и создание документов по ним идут по очереди: иначе правка, сохранённая в момент
  -- создания перемещений, в них бы не попала.
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || v_date::text));
  if tandem.order_locked(v_date) then
    return jsonb_build_object('ok', false, 'error', 'План на этот день уже передан в производство — заявку не изменить. Позвоните на кухню.'); end if;
  if not tandem.order_open(v_date) then
    return jsonb_build_object('ok', false, 'error', 'Приём заявок на этот день закрыт (отсечка ' ||
      coalesce((select value from tandem.settings where key = 'orders_cutoff'), '20:00') || '). Подайте на следующий день.'); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'Нет строк заявки'); end if;
  if exists (select 1 from jsonb_array_elements(payload->'lines') x
              where coalesce(x->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$' or (x->>'qty')::numeric <= 0
                 or nullif(btrim(coalesce(x->>'item_code', '')), '') is null) then
    return jsonb_build_object('ok', false, 'error', 'В каждой строке — позиция и количество больше нуля'); end if;
  select string_agg(coalesce(i.name, x->>'item_code'), ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x
    left join tandem.items i on i.code = x->>'item_code' and i.active and i.for_sale
   where i.code is null;
  if v_bad is not null then return jsonb_build_object('ok', false, 'error', 'Позиции нет в продаже: ' || v_bad); end if;
  -- Штучное — только целыми: полтора беляша не испечь.
  select string_agg(i.name, ', ') into v_bad
    from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
   where i.unit_id in ('шт', 'порц') and (x->>'qty')::numeric <> trunc((x->>'qty')::numeric);
  if v_bad is not null then return jsonb_build_object('ok', false, 'error', 'Штучные позиции — только целым числом: ' || v_bad); end if;

  if jsonb_array_length(payload->'lines') = 0 then
    delete from tandem.orders where point_id = p_point and for_date = v_date;
    return tandem.order_get(p_point, v_date);
  end if;
  insert into tandem.orders (point_id, for_date, sent_by, comment)
    values (p_point, v_date, nullif(btrim(coalesce(payload->>'sent_by', '')), ''), nullif(btrim(coalesce(payload->>'comment', '')), ''))
    on conflict (point_id, for_date) do update set sent_by = excluded.sent_by, comment = excluded.comment, updated_at = now()
    returning id into v_id;
  delete from tandem.order_lines where order_id = v_id;
  insert into tandem.order_lines (order_id, item_code, qty)
    select v_id, x->>'item_code', sum((x->>'qty')::numeric) from jsonb_array_elements(payload->'lines') x group by x->>'item_code';
  return tandem.order_get(p_point, v_date);
end $$;

-- Документы из плана: акт производства на склад кухни (по факту выпуска, где он отмечен, иначе по
-- заявке; только позиции с техкартой) и перемещения с кухни на склады точек. Отмеченный выпуск
-- раскладывается по точкам пропорционально заявкам (штучное — целыми, остаток — точкам с наибольшей
-- дробной частью), чтобы с кухни уходило ровно испечённое. Выпущенные позиции получают признак
-- «продаётся готовой со склада». Создаются черновики; любой сбой откатывает всё — частичного плана нет.
-- До отсечки документы создаются только с p_force (точки ещё могут править заявки).
create or replace function tandem.orders_make_docs(p_for_date date, p_user tandem.users, p_force boolean default false) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_store uuid := nullif((select value from tandem.settings where key = 'orders_store_id'), '')::uuid;
  v_lines jsonb;
  v_r     jsonb;
  v_made  int := 0;
  v_skip  text := '';
  pt      record;
begin
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || p_for_date::text));
  if v_store is null or not exists (select 1 from tandem.stores where id = v_store and active) then
    return tandem.err('validation', 'Не выбран склад кухни, с которого отгружаются заявки'); end if;
  if not exists (select 1 from tandem.orders where for_date = p_for_date) then
    return tandem.err('validation', 'На этот день заявок нет'); end if;
  if tandem.order_open(p_for_date) and not p_force then
    return tandem.err('validation', 'Приём заявок на этот день ещё открыт — точки могут поправить заявки. Создать документы всё равно?'); end if;

  create temp table if not exists _ord_alloc (point_id text, item_code text, qty numeric) on commit drop;
  truncate _ord_alloc;
  insert into _ord_alloc
  with b as (
    select o.point_id, l.item_code, l.qty, pl.fact_qty, i.unit_id in ('шт', 'порц') as whole,
           sum(l.qty) over (partition by l.item_code) as total
      from tandem.order_lines l join tandem.orders o on o.id = l.order_id
      join tandem.items i on i.code = l.item_code
      left join tandem.order_plan pl on pl.for_date = p_for_date and pl.item_code = l.item_code
     where o.for_date = p_for_date
  ), e as (
    select *, case when fact_qty is null then qty else qty * fact_qty / total end as exact from b
  ), f as (
    select *, case when whole and fact_qty is not null then floor(exact) else round(exact, 3) end as base from e
  ), r as (
    select *, row_number() over (partition by item_code order by exact - base desc, point_id) as rn,
           case when whole and fact_qty is not null then fact_qty - sum(base) over (partition by item_code) else 0 end as rest
      from f
  )
  select point_id, item_code, base + case when rn <= rest then 1 else 0 end from r;

  if not exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/production') then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'qty', x.q)), '[]'::jsonb) into v_lines
      from (select a.item_code, sum(a.qty) q from _ord_alloc a
             where tandem.active_chart(a.item_code, p_for_date) is not null group by a.item_code) x where x.q > 0;
    if jsonb_array_length(v_lines) > 0 then
      v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'production', 'doc_date', p_for_date,
               'store_from', v_store, 'comment', 'План выпечки на ' || to_char(p_for_date, 'DD.MM.YYYY'), 'lines', v_lines), p_user);
      if not coalesce((v_r->>'ok')::boolean, false) then
        raise exception using errcode = 'P0001', message = 'Акт производства не создан: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
      update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/production' where id = (v_r->>'id')::uuid;
      update tandem.items set sell_from_stock = true where code in (select x->>'item_code' from jsonb_array_elements(v_lines) x) and not sell_from_stock;
      v_made := v_made + 1;
    end if;
  end if;

  for pt in select o.point_id, p.name, p.default_store_id from tandem.orders o join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date order by p.sort_order loop
    continue when exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/' || pt.point_id);
    if pt.default_store_id is null or pt.default_store_id = v_store then
      v_skip := v_skip || case when v_skip = '' then '' else ', ' end || pt.name; continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty)), '[]'::jsonb) into v_lines
      from _ord_alloc where point_id = pt.point_id and qty > 0;
    continue when jsonb_array_length(v_lines) = 0;
    v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'transfer', 'doc_date', p_for_date,
             'store_from', v_store, 'store_to', pt.default_store_id, 'comment', 'Заявка «' || pt.name || '» на ' || to_char(p_for_date, 'DD.MM.YYYY'),
             'lines', v_lines), p_user);
    if not coalesce((v_r->>'ok')::boolean, false) then
      raise exception using errcode = 'P0001', message = 'Перемещение для «' || pt.name || '» не создано: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
    update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/' || pt.point_id where id = (v_r->>'id')::uuid;
    v_made := v_made + 1;
  end loop;
  return jsonb_build_object('ok', true, 'made', v_made, 'skipped', nullif(v_skip, ''));
end $$;
drop function if exists tandem.orders_make_docs(date, tandem.users);

do $$
declare f text;
begin
  foreach f in array array['tandem.order_save(text,jsonb)', 'tandem.orders_make_docs(date,tandem.users,boolean)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;

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

  if action in ('items','get_report','save_report','aliases','check_save','check_void','check_list','order_get','order_save') then
    if v_pin is distinct from v_owner_pin
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

  -- ---------- заявки точки на завтра (миграция 0038) ----------
  if action = 'order_get' then
    return tandem.order_get(v_point, coalesce(nullif(payload->>'for_date','')::date, tandem.local_now()::date + 1));
  end if;
  if action = 'order_save' then return tandem.order_save(v_point, payload); end if;

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
    if v_pin is distinct from v_owner_pin then
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
      -- Неверные коды за сутки (счётчик единого входа, 0029): кто-то подбирает код точки или собственника.
      'pin_failures', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'count', f.n, 'last', f.last,
          'name', coalesce(p.name, case f.key when 'service' then 'служебный ключ' when '-' then 'вход без точки (собственник, водитель)' else f.key end))
          order by f.n desc), '[]'::jsonb)
        from (select key, count(*) n, max(at) last from tandem.pin_failures where at > now() - interval '24 hours' group by key) f
        left join tandem.points p on p.id = f.key),
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

create or replace function tandem.office_stock_ext(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_d1    date;
  v_d2    date;
begin
  -- Оборотная ведомость: по каждой позиции остаток на начало, обороты по видам документов
  -- и остаток на конец — как «Расширенная оборотно-сальдовая ведомость» iiko, чтобы
  -- сверять учёт в параллельной работе. Количества расхода — положительные числа.
  -- Суммы — по себестоимости движений (qty × unit_cost), как «Сумма с/н» в iiko.
  if action = 'stock_turnover_report' then
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with m as (
        select m.item_code, m.qty, m.qty * m.unit_cost as s, m.move_date, d.doc_type
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
         where m.move_date <= v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
      ), a as (
        select item_code,
          coalesce(sum(qty) filter (where move_date < v_d1), 0)                                          as start_qty,
          coalesce(sum(s)   filter (where move_date < v_d1), 0)                                          as start_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty > 0), 0)   as transfer_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty < 0), 0)  as transfer_out,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty > 0), 0) as production_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty < 0), 0) as production_out,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales_sum,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory_sum,
          coalesce(sum(qty), 0) as end_qty,
          coalesce(sum(s), 0)   as end_sum,
          count(*) filter (where move_date >= v_d1) as moves
        from m group by item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', a.item_code, 'name', i.name, 'unit_id', i.unit_id, 'group_name', g.name,
          'start_qty', round(a.start_qty, 4), 'start_sum', round(a.start_sum, 2),
          'income', round(a.income, 4), 'income_sum', round(a.income_sum, 2),
          'transfer_in', round(a.transfer_in, 4), 'transfer_out', round(a.transfer_out, 4),
          'production_in', round(a.production_in, 4), 'production_out', round(a.production_out, 4),
          'sales', round(a.sales, 4), 'sales_sum', round(a.sales_sum, 2),
          'writeoff', round(a.writeoff, 4), 'writeoff_sum', round(a.writeoff_sum, 2),
          'inventory', round(a.inventory, 4), 'inventory_sum', round(a.inventory_sum, 2),
          'end_qty', round(a.end_qty, 4), 'end_sum', round(a.end_sum, 2))
          order by g.name nulls last, i.name), '[]'::jsonb)
        from a join tandem.items i on i.code = a.item_code
        left join tandem.item_groups g on g.id = i.group_id
       where (a.moves > 0 or round(a.start_qty, 4) <> 0 or round(a.end_qty, 4) <> 0)
         and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
         and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)));
  end if;

  -- Продажи и себестоимость за период: по точкам и по позициям, только проведённые продажи.
  -- Выручка — строки проданного (кол-во × цена продажи из отчёта), себестоимость — строки
  -- расхода (списано по техкартам и как есть по средней склада). Фудкост = себестоимость / выручка.
  if action = 'doc_sales_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (
      with d as (
        select doc.id, doc.store_from, r.point_id
          from tandem.documents doc
          join tandem.daily_reports r on doc.source_kind = 'daily_report' and doc.source_id = r.id::text
         where doc.doc_type = 'sale' and doc.status = 'posted'
           and doc.doc_date between v_d1 and v_d2
           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
      ), li as (
        select d.point_id, l.item_code, l.qty, coalesce(l.sum, 0) as revenue
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
      ), lc as (
        select d.point_id, l.note as item_code, coalesce(l.sum, 0) as cost
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
      ), pt as (
        select p.id as point_id, p.name, p.sort_order,
               (select count(*) from d where d.point_id = p.id) as docs,
               coalesce((select sum(revenue) from li where li.point_id = p.id), 0) as revenue,
               coalesce((select sum(cost) from lc where lc.point_id = p.id), 0) as cost
          from tandem.points p where exists (select 1 from d where d.point_id = p.id)
      ), it as (
        select x.item_code, sum(x.qty) as qty, sum(x.revenue) as revenue, sum(x.cost) as cost from (
          select item_code, qty, revenue, 0::numeric as cost from li
          union all
          select item_code, 0, 0, cost from lc) x
         group by x.item_code
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'points', (select coalesce(jsonb_agg(jsonb_build_object('point_id', point_id, 'point_name', name, 'docs', docs,
                     'revenue', round(revenue, 2), 'cost', round(cost, 2), 'margin', round(revenue - cost, 2),
                     'foodcost_pct', case when revenue > 0 then round(cost / revenue * 100, 2) end)
                     order by sort_order), '[]'::jsonb) from pt),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', it.item_code, 'name', i.name, 'unit_id', i.unit_id,
                     'qty', round(it.qty, 4), 'revenue', round(it.revenue, 2), 'cost', round(it.cost, 2),
                     'margin', round(it.revenue - it.cost, 2),
                     'foodcost_pct', case when it.revenue > 0 then round(it.cost / it.revenue * 100, 2) end)
                     order by it.revenue desc, i.name), '[]'::jsonb)
                    from it join tandem.items i on i.code = it.item_code)));
  end if;

  if action = 'stock_quality_report' then return tandem.quality_report(v_user); end if;

  -- Заявки точек и сводный план выпечки (миграция 0038).
  if action = 'stock_orders_report' then
    if not tandem.office_can(v_user.role, 'doc:transfer', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть заявки'); end if;
    return tandem.orders_report(coalesce(nullif(payload->>'for_date','')::date, tandem.local_now()::date + 1));
  end if;
  if action = 'stock_orders_fact_save' then
    if not tandem.office_can(v_user.role, 'doc:production', 'edit') then
      return tandem.err('forbidden', 'Нет права отмечать выпуск'); end if;
    v_d1 := nullif(payload->>'for_date','')::date;
    if v_d1 is null then return tandem.err('validation', 'Не указан день'); end if;
    if tandem.order_locked(v_d1) then
      return tandem.err('validation', 'Документы по плану уже созданы — выпуск правьте в акте производства'); end if;
    if exists (select 1 from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
                where coalesce(x->>'fact', '') <> '' and x->>'fact' !~ '^[0-9]+([.][0-9]+)?$') then
      return tandem.err('validation', 'Выпуск — число не меньше нуля'); end if;
    if (select count(*) <> count(distinct x->>'item_code') from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x) then
      return tandem.err('validation', 'Позиция в выпуске повторяется'); end if;
    if exists (select 1 from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
                where not exists (select 1 from tandem.items i where i.code = x->>'item_code')) then
      return tandem.err('validation', 'Неизвестная позиция в выпуске'); end if;
    delete from tandem.order_plan p using jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
     where p.for_date = v_d1 and p.item_code = x->>'item_code' and nullif(x->>'fact', '') is null;
    insert into tandem.order_plan (for_date, item_code, fact_qty)
      select v_d1, x->>'item_code', (x->>'fact')::numeric from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
       where nullif(x->>'fact', '') is not null
      on conflict (for_date, item_code) do update set fact_qty = excluded.fact_qty;
    return tandem.orders_report(v_d1);
  end if;
  if action = 'stock_orders_docs_save' then
    if not (tandem.office_can(v_user.role, 'doc:production', 'edit') and tandem.office_can(v_user.role, 'doc:transfer', 'edit')) then
      return tandem.err('forbidden', 'Нет права создавать производство и перемещения'); end if;
    v_d1 := nullif(payload->>'for_date','')::date;
    if v_d1 is null then return tandem.err('validation', 'Не указан день'); end if;
    begin
      return tandem.orders_make_docs(v_d1, v_user, coalesce((payload->>'force')::boolean, false));
    exception when raise_exception then
      return tandem.err('validation', sqlerrm);
    end;
  end if;
  if action = 'stock_orders_settings_save' then
    if not tandem.office_can(v_user.role, 'stores', 'edit') then
      return tandem.err('forbidden', 'Нет права менять настройки заявок'); end if;
    if nullif(payload->>'store_id', '') is not null
       and not exists (select 1 from tandem.stores where id = (payload->>'store_id')::uuid and active) then
      return tandem.err('validation', 'Склад не найден'); end if;
    if coalesce(payload->>'cutoff', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      return tandem.err('validation', 'Время отсечки — в виде 20:00'); end if;
    insert into tandem.settings (key, value) values ('orders_store_id', coalesce(payload->>'store_id', '')), ('orders_cutoff', payload->>'cutoff')
      on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true);
  end if;

  -- Закупки за период: по поставщикам и по товарам (проведённые приходы). Цена — средняя за период,
  -- мин/макс показывают разброс цен у поставщиков.
  if action = 'stock_purchases_report' then
    if not tandem.office_can(v_user.role, 'doc:invoice_in', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть приходы'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (with l as (
        select d.id as doc_id, d.counteragent_id, l.item_code, l.qty, coalesce(l.sum, l.qty * coalesce(l.price, 0)) as s
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
         where d.doc_type = 'invoice_in' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and (v_store is null or d.store_to = v_store)
           and tandem.user_store_ok(v_user.id, d.store_to)
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('counteragent_id', x.counteragent_id,
            'name', coalesce(c.name, 'без поставщика'), 'docs', x.docs, 'items', x.items, 'sum', round(x.s, 2)) order by x.s desc), '[]'::jsonb)
          from (select counteragent_id, count(distinct doc_id) docs, count(distinct item_code) items, sum(s) s from l group by counteragent_id) x
          left join tandem.counteragents c on c.id = x.counteragent_id),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit_id', i.unit_id,
            'qty', round(x.q, 4), 'sum', round(x.s, 2), 'avg_price', case when x.q <> 0 then round(x.s / x.q, 2) end,
            'min_price', round(x.pmin, 2), 'max_price', round(x.pmax, 2), 'suppliers', x.sup) order by x.s desc), '[]'::jsonb)
          from (select l.item_code, sum(l.qty) q, sum(l.s) s, min(l.s / nullif(l.qty, 0)) pmin, max(l.s / nullif(l.qty, 0)) pmax,
                       count(distinct l.counteragent_id) sup from l group by l.item_code) x
          join tandem.items i on i.code = x.item_code)));
  end if;

  -- Прибыль по точкам за период, как «Отчёт о прибылях и убытках» iiko в части продуктов: выручка и
  -- себестоимость проданного, списания (порча, проработка, питание персонала) и итог инвентаризаций
  -- (недостача с минусом) по складам точки. Склады без точки (цех, общий склад) — отдельной строкой.
  if action = 'stock_pnl_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (with rev as (
        select s.point_id, sum(l.sum) v
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
          join tandem.stores s on s.id = d.store_from
         where d.doc_type = 'sale' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, d.store_from)
         group by s.point_id
      ), mv as (
        select s.point_id, d.doc_type, sum(m.qty * m.unit_cost) v
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
          join tandem.stores s on s.id = m.store_id
         where d.doc_type in ('sale', 'writeoff', 'inventory') and m.move_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by s.point_id, d.doc_type
      ), k as (select point_id from rev union select point_id from mv)
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'point_id', k.point_id, 'point_name', coalesce(p.name, 'Склады без точки'),
          'revenue', round(coalesce(r.v, 0), 2),
          'cost', round(-coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'sale'), 0), 2),
          'writeoff', round(-coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'writeoff'), 0), 2),
          'inventory', round(coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'inventory'), 0), 2))
          order by p.sort_order nulls last, p.name), '[]'::jsonb)
        from k left join tandem.points p on p.id = k.point_id left join rev r on r.point_id is not distinct from k.point_id)));
  end if;

  -- Расход для 1С: сколько продуктов ушло на проданное за период, в позициях и единицах 1С —
  -- основа акта списания «на основании продаж». Берётся расход проведённых продаж и актов
  -- производства, кроме полуфабрикатов (их в 1С нет: 1С видит сырьё, из которого они сделаны).
  -- Сумма — по себестоимости движений нашего склада.
  if action = 'stock_1c_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with u as (
        select m.item_code, -sum(m.qty) as qty, -sum(m.qty * m.unit_cost) as s
          from tandem.stock_moves m
          join tandem.documents d on d.id = m.document_id
          join tandem.items i on i.code = m.item_code
         where d.doc_type in ('sale', 'production') and d.status = 'posted' and m.qty < 0
           and i.item_type <> 'prepared'
           -- готовое со склада точки: его сырьё 1С уже видит в акте производства кухни (0040)
           and not (d.doc_type = 'sale' and i.sell_from_stock)
           and m.move_date between v_d1 and v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by m.item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', u.item_code, 'name', i.name, 'unit_id', i.unit_id,
          'qty', round(u.qty, 4), 'sum', round(u.s, 2),
          'code_1c', i.code_1c, 'name_1c', c.name, 'unit_1c', c.unit, 'account_1c', c.account, 'k_1c', i.k_1c,
          'qty_1c', case when i.code_1c is not null and i.k_1c is not null then round(u.qty * i.k_1c, 3) end)
          order by c.name nulls last, i.name), '[]'::jsonb)
        from u join tandem.items i on i.code = u.item_code
        left join tandem.catalog_1c c on c.code = i.code_1c
       where round(u.qty, 4) <> 0));
  end if;

  -- Справочник позиций 1С — для выбора соответствия.
  if action = 'stock_1c_catalog_list' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'unit', unit, 'account', account) order by name), '[]'::jsonb)
        from tandem.catalog_1c));
  end if;

  -- Загрузка справочника 1С (строки материальной ведомости) и, по желанию, соответствий по названию
  -- позиции учёта. Существующие соответствия не перезаписываются — их правят по одной.
  if action = 'stock_1c_catalog_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять справочник 1С'); end if;
    insert into tandem.catalog_1c (code, name, unit, account)
      select btrim(x->>'code'), btrim(x->>'name'), nullif(btrim(x->>'unit'), ''), nullif(btrim(x->>'account'), '')
        from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
       where nullif(btrim(x->>'code'), '') is not null and nullif(btrim(x->>'name'), '') is not null
      on conflict (code) do update set name = excluded.name, unit = excluded.unit, account = excluded.account;
    with l as (select lower(regexp_replace(btrim(x->>'name'), '[[:space:]]+', ' ', 'g')) as n, x->>'code' as code, (x->>'k')::numeric as k
                 from jsonb_array_elements(coalesce(payload->'links', '[]'::jsonb)) x
                where (x->>'k')::numeric > 0 and exists (select 1 from tandem.catalog_1c c where c.code = x->>'code'))
    update tandem.items i set code_1c = l.code, k_1c = l.k
      from l where lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = l.n and i.active and i.code_1c is null;
    return jsonb_build_object('ok', true, 'catalog', (select count(*) from tandem.catalog_1c),
      'linked', (select count(*) from tandem.items where code_1c is not null));
  end if;

  -- Соответствие позиции учёта и позиции 1С: код 1С и сколько единиц 1С в одной нашей единице.
  -- Пустой код снимает соответствие.
  if action = 'stock_1c_link_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять соответствия 1С'); end if;
    if not exists (select 1 from tandem.items where code = payload->>'item_code') then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    if nullif(payload->>'code_1c', '') is not null then
      if not exists (select 1 from tandem.catalog_1c where code = payload->>'code_1c') then
        return tandem.err('validation', 'Такой позиции в справочнике 1С нет'); end if;
      if coalesce(nullif(payload->>'k_1c', '')::numeric, 0) <= 0 then
        return tandem.err('validation', 'Коэффициент — число больше нуля: сколько единиц 1С в одной нашей'); end if;
    end if;
    update tandem.items set code_1c = nullif(payload->>'code_1c', ''),
           k_1c = case when nullif(payload->>'code_1c', '') is null then null else (payload->>'k_1c')::numeric end
     where code = payload->>'item_code';
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function tandem.doc_post(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare
  d record; l record; c record;
  v_cost numeric; v_sum numeric := 0; v_line_sum numeric; v_calc numeric; v_diff numeric;
  v_chart uuid; v_missing text[] := '{}'; v_warn jsonb; v_lines int; v_bad text; v_qty numeric;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'draft' then return tandem.err('validation', 'Документ уже проведён'); end if;
  -- Перемещение по плану заявок — только после проведённого акта производства этого дня: иначе выпечка
  -- уйдёт с кухни по нулевой или старой цене, а кухня — в минус (0040).
  if d.doc_type = 'transfer' and d.source_kind = 'orders' and exists (select 1 from tandem.documents x
       where x.source_kind = 'orders' and x.source_id = split_part(d.source_id, '/', 1) || '/production' and x.status <> 'posted') then
    return tandem.err('validation', 'Сначала проведите акт производства по плану этого дня'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права проводить документы этого типа');
  end if;
  if d.store_from is not null and not exists (select 1 from tandem.stores where id = d.store_from and active) then
    return tandem.err('validation', 'Склад-источник выключен или не найден'); end if;
  if d.store_to is not null and not exists (select 1 from tandem.stores where id = d.store_to and active) then
    return tandem.err('validation', 'Склад-получатель выключен или не найден'); end if;
  select count(*) into v_lines from tandem.document_lines where document_id = p_doc and line_kind = 'item';
  if v_lines = 0 then return tandem.err('validation', 'В документе нет строк'); end if;
  if exists (select 1 from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' and not i.active) then
    return tandem.err('validation', 'В документе есть выключенные позиции'); end if;
  if exists (select 1 from tandem.document_lines where document_id = p_doc and line_kind = 'item'
             group by item_code having count(*) > 1) then
    return tandem.err('validation', 'Позиция повторяется в строках документа — объедините строки'); end if;

  -- Вся построчная проверка — до первой записи: иначе ошибка на второй строке
  -- оставляет движения первой (функция возвращает значение, а не откатывает транзакцию).
  if d.doc_type <> 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and dl.qty <= 0 order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Количество должно быть больше нуля: ' || v_bad); end if;
  end if;
  if d.doc_type = 'invoice_in' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите цену: ' || v_bad); end if;
  elsif d.doc_type = 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.fact_qty is null or dl.fact_qty < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите факт: ' || v_bad); end if;
  end if;

  -- I4: пишущие циклы идут по item_code, а не по sort_order. Порядок строк в документе
  -- задаёт человек, и два документа с одними позициями в разном порядке брали локи
  -- встречно. По item_code порядок блокировок одинаков у всех документов.
  if d.doc_type = 'invoice_in' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      update tandem.document_lines set sum = v_line_sum where id = l.id;
      update tandem.items set cost_price = l.price, cost_date = d.doc_date, cost_source = 'document' where code = l.item_code;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'transfer' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      -- Склады блокируются по возрастанию store_id: встречные перемещения не встают во взаимную блокировку.
      if d.store_from < d.store_to then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
      else
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      end if;
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'writeoff' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'production' then
    for l in select dl.*, i.item_type from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' order by dl.sort_order loop
      if l.item_type not in ('dish','prepared') then return tandem.err('validation', 'Выпускать можно только блюда и полуфабрикаты: ' || l.item_code); end if;
      if tandem.active_chart(l.item_code, d.doc_date) is null then v_missing := v_missing || l.item_code; end if;
    end loop;
    if cardinality(v_missing) > 0 then
      return tandem.err('validation', 'Нет действующей техкарты на дату документа: ' || array_to_string(v_missing, ', '));
    end if;
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_line_sum := 0;
      for c in select item_code, qty from tandem.doc_consume_plan(p_doc) p where p.line_id = l.id order by item_code loop
        -- Округляем расход один раз: и в строку, и в движение, и в сумму идёт одно и то же число.
        v_qty := round(c.qty, 4);
        v_cost := tandem.store_avg(d.store_from, c.item_code);
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', c.item_code, v_qty, i.unit_id, v_cost, round(v_qty * v_cost, 2), l.item_code, 1000 + l.sort_order
          from tandem.items i where i.code = c.item_code;
        perform tandem.apply_move(p_doc, l.id, d.store_from, c.item_code, -v_qty, v_cost, d.doc_date);
        v_line_sum := v_line_sum + round(v_qty * v_cost, 2);
      end loop;
      v_cost := case when l.qty > 0 then round(v_line_sum / l.qty, 4) else 0 end;
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, l.qty, v_cost, d.doc_date);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'sale' then
    -- Продажа (подпроект 4): у позиции есть действующая на дату карта — списываются её
    -- ингредиенты (один уровень, как в производстве), карты нет — сама позиция. Строка
    -- позиции хранит цену продажи и выручку; сумма документа — себестоимость проданного.
    -- Сначала строки расхода по всем позициям, затем движения одним проходом по item_code:
    -- блокировки остатков берутся в одном порядке у всех документов (0023, ревью п. 3).
    -- Цена расхода берётся до движений: средняя склада от расхода не меняется.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- Готовое с кухни (признак sell_from_stock, 0040) продаётся само: его сырьё списал акт производства.
      if tandem.active_chart(l.item_code, d.doc_date) is not null
         and not exists (select 1 from tandem.items x where x.code = l.item_code and x.sell_from_stock) then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          -- Псевдоним pl, а не c: c — переменная цикла ниже, и plpgsql подставил бы её вместо
          -- колонки («record c is not assigned yet» на первой же продаже блюда с картой).
          select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, tandem.store_avg(d.store_from, pl.item_code),
                 round(round(pl.qty, 4) * tandem.store_avg(d.store_from, pl.item_code), 2), l.item_code, 1000 + l.sort_order
            from tandem.doc_consume_plan(p_doc) pl join tandem.items i on i.code = pl.item_code
           where pl.line_id = l.id;
      else
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', l.item_code, round(l.qty, 4), i.unit_id, tandem.store_avg(d.store_from, l.item_code),
                 round(round(l.qty, 4) * tandem.store_avg(d.store_from, l.item_code), 2), l.item_code, 1000 + l.sort_order
            from tandem.items i where i.code = l.item_code;
      end if;
      update tandem.document_lines set sum = round(l.qty * coalesce(l.price, 0), 2) where id = l.id;
    end loop;
    for c in select cl.item_code, cl.qty, cl.price, il.id as line_id
               from tandem.document_lines cl
               join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
              where cl.document_id = p_doc and cl.line_kind = 'consume'
              order by cl.item_code, il.item_code loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, -c.qty, c.price, d.doc_date);
    end loop;
    select coalesce(sum(sum), 0) into v_sum from tandem.document_lines where document_id = p_doc and line_kind = 'consume';

  elsif d.doc_type = 'inventory' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- I4: расчётный остаток читается под локом той же пары, что потом изменит apply_move,
      -- иначе параллельное списание успевало пройти между чтением и записью, и недостача
      -- считалась от остатка, которого уже нет.
      insert into tandem.stock_balances (store_id, item_code) values (d.store_from, l.item_code)
        on conflict (store_id, item_code) do update set updated_at = now();
      select qty into v_calc from tandem.stock_balances
        where store_id = d.store_from and item_code = l.item_code for update;
      v_calc := coalesce(v_calc, 0);
      v_diff := l.fact_qty - v_calc;
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      if v_diff <> 0 then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, v_diff, v_cost, d.doc_date);
      end if;
      v_line_sum := round(v_diff * v_cost, 2);
      update tandem.document_lines set calc_qty = v_calc, qty = l.fact_qty, price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
  end if;

  update tandem.documents set status = 'posted', posted_by = p_user.id, posted_at = now(),
         total_sum = round(v_sum, 2), updated_by = p_user.id, updated_at = now() where id = p_doc;

  select coalesce(jsonb_agg(jsonb_build_object('item_code', t.item_code, 'name', i.name, 'store_id', t.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc) t
    join tandem.stock_balances b on b.store_id = t.store_id and b.item_code = t.item_code
    join tandem.items i on i.code = t.item_code join tandem.stores s on s.id = t.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn, 'total_sum', round(v_sum, 2));
end $$;
