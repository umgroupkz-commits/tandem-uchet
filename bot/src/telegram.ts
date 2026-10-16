// Telegram: карточки заказов с кнопками в группе «Енешка — заказы». Нажимать могут владелец и команда
// (/allow ответом на сообщение человека). Права на кнопку проверяет бот, допустимость перехода — учёт.
// Без parse_mode: имя и адрес клиента не ломают разметку.
import type { Fetch, Order } from "./types.ts";
import type { Store } from "./store.ts";
import type { Uchet } from "./uchet.ts";
import { money, qtyText } from "./menu.ts";

export class Telegram {
  constructor(private token: string, private f: Fetch = fetch) {}
  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const r = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
    return j.result as T;
  }
}

const NEXT: Record<string, [string, string][]> = {
  new: [["confirmed", "Подтвердить"], ["awaiting_prepay", "С предоплатой"], ["rejected", "Отказать"]],
  awaiting_prepay: [["paid", "Оплата пришла"], ["cancelled", "Отменить"]],
  paid: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  confirmed: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  cooking: [["assembled", "Собран"], ["cancelled", "Отменить"]],
  assembled: [["handed_to_courier", "Передал курьеру"], ["awaiting_pickup", "Ждёт клиента"], ["cancelled", "Отменить"]],
  handed_to_courier: [["on_the_way", "В пути"], ["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  on_the_way: [["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  awaiting_pickup: [["issued", "Выдан"], ["not_collected", "Не забрали"]],
};
const REASON = new Set(["rejected", "cancelled", "not_collected"]);
const PAY: [string, string][] = [["cash", "Наличные"], ["kaspi_qr", "Kaspi QR"], ["transfer", "Перевод"], ["card", "Карта"]];
const dm = (d: string) => d.slice(8, 10) + "." + d.slice(5, 7);

export function cardText(o: Order): string {
  return [`№${o.no} · ${o.status_name}`,
    o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз: ${o.point_name}`,
    `${dm(o.for_date)} к ${o.ready_by}`,
    ...o.lines.map((l) => `${l.title} — ${qtyText(l.qty)} ${l.unit} × ${money(l.price)} = ${money(l.sum)}`),
    `Итого ${money(o.total)}`,
    `Клиент: ${o.client_name ?? "—"}, +${o.client_phone} · wa.me/${o.client_phone}`,
    o.prepay_suggested && o.status === "new" ? "По правилу нужна предоплата" : null,
    o.courier ? `Курьер: ${o.courier}` : null, o.reason ? `Причина: ${o.reason}` : null,
    o.confirmed_by ? `Подтвердил(а): ${o.confirmed_by}` : null].filter(Boolean).join("\n");
}
export function cardKeyboard(o: Order) {
  const row = (NEXT[o.status] ?? []).filter(([to]) => !(o.kind === "pickup" && to === "handed_to_courier") && !(o.kind === "delivery" && to === "awaiting_pickup"))
    .map(([to, t]) => ({ text: t, callback_data: `s:${o.id}:${to}` }));
  if (["new", "awaiting_prepay", "paid", "confirmed"].includes(o.status)) row.push({ text: "Править", callback_data: `e:${o.id}` });
  return { inline_keyboard: row.length ? [row.slice(0, 3), row.slice(3)].filter((r) => r.length) : [] };
}

interface Upd {
  callback_query?: { id: string; from: { id: number; first_name?: string }; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { message_id: number; chat: { id: number }; from?: { id: number; first_name?: string }; text?: string; reply_to_message?: { message_id: number; from?: { id: number; first_name?: string } } };
}
type Team = { id: number; name: string }[];

export class Cards {
  constructor(private d: { tg: Pick<Telegram, "call">; uchet: Pick<Uchet, "cardStatus">; store: Store; ownerId: number }) {}
  private group() { return this.d.store.getState<number>("tg_group"); }
  private async who(id: number, first?: string): Promise<string | null> {
    if (id === this.d.ownerId) return first || "Владелец";
    const t = (await this.d.store.getState<Team>("team")) ?? [];
    return t.find((x) => x.id === id)?.name ?? null;
  }
  async say(text: string) { const g = await this.group(); if (g) await this.d.tg.call("sendMessage", { chat_id: g, text }); }
  async newCard(o: Order) {
    const g = await this.group(); if (!g) return;
    const m = await this.d.tg.call<{ message_id: number }>("sendMessage", { chat_id: g, text: "Новый заказ\n" + cardText(o), reply_markup: cardKeyboard(o) });
    await this.d.store.saveCard({ order_id: o.id, chat_id: g, message_id: m.message_id, status: o.status, created_at: o.created_at, dialog_id: o.uzel_dialog_id, lang: o.lang, no: o.no });
  }
  async updateCard(o: Order) {
    const c = await this.d.store.getCard(o.id);
    if (!c) return this.newCard(o);
    try { await this.d.tg.call("editMessageText", { chat_id: c.chat_id, message_id: c.message_id, text: cardText(o), reply_markup: cardKeyboard(o) }); }
    catch (e) { if (!String(e).includes("message is not modified")) throw e; }   // карточка уже такая — это успех
    await this.d.store.saveCard({ ...c, status: o.status });
  }
  private async move(id: number, to: string, by: string, extra: Record<string, unknown>, cbId?: string) {
    const r = await this.d.uchet.cardStatus(id, to, by, extra);
    if (cbId) await this.d.tg.call("answerCallbackQuery", { callback_query_id: cbId, text: r.ok ? "Готово" : (r.message ?? r.error) });
    if (r.order) await this.updateCard(r.order);
    else if (!r.ok && !cbId) await this.say(r.message ?? r.error);
  }
  async onUpdate(u: Upd) {
    if (u.callback_query) {
      const q = u.callback_query, by = await this.who(q.from.id, q.from.first_name);
      if (!by) { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Нет доступа" }); return; }
      const [kind, idS, arg] = String(q.data ?? "").split(":"); const id = Number(idS);
      if (kind === "e") { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Правка — на планшете кассы, вкладка «Заказы»", show_alert: true }); return; }
      if (kind === "p") {
        const to = await this.d.store.getState<string>(`pay:${id}`);
        if (!to) { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id, text: "Нажмите «Доставлен»/«Выдан» ещё раз" }); return; }
        return this.move(id, to, by, { pay_kind: arg }, q.id);
      }
      if (kind !== "s") { await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id }); return; }
      const chat = q.message?.chat.id ?? (await this.group())!;
      if (arg === "delivered" || arg === "issued") {
        await this.d.store.setState(`pay:${id}`, arg);
        const no = (await this.d.store.getCard(id))?.no;
        await this.d.tg.call("sendMessage", { chat_id: chat, text: `${no ? `Заказ №${no}` : "Заказ"}: чем оплатили?`, reply_markup: { inline_keyboard: [PAY.map(([k, t]) => ({ text: t, callback_data: `p:${id}:${k}` }))] } });
        await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id }); return;
      }
      if (REASON.has(arg) || arg === "handed_to_courier") {
        const m = await this.d.tg.call<{ message_id: number }>("sendMessage", { chat_id: chat,
          text: arg === "handed_to_courier" ? "Кто везёт? Ответьте на это сообщение именем курьера." : "Причина (её увидит клиент)? Ответьте на это сообщение.",
          reply_markup: { force_reply: true } });
        await this.d.store.setAwait({ chat_id: chat, prompt_id: m.message_id, order_id: id, kind: arg === "handed_to_courier" ? "courier" : "reason", to: arg, by_name: by, by_id: q.from.id });
        await this.d.tg.call("answerCallbackQuery", { callback_query_id: q.id }); return;
      }
      return this.move(id, arg, by, {}, q.id);
    }
    const m = u.message; if (!m || !m.from) return;
    const text = (m.text ?? "").trim().replace(/^(\/[a-z]+)@\w+/i, "$1");   // «/here@ИмяБота» — та же команда
    if (m.reply_to_message && !text.startsWith("/")) {
      // ответ принимается только от нажавшего кнопку; чужой ответ ожидание не снимает
      const a = await this.d.store.getAwait(m.chat.id, m.reply_to_message.message_id);
      if (!a || !text || m.from.id !== a.by_id) return;
      if (!await this.d.store.takeAwait(m.chat.id, m.reply_to_message.message_id)) return;
      return this.move(a.order_id, a.to, a.by_name, a.kind === "courier" ? { courier: text } : { reason: text });
    }
    const owner = m.from.id === this.d.ownerId;
    if (text === "/here" && owner) { await this.d.store.setState("tg_group", m.chat.id); await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: "Карточки заказов будут приходить сюда." }); return; }
    if (text === "/allow" && owner && m.reply_to_message?.from) {
      const t = ((await this.d.store.getState<Team>("team")) ?? []).filter((x) => x.id !== m.reply_to_message!.from!.id);
      t.push({ id: m.reply_to_message.from.id, name: m.reply_to_message.from.first_name ?? "Сотрудник" });
      await this.d.store.setState("team", t); await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: `${t[t.length - 1].name} может нажимать кнопки.` }); return;
    }
    if (text === "/disallow" && owner && m.reply_to_message?.from) {
      await this.d.store.setState("team", ((await this.d.store.getState<Team>("team")) ?? []).filter((x) => x.id !== m.reply_to_message!.from!.id)); return;
    }
    if (text === "/team" && owner && m.chat.id === await this.group()) { const t = (await this.d.store.getState<Team>("team")) ?? []; await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: t.map((x) => x.name).join(", ") || "Команда пуста" }); return; }
    if ((text === "/pause" || text === "/resume") && owner) {
      await this.d.store.setState("paused", text === "/pause");
      await this.d.tg.call("sendMessage", { chat_id: m.chat.id, text: text === "/pause" ? "Бот на паузе: новые разговоры сразу передаются продавцу." : "Бот снова принимает заказы." });
    }
  }
}
