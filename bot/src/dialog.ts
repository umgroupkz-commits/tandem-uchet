// Ход разговора: системная часть (правила + меню, кэш), время и корзина — системным сообщением после
// хода клиента, цикл инструментов. История только дописывается (preserved thinking Sonnet 5.5).
import type { Uchet } from "./uchet.ts";
import type { Store } from "./store.ts";
import type { DialogState } from "./types.ts";
import { localNow, menuText, rulesText } from "./menu.ts";
import { runTool, TOOLS } from "./tools.ts";
import { handoffText } from "./templates.ts";

export type Block = { type: string; [k: string]: unknown };
export interface ModelClient { create(p: Record<string, unknown>): Promise<{ content: Block[]; stop_reason: string; usage?: Record<string, number> }> }
export interface Deps {
  uchet: Pick<Uchet, "menu" | "quote" | "create">;
  uzel: { send(d: string, t: string): Promise<{ ok: boolean; code?: string }>; handoff(d: string, r: string): Promise<boolean> };
  store: Store; model: ModelClient; modelName: string; now(): Date; uuid(): string;
}

export const SYSTEM_RULES = `Ты — помощник «Енешки» (Темиртау): выпечка, татарские пироги, полуфабрикаты, сеты. Принимаешь заказы в WhatsApp.
Отвечай на языке клиента (русский или казахский), коротко и тепло, как продавец в маленькой семейной пекарне. Без смайликов-простыней.
Что можно предлагать — только позиции из меню ниже, по их кодам в квадратных скобках. Чего нет в меню — нет. Цены не называй сам, кроме цены из меню за единицу.
Собери: позиции и количество (cart_set), способ получения, дату, час и, для доставки, адрес (order_details). Спрашивай по одному-двум пунктам за раз.
Когда всё известно — вызови order_summary: итог клиенту уйдёт сам. Не пересказывай итог. Дождись ответа.
Клиент ответил «да» (иъ, ия, дұрыс, бәрі дұрыс, верно, ок) — вызови order_submit. Клиент что-то меняет — правь корзину или детали и снова order_summary.
Жалоба, «позовите человека», правка уже принятого заказа, вопросы о скидках, оптовых закупках, работе, всё непонятное — handoff.
Не обещай скидок, сроков вне правил и того, чего нет в правилах. Не спорь. Номер телефона клиента уже известен — не спрашивай.`;

export async function handleTurn(deps: Deps, st: DialogState, clientText: string, clientAfterSummary: boolean): Promise<DialogState> {
  const menu = await deps.uchet.menu();
  const system = [{ type: "text", text: `${SYSTEM_RULES}\n\n# Правила\n${rulesText(menu)}\n\n# Меню\n${menuText(menu)}`, cache_control: { type: "ephemeral" } }];
  // После итога или заказа ход кончился результатом инструмента (последний — user с tool_result): новая реплика
  // клиента дописывается в него же — два user подряд API не примет. Модель этот ход ещё не видела: это не правка истории.
  const last = st.convo[st.convo.length - 1] as { role: string; content: unknown } | undefined;
  if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push({ type: "text", text: clientText });
  else st.convo.push({ role: "user", content: clientText });
  st.convo.push({ role: "system", content: `Сейчас ${localNow(deps.now())} (Темиртау). Клиент: ${st.name ?? "имя неизвестно"}. Корзина: ${JSON.stringify(st.cart)}. ` +
    `Получение: ${JSON.stringify(st.details)}. Этап: ${st.stage}${st.last_order_no ? `, последний заказ №${st.last_order_no}` : ""}.` });
  st.last_activity = deps.now().toISOString();
  let reply = "";
  for (let i = 0; i < 6; i++) {
    let resp;
    try { resp = await callModel(deps, system, st.convo); }
    catch { await giveUp(deps, st); return st; }
    st.convo.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason === "refusal") { await giveUp(deps, st); return st; }
    const uses = resp.content.filter((b) => b.type === "tool_use");
    reply = resp.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n").trim();
    if (resp.stop_reason !== "tool_use" || !uses.length) break;
    const results: Record<string, unknown>[] = [];
    let stop = false;
    for (const u of uses) {
      const r = await runTool(deps, st, menu, String(u.name), (u.input ?? {}) as Record<string, unknown>, { clientAfterSummary });
      results.push({ type: "tool_result", tool_use_id: u.id, content: r.result });
      stop = stop || !!r.stop;
    }
    st.convo.push({ role: "user", content: results });
    if (stop) { reply = ""; break; }
  }
  if (reply) await deps.uzel.send(st.dialog_id, reply);
  await deps.store.saveDialog(st);
  return st;
}

async function callModel(deps: Deps, system: unknown[], messages: unknown[]) {
  const p = { model: deps.modelName, max_tokens: 4000, system, tools: TOOLS, messages,
    output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  try { return await deps.model.create(p); }
  catch { return await deps.model.create(p); }   // один повтор: перегрузка, обрыв
}

async function giveUp(deps: Deps, st: DialogState) {
  await deps.uzel.send(st.dialog_id, handoffText(st.lang, "failed"));
  await deps.uzel.handoff(st.dialog_id, "бот не справился");
  await deps.store.saveDialog(st);
}
