// «Узел»: проверка подписи оповещений (README «Узла», «Оповещения (вебхук)») и клиент API по ключу-боту.
// Текст сообщений берётся только из API — в оповещении его нет.
import type { Fetch } from "./types.ts";

const enc = new TextEncoder();
export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export async function verifyUzel(secret: string, ts: string | null, sig: string | null, raw: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  return sameText("sha256=" + await hmacHex(secret, ts + "." + raw), sig);
}

export interface UzelEvent {
  event: string; eventId: string; ts: string; channelId: string | null; dialogId: string | null; messageId: string | null;
  author: string | null; status: string | null; bot: boolean | null; pauseKind: string | null; pauseReason: string | null;
}
export interface UzelMessage {
  id: string; direction: "in" | "out"; type: string; text: string | null; author: string | null;
  attachment: { kind: string } | null; occurredAt: string;
}
export interface UzelDialog {
  id: string; chatId: string; contactName: string | null; assignedUserId: string | null;
  // скрытый адрес WhatsApp (…@lid): chatId — служебные цифры; contactPhone — настоящий номер или null
  addressKind: "phone" | "lid"; contactPhone: string | null;
  bot: { leading: boolean; paused: { kind: string; reason: string | null } | null };
}

export class UzelClient {
  constructor(private base: string, private key: string, private f: Fetch = fetch) {}
  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.f(this.base + path, {
      method, headers: { authorization: "Bearer " + this.key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json: Record<string, unknown> = {};
    try { json = await res.json(); } catch { /* пустой ответ */ }
    return { status: res.status, json };
  }
  async getDialog(id: string): Promise<UzelDialog> {
    const r = await this.req("GET", `/v1/dialogs/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new Error(`Узел: диалог ${r.status}`);
    return r.json.data as UzelDialog;
  }
  async messages(id: string, limit = 30): Promise<UzelMessage[]> {
    const r = await this.req("GET", `/v1/dialogs/${encodeURIComponent(id)}/messages?limit=${limit}`);
    if (r.status !== 200) throw new Error(`Узел: история ${r.status}`);
    return r.json.data as UzelMessage[];
  }
  async send(dialogId: string, text: string): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
    const r = await this.req("POST", "/v1/messages", { dialogId, text });
    if (r.status === 202) return { ok: true, id: String((r.json.data as Record<string, unknown>).id) };
    return { ok: false, code: String(r.json.code ?? r.status) };
  }
  async handoff(dialogId: string, reason: string): Promise<boolean> {
    const r = await this.req("POST", `/v1/dialogs/${encodeURIComponent(dialogId)}/handoff`, { reason: reason.slice(0, 500) });
    return r.status === 200;
  }
  async registerWebhook(url: string): Promise<string> {
    const r = await this.req("POST", "/v1/webhook", { url });
    if (r.status !== 201) throw new Error(`Узел: вебхук не принят (${r.status}): ${String(r.json.error ?? "")}`);
    return String((r.json.data as Record<string, unknown>).secret);
  }
}
