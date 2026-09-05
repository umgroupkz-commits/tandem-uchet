# Подпроект «Документы склада», план 3а (данные, проведение, бэк-офис)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Документы склада пяти типов (приход, перемещение, списание, производство, инвентаризация) с проведением и отменой, движения и остатки со средневзвешенной себестоимостью, раздел «Склад» в бэк-офисе — по спецификации `docs/superpowers/specs/2026-09-05-uchet-stock-design.md` (телефонный экран — план 3б).

**Architecture:** Всё в PostgreSQL (Supabase, схема `tandem`): таблицы `documents`, `document_lines`, `stock_moves`, `stock_balances`, `doc_counters`; ядро проведения — функции `tandem.apply_move`, `tandem.doc_post`, `tandem.doc_unpost`, `tandem.doc_preview`, `tandem.rebuild_balance(s)`; раздел RPC `tandem.office_stock` за диспетчером `public.tandem_office`. Фронт — модуль `js/office/stock.js` в существующей оболочке.

**Tech Stack:** PostgreSQL 15 (plpgsql), Supabase Edge Function `uchet` (без новых маршрутов), ванильный JS (ES-модули), Node 24 для дымового теста.

## Global Constraints

- Вся логика — в SQL обычного PostgreSQL; никаких функций, доступных лишь в Supabase (спецификация ядра 3.1а).
- Ошибки RPC — `{ok:false, error:<код>, message:<по-русски>}`; коды `unauthorized`, `forbidden`, `not_found`, `validation`, `unknown_action`.
- Права: раздел `stock` — admin/owner/storekeeper/accountant/technologist view+edit; разделы `doc:invoice_in` (admin, owner, storekeeper, accountant), `doc:transfer` (admin, owner, storekeeper), `doc:writeoff` (admin, owner, storekeeper), `doc:production` (admin, owner, technologist, storekeeper), `doc:inventory` (admin, owner, storekeeper) — view+edit у перечисленных. Диспетчер выводит право из имени действия (`*_list/_get/_preview` и `stock_balances/stock_moves/item_stock` → view, иначе edit); проверку `doc:<тип>` делает `office_stock` внутри.
- Средняя себестоимость: `avg = (qty_было × avg_было + qty × цена) / (qty_было + qty)`; при `qty_было <= 0` — `avg = цена`; округление до 4 знаков. Расход — по средней склада-источника; если её нет — `items.cost_price`, иначе 0.
- Отрицательный остаток допускается; проведение возвращает `warnings`.
- Инвентаризация: `calc_qty` — текущий остаток на момент проведения; проведённая инвентаризация запрещает `doc_unpost` более ранних (по `posted_at`) документов, двигавших её склад.
- Производство раскрывает карту на один уровень; строки расхода `line_kind='consume'` генерируются при проведении и удаляются при отмене; выпуск приходуется по `Σ расход / qty`.
- Номера: `ПН|ПМ|СП|АП|ИН-ГГГГ-NNNNNN` из `doc_counters`, выдаются при первом сохранении.
- Приход обновляет `items.cost_price/cost_date/cost_source='document'`; отмена прихода `cost_price` не откатывает.
- Тестовые сущности — `ZZ_TEST_`/`zz_test_`; `tandem_test_cleanup` чистит документы тестовых складов и позиций; после прогона `leftovers = 0`.
- Секреты только в окружении/скретчпаде (`TANDEM_ADMIN_PIN`, `TANDEM_OWNER_PIN`); в файлы и отчёты не писать.
- Миграции — файлом `db/migrations/00NN_*.sql` + `apply_migration` тем же именем; функция в базе = файл; права `service_role` в DO-обёртке `if exists (select 1 from pg_roles where rolname='service_role')`; функции разделов — `security invoker`, `revoke all … from public`.
- Диспетчер `tandem_office` — `IF/ELSIF`; при правке брать актуальное тело из базы (`pg_get_functiondef`).
- Коммиты: `git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit`, хвост `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Экраны точек и прежние разделы бэк-офиса не меняют поведения.

---

## Карта файлов

| Файл | Ответственность |
|------|-----------------|
| `db/migrations/0015_stock_schema.sql` | таблицы документов, строк, движений, остатков, счётчиков; права разделов; RLS |
| `db/migrations/0016_stock_core.sql` | `tandem.next_doc_number`, `tandem.store_avg`, `tandem.apply_move`, `tandem.rebuild_balance`, `tandem.rebuild_balances`, `tandem.doc_consume_plan`, `tandem.doc_preview`, `tandem.doc_post`, `tandem.doc_unpost` |
| `db/migrations/0017_office_stock.sql` | `tandem.office_stock`, маршрут `doc%`/`stock%` в диспетчере, расширение `tandem_test_cleanup` |
| `tools/office-smoke.mjs` | раздел `stock` (контрольный сценарий, права, номера, пересборка) |
| `js/office/stock.js` | вкладки «Документы» и «Остатки», форма документа, предпросмотр проведения |
| `js/office/nomenclature.js` | блок «Остатки по складам» и движения в карточке |
| `js/office/app.js`, `js/office/api.js`, `office.html`, `office.css` | раздел `stock`, сборка 3, стили |
| `README.md`, спецификация | документация и уточнения |

Соглашение по действиям (`{action:"office_<имя>", payload}` с `token`):
- `office_docs_list {doc_type?, store_id?, status?, date_from?, date_to?, q?, page?}` → `{ok, rows:[{id,number,doc_type,doc_date,status,store_from,store_from_name,store_to,store_to_name,counteragent_id,counteragent_name,reason,comment,total_sum,created_by_name,posted_at}], total, page, pages}`
- `office_doc_get {id}` → `{ok, doc:{…шапка…, lines:[{id,item_code,name,unit_id,qty,price,sum,fact_qty,calc_qty,current_qty,note,sort_order}], consume:[{item_code,name,unit_id,qty,price,sum}]}}`
- `office_doc_save {id?, doc_type, doc_date, store_from?, store_to?, counteragent_id?, reason?, comment?, lines:[{item_code, qty?, fact_qty?, price?, note?}]}` → `{ok, id, number}`
- `office_doc_preview {id}` → `{ok, warnings:[{item_code,name,store_id,store_name,balance_after}], consume:[{item_code,name,unit_id,qty,price,sum}]}`
- `office_doc_post {id}` → `{ok, warnings:[…], total_sum}`; `office_doc_unpost {id}` → `{ok}`; `office_doc_delete {id}` → `{ok}`
- `office_stock_balances {store_id?, q?, only_nonzero?, page?}` → `{ok, rows:[{store_id,store_name,item_code,name,unit_id,qty,avg_cost,sum}], total, page, pages, total_sum, csv}`
- `office_stock_moves {store_id?, item_code?, date_from?, date_to?, page?}` → `{ok, rows:[{id,move_date,posted_at,store_name,item_code,name,qty,unit_cost,sum,document_id,number,doc_type}], total, page, pages}`
- `office_item_stock {code}` → `{ok, balances:[{store_id,store_name,qty,avg_cost}], moves:[…20 последних…]}`
- `office_stock_rebuild {}` → `{ok, mismatches_before}` (только `admin`)
- Справочники для форм: `office_stores_list`, `office_counteragents_list {kind:'supplier'}`, `office_items_search`.

---

### Task 1: Схема документов, движений, остатков и прав

**Files:**
- Create: `db/migrations/0015_stock_schema.sql`

**Interfaces:**
- Produces таблицы `tandem.documents`, `tandem.document_lines`, `tandem.stock_moves`, `tandem.stock_balances`, `tandem.doc_counters`; строки `role_permissions` разделов `stock` и `doc:*`.

- [ ] **Step 1: Проверка «до»**

`execute_sql` (project `qeehxcnnuzuwskznhdyg`):
```sql
select to_regclass('tandem.documents') d, to_regclass('tandem.stock_moves') m,
       (select count(*) from tandem.role_permissions where section='stock' or section like 'doc:%') perms;
```
Expected: `d = null, m = null, perms = 0`.

- [ ] **Step 2: Миграция 0015**

```sql
-- Документы склада: схема.
create table if not exists tandem.documents (
  id              uuid primary key default gen_random_uuid(),
  doc_type        text not null check (doc_type in ('invoice_in','transfer','writeoff','production','inventory')),
  number          text not null unique,
  doc_date        date not null default current_date,
  status          text not null default 'draft' check (status in ('draft','posted')),
  store_from      uuid null references tandem.stores(id),
  store_to        uuid null references tandem.stores(id),
  counteragent_id uuid null references tandem.counteragents(id),
  reason          text null check (reason is null or reason in ('spoilage','tasting','staff_meals','other')),
  comment         text null,
  total_sum       numeric null,
  created_by      uuid null references tandem.users(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid null references tandem.users(id),
  updated_at      timestamptz not null default now(),
  posted_by       uuid null references tandem.users(id),
  posted_at       timestamptz null,
  constraint documents_stores_by_type check (
    case doc_type
      when 'invoice_in' then store_to is not null and counteragent_id is not null
      when 'transfer'   then store_from is not null and store_to is not null and store_from <> store_to
      else store_from is not null
    end)
);
create index if not exists documents_date_idx on tandem.documents (doc_date desc, created_at desc);
create index if not exists documents_type_status_idx on tandem.documents (doc_type, status);

create table if not exists tandem.document_lines (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references tandem.documents(id) on delete cascade,
  line_kind   text not null default 'item' check (line_kind in ('item','consume')),
  item_code   text not null references tandem.items(code),
  qty         numeric not null default 0 check (qty >= 0),
  unit_id     text null references tandem.units(id),
  price       numeric null,
  sum         numeric null,
  fact_qty    numeric null,
  calc_qty    numeric null,
  note        text null,
  sort_order  int not null default 0
);
create index if not exists document_lines_doc_idx on tandem.document_lines (document_id, line_kind, sort_order);

create table if not exists tandem.stock_moves (
  id          bigserial primary key,
  document_id uuid not null references tandem.documents(id) on delete cascade,
  line_id     uuid null references tandem.document_lines(id) on delete set null,
  store_id    uuid not null references tandem.stores(id),
  item_code   text not null references tandem.items(code),
  qty         numeric not null,
  unit_cost   numeric not null default 0,
  move_date   date not null,
  posted_at   timestamptz not null default now()
);
create index if not exists stock_moves_store_item_idx on tandem.stock_moves (store_id, item_code, move_date, id);
create index if not exists stock_moves_doc_idx on tandem.stock_moves (document_id);

create table if not exists tandem.stock_balances (
  store_id   uuid not null references tandem.stores(id),
  item_code  text not null references tandem.items(code),
  qty        numeric not null default 0,
  avg_cost   numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (store_id, item_code)
);

create table if not exists tandem.doc_counters (
  doc_type text not null,
  year     int  not null,
  last_no  int  not null default 0,
  primary key (doc_type, year)
);

insert into tandem.role_permissions (role, section, action)
select r, s, a from (values
  ('admin','stock','view'),('admin','stock','edit'),('owner','stock','view'),('owner','stock','edit'),
  ('storekeeper','stock','view'),('storekeeper','stock','edit'),('accountant','stock','view'),('accountant','stock','edit'),
  ('technologist','stock','view'),('technologist','stock','edit'),
  ('admin','doc:invoice_in','view'),('admin','doc:invoice_in','edit'),('owner','doc:invoice_in','view'),('owner','doc:invoice_in','edit'),
  ('storekeeper','doc:invoice_in','view'),('storekeeper','doc:invoice_in','edit'),('accountant','doc:invoice_in','view'),('accountant','doc:invoice_in','edit'),
  ('admin','doc:transfer','view'),('admin','doc:transfer','edit'),('owner','doc:transfer','view'),('owner','doc:transfer','edit'),
  ('storekeeper','doc:transfer','view'),('storekeeper','doc:transfer','edit'),
  ('admin','doc:writeoff','view'),('admin','doc:writeoff','edit'),('owner','doc:writeoff','view'),('owner','doc:writeoff','edit'),
  ('storekeeper','doc:writeoff','view'),('storekeeper','doc:writeoff','edit'),
  ('admin','doc:production','view'),('admin','doc:production','edit'),('owner','doc:production','view'),('owner','doc:production','edit'),
  ('technologist','doc:production','view'),('technologist','doc:production','edit'),('storekeeper','doc:production','view'),('storekeeper','doc:production','edit'),
  ('admin','doc:inventory','view'),('admin','doc:inventory','edit'),('owner','doc:inventory','view'),('owner','doc:inventory','edit'),
  ('storekeeper','doc:inventory','view'),('storekeeper','doc:inventory','edit')
) v(r, s, a)
on conflict do nothing;

alter table tandem.documents      enable row level security;
alter table tandem.document_lines enable row level security;
alter table tandem.stock_moves    enable row level security;
alter table tandem.stock_balances enable row level security;
alter table tandem.doc_counters   enable row level security;
```

Применить `apply_migration(name: "0015_stock_schema")`.

- [ ] **Step 3: Проверка «после»**

```sql
select (select count(*) from tandem.role_permissions where section='stock') stock_perms,
       (select count(*) from tandem.role_permissions where section like 'doc:%') doc_perms,
       (select conname from pg_constraint where conname='documents_stores_by_type') chk;
```
Expected: `stock_perms = 10, doc_perms = 32, chk = 'documents_stores_by_type'`.
Проверить ограничение действием: `insert into tandem.documents (doc_type, number) values ('invoice_in','ZZ_TEST_x');` → ошибка `documents_stores_by_type`; `select count(*) from tandem.documents` → 0.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0015_stock_schema.sql
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад: схема документов, движений, остатков и прав

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Ядро проведения

**Files:**
- Create: `db/migrations/0016_stock_core.sql`

**Interfaces:**
- Consumes: таблицы Task 1; `tandem.active_chart`, `tandem.office_can`, `tandem.err`, `items.cost_price`.
- Produces:
  - `tandem.next_doc_number(p_type text, p_date date) → text`
  - `tandem.store_avg(p_store uuid, p_item text) → numeric` (средняя склада, иначе `cost_price`, иначе 0)
  - `tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text, p_qty numeric, p_cost numeric, p_date date) → void`
  - `tandem.rebuild_balance(p_store uuid, p_item text) → void`, `tandem.rebuild_balances() → int` (расхождений до пересборки)
  - `tandem.doc_consume_plan(p_doc uuid) → table(line_id uuid, item_code text, qty numeric)` — расход по картам для производства (агрегировано по строке выпуска и ингредиенту)
  - `tandem.doc_preview(p_doc uuid) → jsonb {warnings, consume}`
  - `tandem.doc_post(p_doc uuid, p_user tandem.users) → jsonb {ok, warnings, total_sum}` / ошибка
  - `tandem.doc_unpost(p_doc uuid, p_user tandem.users) → jsonb {ok}` / ошибка

- [ ] **Step 1: Тест (проваливается)**

Один `execute_sql` — данные и сценарий из спецификации §8 (администратор для `p_user`):
```sql
-- тестовые данные
insert into tandem.stores (id, name, active) values
  ('bbbbbbbb-0000-4000-8000-000000000001','ZZ_TEST_склад А',true),
  ('bbbbbbbb-0000-4000-8000-000000000002','ZZ_TEST_склад Б',true);
insert into tandem.counteragents (id, name, kind) values ('cccccccc-0000-4000-8000-000000000001','ZZ_TEST_ИП','supplier');
insert into tandem.items (code, name, unit, unit_id, step, item_type, product_type, active, for_sale, source) values
  ('ZZ_TEST_muka','ZZ_TEST_мука','кг','кг',0.5,'goods','GOODS',true,false,'office'),
  ('ZZ_TEST_testo','ZZ_TEST_тесто','кг','кг',0.5,'prepared','PREPARED',true,false,'office');
insert into tandem.charts (id, item_code, date_from, output_amount) values ('aaaaaaaa-0000-4000-8000-000000000011','ZZ_TEST_testo','2026-01-01',0.45);
insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output) values ('aaaaaaaa-0000-4000-8000-000000000011','ZZ_TEST_muka',0.5,0.5,0.45);
-- приход 1
insert into tandem.documents (id, doc_type, number, doc_date, store_to, counteragent_id) values
  ('dddddddd-0000-4000-8000-000000000001','invoice_in', tandem.next_doc_number('invoice_in', current_date), current_date,
   'bbbbbbbb-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001');
insert into tandem.document_lines (document_id, item_code, qty, unit_id, price) values ('dddddddd-0000-4000-8000-000000000001','ZZ_TEST_muka',10,'кг',100);
select tandem.doc_post('dddddddd-0000-4000-8000-000000000001', (select u from tandem.users u where login='admin'));
select qty, avg_cost from tandem.stock_balances where store_id='bbbbbbbb-0000-4000-8000-000000000001' and item_code='ZZ_TEST_muka';
```
Expected сейчас: ошибка «function tandem.next_doc_number … does not exist». Записать. Данные (stores/counteragents/items/charts) останутся до очистки в Step 4; вставка документа не выполнится.

- [ ] **Step 2: Миграция 0016**

```sql
-- Документы склада: ядро проведения.

create or replace function tandem.next_doc_number(p_type text, p_date date)
returns text language plpgsql as $$
declare v_no int; v_year int := extract(year from p_date)::int; v_pref text;
begin
  v_pref := case p_type when 'invoice_in' then 'ПН' when 'transfer' then 'ПМ' when 'writeoff' then 'СП'
                        when 'production' then 'АП' when 'inventory' then 'ИН' else 'ДК' end;
  insert into tandem.doc_counters (doc_type, year, last_no) values (p_type, v_year, 1)
    on conflict (doc_type, year) do update set last_no = tandem.doc_counters.last_no + 1
    returning last_no into v_no;
  return v_pref || '-' || v_year || '-' || lpad(v_no::text, 6, '0');
end $$;

-- Себестоимость для расхода: средняя склада, иначе учётная цена позиции, иначе 0.
create or replace function tandem.store_avg(p_store uuid, p_item text)
returns numeric language sql stable as $$
  select coalesce((select avg_cost from tandem.stock_balances where store_id = p_store and item_code = p_item and qty > 0),
                  (select cost_price from tandem.items where code = p_item), 0)
$$;

-- Одно движение + пересчёт остатка и средней. Средняя меняется только приходом (qty > 0).
create or replace function tandem.apply_move(p_doc uuid, p_line uuid, p_store uuid, p_item text,
                                             p_qty numeric, p_cost numeric, p_date date)
returns void language plpgsql as $$
declare v_qty numeric; v_avg numeric; v_cost numeric := coalesce(p_cost, 0);
begin
  if p_qty = 0 then return; end if;
  insert into tandem.stock_moves (document_id, line_id, store_id, item_code, qty, unit_cost, move_date)
    values (p_doc, p_line, p_store, p_item, p_qty, v_cost, p_date);
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost) values (p_store, p_item, 0, 0)
    on conflict (store_id, item_code) do nothing;
  select qty, avg_cost into v_qty, v_avg from tandem.stock_balances
    where store_id = p_store and item_code = p_item for update;
  if p_qty > 0 then
    if v_qty <= 0 then v_avg := v_cost;
    else v_avg := round((v_qty * v_avg + p_qty * v_cost) / (v_qty + p_qty), 4); end if;
  end if;
  update tandem.stock_balances set qty = v_qty + p_qty, avg_cost = v_avg, updated_at = now()
    where store_id = p_store and item_code = p_item;
end $$;

-- Пересборка остатка пары из движений той же формулой в порядке проведения.
create or replace function tandem.rebuild_balance(p_store uuid, p_item text)
returns void language plpgsql as $$
declare r record; v_qty numeric := 0; v_avg numeric := 0;
begin
  for r in select qty, unit_cost from tandem.stock_moves where store_id = p_store and item_code = p_item
           order by posted_at, id loop
    if r.qty > 0 then
      if v_qty <= 0 then v_avg := r.unit_cost;
      else v_avg := round((v_qty * v_avg + r.qty * r.unit_cost) / (v_qty + r.qty), 4); end if;
    end if;
    v_qty := v_qty + r.qty;
  end loop;
  insert into tandem.stock_balances (store_id, item_code, qty, avg_cost, updated_at)
    values (p_store, p_item, v_qty, v_avg, now())
    on conflict (store_id, item_code) do update set qty = excluded.qty, avg_cost = excluded.avg_cost, updated_at = now();
end $$;

create or replace function tandem.rebuild_balances()
returns int language plpgsql as $$
declare r record; v_bad int := 0; v_qty numeric; v_avg numeric;
begin
  for r in select store_id, item_code from tandem.stock_balances
           union select store_id, item_code from tandem.stock_moves loop
    select qty, avg_cost into v_qty, v_avg from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code;
    perform tandem.rebuild_balance(r.store_id, r.item_code);
    if v_qty is distinct from (select qty from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code)
       or v_avg is distinct from (select avg_cost from tandem.stock_balances where store_id = r.store_id and item_code = r.item_code) then
      v_bad := v_bad + 1;
    end if;
  end loop;
  return v_bad;
end $$;

-- Расход по картам для акта производства: по каждой строке выпуска — ингредиенты первого уровня.
create or replace function tandem.doc_consume_plan(p_doc uuid)
returns table(line_id uuid, item_code text, qty numeric) language sql stable as $$
  select l.id, cl.ingredient_code, sum(cl.brutto * l.qty / c.output_amount)
  from tandem.document_lines l
  join tandem.documents d on d.id = l.document_id
  join tandem.charts c on c.id = tandem.active_chart(l.item_code, d.doc_date)
  join tandem.chart_lines cl on cl.chart_id = c.id
  where l.document_id = p_doc and l.line_kind = 'item'
  group by l.id, cl.ingredient_code
$$;

-- Предпросмотр: расход производства и позиции, уходящие в минус. Ничего не пишет.
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
  -- исходящие количества по паре (склад, позиция)
  with outgoing as (
    select d.store_from as store_id, l.item_code, sum(l.qty) as q
      from tandem.document_lines l where l.document_id = p_doc and l.line_kind = 'item'
       and d.doc_type in ('transfer','writeoff') group by l.item_code
    union all
    select d.store_from, p.item_code, sum(p.qty) from tandem.doc_consume_plan(p_doc) p
      where d.doc_type = 'production' group by p.item_code
    union all
    select d.store_from, l.item_code, greatest(coalesce(b.qty,0) - coalesce(l.fact_qty,0), 0)
      from tandem.document_lines l left join tandem.stock_balances b on b.store_id = d.store_from and b.item_code = l.item_code
      where l.document_id = p_doc and l.line_kind = 'item' and d.doc_type = 'inventory'
  ),
  agg as (select store_id, item_code, sum(q) q from outgoing where q > 0 group by store_id, item_code)
  select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'name', i.name, 'store_id', a.store_id,
           'store_name', s.name, 'balance_after', round(coalesce(b.qty,0) - a.q, 4)) order by i.name), '[]'::jsonb)
    into v_warn
    from agg a join tandem.items i on i.code = a.item_code join tandem.stores s on s.id = a.store_id
    left join tandem.stock_balances b on b.store_id = a.store_id and b.item_code = a.item_code
    where coalesce(b.qty,0) - a.q < 0 and d.doc_type <> 'inventory';
  return jsonb_build_object('warnings', v_warn, 'consume', v_consume);
end $$;

-- Проведение: одна транзакция.
create or replace function tandem.doc_post(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare
  d record; l record; c record;
  v_cost numeric; v_sum numeric := 0; v_line_sum numeric; v_calc numeric; v_diff numeric;
  v_chart uuid; v_missing text[] := '{}'; v_warn jsonb; v_lines int;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'draft' then return tandem.err('validation', 'Документ уже проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права проводить документы этого типа');
  end if;
  if d.store_from is not null and not exists (select 1 from tandem.stores where id = d.store_from and active) then
    return tandem.err('validation', 'Склад-источник выключен или не найден'); end if;
  if d.store_to is not null and not exists (select 1 from tandem.stores where id = d.store_to and active) then
    return tandem.err('validation', 'Склад-получатель выключен или не найден'); end if;
  select count(*) into v_lines from tandem.document_lines where document_id = p_doc and line_kind = 'item';
  if v_lines = 0 then return tandem.err('validation', 'В документе нет строк'); end if;
  if exists (select 1 from tandem.document_lines l join tandem.items i on i.code = l.item_code
             where l.document_id = p_doc and l.line_kind = 'item' and not i.active) then
    return tandem.err('validation', 'В документе есть выключенные позиции'); end if;

  if d.doc_type = 'invoice_in' then
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      if l.qty <= 0 then return tandem.err('validation', 'Количество должно быть больше нуля: ' || l.item_code); end if;
      if l.price is null or l.price < 0 then return tandem.err('validation', 'Укажите цену: ' || l.item_code); end if;
      perform tandem.apply_move(p_doc, l.id, d.store_to, l.item_code, l.qty, l.price, d.doc_date);
      v_line_sum := round(l.qty * l.price, 2);
      update tandem.document_lines set sum = v_line_sum where id = l.id;
      update tandem.items set cost_price = l.price, cost_date = d.doc_date, cost_source = 'document' where code = l.item_code;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'transfer' then
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      if l.qty <= 0 then return tandem.err('validation', 'Количество должно быть больше нуля: ' || l.item_code); end if;
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      perform tandem.apply_move(p_doc, l.id, d.store_to,   l.item_code,  l.qty, v_cost, d.doc_date);
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'writeoff' then
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      if l.qty <= 0 then return tandem.err('validation', 'Количество должно быть больше нуля: ' || l.item_code); end if;
      v_cost := tandem.store_avg(d.store_from, l.item_code);
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, -l.qty, v_cost, d.doc_date);
      v_line_sum := round(l.qty * v_cost, 2);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'production' then
    for l in select l.*, i.item_type from tandem.document_lines l join tandem.items i on i.code = l.item_code
             where l.document_id = p_doc and l.line_kind = 'item' order by l.sort_order loop
      if l.qty <= 0 then return tandem.err('validation', 'Количество должно быть больше нуля: ' || l.item_code); end if;
      if l.item_type not in ('dish','prepared') then return tandem.err('validation', 'Выпускать можно только блюда и полуфабрикаты: ' || l.item_code); end if;
      if tandem.active_chart(l.item_code, d.doc_date) is null then v_missing := v_missing || l.item_code; end if;
    end loop;
    if cardinality(v_missing) > 0 then
      return tandem.err('validation', 'Нет действующей техкарты на дату документа: ' || array_to_string(v_missing, ', '));
    end if;
    delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      v_line_sum := 0;
      for c in select item_code, qty from tandem.doc_consume_plan(p_doc) p where p.line_id = l.id loop
        v_cost := tandem.store_avg(d.store_from, c.item_code);
        insert into tandem.document_lines (document_id, line_kind, item_code, qty, unit_id, price, sum, note, sort_order)
          select p_doc, 'consume', c.item_code, round(c.qty, 4), i.unit_id, v_cost, round(c.qty * v_cost, 2), l.item_code, 1000 + l.sort_order
          from tandem.items i where i.code = c.item_code;
        perform tandem.apply_move(p_doc, l.id, d.store_from, c.item_code, -round(c.qty, 4), v_cost, d.doc_date);
        v_line_sum := v_line_sum + round(c.qty * v_cost, 2);
      end loop;
      v_cost := case when l.qty > 0 then round(v_line_sum / l.qty, 4) else 0 end;
      perform tandem.apply_move(p_doc, l.id, d.store_from, l.item_code, l.qty, v_cost, d.doc_date);
      update tandem.document_lines set price = v_cost, sum = v_line_sum where id = l.id;
      v_sum := v_sum + v_line_sum;
    end loop;

  elsif d.doc_type = 'inventory' then
    for l in select * from tandem.document_lines where document_id = p_doc and line_kind = 'item' order by sort_order loop
      if l.fact_qty is null or l.fact_qty < 0 then return tandem.err('validation', 'Укажите факт: ' || l.item_code); end if;
      select coalesce(qty, 0) into v_calc from tandem.stock_balances where store_id = d.store_from and item_code = l.item_code;
      v_calc := coalesce(v_calc, 0);
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

  update tandem.documents set status = 'posted', posted_by = p_user.id, posted_at = now(),
         total_sum = round(v_sum, 2), updated_by = p_user.id, updated_at = now() where id = p_doc;

  select coalesce(jsonb_agg(jsonb_build_object('item_code', t.item_code, 'name', i.name, 'store_id', t.store_id,
           'store_name', s.name, 'balance_after', b.qty) order by i.name), '[]'::jsonb)
    into v_warn
    from (select distinct store_id, item_code from tandem.stock_moves where document_id = p_doc) t
    join tandem.stock_balances b on b.store_id = t.store_id and b.item_code = t.item_code
    join tandem.items i on i.code = t.item_code join tandem.stores s on s.id = t.store_id
    where b.qty < 0;
  return jsonb_build_object('ok', true, 'warnings', v_warn, 'total_sum', round(v_sum, 2));
end $$;

-- Отмена проведения.
create or replace function tandem.doc_unpost(p_doc uuid, p_user tandem.users)
returns jsonb language plpgsql as $$
declare d record; v_inv text; v_pairs text[]; p text;
begin
  select * into d from tandem.documents where id = p_doc for update;
  if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
  if d.status <> 'posted' then return tandem.err('validation', 'Документ не проведён'); end if;
  if not tandem.office_can(p_user.role, 'doc:' || d.doc_type, 'edit') then
    return tandem.err('forbidden', 'Нет права отменять документы этого типа');
  end if;
  select number into v_inv from tandem.documents inv
    where inv.doc_type = 'inventory' and inv.status = 'posted' and inv.id <> p_doc
      and inv.posted_at > d.posted_at and inv.store_from in (d.store_from, d.store_to)
    order by inv.posted_at limit 1;
  if v_inv is not null then
    return tandem.err('validation', 'После этого документа проведена инвентаризация ' || v_inv || ' — сначала отмените её');
  end if;
  with del as (delete from tandem.stock_moves where document_id = p_doc returning store_id, item_code)
    select array_agg(distinct store_id::text || '|' || item_code) into v_pairs from del;
  foreach p in array coalesce(v_pairs, '{}'::text[]) loop
    perform tandem.rebuild_balance(split_part(p, '|', 1)::uuid, split_part(p, '|', 2));
  end loop;
  delete from tandem.document_lines where document_id = p_doc and line_kind = 'consume';
  update tandem.document_lines set calc_qty = null, sum = null,
         price = case when d.doc_type = 'invoice_in' then price else null end
    where document_id = p_doc;
  update tandem.documents set status = 'draft', posted_by = null, posted_at = null, total_sum = null,
         updated_by = p_user.id, updated_at = now() where id = p_doc;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function tandem.next_doc_number(text,date), tandem.store_avg(uuid,text),
  tandem.apply_move(uuid,uuid,uuid,text,numeric,numeric,date), tandem.rebuild_balance(uuid,text),
  tandem.rebuild_balances(), tandem.doc_consume_plan(uuid), tandem.doc_preview(uuid),
  tandem.doc_post(uuid,tandem.users), tandem.doc_unpost(uuid,tandem.users) from public;
```

Применить `apply_migration(name: "0016_stock_core")`.

- [ ] **Step 3: Прогнать сценарий**

Повторить вставку прихода 1 и `doc_post` из Step 1 (данные уже есть). Далее по шагам, каждый — `execute_sql`, проверяя числа (админ: `(select u from tandem.users u where login='admin')` — далее `ADMIN`):

| Шаг | Действие | Ожидание |
|---|---|---|
| 1 | приход 10 × 100 на А | `stock_balances` А/мука: qty 10, avg 100; `items.cost_price` муки 100, `cost_source='document'`; `number` = `ПН-2026-000001` (или следующий) |
| 2 | приход 10 × 200 на А (новый документ `…02`) | qty 20, avg 150 |
| 3 | перемещение 5 А→Б (`…03`, `store_from` А, `store_to` Б) | А 15/150, Б 5/150; строка `price=150, sum=750` |
| 4 | списание 2 с А (`…04`, `reason='spoilage'`) | А 13; движение qty −2, unit_cost 150 |
| 5 | производство 0,9 тесто на А (`…05`) | строка `consume` мука 1,0000 по 150 (sum 150); мука А 12; тесто А 0,9 avg 166.6667; `total_sum 150` |
| 6 | `doc_preview` черновика списания 20 муки с А | `warnings` содержит муку с `balance_after = -8` |
| 6б | провести его → `ok`, warnings непусты; `doc_unpost` → ok; А снова 12 | |
| 7 | инвентаризация А (`…07`, строки: мука `fact_qty 11`, тесто `fact_qty 0.9`) | движение мука −1 по 150; `calc_qty` 12; тесто без движения; А мука 11 |
| 8 | `doc_unpost` прихода `…01` | `validation` с номером инвентаризации |
| 9 | `doc_unpost` инвентаризации → ok; затем `doc_unpost` прихода `…01` → ok | А мука: 11 − (−1) = 12? нет: после отмены инвентаризации 12; после отмены прихода 1 (10 × 100): пересборка из движений: приход 2 (10×200) → qty 10 avg 200; перемещение −5 (unit_cost 150 как записано) → 5; списание −2 → 3; производство −1 → 2 → **qty 2, avg 200** (средняя пересобирается по оставшимся приходам) |
| 10 | `select tandem.rebuild_balances()` | 0 |
| 11 | права: `doc_post` производства от пользователя с ролью `accountant` (подставить `(select u from tandem.users u where login='admin')` с изменённой ролью нельзя — создать временного `zz_test_buh` insert into users) | `forbidden` |

Шаг 9 демонстрирует важное свойство: отмена раннего прихода меняет среднюю задним числом — так и задумано (средняя = функция истории).

- [ ] **Step 4: Убрать тестовые данные**

```sql
delete from tandem.documents where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%') or store_to in (select id from tandem.stores where name like 'ZZ\_TEST\_%');
delete from tandem.stock_balances where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%') or item_code like 'ZZ\_TEST\_%';
delete from tandem.charts where item_code like 'ZZ\_TEST\_%';
delete from tandem.items where code like 'ZZ\_TEST\_%';
delete from tandem.stores where name like 'ZZ\_TEST\_%';
delete from tandem.counteragents where name like 'ZZ\_TEST\_%';
delete from tandem.users where login like 'zz\_test\_%';
delete from tandem.doc_counters where doc_type like 'ZZ%';
select (select count(*) from tandem.documents) + (select count(*) from tandem.stock_moves) + (select count(*) from tandem.stock_balances) + (select count(*) from tandem.items where code like 'ZZ\_TEST\_%') leftovers;
```
Expected: `0`. (Счётчики `doc_counters` остаются — номера тестовых документов «сгорают», это нормально.)

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0016_stock_core.sql
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад: ядро проведения — движения, средняя, производство по картам, инвентаризация, отмена

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Раздел «Склад» — RPC, диспетчер, очистка, дымовой тест

**Files:**
- Create: `db/migrations/0017_office_stock.sql`
- Modify: `tools/office-smoke.mjs` (раздел `stock` перед маркером)

**Interfaces:**
- Consumes: Task 1–2; диспетчер, `tandem_test_cleanup` — актуальные тела из базы.
- Produces: `tandem.office_stock(action text, payload jsonb, v_user tandem.users) → jsonb` с действиями из «Соглашения»; маршрут `doc%`/`stock%` → раздел `stock`; в `v_need` добавить `%\_preview`, а также точные имена `stock_balances`, `stock_moves`, `item_stock` → `view` (в диспетчере: `or action in ('stock_balances','stock_moves','item_stock')`); `tandem_test_cleanup` чистит документы/остатки тестовых складов и позиций и счётчики не трогает.

- [ ] **Step 1: Тест (проваливается)**

```js
SECTIONS.stock = async (ctx) => {
  const t = ctx.token;
  const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;
  // справочники
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад А" }); const A = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад Б" }); const B = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_ИП", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_тесто", item_type: "prepared", unit_id: "кг" }); const testo = r.code;
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }] });
  check("подготовка: склады, поставщик, позиции, карта", A && B && SUP && muka && testo && r.ok, r);
  const bal = async (store, code) => { const b = await call("office_stock_balances", { token: t, store_id: store, q: code }); const row = (b.rows || []).find((x) => x.item_code === code); return row ? { qty: Number(row.qty), avg: Number(row.avg_cost) } : { qty: 0, avg: 0 }; };
  // 1. приход 10×100
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-01", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 100 }] });
  check("приход: черновик с номером ПН", r.ok && /^ПН-\d{4}-\d{6}$/.test(r.number), r);
  const inv1 = r.id, num1 = r.number;
  r = await call("office_doc_post", { token: t, id: inv1 });
  check("приход 1 проведён без предупреждений", r.ok && r.warnings.length === 0 && near(r.total_sum, 1000), r);
  let b = await bal(A, muka); check("остаток А: 10 по 100", b.qty === 10 && near(b.avg, 100), b);
  r = await call("office_item_get", { token: t, code: muka });
  check("учётная цена муки из прихода", r.ok && near(r.item.cost_price, 100) && r.item.cost_source === "document", r.item);
  // 2. приход 10×200
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-01", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 200 }] });
  check("номера растут на 1", r.ok && Number(r.number.slice(-6)) === Number(num1.slice(-6)) + 1, { num1, num2: r.number });
  await call("office_doc_post", { token: t, id: r.id });
  b = await bal(A, muka); check("остаток А: 20 по 150", b.qty === 20 && near(b.avg, 150), b);
  // 3. перемещение 5 А→Б
  r = await call("office_doc_save", { token: t, doc_type: "transfer", doc_date: "2026-09-02", store_from: A, store_to: B, lines: [{ item_code: muka, qty: 5 }] });
  r = await call("office_doc_post", { token: t, id: r.id });
  check("перемещение проведено", r.ok && near(r.total_sum, 750), r);
  b = await bal(B, muka); check("остаток Б: 5 по 150", b.qty === 5 && near(b.avg, 150), b);
  // 4. списание 2
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-02", store_from: A, reason: "spoilage", lines: [{ item_code: muka, qty: 2 }] });
  const wo = r.id; r = await call("office_doc_post", { token: t, id: wo });
  check("списание по средней 150", r.ok && near(r.total_sum, 300), r);
  b = await bal(A, muka); check("остаток А после списания: 13", b.qty === 13, b);
  // 5. производство 0.9 теста
  r = await call("office_doc_save", { token: t, doc_type: "production", doc_date: "2026-09-03", store_from: A, lines: [{ item_code: testo, qty: 0.9 }] });
  const prod = r.id;
  r = await call("office_doc_preview", { token: t, id: prod });
  check("предпросмотр производства: расход 1 кг муки по 150", r.ok && r.consume.length === 1 && near(r.consume[0].qty, 1) && near(r.consume[0].price, 150), r.consume);
  r = await call("office_doc_post", { token: t, id: prod });
  check("производство проведено, сумма 150", r.ok && near(r.total_sum, 150), r);
  r = await call("office_doc_get", { token: t, id: prod });
  check("строки расхода сохранены, выпуск по 166.67", r.ok && r.doc.consume.length === 1 && near(r.doc.lines[0].price, 166.6667, 0.001), r.doc);
  b = await bal(A, muka); check("мука А: 12", b.qty === 12, b);
  b = await bal(A, testo); check("тесто А: 0.9 по 166.67", near(b.qty, 0.9) && near(b.avg, 166.6667, 0.001), b);
  // 6. минус: предупреждение, проведение допускается, отмена возвращает
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-03", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 20 }] });
  const wo20 = r.id;
  r = await call("office_doc_preview", { token: t, id: wo20 });
  check("предпросмотр: уйдёт в минус −8", r.ok && r.warnings.length === 1 && near(r.warnings[0].balance_after, -8), r.warnings);
  r = await call("office_doc_post", { token: t, id: wo20 });
  check("проведение в минус допущено с предупреждением", r.ok && r.warnings.length === 1, r);
  r = await call("office_doc_unpost", { token: t, id: wo20 });
  b = await bal(A, muka); check("отмена вернула остаток 12", r.ok && b.qty === 12, b);
  await call("office_doc_delete", { token: t, id: wo20 });
  // 7. инвентаризация: факт 11 при расчёте 12
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2026-09-04", store_from: A, lines: [{ item_code: muka, fact_qty: 11 }, { item_code: testo, fact_qty: 0.9 }] });
  const inv = r.id;
  r = await call("office_doc_get", { token: t, id: inv });
  check("инвентаризация: подсказка расчётного остатка 12", r.ok && near(r.doc.lines.find((x) => x.item_code === muka).current_qty, 12), r.doc.lines);
  r = await call("office_doc_post", { token: t, id: inv });
  check("инвентаризация: недостача 1 × 150", r.ok && near(r.total_sum, -150), r);
  b = await bal(A, muka); check("мука А после инвентаризации: 11", b.qty === 11, b);
  // 8. запрет отмены раннего документа
  r = await call("office_doc_unpost", { token: t, id: inv1 });
  check("отмена прихода после инвентаризации — validation", r.ok === false && r.error === "validation" && /ИН-/.test(r.message), r);
  // 9. отмена инвентаризации, затем прихода — средняя пересобирается
  r = await call("office_doc_unpost", { token: t, id: inv }); check("инвентаризация отменена", r.ok, r);
  r = await call("office_doc_unpost", { token: t, id: inv1 }); check("приход 1 отменён", r.ok, r);
  b = await bal(A, muka); check("после отмены прихода 1: 2 по 200", b.qty === 2 && near(b.avg, 200), b);
  // 10. движения и пересборка
  r = await call("office_stock_moves", { token: t, store_id: A, item_code: muka });
  check("движения по муке на А", r.ok && r.total >= 4 && r.rows.every((x) => x.number), { total: r.total });
  r = await call("office_stock_rebuild", { token: t });
  check("пересборка остатков: расхождений 0", r.ok && r.mismatches_before === 0, r);
  r = await call("office_item_stock", { token: t, code: muka });
  check("остатки в карточке: А и Б", r.ok && r.balances.length === 2 && r.moves.length > 0, r.balances);
  // 11. права по типам
  r = await call("office_user_save", { token: t, login: "zz_test_tech_s", name: "ZZ_TEST_Технолог", role: "technologist", pin: "4321" });
  let l = await call("office_login", { login: "zz_test_tech_s", pin: "4321" }); await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_doc_save", { token: l.token, doc_type: "invoice_in", doc_date: "2026-09-05", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 1, price: 1 }] });
  check("технолог не создаёт приход — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_save", { token: l.token, doc_type: "production", doc_date: "2026-09-05", store_from: A, lines: [{ item_code: testo, qty: 0.1 }] });
  check("технолог создаёт производство", r.ok, r);
  r = await call("office_doc_post", { token: l.token, id: r.id });
  check("технолог проводит производство", r.ok, r);
  r = await call("office_user_save", { token: t, login: "zz_test_buh_s", name: "ZZ_TEST_Бухгалтер", role: "accountant", pin: "4321" });
  l = await call("office_login", { login: "zz_test_buh_s", pin: "4321" }); await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_doc_save", { token: l.token, doc_type: "writeoff", doc_date: "2026-09-05", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  check("бухгалтер не создаёт списание — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_docs_list", { token: t, store_id: A });
  check("журнал: документы тестового склада", r.ok && r.total >= 6 && r.rows[0].number, { total: r.total });
  r = await call("office_doc_delete", { token: t, id: prod });
  check("удалить проведённый нельзя — validation", r.ok === false && r.error === "validation", r);
};
```

Run: `TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… node tools/office-smoke.mjs stock`
Expected: FAIL начиная с `office_doc_save` (`unknown_action`).

- [ ] **Step 2: Миграция 0017**

```sql
-- Склад: раздел бэк-офиса.
create or replace function tandem.office_stock(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_id uuid := nullif(payload->>'id','')::uuid;
  v_type text; v_page int := greatest(coalesce((payload->>'page')::int,1),1);
  v_q text := btrim(coalesce(payload->>'q','')); v_total int; v_rows jsonb; v_num text; v_res jsonb;
  v_store uuid := nullif(payload->>'store_id','')::uuid; v_code text := payload->>'code';
  d record; v_from uuid; v_to uuid; v_ca uuid; v_date date; v_reason text; v_csv text; v_sum numeric;
begin
  -- ---------- журнал ----------
  if action = 'docs_list' then
    select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0) into v_rows, v_total from (
      select d.id, d.number, d.doc_type, d.doc_date, d.status, d.store_from, sf.name as store_from_name,
             d.store_to, st.name as store_to_name, d.counteragent_id, c.name as counteragent_name,
             d.reason, d.comment, d.total_sum, u.name as created_by_name, d.posted_at,
             count(*) over () as cnt
      from tandem.documents d
      left join tandem.stores sf on sf.id = d.store_from left join tandem.stores st on st.id = d.store_to
      left join tandem.counteragents c on c.id = d.counteragent_id left join tandem.users u on u.id = d.created_by
      where (nullif(payload->>'doc_type','') is null or d.doc_type = payload->>'doc_type')
        and (v_store is null or d.store_from = v_store or d.store_to = v_store)
        and (nullif(payload->>'status','') is null or d.status = payload->>'status')
        and (nullif(payload->>'date_from','') is null or d.doc_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or d.doc_date <= (payload->>'date_to')::date)
        and (v_q = '' or d.number ilike '%'||v_q||'%' or c.name ilike '%'||v_q||'%' or d.comment ilike '%'||v_q||'%')
      order by d.doc_date desc, d.created_at desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total/200.0)::int,1));
  end if;

  -- ---------- карточка ----------
  if action = 'doc_get' then
    select * into d from tandem.documents where id = v_id;
    if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    return jsonb_build_object('ok', true, 'doc', (
      select to_jsonb(dd) || jsonb_build_object(
        'store_from_name', (select name from tandem.stores where id = dd.store_from),
        'store_to_name', (select name from tandem.stores where id = dd.store_to),
        'counteragent_name', (select name from tandem.counteragents where id = dd.counteragent_id),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'item_code', l.item_code, 'name', i.name,
                    'unit_id', coalesce(l.unit_id, i.unit_id), 'item_type', i.item_type, 'qty', l.qty, 'price', l.price, 'sum', l.sum,
                    'fact_qty', l.fact_qty, 'calc_qty', l.calc_qty, 'note', l.note, 'sort_order', l.sort_order,
                    'current_qty', (select qty from tandem.stock_balances b where b.store_id = coalesce(dd.store_from, dd.store_to) and b.item_code = l.item_code))
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
    if v_type not in ('invoice_in','transfer','writeoff','production','inventory') then
      return tandem.err('validation', 'Неизвестный тип документа'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||v_type, 'edit') then
      return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    v_date := coalesce(nullif(payload->>'doc_date','')::date, current_date);
    v_from := nullif(payload->>'store_from','')::uuid; v_to := nullif(payload->>'store_to','')::uuid;
    v_ca := nullif(payload->>'counteragent_id','')::uuid; v_reason := nullif(payload->>'reason','');
    if v_type = 'invoice_in' and (v_to is null or v_ca is null) then return tandem.err('validation', 'Приходу нужны склад и поставщик'); end if;
    if v_type = 'transfer' and (v_from is null or v_to is null or v_from = v_to) then return tandem.err('validation', 'Перемещению нужны два разных склада'); end if;
    if v_type in ('writeoff','production','inventory') and v_from is null then return tandem.err('validation', 'Укажите склад'); end if;
    if v_type = 'writeoff' and v_reason is null then return tandem.err('validation', 'Укажите причину списания'); end if;
    if v_type = 'invoice_in' then v_from := null; end if;
    if v_type in ('writeoff','production','inventory') then v_to := null; end if;
    if jsonb_typeof(payload->'lines') <> 'array' then return tandem.err('validation', 'Строки не переданы'); end if;
    if exists (select 1 from jsonb_array_elements(payload->'lines') x where not exists (select 1 from tandem.items where code = x->>'item_code')) then
      return tandem.err('validation', 'В строках есть неизвестная позиция'); end if;
    if v_id is null then
      v_num := tandem.next_doc_number(v_type, v_date);
      insert into tandem.documents (doc_type, number, doc_date, store_from, store_to, counteragent_id, reason, comment, created_by, updated_by)
        values (v_type, v_num, v_date, v_from, v_to, v_ca, v_reason, payload->>'comment', v_user.id, v_user.id) returning id into v_id;
    else
      select * into d from tandem.documents where id = v_id;
      if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
      if d.status <> 'draft' then return tandem.err('validation', 'Проведённый документ не правится — сначала отмените проведение'); end if;
      if d.doc_type <> v_type then return tandem.err('validation', 'Тип документа менять нельзя'); end if;
      v_num := d.number;
      update tandem.documents set doc_date = v_date, store_from = v_from, store_to = v_to, counteragent_id = v_ca,
        reason = v_reason, comment = payload->>'comment', updated_by = v_user.id, updated_at = now() where id = v_id;
      delete from tandem.document_lines where document_id = v_id;
    end if;
    insert into tandem.document_lines (document_id, item_code, qty, unit_id, price, fact_qty, note, sort_order)
      select v_id, x->>'item_code',
             case when v_type = 'inventory' then coalesce(nullif(x->>'fact_qty','')::numeric, 0) else coalesce(nullif(x->>'qty','')::numeric, 0) end,
             i.unit_id, nullif(x->>'price','')::numeric,
             case when v_type = 'inventory' then nullif(x->>'fact_qty','')::numeric end,
             nullif(x->>'note',''), (ord-1)::int
      from jsonb_array_elements(payload->'lines') with ordinality t(x, ord) join tandem.items i on i.code = x->>'item_code';
    return jsonb_build_object('ok', true, 'id', v_id, 'number', v_num);
  end if;

  -- ---------- проведение / предпросмотр / отмена / удаление ----------
  if action = 'doc_preview' then
    if not exists (select 1 from tandem.documents where id = v_id) then return tandem.err('not_found', 'Документ не найден'); end if;
    return jsonb_build_object('ok', true) || tandem.doc_preview(v_id);
  end if;
  if action = 'doc_post' then return tandem.doc_post(v_id, v_user); end if;
  if action = 'doc_unpost' then return tandem.doc_unpost(v_id, v_user); end if;
  if action = 'doc_delete' then
    select * into d from tandem.documents where id = v_id;
    if d.id is null then return tandem.err('not_found', 'Документ не найден'); end if;
    if d.status <> 'draft' then return tandem.err('validation', 'Удалять можно только черновики'); end if;
    if not tandem.office_can(v_user.role, 'doc:'||d.doc_type, 'edit') then return tandem.err('forbidden', 'Нет права на документы этого типа'); end if;
    delete from tandem.documents where id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- остатки ----------
  if action = 'stock_balances' then
    select coalesce(jsonb_agg(x), '[]'::jsonb), coalesce(max(x.cnt),0), coalesce(sum(x.sum),0) into v_rows, v_total, v_sum from (
      select b.store_id, s.name as store_name, b.item_code, i.name, i.unit_id, b.qty, b.avg_cost,
             round(b.qty * b.avg_cost, 2) as sum, count(*) over () as cnt
      from tandem.stock_balances b join tandem.stores s on s.id = b.store_id join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store)
        and (v_q = '' or i.name ilike '%'||v_q||'%' or i.code = v_q)
        and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0)
      order by s.name, i.name limit 200 offset (v_page-1)*200) x;
    select 'store;code;name;unit;qty;avg_cost;sum' || E'\n' || coalesce(string_agg(concat_ws(';', s.name, b.item_code, replace(i.name,';',','), i.unit_id, b.qty, b.avg_cost, round(b.qty*b.avg_cost,2)), E'\n' order by s.name, i.name), '')
      into v_csv
      from tandem.stock_balances b join tandem.stores s on s.id = b.store_id join tandem.items i on i.code = b.item_code
      where (v_store is null or b.store_id = v_store) and (coalesce((payload->>'only_nonzero')::boolean, true) = false or b.qty <> 0);
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total/200.0)::int,1), 'total_sum', v_sum, 'csv', v_csv);
  end if;

  if action = 'stock_moves' then
    select coalesce(jsonb_agg(x), '[]'::jsonb), coalesce(max(x.cnt),0) into v_rows, v_total from (
      select m.id, m.move_date, m.posted_at, s.name as store_name, m.store_id, m.item_code, i.name, m.qty, m.unit_cost,
             round(m.qty*m.unit_cost,2) as sum, m.document_id, d.number, d.doc_type, count(*) over () as cnt
      from tandem.stock_moves m join tandem.documents d on d.id = m.document_id
      join tandem.stores s on s.id = m.store_id join tandem.items i on i.code = m.item_code
      where (v_store is null or m.store_id = v_store) and (v_code is null or nullif(payload->>'item_code','') is null or m.item_code = payload->>'item_code')
        and (nullif(payload->>'date_from','') is null or m.move_date >= (payload->>'date_from')::date)
        and (nullif(payload->>'date_to','') is null or m.move_date <= (payload->>'date_to')::date)
      order by m.posted_at desc, m.id desc limit 200 offset (v_page-1)*200) x;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page, 'pages', greatest(ceil(v_total/200.0)::int,1));
  end if;

  if action = 'item_stock' then
    if not exists (select 1 from tandem.items where code = v_code) then return tandem.err('not_found', 'Позиция не найдена'); end if;
    return jsonb_build_object('ok', true,
      'balances', (select coalesce(jsonb_agg(jsonb_build_object('store_id', b.store_id, 'store_name', s.name, 'qty', b.qty, 'avg_cost', b.avg_cost) order by s.name), '[]'::jsonb)
                   from tandem.stock_balances b join tandem.stores s on s.id = b.store_id where b.item_code = v_code and b.qty <> 0),
      'moves', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                  select m.move_date, s.name as store_name, m.qty, m.unit_cost, d.number, d.doc_type
                  from tandem.stock_moves m join tandem.documents d on d.id = m.document_id join tandem.stores s on s.id = m.store_id
                  where m.item_code = v_code order by m.posted_at desc, m.id desc limit 20) x));
  end if;

  if action = 'stock_rebuild' then
    if v_user.role <> 'admin' then return tandem.err('forbidden', 'Только администратор'); end if;
    return jsonb_build_object('ok', true, 'mismatches_before', tandem.rebuild_balances());
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
revoke all on function tandem.office_stock(text,jsonb,tandem.users) from public;
```

Замечание к `docs_list`: `jsonb_agg(x) filter (where true)` и `count(*) over ()` в одном `select` без `group by` не сработают в таком виде — реализовать так: подзапрос с `count(*) over () as cnt` внутри `x`, затем `select coalesce(jsonb_agg(to_jsonb(x) - 'cnt'), '[]'::jsonb), coalesce(max(x.cnt), 0) into v_rows, v_total from (...) x;` — этот приём использовать во всех списках.

Замечание к `stock_moves`: в фильтре по позиции использовать только `payload->>'item_code'` (переменная `v_code` берётся из ключа `code`); упростить условие до `(nullif(payload->>'item_code','') is null or m.item_code = payload->>'item_code')`.

Далее в том же файле:
1. **Диспетчер** — актуальное тело из базы; в `v_section := case …` добавить **первой** строкой `when action like 'doc%' or action like 'stock%' then 'stock'`; в `v_need`: `… or action like '%\_preview' or action in ('stock_balances','stock_moves','item_stock')` → view; в маршрутизацию `elsif v_section = 'stock' then return tandem.office_stock(action, payload, v_user);`.
2. **Очистка** — актуальное тело `tandem_test_cleanup`; **в начало** удалений добавить:
   ```sql
   with d as (delete from tandem.documents where store_from in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or store_to in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
       or id in (select document_id from tandem.document_lines l join tandem.items i on i.code = l.item_code
                 where i.name like 'ZZ\_TEST\_%' or i.code like 'ZZ\_TEST\_%') returning 1)
     select count(*) into v_docs from d;
   delete from tandem.stock_balances where store_id in (select id from tandem.stores where name like 'ZZ\_TEST\_%')
     or item_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');
   ```
   (объявить `v_docs int`, добавить `'documents', v_docs` в `deleted`). Движения уходят каскадом с документами.
3. DO-обёртка прав для `tandem_office`, `tandem_test_cleanup`.

Применить `apply_migration(name: "0017_office_stock")`.

- [ ] **Step 3: Прогнать тест**

Run: `… node tools/office-smoke.mjs stock`, затем `all`.
Expected: раздел `stock` — все `ok` (около 40 проверок); `all` — прежние 143 + новые, «очистка: следов нет».

- [ ] **Step 4: Сверки и commit**

`pg_get_functiondef` для `office_stock`, `tandem_office`, `tandem_test_cleanup` = файл; `select count(*) from tandem.documents` → 0 после очистки.

```bash
git add db/migrations/0017_office_stock.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад: RPC раздела, маршрут в диспетчере, очистка теста, контрольный сценарий

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Экран «Склад»: журнал и форма документа

**Files:**
- Create: `js/office/stock.js`
- Modify: `js/office/app.js` (раздел `stock` в `SECTIONS` после `charts`), `office.css`

**Interfaces:**
- Consumes: RPC Task 3; `office_stores_list` → `{stores, points}`; `office_counteragents_list {kind:'supplier', q}`; `office_items_search {q, active:true, item_type?}`; `api`, `can`, `session` из `api.js`; `el, fmt, toast, debounce, modal, confirmDlg` из `ui.js`.
- Produces: `export async function mount(root)`; вкладка «Остатки» — в Task 5 (в этом модуле оставить заглушку `loadBalances()` с текстом «в следующей задаче» нельзя — сделать вкладку сразу, см. Task 5; здесь только «Документы»).

- [ ] **Step 1: app.js и css**

В `SECTIONS` после `charts`: `{ id: "stock", title: "Склад" }`. В `office.css` добавить:
```css
.tabs{display:flex;gap:6px;margin-bottom:12px}.tabs button{width:auto}
.badge{display:inline-block;border-radius:6px;padding:1px 7px;font-size:11.5px;font-weight:700;background:#EEF2F8;color:var(--accent)}
.badge.posted{background:var(--okbg);color:var(--ok)}.badge.draft{background:var(--warnbg,#FCF3E1);color:var(--warn,#8A6412)}
.warnbox{background:#FCF3E1;color:#8A6412;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:13.5px}
```

- [ ] **Step 2: stock.js**

```js
import { api, can, session } from "./api.js?v=3";
import { el, fmt, toast, debounce, modal, confirmDlg } from "./ui.js?v=3";

const TYPES = { invoice_in: "Приход", transfer: "Перемещение", writeoff: "Списание", production: "Производство", inventory: "Инвентаризация" };
const REASONS = { spoilage: "порча", tasting: "проработка", staff_meals: "питание персонала", other: "прочее" };
const perms = () => (session() && session().permissions) || [];
const canDoc = (type) => perms().includes("doc:" + type + ":edit");
let root, stores = [], state = { tab: "docs", doc_type: "", store_id: "", status: "", q: "", page: 1 };
let table, pager;

export async function mount(r) {
  root = r; state.page = 1;
  stores = ((await api("stores_list", {})).stores || []).filter((s) => s.active);
  drawShell();
  await loadDocs();
}

function drawShell() {
  root.innerHTML = "";
  root.append(el("div", { class: "tabs" },
    el("button", { class: state.tab === "docs" ? "" : "ghost", onclick: () => { state.tab = "docs"; drawShell(); loadDocs(); } }, "Документы"),
    el("button", { class: state.tab === "bal" ? "" : "ghost", onclick: () => { state.tab = "bal"; drawShell(); loadBalances(); } }, "Остатки")));
  if (state.tab === "bal") { root.append(el("div", { id: "bal-root" })); return; }
  const newBtn = el("select", { onchange: (e) => { if (e.target.value) { editDoc(null, e.target.value); e.target.value = ""; } } },
    el("option", { value: "" }, "+ Новый документ…"),
    ...Object.entries(TYPES).filter(([k]) => canDoc(k)).map(([k, v]) => el("option", { value: k }, v)));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Номер, поставщик, комментарий", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; loadDocs(); }, 300) }),
      sel({ "": "все типы", ...TYPES }, state.doc_type, (v) => { state.doc_type = v; state.page = 1; loadDocs(); }),
      sel({ "": "все склады", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) }, state.store_id, (v) => { state.store_id = v; state.page = 1; loadDocs(); }),
      sel({ "": "все", draft: "черновики", posted: "проведённые" }, state.status, (v) => { state.status = v; state.page = 1; loadDocs(); }),
      newBtn),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}
function sel(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

async function loadDocs() {
  const r = await api("docs_list", { doc_type: state.doc_type || null, store_id: state.store_id || null, status: state.status || null, q: state.q, page: state.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Номер", "Тип", "Дата", "Склады / поставщик", "Сумма", "Статус"].map((h, i) => el("th", { class: i === 4 ? "num" : "" }, h))));
  for (const d of r.rows) {
    const who = d.doc_type === "invoice_in" ? `${d.counteragent_name || ""} → ${d.store_to_name || ""}`
      : d.doc_type === "transfer" ? `${d.store_from_name || ""} → ${d.store_to_name || ""}` : (d.store_from_name || "");
    table.append(el("tr", { class: "row", onclick: () => editDoc(d.id) },
      el("td", {}, d.number), el("td", {}, TYPES[d.doc_type] || d.doc_type), el("td", {}, d.doc_date), el("td", {}, who),
      el("td", { class: "num" }, d.total_sum != null ? fmt(d.total_sum) : ""),
      el("td", {}, el("span", { class: "badge " + d.status }, d.status === "posted" ? "проведён" : "черновик"))));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Документов нет")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; loadDocs(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; loadDocs(); } }, "→"));
}

// ---------- форма документа ----------
async function editDoc(id, newType) {
  let doc = { doc_type: newType, doc_date: new Date().toISOString().slice(0, 10), status: "draft", lines: [], consume: [] };
  if (id) { const r = await api("doc_get", { id }); if (!r.ok) { toast(r.message, "bad"); return; } doc = r.doc; }
  const type = doc.doc_type, posted = doc.status === "posted";
  const ro = posted || !canDoc(type);
  const m = modal(`${TYPES[type]} ${doc.number || ""}`); m.root.style.maxWidth = "960px";
  const storeOpts = { "": "— склад —", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) };
  const f = {
    date: el("input", { type: "date", value: doc.doc_date, readonly: ro }),
    from: sel(storeOpts, doc.store_from || "", () => {}, ro),
    to: sel(storeOpts, doc.store_to || "", () => {}, ro),
    reason: sel({ "": "— причина —", ...REASONS }, doc.reason || "", () => {}, ro),
    comment: el("input", { value: doc.comment || "", readonly: ro }),
    caId: doc.counteragent_id || null,
    ca: el("input", { placeholder: "поставщик: начните вводить", value: doc.counteragent_name || "", readonly: ro }),
  };
  const caRes = el("div", { class: "sres" });
  f.ca.addEventListener("input", debounce(async () => {
    caRes.innerHTML = ""; f.caId = null; const q = f.ca.value.trim(); if (q.length < 2) return;
    const s = await api("counteragents_list", { q, kind: "supplier" });
    for (const c of (s.rows || []).slice(0, 10)) caRes.append(el("button", { class: "sitem", onclick: () => { f.caId = c.id; f.ca.value = c.name; caRes.innerHTML = ""; } }, c.name));
  }, 300));
  const head = el("div", { class: "grid2" }, el("div", {}, el("label", {}, "Дата"), f.date));
  if (type === "invoice_in") head.append(el("div", {}, el("label", {}, "Склад-получатель"), f.to), el("div", { class: "sbox" }, el("label", {}, "Поставщик"), f.ca, caRes));
  if (type === "transfer") head.append(el("div", {}, el("label", {}, "Откуда"), f.from), el("div", {}, el("label", {}, "Куда"), f.to));
  if (type === "writeoff") head.append(el("div", {}, el("label", {}, "Склад"), f.from), el("div", {}, el("label", {}, "Причина"), f.reason));
  if (type === "production") head.append(el("div", {}, el("label", {}, "Склад кухни (расход и выпуск)"), f.from));
  if (type === "inventory") head.append(el("div", {}, el("label", {}, "Склад"), f.from));
  head.append(el("div", {}, el("label", {}, "Комментарий"), f.comment));
  m.root.append(head);
  // строки
  const lines = doc.lines.map((l) => ({ ...l }));
  const tbl = el("table"); const tot = el("div", { class: "tot" });
  const isInv = type === "inventory", isIn = type === "invoice_in";
  function drawLines() {
    const ae = document.activeElement; const keep = ae && ae.dataset && ae.dataset.li != null ? { li: ae.dataset.li, key: ae.dataset.key } : null;
    tbl.innerHTML = "";
    const cols = ["Позиция", "Ед.", isInv ? "Факт" : "Кол-во"]; if (isInv && posted) cols.push("Расчёт", "Разница"); if (isIn) cols.push("Цена", "Сумма"); if (posted && !isIn && !isInv) cols.push("Себест.", "Сумма"); if (isInv && posted) cols.push("Сумма"); cols.push("");
    tbl.append(el("tr", {}, ...cols.map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    let sum = 0;
    lines.forEach((l, idx) => {
      const q = Number(isInv ? l.fact_qty : l.qty) || 0, p = Number(l.price) || 0;
      const inp = (key) => el("input", { type: "number", step: "0.001", value: l[key] ?? "", readonly: ro, "data-li": String(idx), "data-key": key, style: "text-align:right;padding:6px", oninput: (e) => { l[key] = e.target.value; drawLines(); } });
      const tds = [el("td", {}, l.name, isInv && !posted && l.current_qty != null ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, "расчёт: " + fmt(l.current_qty)) : null), el("td", {}, l.unit_id || ""), el("td", { class: "num" }, inp(isInv ? "fact_qty" : "qty"))];
      if (isInv && posted) tds.push(el("td", { class: "num" }, fmt(l.calc_qty)), el("td", { class: "num" }, fmt(q - Number(l.calc_qty || 0))));
      if (isIn) { tds.push(el("td", { class: "num" }, inp("price")), el("td", { class: "num" }, fmt(q * p))); sum += q * p; }
      if (posted && !isIn && !isInv) { tds.push(el("td", { class: "num" }, fmt(l.price)), el("td", { class: "num" }, fmt(l.sum))); sum += Number(l.sum || 0); }
      if (isInv && posted) { tds.push(el("td", { class: "num" }, fmt(l.sum))); sum += Number(l.sum || 0); }
      tds.push(el("td", {}, ro ? null : el("button", { class: "x", onclick: () => { lines.splice(idx, 1); drawLines(); } }, "×")));
      tbl.append(el("tr", {}, ...tds));
    });
    tot.innerHTML = ""; tot.append(el("span", {}, posted ? "Сумма документа" : (isIn ? "Сумма" : "Строк")), el("span", {}, posted || isIn ? fmt(posted ? doc.total_sum : sum) + " ₸" : String(lines.length)));
    if (keep) { const n = tbl.querySelector(`input[data-li="${keep.li}"][data-key="${keep.key}"]`); if (n) n.focus(); }
  }
  drawLines();
  m.root.append(el("h2", { style: "margin-top:14px" }, isInv ? "Позиции и факт" : (type === "production" ? "Выпуск" : "Строки")), tbl, tot);
  if (!ro) {
    const search = el("input", { placeholder: "Добавить позицию: название или код" }); const res = el("div", { class: "sres" });
    search.addEventListener("input", debounce(async () => {
      res.innerHTML = ""; const q = search.value.trim(); if (q.length < 2) return;
      const s = await api("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).slice(0, 12)) {
        if (type === "production" && !["dish", "prepared"].includes(it.item_type)) continue;
        if (lines.some((l) => l.item_code === it.code)) continue;
        res.append(el("button", { class: "sitem", onclick: () => { lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", fact_qty: "", price: "" }); search.value = ""; res.innerHTML = ""; drawLines(); } },
          it.name, el("span", { class: "dim" }, ` · ${it.unit_id}`)));
      }
    }, 300));
    const tools = el("div", { class: "sbox", style: "margin-top:10px" }, search, res);
    if (isInv) tools.prepend(el("button", { class: "ghost small", style: "margin-bottom:8px", onclick: async () => {
      const st = f.from.value; if (!st) { toast("Сначала выберите склад", "bad"); return; }
      const b = await api("stock_balances", { store_id: st, only_nonzero: true, page: 1 });
      for (const x of (b.rows || [])) if (!lines.some((l) => l.item_code === x.item_code)) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "", current_qty: x.qty });
      drawLines();
    } }, "Заполнить позициями с остатком"));
    m.root.append(tools);
  }
  if (doc.consume && doc.consume.length) {
    const ct = el("table"); ct.append(el("tr", {}, ...["Расход сырья", "Ед.", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    for (const c of doc.consume) ct.append(el("tr", {}, el("td", {}, c.name), el("td", {}, c.unit_id), el("td", { class: "num" }, fmt(c.qty)), el("td", { class: "num" }, fmt(c.price)), el("td", { class: "num" }, fmt(c.sum))));
    m.root.append(el("h2", { style: "margin-top:14px" }, "Списано по техкартам"), ct);
  }
  const err = el("div", { class: "err" }); const actions = el("div", { class: "actions" });
  const payload = () => ({ id: doc.id, doc_type: type, doc_date: f.date.value, store_from: f.from.value || null, store_to: f.to.value || null,
    counteragent_id: f.caId, reason: f.reason.value || null, comment: f.comment.value,
    lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty === "" ? null : l.qty, fact_qty: l.fact_qty === "" ? null : l.fact_qty, price: l.price === "" ? null : l.price })) });
  async function save() { const r = await api("doc_save", payload()); if (!r.ok) { err.textContent = r.message; return null; } doc.id = r.id; doc.number = r.number; return r.id; }
  async function post() {
    const id = await save(); if (!id) return;
    const pv = await api("doc_preview", { id }); if (!pv.ok) { err.textContent = pv.message; return; }
    const box = el("div", {});
    if (pv.consume.length) box.append(el("div", { class: "dim" }, "Будет списано: " + pv.consume.map((c) => `${c.name} ${fmt(c.qty)} ${c.unit_id}`).join(", ")));
    if (pv.warnings.length) box.append(el("div", { class: "warnbox" }, "Уйдут в минус: " + pv.warnings.map((w) => `${w.name} (${w.store_name}) → ${fmt(w.balance_after)}`).join("; ")));
    const cm = modal("Провести документ?"); cm.root.append(box, el("div", { class: "actions" },
      el("button", { onclick: async () => { cm.close(); const r = await api("doc_post", { id }); if (!r.ok) { err.textContent = r.message; return; } toast("Проведено" + (r.warnings.length ? " — есть минусы" : "")); m.close(); loadDocs(); } }, "Провести"),
      el("button", { class: "ghost", onclick: cm.close }, "Отмена")));
  }
  if (!ro) actions.append(el("button", { class: "ghost", onclick: async () => { if (await save()) { toast("Черновик сохранён"); m.close(); loadDocs(); } } }, "Сохранить черновик"), el("button", { onclick: post }, "Провести"));
  if (posted && canDoc(type)) actions.append(el("button", { class: "ghost", onclick: async () => { if (!confirmDlg("Отменить проведение?")) return; const r = await api("doc_unpost", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; } toast("Проведение отменено"); m.close(); loadDocs(); } }, "Отменить проведение"));
  if (doc.id && !posted && canDoc(type)) actions.append(el("button", { class: "ghost", onclick: async () => { if (!confirmDlg("Удалить черновик?")) return; const r = await api("doc_delete", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; } toast("Удалено"); m.close(); loadDocs(); } }, "Удалить"));
  actions.append(el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);
}

// ---------- остатки (Task 5) ----------
let bal = { store_id: "", q: "", nonzero: true, page: 1 };
async function loadBalances() {
  const host = document.getElementById("bal-root"); host.innerHTML = "";
  const r = await api("stock_balances", { store_id: bal.store_id || null, q: bal.q, only_nonzero: bal.nonzero, page: bal.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
  const t = el("table"); t.append(el("tr", {}, ...["Склад", "Позиция", "Ед.", "Кол-во", "Средняя", "Сумма"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) t.append(el("tr", { class: "row", onclick: () => showMoves(x) }, el("td", { class: "dim" }, x.store_name), el("td", {}, x.name), el("td", {}, x.unit_id),
    el("td", { class: "num" + (Number(x.qty) < 0 ? " bad" : "") }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.avg_cost)), el("td", { class: "num" }, fmt(x.sum))));
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Остатков нет — проведите первую инвентаризацию или приход")));
  host.append(el("div", { class: "tools" },
      sel({ "": "все склады", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) }, bal.store_id, (v) => { bal.store_id = v; bal.page = 1; loadBalances(); }),
      el("input", { placeholder: "Поиск позиции", value: bal.q, oninput: debounce((e) => { bal.q = e.target.value; bal.page = 1; loadBalances(); }, 300) }),
      el("label", { style: "margin:0" }, el("input", { type: "checkbox", checked: bal.nonzero, onchange: (e) => { bal.nonzero = e.target.checked; loadBalances(); } }), " только с остатком"),
      el("span", { class: "dim" }, `итого ${fmt(r.total_sum)} ₸`),
      el("button", { class: "ghost", onclick: () => { const b = new Blob(["﻿" + r.csv], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "ostatki.csv"; a.click(); URL.revokeObjectURL(a.href); } }, "CSV")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "pager" }, `всего ${r.total} · стр. ${r.page} из ${r.pages}`,
      el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { bal.page--; loadBalances(); } }, "←"),
      el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { bal.page++; loadBalances(); } }, "→")));
}
async function showMoves(x) {
  const r = await api("stock_moves", { store_id: x.store_id, item_code: x.item_code, page: 1 });
  const m = modal(`${x.name} · ${x.store_name}`);
  const t = el("table"); t.append(el("tr", {}, ...["Дата", "Документ", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
  for (const mv of (r.rows || [])) t.append(el("tr", { class: "row", onclick: () => { m.close(); editDoc(mv.document_id); } }, el("td", {}, mv.move_date), el("td", {}, `${TYPES[mv.doc_type] || mv.doc_type} ${mv.number}`),
    el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty)), el("td", { class: "num" }, fmt(mv.unit_cost)), el("td", { class: "num" }, fmt(mv.sum))));
  m.root.append(t, el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
}
```

**Версия импортов:** в этой задаче и в Task 5 писать текущую сборку — `./api.js?v=2`, `./ui.js?v=2` (в коде выше заменить `?v=3` на `?v=2`); Task 6 поднимет `?v=2` → `?v=3` во всех файлах разом.

- [ ] **Step 3: Проверка в браузере**

`npx --yes serve -l 8077 .`, `office.html`, администратор: раздел «Склад»; «+ Новый документ» → Приход: склад, поставщик через поиск, две позиции, цены → «Провести» → окно предпросмотра → проведено; открыть проведённый — только чтение, сумма; Списание в минус → предупреждение в предпросмотре; Производство теста → предпросмотр показывает расход, после проведения блок «Списано по техкартам»; Инвентаризация → «Заполнить позициями с остатком», подсказки расчёта, проведение; «Отменить проведение» прихода после инвентаризации → текст ошибки с номером; журнал с фильтрами и статусами. Всё — на тестовых складах/позициях `ZZ_TEST_` (создать через Склады/Номенклатуру), очистка `test_cleanup` в конце. Под технологом (`zz_test_tech`) в списке «Новый документ» только «Производство». Консоль чистая.

- [ ] **Step 4: Commit**

```bash
git add js/office/stock.js js/office/app.js office.css
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: раздел «Склад» — журнал, формы пяти типов, предпросмотр проведения, остатки

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Остатки и движения в карточке номенклатуры

**Files:**
- Modify: `js/office/nomenclature.js` (`editItem`, после блока себестоимости)

- [ ] **Step 1: Правка**

После блока «Себестоимость на сегодня» (и для товаров — после подписи источника цены), если `code` задан:
```js
  if (code) {
    const st = await api("item_stock", { code });
    if (st.ok && (st.balances.length || st.moves.length)) {
      const bt = el("table"); bt.append(el("tr", {}, el("th", {}, "Склад"), el("th", { class: "num" }, "Остаток"), el("th", { class: "num" }, "Средняя")));
      for (const b of st.balances) bt.append(el("tr", {}, el("td", {}, b.store_name), el("td", { class: "num" + (Number(b.qty) < 0 ? " bad" : "") }, fmt(b.qty)), el("td", { class: "num" }, fmt(b.avg_cost))));
      const mt = el("table"); mt.append(el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Документ"), el("th", {}, "Склад"), el("th", { class: "num" }, "Кол-во")));
      for (const mv of st.moves.slice(0, 10)) mt.append(el("tr", {}, el("td", {}, mv.move_date), el("td", {}, mv.number), el("td", { class: "dim" }, mv.store_name), el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty))));
      m.root.append(el("h2", { style: "margin-top:16px" }, "Остатки по складам"), bt, el("h2", { style: "margin-top:12px" }, "Последние движения"), mt);
    }
  }
```
(`item_stock` требует `stock:view` — у всех ролей бэк-офиса он есть; если `st.ok === false` — блок не показывать.)

- [ ] **Step 2: Проверка в браузере и commit**

Открыть карточку позиции с движениями (после тестовых документов Task 4 или новых) — таблицы видны; позиция без движений — блока нет. Очистка. Коммит:
```bash
git add js/office/nomenclature.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: остатки и движения в карточке номенклатуры

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Сборка 3, полный прогон, документация

**Files:**
- Modify: `js/office/api.js` (`BUILD = 3`), все `?v=2` → `?v=3` в `office.html` и `js/office/*.js`, подпись «сборка 3»; `README.md`; спецификация (раздел «Уточнения при реализации»); `docs/superpowers/specs/2026-09-05-uchet-core-deferred.md`.

- [ ] **Step 1: Версия**: `grep -rn "?v=2" office.html js/office` → заменить на `?v=3`; `BUILD = 3`; «сборка 3».
- [ ] **Step 2: Полный прогон** `office-smoke.mjs all` → 0 провалов, «очистка: следов нет»; SQL: документов/остатков тестовых 0; `admin`/`svetlana` целы.
- [ ] **Step 3: Документация**: README — раздел «Склад» (типы документов, кто проводит, стартовая инвентаризация, `stock_rebuild`); спецификация — уточнения по факту реализации (что отклонилось); `core-deferred.md` — пометить, что появились `updated_at/updated_by` у документов (пункт «нет журнала» закрыт для документов).
- [ ] **Step 4: Регресс**: локально `index.html` (точка Енешка — плитки, поиск, расход сырья) и `office.html` (все разделы открываются, консоль без 404 на `?v=3`). Коммит:
```bash
git add README.md docs/superpowers office.html js/office
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад: сборка 3, README, уточнения спецификации

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Слияние в `main` — контроллер после финального ревью ветки.
