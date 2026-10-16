import { assert, assertEquals } from "@std/assert";
import { hmacHex, UzelClient, verifyUzel } from "../src/uzel.ts";

const SECRET = "whsec_test";
const raw = '{"event":"message.in","eventId":"e1"}';

Deno.test("uzel: верная подпись принимается", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw, 1760600100), true);
});
Deno.test("uzel: подпись другого тела — отказ", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw + " ", 1760600100), false);
});
Deno.test("uzel: метка старше 5 минут — отказ", async () => {
  const ts = "1760600000";
  const sig = "sha256=" + await hmacHex(SECRET, ts + "." + raw);
  assertEquals(await verifyUzel(SECRET, ts, sig, raw, 1760600301), false);
});
Deno.test("uzel: нет заголовков или пустой секрет — отказ", async () => {
  assertEquals(await verifyUzel(SECRET, null, null, raw), false);
  assertEquals(await verifyUzel("", "1", "sha256=00", raw, 1), false);
});

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const f = (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    const key = (init?.method || "GET") + " " + new URL(url).pathname;
    const [status, json] = (routes[key] || (() => [404, { error: "нет" }]))(body);
    return Promise.resolve(new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));
  };
  return { f, calls };
}

Deno.test("uzel: отправка — 202 и id; ключ в заголовке", async () => {
  const { f, calls } = fakeFetch({ "POST /v1/messages": () => [202, { data: { id: "m1", status: "queued", dialogId: "d1" } }] });
  const u = new UzelClient("https://uzel.example.kz", "uzel_k", f);
  assertEquals(await u.send("d1", "Здравствуйте"), { ok: true, id: "m1" });
  assertEquals(calls[0].auth, "Bearer uzel_k");
  assertEquals(calls[0].body, { dialogId: "d1", text: "Здравствуйте" });
});
Deno.test("uzel: диалог на паузе — код bot_paused, без исключения", async () => {
  const { f } = fakeFetch({ "POST /v1/messages": () => [409, { error: "диалог ведёт человек", code: "bot_paused" }] });
  const u = new UzelClient("https://uzel.example.kz", "k", f);
  assertEquals(await u.send("d1", "x"), { ok: false, code: "bot_paused" });
});
Deno.test("uzel: история и диалог читаются из data", async () => {
  const { f } = fakeFetch({
    "GET /v1/dialogs/d1": () => [200, { data: { id: "d1", chatId: "77011234567", contactName: "Айгуль", assignedUserId: null, addressKind: "lid", contactPhone: "77015554433", bot: { leading: true, paused: null } } }],
    "GET /v1/dialogs/d1/messages": () => [200, { data: [{ id: "m2", direction: "in", type: "text", text: "пирог", author: "client", attachment: null, occurredAt: "2026-10-17T05:00:00Z" }] }],
  });
  const u = new UzelClient("https://uzel.example.kz", "k", f);
  const dlg = await u.getDialog("d1");
  assertEquals([dlg.contactName, dlg.addressKind, dlg.contactPhone], ["Айгуль", "lid", "77015554433"]);
  assertEquals((await u.messages("d1", 20))[0].text, "пирог");
});
Deno.test("uzel: каждый запрос с тайм-аутом", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  const f = (_u: string, init?: RequestInit) => { seen.push(init?.signal); return Promise.resolve(new Response("{}", { status: 202 })); };
  await new UzelClient("https://u", "k", f).handoff("d1", "x");
  assert(seen[0] instanceof AbortSignal);
});
