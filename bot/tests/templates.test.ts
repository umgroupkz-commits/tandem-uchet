import { assert, assertEquals } from "@std/assert";
import { handoffText, soonText, statusText, submittedText, summaryText } from "../src/templates.ts";
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
  for (const s of ["Айгуль", "Пирог с мясом - 1,5 кг", "6 825 ₸", "Итого: 9 300 ₸", "Доставка: ул. Мира 12", "18.10", "18:00", "Всё верно?"]) assert(t.includes(s), s);
  assert(!t.includes("бесплатно"), "условия доставки - в настройках учёта, итог их не обещает");
});
Deno.test("шаблоны: итог по-казахски — казахское название, где есть", () => {
  const t = summaryText(q, "kz", "Айгүл");
  assert(t.includes("Етті бәліш") && t.includes("Манты с говядиной") && t.includes("9 300 ₸"));
  assert(t.includes("Жеткізу: ул. Мира 12") && !t.includes("тегін"), t);
  assert(!/\d-(ге|ке|ға|қа|ден|тен|дан|тан)/.test(t), "после времени без падежных окончаний: " + t);
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
Deno.test("шаблоны: в текстах клиенту нет длинных и средних тире (правило владельца)", () => {
  const all = [summaryText(q, "ru", "А"), summaryText(q, "kz", "А"), submittedText(1, "ru", true, "09:00"), submittedText(1, "kz", false, "09:00"),
    soonText({ ...o, status: "new" }), soonText({ ...o, lang: "kz", status: "new" } as Order),
    ...["confirmed", "awaiting_prepay", "paid", "on_the_way", "awaiting_pickup", "rejected", "cancelled"].flatMap((st) =>
      ["ru", "kz"].map((lang) => statusText({ ...o, lang, status: st, reason: "причина" } as Order, MENU.settings)!)),
    ...(["complaint", "files", "human", "failed"] as const).flatMap((k) => [handoffText("ru", k), handoffText("kz", k)])];
  for (const t of all) assert(!/[–—]/.test(t), t);
});
Deno.test("шаблоны: внутренние статусы клиенту не пишутся", () => {
  assertEquals(statusText({ ...o, status: "cooking" }, MENU.settings), null);
});
Deno.test("шаблоны: «передал продавцу» вне часов — подтвердим утром", () => {
  assert(submittedText(12, "ru", false, "09:00").includes("утром"));
  const k = submittedText(12, "kz", false, "09:00");
  assert(k.includes("09:00") && !/\d-(ге|ке|ға|қа|ден|тен|дан|тан)/.test(k), k);
});
Deno.test("шаблоны: без имени — с заглавной буквы", () => {
  const n = { ...o, client_name: null } as Order;
  assert(statusText({ ...n, status: "confirmed" }, MENU.settings)!.startsWith("Заказ №12"));
  assert(statusText({ ...n, status: "paid", lang: "kz" }, MENU.settings)!.startsWith("№12"));
  assert(summaryText(q, "ru", null).startsWith("Проверьте заказ"));
  assert(summaryText(q, "kz", null).startsWith("Тапсырысты"));
  assert(soonText({ ...n, status: "new" }).startsWith("Продавец"));
});
Deno.test("шаблоны: реквизитов Kaspi нет в настройках — строка опускается, без «undefined»", () => {
  for (const lang of ["ru", "kz"]) {
    const t = statusText({ ...o, lang, status: "awaiting_prepay" } as Order, {})!;
    assert(!t.includes("undefined") && !t.includes("\n\n"), t);
  }
});
Deno.test("шаблоны: передача продавцу — с именем, когда оно известно (тексты разные)", () => {
  const a = handoffText("ru", "human", "Айгуль"), b = handoffText("ru", "human", "Ерлан");
  assert(a.startsWith("Айгуль, передаю продавцу"), a);
  assert(a !== b);
  assert(handoffText("ru", "human", null).startsWith("Передаю продавцу"));
  assert(handoffText("kz", "complaint", "Айгүл").startsWith("Айгүл, "));
});
Deno.test("шаблоны: файлы, голосовые и стикеры — своя фраза", () => {
  assert(handoffText("ru", "files", null).includes("Файлы, голосовые и стикеры пока не разбираю, передаю продавцу"));
  assert(handoffText("kz", "files", null).length > 10);
});
