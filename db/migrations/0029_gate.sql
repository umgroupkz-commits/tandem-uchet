-- Единый вход для всех запросов с сайта: public.tandem_gate(action, payload).
--
-- Зачем. Коды точек, собственника и водителя — короткие (4 цифры), а вход по ним был без
-- ограничения попыток: код подбирался перебором за минуты. Тем же кодом собственника
-- открывались служебные действия (перенос справочников, уборка теста, синхронизации).
-- Что делает gate:
--   1. служебные действия требуют длинного ключа (settings.service_key_hash — sha256 от ключа; ключ случайный, 256 бит, поэтому медленный хэш не нужен) вместо
--      кода собственника; сам код собственника в нижележащую функцию подставляет gate;
--   2. считает неверные коды: 10 за 5 минут по одной точке (или по входу без точки) либо 60
--      за 5 минут по всем — и вход по кодам закрывается на эти 5 минут для всех, включая
--      верный код (иначе ответ на верный код оставался бы подсказкой перебору);
--   3. маршрутизирует действие в прежние функции — их тела не меняются.
-- Прокси (Edge Function uchet, server/proxy.mjs) теперь зовёт только gate: вся логика в базе.
-- Вход бэк-офиса (office_*) идёт мимо счётчика: у него своя блокировка по логину.

create table if not exists tandem.pin_failures (
  id  bigint generated always as identity primary key,
  key text not null,
  at  timestamptz not null default now()
);
create index if not exists pin_failures_key_at on tandem.pin_failures (key, at);
create index if not exists pin_failures_at on tandem.pin_failures (at);
alter table tandem.pin_failures enable row level security;

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
