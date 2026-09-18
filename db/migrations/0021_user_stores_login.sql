-- Кладовщик — только свои склады; вход не выдаёт существование логина.
--
-- 1. tandem.user_stores: за пользователем закрепляются склады. Нет строк — все склады
--    (так остаются администратор, собственник, бухгалтер). Есть строки — складские действия
--    ограничены: документ создаётся, правится, проводится, отменяется и удаляется, только
--    если «свой» склад документа закреплён (приход — склад-получатель, остальные — склад-
--    источник); журнал и карточка показывают документы, касающиеся его складов (входящее
--    перемещение видно, но не проводится им); остатки и движения — только его склады.
--    Проверка — на сервере; экран лишь не предлагает чужое.
-- 2. Вход: блокировка проверяется после crypt и отвечает обычным «Неверный логин или PIN»,
--    пока PIN неверный; пауза 0,3 с на каждой ошибке.
-- Функции пересоздаются целиком из актуальных тел (0018, 0009, 0004 — сверены md5 с базой).

create table if not exists tandem.user_stores (
  user_id  uuid not null references tandem.users(id)  on delete cascade,
  store_id uuid not null references tandem.stores(id) on delete cascade,
  primary key (user_id, store_id)
);
alter table tandem.user_stores enable row level security;

create or replace function tandem.user_store_ids(p_user uuid) returns jsonb
language sql stable set search_path to 'tandem','public' as $$
  select coalesce(jsonb_agg(store_id order by store_id), '[]'::jsonb)
  from tandem.user_stores where user_id = p_user
$$;

-- Склад, от имени которого действует документ: у прихода — получатель, у прочих — источник.
create or replace function tandem.doc_own_store(p_type text, p_from uuid, p_to uuid) returns uuid
language sql immutable as $$
  select case when p_type = 'invoice_in' then p_to else p_from end
$$;

-- Можно ли пользователю работать со складом: привязки нет — можно всё.
create or replace function tandem.user_store_ok(p_user uuid, p_store uuid) returns boolean
language sql stable set search_path to 'tandem','public' as $$
  select p_store is null
      or not exists (select 1 from tandem.user_stores where user_id = p_user)
      or exists (select 1 from tandem.user_stores where user_id = p_user and store_id = p_store)
$$;

-- Виден ли документ: касается хотя бы одного из складов пользователя.
create or replace function tandem.user_doc_ok(p_user uuid, p_from uuid, p_to uuid) returns boolean
language sql stable set search_path to 'tandem','public' as $$
  select not exists (select 1 from tandem.user_stores where user_id = p_user)
      or exists (select 1 from tandem.user_stores where user_id = p_user and store_id in (p_from, p_to))
$$;

create or replace function tandem.office_user_json(u tandem.users) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', u.id, 'login', u.login, 'name', u.name, 'role', u.role,
    'store_ids', tandem.user_store_ids(u.id))
$$;

create or replace function tandem.office_users(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public','extensions' as $$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
begin
  if action = 'users_list' then
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at,
                  'store_ids', tandem.user_store_ids(id))
                  order by active desc, name), '[]'::jsonb) from tandem.users),
      'roles', jsonb_build_array('admin','owner','accountant','technologist','storekeeper'));
  end if;

  if action = 'user_save' then
    v_login := lower(btrim(coalesce(payload->>'login','')));
    v_name  := btrim(coalesce(payload->>'name',''));
    v_role  := coalesce(payload->>'role','');
    v_pin   := nullif(payload->>'pin','');
    if v_login !~ '^[a-z0-9_.-]{2,32}$' then return tandem.err('validation', 'Логин: 2–32 латинских буквы, цифры, _ . -'); end if;
    if v_name = '' then return tandem.err('validation', 'Имя пустое'); end if;
    if v_role not in ('admin','owner','accountant','technologist','storekeeper') then
      return tandem.err('validation', 'Роль не из списка');
    end if;
    v_id := nullif(payload->>'id','')::uuid;
    if exists (select 1 from tandem.users where login = v_login and (v_id is null or id <> v_id)) then
      return tandem.err('validation', 'Такой логин уже есть');
    end if;
    if v_id is null then
      if v_pin is null or length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
        return tandem.err('validation', 'PIN — не меньше 4 цифр');
      end if;
      insert into tandem.users (login, name, role, pin_hash, must_change_pin, active)
        values (v_login, v_name, v_role, crypt(v_pin, gen_salt('bf')), true,
                coalesce((payload->>'active')::boolean, true)) returning id into v_id;
    else
      if v_id = v_user.id and coalesce((payload->>'active')::boolean, true) = false then
        return tandem.err('validation', 'Нельзя выключить самого себя');
      end if;
      if exists (select 1 from tandem.users where id = v_id and role = 'admin' and active)
        and (v_role <> 'admin' or coalesce((payload->>'active')::boolean, true) = false)
        and not exists (select 1 from tandem.users where role = 'admin' and active and id <> v_id)
      then
        return tandem.err('validation', 'Нельзя оставить систему без администратора');
      end if;
      update tandem.users set login = v_login, name = v_name, role = v_role,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
      if not coalesce((payload->>'active')::boolean, true) then
        delete from tandem.sessions where user_id = v_id;
      end if;
    end if;
    -- Склады пользователя меняются, только если ключ пришёл: пустой массив снимает привязку.
    if payload ? 'store_ids' then
      if jsonb_typeof(payload->'store_ids') <> 'array' then
        return tandem.err('validation', 'Склады — списком'); end if;
      delete from tandem.user_stores where user_id = v_id;
      insert into tandem.user_stores (user_id, store_id)
        select v_id, x::uuid from jsonb_array_elements_text(payload->'store_ids') x
        on conflict do nothing;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = true,
      failed_attempts = 0, locked_until = null where id = v_id;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function tandem.office_stock(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_id    uuid := nullif(payload->>'id','')::uuid;
  v_type  text;
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_total int;
  v_rows  jsonb;
  v_num   text;
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_code  text := nullif(payload->>'code','');
  v_doc   record;   -- строка документа; имя не d, иначе plpgsql перехватывает алиас d в подзапросах
  v_from  uuid; v_to uuid; v_ca uuid; v_date date; v_reason text;
  v_ext_num text; v_ext_date date;
  v_csv   text; v_sum numeric;
begin
  -- ---------- журнал ----------
  if action = 'docs_list' then
    -- count(*) over () считается до limit, поэтому общее число берётся из max(cnt),
    -- а сама служебная колонка убирается из строк (to_jsonb(x) - 'cnt').
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select d.id, d.number, d.doc_type, d.doc_date, d.status, d.store_from, sf.name as store_from_name,
             d.store_to, st.name as store_to_name, d.counteragent_id, c.name as counteragent_name,
             d.reason, d.comment, d.total_sum, d.ext_number, d.ext_date,
             u.name as created_by_name, d.posted_at,
             count(*) over () as cnt
      from tandem.documents d
      left join tandem.stores sf on sf.id = d.store_from
      left join tandem.stores st on st.id = d.store_to
      left join tandem.counteragents c on c.id = d.counteragent_id
      left join tandem.users u on u.id = d.created_by
      where (nullif(payload->>'doc_type','') is null or d.doc_type = payload->>'doc_type')
        and (v_store is null or d.store_from = v_store or d.store_to = v_store)
        and (nullif(payload->>'status','') is null or d.status = payload->>'status')
        and (nullif(payload->>'date_from','') is null or d.doc_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or d.doc_date <= (payload->>'date_to')::date)
        and (v_q = '' or d.number ilike '%'||v_q||'%' or c.name ilike '%'||v_q||'%' or d.comment ilike '%'||v_q||'%')
        and tandem.user_doc_ok(v_user.id, d.store_from, d.store_to)
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  -- ---------- карточка ----------
  if action = 'doc_get' then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if not tandem.user_doc_ok(v_user.id, v_doc.store_from, v_doc.store_to) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- ext_number/ext_date/source_* приходят в ответ сами: карточка отдаёт to_jsonb(документа).
    return jsonb_build_object('ok', true, 'doc', (
      select to_jsonb(dd) || jsonb_build_object(
        'store_from_name', (select name from tandem.stores where id = dd.store_from),
        'store_to_name', (select name from tandem.stores where id = dd.store_to),
        'counteragent_name', (select name from tandem.counteragents where id = dd.counteragent_id),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'item_code', l.item_code, 'name', i.name,
                    'unit_id', coalesce(l.unit_id, i.unit_id), 'item_type', i.item_type, 'qty', l.qty, 'price', l.price, 'sum', l.sum,
                    'fact_qty', l.fact_qty, 'calc_qty', l.calc_qty, 'note', l.note, 'sort_order', l.sort_order,
                    'current_qty', (select qty from tandem.stock_balances b
                                    where b.store_id = coalesce(dd.store_from, dd.store_to) and b.item_code = l.item_code))
                    order by l.sort_order), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'item'),
        'consume', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'name', i.name, 'unit_id', l.unit_id,
                    'qty', l.qty, 'price', l.price, 'sum', l.sum, 'for_item', l.note) order by l.sort_order, i.name), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'consume'))
      from tandem.documents dd where dd.id = v_id));
  end if;

  -- ---------- сохранение черновика ----------
  if action = 'doc_save' then
    v_type := payload->>'doc_type';
    if v_type is null or v_type not in ('invoice_in','transfer','writeoff','production','inventory') then
      return tandem.err('validation', 'Неизвестный тип документа'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    v_date   := coalesce(nullif(payload->>'doc_date','')::date, current_date);
    v_from   := nullif(payload->>'store_from','')::uuid;
    v_to     := nullif(payload->>'store_to','')::uuid;
    v_ca     := nullif(payload->>'counteragent_id','')::uuid;
    v_reason := nullif(payload->>'reason','');
    -- Накладная поставщика — только у прихода; у прочих типов поля молча обнуляются.
    v_ext_num  := case when v_type = 'invoice_in' then nullif(payload->>'ext_number','') end;
    v_ext_date := case when v_type = 'invoice_in' then nullif(payload->>'ext_date','')::date end;
    if v_type = 'invoice_in' and (v_to is null or v_ca is null) then
      return tandem.err('validation', 'Приходу нужны склад и поставщик'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then
      return tandem.err('validation', 'Перемещению нужны два разных склада'); end if;
    if v_type in ('writeoff','production','inventory') and v_from is null then
      return tandem.err('validation', 'Укажите склад'); end if;
    if v_type = 'writeoff' and v_reason is null then
      return tandem.err('validation', 'Укажите причину списания'); end if;
    if v_type = 'invoice_in' then v_from := null; end if;
    if v_type in ('writeoff','production','inventory') then v_to := null; end if;
    -- Кладовщик с привязкой к складам создаёт документы только от своего склада.
    if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_type, v_from, v_to)) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' then
      return tandem.err('validation', 'Строки не переданы'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'lines') x
               where not exists (select 1 from tandem.items where code = x->>'item_code')) then
      return tandem.err('validation', 'В строках есть неизвестная позиция'); end if;
    if v_id is null then
      v_num := tandem.next_doc_number(v_type, v_date);
      insert into tandem.documents (doc_type, number, doc_date, store_from, store_to, counteragent_id, reason,
                                    comment, ext_number, ext_date, created_by, updated_by)
        values (v_type, v_num, v_date, v_from, v_to, v_ca, v_reason,
                payload->>'comment', v_ext_num, v_ext_date, v_user.id, v_user.id)
        returning id into v_id;
    else
      -- C1: документ берётся под лок до проверки статуса — иначе параллельное проведение
      -- успевало пройти между чтением статуса и перезаписью строк, и проведённый документ
      -- оставался с чужими строками.
      select * into v_doc from tandem.documents where id = v_id for update;
      if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
      if v_doc.status <> 'draft' then
        return tandem.err('validation', 'Проведённый документ не правится — сначала отмените проведение'); end if;
      if v_doc.doc_type <> v_type then return tandem.err('validation', 'Тип документа менять нельзя'); end if;
      -- и чужой черновик не перетащить на свой склад: проверяется и старый склад документа.
      if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
        return tandem.err('forbidden', 'Документ чужого склада'); end if;
      v_num := v_doc.number;
      update tandem.documents set doc_date = v_date, store_from = v_from, store_to = v_to, counteragent_id = v_ca,
        reason = v_reason, comment = payload->>'comment', ext_number = v_ext_num, ext_date = v_ext_date,
        updated_by = v_user.id, updated_at = now() where id = v_id;
      delete from tandem.document_lines where document_id = v_id;
    end if;
    insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, fact_qty, note, sort_order)
      select v_id, x->>'item_code',
             case when v_type = 'inventory' then coalesce(nullif(x->>'fact_qty','')::numeric, 0)
                  else coalesce(nullif(x->>'qty','')::numeric, 0) end,
             i.unit_id, nullif(x->>'price','')::numeric,
             case when v_type = 'inventory' then nullif(x->>'fact_qty','')::numeric end,
             nullif(x->>'note',''), (ord-1)::int
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';
    return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num);
  end if;

  -- ---------- предпросмотр / проведение / отмена / удаление ----------
  if action in ('doc_preview','doc_post','doc_unpost','doc_delete') then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is not null and not tandem.user_store_ok(v_user.id,
         tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
  end if;
  if action = 'doc_preview' then
    if not exists (select 1 from tandem.documents where id = v_id) then
      return tandem.err('not_found', 'Документ не найден'); end if;
    return jsonb_build_object('ok', true) || tandem.doc_preview(v_id);
  end if;
  if action = 'doc_post'   then return tandem.doc_post(v_id, v_user);   end if;
  if action = 'doc_unpost' then return tandem.doc_unpost(v_id, v_user); end if;
  if action = 'doc_delete' then
    -- C1: тот же лок, что и в doc_save, плюс status = 'draft' в самом delete —
    -- проведённый документ не может быть удалён даже при гонке с doc_post.
    select * into v_doc from tandem.documents where id = v_id for update;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if v_doc.status <> 'draft' then return tandem.err('validation', 'Удалять можно только черновики'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_doc.doc_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    delete from tandem.documents where id = v_id and status = 'draft';
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
             round(b.qty * b.avg_cost, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    -- Итог считается по всей отобранной выборке, а не по одной странице,
    -- иначе сумма под таблицей меняется при листании.
    select coalesce(sum(round(b.qty * b.avg_cost, 2)), 0) into v_sum
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV — тяжёлая строка на весь список, строится только по явному запросу экспорта.
    if coalesce((payload->>'export')::boolean, false) then
      select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' ||
             coalesce(string_agg(concat_ws(';', replace(s.name, ';', ','), b.item_code, replace(i.name, ';', ','), i.unit_id,
                                           b.qty, b.avg_cost, round(b.qty * b.avg_cost, 2)),
                                 E'\n' order by s.name, i.name), '')
        into v_csv
        from tandem.stock_balances b
        join tandem.stores s on s.id = b.store_id
        join tandem.items i on i.code = b.item_code
        where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
          and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
          and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    else
      v_csv := null;
    end if;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total/200.0)::int, 1), 'total_sum', v_sum, 'csv', v_csv);
  end if;

  if action = 'stock_moves' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name,
             m.qty, m.unit_cost, round(m.qty * m.unit_cost, 2) as sum,
             m.document_id, d.number, d.doc_type, count(*) over () as cnt
      from tandem.stock_moves m
      join tandem.documents d on d.id = m.document_id
      join tandem.stores s on s.id = m.store_id
      join tandem.items i on i.code = m.item_code
      where (v_store is null or m.store_id = v_store) and tandem.user_store_ok(v_user.id, m.store_id)
        and (nullif(payload->>'item_code','') is null or m.item_code = payload->>'item_code')
        and (nullif(payload->>'date_from','') is null or m.move_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or m.move_date <= (payload->>'date_to')::date)
      order by m.posted_at desc, m.id desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int, 1));
  end if;

  if action = 'item_stock' then
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    return jsonb_build_object('ok', true,
      'balances', (select coalesce(jsonb_agg(jsonb_build_object('store_id', b.store_id, 'store_name', s.name,
                             'qty', b.qty, 'avg_cost', b.avg_cost) order by s.name), '[]'::jsonb)
                   from tandem.stock_balances b join tandem.stores s on s.id = b.store_id
                   where b.item_code = v_code and b.qty <> 0 and tandem.user_store_ok(v_user.id, b.store_id)),
      'moves', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code and tandem.user_store_ok(v_user.id, m.store_id) order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_token    text := payload->>'token';
  v_user     tandem.users;
  v_pin      text;
  v_hash     text;
  v_calc     text;
  v_ok       boolean;
  v_section  text;
  v_need     text;
  v_attempts int;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;

    -- crypt считается всегда, отдельными операторами: если сложить всё в одно
    -- выражение, Postgres вправе оборвать вычисление на первом false, и ответ
    -- «такого логина нет» вернётся заметно быстрее ответа «неверный PIN».
    -- Хэш-заглушка — обычный bcrypt-хэш от произвольной строки, не секрет:
    -- он нужен только чтобы crypt было над чем работать.
    v_hash := coalesce(v_user.pin_hash, '$2a$06$nok4o3iwBUM19xMpLFJzoeTS1iAyq43SB1ybN/Yq5Zt2PyGfXmZF6');
    v_calc := crypt(v_pin, v_hash);
    v_ok   := v_user.id is not null and v_calc = v_user.pin_hash;

    -- Блокировка проверяется после crypt и отвечает как обычная ошибка: иначе ответ
    -- «подождите 15 минут» подтверждал бы любому, что такой логин существует. О блокировке
    -- узнаёт только тот, кто ввёл верный PIN. Пауза на каждой ошибке замедляет перебор.
    if v_user.id is not null and v_user.locked_until > now() then
      perform pg_sleep(0.3);
      if v_ok then return tandem.err('unauthorized', 'Слишком много попыток, подождите 15 минут'); end if;
      return tandem.err('unauthorized', 'Неверный логин или PIN');
    end if;

    if not v_ok then
      if v_user.id is not null then
        -- храповик: локом, чей срок уже истёк, счётчик не наследуется, а начинается заново.
        v_attempts := case when v_user.locked_until is not null and v_user.locked_until <= now()
                            then 1 else v_user.failed_attempts + 1 end;
        update tandem.users set
          failed_attempts = v_attempts,
          locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' else null end
        where id = v_user.id;
      end if;
      perform pg_sleep(0.3);
      return tandem.err('unauthorized', 'Неверный логин или PIN');
    end if;

    update tandem.users set failed_attempts = 0, locked_until = null where id = v_user.id;
    delete from tandem.sessions where expires_at < now();
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into tandem.sessions (token, user_id, expires_at)
      values (v_token, v_user.id, now() + interval '12 hours');
    return jsonb_build_object('ok', true, 'token', v_token, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  v_user := tandem.office_session(coalesce(v_token,''));
  if v_user.id is null then
    return tandem.err('unauthorized', 'Войдите заново');
  end if;

  -- I2: временный PIN держится на сервере, а не на доброй воле фронта.
  if v_user.must_change_pin and action not in ('me','logout','change_pin') then
    return tandem.err('forbidden', 'Сначала смените временный PIN');
  end if;

  if action = 'logout' then
    delete from tandem.sessions where token = v_token;
    return jsonb_build_object('ok', true);
  end if;

  if action = 'me' then
    return jsonb_build_object('ok', true, 'user', tandem.office_user_json(v_user),
      'must_change_pin', v_user.must_change_pin, 'permissions', tandem.office_permissions(v_user.role));
  end if;

  if action = 'change_pin' then
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then
      return tandem.err('validation', 'PIN — не меньше 4 цифр');
    end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = false
      where id = v_user.id;
    return jsonb_build_object('ok', true, 'must_change_pin', false);
  end if;

  -- раздел и требуемое право выводятся из имени действия
  v_section := case
    -- Склад стоит первым: doc%/stock% и карточка остатков позиции уходят в него,
    -- иначе item_stock перехватил бы правилом item% раздел номенклатуры.
    when action like 'doc%' or action like 'stock%' or action = 'item_stock' then 'stock'
    when action like 'chart%' or action like 'foodcost%' then 'charts'
    when action like 'group%' or action like 'item%'     then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                      or action like '%\_report' or action like '%\_preview'
                      or action in ('stock_balances','stock_moves','item_stock')
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  if v_section = 'nomenclature' then
    return tandem.office_nomenclature(action, payload, v_user);
  elsif v_section = 'charts' then
    return tandem.office_charts(action, payload, v_user);
  elsif v_section = 'stores' then
    return tandem.office_stores(action, payload, v_user);
  elsif v_section = 'counteragents' then
    return tandem.office_counteragents(action, payload, v_user);
  elsif v_section = 'users' then
    return tandem.office_users(action, payload, v_user);
  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;
exception
  -- Minor: кривой uuid/число/boolean в payload — это ошибка ввода, а не сбой базы.
  when invalid_text_representation then
    return tandem.err('validation', 'Неверный формат поля');
  -- ссылка на несуществующий склад/контрагента/позицию — тоже ошибка ввода, не 500.
  when foreign_key_violation then
    return tandem.err('validation', 'Ссылка на несуществующую запись (склад, контрагент или позиция)');
  -- I4: взаимная блокировка двух проведений — не сбой базы, а «повторите»: одна
  -- транзакция снята Postgres'ом, её документ остался черновиком и проводится заново.
  when deadlock_detected then
    return tandem.err('validation', 'Документ проводится параллельно — повторите');
  -- дата накладной или периода, пришедшая мусором ('31.02.2026', 'вчера').
  when invalid_datetime_format then
    return tandem.err('validation', 'Неверный формат даты');
end $$;

-- ---------------------------------------------------------------- права (файл самодостаточен)
revoke all on function tandem.office_stock(text,jsonb,tandem.users) from public;
revoke all on function tandem.office_users(text,jsonb,tandem.users) from public;
revoke all on function public.tandem_office(text,jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function tandem.office_stock(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function tandem.office_users(text,jsonb,tandem.users) from anon, authenticated;
    revoke all on function public.tandem_office(text,jsonb)             from anon, authenticated;
    grant execute on function public.tandem_office(text,jsonb) to service_role;
  end if;
end $$;
