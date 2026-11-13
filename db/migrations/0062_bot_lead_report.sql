-- 0062: сводка по заявкам WhatsApp для бота (Андрей, 13.11.2026): бот Енешки шлёт её в Telegram-группу СММ каждое
-- утро и по команде /svodka. Те же цифры, что в разделе «Заявки WhatsApp» (office_leads, lead_report), но ключом
-- бота через tandem_gate - без входа в бэк-офис. Только цифры и причины отказов, без номеров клиентов.

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0062: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$'bot_client_history','bot_lead_upsert');$a$,
  $a$'bot_client_history','bot_lead_upsert','bot_lead_report');$a$);
-- office_leads не смотрит на пользователя: права проверяет tandem_gate (ключ бота)
select pg_temp.patch('public.tandem_gate(text,jsonb)',
  $a$      when 'bot_lead_upsert'  then tandem.lead_upsert(payload)$a$,
  $a$      when 'bot_lead_upsert'  then tandem.lead_upsert(payload)
      when 'bot_lead_report'  then tandem.office_leads('lead_report', payload, null::tandem.users)$a$);
