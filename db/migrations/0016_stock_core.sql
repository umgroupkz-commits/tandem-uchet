-- Документы склада: ядро проведения.

create or replace function tandem.next_doc_number(p_type text, p_date date)
returns text language plpgsql as $$
declare v_no int; v_year int := extract(year from p_date)::int; v_pref text;
begin
  v_pref := case p_type when 'invoice_in' then 'ПН' when 'transfer' then 'ПМ' when 'writeoff' then 'СП'
                        when 'production' then 'АП' when 'inventory' then 'ИН' else 'ДК' end;
  insert into tandem.doc_counters (doc_type, year, last_no) values (p_type, v_year, 1)
    on conflict (doc_type, year) do update set last_no = tandem.doc_counters.last_no + 1
    returning last_no into v_no;
  return v_pref || '-' || v_year || '-' || lpad(v_no::text, 6, '0');
end $$;

-- Себестоимость для расхода: средняя склада (независимо от знака остатка), иначе учётная цена позиции, иначе 0.
-- После ухода в минус списания продолжают идти по последней средней склада, а не по глобальной учётной цене.
create or replace function tandem.store_avg(p_store uuid, p_item text)
returns numeric language sql stable as $$
  select coalesce((select nullif(avg_cost, 0) from tandem.stock_balances where store_id = p_store and item_code = p_item),
                  (select cost_price from tandem.items where code = p_item), 0)
$$;

-- Одно движение + пересчёт остатка и средней. Средняя меняется только приходом (qty > 0).
create or replace function tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text,
                                             p_qty numeric, p_cost numeric, p_date date)
returns void language plpgsql as $$
declare v_qty numeric; v_avg numeric; v_cost numeric := coalesce(p_cost, 0);
begin
  if p_qty = 0 then return; end if;
  insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, move_date)
    values (p_doc, p_line, p_store, p_item, p_qty, v_cost, p_date);
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost) values (p_store, p_item, 0, 0)
    on conflict (store_id, item_code) do nothing;
  select qty, avg_cost into v_qty, v_avg from tandem.stock_balances
    where store_id = p_store and item_code = p_item for update;
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
  for r in select qty, unit_cost from tandem.stock_moves where store_id = p_store and item_code = p_item
           order by posted_at, id loop
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

create or replace function tandem.rebuild_balances()
returns int language plpgsql as $$
declare r record; v_bad int := 0; v_qty numeric; v_avg numeric;
begin
  for r in select store_id, item_code from tandem.stock_balances
           union select store_id, item_code from tandem.stock_moves loop
    select qty, avg_cost into v_qty, v_avg from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code;
    perform tandem.rebuild_balance(r.store_id, r.item_code);
    if v_qty is distinct from (select qty from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code)
       or v_avg is distinct from (select avg_cost from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code) then
      v_bad := v_bad + 1;
    end if;
  end loop;
  return v_bad;
end $$;

-- Расход по картам для акта производства: по каждой строке выпуска — ингредиенты первого уровня.
create or replace function tandem.doc_consume_plan(p_doc uuid)
returns table(line_id uuid, item_code text, qty numeric) language sql stable as $$
  select l.id, cl.ingredient_code, sum(cl.brutto * l.qty / c.output_amount)
  from tandem.document_lines l
  join tandem.documents d on d.id = l.document_id
  join tandem.charts c on c.id = tandem.active_chart(l.item_code, d.doc_date)
  join tandem.chart_lines cl on cl.chart_id = c.id
  where l.document_id = p_doc and l.line_kind = 'item'
  group by l.id, cl.ingredient_code
$$;

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
  -- исходящие количества по паре (склад, позиция)
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type in ('transfer','writeoff') group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      where d.doc_type = 'production' group by p.item_code
    union all
    select d.store_from, l.item_code, greatest(coalesce(b.qty,0) - coalesce(l.fact_qty,0), 0)
      from tandem.document_lines l left join tandem.stock_balances b on b.store_id = d.store_from and b.item_code = l.item_code
      where l.document_id = p_doc and l.line_kind = 'item' and d.doc_type = 'inventory'
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing where q > 0 group by store_id, item_code)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'store_id', a.store_id,
           'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0 and d.doc_type <> 'inventory';
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

  if d.doc_type = 'invoice_in' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      update tandem.document_lines set sum = v_line_sum where id = l.id;
      update tandem.items set cost_price = l.price, cost_date = d.doc_date, cost_source = 'document' where code = l.item_code;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'transfer' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
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
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
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
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      v_line_sum := 0;
      for c in select item_code, qty from tandem.doc_consume_plan(p_doc) p where p.line_id = l.id loop
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
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      select coalesce(qty, 0) into v_calc from tandem.stock_balances where store_id = d.store_from and item_code = l.item_code;
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

-- Отмена проведения.
create or replace function tandem.doc_unpost(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare d record; v_inv text; v_pairs text[]; p text; v_warn jsonb;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'posted' then return tandem.err('validation', 'Документ не проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права отменять документы этого типа');
  end if;
  select number into v_inv from tandem.documents inv
    where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id <> p_doc
      and inv.posted_at > d.posted_at and inv.store_from in (d.store_from, d.store_to)
    order by inv.posted_at limit 1;
  if v_inv is not null then
    return tandem.err('validation', 'После этого документа проведена инвентаризация ' || v_inv || ' — сначала отмените её');
  end if;
  with del as (delete from tandem.stock_moves where document_id = p_doc returning store_id, item_code)
    select array_agg(distinct store_id::text || '|' || item_code) into v_pairs from del;
  foreach p in array coalesce(v_pairs, '{}'::text[]) loop
    perform tandem.rebuild_balance(split_part(p, '|', 1)::uuid, split_part(p, '|', 2));
  end loop;
  delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
  update tandem.document_lines set calc_qty = null, sum = null,
         price = case when d.doc_type = 'invoice_in' then price else null end
    where document_id = p_doc;
  update tandem.documents set status = 'draft', posted_by = null, posted_at = null, total_sum = null,
         updated_by = p_user.id, updated_at = now() where id = p_doc;
  -- Пересборка могла увести пары в минус (например, отменён ранний приход) — формат тот же, что у doc_post.
  select coalesce(jsonb_agg(jsonb_build_object('item_code', b.item_code, 'name', i.name, 'store_id', b.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from unnest(coalesce(v_pairs, '{}'::text[])) x(pair)
    join tandem.stock_balances b on b.store_id = split_part(x.pair, '|', 1)::uuid and b.item_code = split_part(x.pair, '|', 2)
    join tandem.items i on i.code = b.item_code
    join tandem.stores s on s.id = b.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn);
end $$;

revoke all on function tandem.next_doc_number(text,date), tandem.store_avg(uuid,text),
  tandem.apply_move(uuid,uuid,uuid,text,numeric,numeric,date), tandem.rebuild_balance(uuid,text),
  tandem.rebuild_balances(), tandem.doc_consume_plan(uuid), tandem.doc_preview(uuid),
  tandem.doc_post(uuid,tandem.users), tandem.doc_unpost(uuid,tandem.users) from public;

-- Под пересборку остатка пары (rebuild_balance) и выборку движений склада.
create index if not exists stock_moves_replay_idx on tandem.stock_moves (store_id, item_code, posted_at, id);
