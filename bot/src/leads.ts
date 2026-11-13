// Обращения клиентов (заявки) и разбор переписки моделью - для рекламы (решение Андрея 13.11.2026).
// Бот в тихом режиме не отвечает, а слушает: клиент написал - обращение (эпизод разговора), оператор ответил -
// тот же эпизод. Каждое изменение сразу уходит в учёт (tandem.wa_leads): СММщики видят новые заявки сразу.
// Когда разговор затих, модель читает всю переписку эпизода и говорит, был ли заказ, что заказали, на какую
// дату и почему не заказали. Сумму по меню считает программа, а не модель; названную оператором - берёт как есть.
import type { Lang, Lead, Menu } from "./types.ts";
import type { Store } from "./store.ts";
import type { Block, ModelClient } from "./dialog.ts";
import type { UzelMessage } from "./uzel.ts";
import { maskPhonesIn, nowText } from "./menu.ts";

export const EPISODE_GAP_H = 24;   // тишина дольше суток - следующее сообщение клиента уже новое обращение
export const QUIET_MIN = 40;       // столько минут без новых сообщений - разговор затих, пора разбирать
const LOOKBACK_D = 7;              // старше недели не разбираем: история в «Узле» дальше не нужна
const PER_TICK = 5;                // разборов за один проход: не забить модель после простоя

export interface LeadDeps {
  store: Store;
  uchet: { menu(): Promise<Menu>; leadUpsert(p: Record<string, unknown>): Promise<{ ok: boolean; error?: string; message?: string }> };
  uzelApi: { messages(id: string, limit?: number): Promise<UzelMessage[]> };
  model: ModelClient | null;       // нет ключа Anthropic - обращения считаются, разбора нет
  modelName: string;
  now(): Date;
}

export type Outcome = "order" | "no_order" | "unclear";
export interface Analysis {
  outcome: Outcome;
  items: { item_code: string | null; title: string; qty: number; unit: string; price: number | null; sum: number | null }[];
  total: number | null; total_menu: number | null; kind: "delivery" | "pickup" | null; for_date: string | null;
  reason: string | null; summary: string; model: string;
}

const iso = (t: number) => new Date(t).toISOString();
const atOf = (m: UzelMessage) => Date.parse(m.occurredAt ?? m.createdAt ?? "") || 0;

export class Leads {
  constructor(private d: LeadDeps) {}

  /** Клиент написал n сообщений (первое - в firstAt, последнее - в lastAt). Возвращает обращение. */
  async clientWrote(x: { dialog_id: string; firstAt: string; lastAt: string; n: number; phone: string | null;
    name: string | null; lang: Lang; text: string }): Promise<Lead> {
    const last = await this.d.store.latestLead(x.dialog_id);
    const fresh = !last || Date.parse(x.firstAt) - Date.parse(last.last_at) > EPISODE_GAP_H * 3600e3;
    const l: Lead = fresh
      ? { dialog_id: x.dialog_id, episode_start: x.firstAt, phone: x.phone, name: x.name, lang: x.lang,
          first_text: x.text.slice(0, 1000), last_at: x.lastAt, msgs_in: x.n, msgs_out: 0, first_reply_at: null, analyzed_at: null }
      : { ...last!, phone: x.phone ?? last!.phone, name: x.name ?? last!.name, lang: x.lang,
          last_at: iso(Math.max(Date.parse(last!.last_at), Date.parse(x.lastAt))), msgs_in: last!.msgs_in + x.n };
    await this.d.store.saveLead(l);
    await this.push(l);
    return l;
  }

  /** Оператор ответил (из окна «Узла» или с телефона). Ответ без обращения клиента - не заявка. */
  async operatorWrote(dialogId: string, at: string): Promise<Lead | null> {
    const last = await this.d.store.latestLead(dialogId);
    if (!last || Date.parse(at) - Date.parse(last.last_at) > EPISODE_GAP_H * 3600e3) return null;
    const l: Lead = { ...last, last_at: iso(Math.max(Date.parse(last.last_at), Date.parse(at))), msgs_out: last.msgs_out + 1,
      first_reply_at: last.first_reply_at ?? at };
    await this.d.store.saveLead(l);
    await this.push(l);
    return l;
  }

  /** Разобрать затихшие разговоры. Возвращает, сколько разобрано. */
  async analyzeDue(): Promise<number> {
    if (!this.d.model) return 0;
    const now = this.d.now().getTime();
    const due = await this.d.store.leadsDue(new Date(now - QUIET_MIN * 60e3), new Date(now - LOOKBACK_D * 86400e3), PER_TICK);
    let n = 0;
    for (const l of due) {
      try { if (await this.analyze(l)) n++; }
      catch (e) { await this.d.store.journal("error", l.dialog_id, maskPhonesIn("разбор: " + String(e))); }
    }
    return n;
  }

  async analyze(l: Lead): Promise<boolean> {
    const msgs = (await this.d.uzelApi.messages(l.dialog_id, 100)).slice().sort((a, b) => atOf(a) - atOf(b))
      .filter((m) => atOf(m) >= Date.parse(l.episode_start) - 60e3);
    const lines = msgs.map((m) => transcriptLine(m)).filter((s): s is string => !!s);
    const now = this.d.now();
    if (!lines.some((s) => s.includes("] Клиент:"))) {   // переписки нет (стёрта, не дошла) - разбирать нечего
      await this.d.store.saveLead({ ...l, analyzed_at: now.toISOString() });
      return false;
    }
    const menu = await this.d.uchet.menu();
    const r = await this.d.model!.create({
      model: this.d.modelName, max_tokens: 4000,
      system: [{ type: "text", text: `${ANALYZE_RULES}\n\n# Меню\n${menuForAnalysis(menu)}`, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Сейчас ${nowText(now)} (Темиртау).\n\n# Переписка\n${lines.join("\n")}` }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    });
    if (r.stop_reason === "refusal" || r.stop_reason === "max_tokens") throw new Error("модель не дала разбор: " + r.stop_reason);
    const text = r.content.filter((b: Block) => b.type === "text").map((b) => String(b.text ?? "")).pop() ?? "";
    const raw = JSON.parse(text) as RawAnalysis;
    const a = priceAnalysis(menu, raw, this.d.modelName);
    await this.d.store.journal("analysis", l.dialog_id,
      `${a.outcome}${a.total ? ` ${a.total} ₸` : ""}; токены вход ${r.usage?.input_tokens ?? "?"}, кэш ${r.usage?.cache_read_input_tokens ?? 0}, выход ${r.usage?.output_tokens ?? "?"}`);
    const done: Lead = { ...l, analyzed_at: now.toISOString() };
    await this.push(done, a);
    await this.d.store.saveLead(done);
    return true;
  }

  // В учёт - по возможности: сбой связи с учётом не должен ронять приём сообщений; повторит следующее изменение.
  private async push(l: Lead, a?: Analysis) {
    try {
      const r = await this.d.uchet.leadUpsert({ dialog_id: l.dialog_id, episode_start: l.episode_start, last_msg_at: l.last_at,
        phone: l.phone, name: l.name, lang: l.lang, first_text: l.first_text, msgs_in: l.msgs_in, msgs_out: l.msgs_out,
        first_reply_at: l.first_reply_at, ...(a ? { analysis: a } : {}) });
      if (!r.ok) await this.d.store.journal("error", l.dialog_id, `учёт не принял обращение: ${r.error ?? "?"} ${r.message ?? ""}`);
    } catch (e) {
      await this.d.store.journal("error", l.dialog_id, "учёт недоступен для обращения: " + String(e));
    }
  }
}

const WHO: Record<string, string> = { client: "Клиент", operator: "Продавец", phone_echo: "Продавец", program: "Бот" };
const KIND: Record<string, string> = { image: "фото", video: "видео", audio: "аудио", voice: "голосовое", document: "документ", sticker: "стикер" };
export function transcriptLine(m: UzelMessage): string | null {
  const t = atOf(m);
  if (!t) return null;
  const local = new Date(t + 5 * 3600e3).toISOString();
  const when = `${local.slice(8, 10)}.${local.slice(5, 7)} ${local.slice(11, 16)}`;
  const who = m.direction === "in" ? "Клиент" : (WHO[m.author ?? ""] ?? "Продавец");
  const att = m.attachment ? `[${KIND[m.attachment.kind] ?? "вложение"}] ` : "";
  const text = (m.text ?? "").trim();
  if (!att && !text) return null;
  return `[${when}] ${who}: ${att}${text}`;
}

// Меню для разбора: код, название, единица и цена. Пачки отдельными строками - так их и называют клиенты.
export function menuForAnalysis(menu: Menu): string {
  return menu.items.map((it) => `[${it.item_code}] ${it.title_ru} - ${it.price} ₸ за ${it.unit_label}`).join("\n");
}

export const ANALYZE_RULES = `Ты разбираешь переписку в WhatsApp между клиентом и продавцом «Енешки» (Темиртау: татарские пироги, выпечка, полуфабрикаты). Бот клиенту не отвечал, разговор вёл человек. Нужен итог для отчёта рекламщикам.
outcome: "order" - договорились о заказе: понятно, что берут, и продавец его принял (подтвердил, назвал сумму или время). "no_order" - клиент спрашивал или собирался, но не заказал, или разговор вообще не о заказе. "unclear" - нельзя понять: договорились голосовым или звонком, переписка оборвана, заказ под вопросом.
items: позиции заказа (для no_order - что клиент хотел, если ясно; для unclear - что обсуждали). item_code - код из меню в квадратных скобках, только если позиция совпадает точно; нет в меню или не ясно какая - пустая строка. title - как назвали. qty - количество в единице меню (кг или шт); «пачка» и «0,7» - это позиции «пачка 0,7 кг» по 1 шт.
total_stated - сумма заказа, которую назвал продавец, числом; не называл - 0. Сам не считай.
kind - "delivery", "pickup" или "unknown". for_date - дата, на которую заказ, в виде ГГГГ-ММ-ДД (считай от дат сообщений); неизвестна - пустая строка.
reason - для no_order коротко почему: «спросил цену и пропал», «нет в наличии», «не устроила цена», «не устроила доставка», «долго не отвечали», «не о заказе» или своими словами; иначе пустая строка.
summary - одна-две фразы по-русски: что хотел клиент и чем кончилось. Без номеров телефонов.
Не выдумывай: чего нет в переписке, того нет.`;

export const ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["outcome", "items", "total_stated", "kind", "for_date", "reason", "summary"],
  properties: {
    outcome: { type: "string", enum: ["order", "no_order", "unclear"] },
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["item_code", "title", "qty"],
      properties: { item_code: { type: "string" }, title: { type: "string" }, qty: { type: "number" } } } },
    total_stated: { type: "number" },
    kind: { type: "string", enum: ["delivery", "pickup", "unknown"] },
    for_date: { type: "string" },
    reason: { type: "string" },
    summary: { type: "string" },
  },
};

interface RawAnalysis {
  outcome: Outcome; items: { item_code: string; title: string; qty: number }[]; total_stated: number;
  kind: "delivery" | "pickup" | "unknown"; for_date: string; reason: string; summary: string;
}

// Цены и суммы - из меню. Сумма заказа: названная продавцом (в ней доставка и скидки), иначе по меню.
export function priceAnalysis(menu: Menu, raw: RawAnalysis, model: string): Analysis {
  const outcome: Outcome = ["order", "no_order", "unclear"].includes(raw.outcome) ? raw.outcome : "unclear";
  const items = (Array.isArray(raw.items) ? raw.items : []).filter((x) => x && Number(x.qty) > 0).map((x) => {
    const it = x.item_code ? menu.items.find((m) => m.item_code === x.item_code) ?? null : null;
    const qty = Math.round(Number(x.qty) * 1000) / 1000;
    return it
      ? { item_code: it.item_code, title: it.title_ru, qty, unit: it.unit_label, price: Number(it.price), sum: Math.round(Number(it.price) * qty) }
      : { item_code: null, title: String(x.title ?? "").slice(0, 200), qty, unit: "", price: null, sum: null };
  });
  const known = items.filter((x) => x.sum !== null);
  const totalMenu = known.length ? known.reduce((s, x) => s + (x.sum ?? 0), 0) : null;
  const stated = Number(raw.total_stated) > 0 ? Math.round(Number(raw.total_stated)) : null;
  return {
    outcome, items,
    total: outcome === "order" ? (stated ?? totalMenu) : null,
    total_menu: totalMenu,
    kind: raw.kind === "delivery" || raw.kind === "pickup" ? raw.kind : null,
    for_date: /^\d{4}-\d{2}-\d{2}$/.test(raw.for_date ?? "") ? raw.for_date : null,
    reason: outcome === "no_order" && raw.reason?.trim() ? raw.reason.trim().slice(0, 300) : null,
    summary: maskPhonesIn(String(raw.summary ?? "")).slice(0, 1000),
    model,
  };
}
