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
