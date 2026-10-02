-- Ежедневные документы глазами людей из iiko (сборка 21, контракт contracts3, исполнитель S-A).
-- Находки — из прохода пяти ролей по песочнице (кладовщик, бухгалтер, технолог, касса, собственник).
-- A1: строка инвентаризации несёт введённую цену (человек или файл iiko: «Сумма с/н» / кол-во). Излишек
--     оценивается по ней, если она > 0, иначе — как раньше (средняя склада / учётная); недостача — как
--     раньше. Проведение цену не затирает, отмена проведения не стирает; сумма строки — по фактически
--     применённой себестоимости разницы (doc_get отдаёт её и отдельно: cost). Без этого ввод остатков
--     дня X из оборотки iiko вставал по учётной цене или по нулю (кладовщик, находка 1).
-- A2: documents.reason = 'opening' — «Ввод начальных остатков (день X)», только у инвентаризации:
--     doc_save принимает его у инвентаризации, новое действие doc_set_opening {id, opening} меняет
--     пометку в любом статусе (движения не меняются: это пометка для отчётов, их правит 0046).
-- A3: причины списания — к spoilage/tasting/staff_meals/other добавлены defect («брак»), hospitality
--     («представительские»), internal («хозяйственные нужды»).
-- B:  «готовым со склада» и у ручных документов: проведённое перемещение на склад по умолчанию активной
--     точки и акт производства на таком складе ставят строки store_ready (источник 'auto'; план заявок —
--     по-прежнему 'orders'; ручные строки не трогаются), сдвигают дату на более раннюю, помечают продажи
--     склада и пересобирают первые 5; ответ doc_post — ready_new, resynced, remaining. Отмена проведения
--     пересчитывает строки 'auto' и 'orders' по оставшимся документам (кладовщик, находка 2: беляши,
--     перемещённые вручную, точка при продаже не списывала, а списывала тесто и фарш второй раз).
-- C:  блокировка инвентаризацией — по позициям: мешает только инвентаризация, пересчитавшая хотя бы одну
--     позицию, которую документ двигает на её складе (строки, расход акта по картам, то, что спишет
--     продажа). Частичный пересчёт пяти позиций больше не держит весь склад (кладовщик, находка 3).
--     Отказ называет инвентаризацию и до трёх пересекающихся позиций.
-- J:  журнал ищет и по № накладной поставщика; в строках — кто провёл, у черновика прихода — сумма строк.
-- K:  doc_save прихода: тот же № накладной у того же поставщика в другом приходе — документ сохраняется,
--     в ответе dup_of {id, number, doc_date, status}.
-- M:  stock_moves: у строки balance_after — остаток пары после движения (по дате, затем по порядку
--     проведения), как «остаток» в карточке товара iiko; список идёт в том же порядке.
-- G:  doc_get: у строк — artikul и group_name, у документа — created_by_name, posted_by_name,
--     counteragent_bin (для печати).
-- Второй круг сборки 21 (контракт contracts4, исполнитель T; технолог, находка 1 — учебные приходы
-- подняли себестоимость настоящих техкарт: курица 1 400 → 1 900 с «Учебного склада кухни»):
-- T1: учебный склад — tandem.stores.training. Приход на него не меняет учётную цену позиции (items.cost_price,
--     cost_date, cost_source) и не пишет prev_cost; отмена такого прихода цену не трогает, а отмена прихода
--     на обычный склад откатывает её только на закупки обычных складов. Остатки, средняя склада, движения
--     и отчёты — как у любого склада. tandem.office_stores (тело из канона): stores_list отдаёт training,
--     store_save принимает его (только при наличии ключа; без ключа — не меняет). Признак включили у склада,
--     приходы которого уже успели поставить учётные цены, — эти цены возвращаются на те, что были бы без
--     учебных приходов (tandem.training_cost_restore, в ответе store_save — costs_restored).
-- Третий круг сборки 21 (контракт contracts5, исполнитель S5; находки кладовщика v21):
-- S5.1 отказы проведения и сохранения называют позиции по названию, а не по коду («Нет действующей техкарты
--      на дату документа: Вода ПФ»): до трёх названий, дальше «и ещё N» (tandem.item_names_text).
-- S5.2 doc_preview (тело из канона) у акта производства отдаёт warnings_charts [{item_code, item_name}] —
--      позиции выпуска (блюда и полуфабрикаты) без действующей на дату документа техкарты: окно «Провести
--      документ?» предупреждает заранее. У строк warnings (и в doc_post, doc_unpost) — item_type.
-- S5.3 documents.first_posted_at — место документа в порядке проведения его дня: время первого проведения,
--      отмена его не сбрасывает (для проведённых до сборки — из posted_at). Движения дня в stock_moves
--      (список и balance_after) и «последние движения» item_stock идут по нему, затем по id движения:
--      исправленный и перепроведённый приход остаётся на своём месте. Себестоимость последующих расходов
--      не пересчитывается — doc_post отвечает later_moves: N (сколько документов с расходом тех же пар
--      склад/позиция, что документ приходует, проведено после него). Исключения встают на время КАЖДОГО
--      своего проведения: инвентаризация (её расчёт — всё проведённое к этому моменту, иначе «остаток после»
--      разошёлся бы с фактом); продажа дня (её пересобирают с каждым чеком — это итог дня на момент последней
--      пересборки, как и было); документ, перепроводимый после инвентаризации того же дня, которая
--      пересчитала его позиции (в её расчёт он не вошёл).
--      Пересборка остатка (rebuild_balance) по-прежнему идёт по id — в порядке, в котором считались цены
--      движений, иначе она разошлась бы с остатком, посчитанным при проведении.
-- S5.4 inv_block отдаёт до трёх мешающих инвентаризаций (list, total, max_date, у каждой — opening);
--      ввод начальных остатков (reason = 'opening') называется днём ввода остатков, без совета отменить
--      его проведение (tandem.inv_block_text — текст отказа doc_post и doc_unpost).
-- S5.5 stock_balances: у строк — artikul (бланк пересчёта печатается с кодом iiko).
-- Тела функций — из db/schema/tandem_full.sql (состояние после 0043) с точечными правками.
-- Миграция применяется повторно без ошибок.

-- ---------------------------------------------------------------- ограничения
-- A2, A3. Причины списания по-прежнему не привязаны к типу документа (так было: проверку держит doc_save),
-- а пометка 'opening' — только у инвентаризации. Текст отказа ограничения в tandem_office прежний —
-- «Причина списания не из списка»: и 'opening', и причины списания проверяет doc_save раньше таблицы.
alter table tandem.documents drop constraint if exists documents_reason_check;
alter table tandem.documents add constraint documents_reason_check check (
  reason is null
  or reason in ('spoilage', 'tasting', 'staff_meals', 'other', 'defect', 'hospitality', 'internal')
  or (reason = 'opening' and doc_type = 'inventory'));

-- B. 'auto' — строку поставил ручной документ (перемещение на склад точки или акт на нём).
alter table tandem.store_ready drop constraint if exists store_ready_source_check;
alter table tandem.store_ready add constraint store_ready_source_check check (source in ('orders', 'manual', 'auto'));

-- T1. Учебный склад: приходы на него не меняют учётные цены (doc_post, doc_unpost ниже). Колонку читают и
-- 0046 («Готовность»), и 0047 (происхождение цены) — поэтому она здесь, в первой из них.
alter table tandem.stores add column if not exists training boolean not null default false;
comment on column tandem.stores.training is
  'Учебный склад: приходы на него не меняют учётные цены позиций (items.cost_price) — для тестирования';

-- S5.3. Место документа среди движений его дня. Ставит doc_post, doc_unpost не сбрасывает.
alter table tandem.documents add column if not exists first_posted_at timestamptz;
comment on column tandem.documents.first_posted_at is
  'Время первого проведения — место документа в порядке движений его дня (stock_moves, balance_after); отмена '
  'проведения не сбрасывает. Инвентаризация, продажа дня и документ, перепроведённый после инвентаризации того '
  'же дня, пересчитавшей его позиции, встают на время нового проведения';
update tandem.documents set first_posted_at = posted_at
 where status = 'posted' and first_posted_at is null and posted_at is not null;

-- ---------------------------------------------------------------- T1: учётные цены от учебных приходов
-- Учётная цена позиции, которую поставил проведённый приход на учебный склад (признак включили уже после
-- проведения, или приход проведён до сборки 21), возвращается на ту, что была бы без учебных приходов.
-- Узнаём такую цену так: источник 'document', и дата и цена совпадают со строкой проведённого прихода на
-- учебный склад, но ни с одной строкой прихода на обычный склад (совпала с обычным — цена и так настоящая).
-- Новая цена — позднейшая по дате из двух: последняя проведённая закупка на обычный склад (дата, затем
-- время проведения — как откат в doc_unpost) и цена, стоявшая до первого проведённого учебного прихода,
-- поставившего цену (его prev_cost), — если она ручная или из iiko: цену «по документу» уже представляет
-- закупка (а документ, которого среди проведённых закупок нет, — не основание). При равенстве дат —
-- закупка. Ни того ни другого — цены нет (null): позиция покажется в «Готовности» как сырьё без цены, и это
-- честнее учебной цены. p_items — какие позиции смотреть (null — все). Ответ — список изменённых
-- [{code, name, was, now}].
create or replace function tandem.training_cost_restore(p_items text[])
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare r record; v_a record; v_b jsonb; v_price numeric; v_date date; v_src text; v_out jsonb := '[]'::jsonb;
begin
  for r in
    select i.code, i.name, i.cost_price, i.cost_date
      from tandem.items i
     where i.cost_source = 'document'
       and (p_items is null or i.code = any(p_items))
       and exists (select 1 from tandem.documents d
                     join tandem.stores s on s.id = d.store_to and s.training
                     join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
                    where d.doc_type = 'invoice_in' and d.status = 'posted'
                      and l.item_code = i.code and d.doc_date = i.cost_date and l.price = i.cost_price)
       and not exists (select 1 from tandem.documents d
                         join tandem.stores s on s.id = d.store_to and not s.training
                         join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
                        where d.doc_type = 'invoice_in' and d.status = 'posted'
                          and l.item_code = i.code and d.doc_date = i.cost_date and l.price = i.cost_price)
     order by i.code
       for update of i
  loop
    -- select into без строк обнуляет переменную: прошлый виток цикла сюда не протекает
    select l.price, d.doc_date into v_a
      from tandem.documents d
      join tandem.stores s on s.id = d.store_to and not s.training
      join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
     where d.doc_type = 'invoice_in' and d.status = 'posted' and l.item_code = r.code and l.price > 0
     order by d.doc_date desc, d.posted_at desc limit 1;
    select l.prev_cost into v_b
      from tandem.documents d
      join tandem.stores s on s.id = d.store_to and s.training
      join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
     where d.doc_type = 'invoice_in' and d.status = 'posted' and l.item_code = r.code and l.prev_cost is not null
     order by d.posted_at, d.number limit 1;
    if v_b is not null and v_b->>'cost_source' is distinct from 'document'
       and (v_a.doc_date is null or coalesce((v_b->>'cost_date')::date, '-infinity'::date) > v_a.doc_date) then
      v_price := (v_b->>'cost_price')::numeric; v_date := (v_b->>'cost_date')::date; v_src := v_b->>'cost_source';
    elsif v_a.doc_date is not null then
      v_price := v_a.price; v_date := v_a.doc_date; v_src := 'document';
    else
      v_price := null; v_date := null; v_src := null;
    end if;
    update tandem.items set cost_price = v_price, cost_date = v_date, cost_source = v_src where code = r.code;
    v_out := v_out || jsonb_build_object('code', r.code, 'name', r.name, 'was', r.cost_price, 'now', v_price);
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------- C: что двигает документ
-- Что спишет продажа на складе в этот день — ровно как doc_post: позиция с действующей картой, которую
-- склад не получает готовой, списывает ингредиенты карты (один уровень), прочее — саму себя.
create or replace function tandem.sale_touch_items(p_store uuid, p_date date, p_items text[])
returns setof text language sql stable set search_path to 'tandem', 'public' as $$
  with x as (
    select distinct u.item_code, tandem.active_chart(u.item_code, p_date) as chart_id,
           exists (select 1 from tandem.store_ready sr where sr.store_id = p_store and sr.item_code = u.item_code
                     and sr.date_from <= p_date) as ready
      from unnest(p_items) u(item_code)
     where u.item_code is not null)
  select x.item_code from x where x.chart_id is null or x.ready
  union
  select cl.ingredient_code from x join tandem.chart_lines cl on cl.chart_id = x.chart_id where not x.ready
$$;

-- Пары (склад, позиция), которые документ двигает. Проведённый — ровно его движения (у инвентаризации
-- позиция без разницы движения не имеет — её отмена ничего не меняет). Черновик — что сдвинет проведение:
-- строки на складах документа, расход акта производства по картам, у продажи — что она спишет.
create or replace function tandem.doc_touch_items(p_doc uuid)
returns table (store_id uuid, item_code text) language sql stable set search_path to 'tandem', 'public' as $$
  select distinct m.store_id, m.item_code
    from tandem.stock_moves m join tandem.documents d on d.id = m.document_id and d.status = 'posted'
   where m.document_id = p_doc and m.qty <> 0
  union
  select s.store_id, l.item_code
    from tandem.documents d
    join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
    cross join lateral unnest(case d.doc_type when 'invoice_in' then array[d.store_to]
                                              when 'transfer' then array[d.store_from, d.store_to]
                                              else array[d.store_from] end) s(store_id)
   where d.id = p_doc and d.status = 'draft' and d.doc_type <> 'sale'
  union
  select d.store_from, pl.item_code
    from tandem.documents d cross join lateral tandem.doc_consume_plan(d.id) pl
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'production'
  union
  select d.store_from, t.item_code
    from tandem.documents d
    cross join lateral tandem.sale_touch_items(d.store_from, d.doc_date,
      array(select l.item_code from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item')) t(item_code)
   where d.id = p_doc and d.status = 'draft' and d.doc_type = 'sale'
$$;

-- S5.1. Названия позиций для текста отказа: в порядке кодов в p_codes (повторы — один раз), до трёх
-- названий, дальше «и ещё N». Позиции нет в номенклатуре — её код. Пусто — null.
create or replace function tandem.item_names_text(p_codes text[])
returns text language sql stable set search_path to 'tandem', 'public' as $$
  with u as (
    select c.code, min(c.ord) as ord from unnest(p_codes) with ordinality c(code, ord)
     where c.code is not null group by c.code
  ), n as (
    select coalesce(i.name, u.code) as name, row_number() over (order by u.ord) as rn, count(*) over () as cnt
      from u left join tandem.items i on i.code = u.code
  )
  select string_agg(n.name, ', ' order by n.rn) filter (where n.rn <= 3)
         || case when max(n.cnt) > 3 then ' и ещё ' || (max(n.cnt) - 3) else '' end
    from n
$$;

-- Проведённые инвентаризации, которые пересчитали хотя бы одну из пар p_stores[i]/p_items[i] и датой
-- позже p_date — или того же дня, но проведены позже p_after (p_after задают при отмене: такая
-- инвентаризация уже включила документ в свой расчёт). Порядок — по дате, затем по времени проведения.
-- Ответ — поля первой из них {id, number, doc_date, same_day, store_name, opening, count, items: «A, B, C
-- и ещё N»} (как раньше) и S5.4: list — до трёх таких объектов, total — сколько инвентаризаций мешает,
-- max_date — самая поздняя их дата (документ этой датой уже проводится). Не мешает ни одна — null.
-- opening — ввод начальных остатков (reason = 'opening', A2).
create or replace function tandem.inv_block(p_stores uuid[], p_items text[], p_date date, p_except uuid, p_after timestamptz)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  with t as (
    select distinct u.s as store_id, u.i as item_code from unnest(p_stores, p_items) u(s, i)
     where u.s is not null and u.i is not null
  ), hit as (
    select inv.id, inv.number, inv.doc_date, inv.posted_at, inv.store_from,
           coalesce(inv.reason = 'opening', false) as opening, il.item_code
      from tandem.documents inv
      join tandem.document_lines il on il.document_id = inv.id and il.line_kind = 'item' and il.fact_qty is not null
      join t on t.store_id = inv.store_from and t.item_code = il.item_code
     where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id is distinct from p_except
       and (inv.doc_date > p_date or (p_after is not null and inv.doc_date = p_date and inv.posted_at > p_after))
  ), f as (
    select v.*, row_number() over (order by v.doc_date, v.posted_at, v.number) as rn,
           count(*) over () as total, max(v.doc_date) over () as max_date
      from (select distinct h.id, h.number, h.doc_date, h.posted_at, h.store_from, h.opening from hit h) v
  ), l as (
    select f.rn, f.total, f.max_date,
           jsonb_build_object('id', f.id, 'number', f.number, 'doc_date', f.doc_date, 'same_day', f.doc_date = p_date,
             'store_name', s.name, 'opening', f.opening, 'count', c.n,
             'items', c.names || case when c.n > 3 then ' и ещё ' || (c.n - 3) else '' end) as j
      from f
      join tandem.stores s on s.id = f.store_from
      cross join lateral (
        select count(*) as n, string_agg(z.name, ', ' order by z.name, z.code) filter (where z.rn <= 3) as names
          from (select i.name, i.code, row_number() over (order by i.name, i.code) as rn
                  from (select distinct h.item_code from hit h where h.id = f.id) h
                  join tandem.items i on i.code = h.item_code) z) c
     where f.rn <= 3
  )
  select (select l1.j from l l1 where l1.rn = 1)
         || jsonb_build_object('total', max(l.total), 'max_date', max(l.max_date), 'list', jsonb_agg(l.j order by l.rn))
    from l
  having count(*) > 0
$$;

-- S5.4. Текст отказа по ответу inv_block: p_unpost = false — проведение (doc_post), true — отмена
-- (doc_unpost). Одна обычная инвентаризация — прежний текст слово в слово. Ввод начальных остатков —
-- «день ввода начальных остатков», без совета отменить его проведение. Мешают несколько — названы все
-- (до трёх, дальше «И ещё N»), совет отменить — только обычным.
create or replace function tandem.inv_block_text(p_blk jsonb, p_unpost boolean)
returns text language plpgsql stable set search_path to 'tandem', 'public' as $$
declare r jsonb; v_parts text[] := '{}'; v_n int := 0; v_open boolean := false; v_more int; v_d text; v_txt text;
begin
  if p_blk is null then return null; end if;
  for r in select x from jsonb_array_elements(coalesce(p_blk->'list', jsonb_build_array(p_blk))) x loop
    v_d := to_char((r->>'doc_date')::date, 'DD.MM.YYYY');
    if coalesce((r->>'opening')::boolean, false) then
      v_open := true;
      v_txt := v_d || ' — день ввода начальных остатков на складе «' || (r->>'store_name') || '» (' || (r->>'number') || '): '
        || case when p_unpost then 'остатки по позициям ' || (r->>'items') || ' введены с учётом этого документа'
                else 'документы раньше этой даты по позициям ' || (r->>'items') || ' не проводятся' end;
    else
      v_n := v_n + 1;
      v_txt := case
        when not p_unpost then 'На складе «' || (r->>'store_name') || '» в инвентаризации ' || (r->>'number')
             || ' от ' || v_d || ' пересчитаны: ' || (r->>'items') || ' — документ датой раньше неё учёл бы их второй раз'
        when not coalesce((r->>'same_day')::boolean, false) then 'После даты этого документа проведена инвентаризация '
             || (r->>'number') || ' от ' || v_d || ' (склад «' || (r->>'store_name') || '»), в ней пересчитаны: '
             || (r->>'items') || ' — её расчётный остаток уже включает этот документ'
        else 'После этого документа проведена инвентаризация ' || (r->>'number') || ' того же дня ('
             || v_d || ', склад «' || (r->>'store_name') || '»), в ней пересчитаны: ' || (r->>'items')
             || ' — её расчётный остаток уже включает этот документ' end;
    end if;
    v_parts := v_parts || v_txt;
  end loop;
  v_more := coalesce((p_blk->>'total')::int, cardinality(v_parts)) - cardinality(v_parts);
  v_txt := array_to_string(v_parts, '. ')
    || case when v_more > 0 then '. И ещё ' || v_more || ' '
              || case when v_more % 10 = 1 and v_more % 100 <> 11 then 'инвентаризация'
                      when v_more % 10 between 2 and 4 and v_more % 100 not between 12 and 14 then 'инвентаризации'
                      else 'инвентаризаций' end
            else '' end;
  v_d := to_char(coalesce((p_blk->>'max_date')::date,
                          (select max((x->>'doc_date')::date) from jsonb_array_elements(coalesce(p_blk->'list', jsonb_build_array(p_blk))) x)),
                 'DD.MM.YYYY');
  if not p_unpost then
    if cardinality(v_parts) = 1 and v_more = 0 and not v_open then
      return v_txt || '. Проведите его датой не раньше ' || v_d || ', уберите эти позиции или сначала отмените её проведение';
    end if;
    return v_txt || '. Проведите документ датой не раньше ' || v_d
      || case when v_n > 0 then ', уберите эти позиции или сначала отмените проведение '
                || (select string_agg(x->>'number', ', ') from jsonb_array_elements(coalesce(p_blk->'list', jsonb_build_array(p_blk))) x
                     where not coalesce((x->>'opening')::boolean, false))
              else ' или уберите эти позиции' end;
  end if;
  if v_open then
    return v_txt || '. Проведение этого документа не отменить — исправление внесите документом датой не раньше ' || v_d;
  end if;
  return v_txt || case when cardinality(v_parts) = 1 and v_more = 0 then '. Сначала отмените её проведение'
                       else '. Сначала отмените их проведение' end;
end $$;

-- ---------------------------------------------------------------- B: строки «готовым»
-- Документ (план заявок 'orders' или ручной 'auto') ручную строку не трогает, а свою или строку другого
-- документа только сдвигает на более раннюю дату — источником становится документ, давший эту дату.
-- Правка человеком ('manual') ставит дату, какую указали. Возвращает число помеченных продаж.
create or replace function tandem.store_ready_set(p_store uuid, p_item text, p_date date, p_source text)
returns integer language plpgsql set search_path to 'tandem', 'public' as $$
declare v_old date; v_src text; v_new date;
begin
  select date_from, source into v_old, v_src from tandem.store_ready where store_id = p_store and item_code = p_item for update;
  if p_source in ('orders', 'auto') then
    if v_src is not null and v_src not in ('orders', 'auto') then return 0; end if;
    if v_old is not null and v_old <= p_date then return 0; end if;
    v_new := p_date;
    insert into tandem.store_ready (store_id, item_code, date_from, source) values (p_store, p_item, v_new, p_source)
      on conflict (store_id, item_code) do update set date_from = excluded.date_from, source = excluded.source;
  else
    v_new := p_date;
    insert into tandem.store_ready (store_id, item_code, date_from, source) values (p_store, p_item, v_new, p_source)
      on conflict (store_id, item_code) do update set date_from = excluded.date_from,
         source = case when excluded.source = 'manual' then 'manual' else tandem.store_ready.source end;
  end if;
  if v_old is not distinct from v_new then return 0; end if;
  return tandem.store_ready_mark(p_store, p_item, least(coalesce(v_old, v_new), v_new),
                                 case when v_old is not null then greatest(v_old, v_new) end);
end $$;

-- Отмена проведения перемещения или акта: строка 'auto'/'orders' пересчитывается по оставшимся
-- проведённым документам — самая ранняя дата; не осталось — строка удаляется. Документы, которые
-- ставят строку: перемещение плана на любой склад; ручное перемещение блюда/полуфабриката на склад
-- по умолчанию активной точки; акт (плана или ручной) на таком складе. Позиция — с действующей на дату
-- документа картой. Ручные строки не трогаются. Возвращает число помеченных продаж.
create or replace function tandem.store_ready_recalc(p_store uuid, p_item text, p_except uuid)
returns integer language plpgsql set search_path to 'tandem', 'public' as $$
declare v_old date; v_src text; v_new date; v_nsrc text; v_point boolean; v_kind boolean;
begin
  select date_from, source into v_old, v_src from tandem.store_ready where store_id = p_store and item_code = p_item for update;
  if v_old is null or v_src not in ('orders', 'auto') then return 0; end if;
  v_point := exists (select 1 from tandem.points p where p.default_store_id = p_store and p.active);
  v_kind  := exists (select 1 from tandem.items i where i.code = p_item and i.item_type in ('dish', 'prepared'));
  select x.doc_date, case when x.source_kind = 'orders' then 'orders' else 'auto' end into v_new, v_nsrc
    from tandem.documents x join tandem.document_lines l on l.document_id = x.id and l.line_kind = 'item'
   where x.status = 'posted' and x.id is distinct from p_except and l.item_code = p_item
     and x.doc_type in ('transfer', 'production')
     and ((x.doc_type = 'transfer' and x.store_to = p_store and (x.source_kind = 'orders' or (v_point and v_kind)))
          or (x.doc_type = 'production' and x.store_from = p_store and v_point))
     and tandem.active_chart(p_item, x.doc_date) is not null
   order by x.doc_date, (x.source_kind is not distinct from 'orders') desc, x.number
   limit 1;
  if v_new is null then
    delete from tandem.store_ready where store_id = p_store and item_code = p_item;
    return tandem.store_ready_mark(p_store, p_item, v_old, null);
  end if;
  -- Отмена не делает позицию готовой раньше прежнего: более ранний документ, который строку не ставил
  -- (проведён до сборки 21, или тогда склад не был складом точки, или у позиции ещё не было карты),
  -- не должен задним числом перекраивать продажи.
  if v_new < v_old then v_new := v_old; v_nsrc := v_src; end if;
  if v_new = v_old then
    if v_nsrc is distinct from v_src then
      update tandem.store_ready set source = v_nsrc where store_id = p_store and item_code = p_item;
    end if;
    return 0;
  end if;
  update tandem.store_ready set date_from = v_new, source = v_nsrc where store_id = p_store and item_code = p_item;
  return tandem.store_ready_mark(p_store, p_item, v_old, v_new);
end $$;

-- Прежнее имя (0040–0043) — теперь то же, что store_ready_recalc: строки плана пересчитываются
-- вместе с ручными документами.
create or replace function tandem.store_ready_orders_recalc(p_store uuid, p_item text, p_except uuid)
returns integer language sql set search_path to 'tandem', 'public' as $$
  select tandem.store_ready_recalc(p_store, p_item, p_except)
$$;

-- ---------------------------------------------------------------- проведение, отмена, продажи, раздел склада
CREATE OR REPLACE FUNCTION tandem.doc_post(p_doc uuid, p_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  d record; l record; c record;
  v_cost numeric; v_sum numeric := 0; v_line_sum numeric; v_calc numeric; v_diff numeric;
  v_chart uuid; v_warn jsonb; v_lines int; v_bad text; v_qty numeric;
  v_prev jsonb; v_upd boolean; v_marked int := 0; v_rstore uuid; v_ready jsonb;
  v_blk jsonb; v_st uuid[]; v_it text[]; v_src text; v_was boolean; v_new jsonb := '[]'::jsonb;
  v_train boolean; v_keep timestamptz; v_now timestamptz; v_later int;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'draft' then return tandem.err('validation', 'Документ уже проведён'); end if;
  -- Перемещение по плану заявок — только после проведённого акта производства этого дня: иначе выпечка
  -- уйдёт с кухни по нулевой или старой цене, а кухня — в минус (0040).
  if d.doc_type = 'transfer' and d.source_kind = 'orders' and exists (select 1 from tandem.documents x
       where x.source_kind = 'orders' and x.source_id = split_part(d.source_id, '/', 1) || '/production' and x.status <> 'posted') then
    return tandem.err('validation', 'Сначала проведите акт производства по плану этого дня'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права проводить документы этого типа');
  end if;
  if d.store_from is not null and not exists (select 1 from tandem.stores where id = d.store_from and active) then
    return tandem.err('validation', 'Склад-источник выключен или не найден'); end if;
  if d.store_to is not null and not exists (select 1 from tandem.stores where id = d.store_to and active) then
    return tandem.err('validation', 'Склад-получатель выключен или не найден'); end if;
  -- Замок склада (0041): инвентаризация берёт его исключительно, прочие документы — совместно. Иначе
  -- документ задним числом, прошедший проверку ниже, дописывал бы движения в момент проведения
  -- параллельной инвентаризации, и её расчётный остаток устаревал бы.
  if d.doc_type = 'inventory' then
    perform pg_advisory_xact_lock(hashtext('tandem.store:' || d.store_from::text));
  else
    perform pg_advisory_xact_lock_shared(hashtext('tandem.store:' || x.s::text))
       from (select unnest(array[d.store_from, d.store_to]) as s order by 1) x where x.s is not null;
  end if;
  -- Проведённая инвентаризация склада более поздней датой уже пересчитала остаток на свой день:
  -- документ раньше неё учёл бы тот же товар второй раз (0041, ревью п. 8). Та же дата не мешает:
  -- документ, проведённый после инвентаризации своего дня, в её расчёт не вошёл и идёт после неё
  -- (расчёт — «на конец дня» из уже проведённого, второй круг V1). Правило то же, что у продаж в sale_sync.
  -- Мешает только инвентаризация, пересчитавшая позицию, которую документ двигает на её складе (С):
  -- строки, расход акта по картам, то, что спишет продажа. Прочие позиции её расчёта не касаются.
  select array_agg(t.store_id), array_agg(t.item_code) into v_st, v_it from tandem.doc_touch_items(p_doc) t;
  -- Текст отказа — tandem.inv_block_text (S5.4): одна обычная инвентаризация — прежние слова; ввод
  -- начальных остатков — «день ввода начальных остатков» без совета отменить; мешают несколько — все.
  v_blk := tandem.inv_block(v_st, v_it, d.doc_date, p_doc, null);
  if v_blk is not null then
    return tandem.err('validation', tandem.inv_block_text(v_blk, false));
  end if;
  select count(*) into v_lines from tandem.document_lines where document_id = p_doc and line_kind = 'item';
  if v_lines = 0 then return tandem.err('validation', 'В документе нет строк'); end if;
  -- Отказы ниже называют позиции по названию в порядке строк, до трёх и «и ещё N» (S5.1): код («10»)
  -- кладовщику ничего не говорит.
  -- Продажу выключение позиции не останавливает: её продали, пока позиция была в работе (0041, ревью п. 35).
  if d.doc_type <> 'sale' then
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad
      from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
     where dl.document_id = p_doc and dl.line_kind = 'item' and not i.active;
    if v_bad is not null then return tandem.err('validation', 'В документе есть выключенные позиции: ' || v_bad); end if;
  end if;
  select tandem.item_names_text(array_agg(x.item_code order by x.o)) into v_bad
    from (select item_code, min(sort_order) as o from tandem.document_lines where document_id = p_doc and line_kind = 'item'
           group by item_code having count(*) > 1) x;
  if v_bad is not null then
    return tandem.err('validation', 'Позиция повторяется в строках документа — объедините строки: ' || v_bad); end if;

  -- Вся построчная проверка — до первой записи: иначе ошибка на второй строке
  -- оставляет движения первой (функция возвращает значение, а не откатывает транзакцию).
  if d.doc_type <> 'inventory' then
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and dl.qty <= 0;
    if v_bad is not null then return tandem.err('validation', 'Количество должно быть больше нуля: ' || v_bad); end if;
  end if;
  if d.doc_type = 'invoice_in' then
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0);
    if v_bad is not null then return tandem.err('validation', 'Укажите цену: ' || v_bad); end if;
  elsif d.doc_type = 'inventory' then
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.fact_qty is null or dl.fact_qty < 0);
    if v_bad is not null then return tandem.err('validation', 'Укажите факт: ' || v_bad); end if;
  elsif d.doc_type = 'production' then
    -- проверки акта — тоже до записи (и до строк «готовым» ниже); сначала тип, потом карты — как раньше
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad
      from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
     where dl.document_id = p_doc and dl.line_kind = 'item' and i.item_type not in ('dish','prepared');
    if v_bad is not null then return tandem.err('validation', 'Выпускать можно только блюда и полуфабрикаты: ' || v_bad); end if;
    select tandem.item_names_text(array_agg(dl.item_code order by dl.sort_order)) into v_bad
      from tandem.document_lines dl
     where dl.document_id = p_doc and dl.line_kind = 'item' and tandem.active_chart(dl.item_code, d.doc_date) is null;
    if v_bad is not null then
      return tandem.err('validation', 'Нет действующей техкарты на дату документа: ' || v_bad);
    end if;
  end if;

  -- Место документа в порядке проведения его дня (S5.3): время первого проведения, отмена его не
  -- сбрасывает — исправленный и перепроведённый приход остаётся там, где был. Исключения встают на время
  -- нового проведения: инвентаризация — её расчёт всё проведённое к этому моменту, иначе её «остаток
  -- после» разошёлся бы с фактом; продажа дня — её пересобирают с каждым чеком, и она итог дня на момент
  -- последней пересборки, а не документ первого чека (как было до сборки); документ, который перепроводят
  -- после инвентаризации того же дня, пересчитавшей его позиции, — в её расчёт он не вошёл.
  v_keep := case when d.doc_type in ('inventory', 'sale') or d.first_posted_at is null then null
                 when tandem.inv_block(v_st, v_it, d.doc_date, p_doc, d.first_posted_at) is not null then null
                 else d.first_posted_at end;

  -- «Готовым со склада» по документам плана заявок (второй круг V4): строку ставит ПРОВЕДЕНИЕ, а не
  -- создание черновика — удалённый или исправленный черновик больше не оставляет склад «готовым».
  -- Перемещение по плану — склад-получатель и его позиции с картой; акт по плану — склад кухни, если он
  -- склад по умолчанию активной точки (Енешка продаёт прямо с кухни). Ручные строки не трогаются.
  -- Стоит до первой записи движений: пересобираемые продажи берут замки отчёт → документ → остатки, как
  -- sale_sync и сохранение отчёта точки; после движений этого документа (замки остатков уже наши) порядок
  -- был бы встречным (второй круг V11). Затронутые продажи помечаются все, пересобираются первые 5.
  -- ВНИМАНИЕ: после этого блока — только записи; новые проверки ставить выше.
  -- Ручные документы (B, сборка 21) — так же, источник 'auto': перемещение блюда/полуфабриката с картой
  -- на склад по умолчанию активной точки и акт на таком складе. Иначе выпечку, перемещённую на точку
  -- вручную, продажа точки не списывала, а списывала её сырьё второй раз. ready_new — позиции, которые
  -- этот документ сделал «готовыми» впервые (строки до него не было).
  if d.doc_type in ('transfer', 'production') then
    v_src := case when d.source_kind = 'orders' then 'orders' else 'auto' end;
    if d.doc_type = 'transfer' then
      if v_src = 'orders' or exists (select 1 from tandem.points where default_store_id = d.store_to and active) then
        v_rstore := d.store_to;
      end if;
    elsif exists (select 1 from tandem.points where default_store_id = d.store_from and active) then
      v_rstore := d.store_from;
    end if;
    if v_rstore is not null then
      for l in select distinct dl.item_code, i.name from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
                where dl.document_id = p_doc and dl.line_kind = 'item'
                  and (v_src = 'orders' or i.item_type in ('dish', 'prepared'))
                  and tandem.active_chart(dl.item_code, d.doc_date) is not null order by dl.item_code loop
        v_was := exists (select 1 from tandem.store_ready where store_id = v_rstore and item_code = l.item_code);
        v_marked := v_marked + tandem.store_ready_set(v_rstore, l.item_code, d.doc_date, v_src);
        if not v_was and exists (select 1 from tandem.store_ready where store_id = v_rstore and item_code = l.item_code) then
          v_new := v_new || jsonb_build_object('store_id', v_rstore, 'store_name', (select name from tandem.stores where id = v_rstore),
                                               'item_code', l.item_code, 'item_name', l.name, 'date_from', d.doc_date);
        end if;
      end loop;
      if v_marked > 0 then v_ready := tandem.store_ready_resync_next(v_rstore, null); end if;
    end if;
  end if;

  -- I4: пишущие циклы идут по item_code, а не по sort_order. Порядок строк в документе
  -- задаёт человек, и два документа с одними позициями в разном порядке брали локи
  -- встречно. По item_code порядок блокировок одинаков у всех документов.
  if d.doc_type = 'invoice_in' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    -- Приход на учебный склад (T1) учётную цену не меняет и prev_cost не пишет: техкарты настоящих блюд
    -- не дорожают от учебных накладных. Остатки и средняя склада — как у любого склада.
    v_train := coalesce((select s.training from tandem.stores s where s.id = d.store_to), false);
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      -- Учётная цена — последняя известная закупка: накладная задним числом и бонусная строка с нулевой
      -- ценой её не перезаписывают (0041, ревью п. 41, 67). Прежняя цена запоминается в строке, если
      -- накладная её меняет: отмена единственной закупки вернёт её (второй круг V9).
      v_prev := null; v_upd := false;
      if l.price > 0 and not v_train then
        select jsonb_build_object('cost_price', cost_price, 'cost_date', cost_date, 'cost_source', cost_source),
               d.doc_date >= coalesce(cost_date, '-infinity'::date)
               and (cost_price is distinct from l.price or cost_date is distinct from d.doc_date
                    or cost_source is distinct from 'document')
          into v_prev, v_upd
          from tandem.items where code = l.item_code for update;
      end if;
      if v_upd then
        update tandem.items set cost_price = l.price, cost_date = d.doc_date, cost_source = 'document'
         where code = l.item_code;
      else
        v_prev := null;
      end if;
      update tandem.document_lines set sum = v_line_sum, prev_cost = v_prev where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'transfer' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      -- Склады блокируются по возрастанию store_id: встречные перемещения не встают во взаимную блокировку.
      if d.store_from < d.store_to then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
      else
        perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      end if;
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'writeoff' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'production' then
    -- проверки типа и карт — в блоке предпроверок выше
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    -- Пары акта (выпуск и расход) заводятся и берутся под лок заранее, одним запросом в порядке
    -- item_code: строки ниже считаются в порядке зависимостей, а не по коду, и без общего лока два
    -- акта брали бы локи встречно (0041, ревью п. 32). do update блокирует и уже существующие строки.
    insert into tandem.stock_balances (store_id, item_code)
      select d.store_from, x.item_code
        from (select dl.item_code from tandem.document_lines dl where dl.document_id = p_doc and dl.line_kind = 'item'
              union select pl.item_code from tandem.doc_consume_plan(p_doc) pl) x
       order by x.item_code
      on conflict (store_id, item_code) do update set updated_at = now();
    -- Полуфабрикат, который расходуют другие строки этого же акта, выпускается раньше них: иначе блюдо
    -- списывало бы его до выпуска, по старой или нулевой цене, и итог зависел от случайного порядка кодов
    -- (ревью п. 32). Глубина строки — самая длинная цепочка «ингредиент → продукт» внутри акта
    -- (ограничена 10 на случай цикла в картах); глубже — раньше.
    for l in
      with recursive acts as (
        select dl.item_code from tandem.document_lines dl where dl.document_id = p_doc and dl.line_kind = 'item'
      ), e as (
        select pl.item_code as ing, dl.item_code as prod
          from tandem.doc_consume_plan(p_doc) pl join tandem.document_lines dl on dl.id = pl.line_id
         where pl.item_code in (select item_code from acts)
      ), w (item_code, depth) as (
        select item_code, 0 from acts
        union all
        select e.ing, w.depth + 1 from w join e on e.prod = w.item_code where w.depth < 10
      )
      select dl.* from tandem.document_lines dl
        join (select item_code, max(depth) as depth from w group by item_code) t on t.item_code = dl.item_code
       where dl.document_id = p_doc and dl.line_kind = 'item'
       order by t.depth desc, dl.item_code
    loop
      v_line_sum := 0;
      for c in select item_code, qty from tandem.doc_consume_plan(p_doc) p where p.line_id = l.id order by item_code loop
        -- Округляем расход один раз: и в строку, и в движение, и в сумму идёт одно и то же число.
        v_qty := round(c.qty, 4);
        v_cost := tandem.store_avg(d.store_from, c.item_code);
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', c.item_code, v_qty, i.unit_id, v_cost, round(v_qty * v_cost, 2), l.item_code, 1000 + l.sort_order
          from tandem.items i where i.code = c.item_code;
        perform tandem.apply_move(p_doc, l.id, d.store_from, c.item_code, -v_qty, v_cost, d.doc_date);
        v_line_sum := v_line_sum + round(v_qty * v_cost, 2);
      end loop;
      v_cost := case when l.qty > 0 then round(v_line_sum / l.qty, 4) else 0 end;
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, l.qty, v_cost, d.doc_date);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'sale' then
    -- Продажа (подпроект 4): у позиции есть действующая на дату карта — списываются её
    -- ингредиенты (один уровень, как в производстве), карты нет — сама позиция. Строка
    -- позиции хранит цену продажи и выручку; сумма документа — себестоимость проданного.
    -- Сначала строки расхода по всем позициям, затем движения одним проходом по item_code:
    -- блокировки остатков берутся в одном порядке у всех документов (0023, ревью п. 3).
    -- Цена расхода берётся до движений: средняя склада от расхода не меняется. Цена считается
    -- один раз на строку (offset 0 не даёт планировщику повторить вызов): store_avg без средней
    -- обходит техкарту.
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- Готовой продаётся позиция, которую этот склад с даты продажи получает готовой (store_ready, 0041,
      -- ревью п. 2 и 38): её сырьё списал акт производства. Решает склад и дата, а не признак позиции.
      if tandem.active_chart(l.item_code, d.doc_date) is not null
         and not exists (select 1 from tandem.store_ready sr where sr.store_id = d.store_from
                           and sr.item_code = l.item_code and sr.date_from <= d.doc_date) then
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          -- Псевдоним pl, а не c: c — переменная цикла ниже, и plpgsql подставил бы её вместо
          -- колонки («record c is not assigned yet» на первой же продаже блюда с картой).
          select p_doc, 'consume', pl.item_code, round(pl.qty, 4), i.unit_id, pc.cost,
                 round(round(pl.qty, 4) * pc.cost, 2), l.item_code, 1000 + l.sort_order
            from tandem.doc_consume_plan(p_doc) pl join tandem.items i on i.code = pl.item_code
            cross join lateral (select tandem.store_avg(d.store_from, pl.item_code) as cost offset 0) pc
           where pl.line_id = l.id;
      else
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', l.item_code, round(l.qty, 4), i.unit_id, pc.cost,
                 round(round(l.qty, 4) * pc.cost, 2), l.item_code, 1000 + l.sort_order
            from tandem.items i
            cross join lateral (select tandem.store_avg(d.store_from, l.item_code) as cost offset 0) pc
           where i.code = l.item_code;
      end if;
      update tandem.document_lines set sum = round(l.qty * coalesce(l.price, 0), 2) where id = l.id;
    end loop;
    for c in select cl.item_code, cl.qty, cl.price, il.id as line_id
               from tandem.document_lines cl
               join tandem.document_lines il on il.document_id = p_doc and il.line_kind = 'item' and il.item_code = cl.note
              where cl.document_id = p_doc and cl.line_kind = 'consume'
              order by cl.item_code, il.item_code loop
      perform tandem.apply_move(p_doc, c.line_id, d.store_from, c.item_code, -c.qty, c.price, d.doc_date);
    end loop;
    select coalesce(sum(sum), 0) into v_sum from tandem.document_lines where document_id = p_doc and line_kind = 'consume';

  elsif d.doc_type = 'inventory' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      -- I4: расчётный остаток читается под локом той же пары, что потом изменит apply_move,
      -- иначе параллельное списание успевало пройти между чтением и записью, и недостача
      -- считалась от остатка, которого уже нет. Лок даёт сам do update.
      insert into tandem.stock_balances (store_id, item_code) values (d.store_from, l.item_code)
        on conflict (store_id, item_code) do update set updated_at = now();
      -- Расчётный остаток — на конец дня акта из уже проведённого, а не текущий: акт, внесённый через
      -- день-два после пересчёта или перепроведённый, не стирает документы после своей даты (0041, ревью
      -- п. 7), а приход и продажи этого дня, проведённые до пересчёта, учтены один раз (второй круг V1).
      v_calc := tandem.stock_qty_at(d.store_from, l.item_code, d.doc_date);
      v_diff := l.fact_qty - v_calc;
      -- Излишек — по цене строки, если её ввели (человек или файл iiko: «Сумма с/н» / кол-во, A1): ввод
      -- остатков дня X встаёт по себестоимости iiko, а не по учётной цене или нулю. Нет цены — и у
      -- недостачи всегда — средняя склада / учётная, как раньше. Цену строки проведение не трогает: это
      -- введённое значение; применённая себестоимость — в движении и в сумме строки.
      v_cost := case when v_diff > 0 and l.price > 0 then l.price else tandem.store_avg(d.store_from, l.item_code) end;
      if v_diff <> 0 then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, v_diff, v_cost, d.doc_date);
      end if;
      v_line_sum := round(v_diff * v_cost, 2);
      update tandem.document_lines set calc_qty = v_calc, qty = l.fact_qty, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
  end if;

  -- Время проведения — настоящее (clock_timestamp), а не начало транзакции: по нему doc_unpost решает,
  -- проведена ли инвентаризация того же дня позже документа (второй круг V1). Инвентаризация ждёт
  -- исключительного замка склада, поэтому её время всегда позже документов, проведённых до неё.
  -- first_posted_at — место документа в дне (S5.3, v_keep выше): первое проведение и исключения — сейчас.
  v_now := clock_timestamp();
  update tandem.documents set status = 'posted', posted_by = p_user.id, posted_at = v_now,
         first_posted_at = coalesce(v_keep, v_now),
         total_sum = round(v_sum, 2), updated_by = p_user.id, updated_at = now() where id = p_doc;

  select coalesce(jsonb_agg(jsonb_build_object('item_code', t.item_code, 'name', i.name, 'item_type', i.item_type,
           'store_id', t.store_id, 'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc) t
    join tandem.stock_balances b on b.store_id = t.store_id and b.item_code = t.item_code
    join tandem.items i on i.code = t.item_code join tandem.stores s on s.id = t.store_id
    where b.qty < 0;
  -- later_moves (S5.3): сколько документов уже списали (qty < 0) пары склад/позиция, которые этот документ
  -- приходует, и стоят после него — позже датой или того же дня с более поздним местом. Их себестоимость
  -- посчитана без этого документа и не пересчитывается; экран об этом предупреждает. Документ без
  -- прихода (списание, расход) средней не меняет — у него 0.
  select count(distinct m.document_id) into v_later
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc and qty > 0) t
    join tandem.stock_moves m on m.store_id = t.store_id and m.item_code = t.item_code and m.qty < 0 and m.document_id <> p_doc
    join tandem.documents x on x.id = m.document_id
   where m.move_date > d.doc_date
      or (m.move_date = d.doc_date and coalesce(x.first_posted_at, x.posted_at) > coalesce(v_keep, v_now));
  -- ready (и те же resynced, remaining на верхнем уровне — как ответ правки «готовым») — только у
  -- документов, поменявших строки «готовым»: сколько продаж пересобрано сразу и сколько ещё помечено
  -- (их дорабатывает stock_ready_resync или любой пересчёт продаж). ready_new — всегда (пусто — []).
  return jsonb_build_object('ok', true, 'warnings', v_warn, 'total_sum', round(v_sum, 2), 'ready_new', v_new,
                            'later_moves', v_later)
         || case when v_ready is not null then jsonb_build_object('ready', v_ready) || v_ready else '{}'::jsonb end;
end $function$
;

CREATE OR REPLACE FUNCTION tandem.doc_unpost(p_doc uuid, p_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare d record; v_pairs text[]; p text; v_warn jsonb; l record; v_last record;
        v_marked int := 0; v_rstore uuid; v_ready jsonb; v_blk jsonb; v_st uuid[]; v_it text[];
        v_train boolean;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'posted' then return tandem.err('validation', 'Документ не проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права отменять документы этого типа');
  end if;
  -- Замок склада — как в doc_post (0041).
  if d.doc_type = 'inventory' then
    perform pg_advisory_xact_lock(hashtext('tandem.store:' || d.store_from::text));
  else
    perform pg_advisory_xact_lock_shared(hashtext('tandem.store:' || x.s::text))
       from (select unnest(array[d.store_from, d.store_to]) as s order by 1) x where x.s is not null;
  end if;
  -- Мешает инвентаризация, чей расчётный остаток включает этот документ: более поздней даты или того же
  -- дня, проведённая позже него (расчёт — «на конец дня» из уже проведённого, второй круг V1). Отмена
  -- выдернула бы из-под неё учтённое движение, и остаток разошёлся бы с пересчётом.
  -- Продажи — исключение для того же дня: продажа кассы дня D проведена с первого чека и пересобирается
  -- с каждым следующим, в том числе после инвентаризации дня D (ревью п. 12, 23); пересборка снимает
  -- уже учтённую часть и списывает её снова вместе с новыми чеками — после пересчёта уходит только новое.
  -- Мешает только инвентаризация, пересчитавшая позицию, которую этот документ сдвинул на её складе (С):
  -- остальные позиции в её расчёт не входили, и отмена их не трогает.
  select array_agg(t.store_id), array_agg(t.item_code) into v_st, v_it from tandem.doc_touch_items(p_doc) t;
  -- Здесь — настоящее время проведения (posted_at), а не место в дне (first_posted_at): решает, вошёл ли
  -- документ в расчёт инвентаризации. Текст отказа — tandem.inv_block_text (S5.4): одна обычная — прежние
  -- слова; ввод начальных остатков — без совета отменить его; мешают несколько — названы все.
  v_blk := tandem.inv_block(v_st, v_it, d.doc_date, p_doc, case when d.doc_type <> 'sale' then d.posted_at end);
  if v_blk is not null then
    return tandem.err('validation', tandem.inv_block_text(v_blk, true));
  end if;
  -- Перемещение или акт (плана заявок или ручной, B): строки «готовым» склада-получателя (у акта — его
  -- склада) пересчитываются по оставшимся проведённым документам (второй круг V4, сборка 21). Здесь, до
  -- удаления движений, — порядок замков как у sale_sync (отчёт → документ → остатки), см. doc_post.
  -- После этого блока проверок нет — только записи.
  if d.doc_type in ('transfer', 'production') then
    v_rstore := case when d.doc_type = 'transfer' then d.store_to else d.store_from end;
    for l in select distinct dl.item_code from tandem.document_lines dl
              where dl.document_id = p_doc and dl.line_kind = 'item' order by dl.item_code loop
      v_marked := v_marked + tandem.store_ready_recalc(v_rstore, l.item_code, p_doc);
    end loop;
    if v_marked > 0 then v_ready := tandem.store_ready_resync_next(v_rstore, null); end if;
  end if;
  with del as (delete from tandem.stock_moves where document_id = p_doc returning store_id, item_code)
    select array_agg(distinct store_id::text || '|' || item_code) into v_pairs from del;
  foreach p in array coalesce(v_pairs, '{}'::text[]) loop
    perform tandem.rebuild_balance(split_part(p, '|', 1)::uuid, split_part(p, '|', 2));
  end loop;
  delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
  -- Цена прихода и продажи — введённая, у инвентаризации — тоже (цена излишка, A1); у прочих — расчётная.
  update tandem.document_lines set calc_qty = null, sum = null,
         price = case when d.doc_type in ('invoice_in','sale','inventory') then price else null end
    where document_id = p_doc;
  -- first_posted_at остаётся (S5.3): перепроведённый документ встанет на своё место в дне.
  update tandem.documents set status = 'draft', posted_by = null, posted_at = null, total_sum = null,
         updated_by = p_user.id, updated_at = now() where id = p_doc;
  -- Учётная цена, которую поставила эта накладная, откатывается на последнюю оставшуюся проведённую
  -- закупку (дата, затем время проведения); нет такой — на цену, стоявшую до накладной (prev_cost:
  -- опечатка в единственной накладной больше не остаётся учётной ценой, второй круг V9). Цену, заданную
  -- позже вручную или другим документом, не трогаем (0041, ревью п. 41).
  -- Учебные склады (T1): закупка на учебный склад не бывает ценой отката. Приход на учебный склад цену не
  -- ставил (prev_cost пуст) — его отмена цену не трогает; prev_cost есть только у прихода, проведённого,
  -- пока склад ещё не был учебным, — он цену поставил, и его отмена её откатывает, как у любого прихода.
  -- После отката цена, оставшаяся от учебного прихода (через prev_cost), возвращается training_cost_restore.
  if d.doc_type = 'invoice_in' then
    v_train := coalesce((select s.training from tandem.stores s where s.id = d.store_to), false);
    for l in select dl.item_code, dl.price, dl.prev_cost from tandem.document_lines dl
              where dl.document_id = p_doc and dl.line_kind = 'item' and dl.price > 0
                and (not v_train or dl.prev_cost is not null) order by dl.item_code loop
      select x.doc_date, xl.price into v_last
        from tandem.document_lines xl join tandem.documents x on x.id = xl.document_id
        join tandem.stores xs on xs.id = x.store_to and not xs.training
       where x.doc_type = 'invoice_in' and x.status = 'posted' and xl.line_kind = 'item'
         and xl.item_code = l.item_code and xl.price > 0
       order by x.doc_date desc, x.posted_at desc limit 1;
      if v_last.doc_date is not null then
        update tandem.items set cost_price = v_last.price, cost_date = v_last.doc_date
         where code = l.item_code and cost_source = 'document' and cost_date = d.doc_date and cost_price = l.price;
      elsif l.prev_cost is not null then
        update tandem.items set cost_price = (l.prev_cost->>'cost_price')::numeric,
               cost_date = (l.prev_cost->>'cost_date')::date, cost_source = l.prev_cost->>'cost_source'
         where code = l.item_code and cost_source = 'document' and cost_date = d.doc_date and cost_price = l.price;
      end if;
    end loop;
    update tandem.document_lines set prev_cost = null where document_id = p_doc and prev_cost is not null;
    perform tandem.training_cost_restore(array(select dl.item_code from tandem.document_lines dl
                                                where dl.document_id = p_doc and dl.line_kind = 'item'));
  end if;
  -- Пересборка могла увести пары в минус (например, отменён ранний приход) — формат тот же, что у doc_post.
  select coalesce(jsonb_agg(jsonb_build_object('item_code', b.item_code, 'name', i.name, 'item_type', i.item_type,
           'store_id', b.store_id, 'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from unnest(coalesce(v_pairs, '{}'::text[])) x(pair)
    join tandem.stock_balances b on b.store_id = split_part(x.pair, '|', 1)::uuid and b.item_code = split_part(x.pair, '|', 2)
    join tandem.items i on i.code = b.item_code
    join tandem.stores s on s.id = b.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn)
         || case when v_ready is not null then jsonb_build_object('ready', v_ready) || v_ready else '{}'::jsonb end;
end $function$
;

-- S5.2. Предпросмотр проведения (тело из канона). Новое: warnings_charts — позиции выпуска акта
-- производства (блюда и полуфабрикаты) без действующей на дату документа техкарты [{item_code, item_name}]
-- в порядке строк: проведение откажет «Нет действующей техкарты…», окно «Провести документ?» говорит об
-- этом заранее (кладовщик, «Вода ПФ»). У прочих документов — []. У строк warnings — item_type: экран
-- советует провести акт приготовления, только когда в минус уходит полуфабрикат.
CREATE OR REPLACE FUNCTION tandem.doc_preview(p_doc uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare d record; v_consume jsonb := '[]'::jsonb; v_warn jsonb; v_charts jsonb := '[]'::jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then
    return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb,'warnings_charts','[]'::jsonb);
  end if;
  if d.doc_type = 'production' then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id,
             'qty', round(p.qty, 4), 'price', tandem.store_avg(d.store_from, p.item_code),
             'sum', round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2)) order by i.name), '[]'::jsonb)
      into v_consume
      from (select item_code, sum(qty) qty from tandem.doc_consume_plan(p_doc) group by item_code) p
      join tandem.items i on i.code = p.item_code;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'item_name', x.name) order by x.o, x.item_code), '[]'::jsonb)
      into v_charts
      from (select dl.item_code, i.name, min(dl.sort_order) as o
              from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' and i.item_type in ('dish', 'prepared')
               and tandem.active_chart(dl.item_code, d.doc_date) is null
             group by dl.item_code, i.name) x;
  end if;
  -- Исходящие количества по паре (склад, позиция). Инвентаризации здесь нет: её строки
  -- задают факт, а не расход, и итоговая выборка всё равно отбрасывала этот тип —
  -- ветка была мёртвой и только путала при чтении.
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type in ('transfer','writeoff') group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      where d.doc_type = 'production' group by p.item_code
    union all
    -- Выпуск того же акта покрывает расход: полуфабрикат, выпускаемый здесь же и сразу идущий в блюдо,
    -- в минус не уходит (проведение выпускает его раньше блюда, 0041, ревью п. 32).
    select d.store_from, l.item_code, -sum(l.qty)
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type = 'production' group by l.item_code
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing group by store_id, item_code having sum(q) > 0)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'item_type', i.item_type,
           'store_id', a.store_id, 'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume, 'warnings_charts', v_charts);
end $function$
;

CREATE OR REPLACE FUNCTION tandem.sale_sync(p_report bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  r       record;
  v_doc   record;
  v_store uuid;
  v_lines jsonb;
  v_sys   tandem.users;   -- системный проводящий: права администратора, автор не указан
  v_res   jsonb;
  v_id    uuid;
  v_num   text;
  v_note  text;
  v_blk   jsonb;     -- инвентаризация, пересчитавшая то, что спишет продажа (С)
  v_items text[];    -- что спишет продажа по новому составу отчёта
  v_st    uuid[];
  v_same  boolean;
  v_ready boolean;   -- продажа помечена пересчётом «готовым со склада» (store_ready_mark)
begin
  v_sys.role := 'admin';
  -- Лок отчёта: сохранение отчёта точкой и пересчёт из бэк-офиса идут по очереди. Без него
  -- оба создавали бы первый документ, и второй падал на уникальном индексе источника.
  perform 1 from tandem.daily_reports where id = p_report for update;
  select dr.id, dr.report_date, dr.point_id, p.name as point_name, p.default_store_id
    into r from tandem.daily_reports dr join tandem.points p on p.id = dr.point_id where dr.id = p_report;
  if r.id is null then return tandem.err('not_found', 'Отчёт не найден'); end if;
  select * into v_doc from tandem.documents
    where source_kind = 'daily_report' and source_id = p_report::text for update;
  -- Пометку пересчёта «готовым» (и неудачу прошлого такого пересчёта) обычный пересчёт не стирает:
  -- продажа помечена — значит, её списание расходится с тем, что склад получает готовым (второй круг V10).
  v_ready := coalesce(v_doc.sync_note like 'Пересчёт: изменилось, что склад получает готовым%'
                      or v_doc.sync_note like 'Не пересчитана после изменения «готовым%', false);

  -- Склад продажи: у существующего документа — его собственный (склад на день продажи), склад точки —
  -- только для нового. Иначе после смены склада точки пересчёт переносил всю историю её продаж на
  -- новый склад (0041, ревью п. 36). Выключенный склад документа — пересчёт невозможен.
  if v_doc.id is not null then
    v_store := v_doc.store_from;
    if not exists (select 1 from tandem.stores where id = v_store and active) then
      update tandem.documents set sync_note = 'Склад продажи выключен — продажа не пересчитана'
        where id = v_doc.id;
      return jsonb_build_object('ok', true, 'status', 'no_store');
    end if;
  else
    v_store := r.default_store_id;
    if v_store is not null and not exists (select 1 from tandem.stores where id = v_store and active) then
      v_store := null;
    end if;
  end if;

  -- Проданное по позиции: продажи + вынос (выдано − возвращено). Без кода, услуги и позиции
  -- с итогом ≤ 0 (возврат перекрыл продажу) в склад не идут. Выключенные позиции — идут: их
  -- продали, пока они были в работе, и выключение не должно снимать списание из проведённых
  -- продаж при пересборке (0041, ревью п. 35).
  with u as (
    select s.item_code, s.qty as q, s.qty * coalesce(s.price, 0) as amt
      from tandem.sale_lines s where s.report_id = p_report and s.item_code is not null
    union all
    select t.item_code, t.issued - t.returned, (t.issued - t.returned) * coalesce(t.price, 0)
      from tandem.takeout_lines t where t.report_id = p_report and t.item_code is not null
  ), g as (
    select u.item_code, sum(u.q) as q, sum(u.amt) as amt
      from u join tandem.items i on i.code = u.item_code
     where i.item_type <> 'service'
     group by u.item_code having sum(u.q) > 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', q,
           'price', round(amt / q, 2)) order by item_code), '[]'::jsonb)
    into v_lines from g;

  if v_store is null then   -- сюда доходит только новый документ: у точки нет действующего склада
    return jsonb_build_object('ok', true, 'status', 'no_store');
  end if;

  if v_doc.id is not null and v_doc.status = 'posted' then
    v_same := v_doc.doc_date = r.report_date
       and not exists (
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric)
         except
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item')
       and not exists (
         select l.item_code, l.qty, l.price from tandem.document_lines l
          where l.document_id = v_doc.id and l.line_kind = 'item'
         except
         select x.item_code, (x.qty)::numeric, (x.price)::numeric
           from jsonb_to_recordset(v_lines) x(item_code text, qty numeric, price numeric));
    -- Строки те же и пометки нет (или она про «изменён после инвентаризации», а отчёт
    -- вернули к проведённому) — документ верен. Иная пометка («без техкарты», «сбой»,
    -- пересчёт «готовым») — повод провести заново: например, технолог добавил карту.
    if v_same and (v_doc.sync_note is null or v_doc.sync_note like 'Отчёт изменён%') then
      if v_doc.sync_note is not null then
        update tandem.documents set sync_note = null where id = v_doc.id;
      end if;
      return jsonb_build_object('ok', true, 'status', 'unchanged', 'doc_id', v_doc.id, 'number', v_doc.number);
    end if;
    -- Новый состав продажи задел бы позиции, пересчитанные инвентаризацией позже дня отчёта (С), —
    -- проведённую продажу не трогаем: прежнее списание ближе к правде, чем снятое целиком.
    v_items := array(select tandem.sale_touch_items(v_store, r.report_date,
                 array(select x->>'item_code' from jsonb_array_elements(v_lines) x)));
    v_blk := tandem.inv_block(array_fill(v_store, array[cardinality(v_items)]), v_items, r.report_date, v_doc.id, null);
    if v_blk is not null then
      update tandem.documents set sync_note = case when v_ready
               then 'Не пересчитана после изменения «готовым со склада»: '
               else 'Отчёт изменён после проведения, продажа не пересчитана: ' end
             || 'в инвентаризации ' || (v_blk->>'number') || ' от ' || to_char((v_blk->>'doc_date')::date, 'DD.MM.YYYY')
             || ' пересчитаны: ' || (v_blk->>'items')
             -- ввод начальных остатков не отменяют (S5.4) — совета отменить у него нет
             || case when coalesce((v_blk->>'opening')::boolean, false) then ' — это ввод начальных остатков, продажа раньше него не пересчитывается'
                     else '. Сначала отмените её проведение' end
        where id = v_doc.id;
      return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_doc.id, 'number', v_doc.number,
                                'message', 'инвентаризация ' || (v_blk->>'number'));
    end if;
    v_res := tandem.doc_unpost(v_doc.id, v_sys);
    if not coalesce((v_res->>'ok')::boolean, false) then
      -- Пересчёт «готовым», которому мешает инвентаризация, — своя пометка: правило «Отчёт изменён%»
      -- выше её не сбрасывает, и расхождение видно в продажах и «Готовности» (второй круг V10).
      update tandem.documents set sync_note = case when v_ready
               then 'Не пересчитана после изменения «готовым со склада»: '
               else 'Отчёт изменён после проведения, продажа не пересчитана: ' end
             || coalesce(v_res->>'message', 'отмена проведения не удалась')
        where id = v_doc.id;
      return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_doc.id, 'number', v_doc.number,
                                'message', v_res->>'message');
    end if;
  end if;

  if jsonb_array_length(v_lines) = 0 then
    if v_doc.id is not null then delete from tandem.documents where id = v_doc.id; end if;
    return jsonb_build_object('ok', true, 'status', 'empty');
  end if;

  if v_doc.id is null then
    v_num := tandem.next_doc_number('sale', r.report_date);
    insert into tandem.documents (doc_type, number, doc_date, store_from, comment, source_kind, source_id)
      values ('sale', v_num, r.report_date, v_store, 'Отчёт точки «' || r.point_name || '»',
              'daily_report', p_report::text)
      returning id into v_id;
  else
    v_id := v_doc.id; v_num := v_doc.number;
    update tandem.documents set doc_date = r.report_date, updated_at = now()   -- склад документа остаётся своим
      where id = v_id;
    delete from tandem.document_lines where document_id = v_id;
  end if;
  insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, sort_order)
    select v_id, x->>'item_code', (x->>'qty')::numeric, i.unit_id, (x->>'price')::numeric, (ord - 1)::int
      from jsonb_array_elements(v_lines) with ordinality t(x, ord)
      join tandem.items i on i.code = x->>'item_code';

  -- Инвентаризация этого склада более поздним днём уже учла проданное в своей недостаче:
  -- провести продажу сейчас — списать то же самое второй раз. Документ остаётся черновиком
  -- с пометкой. Инвентаризация того же дня не мешает: расчёт у неё — «на конец дня» из уже проведённого;
  -- проведённая до неё часть продажи в расчёте, пересборка снимает её и списывает снова вместе с новыми
  -- чеками — после пересчёта уходит только проданное после него.
  -- Мешает только инвентаризация, пересчитавшая то, что спишет продажа (сама позиция или ингредиенты
  -- её карты, С); продажа прочего проводится.
  select array_agg(t.store_id), array_agg(t.item_code) into v_st, v_items from tandem.doc_touch_items(v_id) t;
  v_blk := tandem.inv_block(v_st, v_items, r.report_date, v_id, null);
  if v_blk is not null then
    update tandem.documents set sync_note = 'Не проведено: после даты отчёта на складе проведена инвентаризация '
           || (v_blk->>'number') || ' от ' || to_char((v_blk->>'doc_date')::date, 'DD.MM.YYYY')
           || ', в ней пересчитаны: ' || (v_blk->>'items') || ' — проданное уже учтено в её недостаче'
      where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_id, 'number', v_num,
                              'message', 'инвентаризация ' || (v_blk->>'number'));
  end if;

  v_res := tandem.doc_post(v_id, v_sys);
  if not coalesce((v_res->>'ok')::boolean, false) then
    update tandem.documents set sync_note = 'Не проведено: ' || coalesce(v_res->>'message', '?') where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'error', 'doc_id', v_id, 'number', v_num,
                              'message', v_res->>'message');
  end if;

  -- Блюда без действующей карты списаны как есть — это стоит видеть технологу.
  select string_agg(i.name, ', ' order by i.name) into v_note
    from tandem.document_lines l join tandem.items i on i.code = l.item_code
   where l.document_id = v_id and l.line_kind = 'item' and i.item_type in ('dish','prepared')
     and tandem.active_chart(l.item_code, r.report_date) is null;
  update tandem.documents set sync_note = case when v_note is not null then 'Без техкарты списаны как есть: ' || v_note end
    where id = v_id;
  return jsonb_build_object('ok', true, 'status', 'posted', 'doc_id', v_id, 'number', v_num,
                            'warnings', v_res->'warnings');
end $function$
;

CREATE OR REPLACE FUNCTION tandem.office_stock(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
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
  v_d1    date; v_d2 date; v_res jsonb; v_cnt jsonb := '{}'::jsonb; v_rep record;
  v_key   text; v_qkey text; v_bad text;
begin
  -- ---------- журнал ----------
  if action = 'docs_list' then
    -- count(*) over () считается до limit, поэтому общее число берётся из max(cnt),
    -- а сама служебная колонка убирается из строк (to_jsonb(x) - 'cnt').
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      -- J: у черновика прихода сумма — Σ кол-во × цена строк (проведённый хранит её сам); кто провёл.
      select d.id, d.number, d.doc_type, d.doc_date, d.status, d.store_from, sf.name as store_from_name,
             d.store_to, st.name as store_to_name, d.counteragent_id, c.name as counteragent_name,
             d.reason, d.comment,
             case when d.status = 'draft' and d.doc_type = 'invoice_in'
                  then (select round(sum(l.qty * coalesce(l.price, 0)), 2) from tandem.document_lines l
                         where l.document_id = d.id and l.line_kind = 'item')
                  else d.total_sum end as total_sum,
             d.ext_number, d.ext_date,
             u.name as created_by_name, d.posted_at, pu.name as posted_by_name,
             count(*) over () as cnt
      from tandem.documents d
      left join tandem.stores sf on sf.id = d.store_from
      left join tandem.stores st on st.id = d.store_to
      left join tandem.counteragents c on c.id = d.counteragent_id
      left join tandem.users u on u.id = d.created_by
      left join tandem.users pu on pu.id = d.posted_by
      where (nullif(payload->>'doc_type','') is null or d.doc_type = payload->>'doc_type')
        and (v_store is null or d.store_from = v_store or d.store_to = v_store)
        and (nullif(payload->>'status','') is null or d.status = payload->>'status')
        and (nullif(payload->>'date_from','') is null or d.doc_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or d.doc_date <= (payload->>'date_to')::date)
        -- поиск — и по № накладной поставщика (бухгалтер ищет «А-7781» и «7781», J); % и _ — буквально
        and (v_q = '' or d.number ilike '%'||tandem.like_escape(v_q)||'%' or c.name ilike '%'||tandem.like_escape(v_q)||'%'
             or d.comment ilike '%'||tandem.like_escape(v_q)||'%' or d.ext_number ilike '%'||tandem.like_escape(v_q)||'%')
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
    -- ext_number/ext_date/source_*/posted_at приходят в ответ сами: карточка отдаёт to_jsonb(документа).
    -- Для печати (G): кто создал и провёл, БИН поставщика, у строк — код iiko (артикул) и группа.
    return jsonb_build_object('ok', true, 'doc', (
      select to_jsonb(dd) || jsonb_build_object(
        'store_from_name', (select name from tandem.stores where id = dd.store_from),
        'store_to_name', (select name from tandem.stores where id = dd.store_to),
        'counteragent_name', (select name from tandem.counteragents where id = dd.counteragent_id),
        'counteragent_bin', (select bin from tandem.counteragents where id = dd.counteragent_id),
        'created_by_name', (select name from tandem.users where id = dd.created_by),
        'posted_by_name', (select name from tandem.users where id = dd.posted_by),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'item_code', l.item_code, 'name', i.name,
                    'unit_id', coalesce(l.unit_id, i.unit_id), 'item_type', i.item_type, 'qty', l.qty, 'price', l.price, 'sum', l.sum,
                    'fact_qty', l.fact_qty, 'calc_qty', l.calc_qty, 'note', l.note, 'sort_order', l.sort_order,
                    'artikul', i.artikul,
                    'group_name', coalesce((select g.name from tandem.item_groups g where g.id = i.group_id), i.group_name),
                    -- у проведённой инвентаризации price — введённая цена излишка (A1), а cost — себестоимость,
                    -- по которой разница фактически встала (из движения строки); без разницы — null
                    'cost', case when dd.doc_type = 'inventory' and dd.status = 'posted'
                                 then (select m.unit_cost from tandem.stock_moves m
                                        where m.line_id = l.id and m.item_code = l.item_code and m.qty <> 0
                                        order by m.id limit 1) end,
                    -- у инвентаризации подсказка «расчёт» — уже проведённое по её день включительно: ровно
                    -- то, с чем проведение сравнит факт (0041, ревью п. 7, второй круг V1); у проведённой —
                    -- без её собственных движений; у прочих документов — текущий остаток
                    'current_qty', case when dd.doc_type = 'inventory'
                                        then tandem.stock_qty_at(dd.store_from, l.item_code, dd.doc_date)
                                             - coalesce((select sum(m.qty) from tandem.stock_moves m
                                                          where m.document_id = dd.id and m.store_id = dd.store_from
                                                            and m.item_code = l.item_code), 0)
                                        else (select qty from tandem.stock_balances b
                                              where b.store_id = coalesce(dd.store_from, dd.store_to) and b.item_code = l.item_code) end)
                    order by l.sort_order), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'item'),
        'consume', (select coalesce(jsonb_agg(jsonb_build_object('item_code', l.item_code, 'name', i.name, 'unit_id', l.unit_id,
                    'qty', l.qty, 'price', l.price, 'sum', l.sum, 'for_item', l.note, 'artikul', i.artikul,
                    'group_name', coalesce((select g.name from tandem.item_groups g where g.id = i.group_id), i.group_name))
                    order by l.sort_order, i.name), '[]'::jsonb)
                  from tandem.document_lines l join tandem.items i on i.code = l.item_code
                  where l.document_id = dd.id and l.line_kind = 'consume'))
      from tandem.documents dd where dd.id = v_id));
  end if;

  -- ---------- сохранение черновика ----------
  if action = 'doc_save' then
    v_type := payload->>'doc_type';
    if v_type = 'sale' then
      return tandem.err('validation', 'Продажа создаётся отчётом точки, руками её не заводят'); end if;
    if v_type is null or v_type not in ('invoice_in','transfer','writeoff','production','inventory') then
      return tandem.err('validation', 'Неизвестный тип документа'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    -- Дата: мусор и несуществующий день — понятная ошибка, а не сбой; окно — с 01.01.2024 по местное
    -- «завтра» (контракт п. 17, ревью п. 65): опечатка в годе у инвентаризации останавливала проведение
    -- всех продаж склада. Окно проверяется ниже, только у нового документа или при смене даты (второй
    -- круг V3): черновик плана на послезавтра правится и проводится («Провести» сначала сохраняет).
    -- Новые документы плана заявок датируются днём плана, он бывает и позже завтрашнего — им
    -- orders_make_docs открывает окно на время своего вызова. Формат строгий: «01.10.2026» Postgres
    -- молча понял бы как 10 января.
    if coalesce(payload->>'doc_date', '') !~ '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'
       or coalesce(payload->>'ext_date', '') !~ '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$' then
      return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД'); end if;
    begin
      v_date := coalesce(nullif(payload->>'doc_date','')::date, tandem.local_now()::date);
    exception when others then
      return tandem.err('validation', 'Неверная дата документа');
    end;
    v_from   := nullif(payload->>'store_from','')::uuid;
    v_to     := nullif(payload->>'store_to','')::uuid;
    v_ca     := nullif(payload->>'counteragent_id','')::uuid;
    v_reason := nullif(payload->>'reason','');
    -- Ключ формы (контракт п. 8): повтор сохранения с тем же ключом правит тот же документ.
    v_key    := nullif(btrim(coalesce(payload->>'client_key', '')), '');
    if length(v_key) > 64 then
      return tandem.err('validation', 'Ключ документа (client_key) — не длиннее 64 символов'); end if;
    -- Накладная поставщика — только у прихода; у прочих типов поля молча обнуляются. Пробелы по краям
    -- номера — опечатка, а не часть номера (по нему ищут и узнают дубль, K).
    v_ext_num  := case when v_type = 'invoice_in' then nullif(btrim(coalesce(payload->>'ext_number','')),'') end;
    begin
      v_ext_date := case when v_type = 'invoice_in' then nullif(payload->>'ext_date','')::date end;
    exception when others then
      return tandem.err('validation', 'Неверная дата накладной поставщика');
    end;
    if v_type = 'invoice_in' and (v_to is null or v_ca is null) then
      return tandem.err('validation', 'Приходу нужны склад и поставщик'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then
      return tandem.err('validation', 'Перемещению нужны два разных склада'); end if;
    if v_type in ('writeoff','production','inventory') and v_from is null then
      return tandem.err('validation', 'Укажите склад'); end if;
    if v_type = 'writeoff' and v_reason is null then
      return tandem.err('validation', 'Укажите причину списания'); end if;
    -- A2: 'opening' — пометка «ввод начальных остатков (день X)», только у инвентаризации; у неё другой
    -- причины не бывает. У прочих типов — как было: причины списания (A3: + брак, представительские,
    -- хозяйственные нужды).
    if v_reason = 'opening' and v_type <> 'inventory' then
      return tandem.err('validation', 'Пометка «ввод остатков» бывает только у инвентаризации'); end if;
    if v_type = 'inventory' and v_reason is not null and v_reason <> 'opening' then
      return tandem.err('validation', 'У инвентаризации бывает только пометка «ввод остатков»'); end if;
    if v_reason is not null and v_reason <> 'opening'
       and v_reason not in ('spoilage', 'tasting', 'staff_meals', 'other', 'defect', 'hospitality', 'internal') then
      return tandem.err('validation', 'Неизвестная причина списания'); end if;
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
    -- Числа строк — до записи, с названием позиции (ревью п. 66, контракт п. 17): прежде минус в
    -- количестве или факте ронял сохранение на ограничении таблицы, и форма молча не сохранялась.
    -- Сначала вид числа, потом знак: приведение не должно встретить текст.
    -- S5.1: названия всех таких строк в их порядке — до трёх, дальше «и ещё N».
    v_qkey := case when v_type = 'inventory' then 'fact_qty' else 'qty' end;
    select tandem.item_names_text(array_agg(x->>'item_code' order by t.ord)) into v_bad
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
     where coalesce(nullif(x->>v_qkey, ''), '0') !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$'
        or coalesce(nullif(x->>'price', ''), '0') !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$';
    if v_bad is not null then
      return tandem.err('validation', 'Количество и цена — числа: ' || v_bad); end if;
    select tandem.item_names_text(array_agg(x->>'item_code' order by t.ord)) into v_bad
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
     where coalesce(nullif(x->>v_qkey, ''), '0')::numeric < 0;
    if v_bad is not null then
      return tandem.err('validation', case when v_type = 'inventory' then 'Факт' else 'Количество' end
                                      || ' не может быть меньше нуля: ' || v_bad); end if;
    select tandem.item_names_text(array_agg(x->>'item_code' order by t.ord)) into v_bad
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord)
     where coalesce(nullif(x->>'price', ''), '0')::numeric < 0;
    if v_bad is not null then
      return tandem.err('validation', 'Цена не может быть меньше нуля: ' || v_bad); end if;
    if v_id is null and v_key is not null then
      -- Повтор после потерянного ответа (двойное «Провести», обрыв связи на телефоне): тот же ключ
      -- формы — тот же документ, второй не заводится (ревью п. 6, 16, 20). Сохранения с одним ключом
      -- идут по очереди, иначе оба успевали бы не найти документ и завести по своему.
      perform pg_advisory_xact_lock(hashtext('tandem.doc_key:' || v_key));
      select id into v_id from tandem.documents where client_key = v_key;
    end if;
    if v_id is null then
      if v_date < date '2024-01-01' or (v_date > tandem.local_now()::date + 1
           and coalesce(current_setting('tandem.orders_docs', true), '') <> '1') then
        return tandem.err('validation', 'Дата документа — не раньше 01.01.2024 и не позже завтрашнего дня');
      end if;
      v_num := tandem.next_doc_number(v_type, v_date);
      insert into tandem.documents (doc_type, number, doc_date, store_from, store_to, counteragent_id, reason,
                                    comment, ext_number, ext_date, created_by, updated_by, client_key)
        values (v_type, v_num, v_date, v_from, v_to, v_ca, v_reason,
                payload->>'comment', v_ext_num, v_ext_date, v_user.id, v_user.id, v_key)
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
      -- окно дат — только если дату меняют (второй круг V3)
      if v_date is distinct from v_doc.doc_date
         and (v_date < date '2024-01-01' or (v_date > tandem.local_now()::date + 1
              and coalesce(current_setting('tandem.orders_docs', true), '') <> '1')) then
        return tandem.err('validation', 'Дата документа — не раньше 01.01.2024 и не позже завтрашнего дня');
      end if;
      v_num := v_doc.number;
      -- Пометку «ввод остатков» не стирает сохранение, которое о ней не знает (телефон не шлёт reason):
      -- ключа нет вовсе — пометка остаётся; пришёл null — снята.
      if v_type = 'inventory' and not (payload ? 'reason') then v_reason := v_doc.reason; end if;
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
    -- K: тот же № накладной у того же поставщика в другом приходе — вероятно, накладную внесли дважды.
    -- Документ сохраняется (бывают совпадения у разных лет и правки), форма предупреждает по dup_of.
    if v_type = 'invoice_in' and v_ext_num is not null then
      select jsonb_build_object('id', x.id, 'number', x.number, 'doc_date', x.doc_date, 'status', x.status) into v_res
        from tandem.documents x
       where x.doc_type = 'invoice_in' and x.counteragent_id = v_ca and x.id <> v_id
         and lower(btrim(x.ext_number)) = lower(v_ext_num)
       order by (x.status = 'posted') desc, x.doc_date, x.number limit 1;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num)
           || case when v_res is not null then jsonb_build_object('dup_of', v_res) else '{}'::jsonb end;
  end if;

  -- ---------- пометка «ввод начальных остатков» (A2) ----------
  -- Пометка для отчётов (ввод остатков — не доход и не убыток), а не правка документа: меняется у
  -- черновика и у проведённой, движения не трогает.
  if action = 'doc_set_opening' then
    if coalesce(payload->>'opening', '') not in ('true', 'false') then
      return tandem.err('validation', 'Укажите opening: true или false'); end if;
    select * into v_doc from tandem.documents where id = v_id for update;
    if v_doc.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if not tandem.office_can(v_user.role, 'doc:inventory', 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    if not tandem.user_store_ok(v_user.id, tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    if v_doc.doc_type <> 'inventory' then
      return tandem.err('validation', 'Пометка «ввод остатков» бывает только у инвентаризации'); end if;
    v_reason := case when (payload->>'opening')::boolean then 'opening' end;
    if v_reason is distinct from v_doc.reason then
      update tandem.documents set reason = v_reason, updated_by = v_user.id, updated_at = now() where id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id, 'opening', v_reason is not null, 'reason', v_reason);
  end if;

  -- ---------- предпросмотр / проведение / отмена / удаление ----------
  if action in ('doc_preview','doc_post','doc_unpost','doc_delete') then
    select * into v_doc from tandem.documents where id = v_id;
    if v_doc.id is not null and not tandem.user_store_ok(v_user.id,
         tandem.doc_own_store(v_doc.doc_type, v_doc.store_from, v_doc.store_to)) then
      return tandem.err('forbidden', 'Документ чужого склада'); end if;
    -- Продажа — зеркало отчёта точки: её не проводят, не отменяют и не удаляют руками,
    -- иначе склад разойдётся с отчётом. Пересчёт — действием doc_sales_sync.
    if v_doc.doc_type = 'sale' and action <> 'doc_preview' then
      return tandem.err('validation', 'Продажа ведётся отчётом точки — пересчитайте её во вкладке «Продажи»'); end if;
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

  -- ---------- продажи: отчёты точек и их документы ----------
  if action = 'doc_sales_list' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, current_date - 7);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'report_id', r.id, 'report_date', r.report_date, 'point_id', p.id, 'point_name', p.name,
        -- склад продажи: у созданного документа — его собственный (документ остаётся на складе дня, 0041)
        'point_mode', p.mode, 'store_id', coalesce(d.store_from, p.default_store_id), 'store_name', st.name,
        'money', r.cash + r.kaspi_qr + r.transfer + r.card,
        'lines', (select count(*) from tandem.sale_lines s where s.report_id = r.id)
               + (select count(*) from tandem.takeout_lines t where t.report_id = r.id),
        'doc_id', d.id, 'number', d.number, 'status', d.status, 'cost', d.total_sum, 'sync_note', d.sync_note,
        'sale_sum', (select sum(l.sum) from tandem.document_lines l where l.document_id = d.id and l.line_kind = 'item'),
        -- «Не пересчитана после изменения «готовым»…» — пересборку не пускает инвентаризация (как «изменён»);
        -- «Пересчёт: …» — помечена, ждёт пересборки частями (второй круг V7, V10)
        'state', case when d.id is not null and d.status = 'posted'
                           and (d.sync_note like 'Отчёт изменён%' or d.sync_note like 'Не пересчитана%') then 'locked'
                      when d.id is not null and d.status = 'posted'
                           and (d.sync_note like 'Сбой%' or d.sync_note like 'Пересчёт:%') then 'stale'
                      when d.id is not null and d.status = 'posted' then 'posted'
                      when d.id is not null then 'draft'
                      when p.default_store_id is null then 'no_store'
                      when exists (select 1 from tandem.sale_lines s where s.report_id = r.id and s.item_code is not null)
                        or exists (select 1 from tandem.takeout_lines t where t.report_id = r.id and t.item_code is not null)
                        then 'pending'
                      else 'none' end)
        order by r.report_date desc, p.sort_order), '[]'::jsonb)
      from tandem.daily_reports r
      join tandem.points p on p.id = r.point_id
      left join tandem.documents d on d.source_kind = 'daily_report' and d.source_id = r.id::text
      left join tandem.stores st on st.id = coalesce(d.store_from, p.default_store_id)
      where r.report_date between v_d1 and v_d2
        and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
        and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
             or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                          and us.store_id in (p.default_store_id, d.store_from)))));
  end if;

  if action = 'doc_sales_sync' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Пересчитывать продажи может администратор, собственник или бухгалтер'); end if;
    v_d1 := nullif(payload->>'date_from','')::date;
    v_d2 := nullif(payload->>'date_to','')::date;
    if v_d1 is null or v_d2 is null or v_d2 < v_d1 then
      return tandem.err('validation', 'Укажите период'); end if;
    if v_d2 - v_d1 > 31 then return tandem.err('validation', 'Период не длиннее месяца'); end if;
    -- Пакет — одна транзакция: чужой лок ждём не дольше 5 секунд, а сбой одного отчёта не
    -- валит остальные (своя подтранзакция на каждый отчёт, ревью п. 3).
    perform set_config('lock_timeout', '5s', true);
    for v_rep in select r.id from tandem.daily_reports r join tandem.points p on p.id = r.point_id
                 where r.report_date between v_d1 and v_d2
                   and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
                   and (not exists (select 1 from tandem.user_stores us where us.user_id = v_user.id)
                        or exists (select 1 from tandem.user_stores us where us.user_id = v_user.id
                                     and us.store_id = p.default_store_id))
                 order by r.report_date, r.id loop
      begin
        v_res := tandem.sale_sync(v_rep.id);
      exception when others then
        v_res := jsonb_build_object('status', 'error');
        -- замки в порядке sale_sync: отчёт, потом документ (второй круг V11)
        perform 1 from tandem.daily_reports where id = v_rep.id for update;
        update tandem.documents set sync_note = 'Сбой пересчёта: ' || sqlerrm
          where source_kind = 'daily_report' and source_id = v_rep.id::text;
      end;
      v_type := coalesce(v_res->>'status', 'error');
      v_cnt := v_cnt || jsonb_build_object(v_type, coalesce((v_cnt->>v_type)::int, 0) + 1);
    end loop;
    return jsonb_build_object('ok', true, 'counts', v_cnt);
  end if;

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0)
      into v_rows, v_total from (
      -- Сумма — стоимость остатка value, а не qty × средняя: она равна сумме движений пары (0041, ревью п. 9).
      -- artikul — код iiko (S5.5): бланк пересчёта, заполненный остатками, печатается с ним.
      select b.store_id, s.name as store_name, b.item_code, i.name, i.artikul, i.unit_id, b.qty, b.avg_cost,
             round(b.value, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    -- Итог считается по всей отобранной выборке, а не по одной странице,
    -- иначе сумма под таблицей меняется при листании.
    select coalesce(sum(round(b.value, 2)), 0) into v_sum
      from tandem.stock_balances b
      join tandem.stores s on s.id = b.store_id
      join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and tandem.user_store_ok(v_user.id, b.store_id)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    -- CSV — тяжёлая строка на весь список, строится только по явному запросу экспорта.
    -- Числа — с десятичной запятой: при разделителе «;» русский Excel иначе делает из 1.5 дату
    -- «01.май», а среднюю цену оставляет текстом (контракт п. 16, ревью п. 74).
    if coalesce((payload->>'export')::boolean, false) then
      select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' ||
             coalesce(string_agg(concat_ws(';', replace(s.name, ';', ','), b.item_code, replace(i.name, ';', ','), i.unit_id,
                                           replace(b.qty::text, '.', ','), replace(b.avg_cost::text, '.', ','),
                                           replace(round(b.value, 2)::text, '.', ',')),
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
      -- строка с qty = 0 — переоценка остатка (второй круг V2): её сумма — поправка adj
      -- M: balance_after — остаток пары после движения, как «остаток» в карточке товара iiko: по дате, затем
      -- по месту документа в порядке проведения дня (first_posted_at, S5.3: перепроведённый документ — на
      -- своём месте), затем по id движения. Считается по всем движениям пары до конца периода — и тем, что
      -- раньше date_from или на других страницах; список идёт в том же порядке (новые сверху).
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name,
             m.qty, m.unit_cost, m.adj, round(m.qty * m.unit_cost + m.adj, 2) as sum,
             m.balance_after, m.document_id, d.number, d.doc_type, count(*) over () as cnt
      from (select mm.*, coalesce(md.first_posted_at, md.posted_at) as fp,
                   sum(mm.qty) over (partition by mm.store_id, mm.item_code
                                     order by mm.move_date, coalesce(md.first_posted_at, md.posted_at), mm.id) as balance_after
              from tandem.stock_moves mm join tandem.documents md on md.id = mm.document_id
             where (v_store is null or mm.store_id = v_store) and tandem.user_store_ok(v_user.id, mm.store_id)
               and (nullif(payload->>'item_code','') is null or mm.item_code = payload->>'item_code')
               and (nullif(payload->>'date_to','') is null or mm.move_date <= (payload->>'date_to')::date)) m
      join tandem.documents d on d.id = m.document_id
      join tandem.stores s on s.id = m.store_id
      join tandem.items i on i.code = m.item_code
      where (nullif(payload->>'date_from','') is null or m.move_date >= (payload->>'date_from')::date)
      order by m.move_date desc, m.fp desc, m.id desc limit 200 offset (v_page-1)*200) x;
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
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, m.adj,
                         round(m.qty * m.unit_cost + m.adj, 2) as sum, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  -- последние по порядку проведения: по месту документа (S5.3), а не по времени записи
                  -- движения — перепроведённый документ не прыгает наверх
                  where m.item_code = v_code and tandem.user_store_ok(v_user.id, m.store_id)
                  order by coalesce(d.first_posted_at, d.posted_at, m.posted_at) desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  -- Новые действия склада (отчёты) живут в office_stock_ext: их добавление не требует
  -- пересоздавать эту большую функцию целиком.
  return tandem.office_stock_ext(action, payload, v_user);
end $function$
;

-- ---------------------------------------------------------------- T1: склады (тело — из канона, после 0042)
-- stores_list отдаёт training. store_save принимает training только при наличии ключа: без ключа (или с null)
-- признак не меняется, новый склад без ключа — обычный. Признак включили у склада, где уже есть проведённые
-- приходы, — учётные цены, которые они успели поставить, возвращаются (training_cost_restore); в ответе
-- store_save — training и costs_restored: [{code, name, was, now}] (ничего не вернули — []).
CREATE OR REPLACE FUNCTION tandem.office_stores(action text, payload jsonb, v_user tandem.users)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'tandem', 'public'
AS $function$
declare
  v_id uuid; v_name text; v_point text; v_train boolean; v_was boolean; v_restored jsonb := '[]'::jsonb;
begin
  if action = 'stores_list' then
    return jsonb_build_object('ok', true,
      'stores', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'point_id', s.point_id, 'point_name', p.name,
          'is_default', (p.default_store_id = s.id), 'active', s.active, 'training', s.training,
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
    v_train := nullif(payload->>'training', '')::boolean;   -- null — ключа нет: признак не меняется
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.stores (name, point_id, active, training)
        values (v_name, v_point, coalesce((payload->>'active')::boolean, true), coalesce(v_train, false)) returning id into v_id;
    else
      select training into v_was from tandem.stores where id = v_id for update;
      update tandem.stores set name = v_name, point_id = v_point,
        active = coalesce((payload->>'active')::boolean, active),
        training = coalesce(v_train, training) where id = v_id;
      if not found then return tandem.err('not_found', 'Склад не найден'); end if;
      -- отвязанный или выключенный склад не может быть складом по умолчанию
      update tandem.points set default_store_id = null
        where default_store_id = v_id and (v_point is null or id <> v_point or not coalesce((payload->>'active')::boolean, true));
      -- склад стал учебным: цены, которые успели поставить его приходы, — назад
      if v_train and not v_was then v_restored := tandem.training_cost_restore(null); end if;
    end if;
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null
       and exists (select 1 from tandem.stores where id = v_id and active) then
      update tandem.points set default_store_id = v_id where id = v_point;
    elsif payload ? 'is_default' and not (payload->>'is_default')::boolean then
      update tandem.points set default_store_id = null where default_store_id = v_id;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id, 'training', (select training from tandem.stores where id = v_id),
                              'costs_restored', v_restored);
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
    -- Перевод в «касса» посреди дня: первый чек пересобрал бы деньги и продажи дня из чеков и стёр
    -- уже сданный отчёт. Если сегодня (по местной дате) отчёт с данными уже есть и он не из чеков —
    -- режим меняют завтра.
    if payload->>'mode' = 'checks'
       and exists (select 1 from tandem.points where id = v_point and mode <> 'checks')
       and exists (select 1 from tandem.daily_reports d
                    where d.point_id = v_point and d.report_date = tandem.local_now()::date
                      and (d.cash <> 0 or d.kaspi_qr <> 0 or d.transfer <> 0 or d.card <> 0
                           or exists (select 1 from tandem.sale_lines s where s.report_id = d.id)
                           or exists (select 1 from tandem.takeout_lines t where t.report_id = d.id)
                           or exists (select 1 from tandem.cash_expenses e where e.report_id = d.id)))
       and not exists (select 1 from tandem.checks c where c.point_id = v_point and c.check_date = tandem.local_now()::date) then
      return tandem.err('validation', 'Сегодня у точки уже есть отчёт — переключите режим завтра');
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
end $function$
;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array[
    'tandem.sale_touch_items(uuid,date,text[])', 'tandem.doc_touch_items(uuid)',
    'tandem.inv_block(uuid[],text[],date,uuid,timestamp with time zone)',
    'tandem.store_ready_set(uuid,text,date,text)', 'tandem.store_ready_recalc(uuid,text,uuid)',
    'tandem.store_ready_orders_recalc(uuid,text,uuid)',
    'tandem.doc_post(uuid,tandem.users)', 'tandem.doc_unpost(uuid,tandem.users)', 'tandem.sale_sync(bigint)',
    'tandem.office_stock(text,jsonb,tandem.users)',
    'tandem.training_cost_restore(text[])', 'tandem.office_stores(text,jsonb,tandem.users)',
    'tandem.item_names_text(text[])', 'tandem.inv_block_text(jsonb,boolean)', 'tandem.doc_preview(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
