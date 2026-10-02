// Вызовы бэк-офиса: токен сессии в payload, хранение сессии в localStorage.
export const BUILD = 21;
const API = (typeof window !== "undefined" && window.TANDEM_API_URL) || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";   // адрес меняется в config.js
const KEY = "tandem_office";
const TIMEOUT_MS = 20000;
// Долгие действия (пересчёт продаж «готовым со склада», «Провести продажи за период», документы
// по плану) сервер может считать дольше 20 с: им вызывающий передаёт {timeout: LONG_MS}.
export const LONG_MS = 120000;
let S = null;

export function session() {
  if (S) return S;
  try { S = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { S = null; }
  return S;
}
export function setSession(s) {
  S = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
}
export function can(section, action) {
  const s = session();
  return !!(s && s.permissions && s.permissions.includes(section + ":" + action));
}

// api() не бросает исключений: обрыв связи и таймаут (20 с, или opts.timeout мс у долгих действий)
// возвращаются ответом {ok:false, error:'network'} — его, как и любой отказ сервера, экраны
// показывают текстом. Раньше fetch падал исключением, кнопки молча ничего не делали, и было
// непонятно, сохранилось ли.
// Протухшая сессия (unauthorized) больше не перезагружает страницу: api() шлёт событие
// tandem:unauthorized, бэк-офис показывает поверх окно входа, а введённое в формах остаётся.
// opts.quiet — фоновый запрос (счётчик новых замечаний раз в 10 минут): протухшая сессия не поднимает
// окно входа сама по себе, его покажет первое действие человека.
export async function api(action, payload, opts) {
  const body = { action: "office_" + action, payload: { ...(payload || {}) } };
  const s = session();
  if (s && s.token && !body.payload.token) body.payload.token = s.token;
  const ms = opts && Number(opts.timeout) > 0 ? Number(opts.timeout) : TIMEOUT_MS;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  const network = { ok: false, error: "network", message: "Нет связи с сервером. Данные могли не сохраниться — проверьте и повторите" };
  let j;
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
    try { j = await r.json(); } catch { j = null; }
    // Таймаут посреди чтения ответа — тоже обрыв, а не «сервер ответил не JSON».
    if ((!j || typeof j !== "object") && !(ctl && ctl.signal.aborted)) j = { ok: false, error: "bad_json", message: "Сервер ответил не JSON" };
  } catch { j = null; }
  finally { clearTimeout(timer); }
  if (!j || typeof j !== "object") return network;
  if (!j.ok && j.error === "unauthorized" && action !== "login" && !(opts && opts.quiet) && typeof window !== "undefined" && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent("tandem:unauthorized", { detail: { message: j.message } }));
  }
  return j;
}
