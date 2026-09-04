# Подпроект «Ядро»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Справочники (номенклатура с группами, единицы, склады, контрагенты), пользователи с ролями, бэк-офис `office.html` и перенос данных из iiko — по спецификации `docs/superpowers/specs/2026-09-04-uchet-core-design.md`, раздел 4.

**Architecture:** Данные и логика — в PostgreSQL (Supabase, схема `tandem`), наружу только через SECURITY DEFINER RPC и тонкий Edge-прокси `uchet`. Новая RPC `public.tandem_office(action, payload)` — диспетчер: проверяет сессию и права, вызывает функции разделов `tandem.office_nomenclature / office_stores / office_counteragents / office_users`. Фронт — статический `office.html` с ES-модулями в `js/office/`, без сборщика.

**Tech Stack:** PostgreSQL 15 (plpgsql, pgcrypto для bcrypt), Supabase Edge Function (Deno), ванильный JS (ES-модули), Node 24 для скриптов и дымовых тестов, GitHub Pages.

## Global Constraints

- Вся логика — в SQL-функциях обычного PostgreSQL; из расширений только `pgcrypto`, `uuid-ossp`. Никаких функций, доступных лишь в Supabase (спецификация 3.1а).
- Edge Function `uchet` — тонкий прокси «JSON → RPC» без собственной логики.
- Не использовать Supabase Auth, Storage, Realtime.
- Существующие таблицы точек не пересоздаются: `items` только расширяется; экраны точек не меняют поведения.
- Ключ идемпотентности переноса — `iiko_id`; повторный запуск не дублирует.
- Ошибки RPC бэк-офиса — `{ok:false, error:<код>, message:<текст по-русски>}`; коды: `unauthorized`, `forbidden`, `not_found`, `validation`, `unknown_action`.
- Тестовые сущности — с префиксом `ZZ_TEST_`, после прогона удаляются SQL-ом, удаление проверяется.
- Репозиторий публичный: клиентские данные (выгрузки iiko) в него не попадают — папка `data/` в `.gitignore`.
- Секреты только в переменных окружения: `IIKO_API_KEY`, `IIKO_APP_ID`, `IIKO_CLIENT_SECRET`, `TANDEM_OWNER_PIN`, `TANDEM_ADMIN_PIN`.
- Коммиты: `git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit …`, в конце сообщения строка `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Миграции применяются к проекту Supabase `qeehxcnnuzuwskznhdyg` инструментом `apply_migration` (имя = имя файла без расширения) **и** сохраняются файлом в `db/migrations/` — файл в репозитории есть источник истины для переезда.
- Адрес прокси: `https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet`.

---

## Карта файлов

| Файл | Ответственность |
|------|-----------------|
| `db/migrations/0001_core_schema.sql` | таблицы `units`, `item_groups`, `stores`, `counteragents`, `users`, `sessions`, `role_permissions`; колонки в `items`, `points`; засев единиц, прав, первого администратора |
| `db/migrations/0002_items_for_sale.sql` | фильтр `for_sale` в действии `items` RPC `tandem_api` |
| `db/migrations/0003_migrate_rpc.sql` | `public.tandem_migrate(p_pin, p_kind, p_rows)` |
| `db/migrations/0004_office_auth.sql` | `tandem.err`, `tandem.office_session`, `tandem.office_can`, диспетчер `public.tandem_office` (вход, выход, me, смена PIN, маршрутизация) |
| `db/migrations/0005_office_nomenclature.sql` | `tandem.office_nomenclature(action, payload, user)` |
| `db/migrations/0006_office_stores_counteragents.sql` | `tandem.office_stores`, `tandem.office_counteragents` |
| `db/migrations/0007_office_users.sql` | `tandem.office_users` |
| `supabase/functions/uchet/index.ts` | копия прокси в репозитории + два новых маршрута: `migrate`, `office_*` |
| `tools/iiko-migrate.mjs` | перенос из iiko: живая выгрузка (с кэшем в `data/iiko/`), пачки в `migrate` |
| `tools/office-smoke.mjs` | дымовой тест RPC бэк-офиса по разделам |
| `office.html`, `office.css` | оболочка бэк-офиса |
| `js/office/api.js` | вызов прокси с токеном, хранение сессии |
| `js/office/ui.js` | помощники: `el`, `fmt`, `toast`, `debounce` |
| `js/office/app.js` | вход, смена PIN, меню по правам, загрузка модулей разделов |
| `js/office/nomenclature.js`, `stores.js`, `counteragents.js`, `users.js` | экраны разделов |

Соглашение по действиям RPC (все через прокси, `{action, payload}`):
- `office_login {login, pin}` → `{ok, token, user:{id,login,name,role}, must_change_pin, permissions:[...]}`
- `office_logout {token}`, `office_me {token}`, `office_change_pin {token, pin}`
- `office_groups_list`, `office_group_save {id?, name, parent_id?, active?}`
- `office_items_search {q?, group_id?, item_type?, active?, for_sale?, page?}` → `{ok, rows, total, page, pages}`
- `office_item_get {code}`, `office_item_save {...}`, `office_item_prices_save {code, prices:[{point_id, price}]}`
- `office_stores_list`, `office_store_save {id?, name, point_id?, active?, is_default?}`
- `office_counteragents_list {q?, kind?, page?}`, `office_counteragent_save {...}`
- `office_users_list`, `office_user_save {id?, login, name, role, active?, pin?}`, `office_user_reset_pin {id, pin}`
- `migrate {pin, kind, rows}` — только для скрипта переноса, защита кодом собственника.

Права: разделы `nomenclature | stores | counteragents | users`, действия `view | edit`. Диспетчер сам выводит раздел из имени действия и требуемое право: `*_list`, `*_search`, `*_get` → `view`, остальное → `edit`.

---

### Task 1: Каркас: папки, .gitignore, дымовой тест, прокси в репозитории

**Files:**
- Create: `db/migrations/README.md`, `tools/office-smoke.mjs`, `supabase/functions/uchet/index.ts` (папку `data/` не создавать — она в ignore, её создаёт скрипт переноса)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `tools/office-smoke.mjs` — функция `call(action, payload)` и `check(name, cond, detail)`; разделы `auth | nomenclature | stores | counteragents | users | all` подключаются в следующих задачах.

- [ ] **Step 1: .gitignore и README миграций**

Добавить в `.gitignore` строки:

```
# клиентские данные (кэш выгрузок iiko)
data/
```

Создать `db/migrations/README.md`:

```markdown
# Миграции базы

Файлы применяются по порядку номеров к схеме `tandem` (Supabase, проект qeehxcnnuzuwskznhdyg)
инструментом apply_migration; имя миграции = имя файла без расширения.
Файл в репозитории — источник истины для переезда на собственный сервер:
`psql -f` по порядку восстанавливает всё.
Схема до 0001 создана миграциями в панели Supabase (tandem_init_schema … cash_shift_open_cash_manual).
```

- [ ] **Step 2: Скопировать текущий прокси в репозиторий**

Получить текущий код функции `uchet` (инструмент `get_edge_function`, версия 11) и сохранить его **без изменений** в `supabase/functions/uchet/index.ts`. Маршруты добавятся в задачах 3 и 5.

- [ ] **Step 3: Каркас дымового теста**

Создать `tools/office-smoke.mjs`:

```js
// Дымовой тест RPC бэк-офиса. Запуск: node tools/office-smoke.mjs <auth|nomenclature|stores|counteragents|users|all>
// Переменные окружения: TANDEM_ADMIN_LOGIN (по умолчанию admin), TANDEM_ADMIN_PIN.
// Создаёт сущности с префиксом ZZ_TEST_; удаление — SQL-ом после прогона (см. план).
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const section = process.argv[2] || "all";
let failed = 0, passed = 0;

export async function call(action, payload) {
  const r = await fetch(UCHET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload: payload || {} }),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: "bad_json", message: text.slice(0, 200) }; }
}

export function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  → " + JSON.stringify(detail).slice(0, 300) : "")); }
}

const SECTIONS = {};   // имя → async (ctx) => void; заполняется ниже по задачам
const ctx = { token: null, login: process.env.TANDEM_ADMIN_LOGIN || "admin", pin: process.env.TANDEM_ADMIN_PIN || "" };

// --- разделы добавляются здесь ---

// migrate требует TANDEM_OWNER_PIN и в "all" входит только при его наличии;
// любой раздел кроме auth/migrate сначала прогоняет auth — ему нужен токен.
let names = section === "all"
  ? Object.keys(SECTIONS).filter((n) => n !== "migrate" || process.env.TANDEM_OWNER_PIN)
  : [section];
if (!names.includes("auth") && names.some((n) => n !== "migrate")) names = ["auth", ...names];
for (const n of names) {
  if (!SECTIONS[n]) { console.log("нет раздела " + n); process.exit(2); }
  console.log("\n== " + n);
  await SECTIONS[n](ctx);
}
console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Прогнать каркас**

Run: `node tools/office-smoke.mjs all`
Expected: `пройдено 0, провалено 0`, код выхода 0.

- [ ] **Step 5: Commit**

```bash
git add .gitignore db/migrations/README.md tools/office-smoke.mjs supabase/functions/uchet/index.ts
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: каркас миграций, дымового теста и копия прокси

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Схема справочников и пользователей + фильтр `for_sale` для точек

**Files:**
- Create: `db/migrations/0001_core_schema.sql`, `db/migrations/0002_items_for_sale.sql`

**Interfaces:**
- Produces таблицы (используются всеми следующими задачами):
  - `tandem.units(id text PK, name, precision int, iiko_id uuid unique)`
  - `tandem.item_groups(id uuid PK, parent_id uuid, name, sort_order int, active bool, iiko_id uuid unique)`
  - `tandem.items` + `group_id uuid, unit_id text, item_type text, iiko_id uuid unique, for_sale bool`
  - `tandem.stores(id uuid PK, name, point_id text, organization_id uuid, active bool, sort_order int, iiko_id uuid unique)`
  - `tandem.points` + `default_store_id uuid`
  - `tandem.counteragents(id uuid PK, name, kind text, bin text, phone text, note text, active bool, iiko_id uuid unique)`
  - `tandem.users(id uuid PK, login text unique, name, role, pin_hash, must_change_pin bool, active bool, created_at)`
  - `tandem.sessions(token text PK, user_id uuid, created_at, expires_at)`
  - `tandem.role_permissions(role, section, action)`
  - `tandem.item_code_seq` — последовательность кодов для новых позиций (с 90000).

- [ ] **Step 1: Проверка «до» (должна провалиться)**

Run через `execute_sql`:
```sql
select to_regclass('tandem.units') u, to_regclass('tandem.users') us,
       (select count(*) from information_schema.columns where table_schema='tandem' and table_name='items' and column_name='for_sale') fs;
```
Expected: `u = null, us = null, fs = 0`.

- [ ] **Step 2: Написать миграцию 0001**

`db/migrations/0001_core_schema.sql`:

```sql
-- Ядро: справочники, пользователи, роли.
-- pgcrypto: на Supabase уже стоит в схеме extensions (команда — no-op), на своём сервере встанет в public.
create extension if not exists pgcrypto;

create table if not exists tandem.units (
  id        text primary key,
  name      text not null,
  precision int  not null default 0,
  iiko_id   uuid unique
);
insert into tandem.units (id, name, precision, iiko_id) values
  ('шт',   'штука',     0, 'cd19b5ea-1b32-a6e5-1df7-5d2784a0549a'),
  ('кг',   'килограмм', 3, '7ba81c3a-8de5-8f9d-fb9f-e39efcbc57cc'),
  ('л',    'литр',      3, '69859c74-db72-b006-cba5-326cf6f4fc6e'),
  ('порц', 'порция',    0, '6040d92d-e286-f4f9-a613-ed0e6fd241e1')
on conflict (id) do nothing;

create table if not exists tandem.item_groups (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references tandem.item_groups(id),
  name       text not null,
  sort_order int  not null default 0,
  active     boolean not null default true,
  iiko_id    uuid unique
);

alter table tandem.items
  add column if not exists group_id  uuid references tandem.item_groups(id),
  add column if not exists unit_id   text references tandem.units(id),
  add column if not exists item_type text not null default 'dish',
  add column if not exists iiko_id   uuid unique,
  add column if not exists for_sale  boolean not null default false;
alter table tandem.items drop constraint if exists items_item_type_check;
alter table tandem.items add constraint items_item_type_check
  check (item_type in ('goods','dish','prepared','service'));

-- всё, что уже есть, — продаваемая номенклатура точек
update tandem.items set for_sale = true where for_sale = false;
update tandem.items set unit_id = unit
  where unit_id is null and unit in (select id from tandem.units);
update tandem.items set item_type = case product_type
  when 'GOODS' then 'goods' when 'PREPARED' then 'prepared'
  when 'SERVICE' then 'service' else 'dish' end;

create sequence if not exists tandem.item_code_seq start 90000;

create table if not exists tandem.stores (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  point_id        text references tandem.points(id),
  organization_id uuid,
  active          boolean not null default true,
  sort_order      int not null default 0,
  iiko_id         uuid unique
);
alter table tandem.points
  add column if not exists default_store_id uuid references tandem.stores(id);

create table if not exists tandem.counteragents (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  kind    text not null default 'other' check (kind in ('supplier','customer','employee','other')),
  bin     text,
  phone   text,
  note    text,
  active  boolean not null default true,
  iiko_id uuid unique
);

create table if not exists tandem.users (
  id              uuid primary key default gen_random_uuid(),
  login           text not null unique,
  name            text not null,
  role            text not null check (role in ('admin','owner','accountant','technologist','storekeeper')),
  pin_hash        text not null,
  must_change_pin boolean not null default true,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists tandem.sessions (
  token      text primary key,
  user_id    uuid not null references tandem.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists tandem.role_permissions (
  role    text not null,
  section text not null,
  action  text not null check (action in ('view','edit')),
  primary key (role, section, action)
);
insert into tandem.role_permissions (role, section, action)
select r, s, a from (values
  ('admin','nomenclature','view'),('admin','nomenclature','edit'),
  ('admin','stores','view'),('admin','stores','edit'),
  ('admin','counteragents','view'),('admin','counteragents','edit'),
  ('admin','users','view'),('admin','users','edit'),
  ('owner','nomenclature','view'),('owner','nomenclature','edit'),
  ('owner','stores','view'),('owner','stores','edit'),
  ('owner','counteragents','view'),('owner','counteragents','edit'),
  ('accountant','nomenclature','view'),('accountant','stores','view'),
  ('accountant','counteragents','view'),('accountant','counteragents','edit'),
  ('technologist','nomenclature','view'),('technologist','nomenclature','edit'),
  ('technologist','stores','view'),('technologist','counteragents','view'),
  ('storekeeper','nomenclature','view'),('storekeeper','stores','view'),
  ('storekeeper','counteragents','view')
) v(r, s, a)
on conflict do nothing;

-- первый администратор с временным PIN 0000: сменить при первом входе
insert into tandem.users (login, name, role, pin_hash, must_change_pin)
values ('admin', 'Администратор', 'admin', crypt('0000', gen_salt('bf')), true)
on conflict (login) do nothing;

-- доступ только через RPC: RLS без политик
alter table tandem.units            enable row level security;
alter table tandem.item_groups      enable row level security;
alter table tandem.stores           enable row level security;
alter table tandem.counteragents    enable row level security;
alter table tandem.users            enable row level security;
alter table tandem.sessions         enable row level security;
alter table tandem.role_permissions enable row level security;
```

- [ ] **Step 3: Применить миграцию**

`apply_migration(project_id: qeehxcnnuzuwskznhdyg, name: "0001_core_schema", query: <содержимое файла>)`.

- [ ] **Step 4: Проверка «после»**

Run через `execute_sql`:
```sql
select (select count(*) from tandem.units) units,
       (select count(*) from tandem.role_permissions) perms,
       (select count(*) from tandem.users where login='admin') admin,
       (select count(*) from tandem.items where for_sale) for_sale,
       (select count(*) from tandem.items where unit_id is null) no_unit,
       (select count(*) from tandem.items where item_type='dish') dishes;
```
Expected: `units=4, perms=25, admin=1, for_sale=1645, no_unit=0, dishes≈1354` (все текущие позиции — DISH или PREPARED; ноль без единицы).

- [ ] **Step 5: Фильтр for_sale в действии `items` RPC `tandem_api`**

Получить текущее определение: `select pg_get_functiondef('public.tandem_api(text,jsonb)'::regprocedure);`. В ветке `if action = 'items'` есть условие:

```
        where i.active
          and (
```

Заменить на:

```
        where i.active and i.for_sale
          and (
```

Полученное определение целиком (с `CREATE OR REPLACE FUNCTION …`) сохранить в `db/migrations/0002_items_for_sale.sql` с комментарием в первой строке `-- Экраны точек видят только продаваемую номенклатуру (for_sale).` и применить `apply_migration(name: "0002_items_for_sale")`.

- [ ] **Step 6: Регресс точек**

Run: `node -e "fetch('https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'items',payload:{pin:process.env.TANDEM_POINT_PIN,point_id:'eneshka'}})}).then(r=>r.json()).then(j=>console.log(j.ok, (j.items||[]).length))"` где `TANDEM_POINT_PIN` — код точки Енешка (из `tandem.points`, `select pin from tandem.points where id='eneshka'`).
Expected: `true <то же число, что до миграции>` — число до миграции снять тем же вызовом в Step 1 и записать.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0001_core_schema.sql db/migrations/0002_items_for_sale.sql
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: схема справочников, пользователей и ролей; флаг for_sale для точек

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: RPC переноса `tandem_migrate` и маршрут `migrate` в прокси

**Files:**
- Create: `db/migrations/0003_migrate_rpc.sql`
- Modify: `supabase/functions/uchet/index.ts`, `tools/office-smoke.mjs`

**Interfaces:**
- Produces: `public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb) → jsonb {ok, inserted, updated, skipped}`; kinds и поля строк:
  - `groups`: `{id uuid, name, deleted bool, sort int}`
  - `stores`: `{id uuid, name, organization_id uuid, deleted bool}`
  - `counteragents`: `{id uuid, name, kind, bin, phone, deleted bool}`
  - `items`: `{id uuid, code text, name, artikul, group_id uuid, unit text, type text, deleted bool, price numeric|null}`
- Маршрут прокси: `action: "migrate", payload: {pin, kind, rows}` → `tandem_migrate`.

- [ ] **Step 1: Дымовой тест переноса (проваливается)**

В `tools/office-smoke.mjs` перед строкой `// --- разделы добавляются здесь ---` добавить:

```js
SECTIONS.migrate = async () => {
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const G = "11111111-1111-4111-8111-111111111111";
  const S = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const I = "44444444-4444-4444-8444-444444444444";
  let r = await call("migrate", { pin, kind: "groups", rows: [{ id: G, name: "ZZ_TEST_группа", deleted: false, sort: 1 }] });
  check("groups: вставка", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "groups", rows: [{ id: G, name: "ZZ_TEST_группа2", deleted: true, sort: 1 }] });
  check("groups: повтор обновляет, не дублирует", r.ok && r.updated === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "stores", rows: [{ id: S, name: "ZZ_TEST_склад", organization_id: null, deleted: false }] });
  check("stores: вставка", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "counteragents", rows: [{ id: C, name: "ZZ_TEST_поставщик", kind: "supplier", bin: "123", phone: null, deleted: false }] });
  check("counteragents: вставка", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_мука", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
  check("items: вставка нового", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_мука2", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
  check("items: повтор по iiko_id обновляет", r.ok && r.updated === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin: "wrong", kind: "groups", rows: [] });
  check("чужой код — отказ", r.ok === false, r);
};
```

Run: `TANDEM_OWNER_PIN=… node tools/office-smoke.mjs migrate` (код собственника — из `tandem.settings`, key `owner_pin`).
Expected: все проверки FAIL (прокси не знает `migrate`, `tandem_api` вернёт ошибку).

- [ ] **Step 2: Миграция 0003 — функция переноса**

`db/migrations/0003_migrate_rpc.sql`:

```sql
-- Перенос справочников из iiko. Идемпотентно по iiko_id. Защита — код собственника.
create or replace function public.tandem_migrate(p_pin text, p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_owner text; v_ins int := 0; v_upd int := 0; v_total int;
begin
  select value into v_owner from tandem.settings where key = 'owner_pin';
  if p_pin is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Нет доступа');
  end if;
  v_total := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));

  if p_kind = 'groups' then
    with inc as (
      select (x->>'id')::uuid id, x->>'name' name, coalesce((x->>'deleted')::boolean,false) deleted,
             coalesce((x->>'sort')::int, 0) sort
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
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
      select (x->>'id')::uuid id, x->>'name' name, nullif(x->>'organization_id','')::uuid org,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
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
      select (x->>'id')::uuid id, x->>'name' name,
             case when x->>'kind' in ('supplier','customer','employee') then x->>'kind' else 'other' end kind,
             nullif(x->>'bin','') bin, nullif(x->>'phone','') phone,
             coalesce((x->>'deleted')::boolean,false) deleted
      from jsonb_array_elements(p_rows) x where coalesce(x->>'id','') <> ''
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
    with inc as (
      select (x->>'id')::uuid id, x->>'code' code, x->>'name' name, nullif(x->>'artikul','') artikul,
             nullif(x->>'group_id','')::uuid group_id,
             case when x->>'unit' in ('шт','кг','л','порц') then x->>'unit' else 'шт' end unit,
             case when x->>'type' in ('goods','dish','prepared','service') then x->>'type' else 'dish' end typ,
             coalesce((x->>'deleted')::boolean,false) deleted,
             nullif(x->>'price','')::numeric price
      from jsonb_array_elements(p_rows) x
      where coalesce(x->>'id','') <> '' and coalesce(x->>'code','') <> ''
    ),
    upd_id as (
      update tandem.items i set name = inc.name, artikul = coalesce(inc.artikul, i.artikul),
             group_id = inc.group_id, unit_id = inc.unit, unit = inc.unit, item_type = inc.typ,
             active = not inc.deleted, price = coalesce(inc.price, i.price), synced_at = now()
      from inc where i.iiko_id = inc.id returning 1),
    upd_code as (
      update tandem.items i set iiko_id = inc.id, name = inc.name, artikul = coalesce(inc.artikul, i.artikul),
             group_id = inc.group_id, unit_id = inc.unit, unit = inc.unit, item_type = inc.typ,
             active = not inc.deleted, synced_at = now()
      from inc where i.iiko_id is null and i.iiko_code = inc.code returning 1),
    ins as (
      insert into tandem.items (code, name, artikul, iiko_code, iiko_id, group_id, unit_id, unit, step,
                                item_type, product_type, price, active, for_sale, source, synced_at)
      select inc.code, inc.name, inc.artikul, inc.code, inc.id, inc.group_id, inc.unit, inc.unit,
             case when inc.unit in ('кг','л') then 0.5 else 1 end,
             inc.typ, upper(inc.typ), inc.price, not inc.deleted, false, 'iiko_migrate', now()
      from inc
      where not exists (select 1 from tandem.items i where i.iiko_id = inc.id or i.code = inc.code)
      returning 1)
    select (select count(*) from upd_id) + (select count(*) from upd_code), (select count(*) from ins)
      into v_upd, v_ins;

  else
    return jsonb_build_object('ok', false, 'error', 'validation', 'message', 'Неизвестный вид: ' || coalesce(p_kind,''));
  end if;

  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_total - v_ins - v_upd);
end $$;
revoke all on function public.tandem_migrate(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.tandem_migrate(text,text,jsonb) to service_role;
```

Применить `apply_migration(name: "0003_migrate_rpc")`.

- [ ] **Step 3: Маршрут в прокси**

В `supabase/functions/uchet/index.ts` после блока `if (action === "set_short_list") {…}` добавить:

```ts
    // Перенос справочников из iiko (скрипт tools/iiko-migrate.mjs). Защита — код собственника внутри функции.
    if (action === "migrate") {
      return await proxy("tandem_migrate", { p_pin: pin, p_kind: payload.kind ?? "", p_rows: payload.rows ?? [] });
    }
```

Развернуть: `deploy_edge_function(project_id, name: "uchet", entrypoint_path: "index.ts", verify_jwt: false, files: [{name: "index.ts", content: <файл>}])`. `verify_jwt: false` — как у текущей версии 11 (вход проверяют сами функции).

- [ ] **Step 4: Прогнать тест**

Run: `TANDEM_OWNER_PIN=… node tools/office-smoke.mjs migrate`
Expected: 7 `ok`, 0 FAIL.

- [ ] **Step 5: Убрать тестовые записи и проверить**

`execute_sql`:
```sql
delete from tandem.items where code like 'ZZ_TEST_%';
delete from tandem.item_groups where name like 'ZZ_TEST_%';
delete from tandem.stores where name like 'ZZ_TEST_%';
delete from tandem.counteragents where name like 'ZZ_TEST_%';
select (select count(*) from tandem.items where code like 'ZZ_TEST_%')
     + (select count(*) from tandem.item_groups where name like 'ZZ_TEST_%')
     + (select count(*) from tandem.stores where name like 'ZZ_TEST_%')
     + (select count(*) from tandem.counteragents where name like 'ZZ_TEST_%') as leftovers;
```
Expected: `leftovers = 0`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0003_migrate_rpc.sql supabase/functions/uchet/index.ts tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: RPC переноса справочников из iiko и маршрут migrate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Скрипт переноса из iiko и боевой перенос

**Files:**
- Create: `tools/iiko-migrate.mjs`

**Interfaces:**
- Consumes: маршрут `migrate` (Task 3), карта единиц `tandem.units.iiko_id`.
- Produces: заполненные `item_groups`, `stores`, `counteragents`, расширенные `items`; кэш выгрузки в `data/iiko/*.json` (не в git).

- [ ] **Step 1: Скрипт**

`tools/iiko-migrate.mjs`:

```js
// Перенос справочников iiko → база программы. Чтение из iiko работает; запись туда — нет.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET, TANDEM_OWNER_PIN.
// Запуск: node tools/iiko-migrate.mjs [--dry] [--from-cache]
//   --from-cache — не ходить в iiko, взять data/iiko/*.json из прошлого запуска.
import fs from "node:fs";
const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const CACHE = "data/iiko";
const DRY = process.argv.includes("--dry");
const FROM_CACHE = process.argv.includes("--from-cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function iiko(path, body, token) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(IIKO + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 429) { await sleep(3000); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + t.slice(0, 200));
    return JSON.parse(t);
  }
  throw new Error(path + ": постоянный 429");
}

async function paged(path, key, token) {
  let all = [];
  for (let off = 0; off < 20000; off += 500) {
    const j = await iiko(path, { filters: [], limit: 500, offset: off }, token);
    const chunk = j[key] || [];
    all = all.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1400);
  }
  return all;
}

function cacheGet(name) { return JSON.parse(fs.readFileSync(`${CACHE}/${name}.json`, "utf8")); }
function cachePut(name, data) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(`${CACHE}/${name}.json`, JSON.stringify(data)); }

async function load() {
  if (FROM_CACHE) return { units: cacheGet("units"), groups: cacheGet("groups"), products: cacheGet("products"), stores: cacheGet("stores"), counteragents: cacheGet("counteragents") };
  const auth = await iiko("/api/v2/access_token", { apiKey: process.env.IIKO_API_KEY, appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET });
  const token = auth.token; console.log("токен получен");
  const units = (await iiko("/api/inventory/v1/measure_units/list", { limit: 100, offset: 0 }, token)).entities || [];
  await sleep(1400);
  const groups = await paged("/api/nomenclature/v1/group/list", "groups", token);
  await sleep(1400);
  const products = await paged("/api/nomenclature/v1/product/list", "products", token);
  await sleep(1400);
  const orgs = (await iiko("/api/1/organizations", { returnAdditionalInfo: false, includeDisabled: false }, token)).organizations || [];
  await sleep(1400);
  const stores = (await iiko("/api/inventory/v1/stores/list", { organizationId: orgs[0].id }, token)).stores || [];
  await sleep(1400);
  const ca = await iiko("/api/inventory/v1/counteragents/list", { limit: 5000, offset: 0 }, token);
  const counteragents = ca.counteragents || ca.entities || ca.items || [];
  const data = { units, groups, products, stores, counteragents };
  for (const [k, v] of Object.entries(data)) cachePut(k, v);
  return data;
}

async function send(kind, rows) {
  let ins = 0, upd = 0, skip = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(UCHET, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "migrate", payload: { pin: process.env.TANDEM_OWNER_PIN, kind, rows: rows.slice(i, i + 500) } }),
    }).then((x) => x.json());
    if (!r.ok) throw new Error(kind + " пачка " + (i / 500 + 1) + ": " + (r.message || r.error));
    ins += r.inserted; upd += r.updated; skip += r.skipped;
  }
  console.log(`${kind.padEnd(14)} в файле ${String(rows.length).padStart(5)} | вставлено ${String(ins).padStart(5)} | обновлено ${String(upd).padStart(5)} | пропущено ${skip}`);
  return { ins, upd, skip };
}

const d = await load();
const unitName = Object.fromEntries(d.units.map((u) => [u.id, u.name]));
const typeMap = { GOODS: "goods", DISH: "dish", PREPARED: "prepared", SERVICE: "service" };

const groups = d.groups.map((g, i) => ({ id: g.group, name: g.name, deleted: !!g.deleted, sort: i }));
const stores = d.stores.map((s) => ({ id: s.id, name: s.name, organization_id: s.organizationId || null, deleted: !!s.deleted }));
const counteragents = d.counteragents.map((c) => ({
  id: c.id, name: c.name,
  kind: c.supplier ? "supplier" : c.client ? "customer" : c.employee ? "employee" : "other",
  bin: c.taxpayerIdNumber || null, phone: c.phone || c.cellPhone || null, deleted: !!c.deleted,
}));
// Код позиции у нас — первичный ключ, а в iiko удалённые могут делить код с живыми.
// На один код берём одну запись: живую, а из удалённых — первую; остальные считаем «дубли».
const byCode = new Map();
for (const p of d.products.slice().sort((a, b) => Number(!!a.deleted) - Number(!!b.deleted))) {
  const code = String(p.code);
  if (!byCode.has(code)) byCode.set(code, p);
}
const dupes = d.products.length - byCode.size;
const items = [...byCode.values()].map((p) => ({
  id: p.productId, code: String(p.code), name: p.name, artikul: p.productArticle || "",
  group_id: p.parentGroupId || null, unit: unitName[p.amountUnitId] || "шт",
  type: typeMap[p.type] || "dish", deleted: !!p.deleted,
  price: p.defaultSalePrice ? String(p.defaultSalePrice) : null,
}));

console.log(`к переносу: групп ${groups.length}, складов ${stores.length}, контрагентов ${counteragents.length}, позиций ${items.length} (из них удалённых в iiko ${items.filter((x) => x.deleted).length}; дублей кода отброшено ${dupes})`);
if (DRY) { console.log("--dry: в базу ничего не отправлено"); process.exit(0); }
if (!process.env.TANDEM_OWNER_PIN) throw new Error("TANDEM_OWNER_PIN не задан");

await send("groups", groups);
await send("stores", stores);
await send("counteragents", counteragents);
await send("items", items);
console.log("готово");
```

- [ ] **Step 2: Сухой прогон**

Run: `IIKO_API_KEY=… IIKO_APP_ID=… IIKO_CLIENT_SECRET=… node tools/iiko-migrate.mjs --dry`
Expected: строка «к переносу: групп 114, складов 28, контрагентов 271, позиций 3726 (из них удалённых в iiko 445)» (числа могут отличаться на единицы, если в iiko что-то добавили), файлы появились в `data/iiko/`, `git status` их не показывает.

- [ ] **Step 3: Боевой перенос**

Run: `TANDEM_OWNER_PIN=… node tools/iiko-migrate.mjs --from-cache`
Expected: четыре строки со счётчиками; для `items` — `обновлено ≈ 1639` (старые строки привязались по `iiko_code`), `вставлено ≈ 2080`, `пропущено` — только удалённые позиции, чей код совпал с живым (ожидаем 0–10).

- [ ] **Step 4: Сверка в базе**

`execute_sql`:
```sql
select (select count(*) from tandem.item_groups) groups,
       (select count(*) from tandem.stores) stores,
       (select count(*) from tandem.counteragents) counteragents,
       (select count(*) from tandem.items where iiko_id is not null) items_linked,
       (select count(*) from tandem.items where iiko_id is null) items_unlinked,
       (select count(*) from tandem.items where group_id is null and iiko_id is not null) no_group,
       (select count(*) from tandem.items where unit_id is null) no_unit,
       (select count(*) from tandem.items where for_sale) for_sale,
       (select count(*) from tandem.items where active) active;
```
Expected: `groups=114, stores=28, counteragents=271, items_linked ≈ 3720, items_unlinked ≤ 6` (те 6 старых строк без `iiko_code`), `no_group=0, no_unit=0, for_sale=1645` (не изменилось!), `active ≈ 3281 + старые`.

- [ ] **Step 5: Регресс точек**

Тот же вызов `items` для точки `eneshka`, что в Task 2 Step 6.
Expected: число позиций совпадает с записанным до миграции.

- [ ] **Step 6: Commit**

```bash
git add tools/iiko-migrate.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: скрипт переноса справочников из iiko (с кэшем выгрузки)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Вход, сессии, права — диспетчер `tandem_office`

**Files:**
- Create: `db/migrations/0004_office_auth.sql`
- Modify: `supabase/functions/uchet/index.ts`, `tools/office-smoke.mjs`

**Interfaces:**
- Produces:
  - `tandem.err(p_code text, p_msg text) → jsonb`
  - `tandem.office_session(p_token text) → tandem.users` (пустая строка, если сессии нет)
  - `tandem.office_can(p_role, p_section, p_action) → boolean`
  - `public.tandem_office(action text, payload jsonb) → jsonb` — действия `login`, `logout`, `me`, `change_pin`; остальные маршрутизируются в `tandem.office_<section>(action, payload, v_user)` (созданы в задачах 6–8).
  - Маршрут прокси: `action` с префиксом `office_` → `tandem_office(action без префикса, payload)`.

- [ ] **Step 1: Тест раздела auth (проваливается)**

В `tools/office-smoke.mjs` добавить:

```js
SECTIONS.auth = async (ctx) => {
  let r = await call("office_login", { login: ctx.login, pin: "нет-такого" });
  check("неверный PIN — unauthorized", r.ok === false && r.error === "unauthorized", r);
  r = await call("office_login", { login: ctx.login, pin: ctx.pin });
  check("вход администратора", r.ok && r.token && r.user && r.user.role === "admin", r);
  ctx.token = r.token;
  check("права пришли списком", Array.isArray(r.permissions) && r.permissions.includes("users:edit"), r.permissions);
  r = await call("office_me", { token: ctx.token });
  check("me по токену", r.ok && r.user.login === ctx.login, r);
  r = await call("office_me", { token: "мусор" });
  check("me по чужому токену — unauthorized", r.ok === false && r.error === "unauthorized", r);
  r = await call("office_change_pin", { token: ctx.token, pin: "12" });
  check("короткий PIN — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_change_pin", { token: ctx.token, pin: ctx.pin });
  check("смена PIN на тот же — ok, must_change снят", r.ok && r.must_change_pin === false, r);
  r = await call("office_nonsense", { token: ctx.token });
  check("неизвестное действие", r.ok === false && r.error === "unknown_action", r);
  r = await call("office_logout", { token: ctx.token });
  check("выход", r.ok, r);
  r = await call("office_me", { token: ctx.token });
  check("после выхода токен мёртв", r.ok === false && r.error === "unauthorized", r);
  // и снова входим — токен нужен следующим разделам
  r = await call("office_login", { login: ctx.login, pin: ctx.pin });
  ctx.token = r.token;
};
```

Run: `TANDEM_ADMIN_PIN=0000 node tools/office-smoke.mjs auth`
Expected: FAIL везде (прокси отдаёт `office_login` в `tandem_api`, тот его не знает).

- [ ] **Step 2: Миграция 0004**

`db/migrations/0004_office_auth.sql`:

```sql
-- Бэк-офис: сессии, права, диспетчер.
create or replace function tandem.err(p_code text, p_msg text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'error', p_code, 'message', p_msg)
$$;

create or replace function tandem.office_session(p_token text) returns tandem.users
language sql stable as $$
  select u.* from tandem.sessions s join tandem.users u on u.id = s.user_id
  where s.token = p_token and s.expires_at > now() and u.active
$$;

create or replace function tandem.office_can(p_role text, p_section text, p_action text) returns boolean
language sql stable as $$
  select exists (select 1 from tandem.role_permissions
                 where role = p_role and section = p_section and action = p_action)
$$;

create or replace function tandem.office_user_json(u tandem.users) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', u.id, 'login', u.login, 'name', u.name, 'role', u.role)
$$;

create or replace function tandem.office_permissions(p_role text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(section || ':' || action order by section, action), '[]'::jsonb)
  from tandem.role_permissions where role = p_role
$$;

-- 'extensions' в search_path: на Supabase pgcrypto (crypt, gen_salt, gen_random_bytes) живёт там;
-- на своём сервере такой схемы нет, и Postgres её молча пропускает.
create or replace function public.tandem_office(action text, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_token   text := payload->>'token';
  v_user    tandem.users;
  v_pin     text;
  v_section text;
  v_need    text;
begin
  if action = 'login' then
    v_pin := coalesce(payload->>'pin','');
    select * into v_user from tandem.users
      where login = lower(btrim(coalesce(payload->>'login',''))) and active;
    if v_user.id is null or v_user.pin_hash <> crypt(v_pin, v_user.pin_hash) then
      return tandem.err('unauthorized', 'Неверный логин или PIN');
    end if;
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
    when action like 'group%' or action like 'item%' then 'nomenclature'
    when action like 'store%'        then 'stores'
    when action like 'counteragent%' then 'counteragents'
    when action like 'user%'         then 'users'
  end;
  if v_section is null then
    return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
  end if;
  v_need := case when action like '%\_list' or action like '%\_search' or action like '%\_get'
                 then 'view' else 'edit' end;
  if not tandem.office_can(v_user.role, v_section, v_need) then
    return tandem.err('forbidden', 'Нет прав на это действие');
  end if;

  return case v_section
    when 'nomenclature'  then tandem.office_nomenclature(action, payload, v_user)
    when 'stores'        then tandem.office_stores(action, payload, v_user)
    when 'counteragents' then tandem.office_counteragents(action, payload, v_user)
    when 'users'         then tandem.office_users(action, payload, v_user)
  end;
end $$;
revoke all on function public.tandem_office(text,jsonb) from public, anon, authenticated;
grant execute on function public.tandem_office(text,jsonb) to service_role;
```

Применить `apply_migration(name: "0004_office_auth")`. (Функции разделов ещё не существуют — plpgsql разрешает их при вызове, а не при создании.)

- [ ] **Step 3: Маршрут `office_*` в прокси**

В `supabase/functions/uchet/index.ts` после маршрута `migrate` добавить:

```ts
    // Бэк-офис: свой вход (токен сессии в payload), диспетчер tandem_office.
    if (action.startsWith("office_")) {
      return await proxy("tandem_office", { action: action.slice(7), payload });
    }
```

Развернуть `deploy_edge_function` как в Task 3 Step 3.

- [ ] **Step 4: Прогнать тест**

Run: `TANDEM_ADMIN_PIN=0000 node tools/office-smoke.mjs auth`
Expected: 10 `ok`, 0 FAIL.

- [ ] **Step 5: Сменить временный PIN администратора**

Придумать PIN администратора (не 0000), выполнить: `node -e "…office_login… затем office_change_pin"` — или просто прогнать `TANDEM_ADMIN_PIN=<новый>`? Нет: сначала вход со старым. Выполнить руками:

```bash
node --input-type=module -e "
const U='https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet';
const c=(a,p)=>fetch(U,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:a,payload:p})}).then(r=>r.json());
const l=await c('office_login',{login:'admin',pin:'0000'});
console.log(await c('office_change_pin',{token:l.token,pin:process.env.NEW_PIN}));"
```
с `NEW_PIN` в окружении. Новый PIN передать пользователю вне репозитория; далее тесты запускать с `TANDEM_ADMIN_PIN=<новый>`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0004_office_auth.sql supabase/functions/uchet/index.ts tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: вход в бэк-офис, сессии, права и диспетчер tandem_office

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Раздел «Номенклатура» — RPC

**Files:**
- Create: `db/migrations/0005_office_nomenclature.sql`
- Modify: `tools/office-smoke.mjs`

**Interfaces:**
- Consumes: диспетчер (Task 5), таблицы (Task 2).
- Produces: `tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users) → jsonb`:
  - `groups_list` → `{ok, groups:[{id, parent_id, name, sort_order, active, items_count}]}`
  - `group_save {id?, name, parent_id?, active?}` → `{ok, id}`
  - `items_search {q?, group_id?, item_type?, active?, for_sale?, page?}` → `{ok, rows:[{code,name,artikul,item_type,unit_id,group_id,group_name,active,for_sale,price}], total, page, pages}` — по 200
  - `item_get {code}` → `{ok, item:{…все поля…, note, pack_factor, pack_unit, pack_price}, points:[{point_id, point_name, price, rank, short}]}`
  - `item_save {code?, name, item_type, unit_id, group_id?, artikul?, active?, for_sale?, note?, price?, pack_factor?, pack_unit?, pack_price?}` → `{ok, code}` (без `code` — создаёт, код из `item_code_seq`)
  - `item_prices_save {code, prices:[{point_id, price|null}]}` → `{ok}` (null — убрать цену точки)

- [ ] **Step 1: Тест раздела (проваливается)**

```js
SECTIONS.nomenclature = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_groups_list", { token: t });
  check("группы: список", r.ok && Array.isArray(r.groups) && r.groups.length > 50, r);
  r = await call("office_group_save", { token: t, name: "ZZ_TEST_группа" });
  check("группа: создание", r.ok && r.id, r);
  const gid = r.id;
  r = await call("office_group_save", { token: t, id: gid, name: "ZZ_TEST_группа переим.", active: true });
  check("группа: переименование", r.ok, r);
  r = await call("office_group_save", { token: t, name: "" });
  check("группа: пустое имя — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг", group_id: gid, artikul: "ZZ1" });
  check("позиция: создание, код выдан", r.ok && /^\d+$/.test(r.code), r);
  const code = r.code;
  r = await call("office_items_search", { token: t, q: "ZZ_TEST_мука" });
  check("поиск по имени", r.ok && r.total === 1 && r.rows[0].code === code && r.rows[0].group_name.startsWith("ZZ_TEST"), r);
  r = await call("office_items_search", { token: t, q: "ZZ1" });
  check("поиск по артикулу", r.ok && r.total === 1, r);
  r = await call("office_items_search", { token: t, page: 1 });
  check("страница 200", r.ok && r.rows.length === 200 && r.pages >= 15, { total: r.total, pages: r.pages });
  r = await call("office_item_save", { token: t, code, name: "ZZ_TEST_мука в/с", for_sale: true, price: 350 });
  check("позиция: правка", r.ok, r);
  r = await call("office_item_prices_save", { token: t, code, prices: [{ point_id: "eneshka", price: 400 }] });
  check("цена точки: сохранение", r.ok, r);
  r = await call("office_item_get", { token: t, code });
  const ene = (r.points || []).find((p) => p.point_id === "eneshka");
  check("карточка: имя, цена точки", r.ok && r.item.name === "ZZ_TEST_мука в/с" && ene && Number(ene.price) === 400, r);
  r = await call("office_item_prices_save", { token: t, code, prices: [{ point_id: "eneshka", price: null }] });
  r = await call("office_item_get", { token: t, code });
  check("цена точки: снята", r.ok && (r.points.find((p) => p.point_id === "eneshka").price === null), r.points);
  r = await call("office_item_get", { token: t, code: "нет-такого" });
  check("карточка: not_found", r.ok === false && r.error === "not_found", r);
  r = await call("office_item_save", { token: t, name: "x", item_type: "фигня", unit_id: "кг" });
  check("тип не из списка — validation", r.ok === false && r.error === "validation", r);
};
```

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs nomenclature` (раздел auth прогонится автоматически первым — токен нужен).
Expected: раздел auth — ok; раздел nomenclature — FAIL с ошибкой базы «function tandem.office_nomenclature does not exist».

- [ ] **Step 2: Миграция 0005**

```sql
-- Бэк-офис: номенклатура и группы.
create or replace function tandem.office_nomenclature(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security definer set search_path to 'tandem','public' as $$
declare
  v_id    uuid;
  v_code  text;
  v_q     text := btrim(coalesce(payload->>'q',''));
  v_page  int  := greatest(coalesce((payload->>'page')::int, 1), 1);
  v_total int;
  v_rows  jsonb;
  v_name  text;
begin
  if action = 'groups_list' then
    return jsonb_build_object('ok', true, 'groups', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', g.id, 'parent_id', g.parent_id, 'name', g.name, 'sort_order', g.sort_order,
        'active', g.active, 'items_count', (select count(*) from tandem.items i where i.group_id = g.id and i.active))
        order by g.sort_order, g.name), '[]'::jsonb)
      from tandem.item_groups g));
  end if;

  if action = 'group_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название группы пустое'); end if;
    v_id := nullif(payload->>'id','')::uuid;
    if v_id is null then
      insert into tandem.item_groups (name, parent_id, active)
        values (v_name, nullif(payload->>'parent_id','')::uuid, coalesce((payload->>'active')::boolean, true))
        returning id into v_id;
    else
      update tandem.item_groups set name = v_name,
        parent_id = nullif(payload->>'parent_id','')::uuid,
        active = coalesce((payload->>'active')::boolean, active)
        where id = v_id;
      if not found then return tandem.err('not_found', 'Группа не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'items_search' then
    select count(*) into v_total from tandem.items i
      where (v_q = '' or i.name ilike '%' || v_q || '%' or i.artikul ilike '%' || v_q || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean);
    select coalesce(jsonb_agg(r), '[]'::jsonb) into v_rows from (
      select i.code, i.name, i.artikul, i.item_type, i.unit_id, i.group_id, g.name as group_name,
             i.active, i.for_sale, i.price
      from tandem.items i left join tandem.item_groups g on g.id = i.group_id
      where (v_q = '' or i.name ilike '%' || v_q || '%' or i.artikul ilike '%' || v_q || '%' or i.code = v_q)
        and (nullif(payload->>'group_id','') is null or i.group_id = (payload->>'group_id')::uuid)
        and (nullif(payload->>'item_type','') is null or i.item_type = payload->>'item_type')
        and (payload->>'active' is null or i.active = (payload->>'active')::boolean)
        and (payload->>'for_sale' is null or i.for_sale = (payload->>'for_sale')::boolean)
      order by i.name
      limit 200 offset (v_page - 1) * 200) r;
    return jsonb_build_object('ok', true, 'rows', v_rows, 'total', v_total, 'page', v_page,
                              'pages', greatest(ceil(v_total / 200.0)::int, 1));
  end if;

  if action = 'item_get' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    return jsonb_build_object('ok', true,
      'item', (select jsonb_build_object('code', i.code, 'name', i.name, 'artikul', i.artikul,
                 'item_type', i.item_type, 'unit_id', i.unit_id, 'group_id', i.group_id,
                 'group_name', g.name, 'active', i.active, 'for_sale', i.for_sale, 'price', i.price,
                 'note', i.note, 'pack_factor', i.pack_factor, 'pack_unit', i.pack_unit,
                 'pack_price', i.pack_price, 'has_chart', i.has_chart, 'iiko_code', i.iiko_code)
               from tandem.items i left join tandem.item_groups g on g.id = i.group_id where i.code = v_code),
      'points', (select coalesce(jsonb_agg(jsonb_build_object(
                   'point_id', p.id, 'point_name', p.name, 'price', pp.price,
                   'rank', r.rank, 'short', coalesce(r.in_short_list, false)) order by p.sort_order), '[]'::jsonb)
                 from tandem.points p
                 left join tandem.item_prices pp on pp.point_id = p.id and pp.item_code = v_code
                 left join tandem.item_rank r on r.point_id = p.id and r.item_code = v_code
                 where p.active));
  end if;

  if action = 'item_save' then
    v_name := btrim(coalesce(payload->>'name',''));
    if v_name = '' then return tandem.err('validation', 'Название позиции пустое'); end if;
    if coalesce(payload->>'item_type','') not in ('goods','dish','prepared','service') then
      return tandem.err('validation', 'Тип: goods, dish, prepared или service');
    end if;
    if not exists (select 1 from tandem.units where id = payload->>'unit_id') then
      return tandem.err('validation', 'Единица измерения не из справочника');
    end if;
    v_code := nullif(payload->>'code','');
    if v_code is null then
      v_code := nextval('tandem.item_code_seq')::text;
      insert into tandem.items (code, name, artikul, item_type, unit_id, unit, step, group_id, active,
                                for_sale, note, price, pack_factor, pack_unit, pack_price, category, source)
      values (v_code, v_name, nullif(payload->>'artikul',''), payload->>'item_type', payload->>'unit_id',
              payload->>'unit_id', case when payload->>'unit_id' in ('кг','л') then 0.5 else 1 end,
              nullif(payload->>'group_id','')::uuid, coalesce((payload->>'active')::boolean, true),
              coalesce((payload->>'for_sale')::boolean, false), payload->>'note',
              nullif(payload->>'price','')::numeric, nullif(payload->>'pack_factor','')::numeric,
              nullif(payload->>'pack_unit',''), nullif(payload->>'pack_price','')::numeric,
              (select name from tandem.item_groups where id = nullif(payload->>'group_id','')::uuid), 'office');
    else
      update tandem.items set
        name = v_name, artikul = coalesce(nullif(payload->>'artikul',''), artikul),
        item_type = payload->>'item_type', unit_id = payload->>'unit_id', unit = payload->>'unit_id',
        group_id = coalesce(nullif(payload->>'group_id','')::uuid, group_id),
        active = coalesce((payload->>'active')::boolean, active),
        for_sale = coalesce((payload->>'for_sale')::boolean, for_sale),
        note = coalesce(payload->>'note', note),
        price = coalesce(nullif(payload->>'price','')::numeric, price),
        pack_factor = case when payload ? 'pack_factor' then nullif(payload->>'pack_factor','')::numeric else pack_factor end,
        pack_unit   = case when payload ? 'pack_unit'   then nullif(payload->>'pack_unit','')            else pack_unit end,
        pack_price  = case when payload ? 'pack_price'  then nullif(payload->>'pack_price','')::numeric  else pack_price end
      where code = v_code;
      if not found then return tandem.err('not_found', 'Позиция не найдена'); end if;
    end if;
    return jsonb_build_object('ok', true, 'code', v_code);
  end if;

  if action = 'item_prices_save' then
    v_code := payload->>'code';
    if not exists (select 1 from tandem.items where code = v_code) then
      return tandem.err('not_found', 'Позиция не найдена');
    end if;
    delete from tandem.item_prices pp using jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where pp.item_code = v_code and pp.point_id = x->>'point_id' and nullif(x->>'price','') is null;
    insert into tandem.item_prices (point_id, item_code, price, source)
      select x->>'point_id', v_code, (x->>'price')::numeric, 'office'
      from jsonb_array_elements(coalesce(payload->'prices','[]'::jsonb)) x
      where nullif(x->>'price','') is not null
    on conflict (point_id, item_code) do update set price = excluded.price, source = 'office';
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
```

Перед применением проверить, что у `tandem.item_prices` есть уникальный ключ `(point_id, item_code)`: `select conname from pg_constraint where conrelid='tandem.item_prices'::regclass;`. Если нет — добавить в начало миграции `alter table tandem.item_prices add constraint item_prices_pkey primary key (point_id, item_code);` (перед этим убедиться `select point_id,item_code,count(*) from tandem.item_prices group by 1,2 having count(*)>1` пуст).

Применить `apply_migration(name: "0005_office_nomenclature")`.

- [ ] **Step 3: Прогнать тест**

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: разделы auth и nomenclature — все `ok`.

- [ ] **Step 4: Убрать тестовые записи**

```sql
delete from tandem.item_prices where item_code in (select code from tandem.items where name like 'ZZ_TEST_%');
delete from tandem.items where name like 'ZZ_TEST_%';
delete from tandem.item_groups where name like 'ZZ_TEST_%';
select (select count(*) from tandem.items where name like 'ZZ_TEST_%') + (select count(*) from tandem.item_groups where name like 'ZZ_TEST_%') leftovers;
```
Expected: `leftovers = 0`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0005_office_nomenclature.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: RPC номенклатуры и групп для бэк-офиса

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Разделы «Склады» и «Контрагенты» — RPC

**Files:**
- Create: `db/migrations/0006_office_stores_counteragents.sql`
- Modify: `tools/office-smoke.mjs`

**Interfaces:**
- Produces:
  - `tandem.office_stores(action, payload, v_user)`: `stores_list` → `{ok, stores:[{id,name,point_id,point_name,is_default,active,organization_id}], points:[{id,name}]}`; `store_save {id?, name, point_id?, active?, is_default?}` → `{ok, id}`.
  - `tandem.office_counteragents(action, payload, v_user)`: `counteragents_list {q?, kind?, page?}` → `{ok, rows, total, page, pages}`; `counteragent_save {id?, name, kind, bin?, phone?, note?, active?}` → `{ok, id}`.

- [ ] **Step 1: Тесты (проваливаются)**

```js
SECTIONS.stores = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_stores_list", { token: t });
  check("склады: список с точками", r.ok && r.stores.length >= 27 && Array.isArray(r.points) && r.points.length >= 5, { n: r.stores && r.stores.length });
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад", point_id: "aian", is_default: true });
  check("склад: создание с привязкой и по умолчанию", r.ok && r.id, r);
  const id = r.id;
  r = await call("office_stores_list", { token: t });
  const s = r.stores.find((x) => x.id === id);
  check("склад: виден как по умолчанию у Аяна", s && s.point_id === "aian" && s.is_default === true, s);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: null, is_default: false, active: false });
  check("склад: отвязка и деактивация", r.ok, r);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: "нет-такой" });
  check("склад: чужая точка — validation", r.ok === false && r.error === "validation", r);
};

SECTIONS.counteragents = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_ИП Ромашка", kind: "supplier", bin: "990101300123", phone: "+7 700 000 00 00" });
  check("контрагент: создание", r.ok && r.id, r);
  const id = r.id;
  r = await call("office_counteragents_list", { token: t, q: "Ромашка" });
  check("контрагент: поиск", r.ok && r.total === 1 && r.rows[0].id === id && r.rows[0].kind === "supplier", r);
  r = await call("office_counteragents_list", { token: t, kind: "supplier" });
  check("контрагент: фильтр по виду", r.ok && r.total >= 175, { total: r.total });
  r = await call("office_counteragent_save", { token: t, id, name: "ZZ_TEST_ИП Ромашка", kind: "customer", active: false });
  check("контрагент: правка вида и деактивация", r.ok, r);
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_x", kind: "бред" });
  check("контрагент: вид не из списка — validation", r.ok === false && r.error === "validation", r);
};
```

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: новые разделы FAIL с «function … does not exist».

- [ ] **Step 2: Миграция 0006**

```sql
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
    if coalesce((payload->>'is_default')::boolean, false) and v_point is not null then
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
```

Применить `apply_migration(name: "0006_office_stores_counteragents")`.

- [ ] **Step 3: Прогнать тест**

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: все разделы `ok`.

- [ ] **Step 4: Убрать тестовые записи**

```sql
update tandem.points set default_store_id = null where default_store_id in (select id from tandem.stores where name like 'ZZ_TEST_%');
delete from tandem.stores where name like 'ZZ_TEST_%';
delete from tandem.counteragents where name like 'ZZ_TEST_%';
select (select count(*) from tandem.stores where name like 'ZZ_TEST_%') + (select count(*) from tandem.counteragents where name like 'ZZ_TEST_%') leftovers,
       (select default_store_id from tandem.points where id='aian') aian_default;
```
Expected: `leftovers = 0`, `aian_default = null`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0006_office_stores_counteragents.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: RPC складов и контрагентов для бэк-офиса

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Раздел «Пользователи» — RPC и проверка прав по ролям

**Files:**
- Create: `db/migrations/0007_office_users.sql`
- Modify: `tools/office-smoke.mjs`

**Interfaces:**
- Produces `tandem.office_users(action, payload, v_user)`: `users_list` → `{ok, users:[{id,login,name,role,active,must_change_pin,created_at}], roles:[…]}`; `user_save {id?, login, name, role, active?, pin?}` → `{ok, id}` (pin обязателен при создании); `user_reset_pin {id, pin}` → `{ok}` (ставит `must_change_pin`).

- [ ] **Step 1: Тест (проваливается)**

```js
SECTIONS.users = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_users_list", { token: t });
  check("пользователи: список", r.ok && r.users.some((u) => u.login === "admin") && r.roles.length === 5, r);
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: "4321" });
  check("пользователь: создание", r.ok && r.id, r);
  const uid = r.id;
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "дубль", role: "storekeeper", pin: "4321" });
  check("дубль логина — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_user_save", { token: t, login: "zz_test_x", name: "x", role: "storekeeper" });
  check("без PIN при создании — validation", r.ok === false && r.error === "validation", r);
  // права кладовщика
  r = await call("office_login", { login: "zz_test_sklad", pin: "4321" });
  check("кладовщик входит", r.ok && r.user.role === "storekeeper" && r.must_change_pin === true, r);
  const st = r.token;
  r = await call("office_items_search", { token: st, q: "мука" });
  check("кладовщик видит номенклатуру", r.ok, r);
  r = await call("office_item_save", { token: st, name: "ZZ_TEST_нельзя", item_type: "goods", unit_id: "кг" });
  check("кладовщик не правит номенклатуру — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_users_list", { token: st });
  check("кладовщик не видит пользователей — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_user_reset_pin", { token: t, id: uid, pin: "5555" });
  check("сброс PIN администратором", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  check("вход с новым PIN", r.ok, r);
  r = await call("office_user_save", { token: t, id: uid, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", active: false });
  check("деактивация", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  check("выключенный не входит", r.ok === false && r.error === "unauthorized", r);
};
```

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: раздел users FAIL.

- [ ] **Step 2: Миграция 0007**

```sql
-- Бэк-офис: пользователи.
create or replace function tandem.office_users(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql security definer set search_path to 'tandem','public','extensions' as $$
declare
  v_id uuid; v_login text; v_name text; v_role text; v_pin text;
begin
  if action = 'users_list' then
    return jsonb_build_object('ok', true,
      'users', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'login', login, 'name', name, 'role', role,
                  'active', active, 'must_change_pin', must_change_pin, 'created_at', created_at)
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
      update tandem.users set login = v_login, name = v_name, role = v_role,
        active = coalesce((payload->>'active')::boolean, active) where id = v_id;
      if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
      if not coalesce((payload->>'active')::boolean, true) then
        delete from tandem.sessions where user_id = v_id;
      end if;
    end if;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  if action = 'user_reset_pin' then
    v_id := nullif(payload->>'id','')::uuid;
    v_pin := coalesce(payload->>'pin','');
    if length(v_pin) < 4 or v_pin !~ '^[0-9]+$' then return tandem.err('validation', 'PIN — не меньше 4 цифр'); end if;
    update tandem.users set pin_hash = crypt(v_pin, gen_salt('bf')), must_change_pin = true where id = v_id;
    if not found then return tandem.err('not_found', 'Пользователь не найден'); end if;
    delete from tandem.sessions where user_id = v_id;
    return jsonb_build_object('ok', true);
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;
```

Применить `apply_migration(name: "0007_office_users")`.

- [ ] **Step 3: Прогнать тест**

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: все разделы `ok`, включая три проверки `forbidden`/`unauthorized` кладовщика.

- [ ] **Step 4: Убрать тестовые записи**

```sql
delete from tandem.users where login like 'zz_test_%';
delete from tandem.items where name like 'ZZ_TEST_%';
select (select count(*) from tandem.users where login like 'zz_test_%') + (select count(*) from tandem.items where name like 'ZZ_TEST_%') leftovers;
```
Expected: `leftovers = 0` (сессии удалятся каскадом).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0007_office_users.sql tools/office-smoke.mjs
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Ядро: RPC пользователей; права ролей проверены дымовым тестом

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Оболочка бэк-офиса: `office.html`, вход, меню по правам

**Files:**
- Create: `office.html`, `office.css`, `js/office/api.js`, `js/office/ui.js`, `js/office/app.js`

**Interfaces:**
- Produces:
  - `api.js`: `export const BUILD = 1;` `export async function api(action, payload)` — добавляет `token` из `localStorage['tandem_office']`, при `error === 'unauthorized'` сбрасывает сессию и бросает `Error`; `export function session()` / `setSession(obj|null)` — `{token, user, permissions}`; `export function can(section, action)`.
  - `ui.js`: `export function el(tag, attrs, ...children)`, `export function fmt(n)`, `export function toast(text, kind='ok'|'bad')`, `export function debounce(fn, ms)`, `export function confirmDlg(text) → boolean`.
  - `app.js`: при загрузке — если сессии нет, экран входа; иначе шапка + меню по `permissions` и динамический `import('./<section>.js?v=' + BUILD)` с вызовом `mount(container)`. Модуль раздела экспортирует `export async function mount(root)`.

- [ ] **Step 1: office.html**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1F3864">
<title>Тандем KZ — бэк-офис</title>
<link rel="stylesheet" href="office.css?v=1">
</head>
<body>
<div id="login" class="login" hidden>
  <div class="card">
    <h1>Тандем KZ · бэк-офис</h1>
    <div class="sub">Справочники, склады, контрагенты · сборка 1</div>
    <label for="llogin">Логин</label>
    <input id="llogin" autocomplete="username" autocapitalize="off">
    <label for="lpin">PIN</label>
    <input id="lpin" type="password" inputmode="numeric" autocomplete="current-password">
    <button id="lbtn">Войти</button>
    <div class="err" id="lerr"></div>
  </div>
</div>

<div id="pinchange" class="login" hidden>
  <div class="card">
    <h1>Смените PIN</h1>
    <div class="sub">Временный PIN нужно заменить своим — не меньше 4 цифр.</div>
    <label for="npin">Новый PIN</label>
    <input id="npin" type="password" inputmode="numeric">
    <label for="npin2">Ещё раз</label>
    <input id="npin2" type="password" inputmode="numeric">
    <button id="nbtn">Сохранить</button>
    <div class="err" id="nerr"></div>
  </div>
</div>

<div id="shell" hidden>
  <header class="top">
    <div class="brand">Тандем KZ · бэк-офис</div>
    <nav id="menu"></nav>
    <div class="who"><span id="uname"></span> <span id="urole" class="role"></span>
      <button class="link" id="logout">Выйти</button></div>
  </header>
  <main id="main"></main>
</div>
<div id="toast" class="toast" hidden></div>
<script type="module" src="js/office/app.js?v=1"></script>
</body>
</html>
```

- [ ] **Step 2: office.css**

```css
:root{--ink:#1B2430;--ink2:#4A5568;--muted:#8A94A6;--line:#E2E7EF;--bg:#F5F7FB;--card:#fff;
      --accent:#1F3864;--accent2:#3E6EA8;--ok:#0B6B4F;--okbg:#E3F3EC;--bad:#B4453C;--badbg:#FBEAE8;--in:#FFFBF0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}
h1{font-size:19px;margin:0 0 4px;color:var(--accent)}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 10px;font-weight:700}
.sub{font-size:12.5px;color:var(--muted);margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
label{display:block;font-size:12.5px;color:var(--ink2);margin:10px 0 4px;font-weight:600}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--in);color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent2);outline-offset:-1px;background:#fff}
button{font:inherit;font-weight:600;padding:9px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.ghost{background:#fff;color:var(--accent)}
button.link{background:none;border:none;color:var(--accent2);padding:4px 6px;font-weight:500}
button:disabled{opacity:.5}
.err{color:var(--bad);font-size:13px;margin-top:8px;min-height:18px}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.login .card{width:100%;max-width:380px}
.login button{width:100%;margin-top:14px}
.top{display:flex;align-items:center;gap:18px;padding:10px 18px;background:#fff;border-bottom:2px solid var(--accent);position:sticky;top:0;z-index:5}
.brand{font-weight:700;color:var(--accent);white-space:nowrap}
#menu{display:flex;gap:4px;flex:1;flex-wrap:wrap}
#menu button{background:none;border:none;color:var(--ink2);padding:6px 10px;border-radius:6px;font-weight:600}
#menu button.on{background:#EEF2F8;color:var(--accent)}
.who{font-size:13px;color:var(--ink2);white-space:nowrap}
.role{background:#EEF2F8;color:var(--accent);border-radius:6px;padding:1px 7px;font-size:11.5px;font-weight:700}
main{max-width:1280px;margin:0 auto;padding:16px}
.split{display:grid;grid-template-columns:280px 1fr;gap:14px;align-items:start}
@media (max-width:800px){.split{grid-template-columns:1fr}}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.tools input,.tools select{width:auto;min-width:160px;flex:1}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
tr.row{cursor:pointer}
tr.row:hover{background:#F7F9FD}
tr.off td{color:var(--muted)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;background:#EEF2F8;color:var(--accent);border-radius:6px;padding:1px 7px;font-size:11.5px;font-weight:700}
.tag.ok{background:var(--okbg);color:var(--ok)}
.tag.bad{background:var(--badbg);color:var(--bad)}
.tree button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--ink);padding:6px 8px;border-radius:6px;font-weight:500}
.tree button.on{background:#EEF2F8;color:var(--accent);font-weight:700}
.tree button i{float:right;font-style:normal;color:var(--muted);font-size:12px}
.pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:13px;color:var(--ink2)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.dim{color:var(--muted);font-size:13px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 16px;border-radius:9px;font-size:14px;z-index:10}
.toast.bad{background:var(--bad)}
.overlay{position:fixed;inset:0;background:rgba(27,36,48,.35);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:8;overflow:auto}
.overlay .card{width:100%;max-width:640px}
```

- [ ] **Step 3: js/office/api.js**

```js
// Вызовы бэк-офиса: токен сессии в payload, хранение сессии в localStorage.
export const BUILD = 1;
const API = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const KEY = "tandem_office";
let S = null;

export function session() {
  if (S) return S;
  try { S = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { S = null; }
  return S;
}
export function setSession(s) {
  S = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
}
export function can(section, action) {
  const s = session();
  return !!(s && s.permissions && s.permissions.includes(section + ":" + action));
}

export async function api(action, payload) {
  const body = { action: "office_" + action, payload: { ...(payload || {}) } };
  const s = session();
  if (s && s.token && !body.payload.token) body.payload.token = s.token;
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: "bad_json", message: "Сервер ответил не JSON" }));
  if (!j.ok && j.error === "unauthorized" && action !== "login") {
    setSession(null);
    location.reload();
    throw new Error(j.message || "Сессия истекла");
  }
  return j;
}
```

- [ ] **Step 4: js/office/ui.js**

```js
// Мелкие помощники для экранов бэк-офиса.
export function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
export function fmt(n) {
  if (n === null || n === undefined || n === "") return "";
  return (Math.round(Number(n) * 100) / 100).toLocaleString("ru-RU");
}
let toastTimer = null;
export function toast(text, kind = "ok") {
  const t = document.getElementById("toast");
  t.textContent = text; t.className = "toast " + (kind === "bad" ? "bad" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
export function debounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
export function confirmDlg(text) { return window.confirm(text); }
// Оверлей с карточкой; возвращает {root, close}
export function modal(title) {
  const card = el("div", { class: "card" }, el("h1", {}, title));
  const ov = el("div", { class: "overlay" }, card);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  function close() { ov.remove(); }
  document.body.append(ov);
  return { root: card, close };
}
```

- [ ] **Step 5: js/office/app.js**

```js
import { api, session, setSession, can, BUILD } from "./api.js?v=1";
import { toast } from "./ui.js?v=1";

const SECTIONS = [
  { id: "nomenclature", title: "Номенклатура" },
  { id: "stores", title: "Склады" },
  { id: "counteragents", title: "Контрагенты" },
  { id: "users", title: "Пользователи" },
];
const $ = (id) => document.getElementById(id);
let current = null;

function show(id) {
  for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id;
}

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = r.message || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  start();
}

async function doChangePin() {
  $("nerr").textContent = "";
  if ($("npin").value !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  const r = await api("change_pin", { pin: $("npin").value });
  if (!r.ok) { $("nerr").textContent = r.message; return; }
  setSession({ ...session(), must_change_pin: false });
  start();
}

async function open(id) {
  current = id;
  for (const b of $("menu").children) b.classList.toggle("on", b.dataset.id === id);
  const main = $("main");
  main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=${BUILD}`);
    main.innerHTML = "";
    await mod.mount(main);
  } catch (e) {
    main.innerHTML = "";
    main.append(Object.assign(document.createElement("div"), { className: "err", textContent: "Раздел не открылся: " + e.message }));
  }
  try { localStorage.setItem("tandem_office_section", id); } catch {}
}

function start() {
  const s = session();
  if (!s) { show("login"); $("llogin").focus(); return; }
  if (s.must_change_pin) { show("pinchange"); $("npin").focus(); return; }
  show("shell");
  $("uname").textContent = s.user.name;
  $("urole").textContent = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" }[s.user.role] || s.user.role;
  const menu = $("menu"); menu.innerHTML = "";
  const allowed = SECTIONS.filter((x) => can(x.id, "view"));
  for (const x of allowed) {
    const b = document.createElement("button");
    b.textContent = x.title; b.dataset.id = x.id;
    b.addEventListener("click", () => open(x.id));
    menu.append(b);
  }
  let first = null;
  try { first = localStorage.getItem("tandem_office_section"); } catch {}
  if (!allowed.some((x) => x.id === first)) first = allowed[0] && allowed[0].id;
  if (first) open(first); else $("main").textContent = "У вашей роли нет разделов.";
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("logout").addEventListener("click", async () => { await api("logout", {}); setSession(null); location.reload(); });
// сессия могла протухнуть на сервере — проверяем при старте
(async () => {
  if (session()) {
    const r = await api("me", {});
    if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  }
  start();
})();
```

Обратить внимание: в `api.js` нет `location.reload()` бесконечного цикла — при `unauthorized` сессия сбрасывается до перезагрузки, после перезагрузки `session()` пуст и `me` не вызывается.

Версия сборки против кэша: константа `BUILD` в `api.js` управляет динамическими импортами разделов; статические импорты (`./api.js?v=1`, `./ui.js?v=1`) и подключения в `office.html` (`office.css?v=1`, `app.js?v=1`) переменную принять не могут — при новой сборке поднимать число во всех местах поиском по `?v=` и в `BUILD`, а также в подписи «сборка N» на экране входа.

- [ ] **Step 6: Проверка в браузере**

Открыть `office.html` локально через простой статический сервер (модули не грузятся с `file://`): `npx --yes serve -l 8077 .` и в браузере `http://localhost:8077/office.html`. Проверить: вход с неверным PIN даёт текст ошибки; вход администратора открывает оболочку с четырьмя пунктами меню; в `main` появляется «Раздел не открылся» (модулей ещё нет) — это ожидаемо; «Выйти» возвращает на вход; перезагрузка страницы сохраняет вход.
Expected: всё перечисленное; в консоли нет ошибок кроме 404 на `nomenclature.js`.

- [ ] **Step 7: Commit**

```bash
git add office.html office.css js/office/api.js js/office/ui.js js/office/app.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: оболочка, вход, смена PIN, меню по правам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Экран «Номенклатура»

**Files:**
- Create: `js/office/nomenclature.js`

**Interfaces:**
- Consumes: `api`, `can` из `api.js`; `el`, `fmt`, `toast`, `debounce`, `modal` из `ui.js`; RPC из Task 6.
- Produces: `export async function mount(root)`.

- [ ] **Step 1: Модуль**

```js
import { api, can } from "./api.js?v=1";
import { el, fmt, toast, debounce, modal } from "./ui.js?v=1";

const TYPES = { goods: "товар", dish: "блюдо", prepared: "полуфабрикат", service: "услуга" };
let groups = [], state = { q: "", group_id: "", item_type: "", active: "true", page: 1 };
let tree, table, pager, root;

export async function mount(r) {
  root = r;
  const g = await api("groups_list", {});
  groups = g.groups || [];
  tree = el("div", { class: "card tree" });
  const tools = el("div", { class: "tools" },
    el("input", { placeholder: "Поиск: название, артикул, код", value: state.q,
      oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
    select({ "": "все типы", ...TYPES }, state.item_type, (v) => { state.item_type = v; state.page = 1; load(); }),
    select({ "true": "активные", "false": "выключенные", "": "все" }, state.active, (v) => { state.active = v; state.page = 1; load(); }),
    can("nomenclature", "edit") ? el("button", { onclick: () => editItem(null) }, "+ Позиция") : null,
  );
  table = el("table");
  pager = el("div", { class: "pager" });
  root.append(el("div", { class: "split" }, tree, el("div", {}, tools, el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager)));
  drawTree();
  await load();
}

function select(opts, value, onchange) {
  const s = el("select", { onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

function drawTree() {
  tree.innerHTML = "";
  tree.append(el("h2", {}, "Группы"),
    el("button", { class: state.group_id === "" ? "on" : "", onclick: () => pick("") }, "Все позиции"));
  const kids = (pid) => groups.filter((g) => (g.parent_id || null) === pid && g.active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  const walk = (pid, depth) => {
    for (const g of kids(pid)) {
      tree.append(el("button", { class: state.group_id === g.id ? "on" : "", style: `padding-left:${8 + depth * 14}px`, onclick: () => pick(g.id) },
        g.name, el("i", {}, g.items_count)));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  if (can("nomenclature", "edit")) tree.append(el("button", { class: "link", onclick: () => editGroup(null) }, "+ Группа"),
    state.group_id ? el("button", { class: "link", onclick: () => editGroup(groups.find((g) => g.id === state.group_id)) }, "Переименовать / переместить") : null);
}

function pick(id) { state.group_id = id; state.page = 1; drawTree(); load(); }

async function load() {
  const p = { q: state.q, group_id: state.group_id || null, item_type: state.item_type || null, page: state.page };
  if (state.active !== "") p.active = state.active === "true";
  const r = await api("items_search", p);
  if (!r.ok) { toast(r.message, "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Код", "Название", "Артикул", "Тип", "Ед.", "Группа", "Цена", ""].map((h, i) => el("th", { class: i === 6 ? "num" : "" }, h))));
  for (const it of r.rows) {
    table.append(el("tr", { class: "row" + (it.active ? "" : " off"), onclick: () => editItem(it.code) },
      el("td", {}, it.code), el("td", {}, it.name), el("td", {}, it.artikul || ""), el("td", {}, TYPES[it.item_type] || it.item_type),
      el("td", {}, it.unit_id || ""), el("td", { class: "dim" }, it.group_name || "—"), el("td", { class: "num" }, fmt(it.price)),
      el("td", {}, it.for_sale ? el("span", { class: "tag ok" }, "продаётся") : null)));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 8, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

async function editItem(code) {
  let item = { item_type: "dish", unit_id: "шт", group_id: state.group_id || "", active: true, for_sale: false }, points = [];
  if (code) {
    const r = await api("item_get", { code });
    if (!r.ok) { toast(r.message, "bad"); return; }
    item = r.item; points = r.points;
  }
  const ro = !can("nomenclature", "edit");
  const m = modal(code ? `Позиция ${code}` : "Новая позиция");
  const f = {};
  const field = (key, label, node) => { f[key] = node; return el("div", {}, el("label", {}, label), node); };
  const groupSel = el("select", { disabled: ro }, el("option", { value: "" }, "— без группы —"),
    ...groups.map((g) => el("option", { value: g.id, selected: g.id === item.group_id }, g.name)));
  m.root.append(el("div", { class: "grid2" },
    field("name", "Название", el("input", { value: item.name || "", readonly: ro })),
    field("artikul", "Артикул", el("input", { value: item.artikul || "", readonly: ro })),
    field("item_type", "Тип", select(TYPES, item.item_type, () => {})),
    field("unit_id", "Единица", select({ "шт": "шт", "кг": "кг", "л": "л", "порц": "порц" }, item.unit_id, () => {})),
    field("group_id", "Группа", groupSel),
    field("price", "Цена по умолчанию", el("input", { type: "number", step: "0.01", value: item.price ?? "", readonly: ro })),
    field("pack_factor", "Фасовка: множитель", el("input", { type: "number", step: "0.001", value: item.pack_factor ?? "", readonly: ro })),
    field("pack_unit", "Фасовка: единица", el("input", { value: item.pack_unit || "", readonly: ro })),
    field("pack_price", "Фасовка: цена", el("input", { type: "number", step: "0.01", value: item.pack_price ?? "", readonly: ro })),
    field("note", "Заметка", el("input", { value: item.note || "", readonly: ro })),
  ));
  f.active = el("input", { type: "checkbox", checked: item.active, disabled: ro });
  f.for_sale = el("input", { type: "checkbox", checked: item.for_sale, disabled: ro });
  m.root.append(el("div", { class: "actions" }, el("label", {}, f.active, " активна"), el("label", {}, f.for_sale, " продаётся на точках")));
  if (code) {
    const pt = el("table");
    pt.append(el("tr", {}, el("th", {}, "Точка"), el("th", { class: "num" }, "Цена точки"), el("th", {}, "Короткий лист"), el("th", { class: "num" }, "Ранг")));
    const priceInputs = {};
    for (const p of points) {
      priceInputs[p.point_id] = el("input", { type: "number", step: "0.01", value: p.price ?? "", readonly: ro, style: "text-align:right" });
      pt.append(el("tr", {}, el("td", {}, p.point_name), el("td", { class: "num" }, priceInputs[p.point_id]),
        el("td", {}, p.short ? el("span", { class: "tag" }, "да") : ""), el("td", { class: "num" }, p.rank ?? "")));
    }
    m.root.append(el("h2", { style: "margin-top:16px" }, "Цены по точкам"), pt);
    f._prices = priceInputs;
  }
  const err = el("div", { class: "err" });
  m.root.append(err, el("div", { class: "actions" },
    ro ? null : el("button", { onclick: save }, "Сохранить"),
    el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
  async function save() {
    const p = { code: code || undefined, name: f.name.value, artikul: f.artikul.value, item_type: f.item_type.value, unit_id: f.unit_id.value,
      group_id: f.group_id.value || null, price: f.price.value, pack_factor: f.pack_factor.value, pack_unit: f.pack_unit.value,
      pack_price: f.pack_price.value, note: f.note.value, active: f.active.checked, for_sale: f.for_sale.checked };
    const r = await api("item_save", p);
    if (!r.ok) { err.textContent = r.message; return; }
    if (f._prices) {
      const prices = Object.entries(f._prices).map(([point_id, inp]) => ({ point_id, price: inp.value === "" ? null : Number(inp.value) }));
      const r2 = await api("item_prices_save", { code: r.code, prices });
      if (!r2.ok) { err.textContent = r2.message; return; }
    }
    toast("Сохранено"); m.close();
    const g = await api("groups_list", {}); groups = g.groups || []; drawTree(); load();
  }
}

async function editGroup(g) {
  const m = modal(g ? "Группа" : "Новая группа");
  const name = el("input", { value: g ? g.name : "" });
  const parent = el("select", {}, el("option", { value: "" }, "— верхний уровень —"),
    ...groups.filter((x) => !g || x.id !== g.id).map((x) => el("option", { value: x.id, selected: g && x.id === g.parent_id }, x.name)));
  const active = el("input", { type: "checkbox", checked: g ? g.active : true });
  const err = el("div", { class: "err" });
  m.root.append(el("label", {}, "Название"), name, el("label", {}, "Родитель"), parent,
    el("div", { class: "actions" }, el("label", {}, active, " активна")), err,
    el("div", { class: "actions" }, el("button", { onclick: async () => {
      const r = await api("group_save", { id: g ? g.id : undefined, name: name.value, parent_id: parent.value || null, active: active.checked });
      if (!r.ok) { err.textContent = r.message; return; }
      toast("Сохранено"); m.close();
      const gl = await api("groups_list", {}); groups = gl.groups || []; drawTree(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  name.focus();
}
```

- [ ] **Step 2: Проверка в браузере**

`http://localhost:8077/office.html` → Номенклатура. Проверить: дерево групп со счётчиками, клик по группе фильтрует, поиск «мука» находит сырьё (после переноса), «+ Позиция» создаёт `ZZ_TEST_проверка` (тип товар, кг), она находится поиском, карточка открывается, цена точки Енешка сохраняется и видна после повторного открытия, чекбокс «продаётся» выключен по умолчанию у сырья. Под пользователем-кладовщиком (создать в Task 12 или SQL-ом заранее) — карточка только для чтения, кнопок «+ Позиция» нет.
Expected: всё работает; консоль без ошибок.

- [ ] **Step 3: Убрать тестовую позицию**

```sql
delete from tandem.item_prices where item_code in (select code from tandem.items where name like 'ZZ_TEST_%');
delete from tandem.items where name like 'ZZ_TEST_%';
```

- [ ] **Step 4: Commit**

```bash
git add js/office/nomenclature.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: экран номенклатуры — дерево групп, поиск, карточка, цены по точкам

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Экраны «Склады» и «Контрагенты»

**Files:**
- Create: `js/office/stores.js`, `js/office/counteragents.js`

**Interfaces:**
- Consumes: RPC из Task 7; `api`, `can`, `el`, `toast`, `debounce`, `modal`.
- Produces: `mount(root)` в каждом модуле.

- [ ] **Step 1: stores.js**

```js
import { api, can } from "./api.js?v=1";
import { el, toast, modal } from "./ui.js?v=1";

let root, data;
export async function mount(r) { root = r; await load(); }

async function load() {
  data = await api("stores_list", {});
  if (!data.ok) { toast(data.message, "bad"); return; }
  root.innerHTML = "";
  const t = el("table");
  t.append(el("tr", {}, ...["Склад", "Точка", "По умолчанию", "Статус"].map((h) => el("th", {}, h))));
  for (const s of data.stores) {
    t.append(el("tr", { class: "row" + (s.active ? "" : " off"), onclick: () => edit(s) },
      el("td", {}, s.name), el("td", {}, s.point_name || el("span", { class: "dim" }, "без точки")),
      el("td", {}, s.is_default ? el("span", { class: "tag ok" }, "да") : ""),
      el("td", {}, s.active ? "" : el("span", { class: "tag bad" }, "выключен"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, `${data.stores.length} складов`),
      can("stores", "edit") ? el("button", { onclick: () => edit(null) }, "+ Склад") : null),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

function edit(s) {
  const ro = !can("stores", "edit");
  const m = modal(s ? s.name : "Новый склад");
  const name = el("input", { value: s ? s.name : "", readonly: ro });
  const point = el("select", { disabled: ro }, el("option", { value: "" }, "— без точки —"),
    ...data.points.map((p) => el("option", { value: p.id, selected: s && p.id === s.point_id }, p.name)));
  const def = el("input", { type: "checkbox", checked: s ? s.is_default : false, disabled: ro });
  const active = el("input", { type: "checkbox", checked: s ? s.active : true, disabled: ro });
  const err = el("div", { class: "err" });
  m.root.append(el("label", {}, "Название"), name, el("label", {}, "Точка"), point,
    el("div", { class: "actions" }, el("label", {}, def, " склад точки по умолчанию"), el("label", {}, active, " активен")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async () => {
        const r = await api("store_save", { id: s ? s.id : undefined, name: name.value, point_id: point.value || null, is_default: def.checked, active: active.checked });
        if (!r.ok) { err.textContent = r.message; return; }
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
}
```

- [ ] **Step 2: counteragents.js**

```js
import { api, can } from "./api.js?v=1";
import { el, toast, debounce, modal } from "./ui.js?v=1";

const KINDS = { supplier: "поставщик", customer: "покупатель", employee: "сотрудник", other: "прочее" };
let root, state = { q: "", kind: "", page: 1 }, table, pager;

export async function mount(r) {
  root = r;
  const kindSel = el("select", { onchange: (e) => { state.kind = e.target.value; state.page = 1; load(); } },
    el("option", { value: "" }, "все виды"), ...Object.entries(KINDS).map(([v, t]) => el("option", { value: v }, t)));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Поиск: название или БИН", oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
      kindSel, can("counteragents", "edit") ? el("button", { onclick: () => edit(null) }, "+ Контрагент") : null),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
  await load();
}

async function load() {
  const r = await api("counteragents_list", { q: state.q, kind: state.kind || null, page: state.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Название", "Вид", "БИН/ИИН", "Телефон", ""].map((h) => el("th", {}, h))));
  for (const c of r.rows) {
    table.append(el("tr", { class: "row" + (c.active ? "" : " off"), onclick: () => edit(c) },
      el("td", {}, c.name), el("td", {}, KINDS[c.kind] || c.kind), el("td", {}, c.bin || ""), el("td", {}, c.phone || ""),
      el("td", {}, c.active ? "" : el("span", { class: "tag bad" }, "выключен"))));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 5, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

function edit(c) {
  const ro = !can("counteragents", "edit");
  const m = modal(c ? c.name : "Новый контрагент");
  const f = {
    name: el("input", { value: c ? c.name : "", readonly: ro }),
    kind: el("select", { disabled: ro }, ...Object.entries(KINDS).map(([v, t]) => el("option", { value: v, selected: c ? c.kind === v : v === "supplier" }, t))),
    bin: el("input", { value: c ? c.bin || "" : "", readonly: ro }),
    phone: el("input", { value: c ? c.phone || "" : "", readonly: ro }),
    note: el("input", { value: c ? c.note || "" : "", readonly: ro }),
    active: el("input", { type: "checkbox", checked: c ? c.active : true, disabled: ro }),
  };
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Название"), f.name), el("div", {}, el("label", {}, "Вид"), f.kind),
      el("div", {}, el("label", {}, "БИН/ИИН"), f.bin), el("div", {}, el("label", {}, "Телефон"), f.phone)),
    el("label", {}, "Заметка"), f.note,
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async () => {
        const r = await api("counteragent_save", { id: c ? c.id : undefined, name: f.name.value, kind: f.kind.value, bin: f.bin.value, phone: f.phone.value, note: f.note.value, active: f.active.checked });
        if (!r.ok) { err.textContent = r.message; return; }
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
}
```

- [ ] **Step 3: Проверка в браузере**

Склады: 28 строк, все «без точки»; привязать «Магазин кухни» к Енешке и поставить «по умолчанию» → в таблице тег «да»; создать `ZZ_TEST_склад`, выключить — уходит в конец серым. Контрагенты: поиск «Ромашка» пуст, «+ Контрагент» создаёт `ZZ_TEST_ИП Ромашка`, фильтр «поставщик» показывает ≥175. Под бухгалтером (роль accountant): контрагентов правит, склады — только просмотр.
Expected: всё перечисленное, консоль без ошибок. Привязку «Магазин кухни → Енешка» оставить: это рабочая настройка, не тест.

- [ ] **Step 4: Убрать тестовые записи**

```sql
update tandem.points set default_store_id = null where default_store_id in (select id from tandem.stores where name like 'ZZ_TEST_%');
delete from tandem.stores where name like 'ZZ_TEST_%';
delete from tandem.counteragents where name like 'ZZ_TEST_%';
```

- [ ] **Step 5: Commit**

```bash
git add js/office/stores.js js/office/counteragents.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: экраны складов и контрагентов

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Экран «Пользователи»

**Files:**
- Create: `js/office/users.js`

- [ ] **Step 1: Модуль**

```js
import { api } from "./api.js?v=1";
import { el, toast, modal } from "./ui.js?v=1";

const ROLES = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" };
let root;
export async function mount(r) { root = r; await load(); }

async function load() {
  const d = await api("users_list", {});
  if (!d.ok) { toast(d.message, "bad"); return; }
  root.innerHTML = "";
  const t = el("table");
  t.append(el("tr", {}, ...["Логин", "Имя", "Роль", "Статус", ""].map((h) => el("th", {}, h))));
  for (const u of d.users) {
    t.append(el("tr", { class: "row" + (u.active ? "" : " off"), onclick: () => edit(u) },
      el("td", {}, u.login), el("td", {}, u.name), el("td", {}, ROLES[u.role] || u.role),
      el("td", {}, u.active ? (u.must_change_pin ? el("span", { class: "tag" }, "временный PIN") : "") : el("span", { class: "tag bad" }, "выключен")),
      el("td", {}, el("button", { class: "link", onclick: (e) => { e.stopPropagation(); resetPin(u); } }, "сбросить PIN"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, "Один пользователь — одна роль. Кому нужно больше — администратор."),
      el("button", { onclick: () => edit(null) }, "+ Пользователь")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

function edit(u) {
  const m = modal(u ? u.name : "Новый пользователь");
  const f = {
    login: el("input", { value: u ? u.login : "", autocapitalize: "off" }),
    name: el("input", { value: u ? u.name : "" }),
    role: el("select", {}, ...Object.entries(ROLES).map(([v, t]) => el("option", { value: v, selected: u ? u.role === v : v === "storekeeper" }, t))),
    pin: el("input", { type: "password", inputmode: "numeric", placeholder: "не меньше 4 цифр" }),
    active: el("input", { type: "checkbox", checked: u ? u.active : true }),
  };
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Логин"), f.login), el("div", {}, el("label", {}, "Имя"), f.name),
      el("div", {}, el("label", {}, "Роль"), f.role), u ? null : el("div", {}, el("label", {}, "Временный PIN"), f.pin)),
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" }, el("button", { onclick: async () => {
      const r = await api("user_save", { id: u ? u.id : undefined, login: f.login.value, name: f.name.value, role: f.role.value, active: f.active.checked, pin: u ? undefined : f.pin.value });
      if (!r.ok) { err.textContent = r.message; return; }
      toast("Сохранено"); m.close(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  f.login.focus();
}

async function resetPin(u) {
  const pin = window.prompt(`Новый временный PIN для ${u.name} (не меньше 4 цифр):`);
  if (!pin) return;
  const r = await api("user_reset_pin", { id: u.id, pin });
  if (!r.ok) { toast(r.message, "bad"); return; }
  toast("PIN сброшен, при входе попросит сменить"); load();
}
```

- [ ] **Step 2: Проверка в браузере**

Под администратором: раздел виден; создать `zz_test_buh` (бухгалтер, PIN 1234); в новом приватном окне войти им — просит сменить PIN, после смены видны Номенклатура/Склады/Контрагенты, Пользователей нет; вернуться администратором, сбросить PIN — тег «временный PIN»; выключить — серый; попытка выключить самого себя даёт текст ошибки.
Expected: всё перечисленное.

- [ ] **Step 3: Убрать тестового пользователя**

```sql
delete from tandem.users where login like 'zz_test_%';
```

- [ ] **Step 4: Commit**

```bash
git add js/office/users.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: экран пользователей

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Публикация, регресс точек, README, заведение первых пользователей

**Files:**
- Modify: `README.md`, `index.html` (только ссылка на бэк-офис в подвале экрана входа — по желанию собственницы; ссылку добавляем: `<a class="link" href="office.html">Бэк-офис</a>` под кнопкой входа собственника)

- [ ] **Step 1: Полный дымовой прогон и чистота базы**

Run: `TANDEM_ADMIN_PIN=… node tools/office-smoke.mjs all`
Expected: 0 FAIL. Затем SQL-очистка из задач 3, 6, 7, 8 одним блоком и проверка `leftovers = 0` по всем четырём таблицам и пользователям.

- [ ] **Step 2: README**

Добавить в `README.md` раздел:

```markdown
## Бэк-офис (`office.html`)

Справочники: номенклатура с группами, склады, контрагенты, пользователи. Вход — логин и PIN,
роли: администратор, собственник, бухгалтер, технолог, кладовщик (права — таблица
`tandem.role_permissions`). Логика — RPC `tandem_office` (диспетчер) и функции
`tandem.office_*`; файлы миграций — `db/migrations/`. Дымовой тест: `node tools/office-smoke.mjs all`
(нужен `TANDEM_ADMIN_PIN`). Перенос справочников из iiko: `node tools/iiko-migrate.mjs`
(см. шапку скрипта). Спецификация и план — `docs/superpowers/`.
```

- [ ] **Step 3: Push и проверка на Pages**

```bash
git add README.md index.html
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Бэк-офис: ссылка со входа, README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```
Через 2 минуты: `https://umgroupkz-commits.github.io/tandem-uchet/office.html` — вход администратора, четыре раздела открываются. `curl -sI https://umgroupkz-commits.github.io/tandem-uchet/js/office/app.js | head -3` → `200`.
Expected: работает с боевого адреса.

- [ ] **Step 4: Регресс экранов точек**

На `index.html` войти точкой Енешка (код из `tandem.points`), убедиться: плитки частых позиций, поиск «манты», добавление строки, сумма; сырьё («мука», «масло») в поиске точки **не** появляется. Собственница: сводка открывается. Тестовых отчётов не сохранять.
Expected: поведение как до подпроекта.

- [ ] **Step 5: Завести реальных пользователей**

По списку от Светланы (имена и роли она даёт; если списка нет — завести только `svetlana` с ролью `owner` и временным PIN, который сообщить ей лично). Временные PIN не записывать в репозиторий, чат и память.

- [ ] **Step 6: Отчёт о закрытии подпроекта**

Проверить критерии готовности из спецификации (4.8): перенос сверен по счётчикам (Task 4 Step 4), четыре роли входят и видят только своё (Task 8, Task 12), справочники ведутся без iiko (Tasks 10–12), экраны точек не изменились (Step 4). Составить короткое сообщение пользователю: что проверено, что нет, какие данные остались «без точки» (склады), и предложить спецификацию подпроекта 2 «Техкарты и себестоимость».
