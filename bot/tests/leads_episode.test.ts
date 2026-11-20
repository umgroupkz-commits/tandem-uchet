// Граница обращения при разборе (20.11.2026): разбор прошлого обращения не видит следующее, иначе заказ двоится.
import { assertEquals } from "@std/assert";
import { episodeSlice } from "../src/leads.ts";
import type { UzelMessage } from "../src/uzel.ts";

const msg = (id: string, direction: "in" | "out", at: string): UzelMessage =>
  ({ id, direction, type: "text", text: id, author: direction === "in" ? "client" : "phone_echo", attachment: null, occurredAt: at });
const T = (s: string) => Date.parse(s);
const ids = (ms: UzelMessage[]) => ms.map((m) => m.id);

const history = [
  msg("old", "in", "2026-11-12T05:00:00Z"),          // прошлое обращение
  msg("a1", "in", "2026-11-14T05:00:00Z"),            // начало разбираемого
  msg("a2", "out", "2026-11-14T05:10:00Z"),
  msg("a3", "in", "2026-11-15T04:00:00Z"),            // меньше суток после a2 - то же обращение
  msg("late", "out", "2026-11-16T09:00:00Z"),         // продавец через сутки с лишним, клиент молчит - не входит
  msg("b1", "in", "2026-11-17T05:00:00Z"),            // следующее обращение
  msg("b2", "out", "2026-11-17T05:05:00Z"),
];

Deno.test("разбор: обращение - от начала до сообщения клиента после суток тишины", () => {
  assertEquals(ids(episodeSlice(history, T("2026-11-14T05:00:00Z"))), ["a1", "a2", "a3"]);
});
Deno.test("разбор: последнее обращение - до конца истории", () => {
  assertEquals(ids(episodeSlice(history, T("2026-11-17T05:00:00Z"))), ["b1", "b2"]);
});
Deno.test("разбор: сообщения минутой раньше начала (часы «Узла») входят, раньше - нет", () => {
  const h = [msg("x", "in", "2026-11-14T04:58:00Z"), msg("y", "in", "2026-11-14T04:59:30Z"), msg("z", "out", "2026-11-14T05:01:00Z")];
  assertEquals(ids(episodeSlice(h, T("2026-11-14T05:00:00Z"))), ["y", "z"]);
});
