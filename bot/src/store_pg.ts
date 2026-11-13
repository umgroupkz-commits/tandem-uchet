// Store на Postgres (общий сервер VPS, база bot). Запросы параметризованы; схема — sql/001_bot.sql.
import pg from "pg";
import type { DialogState, Lead } from "./types.ts";
import { type Await, type Card, FINAL, type Store } from "./store.ts";

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    // ошибка простаивающего соединения (перезапуск Postgres) без обработчика роняет процесс
    this.pool.on("error", (e: Error) => console.error("pg pool:", e.message));
  }
  async migrate() {   // по порядку; каждый файл можно повторять (if not exists)
    for (const f of ["001_bot.sql", "002_bot.sql", "003_bot.sql"]) await this.pool.query(await Deno.readTextFile(new URL(`../sql/${f}`, import.meta.url)));
  }
  private q(text: string, params: unknown[] = []) { return this.pool.query(text, params); }
  async seenEvent(id: string) {
    const r = await this.q("insert into bot.events_seen (event_id) values ($1) on conflict do nothing", [id]);
    if (Math.random() < 0.01) await this.q("delete from bot.events_seen where at < now() - interval '8 days'");
    return r.rowCount === 1;
  }
  async getDialog(id: string) {
    const r = await this.q("select data from bot.dialogs where dialog_id = $1", [id]);
    return r.rows[0] ? r.rows[0].data as DialogState : null;
  }
  async saveDialog(d: DialogState) {
    await this.q(`insert into bot.dialogs (dialog_id, data, updated_at) values ($1, $2, now())
                  on conflict (dialog_id) do update set data = excluded.data, updated_at = now()`, [d.dialog_id, JSON.stringify(d)]);
  }
  async getState<T>(key: string) {
    const r = await this.q("select value from bot.state where key = $1", [key]);
    return r.rows[0] ? r.rows[0].value as T : null;
  }
  async setState(key: string, v: unknown) {
    await this.q("insert into bot.state (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, JSON.stringify(v)]);
  }
  async getCard(id: number) {
    const r = await this.q("select * from bot.cards where order_id = $1", [id]);
    return r.rows[0] ? this.card(r.rows[0]) : null;
  }
  async saveCard(c: Card) {
    await this.q(`insert into bot.cards (order_id, chat_id, message_id, status, created_at, dialog_id, lang, no) values ($1,$2,$3,$4,$5,$6,$7,$8)
                  on conflict (order_id) do update set status = excluded.status, message_id = excluded.message_id, chat_id = excluded.chat_id`,
      [c.order_id, c.chat_id, c.message_id, c.status, c.created_at, c.dialog_id, c.lang, c.no]);
  }
  async openCards() {
    const r = await this.q("select * from bot.cards where not (status = any($1)) and created_at > now() - interval '15 days'", [[...FINAL]]);
    return r.rows.map((x: Record<string, unknown>) => this.card(x));
  }
  private card(x: Record<string, unknown>): Card {
    return { order_id: Number(x.order_id), chat_id: Number(x.chat_id), message_id: Number(x.message_id), status: String(x.status),
      created_at: new Date(x.created_at as string).toISOString(), dialog_id: (x.dialog_id as string) ?? null, lang: x.lang as "ru" | "kz", no: Number(x.no) };
  }
  async setAwait(a: Await) {
    await this.q(`insert into bot.awaits (chat_id, prompt_id, order_id, kind, to_status, by_name, by_id) values ($1,$2,$3,$4,$5,$6,$7)
                  on conflict do nothing`, [a.chat_id, a.prompt_id, a.order_id, a.kind, a.to, a.by_name, a.by_id]);
  }
  async getAwait(chat: number, p: number) {
    const r = await this.q("select * from bot.awaits where chat_id = $1 and prompt_id = $2", [chat, p]);
    return r.rows[0] ? this.await_(r.rows[0]) : null;
  }
  async takeAwait(chat: number, p: number) {
    const r = await this.q("delete from bot.awaits where chat_id = $1 and prompt_id = $2 returning *", [chat, p]);
    return r.rows[0] ? this.await_(r.rows[0]) : null;
  }
  private await_(x: Record<string, unknown>): Await {
    return { chat_id: Number(x.chat_id), prompt_id: Number(x.prompt_id), order_id: Number(x.order_id), kind: x.kind as Await["kind"],
      to: String(x.to_status), by_name: String(x.by_name), by_id: Number(x.by_id) };
  }
  async noticeOnce(id: number, kind: string) {
    const r = await this.q("insert into bot.notices (order_id, kind) values ($1, $2) on conflict do nothing", [id, kind]);
    return r.rowCount === 1;
  }
  async noticeUndo(id: number, kind: string) {
    await this.q("delete from bot.notices where order_id = $1 and kind = $2", [id, kind]);
  }
  async journal(kind: string, d: string | null, text: string) {
    await this.q("insert into bot.journal (kind, dialog_id, text) values ($1, $2, $3)", [kind, d, text.slice(0, 2000)]);
  }
  // Обращения (src/leads.ts решает, новый это эпизод или продолжение; здесь только чтение и запись)
  private static LEAD = `dialog_id, episode_start, phone, name, lang, first_text, last_at, msgs_in, msgs_out, first_reply_at, analyzed_at`;
  private static row(r: Record<string, unknown>): Lead {
    const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
    return { dialog_id: String(r.dialog_id), episode_start: iso(r.episode_start)!, phone: (r.phone as string) ?? null,
      name: (r.name as string) ?? null, lang: r.lang === "kz" ? "kz" : "ru", first_text: (r.first_text as string) ?? null,
      last_at: iso(r.last_at)!, msgs_in: Number(r.msgs_in), msgs_out: Number(r.msgs_out),
      first_reply_at: iso(r.first_reply_at), analyzed_at: iso(r.analyzed_at) };
  }
  async latestLead(id: string) {
    const r = await this.q(`select ${PgStore.LEAD} from bot.leads where dialog_id = $1 order by episode_start desc limit 1`, [id]);
    return r.rows[0] ? PgStore.row(r.rows[0]) : null;
  }
  async saveLead(l: Lead) {
    await this.q(
      `insert into bot.leads (${PgStore.LEAD}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (dialog_id, episode_start) do update set phone = excluded.phone, name = excluded.name, lang = excluded.lang,
         first_text = excluded.first_text, last_at = excluded.last_at, msgs_in = excluded.msgs_in, msgs_out = excluded.msgs_out,
         first_reply_at = excluded.first_reply_at, analyzed_at = excluded.analyzed_at`,
      [l.dialog_id, l.episode_start, l.phone, l.name, l.lang, l.first_text?.slice(0, 1000) ?? null, l.last_at, l.msgs_in, l.msgs_out,
        l.first_reply_at, l.analyzed_at]);
  }
  async leadsDue(quietBefore: Date, since: Date, limit: number) {
    const r = await this.q(
      `select ${PgStore.LEAD} from bot.leads where last_at < $1 and episode_start >= $2
         and (analyzed_at is null or analyzed_at < last_at) order by last_at limit $3`, [quietBefore, since, limit]);
    return r.rows.map(PgStore.row);
  }
}
