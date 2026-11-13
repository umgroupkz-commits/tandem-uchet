import { assert, assertEquals } from "@std/assert";
import { type LeadReport, SmmReports, summaryText } from "../src/smm.ts";
import { Cards } from "../src/telegram.ts";
import { MemStore } from "../src/store.ts";

const REP: LeadReport = { ok: true, received: 12, processed: 10, in_work: 2, ignored: 3, other_city: 1, sales: 5, revenue: 48300,
  no_reply: 2, no_order: 4, avg_check: 9660, reply_median_min: 6, reasons: [{ reason: "спросил цену и пропал", n: 2 }] };
const URL = "https://x/office.html";

function setup(now: string) {
  const store = new MemStore();
  const sent: Record<string, unknown>[] = [];
  const asked: [string, string][] = [];
  const tg = { call: <T>(_m: string, b: Record<string, unknown>) => { sent.push(b); return Promise.resolve({ message_id: 1 } as T); } };
  const smm = new SmmReports({ store, tg, now: () => new Date(now), officeUrl: URL,
    uchet: { leadReport: (f, t) => { asked.push([f, t]); return Promise.resolve(REP); } } });
  return { store, sent, asked, smm, tg };
}

Deno.test("сводка СММ: цифры их словами и в их порядке, без номеров", () => {
  const t = summaryText(REP, "2026-11-12", "2026-11-12", URL);
  const order = ["Поступило: 12", "Обработано: 10 (83 %)", "В работе: 2", "Игнор: 3", "С других городов: 1", "Продаж: 5 (42 %)",
    "Сумма продаж: 48 300 ₸", "Без ответа продавца: 2"];
  let at = -1;
  for (const s of order) { const i = t.indexOf(s); assert(i > at, s); at = i; }
  assert(t.includes("12.11.2026") && t.includes("спросил цену и пропал - 2") && t.includes(URL));
  assert(!/[–—]/.test(t), "без длинных тире");
});
Deno.test("сводка СММ: период из нескольких дней - через дефис", () => {
  assert(summaryText(REP, "2026-11-07", "2026-11-13", URL).includes("07.11.2026 - 13.11.2026"));
});
Deno.test("сводка СММ: утром после 9:00 - за вчера, один раз в день", async () => {
  const { smm, sent, asked } = setup("2026-11-14T04:30:00Z");   // 09:30 по Темиртау
  await smm.setChat(-100500);
  assertEquals(await smm.morning(), true);
  assertEquals(asked[0], ["2026-11-13", "2026-11-13"]);
  assertEquals(sent[0].chat_id, -100500);
  assertEquals(await smm.morning(), false, "второй раз за день - нет");
  assertEquals(sent.length, 1);
});
Deno.test("сводка СММ: до 9:00 и без назначенной группы - молчит", async () => {
  const early = setup("2026-11-14T03:30:00Z");   // 08:30
  await early.smm.setChat(-1);
  assertEquals(await early.smm.morning(), false);
  const nochat = setup("2026-11-14T06:00:00Z");
  assertEquals(await nochat.smm.morning(), false);
  assertEquals(nochat.sent.length, 0);
});
Deno.test("сводка СММ: /svodka 7 - за последние 7 дней, включая сегодня", async () => {
  const { smm, asked } = setup("2026-11-13T10:00:00Z");
  await smm.text(7);
  assertEquals(asked[0], ["2026-11-07", "2026-11-13"]);
});

const msg = (from: number, chat: number, text: string) => ({ update_id: 1, message: { message_id: 5, from: { id: from, first_name: "А" }, chat: { id: chat }, text } });
function cards(now = "2026-11-13T10:00:00Z") {
  const s = setup(now);
  const c = new Cards({ tg: s.tg, uchet: { cardStatus: () => Promise.resolve({ ok: true }) } as never, store: s.store, ownerId: 42, smm: s.smm });
  return { ...s, c };
}
Deno.test("сводка СММ: /smm от владельца назначает группу; от чужого - нет", async () => {
  const { c, smm, sent } = cards();
  await c.onUpdate(msg(7, -200, "/smm") as never);
  assertEquals(await smm.chat(), null, "не владелец");
  await c.onUpdate(msg(42, -200, "/smm@EneshkaBot") as never);
  assertEquals(await smm.chat(), -200);
  assert(String(sent[sent.length - 1].text).includes("каждое утро в 9:00"));
});
Deno.test("сводка СММ: /svodka - в группе СММ любой, вне её - только владелец", async () => {
  const { c, smm, sent } = cards();
  await smm.setChat(-200);
  await c.onUpdate(msg(7, -200, "/svodka") as never);
  assert(String(sent[sent.length - 1].text).includes("Поступило: 12"));
  const n = sent.length;
  await c.onUpdate(msg(7, -999, "/svodka") as never);
  assertEquals(sent.length, n, "чужая группа - тишина");
  await c.onUpdate(msg(42, 42, "/svodka 30") as never);
  assertEquals(sent.length, n + 1, "владельцу - где угодно");
});
