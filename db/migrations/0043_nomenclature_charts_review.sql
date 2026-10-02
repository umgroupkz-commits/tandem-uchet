-- Номенклатура, техкарты, себестоимость и перенос из iiko — исправления по ревью (сборка 20).
-- Номера — находки ревью, «к.N» — пункты контракта фронт/сервер.
-- 42: переименование группы (group_save и перенос групп из iiko) переносит новое имя в items.category
--     позиций группы и в points.item_categories; перенос позиций из iiko при смене группы ставит category
--     по группе — иначе позиции пропадали с экранов точки, кассы и заявок.
-- 43: повторный перенос техкарт не закрывает и не меняет карты офиса: пересекающаяся iiko-версия
--     пропускается или укорачивается сама и называется в errors.
-- 44, к.14: единица позиции с движениями, документами или техкартами не меняется; тип между товаром и
--     блюдом/полуфабрикатом не меняется при движениях склада; шаг ввода следует за единицей.
-- 45, 49, к.15: даты из payload в разделе техкарт (и item_cost_get) — строго ГГГГ-ММ-ДД, иначе validation.
-- 46: проверка цикла при сохранении карты — на весь период её действия (и в chart_new_version,
--     chart_delete); menu_foodcost при цикле даёт неполную себестоимость, а не заниженную.
-- 72, к.14: та же учётная цена в карточке не переписывает источник и дату цены.
-- 73: псевдоним в items_lookup_list сравнивается без учёта регистра (псевдонимы хранятся строчными).
-- 74, к.16: CSV фудкоста — числа с десятичной запятой.
-- 76, к.14: item_save — ключ artikul/group_id пришёл, значит применяется (пустое снимает).
-- Второй круг (проверка исправлений):
-- V13, K: group_save не переименовывает группу в имя, которым уже помечены позиции другой группы
--     (точкам открылись бы её позиции); перенос групп из iiko при таком совпадении не трогает ни
--     фильтры категорий точек, ни имя группы и её позиции — называет совпадение в warnings.
-- V14, K: полуфабрикат/блюдо без единой версии техкарты становится товаром и при движениях склада
--     (списывался он и так сам, как товар) — то, что советует отчёт качества.
-- V26, L: коды в колонке missing CSV фудкоста — через « | » («81,90» русский Excel читал как 81,9).
-- Тела функций — из db/schema/tandem_full.sql с точечными правками.

-- Дата из payload строго как ГГГГ-ММ-ДД. Приведение ::date читает строку по DateStyle базы
-- ('ISO, MDY'): «01.10.2026» молча становилось 10 января, а «13.10.2026» давало голую 500.
-- Пустое — null; прочее — ошибка invalid_datetime_format, её ловят вызывающие разделы.
create or replace function tandem.chart_date(p text) returns date
language plpgsql immutable as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  if btrim(p) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = 'invalid_datetime_format', message = 'Дата — в формате ГГГГ-ММ-ДД';
  end if;
  begin
    return btrim(p)::date;   -- ГГГГ-ММ-ДД читается одинаково при любом DateStyle
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception using errcode = 'invalid_datetime_format', message = 'Дата — в формате ГГГГ-ММ-ДД';
  end;
end $$;

-- Ведёт ли p_from к p_target хоть в один день периода [p_d1, p_d2] (p_d2 null — бессрочно).
-- Состав дерева карт меняется только в даты начала версий, поэтому достаточно проверить начало
-- периода и каждую дату начала версии внутри него — у позиций, до которых p_from дотягивается
-- какой-либо своей версией за этот период. Конец версии без преемника рёбра только убирает.
create or replace function tandem.chart_reaches_during(p_from text, p_target text, p_d1 date, p_d2 date)
returns boolean language plpgsql stable as $$
declare v_d date;
begin
  if tandem.chart_reaches(p_from, p_target, p_d1) then return true; end if;
  for v_d in
    with recursive r as (
      select p_from as node, 0 as depth
      union
      select cl.ingredient_code, r.depth + 1
      from r join tandem.charts c on c.item_code = r.node
                and daterange(c.date_from, c.date_to, '[]') && daterange(p_d1, p_d2, '[]')
             join tandem.chart_lines cl on cl.chart_id = c.id
      where r.depth < 10
    )
    select distinct c.date_from from tandem.charts c
    where c.item_code in (select node from r) and c.date_from > p_d1
      and (p_d2 is null or c.date_from <= p_d2)
    order by 1
  loop
    if tandem.chart_reaches(p_from, p_target, v_d) then return true; end if;
  end loop;
  return false;
end $$;

-- 42: имя группы живёт ещё в двух местах — items.category (по ней экраны точки, касса и заявки
-- отбирают позиции) и points.item_categories (какие категории видит точка). Переименование
-- переносит новое имя в оба: позиции группы получают его в category, у точек, видевших прежние
-- категории этих позиций, оно появляется в списке; прежнее имя убирается, только когда им больше
-- не помечена ни одна позиция (иначе вторая группа с тем же именем пропала бы с экранов).
create or replace function tandem.group_rename_sync(p_group uuid, p_old text, p_new text) returns void
language plpgsql as $$
declare v_old text[]; v_gone text[];
begin
  select coalesce(array_agg(distinct category), '{}') into v_old
    from tandem.items where group_id = p_group and category is not null and category <> p_new;
  if p_old is not null and p_old <> p_new and not (p_old = any(v_old)) then v_old := v_old || p_old; end if;
  update tandem.items set category = p_new where group_id = p_group and category is distinct from p_new;
  select coalesce(array_agg(c), '{}') into v_gone from unnest(v_old) c
    where not exists (select 1 from tandem.items i where i.category = c);
  update tandem.points p set item_categories = array(
      select x from unnest(p.item_categories || p_new) with ordinality t(x, o)
      where not (x = any(v_gone)) group by x order by min(o))
    where p.item_categories && v_old;
end $$;

-- V13: точки отбирают позиции по имени категории, не по группе. Имя, которым уже помечена хоть одна
-- позиция вне группы p_group (другой группы или старая без группы), после переименования добавилось
-- бы в фильтры её точек — и им открылись бы чужие позиции (одинаковые имена групп в базе не редкость).
create or replace function tandem.group_name_taken(p_group uuid, p_name text) returns boolean
language sql stable as $$
  select exists (select 1 from tandem.items i where i.category = p_name and i.group_id is distinct from p_group)
$$;

CREATE OR REPLACE FUNCTION tandem.menu_foodcost(p_point text DEFAULT NULL::text, p_date date DEFAULT CURRENT_DATE, p_group uuid DEFAULT NULL::uuid)
 RETURNS TABLE(code text, name text, group_name text, unit_id text, cost numeric, price numeric, markup_pct numeric, foodcost_pct numeric, over_limit boolean, missing text[])
 LANGUAGE sql
 STABLE
AS $function$
  with recursive
  lim as (select coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35) as v),
  dishes as (
    select i.code, i.name, g.name as group_name, i.unit_id, coalesce(pp.price, i.price) as price
    from tandem.items i
    left join tandem.item_groups g on g.id = i.group_id
    left join tandem.item_prices pp on p_point is not null and pp.point_id = p_point and pp.item_code = i.code
    where i.active and i.for_sale and i.item_type in ('dish','prepared')
      and (p_group is null or i.group_id = p_group)
  ),
  -- 46: ребро, ведущее обратно в путь (цикл), не отбрасывается — иначе блюдо получало «полную»
  -- себестоимость без доли зацикленного ПФ. Узел цикла помечается cyc, дальше не раскрывается
  -- и становится листом без цены: complete = false, в missing — 'cycle:<код>', как в item_cost.
  walk as (
    select d.code as root, d.code as node, 1::numeric as factor, 0 as depth, array[d.code] as path, false as cyc
    from dishes d
    union all
    select w.root, cl.ingredient_code, w.factor * cl.brutto / c.output_amount, w.depth + 1, w.path || cl.ingredient_code,
           cl.ingredient_code = any(w.path)
    from walk w
    join tandem.items i on i.code = w.node and i.item_type in ('dish','prepared')
    join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
    join tandem.chart_lines cl on cl.chart_id = c.id
    where w.depth < 10 and not w.cyc
  ),
  leaves as (
    select w.root, w.node, w.factor, i.item_type, i.cost_price, w.cyc
    from walk w join tandem.items i on i.code = w.node
    where w.cyc or i.item_type in ('goods','service') or tandem.active_chart(w.node, p_date) is null
       -- M6: обход обрывается на глубине 10 (walk выше), и без этого условия узел на границе
       -- просто исчезал бы из расчёта, а блюдо получало бы «полную» себестоимость по обрубку.
       -- Такой узел — лист без цены: complete становится false, а его код попадает в missing.
       or w.depth >= 10
  ),
  agg as (
    select root,
      sum(case when not cyc and item_type in ('goods','service') and cost_price is not null then factor * cost_price else 0 end) as partial,
      bool_and(not cyc and item_type in ('goods','service') and cost_price is not null) as complete,
      array_remove(array_agg(distinct case when cyc then 'cycle:' || node
                                           when not (item_type in ('goods','service') and cost_price is not null) then node end), null) as missing
    from leaves group by root
  )
  select d.code, d.name, d.group_name, d.unit_id,
    case when a.complete then round(a.partial, 2) end as cost,
    d.price,
    case when a.complete and a.partial > 0 and d.price is not null then round((d.price - a.partial) / a.partial * 100, 1) end as markup_pct,
    case when a.complete and d.price > 0 then round(a.partial / d.price * 100, 1) end as foodcost_pct,
    case when a.complete and d.price > 0 then a.partial / d.price * 100 > (select v from lim) else false end as over_limit,
    coalesce(a.missing, array[d.code]) as missing
  from dishes d left join agg a on a.root = d.code
  order by d.name
$function$
;

CREATE OR REPLACE FUNCTION tandem.office_charts(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_code   text := payload->>'code';
  v_id     uuid := nullif(payload->>'id','')::uuid;
  v_date   date;
  v_q      text := btrim(coalesce(payload->>'q',''));
  v_page   int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_only   text := nullif(payload->>'only','');
  v_group  uuid := nullif(payload->>'group_id','')::uuid;
  v_total  int; v_rows jsonb; v_type text; v_from date; v_to date; v_out numeric;
  v_prev   uuid; v_line jsonb; v_ing text; v_ing_type text; v_active boolean;
  v_chart  uuid; v_item jsonb; v_versions jsonb; v_lines jsonb; v_cost record;
  v_csv    text; v_limit numeric;
begin
  -- 45/49: дата из payload — строго ГГГГ-ММ-ДД (tandem.chart_date). Разбирается здесь, а не в
  -- объявлениях: ошибку из объявлений обработчик функции не ловит, и наружу ушла бы голая 500.
  v_date := coalesce(tandem.chart_date(payload->>'date'), current_date);

  -- ---------- список ----------
  if action = 'charts_list' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    with base as (
      select i.code, i.name, i.item_type, i.unit_id, g.name as group_name, i.price,
             tandem.active_chart(i.code, current_date) as chart_id
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where i.active and i.item_type in ('dish','prepared')
        and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
        and (v_group is null or i.group_id = v_group)
    ),
    -- Себестоимость считается рекурсивно, поэтому её берут только для страницы (join ниже).
    -- Исключение — фильтр «с картой, но без себестоимости»: он без расчёта не работает.
    no_cost as (
      select b.*
      from base b
      left join lateral tandem.item_cost(b.code, current_date) k on true
      where v_only = 'no_cost' and b.chart_id is not null and k.cost is null
    ),
    flt as (
      select * from base where v_only is null or (v_only = 'no_chart' and chart_id is null)
      union all
      select * from no_cost
    ),
    page as (
      select f.*, count(*) over () as total_cnt
      from flt f order by f.name limit 200 offset (v_page - 1) * 200
    )
    select coalesce(max(p.total_cnt), 0),
           coalesce(jsonb_agg(jsonb_build_object(
             'code', p.code, 'name', p.name, 'item_type', p.item_type, 'unit_id', p.unit_id,
             'group_name', p.group_name, 'chart_id', p.chart_id, 'date_from', c.date_from,
             'output_amount', c.output_amount, 'cost', k.cost, 'price', p.price,
             'foodcost_pct', case when k.cost is not null and p.price > 0
                               then round(k.cost / p.price * 100, 1) end,
             'over_limit', case when k.cost is not null and p.price > 0
                             then k.cost / p.price * 100 > v_limit else false end,
             'missing_count', coalesce((select count(*) from unnest(k.missing) m where m <> p.code), 0)) order by p.name), '[]'::jsonb)
      into v_total, v_rows
      from page p
      left join tandem.charts c on c.id = p.chart_id
      left join lateral tandem.item_cost(p.code, current_date) k on true;
    return jsonb_build_object('ok', true, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total / 200.0)::int, 1), 'limit', v_limit, 'rows', v_rows);
  end if;

  -- ---------- карточка ----------
  if action = 'chart_get' then
    select item_type into v_type from tandem.items where code = v_code;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена'); end if;
    if v_id is not null then
      -- I3: запросили конкретную версию — дальше всё считается на её дату начала. Иначе строки
      -- брали цену ингредиента на сегодня, а итог — на дату версии, и они расходились.
      select id, date_from into v_chart, v_date from tandem.charts where id = v_id and item_code = v_code;
      if v_chart is null then return tandem.err('not_found', 'Версия карты не найдена у этой позиции'); end if;
    else
      v_chart := tandem.active_chart(v_code, v_date);
    end if;
    select jsonb_build_object('code', i.code, 'name', i.name, 'item_type', i.item_type,
             'unit_id', i.unit_id, 'price', i.price)
      into v_item from tandem.items i where i.code = v_code;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date_from', date_from, 'date_to', date_to,
             'source', source) order by date_from desc), '[]'::jsonb)
      into v_versions from tandem.charts where item_code = v_code;
    if v_chart is null then
      return jsonb_build_object('ok', true, 'item', v_item, 'chart', null::jsonb,
        'cost', null::numeric, 'partial', null::numeric,
        'missing', to_jsonb(array[v_code]), 'versions', v_versions);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', cl.id, 'ingredient_code', cl.ingredient_code, 'name', i.name, 'unit', i.unit_id,
        'item_type', i.item_type, 'brutto', cl.brutto, 'netto', cl.netto, 'output', cl.output,
        'note', cl.note, 'ing_cost', k.cost,
        'line_cost', case when k.cost is not null then round(cl.brutto * k.cost, 4) end,
        'cold_loss_pct', case when cl.brutto > 0 then round((cl.brutto - cl.netto) / cl.brutto * 100, 1) end,
        'hot_loss_pct',  case when cl.netto  > 0 then round((cl.netto - cl.output) / cl.netto  * 100, 1) end)
        order by cl.sort_order, i.name), '[]'::jsonb)
      into v_lines
      from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
      left join lateral tandem.item_cost(cl.ingredient_code, v_date) k on true
      where cl.chart_id = v_chart;
    -- одна дата на всю карточку: v_date выше подменён датой версии, если её спросили по id
    select * into v_cost from tandem.item_cost(v_code, v_date);
    return jsonb_build_object('ok', true, 'item', v_item,
      'chart', (select jsonb_build_object('id', c.id, 'date_from', c.date_from, 'date_to', c.date_to,
                  'output_amount', c.output_amount, 'technology', c.technology, 'note', c.note,
                  'source', c.source, 'lines', v_lines)
                from tandem.charts c where c.id = v_chart),
      'cost', v_cost.cost, 'partial', v_cost.partial, 'missing', to_jsonb(v_cost.missing),
      'versions', v_versions);
  end if;

  -- ---------- сохранение ----------
  if action = 'chart_save' then
    select item_type into v_type from tandem.items where code = v_code and active;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена или выключена'); end if;
    if v_type not in ('dish','prepared') then
      return tandem.err('validation', 'Техкарта бывает только у блюда или полуфабриката');
    end if;
    v_from := tandem.chart_date(payload->>'date_from');
    v_to   := tandem.chart_date(payload->>'date_to');
    v_out  := nullif(payload->>'output_amount','')::numeric;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала действия'); end if;
    if v_to is not null and v_to < v_from then return tandem.err('validation', 'Дата окончания раньше начала'); end if;
    if v_out is null or v_out <= 0 then return tandem.err('validation', 'Выход должен быть больше нуля'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В карте нет ни одной строки');
    end if;
    -- строки: ингредиент существует, активен, не само блюдо, не ведёт обратно к блюду.
    -- 46: цикл ищется на весь период карты [v_from, v_to], а не только на дату начала: версия ПФ,
    -- вступающая в силу позже, может замкнуть круг уже внутри периода.
    for v_line in select * from jsonb_array_elements(payload->'lines') loop
      v_ing := v_line->>'ingredient_code';
      select item_type, active into v_ing_type, v_active from tandem.items where code = v_ing;
      if v_ing_type is null then return tandem.err('validation', 'Ингредиент не найден: ' || coalesce(v_ing,'')); end if;
      if not v_active then return tandem.err('validation', 'Ингредиент выключен: ' || v_ing); end if;
      if v_ing = v_code then return tandem.err('validation', 'Блюдо не может входить само в себя'); end if;
      if v_ing_type in ('dish','prepared') and tandem.chart_reaches_during(v_ing, v_code, v_from, v_to) then
        return tandem.err('validation', 'Цикл: ' || v_ing || ' уже содержит ' || v_code);
      end if;
      if coalesce((v_line->>'brutto')::numeric, -1) < 0 or coalesce((v_line->>'netto')::numeric, -1) < 0
         or coalesce((v_line->>'output')::numeric, -1) < 0 then
        return tandem.err('validation', 'Количества в строке ' || v_ing || ' должны быть числами не меньше нуля');
      end if;
      if (v_line->>'netto')::numeric > (v_line->>'brutto')::numeric then
        return tandem.err('validation', 'Нетто больше брутто в строке ' || v_ing);
      end if;
    end loop;
    -- пересечение дат с другой картой этого блюда
    if exists (select 1 from tandem.charts c where c.item_code = v_code and (v_id is null or c.id <> v_id)
               and daterange(c.date_from, c.date_to, '[]') && daterange(v_from, v_to, '[]')) then
      return tandem.err('validation', 'На эти даты уже действует другая версия — закройте её датой или выберите другую дату начала');
    end if;
    if v_id is null then
      insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
        values (v_code, v_from, v_to, v_out, payload->>'technology', payload->>'note', 'office', v_user.id, v_user.id)
        returning id into v_id;
    else
      -- I1: правка карты из iiko делает её офисной — перенос её больше не трогает. iiko_id
      -- сохраняется: по нему повторный перенос узнаёт карту и пропускает как «правлена в офисе».
      -- M4: technology и note меняются только когда ключ пришёл в payload — иначе точечное
      -- сохранение (фронт передаёт не всю карточку) молча стирало бы описание и примечание.
      update tandem.charts set date_from = v_from, date_to = v_to, output_amount = v_out,
        technology = case when payload ? 'technology' then payload->>'technology' else technology end,
        note = case when payload ? 'note' then payload->>'note' else note end,
        source = 'office',
        updated_by = v_user.id, updated_at = now()
        where id = v_id and item_code = v_code;
      if not found then return tandem.err('not_found', 'Карта не найдена'); end if;
      delete from tandem.chart_lines where chart_id = v_id;
    end if;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, x->>'ingredient_code', (x->>'brutto')::numeric, (x->>'netto')::numeric,
             (x->>'output')::numeric, (ord - 1)::int, nullif(x->>'note','')
      from jsonb_array_elements(payload->'lines') with ordinality as t(x, ord);
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- новая версия с даты ----------
  if action = 'chart_new_version' then
    v_from := tandem.chart_date(payload->>'date_from');
    if v_from is null then return tandem.err('validation', 'Укажите дату начала новой версии'); end if;
    v_prev := tandem.active_chart(v_code, v_from - 1);
    if v_prev is null then
      return tandem.err('validation', 'Нет действующей карты, которую можно продолжить — создайте карту обычным сохранением');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from >= v_from) then
      return tandem.err('validation', 'Уже есть версия с более поздней датой начала');
    end if;
    -- 46: новая версия продлевает состав прежней на [v_from, ∞) — если прежняя была закрыта раньше,
    -- это новый для неё период, и цикл проверяется на нём так же, как при сохранении
    for v_ing in select cl.ingredient_code from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
                  where cl.chart_id = v_prev and i.item_type in ('dish','prepared') loop
      if tandem.chart_reaches_during(v_ing, v_code, v_from, null) then
        return tandem.err('validation', 'Цикл: ' || v_ing || ' уже содержит ' || v_code);
      end if;
    end loop;
    update tandem.charts set date_to = v_from - 1, updated_by = v_user.id, updated_at = now() where id = v_prev;
    insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
      select item_code, v_from, null, output_amount, technology, note, 'office', v_user.id, v_user.id
      from tandem.charts where id = v_prev returning id into v_id;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, ingredient_code, brutto, netto, output, sort_order, note
      from tandem.chart_lines where chart_id = v_prev;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- удаление ----------
  if action = 'chart_delete' then
    select item_code, date_from into v_code, v_from from tandem.charts where id = v_id and source = 'office';
    if v_code is null then
      return tandem.err('validation', 'Удалять можно только карты, созданные в бэк-офисе; карты из iiko закрываются датой');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from > v_from) then
      return tandem.err('validation', 'После этой версии есть более поздние — удалите сначала их');
    end if;
    -- 46: предыдущая версия ниже снова открывается — на [v_from, ∞) её состав не должен замыкать круг
    select id into v_prev from tandem.charts where item_code = v_code and date_to = v_from - 1;
    for v_ing in select cl.ingredient_code from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
                  where cl.chart_id = v_prev and i.item_type in ('dish','prepared') loop
      if tandem.chart_reaches_during(v_ing, v_code, v_from, null) then
        return tandem.err('validation', 'Цикл: после удаления снова действовала бы прежняя версия, а ' || v_ing || ' уже содержит ' || v_code);
      end if;
    end loop;
    delete from tandem.charts where id = v_id;
    -- предыдущая версия, закрытая ради удалённой, снова становится открытой
    update tandem.charts set date_to = null where item_code = v_code and date_to = v_from - 1
      and not exists (select 1 from tandem.charts c2 where c2.item_code = v_code and c2.date_from > v_from - 1);
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- отчёт ----------
  if action = 'foodcost_report' then
    v_limit := coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35);
    select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb),
           'code;name;group;unit;cost;price;markup_pct;foodcost_pct;over_limit;missing' || E'\n' ||
           coalesce(string_agg(concat_ws(';', m.code, replace(m.name,';',','),
             coalesce(replace(m.group_name,';',','),''), m.unit_id,
             -- 74: десятичная запятая — как в остальных выгрузках; русский Excel с «;» читает
             -- «28.6» как дату или текст
             coalesce(replace(m.cost::text, '.', ','), ''), coalesce(replace(m.price::text, '.', ','), ''),
             coalesce(replace(m.markup_pct::text, '.', ','), ''),
             coalesce(replace(m.foodcost_pct::text, '.', ','), ''), case when m.over_limit then '1' else '0' end,
             -- V26: коды через « | » — «81,90» тот же Excel читал как число 81,9; «81 900» — как 81900
             array_to_string(m.missing, ' | ')), E'\n'), '')
      into v_rows, v_csv
      from tandem.menu_foodcost(nullif(payload->>'point_id',''), v_date, v_group) m;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'limit', v_limit, 'csv', v_csv);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  -- charts_no_overlap ловится проверкой выше; сюда доходят только гонки двух правок разом.
  when exclusion_violation then
    return tandem.err('validation', 'На эти даты уже действует другая версия этой карты');
  when invalid_datetime_format or datetime_field_overflow then
    return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id    uuid;
  v_code  text;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int;
  v_rows  jsonb;
  v_name  text;
  v_old   text;
  v_item  tandem.items;
  k       record;   -- себестоимость позиции: (cost, partial, missing)
begin
  -- Себестоимость отдельным действием: карточка товара обходится без пересчёта дерева,
  -- а экран техкарт спрашивает цену ингредиента точечно.
  if action = 'item_cost_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    -- 49: дата — строго ГГГГ-ММ-ДД, как в разделе техкарт (неверная ловится в конце функции)
    select * into k from tandem.item_cost(v_code, coalesce(tandem.chart_date(payload->>'date'), current_date));
    return jsonb_build_object('ok', true, 'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing));
  end if;

  if action = 'groups_list' then
    return jsonb_build_object('ok', true, 'groups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'parent_id', g.parent_id, 'name', g.name, 'sort_order', g.sort_order,
        'active', g.active, 'items_count', (select count(*) from tandem.items i where i.group_id = g.id and i.active))
        order by g.sort_order, g.name), '[]'::jsonb)
      from tandem.item_groups g));
  end if;

  if action = 'group_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название группы пустое'); end if;
    v_id := nullif(payload->>'id','')::uuid;
    -- Цикл в дереве групп прятал бы ветку целиком (дерево строится от корня): группа не может
    -- входить сама в себя и в собственную подгруппу.
    if v_id is not null and v_id = nullif(payload->>'parent_id','')::uuid then
      return tandem.err('validation', 'Группа не может входить сама в себя'); end if;
    if v_id is not null and exists (
         with recursive up as (
           select g.id, g.parent_id from tandem.item_groups g where g.id = nullif(payload->>'parent_id','')::uuid
           union
           select g.id, g.parent_id from tandem.item_groups g join up on g.id = up.parent_id)
         select 1 from up where up.id = v_id) then
      return tandem.err('validation', 'Нельзя вложить группу в её же подгруппу'); end if;
    if v_id is null then
      insert into tandem.item_groups (name, parent_id, active)
        values (v_name, nullif(payload->>'parent_id','')::uuid, coalesce((payload->>'active')::boolean, true))
        returning id into v_id;
    else
      select name into v_old from tandem.item_groups where id = v_id;
      -- V13: имя, которым уже помечены позиции другой группы, добавилось бы в фильтры точек этой —
      -- и им открылись бы чужие позиции. Сохранение без смены имени (имена групп повторяются) не держим.
      if found and v_old is distinct from v_name and tandem.group_name_taken(v_id, v_name) then
        return tandem.err('validation', 'Такое имя уже у другой группы — точкам открылись бы её позиции. Выберите другое');
      end if;
      update tandem.item_groups set name = v_name,
        parent_id = nullif(payload->>'parent_id','')::uuid,
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Группа не найдена'); end if;
      -- 42: в той же транзакции новое имя уходит в category позиций группы и фильтры точек
      if v_old is distinct from v_name then perform tandem.group_rename_sync(v_id, v_old, v_name); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'items_search' then
    select count(*) into v_total from tandem.items i
      where (v_q = '' or i.name ilike '%' || tandem.like_escape(v_q) || '%' or i.artikul ilike '%' || tandem.like_escape(v_q) || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select i.code, i.name, i.artikul, i.item_type, i.unit_id, i.group_id, g.name as group_name,
             i.active, i.for_sale, i.price
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where (v_q = '' or i.name ilike '%' || tandem.like_escape(v_q) || '%' or i.artikul ilike '%' || tandem.like_escape(v_q) || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean)
      order by i.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  -- Пачечное сопоставление ключей из файла остатков с номенклатурой.
  -- Ключ — код и/или название; порядок попыток задан весом pr: собственный код, код iiko,
  -- артикул (в отчётах iiko колонка «Код» — это именно артикул, пятизначный с ведущими
  -- нулями), псевдоним, единственное точное совпадение по названию. Название, под которым
  -- ходят две живые позиции, не сопоставляется вовсе: угаданная пара хуже честного «не нашёл».
  -- Несопоставленные ключи в ответе просто отсутствуют — их показывает форма.
  -- CTE с ключами зовётся kv, а не k: k здесь — объявленная запись себестоимости, и plpgsql
  -- подставляет переменную вместо колонки CTE ("record k is not assigned yet" на любом вызове).
  if action = 'items_lookup_list' then
    if jsonb_typeof(payload->'keys') <> 'array' or jsonb_array_length(payload->'keys') > 2000 then
      return tandem.err('validation', 'Передайте массив ключей (до 2000)');
    end if;
    return jsonb_build_object('ok', true, 'rows', (
      with kv as (
        select (ord - 1)::int as i, nullif(btrim(x->>'code'),'') as code, nullif(btrim(x->>'name'),'') as name
        from jsonb_array_elements(payload->'keys') with ordinality t(x, ord)
      ),
      m as (
        select kv.i, i.code as item_code, i.name, i.unit_id, 'code' as matched_by, 1 as pr
          from kv join tandem.items i on i.active and kv.code is not null and i.code = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'iiko_code', 2
          from kv join tandem.items i on i.active and kv.code is not null and i.iiko_code = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'artikul', 3
          from kv join tandem.items i on i.active and kv.code is not null and i.artikul = kv.code
        union all
        select kv.i, i.code, i.name, i.unit_id, 'alias', 4
          from kv join tandem.item_aliases a on kv.name is not null and a.alias = lower(kv.name)   -- 73: псевдонимы хранятся строчными
          join tandem.items i on i.code = a.item_code and i.active
        union all
        select kv.i, i.code, i.name, i.unit_id, 'name', 5
          from kv
          join (select lower(name) as ln, min(code) as code from tandem.items
                where active group by lower(name) having count(*) = 1) nm
            on kv.name is not null and nm.ln = lower(kv.name)
          join tandem.items i on i.code = nm.code
      ),
      best as (select distinct on (i) i, item_code, name, unit_id, matched_by from m order by i, pr)
      select coalesce(jsonb_agg(jsonb_build_object('i', i, 'item_code', item_code, 'name', name,
                                                   'unit_id', unit_id, 'matched_by', matched_by)
                                order by i), '[]'::jsonb) from best));
  end if;

  if action = 'item_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    select * into k from tandem.item_cost(v_code, current_date);
    return jsonb_build_object('ok', true,
      'item', (select jsonb_build_object('code', i.code, 'name', i.name, 'artikul', i.artikul,
                 'item_type', i.item_type, 'unit_id', i.unit_id, 'group_id', i.group_id,
                 'group_name', g.name, 'active', i.active, 'for_sale', i.for_sale, 'price', i.price,
                 'note', i.note, 'pack_factor', i.pack_factor, 'pack_unit', i.pack_unit,
                 'pack_price', i.pack_price, 'has_chart', i.has_chart, 'iiko_code', i.iiko_code,
                 'cost_price', i.cost_price, 'cost_date', i.cost_date, 'cost_source', i.cost_source)
               from tandem.items i left join tandem.item_groups g on g.id = i.group_id where i.code = v_code),
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
                   'point_id', p.id, 'point_name', p.name, 'price', pp.price,
                   'rank', r.rank, 'short', coalesce(r.in_short_list, false)) order by p.sort_order), '[]'::jsonb)
                 from tandem.points p
                 left join tandem.item_prices pp on pp.point_id = p.id and pp.item_code = v_code
                 left join tandem.item_rank r on r.point_id = p.id and r.item_code = v_code
                 where p.active),
      'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing));
  end if;

  if action = 'item_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    v_code := nullif(payload->>'code','');
    -- Имя обязательно только при создании: правка меняет ровно те поля, что переданы,
    -- иначе точечное «поставить учётную цену» требовало бы тащить с собой всю карточку.
    if v_code is null and v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;
    if v_code is null then
      -- создание: тип и единица измерения обязательны
      if coalesce(payload->>'item_type','') not in ('goods','dish','prepared','service') then
        return tandem.err('validation', 'Тип: goods, dish, prepared или service');
      end if;
      if not exists (select 1 from tandem.units where id = payload->>'unit_id') then
        return tandem.err('validation', 'Единица измерения не из справочника');
      end if;
      v_code := nextval('tandem.item_code_seq')::text;
      insert into tandem.items (code, name, artikul, item_type, unit_id, unit, step, group_id, active,
                                for_sale, note, price, pack_factor, pack_unit, pack_price, category, source,
                                cost_price, cost_date, cost_source)
      values (v_code, v_name, nullif(payload->>'artikul',''), payload->>'item_type', payload->>'unit_id',
              payload->>'unit_id', case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end,
              nullif(payload->>'group_id','')::uuid, coalesce((payload->>'active')::boolean, true),
              coalesce((payload->>'for_sale')::boolean, false), payload->>'note',
              nullif(payload->>'price','')::numeric, nullif(payload->>'pack_factor','')::numeric,
              nullif(payload->>'pack_unit',''), nullif(payload->>'pack_price','')::numeric,
              (select name from tandem.item_groups where id = nullif(payload->>'group_id','')::uuid), 'office',
              nullif(payload->>'cost_price','')::numeric,
              case when nullif(payload->>'cost_price','') is not null then current_date end,
              case when nullif(payload->>'cost_price','') is not null then 'manual' end);
    else
      -- правка: тип и единица измерения необязательны — как остальные поля, меняются только если переданы
      if nullif(payload->>'item_type','') is not null and payload->>'item_type' not in ('goods','dish','prepared','service') then
        return tandem.err('validation', 'Тип: goods, dish, prepared или service');
      end if;
      if nullif(payload->>'unit_id','') is not null and not exists (select 1 from tandem.units where id = payload->>'unit_id') then
        return tandem.err('validation', 'Единица измерения не из справочника');
      end if;
      select * into v_item from tandem.items where code = v_code;
      if not found then return tandem.err('not_found', 'Позиция не найдена'); end if;
      -- 44: единица — мера всех чисел позиции: остатков и средней на складе, строк документов, норм
      -- закладки в чужих техкартах и выхода своей. Смена без пересчёта молча превращала «300 шт по 60 ₸»
      -- в «300 кг по 60 ₸», поэтому единицу меняет только позиция без истории.
      if nullif(payload->>'unit_id','') is not null and payload->>'unit_id' <> v_item.unit_id
         and (exists (select 1 from tandem.stock_moves where item_code = v_code)
              or exists (select 1 from tandem.document_lines where item_code = v_code)
              or exists (select 1 from tandem.chart_lines where ingredient_code = v_code)
              or exists (select 1 from tandem.charts where item_code = v_code)) then
        return tandem.err('validation', 'Единицу нельзя сменить: по позиции есть движения, документы или техкарты');
      end if;
      -- Товар считается и списывается по учётной цене, блюдо и полуфабрикат — по техкарте: при
      -- движениях склада смена между ними переписала бы смысл уже проведённого.
      -- V14: блюдо/полуфабрикат без единой версии карты списывался и так сам, как товар, — смена на
      -- «товар» ничего не переписывает (это и советует отчёт качества «Вода ПФ»). Любая версия карты,
      -- даже закрытая, держит: по ней раскладывалось проведённое.
      if nullif(payload->>'item_type','') is not null
         and payload->>'item_type' in ('goods','dish','prepared') and v_item.item_type in ('goods','dish','prepared')
         and (payload->>'item_type' = 'goods') <> (v_item.item_type = 'goods')
         and exists (select 1 from tandem.stock_moves where item_code = v_code)
         and (payload->>'item_type' <> 'goods' or exists (select 1 from tandem.charts where item_code = v_code)) then
        return tandem.err('validation', case when payload->>'item_type' = 'goods'
          then 'Тип нельзя сменить на товар: у позиции есть техкарта и движения склада'
          else 'Тип нельзя сменить между товаром и блюдом/полуфабрикатом: по позиции есть движения склада' end);
      end if;
      -- I8: source='office' закрывает строку от повторного переноса из iiko (см. tandem_migrate),
      -- category держится в согласии с группой — на неё смотрят старые экраны точек.
      -- cost_price правится только когда ключ пришёл: пустое значение снимает цену вместе с датой
      -- и источником, иначе учётная цена молча воскресала бы при любой правке карточки.
      -- 76: artikul и group_id так же — ключ пришёл, значит применяется (пустое снимает артикул и
      -- группу); раньше пустое молча оставляло прежнее, а карточка показывала «Сохранено».
      update tandem.items set
        name = coalesce(nullif(v_name, ''), name),
        artikul = case when payload ? 'artikul' then nullif(payload->>'artikul','') else artikul end,
        item_type = coalesce(nullif(payload->>'item_type',''), item_type),
        unit_id = coalesce(nullif(payload->>'unit_id',''), unit_id),
        unit = coalesce(nullif(payload->>'unit_id',''), unit),
        -- шаг ввода следует за единицей, как при создании (сменить её можно только у позиции без истории)
        step = case when nullif(payload->>'unit_id','') is not null and payload->>'unit_id' <> unit_id
                    then case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end else step end,
        group_id = case when payload ? 'group_id' then nullif(payload->>'group_id','')::uuid else group_id end,
        category = case when payload ? 'group_id'
                        then (select g.name from tandem.item_groups g where g.id = nullif(payload->>'group_id','')::uuid)
                        else coalesce((select g.name from tandem.item_groups g where g.id = items.group_id), items.category) end,
        source = 'office',
        active = coalesce((payload->>'active')::boolean, active),
        for_sale = coalesce((payload->>'for_sale')::boolean, for_sale),
        note = coalesce(payload->>'note', note),
        -- Цена по умолчанию правится только когда ключ пришёл: пустое значение её снимает.
        price = case when payload ? 'price' then nullif(payload->>'price','')::numeric else price end,
        pack_factor = case when payload ? 'pack_factor' then nullif(payload->>'pack_factor','')::numeric else pack_factor end,
        pack_unit   = case when payload ? 'pack_unit'   then nullif(payload->>'pack_unit','')            else pack_unit end,
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end,
        -- 72: карточка шлёт cost_price при любом сохранении; цена, равная текущей, не делает её
        -- «ручной» с сегодняшней датой — иначе терялось, откуда она (накладная, iiko), и перенос
        -- цен из iiko переставал её обновлять
        cost_price  = case when payload ? 'cost_price'  then nullif(payload->>'cost_price','')::numeric  else cost_price end,
        cost_date   = case when payload ? 'cost_price' and nullif(payload->>'cost_price','')::numeric is distinct from cost_price
                           then case when nullif(payload->>'cost_price','') is null then null else current_date end
                           else cost_date end,
        cost_source = case when payload ? 'cost_price' and nullif(payload->>'cost_price','')::numeric is distinct from cost_price
                           then case when nullif(payload->>'cost_price','') is null then null else 'manual' end
                           else cost_source end
      where code = v_code;
      if not found then return tandem.err('not_found', 'Позиция не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'code', v_code);
  end if;

  if action = 'item_prices_save' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    delete from tandem.item_prices pp using jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where pp.item_code = v_code and pp.point_id = x->>'point_id' and nullif(x->>'price','') is null;
    insert into tandem.item_prices (point_id, item_code, price, source)
      select x->>'point_id', v_code, (x->>'price')::numeric, 'office'
      from jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where nullif(x->>'price','') is not null
    on conflict (point_id, item_code) do update set price = excluded.price, source = 'office';
    return jsonb_build_object('ok', true);
  end if;

  -- Загрузка цен из «Сводного прейскуранта» iiko кнопкой в бэк-офисе (раньше — скрипт со служебным
  -- ключом). Разбор Excel и выбор точек для каждого подразделения — в браузере; сюда приходят строки
  -- {pt: точка, a: артикул, p: цена}. Пара — по артикулу позиции; цена точки перезаписывается.
  if action = 'item_prices_import' then
    if jsonb_typeof(payload->'rows') is distinct from 'array' then
      return tandem.err('validation', 'Нет строк цен'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'rows') x
                where not exists (select 1 from tandem.points p where p.id = x->>'pt' and p.id not like 'zz\_%')) then
      return tandem.err('validation', 'В строках есть неизвестная точка'); end if;
    declare
      v_loaded int; v_unm int; v_sample jsonb;
    begin
      create temp table if not exists _price_in (point_id text, artikul text, price numeric) on commit drop;
      truncate _price_in;
      insert into _price_in select x->>'pt', btrim(x->>'a'), (x->>'p')::numeric
        from jsonb_array_elements(payload->'rows') x
       where (x->>'p')::numeric > 0 and nullif(btrim(x->>'a'), '') is not null;
      with matched as (
        select distinct on (n.point_id, i.code) n.point_id, i.code, n.price
          from _price_in n join tandem.items i on i.artikul = n.artikul and i.active
         order by n.point_id, i.code
      ), done as (
        insert into tandem.item_prices (point_id, item_code, price, source)
        select point_id, code, price, 'pricelist' from matched
        on conflict (point_id, item_code) do update set price = excluded.price, source = excluded.source
        returning 1
      ) select count(*) into v_loaded from done;
      select count(distinct artikul) into v_unm from _price_in n
       where not exists (select 1 from tandem.items i where i.artikul = n.artikul and i.active);
      select coalesce(jsonb_agg(a), '[]'::jsonb) into v_sample from (select distinct n.artikul a from _price_in n
       where not exists (select 1 from tandem.items i where i.artikul = n.artikul and i.active) order by 1 limit 20) s;
      return jsonb_build_object('ok', true, 'loaded', v_loaded, 'unmatched', v_unm, 'unmatched_sample', v_sample);
    end;
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  when invalid_datetime_format then   -- tandem.chart_date в item_cost_get
    return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
end $function$
;

CREATE OR REPLACE FUNCTION public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int; v_g record;
  v_warn text[] := '{}';   -- V13: замечания переноса групп (в ответе warnings — только если есть)
  v_keep uuid[] := '{}';   -- V13: группы, чьё новое имя из iiko занято позициями другой группы
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    -- 42: группа, переименованная в iiko, переносит новое имя в category своих позиций и в фильтры
    -- категорий точек — как group_save в бэк-офисе.
    -- V13: если новым именем уже помечены позиции другой группы, фильтры точек не трогаются, и имя
    -- группы с category её позиций остаются прежними — совпадение уходит в warnings. Принять одно имя
    -- без другого нельзя: точки отбирают позиции по category, и позиции под общим с чужой группой
    -- именем сразу открылись бы точкам той группы (а свои точки их потеряли бы). Следующий перенос
    -- попробует снова — пока группу не переименуют в iiko.
    -- Занятость проверяется в момент переименования, а свободные сначала: цепочка в одной пачке
    -- («Напитки»→«Чай», «Соки»→«Напитки») проходит целиком при любом порядке строк.
    for v_g in
      select g.id, g.name as old_name, n.name as new_name
      from tandem.item_groups g
      join (select distinct on (id) (x->>'id')::uuid id, x->>'name' name
            from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
            order by id, coalesce((x->>'deleted')::boolean,false)) n on g.iiko_id = n.id
      where n.name is not null and g.name is distinct from n.name
      order by tandem.group_name_taken(g.id, n.name), n.name, g.id
    loop
      if tandem.group_name_taken(v_g.id, v_g.new_name) then
        v_keep := v_keep || v_g.id;
        v_warn := v_warn || format('группа «%s»: в iiko она «%s», но этим именем уже помечены позиции другой группы — имя не '
          'перенесено, иначе точкам открылись бы чужие позиции; переименуйте одну из групп в iiko', v_g.old_name, v_g.new_name);
      else
        perform tandem.group_rename_sync(v_g.id, v_g.old_name, v_g.new_name);
      end if;
    end loop;
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.item_groups g set name = case when g.id = any(v_keep) then g.name else inc.name end,   -- V13
             active = not inc.deleted, sort_order = inc.sort
      from inc where g.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.item_groups (id, name, active, sort_order, iiko_id)
      select inc.id, inc.name, not inc.deleted, inc.sort, inc.id from inc
      where not exists (select 1 from tandem.item_groups g where g.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'stores' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, nullif(x->>'organization_id','')::uuid org,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.stores s set name = inc.name, organization_id = inc.org, active = not inc.deleted
      from inc where s.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.stores (id, name, organization_id, active, iiko_id)
      select inc.id, inc.name, inc.org, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.stores s where s.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'counteragents' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name,
             case when x->>'kind' in ('supplier','customer','employee') then x->>'kind' else 'other' end kind,
             nullif(x->>'bin','') bin, nullif(x->>'phone','') phone,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.counteragents c set name = inc.name, kind = inc.kind, bin = inc.bin,
             phone = inc.phone, active = not inc.deleted
      from inc where c.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.counteragents (id, name, kind, bin, phone, active, iiko_id)
      select inc.id, inc.name, inc.kind, inc.bin, inc.phone, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.counteragents c where c.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'items' then
    -- три непересекающихся набора: уже привязанные по iiko_id; старые строки по iiko_code; новые.
    -- 42: при смене группы category ставится по новой группе (на неё смотрят экраны точки, касса и
    -- заявки), новая позиция получает category своей группы сразу.
    -- inc убирает дубли по id, inc2 — дубли по code (в обоих случаях живая строка побеждает
    -- удалённую): без этого две строки одной пачки с одинаковым ключом обе метят в insert
    -- и падают сырой ошибкой unique_violation вместо {ok:false,...}.
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'code' code, x->>'name' name, nullif(x->>'artikul','') artikul,
             nullif(x->>'group_id','')::uuid group_id,
             case when x->>'unit' in ('шт','кг','л','порц') then x->>'unit' else 'шт' end unit,
             case when x->>'type' in ('goods','dish','prepared','service') then x->>'type' else 'dish' end typ,
             coalesce((x->>'deleted')::boolean,false) deleted,
             nullif(x->>'price','')::numeric price
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'id','') <> '' and coalesce(x->>'code','') <> ''
      order by id, deleted
    ),
    inc2 as (
      select distinct on (code) * from inc order by code, deleted
    ),
    upd_id as (
      update tandem.items i set name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             category = case when i.group_id is distinct from inc2.group_id
                             then (select g.name from tandem.item_groups g where g.id = inc2.group_id) else i.category end,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id = inc2.id and i.source in ('iiko_migrate','iiko_api') returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc2.id, name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             category = case when i.group_id is distinct from inc2.group_id
                             then (select g.name from tandem.item_groups g where g.id = inc2.group_id) else i.category end,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id is null and i.iiko_code = inc2.code
                  and i.source in ('iiko_migrate','iiko_api') returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, category, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc2.code, inc2.name, inc2.artikul, inc2.code, inc2.id, inc2.group_id,
             (select g.name from tandem.item_groups g where g.id = inc2.group_id), inc2.unit, inc2.unit,
             case when inc2.unit in ('кг','л') then 0.5 else 1 end,
             inc2.typ, upper(inc2.typ), inc2.price, not inc2.deleted, false, 'iiko_migrate', now()
      from inc2
      where not exists (select 1 from tandem.items i where i.iiko_id = inc2.id or i.code = inc2.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  elsif p_kind = 'chart_candidates' then
    -- по каким позициям вообще имеет смысл спрашивать карты у iiko
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'iiko_id', iiko_id) order by code), '[]'::jsonb)
      from tandem.items where active and iiko_id is not null and item_type in ('dish','prepared')));

  elsif p_kind = 'charts' then
    -- по одной карте: строки состава сопоставляются по items.iiko_id, неизвестные ингредиенты
    -- пропускаются и называются в ответе; пересекающиеся версии того же блюда закрываются.
    -- Правило при совпадении date_from — «побеждает первая записанная», а не пришедшая позже:
    -- перенос ничего не удаляет, новая версия уходит в skipped и называется в errors. Так
    -- повторный прогон той же выгрузки идемпотентен, а карту, заведённую в офисе руками
    -- (source <> 'iiko'), перенос из iiko не затирает никогда.
    declare
      v_row jsonb; v_cid uuid; v_code text; v_from date; v_to date; v_out numeric; v_lines jsonb;
      v_bad int; v_skip_lines int := 0; v_unknown text[] := '{}'; v_errors text[] := '{}';
      v_exists uuid; v_exists_src text; v_c record; v_conf record; v_off record; v_to_in date;
    begin
      for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
        v_cid  := nullif(v_row->>'iiko_id','')::uuid;
        v_code := nullif(v_row->>'code','');
        v_from := coalesce(nullif(v_row->>'date_from','')::date, date '2020-01-01');
        v_to   := nullif(v_row->>'date_to','')::date;
        v_out  := coalesce(nullif(v_row->>'output_amount','')::numeric, 1);
        -- карты бывают только у блюд и полуфабрикатов; на сырьё и услуги их не вешаем
        if v_cid is null or v_code is null
           or not exists (select 1 from tandem.items
                           where code = v_code and item_type in ('dish','prepared')) then
          v_skip := v_skip + 1; continue;
        end if;
        if v_out <= 0 then v_out := 1; end if;
        if v_to is not null and v_to < v_from then v_to := null; end if;

        -- известные строки складываем в v_lines, неизвестные считаем и запоминаем
        select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'brutto', (l->>'brutto')::numeric,
                 'netto', (l->>'netto')::numeric, 'output', (l->>'output')::numeric,
                 'sort', coalesce((l->>'sort')::int, 0)) order by coalesce((l->>'sort')::int, 0))
                 filter (where i.code is not null), '[]'::jsonb),
               count(*) filter (where i.code is null)
          into v_lines, v_bad
          from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
          left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid;
        v_skip_lines := v_skip_lines + v_bad;
        if v_bad > 0 then
          -- список неизвестных: без пустых значений, сразу без повторов и не длиннее 20
          select coalesce(array_agg(distinct u), '{}'::text[]) into v_unknown
            from unnest(v_unknown || (
              select coalesce(array_agg(distinct l->>'ingredient_iiko_id'), '{}'::text[])
                from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
                left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid
                where i.code is null and coalesce(l->>'ingredient_iiko_id','') <> '')) u;
          if coalesce(array_length(v_unknown, 1), 0) > 20 then v_unknown := v_unknown[1:20]; end if;
        end if;

        -- строки, где ингредиент — само блюдо, отбрасываем: рекурсия в себя бессмысленна;
        -- они такие же пропущенные строки, как и с неизвестным ингредиентом
        select coalesce(jsonb_agg(x) filter (where x->>'code' is distinct from v_code), '[]'::jsonb),
               count(*) filter (where x->>'code' is not distinct from v_code)
          into v_lines, v_bad
          from jsonb_array_elements(v_lines) x;
        v_skip_lines := v_skip_lines + v_bad;
        if jsonb_array_length(v_lines) = 0 then v_skip := v_skip + 1; continue; end if;

        -- I1: карту, правленную в бэк-офисе, перенос не переписывает. iiko_id у неё остался,
        -- но source стал 'office' — по нему и узнаём: пропускаем и называем в errors.
        select id, source into v_exists, v_exists_src from tandem.charts where iiko_id = v_cid;
        if v_exists is not null and v_exists_src is distinct from 'iiko' then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || ': правлена в офисе');
          end if;
          continue;
        end if;
        -- чужая версия ровно с той же датой начала: не трогаем её и не пишем свою
        select id, source, iiko_id into v_conf from tandem.charts
          where item_code = v_code and date_from = v_from and (v_exists is null or id <> v_exists)
          limit 1;
        if v_conf.id is not null then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || case when v_conf.source is distinct from 'iiko'
              then ': совпадает с картой офиса'
              else ': дубль даты начала с ' || coalesce(v_conf.iiko_id::text, '?') end);
          end if;
          continue;
        end if;
        -- 43: карту офиса перенос не закрывает и не меняет. Офисная версия, начавшаяся раньше и ещё
        -- действующая на начало iiko-версии, — iiko-версию не пишем, называем в errors. Проверка до
        -- блока записи: иначе ранние iiko-версии успели бы закрыться ради версии, которой не будет.
        select id, date_from into v_off from tandem.charts
          where item_code = v_code and source is distinct from 'iiko' and (v_exists is null or id <> v_exists)
            and date_from < v_from and daterange(date_from, date_to, '[]') && daterange(v_from, v_to, '[]')
          order by date_from desc limit 1;
        if v_off.id is not null then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || ': пересекается с картой офиса с ' || to_char(v_off.date_from, 'DD.MM.YYYY'));
          end if;
          continue;
        end if;

        -- ниже всё пишущее: одна кривая карта не должна ронять всю пачку
        begin
          -- пересечения с другими версиями того же блюда: ранние закрываем днём раньше нашего
          -- начала, из-за поздних укорачиваем себя; равное начало отсеяно выше
          v_to_in := v_to;
          for v_c in select id, date_from, date_to from tandem.charts
                     where item_code = v_code and (v_exists is null or id <> v_exists)
                       and daterange(date_from, date_to, '[]') && daterange(v_from, v_to, '[]') loop
            if v_c.date_from < v_from then
              -- сюда доходят только карты iiko: офисная с более ранним началом отсеяна выше
              update tandem.charts set date_to = v_from - 1, updated_at = now() where id = v_c.id and source = 'iiko';
            elsif v_c.date_from > v_from then
              v_to := least(coalesce(v_to, v_c.date_from - 1), v_c.date_from - 1);
            end if;
            -- равных начал здесь не бывает; если бы вдруг были, запись упрётся
            -- в charts_no_overlap и карта уйдёт в errors ниже — данные не пострадают
          end loop;

          -- страховка: сюда не попасть, пока равные начала отсеиваются до блока
          if v_to is not null and v_to < v_from then
            v_skip := v_skip + 1;
          else
            if v_exists is null then
              insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, source, iiko_id)
                values (v_code, v_from, v_to, v_out, nullif(v_row->>'technology',''), 'iiko', v_cid)
                returning id into v_exists;
              v_ins := v_ins + 1;
            else
              update tandem.charts set item_code = v_code, date_from = v_from, date_to = v_to,
                     output_amount = v_out, technology = nullif(v_row->>'technology',''), updated_at = now()
                where id = v_exists;
              delete from tandem.chart_lines where chart_id = v_exists;
              v_upd := v_upd + 1;
            end if;
            insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order)
              select v_exists, x->>'code', coalesce((x->>'brutto')::numeric,0), coalesce((x->>'netto')::numeric,0),
                     coalesce((x->>'output')::numeric,0), coalesce((x->>'sort')::int, 0)
              from jsonb_array_elements(v_lines) x;
            -- 43: укоротились из-за поздней карты офиса — записано, но называем: дальше действует она
            if v_to is distinct from v_to_in and coalesce(array_length(v_errors, 1), 0) < 20
               and exists (select 1 from tandem.charts where item_code = v_code and date_from = v_to + 1
                             and source is distinct from 'iiko') then
              v_errors := v_errors || (v_cid::text || ': укорочена до ' || to_char(v_to, 'DD.MM.YYYY')
                                       || ' — дальше действует карта офиса');
            end if;
          end if;
        exception when exclusion_violation then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then v_errors := v_errors || v_cid::text; end if;
        end;
      end loop;

      return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
        'skipped_lines', v_skip_lines, 'unknown', to_jsonb(v_unknown), 'errors', to_jsonb(v_errors));
    end;

  elsif p_kind = 'costs' then
    -- цена закупа из iiko. Перенос ставит только 'iiko_invoice': какой бы source ни пришёл
    -- во входе, чужой меткой он не притворяется. И не перебивает цену, поставленную руками
    -- ('manual') или посчитанную по документу склада ('document') — там источник надёжнее.
    with inc as (
      select distinct on (id) (x->>'iiko_id')::uuid id, (x->>'price')::numeric price,
             nullif(x->>'date','')::date d
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'iiko_id','') <> '' and coalesce(nullif(x->>'price','')::numeric, 0) > 0
      order by id, nullif(x->>'date','')::date desc nulls last
    ),
    upd as (
      update tandem.items i set cost_price = inc.price, cost_date = coalesce(inc.d, current_date),
             cost_source = 'iiko_invoice'
      from inc where i.iiko_id = inc.id
                and (i.cost_source is null or i.cost_source not in ('manual','document'))
      returning 1)
    select count(*) into v_upd from upd;
    return jsonb_build_object('ok', true, 'updated', v_upd, 'skipped', v_total - v_upd);

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd)
         || case when cardinality(v_warn) > 0 then jsonb_build_object('warnings', to_jsonb(v_warn)) else '{}'::jsonb end;
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Дубли ключей в пачке: ' || sqlerrm);
  when others then
    -- иначе любая непредусмотренная ошибка уходит наружу как 500 прокси и вызывающий
    -- (скрипт переноса) видит невнятный ответ вместо причины
    return jsonb_build_object('ok', false, 'error', 'internal', 'message', sqlerrm);
end $function$
;

do $$
declare f text;
begin
  foreach f in array array['tandem.chart_date(text)', 'tandem.chart_reaches_during(text,text,date,date)',
                           'tandem.group_rename_sync(uuid,text,text)', 'tandem.group_name_taken(uuid,text)',
                           'tandem.menu_foodcost(text,date,uuid)',
                           'tandem.office_charts(text,jsonb,tandem.users)', 'tandem.office_nomenclature(text,jsonb,tandem.users)',
                           'public.tandem_migrate(text,text,jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
