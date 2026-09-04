-- Перенос справочников из iiko. Идемпотентно по iiko_id. Защита — код собственника.
create or replace function public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_total int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    with inc as (
      select (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
    ),
    upd as (
      update tandem.item_groups g set name = inc.name, active = not inc.deleted, sort_order = inc.sort
      from inc where g.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.item_groups (id, name, active, sort_order, iiko_id)
      select inc.id, inc.name, not inc.deleted, inc.sort, inc.id from inc
      where not exists (select 1 from tandem.item_groups g where g.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'stores' then
    with inc as (
      select (x->>'id')::uuid id, x->>'name' name, nullif(x->>'organization_id','')::uuid org,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
    ),
    upd as (
      update tandem.stores s set name = inc.name, organization_id = inc.org, active = not inc.deleted
      from inc where s.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.stores (id, name, organization_id, active, iiko_id)
      select inc.id, inc.name, inc.org, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.stores s where s.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'counteragents' then
    with inc as (
      select (x->>'id')::uuid id, x->>'name' name,
             case when x->>'kind' in ('supplier','customer','employee') then x->>'kind' else 'other' end kind,
             nullif(x->>'bin','') bin, nullif(x->>'phone','') phone,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
    ),
    upd as (
      update tandem.counteragents c set name = inc.name, kind = inc.kind, bin = inc.bin,
             phone = inc.phone, active = not inc.deleted
      from inc where c.iiko_id = inc.id returning 1),
    ins as (
      insert into tandem.counteragents (id, name, kind, bin, phone, active, iiko_id)
      select inc.id, inc.name, inc.kind, inc.bin, inc.phone, not inc.deleted, inc.id from inc
      where not exists (select 1 from tandem.counteragents c where c.iiko_id = inc.id) returning 1)
    select (select count(*) from upd), (select count(*) from ins) into v_upd, v_ins;

  elsif p_kind = 'items' then
    -- три непересекающихся набора: уже привязанные по iiko_id; старые строки по iiko_code; новые.
    with inc as (
      select (x->>'id')::uuid id, x->>'code' code, x->>'name' name, nullif(x->>'artikul','') artikul,
             nullif(x->>'group_id','')::uuid group_id,
             case when x->>'unit' in ('шт','кг','л','порц') then x->>'unit' else 'шт' end unit,
             case when x->>'type' in ('goods','dish','prepared','service') then x->>'type' else 'dish' end typ,
             coalesce((x->>'deleted')::boolean,false) deleted,
             nullif(x->>'price','')::numeric price
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'id','') <> '' and coalesce(x->>'code','') <> ''
    ),
    upd_id as (
      update tandem.items i set name = inc.name, artikul = coalesce(inc.artikul, i.artikul),
             group_id = inc.group_id, unit_id = inc.unit, unit = inc.unit, item_type = inc.typ,
             active = not inc.deleted, price = coalesce(inc.price, i.price), synced_at = now()
      from inc where i.iiko_id = inc.id returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc.id, name = inc.name, artikul = coalesce(inc.artikul, i.artikul),
             group_id = inc.group_id, unit_id = inc.unit, unit = inc.unit, item_type = inc.typ,
             active = not inc.deleted, synced_at = now()
      from inc where i.iiko_id is null and i.iiko_code = inc.code returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc.code, inc.name, inc.artikul, inc.code, inc.id, inc.group_id, inc.unit, inc.unit,
             case when inc.unit in ('кг','л') then 0.5 else 1 end,
             inc.typ, upper(inc.typ), inc.price, not inc.deleted, false, 'iiko_migrate', now()
      from inc
      where not exists (select 1 from tandem.items i where i.iiko_id = inc.id or i.code = inc.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd);
end $$;
revoke all on function public.tandem_migrate(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tandem_migrate(text,text,jsonb) to service_role;
