// Служебный контакт виден не в каждом разговоре (20.11.2026): заявка точки рынка выглядит как обычный заказ, а
// что это точка - видно в соседнем разговоре. И символ \u0000 в тексте клиента не должен ронять запись в учёт.
import { assert, assertEquals } from "@std/assert";
import { Leads } from "../src/leads.ts";
import { MemStore } from "../src/store.ts";
import { Uchet } from "../src/uchet.ts";
import type { UzelMessage } from "../src/uzel.ts";
import { MENU, ScriptModel, text } from "./fakes.ts";

const msg = (id: string, direction: "in" | "out", txt: string, at: string): UzelMessage =>
  ({ id, direction, type: "text", text: txt, author: direction === "in" ? "client" : "phone_echo", attachment: null, occurredAt: at });
const verdict = (outcome: string, summary: string) => ({ content: [text(JSON.stringify({ outcome, stage: "done", city: "", other_city: false,
  items: [], total_stated: outcome === "order" ? 16500 : 0, kind: "unknown", for_date: "", reason: "", summary }))], stop_reason: "end_turn" });

const history = [
  msg("a1", "in", "Вареники с капустой 5 кг", "2026-11-15T11:46:00Z"), msg("a2", "out", "Хорошо", "2026-11-15T11:47:00Z"),
  msg("b1", "in", "Заказывала по 5 кг, чек с рынка", "2026-11-17T10:30:00Z"), msg("b2", "out", "Довезут", "2026-11-17T10:33:00Z"),
];

Deno.test("разбор: контакт оказался служебным - его прошлый разговор разбирается заново со справкой, один раз", async () => {
  const store = new MemStore();
  const model = new ScriptModel([verdict("order", "заказ вареников"), verdict("internal", "точка на рынке 6 мкр"),
    verdict("internal", "точка, заявка вареников")] as never);
  const pushed: Record<string, unknown>[] = [];
  const leads = new Leads({ store, model, modelName: "m", now: () => new Date("2026-11-17T12:00:00Z"),
    uzelApi: { messages: () => Promise.resolve(history) },
    uchet: { menu: () => Promise.resolve(MENU), leadUpsert: (p) => { pushed.push(p); return Promise.resolve({ ok: true }); } } });
  await leads.sync({ id: "d1", phone: "77011234567", name: "В" }, history);
  assertEquals(store.leads.length, 2);
  assertEquals(await leads.analyzeDue(), 2);                     // первый - «заказ», второй - «служебный»
  assertEquals(await store.getState("contact_internal:d1"), "точка на рынке 6 мкр");
  assertEquals(store.leads[0].analyzed_at, null, "прошлый разговор снова в очереди");
  assertEquals(await leads.analyzeDue(), 1);
  const third = JSON.stringify(model.requests[2].messages);
  assert(third.includes("Справка о контакте") && third.includes("точка на рынке 6 мкр"), third);
  assert(!third.includes("чек с рынка"), "чужой разговор в переписку не попал - только справка");
  assertEquals((pushed.at(-1)!.analysis as { outcome: string }).outcome, "internal");
  assertEquals(await leads.analyzeDue(), 0, "повторно контакт никого не перезапускает");
});

Deno.test("учёт: символ \\u0000 из текста клиента вычищается перед отправкой", async () => {
  let body = "";
  const f = (_u: string, init?: RequestInit) => { body = String(init!.body); return Promise.resolve(new Response('{"ok":true}', { status: 200 })); };
  await new Uchet("https://u", "k", f).leadUpsert({ first_text: "пирог\u0000 хочу" });
  assert(!body.includes("\\u0000"));
  assertEquals(JSON.parse(body).payload.first_text, "пирог хочу");
});
