-- Перепроверка перед тестированием (18.09.2026).
-- 1. Вход: в 0021 заблокированный логин отвечал на верный PIN иначе, чем на неверный, —
--    перебор узнавал PIN по тексту ответа прямо во время блокировки. Теперь ответ на любую
--    неудачу один, и в нём же сказано про блокировку.
-- 2. Поиск контрагента по телефону включается, только когда запрос похож на телефон
--    (цифры, +, скобки, пробел, дефис): «Буфет 12345» больше не цепляет чужие телефоны.
-- Тела функций — из 0021 и 0026 (сверены md5 с базой).

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
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
end $$;

create or replace function tandem.office_counteragents(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_id uuid; v_name text; v_kind text;
  v_q text := btrim(coalesce(payload->>'q',''));
  v_page int := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int; v_rows jsonb;
  v_digits text := regexp_replace(btrim(coalesce(payload->>'q','')), '\D', '', 'g');
begin
  if action = 'counteragents_list' then
    v_kind := nullif(payload->>'kind','');
    select count(*) into v_total from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || tandem.like_escape(v_q) || '%'
             or c.bin like '%' || tandem.like_escape(v_q) || '%'
             or (length(v_digits) >= 5 and v_q ~ '^[0-9+() -]+$'
                 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || right(v_digits, 10) || '%'))
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select c.id, c.name, c.kind, c.bin, c.phone, c.note, c.active
      from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || tandem.like_escape(v_q) || '%'
             or c.bin like '%' || tandem.like_escape(v_q) || '%'
             or (length(v_digits) >= 5 and v_q ~ '^[0-9+() -]+$'
                 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || right(v_digits, 10) || '%'))
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean)
      order by c.active desc, c.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  if action = 'counteragent_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название контрагента пустое'); end if;
    v_kind := coalesce(payload->>'kind','');
    if v_kind not in ('supplier','customer','employee','other') then
      return tandem.err('validation', 'Вид: supplier, customer, employee или other');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.counteragents (name, kind, bin, phone, note, active)
        values (v_name, v_kind, nullif(payload->>'bin',''), nullif(payload->>'phone',''),
                payload->>'note', coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.counteragents set name = v_name, kind = v_kind,
        bin = case when payload ? 'bin' then nullif(payload->>'bin','') else bin end,
        phone = case when payload ? 'phone' then nullif(payload->>'phone','') else phone end,
        note = coalesce(payload->>'note', note),
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Контрагент не найден'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

revoke all on function public.tandem_office(text,jsonb) from public;
revoke all on function tandem.office_counteragents(text,jsonb,tandem.users) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_office(text,jsonb) from anon, authenticated;
    revoke all on function tandem.office_counteragents(text,jsonb,tandem.users) from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb) to service_role;
  end if;
end $$;
