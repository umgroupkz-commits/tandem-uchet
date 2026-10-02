-- Учебные учётные записи и код обучения (решение владельца 02.10.2026, задание training_server.md).
-- Обучение идёт в рабочей программе: у каждого — интерактивная обучалка (test.html). Все учебные входы
-- (логины и PIN бэк-офиса, коды учебной точки и кассы, учебный код сводки) обучалка показывает после
-- ввода ОДНОГО кода обучения — его задаёт администратор, раздаёт руководитель лично. Учебные учётки
-- защищены сервером: общие справочники и документы настоящих складов они не меняют — ошибка в обучении
-- ничего не портит.
-- 1. Признак training у users, items и points (у складов он есть с 0045); учебные точки — ucheb, ucheb_kassa.
-- 2. Учебная учётка (users.training) в tandem_office: чтение — как у роли; PIN не меняет; документы,
--    «готовым со склада» и заявки — только на учебных складах; новая позиция — можно (она учебная), правка
--    позиции и техкарты — только учебной позиции; всё прочее, что пишет, — отказ (список — tandem.training_guard).
--    Замечания: записать и посмотреть — как у роли, «разобрано» — только у замечаний учебных учёток.
-- 3. office_training_setup / office_training_get (только администратор; гейт ведёт их в tandem.training_office,
--    как office_feedback_*): заводит uch.sklad, uch.buh, uch.tech, uch.owner со случайными PIN, хранит их
--    в settings.training_creds, код обучения — хэшем (training_code_hash), учебный код сводки — training_owner_pin.
-- 4. Гейт: training_info {code} без кода точки — учебные входы по коду обучения; неверный код — неудача
--    со своим ключом 'training' (10 за 5 минут — пауза).
-- 5. Учебный код сводки в tandem_api — как код собственника, но только по учебным точкам; гейт не считает
--    его неудачей (как коды собственника и водителя). Учебные позиции не попадают в меню настоящих точек.
-- 6. users_list отдаёт training, user_save принимает его (только администратор, только если ключ пришёл),
--    у учебной учётки нет временного PIN; код точки не может совпасть с учебным кодом сводки.
-- Тела меняемых функций — из db/schema/tandem_full.sql (снимок после 0047) с точечными правками (метка 0048).
-- Миграция применяется повторно без ошибок.

-- ---------------------------------------------------------------- признак «учебная»
alter table tandem.users  add column if not exists training boolean not null default false;
alter table tandem.items  add column if not exists training boolean not null default false;
alter table tandem.points add column if not exists training boolean not null default false;
comment on column tandem.users.training is
  'Учебная учётная запись (0048): чтение как у роли; пишет только на учебных складах и в учебные позиции; PIN показан в обучалке и не меняется';
comment on column tandem.items.training is
  'Учебная позиция (0048): заведена учебной учётной записью; её карточку и техкарту правят учебные учётки, в меню настоящих точек её нет';
comment on column tandem.points.training is
  'Учебная точка (0048): её код показывается в обучалке, учебный код сводки открывает только такие точки';
update tandem.points set training = true where id in ('ucheb', 'ucheb_kassa') and not training;

-- ---------------------------------------------------------------- помощники
-- Все названные склады учебные (пустые — не в счёт). Склад, которого нет, — не учебный.
create or replace function tandem.training_stores_ok(p_stores uuid[]) returns boolean
language sql stable set search_path to 'tandem', 'public' as $$
  select not exists (select 1 from unnest(coalesce(p_stores, '{}'::uuid[])) x(id)
                      where x.id is not null
                        and not exists (select 1 from tandem.stores s where s.id = x.id and s.training))
$$;

-- План заявок дня общий на все точки: выпуск и документы по нему учебная учётка трогает, только если склад
-- кухни заявок (settings.orders_store_id) и присланный склад кухни учебные, а заявки этого дня — только
-- учебных точек со своими учебными складами (или без склада — такие документы и не создаются).
-- Иначе документы плана заперли бы приём заявок настоящих точек и ушли бы на их склады.
create or replace function tandem.training_orders_ok(p_date date, p_store uuid) returns boolean
language sql stable set search_path to 'tandem', 'public' as $$
  select coalesce((select s.training from tandem.stores s
                    where s.id::text = (select value from tandem.settings where key = 'orders_store_id')), false)
     and tandem.training_stores_ok(array[p_store])
     and not exists (select 1 from tandem.orders o
                       join tandem.points p on p.id = o.point_id
                       left join tandem.stores st on st.id = p.default_store_id
                      where o.for_date = p_date and (not p.training or not coalesce(st.training, true)))
$$;

-- Защита учебной учётной записи: null — можно (дальше права роли и сам раздел), иначе ответ-отказ.
-- p_need — что требует действие ('view' — чтение, как его определяет tandem_office по имени действия).
-- Список разрешённого записан явно; любое другое пишущее действие, в том числе будущее, — отказ.
create or replace function tandem.training_guard(p_action text, p_need text, payload jsonb, p_user tandem.users)
returns jsonb language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_stores constant text := 'Учебная учётная запись работает только с учебными складами';
  v_shared constant text := 'Учебная учётная запись: это действие меняет общие справочники — в обучении его только показывают';
  v_from  uuid;
  v_to    uuid;
  v_have  boolean;   -- документ нашёлся
  v_type  text;
  v_key   text;
  v_store uuid;
  v_code  text;
begin
  if p_need = 'view' then return null; end if;

  -- документы склада: все склады документа учебные — и присланные (как их запишет doc_save), и у
  -- существующего документа (по id или по ключу формы client_key) — прежние
  if p_action = 'doc_save' then
    v_type := payload->>'doc_type';
    if not tandem.training_stores_ok(array[
         case when v_type is distinct from 'invoice_in' then nullif(payload->>'store_from', '')::uuid end,
         case when v_type is null or v_type not in ('writeoff', 'production', 'inventory') then nullif(payload->>'store_to', '')::uuid end]) then
      return tandem.err('forbidden', v_stores); end if;
    v_key := nullif(btrim(coalesce(payload->>'client_key', '')), '');
    if nullif(payload->>'id', '') is not null then
      select store_from, store_to, true into v_from, v_to, v_have from tandem.documents where id = (payload->>'id')::uuid;
    elsif v_key is not null then
      select store_from, store_to, true into v_from, v_to, v_have from tandem.documents where client_key = v_key;
    end if;
    if coalesce(v_have, false) and not tandem.training_stores_ok(array[v_from, v_to]) then
      return tandem.err('forbidden', v_stores); end if;
    return null;
  end if;
  if p_action in ('doc_post', 'doc_unpost', 'doc_delete', 'doc_set_opening') then
    select store_from, store_to, true into v_from, v_to, v_have from tandem.documents where id = nullif(payload->>'id', '')::uuid;
    if coalesce(v_have, false) and not tandem.training_stores_ok(array[v_from, v_to]) then
      return tandem.err('forbidden', v_stores); end if;
    return null;   -- нет документа — ответит раздел
  end if;

  -- «готовым со склада»: только учебный склад
  if p_action in ('stock_ready_save', 'stock_ready_delete') then
    if not tandem.training_stores_ok(array[nullif(payload->>'store_id', '')::uuid]) then
      return tandem.err('forbidden', v_stores); end if;
    return null;
  end if;
  -- Дозапуск пересчёта продаж после правки «готовым» (фронт зовёт его без склада): только если все склады,
  -- до которых он дотянется, учебные — названный склад или все закреплённые за учёткой.
  if p_action = 'stock_ready_resync' then
    v_store := nullif(payload->>'store_id', '')::uuid;
    if v_store is not null then
      if tandem.training_stores_ok(array[v_store]) then return null; end if;
    elsif exists (select 1 from tandem.user_stores where user_id = p_user.id)
          and not exists (select 1 from tandem.user_stores us join tandem.stores s on s.id = us.store_id
                           where us.user_id = p_user.id and not s.training) then
      return null;
    end if;
    return tandem.err('forbidden', v_stores);
  end if;

  -- выпуск по плану и документы по заявкам: склад кухни заявок учебный (см. training_orders_ok)
  if p_action in ('stock_orders_fact_save', 'stock_orders_docs_save') then
    if tandem.training_orders_ok(nullif(payload->>'for_date', '')::date,
         case when p_action = 'stock_orders_docs_save' then nullif(payload->>'store_id', '')::uuid end) then
      return null; end if;
    return tandem.err('forbidden', v_stores);
  end if;

  -- номенклатура: новая позиция — можно (tandem_office пометит её учебной), правка — только учебной
  if p_action = 'item_save' then
    v_code := nullif(payload->>'code', '');
    if v_code is null or not exists (select 1 from tandem.items where code = v_code and not training) then
      return null; end if;
    return tandem.err('forbidden', v_shared);
  end if;
  -- техкарты — только у учебной позиции
  if p_action in ('chart_save', 'chart_new_version') then
    if not exists (select 1 from tandem.items where code = payload->>'code' and not training) then
      return null; end if;
    return tandem.err('forbidden', v_shared);
  end if;
  if p_action = 'chart_delete' then
    select c.item_code into v_code from tandem.charts c where c.id = nullif(payload->>'id', '')::uuid;
    if v_code is null or not exists (select 1 from tandem.items where code = v_code and not training) then
      return null; end if;
    return tandem.err('forbidden', v_shared);
  end if;

  -- Всё остальное пишущее: group_save, item_prices_save, item_prices_import, counteragent_save, store_save,
  -- store_point_save, user_save, user_reset_pin, doc_sales_sync, stock_rebuild, stock_orders_settings_save,
  -- stock_1c_catalog_save, stock_1c_link_save и любое новое действие правки.
  return tandem.err('forbidden', v_shared);
end $$;

-- Шесть случайных цифр (PIN учебных учёток и учебный код сводки).
create or replace function tandem.training_pin6() returns text
language sql volatile set search_path to 'tandem', 'public', 'extensions' as $$
  select lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0')
$$;

-- Учебные входы для обучалки и для администратора. Логин показывается, только пока его учётная запись
-- учебная и включена: снятый признак или выключенный пользователь кодом обучения не открываются.
-- Точки — только отмеченные учебными и включённые.
create or replace function tandem.training_creds() returns jsonb
language plpgsql stable set search_path to 'tandem', 'public' as $$
declare v_c jsonb; v_out jsonb := '{}'::jsonb; k text;
begin
  begin
    v_c := (select value::jsonb from tandem.settings where key = 'training_creds');
  exception when others then v_c := null;
  end;
  foreach k in array array['sklad', 'buh', 'tech', 'owner'] loop
    v_out := v_out || jsonb_build_object(k, (
      select jsonb_build_object('login', u.login, 'pin', v_c->k->>'pin', 'name', u.name, 'role', u.role)
        from tandem.users u
       where u.login = v_c->k->>'login' and u.training and u.active and coalesce(v_c->k->>'pin', '') <> ''));
  end loop;
  return v_out || jsonb_build_object(
    'kassa', (select jsonb_build_object('point', p.id, 'point_name', p.name, 'pin', p.pin)
                from tandem.points p where p.id = 'ucheb_kassa' and p.training and p.active),
    'point', (select jsonb_build_object('point', p.id, 'point_name', p.name, 'pin', p.pin)
                from tandem.points p where p.id = 'ucheb' and p.training and p.active),
    'owner_code', (select value from tandem.settings where key = 'training_owner_pin'));
end $$;

-- office_training_setup / office_training_get (гейт ведёт сюда, как office_feedback_* — в feedback_office).
-- Только администратор (не учебный) и не с временным PIN.
create or replace function tandem.training_office(action text, payload jsonb) returns jsonb
language plpgsql set search_path to 'tandem', 'public', 'extensions' as $$
declare
  v_user    tandem.users;
  v_code    text := btrim(coalesce(payload->>'code', ''));
  v_kitchen uuid; v_spoint uuid; v_skassa uuid; v_all uuid[];
  v_miss    text[] := '{}';
  v_bad     text;
  v_creds   jsonb := '{}'::jsonb;
  a         record;
  v_id      uuid;
  v_pin     text;
begin
  v_user := tandem.office_session(coalesce(payload->>'token', ''));
  if v_user.id is null then return tandem.err('unauthorized', 'Войдите заново'); end if;
  if v_user.must_change_pin then return tandem.err('forbidden', 'Сначала смените временный PIN'); end if;
  if v_user.role <> 'admin' or v_user.training then
    return tandem.err('forbidden', 'Учебные учётные записи настраивает администратор'); end if;

  if action = 'training_get' then
    if not exists (select 1 from tandem.settings where key = 'training_code_hash') then
      return jsonb_build_object('ok', true, 'configured', false); end if;
    return jsonb_build_object('ok', true, 'configured', true, 'creds', tandem.training_creds());
  end if;
  if action is distinct from 'training_setup' then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || coalesce(action, '')); end if;

  -- код обучения: обязателен при первой настройке, потом — только чтобы сменить
  if v_code = '' and not exists (select 1 from tandem.settings where key = 'training_code_hash') then
    return tandem.err('validation', 'Задайте код обучения: от 6 до 32 символов'); end if;
  if v_code <> '' and length(v_code) not between 6 and 32 then
    return tandem.err('validation', 'Код обучения — от 6 до 32 символов'); end if;

  -- учебные склады — по признаку и названию; включённый важнее выключенного
  select id into v_kitchen from tandem.stores
   where training and lower(btrim(name)) = lower('Учебный склад кухни') order by active desc, id limit 1;
  select id into v_spoint from tandem.stores
   where training and lower(btrim(name)) = lower('Учебный склад точки') order by active desc, id limit 1;
  select id into v_skassa from tandem.stores
   where training and lower(btrim(name)) = lower('Учебный склад кассы') order by active desc, id limit 1;
  if v_kitchen is null then v_miss := v_miss || 'Учебный склад кухни'::text; end if;
  if v_spoint is null then v_miss := v_miss || 'Учебный склад точки'::text; end if;
  if v_skassa is null then v_miss := v_miss || 'Учебный склад кассы'::text; end if;
  if cardinality(v_miss) > 0 then
    return tandem.err('validation', 'Нет учебного склада «' || array_to_string(v_miss, '», «')
      || '». Заведите его в разделе «Склады» с отметкой «Учебный склад» и повторите'); end if;
  v_all := array(select id from tandem.stores where training order by name, id);

  -- логин, занятый обычной учётной записью, учебным не становится
  select string_agg(login, ', ' order by login) into v_bad from tandem.users
   where login in ('uch.sklad', 'uch.buh', 'uch.tech', 'uch.owner') and not training;
  if v_bad is not null then
    return tandem.err('validation', 'Логин занят обычной учётной записью: ' || v_bad || ' — переименуйте её и повторите'); end if;

  for a in select * from (values (1, 'sklad', 'uch.sklad', 'Учебный кладовщик', 'storekeeper'),
                                 (2, 'buh',   'uch.buh',   'Учебный бухгалтер', 'accountant'),
                                 (3, 'tech',  'uch.tech',  'Учебный технолог',  'technologist'),
                                 (4, 'owner', 'uch.owner', 'Учебный собственник', 'owner')) x(ord, k, login, name, role)
            order by ord loop
    v_pin := tandem.training_pin6();
    -- новый PIN закрывает прежние сессии учётки (триггер users_pin_sessions), смена роли — тоже
    insert into tandem.users (login, name, role, pin_hash, must_change_pin, active, training)
      values (a.login, a.name, a.role, crypt(v_pin, gen_salt('bf')), false, true, true)
      on conflict (login) do update set name = excluded.name, role = excluded.role, pin_hash = excluded.pin_hash,
        must_change_pin = false, active = true, training = true, failed_attempts = 0, locked_until = null
      returning id into v_id;
    delete from tandem.user_stores where user_id = v_id;
    insert into tandem.user_stores (user_id, store_id)
      select v_id, s from unnest(case a.k when 'sklad' then array[v_kitchen, v_spoint]
                                          when 'tech'  then array[v_kitchen] else v_all end) s
      on conflict do nothing;
    v_creds := v_creds || jsonb_build_object(a.k, jsonb_build_object('login', a.login, 'pin', v_pin, 'name', a.name));
  end loop;
  insert into tandem.settings (key, value) values ('training_creds', v_creds::text)
    on conflict (key) do update set value = excluded.value;
  if v_code <> '' then
    insert into tandem.settings (key, value) values ('training_code_hash', encode(digest(v_code, 'sha256'), 'hex'))
      on conflict (key) do update set value = excluded.value;
  end if;
  -- Учебный код сводки: создаётся один раз; новый — только если совпал с кодом собственника, водителя или точки
  -- (вход по коду сверяет их раньше точки, совпадение открыло бы чужую роль).
  select value into v_pin from tandem.settings where key = 'training_owner_pin';
  if v_pin is null or v_pin !~ '^[0-9]{6}$'
     or v_pin in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'))
     or exists (select 1 from tandem.points where pin = v_pin) then
    loop
      v_pin := tandem.training_pin6();
      exit when v_pin not in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'))
            and not exists (select 1 from tandem.points where pin = v_pin);
    end loop;
    insert into tandem.settings (key, value) values ('training_owner_pin', v_pin)
      on conflict (key) do update set value = excluded.value;
  end if;
  return jsonb_build_object('ok', true, 'configured', true, 'creds', tandem.training_creds());
end $$;

-- Гейт: training_info {code} — учебные входы по коду обучения. Неверный код — неудача со своим ключом
-- 'training' (10 за 5 минут — пауза, как у кода точки); порог по адресу — общий для всех кодов.
create or replace function tandem.training_info(p_code text, p_ip text) returns jsonb
language plpgsql set search_path to 'tandem', 'public', 'extensions' as $$
declare v_hash text; v_code text := btrim(coalesce(p_code, ''));
begin
  if tandem.pin_ip_blocked(p_ip) then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов с этого адреса. Подождите 10 минут', 'code', 'throttled');
  end if;
  if (select count(*) from tandem.pin_failures where key = 'training' and at > now() - interval '5 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Слишком много попыток ввести код обучения. Подождите 5 минут', 'code', 'throttled');
  end if;
  select value into v_hash from tandem.settings where key = 'training_code_hash';
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Обучение не настроено — попросите администратора');
  end if;
  if v_code = '' then
    return jsonb_build_object('ok', false, 'error', 'Код обучения не подошёл');
  end if;
  if encode(digest(v_code, 'sha256'), 'hex') is distinct from v_hash then
    insert into tandem.pin_failures (key, ip) values ('training', p_ip);
    delete from tandem.pin_failures where at < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'error', 'Код обучения не подошёл');
  end if;
  return jsonb_build_object('ok', true, 'creds', tandem.training_creds());
end $$;

-- ---------------------------------------------------------------- гейт (0048: training_info, office_training_*, учебный код сводки)
CREATE OR REPLACE FUNCTION public.tandem_gate(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_pin   text := coalesce(payload->>'pin', '');
  -- IP клиента кладёт Edge Function или прокси своего сервера, перезаписывая присланное клиентом.
  v_ip    text := left(nullif(btrim(coalesce(payload->>'_ip', '')), ''), 64);
  v_key   text;
  v_res   jsonb;
  v_hash  text;
  v_owner text;
  v_service boolean := action in ('migrate','test_cleanup','sync_items','sync_prices','recalc_ranks','set_packaging','set_short_list');
  v_busy  jsonb := jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов. Подождите 5 минут', 'code', 'throttled');
  v_svc_ok   boolean := false;   -- служебное действие с верным ключом
  v_point_ok boolean := false;   -- верный код присланной активной точки
  v_staff    boolean := false;   -- верный код собственника или водителя
  v_train_ok boolean := false;   -- 0048: верный учебный код сводки (training_owner_pin)
begin
  if action like 'office\_%' then
    -- Токен текущей сессии — в настройку транзакции: триггер смены PIN закроет все сессии
    -- пользователя, кроме этой (см. tandem.users_pin_sessions).
    perform set_config('tandem.token', coalesce(payload->>'token', ''), true);
    if action = 'office_login' then
      -- Вход в бэк-офис: у логина свой замок (5 ошибок — 15 минут), сверху — порог по адресу, иначе
      -- перебор шёл бы по многим логинам параллельно и без конца.
      if tandem.pin_ip_blocked(v_ip) then
        return jsonb_build_object('ok', false, 'error', 'throttled', 'code', 'throttled',
                                  'message', 'Слишком много неверных попыток входа с этого адреса. Подождите 10 минут');
      end if;
      v_res := public.tandem_office('login', payload);
      if (v_res->>'ok') = 'false' then
        insert into tandem.pin_failures (key, ip)
          values ('office:' || left(lower(btrim(coalesce(payload->>'login', ''))), 40), v_ip);
        delete from tandem.pin_failures where at < now() - interval '1 day';
      end if;
      return v_res;
    end if;
    -- Замечания тестировщиков (0044): записать может любой вошедший, список и «разобрано» — администратор
    -- и собственник; tandem_office (разделы и права по имени действия) их не знает.
    if action in ('office_feedback_save', 'office_feedback_list', 'office_feedback_done') then
      return tandem.feedback_office(substr(action, 8), payload);
    end if;
    -- 0048: учебные учётные записи настраивает администратор (функция раздела, как у замечаний).
    if action in ('office_training_setup', 'office_training_get') then
      return tandem.training_office(substr(action, 8), payload);
    end if;
    return public.tandem_office(substr(action, 8), payload);
  end if;

  -- Список точек для экрана входа кода не требует и не запирается: иначе чужие ошибки оставили бы
  -- все точки без выбора точки.
  if action = 'points' then
    return public.tandem_api(action, payload);
  end if;

  -- 0048: страница обучения — учебные входы по коду обучения. Кода точки нет, счётчики точек не трогаются:
  -- у кода обучения свой ключ 'training' (10 неверных за 5 минут — пауза), порог по адресу — общий.
  if action = 'training_info' then
    return tandem.training_info(payload->>'code', v_ip);
  end if;

  -- Ключ счётчика — настоящая точка из запроса; всё остальное (вход собственника и водителя,
  -- выдуманные точки) падает в общий ключ «-».
  v_key := case when v_service then 'service'
                else coalesce((select p.id from tandem.points p
                                where p.id = coalesce(nullif(payload->>'point_id',''), nullif(payload->>'point',''))), '-') end;
  -- Что из присланного верно — до порогов: порог по адресу и замок 'master' пропускают верный код точки
  -- и верный служебный ключ, а верный код собственника и водителя не засчитывают неудачей.
  if v_service then
    select value into v_hash from tandem.settings where key = 'service_key_hash';
    v_svc_ok := v_hash is not null and coalesce(payload->>'service_key', '') <> ''
                and encode(digest(payload->>'service_key', 'sha256'), 'hex') = v_hash;
  elsif v_pin <> '' and v_pin not ilike 'CHANGE-ME%' then
    v_point_ok := exists (select 1 from tandem.points p where p.id = v_key and p.pin = v_pin and p.active);
    -- 0048: учебный код сводки — как код собственника: верный неудачей не считается
    v_train_ok := v_pin in (select value from tandem.settings where key = 'training_owner_pin');
    v_staff := v_pin in (select value from tandem.settings where key in ('owner_pin', 'driver_pin')) or v_train_ok;
  end if;
  -- 1) адрес клиента: 30 неверных за 10 минут. Верный служебный ключ и верный код присланной активной
  -- точки проходят: общий адрес (мобильный CGNAT, NAT офиса) не запирает точку и уборку дымового теста.
  -- Остальное — отказ без записи. Общего порога на всю сеть больше нет: он позволял анонимно запереть
  -- все точки, в том числе с верным кодом.
  if not v_svc_ok and not v_point_ok and tandem.pin_ip_blocked(v_ip) then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов с этого адреса. Подождите 10 минут', 'code', 'throttled');
  end if;
  -- 2) ключ запроса: 10 за 5 минут.
  if (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10 then
    return v_busy;
  end if;
  -- 3) 'master' — все неверные коды сети: любой из них мог быть попыткой кода собственника или водителя,
  -- и разнести перебор по ключам точек больше нельзя. Пока он заперт, проходит только верный код
  -- присланной точки: точки работают, а код собственника и водителя получает тот же отказ, что и неверный.
  -- Неверный код точки при этом засчитывается её ключу — иначе замок дал бы перебирать коды точек даром.
  -- Верный код собственника или водителя (раскрытие отчёта точки в уже открытой сводке) неудачей не
  -- считается: иначе обычные клики собственника запирали бы точку и продлевали сам замок.
  if not v_service and not v_point_ok
     and (select count(*) from tandem.pin_failures f where f.key = 'master' and f.at > now() - interval '5 minutes') >= 10 then
    if v_pin <> '' and v_key <> '-' and not v_staff then
      insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    end if;
    return v_busy;
  end if;

  if v_service then
    if not v_svc_ok then
      insert into tandem.pin_failures (key, ip) values ('service', v_ip);
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нужен служебный ключ');
    end if;
    select value into v_owner from tandem.settings where key = 'owner_pin';
    -- Уборка теста снимает и неверные коды служебных точек (см. tandem_test_cleanup): иначе проверка
    -- счётчика запирала бы следующий прогон и вход собственника.
    v_res := case action
      when 'migrate'        then public.tandem_migrate(v_owner, coalesce(payload->>'kind',''), coalesce(payload->'rows','[]'::jsonb))
      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)
      when 'sync_items'     then public.tandem_sync_items(v_owner, coalesce(payload->'items','[]'::jsonb))
      when 'sync_prices'    then public.tandem_sync_prices(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'recalc_ranks'   then public.tandem_recalc_ranks(v_owner, coalesce((payload->>'days')::int, 30))
      when 'set_packaging'  then public.tandem_set_packaging(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'set_short_list' then public.tandem_set_short_list(v_owner, coalesce(payload->>'point',''), coalesce(payload->'codes','[]'::jsonb))
    end;
    return v_res;
  end if;

  -- Пустой код и заглушки из публичного seed ('CHANGE-ME-OWNER', 'CHANGE-ME-DRIVER') не открывают ничего,
  -- даже если в настройках так и остались: при переезде без смены кодов они были бы входом собственником.
  if v_pin = '' or v_pin ilike 'CHANGE-ME%' then
    v_res := jsonb_build_object('ok', false, 'error', case when action = 'login' then 'Неверный код' else 'Нет доступа' end);
  -- 0048: развоз и сопоставления названий импорта — настоящие данные, учебный код сводки их не открывает
  elsif v_train_ok and action in ('realization', 'save_aliases') then
    v_res := jsonb_build_object('ok', false, 'error', 'Учебный код сводки открывает только учебные точки', 'code', 'forbidden');
  else
    v_res := case action
      when 'charts'       then public.tandem_charts(v_pin, coalesce(payload->>'point_id',''))
      when 'realization'  then public.tandem_realization(v_pin, coalesce(payload->>'op','list'), coalesce(payload->'data','{}'::jsonb))
      when 'save_aliases' then public.tandem_save_aliases(v_pin, coalesce(payload->>'point_id',''), coalesce(payload->'data','[]'::jsonb))
      when 'feedback'     then tandem.feedback_point(v_pin, payload)   -- замечание с экрана точки, кассы, заявки (0044)
      else public.tandem_api(action, payload)
    end;
  end if;

  -- Неверный код узнаём по ответу нижележащей функции: их тела не трогаем. Две строки — ключ запроса
  -- и общий 'master' (то же время и адрес: уборка теста снимает их парой).
  -- 0048: верный учебный код сводки неудачей не считается (как код собственника).
  if v_pin <> '' and not v_train_ok and jsonb_typeof(v_res) = 'object' and (v_res->>'ok') = 'false'
     and (v_res->>'error' in ('Неверный код', 'Нет доступа')
          or (v_res->>'error' = 'forbidden' and v_res->>'message' = 'Нет доступа')) then
    insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    delete from tandem.pin_failures where at < now() - interval '1 day';
  end if;
  return v_res;
end $function$
;

-- ---------------------------------------------------------------- бэк-офис: защита учебной учётной записи (0048)
CREATE OR REPLACE FUNCTION public.tandem_office(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
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
  v_con      text;
  v_res      jsonb;   -- 0048: отказ защиты учебной учётки / ответ номенклатуры
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;

    -- crypt считается всегда, отдельными операторами: если сложить всё в одно
    -- выражение, Postgres вправе оборвать вычисление на первом false, и ответ
    -- «такого логина нет» вернётся заметно быстрее ответа «неверный PIN».
    -- Хэш-заглушка — обычный bcrypt-хэш от произвольной строки, не секрет:
    -- он нужен только чтобы crypt было над чем работать.
    v_hash := coalesce(v_user.pin_hash, '$2a$06$nok4o3iwBUM19xMpLFJzoeTS1iAyq43SB1ybN/Yq5Zt2PyGfXmZF6');
    v_calc := crypt(v_pin, v_hash);
    v_ok   := v_user.id is not null and v_calc = v_user.pin_hash;

    -- Пока логин заблокирован, ответ один и тот же при любом PIN — и тот же, что при обычной
    -- ошибке. Отдельный ответ на верный PIN (так было в 0021) давал перебору подсказку:
    -- блокировка не мешала узнать PIN по тексту ответа. Отдельный ответ «заблокирован»
    -- подтверждал бы существование логина. Поэтому про блокировку сказано в самом тексте ошибки.
    if v_user.id is not null and v_user.locked_until > now() then
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
    end if;

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
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN. После пяти ошибок подряд вход закрывается на 15 минут');
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
    -- 0048: PIN учебной учётки показан в обучалке всем, кто учится: сменить его — запереть остальных
    if v_user.training then
      return tandem.err('forbidden', 'У учебной учётной записи PIN не меняется: он показан в обучалке');
    end if;
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
      return tandem.err('validation', 'PIN — не меньше 4 цифр');
    end if;
    if v_user.role in ('admin', 'owner') and length(v_pin) < 6 then
      return tandem.err('validation', 'PIN администратора и собственника — не меньше 6 цифр');
    end if;
    -- Текущий PIN спрашивается всегда, кроме первого входа с временным: оставленная открытой сессия
    -- или утёкший токен не должны уводить учётную запись навсегда. Подбор текущего PIN через сессию
    -- ограничен как вход: пять ошибок подряд — вход закрыт на 15 минут, все сессии пользователя закрыты.
    if not v_user.must_change_pin then
      if coalesce(payload->>'old_pin', '') = '' then
        return tandem.err('validation', 'Введите текущий PIN');
      end if;
      if crypt(payload->>'old_pin', v_user.pin_hash) <> v_user.pin_hash then
        -- Счёт — как у входа (храповик): после истёкшего замка начинается заново. Иначе посторонний,
        -- зная логин, «заряжал» бы счётчик неверными входами, и первая же опечатка владельца сессии
        -- запирала бы его и закрывала все сессии.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set failed_attempts = v_attempts,
               locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
         where id = v_user.id;
        if v_attempts >= 5 then
          delete from tandem.sessions where user_id = v_user.id;
        end if;
        perform pg_sleep(0.3);
        return tandem.err('validation', 'Неверный текущий PIN');
      end if;
    end if;
    -- Текущую сессию не закрываем: остальные закроет триггер tandem.users_pin_sessions.
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = false,
           failed_attempts = 0, locked_until = null
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
  -- 0048: учебная учётка поверх прав роли: чтение — как у роли, писать — только на учебных складах и в
  -- учебные позиции (список — tandem.training_guard).
  if v_user.training then
    v_res := tandem.training_guard(action, v_need, payload, v_user);
    if v_res is not null then return v_res; end if;
  end if;

  if v_section = 'nomenclature' then
    v_res := tandem.office_nomenclature(action, payload, v_user);
    -- 0048: позиция, заведённая учебной учёткой, — учебная: её правят учебные учётки, меню настоящих точек её не видит
    if v_user.training and action = 'item_save' and nullif(payload->>'code', '') is null
       and coalesce((v_res->>'ok')::boolean, false) then
      update tandem.items set training = true where code = v_res->>'code';
    end if;
    return v_res;
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
  -- Чужой лок не дождались (lock_timeout) или сработал statement_timeout прокси: пересчёт продаж по складу
  -- (stock_ready_*, doc_sales_sync) ещё идёт в другом запросе. Всё сделанное этим вызовом откатилось.
  -- query_canceled не входит в others — перехватывается только по имени.
  when lock_not_available or query_canceled then
    return tandem.err('validation', 'Пересчёт по этому складу уже идёт — подождите и обновите список');
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
  -- Несуществующая дата в верном формате (2026-02-31) — тоже ошибка ввода, не 500.
  when datetime_field_overflow then
    return tandem.err('validation', 'Такой даты нет — проверьте число и месяц');
  -- Отрицательное количество, причина не из списка и прочие ограничения таблиц: всё откатывается,
  -- человек видит, что исправить, вместо пустой ошибки «база данных».
  when check_violation then
    get stacked diagnostics v_con = constraint_name;
    return tandem.err('validation', case
      when v_con in ('document_lines_qty_check', 'order_lines_qty_check') then 'Количество не может быть отрицательным'
      when v_con = 'order_plan_fact_qty_check' then 'Выпуск не может быть отрицательным'
      when v_con = 'documents_reason_check' then 'Причина списания не из списка'
      when v_con = 'documents_stores_by_type' then 'Склады не подходят к типу документа'
      when v_con like 'chart\_lines\_%' then 'Брутто, нетто и выход не могут быть отрицательными'
      when v_con = 'charts_output_amount_check' then 'Выход блюда должен быть больше нуля'
      when v_con = 'charts_dates' then 'Дата окончания раньше даты начала'
      when v_con = 'items_item_type_check' then 'Тип позиции не из списка'
      when v_con = 'counteragents_kind_check' then 'Вид контрагента не из списка'
      else 'Недопустимое значение поля' end);
  when numeric_value_out_of_range then
    return tandem.err('validation', 'Слишком большое число');
end $function$
;

-- ---------------------------------------------------------------- замечания: «разобрано» у учебной учётки (0048)
CREATE OR REPLACE FUNCTION tandem.feedback_office(action text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare v_user tandem.users; v_src text := coalesce(payload->>'source', 'office');
begin
  v_user := tandem.office_session(coalesce(payload->>'token', ''));
  if v_user.id is null then return tandem.err('unauthorized', 'Войдите заново'); end if;
  if action = 'feedback_save' then
    return tandem.feedback_add(case when v_src = 'stock' then 'stock' else 'office' end,
                               v_user.login || ' (' || v_user.name || ')', v_user.role, payload);
  end if;
  if v_user.role not in ('admin', 'owner') then return tandem.err('forbidden', 'Замечания разбирают администратор и собственник'); end if;
  if action = 'feedback_list' then
    return jsonb_build_object('ok', true,
      'new', (select count(*) from tandem.feedback where status = 'new'),
      'rows', (select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at desc), '[]'::jsonb)
                 from (select id, created_at, source, author, role, page, message, context, status, done_at, done_by, answer
                         from tandem.feedback
                        where (nullif(payload->>'status', '') is null or status = payload->>'status')
                        order by created_at desc limit 300) f));
  end if;
  if action = 'feedback_done' then
    -- 0048: учебная учётка разбирает только замечания учебных учёток (автор — «login (имя)»): настоящие
    -- замечания тестировщиков в обучении не закрываются
    if v_user.training
       and exists (select 1 from tandem.feedback f where f.id = nullif(payload->>'id', '')::bigint)
       and not exists (select 1 from tandem.feedback f join tandem.users u on u.training
                               and left(f.author, length(u.login) + 2) = u.login || ' ('
                        where f.id = nullif(payload->>'id', '')::bigint and f.source in ('office', 'stock')) then
      return tandem.err('forbidden', 'Учебная учётная запись разбирает только замечания учебных учётных записей');
    end if;
    update tandem.feedback set status = case when coalesce((payload->>'done')::boolean, true) then 'done' else 'new' end,
           done_at = case when coalesce((payload->>'done')::boolean, true) then now() end,
           done_by = case when coalesce((payload->>'done')::boolean, true) then v_user.login end,
           answer = coalesce(left(nullif(btrim(coalesce(payload->>'answer', '')), ''), 2000), answer)
     where id = nullif(payload->>'id', '')::bigint;
    if not found then return tandem.err('not_found', 'Замечание не найдено'); end if;
    return jsonb_build_object('ok', true);
  end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
exception when invalid_text_representation then
  return tandem.err('validation', 'Неверный номер замечания');
end $function$
;

-- ---------------------------------------------------------------- замечание по учебному коду сводки (0048)
CREATE OR REPLACE FUNCTION tandem.feedback_point(p_pin text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare v_point record; v_owner text; v_driver text; v_src text := coalesce(payload->>'source', 'point');
  v_train text;   -- 0048: учебный код сводки
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  select value into v_driver from tandem.settings where key = 'driver_pin';
  select value into v_train from tandem.settings where key = 'training_owner_pin';
  if v_src not in ('kassa', 'point', 'order', 'owner', 'driver') then v_src := 'point'; end if;
  if p_pin <> '' and p_pin = v_owner then
    return tandem.feedback_add(case when v_src in ('kassa', 'point', 'order') then v_src else 'owner' end, 'собственник', 'owner', payload);
  end if;
  if p_pin <> '' and p_pin = v_driver then return tandem.feedback_add('driver', 'водитель', 'driver', payload); end if;
  -- 0048: замечание из учебной сводки — как от собственника, с пометкой «учебный»
  if p_pin <> '' and p_pin = v_train then
    return tandem.feedback_add(case when v_src in ('kassa', 'point', 'order') then v_src else 'owner' end, 'учебный собственник', 'owner', payload);
  end if;
  select id, name into v_point from tandem.points where id = payload->>'point_id' and pin = p_pin and active;
  if v_point.id is null then return jsonb_build_object('ok', false, 'error', 'Нет доступа'); end if;
  return tandem.feedback_add(case when v_src in ('kassa', 'point', 'order') then v_src else 'point' end,
                             v_point.name, 'point:' || v_point.id, payload);
end $function$
;

-- ---------------------------------------------------------------- пользователи: признак training (0048)
CREATE OR REPLACE FUNCTION tandem.office_users(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public', 'extensions'
AS $function$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
  v_train boolean;   -- 0048: признак учебной учётной записи (null — ключа нет, не меняется)
begin
  if action = 'users_list' then
    -- store_ids — все привязки, в том числе к выключенным складам: форма показывает их и отправляет обратно.
    -- 0048: training — учебная учётная запись (метка «учебная» в списке).
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at, 'training', training,
                  'store_ids', tandem.user_store_ids(id))
                  order by active desc, name), '[]'::jsonb) from tandem.users),
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'),
      -- U: может ли смотрящий заводить и менять администраторов (форма прячет роль «admin» и кнопки)
      'can_manage_admins', v_user.role = 'admin');
  end if;

  if action = 'user_save' then
    v_login := lower(btrim(coalesce(payload->>'login','')));
    v_name  := btrim(coalesce(payload->>'name',''));
    v_role  := coalesce(payload->>'role','');
    v_pin   := nullif(payload->>'pin','');
    if v_login !~ '^[a-z0-9_.-]{2,32}$' then return tandem.err('validation', 'Логин: 2–32 латинских буквы, цифры, _ . -'); end if;
    if v_name = '' then return tandem.err('validation', 'Имя пустое'); end if;
    if v_role not in ('admin','owner','accountant','technologist','storekeeper') then
      return tandem.err('validation', 'Роль не из списка');
    end if;
    -- U (owner9): раздел «Пользователи» теперь и у собственника — заводить сотрудников и сбрасывать им PIN.
    -- Администратора он не создаёт (и не делает им никого, в том числе себя), а чужую учётную запись
    -- администратора не меняет и не выключает: иначе право на раздел стало бы правом на всю систему.
    if v_user.role <> 'admin'
       and (v_role = 'admin'
            or exists (select 1 from tandem.users where id = nullif(payload->>'id','')::uuid and role = 'admin')) then
      return tandem.err('forbidden', 'Учётные записи администратора меняет только администратор');
    end if;
    -- 0048: признак учебной учётки ставит и снимает только администратор, и только если ключ пришёл.
    -- У учебной учётки нет временного PIN: сменить его она не может, PIN показан в обучалке.
    if payload ? 'training' then
      if v_user.role <> 'admin' then
        return tandem.err('forbidden', 'Учебную учётную запись отмечает только администратор');
      end if;
      v_train := nullif(payload->>'training', '')::boolean;
    end if;
    -- Склады пользователя меняются, только если ключ пришёл: пустой массив снимает привязку (все склады).
    -- Проверяются до записи: отказ после сохранения оставлял пользователя созданным, а повтор упирался
    -- в «Такой логин уже есть».
    if payload ? 'store_ids' then
      if jsonb_typeof(payload->'store_ids') is distinct from 'array' then
        return tandem.err('validation', 'Склады — списком'); end if;
      if exists (select 1 from jsonb_array_elements_text(payload->'store_ids') x
                  where not exists (select 1 from tandem.stores s where s.id::text = lower(btrim(x)))) then
        return tandem.err('validation', 'Склад не найден — обновите страницу'); end if;
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if exists (select 1 from tandem.users where login = v_login and (v_id is null or id <> v_id)) then
      return tandem.err('validation', 'Такой логин уже есть');
    end if;
    if v_id is null then
      if v_pin is null or length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
        return tandem.err('validation', 'PIN — не меньше 4 цифр');
      end if;
      insert into tandem.users (login, name, role, pin_hash, must_change_pin, active, training)
        values (v_login, v_name, v_role, crypt(v_pin, gen_salt('bf')), not coalesce(v_train, false),
                coalesce((payload->>'active')::boolean, true), coalesce(v_train, false)) returning id into v_id;
    else
      if v_id = v_user.id and coalesce((payload->>'active')::boolean, true) = false then
        return tandem.err('validation', 'Нельзя выключить самого себя');
      end if;
      if exists (select 1 from tandem.users where id = v_id and role = 'admin' and active)
        and (v_role <> 'admin' or coalesce((payload->>'active')::boolean, true) = false)
        and not exists (select 1 from tandem.users where role = 'admin' and active and id <> v_id)
      then
        return tandem.err('validation', 'Нельзя оставить систему без администратора');
      end if;
      update tandem.users set login = v_login, name = v_name, role = v_role,
        active = coalesce((payload->>'active')::boolean, active),
        training = coalesce(v_train, training),
        must_change_pin = case when v_train then false else must_change_pin end where id = v_id;
      if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
      if not coalesce((payload->>'active')::boolean, true) then
        delete from tandem.sessions where user_id = v_id;
      end if;
    end if;
    if payload ? 'store_ids' then
      delete from tandem.user_stores where user_id = v_id;
      insert into tandem.user_stores (user_id, store_id)
        select v_id, lower(btrim(x))::uuid from jsonb_array_elements_text(payload->'store_ids') x
        on conflict do nothing;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    -- U: сбросить PIN администратору — значит войти под ним; это может только администратор
    if v_user.role <> 'admin' and exists (select 1 from tandem.users where id = v_id and role = 'admin') then
      return tandem.err('forbidden', 'Учётные записи администратора меняет только администратор');
    end if;
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    -- 0048: учебной учётке временный PIN не ставится (сменить его она не может), а новый PIN сразу
    -- показывается в обучалке
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = not training,
      failed_attempts = 0, locked_until = null where id = v_id
      returning login, training into v_login, v_train;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    if v_train then
      update tandem.settings set value = coalesce((
          select jsonb_object_agg(e.k, case when e.v->>'login' = v_login then e.v || jsonb_build_object('pin', v_pin) else e.v end)
            from jsonb_each(value::jsonb) e(k, v)), value::jsonb)::text
       where key = 'training_creds';
    end if;
    return jsonb_build_object('ok', true, 'training', v_train);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

-- ---------------------------------------------------------------- точки: код не совпадает с учебным кодом сводки (0048)
CREATE OR REPLACE FUNCTION tandem.office_stores(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id uuid; v_name text; v_point text; v_train boolean; v_was boolean; v_restored jsonb := '[]'::jsonb;
begin
  if action = 'stores_list' then
    return jsonb_build_object('ok', true,
      'stores', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'point_id', s.point_id, 'point_name', p.name,
          'is_default', (p.default_store_id = s.id), 'active', s.active, 'training', s.training,
          'organization_id', s.organization_id) order by s.active desc, p.sort_order nulls last, s.name), '[]'::jsonb)
        from tandem.stores s left join tandem.points p on p.id = s.point_id),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order), '[]'::jsonb)
        from tandem.points where active));
  end if;

  if action = 'store_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название склада пустое'); end if;
    v_point := nullif(payload->>'point_id','');
    if v_point is not null and not exists (select 1 from tandem.points where id = v_point) then
      return tandem.err('validation', 'Точка не найдена');
    end if;
    v_train := nullif(payload->>'training', '')::boolean;   -- null — ключа нет: признак не меняется
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.stores (name, point_id, active, training)
        values (v_name, v_point, coalesce((payload->>'active')::boolean, true), coalesce(v_train, false)) returning id into v_id;
    else
      select training into v_was from tandem.stores where id = v_id for update;
      update tandem.stores set name = v_name, point_id = v_point,
        active = coalesce((payload->>'active')::boolean, active),
        training = coalesce(v_train, training) where id = v_id;
      if not found then return tandem.err('not_found', 'Склад не найден'); end if;
      -- отвязанный или выключенный склад не может быть складом по умолчанию
      update tandem.points set default_store_id = null
        where default_store_id = v_id and (v_point is null or id <> v_point or not coalesce((payload->>'active')::boolean, true));
      -- склад стал учебным: цены, которые успели поставить его приходы, — назад
      if v_train and not v_was then v_restored := tandem.training_cost_restore(null); end if;
    end if;
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null
       and exists (select 1 from tandem.stores where id = v_id and active) then
      update tandem.points set default_store_id = v_id where id = v_point;
    elsif payload ? 'is_default' and not (payload->>'is_default')::boolean then
      update tandem.points set default_store_id = null where default_store_id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id, 'training', (select training from tandem.stores where id = v_id),
                              'costs_restored', v_restored);
  end if;

  -- Точки продаж: режим экрана точки, код входа, юрлицо, группы меню. Служебные точки теста (zz_*)
  -- не показываются и не правятся. Код точки не отдаётся — только признак «задан»; новый код задаётся явно.
  if action = 'store_points_list' then
    return jsonb_build_object('ok', true,
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'mode', p.mode, 'legal_entity', p.legal_entity, 'active', p.active,
          'sort_order', p.sort_order, 'item_categories', coalesce(to_jsonb(p.item_categories), '[]'::jsonb),
          'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '') order by p.sort_order, p.name), '[]'::jsonb)
        from tandem.points p left join tandem.stores s on s.id = p.default_store_id
       where p.id not like 'zz\_%'),
      'categories', (select coalesce(jsonb_agg(c order by c), '[]'::jsonb)
        from (select distinct category c from tandem.items where active and for_sale and category is not null) x),
      'legal_entities', (select coalesce(jsonb_agg(distinct legal_entity), '[]'::jsonb) from tandem.points where legal_entity is not null));
  end if;

  if action = 'store_point_save' then
    v_point := btrim(coalesce(payload->>'id', ''));
    v_name := btrim(coalesce(payload->>'name', ''));
    if v_point = '' or v_point like 'zz\_%' then return tandem.err('validation', 'Не указана точка'); end if;
    if v_name = '' then return tandem.err('validation', 'Название точки обязательно'); end if;
    if coalesce(payload->>'mode', '') not in ('position', 'takeout', 'import', 'manual', 'checks') then
      return tandem.err('validation', 'Неизвестный режим точки'); end if;
    if nullif(payload->>'pin', '') is not null then
      if payload->>'pin' !~ '^[0-9]{4,8}$' then
        return tandem.err('validation', 'Код точки — от 4 до 8 цифр'); end if;
      -- Вход на экран точки сначала сверяет код собственника и водителя: совпадение с ними открыло бы
      -- чужую роль. Совпадение с кодом другой точки путает людей.
      -- 0048: и с учебным кодом сводки — он сверяется раньше кода точки.
      if payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin', 'training_owner_pin'))
         or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point) then
        return tandem.err('validation', 'Этот код уже занят — придумайте другой'); end if;
    end if;
    -- Перевод в «касса» посреди дня: первый чек пересобрал бы деньги и продажи дня из чеков и стёр
    -- уже сданный отчёт. Если сегодня (по местной дате) отчёт с данными уже есть и он не из чеков —
    -- режим меняют завтра.
    if payload->>'mode' = 'checks'
       and exists (select 1 from tandem.points where id = v_point and mode <> 'checks')
       and exists (select 1 from tandem.daily_reports d
                    where d.point_id = v_point and d.report_date = tandem.local_now()::date
                      and (d.cash <> 0 or d.kaspi_qr <> 0 or d.transfer <> 0 or d.card <> 0
                           or exists (select 1 from tandem.sale_lines s where s.report_id = d.id)
                           or exists (select 1 from tandem.takeout_lines t where t.report_id = d.id)
                           or exists (select 1 from tandem.cash_expenses e where e.report_id = d.id)))
       and not exists (select 1 from tandem.checks c where c.point_id = v_point and c.check_date = tandem.local_now()::date) then
      return tandem.err('validation', 'Сегодня у точки уже есть отчёт — переключите режим завтра');
    end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then
        return tandem.err('validation', 'Код новой точки — латиница, цифры и подчёркивание, например eneshka2'); end if;
      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
      insert into tandem.points (id, name, mode, pin, legal_entity, active, sort_order)
        values (v_point, v_name, payload->>'mode', payload->>'pin', nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
                coalesce((payload->>'active')::boolean, true), coalesce((select max(sort_order) from tandem.points where id not like 'zz\_%'), 0) + 10);
    end if;
    update tandem.points set name = v_name, mode = payload->>'mode',
           legal_entity = nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
           active = coalesce((payload->>'active')::boolean, active),
           item_categories = case when jsonb_typeof(payload->'item_categories') = 'array'
                                  then array(select jsonb_array_elements_text(payload->'item_categories')) else item_categories end,
           pin = coalesce(nullif(payload->>'pin', ''), pin)
     where id = v_point;
    return jsonb_build_object('ok', true, 'id', v_point);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $function$
;

-- ---------------------------------------------------------------- экран точки и сводка: учебный код сводки (0048)
CREATE OR REPLACE FUNCTION public.tandem_api(action text, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
 SET jit TO 'off'
AS $function$
declare
  v_pin        text := coalesce(payload->>'pin','');
  v_point      text := payload->>'point_id';
  v_date       date;
  v_owner_pin  text;
  v_driver_pin text;
  v_id         bigint;
  v_res        jsonb;
  v_scopes     text[];
  v_cats       text[];
  v_q          text := btrim(coalesce(payload->>'q',''));
  v_from       date;
  v_to         date;
  v_today      date := tandem.local_now()::date;   -- местная дата (UTC+5): «сегодня» и «вчера» точек и сводки
  v_exp        jsonb;
  v_tko        jsonb;
  v_sal        jsonb;
  v_lbl        text;
  v_val        text;
  v_prev_id    bigint;        -- save_report: строка отчёта до сохранения
  v_prev_first timestamptz;   -- save_report: первая сдача до этого сохранения
  v_before     jsonb;         -- save_report: содержимое отчёта до сохранения
  v_own        boolean;       -- items: у точки загружены свои цены (K2)
  v_train      boolean;       -- 0048: учебный код сводки (settings.training_owner_pin)
  v_tp         text[];        -- 0048: учебные точки (points.training) — всё, что открывает учебный код сводки
begin
  select value into v_owner_pin  from tandem.settings where key = 'owner_pin';
  select value into v_driver_pin from tandem.settings where key = 'driver_pin';
  -- 0048: учебный код сводки работает как код собственника, но только по учебным точкам: в ответах нет
  -- настоящих точек, их отчёты, смены и заявки ему закрыты.
  v_train := coalesce(v_pin <> '' and v_pin = (select value from tandem.settings where key = 'training_owner_pin')
                      and v_pin is distinct from v_owner_pin and v_pin is distinct from v_driver_pin, false);
  if v_train then v_tp := array(select id from tandem.points where training); end if;

  if action = 'points' then
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', id, 'name', name, 'mode', mode, 'legal_entity', legal_entity) order by sort_order), '[]'::jsonb)
            from tandem.points where active);
  end if;

  if action = 'login' then
    if v_pin = v_owner_pin then
      return jsonb_build_object('ok', true, 'role', 'owner');
    end if;
    if v_pin = v_driver_pin then
      return jsonb_build_object('ok', true, 'role', 'driver');
    end if;
    if v_train then
      return jsonb_build_object('ok', true, 'role', 'owner', 'training', true);
    end if;
    if exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', true, 'role', 'point',
        'point', (select jsonb_build_object('id',id,'name',name,'mode',mode)
                  from tandem.points where id = v_point));
    end if;
    return jsonb_build_object('ok', false, 'error', 'Неверный код');
  end if;

  if action in ('items','get_report','save_report','aliases','check_save','check_void','check_list','order_get','order_save') then
    -- 0048: учебный код сводки — только учебные точки
    if v_train and not coalesce(v_point = any(v_tp), false) then
      return jsonb_build_object('ok', false, 'error', 'Учебный код сводки открывает только учебные точки', 'code', 'forbidden');
    end if;
    if v_pin is distinct from v_owner_pin and not v_train
       and not exists (select 1 from tandem.points where id = v_point and pin = v_pin and active) then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
  end if;

  if action = 'items' then
    select item_scopes, item_categories into v_scopes, v_cats
      from tandem.points where id = v_point;
    -- K2 (admin 2): у точки со своими ценами (загружен прейскурант — есть хоть одна строка item_prices)
    -- позиция без своей цены идёт с price = null — касса и экран точки пишут «цена не задана». Цена по
    -- умолчанию из номенклатуры там часто себестоимость из iiko («Блин с творогом фабрика 40,58 ₸»).
    -- У точки без своих цен — по-прежнему цена по умолчанию.
    v_own := exists (select 1 from tandem.item_prices where point_id = v_point);
    return jsonb_build_object('ok', true, 'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', code, 'name', name, 'category', category, 'unit', unit,
        'price', price, 'artikul', artikul, 'iiko_code', iiko_code,
        'rank', rank, 'short', short, 'has_chart', has_chart,
        'pack_factor', pack_factor, 'pack_unit', pack_unit, 'pack_price', pack_price)
        order by category, name), '[]'::jsonb)
      from (
        select i.code, i.name, i.category, i.unit,
               case when v_own then pp.price else coalesce(pp.price, i.price) end as price,
               i.artikul, i.iiko_code, r.rank,
               coalesce(r.in_short_list,false) as short,
               coalesce(i.has_chart,false)     as has_chart,
               i.pack_factor, i.pack_unit, i.pack_price
        from tandem.items i
        left join tandem.item_rank   r  on r.item_code  = i.code and r.point_id  = v_point
        left join tandem.item_prices pp on pp.item_code = i.code and pp.point_id = v_point
        where i.active and i.for_sale
          -- 0048: учебные позиции (заведены учебными учётками) — только в меню учебных точек
          and (not i.training or exists (select 1 from tandem.points tp where tp.id = v_point and tp.training))
          and (
            case
              when v_cats is not null and cardinality(v_cats) > 0 then i.category = any(v_cats)
              when v_scopes is null or cardinality(v_scopes) = 0 then true
              else i.point_hint = any(v_scopes)
            end
          )
          and (v_q = '' or i.name ilike '%' || v_q || '%')
        order by i.category, i.name
        limit 5000   -- было 1200: у Актау после включения штучных товаров 1231 позиция, хвост списка пропадал
      ) s));
  end if;

  -- Карта соответствий для импорта: названия чужой программы → код номенклатуры.
  if action = 'aliases' then
    return jsonb_build_object('ok', true, 'aliases', (
      select coalesce(jsonb_object_agg(alias, item_code), '{}'::jsonb) from tandem.item_aliases));
  end if;

  if action = 'get_report' then
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    select to_jsonb(v) into v_res from tandem.v_daily v
      where v.point_id = v_point and v.report_date = v_date;
    if v_res is null then
      return jsonb_build_object('ok', true, 'report', null, 'expenses','[]'::jsonb,
                                'takeout','[]'::jsonb, 'sales','[]'::jsonb, 'voids','[]'::jsonb);
    end if;
    select id into v_id from tandem.daily_reports
      where point_id = v_point and report_date = v_date;
    -- P/Д1, K1: чеки после закрытия смены (late_checks, late_sum, late_cash, late_kaspi, late_card,
    -- late_transfer) и отметка правки отчёта (edited_at) — экран закрытия смены считает «должно» на момент
    -- закрытия и показывает «после закрытия пробито N чеков — закройте смену заново»
    v_res := v_res || coalesce(tandem.report_marks(v_id), '{}'::jsonb);
    return jsonb_build_object('ok', true, 'report', v_res,
      'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
          'purpose',purpose,'amount',amount,'receipt_no',receipt_no) order by id),'[]'::jsonb)
        from tandem.cash_expenses where report_id = v_id),
      'takeout', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'unit',unit,
          'issued',issued,'returned',returned,'price',price) order by id),'[]'::jsonb)
        from tandem.takeout_lines where report_id = v_id),
      'sales', (select coalesce(jsonb_agg(jsonb_build_object(
          'item_code',item_code,'item_name',item_name,'qty',qty,
          'price',price,'price_list',price_list) order by id),'[]'::jsonb)
        from tandem.sale_lines where report_id = v_id),
      -- Отменённые и исправленные чеки дня (касса): кто, когда, на сколько и почему. first_total и
      -- first_pay_kind — как чек был пробит впервые (было → стало); edited — правили ли и отменённый чек.
      'voids', (select coalesce(jsonb_agg(jsonb_build_object(
          'kind', case when c.status = 'void' then 'void' else 'edited' end, 'no', c.no, 'total', c.total,
          'pay_kind', c.pay_kind, 'first_total', coalesce(c.first_total, c.total),
          'first_pay_kind', coalesce(c.first_pay_kind, c.pay_kind), 'edited', c.edited,
          'reason', c.void_reason, 'seller', c.seller, 'at', c.updated_at)
          order by c.updated_at desc), '[]'::jsonb)
        from tandem.checks c
        where c.point_id = v_point and c.check_date = v_date and (c.status = 'void' or c.edited)));
  end if;

  if action = 'save_report' then
    -- Всё, что может отказать, проверяется до записи; ни одно присланное поле не роняет функцию исключением.
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Не указана дата отчёта'); end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      return jsonb_build_object('ok', false, 'error', 'Не указана точка'); end if;
    v_exp := tandem.jlist(payload->'expenses');
    v_tko := tandem.jlist(payload->'takeout');
    v_sal := tandem.jlist(payload->'sales');
    if v_exp is null or v_tko is null or v_sal is null then
      return jsonb_build_object('ok', false, 'error', 'Неверный формат отчёта: расходы, заборный лист и продажи — списками'); end if;

    -- Числа: пробелы и запятая — как на экране точки (num()), мусор — отказ с именем поля.
    select f.label, f.val into v_lbl, v_val from (
      select 0 as g, v.n::bigint as ord, v.label, v.val from (values
        (1, 'Наличные'::text, payload->>'cash'), (2, 'Kaspi QR', payload->>'kaspi_qr'),
        (3, 'Перевод на счёт', payload->>'transfer'), (4, 'Карта через терминал', payload->>'card'),
        (5, 'QR по выписке', payload->>'qr_statement'), (6, 'Переводы по выписке', payload->>'tr_statement'),
        (7, 'Остаток на начало', payload->>'cash_open'), (8, 'Сдано / инкассация', payload->>'cash_handed'),
        (9, 'Фактически пересчитано', payload->>'cash_counted')) v(n, label, val)
      union all
      select 1, e.ord, 'Расходы, ' || coalesce(nullif(left(btrim(e.x->>'purpose'), 40), ''), 'строка ' || e.ord) || ': сумма', e.x->>'amount'
        from jsonb_array_elements(v_exp) with ordinality e(x, ord)
      union all
      select 2, t.ord * 10 + c.n, 'Заборный лист, ' || coalesce(i.name, left(btrim(t.x->>'item_name'), 40)) || ': ' || c.label, c.val
        from jsonb_array_elements(v_tko) with ordinality t(x, ord)
        left join tandem.items i on i.code = nullif(btrim(t.x->>'item_code'), '')
        cross join lateral (values (1, 'выдано'::text, t.x->>'issued'), (2, 'остаток', t.x->>'returned'), (3, 'цена', t.x->>'price')) c(n, label, val)
       where coalesce(i.name, nullif(btrim(t.x->>'item_name'), '')) is not null
      union all
      select 3, s.ord * 10 + c.n, 'Продажи, ' || coalesce(i.name, left(btrim(s.x->>'item_name'), 40)) || ': ' || c.label, c.val
        from jsonb_array_elements(v_sal) with ordinality s(x, ord)
        left join tandem.items i on i.code = nullif(btrim(s.x->>'item_code'), '')
        cross join lateral (values (1, 'количество'::text, s.x->>'qty'), (2, 'цена', s.x->>'price'), (3, 'цена прейскуранта', s.x->>'price_list')) c(n, label, val)
       where coalesce(i.name, nullif(btrim(s.x->>'item_name'), '')) is not null
    ) f where not tandem.num_ok(f.val) order by f.g, f.ord limit 1;
    if v_lbl is not null then
      return jsonb_build_object('ok', false, 'error', 'Неверное число в поле «' || v_lbl || '»: ' || left(v_val, 40));
    end if;

    -- Код позиции, которой нет в справочнике, раньше ронял сохранение ошибкой внешнего ключа.
    select x.code into v_val from (
      select nullif(btrim(t->>'item_code'), '') as code from jsonb_array_elements(v_tko) t
      union all
      select nullif(btrim(s->>'item_code'), '') from jsonb_array_elements(v_sal) s) x
     where x.code is not null and not exists (select 1 from tandem.items i where i.code = x.code)
     limit 1;
    if v_val is not null then
      return jsonb_build_object('ok', false, 'error', 'Позиции с кодом «' || left(v_val, 40) || '» нет в справочнике — обновите страницу');
    end if;

    -- P4 (owner13): каким был отчёт до этого сохранения — чтобы отличить правку сданного отчёта от
    -- повторной отправки той же формы. У кассы строка есть с первого чека, но сдачей это ещё не было.
    select id, first_saved_at into v_prev_id, v_prev_first from tandem.daily_reports
     where point_id = v_point and report_date = v_date;
    if v_prev_first is not null then v_before := tandem.report_content(v_prev_id); end if;

    insert into tandem.daily_reports as d
      (point_id, report_date, shift_by, cash, kaspi_qr, transfer, card,
       qr_statement, tr_statement, cash_open, cash_handed, cash_counted, comment)
    values (v_point, v_date, left(payload->>'shift_by', 200),
       coalesce(tandem.to_num(payload->>'cash'), 0),
       coalesce(tandem.to_num(payload->>'kaspi_qr'), 0),
       coalesce(tandem.to_num(payload->>'transfer'), 0),
       coalesce(tandem.to_num(payload->>'card'), 0),
       tandem.to_num(payload->>'qr_statement'),
       tandem.to_num(payload->>'tr_statement'),
       coalesce(tandem.to_num(payload->>'cash_open'), 0),
       coalesce(tandem.to_num(payload->>'cash_handed'), 0),
       tandem.to_num(payload->>'cash_counted'),
       left(payload->>'comment', 2000))
    on conflict (point_id, report_date) do update set
       shift_by = excluded.shift_by, cash = excluded.cash,
       kaspi_qr = excluded.kaspi_qr, transfer = excluded.transfer, card = excluded.card,
       qr_statement = excluded.qr_statement, tr_statement = excluded.tr_statement,
       cash_open = excluded.cash_open, cash_handed = excluded.cash_handed,
       cash_counted = excluded.cash_counted, comment = excluded.comment,
       updated_at = now()
    returning d.id into v_id;

    -- Расход без суммы (пустая добавленная строка) пропускается.
    delete from tandem.cash_expenses where report_id = v_id;
    insert into tandem.cash_expenses (report_id, purpose, amount, receipt_no)
    select v_id, left(coalesce(e->>'purpose', ''), 500), tandem.to_num(e->>'amount'), left(nullif(e->>'receipt_no',''), 100)
    from jsonb_array_elements(v_exp) e
    where coalesce(tandem.to_num(e->>'amount'), 0) > 0;

    -- Название строки с кодом — из справочника, а не из запроса: текст точки уходит на экран собственника.
    -- Одна позиция дважды складывается в одну строку (название в отчёте уникально); два кода с одним
    -- названием различаются кодом в скобках, как в отчёте кассы.
    delete from tandem.takeout_lines where report_id = v_id;
    insert into tandem.takeout_lines (report_id, item_code, item_name, unit, issued, returned, price)
    select v_id, g.code,
           case when g.code is not null and count(*) over (partition by g.name) > 1 then g.name || ' [' || g.code || ']' else g.name end,
           g.unit, g.issued, g.returned, g.price
      from (select i.code, coalesce(i.name, left(nullif(btrim(t->>'item_name'), ''), 200)) as name,
                   min(coalesce(i.unit, left(nullif(btrim(t->>'unit'), ''), 20), 'шт')) as unit,
                   sum(coalesce(tandem.to_num(t->>'issued'), 0)) as issued,
                   sum(coalesce(tandem.to_num(t->>'returned'), 0)) as returned,
                   max(tandem.to_num(t->>'price')) as price
              from jsonb_array_elements(v_tko) t
              left join tandem.items i on i.code = nullif(btrim(t->>'item_code'), '')
             group by 1, 2) g
     where g.name is not null;

    delete from tandem.sale_lines where report_id = v_id;
    insert into tandem.sale_lines (report_id, item_code, item_name, qty, price, price_list)
    select v_id, g.code,
           case when g.code is not null and count(*) over (partition by g.name) > 1 then g.name || ' [' || g.code || ']' else g.name end,
           g.qty, g.price, g.price_list
      from (select s.code, s.name, sum(s.qty) as qty,
                   case when count(*) = 1 then max(s.price)
                        else round(sum(s.qty * s.price) / nullif(sum(s.qty) filter (where s.price is not null), 0), 2) end as price,
                   max(s.price_list) as price_list
              from (select i.code, coalesce(i.name, left(nullif(btrim(x->>'item_name'), ''), 200)) as name,
                           coalesce(tandem.to_num(x->>'qty'), 0) as qty,
                           tandem.to_num(x->>'price') as price, tandem.to_num(x->>'price_list') as price_list
                      from jsonb_array_elements(v_sal) x
                      left join tandem.items i on i.code = nullif(btrim(x->>'item_code'), '')) s
             where s.name is not null and s.qty <> 0
             group by s.code, s.name
            having sum(s.qty) <> 0) g;

    -- Касса (режим «чеки»): первичка — чеки. Деньги по каналам и строки продаж отчёта
    -- пересобираются из них, присланное формой не учитывается; сохранение отчёта = закрытие смены.
    if (select mode from tandem.points where id = v_point) = 'checks' then
      perform tandem.check_rollup(v_point, v_date);
      update tandem.daily_reports set closed_at = now() where id = v_id;
    end if;

    -- P4: первая сдача запоминается один раз; saved_at двигается, только если отчёт и правда изменился
    -- (деньги, расходы, заборный лист, продажи, комментарий). Чеки кассы, пришедшие после закрытия,
    -- правкой отчёта не считаются — для них late_checks; они уже были в «до» (check_rollup на каждом чеке).
    update tandem.daily_reports set
        first_saved_at = coalesce(first_saved_at, now()),
        saved_at = case when v_prev_first is null then now()
                        when v_before is distinct from tandem.report_content(v_id) then now()
                        else coalesce(saved_at, now()) end
     where id = v_id;

    -- Подпроект 4: отчёт порождает складской документ «Продажа». Сбой склада не должен
    -- мешать точке сдать отчёт — деньги важнее, продажу пересчитают из бэк-офиса.
    -- Сбой не прячется: пометка на документе (если он уже есть) и состояние в списке продаж.
    begin
      perform tandem.sale_sync(v_id);
    exception when others then
      begin
        update tandem.documents set sync_note = 'Сбой при сохранении отчёта: ' || sqlerrm
               || ' — нажмите «Провести продажи за период»'
          where source_kind = 'daily_report' and source_id = v_id::text;
      exception when others then
        null;
      end;
    end;

    select to_jsonb(v) || coalesce(tandem.report_marks(v.id), '{}'::jsonb) into v_res from tandem.v_daily v where v.id = v_id;
    return jsonb_build_object('ok', true, 'report', v_res);
  end if;

  -- ---------- заявки точки на завтра (миграция 0038) ----------
  if action = 'order_get' then
    return tandem.order_get(v_point, coalesce(tandem.to_date(payload->>'for_date'), v_today + 1));
  end if;
  if action = 'order_save' then return tandem.order_save(v_point, payload); end if;

  -- ---------- касса: чеки в течение дня ----------
  if action in ('check_save','check_void','check_list') then
    if (select mode from tandem.points where id = v_point) is distinct from 'checks' then
      return jsonb_build_object('ok', false, 'error', 'У этой точки касса не включена');
    end if;
    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;
    if action = 'check_void' then return tandem.check_void(v_point, payload); end if;
    return tandem.check_list(v_point, coalesce(tandem.to_date(payload->>'date'), v_today));
  end if;

  -- ---------- открыть смену кассы заново (собственник) ----------
  -- Чек, вошедший в закрытие смены, уже не меняется (check_save/check_void; поздний чек — можно, K1).
  -- Собственник снимает закрытие, касса исправляет или отменяет чек (правка видна в voids как «было →
  -- стало»), затем закрывает смену снова.
  if action = 'reopen_shift' then
    if v_pin is distinct from v_owner_pin and not v_train then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    -- 0048: учебный код сводки открывает смену только учебной точки
    if v_train and not coalesce(v_point = any(v_tp), false) then
      return jsonb_build_object('ok', false, 'error', 'Учебный код сводки открывает только учебные точки', 'code', 'forbidden');
    end if;
    v_date := tandem.to_date(payload->>'date');
    if v_date is null then return jsonb_build_object('ok', false, 'error', 'Неверная дата отчёта'); end if;
    update tandem.daily_reports set closed_at = null, updated_at = now()
     where point_id = v_point and report_date = v_date and closed_at is not null
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'Смена не закрыта'); end if;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'dashboard' then
    if v_pin is distinct from v_owner_pin and not v_train then
      return jsonb_build_object('ok', false, 'error', 'Нет доступа');
    end if;
    -- 0048: по учебному коду сводки каждый раздел ниже отбирает только учебные точки (v_tp), развоз — пуст
    -- Даты периода фронт шлёт местные; по умолчанию — местные же, не дата сервера (UTC).
    v_from := coalesce(tandem.to_date(payload->>'from'), v_today - 30);
    v_to   := coalesce(tandem.to_date(payload->>'to'), v_today);
    return jsonb_build_object('ok', true,
      -- P3/P4, K1: у строки дня — late_checks/late_sum и late_cash/late_kaspi/late_card/late_transfer (чеки
      -- после закрытия смены: «должно» — на момент закрытия, «закрыть смену заново»), first_saved_at и
      -- edited_at (отчёт пересохранён с изменениями после первой сдачи)
      'rows', (select coalesce(jsonb_agg(to_jsonb(v) || coalesce(tandem.report_marks(v.id), '{}'::jsonb)
                                         order by v.report_date desc, v.point_name), '[]'::jsonb)
               from tandem.v_daily v
               where v.report_date between v_from and v_to and (not v_train or v.point_id = any(v_tp))),
      -- P5 (owner15): first_report — дата первого отчёта точки; дни до неё — не «не сдано», а «ещё не работала»
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'mode',p.mode,
                   'first_report', (select min(d.report_date) from tandem.daily_reports d where d.point_id = p.id))
                   order by p.sort_order),'[]'::jsonb)
                 from tandem.points p where p.active and (not v_train or p.id = any(v_tp))),
      -- P1 (owner4): чеки кассы по точкам за период — число активных чеков, сумма, средний чек
      'checks', (select coalesce(jsonb_agg(jsonb_build_object('point_id', t.point_id, 'point_name', t.name,
                   'checks', t.n, 'total', t.s, 'avg', round(t.s / t.n, 2)) order by t.sort_order, t.name), '[]'::jsonb)
                 from (select c.point_id, p.name, p.sort_order, count(*) as n, sum(c.total) as s
                         from tandem.checks c join tandem.points p on p.id = c.point_id
                        where c.check_date between v_from and v_to and c.status = 'active'
                          and (not v_train or c.point_id = any(v_tp))
                        group by c.point_id, p.name, p.sort_order) t),
      -- Выручка по каналам и юрлицам за период
      'channels', (select jsonb_build_object(
          'cash', coalesce(sum(d.cash),0), 'kaspi_qr', coalesce(sum(d.kaspi_qr),0),
          'transfer', coalesce(sum(d.transfer),0), 'card', coalesce(sum(d.card),0))
        from tandem.daily_reports d where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))),
      'by_legal', (select coalesce(jsonb_agg(jsonb_build_object(
          'legal', t.legal_entity, 'revenue', t.rev) order by t.rev desc), '[]'::jsonb)
        from (select p.legal_entity, sum(d.cash + d.kaspi_qr + d.transfer + d.card) rev
              from tandem.daily_reports d join tandem.points p on p.id = d.point_id
              where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
              group by p.legal_entity) t),
      -- Что продано: топ-20 позиций по сумме (продажи + заборный лист)
      'top_items', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.item_name, 'qty', t.q, 'amount', t.amt,
          'discount', t.disc) order by t.amt desc), '[]'::jsonb)
        from (
          select item_name, sum(q) q, sum(amt) amt, sum(disc) disc from (
            select s.item_name, s.qty q, s.qty * coalesce(s.price,0) amt,
                   s.qty * greatest(coalesce(s.price_list, s.price, 0) - coalesce(s.price,0), 0) disc
            from tandem.sale_lines s
            join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
            union all
            select t.item_name, (t.issued - t.returned) q,
                   (t.issued - t.returned) * coalesce(t.price,0) amt, 0
            from tandem.takeout_lines t
            join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and (not v_train or d.point_id = any(v_tp))
          ) u group by item_name order by amt desc limit 20
        ) t),
      -- Кто не сдал отчёт за вчера — по местной дате: ночью до 05:00 «вчера» по UTC — это позавчера.
      -- P5 (owner15): точка, у которой ещё не было ни одного отчёта до вчерашнего дня включительно, не
      -- начала работать в программе — в первые дни все точки шумели бы в «не сдали».
      'missing', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order), '[]'::jsonb)
        from tandem.points p
        where p.active and (not v_train or p.id = any(v_tp))
          and exists (select 1 from tandem.daily_reports d0 where d0.point_id = p.id and d0.report_date <= v_today - 1)
          and not exists (
          select 1 from tandem.daily_reports d
          where d.point_id = p.id and d.report_date = v_today - 1
            -- у кассы строка отчёта появляется с первым чеком; сданным он считается после закрытия смены
            and (p.mode <> 'checks' or d.closed_at is not null))),
      -- Отмены и исправления чеков кассы за период: «пробил, взял наличные, отменил» больше не проходит без следа.
      'voids', (select coalesce(jsonb_agg(x.j order by x.t_at desc), '[]'::jsonb)
        from (select jsonb_build_object('kind', case when c.status = 'void' then 'void' else 'edited' end,
                  'point_id', c.point_id, 'point_name', p.name, 'date', c.check_date, 'no', c.no, 'total', c.total,
                  'pay_kind', c.pay_kind, 'first_total', coalesce(c.first_total, c.total),
                  'first_pay_kind', coalesce(c.first_pay_kind, c.pay_kind), 'edited', c.edited,
                  'reason', c.void_reason, 'seller', c.seller, 'at', c.updated_at) as j,
                  c.updated_at as t_at
                from tandem.checks c join tandem.points p on p.id = c.point_id
               where c.check_date between v_from and v_to and (c.status = 'void' or c.edited)
                 and (not v_train or c.point_id = any(v_tp))
               order by c.updated_at desc limit 300) x),
      -- Расход сырья по техкартам за период: топ-15
      -- P2 (owner7): unit_id — единица ингредиента (брутто в карте — в ней же); экран писал «кг» всем.
      -- Группировка по коду: две позиции с одним названием и разными единицами не складываются.
      'raw_usage', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', t.ingredient_name, 'amount', t.total, 'unit_id', t.unit_id) order by t.total desc), '[]'::jsonb)
        from (
          -- Карта берётся на дату отчёта, а не на сегодня: иначе новая версия карты
          -- переписала бы расход сырья за прошлые дни.
          select ing.name as ingredient_name, ing.unit_id, sum(cl.brutto / ch.output_amount * u.q) total from (
            select s.item_code, s.qty q, d.report_date rd
            from tandem.sale_lines s join tandem.daily_reports d on d.id = s.report_id
            where d.report_date between v_from and v_to and s.item_code is not null and (not v_train or d.point_id = any(v_tp))
            union all
            select t.item_code, (t.issued - t.returned), d.report_date
            from tandem.takeout_lines t join tandem.daily_reports d on d.id = t.report_id
            where d.report_date between v_from and v_to and t.item_code is not null and (not v_train or d.point_id = any(v_tp))
          ) u
          join tandem.charts ch on ch.id = tandem.active_chart(u.item_code, u.rd)
          join tandem.chart_lines cl on cl.chart_id = ch.id
          join tandem.items ing on ing.code = cl.ingredient_code
          group by ing.code, ing.name, ing.unit_id order by total desc limit 15
        ) t),
      -- Неверные коды за сутки (счётчик единого входа, 0029/0042): кто-то подбирает код точки, собственника
      -- или PIN бэк-офиса. 'master' — общий счётчик всех неверных кодов сети (он запирает вход собственника и водителя).
      'pin_failures', (select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'count', f.n, 'last', f.last,
          'name', coalesce(p.name, case
            when f.key = 'service' then 'служебный ключ'
            when f.key = '-' then 'вход без точки (собственник, водитель)'
            -- owner16: «общий замок» было непонятно — пишем, что он делает (порог — в tandem_gate: 10 за 5 минут)
            when f.key = 'master' then 'все неверные коды точек, собственника и водителя вместе: после 10 ошибок за 5 минут вход собственника и водителя закрывается на 5 минут'
            when f.key like 'office:%' then 'бэк-офис, логин «' || substr(f.key, 8) || '»'
            when f.key = 'training' then 'код обучения (страница обучения)'   -- 0048
            else f.key end))
          order by f.n desc), '[]'::jsonb)
        from (select key, count(*) n, max(at) last from tandem.pin_failures where at > now() - interval '24 hours'
                 and (not v_train or key = any(v_tp) or key = 'training')   -- 0048: учебной сводке — только учебное
               group by key order by count(*) desc limit 30) f
        left join tandem.points p on p.id = f.key),
      -- Долги по реализации
      'realization', (select coalesce(jsonb_agg(jsonb_build_object(
          'name', c.name, 'debt', t.debt) order by t.debt desc), '[]'::jsonb)
        from (select client_id, sum(delivered - paid - returned) debt
              from tandem.realization_ledger group by client_id) t
        join tandem.realization_clients c on c.id = t.client_id
        where t.debt <> 0 and not v_train));   -- 0048: развоз — настоящие клиенты, учебной сводке не показывается
  end if;

  return jsonb_build_object('ok', false, 'error', 'Неизвестное действие: ' || action);
end;
$function$
;

-- ---------------------------------------------------------------- техкарты точки: учебный код сводки (0048)
CREATE OR REPLACE FUNCTION public.tandem_charts(p_pin text, p_point text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_owner text;
  v_cats  text[];
  v_train text;   -- 0048: учебный код сводки — как код собственника, но только у учебной точки
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  select value into v_train from tandem.settings where key = 'training_owner_pin';
  if p_pin is distinct from v_owner
     and not coalesce(p_pin <> '' and p_pin = v_train
                      and exists (select 1 from tandem.points where id = p_point and training), false)
     and not exists (select 1 from tandem.points where id = p_point and pin = p_pin and active) then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;
  select item_categories into v_cats from tandem.points where id = p_point;
  return jsonb_build_object('ok', true, 'charts', (
    select coalesce(jsonb_object_agg(item_code, lines), '{}'::jsonb)
    from (
      select c.item_code,
             jsonb_agg(jsonb_build_object('n', ing.name, 'a', round(cl.brutto / c.output_amount, 4), 'u', ing.unit_id) order by cl.brutto desc) as lines
      from tandem.charts c
      join tandem.items i on i.code = c.item_code and i.active and i.for_sale
      join tandem.chart_lines cl on cl.chart_id = c.id
      join tandem.items ing on ing.code = cl.ingredient_code
      where c.id = tandem.active_chart(c.item_code, current_date)
        and (v_cats is null or cardinality(v_cats) = 0 or i.category = any(v_cats))
        -- 0048: учебные позиции — только у учебных точек, как в меню (tandem_api, items)
        and (not i.training or exists (select 1 from tandem.points tp where tp.id = p_point and tp.training))
      group by c.item_code
    ) t));
end $function$
;

-- ---------------------------------------------------------------- права на новые функции
do $$
declare f text;
begin
  foreach f in array array['tandem.training_stores_ok(uuid[])', 'tandem.training_orders_ok(date,uuid)',
                           'tandem.training_guard(text,text,jsonb,tandem.users)', 'tandem.training_pin6()',
                           'tandem.training_creds()', 'tandem.training_office(text,jsonb)', 'tandem.training_info(text,text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;

