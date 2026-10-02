-- Ядро склада, продажи, «готовым со склада», заявки и расход для 1С — исправления по полному ревью
-- (номера находок — по ревью сборки 19; пункты контракта — сборка 20):
-- 1) стоимость остатка stock_balances.value — всегда сумма движений пары (qty × цена + поправка adj).
--    Приход на нулевой или отрицательный остаток сначала переоценивает его по цене прихода отдельной
--    строкой-поправкой (qty 0, сумма в adj), средняя = цена прихода; расход средней не меняет (п. 9,
--    второй круг V2); суммы остатков и CSV считаются по value; CSV — с десятичной запятой (п. 74, контракт 16);
-- 2) store_avg без средней и учётной цены берёт себестоимость по действующей техкарте, а не 0 (п. 10);
-- 3) инвентаризация — «на конец дня»: расчётный остаток = все уже проведённые движения пары датой не позже
--    дня акта; документы после неё не стираются (п. 7, второй круг V1); документ датой раньше проведённой
--    инвентаризации склада не проводится; отмену запрещает инвентаризация более поздней даты или того же
--    дня, проведённая позже документа, — кроме продаж: продажа кассы дня пересобирается и после
--    инвентаризации того же дня (п. 8, 12, 23); проверка и проведение — под замком склада;
-- 4) производство: полуфабрикат, который расходуют другие строки того же акта, выпускается раньше них,
--    локи всех пар акта берутся заранее; предпросмотр не пугает минусом по такому полуфабрикату (п. 32);
-- 5) вместо вечного глобального признака items.sell_from_stock — таблица store_ready: склад с даты
--    получает позицию готовой; продажа на нём списывает саму позицию, «Расход для 1С» её сырьё не берёт;
--    строки ставят ПРОВЕДЁННЫЕ документы плана заявок (отмена проведения пересчитывает строку) и правят
--    люди (stock_ready_*); изменение помечает затронутые продажи и пересобирает их частями по 5
--    (stock_ready_resync), замки — в порядке sale_sync (п. 2, 38, контракт 11; второй круг V4, V7, V10, V11);
--    признак удалён;
-- 6) продажи: существующий документ остаётся на своём складе, выключенные позиции не выпадают (п. 35, 36);
-- 7) учётная цена: только цена > 0 и не накладная задним числом; отмена прихода откатывает цену, а если
--    других закупок нет — возвращает цену, стоявшую до накладной (document_lines.prev_cost) (п. 41, 67, V9);
-- 8) заявки: дробный выпуск штучных отклоняется, у весовых остаток округления раздаётся до точной суммы
--    (п. 69, контракт 12); склад кухни можно передать в сам вызов создания документов (п. 39);
-- 9) «Готовность» видит отчёты точек без созданной продажи (п. 70);
-- 10) doc_save: client_key против повторного создания, окно дат (только для нового документа или новой
--    даты — V3), понятные ошибки по количеству, факту, цене и причине (контракт 8, 17; п. 6, 16, 20, 65, 66).
-- Тексты функций — из db/schema/tandem_full.sql (снимок живой базы), правки точечные.

-- ---------------------------------------------------------------- схема
alter table tandem.stock_balances add column if not exists value numeric not null default 0;
-- Поправка стоимости (₸) без количества (второй круг V2): строка движения с qty = 0 и unit_cost = 0 —
-- переоценка остатка при приходе на минус. Сумма движения везде — qty × unit_cost + adj.
alter table tandem.stock_moves add column if not exists adj numeric not null default 0;
-- Учётная цена позиции до этой строки прихода (cost_price/cost_date/cost_source), если приход её поменял:
-- отмена единственной закупки возвращает прежнюю цену, а не оставляет опечатку (второй круг V9).
alter table tandem.document_lines add column if not exists prev_cost jsonb;

alter table tandem.documents add column if not exists client_key text;
create unique index if not exists documents_client_key_idx on tandem.documents (client_key) where client_key is not null;

-- Склад с даты получает позицию готовой (с кухни перемещением или своим же актом производства):
-- продажа на этом складе списывает саму позицию, а не ингредиенты по карте. Каскад — строка
-- бессмысленна без склада и позиции, и уборка дымового теста удаляет их, не зная о ней.
create table if not exists tandem.store_ready (
  store_id   uuid not null references tandem.stores(id) on delete cascade,
  item_code  text not null references tandem.items(code) on delete cascade,
  date_from  date not null,
  source     text not null default 'manual' check (source in ('orders', 'manual')),
  created_at timestamptz not null default now(),
  primary key (store_id, item_code)
);
alter table tandem.store_ready enable row level security;

-- ---------------------------------------------------------------- остатки и цена расхода

-- Один шаг стоимости остатка (второй круг V2) — общий для apply_move и rebuild_balance, чтобы проведение
-- и пересборка не расходились ни на тиын. Вход: остаток до движения (qty, value, средняя) и движение
-- (количество, цена). Выход: поправка adj (₸, 0 — строки не нужно), остаток, стоимость и средняя после.
--   Приход на остаток <= 0: сначала остаток переоценивается по цене прихода (adj = qty_до × цена − value_до),
--   затем приход; средняя = цена прихода. Прежде разница исчезала (value := qty × цена), и сумма движений
--   расходилась со стоимостью остатка, а поглощение её средней давало 1100 ₸/кг при закупке по 110.
--   Приход на положительный остаток: value += qty × цена, средняя = value / qty; ушла стоимость в ноль или
--   минус (расход по запасной цене при нулевой средней) — так же переоценка по цене прихода.
--   Расход: value −= qty × цена, средняя не меняется.
-- Поправка округляется до тиына: хвосты от округления средней (0,0001 ₸) строк не плодят. Инвариант
-- value = Σ (qty × unit_cost + adj) движений пары держится всегда: в value идёт та же округлённая поправка.
create or replace function tandem.move_step(p_qty0 numeric, p_val0 numeric, p_avg0 numeric, p_qty numeric, p_cost numeric,
                                            out o_adj numeric, out o_qty numeric, out o_val numeric, out o_avg numeric)
language plpgsql immutable as $$
begin
  o_adj := 0;
  o_qty := p_qty0 + p_qty;
  if p_qty > 0 then
    if p_qty0 <= 0 then
      o_adj := round(p_qty0 * p_cost - p_val0, 2);
      o_val := p_val0 + o_adj + p_qty * p_cost;
      o_avg := p_cost;
    else
      o_val := p_val0 + p_qty * p_cost;
      if o_val / o_qty > 0 then
        o_avg := round(o_val / o_qty, 4);
      else
        o_adj := round(p_qty0 * p_cost - p_val0, 2);
        o_val := o_val + o_adj;
        o_avg := p_cost;
      end if;
    end if;
  else
    o_val := p_val0 + p_qty * p_cost;
    o_avg := p_avg0;
  end if;
end $$;

create or replace function tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text, p_qty numeric, p_cost numeric, p_date date)
returns void language plpgsql as $$
declare v_qty numeric; v_val numeric; v_avg numeric; v_cost numeric := coalesce(p_cost, 0); s record;
begin
  if p_qty = 0 then return; end if;
  -- I2: сначала пара (склад, позиция) заводится и берётся под лок, и только потом пишется
  -- движение. В прежнем порядке два параллельных проведения успевали вставить движения
  -- до взаимной блокировки, и средняя считалась каждым по своему, уже устаревшему остатку.
  -- on conflict do nothing дожидается параллельной вставки той же пары, поэтому строка
  -- к моменту select … for update заведомо существует.
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost) values (p_store, p_item, 0, 0)
    on conflict (store_id, item_code) do nothing;
  select qty, value, avg_cost into v_qty, v_val, v_avg from tandem.stock_balances
    where store_id = p_store and item_code = p_item for update;
  -- Стоимость остатка (0041, ревью п. 9, второй круг V2): value — сумма движений пары вместе с
  -- поправками, правило шага — tandem.move_step, тот же, что в rebuild_balance.
  select * into s from tandem.move_step(v_qty, v_val, v_avg, p_qty, v_cost);
  if s.o_adj <> 0 then
    -- переоценка остатка — отдельной строкой того же документа, строки и даты, до самого прихода
    insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, adj, move_date)
      values (p_doc, p_line, p_store, p_item, 0, 0, s.o_adj, p_date);
  end if;
  insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, move_date)
    values (p_doc, p_line, p_store, p_item, p_qty, v_cost, p_date);
  update tandem.stock_balances set qty = s.o_qty, value = s.o_val, avg_cost = s.o_avg, updated_at = now()
    where store_id = p_store and item_code = p_item;
end $$;

create or replace function tandem.rebuild_balance(p_store uuid, p_item text)
returns void language plpgsql as $$
declare r record; s record; v_qty numeric := 0; v_val numeric := 0; v_avg numeric := 0;
begin
  -- I3: пара захватывается первым же оператором, до чтения движений. on conflict do update
  -- блокирует строку всегда (do nothing — не блокирует), поэтому параллельная отмена
  -- проведения не может пересобрать ту же пару по половине движений.
  insert into tandem.stock_balances (store_id, item_code) values (p_store, p_item)
    on conflict (store_id, item_code) do update set updated_at = now();
  -- Строки-поправки (qty = 0) пары зависят от порядка и состава движений — они пересчитываются заново
  -- (второй круг V2): старые удаляются, новые пишутся на документ, строку и дату вызвавшего их прихода.
  delete from tandem.stock_moves where store_id = p_store and item_code = p_item and qty = 0;
  -- Порядок — по id: posted_at внутри одной транзакции одинаков у всех её движений
  -- (now() не меняется), и сортировка по нему неустойчива — средняя зависела бы от плана.
  -- Арифметика стоимости — ровно как в apply_move (tandem.move_step).
  for r in select document_id, line_id, qty, unit_cost, move_date, posted_at from tandem.stock_moves
            where store_id = p_store and item_code = p_item and qty <> 0
            order by id loop
    select * into s from tandem.move_step(v_qty, v_val, v_avg, r.qty, r.unit_cost);
    if s.o_adj <> 0 then
      insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, adj, move_date, posted_at)
        values (r.document_id, r.line_id, p_store, p_item, 0, 0, s.o_adj, r.move_date, r.posted_at);
    end if;
    v_qty := s.o_qty; v_val := s.o_val; v_avg := s.o_avg;
  end loop;
  insert into tandem.stock_balances (store_id, item_code, qty, value, avg_cost, updated_at)
    values (p_store, p_item, v_qty, v_val, v_avg, now())
    on conflict (store_id, item_code) do update set qty = excluded.qty, value = excluded.value,
       avg_cost = excluded.avg_cost, updated_at = now();
end $$;

create or replace function tandem.rebuild_balances()
returns integer language plpgsql as $$
declare r record; v_bad int := 0; v_qty numeric; v_avg numeric; v_val numeric; v_diff boolean;
begin
  for r in select store_id, item_code from tandem.stock_balances
           union select store_id, item_code from tandem.stock_moves loop
    select qty, avg_cost, value into v_qty, v_avg, v_val from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code;
    perform tandem.rebuild_balance(r.store_id, r.item_code);
    -- Сверяется и стоимость остатка (0041): расхождение в ней — тоже повод пересобрать.
    select b.qty is distinct from v_qty or b.avg_cost is distinct from v_avg or b.value is distinct from v_val into v_diff
      from tandem.stock_balances b where b.store_id = r.store_id and b.item_code = r.item_code;
    if v_diff then
      v_bad := v_bad + 1;
    end if;
  end loop;
  return v_bad;
end $$;

create or replace function tandem.store_avg(p_store uuid, p_item text)
returns numeric language sql stable as $$
  -- Цена расхода: средняя склада; нет её — учётная цена позиции; нет и её — себестоимость по действующей
  -- сегодня техкарте, если она посчитана целиком (полуфабрикаты и блюда без остатка на складе: у них почти
  -- никогда нет учётной цены, и расход шёл по нулю — 0041, ревью п. 10); иначе 0.
  select coalesce((select avg_cost from tandem.stock_balances where store_id = p_store and item_code = p_item and avg_cost > 0),
                  (select cost_price from tandem.items where code = p_item and cost_price > 0),
                  (select c.cost from tandem.item_cost(p_item, tandem.local_now()::date) c where c.cost > 0),
                  0)
$$;

-- Расчётный остаток инвентаризации датой p_date — «на конец дня» (второй круг V1): все УЖЕ проведённые
-- движения пары датой не позже дня акта. Приход, производство, перемещение, продажа этого дня, проведённые
-- до пересчёта, в расчёте; движения более поздних дат — нет, акт задним числом их не стирает (ревью п. 7).
-- Документ того же дня, проведённый после инвентаризации, остаётся после неё и в её расчёт не входит;
-- отменить документ, вошедший в расчёт, нельзя, пока она проведена (doc_unpost). Вторая инвентаризация
-- того же дня сравнивает факт с итогом первой. Прежнее правило «утренней» инвентаризации не видело
-- документов своего дня и учитывало их второй раз: приход сегодня + пересчёт сегодня давали излишек.
create or replace function tandem.stock_qty_at(p_store uuid, p_item text, p_date date)
returns numeric language sql stable as $$
  select coalesce(sum(m.qty), 0) from tandem.stock_moves m
   where m.store_id = p_store and m.item_code = p_item and m.move_date <= p_date
$$;

-- ---------------------------------------------------------------- проведение и отмена

create or replace function tandem.doc_post(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare
  d record; l record; c record;
  v_cost numeric; v_sum numeric := 0; v_line_sum numeric; v_calc numeric; v_diff numeric;
  v_chart uuid; v_missing text[] := '{}'; v_warn jsonb; v_lines int; v_bad text; v_qty numeric;
  v_inv record; v_prev jsonb; v_upd boolean; v_marked int := 0; v_rstore uuid; v_ready jsonb;
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
  select inv.number, inv.doc_date, s.name as store_name into v_inv
    from tandem.documents inv join tandem.stores s on s.id = inv.store_from
   where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id <> p_doc
     and inv.store_from in (d.store_from, d.store_to) and inv.doc_date > d.doc_date
   order by inv.doc_date, inv.number limit 1;
  if v_inv.number is not null then
    return tandem.err('validation', 'На складе «' || v_inv.store_name || '» проведена инвентаризация ' || v_inv.number
      || ' от ' || to_char(v_inv.doc_date, 'DD.MM.YYYY') || ' — документ датой раньше неё учёл бы товар второй раз. '
      || 'Проведите его датой не раньше ' || to_char(v_inv.doc_date, 'DD.MM.YYYY') || ' или сначала отмените инвентаризацию');
  end if;
  select count(*) into v_lines from tandem.document_lines where document_id = p_doc and line_kind = 'item';
  if v_lines = 0 then return tandem.err('validation', 'В документе нет строк'); end if;
  -- Продажу выключение позиции не останавливает: её продали, пока позиция была в работе (0041, ревью п. 35).
  if d.doc_type <> 'sale' and exists (select 1 from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' and not i.active) then
    return tandem.err('validation', 'В документе есть выключенные позиции'); end if;
  if exists (select 1 from tandem.document_lines where document_id = p_doc and line_kind = 'item'
             group by item_code having count(*) > 1) then
    return tandem.err('validation', 'Позиция повторяется в строках документа — объедините строки'); end if;

  -- Вся построчная проверка — до первой записи: иначе ошибка на второй строке
  -- оставляет движения первой (функция возвращает значение, а не откатывает транзакцию).
  if d.doc_type <> 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and dl.qty <= 0 order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Количество должно быть больше нуля: ' || v_bad); end if;
  end if;
  if d.doc_type = 'invoice_in' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.price is null or dl.price < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите цену: ' || v_bad); end if;
  elsif d.doc_type = 'inventory' then
    select dl.item_code into v_bad from tandem.document_lines dl
      where dl.document_id = p_doc and dl.line_kind = 'item' and (dl.fact_qty is null or dl.fact_qty < 0)
      order by dl.sort_order limit 1;
    if v_bad is not null then return tandem.err('validation', 'Укажите факт: ' || v_bad); end if;
  elsif d.doc_type = 'production' then
    -- проверки акта — тоже до записи (и до строк «готовым» ниже)
    for l in select dl.item_code, i.item_type from tandem.document_lines dl join tandem.items i on i.code = dl.item_code
             where dl.document_id = p_doc and dl.line_kind = 'item' order by dl.sort_order loop
      if l.item_type not in ('dish','prepared') then return tandem.err('validation', 'Выпускать можно только блюда и полуфабрикаты: ' || l.item_code); end if;
      if tandem.active_chart(l.item_code, d.doc_date) is null then v_missing := v_missing || l.item_code; end if;
    end loop;
    if cardinality(v_missing) > 0 then
      return tandem.err('validation', 'Нет действующей техкарты на дату документа: ' || array_to_string(v_missing, ', '));
    end if;
  end if;

  -- «Готовым со склада» по документам плана заявок (второй круг V4): строку ставит ПРОВЕДЕНИЕ, а не
  -- создание черновика — удалённый или исправленный черновик больше не оставляет склад «готовым».
  -- Перемещение по плану — склад-получатель и его позиции с картой; акт по плану — склад кухни, если он
  -- склад по умолчанию активной точки (Енешка продаёт прямо с кухни). Ручные строки не трогаются.
  -- Стоит до первой записи движений: пересобираемые продажи берут замки отчёт → документ → остатки, как
  -- sale_sync и сохранение отчёта точки; после движений этого документа (замки остатков уже наши) порядок
  -- был бы встречным (второй круг V11). Затронутые продажи помечаются все, пересобираются первые 5.
  -- ВНИМАНИЕ: после этого блока — только записи; новые проверки ставить выше.
  if d.source_kind = 'orders' and d.doc_type in ('transfer', 'production') then
    if d.doc_type = 'transfer' then
      v_rstore := d.store_to;
    elsif exists (select 1 from tandem.points where default_store_id = d.store_from and active) then
      v_rstore := d.store_from;
    end if;
    if v_rstore is not null then
      for l in select distinct dl.item_code from tandem.document_lines dl
                where dl.document_id = p_doc and dl.line_kind = 'item'
                  and tandem.active_chart(dl.item_code, d.doc_date) is not null order by dl.item_code loop
        v_marked := v_marked + tandem.store_ready_set(v_rstore, l.item_code, d.doc_date, 'orders');
      end loop;
      if v_marked > 0 then v_ready := tandem.store_ready_resync_next(v_rstore, null); end if;
    end if;
  end if;

  -- I4: пишущие циклы идут по item_code, а не по sort_order. Порядок строк в документе
  -- задаёт человек, и два документа с одними позициями в разном порядке брали локи
  -- встречно. По item_code порядок блокировок одинаков у всех документов.
  if d.doc_type = 'invoice_in' then
    -- ВНИМАНИЕ: ниже уже идут записи; любая новая проверка должна стоять выше, в блоке предпроверок, иначе return err оставит частично проведённый документ
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by item_code loop
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      -- Учётная цена — последняя известная закупка: накладная задним числом и бонусная строка с нулевой
      -- ценой её не перезаписывают (0041, ревью п. 41, 67). Прежняя цена запоминается в строке, если
      -- накладная её меняет: отмена единственной закупки вернёт её (второй круг V9).
      v_prev := null; v_upd := false;
      if l.price > 0 then
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
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      if v_diff <> 0 then
        perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, v_diff, v_cost, d.doc_date);
      end if;
      v_line_sum := round(v_diff * v_cost, 2);
      update tandem.document_lines set calc_qty = v_calc, qty = l.fact_qty, price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;
  end if;

  -- Время проведения — настоящее (clock_timestamp), а не начало транзакции: по нему doc_unpost решает,
  -- проведена ли инвентаризация того же дня позже документа (второй круг V1). Инвентаризация ждёт
  -- исключительного замка склада, поэтому её время всегда позже документов, проведённых до неё.
  update tandem.documents set status = 'posted', posted_by = p_user.id, posted_at = clock_timestamp(),
         total_sum = round(v_sum, 2), updated_by = p_user.id, updated_at = now() where id = p_doc;

  select coalesce(jsonb_agg(jsonb_build_object('item_code', t.item_code, 'name', i.name, 'store_id', t.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc) t
    join tandem.stock_balances b on b.store_id = t.store_id and b.item_code = t.item_code
    join tandem.items i on i.code = t.item_code join tandem.stores s on s.id = t.store_id
    where b.qty < 0;
  -- ready — только у документов плана, поменявших строки «готовым»: сколько продаж пересобрано сразу и
  -- сколько ещё помечено (их дорабатывает stock_ready_resync или любой пересчёт продаж).
  return jsonb_build_object('ok', true, 'warnings', v_warn, 'total_sum', round(v_sum, 2))
         || case when v_ready is not null then jsonb_build_object('ready', v_ready) else '{}'::jsonb end;
end $$;

create or replace function tandem.doc_unpost(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare d record; v_inv record; v_pairs text[]; p text; v_warn jsonb; l record; v_last record;
        v_marked int := 0; v_rstore uuid; v_ready jsonb;
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
  select inv.number, inv.doc_date into v_inv from tandem.documents inv
    where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id <> p_doc
      and (inv.doc_date > d.doc_date
           or (d.doc_type <> 'sale' and inv.doc_date = d.doc_date and inv.posted_at > d.posted_at))
      and inv.store_from in (d.store_from, d.store_to)
    order by inv.doc_date, inv.posted_at, inv.number limit 1;
  if v_inv.number is not null then
    return tandem.err('validation', case when v_inv.doc_date > d.doc_date
      then 'После даты этого документа проведена инвентаризация ' || v_inv.number
           || ' от ' || to_char(v_inv.doc_date, 'DD.MM.YYYY') || ' — сначала отмените её'
      else 'После этого документа проведена инвентаризация ' || v_inv.number || ' того же дня ('
           || to_char(v_inv.doc_date, 'DD.MM.YYYY') || '): её расчётный остаток уже включает этот документ — сначала отмените её'
      end);
  end if;
  -- Документ плана заявок: строки «готовым» его складов пересчитываются по оставшимся проведённым
  -- документам плана (второй круг V4). Здесь, до удаления движений, — порядок замков как у sale_sync
  -- (отчёт → документ → остатки), см. doc_post. После этого блока проверок нет — только записи.
  if d.source_kind = 'orders' and d.doc_type in ('transfer', 'production') then
    v_rstore := case when d.doc_type = 'transfer' then d.store_to else d.store_from end;
    for l in select distinct dl.item_code from tandem.document_lines dl
              where dl.document_id = p_doc and dl.line_kind = 'item' order by dl.item_code loop
      v_marked := v_marked + tandem.store_ready_orders_recalc(v_rstore, l.item_code, p_doc);
    end loop;
    if v_marked > 0 then v_ready := tandem.store_ready_resync_next(v_rstore, null); end if;
  end if;
  with del as (delete from tandem.stock_moves where document_id = p_doc returning store_id, item_code)
    select array_agg(distinct store_id::text || '|' || item_code) into v_pairs from del;
  foreach p in array coalesce(v_pairs, '{}'::text[]) loop
    perform tandem.rebuild_balance(split_part(p, '|', 1)::uuid, split_part(p, '|', 2));
  end loop;
  delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
  update tandem.document_lines set calc_qty = null, sum = null,
         price = case when d.doc_type in ('invoice_in','sale') then price else null end
    where document_id = p_doc;
  update tandem.documents set status = 'draft', posted_by = null, posted_at = null, total_sum = null,
         updated_by = p_user.id, updated_at = now() where id = p_doc;
  -- Учётная цена, которую поставила эта накладная, откатывается на последнюю оставшуюся проведённую
  -- закупку (дата, затем время проведения); нет такой — на цену, стоявшую до накладной (prev_cost:
  -- опечатка в единственной накладной больше не остаётся учётной ценой, второй круг V9). Цену, заданную
  -- позже вручную или другим документом, не трогаем (0041, ревью п. 41).
  if d.doc_type = 'invoice_in' then
    for l in select dl.item_code, dl.price, dl.prev_cost from tandem.document_lines dl
              where dl.document_id = p_doc and dl.line_kind = 'item' and dl.price > 0 order by dl.item_code loop
      select x.doc_date, xl.price into v_last
        from tandem.document_lines xl join tandem.documents x on x.id = xl.document_id
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
  end if;
  -- Пересборка могла увести пары в минус (например, отменён ранний приход) — формат тот же, что у doc_post.
  select coalesce(jsonb_agg(jsonb_build_object('item_code', b.item_code, 'name', i.name, 'store_id', b.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from unnest(coalesce(v_pairs, '{}'::text[])) x(pair)
    join tandem.stock_balances b on b.store_id = split_part(x.pair, '|', 1)::uuid and b.item_code = split_part(x.pair, '|', 2)
    join tandem.items i on i.code = b.item_code
    join tandem.stores s on s.id = b.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn)
         || case when v_ready is not null then jsonb_build_object('ready', v_ready) else '{}'::jsonb end;
end $$;

create or replace function tandem.doc_preview(p_doc uuid)
returns jsonb language plpgsql stable as $$
declare d record; v_consume jsonb := '[]'::jsonb; v_warn jsonb;
begin
  select * into d from tandem.documents where id = p_doc;
  if d.id is null then return jsonb_build_object('warnings','[]'::jsonb,'consume','[]'::jsonb); end if;
  if d.doc_type = 'production' then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', p.item_code, 'name', i.name, 'unit_id', i.unit_id,
             'qty', round(p.qty, 4), 'price', tandem.store_avg(d.store_from, p.item_code),
             'sum', round(p.qty * tandem.store_avg(d.store_from, p.item_code), 2)) order by i.name), '[]'::jsonb)
      into v_consume
      from (select item_code, sum(qty) qty from tandem.doc_consume_plan(p_doc) group by item_code) p
      join tandem.items i on i.code = p.item_code;
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
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'store_id', a.store_id,
           'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0;
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume);
end $$;

create or replace function tandem.sale_sync(p_report bigint)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
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
  v_inv   text;
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
  select inv.number into v_inv from tandem.documents inv
   where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.store_from = v_store
     and inv.doc_date > r.report_date
   order by inv.doc_date, inv.number limit 1;
  if v_inv is not null then
    update tandem.documents set sync_note = 'Не проведено: после даты отчёта на складе проведена инвентаризация '
           || v_inv || ' — проданное уже учтено в её недостаче'
      where id = v_id;
    return jsonb_build_object('ok', true, 'status', 'locked', 'doc_id', v_id, 'number', v_num,
                              'message', 'инвентаризация ' || v_inv);
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
end $$;

-- ---------------------------------------------------------------- «готовым со склада»
-- Изменение строки store_ready меняет списание проведённых продаж склада с этой позицией (позиция или её
-- сырьё). Пересобирать их все сразу нельзя: на реальной истории это минуты, а запрос режется через 20 с
-- (второй круг V7). Поэтому изменение сразу ПОМЕЧАЕТ все затронутые продажи, а пересобирает их частями
-- по 5 — тот же вызов, следующие вызовы stock_ready_resync или любой обычный пересчёт продаж (sale_sync
-- пересобирает помеченную продажу: строки отчёта те же, но пометка не «Отчёт изменён»).
-- Замки — в порядке sale_sync и сохранения отчёта точки: сначала строки daily_reports, потом документы
-- продаж, потом остатки (второй круг V11). Прежде пометка документа шла до отчёта — взаимная блокировка
-- с пересохранением отчёта или чеком кассы.
drop function if exists tandem.store_ready_resync(uuid, text, date, date);

-- Пометить проведённые продажи склада с позицией за даты [p_from, p_to) (p_to пусто — без конца).
-- Ответ — сколько помечено.
create or replace function tandem.store_ready_mark(p_store uuid, p_item text, p_from date, p_to date)
returns integer language plpgsql set search_path to 'tandem', 'public' as $$
declare v_n int;
begin
  perform 1 from tandem.daily_reports r
    where r.id in (select d.source_id::bigint from tandem.documents d
                    where d.doc_type = 'sale' and d.status = 'posted' and d.source_kind = 'daily_report'
                      and d.store_from = p_store and d.doc_date >= p_from and (p_to is null or d.doc_date < p_to)
                      and exists (select 1 from tandem.document_lines l
                                   where l.document_id = d.id and l.line_kind = 'item' and l.item_code = p_item))
    order by r.id for update of r;
  update tandem.documents d set sync_note = 'Пересчёт: изменилось, что склад получает готовым'
   where d.doc_type = 'sale' and d.status = 'posted' and d.source_kind = 'daily_report'
     and d.store_from = p_store and d.doc_date >= p_from and (p_to is null or d.doc_date < p_to)
     and exists (select 1 from tandem.document_lines l
                  where l.document_id = d.id and l.line_kind = 'item' and l.item_code = p_item);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Пересобрать следующие помеченные продажи (по дате) — не больше p_limit; p_store пусто — все склады,
-- p_user пусто — без проверки закрепления складов (вызов изнутри проведения документа плана).
-- Отчёты отобранных продаж берутся под замок до первой пересборки: пересборка набирает замки остатков,
-- и ждать отчёт, держа их, нельзя (второй круг V11). Сбой одной продажи не валит остальные — пометка на
-- документе; чужой замок (lock_timeout) откатывает весь вызов: tandem_office отвечает «Пересчёт по этому
-- складу уже идёт», и ни изменение, ни частичная пересборка не остаются. Ответ: {resynced, remaining}.
create or replace function tandem.store_ready_resync_next(p_store uuid, p_user uuid, p_limit int default 5)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare r record; v_res jsonb; v_n int := 0; v_ids uuid[]; v_left int;
begin
  select array_agg(x.id order by x.doc_date, x.id) into v_ids from (
    select d.id, d.doc_date from tandem.documents d
     where d.doc_type = 'sale' and d.source_kind = 'daily_report'
       and d.sync_note = 'Пересчёт: изменилось, что склад получает готовым'
       and (p_store is null or d.store_from = p_store)
       and (p_user is null or tandem.user_store_ok(p_user, d.store_from))
     order by d.doc_date, d.id limit greatest(coalesce(p_limit, 5), 0)) x;
  perform 1 from tandem.daily_reports dr
    where dr.id in (select d.source_id::bigint from tandem.documents d where d.id = any(coalesce(v_ids, '{}')))
    order by dr.id for update of dr;
  for r in select d.id, d.source_id from unnest(coalesce(v_ids, '{}')) with ordinality u(id, ord)
             join tandem.documents d on d.id = u.id order by u.ord loop
    begin
      v_res := tandem.sale_sync(r.source_id::bigint);
      if v_res->>'status' = 'posted' then v_n := v_n + 1; end if;
    exception
      when lock_not_available then raise;
      when others then
        perform 1 from tandem.daily_reports where id = r.source_id::bigint for update;
        update tandem.documents set sync_note = 'Сбой пересчёта: ' || sqlerrm where id = r.id;
    end;
  end loop;
  select count(*) into v_left from tandem.documents d
   where d.doc_type = 'sale' and d.source_kind = 'daily_report'
     and d.sync_note = 'Пересчёт: изменилось, что склад получает готовым'
     and (p_store is null or d.store_from = p_store)
     and (p_user is null or tandem.user_store_ok(p_user, d.store_from));
  return jsonb_build_object('resynced', v_n, 'remaining', v_left);
end $$;

-- Поставить строку «готовым со склада». Документы плана (source 'orders') только сдвигают дату раньше —
-- least(прежняя, день плана) — и ручную строку не трогают вовсе (контракт второго круга D); ручное
-- сохранение ставит дату как есть и помечает строку ручной. Изменение даты помечает продажи между прежней
-- и новой датой (новая строка — с её даты). Ответ — сколько продаж помечено; пересборку зовёт вызывающий.
create or replace function tandem.store_ready_set(p_store uuid, p_item text, p_date date, p_source text)
returns integer language plpgsql set search_path to 'tandem', 'public' as $$
declare v_old date; v_src text; v_new date;
begin
  select date_from, source into v_old, v_src from tandem.store_ready where store_id = p_store and item_code = p_item for update;
  if p_source = 'orders' and v_src = 'manual' then return 0; end if;
  v_new := case when p_source = 'orders' then least(coalesce(v_old, p_date), p_date) else p_date end;
  insert into tandem.store_ready (store_id, item_code, date_from, source) values (p_store, p_item, v_new, p_source)
    on conflict (store_id, item_code) do update set date_from = excluded.date_from,
       source = case when excluded.source = 'manual' then 'manual' else tandem.store_ready.source end;
  if v_old is not distinct from v_new then return 0; end if;
  return tandem.store_ready_mark(p_store, p_item, least(coalesce(v_old, v_new), v_new),
                                 case when v_old is not null then greatest(v_old, v_new) end);
end $$;

-- Строка «готовым» по документам плана после отмены проведения одного из них (p_except): дата — самая
-- ранняя из оставшихся проведённых документов плана, которые её подтверждают (перемещение на этот склад
-- позиции с картой; акт по плану на этом складе, если он склад по умолчанию активной точки); таких нет —
-- строка удаляется. Ручная строка и строка, которой уже нет, не трогаются. Ответ — сколько продаж помечено.
create or replace function tandem.store_ready_orders_recalc(p_store uuid, p_item text, p_except uuid)
returns integer language plpgsql set search_path to 'tandem', 'public' as $$
declare v_old date; v_src text; v_new date;
begin
  select date_from, source into v_old, v_src from tandem.store_ready where store_id = p_store and item_code = p_item for update;
  if v_old is null or v_src <> 'orders' then return 0; end if;
  select min(x.doc_date) into v_new
    from tandem.documents x join tandem.document_lines l on l.document_id = x.id and l.line_kind = 'item'
   where x.source_kind = 'orders' and x.status = 'posted' and x.id <> p_except and l.item_code = p_item
     and ((x.doc_type = 'transfer' and x.store_to = p_store)
          or (x.doc_type = 'production' and x.store_from = p_store
              and exists (select 1 from tandem.points p where p.default_store_id = p_store and p.active)))
     and tandem.active_chart(p_item, x.doc_date) is not null;
  if v_new is null then
    delete from tandem.store_ready where store_id = p_store and item_code = p_item;
    return tandem.store_ready_mark(p_store, p_item, v_old, null);
  end if;
  if v_new = v_old then return 0; end if;
  update tandem.store_ready set date_from = v_new where store_id = p_store and item_code = p_item;
  return tandem.store_ready_mark(p_store, p_item, least(v_old, v_new), greatest(v_old, v_new));
end $$;

-- ---------------------------------------------------------------- бэк-офис: склад

create or replace function tandem.office_stock(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
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
                    'qty', l.qty, 'price', l.price, 'sum', l.sum, 'for_item', l.note) order by l.sort_order, i.name), '[]'::jsonb)
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
    -- Накладная поставщика — только у прихода; у прочих типов поля молча обнуляются.
    v_ext_num  := case when v_type = 'invoice_in' then nullif(payload->>'ext_number','') end;
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
    if v_reason is not null and v_reason not in ('spoilage', 'tasting', 'staff_meals', 'other') then
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
    v_qkey := case when v_type = 'inventory' then 'fact_qty' else 'qty' end;
    select i.name into v_bad from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
     where coalesce(nullif(x->>v_qkey, ''), '0') !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$'
        or coalesce(nullif(x->>'price', ''), '0') !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$'
     limit 1;
    if v_bad is not null then
      return tandem.err('validation', 'Количество и цена — числа: ' || v_bad); end if;
    select i.name into v_bad from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
     where coalesce(nullif(x->>v_qkey, ''), '0')::numeric < 0 limit 1;
    if v_bad is not null then
      return tandem.err('validation', case when v_type = 'inventory' then 'Факт' else 'Количество' end
                                      || ' не может быть меньше нуля: ' || v_bad); end if;
    select i.name into v_bad from jsonb_array_elements(payload->'lines') x join tandem.items i on i.code = x->>'item_code'
     where coalesce(nullif(x->>'price', ''), '0')::numeric < 0 limit 1;
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
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
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
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name,
             m.qty, m.unit_cost, m.adj, round(m.qty * m.unit_cost + m.adj, 2) as sum,
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
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, m.adj,
                         round(m.qty * m.unit_cost + m.adj, 2) as sum, d.number, d.doc_type
                  from tandem.stock_moves m
                  join tandem.documents d on d.id = m.document_id
                  join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code and tandem.user_store_ok(v_user.id, m.store_id) order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  -- Новые действия склада (отчёты) живут в office_stock_ext: их добавление не требует
  -- пересоздавать эту большую функцию целиком.
  return tandem.office_stock_ext(action, payload, v_user);
end $$;

create or replace function tandem.office_stock_ext(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_store uuid := nullif(payload->>'store_id','')::uuid;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_d1    date;
  v_d2    date;
  v_bad   text;
begin
  -- Оборотная ведомость: по каждой позиции остаток на начало, обороты по видам документов
  -- и остаток на конец — как «Расширенная оборотно-сальдовая ведомость» iiko, чтобы
  -- сверять учёт в параллельной работе. Количества расхода — положительные числа.
  -- Суммы — по себестоимости движений (qty × unit_cost), как «Сумма с/н» в iiko. Переоценки остатка
  -- (строки adj, второй круг V2) — отдельным полем reval_sum за период; остатки на начало и конец их
  -- включают, поэтому end_sum = start_sum + обороты + reval_sum и совпадает со стоимостью в «Остатках».
  if action = 'stock_turnover_report' then
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with m as (
        -- s — сумма по количеству (у строк-поправок qty = 0, s = 0), adj — поправка (у прочих строк 0)
        select m.item_code, m.qty, m.qty * m.unit_cost as s, m.adj, m.move_date, d.doc_type
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
         where m.move_date <= v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
      ), a as (
        select item_code,
          coalesce(sum(qty) filter (where move_date < v_d1), 0)                                          as start_qty,
          coalesce(sum(s + adj) filter (where move_date < v_d1), 0)                                      as start_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'invoice_in'), 0)             as income_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty > 0), 0)   as transfer_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'transfer' and qty < 0), 0)  as transfer_out,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty > 0), 0) as production_in,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'production' and qty < 0), 0) as production_out,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'sale'), 0)                  as sales_sum,
          coalesce(-sum(qty) filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff,
          coalesce(-sum(s)   filter (where move_date >= v_d1 and doc_type = 'writeoff'), 0)              as writeoff_sum,
          coalesce(sum(qty) filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory,
          coalesce(sum(s)   filter (where move_date >= v_d1 and doc_type = 'inventory'), 0)              as inventory_sum,
          coalesce(sum(adj) filter (where move_date >= v_d1), 0)                                         as reval_sum,
          coalesce(sum(qty), 0)     as end_qty,
          coalesce(sum(s + adj), 0) as end_sum,
          count(*) filter (where move_date >= v_d1) as moves
        from m group by item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', a.item_code, 'name', i.name, 'unit_id', i.unit_id, 'group_name', g.name,
          'start_qty', round(a.start_qty, 4), 'start_sum', round(a.start_sum, 2),
          'income', round(a.income, 4), 'income_sum', round(a.income_sum, 2),
          'transfer_in', round(a.transfer_in, 4), 'transfer_out', round(a.transfer_out, 4),
          'production_in', round(a.production_in, 4), 'production_out', round(a.production_out, 4),
          'sales', round(a.sales, 4), 'sales_sum', round(a.sales_sum, 2),
          'writeoff', round(a.writeoff, 4), 'writeoff_sum', round(a.writeoff_sum, 2),
          'inventory', round(a.inventory, 4), 'inventory_sum', round(a.inventory_sum, 2),
          'reval_sum', round(a.reval_sum, 2),
          'end_qty', round(a.end_qty, 4), 'end_sum', round(a.end_sum, 2))
          order by g.name nulls last, i.name), '[]'::jsonb)
        from a join tandem.items i on i.code = a.item_code
        left join tandem.item_groups g on g.id = i.group_id
       where (a.moves > 0 or round(a.start_qty, 4) <> 0 or round(a.end_qty, 4) <> 0)
         and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
         and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)));
  end if;

  -- Продажи и себестоимость за период: по точкам и по позициям, только проведённые продажи.
  -- Выручка — строки проданного (кол-во × цена продажи из отчёта), себестоимость — строки
  -- расхода (списано по техкартам и как есть по средней склада). Фудкост = себестоимость / выручка.
  if action = 'doc_sales_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (
      with d as (
        select doc.id, doc.store_from, r.point_id
          from tandem.documents doc
          join tandem.daily_reports r on doc.source_kind = 'daily_report' and doc.source_id = r.id::text
         where doc.doc_type = 'sale' and doc.status = 'posted'
           and doc.doc_date between v_d1 and v_d2
           and (nullif(payload->>'point_id','') is null or r.point_id = payload->>'point_id')
           and tandem.user_store_ok(v_user.id, doc.store_from)
      ), li as (
        select d.point_id, l.item_code, l.qty, coalesce(l.sum, 0) as revenue
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
      ), lc as (
        select d.point_id, l.note as item_code, coalesce(l.sum, 0) as cost
          from d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'consume'
      ), pt as (
        select p.id as point_id, p.name, p.sort_order,
               (select count(*) from d where d.point_id = p.id) as docs,
               coalesce((select sum(revenue) from li where li.point_id = p.id), 0) as revenue,
               coalesce((select sum(cost) from lc where lc.point_id = p.id), 0) as cost
          from tandem.points p where exists (select 1 from d where d.point_id = p.id)
      ), it as (
        select x.item_code, sum(x.qty) as qty, sum(x.revenue) as revenue, sum(x.cost) as cost from (
          select item_code, qty, revenue, 0::numeric as cost from li
          union all
          select item_code, 0, 0, cost from lc) x
         group by x.item_code
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'points', (select coalesce(jsonb_agg(jsonb_build_object('point_id', point_id, 'point_name', name, 'docs', docs,
                     'revenue', round(revenue, 2), 'cost', round(cost, 2), 'margin', round(revenue - cost, 2),
                     'foodcost_pct', case when revenue > 0 then round(cost / revenue * 100, 2) end)
                     order by sort_order), '[]'::jsonb) from pt),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', it.item_code, 'name', i.name, 'unit_id', i.unit_id,
                     'qty', round(it.qty, 4), 'revenue', round(it.revenue, 2), 'cost', round(it.cost, 2),
                     'margin', round(it.revenue - it.cost, 2),
                     'foodcost_pct', case when it.revenue > 0 then round(it.cost / it.revenue * 100, 2) end)
                     order by it.revenue desc, i.name), '[]'::jsonb)
                    from it join tandem.items i on i.code = it.item_code)));
  end if;

  if action = 'stock_quality_report' then return tandem.quality_report(v_user); end if;

  -- Заявки точек и сводный план выпечки (миграция 0038).
  if action = 'stock_orders_report' then
    if not tandem.office_can(v_user.role, 'doc:transfer', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть заявки'); end if;
    return tandem.orders_report(coalesce(nullif(payload->>'for_date','')::date, tandem.local_now()::date + 1));
  end if;
  if action = 'stock_orders_fact_save' then
    if not tandem.office_can(v_user.role, 'doc:production', 'edit') then
      return tandem.err('forbidden', 'Нет права отмечать выпуск'); end if;
    v_d1 := nullif(payload->>'for_date','')::date;
    if v_d1 is null then return tandem.err('validation', 'Не указан день'); end if;
    if tandem.order_locked(v_d1) then
      return tandem.err('validation', 'Документы по плану уже созданы — выпуск правьте в акте производства'); end if;
    if exists (select 1 from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
                where coalesce(x->>'fact', '') <> '' and x->>'fact' !~ '^[0-9]+([.][0-9]+)?$') then
      return tandem.err('validation', 'Выпуск — число не меньше нуля'); end if;
    if (select count(*) <> count(distinct x->>'item_code') from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x) then
      return tandem.err('validation', 'Позиция в выпуске повторяется'); end if;
    if exists (select 1 from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
                where not exists (select 1 from tandem.items i where i.code = x->>'item_code')) then
      return tandem.err('validation', 'Неизвестная позиция в выпуске'); end if;
    -- Штучное — только целым, как в заявке: полпирожка не уйдёт ни в акт, ни в перемещение, и выпуск
    -- в плане разошёлся бы с документами (контракт п. 12, ревью п. 69).
    select string_agg(i.name, ', ' order by i.name) into v_bad
      from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x join tandem.items i on i.code = x->>'item_code'
     where i.unit_id in ('шт', 'порц')
       and case when nullif(x->>'fact', '') is null then false
                else (x->>'fact')::numeric <> trunc((x->>'fact')::numeric) end;
    if v_bad is not null then
      return tandem.err('validation', 'Штучные позиции — выпуск только целым числом: ' || v_bad); end if;
    delete from tandem.order_plan p using jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
     where p.for_date = v_d1 and p.item_code = x->>'item_code' and nullif(x->>'fact', '') is null;
    insert into tandem.order_plan (for_date, item_code, fact_qty)
      select v_d1, x->>'item_code', (x->>'fact')::numeric from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
       where nullif(x->>'fact', '') is not null
      on conflict (for_date, item_code) do update set fact_qty = excluded.fact_qty;
    return tandem.orders_report(v_d1);
  end if;
  if action = 'stock_orders_docs_save' then
    if not (tandem.office_can(v_user.role, 'doc:production', 'edit') and tandem.office_can(v_user.role, 'doc:transfer', 'edit')) then
      return tandem.err('forbidden', 'Нет права создавать производство и перемещения'); end if;
    v_d1 := nullif(payload->>'for_date','')::date;
    if v_d1 is null then return tandem.err('validation', 'Не указан день'); end if;
    begin
      -- store_id — склад кухни только для этого вызова, общая настройка не меняется (ревью п. 39).
      return tandem.orders_make_docs(v_d1, v_user, coalesce((payload->>'force')::boolean, false), v_store);
    exception when raise_exception then
      return tandem.err('validation', sqlerrm);
    end;
  end if;
  if action = 'stock_orders_settings_save' then
    if not tandem.office_can(v_user.role, 'stores', 'edit') then
      return tandem.err('forbidden', 'Нет права менять настройки заявок'); end if;
    if nullif(payload->>'store_id', '') is not null
       and not exists (select 1 from tandem.stores where id = (payload->>'store_id')::uuid and active) then
      return tandem.err('validation', 'Склад не найден'); end if;
    if coalesce(payload->>'cutoff', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      return tandem.err('validation', 'Время отсечки — в виде 20:00'); end if;
    insert into tandem.settings (key, value) values ('orders_store_id', coalesce(payload->>'store_id', '')), ('orders_cutoff', payload->>'cutoff')
      on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true);
  end if;

  -- «Готовым со склада» (0041, контракт п. 11): на складе с даты позиция продаётся готовой — продажа
  -- списывает саму позицию, а не сырьё по карте. Строки ставят проведённые документы плана заявок
  -- (doc_post, второй круг V4), правит человек.
  -- Права раздела проверяет tandem_office (_list — просмотр склада, остальное — правка); кладовщик
  -- с закреплёнными складами видит и правит только их.
  if action = 'stock_ready_list' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('store_id', r.store_id, 'store_name', s.name, 'item_code', r.item_code,
               'item_name', i.name, 'unit_id', i.unit_id, 'date_from', r.date_from, 'source', r.source)
               order by s.name, i.name), '[]'::jsonb)
        from tandem.store_ready r join tandem.stores s on s.id = r.store_id join tandem.items i on i.code = r.item_code
       where (v_store is null or r.store_id = v_store) and tandem.user_store_ok(v_user.id, r.store_id)));
  end if;
  -- Изменение помечает все затронутые продажи и пересобирает первые 5; ответ {ok, resynced, remaining}.
  -- Пока remaining > 0, фронт зовёт stock_ready_resync {store_id?} — следующие 5 помеченных продаж
  -- складов, доступных пользователю (второй круг V7). Чужой лок ждём не дольше 5 секунд, как пакетный
  -- пересчёт; не дождались — весь вызов откатывается, tandem_office отвечает «Пересчёт уже идёт».
  if action = 'stock_ready_resync' then
    if v_store is not null and not tandem.user_store_ok(v_user.id, v_store) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    perform set_config('lock_timeout', '5s', true);
    return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
  end if;
  if action in ('stock_ready_save', 'stock_ready_delete') then
    if v_store is null then return tandem.err('validation', 'Укажите склад'); end if;
    if not tandem.user_store_ok(v_user.id, v_store) then
      return tandem.err('forbidden', 'Этот склад не закреплён за вами'); end if;
    perform set_config('lock_timeout', '5s', true);
    if action = 'stock_ready_delete' then
      delete from tandem.store_ready where store_id = v_store and item_code = payload->>'item_code'
        returning date_from into v_d1;
      if v_d1 is null then return tandem.err('not_found', 'Такой строки нет'); end if;
      -- с даты строки продажи снова раскладываются по карте
      perform tandem.store_ready_mark(v_store, payload->>'item_code', v_d1, null);
      return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
    end if;
    if not exists (select 1 from tandem.stores where id = v_store and active) then
      return tandem.err('validation', 'Склад не найден или выключен'); end if;
    if not exists (select 1 from tandem.items where code = payload->>'item_code') then
      return tandem.err('validation', 'Позиция не найдена'); end if;
    begin
      -- формат строгий: «01.10.2026» Postgres молча понял бы как 10 января
      if coalesce(payload->>'date_from', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'date'; end if;
      v_d1 := (payload->>'date_from')::date;
    exception when others then
      return tandem.err('validation', 'Дата — в формате ГГГГ-ММ-ДД');
    end;
    if v_d1 is null or v_d1 < date '2024-01-01' then
      return tandem.err('validation', 'Укажите дату, с которой склад получает позицию готовой (не раньше 01.01.2024)'); end if;
    perform tandem.store_ready_set(v_store, payload->>'item_code', v_d1, 'manual');
    return jsonb_build_object('ok', true) || tandem.store_ready_resync_next(v_store, v_user.id);
  end if;

  -- Закупки за период: по поставщикам и по товарам (проведённые приходы). Цена — средняя за период,
  -- мин/макс показывают разброс цен у поставщиков.
  if action = 'stock_purchases_report' then
    if not tandem.office_can(v_user.role, 'doc:invoice_in', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть приходы'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (with l as (
        select d.id as doc_id, d.counteragent_id, l.item_code, l.qty, coalesce(l.sum, l.qty * coalesce(l.price, 0)) as s
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
         where d.doc_type = 'invoice_in' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and (v_store is null or d.store_to = v_store)
           and tandem.user_store_ok(v_user.id, d.store_to)
      )
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2,
        'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('counteragent_id', x.counteragent_id,
            'name', coalesce(c.name, 'без поставщика'), 'docs', x.docs, 'items', x.items, 'sum', round(x.s, 2)) order by x.s desc), '[]'::jsonb)
          from (select counteragent_id, count(distinct doc_id) docs, count(distinct item_code) items, sum(s) s from l group by counteragent_id) x
          left join tandem.counteragents c on c.id = x.counteragent_id),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'name', i.name, 'unit_id', i.unit_id,
            'qty', round(x.q, 4), 'sum', round(x.s, 2), 'avg_price', case when x.q <> 0 then round(x.s / x.q, 2) end,
            'min_price', round(x.pmin, 2), 'max_price', round(x.pmax, 2), 'suppliers', x.sup) order by x.s desc), '[]'::jsonb)
          from (select l.item_code, sum(l.qty) q, sum(l.s) s, min(l.s / nullif(l.qty, 0)) pmin, max(l.s / nullif(l.qty, 0)) pmax,
                       count(distinct l.counteragent_id) sup from l group by l.item_code) x
          join tandem.items i on i.code = x.item_code)));
  end if;

  -- Прибыль по точкам за период, как «Отчёт о прибылях и убытках» iiko в части продуктов: выручка и
  -- себестоимость проданного, списания (порча, проработка, питание персонала) и итог инвентаризаций
  -- (недостача с минусом) по складам точки. Склады без точки (цех, общий склад) — отдельной строкой.
  -- Переоценка остатка (строки adj, второй круг V2) — поле reval = −Σ adj по складам точки за период;
  -- она входит в cost: продажа в минус шла по старой средней, а приход оценил проданное по своей цене.
  if action = 'stock_pnl_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return (with rev as (
        select s.point_id, sum(l.sum) v
          from tandem.documents d join tandem.document_lines l on l.document_id = d.id and l.line_kind = 'item'
          join tandem.stores s on s.id = d.store_from
         where d.doc_type = 'sale' and d.status = 'posted' and d.doc_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, d.store_from)
         group by s.point_id
      ), mv as (
        -- по количеству: строки-поправки (qty = 0) сюда дают 0, они — в rv
        select s.point_id, d.doc_type, sum(m.qty * m.unit_cost) v
          from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
          join tandem.stores s on s.id = m.store_id
         where d.doc_type in ('sale', 'writeoff', 'inventory') and m.move_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by s.point_id, d.doc_type
      ), rv as (
        select s.point_id, sum(m.adj) v
          from tandem.stock_moves m join tandem.stores s on s.id = m.store_id
         where m.adj <> 0 and m.move_date between v_d1 and v_d2
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by s.point_id
      ), k as (select point_id from rev union select point_id from mv union select point_id from rv)
      select jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (select coalesce(jsonb_agg(jsonb_build_object(
          'point_id', k.point_id, 'point_name', coalesce(p.name, 'Склады без точки'),
          'revenue', round(coalesce(r.v, 0), 2),
          'cost', round(-coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'sale'), 0)
                        - coalesce((select v from rv where rv.point_id is not distinct from k.point_id), 0), 2),
          'reval', round(-coalesce((select v from rv where rv.point_id is not distinct from k.point_id), 0), 2),
          'writeoff', round(-coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'writeoff'), 0), 2),
          'inventory', round(coalesce((select v from mv where mv.point_id is not distinct from k.point_id and doc_type = 'inventory'), 0), 2))
          order by p.sort_order nulls last, p.name), '[]'::jsonb)
        from k left join tandem.points p on p.id = k.point_id left join rev r on r.point_id is not distinct from k.point_id)));
  end if;

  -- Расход для 1С: сколько продуктов ушло на проданное за период, в позициях и единицах 1С —
  -- основа акта списания «на основании продаж». Берётся расход проведённых продаж и актов
  -- производства, кроме полуфабрикатов (их в 1С нет: 1С видит сырьё, из которого они сделаны)
  -- и кроме проданного готовым — позиции с действующей на дату продажи техкартой, списанной
  -- самой: её сырьё уже в акте производства (0041, вместо признака sell_from_stock).
  -- Сумма — по себестоимости движений нашего склада; переоценки остатка (строки adj, qty = 0) сюда не
  -- попадают — отбор только по расходу (qty < 0).
  if action = 'stock_1c_report' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'view') then
      return tandem.err('forbidden', 'Нет права смотреть продажи'); end if;
    v_d1 := coalesce(nullif(payload->>'date_from','')::date, date_trunc('month', current_date)::date);
    v_d2 := coalesce(nullif(payload->>'date_to','')::date, current_date);
    if v_d2 < v_d1 then return tandem.err('validation', 'Дата «по» раньше даты «с»'); end if;
    return jsonb_build_object('ok', true, 'date_from', v_d1, 'date_to', v_d2, 'rows', (
      with u as (
        select m.item_code, -sum(m.qty) as qty, -sum(m.qty * m.unit_cost) as s
          from tandem.stock_moves m
          join tandem.documents d on d.id = m.document_id
          join tandem.items i on i.code = m.item_code
         where d.doc_type in ('sale', 'production') and d.status = 'posted' and m.qty < 0
           and i.item_type <> 'prepared'
           and not (d.doc_type = 'sale' and tandem.active_chart(m.item_code, d.doc_date) is not null)
           and m.move_date between v_d1 and v_d2
           and (v_store is null or m.store_id = v_store)
           and tandem.user_store_ok(v_user.id, m.store_id)
         group by m.item_code
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'item_code', u.item_code, 'name', i.name, 'unit_id', i.unit_id,
          'qty', round(u.qty, 4), 'sum', round(u.s, 2),
          'code_1c', i.code_1c, 'name_1c', c.name, 'unit_1c', c.unit, 'account_1c', c.account, 'k_1c', i.k_1c,
          'qty_1c', case when i.code_1c is not null and i.k_1c is not null then round(u.qty * i.k_1c, 3) end)
          order by c.name nulls last, i.name), '[]'::jsonb)
        from u join tandem.items i on i.code = u.item_code
        left join tandem.catalog_1c c on c.code = i.code_1c
       where round(u.qty, 4) <> 0));
  end if;

  -- Справочник позиций 1С — для выбора соответствия.
  if action = 'stock_1c_catalog_list' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'unit', unit, 'account', account) order by name), '[]'::jsonb)
        from tandem.catalog_1c));
  end if;

  -- Загрузка справочника 1С (строки материальной ведомости) и, по желанию, соответствий по названию
  -- позиции учёта. Существующие соответствия не перезаписываются — их правят по одной.
  if action = 'stock_1c_catalog_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять справочник 1С'); end if;
    insert into tandem.catalog_1c (code, name, unit, account)
      select btrim(x->>'code'), btrim(x->>'name'), nullif(btrim(x->>'unit'), ''), nullif(btrim(x->>'account'), '')
        from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) x
       where nullif(btrim(x->>'code'), '') is not null and nullif(btrim(x->>'name'), '') is not null
      on conflict (code) do update set name = excluded.name, unit = excluded.unit, account = excluded.account;
    with l as (select lower(regexp_replace(btrim(x->>'name'), '[[:space:]]+', ' ', 'g')) as n, x->>'code' as code, (x->>'k')::numeric as k
                 from jsonb_array_elements(coalesce(payload->'links', '[]'::jsonb)) x
                where (x->>'k')::numeric > 0 and exists (select 1 from tandem.catalog_1c c where c.code = x->>'code'))
    update tandem.items i set code_1c = l.code, k_1c = l.k
      from l where lower(regexp_replace(btrim(i.name), '[[:space:]]+', ' ', 'g')) = l.n and i.active and i.code_1c is null;
    return jsonb_build_object('ok', true, 'catalog', (select count(*) from tandem.catalog_1c),
      'linked', (select count(*) from tandem.items where code_1c is not null));
  end if;

  -- Соответствие позиции учёта и позиции 1С: код 1С и сколько единиц 1С в одной нашей единице.
  -- Пустой код снимает соответствие.
  if action = 'stock_1c_link_save' then
    if not tandem.office_can(v_user.role, 'doc:sale', 'edit') then
      return tandem.err('forbidden', 'Нет права менять соответствия 1С'); end if;
    if not exists (select 1 from tandem.items where code = payload->>'item_code') then
      return tandem.err('not_found', 'Позиция не найдена'); end if;
    if nullif(payload->>'code_1c', '') is not null then
      if not exists (select 1 from tandem.catalog_1c where code = payload->>'code_1c') then
        return tandem.err('validation', 'Такой позиции в справочнике 1С нет'); end if;
      if coalesce(nullif(payload->>'k_1c', '')::numeric, 0) <= 0 then
        return tandem.err('validation', 'Коэффициент — число больше нуля: сколько единиц 1С в одной нашей'); end if;
    end if;
    update tandem.items set code_1c = nullif(payload->>'code_1c', ''),
           k_1c = case when nullif(payload->>'code_1c', '') is null then null else (payload->>'k_1c')::numeric end
     where code = payload->>'item_code';
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- ---------------------------------------------------------------- заявки: документы из плана
-- Документы из плана: акт производства на склад кухни (по факту выпуска, где он отмечен, иначе по заявке;
-- только позиции с техкартой) и перемещения с кухни на склады точек по заявкам. Создаются черновиками —
-- кладовщик проверяет и проводит. Повторный вызов недостающие документы досоздаёт, готовые не трогает.
-- 0041: склад кухни можно передать в вызов (p_store) — дымовой тест больше не меняет общую настройку
-- (ревью п. 39); вместо признака позиции sell_from_stock — строки store_ready, их ставит проведение этих
-- документов, а не создание (ревью п. 2, второй круг V4); выпуск раскладывается по точкам без потерь на
-- округлении (ревью п. 69).
drop function if exists tandem.orders_make_docs(date, tandem.users, boolean);
create or replace function tandem.orders_make_docs(p_for_date date, p_user tandem.users, p_force boolean default false,
                                                   p_store uuid default null) returns jsonb
language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_store uuid := coalesce(p_store, nullif((select value from tandem.settings where key = 'orders_store_id'), '')::uuid);
  v_lines jsonb;
  v_r     jsonb;
  v_made  int := 0;
  v_skip  text := '';
  v_bad   text;
  pt      record;
begin
  perform pg_advisory_xact_lock(hashtext('tandem.orders:' || p_for_date::text));
  if p_store is not null and not exists (select 1 from tandem.stores where id = p_store and active) then
    return tandem.err('validation', 'Склад кухни не найден или выключен'); end if;
  if v_store is null or not exists (select 1 from tandem.stores where id = v_store and active) then
    return tandem.err('validation', 'Не выбран склад кухни, с которого отгружаются заявки'); end if;
  if not exists (select 1 from tandem.orders where for_date = p_for_date) then
    return tandem.err('validation', 'На этот день заявок нет'); end if;
  if tandem.order_open(p_for_date) and not p_force then
    return tandem.err('validation', 'Приём заявок на этот день ещё открыт — точки могут поправить заявки. Создать документы всё равно?'); end if;
  -- Дробный выпуск штучных, отмеченный до 0041, при раскладке тихо терялся — пусть его исправят.
  select string_agg(i.name, ', ' order by i.name) into v_bad
    from tandem.order_plan pl join tandem.items i on i.code = pl.item_code
   where pl.for_date = p_for_date and i.unit_id in ('шт', 'порц') and pl.fact_qty <> trunc(pl.fact_qty);
  if v_bad is not null then
    return tandem.err('validation', 'Штучные позиции — выпуск только целым числом, исправьте выпуск: ' || v_bad); end if;

  create temp table if not exists _ord_alloc (point_id text, item_code text, qty numeric) on commit drop;
  truncate _ord_alloc;
  insert into _ord_alloc
  with b as (
    select o.point_id, l.item_code, l.qty, pl.fact_qty, i.unit_id in ('шт', 'порц') as whole,
           sum(l.qty) over (partition by l.item_code) as total
      from tandem.order_lines l join tandem.orders o on o.id = l.order_id
      join tandem.items i on i.code = l.item_code
      left join tandem.order_plan pl on pl.for_date = p_for_date and pl.item_code = l.item_code
     where o.for_date = p_for_date
  ), e as (
    select *, case when fact_qty is null then qty else qty * fact_qty / total end as exact from b
  ), f as (
    -- База: заявка как есть, если выпуск не отмечен; иначе доля выпуска — у штучных целая часть, у весовых
    -- с точностью 0,001 вниз. Остаток выпуска раздаётся ниже шагом 1 или 0,001 тем, у кого отброшенная
    -- часть больше, — сумма по точкам равна выпуску (у весовых прежде терялось до 0,001 на точку).
    select *, case when fact_qty is null then round(exact, 3)
                   when whole then floor(exact)
                   else trunc(exact, 3) end as base from e
  ), r as (
    select *, row_number() over (partition by item_code order by exact - base desc, point_id) as rn,
           case when fact_qty is null then 0
                when whole then fact_qty - sum(base) over (partition by item_code)
                else round((fact_qty - sum(base) over (partition by item_code)) * 1000) end as rest
      from f
  )
  select point_id, item_code, base + case when rn <= rest then case when whole then 1 else 0.001 end else 0 end from r;

  -- Документы плана датируются днём плана, а он бывает и позже завтрашнего: окно дат doc_save
  -- (не позже завтра) на время этого вызова открыто. Настройка живёт до конца транзакции,
  -- и выставить её можно только изнутри базы — через бэк-офис её не передать.
  perform set_config('tandem.orders_docs', '1', true);

  if not exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/production') then
    select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'qty', x.q)), '[]'::jsonb) into v_lines
      from (select a.item_code, sum(a.qty) q from _ord_alloc a
             where tandem.active_chart(a.item_code, p_for_date) is not null group by a.item_code) x where x.q > 0;
    if jsonb_array_length(v_lines) > 0 then
      v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'production', 'doc_date', p_for_date,
               'store_from', v_store, 'comment', 'План выпечки на ' || to_char(p_for_date, 'DD.MM.YYYY'), 'lines', v_lines), p_user);
      if not coalesce((v_r->>'ok')::boolean, false) then
        raise exception using errcode = 'P0001', message = 'Акт производства не создан: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
      update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/production' where id = (v_r->>'id')::uuid;
      -- Строки «готовым» (кухня — склад точки) ставит проведение акта, а не черновик (второй круг V4).
      v_made := v_made + 1;
    end if;
  end if;

  for pt in select o.point_id, p.name, p.default_store_id from tandem.orders o join tandem.points p on p.id = o.point_id
             where o.for_date = p_for_date order by p.sort_order loop
    continue when exists (select 1 from tandem.documents where source_kind = 'orders' and source_id = p_for_date::text || '/' || pt.point_id);
    if pt.default_store_id is null or pt.default_store_id = v_store then
      v_skip := v_skip || case when v_skip = '' then '' else ', ' end || pt.name; continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty)), '[]'::jsonb) into v_lines
      from _ord_alloc where point_id = pt.point_id and qty > 0;
    continue when jsonb_array_length(v_lines) = 0;
    v_r := tandem.office_stock('doc_save', jsonb_build_object('doc_type', 'transfer', 'doc_date', p_for_date,
             'store_from', v_store, 'store_to', pt.default_store_id, 'comment', 'Заявка «' || pt.name || '» на ' || to_char(p_for_date, 'DD.MM.YYYY'),
             'lines', v_lines), p_user);
    if not coalesce((v_r->>'ok')::boolean, false) then
      raise exception using errcode = 'P0001', message = 'Перемещение для «' || pt.name || '» не создано: ' || coalesce(v_r->>'message', v_r->>'error', 'ошибка'); end if;
    update tandem.documents set source_kind = 'orders', source_id = p_for_date::text || '/' || pt.point_id where id = (v_r->>'id')::uuid;
    -- Позиции с картой склад точки получает готовыми с дня плана — строку ставит проведение перемещения
    -- по его фактическим строкам, а не черновик (второй круг V4).
    v_made := v_made + 1;
  end loop;
  perform set_config('tandem.orders_docs', '', true);
  return jsonb_build_object('ok', true, 'made', v_made, 'skipped', nullif(v_skip, ''));
end $$;

-- ---------------------------------------------------------------- «Готовность»
create or replace function tandem.quality_report(p_user tandem.users)
returns jsonb language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_checks jsonb := '[]'::jsonb;
  v_rows   jsonb;
  v_count  int;
begin
  -- 1. Сырьё без учётной цены, стоящее в действующих картах: от него зависит себестоимость блюд.
  with ing as (
    select cl.ingredient_code as code, count(distinct c.item_code) as dishes
      from tandem.chart_lines cl
      join tandem.charts c on c.id = cl.chart_id and (c.date_to is null or c.date_to >= current_date) and c.date_from <= current_date
      join tandem.items d on d.code = c.item_code and d.active
     group by cl.ingredient_code
  ), bad as (
    -- Полуфабрикат-ингредиент без своей карты («Вода ПФ») так же обрывает расчёт: его учётную
    -- цену расчёт не читает, поэтому лечится картой либо сменой типа на «товар» с ценой.
    select i.code, i.name, ing.dishes,
           case when i.item_type = 'goods' then ''
                when exists (select 1 from tandem.charts x where x.item_code = i.code)
                  then ' — у полуфабриката нет действующей техкарты: продлите или заведите карту на сегодня'
                else ' — полуфабрикат без техкарты: заведите карту или смените тип на «товар» и задайте цену' end as how
      from ing join tandem.items i on i.code = ing.code
     where (i.item_type = 'goods' and i.cost_price is null)
        or (i.item_type in ('dish','prepared') and tandem.active_chart(i.code, current_date) is null)
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name,
           'detail', 'стоит в ' || dishes || ' карт.' || how) order by dishes desc, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (select *, row_number() over (order by dishes desc, name) rn from bad) x;
  v_checks := v_checks || jsonb_build_object('id', 'raw_no_cost', 'severity', 'bad', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Сырьё без цены, из-за которого не считается себестоимость',
    'hint', 'Пока цены нет, себестоимость блюд с этим сырьём не считается. Цена появится сама после первого прихода, либо задайте её в карточке.');

  -- 2. Блюда на продаже без действующей техкарты: при продаже спишутся «как есть», а не сырьём.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.item_type in ('dish','prepared')
         and tandem.active_chart(i.code, current_date) is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'dish_no_chart', 'severity', 'bad', 'target', 'chart', 'count', v_count, 'rows', v_rows,
    'title', 'Блюда на продаже без техкарты',
    'hint', 'Продажа такого блюда спишет со склада само блюдо, а не продукты. Заведите техкарту или снимите блюдо с продажи.');

  -- 3. Позиции на продаже без цены — ни общей, ни по точкам.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', category) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, coalesce(g.name, '') as category, row_number() over (order by i.name) rn
        from tandem.items i left join tandem.item_groups g on g.id = i.group_id
       where i.active and i.for_sale and i.price is null
         and not exists (select 1 from tandem.item_prices p where p.item_code = i.code)) x;
  v_checks := v_checks || jsonb_build_object('id', 'sale_no_price', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'На продаже без цены',
    'hint', 'Точка увидит позицию без цены, выручка по ней посчитается нулём. Задайте цену в карточке или снимите с продажи.');

  -- 4. Одинаковые названия у действующих позиций: путаница при приёмке и загрузке остатков по названию.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', 'код ' || code || ', ' || kind) order by name, code) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name, i.code) rn
        from tandem.items i
       where i.active and lower(btrim(i.name)) in (select lower(btrim(name)) from tandem.items where active group by 1 having count(*) > 1)) x;
  v_checks := v_checks || jsonb_build_object('id', 'dup_names', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Одинаковые названия',
    'hint', 'Две действующие позиции с одним названием. Лишнюю выключите или переименуйте — иначе загрузка остатков по названию их пропустит.');

  -- 5. Позиции без группы.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', kind) order by name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select i.code, i.name, i.item_type as kind, row_number() over (order by i.name) rn
        from tandem.items i where i.active and i.group_id is null) x;
  v_checks := v_checks || jsonb_build_object('id', 'no_group', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Позиции без группы', 'hint', 'Их не видно в дереве групп и в отчётах по группам.');

  -- 6. Точки без склада: продажи этих точек склад не списывают.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', id, 'name', name, 'detail', 'продажи не списывают склад') order by sort_order), '[]'::jsonb)
    into v_count, v_rows from tandem.points p
   where p.active and (p.default_store_id is null
      or not exists (select 1 from tandem.stores s where s.id = p.default_store_id and s.active));
  v_checks := v_checks || jsonb_build_object('id', 'point_no_store', 'severity', 'bad', 'target', 'store', 'count', v_count, 'rows', v_rows,
    'title', 'Точки без склада',
    'hint', 'В разделе «Склады» откройте склад точки, выберите точку и отметьте «склад точки по умолчанию».');

  -- 7. Продажи, которые не проведены или устарели, за последние 45 дней — и отчёты точек с действующим
  -- складом, по которым документ продажи так и не создан: склад привязали позже, или первое создание
  -- сорвалось и пометку ставить было некуда (0041, ревью п. 70). Отчёт без проданного (только услуги,
  -- вынос вернули) документа и не должен иметь — его не показываем.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', number, 'name', point_name || ' · ' || doc_date, 'detail', detail) order by doc_date desc) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select y.*, row_number() over (order by y.doc_date desc, y.point_name) rn from (
        select d.number, d.doc_date, coalesce(d.sync_note, 'не проведена') as detail, p.name as point_name
          from tandem.documents d
          join tandem.daily_reports r on d.source_kind = 'daily_report' and d.source_id = r.id::text
          join tandem.points p on p.id = r.point_id
         where d.doc_type = 'sale' and d.doc_date >= current_date - 45
           -- и помеченные пересчётом «готовым» или не пересчитанные после него (второй круг V7, V10)
           and (d.status <> 'posted' or d.sync_note like 'Сбой%' or d.sync_note like 'Отчёт изменён%'
                or d.sync_note like 'Пересчёт:%' or d.sync_note like 'Не пересчитана%')
           and tandem.user_store_ok(p_user.id, d.store_from)
        union all
        select null, r.report_date, 'продажа не создана — нажмите «Провести продажи за период»', p.name
          from tandem.daily_reports r
          join tandem.points p on p.id = r.point_id
          join tandem.stores s on s.id = p.default_store_id and s.active
         where r.report_date >= current_date - 45
           and tandem.user_store_ok(p_user.id, p.default_store_id)
           and not exists (select 1 from tandem.documents d where d.source_kind = 'daily_report' and d.source_id = r.id::text)
           and exists (select 1 from (select sl.item_code, sl.qty as q from tandem.sale_lines sl
                                       where sl.report_id = r.id and sl.item_code is not null
                                      union all
                                      select t.item_code, t.issued - t.returned from tandem.takeout_lines t
                                       where t.report_id = r.id and t.item_code is not null) u
                         join tandem.items i on i.code = u.item_code
                        where i.item_type <> 'service' group by u.item_code having sum(u.q) > 0)) y) x;
  v_checks := v_checks || jsonb_build_object('id', 'sales_not_posted', 'severity', 'bad', 'target', 'sale', 'count', v_count, 'rows', v_rows,
    'title', 'Продажи не проведены', 'hint', 'Откройте вкладку «Продажи» и нажмите «Провести продажи за период». Если мешает инвентаризация — причина написана в строке.');

  -- 8. Отрицательные остатки.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'detail', store_name || ': ' || qty) order by store_name, name) filter (where rn <= 300), '[]'::jsonb)
    into v_count, v_rows from (
      select b.item_code as code, i.name, s.name as store_name, round(b.qty, 3) as qty, row_number() over (order by s.name, i.name) rn
        from tandem.stock_balances b join tandem.items i on i.code = b.item_code join tandem.stores s on s.id = b.store_id
       where b.qty < 0 and tandem.user_store_ok(p_user.id, b.store_id)) x;
  v_checks := v_checks || jsonb_build_object('id', 'negative_stock', 'severity', 'warn', 'target', 'item', 'count', v_count, 'rows', v_rows,
    'title', 'Остаток в минусе',
    'hint', 'Продано или списано больше, чем числилось: не внесён приход, не проведено производство или нет стартовой инвентаризации.');

  -- 9. Пользователи: временный PIN и кладовщики без закреплённых складов. Видит только администратор.
  if p_user.role = 'admin' then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('code', login, 'name', name, 'detail', what) order by name), '[]'::jsonb)
      into v_count, v_rows from (
        select u.login, u.name, 'временный PIN — ещё ни разу не входил' as what from tandem.users u where u.active and u.must_change_pin
        union all
        select u.login, u.name, 'кладовщик без закреплённых складов — видит все склады' from tandem.users u
         where u.active and u.role = 'storekeeper' and not exists (select 1 from tandem.user_stores us where us.user_id = u.id)) x;
    v_checks := v_checks || jsonb_build_object('id', 'users', 'severity', 'warn', 'target', 'user', 'count', v_count, 'rows', v_rows,
      'title', 'Пользователи', 'hint', 'Раздел «Пользователи»: закрепите склады за кладовщиками, напомните про первый вход.');
  end if;

  return jsonb_build_object('ok', true, 'checks', v_checks,
    'bad', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'bad' and (c->>'count')::int > 0),
    'warn', (select count(*) from jsonb_array_elements(v_checks) c where c->>'severity' = 'warn' and (c->>'count')::int > 0));
end $$;

-- ---------------------------------------------------------------- признак позиции больше не нужен
-- Решение «продавать готовым» теперь за складом и датой (store_ready). На момент миграции признак
-- не стоял ни у одной позиции (проверено по живой базе), переносить нечего.
alter table tandem.items drop column if exists sell_from_stock;

-- Стоимость остатков — по движениям: колонка value и строки-поправки adj (второй круг V2) заполняются
-- пересборкой всех пар; повторный прогон пересчитывает поправки заново и даёт то же самое.
do $$ begin perform tandem.rebuild_balances(); end $$;

-- ---------------------------------------------------------------- права
do $$
declare f text;
begin
  foreach f in array array[
    'tandem.move_step(numeric,numeric,numeric,numeric,numeric)',
    'tandem.apply_move(uuid,uuid,uuid,text,numeric,numeric,date)', 'tandem.rebuild_balance(uuid,text)',
    'tandem.rebuild_balances()', 'tandem.store_avg(uuid,text)', 'tandem.stock_qty_at(uuid,text,date)',
    'tandem.doc_post(uuid,tandem.users)', 'tandem.doc_unpost(uuid,tandem.users)', 'tandem.doc_preview(uuid)',
    'tandem.sale_sync(bigint)', 'tandem.store_ready_mark(uuid,text,date,date)',
    'tandem.store_ready_resync_next(uuid,uuid,integer)', 'tandem.store_ready_orders_recalc(uuid,text,uuid)',
    'tandem.store_ready_set(uuid,text,date,text)', 'tandem.office_stock(text,jsonb,tandem.users)',
    'tandem.office_stock_ext(text,jsonb,tandem.users)', 'tandem.orders_make_docs(date,tandem.users,boolean,uuid)',
    'tandem.quality_report(tandem.users)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute 'revoke all on function ' || f || ' from anon, authenticated';
      execute 'grant execute on function ' || f || ' to service_role';
    end if;
  end loop;
end $$;
