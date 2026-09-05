# Подпроект «Техкарты и себестоимость»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Технологические карты с брутто/нетто/выходом и версиями по датам, учётные цены сырья, расчёт себестоимости на дату, раздел «Техкарты» и отчёт «Фудкост меню» в бэк-офисе, перенос карт и цен закупа из iiko — по спецификации `docs/superpowers/specs/2026-09-05-uchet-charts-design.md`.

**Architecture:** Данные и расчёт — в PostgreSQL (Supabase, схема `tandem`): таблицы `charts`/`chart_lines`, функции `tandem.item_cost` (рекурсивно по одному блюду) и `tandem.menu_foodcost` (один рекурсивный CTE по всему меню), раздел RPC `tandem.office_charts` за диспетчером `public.tandem_office`. Перенос — через существующий маршрут `migrate` (`public.tandem_migrate`) новыми видами строк. Фронт — модуль `js/office/charts.js` в существующей оболочке `office.html`.

**Tech Stack:** PostgreSQL 15 (plpgsql, `btree_gist` для ограничения «одна карта на дату»), Supabase Edge Function `uchet` (без изменений маршрутов, кроме документации), ванильный JS (ES-модули), Node 24 для скриптов и дымового теста.

## Global Constraints

- Вся логика — в SQL обычного PostgreSQL; расширения только стандартные (`pgcrypto`, `uuid-ossp`, `btree_gist`); никаких функций, доступных лишь в Supabase (спецификация ядра 3.1а).
- Прокси `uchet` — тонкий; новых маршрутов не нужно: всё идёт через `office_*` → `tandem_office` и `migrate` → `tandem_migrate`.
- Экраны точек не меняют поведения: `tandem_charts` после переписывания отдаёт тот же формат `{ok, charts:{<code>:[{n, a}]}}`.
- Ошибки RPC — `{ok:false, error:<код>, message:<текст по-русски>}`; коды `unauthorized`, `forbidden`, `not_found`, `validation`, `unknown_action`.
- Права: раздел `charts` — admin v+e, owner v+e, technologist v+e, accountant v, storekeeper v; диспетчер выводит право из имени действия (`*_list`, `*_get`, `*_report` → `view`, иначе `edit`).
- Количества строк — в единице ингредиента, выход карты — в единице блюда; пересчёта единиц нет.
- Тестовые сущности — `ZZ_TEST_`/`zz_test_`, чистятся `tandem_test_cleanup`; после каждого прогона `leftovers = 0`.
- Секреты только в окружении/скретчпаде: `IIKO_API_KEY`, `IIKO_APP_ID`, `IIKO_CLIENT_SECRET`, `TANDEM_OWNER_PIN`, `TANDEM_ADMIN_PIN`; в файлы и отчёты не писать. Папка `data/` в `.gitignore`.
- Миграции — файлом в `db/migrations/00NN_*.sql` и `apply_migration` тем же именем; функция в базе = файл; права `service_role` — в DO-обёртке `if exists (select 1 from pg_roles where rolname='service_role')`.
- Коммиты: `git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit`, хвост `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Форма диспетчера `tandem_office` — `IF/ELSIF` (не `RETURN CASE`); при правке брать актуальное тело из базы (`pg_get_functiondef`), а не из старого файла.
- Уточнения к спецификации, принятые при планировании: (1) ограничение `netto <= brutto` — не в базе, а предупреждение в редакторе (в данных iiko есть исключения); (2) кандидатов на перенос карт — 2 191 (все активные `dish`/`prepared` с `iiko_id`), у части карт в iiko нет — это нормально; (3) `estimatedPurchasePrice` у Тандема везде 0 — источник `iiko_estimate` не используется.

---

## Карта файлов

| Файл | Ответственность |
|------|-----------------|
| `db/migrations/0010_charts_schema.sql` | `btree_gist`, `charts`, `chart_lines`, `items.cost_*`, `unit_id not null`, `settings.foodcost_alert`, права раздела `charts`, RLS |
| `db/migrations/0011_cost_functions.sql` | `tandem.active_chart`, `tandem.item_cost`, `tandem.menu_foodcost`, `tandem.chart_reaches` (проверка цикла) |
| `db/migrations/0012_office_charts.sql` | `tandem.office_charts` (list/get/save/new_version/delete/report), маршрут `chart%`/`foodcost%` в диспетчере, `cost_price` в `office_nomenclature`, `item_cost_get`, расширение `tandem_test_cleanup` |
| `db/migrations/0013_migrate_charts.sql` | виды `chart_candidates`, `charts`, `costs` в `tandem_migrate` |
| `db/migrations/0014_point_charts.sql` | `tandem_charts` на новых таблицах; удаление `item_chart` и `tandem_sync_charts` |
| `tools/iiko-migrate-charts.mjs` | перенос карт и цен закупа из iiko (кэш `data/iiko/charts/`) |
| `tools/office-smoke.mjs` | раздел `charts` (+ проверки цен в `nomenclature`), `migrate`: виды карт |
| `js/office/charts.js` | список, редактор, версии, вкладка «Фудкост меню» |
| `js/office/nomenclature.js` | учётная цена товара, себестоимость блюда, ссылка на карту |
| `js/office/app.js` | раздел `charts` в меню, открытие раздела по `#charts/<код>` |
| `README.md`, `docs/superpowers/specs/2026-09-05-uchet-charts-design.md` | документация и уточнения |

Соглашение по действиям (все через прокси `{action:"office_<имя>", payload}` с `token`):
- `office_charts_list {q?, group_id?, only?: 'no_chart'|'no_cost', page?}` → `{ok, rows:[{code,name,item_type,unit_id,group_name,chart_id,date_from,output_amount,cost,price,foodcost_pct,over_limit,missing_count}], total, page, pages}`
- `office_chart_get {code, chart_id?, date?}` → `{ok, item:{code,name,item_type,unit_id,price}, chart:{id,date_from,date_to,output_amount,technology,note,source,lines:[{id,ingredient_code,name,unit,item_type,brutto,netto,output,ing_cost,line_cost,cold_loss_pct,hot_loss_pct}]}|null, cost, partial, missing:[…], versions:[{id,date_from,date_to,source}]}`
- `office_chart_save {id?, code, date_from, date_to?, output_amount, technology?, note?, lines:[{ingredient_code, brutto, netto, output, note?}]}` → `{ok, id}`
- `office_chart_new_version {code, date_from}` → `{ok, id}`
- `office_chart_delete {id}` → `{ok}`
- `office_item_cost_get {code, date?}` → `{ok, cost, partial, missing}`
- `office_foodcost_report {point_id?, date?, group_id?}` → `{ok, rows:[{code,name,group_name,unit_id,cost,price,markup_pct,foodcost_pct,over_limit,missing}], limit, csv}`
- `office_item_save` дополнительно принимает `cost_price`; `office_item_get` отдаёт `cost_price, cost_date, cost_source, cost, partial, missing`.
- `migrate {pin, kind:'chart_candidates'}` → `{ok, rows:[{code, iiko_id}]}`; `kind:'charts'`, `kind:'costs'` → `{ok, inserted, updated, skipped, skipped_lines, unknown:[…до 20 имён/ид…]}`.

---

### Task 1: Схема карт, цен сырья и прав

**Files:**
- Create: `db/migrations/0010_charts_schema.sql`

**Interfaces:**
- Produces таблицы `tandem.charts(id uuid PK, item_code text → items, date_from date, date_to date null, output_amount numeric, technology text, note text, source text, iiko_id uuid unique, created_by uuid, created_at, updated_by uuid, updated_at)` с ограничением `charts_no_overlap`; `tandem.chart_lines(id uuid PK, chart_id uuid → charts cascade, ingredient_code text → items, brutto, netto, output numeric, sort_order int, note text)`; колонки `items.cost_price numeric, cost_date date, cost_source text`; `settings.foodcost_alert = '35'`; строки `role_permissions` раздела `charts`.

- [ ] **Step 1: Проверка «до»**

`execute_sql` (project `qeehxcnnuzuwskznhdyg`):
```sql
select to_regclass('tandem.charts') charts,
       (select count(*) from information_schema.columns where table_schema='tandem' and table_name='items' and column_name='cost_price') cost_col,
       (select count(*) from tandem.items where unit_id is null) no_unit,
       (select count(*) from tandem.role_permissions where section='charts') perms;
```
Expected: `charts = null, cost_col = 0, no_unit = 0, perms = 0`. Если `no_unit > 0` — остановиться: `set not null` в миграции упадёт; сообщить контроллеру список кодов.

- [ ] **Step 2: Миграция 0010**

```sql
-- Техкарты и себестоимость: схема. btree_gist — стандартное расширение Postgres,
-- нужно для ограничения «у блюда одна карта на любую дату».
create extension if not exists btree_gist;

alter table tandem.items
  add column if not exists cost_price  numeric,
  add column if not exists cost_date   date,
  add column if not exists cost_source text;
alter table tandem.items drop constraint if exists items_cost_source_check;
alter table tandem.items add constraint items_cost_source_check
  check (cost_source is null or cost_source in ('iiko_invoice','manual','document'));
alter table tandem.items alter column unit_id set not null;

create table if not exists tandem.charts (
  id            uuid primary key default gen_random_uuid(),
  item_code     text not null references tandem.items(code),
  date_from     date not null default current_date,
  date_to       date null,
  output_amount numeric not null check (output_amount > 0),
  technology    text null,
  note          text null,
  source        text not null default 'office' check (source in ('office','iiko')),
  iiko_id       uuid unique null,
  created_by    uuid null references tandem.users(id),
  created_at    timestamptz not null default now(),
  updated_by    uuid null references tandem.users(id),
  updated_at    timestamptz not null default now(),
  constraint charts_dates check (date_to is null or date_to >= date_from),
  constraint charts_no_overlap exclude using gist
    (item_code with =, daterange(date_from, date_to, '[]') with &&)
);
create index if not exists charts_item_idx on tandem.charts (item_code, date_from desc);

create table if not exists tandem.chart_lines (
  id              uuid primary key default gen_random_uuid(),
  chart_id        uuid not null references tandem.charts(id) on delete cascade,
  ingredient_code text not null references tandem.items(code),
  brutto          numeric not null check (brutto >= 0),
  netto           numeric not null check (netto >= 0),
  output          numeric not null check (output >= 0),
  sort_order      int not null default 0,
  note            text null
);
create index if not exists chart_lines_chart_idx on tandem.chart_lines (chart_id);
create index if not exists chart_lines_ingredient_idx on tandem.chart_lines (ingredient_code);

insert into tandem.settings (key, value) values ('foodcost_alert', '35')
on conflict (key) do nothing;

insert into tandem.role_permissions (role, section, action)
select r, 'charts', a from (values
  ('admin','view'),('admin','edit'),
  ('owner','view'),('owner','edit'),
  ('technologist','view'),('technologist','edit'),
  ('accountant','view'),
  ('storekeeper','view')
) v(r, a)
on conflict do nothing;

alter table tandem.charts      enable row level security;
alter table tandem.chart_lines enable row level security;
```

Перед применением проверить первичный ключ `settings`: `select conname from pg_constraint where conrelid='tandem.settings'::regclass;` — если `key` не уникален, заменить `on conflict (key) do nothing` на `where not exists (select 1 from tandem.settings where key='foodcost_alert')`-форму (`insert … select … where not exists`).

Применить `apply_migration(name: "0010_charts_schema")`.

- [ ] **Step 3: Проверка «после»**

```sql
select (select count(*) from tandem.role_permissions where section='charts') perms,
       (select value from tandem.settings where key='foodcost_alert') alert,
       (select conname from pg_constraint where conname='charts_no_overlap') overlap,
       (select is_nullable from information_schema.columns where table_schema='tandem' and table_name='items' and column_name='unit_id') unit_nullable;
```
Expected: `perms = 8, alert = '35', overlap = 'charts_no_overlap', unit_nullable = 'NO'`.

Проверить ограничение действием (и убрать за собой):
```sql
insert into tandem.charts (item_code, date_from, output_amount, note)
  select code, '2026-01-01', 1, 'ZZ_TEST_overlap' from tandem.items where item_type='dish' and active limit 1;
insert into tandem.charts (item_code, date_from, output_amount, note)
  select code, '2026-06-01', 1, 'ZZ_TEST_overlap' from tandem.items where item_type='dish' and active limit 1;
```
Expected: вторая вставка падает с `conflicting key value violates exclusion constraint "charts_no_overlap"`. Затем `delete from tandem.charts where note='ZZ_TEST_overlap'; select count(*) from tandem.charts;` → `0`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0010_charts_schema.sql
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: схема карт, цен сырья и прав раздела

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Функции расчёта себестоимости

**Files:**
- Create: `db/migrations/0011_cost_functions.sql`

**Interfaces:**
- Produces:
  - `tandem.active_chart(p_code text, p_date date) → uuid` — карта, действующая на дату (null, если нет).
  - `tandem.item_cost(p_code text, p_date date default current_date, p_depth int default 0) → table(cost numeric, partial numeric, missing text[])`.
  - `tandem.chart_reaches(p_from text, p_target text, p_date date) → boolean` — содержит ли дерево ингредиентов `p_from` позицию `p_target` (для проверки цикла).
  - `tandem.menu_foodcost(p_point text, p_date date, p_group uuid) → table(code, name, group_name, unit_id text, cost, price, markup_pct, foodcost_pct numeric, over_limit boolean, missing text[])`.

- [ ] **Step 1: Тест (проваливается)**

Один вызов `execute_sql` — вставка тестовых данных, расчёт, удаление; пока функций нет, упадёт на `tandem.item_cost does not exist`:

```sql
-- тестовые позиции: мука (товар, 100 ₸/кг), тесто (полуфабрикат), пирожок (блюдо)
insert into tandem.items (code, name, unit, unit_id, step, item_type, product_type, active, for_sale, price, cost_price, cost_source, source)
values ('ZZ_TEST_muka','ZZ_TEST_мука','кг','кг',0.5,'goods','GOODS',true,false,null,100,'manual','office'),
       ('ZZ_TEST_testo','ZZ_TEST_тесто','кг','кг',0.5,'prepared','PREPARED',true,false,null,null,null,'office'),
       ('ZZ_TEST_pir','ZZ_TEST_пирожок','шт','шт',1,'dish','DISH',true,true,50,null,null,'office'),
       ('ZZ_TEST_sol','ZZ_TEST_соль','кг','кг',0.5,'goods','GOODS',true,false,null,null,null,'office');
insert into tandem.charts (id, item_code, date_from, output_amount) values
  ('aaaaaaaa-0000-4000-8000-000000000001','ZZ_TEST_testo','2026-01-01',0.45),
  ('aaaaaaaa-0000-4000-8000-000000000002','ZZ_TEST_pir','2026-01-01',1);
insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order) values
  ('aaaaaaaa-0000-4000-8000-000000000001','ZZ_TEST_muka',0.5,0.5,0.45,0),
  ('aaaaaaaa-0000-4000-8000-000000000002','ZZ_TEST_testo',0.08,0.08,0.07,0);
select 'testo' k, * from tandem.item_cost('ZZ_TEST_testo', current_date)
union all select 'pir', * from tandem.item_cost('ZZ_TEST_pir', current_date)
union all select 'sol', * from tandem.item_cost('ZZ_TEST_sol', current_date);
```
Expected сейчас: ошибка «function tandem.item_cost(...) does not exist». Записать в отчёт. Данные остаются до Step 4.

- [ ] **Step 2: Миграция 0011**

```sql
-- Техкарты: расчёт себестоимости на дату.
create or replace function tandem.active_chart(p_code text, p_date date)
returns uuid language sql stable as $$
  select id from tandem.charts
  where item_code = p_code and date_from <= p_date and (date_to is null or date_to >= p_date)
  order by date_from desc limit 1
$$;

-- Себестоимость одной позиции за единицу на дату. Товар — учётная цена; блюдо/полуфабрикат —
-- сумма брутто × себестоимость ингредиента, делённая на выход карты. Если чего-то не хватает,
-- cost = null, а partial — сумма по тому, что посчиталось; missing — коды без цены/карты.
create or replace function tandem.item_cost(p_code text, p_date date default current_date, p_depth int default 0)
returns table(cost numeric, partial numeric, missing text[])
language plpgsql stable as $$
declare
  v_type text; v_price numeric; v_chart uuid; v_out numeric;
  v_sum numeric := 0; v_missing text[] := '{}'; v_all boolean := true;
  r record; s record;
begin
  if p_depth > 10 then
    return query select null::numeric, null::numeric, array['cycle:' || p_code]; return;
  end if;
  select item_type, cost_price into v_type, v_price from tandem.items where code = p_code;
  if not found then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  if v_type in ('goods','service') then
    if v_price is null then
      return query select null::numeric, null::numeric, array[p_code];
    else
      return query select v_price, v_price, '{}'::text[];
    end if;
    return;
  end if;
  v_chart := tandem.active_chart(p_code, p_date);
  if v_chart is null then
    return query select null::numeric, null::numeric, array[p_code]; return;
  end if;
  select output_amount into v_out from tandem.charts where id = v_chart;
  for r in select ingredient_code, brutto from tandem.chart_lines where chart_id = v_chart loop
    select * into s from tandem.item_cost(r.ingredient_code, p_date, p_depth + 1);
    if s.cost is null then
      v_all := false;
      v_missing := v_missing || s.missing;
    else
      v_sum := v_sum + r.brutto * s.cost;
    end if;
  end loop;
  return query select
    case when v_all then round(v_sum / v_out, 4) end,
    round(v_sum / v_out, 4),
    (select coalesce(array_agg(distinct m), '{}'::text[]) from unnest(v_missing) m);
end $$;

-- Есть ли p_target в дереве ингредиентов p_from (по картам, действующим на p_date).
create or replace function tandem.chart_reaches(p_from text, p_target text, p_date date default current_date)
returns boolean language sql stable as $$
  with recursive w as (
    select cl.ingredient_code as node, 1 as depth
    from tandem.chart_lines cl where cl.chart_id = tandem.active_chart(p_from, p_date)
    union all
    select cl.ingredient_code, w.depth + 1
    from w join tandem.chart_lines cl on cl.chart_id = tandem.active_chart(w.node, p_date)
    where w.depth < 10
  )
  select exists (select 1 from w where node = p_target)
$$;

-- Фудкост меню: все продаваемые блюда и полуфабрикаты одним рекурсивным обходом.
-- Множитель по пути = произведение брутто/выход; лист — товар (с ценой или без) либо
-- блюдо без действующей карты.
create or replace function tandem.menu_foodcost(p_point text default null, p_date date default current_date, p_group uuid default null)
returns table(code text, name text, group_name text, unit_id text, cost numeric, price numeric,
              markup_pct numeric, foodcost_pct numeric, over_limit boolean, missing text[])
language sql stable as $$
  with recursive
  lim as (select coalesce((select value::numeric from tandem.settings where key = 'foodcost_alert'), 35) as v),
  dishes as (
    select i.code, i.name, g.name as group_name, i.unit_id, coalesce(pp.price, i.price) as price
    from tandem.items i
    left join tandem.item_groups g on g.id = i.group_id
    left join tandem.item_prices pp on p_point is not null and pp.point_id = p_point and pp.item_code = i.code
    where i.active and i.for_sale and i.item_type in ('dish','prepared')
      and (p_group is null or i.group_id = p_group)
  ),
  walk as (
    select d.code as root, d.code as node, 1::numeric as factor, 0 as depth, array[d.code] as path
    from dishes d
    union all
    select w.root, cl.ingredient_code, w.factor * cl.brutto / c.output_amount, w.depth + 1, w.path || cl.ingredient_code
    from walk w
    join tandem.items i on i.code = w.node and i.item_type in ('dish','prepared')
    join tandem.charts c on c.id = tandem.active_chart(w.node, p_date)
    join tandem.chart_lines cl on cl.chart_id = c.id
    where w.depth < 10 and not (cl.ingredient_code = any(w.path))
  ),
  leaves as (
    select w.root, w.node, w.factor, i.item_type, i.cost_price
    from walk w join tandem.items i on i.code = w.node
    where i.item_type in ('goods','service') or tandem.active_chart(w.node, p_date) is null
  ),
  agg as (
    select root,
      sum(case when item_type in ('goods','service') and cost_price is not null then factor * cost_price else 0 end) as partial,
      bool_and(item_type in ('goods','service') and cost_price is not null) as complete,
      array_remove(array_agg(distinct case when not (item_type in ('goods','service') and cost_price is not null) then node end), null) as missing
    from leaves group by root
  )
  select d.code, d.name, d.group_name, d.unit_id,
    case when a.complete then round(a.partial, 2) end as cost,
    d.price,
    case when a.complete and a.partial > 0 and d.price is not null then round((d.price - a.partial) / a.partial * 100, 1) end as markup_pct,
    case when a.complete and d.price > 0 then round(a.partial / d.price * 100, 1) end as foodcost_pct,
    case when a.complete and d.price > 0 then a.partial / d.price * 100 > (select v from lim) else false end as over_limit,
    coalesce(a.missing, array[d.code]) as missing
  from dishes d left join agg a on a.root = d.code
  order by d.name
$$;

revoke all on function tandem.active_chart(text,date), tandem.item_cost(text,date,int),
  tandem.chart_reaches(text,text,date), tandem.menu_foodcost(text,date,uuid) from public;
```

Применить `apply_migration(name: "0011_cost_functions")`.

- [ ] **Step 3: Прогнать тест**

Повторить `select … item_cost …` из Step 1 (данные уже есть, повторно не вставлять):
Expected:
| k | cost | partial | missing |
|---|------|---------|---------|
| testo | 111.1111 | 111.1111 | {} |
| pir | 8.8889 | 8.8889 | {} |
| sol | null | null | {ZZ_TEST_sol} |

Затем цикл и версии:
```sql
insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output) values
  ('aaaaaaaa-0000-4000-8000-000000000001','ZZ_TEST_sol',0.01,0.01,0.01);
select tandem.chart_reaches('ZZ_TEST_pir','ZZ_TEST_muka') should_be_true,
       tandem.chart_reaches('ZZ_TEST_muka','ZZ_TEST_pir') should_be_false,
       (select cost from tandem.item_cost('ZZ_TEST_pir')) pir_cost_null,
       (select missing from tandem.item_cost('ZZ_TEST_pir')) pir_missing;
select code, cost, price, foodcost_pct, over_limit, missing from tandem.menu_foodcost(null, current_date, null) where code like 'ZZ\_TEST\_%';
```
Expected: `true, false, null, {ZZ_TEST_sol}`; в отчёте фудкоста строка `ZZ_TEST_pir` с `cost = null`, `missing = {ZZ_TEST_sol}`. Затем `update tandem.items set cost_price = 20, cost_source='manual' where code='ZZ_TEST_sol';` и повторить фудкост: `cost = 8.93`, `price = 50`, `foodcost_pct = 17.9`, `over_limit = false`, `missing = {}`. Проверить порог: `update tandem.items set price = 20 where code='ZZ_TEST_pir';` → `foodcost_pct = 44.7`, `over_limit = true`.

- [ ] **Step 4: Убрать тестовые данные**

```sql
delete from tandem.charts where item_code like 'ZZ\_TEST\_%';
delete from tandem.items where code like 'ZZ\_TEST\_%';
select (select count(*) from tandem.charts) + (select count(*) from tandem.chart_lines) + (select count(*) from tandem.items where code like 'ZZ\_TEST\_%') leftovers;
```
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0011_cost_functions.sql
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: функции себестоимости на дату, проверка цикла, фудкост меню

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Раздел «Техкарты» — RPC, цена сырья в номенклатуре, очистка теста

**Files:**
- Create: `db/migrations/0012_office_charts.sql`
- Modify: `tools/office-smoke.mjs` (новый раздел `charts` перед маркером `// --- разделы добавляются здесь ---`; в разделе `nomenclature` — проверка `cost_price`)

**Interfaces:**
- Consumes: Task 1 таблицы, Task 2 функции; диспетчер `public.tandem_office` (актуальное тело — из базы), `tandem.office_nomenclature` (актуальное тело — из базы), `public.tandem_test_cleanup` (актуальное тело — из базы), помощник `tandem.err`.
- Produces: `tandem.office_charts(action text, payload jsonb, v_user tandem.users) → jsonb` с действиями из «Соглашения»; в диспетчере — маршрут `chart%`/`foodcost%` → раздел `charts`; в `office_nomenclature`: `item_save` принимает `cost_price`, `item_get` отдаёт `cost_price, cost_date, cost_source, cost, partial, missing`, новое действие `item_cost_get`; `tandem_test_cleanup` чистит `charts` (каскадом `chart_lines`).

- [ ] **Step 1: Тест (проваливается)**

В `tools/office-smoke.mjs` перед маркером добавить:

```js
SECTIONS.charts = async (ctx) => {
  const t = ctx.token;
  const mk = async (p) => { const r = await call("office_item_save", { token: t, ...p }); check("создана " + p.name, r.ok && r.code, r); return r.code; };
  const muka = await mk({ name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг", cost_price: 100 });
  const sol  = await mk({ name: "ZZ_TEST_соль", item_type: "goods", unit_id: "кг" });
  const testo = await mk({ name: "ZZ_TEST_тесто", item_type: "prepared", unit_id: "кг" });
  const pir  = await mk({ name: "ZZ_TEST_пирожок", item_type: "dish", unit_id: "шт", price: 50, for_sale: true });
  let r = await call("office_item_get", { token: t, code: muka });
  check("учётная цена сохранена, источник manual", r.ok && Number(r.item.cost_price) === 100 && r.item.cost_source === "manual", r.item);
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }] });
  check("карта теста сохранена", r.ok && r.id, r);
  const testoChart = r.id;
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-01-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.08, netto: 0.08, output: 0.07 }] });
  check("карта пирожка сохранена", r.ok && r.id, r);
  r = await call("office_chart_get", { token: t, code: pir });
  check("себестоимость пирожка 8.8889", r.ok && Number(r.cost) === 8.8889 && r.chart.lines.length === 1 && Number(r.chart.lines[0].ing_cost) === 111.1111, { cost: r.cost, line: r.chart && r.chart.lines[0] });
  check("потери в строке посчитаны", r.ok && Number(r.chart.lines[0].hot_loss_pct) === 12.5 && Number(r.chart.lines[0].cold_loss_pct) === 0, r.chart && r.chart.lines[0]);
  r = await call("office_item_cost_get", { token: t, code: testo });
  check("item_cost_get теста 111.1111", r.ok && Number(r.cost) === 111.1111, r);
  // ингредиент без цены → cost null, missing
  r = await call("office_chart_save", { token: t, id: testoChart, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }, { ingredient_code: sol, brutto: 0.01, netto: 0.01, output: 0.01 }] });
  check("карта теста дополнена солью", r.ok, r);
  r = await call("office_chart_get", { token: t, code: pir });
  check("без цены соли себестоимость null, missing содержит соль", r.ok && r.cost === null && r.missing.includes(sol) && r.partial !== null, { cost: r.cost, missing: r.missing });
  // цикл: в тесто добавить пирожок
  r = await call("office_chart_save", { token: t, id: testoChart, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }, { ingredient_code: pir, brutto: 1, netto: 1, output: 1 }] });
  check("цикл отклонён — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: testo, brutto: 1, netto: 1, output: 1 }] });
  check("блюдо само в себе — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: muka, date_from: "2026-01-01", output_amount: 1, lines: [{ ingredient_code: sol, brutto: 1, netto: 1, output: 1 }] });
  check("карта у товара — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-01-01", output_amount: 1, lines: [] });
  check("карта без строк — validation", r.ok === false && r.error === "validation", r);
  // пересечение дат: вторая карта пирожка с 2026-03-01 при открытой первой
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-03-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.09 }] });
  check("пересечение дат — validation", r.ok === false && r.error === "validation", r);
  // новая версия с даты
  r = await call("office_chart_new_version", { token: t, code: pir, date_from: "2026-06-01" });
  check("новая версия создана", r.ok && r.id, r);
  const v2 = r.id;
  r = await call("office_chart_save", { token: t, id: v2, code: pir, date_from: "2026-06-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.09 }] });
  check("версия 2 изменена", r.ok, r);
  await call("office_item_save", { token: t, code: sol, cost_price: 20 });
  r = await call("office_chart_get", { token: t, code: pir, date: "2026-02-01" });
  const c1 = r.cost;
  r = await call("office_chart_get", { token: t, code: pir, date: "2026-07-01" });
  check("две версии: расчёт на разные даты различается", c1 !== null && r.cost !== null && Number(c1) < Number(r.cost) && r.versions.length === 2, { c1, c2: r.cost, versions: r.versions });
  check("старая версия закрыта датой", r.versions.some((v) => v.date_to === "2026-05-31"), r.versions);
  r = await call("office_charts_list", { token: t, q: "ZZ_TEST_пирожок" });
  check("список: пирожок с картой и себестоимостью", r.ok && r.total === 1 && r.rows[0].chart_id && r.rows[0].cost !== null && r.rows[0].foodcost_pct !== null, r.rows && r.rows[0]);
  r = await call("office_charts_list", { token: t, q: "ZZ_TEST_", only: "no_chart" });
  check("список: фильтр без карты пуст для тестовых (у всех блюд карты)", r.ok && r.rows.every((x) => !x.chart_id), r.rows);
  r = await call("office_foodcost_report", { token: t });
  const row = (r.rows || []).find((x) => x.code === pir);
  check("отчёт: пирожок с фудкостом и CSV", r.ok && row && row.foodcost_pct !== null && typeof r.csv === "string" && r.csv.includes("ZZ_TEST_пирожок"), row);
  r = await call("office_chart_delete", { token: t, id: testoChart });
  check("удаление карты офиса без версий после — ok", r.ok, r);
  r = await call("office_chart_get", { token: t, code: testo });
  check("после удаления карты у теста нет", r.ok && r.chart === null, r);
  // права кладовщика
  r = await call("office_user_save", { token: t, login: "zz_test_sklad_ch", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: "4321" });
  let l = await call("office_login", { login: "zz_test_sklad_ch", pin: "4321" });
  await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_charts_list", { token: l.token });
  check("кладовщик видит список карт", r.ok, r);
  r = await call("office_chart_save", { token: l.token, code: pir, date_from: "2026-09-01", output_amount: 1, lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("кладовщик не правит карты — forbidden", r.ok === false && r.error === "forbidden", r);
};
```

В разделе `nomenclature` после проверки «карточка: имя, цена точки» добавить:
```js
  r = await call("office_item_save", { token: t, code, cost_price: 55 });
  r = await call("office_item_get", { token: t, code });
  check("учётная цена товара в карточке", r.ok && Number(r.item.cost_price) === 55 && r.item.cost_source === "manual" && r.item.cost_date, r.item);
```
(в этом разделе `code` — тестовая позиция типа `goods`.)

Run: `TANDEM_ADMIN_PIN="$(cat '<scratchpad>/office_admin_pin.txt')" TANDEM_OWNER_PIN="<из settings>" node tools/office-smoke.mjs charts`
Expected: FAIL везде, начиная с `office_item_save` c `cost_price` (поле пока игнорируется → «учётная цена сохранена» FAIL) и `office_chart_save` → `unknown_action`.

- [ ] **Step 2: Миграция 0012 — раздел `charts`**

Функция раздела:

```sql
-- Техкарты: раздел бэк-офиса.
create or replace function tandem.office_charts(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security invoker set search_path to 'tandem','public' as $$
declare
  v_code   text := payload->>'code';
  v_id     uuid := nullif(payload->>'id','')::uuid;
  v_date   date := coalesce(nullif(payload->>'date','')::date, current_date);
  v_q      text := btrim(coalesce(payload->>'q',''));
  v_page   int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_only   text := nullif(payload->>'only','');
  v_group  uuid := nullif(payload->>'group_id','')::uuid;
  v_total  int; v_rows jsonb; v_type text; v_from date; v_to date; v_out numeric;
  v_prev   uuid; v_line jsonb; v_n int := 0; v_ing text; v_ing_type text; v_active boolean;
  v_chart  uuid; v_item jsonb; v_versions jsonb; v_lines jsonb; v_cost record; v_csv text; v_limit numeric;
begin
  -- ---------- список ----------
  if action = 'charts_list' then
    with base as (
      select i.code, i.name, i.item_type, i.unit_id, g.name as group_name, i.price,
             tandem.active_chart(i.code, current_date) as chart_id
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where i.active and i.item_type in ('dish','prepared')
        and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
        and (v_group is null or i.group_id = v_group)
    ),
    calc as (
      select b.*, c.date_from, c.output_amount, k.cost, k.missing
      from base b
      left join tandem.charts c on c.id = b.chart_id
      left join lateral tandem.item_cost(b.code, current_date) k on true
      where (v_only is null)
         or (v_only = 'no_chart' and b.chart_id is null)
         or (v_only = 'no_cost'  and b.chart_id is not null and k.cost is null)
    )
    select count(*), coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb)
      into v_total, v_rows
      from (select * from calc order by name limit 200 offset (v_page - 1) * 200) x;
    -- count(*) выше считает только страницу; общий счётчик отдельно:
    select count(*) into v_total from (
      select b.code from (
        select i.code, i.name, i.group_id, tandem.active_chart(i.code, current_date) as chart_id
        from tandem.items i where i.active and i.item_type in ('dish','prepared')
          and (v_q = '' or i.name ilike '%' || v_q || '%' or i.code = v_q)
          and (v_group is null or i.group_id = v_group)) b
      left join lateral tandem.item_cost(b.code, current_date) k on v_only = 'no_cost'
      where (v_only is null) or (v_only = 'no_chart' and b.chart_id is null)
         or (v_only = 'no_cost' and b.chart_id is not null and k.cost is null)) t;
    return jsonb_build_object('ok', true, 'total', v_total, 'page', v_page,
      'pages', greatest(ceil(v_total / 200.0)::int, 1),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
        'code', x->>'code', 'name', x->>'name', 'item_type', x->>'item_type', 'unit_id', x->>'unit_id',
        'group_name', x->>'group_name', 'chart_id', x->>'chart_id', 'date_from', x->>'date_from',
        'output_amount', (x->>'output_amount')::numeric, 'cost', (x->>'cost')::numeric,
        'price', (x->>'price')::numeric,
        'foodcost_pct', case when (x->>'cost') is not null and (x->>'price')::numeric > 0
                          then round((x->>'cost')::numeric / (x->>'price')::numeric * 100, 1) end,
        'over_limit', case when (x->>'cost') is not null and (x->>'price')::numeric > 0
                          then (x->>'cost')::numeric / (x->>'price')::numeric * 100 >
                               coalesce((select value::numeric from tandem.settings where key='foodcost_alert'), 35)
                          else false end,
        'missing_count', coalesce(jsonb_array_length(x->'missing'), 0))), '[]'::jsonb)
        from jsonb_array_elements(v_rows) x));
  end if;

  -- ---------- карточка ----------
  if action = 'chart_get' then
    select item_type into v_type from tandem.items where code = v_code;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена'); end if;
    v_chart := coalesce(v_id, tandem.active_chart(v_code, v_date));
    select jsonb_build_object('code', i.code, 'name', i.name, 'item_type', i.item_type, 'unit_id', i.unit_id, 'price', i.price)
      into v_item from tandem.items i where i.code = v_code;
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'date_from', date_from, 'date_to', date_to, 'source', source) order by date_from desc), '[]'::jsonb)
      into v_versions from tandem.charts where item_code = v_code;
    if v_chart is null then
      return jsonb_build_object('ok', true, 'item', v_item, 'chart', null, 'cost', null, 'partial', null,
        'missing', to_jsonb(array[v_code]), 'versions', v_versions);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', cl.id, 'ingredient_code', cl.ingredient_code, 'name', i.name, 'unit', i.unit_id, 'item_type', i.item_type,
        'brutto', cl.brutto, 'netto', cl.netto, 'output', cl.output, 'note', cl.note,
        'ing_cost', k.cost, 'line_cost', case when k.cost is not null then round(cl.brutto * k.cost, 4) end,
        'cold_loss_pct', case when cl.brutto > 0 then round((cl.brutto - cl.netto) / cl.brutto * 100, 1) end,
        'hot_loss_pct',  case when cl.netto > 0 then round((cl.netto - cl.output) / cl.netto * 100, 1) end)
        order by cl.sort_order, i.name), '[]'::jsonb)
      into v_lines
      from tandem.chart_lines cl join tandem.items i on i.code = cl.ingredient_code
      left join lateral tandem.item_cost(cl.ingredient_code, v_date) k on true
      where cl.chart_id = v_chart;
    select * into v_cost from tandem.item_cost(v_code, coalesce((select date_from from tandem.charts where id = v_chart), v_date));
    -- себестоимость считается на дату карты, если запрошена конкретная версия; иначе на v_date
    if v_id is null then select * into v_cost from tandem.item_cost(v_code, v_date); end if;
    return jsonb_build_object('ok', true, 'item', v_item,
      'chart', (select jsonb_build_object('id', c.id, 'date_from', c.date_from, 'date_to', c.date_to,
                  'output_amount', c.output_amount, 'technology', c.technology, 'note', c.note, 'source', c.source,
                  'lines', v_lines) from tandem.charts c where c.id = v_chart),
      'cost', v_cost.cost, 'partial', v_cost.partial, 'missing', to_jsonb(v_cost.missing), 'versions', v_versions);
  end if;

  -- ---------- сохранение ----------
  if action = 'chart_save' then
    select item_type into v_type from tandem.items where code = v_code and active;
    if v_type is null then return tandem.err('not_found', 'Позиция не найдена или выключена'); end if;
    if v_type not in ('dish','prepared') then return tandem.err('validation', 'Техкарта бывает только у блюда или полуфабриката'); end if;
    v_from := nullif(payload->>'date_from','')::date;
    v_to   := nullif(payload->>'date_to','')::date;
    v_out  := nullif(payload->>'output_amount','')::numeric;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала действия'); end if;
    if v_to is not null and v_to < v_from then return tandem.err('validation', 'Дата окончания раньше начала'); end if;
    if v_out is null or v_out <= 0 then return tandem.err('validation', 'Выход должен быть больше нуля'); end if;
    if jsonb_typeof(payload->'lines') <> 'array' or jsonb_array_length(payload->'lines') = 0 then
      return tandem.err('validation', 'В карте нет ни одной строки');
    end if;
    -- строки: ингредиент существует, активен, не само блюдо, не ведёт обратно к блюду
    for v_line in select * from jsonb_array_elements(payload->'lines') loop
      v_ing := v_line->>'ingredient_code';
      select item_type, active into v_ing_type, v_active from tandem.items where code = v_ing;
      if v_ing_type is null then return tandem.err('validation', 'Ингредиент не найден: ' || coalesce(v_ing,'')); end if;
      if not v_active then return tandem.err('validation', 'Ингредиент выключен: ' || v_ing); end if;
      if v_ing = v_code then return tandem.err('validation', 'Блюдо не может входить само в себя'); end if;
      if v_ing_type in ('dish','prepared') and tandem.chart_reaches(v_ing, v_code, v_from) then
        return tandem.err('validation', 'Цикл: ' || v_ing || ' уже содержит ' || v_code);
      end if;
      if coalesce((v_line->>'brutto')::numeric, -1) < 0 or coalesce((v_line->>'netto')::numeric, -1) < 0
         or coalesce((v_line->>'output')::numeric, -1) < 0 then
        return tandem.err('validation', 'Количества в строке ' || v_ing || ' должны быть числами не меньше нуля');
      end if;
    end loop;
    -- пересечение дат с другой картой этого блюда
    if exists (select 1 from tandem.charts c where c.item_code = v_code and (v_id is null or c.id <> v_id)
               and daterange(c.date_from, c.date_to, '[]') && daterange(v_from, v_to, '[]')) then
      return tandem.err('validation', 'На эти даты уже действует другая версия — закройте её датой или выберите другую дату начала');
    end if;
    if v_id is null then
      insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
        values (v_code, v_from, v_to, v_out, payload->>'technology', payload->>'note', 'office', v_user.id, v_user.id)
        returning id into v_id;
    else
      update tandem.charts set date_from = v_from, date_to = v_to, output_amount = v_out,
        technology = payload->>'technology', note = payload->>'note', updated_by = v_user.id, updated_at = now()
        where id = v_id and item_code = v_code;
      if not found then return tandem.err('not_found', 'Карта не найдена'); end if;
      delete from tandem.chart_lines where chart_id = v_id;
    end if;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, x->>'ingredient_code', (x->>'brutto')::numeric, (x->>'netto')::numeric, (x->>'output')::numeric,
             (ord - 1)::int, nullif(x->>'note','')
      from jsonb_array_elements(payload->'lines') with ordinality as t(x, ord);
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- новая версия с даты ----------
  if action = 'chart_new_version' then
    v_from := nullif(payload->>'date_from','')::date;
    if v_from is null then return tandem.err('validation', 'Укажите дату начала новой версии'); end if;
    v_prev := tandem.active_chart(v_code, v_from - 1);
    if v_prev is null then return tandem.err('validation', 'Нет действующей карты, которую можно продолжить — создайте карту обычным сохранением'); end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from >= v_from) then
      return tandem.err('validation', 'Уже есть версия с более поздней датой начала');
    end if;
    update tandem.charts set date_to = v_from - 1, updated_by = v_user.id, updated_at = now() where id = v_prev;
    insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, note, source, created_by, updated_by)
      select item_code, v_from, null, output_amount, technology, note, 'office', v_user.id, v_user.id
      from tandem.charts where id = v_prev returning id into v_id;
    insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order, note)
      select v_id, ingredient_code, brutto, netto, output, sort_order, note from tandem.chart_lines where chart_id = v_prev;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- ---------- удаление ----------
  if action = 'chart_delete' then
    select item_code, date_from into v_code, v_from from tandem.charts where id = v_id and source = 'office';
    if v_code is null then return tandem.err('validation', 'Удалять можно только карты, созданные в бэк-офисе; карты из iiko закрываются датой'); end if;
    if exists (select 1 from tandem.charts where item_code = v_code and date_from > v_from) then
      return tandem.err('validation', 'После этой версии есть более поздние — удалите сначала их');
    end if;
    delete from tandem.charts where id = v_id;
    -- предыдущая версия, закрытая ради удалённой, снова становится открытой
    update tandem.charts set date_to = null where item_code = v_code and date_to = v_from - 1
      and not exists (select 1 from tandem.charts c2 where c2.item_code = v_code and c2.date_from > v_from - 1);
    return jsonb_build_object('ok', true);
  end if;

  -- ---------- отчёт ----------
  if action = 'foodcost_report' then
    v_limit := coalesce((select value::numeric from tandem.settings where key='foodcost_alert'), 35);
    select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb),
           'code;name;group;unit;cost;price;markup_pct;foodcost_pct;over_limit;missing' || E'\n' ||
           coalesce(string_agg(concat_ws(';', m.code, replace(m.name,';',','), coalesce(replace(m.group_name,';',','),''), m.unit_id,
             coalesce(m.cost::text,''), coalesce(m.price::text,''), coalesce(m.markup_pct::text,''), coalesce(m.foodcost_pct::text,''),
             case when m.over_limit then '1' else '0' end, array_to_string(m.missing, ',')), E'\n'), '')
      into v_rows, v_csv
      from tandem.menu_foodcost(nullif(payload->>'point_id',''), v_date, v_group) m;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'limit', v_limit, 'csv', v_csv);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
revoke all on function tandem.office_charts(text,jsonb,tandem.users) from public;
```

Замечание к `charts_list`: первый `select count(*), jsonb_agg(...)` считает только страницу; общий счётчик берётся вторым запросом — так и оставить (упрощение допустимо), либо заменить на `count(*) over ()` внутри `calc` — по выбору исполнителя, но `total` в ответе должен быть общим числом строк по фильтру, а не размером страницы (тест `total === 1` при поиске по имени).

- [ ] **Step 3: Миграция 0012 — диспетчер, номенклатура, очистка**

В тот же файл ниже:

1. **Диспетчер.** Взять актуальное тело `select pg_get_functiondef('public.tandem_office(text,jsonb)'::regprocedure)` и внести две правки: в `v_section := case …` добавить строку **перед** `when action like 'group%' or action like 'item%'`:
   ```
       when action like 'chart%' or action like 'foodcost%' then 'charts'
   ```
   и в маршрутизации `if v_section = 'nomenclature' then … elsif …` добавить ветку `elsif v_section = 'charts' then return tandem.office_charts(action, payload, v_user);`. Правило `v_need` менять не нужно: `charts_list`/`chart_get`/`foodcost_report`/`item_cost_get` заканчиваются на `_list`/`_get`/`_report` — проверить, что в выражении `v_need` учтён суффикс `\_report`; если там только `\_list`, `\_search`, `\_get` — добавить `or action like '%\_report'`.

2. **Номенклатура.** Взять актуальное тело `tandem.office_nomenclature` и внести:
   - в `item_get` в объект `item` добавить `'cost_price', i.cost_price, 'cost_date', i.cost_date, 'cost_source', i.cost_source`, а в корневой ответ — `'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing)` через `select * from tandem.item_cost(v_code, current_date)` в переменную `k record` (объявить);
   - в `item_save` (и вставка, и правка): если `payload ? 'cost_price'` — `cost_price = nullif(payload->>'cost_price','')::numeric, cost_date = current_date, cost_source = case when nullif(payload->>'cost_price','') is null then null else 'manual' end`; иначе не трогать;
   - новое действие в начале функции:
     ```sql
     if action = 'item_cost_get' then
       if not exists (select 1 from tandem.items where code = v_code) then return tandem.err('not_found', 'Позиция не найдена'); end if;
       select * into k from tandem.item_cost(v_code, coalesce(nullif(payload->>'date','')::date, current_date));
       return jsonb_build_object('ok', true, 'cost', k.cost, 'partial', k.partial, 'missing', to_jsonb(k.missing));
     end if;
     ```
     (`v_code := payload->>'code'` — уже есть в функции как переменная для `item_get`; при необходимости объявить).

3. **Очистка.** Взять актуальное тело `public.tandem_test_cleanup` и перед удалением `items` добавить:
   ```sql
   with d as (delete from tandem.charts where item_code in
       (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%') returning 1)
     select count(*) into v_charts from d;
   ```
   (объявить `v_charts int`, добавить в возвращаемый объект `'charts', v_charts`). Строки карт удаляются каскадом. Также удалить `chart_lines`, где ингредиент — тестовый: `delete from tandem.chart_lines where ingredient_code in (select code from tandem.items where name like 'ZZ\_TEST\_%' or code like 'ZZ\_TEST\_%');` — до удаления позиций (иначе FK).

В конце файла — DO-обёртка прав для `tandem_office`, `tandem_test_cleanup` (как в 0008/0009).

Применить `apply_migration(name: "0012_office_charts")`.

- [ ] **Step 4: Прогнать тест**

Run: `TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… node tools/office-smoke.mjs charts` и затем `… all`.
Expected: раздел `charts` — все `ok` (около 30 проверок); `all` — все прежние 96 плюс новые, «очистка: следов нет» — `ok`. Если `hot_loss_pct` для строки теста ожидается 12.5: `(0.08 − 0.07)/0.08 × 100 = 12.5` ✓.

- [ ] **Step 5: Сверки и commit**

`pg_get_functiondef` для `tandem.office_charts`, `public.tandem_office`, `tandem.office_nomenclature`, `public.tandem_test_cleanup` = файл. `select count(*) from tandem.charts` → 0 после очистки.

```bash
git add db/migrations/0012_office_charts.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: RPC раздела, учётная цена в номенклатуре, очистка теста

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Виды переноса `chart_candidates`, `charts`, `costs` в `tandem_migrate`

**Files:**
- Create: `db/migrations/0013_migrate_charts.sql`
- Modify: `tools/office-smoke.mjs` (раздел `migrate`)

**Interfaces:**
- Consumes: `public.tandem_migrate(p_pin, p_kind, p_rows)` — актуальное тело из базы.
- Produces: `kind = 'chart_candidates'` → `{ok, rows:[{code, iiko_id}]}`; `kind = 'charts'` (строки `{iiko_id, code, date_from, date_to, output_amount, technology, lines:[{ingredient_iiko_id, brutto, netto, output, sort}]}`) → `{ok, inserted, updated, skipped, skipped_lines, unknown:[…]}`; `kind = 'costs'` (строки `{iiko_id, price, date, source}`) → `{ok, updated, skipped}`.

- [ ] **Step 1: Тест (проваливается)**

В разделе `migrate` (после проверок items, до «чужой код — отказ»):

```js
  // техкарты: две версии одного блюда + строка с неизвестным ингредиентом + цены закупа
  const CH1 = "88888888-8888-4888-8888-888888888801", CH2 = "88888888-8888-4888-8888-888888888802";
  const I2 = "44444444-4444-4444-8444-444444444402";
  r = await call("migrate", { pin, kind: "items", rows: [
    { id: I2, code: "ZZ_TEST_2", name: "ZZ_TEST_пф_миграция", artikul: "", group_id: G, unit: "кг", type: "prepared", deleted: false, price: null }] });
  r = await call("migrate", { pin, kind: "chart_candidates", rows: [] });
  check("кандидаты: тестовый полуфабрикат в списке", r.ok && (r.rows || []).some((x) => x.code === "ZZ_TEST_2" && x.iiko_id === I2), { n: r.rows && r.rows.length });
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH1, code: "ZZ_TEST_2", date_from: "2026-01-01", date_to: null, output_amount: 1, technology: "смешать",
      lines: [{ ingredient_iiko_id: I, brutto: 2, netto: 2, output: 1.8, sort: 0 }, { ingredient_iiko_id: "99999999-9999-4999-8999-999999999999", brutto: 1, netto: 1, output: 1, sort: 1 }] },
    { iiko_id: CH2, code: "ZZ_TEST_2", date_from: "2026-05-01", date_to: null, output_amount: 1, technology: null,
      lines: [{ ingredient_iiko_id: I, brutto: 3, netto: 3, output: 2.7, sort: 0 }] },
  ] });
  check("карты: 2 вставлены, 1 строка пропущена, неизвестный ингредиент назван", r.ok && r.inserted === 2 && r.skipped_lines === 1 && Array.isArray(r.unknown) && r.unknown.length === 1, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH2, code: "ZZ_TEST_2", date_from: "2026-05-01", date_to: null, output_amount: 1.5, technology: null,
      lines: [{ ingredient_iiko_id: I, brutto: 3, netto: 3, output: 2.7, sort: 0 }] } ] });
  check("карты: повтор обновляет, не дублирует", r.ok && r.updated === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: "88888888-8888-4888-8888-888888888803", code: "ZZ_TEST_2", date_from: "2026-03-01", date_to: null, output_amount: 1,
      lines: [{ ingredient_iiko_id: "99999999-9999-4999-8999-999999999999", brutto: 1, netto: 1, output: 1, sort: 0 }] } ] });
  check("карта без единой известной строки пропущена", r.ok && r.skipped === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 77.5, date: "2026-07-15", source: "iiko_invoice" }] });
  check("цены: обновлена 1", r.ok && r.updated === 1, r);
  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 1, date: "2026-07-16", source: "iiko_invoice" }] });
  check("цены: повтор из накладной обновляет", r.ok && r.updated === 1, r);
```
и в конце раздела `migrate` (после «чужой код — отказ») ничего не менять: очистка — общая в конце прогона; `tandem_test_cleanup` уже удаляет `charts` тестовых позиций (Task 3).

Run: `TANDEM_OWNER_PIN=… node tools/office-smoke.mjs migrate`
Expected: новые проверки FAIL («Неизвестный вид: chart_candidates» и т.д.).

- [ ] **Step 2: Миграция 0013**

Взять актуальное тело `public.tandem_migrate` и добавить ветки перед `else return … 'Неизвестный вид'`:

```sql
  elsif p_kind = 'chart_candidates' then
    return jsonb_build_object('ok', true, 'rows', (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'iiko_id', iiko_id) order by code), '[]'::jsonb)
      from tandem.items where active and iiko_id is not null and item_type in ('dish','prepared')));

  elsif p_kind = 'charts' then
    -- по одной карте: сопоставить строки по items.iiko_id, пропустить неизвестные, закрыть
    -- пересекающиеся версии, вставить/обновить по iiko_id карты
    declare
      v_row jsonb; v_cid uuid; v_code text; v_from date; v_to date; v_out numeric; v_lines jsonb;
      v_known int; v_skip_lines int := 0; v_unknown text[] := '{}'; v_exists uuid; v_c record;
    begin
      for v_row in select * from jsonb_array_elements(p_rows) loop
        v_cid  := nullif(v_row->>'iiko_id','')::uuid;
        v_code := v_row->>'code';
        v_from := coalesce(nullif(v_row->>'date_from','')::date, '2020-01-01');
        v_to   := nullif(v_row->>'date_to','')::date;
        v_out  := coalesce(nullif(v_row->>'output_amount','')::numeric, 1);
        if v_cid is null or v_code is null or not exists (select 1 from tandem.items where code = v_code) then
          v_skip := v_skip + 1; continue;
        end if;
        if v_out <= 0 then v_out := 1; end if;
        if v_to is not null and v_to < v_from then v_to := null; end if;
        -- строки: известные по iiko_id
        select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'brutto', (l->>'brutto')::numeric,
                 'netto', (l->>'netto')::numeric, 'output', (l->>'output')::numeric, 'sort', coalesce((l->>'sort')::int, 0))), '[]'::jsonb),
               count(*) filter (where i.code is null)
          into v_lines, v_known
          from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
          left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid;
        -- v_known здесь — число НЕизвестных строк (см. filter выше)
        v_skip_lines := v_skip_lines + v_known;
        if v_known > 0 then
          -- накапливаем идентификаторы неизвестных ингредиентов, не теряя прежние
          select v_unknown || coalesce(array_agg(distinct l->>'ingredient_iiko_id'), '{}'::text[]) into v_unknown
            from jsonb_array_elements(coalesce(v_row->'lines','[]'::jsonb)) l
            left join tandem.items i on i.iiko_id = nullif(l->>'ingredient_iiko_id','')::uuid
            where i.code is null;
        end if;
        if jsonb_array_length(v_lines) = 0 then v_skip := v_skip + 1; continue; end if;
        -- строки, где ингредиент = само блюдо, отбрасываем
        select coalesce(jsonb_agg(x), '[]'::jsonb) into v_lines from jsonb_array_elements(v_lines) x where x->>'code' <> v_code;
        if jsonb_array_length(v_lines) = 0 then v_skip := v_skip + 1; continue; end if;
        select id into v_exists from tandem.charts where iiko_id = v_cid;
        -- пересечения с другими картами блюда: ранние закрываем, для поздних укорачиваем себя
        for v_c in select id, date_from, date_to from tandem.charts
                   where item_code = v_code and (v_exists is null or id <> v_exists)
                     and daterange(date_from, date_to, '[]') && daterange(v_from, v_to, '[]') loop
          if v_c.date_from < v_from then
            update tandem.charts set date_to = v_from - 1 where id = v_c.id;
          elsif v_c.date_from > v_from then
            v_to := v_c.date_from - 1;
          else
            -- та же дата начала у другой карты iiko: побеждает та, что пришла позже — старую сдвигаем на день назад-закрываем
            update tandem.charts set date_to = v_from - 1 where id = v_c.id and date_from <= v_from - 1;
            if v_c.date_from = v_from then delete from tandem.charts where id = v_c.id; end if;
          end if;
        end loop;
        if v_to is not null and v_to < v_from then v_skip := v_skip + 1; continue; end if;
        if v_exists is null then
          insert into tandem.charts (item_code, date_from, date_to, output_amount, technology, source, iiko_id)
            values (v_code, v_from, v_to, v_out, nullif(v_row->>'technology',''), 'iiko', v_cid) returning id into v_exists;
          v_ins := v_ins + 1;
        else
          update tandem.charts set item_code = v_code, date_from = v_from, date_to = v_to, output_amount = v_out,
            technology = nullif(v_row->>'technology',''), updated_at = now() where id = v_exists;
          delete from tandem.chart_lines where chart_id = v_exists;
          v_upd := v_upd + 1;
        end if;
        insert into tandem.chart_lines (chart_id, ingredient_code, brutto, netto, output, sort_order)
          select v_exists, x->>'code', coalesce((x->>'brutto')::numeric,0), coalesce((x->>'netto')::numeric,0),
                 coalesce((x->>'output')::numeric,0), (x->>'sort')::int
          from jsonb_array_elements(v_lines) x;
      end loop;
      return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
        'skipped_lines', v_skip_lines, 'unknown', to_jsonb(coalesce(v_unknown[1:20], '{}'::text[])));
    end;

  elsif p_kind = 'costs' then
    with inc as (
      select distinct on (id) (x->>'id')::uuid id, (x->>'price')::numeric price, nullif(x->>'date','')::date d,
             case when x->>'source' in ('iiko_invoice','document') then x->>'source' else 'iiko_invoice' end src
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'iiko_id','') <> '' and coalesce(x->>'price','') <> ''
      -- ключ во входе называется iiko_id
      order by id, d desc nulls last
    ),
    upd as (
      update tandem.items i set cost_price = inc.price, cost_date = coalesce(inc.d, current_date), cost_source = inc.src
      from inc where i.iiko_id = inc.id and (i.cost_source is null or i.cost_source = 'iiko_invoice')
      returning 1)
    select count(*) into v_upd from upd;
    return jsonb_build_object('ok', true, 'updated', v_upd, 'skipped', v_total - v_upd);
```

Внимание исполнителю: во входных строках `costs` ключ — `iiko_id`; в `inc` выше замените `(x->>'id')::uuid` на `(x->>'iiko_id')::uuid` (и `distinct on` по нему). Объявите в шапке функции `v_skip int := 0` (если уже есть переменная `skipped`, вычисляемая как `v_total - v_ins - v_upd`, для ветки `charts` возвращайте `v_skip` явно, как в коде выше). Блок накопления `v_unknown` упростите до одного запроса: `select coalesce(v_unknown,'{}') || array_agg(...)` — главное, чтобы в ответе были идентификаторы неизвестных ингредиентов (до 20).

Применить `apply_migration(name: "0013_migrate_charts")`.

- [ ] **Step 3: Прогнать тест**

Run: `TANDEM_OWNER_PIN=… node tools/office-smoke.mjs migrate`
Expected: все проверки раздела `ok`; после прогона `test_cleanup` — `leftovers 0`. Проверить SQL: `select count(*) from tandem.charts where source='iiko'` → 0 (тестовые удалены вместе с позициями).

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0013_migrate_charts.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: перенос карт и цен закупа — виды chart_candidates, charts, costs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Скрипт переноса из iiko, боевой перенос, экран точки на новых таблицах

**Files:**
- Create: `tools/iiko-migrate-charts.mjs`, `db/migrations/0014_point_charts.sql`

**Interfaces:**
- Consumes: маршрут `migrate` с видами из Task 4; iiko: `assembly-chart/list {productId}` → `{items:[{id, product, dateFrom, dateTo, assembledAmount, technologyDescription?, items:[{product, amountIn, amountMiddle, amountOut, sortWeight}]}]}`; `/api/1/organizations`; `incoming_invoice/list {organizationId, from, to}` (даты строго `YYYY-MM-DD`) → `{incomingInvoices:[{documentId, date, deleted}]}` или массив; `incoming_invoice/get {organizationId, documentId}` → `{incomingInvoice:{items:[{product, price, amount, sum}]}}`.
- Produces: заполненные `charts`/`chart_lines` (`source='iiko'`), `items.cost_price` (`iiko_invoice`); `public.tandem_charts` на новых таблицах; таблица `item_chart` и RPC `tandem_sync_charts` удалены.

- [ ] **Step 1: Снимок «до» для регресса экрана точки**

```bash
node --input-type=module -e "
const U='https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet';
const r=await fetch(U,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'charts',payload:{pin:process.env.TANDEM_POINT_PIN,point_id:'eneshka'}})}).then(r=>r.json());
const fs=await import('node:fs'); fs.mkdirSync('data',{recursive:true}); fs.writeFileSync('data/charts_eneshka_before.json',JSON.stringify(r.charts));
console.log('позиций с картой:',Object.keys(r.charts||{}).length);"
```
где `TANDEM_POINT_PIN` — `select pin from tandem.points where id='eneshka'` (не записывать). Expected: `позиций с картой: 45` (или близко). Файл — в `data/` (не в git).

- [ ] **Step 2: Скрипт переноса**

`tools/iiko-migrate-charts.mjs`:

```js
// Перенос технологических карт и цен закупа из iiko → charts/chart_lines и items.cost_price.
// Карты запрашиваются по одному блюду (assembly-chart/list требует productId): ~2 200 запросов
// с паузой 1,3 с — около 50 минут. Ответы кэшируются в data/iiko/charts/<productId>.json,
// повторный запуск берёт кэш и не ходит в iiko за уже полученным.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET, TANDEM_OWNER_PIN.
// Запуск: node tools/iiko-migrate-charts.mjs [--dry] [--limit N] [--skip-costs] [--only-costs]
// Прогресс пишется в data/iiko/charts.log — запускайте в фоне и смотрите лог.
import fs from "node:fs";
const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const CACHE = "data/iiko/charts";
const LOG = "data/iiko/charts.log";
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SKIP_COSTS = args.includes("--skip-costs");
const ONLY_COSTS = args.includes("--only-costs");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "--limit=0").split("=")[1]) || 0;
const PIN = process.env.TANDEM_OWNER_PIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CACHE, { recursive: true });
const log = (s) => { const line = new Date().toISOString().slice(11, 19) + " " + s; console.log(line); fs.appendFileSync(LOG, line + "\n"); };

let token = null, tokenAt = 0;
async function auth() {
  const r = await fetch(IIKO + "/api/v2/access_token", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.IIKO_API_KEY, appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET }) });
  const j = await r.json(); if (!j.token) throw new Error("нет токена: " + JSON.stringify(j).slice(0, 200));
  token = j.token; tokenAt = Date.now();
}
async function iiko(path, body) {
  if (!token || Date.now() - tokenAt > 50 * 60 * 1000) await auth();   // токен живёт час
  for (let i = 0; i < 6; i++) {
    const r = await fetch(IIKO + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body ?? {}) });
    if (r.status === 429) { await sleep(4000); continue; }
    if (r.status === 401) { await auth(); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + t.slice(0, 200));
    return JSON.parse(t);
  }
  throw new Error(path + ": постоянный 429");
}
async function migrate(kind, rows) {
  const r = await fetch(UCHET, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "migrate", payload: { pin: PIN, kind, rows } }) }).then((x) => x.json());
  if (!r.ok) throw new Error(kind + ": " + (r.message || r.error));
  return r;
}

async function charts() {
  const cand = (await migrate("chart_candidates", [])).rows;
  const list = LIMIT ? cand.slice(0, LIMIT) : cand;
  log(`кандидатов: ${cand.length}${LIMIT ? ", берём " + list.length : ""}`);
  const rows = []; let fetched = 0, cached = 0, empty = 0;
  for (const c of list) {
    const f = `${CACHE}/${c.iiko_id}.json`;
    let resp;
    if (fs.existsSync(f)) { resp = JSON.parse(fs.readFileSync(f, "utf8")); cached++; }
    else {
      resp = await iiko("/api/nomenclature/v1/assembly-chart/list", { productId: c.iiko_id });
      fs.writeFileSync(f, JSON.stringify(resp)); fetched++;
      await sleep(1300);
    }
    const items = resp.items || resp.assemblyCharts || [];
    if (!items.length) empty++;
    for (const ch of items) {
      rows.push({
        iiko_id: ch.id, code: c.code, date_from: ch.dateFrom || null, date_to: ch.dateTo || null,
        output_amount: Number(ch.assembledAmount) || 1, technology: ch.technologyDescription || null,
        lines: (ch.items || []).map((l) => ({ ingredient_iiko_id: l.product, brutto: Number(l.amountIn) || 0,
          netto: Number(l.amountMiddle) || 0, output: Number(l.amountOut) || 0, sort: Number(l.sortWeight) || 0 })),
      });
    }
    if ((fetched + cached) % 100 === 0) log(`  ${fetched + cached}/${list.length} (из iiko ${fetched}, из кэша ${cached}), карт ${rows.length}`);
  }
  log(`получено карт: ${rows.length}; блюд без карты в iiko: ${empty}`);
  if (DRY) return;
  let ins = 0, upd = 0, skip = 0, skipL = 0, unknown = new Set();
  // сортируем по блюду и дате начала — так закрытие версий внутри RPC идёт в естественном порядке
  rows.sort((a, b) => a.code.localeCompare(b.code) || String(a.date_from).localeCompare(String(b.date_from)));
  for (let i = 0; i < rows.length; i += 100) {
    const r = await migrate("charts", rows.slice(i, i + 100));
    ins += r.inserted; upd += r.updated; skip += r.skipped; skipL += r.skipped_lines;
    (r.unknown || []).forEach((u) => unknown.add(u));
  }
  log(`карты: вставлено ${ins}, обновлено ${upd}, пропущено ${skip}; строк пропущено ${skipL}; неизвестных ингредиентов ${unknown.size}`);
  if (unknown.size) log("  примеры неизвестных: " + [...unknown].slice(0, 20).join(", "));
}

async function costs() {
  const orgs = (await iiko("/api/1/organizations", { returnAdditionalInfo: false, includeDisabled: false })).organizations || [];
  const from = "2026-01-01", to = new Date().toISOString().slice(0, 10);
  const last = new Map();   // product → {price, date}
  let docs = 0, lines = 0;
  for (const o of orgs) {
    await sleep(1300);
    const l = await iiko("/api/inventory/v1/incoming_invoice/list", { organizationId: o.id, from, to });
    const list = Array.isArray(l) ? l : (l.incomingInvoices || l.documents || []);
    log(`накладных у «${o.name}»: ${list.length}`);
    for (const d of list) {
      if (d.deleted) continue;
      const f = `${CACHE}/inv_${d.documentId}.json`;
      let g;
      if (fs.existsSync(f)) g = JSON.parse(fs.readFileSync(f, "utf8"));
      else { await sleep(1200); g = await iiko("/api/inventory/v1/incoming_invoice/get", { organizationId: o.id, documentId: d.documentId }); fs.writeFileSync(f, JSON.stringify(g)); }
      const inv = g.incomingInvoice || g;
      const date = String(d.date || inv.date).slice(0, 10);
      for (const it of (inv.items || [])) {
        const price = Number(it.price || (it.sum && it.amount ? it.sum / it.amount : 0));
        if (!it.product || !(price > 0)) continue;
        lines++;
        const prev = last.get(it.product);
        if (!prev || prev.date <= date) last.set(it.product, { price, date });
      }
      docs++;
    }
  }
  log(`накладных прочитано ${docs}, строк ${lines}, товаров с ценой ${last.size}`);
  if (DRY) return;
  const rows = [...last.entries()].map(([iiko_id, v]) => ({ iiko_id, price: v.price, date: v.date, source: "iiko_invoice" }));
  let upd = 0, skip = 0;
  for (let i = 0; i < rows.length; i += 500) { const r = await migrate("costs", rows.slice(i, i + 500)); upd += r.updated; skip += r.skipped; }
  log(`цены: обновлено ${upd}, пропущено ${skip} (не найдены по iiko_id или помечены manual)`);
}

if (!PIN && !DRY) throw new Error("TANDEM_OWNER_PIN не задан");
if (!ONLY_COSTS) await charts();
if (!SKIP_COSTS) await costs();
log("готово");
```

- [ ] **Step 3: Пробный перенос на 20 блюдах**

Run (Bash, из корня репозитория, секреты из скретчпада `iiko/apilogin.txt`, `app_id.txt`, `client_secret.txt`, код собственника из базы): `IIKO_API_KEY=… IIKO_APP_ID=… IIKO_CLIENT_SECRET=… TANDEM_OWNER_PIN=… node tools/iiko-migrate-charts.mjs --limit=20 --skip-costs`
Expected: лог с числом кандидатов (≈2 191), получено карт ≤ 20–40, вставлено = получено − пропущено. Проверить в базе: `select c.item_code, i.name, c.date_from, c.date_to, c.output_amount, (select count(*) from tandem.chart_lines l where l.chart_id=c.id) lines from tandem.charts c join tandem.items i on i.code=c.item_code order by 2, 3;` — версии одного блюда не пересекаются (иначе RPC упал бы на ограничении). Сравнить одну карту с iiko вручную (числа брутто/нетто/выход одной строки) — записать в отчёт.

- [ ] **Step 4: Боевой перенос в фоне**

Команда та же без `--limit` (сначала `--skip-costs`, затем `--only-costs`), запуск в фоне (`run_in_background`), ход — в `data/iiko/charts.log`. Ожидание: около 50 минут на карты, несколько минут на накладные. По завершении — итоговые строки лога в отчёт.

SQL-сверка:
```sql
select (select count(*) from tandem.charts where source='iiko') charts_iiko,
       (select count(distinct item_code) from tandem.charts) items_with_chart,
       (select count(*) from tandem.chart_lines) lines,
       (select count(*) from tandem.items where item_type='goods' and active and cost_price is not null) goods_priced,
       (select count(*) from tandem.items where item_type='goods' and active) goods_total,
       (select count(*) from tandem.menu_foodcost(null, current_date, null) where cost is not null) menu_costed,
       (select count(*) from tandem.menu_foodcost(null, current_date, null)) menu_total;
```
Записать все числа. Критерий спецификации — `menu_costed / menu_total ≥ 0.8`; если ниже — это **не блокер задачи** (цены дозаполнят руками), но число и топ-20 ингредиентов без цены (`select node, count(*) from … missing`) — в отчёт: `select m, count(*) from tandem.menu_foodcost(null,current_date,null), unnest(missing) m group by m order by 2 desc limit 20;` с именами через join к `items`.

- [ ] **Step 5: Миграция 0014 — экран точки на новых таблицах**

```sql
-- Экран точки «расход сырья»: те же данные из новых таблиц. Формат ответа не меняется.
create or replace function public.tandem_charts(p_pin text, p_point text)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text;
  v_cats  text[];
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner
     and not exists (select 1 from tandem.points where id = p_point and pin = p_pin and active) then
    return jsonb_build_object('ok', false, 'error', 'Нет доступа');
  end if;
  select item_categories into v_cats from tandem.points where id = p_point;
  return jsonb_build_object('ok', true, 'charts', (
    select coalesce(jsonb_object_agg(item_code, lines), '{}'::jsonb)
    from (
      select c.item_code,
             jsonb_agg(jsonb_build_object('n', ing.name, 'a', round(cl.brutto / c.output_amount, 4)) order by cl.brutto desc) as lines
      from tandem.charts c
      join tandem.items i on i.code = c.item_code and i.active and i.for_sale
      join tandem.chart_lines cl on cl.chart_id = c.id
      join tandem.items ing on ing.code = cl.ingredient_code
      where c.id = tandem.active_chart(c.item_code, current_date)
        and (v_cats is null or cardinality(v_cats) = 0 or i.category = any(v_cats))
      group by c.item_code
    ) t));
end $$;

drop function if exists public.tandem_sync_charts(text, jsonb);
drop table if exists tandem.item_chart;
```
Перед применением снять снимок старой таблицы на случай отката: `select count(*) from tandem.item_chart` и `copy`-аналог не нужен — данные восстановимы переносом; но записать в отчёт число строк (223). Также убрать маршрут `sync_charts` из `supabase/functions/uchet/index.ts` и задеплоить (`verify_jwt:false`), удалить `tools/iiko-sync-charts.mjs` (`git rm`). Применить `apply_migration(name: "0014_point_charts")`.

- [ ] **Step 6: Регресс экрана точки**

Снять снимок «после» тем же вызовом, что в Step 1 (в `data/charts_eneshka_after.json`), и сравнить скриптом:
```bash
node -e "
const fs=require('fs'); const a=JSON.parse(fs.readFileSync('data/charts_eneshka_before.json')), b=JSON.parse(fs.readFileSync('data/charts_eneshka_after.json'));
const ka=Object.keys(a), kb=Object.keys(b); console.log('было позиций',ka.length,'стало',kb.length,'из старых отсутствует',ka.filter(k=>!b[k]).length);
let same=0,diff=0; for(const k of ka){ if(!b[k])continue; const A=new Map(a[k].map(x=>[x.n,+x.a])), B=new Map(b[k].map(x=>[x.n,+x.a]));
 let ok=true; for(const [n,v] of A){ const w=B.get(n); if(w===undefined||Math.abs(w-v)>1e-3){ok=false;} } ok?same++:diff++; }
console.log('совпали',same,'разошлись',diff);"
```
Expected: старые 45 позиций присутствуют; число позиций стало больше (карт теперь у всех продаваемых блюд); «разошлись» — 0 или объяснимое число (в отчёт первые 5 расхождений с именами: старая синхронизация могла брать другое поле). Открыть `index.html` локально (`npx --yes serve -l 8077 .`), войти Енешкой, добавить позицию с картой — блок «расход сырья» показывается; отчёт не сохранять.

- [ ] **Step 7: Commit**

```bash
git add tools/iiko-migrate-charts.mjs db/migrations/0014_point_charts.sql supabase/functions/uchet/index.ts
git rm -q tools/iiko-sync-charts.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: перенос карт и цен закупа из iiko; экран точки на новых таблицах

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Экран «Техкарты»: список и редактор

**Files:**
- Create: `js/office/charts.js`
- Modify: `js/office/app.js` (раздел в `SECTIONS` + открытие по `#charts/<код>`)

**Interfaces:**
- Consumes: `api`, `can` из `api.js`; `el`, `fmt`, `toast`, `debounce`, `modal`, `confirmDlg` из `ui.js`; RPC Task 3; `office_items_search {q, active:true}` для поиска ингредиента; `office_groups_list`.
- Produces: `export async function mount(root)`; `export function openChart(code)` — открыть редактор по коду (используется из карточки номенклатуры через hash).

- [ ] **Step 1: app.js**

В `SECTIONS` после `nomenclature` добавить `{ id: "charts", title: "Техкарты" }`. В `start()` перед выбором `first`: если `location.hash` начинается с `#charts/` и раздел `charts` разрешён — `first = "charts"`. В `open()` после `await mod.mount(main)`: `if (id === "charts" && location.hash.startsWith("#charts/") && mod.openChart) { mod.openChart(decodeURIComponent(location.hash.slice(8))); history.replaceState(null, "", location.pathname); }`.

- [ ] **Step 2: charts.js**

```js
import { api, can } from "./api.js?v=1";
import { el, fmt, toast, debounce, modal, confirmDlg } from "./ui.js?v=1";

const TYPES = { dish: "блюдо", prepared: "полуфабрикат" };
let root, table, pager, groups = [];
let state = { q: "", group_id: "", only: "", page: 1, tab: "list" };

export async function mount(r) {
  root = r; state.page = 1;
  groups = (await api("groups_list", {})).groups || [];
  drawShell();
  await load();
}
export function openChart(code) { editChart(code); }

function drawShell() {
  root.innerHTML = "";
  const tabs = el("div", { class: "tools" },
    el("button", { class: state.tab === "list" ? "" : "ghost", onclick: () => { state.tab = "list"; drawShell(); load(); } }, "Карты"),
    el("button", { class: state.tab === "report" ? "" : "ghost", onclick: () => { state.tab = "report"; drawShell(); loadReport(); } }, "Фудкост меню"));
  root.append(tabs);
  if (state.tab === "report") { root.append(el("div", { id: "fc-root" })); return; }
  const groupSel = el("select", { onchange: (e) => { state.group_id = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.group_id === "" }, "все группы"),
    ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === state.group_id }, g.name)));
  const onlySel = el("select", { onchange: (e) => { state.only = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.only === "" }, "все блюда"),
    el("option", { value: "no_chart", selected: state.only === "no_chart" }, "без карты"),
    el("option", { value: "no_cost", selected: state.only === "no_cost" }, "без себестоимости"));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Поиск блюда или полуфабриката", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
      groupSel, onlySel),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}

async function load() {
  if (state.tab !== "list") return;
  const r = await api("charts_list", { q: state.q, group_id: state.group_id || null, only: state.only || null, page: state.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Позиция", "Тип", "Карта", "Выход", "Себестоимость", "Цена", "Фудкост"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) {
    table.append(el("tr", { class: "row", onclick: () => editChart(x.code) },
      el("td", {}, x.name, el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, x.group_name || "")),
      el("td", {}, TYPES[x.item_type] || x.item_type),
      el("td", {}, x.chart_id ? "с " + x.date_from : el("span", { class: "tag bad" }, "нет карты")),
      el("td", { class: "num" }, x.output_amount != null ? fmt(x.output_amount) + " " + (x.unit_id || "") : ""),
      el("td", { class: "num" }, x.cost != null ? fmt(x.cost) : (x.chart_id ? el("span", { class: "tag" }, "нет цены у " + x.missing_count) : "")),
      el("td", { class: "num" }, fmt(x.price)),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok") }, fmt(x.foodcost_pct) + " %") : "")));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

// ---------- редактор ----------
async function editChart(code, chartId) {
  const r = await api("chart_get", { code, chart_id: chartId || null });
  if (!r.ok) { toast(r.message, "bad"); return; }
  const ro = !can("charts", "edit");
  const item = r.item, ch = r.chart;
  const m = modal(`${item.name} · техкарта`);
  m.root.style.maxWidth = "900px";
  // версии
  if (r.versions.length) {
    const vs = el("select", { onchange: (e) => { m.close(); editChart(code, e.target.value); } },
      ...r.versions.map((v) => el("option", { value: v.id, selected: ch && v.id === ch.id }, `с ${v.date_from}${v.date_to ? " по " + v.date_to : " — действует"}${v.source === "iiko" ? " · iiko" : ""}`)));
    m.root.append(el("div", { class: "tools" }, el("span", { class: "dim" }, "Версия:"), vs));
  }
  const f = {
    date_from: el("input", { type: "date", value: ch ? ch.date_from : new Date().toISOString().slice(0, 10), readonly: ro }),
    date_to: el("input", { type: "date", value: ch && ch.date_to ? ch.date_to : "", readonly: ro }),
    output: el("input", { type: "number", step: "0.001", value: ch ? ch.output_amount : 1, readonly: ro }),
    technology: el("textarea", { readonly: ro }, ch && ch.technology ? ch.technology : ""),
  };
  m.root.append(el("div", { class: "grid2" },
    el("div", {}, el("label", {}, "Действует с"), f.date_from), el("div", {}, el("label", {}, "по (пусто — бессрочно)"), f.date_to),
    el("div", {}, el("label", {}, `Выход, ${item.unit_id}`), f.output),
    el("div", {}, el("label", {}, "Цена продажи"), el("input", { value: fmt(item.price), readonly: true }))),
    el("label", {}, "Технология"), f.technology);
  // строки
  const lines = (ch ? ch.lines : []).map((l) => ({ ...l }));
  const tbl = el("table");
  const totals = el("div", { class: "tot" });
  const warn = el("div", { class: "err" });
  function num(v) { return v === "" || v == null ? 0 : Number(v); }
  function drawLines() {
    tbl.innerHTML = "";
    tbl.append(el("tr", {}, ...["Ингредиент", "Ед.", "Брутто", "Нетто", "Выход", "Потери хол./гор.", "Цена", "Сумма", ""].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    let sum = 0, complete = true;
    const missing = [];
    for (const l of lines) {
      const cold = num(l.brutto) > 0 ? (num(l.brutto) - num(l.netto)) / num(l.brutto) * 100 : 0;
      const hot = num(l.netto) > 0 ? (num(l.netto) - num(l.output)) / num(l.netto) * 100 : 0;
      const lineCost = l.ing_cost != null ? num(l.brutto) * Number(l.ing_cost) : null;
      if (lineCost == null) { complete = false; missing.push(l.name); } else sum += lineCost;
      const inp = (key) => el("input", { type: "number", step: "0.001", value: l[key] ?? "", readonly: ro, style: "text-align:right;padding:6px",
        oninput: (e) => {
          const v = e.target.value; const prev = l[key]; l[key] = v;
          // автоподстановка вниз по цепочке, если поля ещё не правились вручную
          if (key === "brutto" && (l.netto === prev || l.netto === "" || l.netto == null)) l.netto = v;
          if ((key === "brutto" || key === "netto") && (l.output === prev || l.output === "" || l.output == null)) l.output = l.netto;
          drawLines();
        } });
      tbl.append(el("tr", { class: num(l.netto) > num(l.brutto) ? "off" : "" },
        el("td", {}, l.name, l.item_type !== "goods" ? el("span", { class: "tag", style: "margin-left:6px" }, TYPES[l.item_type] || l.item_type) : null),
        el("td", {}, l.unit), el("td", { class: "num" }, inp("brutto")), el("td", { class: "num" }, inp("netto")), el("td", { class: "num" }, inp("output")),
        el("td", { class: "num dim" }, `${cold.toFixed(1)} / ${hot.toFixed(1)} %`),
        el("td", { class: "num" }, l.ing_cost != null ? fmt(l.ing_cost) : el("span", { class: "tag bad" }, "нет")),
        el("td", { class: "num" }, lineCost != null ? fmt(lineCost) : ""),
        el("td", {}, ro ? null : el("button", { class: "x", onclick: () => { lines.splice(lines.indexOf(l), 1); drawLines(); } }, "×"))));
    }
    const out = num(f.output.value) || 0;
    const perUnit = complete && out > 0 ? sum / out : null;
    totals.innerHTML = "";
    totals.append(el("span", {}, complete ? "Себестоимость на выход / за единицу" : "Посчитано частично (нет цен)"),
      el("span", {}, `${fmt(sum)} / ${perUnit != null ? fmt(perUnit) : "—"} ₸` +
        (perUnit != null && item.price ? ` · фудкост ${fmt(perUnit / item.price * 100)} % · наценка ${fmt((item.price - perUnit) / perUnit * 100)} %` : "")));
    warn.textContent = missing.length ? "Нет учётной цены: " + missing.join(", ") + " — задайте её в карточке товара" : "";
    if (lines.some((l) => num(l.netto) > num(l.brutto))) warn.textContent += (warn.textContent ? " · " : "") + "Есть строки, где нетто больше брутто";
  }
  f.output.addEventListener("input", drawLines);
  drawLines();
  m.root.append(el("h2", { style: "margin-top:14px" }, "Состав"), tbl, totals, warn);
  // добавление ингредиента
  if (!ro) {
    const search = el("input", { placeholder: "Добавить ингредиент: начните вводить название" });
    const res = el("div", { class: "sres" });
    search.addEventListener("input", debounce(async () => {
      const q = search.value.trim(); res.innerHTML = "";
      if (q.length < 2) return;
      const s = await api("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).slice(0, 12)) {
        if (it.code === code || lines.some((l) => l.ingredient_code === it.code)) continue;
        res.append(el("button", { class: "sitem", onclick: async () => {
          const c = await api("item_cost_get", { code: it.code });
          lines.push({ ingredient_code: it.code, name: it.name, unit: it.unit_id, item_type: it.item_type, brutto: "", netto: "", output: "", ing_cost: c.ok ? c.cost : null });
          search.value = ""; res.innerHTML = ""; drawLines();
        } }, it.name, el("span", { class: "dim" }, ` · ${it.unit_id} · ${it.item_type === "goods" ? "товар" : TYPES[it.item_type] || it.item_type}`)));
      }
    }, 300));
    m.root.append(el("div", { class: "sbox", style: "margin-top:10px" }, search, res));
  }
  const err = el("div", { class: "err" });
  const actions = el("div", { class: "actions" });
  if (!ro) {
    actions.append(el("button", { onclick: save }, "Сохранить"));
    if (ch) actions.append(el("button", { class: "ghost", onclick: newVersion }, "Новая версия с даты…"));
    if (ch && ch.source === "office") actions.append(el("button", { class: "ghost", onclick: del }, "Удалить версию"));
  }
  actions.append(el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);

  async function save() {
    const p = { id: ch ? ch.id : undefined, code, date_from: f.date_from.value, date_to: f.date_to.value || null,
      output_amount: f.output.value, technology: f.technology.value,
      lines: lines.map((l) => ({ ingredient_code: l.ingredient_code, brutto: num(l.brutto), netto: num(l.netto), output: num(l.output) })) };
    const r2 = await api("chart_save", p);
    if (!r2.ok) { err.textContent = r2.message; return; }
    toast("Сохранено"); m.close(); load();
  }
  async function newVersion() {
    const d = window.prompt("Новая версия действует с даты (ГГГГ-ММ-ДД):", new Date().toISOString().slice(0, 10));
    if (!d) return;
    const r2 = await api("chart_new_version", { code, date_from: d });
    if (!r2.ok) { err.textContent = r2.message; return; }
    toast("Версия создана"); m.close(); editChart(code, r2.id);
  }
  async function del() {
    if (!confirmDlg("Удалить эту версию карты?")) return;
    const r2 = await api("chart_delete", { id: ch.id });
    if (!r2.ok) { err.textContent = r2.message; return; }
    toast("Удалено"); m.close(); load();
  }
}

// ---------- отчёт ----------
let fc = { point_id: "", group_id: "", date: new Date().toISOString().slice(0, 10), sort: "foodcost_pct" };
async function loadReport() {
  const host = document.getElementById("fc-root"); host.innerHTML = "";
  const pts = (await api("stores_list", {})).points || [];   // список точек уже отдаёт stores_list
  const ctl = el("div", { class: "tools" },
    el("select", { onchange: (e) => { fc.point_id = e.target.value; loadReport(); } },
      el("option", { value: "", selected: fc.point_id === "" }, "цена по умолчанию"),
      ...pts.map((p) => el("option", { value: p.id, selected: p.id === fc.point_id }, "цены точки: " + p.name))),
    el("select", { onchange: (e) => { fc.group_id = e.target.value; loadReport(); } },
      el("option", { value: "", selected: fc.group_id === "" }, "все группы"),
      ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === fc.group_id }, g.name))),
    el("input", { type: "date", value: fc.date, onchange: (e) => { fc.date = e.target.value; loadReport(); } }));
  const r = await api("foodcost_report", { point_id: fc.point_id || null, group_id: fc.group_id || null, date: fc.date });
  if (!r.ok) { toast(r.message, "bad"); return; }
  const rows = r.rows.slice().sort((a, b) => (b[fc.sort] ?? -1) - (a[fc.sort] ?? -1));
  const priced = rows.filter((x) => x.cost != null).length;
  const csvBtn = el("button", { class: "ghost", onclick: () => {
    const blob = new Blob(["﻿" + r.csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `foodcost_${fc.date}.csv`; a.click(); URL.revokeObjectURL(a.href);
  } }, "CSV");
  ctl.append(el("span", { class: "dim" }, `позиций ${rows.length}, с себестоимостью ${priced}, порог ${fmt(r.limit)} %`), csvBtn);
  const t = el("table");
  const th = (key, title, cls) => el("th", { class: (cls || "") + " row", onclick: () => { fc.sort = key; loadReport(); } }, title + (fc.sort === key ? " ▼" : ""));
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Группа"), th("cost", "Себестоимость", "num"), th("price", "Цена", "num"), th("markup_pct", "Наценка %", "num"), th("foodcost_pct", "Фудкост %", "num"), el("th", {}, "Нет цены у")));
  for (const x of rows) {
    t.append(el("tr", { class: "row" + (x.over_limit ? "" : ""), onclick: () => editChart(x.code) },
      el("td", {}, x.name), el("td", { class: "dim" }, x.group_name || ""), el("td", { class: "num" }, fmt(x.cost)), el("td", { class: "num" }, fmt(x.price)),
      el("td", { class: "num" }, x.markup_pct != null ? fmt(x.markup_pct) : ""),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok") }, fmt(x.foodcost_pct)) : ""),
      el("td", { class: "dim" }, (x.missing || []).slice(0, 3).join(", ") + ((x.missing || []).length > 3 ? "…" : ""))));
  }
  host.append(ctl, el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}
```

Классы `.sres`, `.sitem`, `.sbox`, `.tot`, `button.x` есть в `index.html`, но не в `office.css` — добавить в `office.css`:
```css
.sbox{position:relative}.sres{margin-top:6px;max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
.sres:empty{display:none}.sitem{display:block;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid var(--line);border-radius:0;padding:9px 12px;color:var(--ink);font-weight:500}
.sitem:last-child{border-bottom:none}
.tot{display:flex;justify-content:space-between;align-items:baseline;padding:10px 14px;background:#EEF2F8;border-radius:8px;margin-top:10px}
.tot span:last-child{font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
button.x{width:30px;padding:4px;background:#fff;color:var(--bad);border-color:var(--line);font-size:16px;line-height:1;font-weight:400}
textarea{width:100%;min-height:70px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--in);color:var(--ink)}
```

- [ ] **Step 3: Проверка в браузере**

`npx --yes serve -l 8077 .` → `http://localhost:8077/office.html`, администратор. Проверить: раздел «Техкарты» в меню; список с картами из iiko, фильтры «без карты» и «без себестоимости», подсветка фудкоста; открыть карту реального блюда (числа совпадают с `chart_get`), переключить версию; создать позицию `ZZ_TEST_пф` (полуфабрикат, кг) в Номенклатуре и `ZZ_TEST_мука2` (товар, кг, учётная цена 100); в Техкартах найти `ZZ_TEST_пф` («нет карты»), открыть, добавить муку 0,5 → нетто и выход подставились, изменить выход строки на 0,45, выход карты 0,45 → итог 111,11; сохранить; «Новая версия с даты» завтра → две версии в списке; «Удалить версию» новой → снова одна; под кладовщиком карточка только для чтения. Открыть `office.html#charts/<код ZZ_TEST_пф>` — редактор открывается сразу. Консоль без ошибок. После проверки — SQL-очистка: `select public.tandem_test_cleanup('<owner_pin>')` → `leftovers 0` (или через прокси `test_cleanup`).

- [ ] **Step 4: Commit**

```bash
git add js/office/charts.js js/office/app.js office.css
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: экран техкарт — список, редактор с потерями и итогами, версии, отчёт фудкоста

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Учётная цена и себестоимость в карточке номенклатуры

**Files:**
- Modify: `js/office/nomenclature.js` (функция `editItem`)

**Interfaces:**
- Consumes: `office_item_get` теперь отдаёт `item.cost_price/cost_date/cost_source` и `cost/partial/missing`; `office_item_save` принимает `cost_price`.

- [ ] **Step 1: Правки**

В `editItem` после поля «Заметка» (`field("note", …)`) добавить в `grid2`:
```js
    item.item_type === "goods" || !code
      ? field("cost_price", "Учётная цена сырья (за " + (item.unit_id || "ед.") + ")", el("input", { type: "number", step: "0.01", value: item.cost_price ?? "", readonly: ro }))
      : null,
```
Ниже, после блока «Цены по точкам» (для существующей позиции), добавить строку себестоимости для блюд и полуфабрикатов и ссылку на карту:
```js
  if (code && (item.item_type === "dish" || item.item_type === "prepared")) {
    const costText = r.cost != null ? `${fmt(r.cost)} ₸ за ${item.unit_id}` : (r.missing && r.missing.length ? `не посчитана — нет цены у: ${r.missing.slice(0, 5).join(", ")}${r.missing.length > 5 ? "…" : ""}` : "не посчитана");
    m.root.append(el("div", { class: "tot" }, el("span", {}, "Себестоимость на сегодня"), el("span", {}, costText)),
      el("div", { style: "margin-top:8px" }, el("a", { class: "link", href: "#charts/" + encodeURIComponent(code), onclick: (e) => { e.preventDefault(); m.close(); location.hash = "#charts/" + encodeURIComponent(code); location.reload(); } }, "Открыть техкарту →")));
  }
```
(здесь `r` — ответ `item_get`, он в области видимости `editItem`; если переменная названа иначе — использовать её.) Если у товара задана учётная цена — под полем показать `dim`-подпись «источник: вручную / накладная iiko / документ, дата …» (`{manual:"вручную", iiko_invoice:"накладная iiko", document:"документ"}`).

В `save()` в объект `p` добавить `cost_price: f.cost_price ? f.cost_price.value : undefined` — **только если поле было показано** (иначе `undefined` и сервер поле не трогает; проверить, что `JSON.stringify` выбрасывает `undefined` — да).

- [ ] **Step 2: Проверка в браузере**

Открыть карточку товара из iiko с ценой из накладной — видна цена и подпись «накладная iiko, дата»; изменить → подпись «вручную»; открыть карточку блюда — строка «Себестоимость на сегодня» и ссылка, переход открывает редактор карты в разделе «Техкарты». Под кладовщиком поле цены `readonly`. Консоль чистая. Тестовых данных не создавать; если создавали — очистка.

- [ ] **Step 3: Commit**

```bash
git add js/office/nomenclature.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: учётная цена сырья и себестоимость в карточке номенклатуры

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Полный прогон, документация, публикация

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-09-05-uchet-charts-design.md`, `office.html` (подпись «сборка 2» и `?v=2` на `office.css`/`app.js`), `js/office/api.js` (`BUILD = 2`) и статические импорты `?v=1` → `?v=2` во всех `js/office/*.js`

- [ ] **Step 1: Версия сборки**

Поднять `BUILD` до 2 и все `?v=1` → `?v=2` (`grep -rn "?v=1" office.html js/office`), подпись на экране входа — «сборка 2». Причина: кэш GitHub Pages 10 минут; модули с новыми контрактами должны перезагрузиться у всех.

- [ ] **Step 2: Полный дымовой прогон**

`TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… node tools/office-smoke.mjs all` → 0 провалов, «очистка: следов нет». Затем SQL: `select (select count(*) from tandem.charts where item_code like 'ZZ\_TEST\_%') + (select count(*) from tandem.items where name like 'ZZ\_TEST\_%') leftovers;` → 0. `admin` и `svetlana` целы.

- [ ] **Step 3: Документация**

README — в раздел бэк-офиса: «Техкарты: раздел `office.html` → Техкарты; перенос из iiko — `node tools/iiko-migrate-charts.mjs` (около часа, в фоне, кэш в `data/iiko/charts`); себестоимость считает `tandem.item_cost`, отчёт — `tandem.menu_foodcost`; порог фудкоста — `settings.foodcost_alert`». Спецификация — раздел «Уточнения при реализации»: три пункта из Global Constraints этого плана плюс фактические числа переноса (карт, строк, доля блюд с себестоимостью, топ ингредиентов без цены). В `docs/superpowers/specs/2026-09-05-uchet-core-deferred.md` отметить закрытые пункты (`unit_id not null`; `iiko-sync-charts` удалён).

- [ ] **Step 4: Регресс точек и commit**

Локально `index.html`: вход Енешкой — плитки, поиск, расход сырья показывается для блюда с картой; отчёт не сохранять. Коммит:
```bash
git add README.md docs/superpowers office.html js/office
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Техкарты: сборка 2, README, уточнения спецификации

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Слияние в `main`, пуш и проверка Pages — контроллер после финального ревью ветки.
