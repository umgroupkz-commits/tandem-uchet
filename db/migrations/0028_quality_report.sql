-- Проверка готовности справочников и документов (вкладка «Готовность» раздела «Склад»).
-- office_stock_ext — тело из 0025 + маршрут на tandem.quality_report.

-- Проверка готовности: что в справочниках и документах помешает учёту. Каждая проверка —
-- {id, title, hint, severity: 'bad'|'warn', target, count, rows:[{code, name, detail}]} (до 300 строк).
-- target говорит экрану, куда вести по клику: item — карточка позиции, chart — техкарта,
-- store/point/user/sale — соответствующий раздел (без перехода к конкретной записи).
create or replace function tandem.quality_report(p_user tandem.users)
returns jsonb language plpgsql stable set search_path to 'tandem','public' as $$
declare
  v_checks jsonb := '[]'::jsonb;
  v_rows   jsonb;
  v_count  int;
begin
  -- 1. Сырьё без учётной цены, стоящее в действующих картах: от него зависит себестоимость блюд.
  with ing as (
    select cl.ingredient_code as code, count(distinct c.item_code) as dishes
      from tandem.chart_lines cl
      join tandem.charts c on c.id = cl.chart_id and (c.date_to is null or c.date_to >= current_date) and c.date_from <= current_date
      join tandem.items d on d.code = c.item_code and d.active
     group by cl.ingredient_code
  ), bad as (
    -- Полуфабрикат-ингредиент без своей карты («Вода ПФ») так же обрывает расчёт: его учётную
    -- цену расчёт не читает, поэтому лечится картой либо сменой типа на «товар» с ценой.
    select i.code, i.name, ing.dishes,
           case when i.item_type = 'goods' then '' else ' — полуфабрикат без техкарты: заведите карту или смените тип на «товар» и задайте цену' end as how
      from ing join tandem.items i on i.code = ing.code
     where (i.item_type = 'goods' and i.cost_price is null)
        or (i.item_type in ('dish','prepared') and tandem.active_chart(i.code, current_date) is null)
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name,
           'detail', 'стоит в ' || dishes || ' карт.' || how) order by dishes desc, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (select *, row_number() over (order by dishes desc, name) rn from bad) x;
  v_checks := v_checks || jsonb_build_object('id', 'raw_no_cost', 'severity', 'bad', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Сырьё без цены, из-за которого не считается себестоимость',
    'hint', 'Пока цены нет, себестоимость блюд с этим сырьём не считается. Цена появится сама после первого прихода, либо задайте её в карточке.');

  -- 2. Блюда на продаже без действующей техкарты: при продаже спишутся «как есть», а не сырьём.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.item_type in ('dish','prepared')
         and tandem.active_chart(i.code, current_date) is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'dish_no_chart', 'severity', 'bad', 'target', 'chart', 'count', v_count, 'rows', v_rows,
    'title', 'Блюда на продаже без техкарты',
    'hint', 'Продажа такого блюда спишет со склада само блюдо, а не продукты. Заведите техкарту или снимите блюдо с продажи.');

  -- 3. Позиции на продаже без цены — ни общей, ни по точкам.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.price is null
         and not exists (select 1 from tandem.item_prices p where p.item_code = i.code)) x;
  v_checks := v_checks || jsonb_build_object('id', 'sale_no_price', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'На продаже без цены',
    'hint', 'Точка увидит позицию без цены, выручка по ней посчитается нулём. Задайте цену в карточке или снимите с продажи.');

  -- 4. Одинаковые названия у действующих позиций: путаница при приёмке и загрузке остатков по названию.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', 'код ' || code || ', ' || kind) order by name, code) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name, i.code) rn
        from tandem.items i
       where i.active and lower(btrim(i.name)) in (select lower(btrim(name)) from tandem.items where active group by 1 having count(*) > 1)) x;
  v_checks := v_checks || jsonb_build_object('id', 'dup_names', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Одинаковые названия',
    'hint', 'Две действующие позиции с одним названием. Лишнюю выключите или переименуйте — иначе загрузка остатков по названию их пропустит.');

  -- 5. Позиции без группы.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', kind) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name) rn
        from tandem.items i where i.active and i.group_id is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'no_group', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Позиции без группы', 'hint', 'Их не видно в дереве групп и в отчётах по группам.');

  -- 6. Точки без склада: продажи этих точек склад не списывают.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', id, 'name', name, 'detail', 'продажи не списывают склад') order by sort_order), '[]'::jsonb)
    into v_count, v_rows from tandem.points p
   where p.active and (p.default_store_id is null
      or not exists (select 1 from tandem.stores s where s.id = p.default_store_id and s.active));
  v_checks := v_checks || jsonb_build_object('id', 'point_no_store', 'severity', 'bad', 'target', 'store', 'count', v_count, 'rows', v_rows,
    'title', 'Точки без склада',
    'hint', 'В разделе «Склады» откройте склад точки, выберите точку и отметьте «склад точки по умолчанию».');

  -- 7. Продажи, которые не проведены или устарели, за последние 45 дней.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', number, 'name', point_name || ' · ' || doc_date, 'detail', coalesce(sync_note, 'не проведена')) order by doc_date desc) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select d.number, d.doc_date, d.sync_note, p.name as point_name, row_number() over (order by d.doc_date desc) rn
        from tandem.documents d
        join tandem.daily_reports r on d.source_kind = 'daily_report' and d.source_id = r.id::text
        join tandem.points p on p.id = r.point_id
       where d.doc_type = 'sale' and d.doc_date >= current_date - 45
         and (d.status <> 'posted' or d.sync_note like 'Сбой%' or d.sync_note like 'Отчёт изменён%')
         and tandem.user_store_ok(p_user.id, d.store_from)) x;
  v_checks := v_checks || jsonb_build_object('id', 'sales_not_posted', 'severity', 'bad', 'target', 'sale', 'count', v_count, 'rows', v_rows,
    'title', 'Продажи не проведены', 'hint', 'Откройте вкладку «Продажи» и нажмите «Провести продажи за период». Если мешает инвентаризация — причина написана в строке.');

  -- 8. Отрицательные остатки.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', store_name || ': ' || qty) order by store_name, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select b.item_code as code, i.name, s.name as store_name, round(b.qty, 3) as qty, row_number() over (order by s.name, i.name) rn
        from tandem.stock_balances b join tandem.items i on i.code = b.item_code join tandem.stores s on s.id = b.store_id
       where b.qty < 0 and tandem.user_store_ok(p_user.id, b.store_id)) x;
  v_checks := v_checks || jsonb_build_object('id', 'negative_stock', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Остаток в минусе',
    'hint', 'Продано или списано больше, чем числилось: не внесён приход, не проведено производство или нет стартовой инвентаризации.');

  -- 9. Пользователи: временный PIN и кладовщики без закреплённых складов. Видит только администратор.
  if p_user.role = 'admin' then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('code', login, 'name', name, 'detail', what) order by name), '[]'::jsonb)
      into v_count, v_rows from (
        select u.login, u.name, 'временный PIN — ещё ни разу не входил' as what from tandem.users u where u.active and u.must_change_pin
        union all
        select u.login, u.name, 'кладовщик без закреплённых складов — видит все склады' from tandem.users u
         where u.active and u.role = 'storekeeper' and not exists (select 1 from tandem.user_stores us where us.user_id = u.id)) x;
    v_checks := v_checks || jsonb_build_object('id', 'users', 'severity', 'warn', 'target', 'user', 'count', v_count, 'rows', v_rows,
      'title', 'Пользователи', 'hint', 'Раздел «Пользователи»: закрепите склады за кладовщиками, напомните про первый вход.');
  end if;

  return jsonb_build_object('ok', true, 'checks', v_checks,
    'bad', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'bad' and (c->>'count')::int > 0),
    'warn', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'warn' and (c->>'count')::int > 0));
end $$;

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

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

revoke all on function tandem.quality_report(tandem.users) from public;
revoke all on function tandem.office_stock_ext(text,jsonb,tandem.users) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.quality_report(tandem.users) from anon, authenticated;
    revoke all on function tandem.office_stock_ext(text,jsonb,tandem.users) from anon, authenticated;
  end if;
end $$;
