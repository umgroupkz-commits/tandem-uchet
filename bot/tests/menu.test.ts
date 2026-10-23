import { assert, assertEquals } from "@std/assert";
import { cartCheck, detectLang, faqText, inHours, maskPhone, maskPhonesIn, menuText, money, phoneFromChat, phoneOf, rulesText } from "../src/menu.ts";
import { MENU } from "./fakes.ts";

Deno.test("menu: текст меню с кодом, ценой, единицей, сроком и стопом", () => {
  const t = menuText(MENU);
  assert(t.includes("[P1] Пирог с мясом — 4 550 ₸ за кг"));
  assert(t.includes("от 1 кг, шаг 0,5"));
  assert(t.includes("печём под заказ"));
  assert(t.includes("Етті бәліш"));
  assert(t.includes("[B1] Беляш") && t.includes("стоп"));
});
Deno.test("menu: правила из настроек", () => {
  const t = rulesText(MENU);
  assert(t.includes("до 12:00") && t.includes("к 18:00") && t.includes("7 000 ₸") && t.includes("Енешка"));
});
Deno.test("menu: доставка и способы оплаты — из настроек учёта, без них прежние слова", () => {
  const def = rulesText(MENU);
  assert(def.includes("Доставка по Темиртау бесплатная, от 7 000 ₸") && def.includes("наличные, Kaspi QR, перевод, карта"));
  const own = rulesText({ ...MENU, settings: { ...MENU.settings, client_delivery_text: "по Темиртау и Караганде платная, 1 000 ₸",
    client_payment_methods: "наличные и Kaspi QR" } });
  assert(own.includes("Доставка по Темиртау и Караганде платная, 1 000 ₸, от 7 000 ₸"), own);
  assert(own.includes("Оплата при получении: наличные и Kaspi QR.") && !own.includes("перевод"), own);
});
Deno.test("menu: частые вопросы — текст из настроек, пустой — без раздела", () => {
  assertEquals(faqText(MENU), "");
  assertEquals(faqText({ ...MENU, settings: { ...MENU.settings, client_faq: "  Мясо только халяль.  " } }), "Мясо только халяль.");
});
Deno.test("menu: проверка строки корзины", () => {
  const p = MENU.items[0];
  assertEquals(cartCheck(p, 1.5), null);
  assert(cartCheck(p, 0.5)!.includes("Минимум"));
  assert(cartCheck(p, 1.3)!.includes("шагом"));
  assert(cartCheck(MENU.items[3], 2.5)!.includes("целым"));
});
Deno.test("menu: стоп не проверяется в корзине — он на дату заказа, решает учёт (stop_until >= for_date)", () => {
  assertEquals(cartCheck(MENU.items[1], 3), null);
});
Deno.test("menu: телефон из chatId и маска", () => {
  assertEquals(phoneFromChat("77011234567"), "77011234567");
  assertEquals(phoneFromChat("123"), null);
  assertEquals(maskPhone("77011234567"), "+7 701 *** ** 67");
});
Deno.test("menu: номер клиента из диалога «Узла» — contactPhone, иначе chatId обычного адреса, у скрытого без номера — нет", () => {
  assertEquals(phoneOf({ chatId: "77011234567", addressKind: "phone", contactPhone: "77011234567" }), "77011234567");
  assertEquals(phoneOf({ chatId: "77011234567", addressKind: "phone", contactPhone: null }), "77011234567");
  assertEquals(phoneOf({ chatId: "241802581950656", addressKind: "lid", contactPhone: "77015554433" }), "77015554433");
  assertEquals(phoneOf({ chatId: "241802581950656", addressKind: "lid", contactPhone: null }), null);
});
Deno.test("menu: номера в тексте журнала маскируются", () => {
  const t = maskPhonesIn("звоните +7 (701) 123-45-67 или 87011234567, заказ на 2 кг к 12:00");
  assert(t.includes("+7 701 *** ** 67") && !t.includes("123-45-67") && !t.includes("87011234567"), t);
  assert(t.includes("заказ на 2 кг к 12:00"), t);
});
Deno.test("menu: язык по буквам", () => {
  assertEquals(detectLang("Сәлеметсіз бе, бәліш керек"), "kz");
  assertEquals(detectLang("Здравствуйте, пирог нужен"), "ru");
  assertEquals(detectLang("👍"), null);
});
Deno.test("menu: деньги и часы приёма", () => {
  assertEquals(money(19300), "19 300 ₸");
  assertEquals(inHours(MENU, new Date("2026-10-17T05:00:00Z")), true);   // 10:00 по UTC+5
  assertEquals(inHours(MENU, new Date("2026-10-17T15:00:00Z")), false);  // 20:00
});

Deno.test("menu: маска — только телефонные записи, дата со временем не трогается", () => {
  assert(!maskPhonesIn("+7 701 123 45 67").includes("123 45 67"));
  assert(!maskPhonesIn("87011234567").includes("87011234567"));
  assert(!maskPhonesIn("7011234567").includes("7011234567"));   // 10 цифр с 7
  assertEquals(maskPhonesIn("к 2026-10-18 12:00 на двоих"), "к 2026-10-18 12:00 на двоих");
  assertEquals(maskPhonesIn("2026-10-18 12:00"), "2026-10-18 12:00");
});
