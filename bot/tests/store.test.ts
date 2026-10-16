import { assert, assertEquals } from "@std/assert";
import { MemStore, type Store } from "../src/store.ts";

export async function storeContract(s: Store) {
  assertEquals(await s.seenEvent("e1"), true);
  assertEquals(await s.seenEvent("e1"), false);
  assertEquals(await s.getDialog("d1"), null);
  const d = { dialog_id: "d1", phone: "77011234567", name: "Айгуль", lang: "ru" as const, convo: [{ role: "user", content: "привет" }],
    cart: [], details: {}, quote: null, stage: "chat" as const, summary_sent_at: null, draft_uid: "u1", last_order_no: null,
    last_client_msg_id: null, last_activity: "2026-10-17T05:00:00.000Z", system_text: null, menu_seen_hash: null };
  await s.saveDialog(d);
  assertEquals((await s.getDialog("d1"))!.convo.length, 1);
  await s.setState("events_after", 15);
  assertEquals(await s.getState<number>("events_after"), 15);
  await s.saveCard({ order_id: 7, chat_id: -100, message_id: 55, status: "new", created_at: "2026-10-17T05:00:00.000Z", dialog_id: "d1", lang: "ru", no: 3 });
  assertEquals((await s.openCards()).map((c) => c.order_id), [7]);
  await s.saveCard({ order_id: 7, chat_id: -100, message_id: 55, status: "issued", created_at: "2026-10-17T05:00:00.000Z", dialog_id: "d1", lang: "ru", no: 3 });
  assertEquals((await s.openCards()).length, 0);
  await s.setAwait({ chat_id: -100, prompt_id: 9, order_id: 7, kind: "reason", to: "rejected", by_name: "Мария", by_id: 5 });
  assertEquals((await s.getAwait(-100, 9))!.by_id, 5);   // подсмотреть — не съесть
  const a = (await s.takeAwait(-100, 9))!;
  assertEquals([a.to, a.by_id, a.by_name, a.kind, a.order_id], ["rejected", 5, "Мария", "reason", 7]);
  assertEquals(await s.getAwait(-100, 9), null);
  assertEquals(await s.takeAwait(-100, 9), null);
  assertEquals(await s.noticeOnce(7, "confirmed"), true);
  assertEquals(await s.noticeOnce(7, "confirmed"), false);
  await s.journal("in", "d1", "+7 701 *** ** 67: привет");
  assert(true);
}

Deno.test("store: MemStore выполняет контракт", async () => { await storeContract(new MemStore()); });

Deno.test({ name: "store: PgStore выполняет контракт (BOT_TEST_DATABASE_URL)", ignore: !Deno.env.get("BOT_TEST_DATABASE_URL"), async fn() {
  const { PgStore } = await import("../src/store_pg.ts");
  const s = new PgStore(Deno.env.get("BOT_TEST_DATABASE_URL")!);
  await s.migrate();
  // чистая схема на каждый прогон: тестовая база, не боевая
  await (s as unknown as { q: (t: string) => Promise<unknown> }).q("truncate bot.events_seen, bot.dialogs, bot.state, bot.cards, bot.awaits, bot.notices, bot.journal");
  await storeContract(s);
}, sanitizeResources: false, sanitizeOps: false });

Deno.test("store: PgStore — у пула есть обработчик ошибок и тайм-ауты", async () => {
  const { PgStore } = await import("../src/store_pg.ts");
  const s = new PgStore("postgres://u:p@127.0.0.1:1/x");
  const pool = (s as unknown as { pool: { listenerCount(e: string): number; options: Record<string, unknown>; end(): Promise<void> } }).pool;
  assertEquals(pool.listenerCount("error"), 1);
  assertEquals([pool.options.connectionTimeoutMillis, pool.options.idleTimeoutMillis], [5000, 30000]);
  await pool.end();
});
