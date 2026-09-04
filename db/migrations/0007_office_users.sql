-- Бэк-офис: пользователи.
create or replace function tandem.office_users(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
begin
  if action = 'users_list' then
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at)
                  order by active desc, name), '[]'::jsonb) from tandem.users),
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'));
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
    v_id := nullif(payload->>'id','')::uuid;
    if exists (select 1 from tandem.users where login = v_login and (v_id is null or id <> v_id)) then
      return tandem.err('validation', 'Такой логин уже есть');
    end if;
    if v_id is null then
      if v_pin is null or length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
        return tandem.err('validation', 'PIN — не меньше 4 цифр');
      end if;
      insert into tandem.users (login, name, role, pin_hash, must_change_pin, active)
        values (v_login, v_name, v_role, crypt(v_pin, gen_salt('bf')), true,
                coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      if v_id = v_user.id and coalesce((payload->>'active')::boolean, true) = false then
        return tandem.err('validation', 'Нельзя выключить самого себя');
      end if;
      update tandem.users set login = v_login, name = v_name, role = v_role,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
      if not coalesce((payload->>'active')::boolean, true) then
        delete from tandem.sessions where user_id = v_id;
      end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = true where id = v_id;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
