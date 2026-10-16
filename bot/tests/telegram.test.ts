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
