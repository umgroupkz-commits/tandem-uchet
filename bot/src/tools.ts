// Инструменты модели. Модель выбирает позиции и детали; цены, суммы и итог считает учёт; итог и «передал
// продавцу» отправляют клиенту сами инструменты шаблоном — модель их не пересказывает.
import type { DialogState, Menu } from "./types.ts";
import type { Deps } from "./dialog.ts";
import { cartCheck, findItem, inHours } from "./menu.ts";
import { handoffText, submittedText, summaryText } from "./templates.ts";

const S = (v: string) => ({ type: ["string", "null"], description: v });
export const TOOLS = [
  { name: "cart_set", strict: true, description: "Положить позицию меню в корзину или изменить количество. qty = 0 — убрать. item_code — код в квадратных скобках из меню.",
    input_schema: { type: "object", properties: { item_code: { type: "string" }, qty: { type: "number" } }, required: ["item_code", "qty"], additionalProperties: false } },
  { name: "order_details", strict: true, description: "Записать то, что клиент сказал о получении. Неизвестное — null. for_date — ГГГГ-ММ-ДД, ready_by — ЧЧ:ММ, kind — delivery или pickup, point_id — код точки самовывоза.",
    input_schema: { type: "object", properties: { kind: { type: ["string", "null"], enum: ["delivery", "pickup", null] }, for_date: S("дата"), ready_by: S("к какому часу"),
      address: S("адрес доставки"), client_name: S("как обращаться"), point_id: S("точка самовывоза") },
      required: ["kind", "for_date", "ready_by", "address", "client_name", "point_id"], additionalProperties: false } },
  { name: "order_summary", strict: true, description: "Когда корзина и получение известны: учёт проверит и посчитает заказ, итог сам уйдёт клиенту. Ошибку учёта объясни клиенту своими словами.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "order_submit", strict: true, description: "Только после того, как клиент ответил «да» на итог. Передаёт заказ продавцу; сообщение клиенту уйдёт само.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "handoff", strict: true, description: "Передать разговор продавцу: жалоба, просьба позвать человека, правка уже принятого заказа, вопрос не по меню и правилам, непонятный разговор. После вызова молчи.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, kind: { type: "string", enum: ["complaint", "human", "failed"] } }, required: ["reason", "kind"], additionalProperties: false } },
];

export async function runTool(deps: Deps, st: DialogState, menu: Menu, name: string, input: Record<string, unknown>, ctx: { clientAfterSummary: boolean }):
  Promise<{ result: string; stop?: boolean }> {
  if (name === "cart_set") {
    const it = findItem(menu, String(input.item_code));
    if (!it) return { result: JSON.stringify({ error: `Позиции ${input.item_code} нет в меню. Предложи то, что есть в меню.` }) };
    const qty = Number(input.qty);
    if (qty === 0) st.cart = st.cart.filter((c) => c.item_code !== it.item_code);
    else {
      const bad = cartCheck(it, qty);
      if (bad) return { result: JSON.stringify({ error: bad }) };
      st.cart = [...st.cart.filter((c) => c.item_code !== it.item_code), { item_code: it.item_code, qty }];
    }
    st.stage = "chat"; st.quote = null;
    return { result: JSON.stringify({ cart: st.cart.map((c) => ({ ...c, title: findItem(menu, c.item_code)!.title_ru })) }) };
  }
  if (name === "order_details") {
    for (const k of ["kind", "for_date", "ready_by", "address", "client_name", "point_id"] as const) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) (st.details as Record<string, string>)[k] = v.trim();
    }
    if (st.details.client_name) st.name = st.details.client_name;
    st.stage = "chat"; st.quote = null;
    return { result: JSON.stringify({ details: st.details }) };
  }
  if (name === "order_summary") {
    if (!st.cart.length) return { result: JSON.stringify({ error: "Корзина пуста" }) };
    const r = await deps.uchet.quote({ ...st.details, lines: st.cart });
    if (!r.ok) { st.stage = "chat"; return { result: JSON.stringify({ error: r.message ?? r.error }) }; }
    st.quote = r.quote;
    await deps.uzel.send(st.dialog_id, summaryText(r.quote, st.lang, st.name));
    st.stage = "awaiting_yes"; st.summary_sent_at = deps.now().toISOString();
    return { result: JSON.stringify({ sent: true, note: "Итог отправлен клиенту. Ничего не добавляй, дождись ответа. После «да» — order_submit." }), stop: true };
  }
  if (name === "order_submit") {
    if (st.stage !== "awaiting_yes" || !ctx.clientAfterSummary) {
      return { result: JSON.stringify({ error: "Нельзя: итог ещё не подтверждён клиентом. Сначала order_summary и ответ клиента «да»." }) };
    }
    const r = await deps.uchet.create({ uid: st.draft_uid, ...st.details, lines: st.cart, client_phone: st.phone,
      client_name: st.name, lang: st.lang, uzel_dialog_id: st.dialog_id });
    if (!r.ok) { st.stage = "chat"; st.quote = null; return { result: JSON.stringify({ error: r.message ?? r.error }) }; }
    const menuNow = await deps.uchet.menu();
    await deps.uzel.send(st.dialog_id, submittedText(r.order.no, st.lang, inHours(menuNow, deps.now()), menuNow.settings.client_hours_from));
    st.stage = "submitted"; st.last_order_no = r.order.no; st.cart = []; st.quote = null;
    st.details = { client_name: st.details.client_name, address: st.details.address };
    st.draft_uid = deps.uuid(); st.summary_sent_at = null;
    return { result: JSON.stringify({ ok: true, no: r.order.no }), stop: true };
  }
  if (name === "handoff") {
    const kind = (["complaint", "human", "failed"].includes(String(input.kind)) ? input.kind : "human") as "complaint" | "human" | "failed";
    await deps.uzel.send(st.dialog_id, handoffText(st.lang, kind));
    await deps.uzel.handoff(st.dialog_id, String(input.reason || "бот передал разговор"));
    return { result: JSON.stringify({ ok: true }), stop: true };
  }
  return { result: JSON.stringify({ error: "нет такого инструмента" }) };
}
