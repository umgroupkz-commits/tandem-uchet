-- 0070: полуфабрикаты раскладываются до сырья, как в iiko Тандема (вопрос Раисы 27.11.2026: «компот 40 л iiko
-- раскидала на сухофрукты, воду, сахар, лимонку»). В iiko у всех блюд и полуфабрикатов Тандема выключено «учитывать
-- остатки» при продаже и при инвентаризации, поэтому iiko раскладывает их до сырья, и на складах iiko нет остатков
-- очищенного лука, теста, фарша. Учёт раньше раскрывал техкарту на один уровень (допущение спецификации продаж
-- 2026-09-18: «полуфабрикаты заготовлены заранее актом»): продажа котлеты списывала «Фарш ПФ», и без ежедневных актов
-- на все 265 полуфабрикатов они ушли бы в минус, а сырьё не списывалось бы.
--
-- Правило теперь одно для продажи, акта производства, списания и описи: позиция раскрывается по действующей на дату
-- техкарте до конца (глубина до 10), кроме
--   - товара и позиции без карты (или с картой без строк) - списывается сама;
--   - того, что склад получает ГОТОВЫМ (tandem.store_ready на дату: перемещением сюда или своим актом) - само;
--   - в акте производства - того, что выпускает этот же акт (расходуется выпущенное).
-- «Готовым» теперь ставится на любом складе, куда пришло перемещение блюда/полуфабриката с картой, и на складе любого
-- акта, а не только на складе точки: при раскладке это нужно и кухне, и складам без точки.
-- Опись: блюдо или полуфабрикат, которого склад не получает готовым, на складе не хранится - посчитанное раскладывается
-- до сырья и прибавляется к факту строк сырья этой же описи; сырьё, которого в описи нет, не трогается (его не
-- пересчитывали), предпросмотр называет его (skipped). Разложенное - строки consume без цены и движений.
-- Сводка собственника («расход сырья») - тоже до сырья (tandem.chart_raw, без учёта «готовым»: это расход сырья на
-- проданное).
--
-- doc_post правится по тексту в базе: объявление и блок «готовым» - точной заменой, ветви списания, производства,
-- продажи и описи - целиком между метками со сверкой md5 прежнего текста (снимок с рабочей базы после 0068).
-- Повторный прогон ничего не меняет; несовпадение останавливает миграцию, не затирая чужих правок.

-- Склад получает позицию готовой на дату.
create or replace function tandem.ready_at(p_store uuid, p_item text, p_date date)
 returns boolean
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select exists (select 1 from tandem.store_ready sr
                  where sr.store_id = p_store and sr.item_code = p_item and sr.date_from <= p_date)
$function$;

-- Раскрывается ли позиция дальше по техкарте на этом складе в этот день: блюдо или полуфабрикат, у действующей карты
-- есть строки, и склад не получает позицию готовой.
create or replace function tandem.pf_opens(p_store uuid, p_item text, p_date date)
 returns boolean
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  select exists (select 1 from tandem.items i where i.code = p_item and i.item_type in ('dish', 'prepared'))
     and exists (select 1 from tandem.chart_lines cl where cl.chart_id = tandem.active_chart(p_item, p_date))
     and not tandem.ready_at(p_store, p_item, p_date)
$function$;

-- Расход по картам документа до сырья: строка документа → позиция → количество. Корень - строки документа с
-- действующей картой (у описи - по факту); кто из корней раскладывается на самом деле, решает ветвь doc_post.
create or replace function tandem.doc_consume_plan(p_doc uuid)
 returns table(line_id uuid, item_code text, qty numeric)
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  with recursive d as (
    select id, doc_type, doc_date, store_from from tandem.documents where id = p_doc
  ), made as (
    select distinct l.item_code from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
     where d.doc_type = 'production'
  ), t (line_id, item_code, qty, depth, path, open) as (
    select l.id, cl.ingredient_code,
           cl.brutto * (case when d.doc_type = 'inventory' then l.fact_qty else l.qty end) / c.output_amount,
           1, array[l.item_code],
           cl.ingredient_code <> l.item_code
             and not exists (select 1 from made m where m.item_code = cl.ingredient_code)
             and tandem.pf_opens(d.store_from, cl.ingredient_code, d.doc_date)
      from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
      join tandem.charts c on c.id = tandem.active_chart(l.item_code, d.doc_date)
      join tandem.chart_lines cl on cl.chart_id = c.id
     where d.doc_type <> 'inventory' or l.fact_qty is not null
    union all
    select t.line_id, cl.ingredient_code, cl.brutto * t.qty / c.output_amount, t.depth + 1, t.path || t.item_code,
           t.depth + 1 < 10
             and not (cl.ingredient_code = any(t.path || t.item_code))
             and not exists (select 1 from made m where m.item_code = cl.ingredient_code)
             and tandem.pf_opens(d.store_from, cl.ingredient_code, d.doc_date)
      from t cross join d
      join tandem.charts c on c.id = tandem.active_chart(t.item_code, d.doc_date)
      join tandem.chart_lines cl on cl.chart_id = c.id
     where t.open
  )
  select t.line_id, t.item_code, sum(t.qty) from t where not t.open group by t.line_id, t.item_code
$function$;

-- Что спишет продажа этих позиций на складе в этот день (для блокировки описью): до сырья, готовое - само.
create or replace function tandem.sale_touch_items(p_store uuid, p_date date, p_items text[])
 returns setof text
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  with recursive x as (
    select distinct u.item_code from unnest(p_items) u(item_code) where u.item_code is not null
  ), w (node, depth, path, open) as (
    select x.item_code, 0, array[]::text[],
           tandem.active_chart(x.item_code, p_date) is not null and not tandem.ready_at(p_store, x.item_code, p_date)
      from x
    union all
    select cl.ingredient_code, w.depth + 1, w.path || w.node,
           w.depth + 1 < 10 and not (cl.ingredient_code = any(w.path || w.node))
             and tandem.pf_opens(p_store, cl.ingredient_code, p_date)
      from w join tandem.chart_lines cl on cl.chart_id = tandem.active_chart(w.node, p_date)
     where w.open
  )
  select distinct w.node from w where not w.open
$function$;

-- Сырьё на единицу позиции по техкартам до конца, без учёта «готовым»: «расход сырья» сводки собственника.
create or replace function tandem.chart_raw(p_item text, p_date date)
 returns table(item_code text, k numeric)
 language sql
 stable
 set search_path to 'tandem', 'public'
as $function$
  with recursive w (node, k, depth, path, open) as (
    select cl.ingredient_code, cl.brutto / c.output_amount, 1, array[p_item],
           cl.ingredient_code <> p_item
             and exists (select 1 from tandem.items i where i.code = cl.ingredient_code and i.item_type in ('dish', 'prepared'))
             and exists (select 1 from tandem.chart_lines x where x.chart_id = tandem.active_chart(cl.ingredient_code, p_date))
      from tandem.charts c join tandem.chart_lines cl on cl.chart_id = c.id
     where c.id = tandem.active_chart(p_item, p_date)
    union all
    select cl.ingredient_code, w.k * cl.brutto / c.output_amount, w.depth + 1, w.path || w.node,
           w.depth + 1 < 10 and not (cl.ingredient_code = any(w.path || w.node))
             and exists (select 1 from tandem.items i where i.code = cl.ingredient_code and i.item_type in ('dish', 'prepared'))
             and exists (select 1 from tandem.chart_lines x where x.chart_id = tandem.active_chart(cl.ingredient_code, p_date))
      from w join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
      join tandem.chart_lines cl on cl.chart_id = c.id
     where w.open
  )
  select w.node, sum(w.k) from w where not w.open group by w.node
$function$;

-- Пары (склад, позиция), которые двигает документ: проведённый - по движениям; черновик - строки, а у акта и у
-- разложенных строк списания - их расход до сырья (0070); продажа - то, что она спишет.
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
     and (d.doc_type = 'production' or (d.doc_type = 'writeoff' and tandem.pf_opens(d.store_from, l.item_code, d.doc_date)))
  union
  select d.store_from, t.item_code
    from tandem.documents d
    cross join lateral tandem.sale_touch_items(d.store_from, d.doc_date,
      array(select l.item_code from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item')) t(item_code)
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'sale'
$function$;

-- Предпросмотр проведения: расход до сырья у акта, у списания и у описи (у описи - что прибавится к факту сырья, и
-- skipped - сырьё, которого в описи нет: его проведение не тронет); уход в минус; позиции выпуска без карты.
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
  if d.doc_type in ('production', 'writeoff', 'inventory') then
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
       and (d.doc_type = 'transfer' or (d.doc_type = 'writeoff' and not tandem.pf_opens(d.store_from, l.item_code, d.doc_date)))
     group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      join tandem.document_lines l on l.id = p.line_id
     where d.doc_type = 'production' or (d.doc_type = 'writeoff' and tandem.pf_opens(d.store_from, l.item_code, d.doc_date))
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
  v text; n int; a int; b int;
  s_start constant text := '  elsif d.doc_type = ''writeoff'' then';
  s_end   constant text := '  -- Время проведения';
  region_md5 constant text := '153cbc87318e274d4e513662733e6bf9';
  dcl_a constant text := 'v_train boolean; v_keep timestamptz; v_now timestamptz; v_later int;';
  dcl_b constant text := 'v_train boolean; v_keep timestamptz; v_now timestamptz; v_later int; v_plan jsonb; /* 0070 */';
  r1a constant text := $r$    if d.doc_type = 'transfer' then
      if v_src = 'orders' or exists (select 1 from tandem.points where default_store_id = d.store_to and active) then
        v_rstore := d.store_to;
      end if;
    elsif exists (select 1 from tandem.points where default_store_id = d.store_from and active) then
      v_rstore := d.store_from;
    end if;$r$;
  r1b constant text := $r$    -- 0070: «готовым» - на любом складе, куда пришло перемещение или где проведён акт, а не только на складе
    -- точки: полуфабрикат, полученный готовым, при раскладке до сырья расходуется сам.
    v_rstore := case when d.doc_type = 'transfer' then d.store_to else d.store_from end;$r$;
  new_region constant text := $r$  elsif d.doc_type = 'writeoff' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    -- 0070: блюдо или полуфабрикат, которого склад не получает готовым (tandem.pf_opens), списывается сырьём по
    -- техкарте до конца, как продажа: испорченный компот на кухне - это сахар и сухофрукты, а не «компот» в минус.
    -- Прочее - само, по средней склада, как раньше. Расход считается один раз на документ (v_plan).
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    v_plan := (select coalesce(jsonb_agg(jsonb_build_object('ln', p.line_id, 'ic', p.item_code, 'qt', p.qty)), '[]'::jsonb)
                 from tandem.doc_consume_plan(p_doc) p);
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      if tandem.pf_opens(d.store_from, l.item_code, d.doc_date) then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', x.ic, round(x.qt, 4), i.unit_id, pc.cost, round(round(x.qt, 4) * pc.cost, 2), l.item_code, 1000 + l.sort_order
            from jsonb_to_recordset(v_plan) x(ln uuid, ic text, qt numeric)
            join tandem.items i on i.code = x.ic
            cross join lateral (select tandem.store_avg(d.store_from, x.ic) as cost offset 0) pc
           where x.ln = l.id;
        select coalesce(sum(cl.sum), 0) into v_line_sum from tandem.document_lines cl
         where cl.document_id = p_doc and cl.line_kind = 'consume' and cl.note = l.item_code;
        update tandem.document_lines set price = case when l.qty > 0 then round(v_line_sum / l.qty, 4) else 0 end,
               sum = v_line_sum where id = l.id;
      else
        v_cost := tandem.store_avg(d.store_from, l.item_code);
        v_line_sum := round(l.qty * v_cost, 2);
        update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      end if;
      v_sum := v_sum + v_line_sum;
    end loop;
    -- Движения - одним проходом по коду позиции (замки остатков в одном порядке у всех документов, 0023):
    -- строка, списанная как есть, - своим количеством, разложенная - строками расхода.
    for c in
      select x.item_code, x.qty, x.price, x.line_id from (
        select dl.item_code, dl.qty, dl.price, dl.id as line_id from tandem.document_lines dl
         where dl.document_id = p_doc and dl.line_kind = 'item'
           and not exists (select 1 from tandem.document_lines cl where cl.document_id = p_doc and cl.line_kind = 'consume'
                            and cl.note = dl.item_code)
        union all
        select cl.item_code, cl.qty, cl.price, il.id from tandem.document_lines cl
          join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
         where cl.document_id = p_doc and cl.line_kind = 'consume') x
      order by x.item_code, x.line_id
    loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, -c.qty, c.price, d.doc_date);
    end loop;

  elsif d.doc_type = 'production' then
    -- проверки типа и карт — в блоке предпроверок выше
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    -- 0070: расход - до сырья (tandem.doc_consume_plan): полуфабрикат, который склад не получает готовым и который этот
    -- акт не выпускает, раскладывается по своей карте. Расход считается один раз на документ (v_plan).
    v_plan := (select coalesce(jsonb_agg(jsonb_build_object('ln', p.line_id, 'ic', p.item_code, 'qt', p.qty)), '[]'::jsonb)
                 from tandem.doc_consume_plan(p_doc) p);
    -- Пары акта (выпуск и расход) заводятся и берутся под лок заранее, одним запросом в порядке
    -- item_code: строки ниже считаются в порядке зависимостей, а не по коду, и без общего лока два
    -- акта брали бы локи встречно (0041, ревью п. 32). do update блокирует и уже существующие строки.
    insert into tandem.stock_balances (store_id, item_code)
      select d.store_from, x.item_code
        from (select dl.item_code from tandem.document_lines dl where dl.document_id = p_doc and dl.line_kind = 'item'
              union select pl.ic from jsonb_to_recordset(v_plan) pl(ic text)) x
       order by x.item_code
      on conflict (store_id, item_code) do update set updated_at = now();
    -- Полуфабрикат, который расходуют другие строки этого же акта, выпускается раньше них: иначе блюдо
    -- списывало бы его до выпуска, по старой или нулевой цене, и итог зависел от случайного порядка кодов
    -- (ревью п. 32). Глубина строки — самая длинная цепочка «ингредиент → продукт» внутри акта
    -- (ограничена 10 на случай цикла в картах); глубже — раньше.
    for l in
      with recursive acts as (
        select dl.item_code from tandem.document_lines dl where dl.document_id = p_doc and dl.line_kind = 'item'
      ), pl as (
        select x.ln as line_id, x.ic as item_code from jsonb_to_recordset(v_plan) x(ln uuid, ic text)
      ), e as (
        select pl.item_code as ing, dl.item_code as prod
          from pl join tandem.document_lines dl on dl.id = pl.line_id
         where pl.item_code in (select item_code from acts)
      ), w (item_code, depth) as (
        select item_code, 0 from acts
        union all
        select e.ing, w.depth + 1 from w join e on e.prod = w.item_code where w.depth < 10
      )
      select dl.* from tandem.document_lines dl
        join (select item_code, max(depth) as depth from w group by item_code) t on t.item_code = dl.item_code
       where dl.document_id = p_doc and dl.line_kind = 'item'
       order by t.depth desc, dl.item_code
    loop
      v_line_sum := 0;
      for c in select x.ic as item_code, x.qt as qty from jsonb_to_recordset(v_plan) x(ln uuid, ic text, qt numeric)
                where x.ln = l.id order by x.ic loop
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
    -- Продажа (подпроект 4): у позиции есть действующая на дату карта — списываются её ингредиенты (0070: до сырья,
    -- tandem.doc_consume_plan; то, что склад получает готовым, — само), карты нет — сама позиция. Строка позиции
    -- хранит цену продажи и выручку; сумма документа — себестоимость проданного.
    -- Сначала строки расхода по всем позициям, затем движения одним проходом по item_code:
    -- блокировки остатков берутся в одном порядке у всех документов (0023, ревью п. 3).
    -- Цена расхода берётся до движений: средняя склада от расхода не меняется. Цена считается
    -- один раз на строку (offset 0 не даёт планировщику повторить вызов): store_avg без средней
    -- обходит техкарту.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    -- 0070: расход по картам - одной вставкой для всех позиций с картой, которые склад не получает готовыми (расчёт до
    -- сырья один раз на документ, а не на каждую строку: продажа кассы пересобирается с каждым чеком).
    insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
      select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, pc.cost,
             round(round(pl.qty, 4) * pc.cost, 2), il.item_code, 1000 + il.sort_order
        from tandem.doc_consume_plan(p_doc) pl
        join tandem.document_lines il on il.id = pl.line_id
        join tandem.items i on i.code = pl.item_code
        cross join lateral (select tandem.store_avg(d.store_from, pl.item_code) as cost offset 0) pc
       where tandem.active_chart(il.item_code, d.doc_date) is not null
         and not tandem.ready_at(d.store_from, il.item_code, d.doc_date);
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- Готовой продаётся позиция, которую этот склад с даты продажи получает готовой (store_ready, 0041,
      -- ревью п. 2 и 38): её сырьё списал акт производства. Решает склад и дата, а не признак позиции.
      if tandem.active_chart(l.item_code, d.doc_date) is null or tandem.ready_at(d.store_from, l.item_code, d.doc_date) then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', l.item_code, round(l.qty, 4), i.unit_id, pc.cost,
                 round(round(l.qty, 4) * pc.cost, 2), l.item_code, 1000 + l.sort_order
            from tandem.items i
            cross join lateral (select tandem.store_avg(d.store_from, l.item_code) as cost offset 0) pc
           where i.code = l.item_code;
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
    -- 0070: блюдо или полуфабрикат, которого склад не получает готовым (tandem.pf_opens: компот, тесто, фарш на кухне -
    -- как в iiko Тандема), на складе не хранится: посчитанное раскладывается по техкарте до сырья и прибавляется к факту
    -- своих строк описи. Сырьё, которого в описи нет, не трогается - его не пересчитывали (предпросмотр называет такие
    -- позиции). Разложенное - строки consume (note - что раскладывали), без цены и движений; у самой разложенной строки
    -- движений нет.
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, note, sort_order)
      select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, il.item_code, 1000 + il.sort_order
        from tandem.doc_consume_plan(p_doc) pl
        join tandem.document_lines il on il.id = pl.line_id
        join tandem.items i on i.code = pl.item_code
       where tandem.pf_opens(d.store_from, il.item_code, d.doc_date);
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      if tandem.pf_opens(d.store_from, l.item_code, d.doc_date) then
        update tandem.document_lines set calc_qty = tandem.stock_qty_at(d.store_from, l.item_code, d.doc_date),
               qty = l.fact_qty, sum = 0 where id = l.id;
        continue;
      end if;
      -- I4: расчётный остаток читается под локом той же пары, что потом изменит apply_move,
      -- иначе параллельное списание успевало пройти между чтением и записью, и недостача
      -- считалась от остатка, которого уже нет. Лок даёт сам do update.
      insert into tandem.stock_balances (store_id, item_code) values (d.store_from, l.item_code)
        on conflict (store_id, item_code) do update set updated_at = now();
      -- Расчётный остаток — на конец дня акта из уже проведённого, а не текущий: акт, внесённый через
      -- день-два после пересчёта или перепроведённый, не стирает документы после своей даты (0041, ревью
      -- п. 7), а приход и продажи этого дня, проведённые до пересчёта, учтены один раз (второй круг V1).
      v_calc := tandem.stock_qty_at(d.store_from, l.item_code, d.doc_date);
      -- 0070: факт - пересчитанное плюс то, что лежит в разложенных полуфабрикатах и блюдах этой описи.
      v_qty := l.fact_qty + coalesce((select sum(cl.qty) from tandem.document_lines cl
                 where cl.document_id = p_doc and cl.line_kind = 'consume' and cl.item_code = l.item_code), 0);
      v_diff := v_qty - v_calc;
      -- Излишек — по цене строки, если её ввели (человек или файл iiko: «Сумма с/н» / кол-во, A1): ввод
      -- остатков дня X встаёт по себестоимости iiko, а не по учётной цене или нулю. Нет цены — и у
      -- недостачи всегда — средняя склада / учётная, как раньше. Цену строки проведение не трогает: это
      -- введённое значение; применённая себестоимость — в движении и в сумме строки.
      v_cost := case when v_diff > 0 and l.price > 0 then l.price else tandem.store_avg(d.store_from, l.item_code) end;
      if v_diff <> 0 then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, v_diff, v_cost, d.doc_date);
      end if;
      v_line_sum := round(v_diff * v_cost, 2);
      update tandem.document_lines set calc_qty = v_calc, qty = v_qty, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
  end if;

$r$;
begin
  v := pg_get_functiondef('tandem.doc_post(uuid,tandem.users)'::regprocedure);
  if position('/* 0070 */' in v) = 0 then
    n := (length(v) - length(replace(v, dcl_a, ''))) / length(dcl_a);
    if n <> 1 then raise exception '0070: в doc_post объявление найдено % раз, ожидалось 1', n; end if;
    n := (length(v) - length(replace(v, r1a, ''))) / length(r1a);
    if n <> 1 then raise exception '0070: в doc_post блок «готовым» найден % раз, ожидалось 1', n; end if;
    a := position(s_start in v); b := position(s_end in v);
    if a = 0 or b = 0 or b < a then raise exception '0070: в doc_post не найдены границы ветвей документов'; end if;
    if md5(substr(v, a, b - a)) <> region_md5 then
      raise exception '0070: ветви doc_post изменены после снимка (md5 %), правка остановлена', md5(substr(v, a, b - a));
    end if;
    v := substr(v, 1, a - 1) || new_region || substr(v, b);
    v := replace(replace(v, dcl_a, dcl_b), r1a, r1b);
    execute v;
  end if;
end $mig$;

-- «Готовым» по любому складу (не только складу точки) при отмене перемещения и акта; продажи пересчитываются и тогда,
-- когда «готовым» стал ингредиент проданного блюда (на любой глубине карты), а не только сама проданная позиция.
do $mig$
declare
  v text; n int;
  p1a constant text := '(x.source_kind = ''orders'' or (v_point and v_kind)))';
  p1b constant text := '(x.source_kind = ''orders'' or v_kind)) /* 0070 */';
  p2a constant text := '(x.doc_type = ''production'' and x.store_from = p_store and v_point))';
  p2b constant text := '(x.doc_type = ''production'' and x.store_from = p_store))';
  m1a constant text := 'and l.line_kind = ''item'' and l.item_code = p_item';
  m1b constant text := 'and l.line_kind = ''item'' and (l.item_code = p_item or tandem.chart_reaches(l.item_code, p_item, d.doc_date)) /* 0070 */';
  o1a constant text := 'sum(cl.brutto / ch.output_amount * u.q) total from (';
  o1b constant text := 'sum(rw.k * u.q) total from (select v.item_code, sum(v.q) q, max(v.rd) rd from ( /* 0070 */';
  o2a constant text := $r$          ) u
          join tandem.charts ch on ch.id = tandem.active_chart(u.item_code, u.rd)
          join tandem.chart_lines cl on cl.chart_id = ch.id
          join tandem.items ing on ing.code = cl.ingredient_code$r$;
  o2b constant text := $r$          ) v group by v.item_code, tandem.active_chart(v.item_code, v.rd)) u
          cross join lateral tandem.chart_raw(u.item_code, u.rd) rw
          join tandem.items ing on ing.code = rw.item_code$r$;
begin
  v := pg_get_functiondef('tandem.store_ready_recalc(uuid,text,uuid)'::regprocedure);
  if position('/* 0070 */' in v) = 0 then
    n := (length(v) - length(replace(v, p1a, ''))) / length(p1a);
    if n <> 1 then raise exception '0070: в store_ready_recalc условие перемещения найдено % раз', n; end if;
    n := (length(v) - length(replace(v, p2a, ''))) / length(p2a);
    if n <> 1 then raise exception '0070: в store_ready_recalc условие акта найдено % раз', n; end if;
    execute replace(replace(v, p1a, p1b), p2a, p2b);
  end if;

  v := pg_get_functiondef('tandem.store_ready_mark(uuid,text,date,date)'::regprocedure);
  if position('/* 0070 */' in v) = 0 then
    n := (length(v) - length(replace(v, m1a, ''))) / length(m1a);
    if n <> 2 then raise exception '0070: в store_ready_mark условие продажи найдено % раз, ожидалось 2', n; end if;
    execute replace(v, m1a, m1b);
  end if;

  v := pg_get_functiondef('tandem.owner_dashboard(date,date,text[],boolean,date)'::regprocedure);
  if position('/* 0070 */' in v) = 0 then
    n := (length(v) - length(replace(v, o1a, ''))) / length(o1a);
    if n <> 1 then raise exception '0070: в owner_dashboard расход сырья найден % раз', n; end if;
    n := (length(v) - length(replace(v, o2a, ''))) / length(o2a);
    if n <> 1 then raise exception '0070: в owner_dashboard соединение с картами найдено % раз', n; end if;
    execute replace(replace(v, o1a, o1b), o2a, o2b);
  end if;
end $mig$;
