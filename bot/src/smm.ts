// Сводка по заявкам WhatsApp в Telegram-группу СММ (Андрей, 13.11.2026). Те же цифры, что в разделе бэк-офиса
// «Заявки WhatsApp», словами СММщицы: поступило, обработано, в работе, игнор, с других городов, продаж, сумма продаж.
// Каждое утро в 9:00 - за вчера; по команде /svodka - за сегодня или за N дней. Номеров клиентов в сводке нет.
import type { Store } from "./store.ts";
import { money } from "./menu.ts";

export interface LeadReport {
  ok: boolean; error?: string; message?: string;
  received: number; processed: number; in_work: number; ignored: number; other_city: number; sales: number;
  revenue: number; no_reply: number; no_order: number; avg_check: number | null; reply_median_min: number | null;
  reasons: { reason: string; n: number }[];
}
export interface SmmDeps {
  uchet: { leadReport(from: string, to: string): Promise<LeadReport> };
  tg: { call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> };
  store: Store;
  now(): Date;
  officeUrl: string;
}

const MORNING = 9;   // час Темиртау, после которого уходит утренняя сводка за вчера
const localDate = (now: Date, minusDays = 0) => new Date(now.getTime() + 5 * 3600e3 - minusDays * 86400e3).toISOString().slice(0, 10);
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const pct = (a: number, b: number) => b ? ` (${Math.round((a / b) * 100)} %)` : "";

export function summaryText(r: LeadReport, from: string, to: string, officeUrl: string): string {
  const period = from === to ? dm(from) : `${dm(from)} - ${dm(to)}`;
  const lines = [
    `Заявки WhatsApp Енешки, ${period}`,
    "",
    `Поступило: ${r.received}`,
    `Обработано: ${r.processed}${pct(r.processed, r.received)}`,
    `В работе: ${r.in_work}`,
    `Игнор: ${r.ignored}`,
    `С других городов: ${r.other_city}`,
    `Продаж: ${r.sales}${pct(r.sales, r.received)}`,
    `Сумма продаж: ${money(Number(r.revenue))}${r.avg_check ? `, средний чек ${money(Number(r.avg_check))}` : ""}`,
    `Без ответа продавца: ${r.no_reply}`,
  ];
  if (r.reply_median_min != null) lines.push(`Первый ответ продавца: ${r.reply_median_min} мин (медиана)`);
  if (r.reasons.length) lines.push("", "Почему не заказали: " + r.reasons.map((x) => `${x.reason} - ${x.n}`).join("; "));
  if (!r.received) lines.push("", "Обращений не было.");
  lines.push("", `Подробно по каждой заявке: ${officeUrl}`);
  return lines.join("\n");
}

export class SmmReports {
  constructor(private d: SmmDeps) {}

  chat() { return this.d.store.getState<number>("smm_chat"); }
  setChat(id: number) { return this.d.store.setState("smm_chat", id); }

  /** Сводка за последние days дней, включая сегодня (1 - только сегодня). */
  async text(days: number): Promise<string> {
    const now = this.d.now();
    const from = localDate(now, Math.max(1, days) - 1), to = localDate(now);
    return this.textFor(from, to);
  }
  private async textFor(from: string, to: string): Promise<string> {
    const r = await this.d.uchet.leadReport(from, to);
    if (!r.ok) throw new Error(`учёт не дал сводку: ${r.error ?? "?"} ${r.message ?? ""}`);
    return summaryText(r, from, to, this.d.officeUrl);
  }

  /** Утренняя сводка за вчера: один раз в день, после 9:00 по Темиртау. Группы нет - молчим. */
  async morning(): Promise<boolean> {
    const chat = await this.chat();
    if (!chat) return false;
    const now = this.d.now();
    const hour = new Date(now.getTime() + 5 * 3600e3).getUTCHours();
    const yesterday = localDate(now, 1);
    if (hour < MORNING || (await this.d.store.getState<string>("smm_sent_for")) === yesterday) return false;
    const text = await this.textFor(yesterday, yesterday);
    await this.d.tg.call("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
    await this.d.store.setState("smm_sent_for", yesterday);
    return true;
  }
}
