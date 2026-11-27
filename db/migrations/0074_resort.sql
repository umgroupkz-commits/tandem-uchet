-- 0074: пересорт (ПС) - продавец пробил одно, а отдал другое (вопрос Раисы 27.11.2026: «мохито и гранат по одной цене,
-- кофе и чай 3 в 1, с фабрики или своё»). Фискальный чек не трогается: документ исправляет только склад. Строка:
-- item_code - что пробили по ошибке, note - что отдали на самом деле (код позиции), qty - сколько. Проведение
-- возвращает на склад то, что списала ошибочная продажа (строки back), и списывает то, что ушло на самом деле (строки
-- consume) - по тем же правилам, что продажа (0070: до сырья, готовое - само). Сумма документа - разница
-- себестоимостей. В оборотной ведомости пересорт идёт вместе с продажами. Права - администратор, собственник,
-- технолог-бухгалтер, бухгалтер.
-- Функции правятся точечной заменой по тексту в базе с подсчётом совпадений и меткой /* 0074 */.

alter table tandem.documents drop constraint if exists documents_doc_type_check;
alter table tandem.documents add constraint documents_doc_type_check
  check (doc_type = any (array['invoice_in', 'invoice_out', 'transfer', 'writeoff', 'production', 'inventory', 'sale', 'resort']));
alter table tandem.document_lines drop constraint if exists document_lines_line_kind_check;
alter table tandem.document_lines add constraint document_lines_line_kind_check
  check (line_kind = any (array['item', 'consume', 'back']));

create or replace function tandem.next_doc_number(p_type text, p_date date)
 returns text
 language plpgsql
as $function$
declare v_no int; v_year int := extract(year from p_date)::int; v_pref text;
begin
  v_pref := case p_type when 'invoice_in' then 'ПН' when 'invoice_out' then 'РН' when 'transfer' then 'ПМ'
                        when 'writeoff' then 'СП' when 'production' then 'АП' when 'inventory' then 'ИН'
                        when 'sale' then 'ПД' when 'resort' then 'ПС' else 'ДК' end;
  insert into tandem.doc_counters (doc_type, year, last_no) values (p_type, v_year, 1)
    on conflict (doc_type, year) do update set last_no = tandem.doc_counters.last_no + 1
    returning last_no into v_no;
  return v_pref || '-' || v_year || '-' || lpad(v_no::text, 6, '0');
end $function$;

insert into tandem.role_permissions (role, section, action)
  select r, 'doc:resort', a from unnest(array['admin', 'owner', 'techbuh', 'accountant']) r
  cross join unnest(array['view', 'edit']) a
  where not exists (select 1 from tandem.role_permissions p where p.role = r and p.section = 'doc:resort' and p.action = a);

-- Что списывает продажа позиции на складе в день: позиция без карты или полученная готовой - сама; иначе карта до
-- сырья (0070). Корень пересорта.
create or replace function tandem.item_consume(p_store uuid, p_item text, p_qty numeric, p_date date)
 returns table(item_code text, qty numeric)
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  with recursive r as (
    select tandem.active_chart(p_item, p_date) is not null and not tandem.ready_at(p_store, p_item, p_date) as open
  ), t (item_code, qty, depth, path, open) as (
    select p_item, p_qty, 0, array[]::text[], r.open from r
    union all
    select cl.ingredient_code, cl.brutto * t.qty / c.output_amount, t.depth + 1, t.path || t.item_code,
           t.depth + 1 < 10 and not (cl.ingredient_code = any(t.path || t.item_code))
             and tandem.pf_opens(p_store, cl.ingredient_code, p_date)
      from t join tandem.charts c on c.id = tandem.active_chart(t.item_code, p_date)
      join tandem.chart_lines cl on cl.chart_id = c.id
     where t.open
  )
  select t.item_code, sum(t.qty) from t where not t.open group by t.item_code
$function$;

create or replace function tandem.doc_touch_items(p_doc uuid)
 returns table(store_id uuid, item_code text)
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select distinct m.store_id, m.item_code
    from tandem.stock_moves m join tandem.documents d on d.id = m.document_id and d.status = 'posted'
   where m.document_id = p_doc and m.qty <> 0
  union
  select s.store_id, l.item_code
    from tandem.documents d
    join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
    cross join lateral unnest(case d.doc_type when 'invoice_in' then array[d.store_to]
                                              when 'transfer' then array[d.store_from, d.store_to]
                                              else array[d.store_from] end) s(store_id)
   where d.id = p_doc and d.status = 'draft' and d.doc_type not in ('sale', 'resort')
  union
  select d.store_from, pl.item_code
    from tandem.documents d cross join lateral tandem.doc_consume_plan(d.id) pl
    join tandem.document_lines l on l.id = pl.line_id
   where d.id = p_doc and d.status = 'draft'
     and (d.doc_type = 'production'
          or (d.doc_type in ('writeoff', 'invoice_out') and tandem.pf_opens(d.store_from, l.item_code, d.doc_date)))
  union
  select d.store_from, x.item_code
    from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
    cross join lateral unnest(array[l.item_code, l.note]) r(code)
    cross join lateral tandem.item_consume(d.store_from, r.code, l.qty, d.doc_date) x
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'resort' and r.code is not null
  union
  select d.store_from, t.item_code
    from tandem.documents d
    cross join lateral tandem.sale_touch_items(d.store_from, d.doc_date,
      array(select l.item_code from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item')) t(item_code)
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'sale'
$function$;

create or replace function tandem.doc_preview(p_doc uuid)
 returns jsonb
 language plpgsql
 stable
as $function$
declare d record; v_consume jsonb := '[]'::jsonb; v_back jsonb := '[]'::jsonb; v_warn jsonb; v_charts jsonb := '[]'::jsonb;
        v_skipped jsonb := '[]'::jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then
    return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb,'warnings_charts','[]'::jsonb,'skipped','[]'::jsonb,'back','[]'::jsonb);
  end if;
  if d.doc_type in ('production', 'writeoff', 'invoice_out', 'inventory') then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id,
             'qty', round(p.qty, 4),
             'price', case when d.doc_type <> 'inventory' then tandem.store_avg(d.store_from, p.item_code) end,
             'sum', case when d.doc_type <> 'inventory' then round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2) end)
             order by i.name), '[]'::jsonb)
      into v_consume
      from (select pl.item_code, sum(pl.qty) qty from tandem.doc_consume_plan(p_doc) pl
              join tandem.document_lines l on l.id = pl.line_id
             where d.doc_type = 'production' or tandem.pf_opens(d.store_from, l.item_code, d.doc_date)
             group by pl.item_code) p
      join tandem.items i on i.code = p.item_code;
  elsif d.doc_type = 'resort' then
    -- 0074: что спишется (отдали на самом деле) и что вернётся на склад (пробили по ошибке)
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id, 'qty', round(p.qty, 4),
             'price', tandem.store_avg(d.store_from, p.item_code), 'sum', round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2))
             order by i.name), '[]'::jsonb) into v_consume
      from (select x.item_code, sum(x.qty) qty from tandem.document_lines l
              cross join lateral tandem.item_consume(d.store_from, l.note, l.qty, d.doc_date) x
             where l.document_id = p_doc and l.line_kind = 'item' and l.note is not null group by x.item_code) p
      join tandem.items i on i.code = p.item_code;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id, 'qty', round(p.qty, 4))
             order by i.name), '[]'::jsonb) into v_back
      from (select x.item_code, sum(x.qty) qty from tandem.document_lines l
              cross join lateral tandem.item_consume(d.store_from, l.item_code, l.qty, d.doc_date) x
             where l.document_id = p_doc and l.line_kind = 'item' group by x.item_code) p
      join tandem.items i on i.code = p.item_code;
  end if;
  if d.doc_type = 'inventory' then
    select coalesce(jsonb_agg(x.e order by x.e->>'name'), '[]'::jsonb) into v_skipped
      from (select e from jsonb_array_elements(v_consume) e
             where not exists (select 1 from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
                                and l.item_code = e->>'item_code'
                                and not tandem.pf_opens(d.store_from, l.item_code, d.doc_date))) x;
  end if;
  if d.doc_type = 'production' then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'item_name', x.name) order by x.o, x.item_code), '[]'::jsonb)
      into v_charts
      from (select dl.item_code, i.name, min(dl.sort_order) as o
              from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' and i.item_type in ('dish', 'prepared')
               and tandem.active_chart(dl.item_code, d.doc_date) is null
             group by dl.item_code, i.name) x;
  end if;
  -- Исходящие количества по паре (склад, позиция). Инвентаризации здесь нет: её строки задают факт, а не расход.
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and (d.doc_type = 'transfer'
            or (d.doc_type in ('writeoff', 'invoice_out') and not tandem.pf_opens(d.store_from, l.item_code, d.doc_date)))
     group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      join tandem.document_lines l on l.id = p.line_id
     where d.doc_type = 'production'
        or (d.doc_type in ('writeoff', 'invoice_out') and tandem.pf_opens(d.store_from, l.item_code, d.doc_date))
     group by p.item_code
    union all
    -- Выпуск того же акта покрывает расход: полуфабрикат, выпускаемый здесь же и сразу идущий в блюдо,
    -- в минус не уходит (проведение выпускает его раньше блюда, 0041, ревью п. 32).
    select d.store_from, l.item_code, -sum(l.qty)
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type = 'production' group by l.item_code
    union all
    select d.store_from, (e->>'item_code'), (e->>'qty')::numeric from jsonb_array_elements(case when d.doc_type = 'resort' then v_consume else '[]'::jsonb end) e
    union all
    select d.store_from, (e->>'item_code'), -(e->>'qty')::numeric from jsonb_array_elements(v_back) e
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing group by store_id, item_code having sum(q) > 0)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'item_type', i.item_type,
           'store_id', a.store_id, 'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume, 'warnings_charts', v_charts, 'skipped', v_skipped, 'back', v_back);
end $function$;

do $mig$
declare
  v text; n int;
  c1a constant text := '  -- Место документа в порядке проведения его дня (S5.3)';
  c1b constant text := $r$  -- 0074: у пересорта в каждой строке - что отдали на самом деле (note): существующая позиция, не та же самая.
  if d.doc_type = 'resort' then   /* 0074 */
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
     where dl.document_id = p_doc and dl.line_kind = 'item'
       and (dl.note is null or dl.note = dl.item_code or not exists (select 1 from tandem.items i where i.code = dl.note));
    if v_bad is not null then return tandem.err('validation', 'Укажите, что отдали на самом деле: ' || v_bad); end if;
  end if;
  -- Место документа в порядке проведения его дня (S5.3)$r$;
  c2a constant text := '  elsif d.doc_type = ''invoice_out'' then';
  c2b constant text := $r$  elsif d.doc_type = 'resort' then
    -- 0074: пересорт. Что пробили по ошибке, возвращается на склад (строки back), что отдали на самом деле, - списывается
    -- (строки consume), по правилам продажи (tandem.item_consume). Цена - средняя склада; сумма - разница себестоимостей.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind in ('consume', 'back');
    insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
      select p_doc, 'back', x.item_code, round(x.qty, 4), i.unit_id, pc.cost, round(round(x.qty, 4) * pc.cost, 2), rl.item_code, 1000 + rl.sort_order
        from tandem.document_lines rl
        cross join lateral tandem.item_consume(d.store_from, rl.item_code, rl.qty, d.doc_date) x
        join tandem.items i on i.code = x.item_code
        cross join lateral (select tandem.store_avg(d.store_from, x.item_code) as cost offset 0) pc
       where rl.document_id = p_doc and rl.line_kind = 'item';
    insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
      select p_doc, 'consume', x.item_code, round(x.qty, 4), i.unit_id, pc.cost, round(round(x.qty, 4) * pc.cost, 2), rl.item_code, 2000 + rl.sort_order
        from tandem.document_lines rl
        cross join lateral tandem.item_consume(d.store_from, rl.note, rl.qty, d.doc_date) x
        join tandem.items i on i.code = x.item_code
        cross join lateral (select tandem.store_avg(d.store_from, x.item_code) as cost offset 0) pc
       where rl.document_id = p_doc and rl.line_kind = 'item';
    for c in select cl.item_code, case when cl.line_kind = 'back' then cl.qty else -cl.qty end as qty, cl.price, il.id as line_id
               from tandem.document_lines cl
               join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
              where cl.document_id = p_doc and cl.line_kind in ('consume', 'back')
              order by cl.item_code, il.item_code, cl.line_kind loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, c.qty, c.price, d.doc_date);
    end loop;
    select coalesce(sum(case when line_kind = 'consume' then sum else -sum end), 0) into v_sum
      from tandem.document_lines where document_id = p_doc and line_kind in ('consume', 'back');

  elsif d.doc_type = 'invoice_out' then$r$;
  u1a constant text := $r$delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';$r$;
  u1b constant text := $r$delete from tandem.document_lines where document_id = p_doc and line_kind in ('consume', 'back');   /* 0074 */$r$;
  s1a constant text := $r$('invoice_in','invoice_out','transfer','writeoff','production','inventory') then /* 0071 */$r$;
  s1b constant text := $r$('invoice_in','invoice_out','transfer','writeoff','production','inventory','resort') then /* 0071 */ /* 0074 */$r$;
  s2a constant text := $r$if v_type in ('writeoff','production','inventory') and v_from is null then$r$;
  s2b constant text := $r$if v_type in ('writeoff','production','inventory','invoice_out','resort') and v_from is null then$r$;
  s3a constant text := $r$if v_type in ('writeoff','production','inventory','invoice_out') then v_to := null; end if;$r$;
  s3b constant text := $r$if v_type in ('writeoff','production','inventory','invoice_out','resort') then v_to := null; end if;$r$;
  s4a constant text := $r$'note', l.note, 'sort_order', l.sort_order,$r$;
  s4b constant text := $r$'note', l.note, 'note_name', (select n.name from tandem.items n where n.code = l.note), 'sort_order', l.sort_order,$r$;
  s5a constant text := $r$'for_item', l.note, 'artikul', i.artikul,$r$;
  s5b constant text := $r$'for_item', l.note, 'back', l.line_kind = 'back', 'artikul', i.artikul,$r$;
  s6a constant text := $r$where l.document_id = dd.id and l.line_kind = 'consume'))$r$;
  s6b constant text := $r$where l.document_id = dd.id and l.line_kind in ('consume', 'back')))$r$;
  t1a constant text := $r$doc_type in ('sale', 'invoice_out') /* 0071 */$r$;
  t1b constant text := $r$doc_type in ('sale', 'invoice_out', 'resort') /* 0071 */ /* 0074 */$r$;
begin
  v := pg_get_functiondef('tandem.doc_post(uuid,tandem.users)'::regprocedure);
  if position('/* 0074 */' in v) = 0 then
    n := (length(v) - length(replace(v, c1a, ''))) / length(c1a);
    if n <> 1 then raise exception '0074: в doc_post метка порядка дня найдена % раз', n; end if;
    n := (length(v) - length(replace(v, c2a, ''))) / length(c2a);
    if n <> 1 then raise exception '0074: в doc_post ветвь расходной накладной найдена % раз', n; end if;
    execute replace(replace(v, c1a, c1b), c2a, c2b);
  end if;

  v := pg_get_functiondef('tandem.doc_unpost(uuid,tandem.users)'::regprocedure);
  if position('/* 0074 */' in v) = 0 then
    n := (length(v) - length(replace(v, u1a, ''))) / length(u1a);
    if n <> 1 then raise exception '0074: в doc_unpost удаление расхода найдено % раз', n; end if;
    execute replace(v, u1a, u1b);
  end if;

  v := pg_get_functiondef('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure);
  if position('/* 0074 */' in v) = 0 then
    if (length(v) - length(replace(v, s1a, ''))) / length(s1a) <> 1 then raise exception '0074: office_stock s1'; end if;
    if (length(v) - length(replace(v, s2a, ''))) / length(s2a) <> 1 then raise exception '0074: office_stock s2'; end if;
    if (length(v) - length(replace(v, s3a, ''))) / length(s3a) <> 1 then raise exception '0074: office_stock s3'; end if;
    if (length(v) - length(replace(v, s4a, ''))) / length(s4a) <> 1 then raise exception '0074: office_stock s4'; end if;
    if (length(v) - length(replace(v, s5a, ''))) / length(s5a) <> 1 then raise exception '0074: office_stock s5'; end if;
    if (length(v) - length(replace(v, s6a, ''))) / length(s6a) <> 1 then raise exception '0074: office_stock s6'; end if;
    execute replace(replace(replace(replace(replace(replace(v, s1a, s1b), s2a, s2b), s3a, s3b), s4a, s4b), s5a, s5b), s6a, s6b);
  end if;

  v := pg_get_functiondef('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure);
  if position('/* 0074 */' in v) = 0 then
    n := (length(v) - length(replace(v, t1a, ''))) / length(t1a);
    if n <> 2 then raise exception '0074: в office_stock_ext продажи ведомости найдены % раз, ожидалось 2', n; end if;
    execute replace(v, t1a, t1b);
  end if;
end $mig$;
