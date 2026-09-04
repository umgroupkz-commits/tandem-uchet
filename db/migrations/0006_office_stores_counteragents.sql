-- Бэк-офис: склады и контрагенты.
create or replace function tandem.office_stores(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_id uuid; v_name text; v_point text;
begin
  if action = 'stores_list' then
    return jsonb_build_object('ok', true,
      'stores', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'point_id', s.point_id, 'point_name', p.name,
          'is_default', (p.default_store_id = s.id), 'active', s.active,
          'organization_id', s.organization_id) order by s.active desc, p.sort_order nulls last, s.name), '[]'::jsonb)
        from tandem.stores s left join tandem.points p on p.id = s.point_id),
      'points', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order), '[]'::jsonb)
        from tandem.points where active));
  end if;

  if action = 'store_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название склада пустое'); end if;
    v_point := nullif(payload->>'point_id','');
    if v_point is not null and not exists (select 1 from tandem.points where id = v_point) then
      return tandem.err('validation', 'Точка не найдена');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.stores (name, point_id, active)
        values (v_name, v_point, coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.stores set name = v_name, point_id = v_point,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Склад не найден'); end if;
      -- отвязанный или выключенный склад не может быть складом по умолчанию
      update tandem.points set default_store_id = null
        where default_store_id = v_id and (v_point is null or id <> v_point or not coalesce((payload->>'active')::boolean, true));
    end if;
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null
       and exists (select 1 from tandem.stores where id = v_id and active) then
      update tandem.points set default_store_id = v_id where id = v_point;
    elsif payload ? 'is_default' and not (payload->>'is_default')::boolean then
      update tandem.points set default_store_id = null where default_store_id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function tandem.office_counteragents(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_id uuid; v_name text; v_kind text;
  v_q text := btrim(coalesce(payload->>'q',''));
  v_page int := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int; v_rows jsonb;
begin
  if action = 'counteragents_list' then
    v_kind := nullif(payload->>'kind','');
    select count(*) into v_total from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || v_q || '%' or c.bin = v_q)
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select c.id, c.name, c.kind, c.bin, c.phone, c.note, c.active
      from tandem.counteragents c
      where (v_q = '' or c.name ilike '%' || v_q || '%' or c.bin = v_q)
        and (v_kind is null or c.kind = v_kind)
        and (payload->>'active' is null or c.active = (payload->>'active')::boolean)
      order by c.active desc, c.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  if action = 'counteragent_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название контрагента пустое'); end if;
    v_kind := coalesce(payload->>'kind','');
    if v_kind not in ('supplier','customer','employee','other') then
      return tandem.err('validation', 'Вид: supplier, customer, employee или other');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.counteragents (name, kind, bin, phone, note, active)
        values (v_name, v_kind, nullif(payload->>'bin',''), nullif(payload->>'phone',''),
                payload->>'note', coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      update tandem.counteragents set name = v_name, kind = v_kind,
        bin = case when payload ? 'bin' then nullif(payload->>'bin','') else bin end,
        phone = case when payload ? 'phone' then nullif(payload->>'phone','') else phone end,
        note = coalesce(payload->>'note', note),
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Контрагент не найден'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
