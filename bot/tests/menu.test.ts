import { assert, assertEquals } from "@std/assert";
import { cartCheck, detectLang, inHours, maskPhone, menuText, money, phoneFromChat, rulesText } from "../src/menu.ts";
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
Deno.test("menu: проверка строки корзины", () => {
  const p = MENU.items[0];
  assertEquals(cartCheck(p, 1.5), null);
  assert(cartCheck(p, 0.5)!.includes("Минимум"));
  assert(cartCheck(p, 1.3)!.includes("шагом"));
  assert(cartCheck(MENU.items[1], 2.5)!.includes("целым"));
  assert(cartCheck(MENU.items[1], 3)!.includes("нет"));
});
Deno.test("menu: телефон из chatId и маска", () => {
  assertEquals(phoneFromChat("77011234567"), "77011234567");
  assertEquals(phoneFromChat("123"), null);
  assertEquals(maskPhone("77011234567"), "+7 701 *** ** 67");
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
