import { assert, assertEquals, assertRejects } from "@std/assert";
import { Uchet } from "../src/uchet.ts";

function gate(handler: (action: string, payload: Record<string, unknown>) => unknown) {
  const calls: { action: string; payload: Record<string, unknown> }[] = [];
  const f = (_url: string, init?: RequestInit) => {
    const b = JSON.parse(String(init!.body));
    calls.push(b);
    return Promise.resolve(new Response(JSON.stringify(handler(b.action, b.payload)), { status: 200 }));
  };
  return { f, calls };
}

Deno.test("uchet: ключ бота в каждом вызове", async () => {
  const { f, calls } = gate(() => ({ ok: true, quote: { total: 1 } }));
  await new Uchet("https://u", "botkey", f).quote({ kind: "pickup" });
  assertEquals(calls[0].action, "bot_order_quote");
  assertEquals(calls[0].payload.service_key, "botkey");
});
Deno.test("uchet: меню кэшируется на минуту", async () => {
  let t = 0, n = 0;
  const { f } = gate(() => { n++; return { ok: true, now: "x", settings: {}, points: [], items: [] }; });
  const u = new Uchet("https://u", "k", f, () => t);
  await u.menu(); await u.menu(); t = 61_000; await u.menu();
  assertEquals(n, 2);
});
Deno.test("uchet: учёт упал — отдаём прежнее меню", async () => {
  let t = 0, down = false;
  const f = (_u: string, _i?: RequestInit) => down ? Promise.reject(new Error("net"))
    : Promise.resolve(new Response(JSON.stringify({ ok: true, now: "x", settings: { a: "1" }, points: [], items: [] })));
  const u = new Uchet("https://u", "k", f, () => t);
  await u.menu(); down = true; t = 120_000;
  assertEquals((await u.menu()).settings.a, "1");
});
Deno.test("uchet: учёт упал и кэша нет — исключение", async () => {
  const u = new Uchet("https://u", "k", () => Promise.reject(new Error("net")));
  await assertRejects(() => u.menu());
});
Deno.test("uchet: каждый вызов с тайм-аутом", async () => {
  const seen: (AbortSignal | null | undefined)[] = [];
  const f = (_u: string, init?: RequestInit) => { seen.push(init?.signal); return Promise.resolve(new Response('{"ok":true}')); };
  await new Uchet("https://u", "k", f).get(1);
  assert(seen[0] instanceof AbortSignal);
});
