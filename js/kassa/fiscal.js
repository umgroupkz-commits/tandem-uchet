// Фискализация на кассе (0053, Webkassa). Работает, только если у точки включено «пробивать фискальные
// чеки» (вход отдаёт point.fiscal). Чек сначала сохраняется у нас (очередь app.js), затем сервер
// пробивает его в Webkassa действием fiscal_check; не пробитый чек виден продавцу и пробивается повторно.
// Печать - печатная форма Webkassa (fiscal_print) на чековый принтер из браузера, с QR-кодом чека.
import { el, toast } from "../office/ui.js?v=26";

let C = null;   // {call(action, payload), point(), store, redraw()}
const QR_LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
const pendKey = () => "tandem_fiscal_pending_" + C.point().id;
const autoKey = "tandem_kassa_autoprint";

export function initFiscal(ctx) { C = ctx; }
export const fiscalOn = () => !!(C && C.point() && C.point().fiscal);
export const autoPrint = () => C.store.get(autoKey, true) !== false;
export function setAutoPrint(v) { C.store.set(autoKey, !!v); }

// Не пробитые в налоговой: uid → {op, tries}. Переживают закрытие вкладки, пробиваются при связи.
function pending() { return C.store.get(pendKey(), {}) || {}; }
function setPending(p) { C.store.set(pendKey(), p); }
export const pendingCount = () => (fiscalOn() ? Object.keys(pending()).length : 0);
// Чек дошёл до сервера - запомнить, что его надо пробить: даже если досылка оборвётся до fiscal_check,
// следующий проход (retryPending) пробьёт его.
export function queueFiscal(uid, op = "sale") { if (!fiscalOn()) return; const p = pending(); if (!p[uid]) { p[uid] = { op, tries: 0 }; setPending(p); } }

// Пробить чек (op sale) или возврат отменённого (op return). print - печатать сразу после успеха.
export async function fiscalize(uid, { op = "sale", print = false, quiet = false } = {}) {
  if (!fiscalOn()) return null;
  const p = pending(); p[uid] = { op, tries: (p[uid] ? p[uid].tries : 0) + 1 }; setPending(p);
  let r;
  try { r = await C.call("fiscal_check", { uid, op }); }
  catch (e) { if (!quiet) toast((op === "return" ? "Возврат" : "Чек") + " не пробит в налоговой: нет связи. Пробьётся сам, когда связь появится", "bad"); return null; }
  if (r && r.ok && (r.fiscal || r.done || r.skip)) {
    const q = pending(); delete q[uid]; setPending(q);
    if (r.skip) return r;
    const f = r.fiscal || {};
    if (!quiet) toast(op === "return" ? "Возврат пробит в налоговой" + (f.return_number ? " · ФП " + f.return_number : "")
      : "Чек пробит в налоговой" + (f.number ? " · ФП " + f.number : ""));
    if (print) printReceipt(uid, op === "return" ? "return" : "sale", f);
    return r;
  }
  // Отказ Webkassa или сервера: чек остаётся в списке «не пробит», текст ошибки - продавцу.
  if (!quiet) toast((r && r.error) || "Чек не пробит в налоговой", "bad");
  if (r && !r.network && r.error === "Нет доступа") { const q = pending(); delete q[uid]; setPending(q); }
  return r;
}

// Повторить всё, что не пробилось (после досылки чеков, при появлении связи, по таймеру).
let retrying = false;
export async function retryPending() {
  if (!fiscalOn() || retrying) return;
  retrying = true;
  try {
    for (const [uid, v] of Object.entries(pending())) await fiscalize(uid, { op: v.op, quiet: true });
  } finally { retrying = false; }
}

// Печать: строки печатной формы Webkassa моноширинным шрифтом на ширину ленты; ссылка на чек в ОФД -
// QR-кодом (строка-ссылка формы или ссылка из ответа).
export async function printReceipt(uid, which = "sale", fiscal = null) {
  let r;
  try { r = await C.call("fiscal_print", { uid, which }); } catch (e) { toast("Нет связи - печатная форма не получена", "bad"); return; }
  if (!r || !r.ok) { toast((r && r.error) || "Печатная форма не получена", "bad"); return; }
  const lines = r.lines || [];
  const url = lines.find((l) => /^https?:\/\//i.test(l.trim())) || (fiscal && (which === "return" ? fiscal.return_url : fiscal.url)) || "";
  let qrSvg = "";
  if (url) { try { await loadQr(); const q = window.qrcode(0, "M"); q.addData(url); q.make(); qrSvg = q.createSvgTag({ cellSize: 3, margin: 0 }); } catch (e) { /* без QR */ } }
  const wide = C.point().fiscal_paper === 80;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Чек</title><style>
    @page { size: ${wide ? "80mm" : "58mm"} auto; margin: 0 }
    body { margin: 0; padding: 2mm; width: ${wide ? "76mm" : "54mm"}; font: ${wide ? "12px" : "10.5px"}/1.25 "Courier New", monospace; color: #000 }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; font: inherit }
    .qr { text-align: center; margin: 2mm 0 } .qr svg { width: 34mm; height: 34mm }
  </style></head><body><pre>${lines.filter((l) => !/^https?:\/\//i.test(l.trim())).map(esc).join("\n")}</pre>
  ${qrSvg ? `<div class="qr">${qrSvg}</div>` : ""}</body></html>`;
  const fr = el("iframe", { style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0", "aria-hidden": "true" });
  document.body.append(fr);
  const d = fr.contentWindow.document; d.open(); d.write(html); d.close();
  setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } finally { setTimeout(() => fr.remove(), 60000); } }, 300);
}
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = QR_LIB; s.onload = ok; s.onerror = fail; document.head.append(s); });
}

// X-отчёт: что пробито в Webkassa за смену - для сверки с итогами кассы.
export async function xReport() {
  let r;
  try { r = await C.call("fiscal_x", {}); } catch (e) { toast("Нет связи с сервером", "bad"); return null; }
  if (!r || !r.ok) { toast((r && r.error) || "X-отчёт не получен", "bad"); return null; }
  return r.report;
}

// Пометка и кнопки чека в списке смены. c.fiscal - из check_list; null - чек не пробивался.
export function fiscalBadges(c, { onAct } = {}) {
  if (!C || !c || c.state) return { pills: [], acts: [], note: null };
  const f = c.fiscal || {};
  // Фискализацию у точки выключили, а чек пробит раньше: он по-прежнему не исправляется - пусть видно почему.
  if (!fiscalOn()) return { pills: f.status === "ok" && c.status !== "void" ? [el("span", { class: "pill ok" }, "в налоговой")] : [], acts: [], note: null };
  const pend = pending()[c.uid];
  const pills = [], acts = []; let note = null;
  if (c.status === "void") {
    if (f.status === "ok") {
      if (f.return_status === "ok") { pills.push(el("span", { class: "pill", title: "ФП возврата " + (f.return_number || "") }, "возврат пробит"));
        acts.push(el("button", { onclick: () => printReceipt(c.uid, "return", f) }, "Печать возврата")); }
      else { pills.push(el("span", { class: "pill bad" }, "возврат не пробит"));
        if (f.return_error) note = "Возврат не пробит в налоговой: " + f.return_error;
        acts.push(el("button", { onclick: async () => { await fiscalize(c.uid, { op: "return", print: autoPrint() }); onAct && onAct(); } }, "Пробить возврат")); }
    }
    return { pills, acts, note };
  }
  if (f.status === "ok") {
    pills.push(el("span", { class: "pill ok", title: "Фискальный признак " + (f.number || "") + (f.offline ? " · автономный режим" : "") }, "в налоговой"));
    acts.push(el("button", { onclick: () => printReceipt(c.uid, "sale", f) }, "Печать чека"));
  } else {
    pills.push(el("span", { class: "pill bad" }, pend ? "не пробит, повторяю" : "не пробит в налоговой"));
    if (f.error) note = "Не пробит в налоговой: " + f.error;
    acts.push(el("button", { onclick: async () => { await fiscalize(c.uid, { print: autoPrint() }); onAct && onAct(); } }, "Пробить в налоговой"));
  }
  return { pills, acts, note };
}
