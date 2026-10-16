import { assert, assertEquals } from "@std/assert";
import { handleTurn } from "../src/dialog.ts";
import { deps, MENU, newDialog, ScriptModel, text, tool } from "./fakes.ts";

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

const ready = () => ({ ...newDialog(), cart: [{ item_code: "P1", qty: 1.5 }],
  details: { kind: "pickup" as const, for_date: "2026-10-18", ready_by: "12:00", client_name: "Айгуль" } });
const sysMsgs = (r: Record<string, unknown>) => (r.messages as { role: string; content: string }[]).filter((x) => x.role === "system");

Deno.test("разговор: меню поменялось между ходами — системная часть та же байт в байт, новое меню системным сообщением, один раз", async () => {
  const m = new ScriptModel([
    { content: [text("Здравствуйте!")], stop_reason: "end_turn" },
    { content: [text("Пирог с мясом теперь 4 800 ₸ за кг")], stop_reason: "end_turn" },
    { content: [text("Записала")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st1 = await handleTurn(d, newDialog(), "привет", false);
  d.uchetF.menuData = { ...MENU, items: MENU.items.map((x) => x.item_code === "P1" ? { ...x, price: 4800 } : x) };
  const st2 = await handleTurn(d, st1, "сколько стоит пирог?", false);
  await handleTurn(d, st2, "хорошо", false);
  assertEquals(m.requests[1].system, m.requests[0].system);
  assertEquals(m.requests[2].system, m.requests[0].system);
  assert(JSON.stringify(m.requests[0].system).includes("4 550 ₸"));
  const upd1 = sysMsgs(m.requests[1]).filter((x) => x.content.includes("Меню и правила обновились — действуют эти:"));
  assertEquals(upd1.length, 1);
  assert(upd1[0].content.includes("4 800 ₸"));
  const upd2 = sysMsgs(m.requests[2]).filter((x) => x.content.includes("Меню и правила обновились"));
  assertEquals(upd2.length, 1);   // то же сообщение из истории, нового не добавлено
  // история второго запроса — продолжение первого байт в байт
  assertEquals((m.requests[1].messages as unknown[]).slice(0, (m.requests[0].messages as unknown[]).length), m.requests[0].messages);
});

Deno.test("разговор: в запросе — автоматический кэш истории сверху и метка на системной части", async () => {
  const m = new ScriptModel([{ content: [text("ок")], stop_reason: "end_turn" }]);
  await handleTurn(deps(m), newDialog(), "привет", false);
  const r = m.requests[0] as Record<string, any>;
  assertEquals(r.cache_control, { type: "ephemeral" });
  assertEquals(r.system[0].cache_control, { type: "ephemeral" });
});

Deno.test("разговор: «да, и добавьте 2 кг мантов» — правка, новый итог и order_submit в одном ответе — заказа нет, ушёл новый итог", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "cart_set", { item_code: "M1", qty: 2 }), tool("t2", "order_summary", {}), tool("t3", "order_submit", {})], stop_reason: "tool_use" },
  ]);
  const d = deps(m);
  const st0 = { ...ready(), stage: "awaiting_yes" as const, summary_sent_at: "2026-10-17T04:59:00.000Z" };
  const st = await handleTurn(d, st0, "да, и добавьте 2 кг мантов", true);
  assertEquals(d.uchetF.creates.length, 0);
  assertEquals(d.uzelF.sent.length, 1);
  assert(d.uzelF.sent[0].text.includes("Манты с говядиной") && d.uzelF.sent[0].text.includes("Всё верно?"));
  assertEquals(st.stage, "awaiting_yes");
  assert(JSON.stringify(st.convo[st.convo.length - 1]).includes("Нельзя"));
});

Deno.test("разговор: итог не ушёл клиенту («Узел» отказал) — этап «чат», итог не считается отправленным, ошибка инструмента", async () => {
  const m = new ScriptModel([{ content: [tool("t1", "order_summary", {})], stop_reason: "tool_use" }]);
  const d = deps(m);
  d.uzelF.paused = true;
  const st = await handleTurn(d, ready(), "оформляйте", false);
  assertEquals(st.stage, "chat");
  assertEquals(st.summary_sent_at, null);
  assertEquals(m.requests.length, 1);
  assert(JSON.stringify(st.convo[st.convo.length - 1]).includes("error"));
});

Deno.test("разговор: модель упала — история как до хода, следующий ход — допустимый запрос", async () => {
  const m = new ScriptModel([
    { content: [text("Здравствуйте!")], stop_reason: "end_turn" },
    { error: Object.assign(new Error("overloaded"), { status: 529 }) }, { error: Object.assign(new Error("overloaded"), { status: 529 }) },
    { content: [text("Слушаю")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st1 = structuredClone(await handleTurn(d, newDialog(), "привет", false));
  const st2 = await handleTurn(d, structuredClone(st1), "пирог хочу", false);
  assertEquals(st2.convo, st1.convo);
  assertEquals(d.storeM.dialogs.get("d1")!.convo, st1.convo);
  assertEquals(d.uzelF.handoffs[0].reason, "бот не справился");
  await handleTurn(d, st2, "алло", false);   // ScriptModel проверяет запрос
  assertEquals(m.requests.length, 4);
});

Deno.test("разговор: сбой после итога — реплика клиента снята с результата инструмента", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "order_summary", {})], stop_reason: "tool_use" },
    { error: new Error("connection reset") }, { error: new Error("connection reset") },
    { content: [text("Ждём ваше «да»")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st1 = structuredClone(await handleTurn(d, ready(), "оформляйте", false));
  const st2 = await handleTurn(d, structuredClone(st1), "а скидка будет?", true);
  assertEquals(st2.convo, st1.convo);
  await handleTurn(d, st2, "да", true);
});

Deno.test("разговор: ответ оборвался на max_tokens с неотвеченным tool_use — откат и передача человеку", async () => {
  const m = new ScriptModel([
    { content: [tool("t1", "cart_set", { item_code: "P1", qty: 1 })], stop_reason: "max_tokens" },
    { content: [text("Слушаю")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st = await handleTurn(d, newDialog(), "пирог", false);
  assertEquals(st.convo, []);
  assertEquals(d.uzelF.handoffs.length, 1);
  await handleTurn(d, st, "алло", false);
});

Deno.test("разговор: отказ модели — откат истории", async () => {
  const m = new ScriptModel([
    { content: [text("Здравствуйте!")], stop_reason: "end_turn" },
    { content: [], stop_reason: "refusal" },
    { content: [text("Слушаю")], stop_reason: "end_turn" },
  ]);
  const d = deps(m);
  const st1 = structuredClone(await handleTurn(d, newDialog(), "привет", false));
  const st2 = await handleTurn(d, structuredClone(st1), "…", false);
  assertEquals(st2.convo, st1.convo);
  await handleTurn(d, st2, "алло", false);
});

Deno.test("разговор: пустой ответ модели после хода клиента — в истории нет пустого сообщения", async () => {
  const m = new ScriptModel([{ content: [], stop_reason: "end_turn" }, { content: [text("Слушаю")], stop_reason: "end_turn" }]);
  const d = deps(m);
  const st = await handleTurn(d, newDialog(), "привет", false);
  await handleTurn(d, st, "алло", false);   // ScriptModel проверяет запрос
});

Deno.test("разговор: повтор вызова модели — только 429, 5xx и обрыв связи", async () => {
  const run = async (err: unknown) => {
    let n = 0;
    const d = deps({ create: () => { n++; return Promise.reject(err); } });
    await handleTurn(d, newDialog(), "привет", false);
    return n;
  };
  assertEquals(await run(Object.assign(new Error("bad request"), { status: 400 })), 1);
  assertEquals(await run(Object.assign(new Error("auth"), { status: 401 })), 1);
  assertEquals(await run(Object.assign(new Error("rate"), { status: 429 })), 2);
  assertEquals(await run(Object.assign(new Error("overloaded"), { status: 529 })), 2);
  assertEquals(await run(new Error("Connection error.")), 2);
});
