-- 0056: фискализация, второй шаг (после 0053-0055).
-- - Внесение и изъятие наличных в Webkassa (MoneyOperation): кнопки в «Смене» кассы и изъятие всего остатка
--   перед Z-отчётом - журнал tandem.fiscal_money.
-- - Чек, который сейчас пробивается (fiscal_status = 'pending', до 2 минут), не правится и не отменяется:
--   иначе фискальный чек вышел бы по прежним строкам или продажа пробилась бы без возврата. Продажа, пробитая
--   уже после отмены чека, ставит чек возврата в очередь.
-- - Вход кассы отдаёт признак учебной точки (касса не печатает там чек сама).
-- - Служебное действие гейта schema_snapshot: снимок схемы для db/schema/tandem_full.sql
--   (node tools/schema-snapshot-pull.mjs).
-- Существующие функции правятся по якорю из текущего текста в базе (якорь обязан встретиться ровно раз).

create table if not exists tandem.fiscal_money (
  id         bigint generated always as identity primary key,
  point_id   text not null references tandem.points(id),
  ext        text not null unique,          -- номер операции для Webkassa (ExternalCheckNumber): повтор не задвоит
  kind       text not null check (kind in ('in', 'out')),
  sum        numeric(14,2) not null check (sum > 0),
  reason     text,
  seller     text,
  auto       boolean not null default false, -- изъятие остатка перед Z-отчётом
  ok         boolean not null default false,
  error      text,
  shift      integer,
  data       jsonb,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
alter table tandem.fiscal_money enable row level security;
comment on table tandem.fiscal_money is '0056: внесения и изъятия наличных в Webkassa по точкам';

-- ---------------------------------------------------------------- запрос к Webkassa (гейт, код точки)
create or replace function tandem.fiscal_prepare(p_point text, payload jsonb) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_op  text := coalesce(nullif(payload->>'op', ''), 'sale');
  v_pt  tandem.points;
  v_uid uuid;
  v_chk tandem.checks;
  v_paper int;
  v_kind text; v_sum numeric; v_ext text; v_m tandem.fiscal_money;
begin
  select * into v_pt from tandem.points where id = p_point;
  if not (coalesce(v_pt.fiscal_enabled, false) and v_pt.mode = 'checks' and coalesce(btrim(v_pt.fiscal_cashbox), '') <> '') then
    return jsonb_build_object('ok', true, 'skip', true);
  end if;
  v_paper := case when v_pt.fiscal_paper = 80 then 0 else 3 end;
  if v_op in ('x', 'z') then
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', tandem.local_now()::date);
  end if;
  if v_op = 'money' then
    v_kind := payload->>'kind';
    begin v_sum := round((payload->>'sum')::numeric, 2); exception when others then v_sum := null; end;
    v_ext := left(btrim(coalesce(payload->>'ext', '')), 64);
    if v_kind not in ('in', 'out') then return jsonb_build_object('ok', false, 'error', 'Внесение или изъятие?'); end if;
    if v_sum is null or v_sum <= 0 or v_sum > 10000000 then return jsonb_build_object('ok', false, 'error', 'Сумма - больше нуля'); end if;
    if v_ext = '' then return jsonb_build_object('ok', false, 'error', 'Нет номера операции'); end if;
    if v_kind = 'out' and coalesce(btrim(payload->>'reason'), '') = '' then
      return jsonb_build_object('ok', false, 'error', 'Напишите, на что изъяли наличные'); end if;
    insert into tandem.fiscal_money (point_id, ext, kind, sum, reason, seller)
      values (p_point, v_ext, v_kind, v_sum, nullif(left(btrim(coalesce(payload->>'reason', '')), 300), ''),
              nullif(left(btrim(coalesce(payload->>'seller', '')), 120), ''))
      on conflict (ext) do nothing;
    select * into v_m from tandem.fiscal_money where ext = v_ext;
    if v_m.point_id <> p_point then return jsonb_build_object('ok', false, 'error', 'Нет доступа'); end if;
    if v_m.ok then return jsonb_build_object('ok', true, 'done', true, 'money', to_jsonb(v_m) - 'data'); end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'kind', v_m.kind, 'sum', v_m.sum, 'ext', v_m.ext);
  end if;
  if v_op not in ('sale', 'return', 'print') then return jsonb_build_object('ok', false, 'error', 'Неизвестная операция кассы'); end if;
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point;
  if v_chk.id is null then return jsonb_build_object('ok', false, 'error', 'Чек не найден'); end if;
  if v_op = 'print' then
    if v_chk.fiscal_status is distinct from 'ok' then return jsonb_build_object('ok', false, 'error', 'Чек ещё не пробит в налоговой'); end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
      'ext', v_chk.uid::text || case when v_chk.fiscal_return_status = 'ok' and payload->>'which' = 'return' then ':r' else '' end);
  end if;
  if v_op = 'sale' then
    if v_chk.fiscal_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    if v_chk.status <> 'active' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек отменён'); end if;
    if v_chk.total <= 0 then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Сумма чека 0'); end if;
    -- 0056: чек пробивается - правка и отмена ждут ответа Webkassa (check_save, check_void)
    update tandem.checks set fiscal_status = 'pending', fiscal_at = now() where id = v_chk.id returning * into v_chk;
  else
    if v_chk.fiscal_status is distinct from 'ok' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек не был пробит'); end if;
    if v_chk.fiscal_return_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    if v_chk.status <> 'void' then return jsonb_build_object('ok', false, 'error', 'Возврат пробивается для отменённого чека'); end if;
  end if;
  return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
    'shift_hint', v_chk.fiscal_shift, 'body', tandem.fiscal_body(v_chk, v_op));
end $$;

-- ---------------------------------------------------------------- запись результата (только сервер)
create or replace function public.tandem_fiscal_store(p_point text, p_uid uuid, p_op text, p_ok boolean, p_data jsonb, p_error text)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_chk tandem.checks;
  v_num text := coalesce(p_data->>'CheckNumber', p_data->>'Number');
  v_url text := p_data->>'TicketUrl';
  v_m tandem.fiscal_money;
begin
  if p_op = 'z' then
    update tandem.daily_reports set fiscal_z_at = case when p_ok then now() else fiscal_z_at end,
           fiscal_z_shift = case when p_ok then coalesce((p_data->>'ShiftNumber')::int, fiscal_z_shift) else fiscal_z_shift end,
           fiscal_z_error = case when p_ok then null else left(p_error, 500) end
     where point_id = p_point and report_date = coalesce((p_data->>'report_date')::date, tandem.local_now()::date);
    return jsonb_build_object('ok', true);
  end if;
  -- 0056: внесение/изъятие. p_data: ext, kind, sum, reason, seller, auto и ответ Webkassa в response.
  if p_op = 'money' then
    insert into tandem.fiscal_money as m (point_id, ext, kind, sum, reason, seller, auto, ok, error, shift, data, done_at)
      values (p_point, p_data->>'ext', p_data->>'kind', (p_data->>'sum')::numeric, p_data->>'reason', p_data->>'seller',
              coalesce((p_data->>'auto')::boolean, false), p_ok, case when p_ok then null else left(p_error, 500) end,
              (p_data->'response'->>'ShiftNumber')::int, p_data->'response', now())
      on conflict (ext) do update set ok = m.ok or excluded.ok,
              error = case when m.ok or excluded.ok then null else excluded.error end,
              shift = coalesce(excluded.shift, m.shift), data = coalesce(excluded.data, m.data), done_at = now()
      returning * into v_m;
    return jsonb_build_object('ok', true, 'money', to_jsonb(v_m) - 'data');
  end if;
  select * into v_chk from tandem.checks where uid = p_uid and point_id = p_point for update;
  if v_chk.id is null then return tandem.err('not_found', 'Чек не найден'); end if;
  if p_op = 'sale' then
    if v_chk.fiscal_status = 'ok' then return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk)); end if;
    update tandem.checks set
      fiscal_status = case when p_ok then 'ok' else 'error' end,
      fiscal_number = case when p_ok then v_num end,
      fiscal_dt = case when p_ok then coalesce(p_data->>'DateTime', p_data->>'RegistratedOn') end,
      fiscal_rnm = case when p_ok then coalesce(p_data->'Cashbox'->>'RegistrationNumber', p_data->>'CashboxRegistrationNumber') end,
      fiscal_shift = case when p_ok then (p_data->>'ShiftNumber')::int end,
      fiscal_url = case when p_ok then v_url end,
      fiscal_offline = case when p_ok then coalesce((p_data->>'OfflineMode')::boolean, (p_data->>'IsOffline')::boolean, false) end,
      fiscal_error = case when p_ok then null else left(p_error, 500) end,
      fiscal_tries = fiscal_tries + 1, fiscal_at = now(),
      -- 0056: чек отменили, пока он пробивался, - продажа в налоговой есть, нужен чек возврата
      fiscal_return_status = case when p_ok and status = 'void' then coalesce(fiscal_return_status, 'pending') else fiscal_return_status end
     where id = v_chk.id returning * into v_chk;
  elsif p_op = 'return' then
    if v_chk.fiscal_return_status = 'ok' then return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk)); end if;
    update tandem.checks set
      fiscal_return_status = case when p_ok then 'ok' else 'error' end,
      fiscal_return_number = case when p_ok then v_num end,
      fiscal_return_url = case when p_ok then v_url end,
      fiscal_return_error = case when p_ok then null else left(p_error, 500) end,
      fiscal_return_at = case when p_ok then now() end
     where id = v_chk.id returning * into v_chk;
  else
    return tandem.err('validation', 'Неизвестная операция');
  end if;
  return jsonb_build_object('ok', true, 'fiscal', tandem.fiscal_json(v_chk));
end $$;

-- ---------------------------------------------------------------- снимок схемы (служебное действие гейта)
-- Тот же запрос, что был в db/schema/snapshot-query.sql; файл теперь зовёт эту функцию.
create or replace function tandem.schema_snapshot() returns jsonb
language sql stable security definer set search_path to 'pg_catalog', 'public' as $$
with seqs as (
  select 10 as ord, 'sequence' kind, c.relname::text nm,
    format('create sequence if not exists tandem.%I as %s increment %s minvalue %s maxvalue %s start %s;', c.relname, format_type(s.seqtypid, null), s.seqincrement, s.seqmin, s.seqmax, s.seqstart) sql
  from pg_class c join pg_sequence s on s.seqrelid = c.oid where c.relnamespace = 'tandem'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'i')
), tabs as (
  select 20 as ord, 'table' kind, c.relname::text nm,
    format(E'create table if not exists tandem.%I (\n%s\n);', c.relname,
      (select string_agg(format('  %I %s%s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
          case when a.attidentity = 'a' then ' generated always as identity' when a.attidentity = 'd' then ' generated by default as identity' else '' end,
          case when a.attgenerated = 's' then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored'
               when d.adbin is not null and a.attidentity = '' then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end,
          case when a.attnotnull then ' not null' else '' end), E',\n' order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) sql
  from pg_class c where c.relnamespace = 'tandem'::regnamespace and c.relkind = 'r'
), cons as (
  select case when con.contype = 'f' then 40 else 30 end as ord, 'constraint' kind, c.relname || '.' || con.conname nm,
    format('alter table tandem.%I add constraint %I %s;', c.relname, con.conname, pg_get_constraintdef(con.oid)) sql
  from pg_constraint con join pg_class c on c.oid = con.conrelid
  where c.relnamespace = 'tandem'::regnamespace and con.contype in ('p','u','c','f','x')
), idx as (
  select 35 as ord, 'index' kind, i.indexname::text nm, i.indexdef || ';' sql
  from pg_indexes i where i.schemaname = 'tandem'
    and not exists (select 1 from pg_constraint con join pg_class ic on ic.oid = con.conindid where ic.relname = i.indexname and ic.relnamespace = 'tandem'::regnamespace)
), seqown as (
  select 45 as ord, 'seqowner' kind, s.relname::text nm, format('alter sequence tandem.%I owned by tandem.%I.%I;', s.relname, t.relname, a.attname) sql
  from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S' join pg_class t on t.oid = d.refobjid
  join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
  where d.deptype = 'a' and s.relnamespace = 'tandem'::regnamespace
), fns as (
  select 50 as ord, 'function' kind, p.oid::regprocedure::text nm, pg_get_functiondef(p.oid) || ';' sql
  from pg_proc p where p.prokind = 'f' and (p.pronamespace = 'tandem'::regnamespace or (p.pronamespace = 'public'::regnamespace and p.proname like 'tandem%'))
), views as (
  select 60 as ord, 'view' kind, c.relname::text nm, format(E'create or replace view tandem.%I as\n%s', c.relname, pg_get_viewdef(c.oid, true)) sql
  from pg_class c where c.relnamespace = 'tandem'::regnamespace and c.relkind = 'v'
), trg as (
  select 70 as ord, 'trigger' kind, t.tgname::text nm, pg_get_triggerdef(t.oid) || ';' sql
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'tandem'::regnamespace and not t.tgisinternal
), rls as (
  select 80 as ord, 'rls' kind, c.relname::text nm, format('alter table tandem.%I enable row level security;', c.relname) sql
  from pg_class c where c.relnamespace = 'tandem'::regnamespace and c.relkind = 'r' and c.relrowsecurity
)
select coalesce(jsonb_agg(jsonb_build_object('ord', ord, 'kind', kind, 'nm', nm, 'sql', sql) order by ord, nm), '[]'::jsonb)
from (select * from seqs union all select * from tabs union all select * from cons union all select * from idx
  union all select * from seqown union all select * from fns union all select * from views union all select * from trg union all select * from rls) x
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.schema_snapshot() from anon, authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------- правки существующих функций по якорю
create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  -- уже применено (повторный прогон): проверяется первым - новый текст часто содержит якорь целиком,
  -- и в 0053 повторный прогон такой правки вставлял её второй раз
  if position(p_to in d) > 0 then return; end if;
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0056: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- гейт: служебное действие «снимок схемы»
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$v_service boolean := action in ('migrate','fiscal_config_set',$a$,
  $a$v_service boolean := action in ('migrate','fiscal_config_set','schema_snapshot',$a$);
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$      when 'fiscal_config_set' then tandem.fiscal_config_set(payload)$a$,
  $a$      when 'fiscal_config_set' then tandem.fiscal_config_set(payload)
      when 'schema_snapshot' then tandem.schema_snapshot()$a$);

-- вход кассы: признак учебной точки
select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$,'fiscal_paper',fiscal_paper)$a$,
  $a$,'fiscal_paper',fiscal_paper,'training',coalesce(training,false))$a$);

-- правка чека, который сейчас пробивается
select pg_temp.patch('tandem.check_save(text,jsonb)',
  $a$if v_closed is not null or v_date < v_today - 2 or v_chk.fiscal_status = 'ok' then$a$,
  $a$if v_closed is not null or v_date < v_today - 2 or v_chk.fiscal_status = 'ok'
         or (v_chk.fiscal_status = 'pending' and v_chk.fiscal_at > now() - interval '2 minutes') then$a$);
select pg_temp.patch('tandem.check_save(text,jsonb)',
  $a$'Чек уже пробит в налоговой: исправить его нельзя. Отмените чек (будет чек возврата) и пробейте заново'); end if;$a$,
  $a$'Чек уже пробит в налоговой: исправить его нельзя. Отмените чек (будет чек возврата) и пробейте заново'); end if;
      -- 0056: ответ Webkassa ещё не пришёл - фискальный чек выйдет по прежним строкам
      if v_chk.fiscal_status = 'pending' then
        return jsonb_build_object('ok', false, 'error', 'Чек пробивается в налоговой: исправить его сейчас нельзя. Через минуту отмените его и пробейте заново'); end if;$a$);

-- отмена чека, который сейчас пробивается
select pg_temp.patch('tandem.check_void(text,jsonb)',
  $a$    update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason,$a$,
  $a$    -- 0056: продажа сейчас пробивается в налоговой - отмена подождёт ответа, иначе возврат не встанет в очередь
    if v_chk.fiscal_status = 'pending' and v_chk.fiscal_at > now() - interval '2 minutes' then
      return jsonb_build_object('ok', false, 'error', 'Чек пробивается в налоговой - отмените его через минуту'); end if;
    update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason,$a$);
