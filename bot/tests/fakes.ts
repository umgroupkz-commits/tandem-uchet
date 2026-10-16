import type { Deps, ModelClient } from "../src/dialog.ts";
import { MemStore } from "../src/store.ts";
import type { DialogState, Menu, Order, Quote } from "../src/types.ts";

export const MENU: Menu = {
  now: "2026-10-17T10:00",
  settings: { client_hours_from: "09:00", client_hours_to: "18:00", client_fresh_cutoff: "12:00", client_fresh_ready: "18:00",
    stock_ready_minutes: "120", client_min_order: "7000", client_max_days_ahead: "14", client_pickup_points: "eneshka",
    client_prepay_rule: "off", client_confirm_remind_min: "15", client_confirm_client_notice_min: "30",
    kaspi_details_ru: "Kaspi: +7 775 000 00 00, Светлана Г.", kaspi_details_kz: "Kaspi: +7 775 000 00 00, Светлана Г.", couriers: "Ерлан" },
  points: [{ id: "eneshka", name: "Енешка, Караганды 74/2" }],
  items: [
    { item_code: "P1", title_ru: "Пирог с мясом", title_kz: "Етті бәліш", composition_ru: "говядина, картофель, лук", composition_kz: null,
      unit_label: "кг", price: 4550, min_qty: 1, step: 0.5, section: "Татарские пироги", ready_kind: "fresh", stopped: false, stop_until: null,
      sort_order: 1, active: true, checked: true },
    { item_code: "B1", title_ru: "Беляш", title_kz: "Беляш", composition_ru: null, composition_kz: null, unit_label: "шт", price: 500,
      min_qty: 2, step: 1, section: "Выпечка", ready_kind: "stock", stopped: true, stop_until: "2026-10-17", sort_order: 2, active: true, checked: true },
    { item_code: "M1", title_ru: "Манты с говядиной", title_kz: "Сиыр етінен манты", composition_ru: null, composition_kz: null, unit_label: "кг",
      price: 4400, min_qty: 1, step: 0.5, section: "Полуфабрикаты", ready_kind: "stock", stopped: false, stop_until: null, sort_order: 3, active: true, checked: true },
    { item_code: "S1", title_ru: "Сет «Чайный дастархан»", title_kz: "«Шай дастарханы» сеті", composition_ru: "пироги и выпечка к чаю", composition_kz: null,
      unit_label: "сет", price: 19300, min_qty: 1, step: 1, section: "Сеты", ready_kind: "fresh", stopped: false, stop_until: null, sort_order: 4, active: true, checked: true },
  ],
};

export class FakeUzel {
  sent: { dialogId: string; text: string }[] = []; handoffs: { dialogId: string; reason: string }[] = []; paused = false;
  send(dialogId: string, text: string) { if (this.paused) return Promise.resolve({ ok: false as const, code: "bot_paused" });
    this.sent.push({ dialogId, text }); return Promise.resolve({ ok: true as const, id: "m" + this.sent.length }); }
  handoff(dialogId: string, reason: string) { this.handoffs.push({ dialogId, reason }); return Promise.resolve(true); }
}
export class FakeUchet {
  quotes: Record<string, unknown>[] = []; creates: Record<string, unknown>[] = []; quoteAnswer: unknown = null; no = 11;
  menu() { return Promise.resolve(MENU); }
  quote(p: Record<string, unknown>) {
    this.quotes.push(p);
    if (this.quoteAnswer) return Promise.resolve(this.quoteAnswer as never);
    const lines = (p.lines as { item_code: string; qty: number }[]).map((l) => { const it = MENU.items.find((x) => x.item_code === l.item_code)!;
      return { item_code: l.item_code, title: it.title_ru, title_kz: it.title_kz, unit: it.unit_label, qty: l.qty, price: it.price, sum: l.qty * it.price }; });
    const q: Quote = { point_id: "eneshka", point_name: MENU.points[0].name, kind: p.kind as "pickup", for_date: String(p.for_date), ready_by: String(p.ready_by),
      address: (p.address as string) ?? null, lines, total: lines.reduce((s, l) => s + l.sum, 0), delivery_fee: 0, prepay_suggested: false };
    return Promise.resolve({ ok: true as const, quote: q });
  }
  create(p: Record<string, unknown>) { this.creates.push(p); this.no++;
    return Promise.resolve({ ok: true as const, order: { id: 100 + this.no, no: this.no, uid: p.uid } as unknown as Order }); }
}
// Модель по сценарию: каждый вызов отдаёт следующий заготовленный ответ и запоминает запрос.
export class ScriptModel implements ModelClient {
  requests: Record<string, unknown>[] = [];
  constructor(private steps: { content: unknown[]; stop_reason: string }[]) {}
  create(p: Record<string, unknown>) { this.requests.push(structuredClone(p)); const s = this.steps.shift();
    if (!s) throw new Error("сценарий модели кончился"); return Promise.resolve(s as never); }
}
export const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
export const text = (t: string) => ({ type: "text", text: t });
export function newDialog(): DialogState {
  return { dialog_id: "d1", phone: "77011234567", name: "Айгуль", lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat",
    summary_sent_at: null, draft_uid: "11111111-1111-4111-8111-111111111111", last_order_no: null, last_client_msg_id: null, last_activity: "2026-10-17T05:00:00.000Z" };
}
export function deps(model: ModelClient, uchet = new FakeUchet(), uzel = new FakeUzel()): Deps & { uchetF: FakeUchet; uzelF: FakeUzel; storeM: MemStore } {
  const store = new MemStore();
  return { uchet, uzel, store, model, modelName: "claude-sonnet-5-5", now: () => new Date("2026-10-17T05:00:00Z"),
    uuid: () => crypto.randomUUID(), uchetF: uchet, uzelF: uzel, storeM: store };
}
