# Бот приёма заказов Енешки — часть A: заказы клиентов в учёте

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** учёт Тандема умеет «Меню заказов» со своей ценой и сверкой, заказ клиента со статусами
и журналом, служебные действия для бота, вкладку «Заказы» на планшете кассы, раздел бэк-офиса
и колонку «Клиенты» в плане кухни.

**Architecture:** три миграции (`0049` меню, `0050` заказы и статусы, `0051` кухня) поверх схемы
`tandem`. Правки существующих функций (`tandem_gate`, `tandem_office`, `tandem_api`,
`tandem_test_cleanup`) — DO-блоком: `pg_get_functiondef` → `replace` по якорю → проверка, что якорь
нашёлся → `execute`. Новые функции — целиком. Экраны — модули ES без сборки, как весь проект.

**Tech Stack:** PostgreSQL 17 (Supabase сейчас, свой сервер `server/` потом), plpgsql, ванильный JS
(ES-модули), дымовой тест `tools/office-smoke.mjs` (Node 20, `fetch`), снимок схемы
`db/schema/tandem_full.sql`.

**Спецификация:** `docs/superpowers/specs/2026-10-16-eneshka-order-bot-design.md`.
**Часть B** (бот, сервер) — `docs/superpowers/plans/2026-10-16-eneshka-order-bot-b-bot.md`;
она опирается на действия `bot_*` из этой части.

## Global Constraints

- Бот видит позицию меню только с отметкой «цена сверена»; изменение цены снимает отметку.
- Цена и сумма заказа считаются в базе (`tandem.corder_check`), присланной цене не верим.
- Статусы и переходы — только по таблице `tandem.client_order_moves`; запретный переход — ошибка `conflict`, а не тихий пропуск.
- Причина обязательна у `rejected`, `cancelled`, `not_collected`; курьер — у `handed_to_courier`; способ оплаты (`cash`, `kaspi_qr`, `transfer`, `card`) — у `delivered`, `issued`.
- Бот может отменить заказ только до `cooking` (переходы с `by_kind` = `bot`).
- «Доставлен»/«Выдан» у точки в режиме `checks` пробивает чек кассы с `uid` заказа (идемпотентно); у остальных точек заказ закрывается без чека.
- Акты по заказам клиентов не запирают заявки точек: `source_id` вида `<дата>/clients-<точка>-<n>`, `order_locked` их пропускает.
- Служебные точки теста `zz_*` проходят как точки выдачи; бот их события пропускает (часть B).
- Телефон и адрес клиента — только в учёте; в бэк-офисе и на планшете видны, в журналах бота маскируются.
- У бота свой ключ: действия `bot_*` при заданном `settings.bot_key_hash` принимают только его, а сам ключ бота не открывает `migrate`, `test_cleanup`, `sync_*` (наименьшие права). Пока хэш пуст — `bot_*` принимают служебный ключ (стенд и первый прогон).
- Секреты в код и в чат не попадают. Тест берёт ключи из `TANDEM_ADMIN_PIN`, `TANDEM_OWNER_PIN`, `TANDEM_SERVICE_KEY`.
- Каждая правка существующей функции проверяет, что якорь нашёлся; не нашёлся — `raise exception`, миграция откатывается.
- Перед первой правкой и после последней — полный прогон `node tools/office-smoke.mjs all`; число зелёных записывается в отчёт задачи.

## Карта влияния (кто пользуется тем, что меняется)

| Что меняется | Кто пользуется |
|---|---|
| `public.tandem_gate` | Edge Function `supabase/functions/uchet/index.ts`, `server/proxy.mjs`, все экраны, `tools/office-smoke.mjs` |
| `public.tandem_office` (разделы) | `js/office/*`, `js/stock/*`, обучалка `js/tours/*`, `tandem.training_guard` |
| `public.tandem_api` (действия точки) | `kassa.html`, `index.html`, `order.html`, `tools/office-smoke.mjs` |
| `public.tandem_test_cleanup` | `tools/office-smoke.mjs` (последний шаг) |
| `tandem.orders_report`, `tandem.order_locked` | `js/office/stock-reports.js` (вкладка «Заявки»), `tandem.order_save`, `tandem.orders_make_docs` |
| `tandem.role_permissions` | `tandem.office_permissions` → `can()` в `js/office/api.js` |
| `db/schema/tandem_full.sql` | репетиция переезда (`server/README.md`), этот план |

## Файлы

- Create: `db/migrations/0049_client_menu.sql` — таблица меню, настройки, функции меню, раздел `clients`, `bot_menu`.
- Create: `db/migrations/0050_client_orders.sql` — заказы, строки, журнал, переходы, функции заказа, действия бота и точки, уборка теста.
- Create: `db/migrations/0051_client_orders_kitchen.sql` — заказы в плане кухни, акт по заказам клиентов.
- Create: `js/office/clients.js` — раздел бэк-офиса «Заказы клиентов» (меню, заказы, настройки).
- Create: `js/kassa/orders.js` — вкладка «Заказы» кассы.
- Modify: `js/office/app.js:9-17` — раздел в списке `SECTIONS`.
- Modify: `js/office/stock-reports.js:410-460` — колонка «Клиенты», блок заказов, кнопка акта.
- Modify: `kassa.html:38-41` и `js/kassa/app.js:134-155,831-832` — вкладка «Заказы».
- Modify: `tools/office-smoke.mjs:14` (`SERVICE`) и новые разделы `cmenu`, `corders`, `corders_kitchen`.
- Modify: `db/schema/tandem_full.sql` — пересборка снимка после применения.
- Modify: `README.md`, `help.html` — что такое «Меню заказов» и вкладка «Заказы».

---

### Task 1: Исходный замер

**Исполнитель:** Claude (запуск, без правок).

- [ ] **Step 1: Прогнать весь набор на живой базе и записать результат**

Run: `TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… TANDEM_SERVICE_KEY=… node tools/office-smoke.mjs all > "$TMP/smoke-before.txt"; tail -1 "$TMP/smoke-before.txt"`
(значения — из `data/service_key.txt` и у Андрея; в чат не печатать)
Expected: строка `пройдено N, провалено 0`. Если провалено не 0 — записать имена упавших проверок
в отчёт задачи отдельной строкой: это «чужие красные», правка их не трогает.

- [ ] **Step 2: Прогнать интерфейсный тест**

Run: `node tools/ui-smoke.mjs`
Expected: `провалено 0` (47 проверок на 02.10.2026).

---

### Task 2: Миграция 0049 — «Меню заказов»

**Исполнитель:** Claude-субагент (схема и права — суждение). Ревью SQL — `verify_answer`
(участники deepseek-chat, mistral; судья openai, `max_tokens` 8000); находки проверять запуском.

**Files:**
- Create: `db/migrations/0049_client_menu.sql`
- Modify: `tools/office-smoke.mjs` (раздел `cmenu`, набор `SERVICE`)

**Interfaces:**
- Produces (SQL): `tandem.setting(text, text) → text`; `tandem.client_settings() → jsonb`;
  `tandem.cmenu_json(tandem.order_menu) → jsonb`; `tandem.cmenu_stop(text, text, text) → jsonb`;
  `tandem.cmenu_bot() → jsonb`; `tandem.office_clients(text, jsonb, tandem.users) → jsonb`.
- Produces (API бэк-офиса, раздел `clients`): `office_cmenu_list`, `office_cmenu_save`, `office_cmenu_check`,
  `office_cmenu_stop`, `office_client_settings_save`.
- Produces (служебное): `bot_menu` → `{ok, now, settings, points:[{id,name}], items:[cmenu_json без kassa_price]}`.

- [ ] **Step 1: Написать падающие проверки раздела `cmenu` в дымовом тесте**

В `tools/office-smoke.mjs` строку 14 заменить на:

```js
const SERVICE = new Set(["migrate", "test_cleanup", "sync_items", "sync_prices", "recalc_ranks", "set_packaging", "set_short_list",
  "bot_menu", "bot_order_quote", "bot_order_create", "bot_order_events", "bot_order_get", "bot_order_cancel", "bot_card_status", "bot_client_history"]);
```

Перед строкой `// migrate и reimport требуют TANDEM_OWNER_PIN …` добавить раздел:

```js
SECTIONS.cmenu = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог меню", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука меню", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  check("меню: подготовка — пирог в продаже, мука не в продаже", pie && muka, r);
  r = await call("office_cmenu_save", { token: t, item_code: muka, title_ru: "Мука", price: 100 });
  check("меню: позицию не в продаже в меню не добавить", r.ok === false && r.error === "validation", r);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", price: 0 });
  check("меню: цена 0 — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", title_kz: "ZZ_TEST_Етті бәліш",
    unit_label: "кг", price: 4550, min_qty: 1, step: 0.5, section: "Татарские пироги", ready_kind: "fresh" });
  check("меню: позиция сохранена, цена не сверена, подсказка — цена кассы", r.ok && r.row.checked === false && Number(r.row.price) === 4550 && r.row.kassa_price != null, r);
  r = await call("bot_menu", {});
  check("меню: бот не видит несверенную цену", r.ok && !r.items.some((x) => x.item_code === pie), r.items && r.items.length);
  check("меню: бот получает настройки и точки выдачи", r.ok && r.settings && r.settings.client_hours_from && Array.isArray(r.points), r.settings);
  r = await call("bot_menu", { service_key: "zz-wrong-key" });
  check("меню: без верного ключа — отказ", r.ok === false && r.error === "forbidden", r);
  if (process.env.TANDEM_BOT_KEY) {
    r = await call("test_cleanup", { service_key: process.env.TANDEM_BOT_KEY });
    check("ключ бота не открывает уборку теста", r.ok === false && r.error === "forbidden", r);
  }
  r = await call("office_cmenu_check", { token: t, item_code: pie });
  check("меню: цена отмечена сверенной", r.ok && r.row.checked === true && r.row.price_checked_by, r);
  r = await call("bot_menu", {});
  const seen = (r.items || []).find((x) => x.item_code === pie);
  check("меню: после сверки бот видит позицию без цены кассы", seen && Number(seen.price) === 4550 && seen.kassa_price === undefined && seen.ready_kind === "fresh", seen);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", unit_label: "кг", price: 4600, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  check("меню: смена цены снимает отметку «сверена»", r.ok && r.row.checked === false, r.row);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", unit_label: "кг", price: 4600, min_qty: 1, step: 0.5, ready_kind: "fresh", section: "Татарские пироги" });
  check("меню: та же цена отметку не трогает (её и не было)", r.ok && r.row.checked === false, r.row);
  await call("office_cmenu_check", { token: t, item_code: pie });
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", unit_label: "шт", price: 4600, min_qty: 0.5, step: 0.5, ready_kind: "fresh" });
  check("меню: у штучного дробный минимум — отказ", r.ok === false && r.error === "validation", r);
  const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  r = await call("office_cmenu_stop", { token: t, item_code: pie, until: day });
  check("меню: стоп на сегодня поставлен", r.ok && r.row.stopped === true, r.row);
  r = await call("bot_menu", {});
  check("меню: бот видит позицию со стопом", ((r.items || []).find((x) => x.item_code === pie) || {}).stopped === true, null);
  r = await call("office_cmenu_stop", { token: t, item_code: pie, until: "" });
  check("меню: стоп снят", r.ok && r.row.stopped === false, r.row);
  r = await call("office_cmenu_list", { token: t });
  check("меню: список с настройками", r.ok && r.rows.some((x) => x.item_code === pie) && r.settings, null);
  r = await call("office_client_settings_save", { token: t, values: { client_fresh_cutoff: "25:00" } });
  check("настройки: неверное время — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_client_settings_save", { token: t, values: { client_unknown_key: "1" } });
  check("настройки: неизвестный ключ — отказ", r.ok === false && r.error === "validation", r);
  ctx.menuPie = pie;
};
```

Там же, в `call()`, служебный ключ для `bot_*` брать из `TANDEM_BOT_KEY`, если он задан (на живой базе после
выдачи ключа боту — часть B, Task 13), иначе из `TANDEM_SERVICE_KEY`. Строку
`if (SERVICE.has(action) && !("service_key" in payload)) payload = { ...payload, service_key: process.env.TANDEM_SERVICE_KEY || "" };`
заменить на:

```js
  if (SERVICE.has(action) && !("service_key" in payload)) {
    const key = action.startsWith("bot_") && process.env.TANDEM_BOT_KEY ? process.env.TANDEM_BOT_KEY : process.env.TANDEM_SERVICE_KEY;
    payload = { ...payload, service_key: key || "" };
  }
```

- [ ] **Step 2: Убедиться, что проверки падают**

Run: `node tools/office-smoke.mjs cmenu`
Expected: FAIL на «меню: позицию не в продаже…» (`unknown_action` — раздела `clients` ещё нет).

- [ ] **Step 3: Написать миграцию `db/migrations/0049_client_menu.sql`**

```sql
-- 0049: меню заказов клиентов — бот приёма заказов Енешки
-- (docs/superpowers/specs/2026-10-16-eneshka-order-bot-design.md). Своя цена для заказов, отметка
-- «цена сверена» (без неё бот позицию не видит), стоп-лист, настройки окон готовности и доставки,
-- раздел бэк-офиса clients и служебное действие bot_menu.

create table if not exists tandem.order_menu (
  item_code        text primary key references tandem.items(code) on update cascade on delete cascade,
  title_ru         text not null check (btrim(title_ru) <> ''),
  title_kz         text,
  composition_ru   text,
  composition_kz   text,
  unit_label       text not null default 'шт' check (unit_label in ('кг', 'шт', 'сет')),
  price            numeric(12,2) not null check (price > 0),
  min_qty          numeric(10,3) not null default 1 check (min_qty > 0),
  step             numeric(10,3) not null default 1 check (step > 0),
  section          text not null default 'Выпечка' check (btrim(section) <> ''),
  ready_kind       text not null default 'stock' check (ready_kind in ('fresh', 'stock')),
  price_checked_by text,
  price_checked_at timestamptz,
  stop_until       date,
  sort_order       int not null default 0,
  active           boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       text
);
alter table tandem.order_menu enable row level security;
revoke all on tandem.order_menu from public;

insert into tandem.settings (key, value) values
  ('client_fresh_cutoff', '12:00'), ('client_fresh_ready', '18:00'), ('stock_ready_minutes', '120'),
  ('client_min_order', '7000'), ('client_hours_from', '09:00'), ('client_hours_to', '18:00'),
  ('client_max_days_ahead', '14'), ('client_pickup_points', 'eneshka'), ('client_prepay_rule', 'off'),
  ('client_confirm_remind_min', '15'), ('client_confirm_client_notice_min', '30'),
  ('kaspi_details_ru', ''), ('kaspi_details_kz', ''), ('couriers', ''),
  ('bot_key_hash', '')   -- sha256 ключа бота; пусто — bot_* принимают служебный ключ
on conflict (key) do nothing;

create or replace function tandem.setting(p_key text, p_default text default null)
returns text language sql stable set search_path to 'tandem', 'public' as $$
  select coalesce((select nullif(value, '') from tandem.settings where key = p_key), p_default)
$$;

create or replace function tandem.client_settings()
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from tandem.settings
   where key like 'client\_%' or key in ('stock_ready_minutes', 'kaspi_details_ru', 'kaspi_details_kz', 'couriers')
$$;

-- Строка меню для бэк-офиса; бот получает её же без цены кассы и служебных полей (cmenu_bot).
create or replace function tandem.cmenu_json(m tandem.order_menu)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('item_code', m.item_code, 'item_name', i.name, 'item_ok', coalesce(i.active and i.for_sale, false),
    'title_ru', m.title_ru, 'title_kz', m.title_kz, 'composition_ru', m.composition_ru, 'composition_kz', m.composition_kz,
    'unit_label', m.unit_label, 'price', m.price, 'min_qty', m.min_qty, 'step', m.step, 'section', m.section,
    'ready_kind', m.ready_kind, 'checked', m.price_checked_at is not null,
    'price_checked_by', m.price_checked_by, 'price_checked_at', m.price_checked_at,
    'stop_until', m.stop_until, 'stopped', m.stop_until is not null and m.stop_until >= tandem.local_now()::date,
    'sort_order', m.sort_order, 'active', m.active, 'updated_by', m.updated_by,
    'kassa_price', coalesce((select pp.price from tandem.item_prices pp where pp.point_id = 'eneshka' and pp.item_code = m.item_code), i.price))
  from tandem.items i where i.code = m.item_code
$$;

-- Стоп «сегодня нет»: до даты включительно; пустая дата снимает стоп. Ставят бэк-офис и точка.
create or replace function tandem.cmenu_stop(p_code text, p_until text, p_by text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_d date;
begin
  if nullif(btrim(coalesce(p_until, '')), '') is not null then
    v_d := tandem.to_date(p_until);
    if v_d is null then return tandem.err('validation', 'Дата стопа не похожа на дату'); end if;
  end if;
  update tandem.order_menu set stop_until = v_d, updated_at = now(), updated_by = left(p_by, 100) where item_code = p_code;
  if not found then return tandem.err('not_found', 'Позиции нет в меню заказов'); end if;
  return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(m) from tandem.order_menu m where m.item_code = p_code));
end $$;

-- Меню для бота: только включённое, сверенное и продаваемое; стоп виден флагом stopped.
create or replace function tandem.cmenu_bot()
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('ok', true,
    'now', to_char(tandem.local_now(), 'YYYY-MM-DD"T"HH24:MI'),
    'settings', tandem.client_settings(),
    'points', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.sort_order)
                          from tandem.points p
                         where p.id = any(string_to_array(replace(tandem.setting('client_pickup_points', 'eneshka'), ' ', ''), ','))), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(tandem.cmenu_json(m) - 'kassa_price' - 'price_checked_by' - 'price_checked_at' - 'item_name' - 'updated_by' - 'item_ok'
                                        order by m.section, m.sort_order, m.title_ru)
                         from tandem.order_menu m join tandem.items i on i.code = m.item_code
                        where m.active and m.price_checked_at is not null and i.active and i.for_sale and not i.training), '[]'::jsonb))
$$;

-- Раздел бэк-офиса «Заказы клиентов». Действия corder_* — в tandem.office_corders (0050).
create or replace function tandem.office_clients(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_code  text := nullif(btrim(coalesce(payload->>'item_code', '')), '');
  v_price numeric;
  v_min   numeric;
  v_step  numeric;
  v_unit  text := coalesce(nullif(payload->>'unit_label', ''), 'шт');
  v_kind  text := coalesce(nullif(payload->>'ready_kind', ''), 'stock');
  k text; v text;
begin
  if action like 'corder%' then return tandem.office_corders(action, payload, v_user); end if;

  if action = 'cmenu_list' then
    return jsonb_build_object('ok', true, 'settings', tandem.client_settings(),
      'rows', coalesce((select jsonb_agg(tandem.cmenu_json(m) order by m.section, m.sort_order, m.title_ru) from tandem.order_menu m), '[]'::jsonb));
  end if;

  if action = 'cmenu_save' then
    if v_code is null or not exists (select 1 from tandem.items where code = v_code and active and for_sale) then
      return tandem.err('validation', 'Позиция не найдена или не в продаже — в меню заказов только то, что продаётся'); end if;
    v_price := tandem.to_num(payload->>'price');
    if v_price is null or v_price <= 0 then return tandem.err('validation', 'Цена для заказов — число больше нуля'); end if;
    if nullif(btrim(coalesce(payload->>'title_ru', '')), '') is null then return tandem.err('validation', 'Название для клиента обязательно'); end if;
    if v_unit not in ('кг', 'шт', 'сет') then return tandem.err('validation', 'Единица — кг, шт или сет'); end if;
    if v_kind not in ('fresh', 'stock') then return tandem.err('validation', 'Готовность — «печём под заказ» или «с витрины»'); end if;
    v_min := coalesce(tandem.to_num(payload->>'min_qty'), 1);
    v_step := coalesce(tandem.to_num(payload->>'step'), 1);
    if v_min <= 0 or v_step <= 0 then return tandem.err('validation', 'Минимум и шаг — больше нуля'); end if;
    if v_unit <> 'кг' and (v_min <> trunc(v_min) or v_step <> trunc(v_step)) then
      return tandem.err('validation', 'У штучного и сетов минимум и шаг — целые'); end if;
    insert into tandem.order_menu as m (item_code, title_ru, title_kz, composition_ru, composition_kz, unit_label, price,
                                        min_qty, step, section, ready_kind, sort_order, active, updated_at, updated_by)
    values (v_code, btrim(payload->>'title_ru'), nullif(btrim(coalesce(payload->>'title_kz', '')), ''),
            nullif(btrim(coalesce(payload->>'composition_ru', '')), ''), nullif(btrim(coalesce(payload->>'composition_kz', '')), ''),
            v_unit, v_price, v_min, v_step, coalesce(nullif(btrim(coalesce(payload->>'section', '')), ''), 'Выпечка'), v_kind,
            coalesce((payload->>'sort_order')::int, 0), coalesce((payload->>'active')::boolean, true), now(), v_user.login)
    on conflict (item_code) do update set
      title_ru = excluded.title_ru, title_kz = excluded.title_kz, composition_ru = excluded.composition_ru,
      composition_kz = excluded.composition_kz, unit_label = excluded.unit_label, price = excluded.price,
      min_qty = excluded.min_qty, step = excluded.step, section = excluded.section, ready_kind = excluded.ready_kind,
      sort_order = excluded.sort_order, active = excluded.active, updated_at = now(), updated_by = excluded.updated_by,
      -- смена цены снимает отметку «сверена»: новую цену кто-то должен подтвердить заново
      price_checked_at = case when m.price = excluded.price then m.price_checked_at end,
      price_checked_by = case when m.price = excluded.price then m.price_checked_by end;
    return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(x) from tandem.order_menu x where x.item_code = v_code));
  end if;

  if action = 'cmenu_check' then
    update tandem.order_menu set price_checked_at = now(), price_checked_by = left(v_user.name, 100) where item_code = v_code;
    if not found then return tandem.err('not_found', 'Позиции нет в меню заказов'); end if;
    return jsonb_build_object('ok', true, 'row', (select tandem.cmenu_json(x) from tandem.order_menu x where x.item_code = v_code));
  end if;

  if action = 'cmenu_stop' then
    return tandem.cmenu_stop(v_code, payload->>'until', v_user.login);
  end if;

  if action = 'client_settings_save' then
    if v_user.role not in ('owner', 'admin') then return tandem.err('forbidden', 'Настройки заказов меняют собственник и администратор'); end if;
    if jsonb_typeof(payload->'values') is distinct from 'object' then return tandem.err('validation', 'Нет значений'); end if;
    for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(payload->'values') loop
      if k in ('client_fresh_cutoff', 'client_fresh_ready', 'client_hours_from', 'client_hours_to') then
        if v !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return tandem.err('validation', 'Время — ЧЧ:ММ: ' || k); end if;
      elsif k in ('stock_ready_minutes', 'client_min_order', 'client_max_days_ahead', 'client_confirm_remind_min', 'client_confirm_client_notice_min') then
        if v !~ '^[0-9]{1,7}$' then return tandem.err('validation', 'Целое число: ' || k); end if;
      elsif k = 'client_prepay_rule' then
        if v not in ('off', 'fresh') and v !~ '^from_sum:[0-9]{1,7}$' then return tandem.err('validation', 'Предоплата — off, fresh или from_sum:N'); end if;
      elsif k = 'client_pickup_points' then
        if v = '' or exists (select 1 from unnest(string_to_array(replace(v, ' ', ''), ',')) p(id)
                              where not exists (select 1 from tandem.points x where x.id = p.id)) then
          return tandem.err('validation', 'Точки выдачи — коды существующих точек через запятую'); end if;
      elsif k in ('kaspi_details_ru', 'kaspi_details_kz', 'couriers') then
        if length(v) > 500 then return tandem.err('validation', 'Не длиннее 500 знаков: ' || k); end if;
      else
        return tandem.err('validation', 'Неизвестная настройка: ' || k);
      end if;
    end loop;
    insert into tandem.settings (key, value)
      select key, btrim(coalesce(value, '')) from jsonb_each_text(payload->'values')
    on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('ok', true, 'settings', tandem.client_settings());
  end if;

  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- Права раздела: смотреть — собственник, администратор, технолог, бухгалтер; править — без бухгалтера.
insert into tandem.role_permissions (role, section, action) values
  ('owner', 'clients', 'view'), ('owner', 'clients', 'edit'),
  ('admin', 'clients', 'view'), ('admin', 'clients', 'edit'),
  ('technologist', 'clients', 'view'), ('technologist', 'clients', 'edit'),
  ('accountant', 'clients', 'view')
on conflict do nothing;

-- tandem_office: раздел clients по имени действия и его диспетчер.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_office(text,jsonb)'::regprocedure);
  if position('''clients''' in d) > 0 then raise notice '0049: tandem_office уже знает раздел clients'; return; end if;
  n := replace(d, $a$    when action like 'user%'         then 'users'
  end;$a$, $a$    when action like 'user%'         then 'users'
    when action like 'cmenu%' or action like 'corder%' or action = 'client_settings_save' then 'clients'
  end;$a$);
  if n = d then raise exception '0049: якорь разделов tandem_office не найден — правку сделать вручную'; end if;
  d := n;
  n := replace(d, $a$  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  end if;$a$, $a$  elsif v_section = 'stock' then
    return tandem.office_stock(action, payload, v_user);
  elsif v_section = 'clients' then
    return tandem.office_clients(action, payload, v_user);
  end if;$a$);
  if n = d then raise exception '0049: якорь диспетчера tandem_office не найден — правку сделать вручную'; end if;
  execute n;
end $mig$;

-- tandem_gate: служебное действие bot_menu (ключ бота — тот же служебный ключ settings.service_key_hash).
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_gate(text,jsonb)'::regprocedure);
  if position('''bot_menu''' in d) > 0 then raise notice '0049: tandem_gate уже знает bot_menu'; return; end if;
  n := replace(d, $a$'set_packaging','set_short_list');$a$, $a$'set_packaging','set_short_list','bot_menu');$a$);
  if n = d then raise exception '0049: якорь списка служебных действий tandem_gate не найден'; end if;
  d := n;
  -- ключ бота: при заданном bot_key_hash действия bot_* сверяются с ним, остальные — со служебным
  n := replace(d, $a$    select value into v_hash from tandem.settings where key = 'service_key_hash';$a$,
    $a$    select value into v_hash from tandem.settings
     where key = case when action like 'bot\_%' and coalesce((select value from tandem.settings where key = 'bot_key_hash'), '') <> ''
                      then 'bot_key_hash' else 'service_key_hash' end;$a$);
  if n = d then raise exception '0049: якорь выбора ключа tandem_gate не найден'; end if;
  d := n;
  n := replace(d, $a$coalesce(payload->'codes','[]'::jsonb))
    end;$a$, $a$coalesce(payload->'codes','[]'::jsonb))
      when 'bot_menu'       then tandem.cmenu_bot()
    end;$a$);
  if n = d then raise exception '0049: якорь case служебных действий tandem_gate не найден'; end if;
  execute n;
end $mig$;
```

Примечание к исполнителю: `tandem.office_corders` появится в 0050; до неё действия `corder_*`
отвечают ошибкой «функция не найдена», а 0049 и 0050 применяются подряд.

- [ ] **Step 4: Применить на стенде-репетиции и прогнать раздел**

Run (стенд из `server/README.md` → «Репетиция»):
```bash
cd server && docker compose -p tandem-rehearsal exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < ../db/migrations/0049_client_menu.sql
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs cmenu
```
Expected: все проверки раздела `cmenu` — `ok`, в конце `провалено 0`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0049_client_menu.sql tools/office-smoke.mjs
git commit -m "Учёт 0049: меню заказов клиентов — своя цена, сверка, стоп-лист, bot_menu"
```

---

### Task 3: Миграция 0050 — заказ клиента, статусы, действия бота и точки

**Исполнитель:** Claude-субагент (переходы и доступы — суждение). Ревью — как в Task 2.

**Files:**
- Create: `db/migrations/0050_client_orders.sql`
- Modify: `tools/office-smoke.mjs` (раздел `corders`)

**Interfaces:**
- Consumes: `tandem.setting`, `tandem.cmenu_stop`, `tandem.cmenu_json` (Task 2); `tandem.check_save(text, jsonb)`.
- Produces (SQL): `tandem.corder_check(jsonb) → jsonb {ok, quote:{point_id, point_name, kind, for_date, ready_by, address, lines[], total, delivery_fee, prepay_suggested}}`;
  `tandem.corder_create(jsonb) → {ok, order, repeat?}`; `tandem.corder_json(bigint) → jsonb`;
  `tandem.corder_set_status(bigint, text, text, text, jsonb, text) → {ok, order}` (id, куда, by_kind, by_name, payload, точка или null);
  `tandem.corder_edit(bigint, jsonb, text, text, text) → {ok, order}`; `tandem.corder_events(bigint, int) → {ok, events[], last}`;
  `tandem.corder_list(text, date, date) → {ok, orders[]}`; `tandem.corder_history(text) → {ok, name, lang, addresses[]}`;
  `tandem.corder_point(text, text, jsonb)`; `tandem.office_corders(text, jsonb, tandem.users)`; `tandem.corder_kitchen() → text[]`.
- Produces (служебные действия бота): `bot_order_quote`, `bot_order_create`, `bot_order_events {after, limit}`,
  `bot_order_get {id | uid}`, `bot_order_cancel {id, reason}`, `bot_card_status {order_id, to, by_name, reason?, courier?, pay_kind?}`,
  `bot_client_history {phone}`.
- Produces (действия точки по коду): `corder_list`, `corder_get {id}`, `corder_status {id, to, …}`, `corder_edit {id, …}`,
  `cmenu_point_list`, `cmenu_stop {item_code, until}`; имя продавца — `payload.seller`.
- Produces (бэк-офис): `office_corder_list {date_from, date_to, point_id?, status?}`, `office_corder_get {id}`, `office_corder_status {id, to, …}`.
- Форма заказа (`corder_json`): `{id, uid, no, no_date, point_id, point_name, point_mode, channel, uzel_dialog_id, client_phone,
  client_name, lang, kind, address, comment, for_date, ready_by "HH:MM", total, delivery_fee, prepay_suggested, prepay_required,
  pay_kind, courier, status, status_name, reason, check_uid, in_act, created_at, confirmed_by, confirmed_at,
  lines:[{item_code, title, unit, qty, price, sum}], last_by}`.

- [ ] **Step 1: Написать падающие проверки раздела `corders`**

После раздела `cmenu` добавить:

```js
SECTIONS.corders = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (действия точки — кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const uid = () => crypto.randomUUID();
  const iso = (k) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы заказов", point_id: "zz_kassa", is_default: true });
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог заказов", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_беляш заказов", item_type: "goods", unit_id: "шт", for_sale: true, price: 300 }); const bel = r.code;
  await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог", unit_label: "кг", price: 4500, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  await call("office_cmenu_save", { token: t, item_code: bel, title_ru: "ZZ_TEST_Беляш", unit_label: "шт", price: 500, min_qty: 2, step: 1, ready_kind: "stock" });
  await call("office_cmenu_check", { token: t, item_code: pie }); await call("office_cmenu_check", { token: t, item_code: bel });
  const menu = await call("bot_menu", {});
  const S = menu.settings || {};
  const hh = (s, add) => { const [h, m] = String(s).split(":").map(Number); const x = h * 60 + m + add; return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
  const READY = hh(S.client_hours_from || "09:00", 60);
  const base = { kind: "pickup", point_id: "zz_kassa", for_date: iso(2), ready_by: READY, lines: [{ item_code: pie, qty: 1.5 }, { item_code: bel, qty: 2 }] };
  const Q = (p) => call("bot_order_quote", { ...base, ...p });

  r = await Q({});
  check("заказ: расчёт — 1,5 кг × 4500 + 2 × 500 = 7750", r.ok && near(r.quote.total, 7750) && r.quote.lines.length === 2, r);
  r = await Q({ lines: [{ item_code: pie, qty: 1.5, price: 1 }] });
  check("заказ: присланная цена игнорируется", r.ok && near(r.quote.lines[0].price, 4500), r.quote);
  r = await Q({ kind: "courier" });
  check("заказ: неизвестный способ получения — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ point_id: "aktau" });
  check("заказ: точка не из списка выдачи — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ for_date: iso(100) });
  check("заказ: дата дальше предела — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ ready_by: "03:00" });
  check("заказ: время вне часов приёма — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ lines: [{ item_code: pie, qty: 0.5 }] });
  check("заказ: меньше минимума — отказ", r.ok === false && /Минимум/.test(r.message), r);
  r = await Q({ lines: [{ item_code: pie, qty: 1.3 }] });
  check("заказ: не по шагу — отказ", r.ok === false && /шагом/.test(r.message), r);
  r = await Q({ lines: [{ item_code: bel, qty: 2.5 }] });
  check("заказ: штучное дробью — отказ", r.ok === false && /целым/.test(r.message), r);
  r = await Q({ lines: [{ item_code: bel, qty: 2 }, { item_code: bel, qty: 3 }] });
  check("заказ: позиция дважды — отказ", r.ok === false && /дважды/.test(r.message), r);
  r = await Q({ kind: "delivery", address: "" });
  check("заказ: доставка без адреса — отказ", r.ok === false && /адрес/.test(r.message), r);
  r = await Q({ kind: "delivery", address: "ZZ_TEST ул. Мира 1", lines: [{ item_code: bel, qty: 2 }] });
  check("заказ: доставка меньше минимума — отказ min_order", r.ok === false && r.error === "min_order", r);
  r = await Q({ for_date: iso(0), ready_by: S.client_hours_from || "09:00", lines: [{ item_code: pie, qty: 1 }] });
  check("заказ: свежий пирог на сегодня к открытию — отказ slot", r.ok === false && r.error === "slot", r);
  await call("office_cmenu_stop", { token: t, item_code: bel, until: iso(2) });
  r = await Q({});
  check("заказ: позиция на стопе на эту дату — отказ stopped", r.ok === false && r.error === "stopped", r);
  await call("office_cmenu_stop", { token: t, item_code: bel, until: "" });

  const phone = "77000000" + String(Math.floor(Math.random() * 900) + 100);
  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: "" });
  check("заказ: без телефона — отказ", r.ok === false && r.error === "validation", r);
  const u1 = uid();
  r = await call("bot_order_create", { ...base, uid: u1, client_phone: phone, client_name: "ZZ_TEST_Клиент", lang: "kz" });
  check("заказ: создан, статус «новый», номер дня", r.ok && r.order.status === "new" && r.order.no >= 1 && r.order.lang === "kz" && near(r.order.total, 7750), r);
  const o1 = r.order;
  r = await call("bot_order_create", { ...base, uid: u1, client_phone: phone });
  check("заказ: повтор с тем же uid — тот же заказ", r.ok && r.repeat === true && r.order.id === o1.id, r);
  r = await call("bot_order_events", { after: 0, limit: 500 });
  check("журнал: читается, курсор last", r.ok && Number(r.last) > 0, r.last);
  const before = Number(r.last) - 1;
  r = await call("bot_order_events", { after: before - 50 < 0 ? 0 : before - 50, limit: 500 });
  check("журнал: событие создания заказа есть", r.ok && r.events.some((e) => e.order.id === o1.id && e.status_to === "new"), null);

  const P = (action, p) => call(action, { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", ...p });
  r = await P("corder_list", {});
  check("точка: видит свой новый заказ", r.ok && r.orders.some((o) => o.id === o1.id), null);
  r = await call("corder_get", { pin, point_id: "zz_test", id: o1.id });
  check("точка: чужой заказ не виден", r.ok === false && r.error === "not_found", r);
  r = await P("corder_edit", { id: o1.id, lines: [{ item_code: pie, qty: 2 }, { item_code: bel, qty: 2 }] });
  check("точка: правка нового заказа пересчитала сумму (2 × 4500 + 1000)", r.ok && near(r.order.total, 10000), r);
  r = await P("corder_status", { id: o1.id, to: "confirmed" });
  check("точка: подтвердила", r.ok && r.order.status === "confirmed" && r.order.confirmed_by === "ZZ_TEST_продавец", r);
  r = await call("bot_card_status", { order_id: o1.id, to: "confirmed", by_name: "ZZ_TEST_телеграм" });
  check("телеграм: второе подтверждение — conflict с именем первого", r.ok === false && r.error === "conflict" && /ZZ_TEST_продавец/.test(r.message), r);
  r = await P("corder_status", { id: o1.id, to: "issued", pay_kind: "cash" });
  check("переход через ступень — conflict", r.ok === false && r.error === "conflict", r);
  r = await P("corder_status", { id: o1.id, to: "cooking" });
  check("готовится", r.ok && r.order.status === "cooking", r);
  r = await call("bot_order_cancel", { id: o1.id, reason: "клиент передумал" });
  check("бот не отменяет то, что уже готовится", r.ok === false && r.error === "forbidden", r);
  r = await P("corder_edit", { id: o1.id, address: "x", lines: [{ item_code: pie, qty: 3 }] });
  check("правка строк после «готовится» — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "assembled" });
  r = await P("corder_status", { id: o1.id, to: "handed_to_courier", courier: "Курьер" });
  check("самовывоз курьеру не передаётся", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "awaiting_pickup" });
  check("ждёт клиента", r.ok && r.order.status === "awaiting_pickup", r);
  r = await P("corder_status", { id: o1.id, to: "issued" });
  check("выдан без способа оплаты — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "issued", pay_kind: "cash" });
  check("выдан — чек кассы пробит с uid заказа", r.ok && r.order.status === "issued" && r.order.check_uid === o1.uid, r);
  r = await P("check_list", { date: iso(0) });
  check("касса: чек заказа в списке на 10 000", r.ok !== false && JSON.stringify(r).includes(o1.uid) , null);

  r = await call("bot_order_create", { ...base, uid: uid(), kind: "delivery", address: "ZZ_TEST ул. Мира 1", client_phone: phone, client_name: "ZZ_TEST_Клиент" });
  const o2 = r.order;
  check("доставка: создана", r.ok && o2.kind === "delivery", r);
  r = await call("bot_card_status", { order_id: o2.id, to: "awaiting_prepay", by_name: "ZZ_TEST_телеграм" });
  check("телеграм: подтверждение с предоплатой", r.ok && r.order.status === "awaiting_prepay" && r.order.prepay_required === true, r);
  r = await call("bot_card_status", { order_id: o2.id, to: "paid", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "cooking", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "assembled", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "handed_to_courier", by_name: "ZZ_TEST_телеграм" });
  check("курьер обязателен", r.ok === false && r.error === "validation", r);
  r = await call("bot_card_status", { order_id: o2.id, to: "handed_to_courier", by_name: "ZZ_TEST_телеграм", courier: "ZZ_TEST_курьер" });
  r = await call("bot_card_status", { order_id: o2.id, to: "on_the_way", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "delivered", by_name: "ZZ_TEST_телеграм", pay_kind: "kaspi_qr" });
  check("доставлен, чек пробит, курьер записан", r.ok && r.order.status === "delivered" && r.order.courier === "ZZ_TEST_курьер" && r.order.check_uid === o2.uid, r);

  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: phone });
  const o3 = r.order;
  r = await P("corder_status", { id: o3.id, to: "rejected" });
  check("отказ без причины — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o3.id, to: "rejected", reason: "ZZ_TEST нет начинки" });
  check("отказ с причиной", r.ok && r.order.status === "rejected" && r.order.reason === "ZZ_TEST нет начинки", r);
  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: phone });
  r = await call("bot_order_cancel", { id: r.order.id, reason: "клиент передумал" });
  check("бот отменяет новый заказ", r.ok && r.order.status === "cancelled", r);

  r = await call("bot_client_history", { phone });
  check("история клиента: имя и адрес", r.ok && r.name === "ZZ_TEST_Клиент" && r.addresses.includes("ZZ_TEST ул. Мира 1"), r);
  r = await call("office_corder_list", { token: t, date_from: iso(2), date_to: iso(2), point_id: "zz_kassa" });
  check("бэк-офис: список заказов точки на день", r.ok && r.orders.length >= 4, r.orders && r.orders.length);
  r = await call("office_corder_get", { token: t, id: o1.id });
  check("бэк-офис: карточка заказа с журналом", r.ok && r.order.id === o1.id && r.events.length >= 6, r.events && r.events.length);
  ctx.corderItems = { pie, bel };
};
```

- [ ] **Step 2: Убедиться, что проверки падают**

Run: `node tools/office-smoke.mjs corders`
Expected: FAIL на первой проверке (`bot_order_quote` не знает служебный список gate — `Нужен служебный ключ`/`forbidden`, либо функции нет).

- [ ] **Step 3: Написать миграцию `db/migrations/0050_client_orders.sql`**

```sql
-- 0050: заказы клиентов — бот приёма заказов Енешки. Заказ живёт только здесь; бот создаёт его
-- служебным ключом, точка и Telegram-кнопки двигают статусы по таблице переходов, журнал
-- client_order_events — источник «что изменилось» для бота (читает «события после номера N»).

create table if not exists tandem.client_orders (
  id               bigserial primary key,
  uid              uuid not null unique,
  no               int not null,
  no_date          date not null,
  point_id         text not null references tandem.points(id),
  channel          text not null default 'whatsapp' check (channel in ('whatsapp')),
  uzel_dialog_id   text,
  client_phone     text not null check (client_phone ~ '^[0-9]{10,15}$'),
  client_name      text,
  lang             text not null default 'ru' check (lang in ('ru', 'kz')),
  kind             text not null check (kind in ('delivery', 'pickup')),
  address          text,
  comment          text,
  for_date         date not null,
  ready_by         time not null,
  total            numeric(12,2) not null check (total >= 0),
  delivery_fee     numeric(12,2) not null default 0,
  prepay_suggested boolean not null default false,
  prepay_required  boolean not null default false,
  pay_kind         text check (pay_kind in ('cash', 'kaspi_qr', 'transfer', 'card')),
  courier          text,
  status           text not null default 'new' check (status in ('new', 'awaiting_prepay', 'paid', 'confirmed', 'cooking', 'assembled',
                     'handed_to_courier', 'on_the_way', 'delivered', 'awaiting_pickup', 'issued', 'rejected', 'cancelled', 'not_collected')),
  reason           text,
  check_uid        uuid,
  confirmed_by     text,
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (no_date, no)
);
create index if not exists client_orders_point_date_idx on tandem.client_orders (point_id, for_date);
create index if not exists client_orders_phone_idx on tandem.client_orders (client_phone, created_at desc);

create table if not exists tandem.client_order_lines (
  id        bigserial primary key,
  order_id  bigint not null references tandem.client_orders(id) on delete cascade,
  item_code text not null references tandem.items(code) on update cascade,
  title     text not null,
  unit      text not null,
  qty       numeric(10,3) not null check (qty > 0),
  price     numeric(12,2) not null check (price >= 0),
  sum       numeric(12,2) not null
);
create index if not exists client_order_lines_order_idx on tandem.client_order_lines (order_id);

create table if not exists tandem.client_order_events (
  id          bigserial primary key,
  order_id    bigint not null references tandem.client_orders(id) on delete cascade,
  at          timestamptz not null default now(),
  status_from text,
  status_to   text not null,
  by_kind     text not null check (by_kind in ('bot', 'point', 'office', 'telegram')),
  by_name     text not null,
  payload     jsonb not null default '{}'::jsonb
);
create index if not exists client_order_events_order_idx on tandem.client_order_events (order_id);

create table if not exists tandem.client_order_moves (
  status_from text not null,
  status_to   text not null,
  kinds       text[] not null,
  need        text check (need in ('reason', 'courier', 'pay')),
  only_kind   text check (only_kind in ('delivery', 'pickup')),
  primary key (status_from, status_to)
);
insert into tandem.client_order_moves (status_from, status_to, kinds, need, only_kind) values
  ('new', 'confirmed', '{point,telegram}', null, null),
  ('new', 'awaiting_prepay', '{point,telegram}', null, null),
  ('new', 'rejected', '{point,telegram}', 'reason', null),
  ('new', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('awaiting_prepay', 'paid', '{point,telegram}', null, null),
  ('awaiting_prepay', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('paid', 'cooking', '{point,telegram,office}', null, null),
  ('paid', 'cancelled', '{point,telegram}', 'reason', null),
  ('confirmed', 'cooking', '{point,telegram,office}', null, null),
  ('confirmed', 'cancelled', '{bot,point,telegram}', 'reason', null),
  ('cooking', 'assembled', '{point,telegram,office}', null, null),
  ('cooking', 'cancelled', '{point,telegram}', 'reason', null),
  ('assembled', 'handed_to_courier', '{point,telegram}', 'courier', 'delivery'),
  ('assembled', 'awaiting_pickup', '{point,telegram}', null, 'pickup'),
  ('assembled', 'cancelled', '{point,telegram}', 'reason', null),
  ('handed_to_courier', 'on_the_way', '{point,telegram}', null, 'delivery'),
  ('handed_to_courier', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('handed_to_courier', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('handed_to_courier', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'delivered', '{point,telegram}', 'pay', 'delivery'),
  ('on_the_way', 'not_collected', '{point,telegram}', 'reason', 'delivery'),
  ('on_the_way', 'cancelled', '{point,telegram}', 'reason', 'delivery'),
  ('awaiting_pickup', 'issued', '{point,telegram}', 'pay', 'pickup'),
  ('awaiting_pickup', 'not_collected', '{point,telegram}', 'reason', 'pickup'),
  ('awaiting_pickup', 'cancelled', '{point,telegram}', 'reason', 'pickup')
on conflict do nothing;

alter table tandem.client_orders enable row level security;
alter table tandem.client_order_lines enable row level security;
alter table tandem.client_order_events enable row level security;
alter table tandem.client_order_moves enable row level security;
revoke all on tandem.client_orders, tandem.client_order_lines, tandem.client_order_events, tandem.client_order_moves from public;

create or replace function tandem.corder_status_name(p text)
returns text language sql immutable as $$
  select case p when 'new' then 'новый' when 'awaiting_prepay' then 'ждёт предоплаты' when 'paid' then 'оплачен'
    when 'confirmed' then 'подтверждён' when 'cooking' then 'готовится' when 'assembled' then 'собран'
    when 'handed_to_courier' then 'передан курьеру' when 'on_the_way' then 'в пути' when 'delivered' then 'доставлен'
    when 'awaiting_pickup' then 'ждёт клиента' when 'issued' then 'выдан' when 'rejected' then 'отказ'
    when 'cancelled' then 'отменён' when 'not_collected' then 'не забрали' else p end
$$;

-- Статусы, в которых заказ уже должна делать кухня (план и акт).
create or replace function tandem.corder_kitchen()
returns text[] language sql immutable as $$
  select array['confirmed', 'paid', 'cooking', 'assembled', 'handed_to_courier', 'on_the_way', 'delivered',
               'awaiting_pickup', 'issued', 'not_collected']
$$;

-- Проверка и расчёт заказа: единственное место правил (окна готовности, минимум, шаг, стоп, доставка).
-- Бот зовёт её как bot_order_quote до «да» клиента; создание и правка — через неё же.
create or replace function tandem.corder_check(payload jsonb)
returns jsonb language plpgsql stable set search_path to 'tandem', 'public' as $$
declare
  v_now    timestamp := tandem.local_now();
  v_today  date := v_now::date;
  v_date   date := tandem.to_date(payload->>'for_date');
  v_ready  time;
  v_kind   text := coalesce(payload->>'kind', '');
  v_point  text := nullif(btrim(coalesce(payload->>'point_id', '')), '');
  v_points text[] := string_to_array(replace(tandem.setting('client_pickup_points', 'eneshka'), ' ', ''), ',');
  v_from   time := tandem.setting('client_hours_from', '09:00')::time;
  v_to     time := tandem.setting('client_hours_to', '18:00')::time;
  v_cut    time := tandem.setting('client_fresh_cutoff', '12:00')::time;
  v_fready time := tandem.setting('client_fresh_ready', '18:00')::time;
  v_mins   int := tandem.setting('stock_ready_minutes', '120')::int;
  v_days   int := tandem.setting('client_max_days_ahead', '14')::int;
  v_min    numeric := tandem.setting('client_min_order', '7000')::numeric;
  v_rule   text := tandem.setting('client_prepay_rule', 'off');
  v_lines  jsonb := '[]'::jsonb;
  v_total  numeric := 0;
  v_fresh  boolean := false;
  v_stock  boolean := false;
  v_first  timestamp;
  v_qty    numeric;
  x        jsonb;
  m        record;
begin
  begin v_ready := (payload->>'ready_by')::time; exception when others then v_ready := null; end;
  if v_kind not in ('delivery', 'pickup') then return tandem.err('validation', 'Способ получения — доставка или самовывоз'); end if;
  v_point := coalesce(v_point, v_points[1]);
  if not (v_point = any(v_points) or left(v_point, 3) = 'zz_') or not exists (select 1 from tandem.points where id = v_point) then
    return tandem.err('validation', 'Эта точка заказы не выдаёт'); end if;
  if v_date is null or v_date < v_today or v_date > v_today + v_days then
    return tandem.err('validation', format('Дата заказа — с сегодняшнего дня и не дальше %s дней', v_days)); end if;
  if v_ready is null or v_ready < v_from or v_ready > v_to then
    return tandem.err('validation', format('Время готовности — с %s до %s', to_char(v_from, 'HH24:MI'), to_char(v_to, 'HH24:MI'))); end if;
  if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') = 0 then
    return tandem.err('validation', 'В заказе нет позиций'); end if;

  for x in select * from jsonb_array_elements(payload->'lines') loop
    select mm.*, (i.active and i.for_sale and not i.training) as sellable into m
      from tandem.order_menu mm join tandem.items i on i.code = mm.item_code
     where mm.item_code = x->>'item_code';
    if m.item_code is null or not m.active or m.price_checked_at is null or not m.sellable then
      return tandem.err('validation', 'Позиции нет в меню заказов: ' || coalesce(x->>'item_code', '—')); end if;
    if m.stop_until is not null and m.stop_until >= v_date then
      return tandem.err('stopped', format('«%s» на %s нет', m.title_ru, to_char(v_date, 'DD.MM'))); end if;
    v_qty := tandem.to_num(x->>'qty');
    if v_qty is null or v_qty <= 0 then return tandem.err('validation', format('Количество «%s» — число больше нуля', m.title_ru)); end if;
    if m.unit_label <> 'кг' and v_qty <> trunc(v_qty) then return tandem.err('validation', format('«%s» — только целым числом', m.title_ru)); end if;
    if v_qty < m.min_qty then
      return tandem.err('validation', format('Минимум «%s» — %s %s', m.title_ru, replace(trim_scale(m.min_qty)::text, '.', ','), m.unit_label)); end if;
    if abs(round((v_qty - m.min_qty) / m.step) * m.step - (v_qty - m.min_qty)) > 0.0005 then
      return tandem.err('validation', format('«%s» — шагом %s %s от %s', m.title_ru, replace(trim_scale(m.step)::text, '.', ','), m.unit_label, replace(trim_scale(m.min_qty)::text, '.', ','))); end if;
    if exists (select 1 from jsonb_array_elements(v_lines) l where l->>'item_code' = m.item_code) then
      return tandem.err('validation', format('«%s» указан дважды', m.title_ru)); end if;
    v_fresh := v_fresh or m.ready_kind = 'fresh';
    v_stock := v_stock or m.ready_kind = 'stock';
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('item_code', m.item_code, 'title', m.title_ru, 'title_kz', m.title_kz,
      'unit', m.unit_label, 'qty', v_qty, 'price', m.price, 'sum', round(v_qty * m.price, 2), 'ready_kind', m.ready_kind));
    v_total := v_total + round(v_qty * m.price, 2);
  end loop;

  if v_date = v_today then
    if v_fresh and (v_now::time >= v_cut or v_ready < v_fready) then
      return tandem.err('slot', format('Свежие пироги на сегодня — заказ до %s, готовность к %s. Позже — на завтра',
                                       to_char(v_cut, 'HH24:MI'), to_char(v_fready, 'HH24:MI'))); end if;
    v_first := greatest(v_now, v_today + v_from) + make_interval(mins => v_mins);
    if v_stock and v_first > v_today + v_to then
      return tandem.err('slot', 'Сегодня уже не успеем — выберите завтра'); end if;
    if v_stock and v_today + v_ready < v_first then
      return tandem.err('slot', format('Сегодня — не раньше %s', to_char(v_first, 'HH24:MI'))); end if;
  end if;

  if v_kind = 'delivery' then
    if nullif(btrim(coalesce(payload->>'address', '')), '') is null then return tandem.err('validation', 'Для доставки нужен адрес'); end if;
    if v_total < v_min then
      return tandem.err('min_order', format('Доставка — от %s ₸, в заказе %s ₸. Можно забрать самому', trim_scale(v_min), trim_scale(v_total))); end if;
  end if;

  return jsonb_build_object('ok', true, 'quote', jsonb_build_object(
    'point_id', v_point, 'point_name', (select name from tandem.points where id = v_point),
    'kind', v_kind, 'for_date', v_date, 'ready_by', to_char(v_ready, 'HH24:MI'),
    'address', case when v_kind = 'delivery' then btrim(payload->>'address') end,
    'lines', v_lines, 'total', v_total, 'delivery_fee', 0,
    'prepay_suggested', (v_rule = 'fresh' and v_fresh) or (v_rule like 'from\_sum:%' and v_total >= substr(v_rule, 10)::numeric)));
end $$;

create or replace function tandem.corder_json(p_id bigint)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('id', o.id, 'uid', o.uid, 'no', o.no, 'no_date', o.no_date, 'point_id', o.point_id,
    'point_name', p.name, 'point_mode', p.mode, 'channel', o.channel, 'uzel_dialog_id', o.uzel_dialog_id,
    'client_phone', o.client_phone, 'client_name', o.client_name, 'lang', o.lang, 'kind', o.kind, 'address', o.address,
    'comment', o.comment, 'for_date', o.for_date, 'ready_by', to_char(o.ready_by, 'HH24:MI'), 'total', o.total,
    'delivery_fee', o.delivery_fee, 'prepay_suggested', o.prepay_suggested, 'prepay_required', o.prepay_required,
    'pay_kind', o.pay_kind, 'courier', o.courier, 'status', o.status, 'status_name', tandem.corder_status_name(o.status),
    'reason', o.reason, 'check_uid', o.check_uid, 'created_at', o.created_at, 'confirmed_by', o.confirmed_by,
    'confirmed_at', o.confirmed_at,
    'in_act', false,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('item_code', l.item_code, 'title', l.title, 'unit', l.unit,
                         'qty', l.qty, 'price', l.price, 'sum', l.sum) order by l.id)
                       from tandem.client_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'last_by', (select e.by_name from tandem.client_order_events e where e.order_id = o.id order by e.id desc limit 1))
  from tandem.client_orders o join tandem.points p on p.id = o.point_id where o.id = p_id
$$;

create or replace function tandem.corder_create(payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_uid   uuid;
  v_phone text := regexp_replace(coalesce(payload->>'client_phone', ''), '\D', '', 'g');
  v_q     jsonb;
  v_day   date := tandem.local_now()::date;
  v_id    bigint;
  v_no    int;
begin
  begin v_uid := (payload->>'uid')::uuid; exception when others then v_uid := null; end;
  if v_uid is null then return tandem.err('validation', 'Нужен uid заказа'); end if;
  select id into v_id from tandem.client_orders where uid = v_uid;
  if v_id is not null then return jsonb_build_object('ok', true, 'repeat', true, 'order', tandem.corder_json(v_id)); end if;
  if length(v_phone) < 10 or length(v_phone) > 15 then return tandem.err('validation', 'Нужен телефон клиента'); end if;
  v_q := tandem.corder_check(payload);
  if not coalesce((v_q->>'ok')::boolean, false) then return v_q; end if;
  v_q := v_q->'quote';
  perform pg_advisory_xact_lock(hashtext('tandem.client_orders:' || v_day::text));
  select coalesce(max(no), 0) + 1 into v_no from tandem.client_orders where no_date = v_day;
  insert into tandem.client_orders (uid, no, no_date, point_id, uzel_dialog_id, client_phone, client_name, lang, kind, address,
                                    comment, for_date, ready_by, total, prepay_suggested)
  values (v_uid, v_no, v_day, v_q->>'point_id', nullif(btrim(coalesce(payload->>'uzel_dialog_id', '')), ''), v_phone,
          left(nullif(btrim(coalesce(payload->>'client_name', '')), ''), 100),
          case when payload->>'lang' = 'kz' then 'kz' else 'ru' end, v_q->>'kind', left(v_q->>'address', 300),
          left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500),
          (v_q->>'for_date')::date, (v_q->>'ready_by')::time, (v_q->>'total')::numeric, (v_q->>'prepay_suggested')::boolean)
  returning id into v_id;
  insert into tandem.client_order_lines (order_id, item_code, title, unit, qty, price, sum)
    select v_id, l->>'item_code', l->>'title', l->>'unit', (l->>'qty')::numeric, (l->>'price')::numeric, (l->>'sum')::numeric
      from jsonb_array_elements(v_q->'lines') l;
  insert into tandem.client_order_events (order_id, status_from, status_to, by_kind, by_name) values (v_id, null, 'new', 'bot', 'Бот');
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id));
end $$;

create or replace function tandem.corder_set_status(p_id bigint, p_to text, p_kind text, p_by text, payload jsonb, p_point text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  o        tandem.client_orders;
  t        tandem.client_order_moves;
  v_pay    text := nullif(payload->>'pay_kind', '');
  v_reason text := left(nullif(btrim(coalesce(payload->>'reason', '')), ''), 300);
  v_cour   text := left(nullif(btrim(coalesce(payload->>'courier', '')), ''), 100);
  v_by     text := left(nullif(btrim(coalesce(p_by, '')), ''), 100);
  v_chk    jsonb;
  v_check  uuid;
begin
  select * into o from tandem.client_orders where id = p_id for update;
  if o.id is null or (p_point is not null and o.point_id <> p_point) then return tandem.err('not_found', 'Заказ не найден'); end if;
  if v_by is null then return tandem.err('validation', 'Кто меняет статус — имя обязательно'); end if;
  select * into t from tandem.client_order_moves where status_from = o.status and status_to = p_to;
  if t.status_to is null then
    return jsonb_build_object('ok', false, 'error', 'conflict',
      'message', format('Заказ №%s уже «%s»%s', o.no, tandem.corder_status_name(o.status),
                        coalesce(' — ' || (select e.by_name from tandem.client_order_events e where e.order_id = o.id order by e.id desc limit 1), '')),
      'order', tandem.corder_json(o.id));
  end if;
  if not (p_kind = any(t.kinds)) then return tandem.err('forbidden', 'Этот шаг здесь не делается'); end if;
  if t.only_kind is not null and t.only_kind <> o.kind then
    return tandem.err('validation', case when o.kind = 'pickup' then 'Это самовывоз — курьера нет' else 'Это доставка — «ждёт клиента» не ставится' end); end if;
  if t.need = 'reason' and v_reason is null then return tandem.err('validation', 'Укажите причину'); end if;
  if t.need = 'courier' and v_cour is null then return tandem.err('validation', 'Укажите курьера'); end if;
  if t.need = 'pay' then
    if v_pay is null or v_pay not in ('cash', 'kaspi_qr', 'transfer', 'card') then return tandem.err('validation', 'Выберите способ оплаты'); end if;
    if (select mode from tandem.points where id = o.point_id) = 'checks' then
      v_chk := tandem.check_save(o.point_id, jsonb_build_object('uid', o.uid, 'date', tandem.local_now()::date, 'seller', v_by,
                 'pay_kind', v_pay, 'lines', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty, 'price', price) order by id)
                                               from tandem.client_order_lines where order_id = o.id)));
      if not coalesce((v_chk->>'ok')::boolean, false) then
        return tandem.err('check', 'Чек не пробит: ' || coalesce(v_chk->>'error', v_chk->>'message', 'ошибка')); end if;
      v_check := o.uid;
    end if;
  end if;
  update tandem.client_orders set status = p_to, updated_at = now(),
         reason = coalesce(v_reason, reason), courier = coalesce(v_cour, courier),
         pay_kind = coalesce(v_pay, pay_kind), check_uid = coalesce(v_check, check_uid),
         prepay_required = prepay_required or p_to = 'awaiting_prepay',
         confirmed_by = case when p_to in ('confirmed', 'awaiting_prepay') then v_by else confirmed_by end,
         confirmed_at = case when p_to in ('confirmed', 'awaiting_prepay') then now() else confirmed_at end
   where id = o.id;
  insert into tandem.client_order_events (order_id, status_from, status_to, by_kind, by_name, payload)
    values (o.id, o.status, p_to, p_kind, v_by, jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'courier', v_cour, 'pay_kind', v_pay)));
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id));
end $$;

-- Правка до «готовится»: строки, дата, час, адрес, комментарий. Только адрес и комментарий — без
-- проверки окон (правка адреса не должна упираться в отсечку, прошедшую после заказа).
create or replace function tandem.corder_edit(p_id bigint, payload jsonb, p_kind text, p_by text, p_point text)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  o     tandem.client_orders;
  v_q   jsonb;
  v_by  text := left(nullif(btrim(coalesce(p_by, '')), ''), 100);
  v_big boolean := payload ? 'lines' or payload ? 'for_date' or payload ? 'ready_by' or payload ? 'kind';
begin
  select * into o from tandem.client_orders where id = p_id for update;
  if o.id is null or (p_point is not null and o.point_id <> p_point) then return tandem.err('not_found', 'Заказ не найден'); end if;
  if v_by is null then return tandem.err('validation', 'Кто правит — имя обязательно'); end if;
  if o.status not in ('new', 'awaiting_prepay', 'paid', 'confirmed') then
    return tandem.err('validation', 'Заказ уже готовится — правка только словами с кухней'); end if;
  if v_big then
    v_q := tandem.corder_check(jsonb_build_object('kind', coalesce(payload->>'kind', o.kind), 'point_id', o.point_id,
             'for_date', coalesce(payload->>'for_date', o.for_date::text), 'ready_by', coalesce(payload->>'ready_by', to_char(o.ready_by, 'HH24:MI')),
             'address', coalesce(payload->>'address', o.address),
             'lines', coalesce(payload->'lines', (select jsonb_agg(jsonb_build_object('item_code', item_code, 'qty', qty) order by id)
                                                    from tandem.client_order_lines where order_id = o.id))));
    if not coalesce((v_q->>'ok')::boolean, false) then return v_q; end if;
    v_q := v_q->'quote';
    update tandem.client_orders set kind = v_q->>'kind', for_date = (v_q->>'for_date')::date, ready_by = (v_q->>'ready_by')::time,
           address = left(v_q->>'address', 300), total = (v_q->>'total')::numeric, prepay_suggested = (v_q->>'prepay_suggested')::boolean,
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
    delete from tandem.client_order_lines where order_id = o.id;
    insert into tandem.client_order_lines (order_id, item_code, title, unit, qty, price, sum)
      select o.id, l->>'item_code', l->>'title', l->>'unit', (l->>'qty')::numeric, (l->>'price')::numeric, (l->>'sum')::numeric
        from jsonb_array_elements(v_q->'lines') l;
  else
    if o.kind = 'delivery' and payload ? 'address' and nullif(btrim(coalesce(payload->>'address', '')), '') is null then
      return tandem.err('validation', 'Для доставки нужен адрес'); end if;
    update tandem.client_orders set address = coalesce(left(nullif(btrim(coalesce(payload->>'address', '')), ''), 300), address),
           comment = coalesce(left(nullif(btrim(coalesce(payload->>'comment', '')), ''), 500), comment), updated_at = now()
     where id = o.id;
  end if;
  insert into tandem.client_order_events (order_id, status_from, status_to, by_kind, by_name, payload)
    values (o.id, o.status, o.status, p_kind, v_by, jsonb_build_object('edited', true));
  return jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id));
end $$;

create or replace function tandem.corder_events(p_after bigint, p_limit int)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  with e as (select * from tandem.client_order_events where id > coalesce(p_after, 0) order by id limit least(greatest(coalesce(p_limit, 200), 1), 500))
  select jsonb_build_object('ok', true,
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'status_from', e.status_from, 'status_to', e.status_to,
                  'by_kind', e.by_kind, 'by_name', e.by_name, 'payload', e.payload, 'order', tandem.corder_json(e.order_id)) order by e.id) from e), '[]'::jsonb),
    'last', coalesce((select max(id) from e), coalesce(p_after, 0)))
$$;

create or replace function tandem.corder_list(p_point text, p_from date, p_to date)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  select jsonb_build_object('ok', true, 'orders', coalesce(jsonb_agg(tandem.corder_json(o.id)
           order by (o.status = 'new') desc, o.for_date, o.ready_by, o.no), '[]'::jsonb))
    from tandem.client_orders o
   where (p_point is null or o.point_id = p_point)
     and (o.for_date between p_from and p_to or o.status = 'new')
$$;

create or replace function tandem.corder_history(p_phone text)
returns jsonb language sql stable set search_path to 'tandem', 'public' as $$
  with o as (select * from tandem.client_orders where client_phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
              order by created_at desc limit 20)
  select jsonb_build_object('ok', true,
    'name', (select client_name from o where client_name is not null limit 1),
    'lang', (select lang from o limit 1),
    'orders', (select count(*) from o),
    'addresses', coalesce((select jsonb_agg(a) from (select address a, max(created_at) at from o where address is not null
                             group by address order by max(created_at) desc limit 3) x), '[]'::jsonb))
$$;

-- Действия точки (tandem_api уже проверил код точки).
create or replace function tandem.corder_point(action text, p_point text, payload jsonb)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare
  v_by    text := coalesce(left(nullif(btrim(coalesce(payload->>'seller', '')), ''), 100), 'Точка');
  v_today date := tandem.local_now()::date;
  v_id    bigint := tandem.to_num(payload->>'id')::bigint;
begin
  if action = 'corder_list' then return tandem.corder_list(p_point, v_today - 1, v_today + 14); end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id and point_id = p_point) then
      return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id));
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'point', v_by, payload, p_point); end if;
  if action = 'corder_edit' then return tandem.corder_edit(v_id, payload - 'pin' - 'point_id' - 'seller' - 'id', 'point', v_by, p_point); end if;
  if action = 'cmenu_point_list' then
    return jsonb_build_object('ok', true, 'rows', coalesce((select jsonb_agg(tandem.cmenu_json(m) - 'kassa_price' order by m.section, m.sort_order, m.title_ru)
                                                             from tandem.order_menu m where m.active and m.price_checked_at is not null), '[]'::jsonb));
  end if;
  if action = 'cmenu_stop' then return tandem.cmenu_stop(payload->>'item_code', payload->>'until', 'точка: ' || v_by); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

create or replace function tandem.office_corders(action text, payload jsonb, v_user tandem.users)
returns jsonb language plpgsql set search_path to 'tandem', 'public' as $$
declare v_id bigint := tandem.to_num(payload->>'id')::bigint;
begin
  if action = 'corder_list' then
    return jsonb_build_object('ok', true, 'orders', coalesce((select jsonb_agg(tandem.corder_json(o.id) order by o.for_date desc, o.ready_by, o.no)
      from tandem.client_orders o
     where o.for_date between coalesce(tandem.to_date(payload->>'date_from'), tandem.local_now()::date) and coalesce(tandem.to_date(payload->>'date_to'), tandem.local_now()::date)
       and (nullif(payload->>'point_id', '') is null or o.point_id = payload->>'point_id')
       and (nullif(payload->>'status', '') is null or o.status = payload->>'status')), '[]'::jsonb));
  end if;
  if action = 'corder_get' then
    if not exists (select 1 from tandem.client_orders where id = v_id) then return tandem.err('not_found', 'Заказ не найден'); end if;
    return jsonb_build_object('ok', true, 'order', tandem.corder_json(v_id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status_from', e.status_from, 'status_to', e.status_to,
                   'status_name', tandem.corder_status_name(e.status_to), 'by_kind', e.by_kind, 'by_name', e.by_name, 'payload', e.payload) order by e.id), '[]'::jsonb)
                 from tandem.client_order_events e where e.order_id = v_id));
  end if;
  if action = 'corder_status' then return tandem.corder_set_status(v_id, payload->>'to', 'office', v_user.name, payload, null); end if;
  return tandem.err('unknown_action', 'Неизвестное действие: ' || action);
end $$;

-- tandem_gate: служебные действия бота.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_gate(text,jsonb)'::regprocedure);
  if position('''bot_order_create''' in d) > 0 then raise notice '0050: tandem_gate уже знает действия заказов'; return; end if;
  n := replace(d, $a$'set_short_list','bot_menu');$a$,
    $a$'set_short_list','bot_menu','bot_order_quote','bot_order_create','bot_order_events','bot_order_get','bot_order_cancel','bot_card_status','bot_client_history');$a$);
  if n = d then raise exception '0050: якорь списка служебных действий tandem_gate не найден (0049 применена?)'; end if;
  d := n;
  n := replace(d, $a$      when 'bot_menu'       then tandem.cmenu_bot()
    end;$a$, $a$      when 'bot_menu'       then tandem.cmenu_bot()
      when 'bot_order_quote'  then tandem.corder_check(payload)
      when 'bot_order_create' then tandem.corder_create(payload)
      when 'bot_order_events' then tandem.corder_events(coalesce(tandem.to_num(payload->>'after'), 0)::bigint, coalesce(tandem.to_num(payload->>'limit'), 200)::int)
      when 'bot_order_get'    then coalesce((select jsonb_build_object('ok', true, 'order', tandem.corder_json(o.id)) from tandem.client_orders o
                                               where o.id = tandem.to_num(payload->>'id')::bigint or o.uid::text = payload->>'uid' limit 1),
                                             tandem.err('not_found', 'Заказ не найден'))
      when 'bot_order_cancel' then tandem.corder_set_status(tandem.to_num(payload->>'id')::bigint, 'cancelled', 'bot', 'Бот', payload, null)
      when 'bot_card_status'  then tandem.corder_set_status(tandem.to_num(payload->>'order_id')::bigint, payload->>'to', 'telegram', payload->>'by_name', payload, null)
      when 'bot_client_history' then tandem.corder_history(payload->>'phone')
    end;$a$);
  if n = d then raise exception '0050: якорь case служебных действий tandem_gate не найден'; end if;
  execute n;
end $mig$;

-- tandem_api: действия точки по заказам клиентов — под той же проверкой кода точки.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_api(text,jsonb)'::regprocedure);
  if position('tandem.corder_point' in d) > 0 then raise notice '0050: tandem_api уже знает заказы клиентов'; return; end if;
  n := replace(d, $a$'check_list','order_get','order_save') then$a$,
    $a$'check_list','order_get','order_save','corder_list','corder_get','corder_status','corder_edit','cmenu_point_list','cmenu_stop') then$a$);
  if n = d then raise exception '0050: якорь списка действий точки tandem_api не найден'; end if;
  d := n;
  n := replace(d, $a$  -- ---------- касса: чеки в течение дня ----------$a$, $a$  -- ---------- заказы клиентов (0050) ----------
  if action in ('corder_list','corder_get','corder_status','corder_edit','cmenu_point_list','cmenu_stop') then
    return tandem.corder_point(action, v_point, payload);
  end if;

  -- ---------- касса: чеки в течение дня ----------$a$);
  if n = d then raise exception '0050: якорь блока кассы tandem_api не найден'; end if;
  execute n;
end $mig$;

-- tandem_test_cleanup: заказы служебных точек (строки и журнал — каскадом) и остаток в leftovers.
do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.tandem_test_cleanup(text)'::regprocedure);
  if position('client_orders' in d) > 0 then raise notice '0050: уборка уже знает заказы клиентов'; return; end if;
  n := replace(d, $a$  delete from tandem.orders where left(point_id, 3) = 'zz_';$a$,
    $a$  delete from tandem.client_orders where left(point_id, 3) = 'zz_';   -- 0050: заказы клиентов служебных точек
  delete from tandem.orders where left(point_id, 3) = 'zz_';$a$);
  if n = d then raise exception '0050: якорь уборки заявок не найден'; end if;
  d := n;
  n := replace(d, $a$       + (select count(*) from tandem.users where login like 'zz\_test\_%')$a$,
    $a$       + (select count(*) from tandem.users where login like 'zz\_test\_%')
       + (select count(*) from tandem.client_orders where left(point_id, 3) = 'zz_')$a$);
  if n = d then raise exception '0050: якорь подсчёта остатков уборки не найден'; end if;
  execute n;
end $mig$;
```

Примечание к исполнителю: `bot_order_get` без найденного заказа отдаёт `not_found` через `coalesce`
подзапроса. Проверить отдельным вызовом в Step 4: `call("bot_order_get", {id: 0})` → `ok:false, error:"not_found"`,
и `call("bot_order_get", {uid: <uid o1>})` → тот же заказ.

- [ ] **Step 4: Применить на стенде-репетиции и прогнать разделы**

Run:
```bash
cd server && docker compose -p tandem-rehearsal exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < ../db/migrations/0050_client_orders.sql
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs cmenu
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs corders
```
Expected: все `ok`; в уборке — «очистка: следов нет». Если на стенде нет точки `zz_kassa`
в режиме `checks` — её создаёт `seed-dev.sql`; иначе проверки чеков упадут, и это ошибка стенда, а не миграции.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0050_client_orders.sql tools/office-smoke.mjs
git commit -m "Учёт 0050: заказ клиента — статусы по таблице переходов, журнал, действия бота и точки"
```

---

### Task 4: Миграция 0051 — заказы клиентов на кухне

**Исполнитель:** Claude-субагент (склад — суждение: документы и «готовым»).

**Files:**
- Create: `db/migrations/0051_client_orders_kitchen.sql`
- Modify: `tools/office-smoke.mjs` (раздел `corders_kitchen`)

**Interfaces:**
- Consumes: `tandem.corder_kitchen()`, `tandem.office_corders` (Task 3); `tandem.office_stock('doc_save', …)`; `tandem.active_chart`.
- Produces: колонки `client_orders.production_doc uuid`, `client_orders.act_at timestamptz`;
  `tandem.corder_make_docs(date, tandem.users) → {ok, made, skipped}`; бэк-офис `office_corder_docs_save {for_date}`;
  в `stock_orders_report` ключи `clients:[{item_code, name, unit, qty, in_act, has_chart}]` и
  `client_orders:[{id, no, point_id, point_name, kind, ready_by, status, status_name, in_act, client_name, lines:[{title, qty, unit}]}]`;
  `corder_json.in_act` = `act_at is not null`.

- [ ] **Step 1: Написать падающие проверки раздела `corders_kitchen`**

```js
SECTIONS.corders_kitchen = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const iso = (k) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
  let d = null;
  for (let k = 3; k <= 9 && !d; k++) {
    const x = await call("office_stock_orders_report", { token: t, for_date: iso(k) });
    if (x.ok && !(x.docs || []).length && !(x.client_orders || []).some((o) => !String(o.point_id).startsWith("zz_"))) d = iso(k);
  }
  if (!d) { console.log("  пропуск: нет дня без настоящих документов плана"); return; }
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы кухни", point_id: "zz_kassa", is_default: true }); const S = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука кухни", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог кухни", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_chart_save", { token: t, code: pie, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.5 }] });
  await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог кухни", unit_label: "кг", price: 4500, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  await call("office_cmenu_check", { token: t, item_code: pie });
  const menu = await call("bot_menu", {});
  const from = (menu.settings || {}).client_hours_from || "09:00";
  const ready = String(Number(from.slice(0, 2)) + 1).padStart(2, "0") + from.slice(2);
  const mk = async (qty) => {
    const x = await call("bot_order_create", { uid: crypto.randomUUID(), kind: "pickup", point_id: "zz_kassa", for_date: d, ready_by: ready,
      client_phone: "77000000999", lines: [{ item_code: pie, qty }] });
    await call("corder_status", { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", id: x.order.id, to: "confirmed" });
    return x.order;
  };
  const o1 = await mk(2);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  const c = (r.clients || []).find((x) => x.item_code === pie) || {};
  check("кухня: в плане колонка «Клиенты» — 2 кг пирога", r.ok && near(c.qty, 2) && near(c.in_act || 0, 0) && c.has_chart, c);
  check("кухня: заказ в списке дня, ещё не в акте", (r.client_orders || []).some((o) => o.id === o1.id && o.in_act === false), r.client_orders);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: акт по заказам клиентов создан", r.ok && r.made === 1, r);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  check("кухня: акт виден в документах плана, заявки точек не заперты", r.ok && r.docs.some((x) => /\/clients-zz_kassa-1$/.test(x.source_id)) && r.locked === false, { docs: r.docs, locked: r.locked });
  check("кухня: заказ отмечен «в акте»", (r.client_orders || []).some((o) => o.id === o1.id && o.in_act === true), null);
  const o2 = await mk(1);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  check("кухня: поздний заказ — «после акта»", (r.client_orders || []).some((o) => o.id === o2.id && o.in_act === false), null);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: дополнительный акт только на поздний заказ", r.ok && r.made === 1, r);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  const act2 = r.docs.find((x) => /\/clients-zz_kassa-2$/.test(x.source_id));
  const doc = act2 && await call("office_doc_get", { token: t, id: act2.id });
  check("кухня: во втором акте 1 кг", doc && doc.ok && near((doc.doc.lines.find((l) => l.item_code === pie) || {}).qty, 1), doc && doc.doc && doc.doc.lines);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: повтор без новых заказов — актов не добавилось", r.ok && r.made === 0, r);
  r = await call("corder_edit", { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", id: o2.id, lines: [{ item_code: pie, qty: 3 }] });
  check("кухня: строки заказа в акте не правятся", r.ok === false && r.error === "validation", r);
};
```

- [ ] **Step 2: Убедиться, что проверки падают**

Run: `node tools/office-smoke.mjs corders_kitchen`
Expected: FAIL «кухня: в плане колонка «Клиенты»…» (ключа `clients` в отчёте нет).

- [ ] **Step 3: Написать миграцию `db/migrations/0051_client_orders_kitchen.sql`**

```sql
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
```

Примечание к исполнителю: `corder_docs_save` заканчивается на `_save` — право `clients:edit`
выводит `tandem_office`, а `doc:production:edit` проверяется внутри. Если в `role_permissions` раздел
называется иначе, чем `doc:production`, — свериться запросом
`select distinct section from tandem.role_permissions where section like 'doc%'` и поправить строку.

- [ ] **Step 4: Применить на стенде и прогнать разделы**

Run:
```bash
cd server && docker compose -p tandem-rehearsal exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < ../db/migrations/0051_client_orders_kitchen.sql
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs corders_kitchen
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs orders
```
Expected: `corders_kitchen` — все `ok`; старый раздел `orders` — по-прежнему все `ok`
(акты клиентов не трогают заявки точек).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0051_client_orders_kitchen.sql tools/office-smoke.mjs
git commit -m "Учёт 0051: заказы клиентов в плане кухни и акт производства по ним"
```

---

### Task 5: Бэк-офис — раздел «Заказы клиентов»

**Исполнитель:** черновик модуля — gemini (`ask_model`, provider gemini, по коду ниже и `js/office/counteragents.js` как образцу стиля);
проверка — Claude в браузере (`preview_start` `live-local` или песочница), затем `node tools/ui-smoke.mjs`.

**Files:**
- Create: `js/office/clients.js`
- Modify: `js/office/app.js:9-17`

**Interfaces:**
- Consumes: `office_cmenu_list/save/check/stop`, `office_client_settings_save`, `office_corder_list/get/status`; `api`, `can` из `api.js`; `el`, `toast`, `errText`, `modal`, `today` из `ui.js`; `itemPicker`, `fmtDate`, `fmtMoney` из `inputs.js`.
- Produces: модуль раздела `export async function mount(root)`, `export function setTab(name)` (`menu` | `orders` | `settings`).

- [ ] **Step 1: Добавить раздел в список**

В `js/office/app.js` в массив `SECTIONS` после строки `{ id: "users", title: "Пользователи" },` вставить:

```js
  { id: "clients", title: "Заказы клиентов" },
```

- [ ] **Step 2: Написать модуль `js/office/clients.js`**

```js
// Раздел «Заказы клиентов» (0049–0051): меню заказов для бота со своей ценой и отметкой «цена сверена»,
// список заказов с журналом, настройки окон готовности и доставки. Права — раздел clients.
import { api, can } from "./api.js?v=22";
import { el, toast, errText, modal, today } from "./ui.js?v=22";
import { itemPicker, fmtDate, fmtMoney } from "./inputs.js?v=22";

const UNITS = ["кг", "шт", "сет"];
const READY = { fresh: "печём под заказ", stock: "с витрины" };
const SETTINGS = [
  ["client_hours_from", "Приём заказов с"], ["client_hours_to", "до"],
  ["client_fresh_cutoff", "Свежие пироги на сегодня — заказ до"], ["client_fresh_ready", "готовность к"],
  ["stock_ready_minutes", "С витрины — через, мин"], ["client_min_order", "Доставка от, ₸"],
  ["client_max_days_ahead", "Заказ вперёд, дней"], ["client_pickup_points", "Точки выдачи (коды через запятую)"],
  ["client_prepay_rule", "Предоплата: off / fresh / from_sum:N"], ["client_confirm_remind_min", "Напомнить продавцу через, мин"],
  ["client_confirm_client_notice_min", "Написать клиенту «скоро ответим» через, мин"],
  ["couriers", "Курьеры (через запятую)"], ["kaspi_details_ru", "Реквизиты Kaspi (рус.)"], ["kaspi_details_kz", "Реквизиты Kaspi (каз.)"],
];
let root, body, tab = "menu", seq = 0;
const ord = { from: today(), to: today(), status: "" };

export function setTab(name) { tab = name; if (body) draw(); }

export async function mount(r) {
  root = r;
  const tabs = el("div", { class: "tabs" },
    ...[["menu", "Меню заказов"], ["orders", "Заказы"], ["settings", "Настройки"]].map(([id, title]) =>
      el("button", { class: tab === id ? "on" : "", onclick: (e) => { tab = id; for (const b of tabs.children) b.classList.toggle("on", b === e.target); draw(); } }, title)));
  body = el("div");
  root.append(tabs, body);
  await draw();
}

async function draw() {
  const n = ++seq;
  body.innerHTML = '<div class="dim">Загрузка…</div>';
  if (tab === "orders") return drawOrders(n);
  const r = await api("cmenu_list", {});
  if (n !== seq) return;
  body.innerHTML = "";
  if (!r.ok) { body.append(el("div", { class: "err" }, errText(r))); return; }
  if (tab === "settings") return drawSettings(r.settings);
  drawMenu(r.rows);
}

function drawMenu(rows) {
  const edit = can("clients", "edit");
  const unchecked = rows.filter((x) => x.active && !x.checked).length;
  body.append(el("div", { class: "tools" },
    edit ? el("button", { onclick: () => editRow(null) }, "+ Позиция в меню") : null,
    el("span", { class: unchecked ? "tag bad" : "dim" }, unchecked ? `Цена не сверена: ${unchecked} — бот их не видит` : "Все цены сверены")));
  const t = el("table");
  t.append(el("tr", {}, ...["Раздел", "Для клиента", "Ед.", "Цена заказа", "Цена кассы", "Готовность", "Цена", "Стоп", ""].map((h) => el("th", {}, h))));
  for (const x of rows) {
    const diff = x.kassa_price != null && Number(x.kassa_price) !== Number(x.price);
    t.append(el("tr", { class: x.active ? "" : "dim" },
      el("td", {}, x.section), el("td", {}, x.title_ru, x.title_kz ? el("div", { class: "dim" }, x.title_kz) : null),
      el("td", {}, x.unit_label), el("td", { class: "num" }, fmtMoney(x.price)),
      el("td", { class: "num" + (diff ? " bad" : "") , title: diff ? "Цена кассы отличается" : "" }, x.kassa_price == null ? "—" : fmtMoney(x.kassa_price)),
      el("td", {}, READY[x.ready_kind]),
      el("td", {}, x.checked ? el("span", { class: "tag ok", title: `${x.price_checked_by || ""}` }, "сверена")
        : edit ? el("button", { class: "ghost", onclick: () => act("cmenu_check", { item_code: x.item_code }, "Цена отмечена сверенной") }, "Сверить") : el("span", { class: "tag bad" }, "не сверена")),
      el("td", {}, x.stopped ? el("span", { class: "tag bad" }, "до " + fmtDate(x.stop_until)) : "",
        edit ? el("button", { class: "link", onclick: () => act("cmenu_stop", { item_code: x.item_code, until: x.stopped ? "" : today() }, x.stopped ? "Стоп снят" : "Сегодня нет") }, x.stopped ? "снять" : "сегодня нет") : null),
      el("td", {}, edit ? el("button", { class: "link", onclick: () => editRow(x) }, "править") : null)));
  }
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "Меню пусто: добавьте позиции из закреплённых постов Instagram")));
  body.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

async function act(action, payload, ok) {
  const r = await api(action, payload);
  if (!r.ok) { toast(errText(r), "bad"); return; }
  toast(ok); draw();
}

function editRow(x) {
  const m = modal(x ? "Позиция меню заказов" : "Новая позиция меню заказов");
  const pick = x ? null : itemPicker({ placeholder: "Позиция учёта (в продаже)" });
  const f = {};
  const inp = (k, v, attrs = {}) => (f[k] = el("input", { value: v ?? "", ...attrs }));
  const sel = (k, opts, v) => (f[k] = el("select", {}, ...opts.map(([val, t]) => el("option", { value: val, selected: val === v }, t))));
  m.root.append(
    x ? el("div", { class: "dim" }, "Позиция учёта: " + x.item_name) : el("label", {}, "Позиция учёта", pick.root || pick),
    el("label", {}, "Название для клиента", inp("title_ru", x && x.title_ru)),
    el("label", {}, "Название по-казахски", inp("title_kz", x && x.title_kz)),
    el("label", {}, "Состав", inp("composition_ru", x && x.composition_ru)),
    el("label", {}, "Состав по-казахски", inp("composition_kz", x && x.composition_kz)),
    el("label", {}, "Раздел", inp("section", (x && x.section) || "Выпечка")),
    el("label", {}, "Единица", sel("unit_label", UNITS.map((u) => [u, u]), (x && x.unit_label) || "шт")),
    el("label", {}, "Цена для заказов, ₸", inp("price", x && x.price, { inputmode: "decimal" })),
    x ? el("div", { class: "dim" }, "Цена кассы Енешки: " + (x.kassa_price == null ? "—" : fmtMoney(x.kassa_price)) + ". Смена цены снимает отметку «сверена».") : null,
    el("label", {}, "Минимум", inp("min_qty", (x && x.min_qty) || 1, { inputmode: "decimal" })),
    el("label", {}, "Шаг", inp("step", (x && x.step) || 1, { inputmode: "decimal" })),
    el("label", {}, "Готовность", sel("ready_kind", Object.entries(READY), (x && x.ready_kind) || "stock")),
    el("label", {}, "Порядок", inp("sort_order", (x && x.sort_order) || 0, { inputmode: "numeric" })),
    el("label", {}, (f.active = el("input", { type: "checkbox", checked: x ? x.active : true })), " в меню"),
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => m.cancel() }, "Отмена"),
      el("button", { onclick: async (e) => {
        const code = x ? x.item_code : (pick.value && pick.value()) || pick.code;
        const payload = { item_code: code, active: f.active.checked };
        for (const k of Object.keys(f)) if (k !== "active") payload[k] = String(f[k].value).replace(",", ".").trim();
        e.target.disabled = true;
        const r = await api("cmenu_save", payload);
        e.target.disabled = false;
        if (!r.ok) { toast(errText(r), "bad"); return; }
        m.close(); toast(r.row.checked ? "Сохранено" : "Сохранено. Цену нужно сверить — до этого бот позицию не видит"); draw(); } }, "Сохранить")));
}

function drawSettings(s) {
  const edit = can("clients", "edit");
  const f = {};
  const card = el("div", { class: "card" });
  for (const [k, title] of SETTINGS) card.append(el("label", {}, title, (f[k] = el("input", { value: s[k] ?? "", disabled: !edit }))));
  if (edit) card.append(el("div", { class: "actions" }, el("button", { onclick: async (e) => {
    const values = {}; for (const [k] of SETTINGS) if (String(f[k].value) !== String(s[k] ?? "")) values[k] = f[k].value.trim();
    if (!Object.keys(values).length) { toast("Ничего не изменилось"); return; }
    e.target.disabled = true; const r = await api("client_settings_save", { values }); e.target.disabled = false;
    if (!r.ok) { toast(errText(r), "bad"); return; } toast("Настройки сохранены"); draw(); } }, "Сохранить")));
  body.append(el("div", { class: "dim", style: "margin-bottom:8px" }, "Правила, по которым бот принимает заказы. Меняют собственник и администратор."), card);
}

async function drawOrders(n) {
  const r = await api("corder_list", { date_from: ord.from, date_to: ord.to, status: ord.status });
  if (n !== seq) return;
  body.innerHTML = "";
  const from = el("input", { type: "date", value: ord.from, onchange: (e) => { ord.from = e.target.value; draw(); } });
  const to = el("input", { type: "date", value: ord.to, onchange: (e) => { ord.to = e.target.value; draw(); } });
  body.append(el("div", { class: "tools" }, el("span", {}, "Дата заказа с"), from, el("span", {}, "по"), to));
  if (!r.ok) { body.append(el("div", { class: "err" }, errText(r))); return; }
  const t = el("table");
  t.append(el("tr", {}, ...["№", "Дата, к часу", "Клиент", "Получение", "Сумма", "Статус", "Подтвердил"].map((h) => el("th", {}, h))));
  for (const o of r.orders) t.append(el("tr", { style: "cursor:pointer", onclick: () => openOrder(o.id) },
    el("td", {}, `${o.no} от ${fmtDate(o.no_date)}`), el("td", {}, `${fmtDate(o.for_date)} ${o.ready_by}`),
    el("td", {}, o.client_name || "—", el("div", { class: "dim" }, "+" + o.client_phone)),
    el("td", {}, o.kind === "delivery" ? "доставка: " + (o.address || "") : "самовывоз: " + o.point_name),
    el("td", { class: "num" }, fmtMoney(o.total)), el("td", {}, o.status_name), el("td", {}, o.confirmed_by || "")));
  if (!r.orders.length) t.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "Заказов нет")));
  body.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

async function openOrder(id) {
  const r = await api("corder_get", { id });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const o = r.order, m = modal(`Заказ №${o.no} от ${fmtDate(o.no_date)}`);
  m.root.append(
    el("div", {}, `${o.client_name || "—"}, +${o.client_phone}, язык: ${o.lang === "kz" ? "казахский" : "русский"}`),
    el("div", {}, o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз: ${o.point_name}`, ` · ${fmtDate(o.for_date)} к ${o.ready_by}`),
    el("table", {}, ...o.lines.map((l) => el("tr", {}, el("td", {}, l.title), el("td", { class: "num" }, `${l.qty} ${l.unit}`), el("td", { class: "num" }, fmtMoney(l.sum))))),
    el("div", { style: "font-weight:700" }, "Итого: " + fmtMoney(o.total)),
    el("h3", {}, "Журнал"),
    ...r.events.map((e) => el("div", { class: "dim" }, `${new Date(e.at).toLocaleString("ru-RU")} — ${e.payload && e.payload.edited ? "правка" : e.status_name} — ${e.by_name}`,
      e.payload && e.payload.reason ? ` (${e.payload.reason})` : "")),
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => m.close() }, "Закрыть")));
}
```

Примечание к исполнителю: `itemPicker` в `js/office/inputs.js:94` — сверить, что он возвращает
(элемент или объект со `root` и выбранным кодом), и подогнать две строки с `pick`. Проверка —
сохранить новую позицию через окно и увидеть её в списке.

- [ ] **Step 3: Проверить в браузере**

Открыть бэк-офис через `preview_start` (`live-local`, порт 8091) с песочницей или боевым `config.js`,
войти администратором, открыть «Заказы клиентов»:
- вкладка «Меню заказов» показывает позиции, кнопка «Сверить» меняет метку на «сверена»;
- «+ Позиция в меню» сохраняет позицию, тост говорит про сверку;
- «Настройки» сохраняют время отсечки; `25:00` даёт ошибку;
- «Заказы» показывают заказ, созданный тестом, карточка открывает журнал.

Expected: в консоли браузера (`read_console_messages`, `onlyErrors`) ошибок нет.

- [ ] **Step 4: Интерфейсный тест**

Run: `node tools/ui-smoke.mjs`
Expected: `провалено 0`.

- [ ] **Step 5: Commit**

```bash
git add js/office/clients.js js/office/app.js
git commit -m "Бэк-офис: раздел «Заказы клиентов» — меню со сверкой цен, заказы, настройки"
```

---

### Task 6: «Склад → Заявки» — заказы клиентов в плане кухни

**Исполнитель:** Claude (правка живого экрана; по коду ниже).

**Files:**
- Modify: `js/office/stock-reports.js` (функция плана заявок, после построения таблицы `t`)

**Interfaces:**
- Consumes: ключи отчёта `clients`, `client_orders` (Task 4), `office_corder_docs_save`.

- [ ] **Step 1: Колонка «Клиенты» в таблице плана**

В заголовке таблицы плана после `el("th", { class: "num" }, "Заявлено"),` вставить
`el("th", { class: "num", title: "Подтверждённые заказы клиентов на этот день" }, "Клиенты"),`.
Перед циклом `for (const x of r.plan)` добавить
`const cl = new Map((r.clients || []).map((c) => [c.item_code, c]));`, а в строке после ячейки
«Заявлено» вставить `el("td", { class: "num" }, cl.has(x.item_code) ? fmt(cl.get(x.item_code).qty) : ""),`.
В строке «На этот день заявок нет» поменять `colspan: 5` на `colspan: 6`.

- [ ] **Step 2: Блок «Заказы клиентов» под планом**

Сразу после `out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));` вставить:

```js
  if ((r.client_orders || []).length) {
    const late = r.client_orders.filter((o) => !o.in_act);
    const only = (r.clients || []).filter((c) => !r.plan.some((p) => p.item_code === c.item_code));
    out.append(el("h3", { style: "margin:14px 0 6px" }, "Заказы клиентов"),
      only.length ? el("div", { class: "dim" }, "Только в заказах клиентов: " + only.map((c) => `${c.name} — ${fmt(c.qty)} ${c.unit || ""}`).join(", ")) : null,
      el("div", { class: "card", style: "padding:0;overflow:auto" }, el("table", {},
        el("tr", {}, ...["К часу", "№", "Точка", "Состав", "Статус", ""].map((h) => el("th", {}, h))),
        ...r.client_orders.map((o) => el("tr", {}, el("td", {}, o.ready_by), el("td", {}, String(o.no)),
          el("td", {}, (o.kind === "delivery" ? "доставка, " : "самовывоз, ") + o.point_name),
          el("td", {}, (o.lines || []).map((l) => `${l.title} ${fmt(l.qty)} ${l.unit}`).join("; ")),
          el("td", {}, o.status_name), el("td", {}, o.in_act ? el("span", { class: "tag ok" }, "в акте") : el("span", { class: "tag bad" }, "после акта")))))));
    if (late.length && perms().includes("doc:production:edit")) out.append(el("div", { class: "actions" }, el("button", { onclick: async (e) => {
      e.target.disabled = true;
      const x = await api("corder_docs_save", { for_date: day }, { timeout: LONG_MS });
      e.target.disabled = false;
      if (!x.ok) { toast(errText(x), "bad"); if (x.error === "network") loadOrders(); return; }
      toast(x.made ? `Создано актов: ${x.made}` : "Новых позиций с техкартой нет — заказы отмечены");
      if (x.skipped) toast("Без склада точки, акт не создан: " + x.skipped, "bad");
      loadOrders(); } }, `Акт по заказам клиентов (${late.length})`)));
  }
```

- [ ] **Step 3: Проверить в браузере**

На песочнице после прогона `corders_kitchen` без уборки (`TANDEM_SERVICE_KEY` не задавать на один прогон)
открыть «Склад → Заявки» на найденный тестом день: колонка «Клиенты» и блок заказов видны,
кнопка «Акт по заказам клиентов» создаёт акт, после этого метка «в акте». Затем прогнать уборку:
`node tools/office-smoke.mjs auth` с `TANDEM_SERVICE_KEY`.
Expected: консоль без ошибок; «очистка: следов нет».

- [ ] **Step 4: Commit**

```bash
git add js/office/stock-reports.js
git commit -m "Склад → Заявки: колонка «Клиенты», заказы дня и акт по заказам клиентов"
```

---

### Task 7: Касса — вкладка «Заказы»

**Исполнитель:** черновик — gemini по коду ниже; проверка — Claude в браузере на учебной кассе
`ucheb_kassa` (код у Андрея) и на песочнице.

**Files:**
- Create: `js/kassa/orders.js`
- Modify: `kassa.html:38-41`, `js/kassa/app.js` (`openShell`, `showTab`, обработчики вкладок, экспорт `call`)

**Interfaces:**
- Consumes: действия точки `corder_list`, `corder_status`, `corder_edit`, `cmenu_point_list`, `cmenu_stop`; `call(action, payload)` из `app.js`.
- Produces: `export function mountOrders(root, ctx)`, где `ctx = { call, seller: () => string, onCount: (n) => void }`;
  `export function stopOrders()`.

- [ ] **Step 1: Вкладка в разметке**

В `kassa.html` после `<button id="tab-shift" aria-selected="false">Смена</button>` добавить
`<button id="tab-orders" aria-selected="false">Заказы <span id="ordcount" class="badge" hidden></span></button>`,
а после `<main id="sale" class="sale">…</main>` (перед секцией смены) — `<main id="orders" class="orders" hidden></main>`.

- [ ] **Step 2: Модуль `js/kassa/orders.js`**

```js
// Вкладка «Заказы» кассы (0050): заказы клиентов из WhatsApp-бота. Новый заказ продавец подтверждает
// здесь или в Telegram — кто первым; дальше ведёт статусы до выдачи. «Выдан»/«Доставлен» пробивает чек
// на сервере (uid заказа), очередь чеков планшета не участвует.
import { el, fmt, toast } from "../office/ui.js?v=22";

const POLL = 20000;
const PAY = { cash: "Наличные", kaspi_qr: "Kaspi QR", transfer: "Перевод", card: "Карта" };
const NEXT = {
  new: [["confirmed", "Подтвердить"], ["awaiting_prepay", "С предоплатой"], ["rejected", "Отказать"]],
  awaiting_prepay: [["paid", "Оплата пришла"], ["cancelled", "Отменить"]],
  paid: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  confirmed: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  cooking: [["assembled", "Собран"], ["cancelled", "Отменить"]],
  assembled: [["handed_to_courier", "Передан курьеру"], ["awaiting_pickup", "Ждёт клиента"], ["cancelled", "Отменить"]],
  handed_to_courier: [["on_the_way", "В пути"], ["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  on_the_way: [["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  awaiting_pickup: [["issued", "Выдан"], ["not_collected", "Не забрали"]],
};
const REASON = new Set(["rejected", "cancelled", "not_collected"]);
const PAYTO = new Set(["delivered", "issued"]);
const OPEN = new Set(Object.keys(NEXT));
let R = null, C = null, timer = null, known = new Set(), first = true;

export function mountOrders(root, ctx) {
  R = root; C = ctx; first = true; known = new Set();
  clearInterval(timer); timer = setInterval(load, POLL);
  load();
}
export function stopOrders() { clearInterval(timer); timer = null; }

function beep() {
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); o.frequency.value = 880;
    o.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 350); } catch {}
}

async function load() {
  if (!R) return;
  let r;
  try { r = await C.call("corder_list", {}); } catch { return; }   // нет связи — следующий опрос
  if (!r || !r.ok) return;
  const fresh = r.orders.filter((o) => o.status === "new" && !known.has(o.id));
  if (!first && fresh.length) { beep(); toast(`Новый заказ: №${fresh.map((o) => o.no).join(", №")}`); }
  for (const o of r.orders) known.add(o.id);
  first = false;
  C.onCount(r.orders.filter((o) => o.status === "new").length);
  draw(r.orders);
}

function draw(orders) {
  R.innerHTML = "";
  R.append(el("div", { class: "tools" }, el("button", { class: "ghost", onclick: stopList }, "Стоп-лист"), el("button", { class: "ghost", onclick: load }, "Обновить")));
  const groups = [["Новые", (o) => o.status === "new"], ["В работе", (o) => OPEN.has(o.status) && o.status !== "new"],
                  ["Закрытые", (o) => !OPEN.has(o.status)]];
  for (const [title, f] of groups) {
    const list = orders.filter(f);
    if (!list.length) continue;
    R.append(el("h3", {}, `${title} (${list.length})`), ...list.map(card));
  }
  if (!orders.length) R.append(el("div", { class: "dim" }, "Заказов нет"));
}

function card(o) {
  const lines = o.lines.map((l) => `${l.title} — ${fmt(l.qty)} ${l.unit}`).join(", ");
  const btns = (NEXT[o.status] || []).filter(([to]) => !(o.kind === "pickup" && (to === "handed_to_courier")) && !(o.kind === "delivery" && to === "awaiting_pickup"))
    .map(([to, title]) => el("button", { class: to === "rejected" || to === "cancelled" || to === "not_collected" ? "ghost" : "", onclick: () => move(o, to) }, title));
  if (["new", "awaiting_prepay", "paid", "confirmed"].includes(o.status)) btns.push(el("button", { class: "link", onclick: () => editOrder(o) }, "Править"));
  return el("div", { class: "card" + (o.status === "new" ? " hot" : "") },
    el("div", { style: "font-weight:700" }, `№${o.no} · ${o.for_date.split("-").reverse().join(".")} к ${o.ready_by} · ${fmt(o.total)} ₸ · ${o.status_name}`),
    el("div", {}, o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз`, " · ", o.client_name || "", " ",
      el("a", { href: "tel:+" + o.client_phone }, "+" + o.client_phone)),
    el("div", { class: "dim" }, lines),
    o.prepay_suggested && o.status === "new" ? el("div", { class: "tag bad" }, "по правилу нужна предоплата") : null,
    o.courier ? el("div", { class: "dim" }, "Курьер: " + o.courier) : null,
    o.reason ? el("div", { class: "dim" }, "Причина: " + o.reason) : null,
    el("div", { class: "actions" }, ...btns));
}

async function move(o, to) {
  const p = { id: o.id, to };
  if (REASON.has(to)) { const v = window.prompt("Причина (её увидит клиент при отказе или отмене):", ""); if (!v || !v.trim()) return; p.reason = v.trim(); }
  if (to === "handed_to_courier") { const v = window.prompt("Кто везёт? (имя курьера)", ""); if (!v || !v.trim()) return; p.courier = v.trim(); }
  if (PAYTO.has(to)) { const v = await payDialog(o); if (!v) return; p.pay_kind = v; }
  let r;
  try { r = await C.call("corder_status", { ...p, seller: C.seller() }); } catch (e) { toast("Нет связи — статус не изменён", "bad"); return; }
  if (!r.ok) { toast(r.message || r.error || "Не получилось", "bad"); load(); return; }
  toast(`№${o.no}: ${r.order.status_name}`); load();
}

function payDialog(o) {
  return new Promise((done) => {
    const ov = el("div", { class: "overlay" });
    const box = el("div", { class: "card" }, el("h3", {}, `№${o.no}: ${fmt(o.total)} ₸ — чем оплатили?`),
      ...Object.entries(PAY).map(([k, t]) => el("button", { onclick: () => { ov.remove(); done(k); } }, t)),
      el("button", { class: "ghost", onclick: () => { ov.remove(); done(null); } }, "Назад"));
    ov.append(box); document.body.append(ov);
  });
}

async function editOrder(o) {
  const ov = el("div", { class: "overlay" });
  const qty = new Map();
  const date = el("input", { type: "date", value: o.for_date });
  const time = el("input", { type: "time", value: o.ready_by });
  const addr = el("input", { value: o.address || "", placeholder: "Адрес" });
  const rows = o.lines.map((l) => { const i = el("input", { inputmode: "decimal", value: String(l.qty).replace(".", ","), style: "width:80px" }); qty.set(l.item_code, i);
    return el("div", {}, l.title, " ", i, " ", l.unit); });
  const box = el("div", { class: "card" }, el("h3", {}, `Правка №${o.no}`), ...rows, el("div", {}, "Дата ", date, " к ", time),
    o.kind === "delivery" ? addr : null,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => ov.remove() }, "Отмена"),
      el("button", { onclick: async () => {
        const lines = [...qty].map(([item_code, i]) => ({ item_code, qty: String(i.value).replace(",", ".").trim() })).filter((l) => Number(l.qty) > 0);
        const p = { id: o.id, lines, for_date: date.value, ready_by: time.value, seller: C.seller() };
        if (o.kind === "delivery") p.address = addr.value.trim();
        let r; try { r = await C.call("corder_edit", p); } catch { toast("Нет связи — правка не сохранена", "bad"); return; }
        if (!r.ok) { toast(r.message || r.error, "bad"); return; }
        ov.remove(); toast(`№${o.no}: сумма ${fmt(r.order.total)} ₸`); load(); } }, "Сохранить")));
  ov.append(box); document.body.append(ov);
}

async function stopList() {
  let r; try { r = await C.call("cmenu_point_list", {}); } catch { toast("Нет связи", "bad"); return; }
  if (!r.ok) { toast(r.message || r.error, "bad"); return; }
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const ov = el("div", { class: "overlay" });
  const box = el("div", { class: "card" }, el("h3", {}, "Сегодня нет (бот перестанет предлагать)"),
    ...r.rows.map((x) => el("label", {}, el("input", { type: "checkbox", checked: x.stopped, onchange: async (e) => {
      let s; try { s = await C.call("cmenu_stop", { item_code: x.item_code, until: e.target.checked ? today : "" }); } catch { s = null; }
      if (!s || !s.ok) { e.target.checked = !e.target.checked; toast((s && (s.message || s.error)) || "Нет связи", "bad"); } } }), " ", x.title_ru)),
    el("button", { onclick: () => ov.remove() }, "Готово"));
  ov.append(box); document.body.append(ov);
}
```

- [ ] **Step 3: Подключить вкладку в `js/kassa/app.js`**

В начало файла рядом с импортом `ui.js` добавить:
`import { mountOrders, stopOrders } from "./orders.js?v=22";`

`showTab` заменить на:

```js
function showTab(name) {
  $("sale").hidden = name !== "sale"; $("shift").hidden = name !== "shift"; $("orders").hidden = name !== "orders";
  $("tab-sale").setAttribute("aria-selected", String(name === "sale"));
  $("tab-shift").setAttribute("aria-selected", String(name === "shift"));
  $("tab-orders").setAttribute("aria-selected", String(name === "orders"));
  $("cartbar").hidden = name !== "sale" || !S.cart.length;
  drawClosed();
  if (name === "shift") drawShift();
}
```

В `openShell()` после `showTab("sale");` добавить (опрос идёт на любой вкладке — иначе продавец не услышит новый заказ):

```js
  mountOrders($("orders"), { call: (a, p) => call(a, p), seller: () => S.seller,
    onCount: (n) => { const b = $("ordcount"); b.hidden = !n; b.textContent = String(n); } });
```

В `logout()` перед `initLogin();` добавить `stopOrders();`. Рядом со строками 831–832 добавить
`$("tab-orders").onclick = () => showTab("orders");`.

- [ ] **Step 4: Стили**

В `kassa.css` добавить:

```css
.orders{padding:12px;overflow:auto}
.orders .card{margin:8px 0;padding:10px}
.orders .card.hot{border:2px solid var(--bad, #c0392b)}
.orders .actions button{margin:4px 6px 0 0}
.badge{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:#c0392b;color:#fff;font-size:12px}
```

- [ ] **Step 5: Проверить в браузере**

На песочнице: войти в кассу точки `zz_kassa` (или учебной `ucheb_kassa`), создать заказ
`bot_order_create` из консоли Node, через 20 с увидеть счётчик на вкладке и звук; провести заказ
«Подтвердить → Готовится → Собран → Ждёт клиента → Выдан (Наличные)»; во вкладке «Смена» появился
чек на сумму заказа; «Стоп-лист» ставит и снимает галочку. Ширина 768 (`resize_window` tablet) —
кнопки не уезжают.
Expected: консоль без ошибок; чек в смене; `node tools/ui-smoke.mjs` — `провалено 0`.

- [ ] **Step 6: Commit**

```bash
git add js/kassa/orders.js js/kassa/app.js kassa.html kassa.css
git commit -m "Касса: вкладка «Заказы» — подтверждение, статусы до выдачи, стоп-лист"
```

---

### Task 8: Применение на живой базе, снимок схемы, сборка, памятки

**Исполнитель:** Claude (доступ к боевой базе — только Claude, по правилу выкладки больших миграций).

**Files:**
- Modify: `db/schema/tandem_full.sql`, `README.md`, `help.html`, файлы сборки (скрипт).

- [ ] **Step 1: Сборка**

Run: `node tools/bump-build.mjs`
Expected: `сборка N → N+1, файлов изменено: …` (включая новые `js/office/clients.js`, `js/kassa/orders.js`).

- [ ] **Step 2: Коммит и выкладка миграций приёмом «http_get + md5»**

Закоммитить и отправить ветку; для каждой из 0049, 0050, 0051 выполнить через `apply_migration`
(проект `qeehxcnnuzuwskznhdyg`) DO-блок, который берёт файл с `raw.githubusercontent.com` по SHA
коммита и исполняет его только при совпадении md5 с локальным (`md5sum db/migrations/0049_client_menu.sql`).
Порядок строго 0049 → 0050 → 0051.
Expected: каждая миграция — без ошибок; `list_migrations` показывает три новые.

- [ ] **Step 3: Полный прогон на живой базе**

Run: `node tools/office-smoke.mjs all > "$TMP/smoke-after.txt"; tail -1 "$TMP/smoke-after.txt"`
Expected: `провалено 0`, а пройдено = исходное число из Task 1 + проверки разделов `cmenu`, `corders`,
`corders_kitchen`; «очистка: следов нет». Упавшие из Task 1 «чужие красные» сравнить по именам.

- [ ] **Step 4: Снимок схемы**

Выполнить `db/schema/snapshot-query.sql` на живой базе (`execute_sql`), результат — в файл
scratchpad, затем `node tools/build-schema-snapshot.mjs <файл>`.
Expected: в `db/schema/tandem_full.sql` есть `tandem.order_menu`, `tandem.client_orders`,
`tandem.corder_check`; `git diff --stat db/schema/tandem_full.sql` — только добавления и правленые функции.

- [ ] **Step 5: Памятки**

`README.md` — раздел «Заказы клиентов»: что такое меню заказов и сверка цены, где вкладка на кассе,
что бот видит только сверенное. `help.html` — короткая памятка продавцу: «новый заказ → Подтвердить
или С предоплатой → … → Выдан → способ оплаты; Стоп-лист — сегодня нет».

- [ ] **Step 6: Commit**

```bash
git add db/schema/tandem_full.sql README.md help.html
git add -u
git commit -m "Сборка: заказы клиентов в учёте — снимок схемы после 0051, памятки"
```

- [ ] **Step 7: Записать итог в память сети**

`remember` (project «Учет для Тандема»): миграции 0049–0051 применены, действия `bot_*` для бота,
вкладка «Заказы» кассы, раздел «Заказы клиентов», сколько проверок прошло.
