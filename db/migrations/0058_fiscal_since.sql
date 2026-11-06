-- 0058: с какого момента точка пробивает фискальные чеки (points.fiscal_since). Чеки, пробитые до включения
-- фискализации, в налоговую не идут: касса не помечает их «не пробит», а Z-отчёт из-за них не останавливается.
-- Проверка «есть не пробитые чеки» перед Z-отчётом теперь в базе (fiscal_prepare, op z), а не только на странице.
alter table tandem.points add column if not exists fiscal_since timestamptz;
update tandem.points set fiscal_since = now() where fiscal_enabled and fiscal_since is null;

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0058: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

-- включили фискальный чек - запомнить когда
select pg_temp.patch('tandem.office_stores(text,jsonb,tandem.users)',
  $a$           fiscal_enabled = coalesce((payload->>'fiscal_enabled')::boolean, fiscal_enabled),$a$,
  $a$           fiscal_since = case when coalesce((payload->>'fiscal_enabled')::boolean, fiscal_enabled) and not fiscal_enabled
                               then now() else fiscal_since end,
           fiscal_enabled = coalesce((payload->>'fiscal_enabled')::boolean, fiscal_enabled),$a$);

-- переменная для проверки ниже
select pg_temp.patch('tandem.fiscal_prepare(text,jsonb)',
  $a$  v_kind text; v_sum numeric; v_ext text; v_m tandem.fiscal_money;$a$,
  $a$  v_kind text; v_sum numeric; v_ext text; v_m tandem.fiscal_money; v_left int;$a$);

-- Z-отчёт: сначала пробить чеки дня (после включения фискализации), иначе они ушли бы в следующую смену Webkassa
select pg_temp.patch('tandem.fiscal_prepare(text,jsonb)',
  $a$  if v_op in ('x', 'z') then
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', tandem.local_now()::date);$a$,
  $a$  if v_op = 'z' then
    select count(*) into v_left from tandem.checks c
     where c.point_id = p_point and c.check_date = tandem.local_now()::date and c.status = 'active' and c.total > 0
       and c.fiscal_status is distinct from 'ok'
       and (c.fiscal_status is not null or c.created_at >= coalesce(v_pt.fiscal_since, '-infinity'::timestamptz));
    if v_left > 0 then
      return jsonb_build_object('ok', false, 'unfiscal', v_left, 'error', 'не пробиты в налоговой чеков - ' || v_left
        || '. Пробейте их в кассе (вкладка «Смена», кнопка у чека) и закройте смену ещё раз');
    end if;
  end if;
  if v_op in ('x', 'z') then
    return jsonb_build_object('ok', true, 'op', v_op, 'cashbox', v_pt.fiscal_cashbox, 'date', tandem.local_now()::date);$a$);

-- список чеков кассы: чек, пробитый до включения фискализации, - «вне налоговой» (status off)
select pg_temp.patch('tandem.check_list(text,date)',
  $a$'fiscal', case when c.fiscal_status is not null or c.fiscal_return_status is not null then tandem.fiscal_json(c) end,$a$,
  $a$'fiscal', case when c.fiscal_status is not null or c.fiscal_return_status is not null then tandem.fiscal_json(c)
                     when c.created_at < (select p.fiscal_since from tandem.points p where p.id = c.point_id)
                     then jsonb_build_object('status', 'off') end,$a$);
