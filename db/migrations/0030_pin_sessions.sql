-- Смена PIN закрывает остальные сессии пользователя (отложенное замечание подпроекта 1):
-- украденная или забытая на чужом телефоне сессия не переживает смену PIN. Текущая сессия
-- остаётся — её токен gate кладёт в настройку транзакции tandem.token. При сбросе PIN
-- администратором токен в настройке чужой, поэтому у пользователя закрываются все сессии.
-- tandem_gate — тело из 0029 + одна строка set_config.

create or replace function tandem.users_pin_sessions() returns trigger
language plpgsql as $$
begin
  if new.pin_hash is distinct from old.pin_hash then
    delete from tandem.sessions
     where user_id = new.id and token <> coalesce(current_setting('tandem.token', true), '');
  end if;
  return new;
end $$;
drop trigger if exists users_pin_sessions on tandem.users;
create trigger users_pin_sessions after update of pin_hash on tandem.users
  for each row execute function tandem.users_pin_sessions();

create or replace function public.tandem_gate(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_pin   text := coalesce(payload->>'pin', '');
  v_key   text;
  v_res   jsonb;
  v_hash  text;
  v_owner text;
  v_service boolean := action in ('migrate','test_cleanup','sync_items','sync_prices','recalc_ranks','set_packaging','set_short_list');
begin
  if action like 'office\_%' then
    -- Токен текущей сессии — в настройку транзакции: триггер смены PIN закроет все сессии
    -- пользователя, кроме этой (см. tandem.users_pin_sessions).
    perform set_config('tandem.token', coalesce(payload->>'token', ''), true);
    return public.tandem_office(substr(action, 8), payload);
  end if;

  -- Ключ счётчика — настоящая точка из запроса; всё остальное (вход собственника и водителя,
  -- выдуманные точки) падает в один общий ключ, чтобы перебор нельзя было размазать по ключам.
  v_key := case when v_service then 'service'
                else coalesce((select p.id from tandem.points p
                                where p.id = coalesce(nullif(payload->>'point_id',''), nullif(payload->>'point',''))), '-') end;
  if (select count(*) from tandem.pin_failures f where f.key = v_key and f.at > now() - interval '5 minutes') >= 10
     or (select count(*) from tandem.pin_failures f where f.at > now() - interval '5 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'error', 'Слишком много неверных кодов. Подождите 5 минут',
                              'code', 'throttled');
  end if;

  if v_service then
    select value into v_hash from tandem.settings where key = 'service_key_hash';
    if v_hash is null or coalesce(payload->>'service_key', '') = ''
       or encode(digest(payload->>'service_key', 'sha256'), 'hex') <> v_hash then
      insert into tandem.pin_failures (key) values ('service');
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нужен служебный ключ');
    end if;
    select value into v_owner from tandem.settings where key = 'owner_pin';
    v_res := case action
      when 'migrate'        then public.tandem_migrate(v_owner, coalesce(payload->>'kind',''), coalesce(payload->'rows','[]'::jsonb))
      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)
      when 'sync_items'     then public.tandem_sync_items(v_owner, coalesce(payload->'items','[]'::jsonb))
      when 'sync_prices'    then public.tandem_sync_prices(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'recalc_ranks'   then public.tandem_recalc_ranks(v_owner, coalesce((payload->>'days')::int, 30))
      when 'set_packaging'  then public.tandem_set_packaging(v_owner, coalesce(payload->'data','[]'::jsonb))
      when 'set_short_list' then public.tandem_set_short_list(v_owner, coalesce(payload->>'point',''), coalesce(payload->'codes','[]'::jsonb))
    end;
    -- Уборка теста снимает и его неверные коды: иначе проверка счётчика запирала бы следующий прогон.
    if action = 'test_cleanup' then delete from tandem.pin_failures where key in ('zz_test'); end if;
    return v_res;
  end if;

  v_res := case action
    when 'charts'       then public.tandem_charts(v_pin, coalesce(payload->>'point_id',''))
    when 'realization'  then public.tandem_realization(v_pin, coalesce(payload->>'op','list'), coalesce(payload->'data','{}'::jsonb))
    when 'save_aliases' then public.tandem_save_aliases(v_pin, coalesce(payload->>'point_id',''), coalesce(payload->'data','[]'::jsonb))
    else public.tandem_api(action, payload)
  end;

  -- Неверный код узнаём по ответу нижележащей функции: их тела не трогаем.
  if v_pin <> '' and jsonb_typeof(v_res) = 'object' and (v_res->>'ok') = 'false'
     and (v_res->>'error' in ('Неверный код', 'Нет доступа')
          or (v_res->>'error' = 'forbidden' and v_res->>'message' = 'Нет доступа')) then
    insert into tandem.pin_failures (key) values (v_key);
    delete from tandem.pin_failures where at < now() - interval '1 day';
  end if;
  return v_res;
end $$;

revoke all on function public.tandem_gate(text,jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_gate(text,jsonb) from anon, authenticated;
    grant execute on function public.tandem_gate(text,jsonb) to service_role;
  end if;
end $$;
