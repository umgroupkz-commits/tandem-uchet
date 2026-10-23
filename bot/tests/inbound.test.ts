import { assert, assertEquals } from "@std/assert";
import { Inbound } from "../src/inbound.ts";
import { hmacHex } from "../src/uzel.ts";
import { deps, newDialog, ScriptModel, text } from "./fakes.ts";

const SECRET = "whsec_t";
function api(over: Partial<{ paused: unknown; assigned: string | null; msgs: unknown[]; chatId: string; addressKind: string; contactPhone: string | null }> = {}) {
  return {
    getDialog: () => Promise.resolve({ id: "d1", chatId: over.chatId ?? "77011234567", contactName: "Айгуль", assignedUserId: over.assigned ?? null,
      addressKind: over.addressKind ?? "phone", contactPhone: "contactPhone" in over ? over.contactPhone : (over.chatId ?? "77011234567"),
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
const make = (model: ScriptModel, a = api()) => { const d = deps(model); const notified: string[] = [];
  return { inb: new Inbound({ ...d, uzelApi: a as never, secret: SECRET, debounceMs: 0, paused: () => Promise.resolve(false),
    notify: (t: string) => { notified.push(t); return Promise.resolve(); } }), d, notified }; };
const msg = (id: string, direction: "in" | "out", txt: string | null, at: string, author = direction === "in" ? "client" : "program", extra: Record<string, unknown> = {}) =>
  ({ id, direction, type: "text", text: txt, author, attachment: null, occurredAt: at, ...extra });
const userText = (m: ScriptModel) => JSON.stringify((m.requests[0].messages as unknown[])[0]);

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
  assert(d.uzelF.sent[0].text.includes("голосовые и стикеры пока не разбираю"));
  assertEquals(d.uzelF.handoffs.length, 1);
});
Deno.test("вход: уже обработанное сообщение повторно в ход не идёт", async () => {
  const m = new ScriptModel([{ content: [text("Принято")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m);
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  await inb.handle(await signed(ev("e2"))); await inb.idle();   // новое событие, но новых сообщений клиента нет
  assertEquals(d.uzelF.sent.length, 1);
});
Deno.test("вход: скрытый адрес WhatsApp без номера — передача продавцу «нужен телефон», модель не зовётся", async () => {
  const m = new ScriptModel([]);
  const { inb, d } = make(m, api({ chatId: "241802581950656", addressKind: "lid", contactPhone: null }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(m.requests.length, 0);
  assert(d.uzelF.sent[0].text.includes("ередаю продавцу"), d.uzelF.sent[0]?.text);
  assertEquals(d.uzelF.handoffs, [{ dialogId: "d1", reason: "скрытый номер — нужен телефон" }]);
});
Deno.test("вход: скрытый адрес с известным номером — заказ на contactPhone, не на служебные цифры", async () => {
  const m = new ScriptModel([{ content: [text("Здравствуйте")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ chatId: "241802581950656", addressKind: "lid", contactPhone: "77015554433" }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.storeM.dialogs.get("d1")!.phone, "77015554433");
  assertEquals(d.uzelF.sent.map((x) => x.text), ["Здравствуйте"]);
});
Deno.test("вход: номер телефона в журнале маскируется и в тексте клиента", async () => {
  const msgs = [{ id: "m1", direction: "in", type: "text", text: "мой второй номер 8 701 765 43 21", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:00Z" }];
  const { inb, d } = make(new ScriptModel([{ content: [text("Записала")], stop_reason: "end_turn" }]), api({ msgs }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  const line = d.storeM.log.find((l) => l.startsWith("in "))!;
  assert(!line.includes("765 43 21") && line.includes("+7 701 *** ** 67"), line);
});
Deno.test("вход: ping без подписи — 200 (регистрация: «Узел» подписывает его ещё неизвестным боту секретом)", async () => {
  const { inb } = make(new ScriptModel([]));
  const r = await inb.handle(new Request("https://bot/uzel", { method: "POST", body: JSON.stringify({ event: "ping", eventId: "p1", ts: "x" }) }));
  assertEquals(r.status, 200);
});
Deno.test("вход: message.in без подписи — 401", async () => {
  const { inb, d } = make(new ScriptModel([]));
  const r = await inb.handle(new Request("https://bot/uzel", { method: "POST", body: JSON.stringify(ev("e1")) }));
  assertEquals(r.status, 401);
  await inb.idle();
  assertEquals(d.uzelF.sent.length, 0);
});
Deno.test("вход: на паузе — молчит, но курсор сдвигает (состояние создаётся)", async () => {
  const { inb, d } = make(new ScriptModel([]), api({ paused: { kind: "handoff", reason: null }, msgs: [msg("m1", "in", "позовите человека", "2026-10-17T05:00:00Z")] }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.uzelF.sent.length, 0);
  assertEquals(d.storeM.dialogs.get("d1")!.last_client_msg_id, "m1");
});
Deno.test("вход: после возврата от человека — только сообщения после его ответа, не то, что он уже разобрал", async () => {
  const m = new ScriptModel([{ content: [text("Конечно")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ msgs: [
    msg("m1", "in", "пирог хочу", "2026-10-17T04:00:00Z"),
    msg("m2", "in", "СТАРОЕ разобрал человек", "2026-10-17T04:10:00Z"),
    msg("m3", "out", "Здравствуйте, всё сделаем", "2026-10-17T04:20:00Z", "operator"),
    msg("m4", "in", "а ещё манты можно?", "2026-10-17T05:00:00Z"),
  ] }));
  await d.storeM.saveDialog({ ...newDialog(), last_client_msg_id: "m1" });
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(userText(m).includes("манты") && !userText(m).includes("СТАРОЕ"), userText(m));
});
Deno.test("вход: курсора нет в окне истории — только сообщения после последнего исходящего", async () => {
  const m = new ScriptModel([{ content: [text("Конечно")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ msgs: [
    msg("m5", "in", "СТАРОЕ", "2026-10-17T04:00:00Z"),
    msg("m6", "out", "Ответ бота", "2026-10-17T04:01:00Z", "program"),
    msg("m7", "in", "новое: пирог на завтра", "2026-10-17T05:00:00Z"),
  ] }));
  await d.storeM.saveDialog({ ...newDialog(), last_client_msg_id: "m0-ушло-из-окна" });
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(userText(m).includes("новое") && !userText(m).includes("СТАРОЕ"), userText(m));
});
Deno.test("вход: клиент дописал, пока бот отвечал, — его сообщение не теряется", async () => {
  const m = new ScriptModel([{ content: [text("Хорошо")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ msgs: [
    msg("m1", "in", "пирог хочу", "2026-10-17T04:00:00Z"),
    msg("m2", "in", "и манты", "2026-10-17T04:00:03Z"),
    msg("m3", "out", "Какой пирог?", "2026-10-17T04:00:06Z", "program"),
  ] }));
  await d.storeM.saveDialog({ ...newDialog(), last_client_msg_id: "m1" });
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(userText(m).includes("и манты"), userText(m));
});
for (const kind of ["image", "video", "voice", "document", "sticker", "что-то-новое"]) {
  Deno.test(`вход: вложение «${kind}» — фраза про файлы и передача продавцу, модель не зовётся`, async () => {
    const m = new ScriptModel([]);
    const { inb, d } = make(m, api({ msgs: [msg("m1", "in", kind === "image" ? "вот такой торт" : null, "2026-10-17T05:00:00Z", "client", { type: kind, attachment: { kind } })] }));
    await inb.handle(await signed(ev("e1"))); await inb.idle();
    assertEquals(m.requests.length, 0);
    assert(d.uzelF.sent[0].text.startsWith("Айгуль, файлы, голосовые и стикеры пока не разбираю, передаю продавцу"), d.uzelF.sent[0]?.text);
    assertEquals(d.uzelF.handoffs.length, 1);
  });
}
Deno.test("вход: сообщение без текста и без вложения — модель не зовётся", async () => {
  const m = new ScriptModel([]);
  const { inb, d } = make(m, api({ msgs: [msg("m1", "in", "", "2026-10-17T05:00:00Z")] }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(m.requests.length, 0);
  assertEquals(d.storeM.dialogs.get("d1")!.last_client_msg_id, "m1");
});
Deno.test("вход: сбой обработки — клиенту фраза передачи, продавцу handoff, в группу сообщение; цепочка жива", async () => {
  let calls = 0;
  const a = api();
  const base = a.getDialog;
  a.getDialog = () => ++calls === 1 ? Promise.reject(new Error("Узел: диалог 502")) : base();
  const m = new ScriptModel([{ content: [text("Слушаю")], stop_reason: "end_turn" }]);
  const { inb, d, notified } = make(m, a);
  const journal = d.storeM.journal.bind(d.storeM);
  d.storeM.journal = (k: string, id: string | null, t: string) => k === "error" ? Promise.reject(new Error("база легла")) : journal(k, id, t);
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(d.uzelF.sent[0].text.includes("чтобы ничего не напутать"), d.uzelF.sent[0]?.text);
  assertEquals(d.uzelF.handoffs[0].reason, "бот не справился");
  assertEquals(notified.length, 1);
  await inb.handle(await signed(ev("e2"))); await inb.idle();
  assertEquals(d.uzelF.sent[1].text, "Слушаю");
});
Deno.test("вход: у сообщения нет occurredAt — порядок по createdAt, без падения", async () => {
  const m = new ScriptModel([{ content: [text("Хорошо")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ msgs: [
    msg("m2", "in", "второе", null as unknown as string, "client", { createdAt: "2026-10-17T05:00:02Z" }),
    msg("m1", "in", "первое", "2026-10-17T05:00:00Z"),
  ] }));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assert(userText(m).indexOf("первое") < userText(m).indexOf("второе"), userText(m));
  assertEquals(d.storeM.dialogs.get("d1")!.last_client_msg_id, "m2");
});
Deno.test("вход: законченные цепочки диалогов не копятся", async () => {
  const { inb } = make(new ScriptModel([{ content: [text("Здравствуйте")], stop_reason: "end_turn" }]));
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals((inb as unknown as { chains: Map<string, unknown> }).chains.size, 0);
});

Deno.test("вход: скрытый адрес без contactPhone сейчас, но номер уже в сохранённом диалоге — разговор идёт, не передача", async () => {
  const m = new ScriptModel([{ content: [text("Здравствуйте")], stop_reason: "end_turn" }]);
  const { inb, d } = make(m, api({ chatId: "241802581950656", addressKind: "lid", contactPhone: null }));
  d.storeM.dialogs.set("d1", { ...newDialog(), phone: "77015554433" });
  await inb.handle(await signed(ev("e1"))); await inb.idle();
  assertEquals(d.uzelF.handoffs, []);
  assertEquals(d.uzelF.sent.map((x) => x.text), ["Здравствуйте"]);
  assertEquals(d.storeM.dialogs.get("d1")!.phone, "77015554433");
});
