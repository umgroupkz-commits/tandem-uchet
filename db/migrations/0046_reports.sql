-- Отчёты склада глазами людей из iiko (сборка 21, контракт R1–R6). Бухгалтер и собственник сверяют
-- ведомость, закупки и прибыль с привычными отчётами iiko — здесь то, что мешало:
--   R1. Ввод начальных остатков (инвентаризация с reason = 'opening', её ставит 0045) — не доход и не убыток:
--       в «Прибыль по точкам» не идёт совсем, в ведомости — своей колонкой «Ввод остатков» (opening).
--   R2. Ведомость: суммы по каждому движению, излишки и недостачи раздельно, код iiko (артикул), итоги.
--   R3. Прибыль: точка склада — и через склад точки по умолчанию; излишки/недостача раздельно, скидки кассы,
--       число проданных позиций с неполной себестоимостью.
--   R4. Продажи: пометка «себестоимость неполная» и до трёх названий того, у чего нет цены.
--   R5. Закупки: средняя накладная и итоги.
--   R6. Готовность: склад точки не привязан к точке; подозрительный фудкост проданного за 30 дней.
-- Второй круг (контракт contracts4, исполнитель T):
--   T1. Готовность: «Учебные склады» (info) — включённые склады с признаком training (колонку добавляет 0045,
--       она применяется раньше): приходы на них не меняют учётные цены, после тестирования склад выключают.
--   T2. Готовность: тип позиции в строках «Одинаковые названия» и «Позиции без группы» — по-русски
--       (товар / блюдо / полуфабрикат / услуга), а не dish/goods (администратор 9, технолог 8, собственник Д6).
-- Меняются tandem.office_stock_ext и tandem.quality_report (целиком, остальные действия — как в каноне),
-- добавляется tandem.cost_missing_at. Миграция повторяется без ошибок (только create or replace).

-- ---------------------------------------------------------------- неполная себестоимость проданного
-- По парам (позиция, дата продажи) — коды того, у чего нет цены, ровно как в карточке позиции
-- (tandem.item_cost(...).missing: сырьё без учётной цены, полуфабрикат без карты, 'cycle:<код>'). Пустой
-- массив — себестоимость полная.
-- Почему не item_cost на каждую пару: за месяц это сотни позиций × 30 дней, а рекурсивный расчёт идёт
-- по дереву карт — отчёт открывался бы секундами. Результат item_cost на дату меняется, только когда
-- в дереве позиции начинает или перестаёт действовать какая-нибудь версия карты (учётные цены от даты
-- не зависят). Поэтому даты продаж позиции режутся по таким границам — началам версий (date_from)
-- и дням после их окончания (date_to + 1) карт всех позиций, до которых её карты дотягиваются в периоде, —
-- и item_cost считается один раз на отрезок, по первой дате продажи в нём. Ответ тот же, что у item_cost
-- на каждую дату.
create or replace function tandem.cost_missing_at(p_items text[], p_dates date[])
returns table (item_code text, doc_date date, missing text[])
language sql stable set search_path to 'tandem', 'public' as $$
  with recursive
  s as (
    select distinct x.item_code, x.doc_date from unnest(p_items, p_dates) as x(item_code, doc_date)
     where x.item_code is not null and x.doc_date is not null
  ),
  lim as (select min(s.doc_date) as d1, max(s.doc_date) as d2 from s),
  -- Всё, до чего карты позиции дотягиваются любой своей версией, действовавшей в периоде. Глубина — как
  -- у item_cost (дальше 10 уровней он не смотрит, там цикл); union отсекает повторы.
  tree (root, node, depth) as (
    select s.item_code, s.item_code, 0 from s
    union
    select t.root, cl.ingredient_code, t.depth + 1
      from tree t
      cross join lim
      join tandem.charts c on c.item_code = t.node and c.date_from <= lim.d2 and (c.date_to is null or c.date_to >= lim.d1)
      join tandem.chart_lines cl on cl.chart_id = c.id
     where t.depth < 10
  ),
  -- materialized и соединение вместо подзапроса на каждую строку: иначе планировщик пересчитывал дерево
  -- для каждой пары (на 9 тысячах пар — секунды)
  bnd as materialized (
    select distinct t.root, b.d
      from (select distinct tree.root, tree.node from tree) t
      cross join lim
      join tandem.charts c on c.item_code = t.node
      cross join lateral (values (c.date_from), (c.date_to + 1)) as b(d)
     where b.d > lim.d1 and b.d <= lim.d2
  ),
  seg as (
    select s.item_code, s.doc_date, coalesce(max(b.d), lim.d1) as seg_from
      from s cross join lim
      left join bnd b on b.root = s.item_code and b.d <= s.doc_date
     group by s.item_code, s.doc_date, lim.d1
  ),
  rep as (select seg.item_code, seg.seg_from, min(seg.doc_date) as d from seg group by seg.item_code, seg.seg_from),
  rc as (
    select rep.item_code, rep.seg_from, c.missing
      from rep cross join lateral tandem.item_cost(rep.item_code, rep.d) c
  )
  select seg.item_code, seg.doc_date, coalesce(rc.missing, '{}'::text[])
    from seg left join rc on rc.item_code = seg.item_code and rc.seg_from = seg.seg_from
$$;

-- ---------------------------------------------------------------- действия отчётов склада
create or replace function tandem.office_stock_ext(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $function$
declare
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_d1    date;
  v_d2    date;
  v_bad   text;
begin
  -- Оборотная ведомость: по каждой позиции остаток на начало, обороты по видам документов
  -- и остаток на конец — как «Расширенная оборотно-сальдовая ведомость» iiko, чтобы
  -- сверять учёт в параллельной работе. Количества расхода — положительные числа.
  -- Суммы — по себестоимости движений (qty × unit_cost), у каждого вида движения своя (R2). Переоценки
  -- остатка (строки adj, второй круг V2) — отдельным полем reval_sum за период; остатки на начало и конец
  -- их включают, поэтому end_sum = start_sum + приход + перемещения (+ к нам − от нас) + производство
  -- (выпуск − расход) − продажи − списания + инвентаризация + ввод остатков + reval_sum, и end_sum
  -- совпадает со стоимостью в «Остатках». Так же сходятся количества.
  -- Инвентаризация (inventory) — нетто, излишки (surplus) и недостачи (shortage) — те же движения
  -- раздельно, положительными числами. Ввод начальных остатков (reason = 'opening', R1) — не результат
  -- пересчёта, а перенос остатков из iiko: своей колонкой opening, в inventory/surplus/shortage не входит;
  -- в «на начало» он, конечно, сидит, если был раньше периода.
  -- totals — итоги всех сумм по строкам ответа (сложены уже округлённые значения — строка «Итого»
  -- совпадает с суммой колонки на экране и в CSV).
  if action = 'stock_turnover_report' then
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (
      with m as (
        -- s — сумма по количеству (у строк-поправок qty = 0, s = 0), adj — поправка (у прочих строк 0)
        select m.item_code, m.qty, m.qty * m.unit_cost as s, m.adj, m.move_date >= v_d1 as cur, d.doc_type,
               d.doc_type = 'inventory' and coalesce(d.reason, '') = 'opening' as op
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
         where m.move_date <= v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
      ), a as (
        select item_code,
          coalesce(sum(qty)     filter (where not cur), 0)                                                    as start_qty,
          coalesce(sum(s + adj) filter (where not cur), 0)                                                    as start_sum,
          coalesce(sum(qty)  filter (where cur and doc_type = 'invoice_in'), 0)                               as income,
          coalesce(sum(s)    filter (where cur and doc_type = 'invoice_in'), 0)                               as income_sum,
          coalesce(sum(qty)  filter (where cur and doc_type = 'transfer' and qty > 0), 0)                     as transfer_in,
          coalesce(sum(s)    filter (where cur and doc_type = 'transfer' and qty > 0), 0)                     as transfer_in_sum,
          coalesce(-sum(qty) filter (where cur and doc_type = 'transfer' and qty < 0), 0)                     as transfer_out,
          coalesce(-sum(s)   filter (where cur and doc_type = 'transfer' and qty < 0), 0)                     as transfer_out_sum,
          coalesce(sum(qty)  filter (where cur and doc_type = 'production' and qty > 0), 0)                   as production_in,
          coalesce(sum(s)    filter (where cur and doc_type = 'production' and qty > 0), 0)                   as production_in_sum,
          coalesce(-sum(qty) filter (where cur and doc_type = 'production' and qty < 0), 0)                   as production_out,
          coalesce(-sum(s)   filter (where cur and doc_type = 'production' and qty < 0), 0)                   as production_out_sum,
          coalesce(-sum(qty) filter (where cur and doc_type = 'sale'), 0)                                     as sales,
          coalesce(-sum(s)   filter (where cur and doc_type = 'sale'), 0)                                     as sales_sum,
          coalesce(-sum(qty) filter (where cur and doc_type = 'writeoff'), 0)                                 as writeoff,
          coalesce(-sum(s)   filter (where cur and doc_type = 'writeoff'), 0)                                 as writeoff_sum,
          coalesce(sum(qty)  filter (where cur and doc_type = 'inventory' and not op and qty > 0), 0)         as surplus,
          coalesce(sum(s)    filter (where cur and doc_type = 'inventory' and not op and qty > 0), 0)         as surplus_sum,
          coalesce(-sum(qty) filter (where cur and doc_type = 'inventory' and not op and qty < 0), 0)         as shortage,
          coalesce(-sum(s)   filter (where cur and doc_type = 'inventory' and not op and qty < 0), 0)         as shortage_sum,
          coalesce(sum(qty)  filter (where cur and op), 0)                                                    as opening,
          coalesce(sum(s)    filter (where cur and op), 0)                                                    as opening_sum,
          coalesce(sum(adj)  filter (where cur), 0)                                                           as reval_sum,
          coalesce(sum(qty), 0)     as end_qty,
          coalesce(sum(s + adj), 0) as end_sum,
          count(*) filter (where cur) as moves
        from m group by item_code
      ), r as (
        -- Округление — здесь, один раз: итоги ниже складывают ровно то, что видно в строках. Нетто
        -- инвентаризации — из округлённых излишков и недостач, чтобы «излишки − недостача» сходилось.
        select a.item_code, i.name, i.unit_id, i.artikul, g.name as group_name,
               round(a.start_qty, 4) as start_qty, round(a.start_sum, 2) as start_sum,
               round(a.income, 4) as income, round(a.income_sum, 2) as income_sum,
               round(a.transfer_in, 4) as transfer_in, round(a.transfer_in_sum, 2) as transfer_in_sum,
               round(a.transfer_out, 4) as transfer_out, round(a.transfer_out_sum, 2) as transfer_out_sum,
               round(a.production_in, 4) as production_in, round(a.production_in_sum, 2) as production_in_sum,
               round(a.production_out, 4) as production_out, round(a.production_out_sum, 2) as production_out_sum,
               round(a.sales, 4) as sales, round(a.sales_sum, 2) as sales_sum,
               round(a.writeoff, 4) as writeoff, round(a.writeoff_sum, 2) as writeoff_sum,
               round(a.surplus, 4) - round(a.shortage, 4) as inventory, round(a.surplus_sum, 2) - round(a.shortage_sum, 2) as inventory_sum,
               round(a.surplus, 4) as surplus, round(a.surplus_sum, 2) as surplus_sum,
               round(a.shortage, 4) as shortage, round(a.shortage_sum, 2) as shortage_sum,
               round(a.opening, 4) as opening, round(a.opening_sum, 2) as opening_sum,
               round(a.reval_sum, 2) as reval_sum,
               round(a.end_qty, 4) as end_qty, round(a.end_sum, 2) as end_sum,
               row_number() over (order by g.name nulls last, i.name, a.item_code) as rn
          from a join tandem.items i on i.code = a.item_code
          left join tandem.item_groups g on g.id = i.group_id
         -- позиция без движений и без количества, но со стоимостью (копейки после продажи «в ноль») тоже
         -- показывается: иначе итог ведомости не сошёлся бы со стоимостью в «Остатках»
         where (a.moves > 0 or round(a.start_qty, 4) <> 0 or round(a.end_qty, 4) <> 0
                or round(a.start_sum, 2) <> 0 or round(a.end_sum, 2) <> 0)
           and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q or i.artikul = v_q)
           and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'rows', (select coalesce(jsonb_agg(jsonb_build_object(
            'item_code', r.item_code, 'name', r.name, 'unit_id', r.unit_id, 'group_name', r.group_name, 'artikul', r.artikul,
            'start_qty', r.start_qty, 'start_sum', r.start_sum,
            'income', r.income, 'income_sum', r.income_sum,
            'transfer_in', r.transfer_in, 'transfer_in_sum', r.transfer_in_sum,
            'transfer_out', r.transfer_out, 'transfer_out_sum', r.transfer_out_sum,
            'production_in', r.production_in, 'production_in_sum', r.production_in_sum,
            'production_out', r.production_out, 'production_out_sum', r.production_out_sum,
            'sales', r.sales, 'sales_sum', r.sales_sum,
            'writeoff', r.writeoff, 'writeoff_sum', r.writeoff_sum,
            'inventory', r.inventory, 'inventory_sum', r.inventory_sum,
            'surplus', r.surplus, 'surplus_sum', r.surplus_sum,
            'shortage', r.shortage, 'shortage_sum', r.shortage_sum,
            'opening', r.opening, 'opening_sum', r.opening_sum,
            'reval_sum', r.reval_sum,
            'end_qty', r.end_qty, 'end_sum', r.end_sum) order by r.rn), '[]'::jsonb) from r),
        'totals', (select jsonb_build_object('items', count(*),
            'start_sum', coalesce(sum(r.start_sum), 0), 'income_sum', coalesce(sum(r.income_sum), 0),
            'transfer_in_sum', coalesce(sum(r.transfer_in_sum), 0), 'transfer_out_sum', coalesce(sum(r.transfer_out_sum), 0),
            'production_in_sum', coalesce(sum(r.production_in_sum), 0), 'production_out_sum', coalesce(sum(r.production_out_sum), 0),
            'sales_sum', coalesce(sum(r.sales_sum), 0), 'writeoff_sum', coalesce(sum(r.writeoff_sum), 0),
            'inventory_sum', coalesce(sum(r.inventory_sum), 0), 'surplus_sum', coalesce(sum(r.surplus_sum), 0),
            'shortage_sum', coalesce(sum(r.shortage_sum), 0), 'opening_sum', coalesce(sum(r.opening_sum), 0),
            'reval_sum', coalesce(sum(r.reval_sum), 0), 'end_sum', coalesce(sum(r.end_sum), 0)) from r)));
  end if;

  -- Продажи и себестоимость за период: по точкам и по позициям, только проведённые продажи.
  -- Выручка — строки проданного (кол-во × цена продажи из отчёта), себестоимость — строки
  -- расхода (списано по техкартам и как есть по средней склада). Фудкост = себестоимость / выручка.
  -- Себестоимость неполная (R4): на дату продажи в техкарте есть сырьё без цены или полуфабрикат без
  -- карты — расход по нему шёл по нулю, и фудкост занижен («Самса» 19,82 % зелёным при «нет цены у: 10»).
  -- У позиции — cost_incomplete и до трёх названий того, чему не хватает цены (missing_names), у точки —
  -- incomplete: сколько таких позиций она продала.
  if action = 'doc_sales_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (
      with d as (
        select doc.id, doc.store_from, doc.doc_date, r.point_id
          from tandem.documents doc
          join tandem.daily_reports r on doc.source_kind = 'daily_report' and doc.source_id = r.id::text
         where doc.doc_type = 'sale' and doc.status = 'posted'
           and doc.doc_date between v_d1 and v_d2
           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
      ), li as (
        select d.point_id, d.doc_date, l.item_code, l.qty, coalesce(l.sum, 0) as revenue
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
      ), lc as (
        select d.point_id, l.note as item_code, coalesce(l.sum, 0) as cost
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
      ), mi as (
        -- пары (позиция, дата продажи) с неполной себестоимостью; оба массива собраны одним проходом —
        -- порядок элементов у них общий
        select cm.item_code, cm.doc_date, cm.missing
          from (select array_agg(z.item_code) as ic, array_agg(z.doc_date) as dd
                  from (select distinct li.item_code, li.doc_date from li) z) a
          cross join lateral tandem.cost_missing_at(a.ic, a.dd) cm
         where cardinality(cm.missing) > 0
      ), mn as (
        -- названия вместо кодов: полуфабрикат или блюдо в списке — это «нет техкарты», а не «нет цены»
        select y.item_code, array_agg(y.nm order by y.nm) as names
          from (select distinct mi.item_code,
                       case when x.code <> x.mc then 'цикл: ' || coalesce(i.name, x.code)
                            when i.item_type in ('dish', 'prepared') then coalesce(i.name, x.code) || ' (нет техкарты)'
                            else coalesce(i.name, x.code) end as nm
                  from mi cross join lateral unnest(mi.missing) as u(mc)
                  cross join lateral (select u.mc, case when u.mc like 'cycle:%' then substr(u.mc, 7) else u.mc end as code) x
                  left join tandem.items i on i.code = x.code) y
         group by y.item_code
      ), pt as (
        select p.id as point_id, p.name, p.sort_order,
               (select count(*) from d where d.point_id = p.id) as docs,
               coalesce((select sum(revenue) from li where li.point_id = p.id), 0) as revenue,
               coalesce((select sum(cost) from lc where lc.point_id = p.id), 0) as cost,
               (select count(distinct li.item_code) from li join mi on mi.item_code = li.item_code and mi.doc_date = li.doc_date
                 where li.point_id = p.id) as incomplete
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
                     'foodcost_pct', case when revenue > 0 then round(cost / revenue * 100, 2) end,
                     'incomplete', incomplete)
                     order by sort_order), '[]'::jsonb) from pt),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', it.item_code, 'name', i.name, 'unit_id', i.unit_id,
                     'qty', round(it.qty, 4), 'revenue', round(it.revenue, 2), 'cost', round(it.cost, 2),
                     'margin', round(it.revenue - it.cost, 2),
                     'foodcost_pct', case when it.revenue > 0 then round(it.cost / it.revenue * 100, 2) end,
                     'cost_incomplete', mn.item_code is not null,
                     'missing_names', coalesce(to_jsonb(mn.names[1:3]), '[]'::jsonb))
                     order by it.revenue desc, i.name), '[]'::jsonb)
                    from it join tandem.items i on i.code = it.item_code
                    left join mn on mn.item_code = it.item_code)));
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
    -- Штучное — только целым, как в заявке: полпирожка не уйдёт ни в акт, ни в перемещение, и выпуск
    -- в плане разошёлся бы с документами (контракт п. 12, ревью п. 69).
    select string_agg(i.name, ', ' order by i.name) into v_bad
      from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x join tandem.items i on i.code = x->>'item_code'
     where i.unit_id in ('шт', 'порц')
       and case when nullif(x->>'fact', '') is null then false
                else (x->>'fact')::numeric <> trunc((x->>'fact')::numeric) end;
    if v_bad is not null then
      return tandem.err('validation', 'Штучные позиции — выпуск только целым числом: ' || v_bad); end if;
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
      -- store_id — склад кухни только для этого вызова, общая настройка не меняется (ревью п. 39).
      return tandem.orders_make_docs(v_d1, v_user, coalesce((payload->>'force')::boolean, false), v_store);
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

  -- «Готовым со склада» (0041, контракт п. 11): на складе с даты позиция продаётся готовой — продажа
  -- списывает саму позицию, а не сырьё по карте. Строки ставят проведённые документы плана заявок
  -- (doc_post, второй круг V4), правит человек.
  -- Права раздела проверяет tandem_office (_list — просмотр склада, остальное — правка); кладовщик
  -- с закреплёнными складами видит и правит только их.
  if action = 'stock_ready_list' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('store_id', r.store_id, 'store_name', s.name, 'item_code', r.item_code,
               'item_name', i.name, 'unit_id', i.unit_id, 'date_from', r.date_from, 'source', r.source)
               order by s.name, i.name), '[]'::jsonb)
        from tandem.store_ready r join tandem.stores s on s.id = r.store_id join tandem.items i on i.code = r.item_code
       where (v_store is null or r.store_id = v_store) and tandem.user_store_ok(v_user.id, r.store_id)));
  end if;
  -- Изменение помечает все затронутые продажи и пересобирает первые 5; ответ {ok, resynced, remaining}.
  -- Пока remaining > 0, фронт зовёт stock_ready_resync {store_id?} — следующие 5 помеченных продаж
  -- складов, доступных пользователю (второй круг V7). Чужой лок ждём не дольше 5 секунд, как пакетный
  -- пересчёт; не дождались — весь вызов откатывается, tandem_office отвечает «Пересчёт уже идёт».
  if action = 'stock_ready_resync' then
    if v_store is not null and not tandem.user_store_ok(v_user.id, v_store) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    perform set_config('lock_timeout', '5s', true);
    return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
  end if;
  if action in ('stock_ready_save', 'stock_ready_delete') then
    if v_store is null then return tandem.err('validation', 'Укажите склад'); end if;
    if not tandem.user_store_ok(v_user.id, v_store) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    perform set_config('lock_timeout', '5s', true);
    if action = 'stock_ready_delete' then
      delete from tandem.store_ready where store_id = v_store and item_code = payload->>'item_code'
        returning date_from into v_d1;
      if v_d1 is null then return tandem.err('not_found', 'Такой строки нет'); end if;
      -- с даты строки продажи снова раскладываются по карте
      perform tandem.store_ready_mark(v_store, payload->>'item_code', v_d1, null);
      return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
    end if;
    if not exists (select 1 from tandem.stores where id = v_store and active) then
      return tandem.err('validation', 'Склад не найден или выключен'); end if;
    if not exists (select 1 from tandem.items where code = payload->>'item_code') then
      return tandem.err('validation', 'Позиция не найдена'); end if;
    begin
      -- формат строгий: «01.10.2026» Postgres молча понял бы как 10 января
      if coalesce(payload->>'date_from', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'date'; end if;
      v_d1 := (payload->>'date_from')::date;
    exception when others then
      return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
    end;
    if v_d1 is null or v_d1 < date '2024-01-01' then
      return tandem.err('validation', 'Укажите дату, с которой склад получает позицию готовой (не раньше 01.01.2024)'); end if;
    perform tandem.store_ready_set(v_store, payload->>'item_code', v_d1, 'manual');
    return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
  end if;

  -- Закупки за период: по поставщикам и по товарам (проведённые приходы). Цена — средняя за период,
  -- мин/макс показывают разброс цен у поставщиков. У поставщика — средняя накладная (avg = сумма /
  -- накладных), в totals — итог отчёта, как «Итого: 133 накладных, 13,9 млн» в iiko (R5). Суммы строк
  -- приходов уже округлены до копеек при проведении, поэтому итог сходится с суммой колонки.
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
            'name', coalesce(c.name, 'без поставщика'), 'docs', x.docs, 'items', x.items, 'sum', round(x.s, 2),
            'avg', round(x.s / x.docs, 2)) order by x.s desc), '[]'::jsonb)
          from (select counteragent_id, count(distinct doc_id) docs, count(distinct item_code) items, sum(s) s from l group by counteragent_id) x
          left join tandem.counteragents c on c.id = x.counteragent_id),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'artikul', i.artikul, 'name', i.name, 'unit_id', i.unit_id,
            'qty', round(x.q, 4), 'sum', round(x.s, 2), 'avg_price', case when x.q <> 0 then round(x.s / x.q, 2) end,
            'min_price', round(x.pmin, 2), 'max_price', round(x.pmax, 2), 'suppliers', x.sup) order by x.s desc), '[]'::jsonb)
          from (select l.item_code, sum(l.qty) q, sum(l.s) s, min(l.s / nullif(l.qty, 0)) pmin, max(l.s / nullif(l.qty, 0)) pmax,
                       count(distinct l.counteragent_id) sup from l group by l.item_code) x
          join tandem.items i on i.code = x.item_code),
        'totals', (select jsonb_build_object('docs', count(distinct l.doc_id), 'sum', round(coalesce(sum(l.s), 0), 2),
            'items', count(distinct l.item_code), 'suppliers', count(distinct coalesce(l.counteragent_id::text, '')),
            'avg', case when count(distinct l.doc_id) > 0 then round(sum(l.s) / count(distinct l.doc_id), 2) end)
          from l)));
  end if;

  -- Прибыль по точкам за период, как «Отчёт о прибылях и убытках» iiko в части продуктов: выручка и
  -- себестоимость проданного, списания (порча, проработка, питание персонала), излишки и недостачи
  -- инвентаризаций (surplus, shortage — положительными; inventory — их нетто, как раньше) по складам точки.
  -- Склады без точки (цех, общий склад) — отдельной строкой.
  -- Точка склада (R3) — привязка склада к точке, а если её нет — точка, у которой этот склад по умолчанию:
  -- продажи точки списываются с её склада по умолчанию, и без этого выручка Столовой Актау («Кухня Актау»
  -- ни к какой точке не привязана) уходила в «Склады без точки». Несколько таких точек — первая по имени
  -- (действующие раньше выключенных).
  -- Ввод начальных остатков (R1) — не доход и не убыток: ни его движения, ни переоценка ушедшего в минус,
  -- которую он сделал, в отчёт не идут (это поправка к оценке того, что было до дня X, — не прибыль периода).
  -- Переоценка остатка (строки adj, второй круг V2) — поле reval = −Σ adj по складам точки за период;
  -- она входит в cost: продажа в минус шла по старой средней, а приход оценил проданное по своей цене.
  -- discounts — скидки кассы: Σ (прейскурант − цена) × кол-во по активным чекам точки, где цена ниже
  -- прейскуранта (у точек без кассы 0); выручка в отчёте уже за вычетом скидок. incomplete — сколько
  -- проданных позиций с неполной себестоимостью на дату продажи (как в doc_sales_report).
  if action = 'stock_pnl_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (with sp as (
        select s.id as store_id,
               coalesce(s.point_id, (select p.id from tandem.points p where p.default_store_id = s.id
                                      order by p.active desc, p.name, p.id limit 1)) as point_id
          from tandem.stores s
      ), rev as (
        select sp.point_id, sum(l.sum) v
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
          join sp on sp.store_id = d.store_from
         where d.doc_type = 'sale' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, d.store_from)
         group by sp.point_id
      ), mv as (
        -- суммы по количеству (строки-поправки с qty = 0 дают в них 0) и поправки adj любых документов — в reval
        select sp.point_id,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'sale'), 0) as sale,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'writeoff'), 0) as writeoff,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'inventory' and m.qty > 0), 0) as surplus,
               coalesce(sum(m.qty * m.unit_cost) filter (where d.doc_type = 'inventory' and m.qty < 0), 0) as shortage,
               coalesce(sum(m.adj), 0) as adj
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
          join sp on sp.store_id = m.store_id
         where (d.doc_type in ('sale', 'writeoff', 'inventory') or m.adj <> 0)
           and not (d.doc_type = 'inventory' and coalesce(d.reason, '') = 'opening')
           and m.move_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by sp.point_id
      ), disc as (
        -- скидки видны тому, кому виден склад точки (кладовщик с закреплёнными складами — только своих)
        select c.point_id, sum((l.price_list - l.price) * l.qty) v
          from tandem.checks c join tandem.check_lines l on l.check_id = c.id
          join tandem.points p on p.id = c.point_id
         where c.status = 'active' and c.check_date between v_d1 and v_d2 and l.price_list > l.price
           and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
                or (p.default_store_id is not null and tandem.user_store_ok(v_user.id, p.default_store_id)))
         group by c.point_id
      ), sold as (
        select distinct sp.point_id, l.item_code, d.doc_date
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
          join sp on sp.store_id = d.store_from
         where d.doc_type = 'sale' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, d.store_from)
      ), mi as (
        select cm.item_code, cm.doc_date
          from (select array_agg(z.item_code) as ic, array_agg(z.doc_date) as dd
                  from (select distinct sold.item_code, sold.doc_date from sold) z) a
          cross join lateral tandem.cost_missing_at(a.ic, a.dd) cm
         where cardinality(cm.missing) > 0
      ), inc as (
        select sold.point_id, count(distinct sold.item_code) as n
          from sold join mi on mi.item_code = sold.item_code and mi.doc_date = sold.doc_date
         group by sold.point_id
      ), k as (
        select point_id from rev union select point_id from mv union select point_id from disc
      ), x as (
        select k.point_id, p.name, p.sort_order,
               round(coalesce(r.v, 0), 2) as revenue,
               round(-coalesce(mv.sale, 0) - coalesce(mv.adj, 0), 2) as cost,
               round(-coalesce(mv.adj, 0), 2) as reval,
               round(-coalesce(mv.writeoff, 0), 2) as writeoff,
               round(coalesce(mv.surplus, 0), 2) as surplus,
               round(-coalesce(mv.shortage, 0), 2) as shortage,
               round(coalesce(dc.v, 0), 2) as discounts,
               coalesce(inc.n, 0) as incomplete
          from k left join tandem.points p on p.id = k.point_id
          left join rev r on r.point_id is not distinct from k.point_id
          left join mv on mv.point_id is not distinct from k.point_id
          left join disc dc on dc.point_id is not distinct from k.point_id
          left join inc on inc.point_id is not distinct from k.point_id
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'point_id', x.point_id, 'point_name', coalesce(x.name, 'Склады без точки'),
          'revenue', x.revenue, 'cost', x.cost, 'reval', x.reval, 'writeoff', x.writeoff,
          'inventory', x.surplus - x.shortage, 'surplus', x.surplus, 'shortage', x.shortage,
          'discounts', x.discounts, 'incomplete', x.incomplete)
          order by x.sort_order nulls last, x.name), '[]'::jsonb) from x)));
  end if;

  -- Расход для 1С: сколько продуктов ушло на проданное за период, в позициях и единицах 1С —
  -- основа акта списания «на основании продаж». Берётся расход проведённых продаж и актов
  -- производства, кроме полуфабрикатов (их в 1С нет: 1С видит сырьё, из которого они сделаны)
  -- и кроме проданного готовым — позиции с действующей на дату продажи техкартой, списанной
  -- самой: её сырьё уже в акте производства (0041, вместо признака sell_from_stock).
  -- Сумма — по себестоимости движений нашего склада; переоценки остатка (строки adj, qty = 0) сюда не
  -- попадают — отбор только по расходу (qty < 0).
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
           and not (d.doc_type = 'sale' and tandem.active_chart(m.item_code, d.doc_date) is not null)
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
end $function$;

-- ---------------------------------------------------------------- готовность (две новые проверки: 6а и 8а)
create or replace function tandem.quality_report(p_user tandem.users)
returns jsonb language plpgsql stable set search_path to 'tandem', 'public' as $function$
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
           case when i.item_type = 'goods' then ''
                when exists (select 1 from tandem.charts x where x.item_code = i.code)
                  then ' — у полуфабриката нет действующей техкарты: продлите или заведите карту на сегодня'
                else ' — полуфабрикат без техкарты: заведите карту или смените тип на «товар» и задайте цену' end as how
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
  -- Тип позиции в строке — по-русски, как в карточке (T2: было «код 1763, dish»).
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', 'код ' || code || ', ' || kind) order by name, code) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name,
             case i.item_type when 'goods' then 'товар' when 'dish' then 'блюдо' when 'prepared' then 'полуфабрикат'
                              when 'service' then 'услуга' else coalesce(i.item_type, 'тип не задан') end as kind,
             row_number() over (order by i.name, i.code) rn
        from tandem.items i
       where i.active and lower(btrim(i.name)) in (select lower(btrim(name)) from tandem.items where active group by 1 having count(*) > 1)) x;
  v_checks := v_checks || jsonb_build_object('id', 'dup_names', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Одинаковые названия',
    'hint', 'Две действующие позиции с одним названием. Лишнюю выключите или переименуйте — иначе загрузка остатков по названию их пропустит.');

  -- 5. Позиции без группы (тип — по-русски, T2: было «морс — dish»).
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', kind) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name,
             case i.item_type when 'goods' then 'товар' when 'dish' then 'блюдо' when 'prepared' then 'полуфабрикат'
                              when 'service' then 'услуга' else coalesce(i.item_type, 'тип не задан') end as kind,
             row_number() over (order by i.name) rn
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

  -- 6а. Склад по умолчанию точки не привязан к ней (R6, находка собственника 2): продажи точки списываются
  -- с её склада по умолчанию, а отчёты группируют склады по привязке склада к точке. У Столовой Актау склад
  -- «Кухня Актау», а сама кухня — «без точки». Склад, привязанный к другой точке, — то же расхождение.
  -- Выключенный склад ловит проверка 6.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', id, 'name', name || ' → ' || store_name, 'detail', detail,
           'point_id', id, 'store_id', store_id) order by rn) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select p.id, p.name, s.id as store_id, s.name as store_name,
             case when s.point_id is null then 'склад ни к какой точке не привязан'
                  else 'склад привязан к другой точке: ' || coalesce(o.name, s.point_id) end as detail,
             row_number() over (order by p.sort_order, p.name) rn
        from tandem.points p
        join tandem.stores s on s.id = p.default_store_id and s.active
        left join tandem.points o on o.id = s.point_id
       where p.active and s.point_id is distinct from p.id) x;
  v_checks := v_checks || jsonb_build_object('id', 'point_store_unlinked', 'severity', 'warn', 'target', 'store', 'count', v_count, 'rows', v_rows,
    'title', 'Склад по умолчанию точки не привязан к ней',
    'hint', 'Склады → Точки продаж: «Привязать склад к точке». Пока привязки нет, склад в разделе «Склады» числится без точки, и в отчётах его легко принять за общий склад.');

  -- 6б. Учебные склады (T1, сборка 21: признак stores.training ставит 0045). Приходы на них не меняют учётные
  -- цены — напоминание выключить склады после тестирования и способ заметить настоящий склад, отмеченный
  -- учебным по ошибке: его приходы молча перестали бы обновлять цены техкарт. Проверка — справочная (info,
  -- в счётчики bad/warn не входит) и появляется, только пока включённые учебные склады есть.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', id, 'name', name, 'detail', detail, 'store_id', id)
           order by rn) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select s.id, s.name,
             case when p.name is not null then 'точка «' || p.name || '»' else 'без точки' end
             || ' · ' || case when n.cnt = 0 then 'приходов нет' else 'проведено приходов: ' || n.cnt end as detail,
             row_number() over (order by s.name) rn
        from tandem.stores s
        left join tandem.points p on p.id = s.point_id
        cross join lateral (select count(*) as cnt from tandem.documents d
                             where d.doc_type = 'invoice_in' and d.status = 'posted' and d.store_to = s.id) n
       where s.active and s.training and tandem.user_store_ok(p_user.id, s.id)) x;
  if v_count > 0 then
    v_checks := v_checks || jsonb_build_object('id', 'training_stores', 'severity', 'info', 'target', 'store', 'count', v_count, 'rows', v_rows,
      'title', 'Учебные склады',
      'hint', 'Приходы на них не меняют учётные цены; после тестирования выключите склад. Если в списке настоящий склад — снимите в его карточке флажок «Учебный склад»: иначе его приходы не обновляют цены техкарт.');
  end if;

  -- 7. Продажи, которые не проведены или устарели, за последние 45 дней — и отчёты точек с действующим
  -- складом, по которым документ продажи так и не создан: склад привязали позже, или первое создание
  -- сорвалось и пометку ставить было некуда (0041, ревью п. 70). Отчёт без проданного (только услуги,
  -- вынос вернули) документа и не должен иметь — его не показываем.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', number, 'name', point_name || ' · ' || doc_date, 'detail', detail) order by doc_date desc) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select y.*, row_number() over (order by y.doc_date desc, y.point_name) rn from (
        select d.number, d.doc_date, coalesce(d.sync_note, 'не проведена') as detail, p.name as point_name
          from tandem.documents d
          join tandem.daily_reports r on d.source_kind = 'daily_report' and d.source_id = r.id::text
          join tandem.points p on p.id = r.point_id
         where d.doc_type = 'sale' and d.doc_date >= current_date - 45
           -- и помеченные пересчётом «готовым» или не пересчитанные после него (второй круг V7, V10)
           and (d.status <> 'posted' or d.sync_note like 'Сбой%' or d.sync_note like 'Отчёт изменён%'
                or d.sync_note like 'Пересчёт:%' or d.sync_note like 'Не пересчитана%')
           and tandem.user_store_ok(p_user.id, d.store_from)
        union all
        select null, r.report_date, 'продажа не создана — нажмите «Провести продажи за период»', p.name
          from tandem.daily_reports r
          join tandem.points p on p.id = r.point_id
          join tandem.stores s on s.id = p.default_store_id and s.active
         where r.report_date >= current_date - 45
           and tandem.user_store_ok(p_user.id, p.default_store_id)
           and not exists (select 1 from tandem.documents d where d.source_kind = 'daily_report' and d.source_id = r.id::text)
           and exists (select 1 from (select sl.item_code, sl.qty as q from tandem.sale_lines sl
                                       where sl.report_id = r.id and sl.item_code is not null
                                      union all
                                      select t.item_code, t.issued - t.returned from tandem.takeout_lines t
                                       where t.report_id = r.id and t.item_code is not null) u
                         join tandem.items i on i.code = u.item_code
                        where i.item_type <> 'service' group by u.item_code having sum(u.q) > 0)) y) x;
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

  -- 8а. Подозрительный фудкост проданного за 30 дней (R6, находка собственника 3): выше 100 % — продано
  -- дешевле продуктов («Сырник 0,7» — 392,78 %), ниже 5 % — обычно в техкарте сырьё без цены или нет
  -- ингредиента («Кексы №1» — 1,12 %). Цифры — по проведённым продажам, как во вкладке «Продажи»; если
  -- себестоимость неполная, в строке — у чего нет цены (до трёх названий).
  with d as (
    select doc.id, doc.doc_date from tandem.documents doc
     where doc.doc_type = 'sale' and doc.status = 'posted'
       and doc.doc_date > current_date - 30 and doc.doc_date <= current_date
       and tandem.user_store_ok(p_user.id, doc.store_from)
  ), li as (
    select l.item_code, d.doc_date, coalesce(l.sum, 0) as revenue
      from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
  ), lc as (
    select l.note as item_code, coalesce(l.sum, 0) as cost
      from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
  ), it as (
    select x.item_code, sum(x.revenue) as revenue, sum(x.cost) as cost from (
      select item_code, revenue, 0::numeric as cost from li
      union all
      select item_code, 0, cost from lc) x
     group by x.item_code
  ), odd as (
    select it.item_code, it.revenue, it.cost, it.cost / it.revenue * 100 as fc
      from it where it.revenue > 0 and (it.cost / it.revenue * 100 > 100 or it.cost / it.revenue * 100 < 5)
  ), mi as (
    select cm.item_code, cm.missing
      from (select array_agg(z.item_code) as ic, array_agg(z.doc_date) as dd
              from (select distinct li.item_code, li.doc_date from li where li.item_code in (select item_code from odd)) z) a
      cross join lateral tandem.cost_missing_at(a.ic, a.dd) cm
     where cardinality(cm.missing) > 0
  ), mn as (
    select y.item_code, array_to_string((array_agg(y.nm order by y.nm))[1:3], ', ')
             || case when count(*) > 3 then ' и ещё ' || (count(*) - 3) else '' end as names
      from (select distinct mi.item_code,
                   case when x.code <> x.mc then 'цикл: ' || coalesce(i.name, x.code)
                        when i.item_type in ('dish', 'prepared') then coalesce(i.name, x.code) || ' (нет техкарты)'
                        else coalesce(i.name, x.code) end as nm
              from mi cross join lateral unnest(mi.missing) as u(mc)
              cross join lateral (select u.mc, case when u.mc like 'cycle:%' then substr(u.mc, 7) else u.mc end as code) x
              left join tandem.items i on i.code = x.code) y
     group by y.item_code
  )
  -- деньги и проценты — по-русски: пробел между тысячами, запятая перед копейками
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', item_code, 'name', name, 'detail', detail) order by rn)
           filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select odd.item_code, i.name,
             'фудкост ' || translate(to_char(round(odd.fc, 1), 'FM999,999,990.0'), ',.', ' ,') || ' %: выручка '
             || translate(to_char(round(odd.revenue, 2), 'FM999,999,999,990.00'), ',.', ' ,') || ' ₸, себестоимость '
             || translate(to_char(round(odd.cost, 2), 'FM999,999,999,990.00'), ',.', ' ,') || ' ₸'
             || coalesce(' — себестоимость неполная, нет цены у: ' || mn.names, '') as detail,
             row_number() over (order by odd.fc > 100 desc, case when odd.fc > 100 then -odd.fc else odd.fc end, i.name) rn
        from odd join tandem.items i on i.code = odd.item_code
        left join mn on mn.item_code = odd.item_code) x;
  v_checks := v_checks || jsonb_build_object('id', 'foodcost_odd', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Подозрительный фудкост проданного за 30 дней',
    'hint', 'Фудкост выше 100 % — продано дешевле продуктов: проверьте цену продажи, выход и брутто в техкарте. Ниже 5 % — обычно в техкарте нет ингредиента или у сырья нет цены, и себестоимость занижена.');

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
end $function$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array['tandem.cost_missing_at(text[],date[])', 'tandem.office_stock_ext(text,jsonb,tandem.users)',
                           'tandem.quality_report(tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
