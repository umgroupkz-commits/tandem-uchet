// Ход разговора: системная часть (правила + меню, кэш), время и корзина — системным сообщением после
// хода клиента, цикл инструментов. История только дописывается (preserved thinking Sonnet 5.5).
import type { Uchet } from "./uchet.ts";
import type { Store } from "./store.ts";
import type { DialogState, Menu } from "./types.ts";
import { localNow, menuText, rulesText } from "./menu.ts";
import { runTool, type ToolCtx, TOOLS } from "./tools.ts";
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

// Правила и меню — переменная часть системного текста. Сравнивается по отпечатку: поменялась — модель узнаёт
// системным сообщением, а верхняя системная часть разговора остаётся прежней байт в байт.
const contextText = (menu: Menu) => `# Правила\n${rulesText(menu)}\n\n# Меню\n${menuText(menu)}`;
function fingerprint(s: string): string {   // FNV-1a, 32 бита: отличить «то же» от «другое»
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + ":" + s.length;
}
type Msg = { role: string; content: unknown };

export async function handleTurn(deps: Deps, st: DialogState, clientText: string, clientAfterSummary: boolean): Promise<DialogState> {
  const menu = await deps.uchet.menu();
  const ctxNow = contextText(menu);
  // Системная часть замораживается на весь разговор: preserved thinking Sonnet 5.5 требует, чтобы она
  // не менялась (иначе 400 на всю открытую историю), и на ней держится кэш.
  if (!st.convo.length || !st.system_text) { st.system_text = `${SYSTEM_RULES}\n\n${ctxNow}`; st.menu_seen_hash = fingerprint(ctxNow); }
  const system = [{ type: "text", text: st.system_text, cache_control: { type: "ephemeral" } }];
  // Откат при сбое: история возвращается к виду до хода (последнее сообщение — его содержимым), иначе
  // в ней останутся реплика без ответа или tool_use без результата, и следующий запрос API не примет.
  const base = st.convo.length;
  const trailing = base ? structuredClone(st.convo[base - 1]) : null;
  const seenBefore = st.menu_seen_hash;
  const rollback = async () => {
    st.convo.length = base;
    if (trailing) st.convo[base - 1] = trailing;
    st.menu_seen_hash = seenBefore;
    await giveUp(deps, st);
    return st;
  };
  // После итога или заказа ход кончился результатом инструмента (последний — user с tool_result): новая реплика
  // клиента дописывается в него же — два user подряд API не примет. Модель этот ход ещё не видела: это не правка истории.
  const last = st.convo[st.convo.length - 1] as Msg | undefined;
  if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push({ type: "text", text: clientText });
  else st.convo.push({ role: "user", content: clientText });
  // Одно системное сообщение на ход (два подряд API не примет: за системным — только assistant): сначала,
  // если меню или правила поменялись, их новый текст, затем время и корзина.
  let update = "";
  if (fingerprint(ctxNow) !== st.menu_seen_hash) {
    update = `Меню и правила обновились — действуют эти:\n${ctxNow}\n\n`;
    st.menu_seen_hash = fingerprint(ctxNow);
  }
  st.convo.push({ role: "system", content: update + `Сейчас ${localNow(deps.now())} (Темиртау). Клиент: ${st.name ?? "имя неизвестно"}. Корзина: ${JSON.stringify(st.cart)}. ` +
    `Получение: ${JSON.stringify(st.details)}. Этап: ${st.stage}${st.last_order_no ? `, последний заказ №${st.last_order_no}` : ""}.` });
  st.last_activity = deps.now().toISOString();
  // ctx общий на ход: правка корзины, деталей или новый итог в этом же ходе снимают «клиент ответил после итога»
  const ctx: ToolCtx = { clientAfterSummary };
  let reply = "";
  for (let i = 0; i < 6; i++) {
    let resp;
    try { resp = await callModel(deps, system, st.convo); }
    catch { return await rollback(); }
    if (resp.stop_reason === "refusal") return await rollback();
    const uses = resp.content.filter((b) => b.type === "tool_use");
    // оборванный ответ (max_tokens и т. п.) с tool_use без результата — в историю его не взять
    if (uses.length && resp.stop_reason !== "tool_use") return await rollback();
    if (!resp.content.length) {
      // пустой ответ: пустое сообщение API не примет; после системного без assistant — тоже
      if ((st.convo[st.convo.length - 1] as Msg).role === "system") return await rollback();
      reply = ""; break;
    }
    st.convo.push({ role: "assistant", content: resp.content });
    reply = resp.content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n").trim();
    if (!uses.length) break;
    const results: Record<string, unknown>[] = [];
    let stop = false;
    for (const u of uses) {
      const r = await runTool(deps, st, menu, String(u.name), (u.input ?? {}) as Record<string, unknown>, ctx);
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

// Повтор — один и только там, где он может помочь: 429, 5xx, обрыв связи (ошибка без кода ответа).
// 400/401/403/404/413 повтор не исправит. SDK сам не повторяет (maxRetries: 0 в model.ts).
function retryable(e: unknown): boolean {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s !== "number" || s === 429 || s >= 500;
}

async function callModel(deps: Deps, system: unknown[], messages: unknown[]) {
  const p = { model: deps.modelName, max_tokens: 4000, system, tools: TOOLS, messages,
    cache_control: { type: "ephemeral" },   // автоматический кэш растущей истории, вдобавок к метке на системной части
    output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  try { return await deps.model.create(p); }
  catch (e) { if (!retryable(e)) throw e; return await deps.model.create(p); }
}

async function giveUp(deps: Deps, st: DialogState) {
  await deps.uzel.send(st.dialog_id, handoffText(st.lang, "failed", st.name));
  await deps.uzel.handoff(st.dialog_id, "бот не справился");
  await deps.store.saveDialog(st);
}
