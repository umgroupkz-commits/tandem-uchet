import { assertEquals } from "@std/assert";
import { makeApp } from "../src/app.ts";

const app = makeApp({ inbound: { handle: () => Promise.resolve(new Response("ok")) } as never,
  cards: { onUpdate: () => Promise.resolve() } as never, tgSecret: "s", health: () => Promise.resolve({ ok: true }) });

Deno.test("app: /tg без секрета — 401", async () => {
  assertEquals((await app(new Request("https://b/tg", { method: "POST", body: "{}" }))).status, 401);
});
Deno.test("app: /tg с секретом — 200", async () => {
  assertEquals((await app(new Request("https://b/tg", { method: "POST", body: "{}", headers: { "x-telegram-bot-api-secret-token": "s" } }))).status, 200);
});
Deno.test("app: /health и 404", async () => {
  assertEquals((await app(new Request("https://b/health"))).status, 200);
  assertEquals((await app(new Request("https://b/x"))).status, 404);
});
Deno.test("app: /tg с неверным секретом той же длины — 401", async () => {
  assertEquals((await app(new Request("https://b/tg", { method: "POST", body: "{}", headers: { "x-telegram-bot-api-secret-token": "x" } }))).status, 401);
});
