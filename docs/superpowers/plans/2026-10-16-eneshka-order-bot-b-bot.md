# Бот приёма заказов Енешки — часть B: бот и сервер

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WhatsApp-бот Енешки на «Узле» собирает заказ на русском и казахском, кладёт его в учёт
действиями `bot_*`, присылает карточку с кнопками в Telegram, пишет клиенту при смене статуса,
передаёт разговор человеку; разворачивается контейнером на VPS Тандема.

**Architecture:** Deno-сервис `bot/` в этом репозитории. Вход — вебхук «Узла» (`POST /uzel`, подпись
HMAC) и вебхук Telegram (`POST /tg`). Разговор — Claude Sonnet 5.5 с инструментами; инструменты
считают через учёт (`bot_order_quote`) и сами отправляют клиенту шаблоны итога и статусов.
Наблюдатель раз в 10 с читает журнал заказов «после номера N». Своя база — схема `bot` в общем
Postgres VPS. Каждый модуль — свой файл со своими тестами на подделках соседей.

**Tech Stack:** Deno 2.9.5, TypeScript, `npm:pg@8.13.1` (как в «Узле»), `npm:@anthropic-ai/sdk`
(версия закрепляется в Task 1), `jsr:@std/assert`, Telegram Bot API, Docker (`denoland/deno:2.9.5`),
Caddy «Узла».

**Спецификация:** `docs/superpowers/specs/2026-10-16-eneshka-order-bot-design.md`.
**Опирается на часть A:** `docs/superpowers/plans/2026-10-16-eneshka-order-bot-a-uchet.md`
(действия `bot_menu`, `bot_order_quote`, `bot_order_create`, `bot_order_events`, `bot_order_get`,
`bot_order_cancel`, `bot_card_status`, `bot_client_history`; форма заказа `corder_json`).

## Global Constraints

- Модель — `claude-sonnet-5-5` (настройка `BOT_MODEL`), `output_config.effort` = `low`, `fallbacks: "default"` с бетой `server-side-fallback-2026-07-01`; `tool_choice` не форсировать (400 на Sonnet 5.5), инструменты со `strict: true`.
- История разговора — только дописывается (preserved thinking: правка прошлых ходов даёт 400). Новый заказ — новая история, а не обрезка старой.
- Текущее время и состояние корзины — сообщением `role: "system"` после хода клиента, а не правкой системной части (кэш).
- Цены, суммы и итог — только из ответа учёта; модель их не пишет. Итог, «передал продавцу» и статусы уходят клиенту шаблоном из `templates.ts` прямо из инструмента или наблюдателя.
- `order_submit` проходит, только если итог уже отправлен и клиент ответил после него.
- Текст сообщения клиента — только из API «Узла» (`GET /v1/dialogs/<id>/messages`), не из вебхука. Перед ответом — `GET /v1/dialogs/<id>`: `bot.paused` или назначенный сотрудник — молчать.
- Повтор события «Узла» отбрасывается по `eventId`; ответ на вебхук — сразу, работа — после.
- События заказов точек `zz_*` и заказов без `uzel_dialog_id` бот пропускает.
- Телефон в журнале бота — маской `+7 701 *** ** 67`. В Telegram-карточке — полностью (сотрудникам).
- Секреты только в переменных окружения контейнера: `UZEL_API_KEY`, `UZEL_WEBHOOK_SECRET`, `UCHET_SERVICE_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `DATABASE_URL`. Скрипты записывают секреты в `.env` на сервере сами и не печатают их.
- Деньги и сообщения людям — только после «да» Андрея (список в Task 14).
- `deno task test` и `deno task check` зелёные после каждой задачи; число тестов пишется в отчёт.

## Файлы

```
bot/
  deno.json                 задачи, импорты
  main.ts                   запуск: сервер, наблюдатель, напоминания
  src/config.ts             переменные окружения
  src/types.ts              общие типы (меню, заказ, событие, состояние диалога)
  src/store.ts              интерфейс Store, MemStore
  src/store_pg.ts           PgStore (схема bot)
  src/uzel.ts               подпись вебхука, клиент API «Узла»
  src/uchet.ts              клиент учёта (bot_*), кэш меню
  src/menu.ts               текст меню и правил, проверка строки корзины, телефон, язык
  src/templates.ts          шаблоны ru/kz
  src/tools.ts              инструменты модели
  src/dialog.ts             ход разговора с моделью
  src/model.ts              адаптер Anthropic SDK
  src/inbound.ts            вебхук «Узла» → очередь диалога → ход разговора
  src/telegram.ts           клиент Bot API, карточки, кнопки, команды
  src/watcher.ts            журнал заказов → клиенту и в карточку; напоминания
  src/app.ts                маршруты HTTP
  sql/001_bot.sql           схема bot
  tests/fakes.ts            подделки Uzel, Uchet, Telegram, модели
  tests/*.test.ts           тесты модулей
  eval/cases.json           30 эталонных разговоров
  eval/menu.json            снимок меню для эталонов
  eval/run.ts               прогон эталонов на настоящей модели
  scripts/register.ts       регистрация вебхуков «Узла» и Telegram (секрет — в .env, не на экран)
  scripts/bot-key.ts        ключ бота для учёта: в .env, на экран — только sha256
  Dockerfile
  docker-compose.override.yml   служба bot для установки «Узла» Тандема
  README.md
```

---

### Task 1: Каркас `bot/`, типы, конфигурация

**Исполнитель:** gemini (механика по коду ниже), проверка — `deno task check` и `deno task test`.

**Files:** Create `bot/deno.json`, `bot/src/types.ts`, `bot/src/config.ts`, `bot/tests/config.test.ts`

**Interfaces:**
- Produces: типы `Fetch`, `Lang`, `MenuItem`, `Menu`, `OrderLine`, `Order`, `OrderEvent`, `CartLine`, `Details`, `Quote`, `DialogState`; `loadConfig(env: Record<string,string|undefined>) → Config`.

- [ ] **Step 1: Закрепить версию SDK**

Run: `npm view @anthropic-ai/sdk time --json` — выбрать последнюю версию, выпущенную не позже чем
за 14 дней до сегодняшней даты; записать её в `deno.json` вместо `X.Y.Z`.

- [ ] **Step 2: `bot/deno.json`**

```json
{
  "tasks": {
    "test": "deno test --allow-env --allow-read",
    "check": "deno check main.ts src/*.ts tests/*.ts eval/run.ts scripts/*.ts",
    "start": "deno run --allow-net --allow-env --allow-read main.ts",
    "eval": "deno run --allow-net --allow-env --allow-read eval/run.ts"
  },
  "nodeModulesDir": "auto",
  "imports": {
    "pg": "npm:pg@8.13.1",
    "@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@X.Y.Z",
    "@std/assert": "jsr:@std/assert@1.0.13"
  },
  "fmt": { "lineWidth": 110 }
}
```

- [ ] **Step 3: `bot/src/types.ts`**

```ts
// Общие типы бота. Формы заказа и события повторяют tandem.corder_json / corder_events (часть A, 0050).
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Lang = "ru" | "kz";

export interface MenuItem {
  item_code: string; title_ru: string; title_kz: string | null;
  composition_ru: string | null; composition_kz: string | null;
  unit_label: "кг" | "шт" | "сет"; price: number; min_qty: number; step: number;
  section: string; ready_kind: "fresh" | "stock"; stopped: boolean; stop_until: string | null;
  sort_order: number; active: boolean; checked: boolean;
}
export interface Menu { now: string; settings: Record<string, string>; points: { id: string; name: string }[]; items: MenuItem[] }

export interface OrderLine { item_code: string; title: string; unit: string; qty: number; price: number; sum: number }
export interface Order {
  id: number; uid: string; no: number; no_date: string; point_id: string; point_name: string;
  uzel_dialog_id: string | null; client_phone: string; client_name: string | null; lang: Lang;
  kind: "delivery" | "pickup"; address: string | null; for_date: string; ready_by: string; total: number;
  prepay_suggested: boolean; prepay_required: boolean; pay_kind: string | null; courier: string | null;
  status: string; status_name: string; reason: string | null; created_at: string; confirmed_by: string | null;
  lines: OrderLine[];
}
export interface OrderEvent {
  id: number; at: string; status_from: string | null; status_to: string; by_kind: string; by_name: string;
  payload: Record<string, unknown>; order: Order;
}
export interface CartLine { item_code: string; qty: number }
export interface Details {
  kind?: "delivery" | "pickup"; for_date?: string; ready_by?: string; address?: string;
  client_name?: string; point_id?: string;
}
export interface Quote {
  point_id: string; point_name: string; kind: "delivery" | "pickup"; for_date: string; ready_by: string;
  address: string | null; lines: (OrderLine & { title_kz?: string | null })[]; total: number;
  delivery_fee: number; prepay_suggested: boolean;
}
export interface DialogState {
  dialog_id: string; phone: string; name: string | null; lang: Lang;
  convo: unknown[];                  // MessageParam[] Anthropic — только дописывается
  cart: CartLine[]; details: Details; quote: Quote | null;
  stage: "chat" | "awaiting_yes" | "submitted";
  summary_sent_at: string | null; draft_uid: string; last_order_no: number | null;
  last_client_msg_id: string | null; last_activity: string;
}
```

- [ ] **Step 4: Написать падающий тест `bot/tests/config.test.ts`**

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../src/config.ts";

const full = {
  UZEL_BASE_URL: "https://uzel.example.kz", UZEL_API_KEY: "uzel_x", UZEL_WEBHOOK_SECRET: "whsec_x",
  UCHET_API_URL: "https://u.example/functions/v1/uchet", UCHET_SERVICE_KEY: "k", ANTHROPIC_API_KEY: "a",
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s", TELEGRAM_OWNER_ID: "42",
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://bot.example.kz",
};

Deno.test("config: всё задано — модель по умолчанию Sonnet 5.5, порт 8080", () => {
  const c = loadConfig(full);
  assertEquals(c.model, "claude-sonnet-5-5");
  assertEquals(c.port, 8080);
  assertEquals(c.telegramOwnerId, 42);
});

Deno.test("config: нет переменной — ошибка с её именем, без значений", () => {
  const { UCHET_SERVICE_KEY: _, ...rest } = full;
  assertThrows(() => loadConfig(rest), Error, "UCHET_SERVICE_KEY");
});

Deno.test("config: секрет вебхука может быть пустым до регистрации", () => {
  const c = loadConfig({ ...full, UZEL_WEBHOOK_SECRET: "" });
  assertEquals(c.uzelWebhookSecret, "");
});
```

- [ ] **Step 5: Убедиться, что тест падает**

Run: `cd bot && deno task test`
Expected: FAIL — `Module not found "src/config.ts"`.

- [ ] **Step 6: `bot/src/config.ts`**

```ts
// Настройки из окружения контейнера. Значения секретов в сообщения об ошибках не попадают.
export interface Config {
  uzelBase: string; uzelKey: string; uzelWebhookSecret: string;
  uchetUrl: string; uchetKey: string; anthropicKey: string; model: string;
  tgToken: string; tgWebhookSecret: string; telegramOwnerId: number;
  databaseUrl: string; publicBase: string; port: number;
}

const REQUIRED = ["UZEL_BASE_URL", "UZEL_API_KEY", "UCHET_API_URL", "UCHET_SERVICE_KEY", "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_ID", "DATABASE_URL", "PUBLIC_BASE_URL"];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error("Не заданы переменные окружения: " + missing.join(", "));
  return {
    uzelBase: env.UZEL_BASE_URL!.replace(/\/$/, ""), uzelKey: env.UZEL_API_KEY!,
    uzelWebhookSecret: env.UZEL_WEBHOOK_SECRET ?? "",
    uchetUrl: env.UCHET_API_URL!, uchetKey: env.UCHET_SERVICE_KEY!, anthropicKey: env.ANTHROPIC_API_KEY!,
    model: env.BOT_MODEL || "claude-sonnet-5-5",
    tgToken: env.TELEGRAM_BOT_TOKEN!, tgWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET!,
    telegramOwnerId: Number(env.TELEGRAM_OWNER_ID),
    databaseUrl: env.DATABASE_URL!, publicBase: env.PUBLIC_BASE_URL!.replace(/\/$/, ""),
    port: Number(env.PORT || 8080),
  };
}
```

- [ ] **Step 7: Тест и проверка типов**

Run: `cd bot && deno task test && deno check src/config.ts src/types.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 8: Commit**

```bash
git add bot/deno.json bot/src/types.ts bot/src/config.ts bot/tests/config.test.ts
git commit -m "Бот Енешки: каркас, типы, настройки окружения"
```

---

### Task 2: Хранилище — `Store`, `MemStore`, `PgStore`, схема `bot`

**Исполнитель:** gemini (по коду ниже); проверка PgStore — Claude на Postgres в Docker.

**Files:** Create `bot/src/store.ts`, `bot/src/store_pg.ts`, `bot/sql/001_bot.sql`, `bot/tests/store.test.ts`

**Interfaces:**
- Produces: `interface Store { seenEvent(id): Promise<boolean>; getDialog(id): Promise<DialogState|null>; saveDialog(d): Promise<void>;
  getState<T>(key): Promise<T|null>; setState(key, v): Promise<void>; getCard(orderId): Promise<Card|null>; saveCard(c): Promise<void>;
  openCards(): Promise<Card[]>; setAwait(a): Promise<void>; takeAwait(chatId, promptId): Promise<Await|null>;
  noticeOnce(orderId, kind): Promise<boolean>; journal(kind, dialogId, text): Promise<void> }`;
  `interface Card { order_id: number; chat_id: number; message_id: number; status: string; created_at: string; dialog_id: string | null; lang: Lang; no: number }`;
  `interface Await { chat_id: number; prompt_id: number; order_id: number; kind: "reason" | "courier"; to: string; by_name: string }`;
  `class MemStore implements Store`; `class PgStore implements Store` (`new PgStore(databaseUrl)`, `migrate()`).

- [ ] **Step 1: Падающий тест `bot/tests/store.test.ts`** (общий для обеих реализаций)

```ts
import { assert, assertEquals } from "@std/assert";
import { MemStore, type Store } from "../src/store.ts";

export async function storeContract(s: Store) {
  assertEquals(await s.seenEvent("e1"), true);
  assertEquals(await s.seenEvent("e1"), false);
  assertEquals(await s.getDialog("d1"), null);
  const d = { dialog_id: "d1", phone: "77011234567", name: "Айгуль", lang: "ru" as const, convo: [{ role: "user", content: "привет" }],
    cart: [], details: {}, quote: null, stage: "chat" as const, summary_sent_at: null, draft_uid: "u1", last_order_no: null,
    last_client_msg_id: null, last_activity: "2026-10-17T05:00:00.000Z" };
  await s.saveDialog(d);
  assertEquals((await s.getDialog("d1"))!.convo.length, 1);
  await s.setState("events_after", 15);
  assertEquals(await s.getState<number>("events_after"), 15);
  await s.saveCard({ order_id: 7, chat_id: -100, message_id: 55, status: "new", created_at: "2026-10-17T05:00:00.000Z", dialog_id: "d1", lang: "ru", no: 3 });
  assertEquals((await s.openCards()).map((c) => c.order_id), [7]);
  await s.saveCard({ order_id: 7, chat_id: -100, message_id: 55, status: "issued", created_at: "2026-10-17T05:00:00.000Z", dialog_id: "d1", lang: "ru", no: 3 });
  assertEquals((await s.openCards()).length, 0);
  await s.setAwait({ chat_id: -100, prompt_id: 9, order_id: 7, kind: "reason", to: "rejected", by_name: "Мария" });
  assertEquals((await s.takeAwait(-100, 9))!.to, "rejected");
  assertEquals(await s.takeAwait(-100, 9), null);
  assertEquals(await s.noticeOnce(7, "confirmed"), true);
  assertEquals(await s.noticeOnce(7, "confirmed"), false);
  await s.journal("in", "d1", "+7 701 *** ** 67: привет");
  assert(true);
}

Deno.test("store: MemStore выполняет контракт", async () => { await storeContract(new MemStore()); });
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bot && deno task test` → FAIL `Module not found "src/store.ts"`.

- [ ] **Step 3: `bot/src/store.ts`**

```ts
// Хранилище бота: дедупликация событий «Узла», состояние диалогов, карточки Telegram, ожидания ответа
// в Telegram (причина, курьер), разовые уведомления, журнал. Заказы здесь не хранятся — они в учёте.
import type { DialogState, Lang } from "./types.ts";

export interface Card { order_id: number; chat_id: number; message_id: number; status: string; created_at: string; dialog_id: string | null; lang: Lang; no: number }
export interface Await { chat_id: number; prompt_id: number; order_id: number; kind: "reason" | "courier"; to: string; by_name: string }
export const FINAL = new Set(["delivered", "issued", "rejected", "cancelled", "not_collected"]);

export interface Store {
  seenEvent(id: string): Promise<boolean>;
  getDialog(id: string): Promise<DialogState | null>;
  saveDialog(d: DialogState): Promise<void>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, v: unknown): Promise<void>;
  getCard(orderId: number): Promise<Card | null>;
  saveCard(c: Card): Promise<void>;
  openCards(): Promise<Card[]>;
  setAwait(a: Await): Promise<void>;
  takeAwait(chatId: number, promptId: number): Promise<Await | null>;
  noticeOnce(orderId: number, kind: string): Promise<boolean>;
  journal(kind: string, dialogId: string | null, text: string): Promise<void>;
}

export class MemStore implements Store {
  events = new Set<string>(); dialogs = new Map<string, DialogState>(); state = new Map<string, unknown>();
  cards = new Map<number, Card>(); awaits = new Map<string, Await>(); notices = new Set<string>(); log: string[] = [];
  seenEvent(id: string) { const n = !this.events.has(id); this.events.add(id); return Promise.resolve(n); }
  getDialog(id: string) { const d = this.dialogs.get(id); return Promise.resolve(d ? structuredClone(d) : null); }
  saveDialog(d: DialogState) { this.dialogs.set(d.dialog_id, structuredClone(d)); return Promise.resolve(); }
  getState<T>(key: string) { return Promise.resolve((this.state.has(key) ? this.state.get(key) : null) as T | null); }
  setState(key: string, v: unknown) { this.state.set(key, v); return Promise.resolve(); }
  getCard(id: number) { return Promise.resolve(this.cards.get(id) ?? null); }
  saveCard(c: Card) { this.cards.set(c.order_id, { ...c }); return Promise.resolve(); }
  openCards() { return Promise.resolve([...this.cards.values()].filter((c) => !FINAL.has(c.status))); }
  setAwait(a: Await) { this.awaits.set(`${a.chat_id}:${a.prompt_id}`, a); return Promise.resolve(); }
  takeAwait(chat: number, p: number) { const k = `${chat}:${p}`; const a = this.awaits.get(k) ?? null; this.awaits.delete(k); return Promise.resolve(a); }
  noticeOnce(id: number, kind: string) { const k = `${id}:${kind}`; const n = !this.notices.has(k); this.notices.add(k); return Promise.resolve(n); }
  journal(kind: string, d: string | null, text: string) { this.log.push(`${kind} ${d ?? "-"} ${text}`); return Promise.resolve(); }
}
```

- [ ] **Step 4: `bot/sql/001_bot.sql`**

```sql
create schema if not exists bot;
create table if not exists bot.events_seen (event_id text primary key, at timestamptz not null default now());
create table if not exists bot.dialogs (dialog_id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists bot.state (key text primary key, value jsonb not null);
create table if not exists bot.cards (order_id bigint primary key, chat_id bigint not null, message_id bigint not null,
  status text not null, created_at timestamptz not null, dialog_id text, lang text not null, no int not null);
create table if not exists bot.awaits (chat_id bigint not null, prompt_id bigint not null, order_id bigint not null,
  kind text not null, to_status text not null, by_name text not null, primary key (chat_id, prompt_id));
create table if not exists bot.notices (order_id bigint not null, kind text not null, at timestamptz not null default now(),
  primary key (order_id, kind));
create table if not exists bot.journal (id bigserial primary key, at timestamptz not null default now(), kind text not null,
  dialog_id text, text text not null);
-- события «Узла» старше недели не повторяются (README «Узла»: доставленные хранятся неделю)
create index if not exists events_seen_at_idx on bot.events_seen (at);
```

- [ ] **Step 5: `bot/src/store_pg.ts`**

```ts
// Store на Postgres (общий сервер VPS, база bot). Запросы параметризованы; схема — sql/001_bot.sql.
import pg from "pg";
import type { DialogState } from "./types.ts";
import { type Await, type Card, FINAL, type Store } from "./store.ts";

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 4 }); }
  async migrate() {
    const sql = await Deno.readTextFile(new URL("../sql/001_bot.sql", import.meta.url));
    await this.pool.query(sql);
  }
  private q(text: string, params: unknown[] = []) { return this.pool.query(text, params); }
  async seenEvent(id: string) {
    const r = await this.q("insert into bot.events_seen (event_id) values ($1) on conflict do nothing", [id]);
    if (Math.random() < 0.01) await this.q("delete from bot.events_seen where at < now() - interval '8 days'");
    return r.rowCount === 1;
  }
  async getDialog(id: string) {
    const r = await this.q("select data from bot.dialogs where dialog_id = $1", [id]);
    return r.rows[0] ? r.rows[0].data as DialogState : null;
  }
  async saveDialog(d: DialogState) {
    await this.q(`insert into bot.dialogs (dialog_id, data, updated_at) values ($1, $2, now())
                  on conflict (dialog_id) do update set data = excluded.data, updated_at = now()`, [d.dialog_id, JSON.stringify(d)]);
  }
  async getState<T>(key: string) {
    const r = await this.q("select value from bot.state where key = $1", [key]);
    return r.rows[0] ? r.rows[0].value as T : null;
  }
  async setState(key: string, v: unknown) {
    await this.q("insert into bot.state (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(v)]);
  }
  async getCard(id: number) {
    const r = await this.q("select * from bot.cards where order_id = $1", [id]);
    return r.rows[0] ? this.card(r.rows[0]) : null;
  }
  async saveCard(c: Card) {
    await this.q(`insert into bot.cards (order_id, chat_id, message_id, status, created_at, dialog_id, lang, no) values ($1,$2,$3,$4,$5,$6,$7,$8)
                  on conflict (order_id) do update set status = excluded.status, message_id = excluded.message_id, chat_id = excluded.chat_id`,
      [c.order_id, c.chat_id, c.message_id, c.status, c.created_at, c.dialog_id, c.lang, c.no]);
  }
  async openCards() {
    const r = await this.q("select * from bot.cards where not (status = any($1)) and created_at > now() - interval '15 days'", [[...FINAL]]);
    return r.rows.map((x) => this.card(x));
  }
  private card(x: Record<string, unknown>): Card {
    return { order_id: Number(x.order_id), chat_id: Number(x.chat_id), message_id: Number(x.message_id), status: String(x.status),
      created_at: new Date(x.created_at as string).toISOString(), dialog_id: (x.dialog_id as string) ?? null, lang: x.lang as "ru" | "kz", no: Number(x.no) };
  }
  async setAwait(a: Await) {
    await this.q(`insert into bot.awaits (chat_id, prompt_id, order_id, kind, to_status, by_name) values ($1,$2,$3,$4,$5,$6)
                  on conflict do nothing`, [a.chat_id, a.prompt_id, a.order_id, a.kind, a.to, a.by_name]);
  }
  async takeAwait(chat: number, p: number) {
    const r = await this.q("delete from bot.awaits where chat_id = $1 and prompt_id = $2 returning *", [chat, p]);
    const x = r.rows[0];
    return x ? { chat_id: Number(x.chat_id), prompt_id: Number(x.prompt_id), order_id: Number(x.order_id), kind: x.kind, to: x.to_status, by_name: x.by_name } : null;
  }
  async noticeOnce(id: number, kind: string) {
    const r = await this.q("insert into bot.notices (order_id, kind) values ($1, $2) on conflict do nothing", [id, kind]);
    return r.rowCount === 1;
  }
  async journal(kind: string, d: string | null, text: string) {
    await this.q("insert into bot.journal (kind, dialog_id, text) values ($1, $2, $3)", [kind, d, text.slice(0, 2000)]);
  }
}
```

- [ ] **Step 6: Контракт на настоящем Postgres**

Добавить в конец `bot/tests/store.test.ts`:

```ts
Deno.test({ name: "store: PgStore выполняет контракт (BOT_TEST_DATABASE_URL)", ignore: !Deno.env.get("BOT_TEST_DATABASE_URL"), async fn() {
  const { PgStore } = await import("../src/store_pg.ts");
  const s = new PgStore(Deno.env.get("BOT_TEST_DATABASE_URL")!);
  await s.migrate();
  // чистая схема на каждый прогон: тестовая база, не боевая
  await (s as unknown as { q: (t: string) => Promise<unknown> }).q("truncate bot.events_seen, bot.dialogs, bot.state, bot.cards, bot.awaits, bot.notices, bot.journal");
  await storeContract(s);
}, sanitizeResources: false, sanitizeOps: false });
```

Run:
```bash
docker run -d --rm --name bot-test-pg -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17
cd bot && BOT_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres deno test --allow-env --allow-read --allow-net --allow-sys tests/store.test.ts
docker stop bot-test-pg
```
Expected: `2 passed`.

- [ ] **Step 7: Commit**

```bash
git add bot/src/store.ts bot/src/store_pg.ts bot/sql/001_bot.sql bot/tests/store.test.ts
git commit -m "Бот Енешки: хранилище — память и Postgres, схема bot"
```

---

### Task 3: «Узел» — подпись вебхука и клиент API

**Исполнитель:** openai/gpt-5.3-codex (подпись и сравнение за постоянное время — нужна точность); проверка — тесты ниже.

**Files:** Create `bot/src/uzel.ts`, `bot/tests/uzel.test.ts`

**Interfaces:**
- Produces: `verifyUzel(secret, ts, sig, raw, nowSec?) → Promise<boolean>`; `hmacHex(secret, data) → Promise<string>`;
  `interface UzelEvent`, `interface UzelMessage { id; direction: "in"|"out"; type; text: string|null; author: string|null; attachment: {kind: string}|null; occurredAt }`,
  `interface UzelDialog { id; chatId; contactName: string|null; assignedUserId: string|null; bot: {leading: boolean; paused: {kind: string; reason: string|null}|null} }`;
  `class UzelClient(base, key, f?)` с `getDialog(id)`, `messages(id, limit)`, `send(dialogId, text) → {ok: true, id} | {ok: false, code}`, `handoff(dialogId, reason)`, `registerWebhook(url) → secret`.

- [ ] **Step 1: Падающий тест `bot/tests/uzel.test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { hmacHex, UzelClient, verifyUzel } from "../src/uzel.ts";

const SECRET = "whsec_test";
const raw = '{"event":"message.in","eventId":"e1"}';

Deno.test("uzel: верная подпись принимается", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw, 1760600100), true);
});
Deno.test("uzel: подпись другого тела — отказ", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw + " ", 1760600100), false);
});
Deno.test("uzel: метка старше 5 минут — отказ", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw, 1760600301), false);
});
Deno.test("uzel: нет заголовков или пустой секрет — отказ", async () => {
  assertEquals(await verifyUzel(SECRET, null, null, raw), false);
  assertEquals(await verifyUzel("", "1", "sha256=00", raw, 1), false);
});

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const f = (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    const key = (init?.method || "GET") + " " + new URL(url).pathname;
    const [status, json] = (routes[key] || (() => [404, { error: "нет" }]))(body);
    return Promise.resolve(new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));
  };
  return { f, calls };
}

Deno.test("uzel: отправка — 202 и id; ключ в заголовке", async () => {
  const { f, calls } = fakeFetch({ "POST /v1/messages": () => [202, { data: { id: "m1", status: "queued", dialogId: "d1" } }] });
  const u = new UzelClient("https://uzel.example.kz", "uzel_k", f);
  assertEquals(await u.send("d1", "Здравствуйте"), { ok: true, id: "m1" });
  assertEquals(calls[0].auth, "Bearer uzel_k");
  assertEquals(calls[0].body, { dialogId: "d1", text: "Здравствуйте" });
});
Deno.test("uzel: диалог на паузе — код bot_paused, без исключения", async () => {
  const { f } = fakeFetch({ "POST /v1/messages": () => [409, { error: "диалог ведёт человек", code: "bot_paused" }] });
  const u = new UzelClient("https://uzel.example.kz", "k", f);
  assertEquals(await u.send("d1", "x"), { ok: false, code: "bot_paused" });
});
Deno.test("uzel: история и диалог читаются из data", async () => {
  const { f } = fakeFetch({
    "GET /v1/dialogs/d1": () => [200, { data: { id: "d1", chatId: "77011234567", contactName: "Айгуль", assignedUserId: null, bot: { leading: true, paused: null } } }],
    "GET /v1/dialogs/d1/messages": () => [200, { data: [{ id: "m2", direction: "in", type: "text", text: "пирог", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:00Z" }] }],
  });
  const u = new UzelClient("https://uzel.example.kz", "k", f);
  assertEquals((await u.getDialog("d1")).contactName, "Айгуль");
  assertEquals((await u.messages("d1", 20))[0].text, "пирог");
});
```

- [ ] **Step 2: Убедиться, что падает** — `deno task test` → FAIL (нет модуля).

- [ ] **Step 3: `bot/src/uzel.ts`**

```ts
// «Узел»: проверка подписи оповещений (README «Узла», «Оповещения (вебхук)») и клиент API по ключу-боту.
// Текст сообщений берётся только из API — в оповещении его нет.
import type { Fetch } from "./types.ts";

const enc = new TextEncoder();
export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export async function verifyUzel(secret: string, ts: string | null, sig: string | null, raw: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  return sameText("sha256=" + await hmacHex(secret, ts + "." + raw), sig);
}

export interface UzelEvent {
  event: string; eventId: string; ts: string; channelId: string | null; dialogId: string | null; messageId: string | null;
  author: string | null; status: string | null; bot: boolean | null; pauseKind: string | null; pauseReason: string | null;
}
export interface UzelMessage {
  id: string; direction: "in" | "out"; type: string; text: string | null; author: string | null;
  attachment: { kind: string } | null; occurredAt: string;
}
export interface UzelDialog {
  id: string; chatId: string; contactName: string | null; assignedUserId: string | null;
  bot: { leading: boolean; paused: { kind: string; reason: string | null } | null };
}

export class UzelClient {
  constructor(private base: string, private key: string, private f: Fetch = fetch) {}
  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.f(this.base + path, {
      method, headers: { authorization: "Bearer " + this.key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: Record<string, unknown> = {};
    try { json = await res.json(); } catch { /* пустой ответ */ }
    return { status: res.status, json };
  }
  async getDialog(id: string): Promise<UzelDialog> {
    const r = await this.req("GET", `/v1/dialogs/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new Error(`Узел: диалог ${r.status}`);
    return r.json.data as UzelDialog;
  }
  async messages(id: string, limit = 30): Promise<UzelMessage[]> {
    const r = await this.req("GET", `/v1/dialogs/${encodeURIComponent(id)}/messages?limit=${limit}`);
    if (r.status !== 200) throw new Error(`Узел: история ${r.status}`);
    return r.json.data as UzelMessage[];
  }
  async send(dialogId: string, text: string): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
    const r = await this.req("POST", "/v1/messages", { dialogId, text });
    if (r.status === 202) return { ok: true, id: String((r.json.data as Record<string, unknown>).id) };
    return { ok: false, code: String(r.json.code ?? r.status) };
  }
  async handoff(dialogId: string, reason: string): Promise<boolean> {
    const r = await this.req("POST", `/v1/dialogs/${encodeURIComponent(dialogId)}/handoff`, { reason: reason.slice(0, 500) });
    return r.status === 200;
  }
  async registerWebhook(url: string): Promise<string> {
    const r = await this.req("POST", "/v1/webhook", { url });
    if (r.status !== 201) throw new Error(`Узел: вебхук не принят (${r.status}): ${String(r.json.error ?? "")}`);
    return String((r.json.data as Record<string, unknown>).secret);
  }
}
```

- [ ] **Step 4: Тесты** — `deno task test` → все `uzel:` проходят.
- [ ] **Step 5: Commit** — `git add bot/src/uzel.ts bot/tests/uzel.test.ts && git commit -m "Бот Енешки: подпись вебхука и клиент «Узла»"`

---

### Task 4: Клиент учёта

**Исполнитель:** gemini; проверка — тесты.

**Files:** Create `bot/src/uchet.ts`, `bot/tests/uchet.test.ts`

**Interfaces:**
- Produces: `class Uchet(url, key, f?, now?)`: `menu(): Promise<Menu>` (кэш 60 с; при сбое — прежний кэш),
  `quote(p): Promise<Ans<{quote: Quote}>>`, `create(p): Promise<Ans<{order: Order; repeat?: boolean}>>`,
  `events(after, limit): Promise<{events: OrderEvent[]; last: number}>`, `get(id)`, `cancel(id, reason)`,
  `cardStatus(orderId, to, byName, extra): Promise<Ans<{order: Order}>>`, `history(phone)`;
  `type Ans<T> = ({ok: true} & T) | {ok: false; error: string; message?: string; order?: Order}`.

- [ ] **Step 1: Падающий тест `bot/tests/uchet.test.ts`**

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { Uchet } from "../src/uchet.ts";

function gate(handler: (action: string, payload: Record<string, unknown>) => unknown) {
  const calls: { action: string; payload: Record<string, unknown> }[] = [];
  const f = (_url: string, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    calls.push(b);
    return Promise.resolve(new Response(JSON.stringify(handler(b.action, b.payload)), { status: 200 }));
  };
  return { f, calls };
}

Deno.test("uchet: ключ бота в каждом вызове", async () => {
  const { f, calls } = gate(() => ({ ok: true, quote: { total: 1 } }));
  await new Uchet("https://u", "botkey", f).quote({ kind: "pickup" });
  assertEquals(calls[0].action, "bot_order_quote");
  assertEquals(calls[0].payload.service_key, "botkey");
});
Deno.test("uchet: меню кэшируется на минуту", async () => {
  let t = 0, n = 0;
  const { f } = gate(() => { n++; return { ok: true, now: "x", settings: {}, points: [], items: [] }; });
  const u = new Uchet("https://u", "k", f, () => t);
  await u.menu(); await u.menu(); t = 61_000; await u.menu();
  assertEquals(n, 2);
});
Deno.test("uchet: учёт упал — отдаём прежнее меню", async () => {
  let t = 0, down = false;
  const f = (_u: string, _i?: RequestInit) => down ? Promise.reject(new Error("net"))
    : Promise.resolve(new Response(JSON.stringify({ ok: true, now: "x", settings: { a: "1" }, points: [], items: [] })));
  const u = new Uchet("https://u", "k", f, () => t);
  await u.menu(); down = true; t = 120_000;
  assertEquals((await u.menu()).settings.a, "1");
});
Deno.test("uchet: учёт упал и кэша нет — исключение", async () => {
  const u = new Uchet("https://u", "k", () => Promise.reject(new Error("net")));
  await assertRejects(() => u.menu());
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: `bot/src/uchet.ts`**

```ts
// Учёт Тандема: служебные действия bot_* через tandem_gate (часть A). Ключ — ключ бота (settings.bot_key_hash).
import type { Fetch, Menu, Order, OrderEvent, Quote } from "./types.ts";

export type Ans<T> = ({ ok: true } & T) | { ok: false; error: string; message?: string; order?: Order };

export class Uchet {
  private cache: { at: number; menu: Menu } | null = null;
  constructor(private url: string, private key: string, private f: Fetch = fetch, private now: () => number = Date.now) {}
  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await this.f(this.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload: { ...payload, service_key: this.key } }) });
    if (res.status >= 500) throw new Error(`учёт: ${res.status}`);
    return await res.json() as T;
  }
  async menu(): Promise<Menu> {
    if (this.cache && this.now() - this.cache.at < 60_000) return this.cache.menu;
    try {
      const r = await this.call<Menu & { ok: boolean; error?: string }>("bot_menu");
      if (!r.ok) throw new Error("учёт: меню — " + (r.error ?? "отказ"));
      this.cache = { at: this.now(), menu: r };
      return r;
    } catch (e) {
      if (this.cache) return this.cache.menu;
      throw e;
    }
  }
  quote(p: Record<string, unknown>) { return this.call<Ans<{ quote: Quote }>>("bot_order_quote", p); }
  create(p: Record<string, unknown>) { return this.call<Ans<{ order: Order; repeat?: boolean }>>("bot_order_create", p); }
  events(after: number, limit = 200) { return this.call<{ ok: boolean; events: OrderEvent[]; last: number }>("bot_order_events", { after, limit }); }
  get(id: number) { return this.call<Ans<{ order: Order }>>("bot_order_get", { id }); }
  cancel(id: number, reason: string) { return this.call<Ans<{ order: Order }>>("bot_order_cancel", { id, reason }); }
  cardStatus(order_id: number, to: string, by_name: string, extra: Record<string, unknown> = {}) {
    return this.call<Ans<{ order: Order }>>("bot_card_status", { order_id, to, by_name, ...extra });
  }
  history(phone: string) { return this.call<{ ok: boolean; name: string | null; lang: string | null; addresses: string[] }>("bot_client_history", { phone }); }
}
```

- [ ] **Step 4: Тесты зелёные.** - [ ] **Step 5: Commit** — `git commit -m "Бот Енешки: клиент учёта с кэшем меню"`

---

### Task 5: Меню, правила, корзина, телефон, язык

**Исполнитель:** gemini; проверка — тесты.

**Files:** Create `bot/src/menu.ts`, `bot/tests/menu.test.ts`

**Interfaces:**
- Produces: `menuText(menu: Menu): string`; `rulesText(menu: Menu): string`; `findItem(menu, code): MenuItem | null`;
  `cartCheck(item: MenuItem, qty: number): string | null`; `phoneFromChat(chatId): string | null`; `maskPhone(p): string`;
  `detectLang(text): Lang | null`; `money(n): string`; `qtyText(n): string`; `inHours(menu, now: Date): boolean`; `localNow(now: Date): string`.

- [ ] **Step 1: Падающий тест `bot/tests/menu.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { cartCheck, detectLang, inHours, maskPhone, menuText, money, phoneFromChat, rulesText } from "../src/menu.ts";
import { MENU } from "./fakes.ts";

Deno.test("menu: текст меню с кодом, ценой, единицей, сроком и стопом", () => {
  const t = menuText(MENU);
  assert(t.includes("[P1] Пирог с мясом — 4 550 ₸ за кг"));
  assert(t.includes("от 1 кг, шаг 0,5"));
  assert(t.includes("печём под заказ"));
  assert(t.includes("Етті бәліш"));
  assert(t.includes("[B1] Беляш") && t.includes("стоп"));
});
Deno.test("menu: правила из настроек", () => {
  const t = rulesText(MENU);
  assert(t.includes("до 12:00") && t.includes("к 18:00") && t.includes("7 000 ₸") && t.includes("Енешка"));
});
Deno.test("menu: проверка строки корзины", () => {
  const p = MENU.items[0];
  assertEquals(cartCheck(p, 1.5), null);
  assert(cartCheck(p, 0.5)!.includes("Минимум"));
  assert(cartCheck(p, 1.3)!.includes("шагом"));
  assert(cartCheck(MENU.items[1], 2.5)!.includes("целым"));
  assert(cartCheck(MENU.items[1], 3)!.includes("нет"));
});
Deno.test("menu: телефон из chatId и маска", () => {
  assertEquals(phoneFromChat("77011234567"), "77011234567");
  assertEquals(phoneFromChat("123"), null);
  assertEquals(maskPhone("77011234567"), "+7 701 *** ** 67");
});
Deno.test("menu: язык по буквам", () => {
  assertEquals(detectLang("Сәлеметсіз бе, бәліш керек"), "kz");
  assertEquals(detectLang("Здравствуйте, пирог нужен"), "ru");
  assertEquals(detectLang("👍"), null);
});
Deno.test("menu: деньги и часы приёма", () => {
  assertEquals(money(19300), "19 300 ₸");
  assertEquals(inHours(MENU, new Date("2026-10-17T05:00:00Z")), true);   // 10:00 по UTC+5
  assertEquals(inHours(MENU, new Date("2026-10-17T15:00:00Z")), false);  // 20:00
});
```

- [ ] **Step 2: Подделки `bot/tests/fakes.ts`** (меню — общее для всех тестов; остальные подделки добавляются в задачах 7–10)

```ts
import type { Menu } from "../src/types.ts";

export const MENU: Menu = {
  now: "2026-10-17T10:00",
  settings: { client_hours_from: "09:00", client_hours_to: "18:00", client_fresh_cutoff: "12:00", client_fresh_ready: "18:00",
    stock_ready_minutes: "120", client_min_order: "7000", client_max_days_ahead: "14", client_pickup_points: "eneshka",
    client_prepay_rule: "off", client_confirm_remind_min: "15", client_confirm_client_notice_min: "30",
    kaspi_details_ru: "Kaspi: +7 775 000 00 00, Светлана Г.", kaspi_details_kz: "Kaspi: +7 775 000 00 00, Светлана Г.", couriers: "Ерлан" },
  points: [{ id: "eneshka", name: "Енешка, Караганды 74/2" }],
  items: [
    { item_code: "P1", title_ru: "Пирог с мясом", title_kz: "Етті бәліш", composition_ru: "говядина, картофель, лук", composition_kz: null,
      unit_label: "кг", price: 4550, min_qty: 1, step: 0.5, section: "Татарские пироги", ready_kind: "fresh", stopped: false, stop_until: null,
      sort_order: 1, active: true, checked: true },
    { item_code: "B1", title_ru: "Беляш", title_kz: "Беляш", composition_ru: null, composition_kz: null, unit_label: "шт", price: 500,
      min_qty: 2, step: 1, section: "Выпечка", ready_kind: "stock", stopped: true, stop_until: "2026-10-17", sort_order: 2, active: true, checked: true },
    { item_code: "M1", title_ru: "Манты с говядиной", title_kz: "Сиыр етінен манты", composition_ru: null, composition_kz: null, unit_label: "кг",
      price: 4400, min_qty: 1, step: 0.5, section: "Полуфабрикаты", ready_kind: "stock", stopped: false, stop_until: null, sort_order: 3, active: true, checked: true },
    { item_code: "S1", title_ru: "Сет «Чайный дастархан»", title_kz: "«Шай дастарханы» сеті", composition_ru: "пироги и выпечка к чаю", composition_kz: null,
      unit_label: "сет", price: 19300, min_qty: 1, step: 1, section: "Сеты", ready_kind: "fresh", stopped: false, stop_until: null, sort_order: 4, active: true, checked: true },
  ],
};
```

- [ ] **Step 3: Убедиться, что падает.**

- [ ] **Step 4: `bot/src/menu.ts`**

```ts
// Меню и правила для системной части, проверка строки корзины (окончательно проверяет учёт), телефон, язык.
import type { Lang, Menu, MenuItem } from "./types.ts";

export const money = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ") + " ₸";
export const qtyText = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");
const READY = { fresh: "печём под заказ", stock: "с витрины или из морозилки" };

export function menuText(menu: Menu): string {
  const out: string[] = [];
  let section = "";
  for (const it of menu.items) {
    if (it.section !== section) { section = it.section; out.push(`\n## ${section}`); }
    const unit = it.unit_label === "кг" ? "кг" : it.unit_label;
    out.push(`• [${it.item_code}] ${it.title_ru} — ${money(it.price)} за ${unit}` +
      (it.title_kz ? ` (каз.: ${it.title_kz})` : "") +
      `; от ${qtyText(it.min_qty)} ${unit}, шаг ${qtyText(it.step)}; ${READY[it.ready_kind]}` +
      (it.composition_ru ? `; состав: ${it.composition_ru}` : "") +
      (it.stopped ? `; стоп до ${it.stop_until} — на эти даты нет` : ""));
  }
  return out.join("\n").trim();
}

export function rulesText(menu: Menu): string {
  const s = menu.settings;
  return [
    `Часы приёма и готовности: с ${s.client_hours_from} до ${s.client_hours_to} (время Темиртау, UTC+5).`,
    `Свежие пироги и сеты «печём под заказ»: на сегодня — если заказ до ${s.client_fresh_cutoff}, готовность к ${s.client_fresh_ready}; позже — на завтра и дальше.`,
    `«С витрины»: сегодня — не раньше чем через ${s.stock_ready_minutes} минут, в часы приёма.`,
    `Заказ вперёд — не дальше ${s.client_max_days_ahead} дней.`,
    `Доставка по Темиртау бесплатная, от ${money(Number(s.client_min_order))}. Меньше — только самовывоз.`,
    `Самовывоз: ${menu.points.map((p) => `[${p.id}] ${p.name}`).join("; ")}.`,
    `Оплата при получении: наличные, Kaspi QR, перевод, карта.`,
  ].join("\n");
}

export const findItem = (menu: Menu, code: string): MenuItem | null => menu.items.find((x) => x.item_code === code) ?? null;

export function cartCheck(it: MenuItem, qty: number): string | null {
  if (!(qty > 0)) return `Количество «${it.title_ru}» — больше нуля`;
  if (it.stopped) return `«${it.title_ru}» сейчас нет (стоп до ${it.stop_until})`;
  if (it.unit_label !== "кг" && qty !== Math.trunc(qty)) return `«${it.title_ru}» — только целым числом`;
  if (qty < it.min_qty) return `Минимум «${it.title_ru}» — ${qtyText(it.min_qty)} ${it.unit_label}`;
  const k = (qty - it.min_qty) / it.step;
  if (Math.abs(Math.round(k) - k) > 1e-6) return `«${it.title_ru}» — шагом ${qtyText(it.step)} ${it.unit_label} от ${qtyText(it.min_qty)}`;
  return null;
}

export function phoneFromChat(chatId: string): string | null {
  const d = String(chatId).replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}
export function maskPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  return d.length === 11 ? `+${d[0]} ${d.slice(1, 4)} *** ** ${d.slice(9)}` : "+***" + d.slice(-2);
}
export function detectLang(text: string): Lang | null {
  if (/[әғқңөұүһі]/i.test(text)) return "kz";
  if (/[а-яё]/i.test(text)) return "ru";
  return null;
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
export function localNow(now: Date): string {
  return new Date(now.getTime() + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}
export function inHours(menu: Menu, now: Date): boolean {
  const l = new Date(now.getTime() + 5 * 3600e3);
  const m = l.getUTCHours() * 60 + l.getUTCMinutes();
  return m >= hm(menu.settings.client_hours_from) && m < hm(menu.settings.client_hours_to);
}
```

- [ ] **Step 5: Тесты зелёные.** - [ ] **Step 6: Commit** — `git commit -m "Бот Енешки: меню, правила, корзина, телефон, язык"`

---

### Task 6: Шаблоны сообщений ru/kz

**Исполнитель:** Claude пишет русские тексты (ниже); казахские — черновик gemini, сверка платной моделью
(`ask_model`, provider openai, около $0,01 — в списке расходов Task 14, до согласия — только черновик).

**Files:** Create `bot/src/templates.ts`, `bot/tests/templates.test.ts`

**Interfaces:**
- Produces: `summaryText(q: Quote, lang, name): string`; `submittedText(no, lang, inHours, from): string`;
  `statusText(o: Order, settings): string | null` (для `confirmed`, `awaiting_prepay`, `paid`, `on_the_way`, `awaiting_pickup`, `rejected`, `cancelled`);
  `soonText(o: Order): string`; `handoffText(lang, kind: "complaint"|"voice"|"human"|"failed"): string`.

- [ ] **Step 1: Падающий тест `bot/tests/templates.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { statusText, submittedText, summaryText } from "../src/templates.ts";
import type { Order, Quote } from "../src/types.ts";
import { MENU } from "./fakes.ts";

const q: Quote = { point_id: "eneshka", point_name: "Енешка, Караганды 74/2", kind: "delivery", for_date: "2026-10-18", ready_by: "18:00",
  address: "ул. Мира 12, кв 5", total: 9300, delivery_fee: 0, prepay_suggested: false,
  lines: [{ item_code: "P1", title: "Пирог с мясом", title_kz: "Етті бәліш", unit: "кг", qty: 1.5, price: 4550, sum: 6825 },
          { item_code: "M1", title: "Манты с говядиной", title_kz: null, unit: "кг", qty: 0.5, price: 4950, sum: 2475 }] };
const o = { id: 1, no: 12, lang: "ru", client_name: "Айгуль", kind: "delivery", for_date: "2026-10-18", ready_by: "18:00", total: 9300,
  point_name: "Енешка, Караганды 74/2", reason: null } as unknown as Order;

Deno.test("шаблоны: итог по-русски — позиции, сумма, доставка, дата, вопрос", () => {
  const t = summaryText(q, "ru", "Айгуль");
  for (const s of ["Айгуль", "Пирог с мясом — 1,5 кг", "6 825 ₸", "Итого: 9 300 ₸", "доставка бесплатно", "18.10", "18:00", "ул. Мира 12", "Всё верно?"]) assert(t.includes(s), s);
});
Deno.test("шаблоны: итог по-казахски — казахское название, где есть", () => {
  const t = summaryText(q, "kz", "Айгүл");
  assert(t.includes("Етті бәліш") && t.includes("Манты с говядиной") && t.includes("9 300 ₸"));
});
Deno.test("шаблоны: статусы содержат номер заказа и имя — тексты разные у разных клиентов", () => {
  const c = { ...o, status: "confirmed" } as Order;
  const a = statusText(c, MENU.settings)!, b = statusText({ ...c, no: 13, client_name: "Ерлан" }, MENU.settings)!;
  assert(a.includes("№12") && a.includes("Айгуль"));
  assert(a !== b);
});
Deno.test("шаблоны: предоплата — реквизиты из настроек", () => {
  assert(statusText({ ...o, status: "awaiting_prepay" }, MENU.settings)!.includes("Kaspi: +7 775 000 00 00"));
});
Deno.test("шаблоны: отказ и отмена — с причиной", () => {
  assert(statusText({ ...o, status: "rejected", reason: "нет начинки" }, MENU.settings)!.includes("нет начинки"));
});
Deno.test("шаблоны: внутренние статусы клиенту не пишутся", () => {
  assertEquals(statusText({ ...o, status: "cooking" }, MENU.settings), null);
});
Deno.test("шаблоны: «передал продавцу» вне часов — подтвердим утром", () => {
  assert(submittedText(12, "ru", false, "09:00").includes("утром"));
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: `bot/src/templates.ts`**

```ts
// Шаблоны сообщений клиенту. Ключевые фразы модель не пересказывает: их шлют инструменты и наблюдатель.
// Номер заказа и имя в каждом статусном шаблоне — тексты разные, правило «Узла» «один текст не больше
// 5 клиентам в час» их не задерживает. Казахские тексты сверены платной моделью (Task 6, Step 5).
import type { Lang, Order, Quote } from "./types.ts";
import { money, qtyText } from "./menu.ts";

const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);
const hello = (lang: Lang, name: string | null) => name ? (lang === "kz" ? `${name}, ` : `${name}, `) : "";

export function summaryText(q: Quote, lang: Lang, name: string | null): string {
  const lines = q.lines.map((l) => `• ${(lang === "kz" && l.title_kz) || l.title} — ${qtyText(l.qty)} ${l.unit} × ${money(l.price)} = ${money(l.sum)}`);
  if (lang === "kz") {
    return [`${hello(lang, name)}тапсырысты тексеріңіз:`, ...lines, `Барлығы: ${money(q.total)}`,
      q.kind === "delivery" ? `Жеткізу тегін: ${q.address}` : `Өзіңіз алып кетесіз: ${q.point_name}`,
      `${dm(q.for_date)}, ${q.ready_by}-ге дайын болады.`, "Бәрі дұрыс па?"].join("\n");
  }
  return [`${hello(lang, name)}проверьте заказ:`, ...lines, `Итого: ${money(q.total)}`,
    q.kind === "delivery" ? `Доставка бесплатно: ${q.address}` : `Самовывоз: ${q.point_name}`,
    `Готово ${dm(q.for_date)} к ${q.ready_by}.`, "Всё верно?"].join("\n");
}

export function submittedText(no: number, lang: Lang, inHours: boolean, from: string): string {
  if (lang === "kz") return inHours
    ? `Тапсырыс №${no} сатушыға жіберілді, 15 минут ішінде растаймыз.`
    : `Тапсырыс №${no} қабылданды. Таңертең ${from}-ден бастап растаймыз.`;
  return inHours ? `Заказ №${no} передал продавцу, подтвердим в течение 15 минут.`
    : `Заказ №${no} записал. Подтвердим утром, с ${from}.`;
}

export function statusText(o: Order, s: Record<string, string>): string | null {
  const n = o.client_name ? `${o.client_name}, ` : "";
  const kz = o.lang === "kz";
  const when = `${dm(o.for_date)} ${o.ready_by}`;
  switch (o.status) {
    case "confirmed": return kz ? `${n}тапсырыс №${o.no} расталды: ${when}, ${money(o.total)}. Рахмет!`
      : `${n}заказ №${o.no} подтверждён: ${when}, ${money(o.total)}. Спасибо!`;
    case "awaiting_prepay": return kz ? `${n}тапсырыс №${o.no} расталды. Пісіруді бастау үшін алдын ала төлем: ${money(o.total)}.\n${s.kaspi_details_kz || s.kaspi_details_ru}\nТөлеген соң хабарлаңыз.`
      : `${n}заказ №${o.no} подтверждён. Чтобы начать печь, нужна предоплата ${money(o.total)}.\n${s.kaspi_details_ru}\nПосле оплаты напишите, пожалуйста.`;
    case "paid": return kz ? `${n}№${o.no} төлем келді, ${when} дайын болады.` : `${n}оплата по заказу №${o.no} пришла, готово будет ${when}.`;
    case "on_the_way": return kz ? `${n}№${o.no} тапсырыс жолда, курьер жақын арада жетеді.` : `${n}заказ №${o.no} в пути, курьер скоро будет.`;
    case "awaiting_pickup": return kz ? `${n}№${o.no} тапсырыс дайын, алып кетуге болады: ${o.point_name}.` : `${n}заказ №${o.no} готов, можно забирать: ${o.point_name}.`;
    case "rejected": return kz ? `${n}кешіріңіз, №${o.no} тапсырысты орындай алмаймыз: ${o.reason}.` : `${n}к сожалению, заказ №${o.no} выполнить не сможем: ${o.reason}.`;
    case "cancelled": return kz ? `${n}№${o.no} тапсырыс тоқтатылды: ${o.reason}.` : `${n}заказ №${o.no} отменён: ${o.reason}.`;
    default: return null;
  }
}

export function soonText(o: Order): string {
  return o.lang === "kz" ? `${o.client_name ? o.client_name + ", " : ""}№${o.no} тапсырысты сатушы жақын арада растайды.`
    : `${o.client_name ? o.client_name + ", " : ""}продавец скоро подтвердит заказ №${o.no}.`;
}

export function handoffText(lang: Lang, kind: "complaint" | "voice" | "human" | "failed"): string {
  const ru = { complaint: "Простите, пожалуйста. Передаю продавцу — ответит здесь же.", voice: "Голосовые и фото пока не разбираю — передаю продавцу, он ответит здесь же.",
    human: "Передаю продавцу — ответит здесь же.", failed: "Передаю продавцу, чтобы ничего не напутать, — ответит здесь же." };
  const kz = { complaint: "Кешіріңіз. Сатушыға жіберемін — осында жауап береді.", voice: "Дауыстық хабар мен суретті әзірге түсінбеймін — сатушыға жіберемін.",
    human: "Сатушыға жіберемін — осында жауап береді.", failed: "Қателеспеу үшін сатушыға жіберемін — осында жауап береді." };
  return (lang === "kz" ? kz : ru)[kind];
}
```

- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Сверка казахских текстов** (после «да» Андрея на расход): все казахские строки файла одним
  `ask_model` (provider openai, note «вычитка казахских шаблонов бота Енешки», project «Учет для Тандема»)
  с просьбой исправить грамматику и стиль вежливого обращения к клиенту, сохранив `${…}`; правки внести, тесты прогнать снова.
- [ ] **Step 6: Commit** — `git commit -m "Бот Енешки: шаблоны сообщений ru/kz"`

---

### Task 7: Инструменты модели и ход разговора

**Исполнитель:** Claude-субагент (поведение бота и защита от выдумки — суждение); ревью — `verify_answer`
(deepseek-chat, qwen, gemini; судья openai; `max_tokens` 8000), находки проверять запуском.

**Files:** Create `bot/src/tools.ts`, `bot/src/dialog.ts`, `bot/tests/dialog.test.ts`; Modify `bot/tests/fakes.ts`

**Interfaces:**
- Consumes: `Uchet` (Task 4), `UzelClient.send/handoff` (Task 3), `Store` (Task 2), `menu.ts`, `templates.ts`.
- Produces: `interface ModelClient { create(p: Record<string, unknown>): Promise<{ content: Block[]; stop_reason: string; usage?: Record<string, number> }> }`;
  `type Block = {type: "text"; text: string} | {type: "tool_use"; id: string; name: string; input: Record<string, unknown>} | {type: string; [k: string]: unknown}`;
  `interface Deps { uchet: Pick<Uchet, "menu"|"quote"|"create">; uzel: { send(d, t): Promise<{ok: boolean; code?: string}>; handoff(d, r): Promise<boolean> }; store: Store; model: ModelClient; modelName: string; now(): Date; uuid(): string }`;
  `TOOLS` (определения); `runTool(deps, st: DialogState, menu: Menu, name, input, ctx: {clientAfterSummary: boolean}) → Promise<{result: string; stop?: boolean}>`;
  `handleTurn(deps, st: DialogState, clientText: string, clientAfterSummary: boolean) → Promise<DialogState>`; `SYSTEM_RULES`.

- [ ] **Step 1: Подделки** — дописать в `bot/tests/fakes.ts`:

```ts
import type { Deps, ModelClient } from "../src/dialog.ts";
import { MemStore } from "../src/store.ts";
import type { DialogState, Order, Quote } from "../src/types.ts";

export class FakeUzel {
  sent: { dialogId: string; text: string }[] = []; handoffs: { dialogId: string; reason: string }[] = []; paused = false;
  send(dialogId: string, text: string) { if (this.paused) return Promise.resolve({ ok: false as const, code: "bot_paused" });
    this.sent.push({ dialogId, text }); return Promise.resolve({ ok: true as const, id: "m" + this.sent.length }); }
  handoff(dialogId: string, reason: string) { this.handoffs.push({ dialogId, reason }); return Promise.resolve(true); }
}
export class FakeUchet {
  quotes: Record<string, unknown>[] = []; creates: Record<string, unknown>[] = []; quoteAnswer: unknown = null; no = 11;
  menu() { return Promise.resolve(MENU); }
  quote(p: Record<string, unknown>) {
    this.quotes.push(p);
    if (this.quoteAnswer) return Promise.resolve(this.quoteAnswer as never);
    const lines = (p.lines as { item_code: string; qty: number }[]).map((l) => { const it = MENU.items.find((x) => x.item_code === l.item_code)!;
      return { item_code: l.item_code, title: it.title_ru, title_kz: it.title_kz, unit: it.unit_label, qty: l.qty, price: it.price, sum: l.qty * it.price }; });
    const q: Quote = { point_id: "eneshka", point_name: MENU.points[0].name, kind: p.kind as "pickup", for_date: String(p.for_date), ready_by: String(p.ready_by),
      address: (p.address as string) ?? null, lines, total: lines.reduce((s, l) => s + l.sum, 0), delivery_fee: 0, prepay_suggested: false };
    return Promise.resolve({ ok: true as const, quote: q });
  }
  create(p: Record<string, unknown>) { this.creates.push(p); this.no++;
    return Promise.resolve({ ok: true as const, order: { id: 100 + this.no, no: this.no, uid: p.uid } as unknown as Order }); }
}
// Модель по сценарию: каждый вызов отдаёт следующий заготовленный ответ и запоминает запрос.
export class ScriptModel implements ModelClient {
  requests: Record<string, unknown>[] = [];
  constructor(private steps: { content: unknown[]; stop_reason: string }[]) {}
  create(p: Record<string, unknown>) { this.requests.push(structuredClone(p)); const s = this.steps.shift();
    if (!s) throw new Error("сценарий модели кончился"); return Promise.resolve(s as never); }
}
export const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
export const text = (t: string) => ({ type: "text", text: t });
export function newDialog(): DialogState {
  return { dialog_id: "d1", phone: "77011234567", name: "Айгуль", lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat",
    summary_sent_at: null, draft_uid: "11111111-1111-4111-8111-111111111111", last_order_no: null, last_client_msg_id: null, last_activity: "2026-10-17T05:00:00.000Z" };
}
export function deps(model: ModelClient, uchet = new FakeUchet(), uzel = new FakeUzel()): Deps & { uchetF: FakeUchet; uzelF: FakeUzel; storeM: MemStore } {
  const store = new MemStore();
  return { uchet, uzel, store, model, modelName: "claude-sonnet-5-5", now: () => new Date("2026-10-17T05:00:00Z"),
    uuid: () => crypto.randomUUID(), uchetF: uchet, uzelF: uzel, storeM: store };
}
```

- [ ] **Step 2: Падающие тесты `bot/tests/dialog.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { handleTurn } from "../src/dialog.ts";
import { deps, newDialog, ScriptModel, text, tool } from "./fakes.ts";

const details = { kind: "pickup", for_date: "2026-10-18", ready_by: "12:00", address: null, client_name: "Айгуль", point_id: null };

Deno.test("разговор: простой ответ модели уходит клиенту, история только дописывается", async () => {
  const m = new ScriptModel([{ content: [text("Здравствуйте! Что желаете?")], stop_reason: "end_turn" }]);
  const d = deps(m);
  const st = await handleTurn(d, newDialog(), "привет", false);
  assertEquals(d.uzelF.sent.map((x) => x.text), ["Здравствуйте! Что желаете?"]);
  assertEquals(st.convo.length, 3);   // user, system (время и корзина), assistant
  assertEquals((st.convo[1] as { role: string }).role, "system");
});

Deno.test("разговор: запрос к модели — Sonnet 5.5, низкий effort, fallbacks, кэш системной части, strict-инструменты", async () => {
  const m = new ScriptModel([{ content: [text("ок")], stop_reason: "end_turn" }]);
  await handleTurn(deps(m), newDialog(), "привет", false);
  const r = m.requests[0] as Record<string, any>;
  assertEquals(r.model, "claude-sonnet-5-5");
  assertEquals(r.output_config, { effort: "low" });
  assertEquals(r.fallbacks, "default");
  assertEquals(r.betas, ["server-side-fallback-2026-07-01"]);
  assert(r.tool_choice === undefined);
  assert(r.system[0].cache_control && r.system[0].text.includes("[P1] Пирог с мясом"));
  assert(r.tools.every((t: { strict: boolean }) => t.strict === true));
});

Deno.test("разговор: корзина, детали, итог — итог уходит шаблоном с суммой учёта, этап «ждём да»", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "cart_set", { item_code: "P1", qty: 1.5 }), tool("t2", "order_details", details)], stop_reason: "tool_use" },
    { content: [tool("t3", "order_summary", {})], stop_reason: "tool_use" },
    { content: [], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st = await handleTurn(d, newDialog(), "пирог с мясом полтора кило на завтра к 12, заберу сама", false);
  assertEquals(st.stage, "awaiting_yes");
  assertEquals(d.uzelF.sent.length, 1);
  assert(d.uzelF.sent[0].text.includes("Итого: 6 825 ₸") && d.uzelF.sent[0].text.includes("Всё верно?"));
  assertEquals(d.uchetF.quotes[0].lines, [{ item_code: "P1", qty: 1.5 }]);
});

Deno.test("разговор: неверное количество — инструмент отвечает ошибкой, корзина не меняется", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "cart_set", { item_code: "P1", qty: 1.3 })], stop_reason: "tool_use" },
    { content: [text("Пироги — шагом полкило: 1 или 1,5 кг?")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st = await handleTurn(d, newDialog(), "1.3 кг", false);
  assertEquals(st.cart, []);
  const res = JSON.stringify(m.requests[1].messages);
  assert(res.includes("шагом"));
});

Deno.test("разговор: позиции нет в меню — ошибка инструмента, без выдумки", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "cart_set", { item_code: "X9", qty: 1 })], stop_reason: "tool_use" },
    { content: [text("Такого нет, могу предложить…")], stop_reason: "end_turn" },
  ]);
  const st = await handleTurn(deps(m), newDialog(), "пиццу", false);
  assertEquals(st.cart, []);
  assert(JSON.stringify(m.requests[1].messages).includes("нет в меню"));
});

Deno.test("разговор: order_submit без «да» после итога — отказ инструмента", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "order_submit", {})], stop_reason: "tool_use" },
    { content: [text("Сначала проверьте итог")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st0 = { ...newDialog(), stage: "awaiting_yes" as const, summary_sent_at: "2026-10-17T05:00:00.000Z", cart: [{ item_code: "P1", qty: 1.5 }], details: { kind: "pickup" as const, for_date: "2026-10-18", ready_by: "12:00" } };
  await handleTurn(d, st0, "а можно ещё манты?", false);
  assertEquals(d.uchetF.creates.length, 0);
});

Deno.test("разговор: «да» после итога — заказ в учёте с uid черновика, клиенту «передал продавцу», новый черновик", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "order_submit", {})], stop_reason: "tool_use" },
    { content: [], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st0 = { ...newDialog(), stage: "awaiting_yes" as const, summary_sent_at: "2026-10-17T04:59:00.000Z", cart: [{ item_code: "P1", qty: 1.5 }],
    details: { kind: "pickup" as const, for_date: "2026-10-18", ready_by: "12:00", client_name: "Айгуль" } };
  const st = await handleTurn(d, st0, "да", true);
  assertEquals(d.uchetF.creates.length, 1);
  assertEquals(d.uchetF.creates[0].uid, st0.draft_uid);
  assertEquals(d.uchetF.creates[0].client_phone, "77011234567");
  assertEquals(d.uchetF.creates[0].uzel_dialog_id, "d1");
  assert(d.uzelF.sent[0].text.includes("№12"));
  assertEquals(st.stage, "submitted");
  assertEquals(st.cart, []);
  assert(st.draft_uid !== st0.draft_uid);
});

Deno.test("разговор: реплика после итога дописывается к результату инструмента — без двух user подряд", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "order_summary", {})], stop_reason: "tool_use" },
    { content: [tool("t2", "order_submit", {})], stop_reason: "tool_use" },
  ]);
  const d = deps(m);
  const st0 = { ...newDialog(), cart: [{ item_code: "P1", qty: 1.5 }], details: { kind: "pickup" as const, for_date: "2026-10-18", ready_by: "12:00" } };
  const st1 = await handleTurn(d, st0, "всё, оформляйте", false);
  await handleTurn(d, st1, "да", true);
  const msgs = m.requests[1].messages as { role: string }[];
  for (let i = 1; i < msgs.length; i++) assert(!(msgs[i].role === "user" && msgs[i - 1].role === "user"), "два user подряд");
  assertEquals(d.uchetF.creates.length, 1);
});

Deno.test("разговор: учёт отказал по окну — этап снова «чат», модель получает причину", async () => {
  const u = deps(new ScriptModel([
    { content: [tool("t1", "order_summary", {})], stop_reason: "tool_use" },
    { content: [text("На сегодня уже поздно, давайте на завтра?")], stop_reason: "end_turn" },
  ]));
  u.uchetF.quoteAnswer = { ok: false, error: "slot", message: "Свежие пироги на сегодня — заказ до 12:00" };
  const st0 = { ...newDialog(), cart: [{ item_code: "P1", qty: 1 }], details: { kind: "pickup" as const, for_date: "2026-10-17", ready_by: "18:00" } };
  const st = await handleTurn(u, st0, "на сегодня", false);
  assertEquals(st.stage, "chat");
  assertEquals(u.uzelF.sent.map((x) => x.text), ["На сегодня уже поздно, давайте на завтра?"]);
});

Deno.test("разговор: жалоба — фраза передачи и handoff, дальше модель не зовётся", async () => {
  const m = new ScriptModel([{ content: [tool("t1", "handoff", { reason: "жалоба", kind: "complaint" })], stop_reason: "tool_use" }]);
  const d = deps(m);
  await handleTurn(d, newDialog(), "вчерашний пирог был сырой!", false);
  assertEquals(d.uzelF.handoffs, [{ dialogId: "d1", reason: "жалоба" }]);
  assert(d.uzelF.sent[0].text.includes("Передаю продавцу"));
  assertEquals(m.requests.length, 1);
});

Deno.test("разговор: модель дважды упала — передача человеку «бот не справился»", async () => {
  const bad = { create: () => Promise.reject(new Error("overloaded")) };
  const d = deps(bad as never);
  await handleTurn(d, newDialog(), "привет", false);
  assertEquals(d.uzelF.handoffs[0].reason, "бот не справился");
});

Deno.test("разговор: отказ модели (refusal) — передача человеку", async () => {
  const d = deps(new ScriptModel([{ content: [], stop_reason: "refusal" }]));
  await handleTurn(d, newDialog(), "…", false);
  assertEquals(d.uzelF.handoffs.length, 1);
});
```

- [ ] **Step 3: Убедиться, что падает** — `deno task test` → FAIL (нет `src/dialog.ts`).

- [ ] **Step 4: `bot/src/tools.ts`**

```ts
// Инструменты модели. Модель выбирает позиции и детали; цены, суммы и итог считает учёт; итог и «передал
// продавцу» отправляют клиенту сами инструменты шаблоном — модель их не пересказывает.
import type { DialogState, Menu } from "./types.ts";
import type { Deps } from "./dialog.ts";
import { cartCheck, findItem, inHours } from "./menu.ts";
import { handoffText, submittedText, summaryText } from "./templates.ts";

const S = (v: string) => ({ type: ["string", "null"], description: v });
export const TOOLS = [
  { name: "cart_set", strict: true, description: "Положить позицию меню в корзину или изменить количество. qty = 0 — убрать. item_code — код в квадратных скобках из меню.",
    input_schema: { type: "object", properties: { item_code: { type: "string" }, qty: { type: "number" } }, required: ["item_code", "qty"], additionalProperties: false } },
  { name: "order_details", strict: true, description: "Записать то, что клиент сказал о получении. Неизвестное — null. for_date — ГГГГ-ММ-ДД, ready_by — ЧЧ:ММ, kind — delivery или pickup, point_id — код точки самовывоза.",
    input_schema: { type: "object", properties: { kind: { type: ["string", "null"], enum: ["delivery", "pickup", null] }, for_date: S("дата"), ready_by: S("к какому часу"),
      address: S("адрес доставки"), client_name: S("как обращаться"), point_id: S("точка самовывоза") },
      required: ["kind", "for_date", "ready_by", "address", "client_name", "point_id"], additionalProperties: false } },
  { name: "order_summary", strict: true, description: "Когда корзина и получение известны: учёт проверит и посчитает заказ, итог сам уйдёт клиенту. Ошибку учёта объясни клиенту своими словами.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "order_submit", strict: true, description: "Только после того, как клиент ответил «да» на итог. Передаёт заказ продавцу; сообщение клиенту уйдёт само.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "handoff", strict: true, description: "Передать разговор продавцу: жалоба, просьба позвать человека, правка уже принятого заказа, вопрос не по меню и правилам, непонятный разговор. После вызова молчи.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, kind: { type: "string", enum: ["complaint", "human", "failed"] } }, required: ["reason", "kind"], additionalProperties: false } },
];

export async function runTool(deps: Deps, st: DialogState, menu: Menu, name: string, input: Record<string, unknown>, ctx: { clientAfterSummary: boolean }):
  Promise<{ result: string; stop?: boolean }> {
  if (name === "cart_set") {
    const it = findItem(menu, String(input.item_code));
    if (!it) return { result: JSON.stringify({ error: `Позиции ${input.item_code} нет в меню. Предложи то, что есть в меню.` }) };
    const qty = Number(input.qty);
    if (qty === 0) st.cart = st.cart.filter((c) => c.item_code !== it.item_code);
    else {
      const bad = cartCheck(it, qty);
      if (bad) return { result: JSON.stringify({ error: bad }) };
      st.cart = [...st.cart.filter((c) => c.item_code !== it.item_code), { item_code: it.item_code, qty }];
    }
    st.stage = "chat"; st.quote = null;
    return { result: JSON.stringify({ cart: st.cart.map((c) => ({ ...c, title: findItem(menu, c.item_code)!.title_ru })) }) };
  }
  if (name === "order_details") {
    for (const k of ["kind", "for_date", "ready_by", "address", "client_name", "point_id"] as const) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) (st.details as Record<string, string>)[k] = v.trim();
    }
    if (st.details.client_name) st.name = st.details.client_name;
    st.stage = "chat"; st.quote = null;
    return { result: JSON.stringify({ details: st.details }) };
  }
  if (name === "order_summary") {
    if (!st.cart.length) return { result: JSON.stringify({ error: "Корзина пуста" }) };
    const r = await deps.uchet.quote({ ...st.details, lines: st.cart });
    if (!r.ok) { st.stage = "chat"; return { result: JSON.stringify({ error: r.message ?? r.error }) }; }
    st.quote = r.quote;
    await deps.uzel.send(st.dialog_id, summaryText(r.quote, st.lang, st.name));
    st.stage = "awaiting_yes"; st.summary_sent_at = deps.now().toISOString();
    return { result: JSON.stringify({ sent: true, note: "Итог отправлен клиенту. Ничего не добавляй, дождись ответа. После «да» — order_submit." }), stop: true };
  }
  if (name === "order_submit") {
    if (st.stage !== "awaiting_yes" || !ctx.clientAfterSummary) {
      return { result: JSON.stringify({ error: "Нельзя: итог ещё не подтверждён клиентом. Сначала order_summary и ответ клиента «да»." }) };
    }
    const r = await deps.uchet.create({ uid: st.draft_uid, ...st.details, lines: st.cart, client_phone: st.phone,
      client_name: st.name, lang: st.lang, uzel_dialog_id: st.dialog_id });
    if (!r.ok) { st.stage = "chat"; st.quote = null; return { result: JSON.stringify({ error: r.message ?? r.error }) }; }
    const menuNow = await deps.uchet.menu();
    await deps.uzel.send(st.dialog_id, submittedText(r.order.no, st.lang, inHours(menuNow, deps.now()), menuNow.settings.client_hours_from));
    st.stage = "submitted"; st.last_order_no = r.order.no; st.cart = []; st.quote = null;
    st.details = { client_name: st.details.client_name, address: st.details.address };
    st.draft_uid = deps.uuid(); st.summary_sent_at = null;
    return { result: JSON.stringify({ ok: true, no: r.order.no }), stop: true };
  }
  if (name === "handoff") {
    const kind = (["complaint", "human", "failed"].includes(String(input.kind)) ? input.kind : "human") as "complaint" | "human" | "failed";
    await deps.uzel.send(st.dialog_id, handoffText(st.lang, kind));
    await deps.uzel.handoff(st.dialog_id, String(input.reason || "бот передал разговор"));
    return { result: JSON.stringify({ ok: true }), stop: true };
  }
  return { result: JSON.stringify({ error: "нет такого инструмента" }) };
}
```

- [ ] **Step 5: `bot/src/dialog.ts`**

```ts
// Ход разговора: системная часть (правила + меню, кэш), время и корзина — системным сообщением после
// хода клиента, цикл инструментов. История только дописывается (preserved thinking Sonnet 5.5).
import type { Uchet } from "./uchet.ts";
import type { Store } from "./store.ts";
import type { DialogState } from "./types.ts";
import { localNow, menuText, rulesText } from "./menu.ts";
import { runTool, TOOLS } from "./tools.ts";
import { handoffText } from "./templates.ts";

export type Block = { type: string; [k: string]: unknown };
export interface ModelClient { create(p: Record<string, unknown>): Promise<{ content: Block[]; stop_reason: string; usage?: Record<string, number> }> }
export interface Deps {
  uchet: Pick<Uchet, "menu" | "quote" | "create">;
  uzel: { send(d: string, t: string): Promise<{ ok: boolean; code?: string }>; handoff(d: string, r: string): Promise<boolean> };
  store: Store; model: ModelClient; modelName: string; now(): Date; uuid(): string;
}

export const SYSTEM_RULES = `Ты — помощник «Енешки» (Темиртау): выпечка, татарские пироги, полуфабрикаты, сеты. Принимаешь заказы в WhatsApp.
Отвечай на языке клиента (русский или казахский), коротко и тепло, как продавец в маленькой семейной пекарне. Без смайликов-простыней.
Что можно предлагать — только позиции из меню ниже, по их кодам в квадратных скобках. Чего нет в меню — нет. Цены не называй сам, кроме цены из меню за единицу.
Собери: позиции и количество (cart_set), способ получения, дату, час и, для доставки, адрес (order_details). Спрашивай по одному-двум пунктам за раз.
Когда всё известно — вызови order_summary: итог клиенту уйдёт сам. Не пересказывай итог. Дождись ответа.
Клиент ответил «да» (иъ, ия, дұрыс, бәрі дұрыс, верно, ок) — вызови order_submit. Клиент что-то меняет — правь корзину или детали и снова order_summary.
Жалоба, «позовите человека», правка уже принятого заказа, вопросы о скидках, оптовых закупках, работе, всё непонятное — handoff.
Не обещай скидок, сроков вне правил и того, чего нет в правилах. Не спорь. Номер телефона клиента уже известен — не спрашивай.`;

export async function handleTurn(deps: Deps, st: DialogState, clientText: string, clientAfterSummary: boolean): Promise<DialogState> {
  const menu = await deps.uchet.menu();
  const system = [{ type: "text", text: `${SYSTEM_RULES}\n\n# Правила\n${rulesText(menu)}\n\n# Меню\n${menuText(menu)}`, cache_control: { type: "ephemeral" } }];
  // После итога или заказа ход кончился результатом инструмента (последний — user с tool_result): новая реплика
  // клиента дописывается в него же — два user подряд API не примет. Модель этот ход ещё не видела: это не правка истории.
  const last = st.convo[st.convo.length - 1] as { role: string; content: unknown } | undefined;
  if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push({ type: "text", text: clientText });
  else st.convo.push({ role: "user", content: clientText });
  st.convo.push({ role: "system", content: `Сейчас ${localNow(deps.now())} (Темиртау). Клиент: ${st.name ?? "имя неизвестно"}. Корзина: ${JSON.stringify(st.cart)}. ` +
    `Получение: ${JSON.stringify(st.details)}. Этап: ${st.stage}${st.last_order_no ? `, последний заказ №${st.last_order_no}` : ""}.` });
  st.last_activity = deps.now().toISOString();
  let reply = "";
  for (let i = 0; i < 6; i++) {
    let resp;
    try { resp = await callModel(deps, system, st.convo); }
    catch { await giveUp(deps, st); return st; }
    st.convo.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason === "refusal") { await giveUp(deps, st); return st; }
    const uses = resp.content.filter((b) => b.type === "tool_use");
    reply = resp.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n").trim();
    if (resp.stop_reason !== "tool_use" || !uses.length) break;
    const results: Record<string, unknown>[] = [];
    let stop = false;
    for (const u of uses) {
      const r = await runTool(deps, st, menu, String(u.name), (u.input ?? {}) as Record<string, unknown>, { clientAfterSummary });
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.result });
      stop = stop || !!r.stop;
    }
    st.convo.push({ role: "user", content: results });
    if (stop) { reply = ""; break; }
  }
  if (reply) await deps.uzel.send(st.dialog_id, reply);
  await deps.store.saveDialog(st);
  return st;
}

async function callModel(deps: Deps, system: unknown[], messages: unknown[]) {
  const p = { model: deps.modelName, max_tokens: 4000, system, tools: TOOLS, messages,
    output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  try { return await deps.model.create(p); }
  catch { return await deps.model.create(p); }   // один повтор: перегрузка, обрыв
}

async function giveUp(deps: Deps, st: DialogState) {
  await deps.uzel.send(st.dialog_id, handoffText(st.lang, "failed"));
  await deps.uzel.handoff(st.dialog_id, "бот не справился");
  await deps.store.saveDialog(st);
}
```

- [ ] **Step 6: Тесты зелёные** — `cd bot && deno task test && deno task check`.
- [ ] **Step 7: Commit** — `git commit -m "Бот Енешки: инструменты и ход разговора"`

---

### Task 8: Адаптер модели (Anthropic SDK)

**Исполнитель:** Claude (SDK — по навыку `claude-api`).

**Files:** Create `bot/src/model.ts`, `bot/tests/model.test.ts`

**Interfaces:** Produces `class ClaudeModel implements ModelClient` (`new ClaudeModel(apiKey)`).

- [ ] **Step 1: Тест формы вызова** `bot/tests/model.test.ts`

```ts
import { assertEquals } from "@std/assert";
import { ClaudeModel } from "../src/model.ts";

Deno.test("модель: идёт в beta.messages.create с бетой и fallbacks как есть", async () => {
  const seen: Record<string, unknown>[] = [];
  const m = new ClaudeModel("k", { beta: { messages: { create: (p: Record<string, unknown>) => { seen.push(p); return Promise.resolve({ content: [], stop_reason: "end_turn" }); } } } } as never);
  await m.create({ model: "claude-sonnet-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", messages: [] });
  assertEquals(seen[0].fallbacks, "default");
  assertEquals(seen[0].betas, ["server-side-fallback-2026-07-01"]);
});
```

- [ ] **Step 2: `bot/src/model.ts`**

```ts
// Адаптер Anthropic SDK. Параметры собирает dialog.ts; здесь — только транспорт и тайм-аут.
import Anthropic from "@anthropic-ai/sdk";
import type { Block, ModelClient } from "./dialog.ts";

export class ClaudeModel implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string, client?: Anthropic) { this.client = client ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }); }
  async create(p: Record<string, unknown>) {
    const r = await this.client.beta.messages.create(p as never);
    const x = r as unknown as { content: Block[]; stop_reason: string; usage?: Record<string, number> };
    return { content: x.content, stop_reason: x.stop_reason, usage: x.usage };
  }
}
```

- [ ] **Step 3: Живая проверка одного запроса** (после «да» на ключ, Task 14): `deno run --allow-net --allow-env --allow-read eval/run.ts --only 1`
  → ответ пришёл, `usage.cache_read_input_tokens` во втором ходе > 0.
- [ ] **Step 4: Commit** — `git commit -m "Бот Енешки: адаптер Claude Sonnet 5.5"`

---

### Task 9: Вебхук «Узла» → очередь диалога → ход разговора

**Исполнитель:** Claude-субагент (порядок и молчание бота — суждение).

**Files:** Create `bot/src/inbound.ts`, `bot/tests/inbound.test.ts`

**Interfaces:**
- Consumes: `verifyUzel`, `UzelClient` (Task 3), `handleTurn` (Task 7), `Store`, `menu.ts`.
- Produces: `class Inbound(deps: InDeps)`: `handle(req: Request): Promise<Response>`; `process(dialogId): Promise<void>` (для тестов);
  `interface InDeps extends Deps { uzelApi: Pick<UzelClient, "getDialog"|"messages">; secret: string; debounceMs: number; paused(): Promise<boolean> }`.

- [ ] **Step 1: Падающие тесты `bot/tests/inbound.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { Inbound } from "../src/inbound.ts";
import { hmacHex } from "../src/uzel.ts";
import { deps, ScriptModel, text } from "./fakes.ts";

const SECRET = "whsec_t";
function api(over: Partial<{ paused: unknown; assigned: string | null; msgs: unknown[] }> = {}) {
  return {
    getDialog: () => Promise.resolve({ id: "d1", chatId: "77011234567", contactName: "Айгуль", assignedUserId: over.assigned ?? null,
      bot: { leading: true, paused: over.paused ?? null } }),
    messages: () => Promise.resolve(over.msgs ?? [
      { id: "m2", direction: "in", type: "text", text: "и манты", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:02Z" },
      { id: "m1", direction: "in", type: "text", text: "пирог хочу", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:00Z" },
    ]),
  };
}
async function signed(body: unknown) {
  const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://bot/uzel", { method: "POST", body: raw, headers: { "x-uzel-timestamp": ts, "x-uzel-signature": "sha256=" + await hmacHex(SECRET, ts + "." + raw) } });
}
const ev = (id: string) => ({ event: "message.in", eventId: id, ts: "x", channelId: "c", dialogId: "d1", messageId: "m2", author: "client",
  status: null, bot: null, pauseKind: null, pauseReason: null });
const make = (model: ScriptModel, a = api()) => { const d = deps(model);
  return { inb: new Inbound({ ...d, uzelApi: a as never, secret: SECRET, debounceMs: 0, paused: () => Promise.resolve(false) }), d }; };

Deno.test("вход: неверная подпись — 401", async () => {
  const { inb } = make(new ScriptModel([]));
  const r = await inb.handle(new Request("https://bot/uzel", { method: "POST", body: "{}", headers: { "x-uzel-timestamp": "1", "x-uzel-signature": "sha256=00" } }));
  assertEquals(r.status, 401);
});
Deno.test("вход: два новых сообщения клиента — один ход с обоими текстами", async () => {
  const m = new ScriptModel([{ content: [text("Сколько килограммов?")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m);
  assertEquals((await inb.handle(await signed(ev("e1")))).status, 200);
  await inb.idle();
  assertEquals(d.uzelF.sent.map((x) => x.text), ["Сколько килограммов?"]);
  const user = JSON.stringify((m.requests[0].messages as unknown[])[0]);
  assert(user.includes("пирог хочу") && user.includes("и манты"));
});
Deno.test("вход: повтор того же eventId — без второго ответа", async () => {
  const m = new ScriptModel([{ content: [text("Здравствуйте")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m);
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.uzelF.sent.length, 1);
});
Deno.test("вход: бот на паузе в «Узле» — молчит", async () => {
  const { inb, d } = make(new ScriptModel([]), api({ paused: { kind: "human", reason: null } }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.uzelF.sent.length, 0);
});
Deno.test("вход: после клиента ответил человек с телефона — молчит", async () => {
  const { inb, d } = make(new ScriptModel([]), api({ msgs: [
    { id: "m3", direction: "out", type: "text", text: "Здравствуйте, сейчас", author: "phone_echo", attachment: null, occurredAt: "2026-10-17T05:00:05Z" },
    { id: "m2", direction: "in", type: "text", text: "пирог", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:02Z" } ] }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.uzelF.sent.length, 0);
});
Deno.test("вход: голосовое — фраза и передача продавцу", async () => {
  const { inb, d } = make(new ScriptModel([]), api({ msgs: [
    { id: "m2", direction: "in", type: "audio", text: null, author: "client", attachment: { kind: "audio" }, occurredAt: "2026-10-17T05:00:02Z" } ] }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(d.uzelF.sent[0].text.includes("Голосовые"));
  assertEquals(d.uzelF.handoffs.length, 1);
});
Deno.test("вход: уже обработанное сообщение повторно в ход не идёт", async () => {
  const m = new ScriptModel([{ content: [text("Принято")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m);
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  await inb.handle(await signed(ev("e2"))); await inb.idle();   // новое событие, но новых сообщений клиента нет
  assertEquals(d.uzelF.sent.length, 1);
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: `bot/src/inbound.ts`**

```ts
// Вебхук «Узла»: проверка подписи, отброс повторов, ответ сразу; работа — в очереди своего диалога после
// короткой паузы (клиент часто пишет двумя-тремя сообщениями подряд). Текст — только из API «Узла».
import type { UzelClient, UzelEvent, UzelMessage } from "./uzel.ts";
import { verifyUzel } from "./uzel.ts";
import { type Deps, handleTurn } from "./dialog.ts";
import type { DialogState } from "./types.ts";
import { detectLang, maskPhone, phoneFromChat } from "./menu.ts";
import { handoffText } from "./templates.ts";

export interface InDeps extends Deps {
  uzelApi: Pick<UzelClient, "getDialog" | "messages">; secret: string; debounceMs: number; paused(): Promise<boolean>;
}
const SIX_H = 6 * 3600e3, HALF_H = 30 * 60e3;

export class Inbound {
  private chains = new Map<string, Promise<void>>();
  private timers = new Map<string, { t: number; done: () => void }>();
  private pending = new Set<Promise<void>>();
  constructor(private d: InDeps) {}

  async handle(req: Request): Promise<Response> {
    const raw = await req.text();
    if (!await verifyUzel(this.d.secret, req.headers.get("x-uzel-timestamp"), req.headers.get("x-uzel-signature"), raw)) {
      return new Response("bad signature", { status: 401 });
    }
    let ev: UzelEvent;
    try { ev = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
    if (ev.event === "ping" || !ev.eventId) return new Response("ok");
    if (!await this.d.store.seenEvent(ev.eventId)) return new Response("dup");
    if (ev.event === "message.in" && ev.dialogId) this.schedule(ev.dialogId);
    return new Response("ok");
  }

  private schedule(id: string) {
    // новая реплика в паузе — прежний таймер снимается, а его ожидание закрывается: ход будет один, по всем репликам
    const old = this.timers.get(id);
    if (old) { clearTimeout(old.t); old.done(); }
    const p = new Promise<void>((done) => {
      const t = setTimeout(() => {
        this.timers.delete(id);
        const prev = this.chains.get(id) ?? Promise.resolve();
        const next = prev.then(() => this.process(id)).catch((e) => this.d.store.journal("error", id, String(e))).finally(done);
        this.chains.set(id, next);
      }, this.d.debounceMs);
      this.timers.set(id, { t, done });
    });
    this.pending.add(p); p.finally(() => this.pending.delete(p));
  }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }

  async process(id: string): Promise<void> {
    const dlg = await this.d.uzelApi.getDialog(id);
    if (dlg.bot.paused || dlg.assignedUserId) return;
    const msgs: UzelMessage[] = (await this.d.uzelApi.messages(id, 30)).slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const phone = phoneFromChat(dlg.chatId);
    if (!phone) return;   // скрытый адрес WhatsApp без номера — заказ не оформить, ответит человек
    let st = await this.d.store.getDialog(id) ?? this.fresh(id, phone, dlg.contactName);
    const lastIdx = st.last_client_msg_id ? msgs.findIndex((m) => m.id === st.last_client_msg_id) : -1;
    const newer = msgs.slice(lastIdx + 1);
    const clientNew = newer.filter((m) => m.direction === "in");
    if (!clientNew.length) return;
    const lastClient = clientNew[clientNew.length - 1];
    if (newer.some((m) => m.direction === "out" && (m.author === "operator" || m.author === "phone_echo") && m.occurredAt > lastClient.occurredAt)) return;
    st.last_client_msg_id = lastClient.id;
    const now = this.d.now().getTime();
    const idle = now - new Date(st.last_activity).getTime();
    if (idle > SIX_H || (st.stage === "submitted" && idle > HALF_H)) st = { ...this.fresh(id, phone, st.name), lang: st.lang, details: { client_name: st.details.client_name, address: st.details.address } , last_client_msg_id: st.last_client_msg_id, last_order_no: st.last_order_no };
    const texts = clientNew.map((m) => m.text ?? "").filter(Boolean);
    const lang = detectLang(texts.join(" "));
    if (lang) st.lang = lang;
    await this.d.store.journal("in", id, `${maskPhone(phone)}: ${texts.join(" | ").slice(0, 300)}`);
    if (clientNew.some((m) => m.attachment && ["audio", "voice", "image", "video"].includes(m.attachment.kind))) {
      await this.d.uzel.send(id, handoffText(st.lang, "voice"));
      await this.d.uzel.handoff(id, "голосовое или фото");
      await this.d.store.saveDialog(st);
      return;
    }
    if (await this.d.paused()) {
      await this.d.uzel.send(id, handoffText(st.lang, "human"));
      await this.d.uzel.handoff(id, "бот на паузе");
      await this.d.store.saveDialog(st);
      return;
    }
    const afterSummary = !!st.summary_sent_at && clientNew.some((m) => m.occurredAt > st.summary_sent_at!);
    await handleTurn(this.d, st, texts.join("\n"), afterSummary);
  }

  private fresh(id: string, phone: string, name: string | null): DialogState {
    return { dialog_id: id, phone, name, lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat", summary_sent_at: null,
      draft_uid: this.d.uuid(), last_order_no: null, last_client_msg_id: null, last_activity: this.d.now().toISOString() };
  }
}
```

- [ ] **Step 4: Тесты зелёные.** - [ ] **Step 5: Commit** — `git commit -m "Бот Енешки: вход из «Узла» — подпись, повторы, очередь диалога, молчание"`

---

### Task 10: Telegram — карточки, кнопки, команды

**Исполнитель:** gemini — черновик по образцу `C:\Вайбкодинг\Полежим Threads\src\telegram.ts` и коду ниже; Claude — права и тесты.

**Files:** Create `bot/src/telegram.ts`, `bot/tests/telegram.test.ts`

**Interfaces:**
- Consumes: `Uchet.cardStatus` (Task 4), `Store` (cards, awaits, state `tg_group`, `team`).
- Produces: `class Telegram(token, f?)` с `call(method, payload)`; `cardText(o: Order): string`; `cardKeyboard(o: Order)`;
  `class Cards(deps: {tg, uchet, store, ownerId})`: `newCard(o)`, `updateCard(o)`, `say(text)`, `onUpdate(update)`.
- Данные кнопок: `s:<id>:<to>` — статус; `p:<id>:<pay>` — оплата при `delivered`/`issued`; `e:<id>` — «Править».

- [ ] **Step 1: Падающие тесты `bot/tests/telegram.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { Cards, cardKeyboard, cardText } from "../src/telegram.ts";
import { MemStore } from "../src/store.ts";
import type { Order } from "../src/types.ts";

const order = (over: Partial<Order> = {}) => ({ id: 7, no: 12, status: "new", status_name: "новый", kind: "delivery", address: "ул. Мира 12",
  for_date: "2026-10-18", ready_by: "18:00", total: 9300, client_name: "Айгуль", client_phone: "77011234567", lang: "ru", point_name: "Енешка",
  prepay_suggested: false, courier: null, reason: null, confirmed_by: null, uzel_dialog_id: "d1", created_at: "2026-10-17T05:00:00Z",
  lines: [{ item_code: "P1", title: "Пирог с мясом", unit: "кг", qty: 1.5, price: 4550, sum: 6825 }], ...over }) as unknown as Order;

class FakeTg { calls: { method: string; p: Record<string, unknown> }[] = []; mid = 100;
  call(method: string, p: Record<string, unknown>) { this.calls.push({ method, p }); return Promise.resolve({ message_id: ++this.mid } as never); } }

function setup() {
  const tg = new FakeTg(), store = new MemStore();
  const statuses: unknown[][] = [];
  const uchet = { cardStatus: (id: number, to: string, by: string, extra: Record<string, unknown>) => { statuses.push([id, to, by, extra]);
    return Promise.resolve({ ok: true, order: order({ status: to, status_name: to, ...(extra as object) }) } as never); } };
  return { tg, store, statuses, cards: new Cards({ tg: tg as never, uchet: uchet as never, store, ownerId: 42 }) };
}
const cb = (from: number, data: string, name = "Мария") => ({ callback_query: { id: "q", from: { id: from, first_name: name }, data, message: { message_id: 101, chat: { id: -100 } } } });

Deno.test("карточка: текст — номер, состав, сумма, клиент, ссылка wa.me", () => {
  const t = cardText(order());
  for (const s of ["№12", "Пирог с мясом — 1,5 кг", "9 300 ₸", "Доставка: ул. Мира 12", "18.10 к 18:00", "Айгуль", "wa.me/77011234567"]) assert(t.includes(s), s);
});
Deno.test("карточка: кнопки нового — подтвердить, с предоплатой, отказать, править", () => {
  const k = JSON.stringify(cardKeyboard(order()));
  assert(k.includes("s:7:confirmed") && k.includes("s:7:awaiting_prepay") && k.includes("s:7:rejected") && k.includes("e:7"));
});
Deno.test("карточка: у самовывоза нет «Передан курьеру», у доставки нет «Ждёт клиента»", () => {
  assert(!JSON.stringify(cardKeyboard(order({ status: "assembled", kind: "pickup" }))).includes("handed_to_courier"));
  assert(!JSON.stringify(cardKeyboard(order({ status: "assembled", kind: "delivery" }))).includes("awaiting_pickup"));
});
Deno.test("кнопки: чужой — «Нет доступа», статус не меняется", async () => {
  const s = setup(); await s.store.setState("tg_group", -100); await s.store.setState("team", [{ id: 5, name: "Мария" }]);
  await s.cards.onUpdate(cb(999, "s:7:confirmed"));
  assertEquals(s.statuses.length, 0);
  assert(JSON.stringify(s.tg.calls).includes("Нет доступа"));
});
Deno.test("кнопки: член команды подтверждает — статус с её именем, карточка обновлена", async () => {
  const s = setup(); await s.store.setState("tg_group", -100); await s.store.setState("team", [{ id: 5, name: "Мария" }]);
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 101, status: "new", created_at: "x", dialog_id: "d1", lang: "ru", no: 12 });
  await s.cards.onUpdate(cb(5, "s:7:confirmed"));
  assertEquals(s.statuses[0].slice(0, 3), [7, "confirmed", "Мария"]);
  assert(s.tg.calls.some((c) => c.method === "editMessageText"));
});
Deno.test("кнопки: отказ — бот просит причину ответом, ответ уходит в учёт", async () => {
  const s = setup(); await s.store.setState("tg_group", -100); await s.store.setState("team", [{ id: 5, name: "Мария" }]);
  await s.cards.onUpdate(cb(5, "s:7:rejected"));
  const ask = s.tg.calls.find((c) => c.method === "sendMessage")!;
  assert(String(ask.p.text).includes("Причина"));
  await s.cards.onUpdate({ message: { message_id: 200, chat: { id: -100 }, from: { id: 5, first_name: "Мария" }, text: "нет начинки", reply_to_message: { message_id: 101 } } });
  assertEquals(s.statuses[0].slice(0, 3), [7, "rejected", "Мария"]);
  assertEquals((s.statuses[0][3] as { reason: string }).reason, "нет начинки");
});
Deno.test("кнопки: «Доставлен» — сначала способ оплаты", async () => {
  const s = setup(); await s.store.setState("tg_group", -100);
  await s.cards.onUpdate(cb(42, "s:7:delivered", "Андрей"));
  assertEquals(s.statuses.length, 0);
  assert(JSON.stringify(s.tg.calls).includes("p:7:cash"));
  await s.cards.onUpdate(cb(42, "p:7:kaspi_qr", "Андрей"));
  assertEquals(s.statuses[0].slice(0, 3), [7, "delivered", "Андрей"]);
  assertEquals((s.statuses[0][3] as { pay_kind: string }).pay_kind, "kaspi_qr");
});
Deno.test("команды: /here только владелец; /allow ответом добавляет в команду", async () => {
  const s = setup();
  await s.cards.onUpdate({ message: { message_id: 1, chat: { id: -100 }, from: { id: 5 }, text: "/here" } });
  assertEquals(await s.store.getState("tg_group"), null);
  await s.cards.onUpdate({ message: { message_id: 2, chat: { id: -100 }, from: { id: 42 }, text: "/here" } });
  assertEquals(await s.store.getState("tg_group"), -100);
  await s.cards.onUpdate({ message: { message_id: 3, chat: { id: -100 }, from: { id: 42 }, text: "/allow", reply_to_message: { message_id: 9, from: { id: 5, first_name: "Мария" } } } });
  assertEquals(await s.store.getState("team"), [{ id: 5, name: "Мария" }]);
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: `bot/src/telegram.ts`**

```ts
// Telegram: карточки заказов с кнопками в группе «Енешка — заказы». Нажимать могут владелец и команда
// (/allow ответом на сообщение человека). Права на кнопку проверяет бот, допустимость перехода — учёт.
// Без parse_mode: имя и адрес клиента не ломают разметку.
import type { Fetch, Order } from "./types.ts";
import type { Store } from "./store.ts";
import type { Uchet } from "./uchet.ts";
import { money, qtyText } from "./menu.ts";

export class Telegram {
  constructor(private token: string, private f: Fetch = fetch) {}
  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const r = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
    return j.result as T;
  }
}

const NEXT: Record<string, [string, string][]> = {
  new: [["confirmed", "Подтвердить"], ["awaiting_prepay", "С предоплатой"], ["rejected", "Отказать"]],
  awaiting_prepay: [["paid", "Оплата пришла"], ["cancelled", "Отменить"]],
  paid: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  confirmed: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  cooking: [["assembled", "Собран"], ["cancelled", "Отменить"]],
  assembled: [["handed_to_courier", "Передал курьеру"], ["awaiting_pickup", "Ждёт клиента"], ["cancelled", "Отменить"]],
  handed_to_courier: [["on_the_way", "В пути"], ["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  on_the_way: [["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  awaiting_pickup: [["issued", "Выдан"], ["not_collected", "Не забрали"]],
};
const REASON = new Set(["rejected", "cancelled", "not_collected"]);
const PAY: [string, string][] = [["cash", "Наличные"], ["kaspi_qr", "Kaspi QR"], ["transfer", "Перевод"], ["card", "Карта"]];
const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);

export function cardText(o: Order): string {
  return [`№${o.no} · ${o.status_name}`,
    o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз: ${o.point_name}`,
    `${dm(o.for_date)} к ${o.ready_by}`,
    ...o.lines.map((l) => `${l.title} — ${qtyText(l.qty)} ${l.unit} × ${money(l.price)} = ${money(l.sum)}`),
    `Итого ${money(o.total)}`,
    `Клиент: ${o.client_name ?? "—"}, +${o.client_phone} · wa.me/${o.client_phone}`,
    o.prepay_suggested && o.status === "new" ? "По правилу нужна предоплата" : null,
    o.courier ? `Курьер: ${o.courier}` : null, o.reason ? `Причина: ${o.reason}` : null,
    o.confirmed_by ? `Подтвердил(а): ${o.confirmed_by}` : null].filter(Boolean).join("\n");
}
export function cardKeyboard(o: Order) {
  const row = (NEXT[o.status] ?? []).filter(([to]) => !(o.kind === "pickup" && to === "handed_to_courier") && !(o.kind === "delivery" && to === "awaiting_pickup"))
    .map(([to, t]) => ({ text: t, callback_data: `s:${o.id}:${to}` }));
  if (["new", "awaiting_prepay", "paid", "confirmed"].includes(o.status)) row.push({ text: "Править", callback_data: `e:${o.id}` });
  return { inline_keyboard: row.length ? [row.slice(0, 3), row.slice(3)].filter((r) => r.length) : [] };
}

interface Upd {
  callback_query?: { id: string; from: { id: number; first_name?: string }; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { message_id: number; chat: { id: number }; from?: { id: number; first_name?: string }; text?: string; reply_to_message?: { message_id: number; from?: { id: number; first_name?: string } } };
}
type Team = { id: number; name: string }[];

export class Cards {
  constructor(private d: { tg: Pick<Telegram, "call">; uchet: Pick<Uchet, "cardStatus">; store: Store; ownerId: number }) {}
  private group() { return this.d.store.getState<number>("tg_group"); }
  private async who(id: number, first?: string): Promise<string | null> {
    if (id === this.d.ownerId) return first || "Владелец";
    const t = (await this.d.store.getState<Team>("team")) ?? [];
    return t.find((x) => x.id === id)?.name ?? null;
  }
  async say(text: string) { const g = await this.group(); if (g) await this.d.tg.call("sendMessage", { chat_id: g, text }); }
  async newCard(o: Order) {
    const g = await this.group(); if (!g) return;
    const m = await this.d.tg.call<{ message_id: number }>("sendMessage", { chat_id: g, text: "Новый заказ\n" + cardText(o), reply_markup: cardKeyboard(o) });
    await this.d.store.saveCard({ order_id: o.id, chat_id: g, message_id: m.message_id, status: o.status, created_at: o.created_at, dialog_id: o.uzel_dialog_id, lang: o.lang, no: o.no });
  }
  async updateCard(o: Order) {
    const c = await this.d.store.getCard(o.id);
    if (!c) return this.newCard(o);
    await this.d.tg.call("editMessageText", { chat_id: c.chat_id, message_id: c.message_id, text: cardText(o), reply_markup: cardKeyboard(o) });
    await this.d.store.saveCard({ ...c, status: o.status });
  }
  private async move(id: number, to: string, by: string, extra: Record<string, unknown>, cbId?: string) {
    const r = await this.d.uchet.cardStatus(id, to, by, extra);
    if (cbId) await this.d.tg.call("answerCallbackQuery", { callback_query_id: cbId, text: r.ok ? "Готово" : (r.message ?? r.error) });
    if (r.order) await this.updateCard(r.order);
    else if (!r.ok && !cbId) await this.say(r.message ?? r.error);
  }
  async onUpdate(u: Upd) {
    if (u.callback_query) {
      const q = u.callback_query, by = await this.who(q.from.id, q.from.first_name);
      if (!by) { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Нет доступа" }); return; }
      const [kind, idS, arg] = String(q.data ?? "").split(":"); const id = Number(idS);
      if (kind === "e") { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Правка — на планшете кассы, вкладка «Заказы»", show_alert: true }); return; }
      if (kind === "p") return this.move(id, (await this.d.store.getState<string>(`pay:${id}`)) ?? "issued", by, { pay_kind: arg }, q.id);
      if (kind !== "s") return;
      const chat = q.message?.chat.id ?? (await this.group())!;
      if (arg === "delivered" || arg === "issued") {
        await this.d.store.setState(`pay:${id}`, arg);
        await this.d.tg.call("sendMessage", { chat_id: chat, text: `№ заказа ${id}: чем оплатили?`, reply_markup: { inline_keyboard: [PAY.map(([k, t]) => ({ text: t, callback_data: `p:${id}:${k}` }))] } });
        await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id }); return;
      }
      if (REASON.has(arg) || arg === "handed_to_courier") {
        const m = await this.d.tg.call<{ message_id: number }>("sendMessage", { chat_id: chat,
          text: arg === "handed_to_courier" ? "Кто везёт? Ответьте на это сообщение именем курьера." : "Причина (её увидит клиент)? Ответьте на это сообщение.",
          reply_markup: { force_reply: true, selective: true } });
        await this.d.store.setAwait({ chat_id: chat, prompt_id: m.message_id, order_id: id, kind: arg === "handed_to_courier" ? "courier" : "reason", to: arg, by_name: by });
        await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id }); return;
      }
      return this.move(id, arg, by, {}, q.id);
    }
    const m = u.message; if (!m || !m.from) return;
    const text = (m.text ?? "").trim();
    if (m.reply_to_message && !text.startsWith("/")) {
      const a = await this.d.store.takeAwait(m.chat.id, m.reply_to_message.message_id);
      if (a && text) return this.move(a.order_id, a.to, a.by_name, a.kind === "courier" ? { courier: text } : { reason: text });
      return;
    }
    const owner = m.from.id === this.d.ownerId;
    if (text === "/here" && owner) { await this.d.store.setState("tg_group", m.chat.id); await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: "Карточки заказов будут приходить сюда." }); return; }
    if (text === "/allow" && owner && m.reply_to_message?.from) {
      const t = ((await this.d.store.getState<Team>("team")) ?? []).filter((x) => x.id !== m.reply_to_message!.from!.id);
      t.push({ id: m.reply_to_message.from.id, name: m.reply_to_message.from.first_name ?? "Сотрудник" });
      await this.d.store.setState("team", t); await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: `${t[t.length - 1].name} может нажимать кнопки.` }); return;
    }
    if (text === "/disallow" && owner && m.reply_to_message?.from) {
      await this.d.store.setState("team", ((await this.d.store.getState<Team>("team")) ?? []).filter((x) => x.id !== m.reply_to_message!.from!.id)); return;
    }
    if (text === "/team") { const t = (await this.d.store.getState<Team>("team")) ?? []; await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: t.map((x) => x.name).join(", ") || "Команда пуста" }); return; }
    if ((text === "/pause" || text === "/resume") && owner) {
      await this.d.store.setState("paused", text === "/pause");
      await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: text === "/pause" ? "Бот на паузе: новые разговоры сразу передаются продавцу." : "Бот снова принимает заказы." });
    }
  }
}
```

- [ ] **Step 4: Тесты зелёные.** - [ ] **Step 5: Commit** — `git commit -m "Бот Енешки: карточки и кнопки в Telegram"`

---

### Task 11: Наблюдатель — журнал заказов, сообщения клиенту, напоминания

**Исполнитель:** Claude-субагент.

**Files:** Create `bot/src/watcher.ts`, `bot/tests/watcher.test.ts`

**Interfaces:**
- Consumes: `Uchet.events/menu`, `Cards.newCard/updateCard/say`, `UzelClient.send`, `Store`, `templates.ts`, `menu.inHours`.
- Produces: `class Watcher(deps)`: `pollOnce(): Promise<number>` (обработано событий), `reminders(): Promise<void>`.

- [ ] **Step 1: Падающие тесты `bot/tests/watcher.test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { Watcher } from "../src/watcher.ts";
import { MemStore } from "../src/store.ts";
import { FakeUzel, MENU } from "./fakes.ts";
import type { Order, OrderEvent } from "../src/types.ts";

const o = (over: Partial<Order> = {}) => ({ id: 7, no: 12, uid: "u", point_id: "eneshka", point_name: "Енешка", uzel_dialog_id: "d1", client_phone: "77011234567",
  client_name: "Айгуль", lang: "ru", kind: "pickup", address: null, for_date: "2026-10-18", ready_by: "18:00", total: 9300, prepay_suggested: false,
  prepay_required: false, pay_kind: null, courier: null, status: "new", status_name: "новый", reason: null, created_at: new Date().toISOString(),
  confirmed_by: null, lines: [], ...over }) as Order;
const e = (id: number, from: string | null, to: string, order: Order): OrderEvent => ({ id, at: new Date().toISOString(), status_from: from, status_to: to, by_kind: "point", by_name: "Мария", payload: {}, order });

function setup(events: OrderEvent[]) {
  const store = new MemStore(), uzel = new FakeUzel(), cards: string[] = [], said: string[] = [];
  const uchet = { events: (after: number) => Promise.resolve({ ok: true, events: events.filter((x) => x.id > after), last: Math.max(after, ...events.map((x) => x.id)) }),
    menu: () => Promise.resolve(MENU) };
  const c = { newCard: (x: Order) => { cards.push("new:" + x.no); return Promise.resolve(); }, updateCard: (x: Order) => { cards.push("upd:" + x.status); return Promise.resolve(); },
    say: (t: string) => { said.push(t); return Promise.resolve(); } };
  const w = new Watcher({ uchet: uchet as never, cards: c as never, uzel, store, now: () => new Date() });
  return { w, store, uzel, cards, said };
}

Deno.test("наблюдатель: новый заказ — карточка; подтверждение — клиенту и в карточку; курсор сохранён", async () => {
  const s = setup([e(1, null, "new", o()), e(2, "new", "confirmed", o({ status: "confirmed" }))]);
  assertEquals(await s.w.pollOnce(), 2);
  assertEquals(s.cards, ["new:12", "upd:confirmed"]);
  assert(s.uzel.sent[0].text.includes("№12") && s.uzel.sent[0].text.includes("подтверждён"));
  assertEquals(await s.store.getState("events_after"), 2);
  assertEquals(await s.w.pollOnce(), 0);
});
Deno.test("наблюдатель: заказы служебных точек и без диалога пропускаются", async () => {
  const s = setup([e(1, null, "new", o({ point_id: "zz_kassa" })), e(2, null, "new", o({ uzel_dialog_id: null }))]);
  await s.w.pollOnce();
  assertEquals(s.cards, []); assertEquals(s.uzel.sent, []);
});
Deno.test("наблюдатель: внутренний статус — только карточка, клиенту ничего", async () => {
  const s = setup([e(3, "confirmed", "cooking", o({ status: "cooking" }))]);
  await s.w.pollOnce();
  assertEquals(s.uzel.sent, []); assertEquals(s.cards, ["upd:cooking"]);
});
Deno.test("наблюдатель: диалог ведёт человек — клиенту не ушло, в группу сказано", async () => {
  const s = setup([e(2, "new", "confirmed", o({ status: "confirmed" }))]);
  s.uzel.paused = true;
  await s.w.pollOnce();
  assert(s.said[0].includes("№12") && s.said[0].includes("сообщите"));
});
Deno.test("наблюдатель: правка заказа (статус тот же) клиенту не пишется", async () => {
  const s = setup([e(4, "confirmed", "confirmed", o({ status: "confirmed" }))]);
  await s.w.pollOnce();
  assertEquals(s.uzel.sent, []);
});
Deno.test("напоминания: неподтверждённый 16 минут — в группу; 31 минута — клиенту; по разу", async () => {
  const s = setup([]);
  const t0 = new Date("2026-10-17T05:00:00Z");   // 10:00 по Темиртау — часы приёма
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 1, status: "new", created_at: t0.toISOString(), dialog_id: "d1", lang: "ru", no: 12 });
  const w1 = new Watcher({ uchet: { menu: () => Promise.resolve(MENU) } as never, cards: { say: (t: string) => { s.said.push(t); return Promise.resolve(); } } as never,
    uzel: s.uzel, store: s.store, now: () => new Date(t0.getTime() + 16 * 60e3) });
  await w1.reminders(); await w1.reminders();
  assertEquals(s.said.length, 1);
  const w2 = new Watcher({ uchet: { menu: () => Promise.resolve(MENU) } as never, cards: { say: () => Promise.resolve() } as never,
    uzel: s.uzel, store: s.store, now: () => new Date(t0.getTime() + 31 * 60e3) });
  await w2.reminders(); await w2.reminders();
  assertEquals(s.uzel.sent.length, 1);
  assert(s.uzel.sent[0].text.includes("№12"));
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: `bot/src/watcher.ts`**

```ts
// Наблюдатель: раз в 10 с читает журнал заказов учёта «после номера N». Новый заказ — карточка в Telegram;
// смена статуса — карточка и, для клиентских статусов, сообщение клиенту (по разу на статус).
// Раз в минуту — напоминания о неподтверждённых: продавцам, потом клиенту.
import type { Order, OrderEvent } from "./types.ts";
import type { Store } from "./store.ts";
import type { Uchet } from "./uchet.ts";
import type { Cards } from "./telegram.ts";
import { soonText, statusText } from "./templates.ts";
import { inHours } from "./menu.ts";

export interface WDeps {
  uchet: Pick<Uchet, "events" | "menu">; cards: Pick<Cards, "newCard" | "updateCard" | "say">;
  uzel: { send(d: string, t: string): Promise<{ ok: boolean; code?: string }> }; store: Store; now(): Date;
}
const STALE_MS = 3600e3;

export class Watcher {
  private busy = false;
  constructor(private d: WDeps) {}
  async pollOnce(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const after = (await this.d.store.getState<number>("events_after")) ?? 0;
      const r = await this.d.uchet.events(after, 200);
      if (!r.ok) return 0;
      const menu = await this.d.uchet.menu();
      for (const ev of r.events) await this.handle(ev, menu.settings);
      await this.d.store.setState("events_after", r.last);
      return r.events.length;
    } finally { this.busy = false; }
  }
  private async handle(ev: OrderEvent, settings: Record<string, string>) {
    const o: Order = { ...ev.order, status: ev.status_to };
    if (o.point_id.startsWith("zz_") || !o.uzel_dialog_id) return;
    if (this.d.now().getTime() - new Date(ev.at).getTime() > STALE_MS) return;   // первый запуск: старое не рассылать
    if (ev.status_from === null) { await this.d.cards.newCard(ev.order); return; }
    await this.d.cards.updateCard(ev.order);
    if (ev.status_from === ev.status_to) return;   // правка заказа
    const text = statusText({ ...ev.order, status: ev.status_to }, settings);
    if (!text || !await this.d.store.noticeOnce(o.id, ev.status_to)) return;
    const r = await this.d.uzel.send(o.uzel_dialog_id!, text);
    if (!r.ok) await this.d.cards.say(`№${o.no}: клиенту не ушло «${text.slice(0, 80)}…» — диалог ведёт человек, сообщите сами.`);
  }
  async reminders() {
    const menu = await this.d.uchet.menu();
    if (!inHours(menu, this.d.now())) return;
    const remind = Number(menu.settings.client_confirm_remind_min || 15) * 60e3;
    const notice = Number(menu.settings.client_confirm_client_notice_min || 30) * 60e3;
    for (const c of await this.d.store.openCards()) {
      if (c.status !== "new") continue;
      const age = this.d.now().getTime() - new Date(c.created_at).getTime();
      if (age > remind && await this.d.store.noticeOnce(c.order_id, "remind")) await this.d.cards.say(`№${c.no} ждёт подтверждения ${Math.round(age / 60e3)} мин.`);
      if (age > notice && c.dialog_id && await this.d.store.noticeOnce(c.order_id, "soon")) {
        await this.d.uzel.send(c.dialog_id, soonText({ no: c.no, lang: c.lang, client_name: null } as Order));
      }
    }
  }
}
```

- [ ] **Step 4: Тесты зелёные.** - [ ] **Step 5: Commit** — `git commit -m "Бот Енешки: наблюдатель статусов и напоминания"`

---

### Task 12: Маршруты HTTP, запуск, скрипты регистрации и ключа

**Исполнитель:** gemini (механика); Claude — проверка `deno task check`, тест маршрутов.

**Files:** Create `bot/src/app.ts`, `bot/main.ts`, `bot/scripts/register.ts`, `bot/scripts/bot-key.ts`, `bot/tests/app.test.ts`

**Interfaces:**
- Produces: `makeApp({inbound, cards, tgSecret, health}) → (req: Request) => Promise<Response>`: `POST /uzel`, `POST /tg` (заголовок `x-telegram-bot-api-secret-token`), `GET /health`.

- [ ] **Step 1: Тест маршрутов `bot/tests/app.test.ts`**

```ts
import { assertEquals } from "@std/assert";
import { makeApp } from "../src/app.ts";

const app = makeApp({ inbound: { handle: () => Promise.resolve(new Response("ok")) } as never,
  cards: { onUpdate: () => Promise.resolve() } as never, tgSecret: "s", health: () => Promise.resolve({ ok: true }) });

Deno.test("app: /tg без секрета — 401", async () => {
  assertEquals((await app(new Request("https://b/tg", { method: "POST", body: "{}" }))).status, 401);
});
Deno.test("app: /tg с секретом — 200", async () => {
  assertEquals((await app(new Request("https://b/tg", { method: "POST", body: "{}", headers: { "x-telegram-bot-api-secret-token": "s" } }))).status, 200);
});
Deno.test("app: /health и 404", async () => {
  assertEquals((await app(new Request("https://b/health"))).status, 200);
  assertEquals((await app(new Request("https://b/x"))).status, 404);
});
```

- [ ] **Step 2: `bot/src/app.ts`**

```ts
// Маршруты: вебхук «Узла», вебхук Telegram (секретный заголовок), здоровье. Ответ Telegram — сразу.
import type { Inbound } from "./inbound.ts";
import type { Cards } from "./telegram.ts";

export function makeApp(d: { inbound: Pick<Inbound, "handle">; cards: Pick<Cards, "onUpdate">; tgSecret: string; health: () => Promise<unknown> }) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/uzel") return d.inbound.handle(req);
    if (req.method === "POST" && path === "/tg") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== d.tgSecret) return new Response("no", { status: 401 });
      const u = await req.json().catch(() => null);
      if (u) d.cards.onUpdate(u).catch((e) => console.error("tg", String(e)));
      return new Response("ok");
    }
    if (req.method === "GET" && path === "/health") return Response.json(await d.health());
    return new Response("not found", { status: 404 });
  };
}
```

- [ ] **Step 3: `bot/main.ts`**

```ts
// Запуск бота: Postgres-хранилище, клиенты, сервер, наблюдатель (10 с) и напоминания (60 с).
import { loadConfig } from "./src/config.ts";
import { PgStore } from "./src/store_pg.ts";
import { UzelClient } from "./src/uzel.ts";
import { Uchet } from "./src/uchet.ts";
import { ClaudeModel } from "./src/model.ts";
import { Inbound } from "./src/inbound.ts";
import { Cards, Telegram } from "./src/telegram.ts";
import { Watcher } from "./src/watcher.ts";
import { makeApp } from "./src/app.ts";

const cfg = loadConfig(Deno.env.toObject());
const store = new PgStore(cfg.databaseUrl);
await store.migrate();
const uzel = new UzelClient(cfg.uzelBase, cfg.uzelKey);
const uchet = new Uchet(cfg.uchetUrl, cfg.uchetKey);
const cards = new Cards({ tg: new Telegram(cfg.tgToken), uchet, store, ownerId: cfg.telegramOwnerId });
const base = { uchet, uzel, store, model: new ClaudeModel(cfg.anthropicKey), modelName: cfg.model, now: () => new Date(), uuid: () => crypto.randomUUID() };
const inbound = new Inbound({ ...base, uzelApi: uzel, secret: cfg.uzelWebhookSecret, debounceMs: 4000,
  paused: async () => (await store.getState<boolean>("paused")) === true });
const watcher = new Watcher({ uchet, cards, uzel, store, now: () => new Date() });
setInterval(() => watcher.pollOnce().catch((e) => store.journal("error", null, "watcher: " + e)), 10_000);
setInterval(() => watcher.reminders().catch((e) => store.journal("error", null, "reminders: " + e)), 60_000);
Deno.serve({ port: cfg.port }, makeApp({ inbound, cards, tgSecret: cfg.tgWebhookSecret,
  health: async () => ({ ok: true, events_after: await store.getState("events_after"), paused: await store.getState("paused") === true }) }));
```

- [ ] **Step 4: `bot/scripts/register.ts`** — регистрирует вебхуки; секрет «Узла» дописывает в `.env`, на экран — только «записан»

```ts
// deno run --allow-net --allow-env --allow-read --allow-write scripts/register.ts /srv/tandem/bot.env
import { UzelClient } from "../src/uzel.ts";
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
const env = Deno.env.toObject();
const uzel = new UzelClient(env.UZEL_BASE_URL, env.UZEL_API_KEY);
const secret = await uzel.registerWebhook(env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/uzel");
const text = await Deno.readTextFile(file);
await Deno.writeTextFile(file, text.replace(/^UZEL_WEBHOOK_SECRET=.*$/m, "") .trimEnd() + "\nUZEL_WEBHOOK_SECRET=" + secret + "\n");
console.log("Вебхук «Узла» зарегистрирован, секрет записан в " + file);
const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/tg", secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] }) });
console.log("Telegram: " + (await r.json()).description);
```

- [ ] **Step 5: `bot/scripts/bot-key.ts`** — ключ бота для учёта: в `.env`, на экран только отпечаток для `settings.bot_key_hash`

```ts
// deno run --allow-read --allow-write scripts/bot-key.ts /srv/tandem/bot.env
const file = Deno.args[0];
if (!file) throw new Error("укажите путь к .env бота");
const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const text = await Deno.readTextFile(file).catch(() => "");
await Deno.writeTextFile(file, text.replace(/^UCHET_SERVICE_KEY=.*$/m, "").trimEnd() + "\nUCHET_SERVICE_KEY=" + key + "\n");
console.log("Ключ записан в " + file + ". Отпечаток для учёта (settings.bot_key_hash): " + hash);
```

- [ ] **Step 6: Проверка** — `cd bot && deno task test && deno task check` → всё зелёное; число тестов — в отчёт.
- [ ] **Step 7: Commit** — `git commit -m "Бот Енешки: маршруты, запуск, регистрация вебхуков и ключ бота"`

---

### Task 13: Эталонные разговоры

**Исполнитель:** сценарии — `ask_model_batch` (gemini, 30 описаний → JSON по схеме ниже, note «эталоны бота Енешки»);
казахские — сверка платной моделью; прогон — Claude после «да» Андрея (около $2 за прогон).

**Files:** Create `bot/eval/cases.json`, `bot/eval/menu.json`, `bot/eval/run.ts`

**Interfaces:**
- Формат случая: `{ "id": "ru-01", "lang": "ru", "turns": ["…", "…", "да"], "expect": { "submit": true, "kind": "pickup", "lines": [{"item_code": "P1", "qty": 1.5}], "for_date_offset": 1, "ready_by": "12:00" } }`
  или `{ "expect": { "handoff": true } }`. `for_date_offset` — дни от «сегодня» прогона.

- [ ] **Step 1: Состав 30 случаев** — 20 русских и 10 казахских:
  пирог к дате (5), полуфабрикаты сегодня (4), сет (3), вопрос о составе/цене без заказа (3, `expect.submit=false`),
  самовывоз (3), доставка ниже минимума → самовывоз (2), позиция на стопе → замена (2), правка в середине разговора (3),
  жалоба (2, handoff), голосовое не проверяется здесь (это вход), «позовите человека» (1, handoff),
  заказ на сегодня после отсечки свежих (2, ожидается перенос на завтра).
- [ ] **Step 2: Снимок меню** — `bot/eval/menu.json` = ответ `bot_menu` живой базы после сверки цен (Task 14, шаг 5);
  до этого — меню из постов Instagram с теми же кодами, что заведёт часть A.
- [ ] **Step 3: `bot/eval/run.ts`**

```ts
// Прогон эталонных разговоров на настоящей модели: подделки «Узла» и учёта (учёт считает по eval/menu.json),
// клиент — заранее записанные реплики. Итог: сколько заказов собрано верно и сколько стоил прогон.
import { handleTurn } from "../src/dialog.ts";
import { ClaudeModel } from "../src/model.ts";
import { MemStore } from "../src/store.ts";
import type { Menu } from "../src/types.ts";
import { FakeUchet, FakeUzel, newDialog } from "../tests/fakes.ts";

const menu: Menu = JSON.parse(await Deno.readTextFile(new URL("./menu.json", import.meta.url)));
const cases = JSON.parse(await Deno.readTextFile(new URL("./cases.json", import.meta.url)));
const only = Deno.args.includes("--only") ? Number(Deno.args[Deno.args.indexOf("--only") + 1]) : 0;
const model = new ClaudeModel(Deno.env.get("ANTHROPIC_API_KEY")!);
const usage = { in: 0, out: 0, cacheR: 0, cacheW: 0 };
const counting = { create: async (p: Record<string, unknown>) => { const r = await model.create(p);
  usage.in += r.usage?.input_tokens ?? 0; usage.out += r.usage?.output_tokens ?? 0;
  usage.cacheR += r.usage?.cache_read_input_tokens ?? 0; usage.cacheW += r.usage?.cache_creation_input_tokens ?? 0; return r; } };
let pass = 0;
const norm = (ls: { item_code: string; qty: number }[]) => ls.map((l) => `${l.item_code}:${Number(l.qty)}`).sort().join(",");
const iso = (k: number) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
for (const c of (only ? cases.slice(0, only) : cases)) {
  const uchet = new FakeUchet(); (uchet as unknown as { menu: () => Promise<Menu> }).menu = () => Promise.resolve(menu);
  const uzel = new FakeUzel();
  const d = { uchet, uzel, store: new MemStore(), model: counting, modelName: Deno.env.get("BOT_MODEL") || "claude-sonnet-5-5", now: () => new Date(), uuid: () => crypto.randomUUID() };
  let st = { ...newDialog(), lang: c.lang };
  for (const t of c.turns) {
    const after = !!st.summary_sent_at;
    st = await handleTurn(d as never, st, t, after);
    if (uzel.handoffs.length) break;
  }
  const got = uchet.creates[0] as Record<string, unknown> | undefined;
  const e = c.expect;
  const ok = e.handoff ? uzel.handoffs.length > 0
    : e.submit === false ? !got && !uzel.handoffs.length
    : !!got && got.kind === e.kind && norm(got.lines as { item_code: string; qty: number }[]) === norm(e.lines)
      && got.for_date === iso(e.for_date_offset) && (!e.ready_by || got.ready_by === e.ready_by);
  console.log(`${ok ? "ok  " : "FAIL"} ${c.id}${ok ? "" : "  → " + JSON.stringify(got ?? { handoffs: uzel.handoffs, sent: uzel.sent.map((x) => x.text) }).slice(0, 300)}`);
  if (ok) pass++;
}
const cost = (usage.in * 2 + usage.cacheW * 2.5 + usage.cacheR * 0.2 + usage.out * 10) / 1e6;
console.log(`\nверно ${pass} из ${only || cases.length}; токены вход ${usage.in}, кэш чтение ${usage.cacheR}, выход ${usage.out}; ≈ $${cost.toFixed(2)}`);
```

- [ ] **Step 4: Прогон** (после «да» и ключа): `cd bot && deno task eval`
  Expected: `верно 30 из 30`. Каждый FAIL — разбор: правка `SYSTEM_RULES`/описаний инструментов, повторный прогон;
  после трёх неудачных кругов на одном случае — разбор с Андреем, а не подгонка эталона.
- [ ] **Step 5: Commit** — `git commit -m "Бот Енешки: 30 эталонных разговоров и прогон"`

---

### Task 14: VPS Тандема, «Узел», бот — выкладка и запуск

**Исполнитель:** Claude (сервер, доступы); шаги со звёздочкой — после явного «да» Андрея.

**Files:** Create `bot/Dockerfile`, `bot/docker-compose.override.yml`, `bot/README.md`; в репозитории «Узла» — `docker/proxy/Caddyfile` (импорт доп. сайтов) и том в `docker-compose.yml`.

- [ ] **Step 1: `bot/Dockerfile`**

```dockerfile
FROM denoland/deno:2.9.5
WORKDIR /app
COPY deno.json ./
COPY src ./src
COPY sql ./sql
COPY main.ts ./
RUN deno install --entrypoint main.ts
USER deno
EXPOSE 8080
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
```

- [ ] **Step 2: `bot/docker-compose.override.yml`** — кладётся рядом с `docker-compose.yml` установки «Узла» Тандема

```yaml
# Служба бота приёма заказов Енешки в установке «Узла» Тандема. Compose подхватывает этот файл сам.
services:
  bot:
    image: tandem.invalid/eneshka-bot:${BOT_VERSIYA:-mestnaya}
    env_file: ./bot.env
    depends_on: [postgres, app]
    restart: unless-stopped
  proxy:
    volumes:
      - ./docker/proxy/extra:/etc/caddy/extra:ro
```

- [ ] **Step 3: Доп. сайты в Caddy «Узла»** (общая возможность продукта, отдельный коммит в его репозитории
  по его правилам выкладки): в конец `docker/proxy/Caddyfile` дописать `import /etc/caddy/extra/*.caddy`;
  проверить `docker run --rm -v ./docker/proxy:/etc/caddy caddy:2.10 caddy validate --config /etc/caddy/Caddyfile`
  без папки `extra` и с ней. В установке Тандема — `docker/proxy/extra/bot.caddy`:

```
{$BOT_DOMAIN} {
	tls {$UZEL_TLS}
	request_body { max_size 1MB }
	reverse_proxy bot:8080
}
```

  и `BOT_DOMAIN` в `environment` службы proxy (override). Expected: `caddy validate` — `Valid configuration`.

- [ ] **Step 4\*: Сервер.** Купить VPS PS.kz Basic-1 (3 750 ₸/мес), DNS двух имён (окно «Узла» и бот) на его адрес,
  установка «Узла» по его README (шаги 1–7, `INSTALL_NAME=Енешка`), swap 1 ГБ, база `bot` в Postgres «Узла»:
  `docker compose exec postgres psql -U <пользователь> -c "create database bot"`.
- [ ] **Step 5\*: Номер.** Ссылка привязки (`deploy/ssylka-privyazki.sh`) — человеку с телефоном рабочего номера;
  отправляет Андрей. Перед ботом — выключить автоответы WhatsApp Business на этом телефоне.
- [ ] **Step 6\*: Ключи.** Андрей в окне «Узла»: «Ключи для программ → Выдать ключ» с галочкой «Этот ключ — бот» →
  `UZEL_API_KEY` в `bot.env` (вставляет сам или скриптом из буфера). На сервере `scripts/bot-key.ts bot.env` →
  отпечаток применить в учёте: `update tandem.settings set value = '<отпечаток>' where key = 'bot_key_hash'`.
  `ANTHROPIC_API_KEY` (чей ключ — решает Андрей: UM Group или Тандем), Telegram-бот у @BotFather → `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET` (случайный), `TELEGRAM_OWNER_ID`, `DATABASE_URL`, `UCHET_API_URL`, `UZEL_BASE_URL`, `PUBLIC_BASE_URL`.
- [ ] **Step 7: Сборка и запуск.** Образ собирается на машине Андрея (`docker build -t tandem.invalid/eneshka-bot:<версия> bot`)
  и передаётся `docker save | ssh … docker load`, как образы «Узла»; на сервере `docker compose up -d bot proxy`;
  `scripts/register.ts` внутри контейнера. Expected: `GET https://<бот>/health` → `{"ok":true,…}`;
  в окне «Узла» у ключа «Оповещения: https://<бот>/uzel».
- [ ] **Step 8: Telegram-группа.** Андрей создаёт группу «Енешка — заказы», добавляет бота, пишет `/here`;
  продавцам — `/allow` ответом на их сообщение.
- [ ] **Step 9: Сквозная проба на учебной точке.** В настройках временно `client_pickup_points` = `ucheb_kassa`
  (или служебный номер и точка `zz_*` нельзя — бот их пропускает; пробу ведём на `ucheb_kassa`). С личного
  телефона Андрея: заказ → итог → «да» → карточка в Telegram и на учебной кассе → подтверждение → «Готовится» →
  «Собран» → «Ждёт клиента» → «Выдан (Наличные)» → чек в смене учебной кассы; клиенту пришли «принят» и «готов».
  Затем вернуть `client_pickup_points` = `eneshka`. Expected: все сообщения дошли, журнал бота без `error`.
- [ ] **Step 10: Замер памяти** (спецификация, проверка 5): 20 одновременных разговоров (`eval/run.ts` с 20 случаями
  против бота на стенде) + касса; `docker stats --no-stream` и `free -m` каждые 10 с. Expected: занято меньше 80 % памяти,
  swap не растёт постоянно. Иначе — смена тарифа на Basic-2 (7 300 ₸/мес) на «да» Андрея.
- [ ] **Step 11: Памятки.** `bot/README.md` — что где лежит, переменные (только имена), как выкатить, как поставить на паузу
  (`/pause`), где журнал (`bot.journal`). Обновить README репозитория (раздел «Бот приёма заказов»).
- [ ] **Step 12: Память сети.** `remember`: адрес бота, где живёт, что запущено, что ждёт Светлану.
- [ ] **Step 13: Commit** — `git commit -m "Бот Енешки: образ, служба в установке «Узла», памятка"`

---

## Что ждёт «да» Андрея (собрать одним сообщением в конце части B)

| Что | Цена | Когда |
|---|---|---|
| VPS PS.kz Basic-1 | 3 750 ₸/мес | Task 14, шаг 4 |
| Claude Sonnet 5.5 в бою | ≈ $40–60/мес | после сквозной пробы |
| Прогоны эталонов | ≈ $2 за прогон, 2–4 прогона | Task 13 |
| Вычитка казахских шаблонов и эталонов платной моделью | ≈ $0,05 | Task 6, 13 |
| Ссылка привязки номера и вопросы Светлане | сообщение от имени Андрея | Task 14, шаг 5 |
| Basic-2 при провале замера | 7 300 ₸/мес | Task 14, шаг 10 |

Вопросы Светлане (черновик готовит исполнитель, отправляет Андрей): единственный номер для заказов;
минимальная сумма, зоны и часы доставки, кто возит; кто подтверждает заказы и в какие часы, кто в
Telegram-группе; точки самовывоза; предоплата — правило или «пока нет»; сверка цен меню заказов; часы Енешки
(в 2ГИС 9:00–17:00).
