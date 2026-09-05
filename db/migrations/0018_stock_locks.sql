-- Склад, замечания финального ревью 3а: порядок блокировок в ядре и RPC,
-- движения не теряются каскадом, задел под источник документа и накладную поставщика.
-- Функции пересоздаются целиком — актуальные тела брались из базы (pg_get_functiondef).

-- ---------------------------------------------------------------- схема
-- Движение — первичный факт учёта: удаление документа не должно уносить его молча.
-- Отмена проведения (doc_unpost) снимает движения явно, тестовая уборка — тоже.
alter table tandem.stock_moves drop constraint if exists stock_moves_document_id_fkey;
alter table tandem.stock_moves add constraint stock_moves_document_id_fkey
  foreign key (document_id) references tandem.documents(id) on delete restrict;

-- Задел под подпроекты 4–5: ссылка на источник документа (отчёт точки, импорт),
-- номер и дата накладной поставщика (их вводит кладовщик при приёмке).
alter table tandem.documents
  add column if not exists source_kind text null,
  add column if not exists source_id   text null,
  add column if not exists ext_number  text null,
  add column if not exists ext_date    date null;

-- Воспроизведение движений идёт по id (posted_at у движений одной транзакции одинаков),
-- поэтому индекс должен заканчиваться id, а не датой.
drop index if exists tandem.stock_moves_replay_idx;
create index if not exists stock_moves_replay_idx on tandem.stock_moves (store_id, item_code, id);

-- ---------------------------------------------------------------- ядро: порядок «лок → чтение → запись»

-- Одно движение + пересчёт остатка и средней. Средняя меняется только приходом (qty > 0).
create or replace function tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text,
                                             p_qty numeric, p_cost numeric, p_date date)
returns void language plpgsql as $$
declare v_qty numeric; v_avg numeric; v_cost numeric := coalesce(p_cost, 0);
begin
  if p_qty = 0 then return; end if;
  -- I2: сначала пара (склад, позиция) заводится и берётся под лок, и только потом пишется
  -- движение. В прежнем порядке два параллельных проведения успевали вставить движения
  -- до взаимной блокировки, и средняя считалась каждым по своему, уже устаревшему остатку.
  -- on conflict do nothing дожидается параллельной вставки той же пары, поэтому строка
  -- к моменту select … for update заведомо существует.
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost) values (p_store, p_item, 0, 0)
    on conflict (store_id, item_code) do nothing;
  select qty, avg_cost into v_qty, v_avg from tandem.stock_balances
    where store_id = p_store and item_code = p_item for update;
  insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, move_date)
    values (p_doc, p_line, p_store, p_item, p_qty, v_cost, p_date);
  if p_qty > 0 then
    if v_qty <= 0 then v_avg := v_cost;
    else v_avg := round((v_qty * v_avg + p_qty * v_cost) / (v_qty + p_qty), 4); end if;
  end if;
  update tandem.stock_balances set qty = v_qty + p_qty, avg_cost = v_avg, updated_at = now()
    where store_id = p_store and item_code = p_item;
end $$;

-- Пересборка остатка пары из движений той же формулой в порядке проведения.
create or replace function tandem.rebuild_balance(p_store uuid, p_item text)
returns void language plpgsql as $$
declare r record; v_qty numeric := 0; v_avg numeric := 0;
begin
  -- I3: пара захватывается первым же оператором, до чтения движений. on conflict do update
  -- блокирует строку всегда (do nothing — не блокирует), поэтому параллельная отмена
  -- проведения не может пересобрать ту же пару по половине движений.
  insert into tandem.stock_balances (store_id, item_code) values (p_store, p_item)
    on conflict (store_id, item_code) do update set updated_at = now();
  -- Порядок — по id: posted_at внутри одной транзакции одинаков у всех её движений
  -- (now() не меняется), и сортировка по нему неустойчива — средняя зависела бы от плана.
  for r in select qty, unit_cost from tandem.stock_moves where store_id = p_store and item_code = p_item
           order by id loop
    if r.qty > 0 then
      if v_qty <= 0 then v_avg := r.unit_cost;
      else v_avg := round((v_qty * v_avg + r.qty * r.unit_cost) / (v_qty + r.qty), 4); end if;
    end if;
    v_qty := v_qty + r.qty;
  end loop;
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost, updated_at)
    values (p_store, p_item, v_qty, v_avg, now())
    on conflict (store_id, item_code) do update set qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = now();
end $$;

-- Предпросмотр: расход производства и позиции, уходящие в минус. Ничего не пишет.
create or replace function tandem.doc_preview(p_doc uuid)
returns jsonb language plpgsql stable as $$
declare d record; v_consume jsonb := '[]'::jsonb; v_warn jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb); end if;
  if d.doc_type = 'production' then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id,
             'qty', round(p.qty, 4), 'price', tandem.store_avg(d.store_from, p.item_code),
             'sum', round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2)) order by i.name), '[]'::jsonb)
      into v_consume
      from (select item_code, sum(qty) qty from tandem.doc_consume_plan(p_doc) group by item_code) p
      join tandem.items i on i.code = p.item_code;
  end if;
  -- Исходящие количества по паре (склад, позиция). Инвентаризации здесь нет: её строки
  -- задают факт, а не расход, и итоговая выборка всё равно отбрасывала этот тип —
  -- ветка была мёртвой и только путала при чтении.
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type in ('transfer','writeoff') group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      where d.doc_type = 'production' group by p.item_code
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing where q > 0 group by store_id, item_code)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'store_id', a.store_id,
           'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume);
end $$;

-- Проведение: одна транзакция.
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

-- ---------------------------------------------------------------- RPC склада
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
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  -- ---------- карточка ----------
  if action = 'doc_get' then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
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

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
             round(b.qty * b.avg_cost, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    -- Итог считается по всей отобранной выборке, а не по одной странице,
    -- иначе сумма под таблицей меняется при листании.
    select coalesce(sum(round(b.qty * b.avg_cost, 2)), 0) into v_sum
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store)
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
        where (v_store is null or b.store_id = v_store)
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
      where (v_store is null or m.store_id = v_store)
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
                   where b.item_code = v_code and b.qty <> 0),
      'moves', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- ---------------------------------------------------------------- диспетчер бэк-офиса
create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_token    text := payload->>'token';
  v_user     tandem.users;
  v_pin      text;
  v_hash     text;
  v_calc     text;
  v_ok       boolean;
  v_section  text;
  v_need     text;
  v_attempts int;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;

    if v_user.id is not null and v_user.locked_until > now() then
      return tandem.err('unauthorized', 'Слишком много попыток, подождите 15 минут');
    end if;

    -- crypt считается всегда, отдельными операторами: если сложить всё в одно
    -- выражение, Postgres вправе оборвать вычисление на первом false, и ответ
    -- «такого логина нет» вернётся заметно быстрее ответа «неверный PIN».
    -- Хэш-заглушка — обычный bcrypt-хэш от произвольной строки, не секрет:
    -- он нужен только чтобы crypt было над чем работать.
    v_hash := coalesce(v_user.pin_hash, '$2a$06$nok4o3iwBUM19xMpLFJzoeTS1iAyq43SB1ybN/Yq5Zt2PyGfXmZF6');
    v_calc := crypt(v_pin, v_hash);
    v_ok   := v_user.id is not null and v_calc = v_user.pin_hash;

    if not v_ok then
      if v_user.id is not null then
        -- храповик: локом, чей срок уже истёк, счётчик не наследуется, а начинается заново.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set
          failed_attempts = v_attempts,
          locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
        where id = v_user.id;
      end if;
      return tandem.err('unauthorized', 'Неверный логин или PIN');
    end if;

    update tandem.users set failed_attempts = 0, locked_until = null where id = v_user.id;
    delete from tandem.sessions where expires_at < now();
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into tandem.sessions (token, user_id, expires_at)
      values (v_token, v_user.id, now() + interval '12 hours');
    return jsonb_build_object('ok', true, 'token', v_token, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  v_user := tandem.office_session(coalesce(v_token,''));
  if v_user.id is null then
    return tandem.err('unauthorized', 'Войдите заново');
  end if;

  -- I2: временный PIN держится на сервере, а не на доброй воле фронта.
  if v_user.must_change_pin and action not in ('me','logout','change_pin') then
    return tandem.err('forbidden', 'Сначала смените временный PIN');
  end if;

  if action = 'logout' then
    delete from tandem.sessions where token = v_token;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'me' then
    return jsonb_build_object('ok', true, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  if action = 'change_pin' then
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
      return tandem.err('validation', 'PIN — не меньше 4 цифр');
    end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = false
      where id = v_user.id;
    return jsonb_build_object('ok', true, 'must_change_pin', false);
  end if;

  -- раздел и требуемое право выводятся из имени действия
  v_section := case
    -- Склад стоит первым: doc%/stock% и карточка остатков позиции уходят в него,
    -- иначе item_stock перехватил бы правилом item% раздел номенклатуры.
    when action like 'doc%' or action like 'stock%' or action = 'item_stock' then 'stock'
    when action like 'chart%' or action like 'foodcost%' then 'charts'
    when action like 'group%' or action like 'item%'     then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                      or action like '%\_report' or action like '%\_preview'
                      or action in ('stock_balances','stock_moves','item_stock')
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  if v_section = 'nomenclature' then
    return tandem.office_nomenclature(action, payload, v_user);
  elsif v_section = 'charts' then
    return tandem.office_charts(action, payload, v_user);
  elsif v_section = 'stores' then
    return tandem.office_stores(action, payload, v_user);
  elsif v_section = 'counteragents' then
    return tandem.office_counteragents(action, payload, v_user);
  elsif v_section = 'users' then
    return tandem.office_users(action, payload, v_user);
  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;
exception
  -- Minor: кривой uuid/число/boolean в payload — это ошибка ввода, а не сбой базы.
  when invalid_text_representation then
    return tandem.err('validation', 'Неверный формат поля');
  -- ссылка на несуществующий склад/контрагента/позицию — тоже ошибка ввода, не 500.
  when foreign_key_violation then
    return tandem.err('validation', 'Ссылка на несуществующую запись (склад, контрагент или позиция)');
  -- I4: взаимная блокировка двух проведений — не сбой базы, а «повторите»: одна
  -- транзакция снята Postgres'ом, её документ остался черновиком и проводится заново.
  when deadlock_detected then
    return tandem.err('validation', 'Документ проводится параллельно — повторите');
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
end $$;

-- ---------------------------------------------------------------- уборка после теста
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
revoke all on function tandem.apply_move(uuid,uuid,uuid,text,numeric,numeric,date),
  tandem.rebuild_balance(uuid,text), tandem.doc_preview(uuid),
  tandem.doc_post(uuid,tandem.users) from public;
revoke all on function tandem.office_stock(text,jsonb,tandem.users) from public;
revoke all on function public.tandem_office(text,jsonb) from public;
revoke all on function public.tandem_test_cleanup(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.office_stock(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function public.tandem_office(text,jsonb)             from anon, authenticated;
    revoke all on function public.tandem_test_cleanup(text)             from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb)          to service_role;
    grant execute on function public.tandem_test_cleanup(text)          to service_role;
  end if;
end $$;
