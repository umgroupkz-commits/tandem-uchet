-- 0060: учебная касса остаётся на тестовом стенде Webkassa и после подключения рабочей кассы. Настройки Webkassa
-- в Vault общие (0053), поэтому у тестового стенда - свой набор webkassa_test_* (node tools/webkassa-config.mjs --test),
-- а общий webkassa_* становится рабочим. Сервер (supabase/functions/uchet/fiscal.js, pickConfig) берёт для
-- учебной точки тестовый набор; пока его нет - общий, но только если тот сам тестовый (devkkm или имитация):
-- учебный чек не должен уйти в налоговую с рабочей кассы. Для этого fiscal_prepare отдаёт признак training.

create or replace function tandem.fiscal_config_set(payload jsonb) returns jsonb
language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare k text; v text; v_id uuid; v_set text[] := '{}';
  v_pre text := case when payload->>'set' = 'test' then 'webkassa_test_' else 'webkassa_' end;
begin
  foreach k in array array['base', 'api_key', 'login', 'password', 'mode'] loop
    v := nullif(btrim(coalesce(payload->>k, '')), '');
    if v is null then continue; end if;
    select id into v_id from vault.secrets where name = v_pre || k;
    if v_id is null then perform vault.create_secret(v, v_pre || k, 'Webkassa: ' || v_pre || k || ' (0060)');
    else perform vault.update_secret(v_id, v); end if;
    v_set := v_set || k;
  end loop;
  return jsonb_build_object('ok', true, 'set', to_jsonb(v_set), 'target', case when v_pre = 'webkassa_test_' then 'test' else 'main' end,
    'has_test', exists (select 1 from vault.secrets where name in ('webkassa_test_api_key', 'webkassa_test_mode')));
end $$;

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0060: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$if action = 'fiscal_prepare' then return tandem.fiscal_prepare(v_point, payload); end if;$a$,
  $a$if action = 'fiscal_prepare' then   -- 0060: признак учебной точки - серверу, чтобы выбрать стенд Webkassa
      return tandem.fiscal_prepare(v_point, payload)
        || jsonb_build_object('training', coalesce((select training from tandem.points where id = v_point), false));
    end if;$a$);

revoke all on function tandem.fiscal_config_set(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.fiscal_config_set(jsonb) from anon, authenticated;
  end if;
end $$;
