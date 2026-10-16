// Наблюдатель: раз в 10 с читает журнал заказов учёта «после номера N». Новый заказ — карточка в Telegram;
// смена статуса — карточка и, для клиентских статусов, сообщение клиенту (по разу на статус).
// Раз в минуту — напоминания о неподтверждённых: продавцам, потом клиенту.
import type { Order, OrderEvent } from "./types.ts";
import type { Store } from "./store.ts";
import type { Uchet } from "./uchet.ts";
import type { Cards } from "./telegram.ts";
import { soonText, statusText } from "./templates.ts";
import { inHours } from "./menu.ts";

export interface WDeps {
  uchet: Pick<Uchet, "events" | "menu">; cards: Pick<Cards, "newCard" | "updateCard" | "say">;
  uzel: { send(d: string, t: string): Promise<{ ok: boolean; code?: string }> }; store: Store; now(): Date;
}
const STALE_MS = 3600e3;

export class Watcher {
  private busy = false;
  constructor(private d: WDeps) {}
  async pollOnce(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const after = (await this.d.store.getState<number>("events_after")) ?? 0;
      const r = await this.d.uchet.events(after, 200);
      if (!r.ok) return 0;
      const menu = await this.d.uchet.menu();
      for (const ev of r.events) await this.handle(ev, menu.settings);
      await this.d.store.setState("events_after", r.last);
      return r.events.length;
    } finally { this.busy = false; }
  }
  private async handle(ev: OrderEvent, settings: Record<string, string>) {
    const o: Order = { ...ev.order, status: ev.status_to };
    if (o.point_id.startsWith("zz_") || !o.uzel_dialog_id) return;
    if (this.d.now().getTime() - new Date(ev.at).getTime() > STALE_MS) return;   // первый запуск: старое не рассылать
    if (ev.status_from === null) { await this.d.cards.newCard(ev.order); return; }
    await this.d.cards.updateCard(ev.order);
    if (ev.status_from === ev.status_to) return;   // правка заказа
    const text = statusText({ ...ev.order, status: ev.status_to }, settings);
    if (!text || !await this.d.store.noticeOnce(o.id, ev.status_to)) return;
    const r = await this.d.uzel.send(o.uzel_dialog_id!, text);
    if (!r.ok) await this.d.cards.say(`№${o.no}: клиенту не ушло «${text.slice(0, 80)}…» — диалог ведёт человек, сообщите сами.`);
  }
  async reminders() {
    const menu = await this.d.uchet.menu();
    if (!inHours(menu, this.d.now())) return;
    const remind = Number(menu.settings.client_confirm_remind_min || 15) * 60e3;
    const notice = Number(menu.settings.client_confirm_client_notice_min || 30) * 60e3;
    for (const c of await this.d.store.openCards()) {
      if (c.status !== "new") continue;
      const age = this.d.now().getTime() - new Date(c.created_at).getTime();
      if (age > remind && await this.d.store.noticeOnce(c.order_id, "remind")) await this.d.cards.say(`№${c.no} ждёт подтверждения ${Math.round(age / 60e3)} мин.`);
      if (age > notice && c.dialog_id && await this.d.store.noticeOnce(c.order_id, "soon")) {
        await this.d.uzel.send(c.dialog_id, soonText({ no: c.no, lang: c.lang, client_name: null } as Order));
      }
    }
  }
}
