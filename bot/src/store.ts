// Хранилище бота: дедупликация событий «Узла», состояние диалогов, карточки Telegram, ожидания ответа
// в Telegram (причина, курьер), разовые уведомления, журнал. Заказы здесь не хранятся — они в учёте.
import type { DialogState, Lang, Lead } from "./types.ts";

export interface Card { order_id: number; chat_id: number; message_id: number; status: string; created_at: string; dialog_id: string | null; lang: Lang; no: number }
// by_id — Telegram id нажавшего кнопку: ответ с причиной или курьером принимается только от него
export interface Await { chat_id: number; prompt_id: number; order_id: number; kind: "reason" | "courier"; to: string; by_name: string; by_id: number }
export const FINAL = new Set(["delivered", "issued", "rejected", "cancelled", "not_collected"]);

export interface Store {
  /** Отметить событие «Узла»; true — событие НОВОЕ (первый раз), false — повтор. */
  seenEvent(id: string): Promise<boolean>;
  getDialog(id: string): Promise<DialogState | null>;
  saveDialog(d: DialogState): Promise<void>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, v: unknown): Promise<void>;
  getCard(orderId: number): Promise<Card | null>;
  saveCard(c: Card): Promise<void>;
  openCards(): Promise<Card[]>;
  setAwait(a: Await): Promise<void>;
  getAwait(chatId: number, promptId: number): Promise<Await | null>;    // подсмотреть, не снимая
  takeAwait(chatId: number, promptId: number): Promise<Await | null>;   // снять
  noticeOnce(orderId: number, kind: string): Promise<boolean>;   // true — отметка поставлена сейчас (уведомления ещё не было)
  noticeUndo(orderId: number, kind: string): Promise<void>;      // снять отметку: уведомление не ушло
  journal(kind: string, dialogId: string | null, text: string): Promise<void>;
  /** Обращения (заявки): последнее по диалогу, запись, и те, что затихли и ещё не разобраны (src/leads.ts). */
  latestLead(dialogId: string): Promise<Lead | null>;
  saveLead(l: Lead): Promise<void>;
  leadsDue(quietBefore: Date, since: Date, limit: number): Promise<Lead[]>;
}

export class MemStore implements Store {
  events = new Set<string>(); dialogs = new Map<string, DialogState>(); state = new Map<string, unknown>();
  cards = new Map<number, Card>(); awaits = new Map<string, Await>(); notices = new Set<string>(); log: string[] = [];
  seenEvent(id: string) { const n = !this.events.has(id); this.events.add(id); return Promise.resolve(n); }
  getDialog(id: string) { const d = this.dialogs.get(id); return Promise.resolve(d ? structuredClone(d) : null); }
  saveDialog(d: DialogState) { this.dialogs.set(d.dialog_id, structuredClone(d)); return Promise.resolve(); }
  getState<T>(key: string) { return Promise.resolve((this.state.has(key) ? this.state.get(key) : null) as T | null); }
  setState(key: string, v: unknown) { this.state.set(key, v); return Promise.resolve(); }
  getCard(id: number) { return Promise.resolve(this.cards.get(id) ?? null); }
  saveCard(c: Card) { this.cards.set(c.order_id, { ...c }); return Promise.resolve(); }
  openCards() { return Promise.resolve([...this.cards.values()].filter((c) => !FINAL.has(c.status))); }
  setAwait(a: Await) { this.awaits.set(`${a.chat_id}:${a.prompt_id}`, a); return Promise.resolve(); }
  getAwait(chat: number, p: number) { return Promise.resolve(this.awaits.get(`${chat}:${p}`) ?? null); }
  takeAwait(chat: number, p: number) { const k = `${chat}:${p}`; const a = this.awaits.get(k) ?? null; this.awaits.delete(k); return Promise.resolve(a); }
  noticeOnce(id: number, kind: string) { const k = `${id}:${kind}`; const n = !this.notices.has(k); this.notices.add(k); return Promise.resolve(n); }
  noticeUndo(id: number, kind: string) { this.notices.delete(`${id}:${kind}`); return Promise.resolve(); }
  journal(kind: string, d: string | null, text: string) { this.log.push(`${kind} ${d ?? "-"} ${text}`); return Promise.resolve(); }
  leads: Lead[] = [];
  latestLead(id: string) {
    const l = this.leads.filter((x) => x.dialog_id === id).sort((a, b) => Date.parse(b.episode_start) - Date.parse(a.episode_start))[0];
    return Promise.resolve(l ? { ...l } : null);
  }
  saveLead(l: Lead) {
    const i = this.leads.findIndex((x) => x.dialog_id === l.dialog_id && x.episode_start === l.episode_start);
    if (i >= 0) this.leads[i] = { ...l }; else this.leads.push({ ...l });
    return Promise.resolve();
  }
  leadsDue(quietBefore: Date, since: Date, limit: number) {
    return Promise.resolve(this.leads
      .filter((l) => Date.parse(l.last_at) < quietBefore.getTime() && Date.parse(l.episode_start) >= since.getTime()
        && (!l.analyzed_at || Date.parse(l.analyzed_at) < Date.parse(l.last_at)))
      .sort((a, b) => Date.parse(a.last_at) - Date.parse(b.last_at)).slice(0, limit).map((l) => ({ ...l })));
  }
}
