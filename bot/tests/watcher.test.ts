import { assert, assertEquals } from "@std/assert";
import { Watcher } from "../src/watcher.ts";
import { MemStore } from "../src/store.ts";
import { FakeUzel, MENU } from "./fakes.ts";
import type { Order, OrderEvent } from "../src/types.ts";

const o = (over: Partial<Order> = {}) => ({ id: 7, no: 12, uid: "u", point_id: "eneshka", point_name: "Енешка", uzel_dialog_id: "d1", client_phone: "77011234567",
  client_name: "Айгуль", lang: "ru", kind: "pickup", address: null, for_date: "2026-10-18", ready_by: "18:00", total: 9300, prepay_suggested: false,
  prepay_required: false, pay_kind: null, courier: null, status: "new", status_name: "новый", reason: null, created_at: new Date().toISOString(),
  confirmed_by: null, lines: [], ...over }) as Order;
const e = (id: number, from: string | null, to: string, order: Order, at = new Date().toISOString()): OrderEvent => ({ id, at, status_from: from, status_to: to, by_kind: "point", by_name: "Мария", payload: {}, order });

function setup(events: OrderEvent[]) {
  const store = new MemStore(), uzel = new FakeUzel(), cards: string[] = [], said: string[] = [];
  const uchet = { events: (after: number) => Promise.resolve({ ok: true, events: events.filter((x) => x.id > after), last: Math.max(after, ...events.map((x) => x.id)) }),
    menu: () => Promise.resolve(MENU) };
  const c = { newCard: (x: Order) => { cards.push("new:" + x.no); return Promise.resolve(); }, updateCard: (x: Order) => { cards.push("upd:" + x.status); return Promise.resolve(); },
    say: (t: string) => { said.push(t); return Promise.resolve(); } };
  const w = new Watcher({ uchet: uchet as never, cards: c as never, uzel, store, now: () => new Date() });
  return { w, store, uzel, cards, said, c };
}

Deno.test("наблюдатель: новый заказ — карточка; подтверждение — клиенту и в карточку; курсор сохранён", async () => {
  const s = setup([e(1, null, "new", o()), e(2, "new", "confirmed", o({ status: "confirmed" }))]);
  assertEquals(await s.w.pollOnce(), 2);
  assertEquals(s.cards, ["new:12", "upd:confirmed"]);
  assert(s.uzel.sent[0].text.includes("№12") && s.uzel.sent[0].text.includes("подтверждён"));
  assertEquals(await s.store.getState("events_after"), 2);
  assertEquals(await s.w.pollOnce(), 0);
});
Deno.test("наблюдатель: заказы служебных точек и без диалога пропускаются", async () => {
  const s = setup([e(1, null, "new", o({ point_id: "zz_kassa" })), e(2, null, "new", o({ uzel_dialog_id: null }))]);
  await s.w.pollOnce();
  assertEquals(s.cards, []); assertEquals(s.uzel.sent, []);
});
Deno.test("наблюдатель: внутренний статус — только карточка, клиенту ничего", async () => {
  const s = setup([e(3, "confirmed", "cooking", o({ status: "cooking" }))]);
  await s.w.pollOnce();
  assertEquals(s.uzel.sent, []); assertEquals(s.cards, ["upd:cooking"]);
});
Deno.test("наблюдатель: диалог ведёт человек — клиенту не ушло, в группу сказано", async () => {
  const s = setup([e(2, "new", "confirmed", o({ status: "confirmed" }))]);
  s.uzel.paused = true;
  await s.w.pollOnce();
  assert(s.said[0].includes("№12") && s.said[0].includes("сообщите"));
});
Deno.test("наблюдатель: правка заказа (статус тот же) клиенту не пишется", async () => {
  const s = setup([e(4, "confirmed", "confirmed", o({ status: "confirmed" }))]);
  await s.w.pollOnce();
  assertEquals(s.uzel.sent, []);
});
Deno.test("напоминания: неподтверждённый 16 минут — в группу; 31 минута — клиенту; по разу", async () => {
  const s = setup([]);
  const t0 = new Date("2026-10-17T05:00:00Z");   // 10:00 по Темиртау — часы приёма
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 1, status: "new", created_at: t0.toISOString(), dialog_id: "d1", lang: "ru", no: 12 });
  const w1 = new Watcher({ uchet: { menu: () => Promise.resolve(MENU) } as never, cards: { say: (t: string) => { s.said.push(t); return Promise.resolve(); } } as never,
    uzel: s.uzel, store: s.store, now: () => new Date(t0.getTime() + 16 * 60e3) });
  await w1.reminders(); await w1.reminders();
  assertEquals(s.said.length, 1);
  const w2 = new Watcher({ uchet: { menu: () => Promise.resolve(MENU) } as never, cards: { say: () => Promise.resolve() } as never,
    uzel: s.uzel, store: s.store, now: () => new Date(t0.getTime() + 31 * 60e3) });
  await w2.reminders(); await w2.reminders();
  assertEquals(s.uzel.sent.length, 1);
  assert(s.uzel.sent[0].text.includes("№12"));
});
const twoHoursAgo = () => new Date(Date.now() - 2 * 3600e3).toISOString();
Deno.test("наблюдатель: сбой на одном событии — журнал, следующее обрабатывается, курсор не застревает", async () => {
  const s = setup([e(1, null, "new", o()), e(2, null, "new", o({ id: 8, no: 13 }))]);
  let first = true;
  s.c.newCard = (x: Order) => { if (first) { first = false; return Promise.reject(new Error("Telegram sendMessage: 429")); } s.cards.push("new:" + x.no); return Promise.resolve(); };
  assertEquals(await s.w.pollOnce(), 2);
  assertEquals(s.cards, ["new:13"]);
  assertEquals(await s.store.getState("events_after"), 2);
  assert(s.store.log.some((l) => l.startsWith("error") && l.includes("429")), s.store.log.join("\n"));
  assertEquals(await s.w.pollOnce(), 0);   // упавшее событие не повторяется вечно
});
Deno.test("наблюдатель: после простоя больше часа — карточки всё равно, клиенту не пишем, группе сказано", async () => {
  const s = setup([e(1, null, "new", o(), twoHoursAgo()), e(2, "new", "confirmed", o({ status: "confirmed" }), twoHoursAgo())]);
  await s.w.pollOnce();
  assertEquals(s.cards, ["new:12", "upd:confirmed"]);
  assertEquals(s.uzel.sent, []);
  assert(s.said.some((t) => t.includes("№12") && t.includes("клиенту не написано: событие старше часа")), s.said.join("\n"));
});
Deno.test("наблюдатель: клиенту не ушло — отметка снята, в группу сказано", async () => {
  const s = setup([e(2, "new", "confirmed", o({ status: "confirmed" }))]);
  s.uzel.send = (() => Promise.reject(new Error("Узел недоступен"))) as never;
  await s.w.pollOnce();
  assert(s.said.some((t) => t.includes("№12")), s.said.join("\n"));
  assertEquals(await s.store.noticeOnce(7, "confirmed"), true);   // отметку сняли — её можно поставить снова
  assertEquals(await s.store.getState("events_after"), 2);
});
Deno.test("напоминания: клиенту не ушло (сбой связи) — повтор в следующую минуту", async () => {
  const s = setup([]);
  const t0 = new Date("2026-10-17T05:00:00Z");
  await s.store.saveCard({ order_id: 7, chat_id: -100, message_id: 1, status: "new", created_at: t0.toISOString(), dialog_id: "d1", lang: "ru", no: 12 });
  let down = true;
  const uzel = { send: (dlg: string, t: string) => down ? Promise.reject(new Error("net")) : s.uzel.send(dlg, t) };
  const w = new Watcher({ uchet: { menu: () => Promise.resolve(MENU) } as never, cards: { say: () => Promise.resolve() } as never,
    uzel, store: s.store, now: () => new Date(t0.getTime() + 31 * 60e3) });
  await w.reminders().catch(() => {});
  down = false;
  await w.reminders();
  assertEquals(s.uzel.sent.length, 1);
});
