-- Замечания финального ревью: лок на вход, временный PIN на сервере, права функций разделов,
-- sync_items, категория при правке.
--
-- C1  вход: 5 неверных PIN подряд → блокировка логина на 15 минут; сравнение хэша считается
--     всегда, даже когда логина нет, чтобы время ответа не выдавало существование пользователя.
-- I2  пока не сменён временный PIN, из бэк-офиса доступны только me / logout / change_pin.
-- I3  tandem_sync_items заполняет новые колонки (for_sale, unit_id, item_type, group_id).
-- I5  функции разделов больше не SECURITY DEFINER и не доступны PUBLIC/anon/authenticated:
--     их зовёт диспетчер public.tandem_office, который сам SECURITY DEFINER.
-- I6  public.tandem_test_cleanup — уборка следов дымового теста.
-- I7  повторный перенос из iiko не затирает позиции, правленные в бэк-офисе.
-- I8  правка позиции в бэк-офисе метит строку source='office' и держит category в согласии с группой.

-- ---------------------------------------------------------------- C1: счётчик попыток и лок
alter table tandem.users
  add column if not exists failed_attempts int not null default 0,
  add column if not exists locked_until timestamptz;

-- ---------------------------------------------------------------- C1 + I2 + Minor: диспетчер
-- Форма IF/ELSIF в конце сохранена намеренно: RETURN CASE ... END одним SQL-выражением
-- заставляет планировщик резолвить все ветки сразу (см. комментарий в 0005).
create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_token   text := payload->>'token';
  v_user    tandem.users;
  v_pin     text;
  v_hash    text;
  v_calc    text;
  v_ok      boolean;
  v_section text;
  v_need    text;
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
        update tandem.users set
          failed_attempts = failed_attempts + 1,
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
                              else locked_until end
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
    when action like 'group%' or action like 'item%' then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  if v_section = 'nomenclature' then
    return tandem.office_nomenclature(action, payload, v_user);
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

-- ---------------------------------------------------------------- I8: правка метит source='office'
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
begin
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
    return jsonb_build_object('ok', true,
      'item', (select jsonb_build_object('code', i.code, 'name', i.name, 'artikul', i.artikul,
                 'item_type', i.item_type, 'unit_id', i.unit_id, 'group_id', i.group_id,
                 'group_name', g.name, 'active', i.active, 'for_sale', i.for_sale, 'price', i.price,
                 'note', i.note, 'pack_factor', i.pack_factor, 'pack_unit', i.pack_unit,
                 'pack_price', i.pack_price, 'has_chart', i.has_chart, 'iiko_code', i.iiko_code)
               from tandem.items i left join tandem.item_groups g on g.id = i.group_id where i.code = v_code),
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
                   'point_id', p.id, 'point_name', p.name, 'price', pp.price,
                   'rank', r.rank, 'short', coalesce(r.in_short_list, false)) order by p.sort_order), '[]'::jsonb)
                 from tandem.points p
                 left join tandem.item_prices pp on pp.point_id = p.id and pp.item_code = v_code
                 left join tandem.item_rank r on r.point_id = p.id and r.item_code = v_code
                 where p.active));
  end if;

  if action = 'item_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;
    v_code := nullif(payload->>'code','');
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
                                for_sale, note, price, pack_factor, pack_unit, pack_price, category, source)
      values (v_code, v_name, nullif(payload->>'artikul',''), payload->>'item_type', payload->>'unit_id',
              payload->>'unit_id', case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end,
              nullif(payload->>'group_id','')::uuid, coalesce((payload->>'active')::boolean, true),
              coalesce((payload->>'for_sale')::boolean, false), payload->>'note',
              nullif(payload->>'price','')::numeric, nullif(payload->>'pack_factor','')::numeric,
              nullif(payload->>'pack_unit',''), nullif(payload->>'pack_price','')::numeric,
              (select name from tandem.item_groups where id = nullif(payload->>'group_id','')::uuid), 'office');
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
      update tandem.items set
        name = v_name, artikul = coalesce(nullif(payload->>'artikul',''), artikul),
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
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end
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

-- ---------------------------------------------------------------- I7: повторный перенос из iiko
-- upd_id/upd_code трогают только строки, пришедшие из iiko (source in ('iiko_migrate','iiko_api')).
-- Позиция, правленная в бэк-офисе (source='office'), не обновляется и не вставляется заново —
-- она попадает в «пропущено». Цена по upd_id больше не перезаписывается: прайс ведём у себя.
create or replace function public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_total int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
    ),
    upd as (
      update tandem.item_groups g set name = inc.name, active = not inc.deleted, sort_order = inc.sort
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
    -- inc убирает дубли по id, inc2 — дубли по code (в обоих случаях живая строка побеждает
    -- удалённую): без этого две строки одной пачки с одинаковым ключом обе метят в insert
    -- и падают unique_violation'ом сырой ошибкой Postgres вместо {ok:false,...}.
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
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id = inc2.id and i.source in ('iiko_migrate','iiko_api') returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc2.id, name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id is null and i.iiko_code = inc2.code
                  and i.source in ('iiko_migrate','iiko_api') returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc2.code, inc2.name, inc2.artikul, inc2.code, inc2.id, inc2.group_id, inc2.unit, inc2.unit,
             case when inc2.unit in ('кг','л') then 0.5 else 1 end,
             inc2.typ, upper(inc2.typ), inc2.price, not inc2.deleted, false, 'iiko_migrate', now()
      from inc2
      where not exists (select 1 from tandem.items i where i.iiko_id = inc2.id or i.code = inc2.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Дубли ключей в пачке: ' || sqlerrm);
end $$;

-- ---------------------------------------------------------------- I3: sync_items и новые колонки
-- Скрипт tools/iiko-sync-items.mjs — не основной путь (основной — перенос iiko-migrate),
-- но пока он жив, вставляемые им строки обязаны иметь for_sale/unit_id/item_type/group_id,
-- иначе они не видны экранам точек и висят вне дерева групп.
create or replace function public.tandem_sync_items(p_pin text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text;
  v_ins   int := 0;
  v_upd   int := 0;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;

  with incoming as (
    select
      x->>'c'                              as code,
      x->>'n'                              as name,
      nullif(x->>'a','')                   as artikul,
      nullif(x->>'g','')                   as category,
      nullif(x->>'t','')                   as product_type,
      nullif(x->>'u','')                   as unit,
      nullif(x->>'pr','')::numeric         as price,
      coalesce((x->>'ch')::boolean, false) as has_chart
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'c','') <> '' and coalesce(x->>'n','') <> ''
  ),
  upd as (
    update tandem.items i set
      name         = n.name,
      artikul      = coalesce(n.artikul, i.artikul),
      iiko_code    = n.code,
      category     = coalesce(n.category, i.category),
      product_type = n.product_type,
      unit         = coalesce(n.unit, i.unit),
      price        = coalesce(n.price, i.price),
      has_chart    = n.has_chart,
      active       = true,
      source       = 'iiko_api',
      synced_at    = now()
    from incoming n
    where i.code = n.code
    returning 1
  ),
  ins as (
    insert into tandem.items (code, name, artikul, iiko_code, category, product_type,
                              unit, unit_id, item_type, group_id, step, price, has_chart,
                              active, for_sale, source, synced_at)
    select n.code, n.name, n.artikul, n.code, n.category, n.product_type,
           coalesce(n.unit,'шт'),
           case when n.unit in ('шт','кг','л','порц') then n.unit else 'шт' end,
           case n.product_type when 'GOODS' then 'goods' when 'PREPARED' then 'prepared'
                               when 'SERVICE' then 'service' else 'dish' end,
           (select g.id from tandem.item_groups g where g.name = n.category limit 1),
           case when n.unit in ('кг','л') then 0.5 else 1 end,
           n.price, n.has_chart, true, true, 'iiko_api', now()
    from incoming n
    where not exists (select 1 from tandem.items i where i.code = n.code)
    returning 1
  )
  select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  return jsonb_build_object('ok', true, 'updated', v_upd, 'inserted', v_ins);
end $$;

-- ---------------------------------------------------------------- I6: уборка следов дымового теста
-- Защита та же, что у переноса, — код собственника. Шаблоны с экранированным подчёркиванием:
-- в LIKE '_' сам по себе подстановочный, и незащищённый 'ZZ_TEST_%' поймал бы лишнее.
create or replace function public.tandem_test_cleanup(p_pin text)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_left int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

  delete from tandem.item_prices where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  delete from tandem.item_rank where item_code in
    (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');

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
    'counteragents', v_ca, 'users', v_users), 'leftovers', v_left);
end $$;

-- ---------------------------------------------------------------- I5: права функций разделов
-- Функции разделов зовёт только диспетчер public.tandem_office (он SECURITY DEFINER),
-- поэтому собственный SECURITY DEFINER им не нужен, а снаружи их дёргать незачем.
alter function tandem.office_nomenclature(text,jsonb,tandem.users)  security invoker;
alter function tandem.office_stores(text,jsonb,tandem.users)        security invoker;
alter function tandem.office_counteragents(text,jsonb,tandem.users) security invoker;
alter function tandem.office_users(text,jsonb,tandem.users)         security invoker;

revoke all on function
  tandem.office_nomenclature(text,jsonb,tandem.users),
  tandem.office_stores(text,jsonb,tandem.users),
  tandem.office_counteragents(text,jsonb,tandem.users),
  tandem.office_users(text,jsonb,tandem.users),
  tandem.office_session(text),
  tandem.office_can(text,text,text),
  tandem.office_user_json(tandem.users),
  tandem.office_permissions(text),
  tandem.err(text,text)
from public;

-- ---------------------------------------------------------------- I4: права под чужой Postgres
-- Роли anon/authenticated/service_role — выдумка Supabase; на своём сервере их нет,
-- и без обёртки файл там падает. PUBLIC есть везде, поэтому revoke выше — снаружи.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function
      tandem.office_nomenclature(text,jsonb,tandem.users),
      tandem.office_stores(text,jsonb,tandem.users),
      tandem.office_counteragents(text,jsonb,tandem.users),
      tandem.office_users(text,jsonb,tandem.users),
      tandem.office_session(text),
      tandem.office_can(text,text,text),
      tandem.office_user_json(tandem.users),
      tandem.office_permissions(text),
      tandem.err(text,text)
    from anon, authenticated;
  end if;
end $$;

revoke all on function public.tandem_office(text,jsonb) from public;
revoke all on function public.tandem_migrate(text,text,jsonb) from public;
revoke all on function public.tandem_sync_items(text,jsonb) from public;
revoke all on function public.tandem_test_cleanup(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_office(text,jsonb)          from anon, authenticated;
    revoke all on function public.tandem_migrate(text,text,jsonb)    from anon, authenticated;
    revoke all on function public.tandem_sync_items(text,jsonb)      from anon, authenticated;
    revoke all on function public.tandem_test_cleanup(text)          from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb)       to service_role;
    grant execute on function public.tandem_migrate(text,text,jsonb) to service_role;
    grant execute on function public.tandem_sync_items(text,jsonb)   to service_role;
    grant execute on function public.tandem_test_cleanup(text)       to service_role;
  end if;
end $$;
