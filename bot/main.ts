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
import { inSchedule } from "./src/menu.ts";
import { Leads } from "./src/leads.ts";
import { SmmReports } from "./src/smm.ts";

const cfg = loadConfig(Deno.env.toObject());
const store = new PgStore(cfg.databaseUrl);
await store.migrate();
const uzel = new UzelClient(cfg.uzelBase, cfg.uzelKey);
const uchet = new Uchet(cfg.uchetUrl, cfg.uchetKey);
const tg = new Telegram(cfg.tgToken);
// Сводка по заявкам WhatsApp для группы СММ (src/smm.ts): группу назначает владелец командой /smm.
const smm = new SmmReports({ uchet, tg, store, now: () => new Date(), officeUrl: "https://umgroupkz-commits.github.io/tandem-uchet/office.html" });
const cards = new Cards({ tg, uchet, store, ownerId: cfg.telegramOwnerId, smm });
const base = { uchet, uzel, store, model: new ClaudeModel(cfg.anthropicKey), modelName: cfg.model, now: () => new Date(), uuid: () => crypto.randomUUID() };
// Бот отвечает клиентам, только если молчать не велит ни один из трёх уровней: BOT_MODE в bot.env (замок на
// сервере), client_bot_mode в учёте и расписание client_bot_schedule. Учёт недоступен — решает обычный ход:
// он сам передаст разговор продавцу, и клиент не останется без ответа.
const silent = async () => {
  if (cfg.silent) return true;
  try {
    const s = (await uchet.menu()).settings;
    if ((s.client_bot_mode ?? "").trim().toLowerCase() === "silent") return true;
    return !inSchedule(s.client_bot_schedule, new Date());
  } catch { return false; }
};
// Обращения и разбор переписки (src/leads.ts). Модель - та же, что у бота; без ключа Anthropic заявки считаются,
// но не разбираются. Разбор - раз в 5 минут по затихшим разговорам.
const leads = new Leads({ store, uchet, uzelApi: uzel, model: cfg.anthropicKey ? base.model : null, modelName: cfg.model,
  now: () => new Date() });
if (cfg.anthropicKey) {
  const tick = () => leads.analyzeDue().catch((e) => store.journal("error", null, "разбор: " + e));
  setTimeout(tick, 60_000);
  setInterval(tick, 5 * 60_000);
}
const inbound = new Inbound({ ...base, uzelApi: uzel, secret: cfg.uzelWebhookSecret, debounceMs: 4000, leads,
  paused: async () => (await store.getState<boolean>("paused")) === true, silent,
  notify: (t) => cfg.tgToken ? cards.say(t) : store.journal("notify", null, t) });
// Карточки заказов и напоминания живут в Telegram: без бота Telegram их некому показывать (так бывает
// только в тихом режиме, пока бот лишь слушает WhatsApp) — наблюдатель тогда не поднимается.
if (cfg.tgToken) {
  const watcher = new Watcher({ uchet, cards, uzel, store, now: () => new Date() });
  setInterval(() => watcher.pollOnce().catch((e) => store.journal("error", null, "watcher: " + e)), 10_000);
  setInterval(() => watcher.reminders().catch((e) => store.journal("error", null, "reminders: " + e)), 60_000);
  // утренняя сводка СММ: проверка раз в 10 минут, уходит один раз в день после 9:00
  setInterval(() => smm.morning().catch((e) => store.journal("error", null, "сводка СММ: " + e)), 10 * 60_000);
} else {
  await store.journal("start", null, "тихий режим без Telegram: карточки заказов и напоминания выключены");
}
Deno.serve({ port: cfg.port }, makeApp({ inbound, cards, tgSecret: cfg.tgWebhookSecret,
  health: async () => ({ ok: true, events_after: await store.getState("events_after"),
    paused: await store.getState("paused") === true, silent: await silent() }) }));
