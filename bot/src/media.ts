// Вложения переписки для разбора заявок (Андрей, 20.11.2026: «давай подключим распознавание голосовых»).
// Голосовые (и клиента, и продавца) - в текст через Whisper у Groq; расшифровка хранится в состоянии бота
// (voice:<id вложения>), повторный разбор не распознаёт заново. Фото и PDF клиента - разбору как есть
// (Claude видит картинки и документы сам): чек Kaspi, скрин рекламы, фото прошлого заказа. Фото продавца
// (витрина, прайс) не нужны - его слова есть в переписке.
import type { Store } from "./store.ts";
import type { Fetch } from "./types.ts";
import type { UzelMessage } from "./uzel.ts";

export interface Stt { transcribe(bytes: Uint8Array, mime: string): Promise<string> }
export interface MediaDeps {
  store: Store;
  download?(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
  stt: Stt | null;
}

/** Сбой, который стоит повторить позже (сеть, 429, 5xx): разбор заявки откладывается до следующего прохода. */
export class RetryLater extends Error {}

const STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
// Подсказка распознаванию: слова, которые Whisper без неё пишет как попало.
const STT_HINT = "Енешка, Темиртау, Караганда, самса, манты, чебуреки, чебурята, беляши, вареники, пельмени, голубцы, тефтели, " +
  "эчпочмак, курник, бәліш, пирог, сет Дастархан, полуфабрикаты, предзаказ, доставка, самовывоз, Kaspi, Халык, рынок 6 микрорайон";

export class GroqStt implements Stt {
  constructor(private key: string, private f: Fetch = fetch, private model = "whisper-large-v3") {}
  async transcribe(bytes: Uint8Array, mime: string): Promise<string> {
    // Язык не задаём: в Темиртау говорят и по-русски, и по-казахски. Если Whisper решил, что это не они
    // (короткое или шумное голосовое), - второй раз с русским.
    const first = await this.call(bytes, mime, null);
    if (first.language && !/^(russian|kazakh|ru|kk)$/i.test(first.language)) return (await this.call(bytes, mime, "ru")).text;
    return first.text;
  }
  private async call(bytes: Uint8Array, mime: string, language: string | null): Promise<{ text: string; language: string }> {
    const fd = new FormData();
    const type = mime.split(";")[0].trim() || "audio/ogg";
    fd.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), "voice." + (type.includes("mpeg") ? "mp3" : type.includes("mp4") ? "m4a" : "ogg"));
    fd.append("model", this.model);
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    fd.append("prompt", STT_HINT);
    if (language) fd.append("language", language);
    let res: Response;
    try {
      res = await this.f(STT_URL, { method: "POST", headers: { authorization: "Bearer " + this.key }, body: fd, signal: AbortSignal.timeout(60_000) });
    } catch (e) { throw new RetryLater("распознавание недоступно: " + String(e)); }
    if (res.status === 429 || res.status >= 500) { await res.body?.cancel(); throw new RetryLater(`распознавание: ${res.status}`); }
    const j = await res.json().catch(() => ({})) as { text?: string; language?: string; error?: { message?: string } };
    if (res.status !== 200) throw new Error(`распознавание: ${res.status} ${j.error?.message ?? ""}`.trim());
    return { text: String(j.text ?? "").trim(), language: String(j.language ?? "") };
  }
}

const MAX_VOICE_SEC = 600;          // длиннее 10 минут - не голосовое по заказу, не тратим лимит
const MAX_IMAGES = 6, MAX_IMAGE_BYTES = 3_500_000;   // base64 раздувает на треть: предел картинки у API - 5 МБ
const MAX_DOCS = 2, MAX_DOC_BYTES = 8_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Расшифровка голосового: из памяти бота или заново. null - распознать нельзя (нет ключа, файл не дошёл). */
export async function voiceText(m: UzelMessage, d: MediaDeps): Promise<string | null> {
  const a = m.attachment;
  if (!a || (a.kind !== "voice" && a.kind !== "audio") || !a.id || !a.url || a.state !== "stored") return null;
  const key = `voice:${a.id}`;
  const saved = await d.store.getState<string>(key);
  if (saved !== null) return saved || null;
  if (!d.stt || !d.download || (a.durationSeconds ?? 0) > MAX_VOICE_SEC) return null;
  const f = await d.download(a.url).catch((e) => { throw new RetryLater(String(e)); });
  let text: string;
  try { text = await d.stt.transcribe(f.bytes, f.mime || a.mimeType || "audio/ogg"); }
  catch (e) {
    if (e instanceof RetryLater) throw e;
    text = "";   // файл не принят распознаванием - запоминаем, чтобы не пробовать каждый проход
    await d.store.journal("error", null, "голосовое не распознано: " + String(e).slice(0, 200));
  }
  await d.store.setState(key, text);
  return text || null;
}

export type Block = { type: string; [k: string]: unknown };
export interface Attached { label: string; block: Block }

/** Фото и PDF клиента для разбора: не больше MAX_IMAGES фото и MAX_DOCS документов, свежие важнее. */
export async function clientFiles(msgs: UzelMessage[], d: MediaDeps): Promise<Map<string, Attached>> {
  const out = new Map<string, Attached>();
  if (!d.download) return out;
  const pick = (kind: "image" | "document", max: number, limit: number) => msgs
    .filter((m) => m.direction === "in" && m.attachment?.kind === kind && m.attachment.state === "stored" && m.attachment.url
      && (m.attachment.byteSize ?? 0) <= limit
      && (kind === "image" ? IMAGE_TYPES.has((m.attachment.mimeType ?? "").split(";")[0]) : (m.attachment.mimeType ?? "").startsWith("application/pdf")))
    .slice(-max);
  let ni = 0, nd = 0;
  for (const m of [...pick("image", MAX_IMAGES, MAX_IMAGE_BYTES), ...pick("document", MAX_DOCS, MAX_DOC_BYTES)]) {
    const a = m.attachment!;
    const f = await d.download(a.url!).catch((e) => { throw new RetryLater(String(e)); });
    const mime = (f.mime || a.mimeType || "").split(";")[0].trim();
    const data = b64(f.bytes);
    if (a.kind === "image") {
      if (!IMAGE_TYPES.has(mime)) continue;
      out.set(m.id, { label: `фото №${++ni}`, block: { type: "image", source: { type: "base64", media_type: mime, data } } });
    } else {
      out.set(m.id, { label: `документ №${++nd}`, block: { type: "document", source: { type: "base64", media_type: "application/pdf", data } } });
    }
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
