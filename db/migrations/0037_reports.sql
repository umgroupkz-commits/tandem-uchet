-- Отчёты как в iiko: закупки по поставщикам и товарам (stock_purchases_report), прибыль по точкам
-- с учётом списаний и инвентаризаций (stock_pnl_report). office_stock_ext — тело из 0034 + два действия.

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
