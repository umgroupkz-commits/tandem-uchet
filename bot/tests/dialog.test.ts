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
  const uid0 = st0.draft_uid;   // handleTurn правит переданное состояние на месте — запоминаем uid до хода
  const st = await handleTurn(d, st0, "да", true);
  assertEquals(d.uchetF.creates.length, 1);
  assertEquals(d.uchetF.creates[0].uid, uid0);
  assertEquals(d.uchetF.creates[0].client_phone, "77011234567");
  assertEquals(d.uchetF.creates[0].uzel_dialog_id, "d1");
  assert(d.uzelF.sent[0].text.includes("№12"));
  assertEquals(st.stage, "submitted");
  assertEquals(st.cart, []);
  assert(st.draft_uid !== uid0);
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
