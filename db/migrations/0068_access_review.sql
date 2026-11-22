-- 0068: ревизия 22.11.2026, участок «сервер, доступы и безопасность».
--
-- 1. Перебор кода точки с запертого адреса (tandem_gate). Порог по адресу (30 неверных за 10 минут) пропускал
--    верный код точки, а неверный отклонял без записи: запертый адрес перебирал коды точки без счёта и по ответу
--    узнавал верный (на стенде - 300 кодов в секунду). Теперь сначала замок ключа точки (10 за 5 минут: у запертой
--    точки один ответ на любой код), потом порог по адресу, и неверный код настоящей точки с запертого адреса
--    засчитывается её ключу и master, как при замке master. Верный код точки с общего адреса (мобильный CGNAT,
--    NAT магазина) по-прежнему проходит.
-- 2. Код новой точки - от 6 до 8 цифр (store_point_save). Нынешние 4-значные коды работают, пока их не сменят.
--    «Этот код уже занят» - последней проверкой перед записью: раньше форма с ошибкой в другом поле ничего не
--    сохраняла, но отвечала, совпал ли код с кодом собственника, водителя или другой точки.
-- 3. Учебная учётка (training_guard, office_users): заявки WhatsApp и заказы клиентов (имена, телефоны, адреса) не
--    открываются вовсе, в «Пользователях» видны только учебные учётки - урок собственника «Сотрудники» работает
--    на них. Обучение с 20.11.2026 идёт в тестовой базе, а учебный вход в рабочей раздают всем, кто учится.
-- 4. Сброс своего PIN через «Пользователи» (office_users, user_reset_pin) - отказ: свой PIN меняют «Сменить PIN»
--    с текущим. Иначе тот, кому досталась открытая сессия администратора или собственника, уводил учётку навсегда.
--
-- Правки - точечные, по тексту функций из базы на момент применения (как в 0060): чужие изменения соседних мест
-- сохраняются, повторный прогон ничего не меняет, а несовпавший образец останавливает миграцию с ошибкой.
-- Применение: docker exec -i tandem-db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < db/migrations/0068_access_review.sql

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0068: образец в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- ---------------------------------------------------------------- 1. гейт: замок точки раньше порога по адресу
select pg_temp.patch('public.tandem_gate(text,jsonb)'::regprocedure,
  replace($a$  -- 1) адрес клиента: 30 неверных за 10 минут. Верный служебный ключ и верный код присланной активной
  -- точки проходят: общий адрес (мобильный CGNAT, NAT офиса) не запирает точку и уборку дымового теста.
  -- Остальное <EM> отказ без записи. Общего порога на всю сеть больше нет: он позволял анонимно запереть
  -- все точки, в том числе с верным кодом.
  if not v_svc_ok and not v_point_ok and tandem.pin_ip_blocked(v_ip) then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов с этого адреса. Подождите 10 минут', 'code', 'throttled');
  end if;
  -- 2) ключ запроса: 10 за 5 минут.
  if not v_svc_ok and (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10 then
    return v_busy;
  end if;
$a$, '<EM>', chr(8212)),
  $b$  -- 1) ключ запроса: 10 за 5 минут. С 0068 - раньше порога по адресу: у запертой точки один ответ на любой код,
  -- верный он или нет.
  if not v_svc_ok and (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10 then
    return v_busy;
  end if;
  -- 2) адрес клиента: 30 неверных за 10 минут. Верный служебный ключ и верный код присланной активной
  -- точки проходят: общий адрес (мобильный CGNAT, NAT офиса) не запирает точку и уборку дымового теста.
  -- 0068: неверный код настоящей точки с запертого адреса засчитывается её ключу и master (раньше - отказ без
  -- записи, и запертый адрес перебирал коды точки без счёта: неверный получал «подождите», верный проходил).
  -- Перебор теперь упирается в замок точки: 10 за 5 минут. Код собственника и водителя здесь не пишется - их
  -- верный код получает тот же отказ, подсказки нет. Общего порога на всю сеть нет: он позволял анонимно
  -- запереть все точки, в том числе с верным кодом.
  if not v_svc_ok and not v_point_ok and tandem.pin_ip_blocked(v_ip) then
    if not v_service and v_pin <> '' and v_key <> '-' and not v_staff then
      insert into tandem.pin_failures (key, ip) values (v_key, v_ip), ('master', v_ip);
    end if;
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов с этого адреса. Подождите 10 минут', 'code', 'throttled');
  end if;
$b$);

-- ---------------------------------------------------------------- 2. код новой точки и «код занят»
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)'::regprocedure,
  $a$      if payload->>'pin' !~ '^[0-9]{4,8}$' then$a$,
  $b$      if payload->>'pin' !~ '^[0-9]{6,8}$' then   -- 0068: новые коды - от 6 цифр, прежние 4-значные работают$b$);
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)'::regprocedure,
  $a$от 4 до 8 цифр'); end if;$a$,
  $b$от 6 до 8 цифр'); end if;$b$);
-- проверку занятости переносим к записи: здесь её больше нет
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)'::regprocedure,
  replace($a$      -- Вход на экран точки сначала сверяет код собственника и водителя: совпадение с ними открыло бы
      -- чужую роль. Совпадение с кодом другой точки путает людей.
      -- 0048: и с учебным кодом сводки <EM> он сверяется раньше кода точки.
      if payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin', 'training_owner_pin'))
         or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point) then
        return tandem.err('validation', 'Этот код уже занят <EM> придумайте другой'); end if;
$a$, '<EM>', chr(8212)),
  $b$      -- 0068: занятость кода - последней проверкой, перед записью (ниже)
$b$);
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)'::regprocedure,
  $a$      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
$a$,
  $b$      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
    end if;
    -- 0068: занятость кода - последней проверкой, когда всё остальное в форме верно: иначе форма с ошибкой в другом
    -- поле (ничего не сохраняя) отвечала бы, совпал ли код с кодом собственника, водителя или другой точки.
    -- Вход на экран точки сначала сверяет код собственника, водителя и учебный код сводки: совпадение с ними
    -- открыло бы чужую роль. Совпадение с кодом другой точки путает людей.
    if nullif(payload->>'pin', '') is not null
       and (payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin', 'training_owner_pin'))
            or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point)) then
      return tandem.err('validation', 'Этот код уже занят - придумайте другой'); end if;
    if not exists (select 1 from tandem.points where id = v_point) then
$b$);

-- ---------------------------------------------------------------- 3. учебная учётка и персональные данные
select pg_temp.patch('tandem.training_guard(text,text,jsonb,tandem.users)'::regprocedure,
  $a$  if p_need = 'view' then return null; end if;
$a$,
  $b$  -- 0068: заявки WhatsApp и заказы клиентов - настоящие имена, телефоны и адреса: учебной учётке не открываются
  -- даже на чтение (раздел leads, раздел clients: меню заказов, заказы, их настройки).
  if p_action like 'lead%' or p_action like 'corder%' or p_action like 'cmenu%' or p_action = 'client_settings_save' then
    return tandem.err('forbidden', 'Учебная учётная запись не открывает заявки и заказы клиентов: там настоящие имена и телефоны');
  end if;
  if p_need = 'view' then return null; end if;
$b$);

-- в «Пользователях» учебная учётка видит только учебные учётки (логины и имена сотрудников ей не показываются)
select pg_temp.patch('tandem.office_users(text,jsonb,tandem.users)'::regprocedure,
  $a$order by active desc, name), '[]'::jsonb) from tandem.users),$a$,
  $b$order by active desc, name), '[]'::jsonb) from tandem.users
                where not v_user.training or training),   -- 0068: учебной учётке - только учебные$b$);

-- ---------------------------------------------------------------- 4. свой PIN - только «Сменить PIN»
select pg_temp.patch('tandem.office_users(text,jsonb,tandem.users)'::regprocedure,
  $a$    v_pin := coalesce(payload->>'pin','');
$a$,
  $b$    v_pin := coalesce(payload->>'pin','');
    -- 0068: свой PIN - только «Сменить PIN» с текущим. Сброс себе через «Пользователи» текущего не спрашивал: кому
    -- досталась открытая сессия администратора или собственника, тот ставил свой PIN и уводил учётку навсегда.
    if v_id = v_user.id then
      return tandem.err('forbidden', 'Свой PIN меняйте кнопкой «Сменить PIN»: там нужен текущий PIN');
    end if;
$b$);

-- ---------------------------------------------------------------- права (как в 0042)
do $$
declare f text;
begin
  foreach f in array array['public.tandem_gate(text,jsonb)', 'tandem.office_stores(text,jsonb,tandem.users)',
      'tandem.office_users(text,jsonb,tandem.users)', 'tandem.training_guard(text,text,jsonb,tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
