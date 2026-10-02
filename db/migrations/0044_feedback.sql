-- Замечания тестировщиков прямо из программы (сборка 21). Кнопка «Замечание» на всех экранах: человек
-- пишет, что не так, экран сам прикладывает, где он был (страница, раздел, точка или логин, сборка, последняя
-- ошибка на экране). Список и отметка «разобрано» — у администратора и собственника в бэк-офисе.
-- Бэк-офис: office_feedback_save / _list / _done (сессия бэк-офиса; разбирают admin и owner).
-- Экраны точки, кассы, заявки и водителя: действие feedback с кодом точки, собственника или водителя —
-- неверный код засчитывается счётчиком гейта, как любой другой.

create table if not exists tandem.feedback (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source     text not null check (source in ('office', 'stock', 'kassa', 'point', 'order', 'owner', 'driver')),
  author     text,
  role       text,
  page       text,
  message    text not null,
  context    jsonb,
  status     text not null default 'new' check (status in ('new', 'done')),
  done_at    timestamptz,
  done_by    text,
  answer     text
);
alter table tandem.feedback enable row level security;
create index if not exists feedback_created_idx on tandem.feedback (created_at desc);

-- Запись замечания: текст обязателен и не длиннее 2000 знаков, приложенные сведения — не больше 8 КБ
-- (лишнее отрезается, а не роняет запись: замечание важнее подробностей).
create or replace function tandem.feedback_add(p_source text, p_author text, p_role text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_msg text := btrim(coalesce(payload->>'message', '')); v_ctx jsonb := payload->'context'; v_id bigint;
begin
  if v_msg = '' then return jsonb_build_object('ok', false, 'error', 'Напишите, что случилось'); end if;
  if jsonb_typeof(v_ctx) is distinct from 'object' then v_ctx := null; end if;
  if length(coalesce(v_ctx::text, '')) > 8000 then v_ctx := jsonb_build_object('note', 'сведения обрезаны', 'head', left(v_ctx::text, 7000)); end if;
  insert into tandem.feedback (source, author, role, page, message, context)
    values (p_source, left(p_author, 200), left(p_role, 40), left(nullif(btrim(coalesce(payload->>'page', '')), ''), 200), left(v_msg, 2000), v_ctx)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- С экранов без входа в бэк-офис: код точки (точка из запроса, действующая), код собственника или водителя.
-- Неверный код — ответ «Нет доступа»: гейт засчитывает его в счётчик неверных кодов.
create or replace function tandem.feedback_point(p_pin text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_point record; v_owner text; v_driver text; v_src text := coalesce(payload->>'source', 'point');
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  select value into v_driver from tandem.settings where key = 'driver_pin';
  if v_src not in ('kassa', 'point', 'order', 'owner', 'driver') then v_src := 'point'; end if;
  if p_pin <> '' and p_pin = v_owner then
    return tandem.feedback_add(case when v_src in ('kassa', 'point', 'order') then v_src else 'owner' end, 'собственник', 'owner', payload);
  end if;
  if p_pin <> '' and p_pin = v_driver then return tandem.feedback_add('driver', 'водитель', 'driver', payload); end if;
  select id, name into v_point from tandem.points where id = payload->>'point_id' and pin = p_pin and active;
  if v_point.id is null then return jsonb_build_object('ok', false, 'error', 'Нет доступа'); end if;
  return tandem.feedback_add(case when v_src in ('kassa', 'point', 'order') then v_src else 'point' end,
                             v_point.name, 'point:' || v_point.id, payload);
end $$;

-- Из бэк-офиса: записать может любой вошедший (и со склада с телефона — та же сессия); список и отметку
-- «разобрано» видят администратор и собственник.
create or replace function tandem.feedback_office(action text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
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
end $$;

-- ---------------------------------------------------------------- гейт: маршруты замечаний (тело — из 0042)
create or replace function public.tandem_gate(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public', 'extensions' as $$
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
    return public.tandem_office(substr(action, 8), payload);
  end if;

  -- Список точек для экрана входа кода не требует и не запирается: иначе чужие ошибки оставили бы
  -- все точки без выбора точки.
  if action = 'points' then
    return public.tandem_api(action, payload);
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
    v_staff := v_pin in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'));
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
  if v_pin <> '' and jsonb_typeof(v_res) = 'object' and (v_res->>'ok') = 'false'
     and (v_res->>'error' in ('Неверный код', 'Нет доступа')
          or (v_res->>'error' = 'forbidden' and v_res->>'message' = 'Нет доступа')) then
    insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    delete from tandem.pin_failures where at < now() - interval '1 day';
  end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------- уборка теста: и его замечания (тело — из 0042)
create or replace function public.tandem_test_cleanup(p_pin text)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_owner text;
  v_items int; v_groups int; v_stores int; v_ca int; v_users int; v_charts int; v_left int;
  v_docs int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;

  -- Движения держат документ (stock_moves_document_id_fkey on delete restrict) — с 0018
  -- они больше не уходят каскадом и снимаются здесь явно, до удаления самих документов.
  delete from tandem.stock_moves
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%')
       or document_id in (
            select id from tandem.documents
              where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
                 or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                           where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%'));

  -- «Готовым со склада» (0041): строки тестовых складов, складов служебных точек и тестовых позиций —
  -- до удаления складов и позиций. Без таблицы (база до 0041) шаг пропускается.
  if to_regclass('tandem.store_ready') is not null then
    delete from tandem.store_ready
      where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%' or point_id like 'zz\_%')
         or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  end if;

  -- Отчёты служебной точки теста zz_test (выключена, на экранах не видна): их продажи сидят
  -- на тестовых складах и уйдут ниже вместе с документами склада. Настоящие точки тест не трогает.
  delete from tandem.checks where point_id = 'zz_kassa';   -- касса теста: чеки, затем отчёты
  -- Заявки служебных точек: факт выпуска их дней снимается, только если позицию в этот день не заказывала
  -- ни одна настоящая точка, — чужой план пекаря тест не трогает. Затем сами заявки (строки — каскадом).
  delete from tandem.order_plan pl
   where exists (select 1 from tandem.order_lines l join tandem.orders o on o.id = l.order_id
                  where left(o.point_id, 3) = 'zz_' and o.for_date = pl.for_date and l.item_code = pl.item_code)
     and not exists (select 1 from tandem.order_lines l join tandem.orders o on o.id = l.order_id
                      where left(o.point_id, 3) <> 'zz_' and o.for_date = pl.for_date and l.item_code = pl.item_code);
  delete from tandem.orders where left(point_id, 3) = 'zz_';
  delete from tandem.order_plan where item_code in (select code from tandem.items where name like 'ZZ_TEST_%' or code like 'ZZ_TEST_%');
  update tandem.settings set value = '' where key = 'orders_store_id'
     and value in (select id::text from tandem.stores where name like 'ZZ_TEST_%');
  delete from tandem.daily_reports where point_id in ('zz_test', 'zz_kassa');
  -- замечания, оставленные дымовым тестом (0044)
  if to_regclass('tandem.feedback') is not null then delete from tandem.feedback where message like 'ZZ\_TEST\_%'; end if;

  -- Неверные коды служебных точек вместе с парной строкой общего счётчика 'master' (то же время и адрес)
  -- и неудачные входы тестовых логинов бэк-офиса: замок, который тест ставит себе сам, иначе держал бы
  -- вход собственника и следующий прогон.
  with z as (delete from tandem.pin_failures where key like 'zz\_%' returning at, ip)
  delete from tandem.pin_failures m
   using (select distinct at, ip from z) zz
   where m.key = 'master' and m.at = zz.at and m.ip is not distinct from zz.ip;
  delete from tandem.pin_failures where key like 'office:zz\_test\_%';

  -- Документы тестовых складов и позиций уходят первыми: на них ссылаются строки,
  -- а сами документы держат FK на stores и items.
  with d as (delete from tandem.documents
      where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or store_to   in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
         or id in (select l.document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                   where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%')
      returning 1)
    select count(*) into v_docs from d;
  delete from tandem.stock_balances
    where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
  -- Счётчики номеров (doc_counters) не трогаем: номера документов не должны повторяться.

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
    'counteragents', v_ca, 'users', v_users, 'charts', v_charts, 'documents', v_docs), 'leftovers', v_left);
end $$;

do $$
declare f text;
begin
  foreach f in array array['tandem.feedback_add(text,text,text,jsonb)', 'tandem.feedback_point(text,jsonb)',
                           'tandem.feedback_office(text,jsonb)', 'public.tandem_gate(text,jsonb)', 'public.tandem_test_cleanup(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
