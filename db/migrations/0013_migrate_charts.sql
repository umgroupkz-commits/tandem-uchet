-- Перенос из iiko: техкарты и цены закупа. Функция пересоздаётся целиком —
-- к прежним видам (groups/stores/counteragents/items) добавлены три:
--   chart_candidates — список блюд и полуфабрикатов, для которых имеет смысл тянуть карты;
--   charts           — сами карты со строками состава (версии по датам);
--   costs            — цена последнего закупа в items.cost_*.
create or replace function public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
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
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name, nullif(x->>'organization_id','')::uuid org,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
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
      select distinct on (id) (x->>'id')::uuid id, x->>'name' name,
             case when x->>'kind' in ('supplier','customer','employee') then x->>'kind' else 'other' end kind,
             nullif(x->>'bin','') bin, nullif(x->>'phone','') phone,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
      order by id, deleted
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
    -- inc убирает дубли по id, inc2 — дубли по code (в обоих случаях живая строка побеждает
    -- удалённую): без этого две строки одной пачки с одинаковым ключом обе метят в insert
    -- и падают сырой ошибкой unique_violation вместо {ok:false,...}.
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, x->>'code' code, x->>'name' name, nullif(x->>'artikul','') artikul,
             nullif(x->>'group_id','')::uuid group_id,
             case when x->>'unit' in ('шт','кг','л','порц') then x->>'unit' else 'шт' end unit,
             case when x->>'type' in ('goods','dish','prepared','service') then x->>'type' else 'dish' end typ,
             coalesce((x->>'deleted')::boolean,false) deleted,
             nullif(x->>'price','')::numeric price
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'id','') <> '' and coalesce(x->>'code','') <> ''
      order by id, deleted
    ),
    inc2 as (
      select distinct on (code) * from inc order by code, deleted
    ),
    upd_id as (
      update tandem.items i set name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id = inc2.id and i.source in ('iiko_migrate','iiko_api') returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc2.id, name = inc2.name, artikul = coalesce(inc2.artikul, i.artikul),
             group_id = inc2.group_id, unit_id = inc2.unit, unit = inc2.unit, item_type = inc2.typ,
             active = not inc2.deleted, synced_at = now()
      from inc2 where i.iiko_id is null and i.iiko_code = inc2.code
                  and i.source in ('iiko_migrate','iiko_api') returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc2.code, inc2.name, inc2.artikul, inc2.code, inc2.id, inc2.group_id, inc2.unit, inc2.unit,
             case when inc2.unit in ('кг','л') then 0.5 else 1 end,
             inc2.typ, upper(inc2.typ), inc2.price, not inc2.deleted, false, 'iiko_migrate', now()
      from inc2
      where not exists (select 1 from tandem.items i where i.iiko_id = inc2.id or i.code = inc2.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  elsif p_kind = 'chart_candidates' then
    -- по каким позициям вообще имеет смысл спрашивать карты у iiko
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'iiko_id', iiko_id) order by code), '[]'::jsonb)
      from tandem.items where active and iiko_id is not null and item_type in ('dish','prepared')));

  elsif p_kind = 'charts' then
    -- по одной карте: строки состава сопоставляются по items.iiko_id, неизвестные ингредиенты
    -- пропускаются и называются в ответе; пересекающиеся версии того же блюда закрываются.
    -- Правило при совпадении date_from — «побеждает первая записанная», а не пришедшая позже:
    -- перенос ничего не удаляет, новая версия уходит в skipped и называется в errors. Так
    -- повторный прогон той же выгрузки идемпотентен, а карту, заведённую в офисе руками
    -- (source <> 'iiko'), перенос из iiko не затирает никогда.
    declare
      v_row jsonb; v_cid uuid; v_code text; v_from date; v_to date; v_out numeric; v_lines jsonb;
      v_bad int; v_skip_lines int := 0; v_unknown text[] := '{}'; v_errors text[] := '{}';
      v_exists uuid; v_exists_src text; v_c record; v_conf record;
    begin
      for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
        v_cid  := nullif(v_row->>'iiko_id','')::uuid;
        v_code := nullif(v_row->>'code','');
        v_from := coalesce(nullif(v_row->>'date_from','')::date, date '2020-01-01');
        v_to   := nullif(v_row->>'date_to','')::date;
        v_out  := coalesce(nullif(v_row->>'output_amount','')::numeric, 1);
        -- карты бывают только у блюд и полуфабрикатов; на сырьё и услуги их не вешаем
        if v_cid is null or v_code is null
           or not exists (select 1 from tandem.items
                           where code = v_code and item_type in ('dish','prepared')) then
          v_skip := v_skip + 1; continue;
        end if;
        if v_out <= 0 then v_out := 1; end if;
        if v_to is not null and v_to < v_from then v_to := null; end if;

        -- известные строки складываем в v_lines, неизвестные считаем и запоминаем
        select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'brutto', (l->>'brutto')::numeric,
                 'netto', (l->>'netto')::numeric, 'output', (l->>'output')::numeric,
                 'sort', coalesce((l->>'sort')::int, 0)) order by coalesce((l->>'sort')::int, 0))
                 filter (where i.code is not null), '[]'::jsonb),
               count(*) filter (where i.code is null)
          into v_lines, v_bad
          from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
          left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid;
        v_skip_lines := v_skip_lines + v_bad;
        if v_bad > 0 then
          -- список неизвестных: без пустых значений, сразу без повторов и не длиннее 20
          select coalesce(array_agg(distinct u), '{}'::text[]) into v_unknown
            from unnest(v_unknown || (
              select coalesce(array_agg(distinct l->>'ingredient_iiko_id'), '{}'::text[])
                from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
                left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid
                where i.code is null and coalesce(l->>'ingredient_iiko_id','') <> '')) u;
          if coalesce(array_length(v_unknown, 1), 0) > 20 then v_unknown := v_unknown[1:20]; end if;
        end if;

        -- строки, где ингредиент — само блюдо, отбрасываем: рекурсия в себя бессмысленна;
        -- они такие же пропущенные строки, как и с неизвестным ингредиентом
        select coalesce(jsonb_agg(x) filter (where x->>'code' is distinct from v_code), '[]'::jsonb),
               count(*) filter (where x->>'code' is not distinct from v_code)
          into v_lines, v_bad
          from jsonb_array_elements(v_lines) x;
        v_skip_lines := v_skip_lines + v_bad;
        if jsonb_array_length(v_lines) = 0 then v_skip := v_skip + 1; continue; end if;

        -- I1: карту, правленную в бэк-офисе, перенос не переписывает. iiko_id у неё остался,
        -- но source стал 'office' — по нему и узнаём: пропускаем и называем в errors.
        select id, source into v_exists, v_exists_src from tandem.charts where iiko_id = v_cid;
        if v_exists is not null and v_exists_src is distinct from 'iiko' then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || ': правлена в офисе');
          end if;
          continue;
        end if;
        -- чужая версия ровно с той же датой начала: не трогаем её и не пишем свою
        select id, source, iiko_id into v_conf from tandem.charts
          where item_code = v_code and date_from = v_from and (v_exists is null or id <> v_exists)
          limit 1;
        if v_conf.id is not null then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then
            v_errors := v_errors || (v_cid::text || case when v_conf.source is distinct from 'iiko'
              then ': совпадает с картой офиса'
              else ': дубль даты начала с ' || coalesce(v_conf.iiko_id::text, '?') end);
          end if;
          continue;
        end if;

        -- ниже всё пишущее: одна кривая карта не должна ронять всю пачку
        begin
          -- пересечения с другими версиями того же блюда: ранние закрываем днём раньше нашего
          -- начала, из-за поздних укорачиваем себя; равное начало отсеяно выше
          for v_c in select id, date_from, date_to from tandem.charts
                     where item_code = v_code and (v_exists is null or id <> v_exists)
                       and daterange(date_from, date_to, '[]') && daterange(v_from, v_to, '[]') loop
            if v_c.date_from < v_from then
              update tandem.charts set date_to = v_from - 1, updated_at = now() where id = v_c.id;
            elsif v_c.date_from > v_from then
              v_to := least(coalesce(v_to, v_c.date_from - 1), v_c.date_from - 1);
            end if;
            -- равных начал здесь не бывает; если бы вдруг были, запись упрётся
            -- в charts_no_overlap и карта уйдёт в errors ниже — данные не пострадают
          end loop;

          -- страховка: сюда не попасть, пока равные начала отсеиваются до блока
          if v_to is not null and v_to < v_from then
            v_skip := v_skip + 1;
          else
            if v_exists is null then
              insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, source, iiko_id)
                values (v_code, v_from, v_to, v_out, nullif(v_row->>'technology',''), 'iiko', v_cid)
                returning id into v_exists;
              v_ins := v_ins + 1;
            else
              update tandem.charts set item_code = v_code, date_from = v_from, date_to = v_to,
                     output_amount = v_out, technology = nullif(v_row->>'technology',''), updated_at = now()
                where id = v_exists;
              delete from tandem.chart_lines where chart_id = v_exists;
              v_upd := v_upd + 1;
            end if;
            insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order)
              select v_exists, x->>'code', coalesce((x->>'brutto')::numeric,0), coalesce((x->>'netto')::numeric,0),
                     coalesce((x->>'output')::numeric,0), coalesce((x->>'sort')::int, 0)
              from jsonb_array_elements(v_lines) x;
          end if;
        exception when exclusion_violation then
          v_skip := v_skip + 1;
          if coalesce(array_length(v_errors, 1), 0) < 20 then v_errors := v_errors || v_cid::text; end if;
        end;
      end loop;

      return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
        'skipped_lines', v_skip_lines, 'unknown', to_jsonb(v_unknown), 'errors', to_jsonb(v_errors));
    end;

  elsif p_kind = 'costs' then
    -- цена закупа из iiko. Перенос ставит только 'iiko_invoice': какой бы source ни пришёл
    -- во входе, чужой меткой он не притворяется. И не перебивает цену, поставленную руками
    -- ('manual') или посчитанную по документу склада ('document') — там источник надёжнее.
    with inc as (
      select distinct on (id) (x->>'iiko_id')::uuid id, (x->>'price')::numeric price,
             nullif(x->>'date','')::date d
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'iiko_id','') <> '' and coalesce(nullif(x->>'price','')::numeric, 0) > 0
      order by id, nullif(x->>'date','')::date desc nulls last
    ),
    upd as (
      update tandem.items i set cost_price = inc.price, cost_date = coalesce(inc.d, current_date),
             cost_source = 'iiko_invoice'
      from inc where i.iiko_id = inc.id
                and (i.cost_source is null or i.cost_source not in ('manual','document'))
      returning 1)
    select count(*) into v_upd from upd;
    return jsonb_build_object('ok', true, 'updated', v_upd, 'skipped', v_total - v_upd);

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Дубли ключей в пачке: ' || sqlerrm);
  when others then
    -- иначе любая непредусмотренная ошибка уходит наружу как 500 прокси и вызывающий
    -- (скрипт переноса) видит невнятный ответ вместо причины
    return jsonb_build_object('ok', false, 'error', 'internal', 'message', sqlerrm);
end $$;

revoke all on function public.tandem_migrate(text,text,jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.tandem_migrate(text,text,jsonb) from anon, authenticated;
    grant execute on function public.tandem_migrate(text,text,jsonb) to service_role;
  end if;
end $$;
