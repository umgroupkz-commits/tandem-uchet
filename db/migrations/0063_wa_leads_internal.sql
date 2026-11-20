-- 0063: служебная переписка вне заявок (20.11.2026). Наталья ведёт в том же WhatsApp и клиентов, и своих:
-- цех, курьера, магазины и точки, куда Енешка сдаёт товар (Шик, Аян, рынок 6 мкр), поставщиков. Бот считал эти
-- разговоры заявками, а ежедневные заявки точек - продажами (один заказ точки попадал и в продажи точки, и в
-- продажи клиента). Теперь разбор ставит им итог internal: в списке раздела они видны с пометкой «служебная»,
-- в сводке (lead_report) не считаются нигде, а их число отдаётся отдельно - internal.

alter table tandem.wa_leads drop constraint if exists wa_leads_outcome_check;
alter table tandem.wa_leads add constraint wa_leads_outcome_check
  check (outcome in ('pending', 'order', 'no_order', 'unclear', 'internal'));

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0063: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- бот может прислать итог internal
select pg_temp.patch('tandem.lead_upsert(jsonb)',
  $a$not in ('order', 'no_order', 'unclear')$a$,
  $a$not in ('order', 'no_order', 'unclear', 'internal')$a$);

-- сводка: служебные разговоры не входят ни в одну цифру
select pg_temp.patch('tandem.office_leads(text,jsonb,tandem.users)',
  $a$episode_start < t1),$a$,
  $a$episode_start < t1 and outcome <> 'internal'),$a$);
-- и считаются отдельно: сколько разговоров не попало в заявки
select pg_temp.patch('tandem.office_leads(text,jsonb,tandem.users)',
  $a$'unclear',    (select count(*) from l where outcome = 'unclear'),$a$,
  $a$'unclear',    (select count(*) from l where outcome = 'unclear'),
        'internal',   (select count(*) from tandem.wa_leads where outcome = 'internal' and episode_start >= t0 and episode_start < t1),$a$);
