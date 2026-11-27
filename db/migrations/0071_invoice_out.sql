-- 0071: расходная накладная (РН) - отгрузка стороннему покупателю: реализация в чужие магазины, опт (документ Светланы
-- «движение», 27.11.2026: кухня Енешки отдаёт выпечку и п/ф под реализацию в магазины). Между своими точками - по-прежнему
-- перемещение (в iiko его оформляли расходной накладной только потому, что точки там в разных организациях).
--
-- Покупатель - контрагент (вид «покупатель» = customer), склад - откуда отгружают. Цена строки - цена продажи, сумма
-- строки - выручка, сумма документа - выручка. Со склада списывается, как продажа (0070): блюдо или полуфабрикат,
-- которого склад не получает готовым, - сырьём по техкарте до конца, прочее - само; строки расхода хранят себестоимость.
-- Оборотная ведомость считает отгрузки вместе с продажами. Права doc:invoice_out - у администратора, собственника,
-- кладовщика (заведующая кухней) и бухгалтера.
--
-- Функции правятся точечной заменой по их тексту в базе с подсчётом совпадений и меткой /* 0071 */: повторный прогон
-- ничего не меняет, несовпадение останавливает миграцию.

alter table tandem.documents drop constraint if exists documents_doc_type_check;
alter table tandem.documents add constraint documents_doc_type_check
  check (doc_type = any (array['invoice_in', 'invoice_out', 'transfer', 'writeoff', 'production', 'inventory', 'sale']));

create or replace function tandem.next_doc_number(p_type text, p_date date)
 returns text
 language plpgsql
as $function$
declare v_no int; v_year int := extract(year from p_date)::int; v_pref text;
begin
  v_pref := case p_type when 'invoice_in' then 'ПН' when 'invoice_out' then 'РН' when 'transfer' then 'ПМ'
                        when 'writeoff' then 'СП' when 'production' then 'АП' when 'inventory' then 'ИН'
                        when 'sale' then 'ПД' else 'ДК' end;
  insert into tandem.doc_counters (doc_type, year, last_no) values (p_type, v_year, 1)
    on conflict (doc_type, year) do update set last_no = tandem.doc_counters.last_no + 1
    returning last_no into v_no;
  return v_pref || '-' || v_year || '-' || lpad(v_no::text, 6, '0');
end $function$;

insert into tandem.role_permissions (role, section, action)
  select r, 'doc:invoice_out', a from unnest(array['admin', 'owner', 'storekeeper', 'accountant']) r
  cross join unnest(array['view', 'edit']) a
  where not exists (select 1 from tandem.role_permissions p where p.role = r and p.section = 'doc:invoice_out' and p.action = a);

-- Пары (склад, позиция), которые двигает документ (0070) + расходная накладная: как списание.
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
   where d.id = p_doc and d.status = 'draft' and d.doc_type <> 'sale'
  union
  select d.store_from, pl.item_code
    from tandem.documents d cross join lateral tandem.doc_consume_plan(d.id) pl
    join tandem.document_lines l on l.id = pl.line_id
   where d.id = p_doc and d.status = 'draft'
     and (d.doc_type = 'production'
          or (d.doc_type in ('writeoff', 'invoice_out') and tandem.pf_opens(d.store_from, l.item_code, d.doc_date)))
  union
  select d.store_from, t.item_code
    from tandem.documents d
    cross join lateral tandem.sale_touch_items(d.store_from, d.doc_date,
      array(select l.item_code from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item')) t(item_code)
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'sale'
$function$;

-- Предпросмотр (0070) + расходная накладная: расход и уход в минус - как у списания.
create or replace function tandem.doc_preview(p_doc uuid)
 returns jsonb
 language plpgsql
 stable
as $function$
declare d record; v_consume jsonb := '[]'::jsonb; v_warn jsonb; v_charts jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then
    return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb,'warnings_charts','[]'::jsonb,'skipped','[]'::jsonb);
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
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing group by store_id, item_code having sum(q) > 0)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'item_type', i.item_type,
           'store_id', a.store_id, 'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume, 'warnings_charts', v_charts, 'skipped', v_skipped);
end $function$;

do $mig$
declare
  v text; n int;
  -- doc_post: цена обязательна и у расходной накладной; новая ветвь проведения - перед списанием.
  c1a constant text := $r$  if d.doc_type = 'invoice_in' then
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0);$r$;
  c1b constant text := $r$  if d.doc_type in ('invoice_in', 'invoice_out') then   /* 0071 */
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0);$r$;
  c2a constant text := '  elsif d.doc_type = ''writeoff'' then';
  c2b constant text := $r$  elsif d.doc_type = 'invoice_out' then
    -- 0071: расходная накладная стороннему покупателю. Цена строки - цена продажи, сумма строки и документа - выручка.
    -- Со склада - как продажа (0070): блюдо или полуфабрикат, которого склад не получает готовым, - сырьём по техкарте
    -- до конца, прочее - само; строки расхода хранят себестоимость. Расход считается один раз на документ.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
      select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, pc.cost,
             round(round(pl.qty, 4) * pc.cost, 2), il.item_code, 1000 + il.sort_order
        from tandem.doc_consume_plan(p_doc) pl
        join tandem.document_lines il on il.id = pl.line_id
        join tandem.items i on i.code = pl.item_code
        cross join lateral (select tandem.store_avg(d.store_from, pl.item_code) as cost offset 0) pc
       where tandem.pf_opens(d.store_from, il.item_code, d.doc_date);
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      if not tandem.pf_opens(d.store_from, l.item_code, d.doc_date) then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', l.item_code, round(l.qty, 4), i.unit_id, pc.cost,
                 round(round(l.qty, 4) * pc.cost, 2), l.item_code, 1000 + l.sort_order
            from tandem.items i
            cross join lateral (select tandem.store_avg(d.store_from, l.item_code) as cost offset 0) pc
           where i.code = l.item_code;
      end if;
      v_line_sum := round(l.qty * coalesce(l.price, 0), 2);
      update tandem.document_lines set sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
    for c in select cl.item_code, cl.qty, cl.price, il.id as line_id
               from tandem.document_lines cl
               join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
              where cl.document_id = p_doc and cl.line_kind = 'consume'
              order by cl.item_code, il.item_code loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, -c.qty, c.price, d.doc_date);
    end loop;

  elsif d.doc_type = 'writeoff' then$r$;
  -- doc_unpost: введённая цена продажи у расходной накладной остаётся, как у прихода.
  u1a constant text := $r$price = case when d.doc_type in ('invoice_in','sale','inventory') then price else null end$r$;
  u1b constant text := $r$price = case when d.doc_type in ('invoice_in','sale','inventory','invoice_out') /* 0071 */ then price else null end$r$;
  -- office_stock: тип, обязательные поля, сумма черновика в журнале.
  s1a constant text := $r$if v_type is null or v_type not in ('invoice_in','transfer','writeoff','production','inventory') then$r$;
  s1b constant text := $r$if v_type is null or v_type not in ('invoice_in','invoice_out','transfer','writeoff','production','inventory') then /* 0071 */$r$;
  s2a constant text := $r$    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then$r$;
  s2b constant text := $r$    if v_type = 'invoice_out' and (v_from is null or v_ca is null) then
      return tandem.err('validation', 'Расходной накладной нужны склад и покупатель'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then$r$;
  s3a constant text := $r$if v_type in ('writeoff','production','inventory') then v_to := null; end if;$r$;
  s3b constant text := $r$if v_type in ('writeoff','production','inventory','invoice_out') then v_to := null; end if;$r$;
  s4a constant text := $r$case when d.status = 'draft' and d.doc_type = 'invoice_in'$r$;
  s4b constant text := $r$case when d.status = 'draft' and d.doc_type in ('invoice_in', 'invoice_out')$r$;
  -- office_stock_ext: оборотная ведомость - отгрузки покупателям вместе с продажами.
  t1a constant text := $r$cur and doc_type = 'sale'), 0)$r$;
  t1b constant text := $r$cur and doc_type in ('sale', 'invoice_out') /* 0071 */), 0)$r$;
begin
  v := pg_get_functiondef('tandem.doc_post(uuid,tandem.users)'::regprocedure);
  if position('/* 0071 */' in v) = 0 then
    n := (length(v) - length(replace(v, c1a, ''))) / length(c1a);
    if n <> 1 then raise exception '0071: в doc_post проверка цены найдена % раз', n; end if;
    n := (length(v) - length(replace(v, c2a, ''))) / length(c2a);
    if n <> 1 then raise exception '0071: в doc_post ветвь списания найдена % раз', n; end if;
    execute replace(replace(v, c1a, c1b), c2a, c2b);
  end if;

  v := pg_get_functiondef('tandem.doc_unpost(uuid,tandem.users)'::regprocedure);
  if position('/* 0071 */' in v) = 0 then
    n := (length(v) - length(replace(v, u1a, ''))) / length(u1a);
    if n <> 1 then raise exception '0071: в doc_unpost правило цены найдено % раз', n; end if;
    execute replace(v, u1a, u1b);
  end if;

  v := pg_get_functiondef('tandem.office_stock(text,jsonb,tandem.users)'::regprocedure);
  if position('/* 0071 */' in v) = 0 then
    n := (length(v) - length(replace(v, s1a, ''))) / length(s1a);
    if n <> 1 then raise exception '0071: в office_stock список типов найден % раз', n; end if;
    n := (length(v) - length(replace(v, s2a, ''))) / length(s2a);
    if n <> 1 then raise exception '0071: в office_stock проверка перемещения найдена % раз', n; end if;
    n := (length(v) - length(replace(v, s3a, ''))) / length(s3a);
    if n <> 1 then raise exception '0071: в office_stock обнуление склада-получателя найдено % раз', n; end if;
    n := (length(v) - length(replace(v, s4a, ''))) / length(s4a);
    if n <> 1 then raise exception '0071: в office_stock сумма черновика найдена % раз', n; end if;
    execute replace(replace(replace(replace(v, s1a, s1b), s2a, s2b), s3a, s3b), s4a, s4b);
  end if;

  v := pg_get_functiondef('tandem.office_stock_ext(text,jsonb,tandem.users)'::regprocedure);
  if position('/* 0071 */' in v) = 0 then
    n := (length(v) - length(replace(v, t1a, ''))) / length(t1a);
    if n <> 2 then raise exception '0071: в office_stock_ext продажи ведомости найдены % раз, ожидалось 2', n; end if;
    execute replace(v, t1a, t1b);
  end if;
end $mig$;
