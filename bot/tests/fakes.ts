import type { Deps, ModelClient } from "../src/dialog.ts";
import { MemStore } from "../src/store.ts";
import type { DialogState, Menu, Order, Quote } from "../src/types.ts";
import { assert } from "@std/assert";

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
  menuData: Menu = MENU;
  menu() { return Promise.resolve(this.menuData); }
  // считает по тому меню, что отдаёт menu() — eval/run.ts подменяет menu() своим снимком
  async quote(p: Record<string, unknown>) {
    this.quotes.push(p);
    if (this.quoteAnswer) return this.quoteAnswer as never;
    const menu = await this.menu();
    const lines = (p.lines as { item_code: string; qty: number }[]).map((l) => { const it = menu.items.find((x) => x.item_code === l.item_code)!;
      return { item_code: l.item_code, title: it.title_ru, title_kz: it.title_kz, unit: it.unit_label, qty: l.qty, price: it.price, sum: l.qty * it.price }; });
    const q: Quote = { point_id: menu.points[0].id, point_name: menu.points[0].name, kind: p.kind as "pickup", for_date: String(p.for_date), ready_by: String(p.ready_by),
      address: (p.address as string) ?? null, lines, total: lines.reduce((s, l) => s + l.sum, 0), delivery_fee: 0, prepay_suggested: false };
    return { ok: true as const, quote: q };
  }
  create(p: Record<string, unknown>) { this.creates.push(p); this.no++;
    return Promise.resolve({ ok: true as const, order: { id: 100 + this.no, no: this.no, uid: p.uid } as unknown as Order }); }
}
// Запрос, который API примет: первое — user; без пустых сообщений; без двух user или двух assistant подряд;
// системное сообщение — только после user и последним или перед assistant; каждый tool_use отвечен
// tool_result в следующем user (результаты — первыми в нём), и каждый tool_result — на tool_use выше.
type Msg = { role: string; content: unknown };
export function assertValidRequest(p: Record<string, unknown>) {
  const ms = p.messages as Msg[];
  assert(Array.isArray(ms) && ms.length > 0, "пустой messages");
  assert(ms[0].role === "user", "первое сообщение не user");
  const blocks = (m: Msg) => Array.isArray(m.content) ? m.content as { type: string; id?: string; tool_use_id?: string }[] : [];
  ms.forEach((m, i) => {
    const prev = ms[i - 1], next = ms[i + 1];
    const empty = typeof m.content === "string" ? !m.content.trim() : !Array.isArray(m.content) || m.content.length === 0;
    assert(!empty, `сообщение ${i} (${m.role}) пустое`);
    if (m.role === "system") {
      assert(prev?.role === "user", `системное ${i} не после user`);
      assert(!next || next.role === "assistant", `за системным ${i} не assistant`);
    }
    if (prev && m.role !== "system") assert(!(prev.role === m.role), `два ${m.role} подряд: ${i - 1}, ${i}`);
    if (m.role === "assistant") {
      const ids = blocks(m).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (ids.length) {
        assert(next?.role === "user", `tool_use в ${i} без user-ответа`);
        const got = new Set(blocks(next).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id));
        for (const id of ids) assert(got.has(id), `tool_use ${id} без tool_result`);
      }
    }
    if (m.role === "user") {
      const bs = blocks(m), results = bs.filter((b) => b.type === "tool_result");
      if (results.length) {
        const firstOther = bs.findIndex((b) => b.type !== "tool_result");
        assert(firstOther === -1 || bs.slice(firstOther).every((b) => b.type !== "tool_result"), `в ${i} tool_result после текста`);
        const asked = new Set(prev ? blocks(prev).filter((b) => b.type === "tool_use").map((b) => b.id) : []);
        for (const r of results) assert(prev?.role === "assistant" && asked.has(r.tool_use_id), `tool_result ${r.tool_use_id} без tool_use`);
      }
    }
  });
}
// Модель по сценарию: каждый вызов отдаёт следующий заготовленный ответ (или бросает error) и запоминает
// запрос; каждый запрос проверяется на допустимость для API.
export class ScriptModel implements ModelClient {
  requests: Record<string, unknown>[] = [];
  constructor(private steps: { content?: unknown[]; stop_reason?: string; error?: unknown }[]) {}
  violations: string[] = [];
  create(p: Record<string, unknown>) {
    this.requests.push(structuredClone(p));
    // dialog.ts ловит любые ошибки модели (передача человеку), поэтому нарушение ещё и выбрасывается
    // вне хода — тест падает с «Uncaught», даже если сам его не проверяет
    try { assertValidRequest(p); } catch (e) { this.violations.push(String(e)); queueMicrotask(() => { throw e; }); throw e; }
    const s = this.steps.shift();
    if (!s) throw new Error("сценарий модели кончился");
    if (s.error) return Promise.reject(s.error);
    return Promise.resolve(s as never);
  }
}
export const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
export const text = (t: string) => ({ type: "text", text: t });
export function newDialog(): DialogState {
  return { dialog_id: "d1", phone: "77011234567", name: "Айгуль", lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat",
    summary_sent_at: null, draft_uid: "11111111-1111-4111-8111-111111111111", last_order_no: null, last_client_msg_id: null, last_activity: "2026-10-17T05:00:00.000Z",
    system_text: null, menu_seen_hash: null };
}
export function deps(model: ModelClient, uchet = new FakeUchet(), uzel = new FakeUzel()): Deps & { uchetF: FakeUchet; uzelF: FakeUzel; storeM: MemStore } {
  const store = new MemStore();
  return { uchet, uzel, store, model, modelName: "claude-sonnet-5-5", now: () => new Date("2026-10-17T05:00:00Z"),
    uuid: () => crypto.randomUUID(), uchetF: uchet, uzelF: uzel, storeM: store };
}
