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
