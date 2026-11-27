-- 0072: роль «технолог-бухгалтер» (techbuh) - для технолога Тандема (Раиса). По документу Светланы «движение»
-- (27.11.2026) технолог вносит ревизии, приходы и цены, сводит перемещения, ведёт техкарты и номенклатуру, а у роли
-- «технолог» прав на ревизию, приход, перемещение и списание нет. Права новой роли - объединение технолога,
-- кладовщика и бухгалтера (в том числе расходная накладная, 0071), без пользователей, без правки складов и без заявок
-- WhatsApp: это остаётся собственнику и администратору.

alter table tandem.users drop constraint if exists users_role_check;
alter table tandem.users add constraint users_role_check
  check (role = any (array['admin', 'owner', 'accountant', 'technologist', 'storekeeper', 'smm', 'techbuh']));

insert into tandem.role_permissions (role, section, action)
  select distinct 'techbuh', p.section, p.action from tandem.role_permissions p
   where p.role in ('technologist', 'storekeeper', 'accountant')
     and not exists (select 1 from tandem.role_permissions q where q.role = 'techbuh' and q.section = p.section and q.action = p.action);

do $mig$
declare
  v text; n int;
  a1 constant text := $r$jsonb_build_array('admin','owner','accountant','technologist','storekeeper','smm')$r$;
  b1 constant text := $r$jsonb_build_array('admin','owner','accountant','technologist','storekeeper','smm','techbuh') /* 0072 */$r$;
  a2 constant text := $r$v_role not in ('admin','owner','accountant','technologist','storekeeper','smm')$r$;
  b2 constant text := $r$v_role not in ('admin','owner','accountant','technologist','storekeeper','smm','techbuh')$r$;
begin
  v := pg_get_functiondef('tandem.office_users(text,jsonb,tandem.users)'::regprocedure);
  if position('/* 0072 */' in v) = 0 then
    n := (length(v) - length(replace(v, a1, ''))) / length(a1);
    if n <> 1 then raise exception '0072: в office_users список ролей найден % раз', n; end if;
    n := (length(v) - length(replace(v, a2, ''))) / length(a2);
    if n <> 1 then raise exception '0072: в office_users проверка роли найдена % раз', n; end if;
    execute replace(replace(v, a1, b1), a2, b2);
  end if;
end $mig$;
