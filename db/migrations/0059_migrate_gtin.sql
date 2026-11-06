-- 0059: штрихкоды (GTIN) из iiko при каждом обновлении. По GTIN Webkassa сама находит НТИН товара (0057), поэтому
-- клиенту достаточно вписать штрихкоды с упаковки в iiko. Вид переноса 'gtin' (tools/iiko-migrate.mjs): строки
-- {iiko_id, gtin}, пустой gtin - в iiko штрихкода нет. Штрихкод, вписанный в бэк-офисе (gtin_source 'office'),
-- перенос не трогает; свой, iiko-шный, - обновляет и снимает, если в iiko его убрали.
alter table tandem.items add column if not exists gtin_source text;   -- 'iiko' - из переноса, 'office' - вписан в бэк-офисе
update tandem.items set gtin_source = 'iiko' where gtin is not null and gtin_source is null;   -- 42 штрихкода из iiko (30.10)

create or replace function pg_temp.patch(p_fn regprocedure, p_from text, p_to text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_fn); n int;
begin
  if position(p_to in d) > 0 then return; end if;   -- уже применено (повторный прогон)
  n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
  if n <> 1 then raise exception '0059: якорь в % встретился % раз: %', p_fn, n, left(p_from, 80); end if;
  execute replace(d, p_from, p_to);
end $$;

select pg_temp.patch('public.tandem_migrate(text,text,jsonb)',
  $a$
  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));$a$,
  $a$
  elsif p_kind = 'gtin' then
    -- 0059: штрихкоды из iiko; вписанные в бэк-офисе не трогаем
    with inc as (
      select distinct on (id) (x->>'iiko_id')::uuid id, nullif(btrim(coalesce(x->>'gtin', '')), '') gtin
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'iiko_id', '') <> '' and coalesce(btrim(x->>'gtin'), '') ~ '^([0-9]{8,14})?$'
      order by id),
    upd as (
      update tandem.items i set gtin = inc.gtin, gtin_source = case when inc.gtin is null then null else 'iiko' end
      from inc where i.iiko_id = inc.id and coalesce(i.gtin_source, '') <> 'office'
                 and i.gtin is distinct from inc.gtin
      returning 1)
    select count(*) into v_upd from upd;
    return jsonb_build_object('ok', true, 'updated', v_upd, 'skipped', v_total - v_upd);

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));$a$);

-- штрихкод, вписанный в карточке позиции, - «из бэк-офиса»: перенос из iiko его больше не перепишет
select pg_temp.patch('tandem.office_nomenclature(text,jsonb,tandem.users)',
  $a$        gtin = case when payload ? 'gtin' then nullif(btrim(payload->>'gtin'), '') else gtin end,$a$,
  $a$        gtin = case when payload ? 'gtin' then nullif(btrim(payload->>'gtin'), '') else gtin end,
        gtin_source = case when payload ? 'gtin' and nullif(btrim(payload->>'gtin'), '') is distinct from gtin
                           then case when nullif(btrim(payload->>'gtin'), '') is null then null else 'office' end else gtin_source end,$a$);
