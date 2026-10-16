// Учёт Тандема: служебные действия bot_* через tandem_gate (часть A). Ключ — ключ бота (settings.bot_key_hash).
import type { Fetch, Menu, Order, OrderEvent, Quote } from "./types.ts";

export type Ans<T> = ({ ok: true } & T) | { ok: false; error: string; message?: string; order?: Order };

export class Uchet {
  private cache: { at: number; menu: Menu } | null = null;
  constructor(private url: string, private key: string, private f: Fetch = fetch, private now: () => number = Date.now) {}
  private async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await this.f(this.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload: { ...payload, service_key: this.key } }) });
    if (res.status >= 500) throw new Error(`учёт: ${res.status}`);
    return await res.json() as T;
  }
  async menu(): Promise<Menu> {
    if (this.cache && this.now() - this.cache.at < 60_000) return this.cache.menu;
    try {
      const r = await this.call<Menu & { ok: boolean; error?: string }>("bot_menu");
      if (!r.ok) throw new Error("учёт: меню — " + (r.error ?? "отказ"));
      this.cache = { at: this.now(), menu: r };
      return r;
    } catch (e) {
      if (this.cache) return this.cache.menu;
      throw e;
    }
  }
  quote(p: Record<string, unknown>) { return this.call<Ans<{ quote: Quote }>>("bot_order_quote", p); }
  create(p: Record<string, unknown>) { return this.call<Ans<{ order: Order; repeat?: boolean }>>("bot_order_create", p); }
  events(after: number, limit = 200) { return this.call<{ ok: boolean; events: OrderEvent[]; last: number }>("bot_order_events", { after, limit }); }
  get(id: number) { return this.call<Ans<{ order: Order }>>("bot_order_get", { id }); }
  cancel(id: number, reason: string) { return this.call<Ans<{ order: Order }>>("bot_order_cancel", { id, reason }); }
  cardStatus(order_id: number, to: string, by_name: string, extra: Record<string, unknown> = {}) {
    return this.call<Ans<{ order: Order }>>("bot_card_status", { order_id, to, by_name, ...extra });
  }
  history(phone: string) { return this.call<{ ok: boolean; name: string | null; lang: string | null; addresses: string[] }>("bot_client_history", { phone }); }
}
