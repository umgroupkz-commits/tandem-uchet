import { assert, assertEquals } from "@std/assert";
import { ANALYSIS_SCHEMA, Leads, menuForAnalysis, priceAnalysis, transcriptLine } from "../src/leads.ts";
import { MemStore } from "../src/store.ts";
import type { UzelMessage } from "../src/uzel.ts";
import { MENU, ScriptModel, text } from "./fakes.ts";

const msg = (id: string, direction: "in" | "out", txt: string, at: string, author = direction === "in" ? "client" : "phone_echo"): UzelMessage =>
  ({ id, direction, type: "text", text: txt, author, attachment: null, occurredAt: at });

function setup(msgs: UzelMessage[], replies: { content: unknown[]; stop_reason: string }[] = [], now = "2026-11-13T10:00:00Z") {
  const store = new MemStore();
  const pushed: Record<string, unknown>[] = [];
  const model = new ScriptModel(replies as never);
  const leads = new Leads({ store, model, modelName: "claude-sonnet-5-5", now: () => new Date(now),
    uzelApi: { messages: () => Promise.resolve(msgs) },
    uchet: { menu: () => Promise.resolve(MENU), leadUpsert: (p) => { pushed.push(p); return Promise.resolve({ ok: true }); } } });
  return { store, pushed, model, leads };
}
const DLG = { id: "d1", phone: "77011234567", name: "Айгуль" };
// обращение для проверок разбора: клиент написал в firstAt (и ещё раз в lastAt)
const wrote = (leads: Leads, firstAt: string, lastAt = firstAt) => leads.sync(DLG, [msg("w" + firstAt, "in", "пирог хочу", firstAt),
  ...(lastAt !== firstAt ? [msg("w" + lastAt, "in", "на завтра", lastAt)] : [])]);

Deno.test("обращения: первое сообщение - новое обращение, его время - время первого обращения", async () => {
  const { leads, store, pushed } = setup([]);
  await leads.sync(DLG, [msg("m2", "in", "на завтра", "2026-11-13T05:01:00Z"), msg("m1", "in", "пирог хочу", "2026-11-13T05:00:00Z")]);
  assertEquals(store.leads.length, 1);
  assertEquals(store.leads[0].episode_start, "2026-11-13T05:00:00.000Z");
  assertEquals(store.leads[0].msgs_in, 2);
  assertEquals(store.leads[0].first_text, "пирог хочу | на завтра");
  assertEquals(pushed.length, 1, "в учёт - одной записью");
  assertEquals(pushed[0].episode_start, "2026-11-13T05:00:00.000Z");
  assertEquals(pushed[0].analysis, undefined, "сразу - без разбора");
});
Deno.test("обращения: та же история второй раз - ничего не удваивается", async () => {
  const h = [msg("m1", "in", "пирог хочу", "2026-11-13T05:00:00Z"), msg("m2", "out", "есть", "2026-11-13T05:03:00Z")];
  const { leads, store, pushed } = setup([]);
  assertEquals(await leads.sync(DLG, h), 1);
  assertEquals(await leads.sync(DLG, h), 0);
  assertEquals(store.leads[0].msgs_in, 1);
  assertEquals(store.leads[0].msgs_out, 1);
  assertEquals(pushed.length, 1);
});
Deno.test("обращения: дописал через час - то же обращение; через сутки с лишним - новое", async () => {
  const { leads, store } = setup([], [], "2026-11-14T10:00:00Z");
  const h = [msg("m1", "in", "пирог хочу", "2026-11-13T05:00:00Z")];
  await leads.sync(DLG, h);
  h.push(msg("m2", "in", "и манты", "2026-11-13T06:00:00Z"));
  await leads.sync(DLG, h);
  assertEquals(store.leads.length, 1);
  assertEquals(store.leads[0].msgs_in, 2);
  h.push(msg("m3", "in", "а сегодня есть?", "2026-11-14T07:00:00Z"));
  await leads.sync(DLG, h);
  assertEquals(store.leads.length, 2, "больше суток тишины - новое обращение");
  assertEquals(store.leads[1].first_text, "а сегодня есть?");
});
Deno.test("обращения: ответ продавца без обращения клиента - не заявка", async () => {
  const { leads, store } = setup([]);
  assertEquals(await leads.sync(DLG, [msg("m1", "out", "Добрый день, напоминаем о заказе", "2026-11-13T05:00:00Z")]), 0);
  assertEquals(store.leads.length, 0);
});
Deno.test("обращения: первый ответ продавца запоминается, ответ бота не считается", async () => {
  const { leads, store } = setup([]);
  await leads.sync(DLG, [msg("m1", "in", "пирог хочу", "2026-11-13T05:00:00Z"), msg("m2", "out", "есть", "2026-11-13T05:07:00Z", "operator"),
    msg("m3", "out", "авто", "2026-11-13T05:08:00Z", "program"), msg("m4", "out", "3500", "2026-11-13T05:20:00Z")]);
  assertEquals(store.leads[0].first_reply_at, "2026-11-13T05:07:00.000Z");
  assertEquals(store.leads[0].msgs_out, 2);
  assertEquals(store.leads[0].last_at, "2026-11-13T05:20:00.000Z");
});
Deno.test("обращения: старше недели не берём", async () => {
  const { leads, store } = setup([]);
  assertEquals(await leads.sync(DLG, [msg("m1", "in", "пирог хочу", "2026-11-01T05:00:00Z")]), 0);
  assertEquals(store.leads.length, 0);
});
Deno.test("обращения: обход всех диалогов «Узла» досчитывает пропущенное", async () => {
  const store = new MemStore();
  const pushed: Record<string, unknown>[] = [];
  const hist: Record<string, UzelMessage[]> = {
    a: [msg("a1", "in", "пирог", "2026-11-13T05:00:00Z"), msg("a2", "out", "есть", "2026-11-13T05:02:00Z")],
    b: [msg("b1", "out", "рассылка", "2026-11-13T05:00:00Z")],
  };
  const dlg = (id: string, phone: string | null) => ({ id, chatId: phone ?? "1", contactName: "К" + id, assignedUserId: null,
    addressKind: (phone ? "phone" : "lid") as "phone" | "lid", contactPhone: phone, bot: { leading: false, paused: null } });
  const leads = new Leads({ store, model: null, modelName: "m", now: () => new Date("2026-11-13T10:00:00Z"),
    uzelApi: { messages: (id) => Promise.resolve(hist[id]), channels: () => Promise.resolve([{ id: "c1" }]),
      dialogs: () => Promise.resolve([dlg("a", "77011234567"), dlg("b", null)]) },
    uchet: { menu: () => Promise.resolve(MENU), leadUpsert: (p) => { pushed.push(p); return Promise.resolve({ ok: true }); } } });
  assertEquals(await leads.sweep(), 1);
  assertEquals(store.leads.length, 1);
  assertEquals(store.leads[0].phone, "77011234567");
  assertEquals(store.leads[0].name, "Кa");
  assertEquals(await leads.sweep(), 0, "второй обход - ничего нового");
  assertEquals(pushed.length, 1);
});

const ORDER = { outcome: "order", stage: "done", city: "", other_city: false, items: [{ item_code: "P1", title: "пирог с мясом", qty: 1.5 }, { item_code: "", title: "торт наполеон", qty: 1 }],
  total_stated: 0, kind: "pickup", for_date: "2026-11-14", reason: "", summary: "Взяла пирог на завтра, тел. +7 701 123 45 67" };
const convo = [msg("m1", "in", "Здравствуйте, пирог с мясом полтора кило на завтра", "2026-11-13T05:00:00Z"),
  msg("m2", "out", "Здравствуйте! Да, сделаем, заберёте сами?", "2026-11-13T05:05:00Z"), msg("m3", "in", "да", "2026-11-13T05:06:00Z")];

Deno.test("разбор: затихший разговор - модель, суммы по меню, итог в учёт, повторно не разбирается", async () => {
  const { leads, store, pushed, model } = setup(convo, [{ content: [text(JSON.stringify(ORDER))], stop_reason: "end_turn" }]);
  await wrote(leads, "2026-11-13T05:00:00.000Z", "2026-11-13T05:06:00.000Z");
  assertEquals(await leads.analyzeDue(), 1);
  const a = pushed[pushed.length - 1].analysis as Record<string, unknown>;
  assertEquals(a.outcome, "order");
  assertEquals(a.total_menu, 6825, "1,5 кг × 4 550 - считает программа");
  assertEquals(a.total, 6825, "оператор сумму не назвал - по меню");
  assertEquals((a.items as { price: number | null }[])[1].price, null, "чего нет в меню - без цены");
  assertEquals(a.for_date, "2026-11-14");
  assert(!String(a.summary).includes("123 45"), "номер в итоге замаскирован");
  const req = model.requests[0] as Record<string, unknown>;
  assertEquals(req.model, "claude-sonnet-5-5");
  assert(JSON.stringify(req.messages).includes("Продавец: Здравствуйте! Да, сделаем"), "в переписке и продавец");
  assert(JSON.stringify(req.system).includes("[P1]"), "меню с кодами в системной части");
  assert(store.leads[0].analyzed_at, "отмечено как разобранное");
  assertEquals(await leads.analyzeDue(), 0, "без новых сообщений - не разбирается второй раз");
});
Deno.test("разбор: разговор ещё идёт (меньше 40 минут) - рано", async () => {
  const { leads } = setup(convo, [], "2026-11-13T05:30:00Z");
  await wrote(leads, "2026-11-13T05:00:00.000Z", "2026-11-13T05:06:00.000Z");
  assertEquals(await leads.analyzeDue(), 0);
});
Deno.test("разбор: клиент дописал после разбора - разбирается заново", async () => {
  const { leads, store } = setup(convo, [{ content: [text(JSON.stringify(ORDER))], stop_reason: "end_turn" },
    { content: [text(JSON.stringify({ ...ORDER, outcome: "no_order", reason: "передумал" }))], stop_reason: "end_turn" }]);
  await wrote(leads, "2026-11-13T05:00:00.000Z", "2026-11-13T05:06:00.000Z");
  assertEquals(await leads.analyzeDue(), 1);
  store.leads[0].analyzed_at = "2026-11-13T05:10:00.000Z";
  await wrote(leads, "2026-11-13T05:20:00.000Z");
  assertEquals(await leads.analyzeDue(), 1);
});
Deno.test("разбор: сумма, названная продавцом, главнее суммы по меню", () => {
  const a = priceAnalysis(MENU, { ...ORDER, total_stated: 8000 } as never, "m");
  assertEquals(a.total, 8000);
  assertEquals(a.total_menu, 6825);
});
Deno.test("разбор: не заказ - суммы заказа нет, причина есть", () => {
  const a = priceAnalysis(MENU, { ...ORDER, outcome: "no_order", reason: "спросил цену и пропал" } as never, "m");
  assertEquals(a.total, null);
  assertEquals(a.reason, "спросил цену и пропал");
});
Deno.test("разбор: отказ модели - ошибка в журнал, обращение не отмечено разобранным", async () => {
  const { leads, store } = setup(convo, [{ content: [], stop_reason: "refusal" }]);
  await wrote(leads, "2026-11-13T05:00:00.000Z", "2026-11-13T05:06:00.000Z");
  assertEquals(await leads.analyzeDue(), 0);
  assertEquals(store.leads[0].analyzed_at, null);
  assert(store.log.some((l) => l.startsWith("error d1")));
});
Deno.test("разбор: нет ключа Anthropic - заявки считаются, разбора нет", async () => {
  const store = new MemStore();
  const leads = new Leads({ store, model: null, modelName: "m", now: () => new Date("2026-11-13T10:00:00Z"),
    uzelApi: { messages: () => Promise.resolve(convo) }, uchet: { menu: () => Promise.resolve(MENU), leadUpsert: () => Promise.resolve({ ok: true }) } });
  await wrote(leads, "2026-11-13T05:00:00.000Z");
  assertEquals(await leads.analyzeDue(), 0);
  assertEquals(store.leads.length, 1);
});
Deno.test("разбор: строка переписки - время Темиртау, кто писал, вложение словом", () => {
  assertEquals(transcriptLine(msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z")), "[13.11 10:00] Клиент: здравствуйте");
  assertEquals(transcriptLine({ ...msg("m2", "in", "", "2026-11-13T05:01:00Z"), attachment: { kind: "voice" } }), "[13.11 10:01] Клиент: [голосовое] ");
  assertEquals(transcriptLine(msg("m3", "out", "ок", "2026-11-13T05:02:00Z", "operator")), "[13.11 10:02] Продавец: ок");
});
Deno.test("разбор: схема ответа - строгая (все поля обязательны, лишних нет)", () => {
  assertEquals(ANALYSIS_SCHEMA.additionalProperties, false);
  assertEquals(ANALYSIS_SCHEMA.required.length, Object.keys(ANALYSIS_SCHEMA.properties).length);
  assert(menuForAnalysis(MENU).includes("[P1]"));
});

Deno.test("разбор: стадии воронки СММ - заказ всегда итог, неизвестная стадия - в работе", () => {
  assertEquals(priceAnalysis(MENU, { ...ORDER, stage: "ignored" } as never, "m").stage, "done", "продажа - не игнор");
  assertEquals(priceAnalysis(MENU, { ...ORDER, outcome: "no_order", stage: "ignored" } as never, "m").stage, "ignored");
  assertEquals(priceAnalysis(MENU, { ...ORDER, outcome: "unclear", stage: "что-то" } as never, "m").stage, "in_work");
});
Deno.test("разбор: другой город - только если город назван", () => {
  const a = priceAnalysis(MENU, { ...ORDER, outcome: "no_order", city: "Астана", other_city: true } as never, "m");
  assertEquals(a.other_city, true); assertEquals(a.city, "Астана");
  assertEquals(priceAnalysis(MENU, { ...ORDER, city: "", other_city: true } as never, "m").other_city, false, "без города - не считаем");
});
Deno.test("разбор: в схеме стадия и город обязательны", () => {
  for (const f of ["stage", "city", "other_city"]) assert(ANALYSIS_SCHEMA.required.includes(f), f);
});
