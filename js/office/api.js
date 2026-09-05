// Вызовы бэк-офиса: токен сессии в payload, хранение сессии в localStorage.
export const BUILD = 2;
const API = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const KEY = "tandem_office";
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

export async function api(action, payload) {
  const body = { action: "office_" + action, payload: { ...(payload || {}) } };
  const s = session();
  if (s && s.token && !body.payload.token) body.payload.token = s.token;
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: "bad_json", message: "Сервер ответил не JSON" }));
  if (!j.ok && j.error === "unauthorized" && action !== "login") {
    setSession(null);
    location.reload();
    throw new Error(j.message || "Сессия истекла");
  }
  return j;
}
