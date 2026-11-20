-- 0064: продолжение прошлого заказа (20.11.2026). Клиентка заказала сет 14.11, а 16.11 прислала чек об оплате -
-- второй разговор (больше суток тишины) считался второй продажей на те же 19 000 ₸. Теперь бот видит итог прошлых
-- обращений клиента и ставит такому разговору итог followup: в списке он виден («продолжение заказа»), в сводке
-- не считается нигде - как служебный (0063).

alter table tandem.wa_leads drop constraint if exists wa_leads_outcome_check;
alter table tandem.wa_leads add constraint wa_leads_outcome_check
  check (outcome in ('pending', 'order', 'no_order', 'unclear', 'internal', 'followup'));

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0064: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('tandem.lead_upsert(jsonb)',
  $a$not in ('order', 'no_order', 'unclear', 'internal')$a$,
  $a$not in ('order', 'no_order', 'unclear', 'internal', 'followup')$a$);

select pg_temp.patch('tandem.office_leads(text,jsonb,tandem.users)',
  $a$episode_start < t1 and outcome <> 'internal'),$a$,
  $a$episode_start < t1 and outcome not in ('internal', 'followup')),$a$);
select pg_temp.patch('tandem.office_leads(text,jsonb,tandem.users)',
  $a$'internal',   (select count(*) from tandem.wa_leads where outcome = 'internal' and episode_start >= t0 and episode_start < t1),$a$,
  $a$'internal',   (select count(*) from tandem.wa_leads where outcome = 'internal' and episode_start >= t0 and episode_start < t1),
        'followup',   (select count(*) from tandem.wa_leads where outcome = 'followup' and episode_start >= t0 and episode_start < t1),$a$);
