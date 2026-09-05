-- Техкарты: расчёт себестоимости на дату.
create or replace function tandem.active_chart(p_code text, p_date date)
returns uuid language sql stable as $$
  select id from tandem.charts
  where item_code = p_code and date_from <= p_date and (date_to is null or date_to >= p_date)
  order by date_from desc limit 1
$$;

-- Себестоимость одной позиции за единицу на дату. Товар — учётная цена; блюдо/полуфабрикат —
-- сумма брутто × себестоимость ингредиента, делённая на выход карты. Если чего-то не хватает,
-- cost = null, а partial — сумма по тому, что посчиталось; missing — коды без цены/карты.
create or replace function tandem.item_cost(p_code text, p_date date default current_date, p_depth int default 0)
returns table(cost numeric, partial numeric, missing text[])
language plpgsql stable as $$
declare
  v_type text; v_price numeric; v_chart uuid; v_out numeric;
  v_sum numeric := 0; v_missing text[] := '{}'; v_all boolean := true;
  r record; s record;
begin
  if p_depth > 10 then
    return query select null::numeric, null::numeric, array['cycle:' || p_code]; return;
  end if;
  select item_type, cost_price into v_type, v_price from tandem.items where code = p_code;
  if not found then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  if v_type in ('goods','service') then
    if v_price is null then
      return query select null::numeric, null::numeric, array[p_code];
    else
      return query select v_price, v_price, '{}'::text[];
    end if;
    return;
  end if;
  v_chart := tandem.active_chart(p_code, p_date);
  if v_chart is null then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  select output_amount into v_out from tandem.charts where id = v_chart;
  for r in select ingredient_code, brutto from tandem.chart_lines where chart_id = v_chart loop
    select * into s from tandem.item_cost(r.ingredient_code, p_date, p_depth + 1);
    if s.cost is null then
      v_all := false;
      v_missing := v_missing || s.missing;
    else
      v_sum := v_sum + r.brutto * s.cost;
    end if;
  end loop;
  return query select
    case when v_all then round(v_sum / v_out, 4) end,
    round(v_sum / v_out, 4),
    (select coalesce(array_agg(distinct m), '{}'::text[]) from unnest(v_missing) m);
end $$;

-- Есть ли p_target в дереве ингредиентов p_from (по картам, действующим на p_date).
create or replace function tandem.chart_reaches(p_from text, p_target text, p_date date default current_date)
returns boolean language sql stable as $$
  with recursive w as (
    select cl.ingredient_code as node, 1 as depth
    from tandem.chart_lines cl where cl.chart_id = tandem.active_chart(p_from, p_date)
    union all
    select cl.ingredient_code, w.depth + 1
    from w join tandem.chart_lines cl on cl.chart_id = tandem.active_chart(w.node, p_date)
    where w.depth < 10
  )
  select exists (select 1 from w where node = p_target)
$$;

-- Фудкост меню: все продаваемые блюда и полуфабрикаты одним рекурсивным обходом.
-- Множитель по пути = произведение брутто/выход; лист — товар (с ценой или без) либо
-- блюдо без действующей карты.
create or replace function tandem.menu_foodcost(p_point text default null, p_date date default current_date, p_group uuid default null)
returns table(code text, name text, group_name text, unit_id text, cost numeric, price numeric,
              markup_pct numeric, foodcost_pct numeric, over_limit boolean, missing text[])
language sql stable as $$
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
  walk as (
    select d.code as root, d.code as node, 1::numeric as factor, 0 as depth, array[d.code] as path
    from dishes d
    union all
    select w.root, cl.ingredient_code, w.factor * cl.brutto / c.output_amount, w.depth + 1, w.path || cl.ingredient_code
    from walk w
    join tandem.items i on i.code = w.node and i.item_type in ('dish','prepared')
    join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
    join tandem.chart_lines cl on cl.chart_id = c.id
    where w.depth < 10 and not (cl.ingredient_code = any(w.path))
  ),
  leaves as (
    select w.root, w.node, w.factor, i.item_type, i.cost_price
    from walk w join tandem.items i on i.code = w.node
    where i.item_type in ('goods','service') or tandem.active_chart(w.node, p_date) is null
       -- M6: обход обрывается на глубине 10 (walk выше), и без этого условия узел на границе
       -- просто исчезал бы из расчёта, а блюдо получало бы «полную» себестоимость по обрубку.
       -- Такой узел — лист без цены: complete становится false, а его код попадает в missing.
       or w.depth >= 10
  ),
  agg as (
    select root,
      sum(case when item_type in ('goods','service') and cost_price is not null then factor * cost_price else 0 end) as partial,
      bool_and(item_type in ('goods','service') and cost_price is not null) as complete,
      array_remove(array_agg(distinct case when not (item_type in ('goods','service') and cost_price is not null) then node end), null) as missing
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
$$;

revoke all on function tandem.active_chart(text,date), tandem.item_cost(text,date,int),
  tandem.chart_reaches(text,text,date), tandem.menu_foodcost(text,date,uuid) from public;
