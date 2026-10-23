// Эталонные разговоры (eval/cases.json) сверяются со снимком меню (eval/menu.json) без модели и без денег:
// ожидаемый заказ должен быть собираемым по этому меню, иначе платный прогон проверял бы не бота, а опечатку.
import { assert } from "@std/assert";
import { cartCheck, findItem } from "../src/menu.ts";
import type { Menu } from "../src/types.ts";

const menu: Menu = JSON.parse(await Deno.readTextFile(new URL("../eval/menu.json", import.meta.url)));
const cases = JSON.parse(await Deno.readTextFile(new URL("../eval/cases.json", import.meta.url)));
type Line = { item_code: string; qty: number };
const total = (ls: Line[]) => ls.reduce((s, l) => s + findItem(menu, l.item_code)!.price * l.qty, 0);
const minOrder = Number(menu.settings.client_min_order);
const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const inHours = (t: string) => hm(t) >= hm(menu.settings.client_hours_from) && hm(t) < hm(menu.settings.client_hours_to);

Deno.test("эталоны: 30 разговоров, у каждого свой id", () => {
  assert(cases.length === 30);
  assert(new Set(cases.map((c: { id: string }) => c.id)).size === cases.length);
});

for (const c of cases) {
  if (!c.expect.submit) continue;
  Deno.test(`эталоны: ${c.id} собирается по меню снимка`, () => {
    for (const l of c.expect.lines as Line[]) {
      const it = findItem(menu, l.item_code);
      assert(it, `${c.id}: кода ${l.item_code} нет в меню`);
      assert(!it.stopped, `${c.id}: ${it.title_ru} на стопе`);
      assert(cartCheck(it, l.qty) === null, `${c.id}: ${cartCheck(it, l.qty)}`);
    }
    if (c.expect.ready_by) assert(inHours(c.expect.ready_by), `${c.id}: ${c.expect.ready_by} вне часов приёма`);
    if (c.expect.kind === "delivery") assert(total(c.expect.lines) >= minOrder, `${c.id}: доставка меньше минимума`);
  });
}

// Сценарии «просил доставку, бот отказал, заберу сам»: отказ должен быть по правилу минимальной суммы.
for (const id of ["ru-10", "kz-07"]) {
  Deno.test(`эталоны: ${id} - доставка этого заказа меньше минимума, отказ обоснован`, () => {
    const c = cases.find((x: { id: string }) => x.id === id);
    assert(total(c.expect.lines) < minOrder);
  });
}

Deno.test("эталоны: ru-11 - вареники с вишней в снимке на стопе, сценарий проверяет стоп-лист", () => {
  assert(findItem(menu, "2964")?.stopped === true);
});
