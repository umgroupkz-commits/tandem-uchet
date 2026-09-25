-- Раздел «Точки» в бэк-офисе: режим экрана точки (в том числе касса), код входа, юрлицо, группы меню —
-- раньше менялись только в базе. Действия в разделе «Склады» (права stores:*): store_points_list, store_point_save.
-- office_stores — тело из 0006 + два действия.

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

  -- Точки продаж: режим экрана точки, код входа, юрлицо, группы меню. Служебные точки теста (zz_*)
  -- не показываются и не правятся. Код точки не отдаётся — только признак «задан»; новый код задаётся явно.
  if action = 'store_points_list' then
    return jsonb_build_object('ok', true,
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'mode', p.mode, 'legal_entity', p.legal_entity, 'active', p.active,
          'sort_order', p.sort_order, 'item_categories', coalesce(to_jsonb(p.item_categories), '[]'::jsonb),
          'store_name', s.name, 'has_pin', coalesce(p.pin, '') <> '') order by p.sort_order, p.name), '[]'::jsonb)
        from tandem.points p left join tandem.stores s on s.id = p.default_store_id
       where p.id not like 'zz\_%'),
      'categories', (select coalesce(jsonb_agg(c order by c), '[]'::jsonb)
        from (select distinct category c from tandem.items where active and for_sale and category is not null) x),
      'legal_entities', (select coalesce(jsonb_agg(distinct legal_entity), '[]'::jsonb) from tandem.points where legal_entity is not null));
  end if;

  if action = 'store_point_save' then
    v_point := btrim(coalesce(payload->>'id', ''));
    v_name := btrim(coalesce(payload->>'name', ''));
    if v_point = '' or v_point like 'zz\_%' then return tandem.err('validation', 'Не указана точка'); end if;
    if v_name = '' then return tandem.err('validation', 'Название точки обязательно'); end if;
    if coalesce(payload->>'mode', '') not in ('position', 'takeout', 'import', 'manual', 'checks') then
      return tandem.err('validation', 'Неизвестный режим точки'); end if;
    if nullif(payload->>'pin', '') is not null then
      if payload->>'pin' !~ '^[0-9]{4,8}$' then
        return tandem.err('validation', 'Код точки — от 4 до 8 цифр'); end if;
      -- Вход на экран точки сначала сверяет код собственника и водителя: совпадение с ними открыло бы
      -- чужую роль. Совпадение с кодом другой точки путает людей.
      if payload->>'pin' in (select value from tandem.settings where key in ('owner_pin', 'driver_pin'))
         or exists (select 1 from tandem.points where pin = payload->>'pin' and id <> v_point) then
        return tandem.err('validation', 'Этот код уже занят — придумайте другой'); end if;
    end if;
    if not exists (select 1 from tandem.points where id = v_point) then
      if v_point !~ '^[a-z][a-z0-9_]{1,30}$' then
        return tandem.err('validation', 'Код новой точки — латиница, цифры и подчёркивание, например eneshka2'); end if;
      if nullif(payload->>'pin', '') is null then return tandem.err('validation', 'Для новой точки задайте код входа'); end if;
      insert into tandem.points (id, name, mode, pin, legal_entity, active, sort_order)
        values (v_point, v_name, payload->>'mode', payload->>'pin', nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
                coalesce((payload->>'active')::boolean, true), coalesce((select max(sort_order) from tandem.points where id not like 'zz\_%'), 0) + 10);
    end if;
    update tandem.points set name = v_name, mode = payload->>'mode',
           legal_entity = nullif(btrim(coalesce(payload->>'legal_entity', '')), ''),
           active = coalesce((payload->>'active')::boolean, active),
           item_categories = case when jsonb_typeof(payload->'item_categories') = 'array'
                                  then array(select jsonb_array_elements_text(payload->'item_categories')) else item_categories end,
           pin = coalesce(nullif(payload->>'pin', ''), pin)
     where id = v_point;
    return jsonb_build_object('ok', true, 'id', v_point);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
