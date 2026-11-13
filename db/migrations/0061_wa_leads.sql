-- 0061: заявки из WhatsApp (Енешка, решение Андрея 13.11.2026). Применена 13.11.2026 под именем 0059_wa_leads.sql,
-- до того как в main пришли 0059_migrate_gtin и 0060; содержание то же, повторный прогон ничего не меняет.
-- Бот в тихом режиме не отвечает клиентам, а читает
-- их переписку с оператором: каждое обращение - строка здесь, сразу как клиент написал; когда разговор затих,
-- бот разбирает его моделью и дописывает итог: был ли заказ, что заказали, сумма, почему не заказали.
-- Смотрят раздел «Заявки WhatsApp» СММщики (новая роль smm, только этот раздел), собственник и администратор:
-- сколько людей написало, сколько заказало, время первого обращения - для рекламы.
-- Номер клиента виден полностью (решение Андрея 13.11.2026: нужен СММ для аудиторий Facebook).
-- Воронка - словами СММщицы (13.11.2026): поступило, обработано, в работе, игнор, с других городов, продаж,
-- сумма продаж; плюс «без ответа» - продавец так и не ответил.

create table if not exists tandem.wa_leads (
  id              bigserial primary key,
  dialog_id       text not null,
  episode_start   timestamptz not null,   -- первое сообщение клиента в этом разговоре = время первого обращения
  client_phone    text check (client_phone ~ '^[0-9]{10,15}$'),
  client_name     text,
  lang            text not null default 'ru' check (lang in ('ru', 'kz')),
  first_text      text,
  last_msg_at     timestamptz not null,
  msgs_in         int not null default 0,
  msgs_out        int not null default 0,
  first_reply_at  timestamptz,            -- первый ответ оператора: видно, как быстро отвечают
  source          text,                   -- откуда пришёл (метки в рекламе - когда появятся)
  outcome         text not null default 'pending' check (outcome in ('pending', 'order', 'no_order', 'unclear')),
  stage           text not null default 'in_work' check (stage in ('in_work', 'ignored', 'done')),  -- где разговор: в работе / игнор / итог ясен
  city            text,                   -- город, если клиент его назвал
  other_city      boolean not null default false,  -- не Темиртау и не Караганда
  items           jsonb not null default '[]'::jsonb,
  total           numeric(12,2),          -- сумма заказа: названная оператором, иначе по ценам меню
  total_menu      numeric(12,2),          -- то же по ценам меню (сверка с названной)
  kind            text check (kind in ('delivery', 'pickup')),
  for_date        date,
  reason          text,                   -- почему не заказали
  summary         text,                   -- что произошло, одной-двумя фразами
  analyzed_at     timestamptz,
  model           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (dialog_id, episode_start)
);
create index if not exists wa_leads_episode_idx on tandem.wa_leads (episode_start);
alter table tandem.wa_leads enable row level security;

-- Бот (ключ бота, tandem_gate): обращение появилось или изменилось. Счётчики бот присылает целиком (не прибавкой):
-- повтор того же вызова ничего не портит. Разбор (analysis) - только когда он есть; без него итог прежний.
create or replace function tandem.lead_upsert(payload jsonb) returns jsonb
language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_dialog text := btrim(coalesce(payload->>'dialog_id', ''));
  v_start  timestamptz;
  v_last   timestamptz;
  v_phone  text := nullif(regexp_replace(coalesce(payload->>'phone', ''), '\D', '', 'g'), '');
  v_lang   text := case when payload->>'lang' = 'kz' then 'kz' else 'ru' end;
  a        jsonb := payload->'analysis';
  v_id     bigint;
begin
  if v_dialog = '' or length(v_dialog) > 200 then return tandem.err('validation', 'Нет диалога'); end if;
  begin
    v_start := (payload->>'episode_start')::timestamptz;
    v_last  := coalesce((payload->>'last_msg_at')::timestamptz, v_start);
  exception when others then return tandem.err('validation', 'Неверное время обращения'); end;
  if v_start is null then return tandem.err('validation', 'Нет времени обращения'); end if;
  if v_phone is not null and v_phone !~ '^[0-9]{10,15}$' then v_phone := null; end if;
  if a is not null and (coalesce(a->>'outcome', '') not in ('order', 'no_order', 'unclear')
                        or coalesce(a->>'stage', '') not in ('in_work', 'ignored', 'done')) then
    return tandem.err('validation', 'Итог разбора не из списка');
  end if;

  insert into tandem.wa_leads as l (dialog_id, episode_start, client_phone, client_name, lang, first_text, last_msg_at,
                                    msgs_in, msgs_out, first_reply_at, source)
  values (v_dialog, v_start, v_phone, left(nullif(btrim(payload->>'name'), ''), 200), v_lang,
          left(payload->>'first_text', 1000), v_last,
          greatest(coalesce(tandem.to_num(payload->>'msgs_in'), 0)::int, 0), greatest(coalesce(tandem.to_num(payload->>'msgs_out'), 0)::int, 0),
          nullif(payload->>'first_reply_at', '')::timestamptz, left(nullif(btrim(payload->>'source'), ''), 200))
  on conflict (dialog_id, episode_start) do update set
    client_phone   = coalesce(excluded.client_phone, l.client_phone),
    client_name    = coalesce(excluded.client_name, l.client_name),
    lang           = excluded.lang,
    first_text     = coalesce(l.first_text, excluded.first_text),
    last_msg_at    = greatest(l.last_msg_at, excluded.last_msg_at),
    msgs_in        = greatest(l.msgs_in, excluded.msgs_in),
    msgs_out       = greatest(l.msgs_out, excluded.msgs_out),
    first_reply_at = coalesce(l.first_reply_at, excluded.first_reply_at),
    source         = coalesce(excluded.source, l.source),
    updated_at     = now()
  returning id into v_id;

  if a is not null then
    update tandem.wa_leads set
      outcome     = a->>'outcome',
      stage       = a->>'stage',
      city        = left(nullif(btrim(a->>'city'), ''), 100),
      other_city  = coalesce((a->>'other_city')::boolean, false),
      items       = case when jsonb_typeof(a->'items') = 'array' then a->'items' else '[]'::jsonb end,
      total       = tandem.to_num(a->>'total'),
      total_menu  = tandem.to_num(a->>'total_menu'),
      kind        = case when a->>'kind' in ('delivery', 'pickup') then a->>'kind' end,
      for_date    = case when a->>'for_date' ~ '^\d{4}-\d{2}-\d{2}$' then (a->>'for_date')::date end,
      reason      = left(nullif(btrim(a->>'reason'), ''), 500),
      summary     = left(nullif(btrim(a->>'summary'), ''), 1000),
      model       = left(a->>'model', 100),
      analyzed_at = now(),
      updated_at  = now()
     where id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Раздел «Заявки WhatsApp». Даты - по времени Темиртау (UTC+5): день, в который клиент впервые написал.
create or replace function tandem.office_leads(action text, payload jsonb, v_user tandem.users) returns jsonb
language plpgsql security definer set search_path to 'tandem', 'public' as $$
declare
  v_from date := coalesce(nullif(payload->>'from', '')::date, (now() at time zone 'UTC' + interval '5 hours')::date);
  v_to   date := coalesce(nullif(payload->>'to', '')::date, v_from);
  t0 timestamptz; t1 timestamptz;
begin
  if v_to < v_from then return tandem.err('validation', 'Конец периода раньше начала'); end if;
  if v_to - v_from > 366 then return tandem.err('validation', 'Период не больше года'); end if;
  t0 := (v_from::timestamp - interval '5 hours') at time zone 'UTC';
  t1 := ((v_to + 1)::timestamp - interval '5 hours') at time zone 'UTC';

  if action = 'lead_list' then
    return jsonb_build_object('ok', true, 'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'first_at', l.episode_start, 'last_at', l.last_msg_at, 'phone', l.client_phone, 'name', l.client_name,
        'lang', l.lang, 'first_text', left(l.first_text, 300), 'msgs_in', l.msgs_in, 'msgs_out', l.msgs_out,
        'reply_min', case when l.first_reply_at is not null
                          then greatest(round(extract(epoch from l.first_reply_at - l.episode_start) / 60)::int, 0) end,
        'source', l.source, 'outcome', l.outcome, 'stage', l.stage, 'city', l.city, 'other_city', l.other_city, 'items', l.items, 'total', l.total, 'total_menu', l.total_menu,
        'kind', l.kind, 'for_date', l.for_date, 'reason', l.reason, 'summary', l.summary, 'analyzed_at', l.analyzed_at)
        order by l.episode_start desc)
      from (select * from tandem.wa_leads where episode_start >= t0 and episode_start < t1
             order by episode_start desc limit 3000) l), '[]'::jsonb));
  end if;

  if action = 'lead_report' then
    -- Одна заявка бывает в нескольких строках, как в воронке: обработана и продана, обработана и в игноре.
    -- «В работе» - и то, что модель ещё не разбирала (разговор не затих).
    return (
      with l as (select *, (episode_start at time zone 'UTC' + interval '5 hours')::date as d,
                        (outcome = 'pending' or stage = 'in_work') as is_work
                   from tandem.wa_leads where episode_start >= t0 and episode_start < t1),
      days as (select d, count(*) received,
                      count(*) filter (where first_reply_at is not null) processed,
                      count(*) filter (where is_work) in_work,
                      count(*) filter (where stage = 'ignored') ignored,
                      count(*) filter (where other_city) other_city,
                      count(*) filter (where outcome = 'order') sales,
                      coalesce(sum(total) filter (where outcome = 'order'), 0) revenue,
                      count(*) filter (where first_reply_at is null) no_reply
                 from l group by d)
      select jsonb_build_object('ok', true,
        'received',   (select count(*) from l),
        'processed',  (select count(*) from l where first_reply_at is not null),
        'in_work',    (select count(*) from l where is_work),
        'ignored',    (select count(*) from l where stage = 'ignored'),
        'other_city', (select count(*) from l where other_city),
        'sales',      (select count(*) from l where outcome = 'order'),
        'revenue',    (select coalesce(sum(total), 0) from l where outcome = 'order'),
        'no_reply',   (select count(*) from l where first_reply_at is null),
        'no_order',   (select count(*) from l where outcome = 'no_order'),
        'unclear',    (select count(*) from l where outcome = 'unclear'),
        'avg_check',  (select round(avg(total)) from l where outcome = 'order' and total is not null),
        'reply_median_min', (select round(percentile_cont(0.5) within group (order by extract(epoch from first_reply_at - episode_start) / 60))
                               from l where first_reply_at is not null),
        'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc)
                               from (select reason, count(*) n from l where outcome = 'no_order' and reason is not null
                                      group by reason order by count(*) desc limit 10) r), '[]'::jsonb),
        'days', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'received', received, 'processed', processed,
                                             'in_work', in_work, 'ignored', ignored, 'other_city', other_city, 'sales', sales,
                                             'revenue', revenue, 'no_reply', no_reply) order by d) from days), '[]'::jsonb)));
  end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- Роль «СММ»: только раздел заявок, только смотреть.
alter table tandem.users drop constraint if exists users_role_check;
alter table tandem.users add constraint users_role_check
  check (role in ('admin', 'owner', 'accountant', 'technologist', 'storekeeper', 'smm'));
insert into tandem.role_permissions (role, section, action) values
  ('smm', 'leads', 'view'), ('owner', 'leads', 'view'), ('admin', 'leads', 'view')
on conflict do nothing;

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0061: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- бот присылает обращения ключом бота
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$'bot_card_status','bot_client_history');$a$,
  $a$'bot_card_status','bot_client_history','bot_lead_upsert');$a$);
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$      when 'bot_client_history' then tandem.corder_history(payload->>'phone')$a$,
  $a$      when 'bot_client_history' then tandem.corder_history(payload->>'phone')
      when 'bot_lead_upsert'  then tandem.lead_upsert(payload)$a$);

-- раздел бэк-офиса
select pg_temp.patch('public.tandem_office(text,jsonb)',
  $a$    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'$a$,
  $a$    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'
    when action like 'lead%'         then 'leads'$a$);
select pg_temp.patch('public.tandem_office(text,jsonb)',
  $a$  elsif v_section = 'clients' then
    return tandem.office_clients(action, payload, v_user);$a$,
  $a$  elsif v_section = 'clients' then
    return tandem.office_clients(action, payload, v_user);
  elsif v_section = 'leads' then
    return tandem.office_leads(action, payload, v_user);$a$);

-- роль smm в разделе «Пользователи»
select pg_temp.patch('tandem.office_users(text,jsonb,tandem.users)',
  $a$'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'),$a$,
  $a$'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper','smm'),$a$);
select pg_temp.patch('tandem.office_users(text,jsonb,tandem.users)',
  $a$if v_role not in ('admin','owner','accountant','technologist','storekeeper') then$a$,
  $a$if v_role not in ('admin','owner','accountant','technologist','storekeeper','smm') then$a$);
