// Прогон эталонных разговоров на настоящей модели: подделки «Узла» и учёта (учёт считает по eval/menu.json),
// клиент — заранее записанные реплики. Итог: сколько заказов собрано верно и сколько стоил прогон.
import { handleTurn } from "../src/dialog.ts";
import { ClaudeModel } from "../src/model.ts";
import { MemStore } from "../src/store.ts";
import type { Menu } from "../src/types.ts";
import { FakeUchet, FakeUzel, newDialog } from "../tests/fakes.ts";

const menu: Menu = JSON.parse(await Deno.readTextFile(new URL("./menu.json", import.meta.url)));
const cases = JSON.parse(await Deno.readTextFile(new URL("./cases.json", import.meta.url)));
const only = Deno.args.includes("--only") ? Number(Deno.args[Deno.args.indexOf("--only") + 1]) : 0;
const model = new ClaudeModel(Deno.env.get("ANTHROPIC_API_KEY")!);
const usage = { in: 0, out: 0, cacheR: 0, cacheW: 0 };
const counting = { create: async (p: Record<string, unknown>) => { const r = await model.create(p);
  usage.in += r.usage?.input_tokens ?? 0; usage.out += r.usage?.output_tokens ?? 0;
  usage.cacheR += r.usage?.cache_read_input_tokens ?? 0; usage.cacheW += r.usage?.cache_creation_input_tokens ?? 0; return r; } };
let pass = 0;
const norm = (ls: { item_code: string; qty: number }[]) => ls.map((l) => `${l.item_code}:${Number(l.qty)}`).sort().join(",");
const iso = (k: number) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
for (const c of (only ? cases.slice(0, only) : cases)) {
  const uchet = new FakeUchet(); (uchet as unknown as { menu: () => Promise<Menu> }).menu = () => Promise.resolve(menu);
  const uzel = new FakeUzel();
  const d = { uchet, uzel, store: new MemStore(), model: counting, modelName: Deno.env.get("BOT_MODEL") || "claude-sonnet-5-5", now: () => new Date(), uuid: () => crypto.randomUUID() };
  let st = { ...newDialog(), lang: c.lang };
  for (const t of c.turns) {
    const after = !!st.summary_sent_at;
    st = await handleTurn(d as never, st, t, after);
    if (uzel.handoffs.length) break;
  }
  const got = uchet.creates[0] as Record<string, unknown> | undefined;
  const e = c.expect;
  const ok = e.handoff ? uzel.handoffs.length > 0
    : e.submit === false ? !got && !uzel.handoffs.length
    : !!got && got.kind === e.kind && norm(got.lines as { item_code: string; qty: number }[]) === norm(e.lines)
      && got.for_date === iso(e.for_date_offset) && (!e.ready_by || got.ready_by === e.ready_by);
  console.log(`${ok ? "ok  " : "FAIL"} ${c.id}${ok ? "" : "  → " + JSON.stringify(got ?? { handoffs: uzel.handoffs, sent: uzel.sent.map((x) => x.text) }).slice(0, 300)}`);
  if (ok) pass++;
}
const cost = (usage.in * 2 + usage.cacheW * 2.5 + usage.cacheR * 0.2 + usage.out * 10) / 1e6;
console.log(`\nверно ${pass} из ${only || cases.length}; токены вход ${usage.in}, кэш чтение ${usage.cacheR}, выход ${usage.out}; ≈ $${cost.toFixed(2)}`);
