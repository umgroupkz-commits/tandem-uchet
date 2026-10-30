-- 0055: проверка «Готовности» «Товары без НТИН на точках с фискальным чеком» (0054) не смотрит на учебные
-- точки (points.training): у «Учебной кассы» фискальный чек включён ради тестовой кассы Webkassa, и её меню
-- давало сотни ложных предупреждений.
create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n = 0 and position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  if n <> 1 then raise exception '0055: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$if exists (select 1 from tandem.points where active and fiscal_enabled) then$a$,
  $a$if exists (select 1 from tandem.points where active and fiscal_enabled and not coalesce(training, false)) then$a$);
select pg_temp.patch('tandem.quality_report(tandem.users)',
  $a$exists (select 1 from tandem.points p where p.active and p.fiscal_enabled
$a$,
  $a$exists (select 1 from tandem.points p where p.active and p.fiscal_enabled and not coalesce(p.training, false)
$a$);
