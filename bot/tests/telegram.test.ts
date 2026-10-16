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
Deno.test("кнопки: причину принимает только нажавший — чужой ответ игнорируется и ожидание не съедает", async () => {
  const s = setup(); await s.store.setState("tg_group", -100); await s.store.setState("team", [{ id: 5, name: "Мария" }, { id: 6, name: "Ерлан" }]);
  await s.cards.onUpdate(cb(5, "s:7:rejected"));
  const prompt = 101;   // message_id вопроса «Причина?» (первый вызов FakeTg)
  const n = s.tg.calls.length;
  await s.cards.onUpdate({ message: { message_id: 300, chat: { id: -100 }, from: { id: 6, first_name: "Ерлан" }, text: "просто так", reply_to_message: { message_id: prompt } } });
  await s.cards.onUpdate({ message: { message_id: 301, chat: { id: -100 }, from: { id: 777, first_name: "Чужой" }, text: "хаха", reply_to_message: { message_id: prompt } } });
  assertEquals(s.statuses.length, 0);
  assertEquals(s.tg.calls.length, n);   // никому ничего не ответили
  await s.cards.onUpdate({ message: { message_id: 302, chat: { id: -100 }, from: { id: 5, first_name: "Мария" }, text: "нет начинки", reply_to_message: { message_id: prompt } } });
  assertEquals(s.statuses[0].slice(0, 3), [7, "rejected", "Мария"]);
});
Deno.test("кнопки: вопрос «Причина?» — force_reply без selective", async () => {
  const s = setup(); await s.store.setState("tg_group", -100);
  await s.cards.onUpdate(cb(42, "s:7:cancelled", "Андрей"));
  assertEquals(s.tg.calls.find((c) => c.method === "sendMessage")!.p.reply_markup, { force_reply: true });
});
Deno.test("кнопки: вопрос об оплате — с номером заказа, не с id", async () => {
  const s = setup(); await s.store.setState("tg_group", -100);
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 101, status: "awaiting_pickup", created_at: "x", dialog_id: "d1", lang: "ru", no: 12 });
  await s.cards.onUpdate(cb(42, "s:7:issued", "Андрей"));
  const t = String(s.tg.calls.find((c) => c.method === "sendMessage")!.p.text);
  assert(t.includes("№12") && !t.includes(" 7"), t);
});
Deno.test("кнопки: способ оплаты без нажатого «Доставлен»/«Выдан» — просим нажать ещё раз, статус не трогаем", async () => {
  const s = setup(); await s.store.setState("tg_group", -100);
  await s.cards.onUpdate(cb(42, "p:7:cash", "Андрей"));
  assertEquals(s.statuses.length, 0);
  const a = s.tg.calls.find((c) => c.method === "answerCallbackQuery")!;
  assertEquals(a.p.text, "Нажмите «Доставлен»/«Выдан» ещё раз");
});
Deno.test("кнопки: неизвестная кнопка — ответ на нажатие всё равно есть", async () => {
  const s = setup(); await s.store.setState("tg_group", -100);
  await s.cards.onUpdate(cb(42, "zz:7:x", "Андрей"));
  assert(s.tg.calls.some((c) => c.method === "answerCallbackQuery"));
  assertEquals(s.statuses.length, 0);
});
Deno.test("команды: /team — только владелец и только в группе заказов; /here@ИмяБота понимается", async () => {
  const s = setup();
  await s.cards.onUpdate({ message: { message_id: 1, chat: { id: -100 }, from: { id: 42 }, text: "/here@EneshkaBot" } });
  assertEquals(await s.store.getState("tg_group"), -100);
  await s.store.setState("team", [{ id: 5, name: "Мария" }]);
  const n = s.tg.calls.length;
  await s.cards.onUpdate({ message: { message_id: 2, chat: { id: -100 }, from: { id: 5 }, text: "/team" } });
  await s.cards.onUpdate({ message: { message_id: 3, chat: { id: 42 }, from: { id: 42 }, text: "/team" } });
  assertEquals(s.tg.calls.length, n);
  await s.cards.onUpdate({ message: { message_id: 4, chat: { id: -100 }, from: { id: 42 }, text: "/team@EneshkaBot" } });
  assertEquals(s.tg.calls[n].p.text, "Мария");
});
Deno.test("карточка: Telegram «message is not modified» — это успех, статус карточки записан", async () => {
  const s = setup();
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 101, status: "new", created_at: "x", dialog_id: "d1", lang: "ru", no: 12 });
  s.tg.call = (method: string, p: Record<string, unknown>) => { s.tg.calls.push({ method, p });
    return method === "editMessageText" ? Promise.reject(new Error("Telegram editMessageText: Bad Request: message is not modified: specified new message content and reply markup are exactly the same")) : Promise.resolve({ message_id: 1 } as never); };
  await s.cards.updateCard(order({ status: "confirmed" }));
  assertEquals((await s.store.getCard(7))!.status, "confirmed");
});

Deno.test("кнопки: ожидание со старой записью (by_id 0) — ответ принимается от любого члена команды, чужой — нет", async () => {
  const s = setup(); await s.store.setState("tg_group", -100); await s.store.setState("team", [{ id: 5, name: "Мария" }]);
  await s.store.setAwait({ chat_id: -100, prompt_id: 101, order_id: 7, kind: "reason", to: "rejected", by_name: "Мария", by_id: 0 });
  await s.cards.onUpdate({ message: { message_id: 200, chat: { id: -100 }, from: { id: 99, first_name: "Чужой" }, text: "вмешался", reply_to_message: { message_id: 101 } } });
  assertEquals(s.statuses.length, 0);
  assert(await s.store.getAwait(-100, 101));   // ожидание не снято
  await s.cards.onUpdate({ message: { message_id: 201, chat: { id: -100 }, from: { id: 5, first_name: "Мария" }, text: "нет начинки", reply_to_message: { message_id: 101 } } });
  assertEquals(s.statuses[0].slice(0, 3), [7, "rejected", "Мария"]);
  assertEquals((s.statuses[0][3] as { reason: string }).reason, "нет начинки");
});
