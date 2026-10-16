import { assert, assertEquals } from "@std/assert";
import { statusText, submittedText, summaryText } from "../src/templates.ts";
import type { Order, Quote } from "../src/types.ts";
import { MENU } from "./fakes.ts";

const q: Quote = { point_id: "eneshka", point_name: "Енешка, Караганды 74/2", kind: "delivery", for_date: "2026-10-18", ready_by: "18:00",
  address: "ул. Мира 12, кв 5", total: 9300, delivery_fee: 0, prepay_suggested: false,
  lines: [{ item_code: "P1", title: "Пирог с мясом", title_kz: "Етті бәліш", unit: "кг", qty: 1.5, price: 4550, sum: 6825 },
          { item_code: "M1", title: "Манты с говядиной", title_kz: null, unit: "кг", qty: 0.5, price: 4950, sum: 2475 }] };
const o = { id: 1, no: 12, lang: "ru", client_name: "Айгуль", kind: "delivery", for_date: "2026-10-18", ready_by: "18:00", total: 9300,
  point_name: "Енешка, Караганды 74/2", reason: null } as unknown as Order;

Deno.test("шаблоны: итог по-русски — позиции, сумма, доставка, дата, вопрос", () => {
  const t = summaryText(q, "ru", "Айгуль");
  for (const s of ["Айгуль", "Пирог с мясом — 1,5 кг", "6 825 ₸", "Итого: 9 300 ₸", "Доставка бесплатно", "18.10", "18:00", "ул. Мира 12", "Всё верно?"]) assert(t.includes(s), s);
});
Deno.test("шаблоны: итог по-казахски — казахское название, где есть", () => {
  const t = summaryText(q, "kz", "Айгүл");
  assert(t.includes("Етті бәліш") && t.includes("Манты с говядиной") && t.includes("9 300 ₸"));
});
Deno.test("шаблоны: статусы содержат номер заказа и имя — тексты разные у разных клиентов", () => {
  const c = { ...o, status: "confirmed" } as Order;
  const a = statusText(c, MENU.settings)!, b = statusText({ ...c, no: 13, client_name: "Ерлан" }, MENU.settings)!;
  assert(a.includes("№12") && a.includes("Айгуль"));
  assert(a !== b);
});
Deno.test("шаблоны: предоплата — реквизиты из настроек", () => {
  assert(statusText({ ...o, status: "awaiting_prepay" }, MENU.settings)!.includes("Kaspi: +7 775 000 00 00"));
});
Deno.test("шаблоны: отказ и отмена — с причиной", () => {
  assert(statusText({ ...o, status: "rejected", reason: "нет начинки" }, MENU.settings)!.includes("нет начинки"));
});
Deno.test("шаблоны: внутренние статусы клиенту не пишутся", () => {
  assertEquals(statusText({ ...o, status: "cooking" }, MENU.settings), null);
});
Deno.test("шаблоны: «передал продавцу» вне часов — подтвердим утром", () => {
  assert(submittedText(12, "ru", false, "09:00").includes("утром"));
});
