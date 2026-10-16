// Вебхук «Узла»: проверка подписи, отброс повторов, ответ сразу; работа — в очереди своего диалога после
// короткой паузы (клиент часто пишет двумя-тремя сообщениями подряд). Текст — только из API «Узла».
import type { UzelClient, UzelEvent, UzelMessage } from "./uzel.ts";
import { verifyUzel } from "./uzel.ts";
import { type Deps, handleTurn } from "./dialog.ts";
import type { DialogState, Lang } from "./types.ts";
import { detectLang, maskPhone, maskPhonesIn, phoneOf } from "./menu.ts";
import { handoffText } from "./templates.ts";

export interface InDeps extends Deps {
  uzelApi: Pick<UzelClient, "getDialog" | "messages">; secret: string; debounceMs: number; paused(): Promise<boolean>;
  notify(text: string): Promise<void>;   // сообщение в группу продавцов (main.ts: cards.say)
}
const SIX_H = 6 * 3600e3, HALF_H = 30 * 60e3;
const HUMAN = new Set(["operator", "phone_echo"]);
const at = (m: UzelMessage) => Date.parse(m.occurredAt ?? m.createdAt ?? "") || 0;
// Вложение любого вида (фото, видео, голосовое, аудио, документ, стикер, неизвестное) или не-текст без текста
const notText = (m: UzelMessage) => !!m.attachment || (m.type !== "text" && !(m.text ?? "").trim());

export class Inbound {
  private chains = new Map<string, Promise<void>>();
  private timers = new Map<string, { t: ReturnType<typeof setTimeout>; done: () => void }>();
  private pending = new Set<Promise<void>>();
  constructor(private d: InDeps) {}

  async handle(req: Request): Promise<Response> {
    const raw = await req.text();
    let ev: UzelEvent | null = null;
    try { ev = JSON.parse(raw); } catch { /* ниже: без подписи — 401, с подписью — 400 */ }
    // ping при регистрации «Узел» подписывает новым секретом, которого бот ещё не знает; данных в нём нет
    if (ev && ev.event === "ping") return new Response("ok");
    if (!await verifyUzel(this.d.secret, req.headers.get("x-uzel-timestamp"), req.headers.get("x-uzel-signature"), raw)) {
      return new Response("bad signature", { status: 401 });
    }
    if (!ev) return new Response("bad json", { status: 400 });
    if (!ev.eventId) return new Response("ok");
    if (!await this.d.store.seenEvent(ev.eventId)) return new Response("dup");
    if (ev.event === "message.in" && ev.dialogId) this.schedule(ev.dialogId);
    return new Response("ok");
  }

  private schedule(id: string) {
    // новая реплика в паузе — прежний таймер снимается, а его ожидание закрывается: ход будет один, по всем репликам
    const old = this.timers.get(id);
    if (old) { clearTimeout(old.t); old.done(); }
    const p = new Promise<void>((done) => {
      const t = setTimeout(() => {
        this.timers.delete(id);
        const prev = this.chains.get(id) ?? Promise.resolve();
        const next: Promise<void> = prev.then(() => this.process(id)).catch((e) => this.failed(id, e))
          .finally(() => { if (this.chains.get(id) === next) this.chains.delete(id); done(); });
        this.chains.set(id, next);
      }, this.d.debounceMs);
      this.timers.set(id, { t, done });
    });
    this.pending.add(p); p.finally(() => this.pending.delete(p));
  }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }

  // Сбой хода: клиент не должен остаться без ответа. Всё — по возможности: сбой здесь не рвёт цепочку.
  private async failed(id: string, e: unknown) {
    const tryDo = async (f: () => Promise<unknown>) => { try { await f(); } catch { /* по возможности */ } };
    await tryDo(() => this.d.store.journal("error", id, maskPhonesIn(String(e))));
    let lang: Lang = "ru", name: string | null = null, phone = "";
    await tryDo(async () => { const st = await this.d.store.getDialog(id); if (st) ({ lang, name, phone } = st); });
    await tryDo(() => this.d.uzel.send(id, handoffText(lang, "failed", name)));
    await tryDo(() => this.d.uzel.handoff(id, "бот не справился"));
    await tryDo(() => this.d.notify(`Бот не справился с разговором${phone ? ` +${phone}` : ""} — ответьте клиенту в «Узле».`));
  }

  async process(id: string): Promise<void> {
    const dlg = await this.d.uzelApi.getDialog(id);
    const msgs: UzelMessage[] = (await this.d.uzelApi.messages(id, 30)).slice().sort((a, b) => at(a) - at(b));
    const phone = phoneOf(dlg);
    let st = await this.d.store.getDialog(id) ?? this.fresh(id, phone ?? "", dlg.contactName);
    if (phone) st.phone = phone;
    // Новое от клиента — после курсора и после последнего ответа человека (то, на что ответил человек, уже
    // разобрано). Курсора нет в окне — только после последнего исходящего вообще. Ответ самого бота
    // (program) при найденном курсоре границей не служит: клиент мог дописать, пока бот отвечал.
    const lastIdx = (pred: (m: UzelMessage) => boolean) => msgs.findLastIndex(pred);
    const cursor = st.last_client_msg_id ? msgs.findIndex((m) => m.id === st.last_client_msg_id) : -1;
    const human = lastIdx((m) => m.direction === "out" && HUMAN.has(m.author ?? ""));
    const start = st.last_client_msg_id && cursor < 0 ? lastIdx((m) => m.direction === "out") : Math.max(cursor, human);
    const clientNew = msgs.slice(start + 1).filter((m) => m.direction === "in");
    const lastIn = lastIdx((m) => m.direction === "in");
    // Ведёт человек или бот на паузе в «Узле» — молчать, но курсор сдвинуть: после возврата это не новое
    if (dlg.bot.paused || dlg.assignedUserId) {
      if (lastIn >= 0 && msgs[lastIn].id !== st.last_client_msg_id) { st.last_client_msg_id = msgs[lastIn].id; await this.d.store.saveDialog(st); }
      return;
    }
    if (!clientNew.length) return;
    const lastClient = clientNew[clientNew.length - 1];
    st.last_client_msg_id = lastClient.id;
    const now = this.d.now().getTime();
    const idle = now - new Date(st.last_activity).getTime();
    if (idle > SIX_H || (st.stage === "submitted" && idle > HALF_H)) st = { ...this.fresh(id, st.phone, st.name), lang: st.lang, details: { client_name: st.details.client_name, address: st.details.address } , last_client_msg_id: st.last_client_msg_id, last_order_no: st.last_order_no };
    const texts = clientNew.map((m) => (m.text ?? "").trim()).filter(Boolean);
    const lang = detectLang(texts.join(" "));
    if (lang) st.lang = lang;
    await this.d.store.journal("in", id, `${phone ? maskPhone(phone) : "скрытый номер"}: ${maskPhonesIn(texts.join(" | ")).slice(0, 300)}`);
    if (!phone) {   // скрытый адрес WhatsApp без номера — заказ не оформить, ответит человек
      await this.d.uzel.send(id, handoffText(st.lang, "human", st.name));
      await this.d.uzel.handoff(id, "скрытый номер — нужен телефон");
      await this.d.store.saveDialog(st);
      return;
    }
    if (clientNew.some(notText)) {
      await this.d.uzel.send(id, handoffText(st.lang, "files", st.name));
      await this.d.uzel.handoff(id, "файл, голосовое или стикер");
      await this.d.store.saveDialog(st);
      return;
    }
    if (!texts.length) { await this.d.store.saveDialog(st); return; }   // пустое (реакция и т. п.) — ход не нужен
    if (await this.d.paused()) {
      await this.d.uzel.send(id, handoffText(st.lang, "human", st.name));
      await this.d.uzel.handoff(id, "бот на паузе");
      await this.d.store.saveDialog(st);
      return;
    }
    const summaryAt = st.summary_sent_at ? Date.parse(st.summary_sent_at) : NaN;
    const afterSummary = !Number.isNaN(summaryAt) && clientNew.some((m) => at(m) > summaryAt);
    await handleTurn(this.d, st, texts.join("\n"), afterSummary);
  }

  private fresh(id: string, phone: string, name: string | null): DialogState {
    return { dialog_id: id, phone, name, lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat", summary_sent_at: null,
      draft_uid: this.d.uuid(), last_order_no: null, last_client_msg_id: null, last_activity: this.d.now().toISOString(),
      system_text: null, menu_seen_hash: null };
  }
}
