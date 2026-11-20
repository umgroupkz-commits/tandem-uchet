// Разбор заявок с вложениями (20.11.2026): голосовые - расшифровкой, фото и PDF клиента - как есть, служебная переписка.
import { assert, assertEquals } from "@std/assert";
import { ANALYSIS_SCHEMA, Leads, priceAnalysis } from "../src/leads.ts";
import { RetryLater } from "../src/media.ts";
import { MemStore } from "../src/store.ts";
import type { UzelMessage } from "../src/uzel.ts";
import { MENU, ScriptModel, text } from "./fakes.ts";

const msg = (id: string, direction: "in" | "out", txt: string, at: string): UzelMessage =>
  ({ id, direction, type: "text", text: txt, author: direction === "in" ? "client" : "phone_echo", attachment: null, occurredAt: at });
const att = (kind: string, id: string, extra: Record<string, unknown> = {}) => ({
  kind, id, url: `/v1/attachments/${id}`, state: "stored", byteSize: 1000, durationSeconds: 12,
  mimeType: kind === "image" ? "image/jpeg" : kind === "document" ? "application/pdf" : "audio/ogg; codecs=opus", ...extra });
const withAtt = (m: UzelMessage, a: Record<string, unknown>): UzelMessage => ({ ...m, type: String(a.kind), attachment: a as never });

const ORDER = { outcome: "order", stage: "done", city: "", other_city: false, items: [{ item_code: "P1", title: "пирог с мясом", qty: 1 }],
  total_stated: 0, kind: "pickup", for_date: "2026-11-14", reason: "", summary: "Взяла пирог" };
const OK = { content: [text(JSON.stringify(ORDER))], stop_reason: "end_turn" };
const DLG = { id: "d1", phone: "77011234567", name: "Айгуль" };

function setup(msgs: UzelMessage[], replies: unknown[], stt: { transcribe(b: Uint8Array, m: string): Promise<string> } | null) {
  const store = new MemStore();
  const model = new ScriptModel(replies as never);
  const downloads: string[] = [];
  const leads = new Leads({ store, model, modelName: "claude-sonnet-5-5", now: () => new Date("2026-11-13T10:00:00Z"),
    uzelApi: { messages: () => Promise.resolve(msgs) },
    uchet: { menu: () => Promise.resolve(MENU), leadUpsert: () => Promise.resolve({ ok: true }) },
    media: {
      download: (p) => {
        downloads.push(p);
        return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mime: p.includes("img") ? "image/jpeg" : p.includes("doc") ? "application/pdf" : "audio/ogg" });
      }, stt } });
  return { store, model, leads, downloads };
}
const wrote = (leads: Leads) => leads.sync(DLG, [msg("w1", "in", "пирог хочу", "2026-11-13T05:00:00.000Z")]);

Deno.test("разбор: голосовые - расшифровка в переписке (и продавца тоже), второй раз не распознаётся", async () => {
  const msgs = [msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z"),
    withAtt(msg("v1", "in", "", "2026-11-13T05:01:00Z"), att("voice", "aud1")),
    withAtt(msg("v2", "out", "", "2026-11-13T05:03:00Z"), att("voice", "aud2"))];
  let calls = 0;
  const stt = { transcribe: () => Promise.resolve(++calls === 1 ? "пирог с мясом на завтра" : "хорошо, сделаем к обеду") };
  const { leads, model, store } = setup(msgs, [OK, OK], stt);
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 1);
  const body = JSON.stringify(model.requests[0].messages);
  assert(body.includes("Клиент: [голосовое] расшифровка: «пирог с мясом на завтра»"), body);
  assert(body.includes("Продавец: [голосовое] расшифровка: «хорошо, сделаем к обеду»"), body);
  assertEquals(calls, 2);
  store.leads[0].analyzed_at = "2026-11-13T04:00:00.000Z";   // клиент дописал - разбор заново
  assertEquals(await leads.analyzeDue(), 1);
  assertEquals(calls, 2, "расшифровки взяты из памяти бота");
  assert(JSON.stringify(model.requests[1].messages).includes("пирог с мясом на завтра"));
});
Deno.test("разбор: нет распознавания - голосовое остаётся пометкой, файл не качается", async () => {
  const msgs = [msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z"), withAtt(msg("v1", "in", "", "2026-11-13T05:01:00Z"), att("voice", "aud1"))];
  const { leads, model, downloads } = setup(msgs, [OK], null);
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 1);
  assert(JSON.stringify(model.requests[0].messages).includes("Клиент: [голосовое]"));
  assertEquals(downloads.length, 0);
});
Deno.test("разбор: распознавание временно недоступно - разбор откладывается, а не идёт без голоса", async () => {
  const msgs = [msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z"), withAtt(msg("v1", "in", "", "2026-11-13T05:01:00Z"), att("voice", "aud1"))];
  const { leads, model, store } = setup(msgs, [OK], { transcribe: () => Promise.reject(new RetryLater("429")) });
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 0);
  assertEquals(model.requests.length, 0);
  assertEquals(store.leads[0].analyzed_at, null, "попробует на следующем проходе");
  assertEquals(await store.getState("voice:aud1"), null, "сбой не запомнен как пустая расшифровка");
});
Deno.test("разбор: файл не принят распознаванием - запоминается пустым, разбор идёт с пометкой", async () => {
  const msgs = [msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z"), withAtt(msg("v1", "in", "", "2026-11-13T05:01:00Z"), att("voice", "aud1"))];
  const { leads, model, store } = setup(msgs, [OK], { transcribe: () => Promise.reject(new Error("400 bad file")) });
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 1);
  assertEquals(await store.getState("voice:aud1"), "");
  assert(JSON.stringify(model.requests[0].messages).includes("Клиент: [голосовое]"));
});
Deno.test("разбор: фото и PDF клиента - разбору как есть, фото продавца - нет", async () => {
  const msgs = [msg("m1", "in", "вот чек", "2026-11-13T05:00:00Z"),
    withAtt(msg("i1", "in", "", "2026-11-13T05:01:00Z"), att("image", "img1")),
    withAtt(msg("d1", "in", "", "2026-11-13T05:02:00Z"), att("document", "doc1")),
    withAtt(msg("i2", "out", "прайс", "2026-11-13T05:03:00Z"), att("image", "img2"))];
  const { leads, model, downloads } = setup(msgs, [OK], null);
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 1);
  assertEquals(downloads.sort(), ["/v1/attachments/doc1", "/v1/attachments/img1"]);
  const content = (model.requests[0].messages as { content: { type: string; text?: string }[] }[])[0].content;
  assert(content[0].text!.includes("Клиент: [фото №1]"), content[0].text);
  assert(content[0].text!.includes("Клиент: [документ №1]"));
  assert(content[0].text!.includes("Продавец: [фото] прайс"));
  assertEquals(content.filter((b) => b.type === "image").length, 1);
  assertEquals(content.filter((b) => b.type === "document").length, 1);
});
Deno.test("разбор: большие, неподходящие и не дошедшие файлы не прикладываются", async () => {
  const msgs = [msg("m1", "in", "здравствуйте", "2026-11-13T05:00:00Z"),
    withAtt(msg("i1", "in", "", "2026-11-13T05:01:00Z"), att("image", "img1", { byteSize: 9_000_000 })),
    withAtt(msg("i2", "in", "", "2026-11-13T05:02:00Z"), att("image", "img2", { mimeType: "image/heic" })),
    withAtt(msg("i3", "in", "", "2026-11-13T05:03:00Z"), att("image", "img3", { state: "failed" }))];
  const { leads, downloads } = setup(msgs, [OK], null);
  await wrote(leads);
  assertEquals(await leads.analyzeDue(), 1);
  assertEquals(downloads.length, 0);
});
Deno.test("разбор: служебная переписка - итог internal, без суммы и причины, разговор закрыт", () => {
  const a = priceAnalysis(MENU, { ...ORDER, outcome: "internal", stage: "in_work", reason: "цех" } as never, "m");
  assertEquals(a.outcome, "internal");
  assertEquals(a.total, null);
  assertEquals(a.stage, "done");
  assertEquals(a.reason, null);
  assert((ANALYSIS_SCHEMA.properties.outcome.enum as string[]).includes("internal"));
});
