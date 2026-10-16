import { assertEquals } from "@std/assert";
import { ClaudeModel } from "../src/model.ts";

Deno.test("модель: идёт в beta.messages.create с бетой и fallbacks как есть", async () => {
  const seen: Record<string, unknown>[] = [];
  const m = new ClaudeModel("k", { beta: { messages: { create: (p: Record<string, unknown>) => { seen.push(p); return Promise.resolve({ content: [], stop_reason: "end_turn" }); } } } } as never);
  await m.create({ model: "claude-sonnet-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", messages: [] });
  assertEquals(seen[0].fallbacks, "default");
  assertEquals(seen[0].betas, ["server-side-fallback-2026-07-01"]);
});
