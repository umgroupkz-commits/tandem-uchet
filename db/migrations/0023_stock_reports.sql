-- Отчёт «Оборотная ведомость» и исправления ревью подпроекта 4 (продажи).
--
-- 1. stock_turnover_report (office_stock_ext) — аналог «Расширенной оборотно-сальдовой
--    ведомости» iiko: остаток на начало, обороты по видам документов, остаток на конец.
--    office_stock больше не отвечает unknown_action сама, а отдаёт незнакомые действия в
--    office_stock_ext — новые отчёты склада добавляются туда.
-- 2. Ревью продаж: сбой синхронизации при сохранении отчёта оставляет пометку; продажа не
--    проводится, если инвентаризация склада более поздним днём уже учла проданное; лок отчёта
--    в sale_sync; расход продажи — одним проходом по item_code; пересчёт — по месяцу, с
--    lock_timeout и подтранзакцией на отчёт; список и пересчёт продаж — только точки складов
--    пользователя и только с правом doc:sale; «без техкарты» пересчитывается, когда карта
--    появилась; выключенные позиции — в пометку.
-- 3. Служебная точка zz_test (выключена) для дымового теста — настоящие точки тест больше не трогает.
-- Функции пересоздаются целиком из 0022 (сверены md5 с базой).

insert into tandem.points (id, name, legal_entity, mode, sort_order, pin, active, note)
values ('zz_test', 'ZZ_TEST_точка', null, 'position', 999, md5(random()::text), false,
        'Служебная точка дымового теста (tools/office-smoke.mjs). Не включать.')
on conflict (id) do nothing;

-- Расширение раздела склада: отчёты. Неизвестное здесь действие — unknown_action.
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
      if tandem.active_chart(l.item_code, d.doc_date) is not null then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', c.item_code, round(c.qty, 4), i.unit_id, tandem.store_avg(d.store_from, c.item_code),
                 round(round(c.qty, 4) * tandem.store_avg(d.store_from, c.item_code), 2), l.item_code, 1000 + l.sort_order
            from tandem.doc_consume_plan(p_doc) c join tandem.items i on i.code = c.item_code
           where c.line_id = l.id;
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

-- Синхронизация продажи с отчётом точки (версия 0023, замечания ревью подпроекта 4).
-- Статусы: posted, unchanged, no_store, empty, locked (инвентаризация мешает провести или
-- отменить), error (проведение отказало). Пометка sync_note объясняет всё, что не так.
create or replace function tandem.sale_sync(p_report bigint)
returns jsonb language plpgsql set search_path to 'tandem','public' as $$
declare
  r       record;
  v_doc   record;
  v_store uuid;
  v_lines jsonb;
  v_sys   tandem.users;   -- системный проводящий: права администратора, автор не указан
  v_res   jsonb;
  v_id    uuid;
  v_num   text;
  v_note  text;
  v_skip  text;
  v_inv   text;
  v_same  boolean;
begin
  v_sys.role := 'admin';
  -- Лок отчёта: сохранение отчёта точкой и пересчёт из бэк-офиса идут по очереди. Без него
  -- оба создавали бы первый документ, и второй падал на уникальном индексе источника.
  perform 1 from tandem.daily_reports where id = p_report for update;
  select dr.id, dr.report_date, dr.point_id, p.name as point_name, p.default_store_id
    into r from tandem.daily_reports dr join tandem.points p on p.id = dr.point_id where dr.id = p_report;
  if r.id is null then return tandem.err('not_found', 'Отчёт не найден'); end if;
  select * into v_doc from tandem.documents
    where source_kind = 'daily_report' and source_id = p_report::text for update;

  v_store := r.default_store_id;
  if v_store is not null and not exists (select 1 from tandem.stores where id = v_store and active) then
    v_store := null;
  end if;

  -- Проданное по позиции: продажи + вынос (выдано − возвращено). Без кода, выключенные,
  -- услуги и позиции с итогом ≤ 0 (возврат перекрыл продажу) в склад не идут.
  with u as (
    select s.item_code, s.qty as q, s.qty * coalesce(s.price, 0) as amt
      from tandem.sale_lines s where s.report_id = p_report and s.item_code is not null
    union all
    select t.item_code, t.issued - t.returned, (t.issued - t.returned) * coalesce(t.price, 0)
      from tandem.takeout_lines t where t.report_id = p_report and t.item_code is not null
  ), g as (
    select u.item_code, sum(u.q) as q, sum(u.amt) as amt
      from u join tandem.items i on i.code = u.item_code
     where i.active and i.item_type <> 'service'
     group by u.item_code having sum(u.q) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', q,
           'price', round(amt / q, 2)) order by item_code), '[]'::jsonb)
    into v_lines from g;
  -- Выключенные позиции в отчёте — в пометку: иначе склад разойдётся с отчётом без объяснения.
  select string_agg(distinct i.name, ', ') into v_skip
    from (select item_code from tandem.sale_lines where report_id = p_report and item_code is not null
          union all
          select item_code from tandem.takeout_lines where report_id = p_report and item_code is not null) u
    join tandem.items i on i.code = u.item_code where not i.active;

  if v_store is null then
    if v_doc.id is not null then
      update tandem.documents set sync_note = 'У точки нет действующего склада — продажа не пересчитана'
        where id = v_doc.id;
    end if;
    return jsonb_build_object('ok', true, 'status', 'no_store');
  end if;

  if v_doc.id is not null and v_doc.status = 'posted' then
    v_same := v_doc.store_from = v_store and v_doc.doc_date = r.report_date
       and not exists (
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric)
         except
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item')
       and not exists (
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item'
         except
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric));
    -- Строки те же и пометки нет (или она про «изменён после инвентаризации», а отчёт
    -- вернули к проведённому) — документ верен. Иная пометка («без техкарты», «сбой») —
    -- повод провести заново: например, технолог добавил карту.
    if v_same and (v_doc.sync_note is null or v_doc.sync_note like 'Отчёт изменён%') then
      if v_doc.sync_note is not null then
        update tandem.documents set sync_note = null where id = v_doc.id;
      end if;
      return jsonb_build_object('ok', true, 'status', 'unchanged', 'doc_id', v_doc.id, 'number', v_doc.number);
    end if;
    v_res := tandem.doc_unpost(v_doc.id, v_sys);
    if not coalesce((v_res->>'ok')::boolean, false) then
      update tandem.documents set sync_note = 'Отчёт изменён после проведения, продажа не пересчитана: '
             || coalesce(v_res->>'message', 'отмена проведения не удалась')
        where id = v_doc.id;
      return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_doc.id, 'number', v_doc.number,
                                'message', v_res->>'message');
    end if;
  end if;

  if jsonb_array_length(v_lines) = 0 then
    if v_doc.id is not null then delete from tandem.documents where id = v_doc.id; end if;
    return jsonb_build_object('ok', true, 'status', 'empty');
  end if;

  if v_doc.id is null then
    v_num := tandem.next_doc_number('sale', r.report_date);
    insert into tandem.documents (doc_type, number, doc_date, store_from, comment, source_kind, source_id)
      values ('sale', v_num, r.report_date, v_store, 'Отчёт точки «' || r.point_name || '»',
              'daily_report', p_report::text)
      returning id into v_id;
  else
    v_id := v_doc.id; v_num := v_doc.number;
    update tandem.documents set store_from = v_store, doc_date = r.report_date, updated_at = now()
      where id = v_id;
    delete from tandem.document_lines where document_id = v_id;
  end if;
  insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, sort_order)
    select v_id, x->>'item_code', (x->>'qty')::numeric, i.unit_id, (x->>'price')::numeric, (ord - 1)::int
      from jsonb_array_elements(v_lines) with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';

  -- Инвентаризация этого склада более поздним днём уже учла проданное в своей недостаче:
  -- провести продажу сейчас — списать то же самое второй раз. Документ остаётся черновиком
  -- с пометкой. Инвентаризация в тот же день считается утренней (до продаж) и не мешает.
  select inv.number into v_inv from tandem.documents inv
   where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.store_from = v_store
     and inv.doc_date > r.report_date
   order by inv.doc_date, inv.number limit 1;
  if v_inv is not null then
    update tandem.documents set sync_note = 'Не проведено: после даты отчёта на складе проведена инвентаризация '
           || v_inv || ' — проданное уже учтено в её недостаче'
      where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_id, 'number', v_num,
                              'message', 'инвентаризация ' || v_inv);
  end if;

  v_res := tandem.doc_post(v_id, v_sys);
  if not coalesce((v_res->>'ok')::boolean, false) then
    update tandem.documents set sync_note = 'Не проведено: ' || coalesce(v_res->>'message', '?') where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'error', 'doc_id', v_id, 'number', v_num,
                              'message', v_res->>'message');
  end if;

  -- Блюда без действующей карты списаны как есть — это стоит видеть технологу.
  select string_agg(i.name, ', ' order by i.name) into v_note
    from tandem.document_lines l join tandem.items i on i.code = l.item_code
   where l.document_id = v_id and l.line_kind = 'item' and i.item_type in ('dish','prepared')
     and tandem.active_chart(l.item_code, r.report_date) is null;
  update tandem.documents set sync_note = nullif(concat_ws('. ',
           case when v_note is not null then 'Без техкарты списаны как есть: ' || v_note end,
           case when v_skip is not null then 'Выключенные позиции не списаны: ' || v_skip end), '')
    where id = v_id;
  return jsonb_build_object('ok', true, 'status', 'posted', 'doc_id', v_id, 'number', v_num,
                            'warnings', v_res->'warnings');
end $$;

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
        'money', r.cash + r.kaspi_qr + r.transfer,
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

  if action in ('items','get_report','save_report','aliases') then
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
        limit 1200
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
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, payload->>'shift_by',
       coalesce((payload->>'cash')::numeric,0),
       coalesce((payload->>'kaspi_qr')::numeric,0),
       coalesce((payload->>'transfer')::numeric,0),
       nullif(payload->>'qr_statement','')::numeric,
       nullif(payload->>'tr_statement','')::numeric,
       coalesce((payload->>'cash_open')::numeric,0),
       coalesce((payload->>'cash_handed')::numeric,0),
       nullif(payload->>'cash_counted','')::numeric,
       payload->>'comment')
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer,
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
          'transfer', coalesce(sum(d.transfer),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer) rev
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
          where d.point_id = p.id and d.report_date = current_date - 1)),
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
  delete from tandem.daily_reports where point_id = 'zz_test';

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

-- ---------------------------------------------------------------- права (файл самодостаточен)
revoke all on function tandem.sale_sync(bigint) from public;
revoke all on function tandem.doc_post(uuid,tandem.users) from public;
revoke all on function tandem.office_stock(text,jsonb,tandem.users) from public;
revoke all on function tandem.office_stock_ext(text,jsonb,tandem.users) from public;
revoke all on function public.tandem_api(text,jsonb) from public;
revoke all on function public.tandem_test_cleanup(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.sale_sync(bigint) from anon, authenticated;
    revoke all on function tandem.office_stock(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function tandem.office_stock_ext(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function public.tandem_api(text,jsonb) from anon, authenticated;
    revoke all on function public.tandem_test_cleanup(text) from anon, authenticated;
    grant execute on function public.tandem_api(text,jsonb) to service_role;
    grant execute on function public.tandem_test_cleanup(text) to service_role;
  end if;
end $$;
