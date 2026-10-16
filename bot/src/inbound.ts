// Вебхук «Узла»: проверка подписи, отброс повторов, ответ сразу; работа — в очереди своего диалога после
// короткой паузы (клиент часто пишет двумя-тремя сообщениями подряд). Текст — только из API «Узла».
import type { UzelClient, UzelEvent, UzelMessage } from "./uzel.ts";
import { verifyUzel } from "./uzel.ts";
import { type Deps, handleTurn } from "./dialog.ts";
import type { DialogState } from "./types.ts";
import { detectLang, maskPhone, maskPhonesIn, phoneOf } from "./menu.ts";
import { handoffText } from "./templates.ts";

export interface InDeps extends Deps {
  uzelApi: Pick<UzelClient, "getDialog" | "messages">; secret: string; debounceMs: number; paused(): Promise<boolean>;
}
const SIX_H = 6 * 3600e3, HALF_H = 30 * 60e3;

export class Inbound {
  private chains = new Map<string, Promise<void>>();
  private timers = new Map<string, { t: ReturnType<typeof setTimeout>; done: () => void }>();
  private pending = new Set<Promise<void>>();
  constructor(private d: InDeps) {}

  async handle(req: Request): Promise<Response> {
    const raw = await req.text();
    if (!await verifyUzel(this.d.secret, req.headers.get("x-uzel-timestamp"), req.headers.get("x-uzel-signature"), raw)) {
      return new Response("bad signature", { status: 401 });
    }
    let ev: UzelEvent;
    try { ev = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
    if (ev.event === "ping" || !ev.eventId) return new Response("ok");
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
        const next = prev.then(() => this.process(id)).catch((e) => this.d.store.journal("error", id, String(e))).finally(done);
        this.chains.set(id, next);
      }, this.d.debounceMs);
      this.timers.set(id, { t, done });
    });
    this.pending.add(p); p.finally(() => this.pending.delete(p));
  }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }

  async process(id: string): Promise<void> {
    const dlg = await this.d.uzelApi.getDialog(id);
    if (dlg.bot.paused || dlg.assignedUserId) return;
    const msgs: UzelMessage[] = (await this.d.uzelApi.messages(id, 30)).slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const phone = phoneOf(dlg);
    let st = await this.d.store.getDialog(id) ?? this.fresh(id, phone ?? "", dlg.contactName);
    if (phone) st.phone = phone;
    const lastIdx = st.last_client_msg_id ? msgs.findIndex((m) => m.id === st.last_client_msg_id) : -1;
    const newer = msgs.slice(lastIdx + 1);
    const clientNew = newer.filter((m) => m.direction === "in");
    if (!clientNew.length) return;
    const lastClient = clientNew[clientNew.length - 1];
    if (newer.some((m) => m.direction === "out" && (m.author === "operator" || m.author === "phone_echo") && m.occurredAt > lastClient.occurredAt)) return;
    st.last_client_msg_id = lastClient.id;
    const now = this.d.now().getTime();
    const idle = now - new Date(st.last_activity).getTime();
    if (idle > SIX_H || (st.stage === "submitted" && idle > HALF_H)) st = { ...this.fresh(id, st.phone, st.name), lang: st.lang, details: { client_name: st.details.client_name, address: st.details.address } , last_client_msg_id: st.last_client_msg_id, last_order_no: st.last_order_no };
    const texts = clientNew.map((m) => m.text ?? "").filter(Boolean);
    const lang = detectLang(texts.join(" "));
    if (lang) st.lang = lang;
    await this.d.store.journal("in", id, `${phone ? maskPhone(phone) : "скрытый номер"}: ${maskPhonesIn(texts.join(" | ")).slice(0, 300)}`);
    if (!phone) {   // скрытый адрес WhatsApp без номера — заказ не оформить, ответит человек
      await this.d.uzel.send(id, handoffText(st.lang, "human", st.name));
      await this.d.uzel.handoff(id, "скрытый номер — нужен телефон");
      await this.d.store.saveDialog(st);
      return;
    }
    if (clientNew.some((m) => m.attachment && ["audio", "voice", "image", "video"].includes(m.attachment.kind))) {
      await this.d.uzel.send(id, handoffText(st.lang, "files", st.name));
      await this.d.uzel.handoff(id, "голосовое или фото");
      await this.d.store.saveDialog(st);
      return;
    }
    if (await this.d.paused()) {
      await this.d.uzel.send(id, handoffText(st.lang, "human", st.name));
      await this.d.uzel.handoff(id, "бот на паузе");
      await this.d.store.saveDialog(st);
      return;
    }
    const afterSummary = !!st.summary_sent_at && clientNew.some((m) => m.occurredAt > st.summary_sent_at!);
    await handleTurn(this.d, st, texts.join("\n"), afterSummary);
  }

  private fresh(id: string, phone: string, name: string | null): DialogState {
    return { dialog_id: id, phone, name, lang: "ru", convo: [], cart: [], details: {}, quote: null, stage: "chat", summary_sent_at: null,
      draft_uid: this.d.uuid(), last_order_no: null, last_client_msg_id: null, last_activity: this.d.now().toISOString(),
      system_text: null, menu_seen_hash: null };
  }
}
