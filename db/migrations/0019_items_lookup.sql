-- Загрузка факта инвентаризации из файла остатков iiko: пачечное сопоставление
-- позиций по коду, коду iiko, артикулу, псевдониму и названию.
-- Раздел номенклатуры пересоздаётся целиком — актуальное тело бралось из базы
-- (pg_get_functiondef); хранить в файле «дифф» — верный способ развести код и базу.
-- Диспетчер не трогаем: 'items_lookup_list' попадает в раздел номенклатуры по правилу
-- item% и требует права view по правилу %_list.

create or replace function tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_id    uuid;
  v_code  text;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int;
  v_rows  jsonb;
  v_name  text;
  k       record;   -- себестоимость позиции: (cost, partial, missing)
begin
  -- Себестоимость отдельным действием: карточка товара обходится без пересчёта дерева,
  -- а экран техкарт спрашивает цену ингредиента точечно.
  if action = 'item_cost_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    select * into k from tandem.item_cost(v_code, coalesce(nullif(payload->>'date','')::date, current_date));
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
    if v_id is null then
      insert into tandem.item_groups (name, parent_id, active)
        values (v_name, nullif(payload->>'parent_id','')::uuid, coalesce((payload->>'active')::boolean, true))
        returning id into v_id;
    else
      update tandem.item_groups set name = v_name,
        parent_id = nullif(payload->>'parent_id','')::uuid,
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Группа не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'items_search' then
    select count(*) into v_total from tandem.items i
      where (v_q = '' or i.name ilike '%' || v_q || '%' or i.artikul ilike '%' || v_q || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select i.code, i.name, i.artikul, i.item_type, i.unit_id, i.group_id, g.name as group_name,
             i.active, i.for_sale, i.price
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where (v_q = '' or i.name ilike '%' || v_q || '%' or i.artikul ilike '%' || v_q || '%' or i.code = v_q)
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
          from kv join tandem.item_aliases a on kv.name is not null and a.alias = kv.name
          join tandem.items i on i.code = a.item_code and i.active
        union all
        select kv.i, i.code, i.name, i.unit_id, 'name', 5
          from kv join lateral (
            select i.code, i.name, i.unit_id from tandem.items i
            where kv.name is not null and i.active and lower(i.name) = lower(kv.name)
          ) i on true
          where (select count(*) from tandem.items j where j.active and lower(j.name) = lower(kv.name)) = 1
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
      -- I8: source='office' закрывает строку от повторного переноса из iiko (см. tandem_migrate),
      -- category держится в согласии с группой — на неё смотрят старые экраны точек.
      -- cost_price правится только когда ключ пришёл: пустое значение снимает цену вместе с датой
      -- и источником, иначе учётная цена молча воскресала бы при любой правке карточки.
      update tandem.items set
        name = coalesce(nullif(v_name, ''), name),
        artikul = coalesce(nullif(payload->>'artikul',''), artikul),
        item_type = coalesce(nullif(payload->>'item_type',''), item_type),
        unit_id = coalesce(nullif(payload->>'unit_id',''), unit_id),
        unit = coalesce(nullif(payload->>'unit_id',''), unit),
        group_id = coalesce(nullif(payload->>'group_id','')::uuid, group_id),
        category = coalesce((select g.name from tandem.item_groups g
                             where g.id = coalesce(nullif(payload->>'group_id','')::uuid, items.group_id)),
                            items.category),
        source = 'office',
        active = coalesce((payload->>'active')::boolean, active),
        for_sale = coalesce((payload->>'for_sale')::boolean, for_sale),
        note = coalesce(payload->>'note', note),
        price = coalesce(nullif(payload->>'price','')::numeric, price),
        pack_factor = case when payload ? 'pack_factor' then nullif(payload->>'pack_factor','')::numeric else pack_factor end,
        pack_unit   = case when payload ? 'pack_unit'   then nullif(payload->>'pack_unit','')            else pack_unit end,
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end,
        cost_price  = case when payload ? 'cost_price'  then nullif(payload->>'cost_price','')::numeric  else cost_price end,
        cost_date   = case when payload ? 'cost_price'
                           then case when nullif(payload->>'cost_price','') is null then null else current_date end
                           else cost_date end,
        cost_source = case when payload ? 'cost_price'
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

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- ---------------------------------------------------------------- права (файл самодостаточен)
revoke all on function tandem.office_nomenclature(text,jsonb,tandem.users) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.office_nomenclature(text,jsonb,tandem.users) from anon, authenticated;
  end if;
end $$;
