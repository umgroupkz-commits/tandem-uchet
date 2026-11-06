-- 0053: фискализация кассы через Webkassa и НТИН (решение клиента 30.10.2026).
-- Устройство: docs/superpowers/specs/2026-10-30-fiscal-webkassa-design.md, контракт API: docs/webkassa-api.md.
-- - Фискализация включается у точки (fiscal_enabled + заводской номер кассы Webkassa); без неё касса
--   работает как раньше.
-- - Чек сохраняется как раньше (check_save); затем Edge Function берёт тело запроса Webkassa из
--   fiscal_prepare (гейт, код точки), пробивает его и пишет результат через tandem_fiscal_store - её может
--   вызвать только сервер (service role), иначе касса записала бы себе любой фискальный признак.
-- - Пробитый чек не правится (только отмена = чек возврата); отмена пробитого ставит возврат в очередь.
-- - Логин, пароль и ключ Webkassa - в зашифрованном хранилище Vault (fiscal_config_set по служебному
--   ключу через гейт, чтение - tandem_fiscal_config, только сервер).
-- Существующие функции правятся по якорю из текущего текста в базе (якорь обязан встретиться ровно раз).

alter table tandem.points add column if not exists fiscal_enabled boolean not null default false;
alter table tandem.points add column if not exists fiscal_cashbox text;
alter table tandem.points add column if not exists fiscal_vat numeric;           -- ставка НДС в чеке; пусто - без НДС
alter table tandem.points add column if not exists fiscal_paper smallint not null default 58;  -- 58 или 80 мм

alter table tandem.items add column if not exists ntin text;
alter table tandem.items add column if not exists gtin text;
alter table tandem.items add column if not exists position_type smallint not null default 0;   -- 0 товар, 2 услуга

alter table tandem.checks add column if not exists fiscal_status text;          -- null - не пробивался; ok; error
alter table tandem.checks add column if not exists fiscal_number text;          -- фискальный признак (CheckNumber)
alter table tandem.checks add column if not exists fiscal_dt text;              -- дата-время чека, как вернула Webkassa
alter table tandem.checks add column if not exists fiscal_rnm text;             -- регистрационный номер кассы
alter table tandem.checks add column if not exists fiscal_shift integer;
alter table tandem.checks add column if not exists fiscal_url text;             -- чек на сайте ОФД
alter table tandem.checks add column if not exists fiscal_offline boolean;
alter table tandem.checks add column if not exists fiscal_error text;
alter table tandem.checks add column if not exists fiscal_tries integer not null default 0;
alter table tandem.checks add column if not exists fiscal_at timestamptz;
alter table tandem.checks add column if not exists fiscal_return_status text;   -- pending (отменён, возврат не пробит); ok; error
alter table tandem.checks add column if not exists fiscal_return_number text;
alter table tandem.checks add column if not exists fiscal_return_url text;
alter table tandem.checks add column if not exists fiscal_return_error text;
alter table tandem.checks add column if not exists fiscal_return_at timestamptz;

alter table tandem.daily_reports add column if not exists fiscal_z_at timestamptz;
alter table tandem.daily_reports add column if not exists fiscal_z_shift integer;
alter table tandem.daily_reports add column if not exists fiscal_z_error text;

comment on column tandem.points.fiscal_enabled is '0053: касса точки пробивает фискальные чеки через Webkassa (нужен fiscal_cashbox)';
comment on column tandem.items.ntin is '0053: НТИН из Национального каталога товаров - для товаров на перепродажу уходит в фискальный чек';

-- ---------------------------------------------------------------- тело чека Webkassa
-- Позиции из строк чека: цена прейскуранта и скидка до цены продажи (как в чеке кассы), сумма строки -
-- round(qty * price, 2), как total чека. НДС - по настройке точки, внутри суммы. Строки с нулевой суммой
-- не передаются (Webkassa такие не принимает). Оплата одним способом: наличные 0, карта 1, Kaspi QR и
-- перевод - мобильный платёж 4.
create or replace function tandem.fiscal_body(p_chk tandem.checks, p_op text) returns jsonb
language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_pt  tandem.points;
  v_pos jsonb;
  v_vat numeric;
begin
  select * into v_pt from tandem.points where id = p_chk.point_id;
  v_vat := nullif(v_pt.fiscal_vat, 0);
  select coalesce(jsonb_agg(x.pos order by x.id), '[]'::jsonb) into v_pos from (
    select l.id, jsonb_strip_nulls(jsonb_build_object(
      'Count', l.qty,
      'Price', case when coalesce(l.price_list, 0) > l.price then l.price_list else l.price end,
      'Discount', case when coalesce(l.price_list, 0) > l.price then round(l.price_list * l.qty, 2) - round(l.price * l.qty, 2) else 0 end,
      'Markup', 0,
      'TaxType', case when v_vat is null then 0 else 100 end,
      'TaxPercent', coalesce(v_vat, 0),
      'Tax', case when v_vat is null then 0 else round(round(l.qty * l.price, 2) * v_vat / (100 + v_vat), 2) end,
      'PositionName', left(l.item_name, 250),
      'PositionCode', l.item_code,
      'SectionCode', '1',
      'UnitCode', case coalesce(i.unit_id, i.unit) when 'кг' then 166 when 'л' then 112 else 796 end,
      'PositionType', coalesce(i.position_type, 0),
      'NTIN', nullif(btrim(coalesce(i.ntin, '')), ''),
      'GTIN', nullif(btrim(coalesce(i.gtin, '')), ''),
      'WarehouseType', 0)) pos
    from tandem.check_lines l left join tandem.items i on i.code = l.item_code
    where l.check_id = p_chk.id and round(l.qty * l.price, 2) > 0) x;
  return jsonb_strip_nulls(jsonb_build_object(
    'CashboxUniqueNumber', v_pt.fiscal_cashbox,
    'OperationType', case when p_op = 'return' then 3 else 2 end,
    'Positions', v_pos,
    'Payments', jsonb_build_array(jsonb_build_object('Sum', p_chk.total,
       'PaymentType', case p_chk.pay_kind when 'cash' then 0 when 'card' then 1 else 4 end)),
    'RoundType', 0,
    'ExternalCheckNumber', p_chk.uid::text || case when p_op = 'return' then ':r' else '' end,
    'ExternalOrderNumber', p_chk.point_id || '-' || to_char(p_chk.check_date, 'YYYYMMDD') || '-' || p_chk.no,
    'ReturnBasisDetails', case when p_op = 'return' then jsonb_build_object(
       'CheckNumber', p_chk.fiscal_number, 'DateTime', p_chk.fiscal_dt, 'RegistrationNumber', p_chk.fiscal_rnm,
       'Total', p_chk.total, 'IsOffline', coalesce(p_chk.fiscal_offline, false)) end));
end $$;

-- ---------------------------------------------------------------- подготовка (касса, код точки)
-- op: sale - пробить чек; return - возврат отменённого пробитого; print - номер для печатной формы;
-- x, z - отчёты смены. Точка без фискализации - {ok, skip}: касса работает как раньше.
create or replace function tandem.fiscal_prepare(p_point text, payload jsonb) returns jsonb
language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_op  text := coalesce(nullif(payload->>'op', ''), 'sale');
  v_pt  tandem.points;
  v_uid uuid;
  v_chk tandem.checks;
  v_paper int;
begin
  select * into v_pt from tandem.points where id = p_point;
  if not (coalesce(v_pt.fiscal_enabled, false) and v_pt.mode = 'checks' and coalesce(btrim(v_pt.fiscal_cashbox), '') <> '') then
    return jsonb_build_object('ok', true, 'skip', true);
  end if;
  v_paper := case when v_pt.fiscal_paper = 80 then 0 else 3 end;
  if v_op in ('x', 'z') then
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', tandem.local_now()::date);
  end if;
  if v_op not in ('sale', 'return', 'print') then return tandem.err('validation', 'Неизвестная операция кассы'); end if;
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  select * into v_chk from tandem.checks where uid = v_uid and point_id = p_point;
  if v_chk.id is null then return tandem.err('not_found', 'Чек не найден'); end if;
  if v_op = 'print' then
    if v_chk.fiscal_status is distinct from 'ok' then return tandem.err('validation', 'Чек ещё не пробит в налоговой'); end if;
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
      'ext', v_chk.uid::text || case when v_chk.fiscal_return_status = 'ok' and payload->>'which' = 'return' then ':r' else '' end);
  end if;
  if v_op = 'sale' then
    if v_chk.fiscal_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    if v_chk.status <> 'active' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек отменён'); end if;
    if v_chk.total <= 0 then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Сумма чека 0'); end if;
  else
    if v_chk.fiscal_status is distinct from 'ok' then return jsonb_build_object('ok', true, 'skip', true, 'reason', 'Чек не был пробит'); end if;
    if v_chk.fiscal_return_status = 'ok' then
      return jsonb_build_object('ok', true, 'done', true, 'fiscal', tandem.fiscal_json(v_chk));
    end if;
    if v_chk.status <> 'void' then return tandem.err('validation', 'Возврат пробивается для отменённого чека'); end if;
  end if;
  return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'paper', v_paper,
    'shift_hint', v_chk.fiscal_shift, 'body', tandem.fiscal_body(v_chk, v_op));
end $$;

create or replace function tandem.fiscal_json(c tandem.checks) returns jsonb
language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('status', c.fiscal_status, 'number', c.fiscal_number, 'dt', c.fiscal_dt, 'url', c.fiscal_url,
    'shift', c.fiscal_shift, 'offline', c.fiscal_offline, 'error', c.fiscal_error,
    'return_status', c.fiscal_return_status, 'return_number', c.fiscal_return_number,
    'return_url', c.fiscal_return_url, 'return_error', c.fiscal_return_error)
$$;

-- ---------------------------------------------------------------- запись результата (только сервер)
-- p_data - ответ Webkassa на чек (Data) или запись истории смены (Check/History, при повторе с кодом 14).
create or replace function public.tandem_fiscal_store(p_point text, p_uid uuid, p_op text, p_ok boolean, p_data jsonb, p_error text)
returns jsonb language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_chk tandem.checks;
  v_num text := coalesce(p_data->>'CheckNumber', p_data->>'Number');
  v_url text := p_data->>'TicketUrl';
begin
  if p_op = 'z' then
    update tandem.daily_reports set fiscal_z_at = case when p_ok then now() else fiscal_z_at end,
           fiscal_z_shift = case when p_ok then coalesce((p_data->>'ShiftNumber')::int, fiscal_z_shift) else fiscal_z_shift end,
           fiscal_z_error = case when p_ok then null else left(p_error, 500) end
     where point_id = p_point and report_date = coalesce((p_data->>'report_date')::date, tandem.local_now()::date);
    return jsonb_build_object('ok', true);
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
      fiscal_tries = fiscal_tries + 1, fiscal_at = now()
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

-- ---------------------------------------------------------------- настройки Webkassa в Vault
-- Записать - служебное действие гейта fiscal_config_set (по служебному ключу; значения в ответ не
-- возвращаются). Прочитать - только сервер (service role).
create or replace function tandem.fiscal_config_set(payload jsonb) returns jsonb
language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare k text; v text; v_id uuid; v_set text[] := '{}';
begin
  foreach k in array array['base', 'api_key', 'login', 'password', 'mode'] loop
    v := nullif(btrim(coalesce(payload->>k, '')), '');
    if v is null then continue; end if;
    select id into v_id from vault.secrets where name = 'webkassa_' || k;
    if v_id is null then perform vault.create_secret(v, 'webkassa_' || k, 'Webkassa: ' || k || ' (0053)');
    else perform vault.update_secret(v_id, v); end if;
    v_set := v_set || k;
  end loop;
  return jsonb_build_object('ok', true, 'set', to_jsonb(v_set));
end $$;

-- На своём сервере Vault нет: там настройки Webkassa - переменные окружения прокси (функция вернёт {}).
create or replace function public.tandem_fiscal_config() returns jsonb
language plpgsql stable security definer set search_path to 'tandem', 'public' as $$
declare v jsonb;
begin
  if to_regclass('vault.decrypted_secrets') is null then return '{}'::jsonb; end if;
  execute $q$select coalesce(jsonb_object_agg(substr(name, 10), decrypted_secret), '{}'::jsonb)
                from vault.decrypted_secrets where name like 'webkassa\_%'$q$ into v;
  return v;
end $$;

-- ---------------------------------------------------------------- права (файл самодостаточен)
revoke all on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) from public;
revoke all on function public.tandem_fiscal_config() from public;
revoke all on function tandem.fiscal_config_set(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) from anon, authenticated;
    revoke all on function public.tandem_fiscal_config() from anon, authenticated;
    revoke all on function tandem.fiscal_config_set(jsonb) from anon, authenticated;
    grant execute on function public.tandem_fiscal_store(text, uuid, text, boolean, jsonb, text) to service_role;
    grant execute on function public.tandem_fiscal_config() to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------- правки существующих функций по якорю
create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n = 0 and position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  if n <> 1 then raise exception '0053: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- гейт: служебное действие записи настроек Webkassa
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$v_service boolean := action in ('migrate','test_cleanup',$a$,
  $a$v_service boolean := action in ('migrate','fiscal_config_set','test_cleanup',$a$);
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)$a$,
  $a$      when 'fiscal_config_set' then tandem.fiscal_config_set(payload)
      when 'test_cleanup'   then public.tandem_test_cleanup(v_owner)$a$);

-- API точки: fiscal_prepare по коду точки; признак фискализации при входе
select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$'check_save','check_void','check_list','order_get'$a$,
  $a$'check_save','check_void','check_list','fiscal_prepare','order_get'$a$);
select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$if action in ('check_save','check_void','check_list') then$a$,
  $a$if action in ('check_save','check_void','check_list','fiscal_prepare') then$a$);
select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;$a$,
  $a$    if action = 'fiscal_prepare' then return tandem.fiscal_prepare(v_point, payload); end if;
    if action = 'check_save' then return tandem.check_save(v_point, payload); end if;$a$);
select pg_temp.patch('public.tandem_api(text,jsonb)',
  $a$'point', (select jsonb_build_object('id',id,'name',name,'mode',mode)$a$,
  $a$'point', (select jsonb_build_object('id',id,'name',name,'mode',mode,
                  'fiscal',(fiscal_enabled and mode = 'checks' and coalesce(btrim(fiscal_cashbox), '') <> ''),'fiscal_paper',fiscal_paper)$a$);

-- пробитый чек не правится: только отмена (чек возврата)
select pg_temp.patch('tandem.check_save(text,jsonb)',
  $a$if v_closed is not null or v_date < v_today - 2 then$a$,
  $a$if v_closed is not null or v_date < v_today - 2 or v_chk.fiscal_status = 'ok' then$a$);
select pg_temp.patch('tandem.check_save(text,jsonb)',
  $a$      -- Начало «Смена закрыта» / «Чек слишком старый» не менять: по нему касса узнаёт отказ правки (LOCKED).$a$,
  $a$      -- 0053: пробитый в налоговой чек не меняется - его отменяют (чек возврата) и пробивают новый.
      if v_chk.fiscal_status = 'ok' then
        return jsonb_build_object('ok', false, 'error', 'Чек уже пробит в налоговой: исправить его нельзя. Отмените чек (будет чек возврата) и пробейте заново'); end if;
      -- Начало «Смена закрыта» / «Чек слишком старый» не менять: по нему касса узнаёт отказ правки (LOCKED).$a$);
-- отмена пробитого чека ставит чек возврата в очередь
select pg_temp.patch('tandem.check_void(text,jsonb)',
  $a$update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason where id = v_chk.id;$a$,
  $a$update tandem.checks set status = 'void', updated_at = now(), void_reason = v_reason,
           fiscal_return_status = case when fiscal_status = 'ok' then 'pending' end where id = v_chk.id;$a$);
-- список чеков кассы: фискальные поля
select pg_temp.patch('tandem.check_list(text,date)',
  $a$'late', coalesce(c.created_at > r.closed_at, false),$a$,
  $a$'late', coalesce(c.created_at > r.closed_at, false),
        'fiscal', case when c.fiscal_status is not null or c.fiscal_return_status is not null then tandem.fiscal_json(c) end,$a$);
