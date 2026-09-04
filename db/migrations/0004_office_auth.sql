-- Бэк-офис: сессии, права, диспетчер.
create or replace function tandem.err(p_code text, p_msg text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'error', p_code, 'message', p_msg)
$$;

create or replace function tandem.office_session(p_token text) returns tandem.users
language sql stable as $$
  select u.* from tandem.sessions s join tandem.users u on u.id = s.user_id
  where s.token = p_token and s.expires_at > now() and u.active
$$;

create or replace function tandem.office_can(p_role text, p_section text, p_action text) returns boolean
language sql stable as $$
  select exists (select 1 from tandem.role_permissions
                 where role = p_role and section = p_section and action = p_action)
$$;

create or replace function tandem.office_user_json(u tandem.users) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', u.id, 'login', u.login, 'name', u.name, 'role', u.role)
$$;

create or replace function tandem.office_permissions(p_role text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(section || ':' || action order by section, action), '[]'::jsonb)
  from tandem.role_permissions where role = p_role
$$;

-- 'extensions' в search_path: на Supabase pgcrypto (crypt, gen_salt, gen_random_bytes) живёт там;
-- на своём сервере такой схемы нет, и Postgres её молча пропускает.
create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_token   text := payload->>'token';
  v_user    tandem.users;
  v_pin     text;
  v_section text;
  v_need    text;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;
    if v_user.id is null or v_user.pin_hash <> crypt(v_pin, v_user.pin_hash) then
      return tandem.err('unauthorized', 'Неверный логин или PIN');
    end if;
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

  return case v_section
    when 'nomenclature'  then tandem.office_nomenclature(action, payload, v_user)
    when 'stores'        then tandem.office_stores(action, payload, v_user)
    when 'counteragents' then tandem.office_counteragents(action, payload, v_user)
    when 'users'         then tandem.office_users(action, payload, v_user)
  end;
end $$;
-- Роли anon/authenticated/service_role — выдумка Supabase; на своём сервере их нет,
-- и без обёртки файл там падает. PUBLIC есть в любом Postgres, поэтому revoke от него — снаружи.
revoke all on function public.tandem_office(text,jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_office(text,jsonb) from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb) to service_role;
  end if;
end $$;
