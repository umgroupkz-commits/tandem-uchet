-- 0051: заказы клиентов на кухне. Подтверждённые заказы видны в плане «Склад → Заявки» колонкой
-- «Клиенты» и списком дня; акт производства по ним создаётся на склад точки выдачи (оттуда же
-- их пробивает касса), source_id «<дата>/clients-<точка>-<n>». Такие акты заявки точек не запирают.

alter table tandem.client_orders add column if not exists production_doc uuid references tandem.documents(id) on delete set null;
alter table tandem.client_orders add column if not exists act_at timestamptz;

create or replace function tandem.order_locked(p_for_date date)
 returns boolean language sql stable set search_path to 'tandem', 'public' as $$
  select exists (select 1 from tandem.documents where source_kind = 'orders' and source_id like p_for_date::text || '/%'
                    and source_id not like p_for_date::text || '/clients-%')
$$;

create or replace function tandem.orders_report(p_for_date date)
 returns jsonb language sql stable set search_path to 'tandem', 'public' as $function$
  select jsonb_build_object('ok', true, 'for_date', p_for_date, 'open', tandem.order_open(p_for_date), 'locked', tandem.order_locked(p_for_date),
    'cutoff', coalesce((select value from tandem.settings where key = 'orders_cutoff'), '20:00'),
    'store_id', (select value from tandem.settings where key = 'orders_store_id'),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('point_id', o.point_id, 'point_name', p.name, 'sent_by', o.sent_by,
        'comment', o.comment, 'updated_at', o.updated_at, 'has_store', p.default_store_id is not null,
        'lines', (select count(*) from tandem.order_lines l where l.order_id = o.id)) order by p.sort_order), '[]'::jsonb)
      from tandem.orders o join tandem.points p on p.id = o.point_id where o.for_date = p_for_date),
    'plan', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit', i.unit_id, 'qty', x.q,
        'fact', pl.fact_qty, 'has_chart', tandem.active_chart(x.item_code, p_for_date) is not null, 'by_point', x.byp) order by i.name), '[]'::jsonb)
      from (select l.item_code, sum(l.qty) q, jsonb_object_agg(o.point_id, l.qty) byp
              from tandem.order_lines l join tandem.orders o on o.id = l.order_id
             where o.for_date = p_for_date group by l.item_code) x
      join tandem.items i on i.code = x.item_code
      left join tandem.order_plan pl on pl.for_date = p_for_date and pl.item_code = x.item_code),
    'docs', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'doc_type', d.doc_type, 'status', d.status,
        'source_id', d.source_id) order by d.doc_type, d.number), '[]'::jsonb)
      from tandem.documents d where d.source_kind = 'orders' and d.source_id like p_for_date::text || '/%'),
    -- 0051: заказы клиентов дня — по позициям (колонка «Клиенты») и списком
    'clients', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit', i.unit_id, 'qty', x.q,
        'in_act', x.q_act, 'has_chart', tandem.active_chart(x.item_code, p_for_date) is not null) order by i.name), '[]'::jsonb)
      from (select l.item_code, sum(l.qty) q, coalesce(sum(l.qty) filter (where o.act_at is not null), 0) q_act
              from tandem.client_order_lines l join tandem.client_orders o on o.id = l.order_id
             where o.for_date = p_for_date and o.status = any(tandem.corder_kitchen()) group by l.item_code) x
      join tandem.items i on i.code = x.item_code),
    'client_orders', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'point_id', o.point_id, 'point_name', p.name,
        'kind', o.kind, 'ready_by', to_char(o.ready_by, 'HH24:MI'), 'status', o.status, 'status_name', tandem.corder_status_name(o.status),
        'in_act', o.act_at is not null, 'client_name', o.client_name,
        'lines', (select jsonb_agg(jsonb_build_object('title', l.title, 'qty', l.qty, 'unit', l.unit) order by l.id)
                    from tandem.client_order_lines l where l.order_id = o.id)) order by o.ready_by, o.no), '[]'::jsonb)
      from tandem.client_orders o join tandem.points p on p.id = o.point_id
     where o.for_date = p_for_date and o.status = any(tandem.corder_kitchen())))
$function$;

-- Акт по заказам клиентов: по каждой точке выдачи — один акт производства на её склад на заказы,
-- ещё не попавшие в акт. Позиции без техкарты (покупное) в акт не идут, но заказ отмечается «в акте»,
-- чтобы не висел «после акта». Повторный вызов делает акт только на новые заказы.
create or replace function tandem.corder_make_docs(p_for_date date, p_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  pt     record;
  v_lines jsonb;
  v_r    jsonb;
  v_made int := 0;
  v_skip text := '';
  v_n    int;
begin
  if p_for_date is null then return tandem.err('validation', 'Нужна дата'); end if;
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || p_for_date::text));
  -- документы плана датируются днём плана: окно дат doc_save на время вызова открыто (как в orders_make_docs)
  perform set_config('tandem.orders_docs', '1', true);
  for pt in select o.point_id, p.name, p.default_store_id, array_agg(o.id) ids
              from tandem.client_orders o join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date and o.status = any(tandem.corder_kitchen()) and o.act_at is null
             group by o.point_id, p.name, p.default_store_id, p.sort_order order by p.sort_order loop
    if pt.default_store_id is null then
      v_skip := v_skip || case when v_skip = '' then '' else ', ' end || pt.name; continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'qty', x.q)), '[]'::jsonb) into v_lines
      from (select l.item_code, sum(l.qty) q from tandem.client_order_lines l
             where l.order_id = any(pt.ids) and tandem.active_chart(l.item_code, p_for_date) is not null
             group by l.item_code) x;
    if jsonb_array_length(v_lines) > 0 then
      select count(*) + 1 into v_n from tandem.documents
       where source_kind = 'orders' and source_id like p_for_date::text || '/clients-' || pt.point_id || '-%';
      v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'production', 'doc_date', p_for_date,
               'store_from', pt.default_store_id, 'comment', format('Заказы клиентов «%s» на %s', pt.name, to_char(p_for_date, 'DD.MM.YYYY')),
               'lines', v_lines), p_user);
      if not coalesce((v_r->>'ok')::boolean, false) then
        raise exception using errcode = 'P0001', message = 'Акт по заказам клиентов не создан: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
      update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/clients-' || pt.point_id || '-' || v_n
       where id = (v_r->>'id')::uuid;
      update tandem.client_orders set production_doc = (v_r->>'id')::uuid where id = any(pt.ids);
      v_made := v_made + 1;
    end if;
    update tandem.client_orders set act_at = now() where id = any(pt.ids);
  end loop;
  perform set_config('tandem.orders_docs', '', true);
  return jsonb_build_object('ok', true, 'made', v_made, 'skipped', nullif(v_skip, ''));
end $$;

-- corder_json: признак «в акте».
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('tandem.corder_json(bigint)'::regprocedure);
  n := replace(d, $a$'in_act', false,$a$, $a$'in_act', o.act_at is not null,$a$);
  if n = d then raise exception '0051: якорь in_act в corder_json не найден'; end if;
  execute n;
end $mig$;

-- corder_edit: строки заказа, уже попавшего в акт, не правятся.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('tandem.corder_edit(bigint,jsonb,text,text,text)'::regprocedure);
  if position('act_at' in d) > 0 then raise notice '0051: corder_edit уже знает акт'; return; end if;
  n := replace(d, $a$  if v_big then
    v_q := tandem.corder_check($a$, $a$  if v_big and o.act_at is not null then
    return tandem.err('validation', 'Заказ уже в акте производства — состав и время не правятся'); end if;
  if v_big then
    v_q := tandem.corder_check($a$);
  if n = d then raise exception '0051: якорь правки строк в corder_edit не найден'; end if;
  execute n;
end $mig$;

-- office_corders: кнопка «Акт по заказам клиентов».
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('tandem.office_corders(text,jsonb,tandem.users)'::regprocedure);
  if position('corder_docs_save' in d) > 0 then raise notice '0051: office_corders уже знает акт'; return; end if;
  n := replace(d, $a$  if action = 'corder_status' then$a$, $a$  if action = 'corder_docs_save' then
    if not tandem.office_can(v_user.role, 'doc:production', 'edit') then return tandem.err('forbidden', 'Нет прав на акт производства'); end if;
    return tandem.corder_make_docs(tandem.to_date(payload->>'for_date'), v_user);
  end if;
  if action = 'corder_status' then$a$);
  if n = d then raise exception '0051: якорь office_corders не найден'; end if;
  execute n;
end $mig$;
