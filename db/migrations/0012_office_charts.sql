-- Техкарты: раздел бэк-офиса, учётная цена сырья в номенклатуре, уборка теста.
-- Диспетчер, номенклатура и уборка пересоздаются целиком: create or replace требует
-- полного тела, а хранить в файле только «дифф» — верный способ развести код и базу.

-- ---------------------------------------------------------------- раздел «Техкарты»
create or replace function tandem.office_charts(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_code   text := payload->>'code';
  v_id     uuid := nullif(payload->>'id','')::uuid;
  v_date   date := coalesce(nullif(payload->>'date','')::date, current_date);
  v_q      text := btrim(coalesce(payload->>'q',''));
  v_page   int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_only   text := nullif(payload->>'only','');
  v_group  uuid := nullif(payload->>'group_id','')::uuid;
  v_total  int; v_rows jsonb; v_type text; v_from date; v_to date; v_out numeric;
  v_prev   uuid; v_line jsonb; v_ing text; v_ing_type text; v_active boolean;
  v_chart  uuid; v_item jsonb; v_versions jsonb; v_lines jsonb; v_cost record;
  v_csv    text; v_limit numeric;
begin
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
    v_from := nullif(payload->>'date_from','')::date;
    v_to   := nullif(payload->>'date_to','')::date;
    v_out  := nullif(payload->>'output_amount','')::numeric;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала действия'); end if;
    if v_to is not null and v_to < v_from then return tandem.err('validation', 'Дата окончания раньше начала'); end if;
    if v_out is null or v_out <= 0 then return tandem.err('validation', 'Выход должен быть больше нуля'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В карте нет ни одной строки');
    end if;
    -- строки: ингредиент существует, активен, не само блюдо, не ведёт обратно к блюду
    for v_line in select * from jsonb_array_elements(payload->'lines') loop
      v_ing := v_line->>'ingredient_code';
      select item_type, active into v_ing_type, v_active from tandem.items where code = v_ing;
      if v_ing_type is null then return tandem.err('validation', 'Ингредиент не найден: ' || coalesce(v_ing,'')); end if;
      if not v_active then return tandem.err('validation', 'Ингредиент выключен: ' || v_ing); end if;
      if v_ing = v_code then return tandem.err('validation', 'Блюдо не может входить само в себя'); end if;
      if v_ing_type in ('dish','prepared') and tandem.chart_reaches(v_ing, v_code, v_from) then
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
    v_from := nullif(payload->>'date_from','')::date;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала новой версии'); end if;
    v_prev := tandem.active_chart(v_code, v_from - 1);
    if v_prev is null then
      return tandem.err('validation', 'Нет действующей карты, которую можно продолжить — создайте карту обычным сохранением');
    end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from >= v_from) then
      return tandem.err('validation', 'Уже есть версия с более поздней датой начала');
    end if;
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
             coalesce(m.cost::text,''), coalesce(m.price::text,''), coalesce(m.markup_pct::text,''),
             coalesce(m.foodcost_pct::text,''), case when m.over_limit then '1' else '0' end,
             array_to_string(m.missing, ',')), E'\n'), '')
      into v_rows, v_csv
      from tandem.menu_foodcost(nullif(payload->>'point_id',''), v_date, v_group) m;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'limit', v_limit, 'csv', v_csv);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception
  -- charts_no_overlap ловится проверкой выше; сюда доходят только гонки двух правок разом.
  when exclusion_violation then
    return tandem.err('validation', 'На эти даты уже действует другая версия этой карты');
end $$;
revoke all on function tandem.office_charts(text,jsonb,tandem.users) from public;

-- ---------------------------------------------------------------- диспетчер
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
                      or action like '%\_report'
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
  end if;
exception
  -- Minor: кривой uuid/число/boolean в payload — это ошибка ввода, а не сбой базы.
  when invalid_text_representation then
    return tandem.err('validation', 'Неверный формат поля');
end $$;

-- ---------------------------------------------------------------- номенклатура
create or replace function tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem','public' as $$
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

-- ---------------------------------------------------------------- уборка после теста
create or replace function public.tandem_test_cleanup(p_pin text)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_charts int; v_left int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

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
    'counteragents', v_ca, 'users', v_users, 'charts', v_charts), 'leftovers', v_left);
end $$;

-- ---------------------------------------------------------------- права (файл самодостаточен)
revoke all on function tandem.office_charts(text,jsonb,tandem.users) from public;
revoke all on function tandem.office_nomenclature(text,jsonb,tandem.users) from public;
revoke all on function public.tandem_office(text,jsonb) from public;
revoke all on function public.tandem_test_cleanup(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.office_charts(text,jsonb,tandem.users)       from anon, authenticated;
    revoke all on function tandem.office_nomenclature(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function public.tandem_office(text,jsonb)                    from anon, authenticated;
    revoke all on function public.tandem_test_cleanup(text)                    from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb)       to service_role;
    grant execute on function public.tandem_test_cleanup(text)       to service_role;
  end if;
end $$;
