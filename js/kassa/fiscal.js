// Фискализация на кассе (0053, Webkassa). Работает, только если у точки включено «пробивать фискальные
// чеки» (вход отдаёт point.fiscal). Чек сначала сохраняется у нас (очередь app.js), затем сервер
// пробивает его в Webkassa действием fiscal_check; не пробитый чек виден продавцу и пробивается повторно.
// Печать - печатная форма Webkassa (fiscal_print) на чековый принтер из браузера, с QR-кодом чека.
// 0065: статусы чека от сервера, кроме «в налоговой» и «не пробит»: unknown - «неизвестно, пробит ли» (Webkassa не
// ответила - чек мог уйти в налоговую, правка закрыта, касса проверяет его повтором); mismatch - в налоговой этот
// чек на другую сумму (только отмена и офис); у отменённого возврат check - касса сначала узнаёт у Webkassa, была
// ли продажа, manual - возврат через офис.
import { el, toast } from "../office/ui.js?v=33";

let C = null;   // {call(action, payload), point(), seller(), store, changed() - список «не пробиты» изменился, blocked() - код точки не принят}
const QR_LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
const pendKey = () => "tandem_fiscal_pending_" + C.point().id;
const autoKey = "tandem_kassa_autoprint";

export function initFiscal(ctx) { C = ctx; }
export const fiscalOn = () => !!(C && C.point() && C.point().fiscal);
// Печать сразу после оплаты: по умолчанию включена, на учебной точке выключена - окно печати мешало бы урокам.
export const autoPrint = () => { const v = C.store.get(autoKey, null); return v === null ? !(C.point() && C.point().training) : v !== false; };
// Ответ сервера: текст ошибки - error, у отказов базы (tandem.err) - message.
const errText = (r, d) => (r && (r.message || r.error)) || d;
// Смена Webkassa была открыта дольше суток - сервер закрыл её сам (Z-отчёт) и повторил операцию.
const autoZText = (r) => (r && r.auto_z ? ". Смена Webkassa была открыта больше суток - закрыта сама" + (r.auto_z === true ? "" : " (Z №" + r.auto_z + ")") : "");
export function setAutoPrint(v) { C.store.set(autoKey, !!v); }
const changed = () => { if (C && C.changed) C.changed(); };
const blocked = () => !!(C && C.blocked && C.blocked());

// Не пробитые в налоговой: uid → {op, tries}. Переживают закрытие вкладки, пробиваются при связи.
function pending() { return C.store.get(pendKey(), {}) || {}; }
function setPending(p) { C.store.set(pendKey(), p); }
function unqueue(uid) { const q = pending(); if (q[uid]) { delete q[uid]; setPending(q); } }
export const pendingCount = () => (fiscalOn() ? Object.keys(pending()).length : 0);
// Чек дошёл до сервера - запомнить, что его надо пробить: даже если досылка оборвётся до fiscal_check,
// следующий проход (retryPending) пробьёт его. Ответ - true, если чек в списке новый (или сменилась операция).
export function queueFiscal(uid, op = "sale") {
  if (!fiscalOn()) return false;
  const p = pending();
  if (p[uid] && p[uid].op === op) return false;
  p[uid] = { op, tries: p[uid] ? p[uid].tries : 0 }; setPending(p); changed();
  return true;
}
// 0065: uid, которые пробиваются сейчас с этой вкладки: повтор (retryPending) и кнопки не шлют их второй раз.
// Вторую вкладку и чужой планшет останавливает сервер: «Чек пробивается в налоговой» (busy).
const inflight = new Set();
export const inFlight = (uid) => inflight.has(uid);

// Пробить чек (op sale) или возврат отменённого (op return). print - печатать сразу после успеха; note - что
// добавить к сообщению об успехе (сдача: прежнее сообщение со сдачей стирается этим).
export async function fiscalize(uid, { op = "sale", print = false, quiet = false, note = "" } = {}) {
  if (!fiscalOn() || blocked()) return null;
  if (inflight.has(uid)) return { ok: false, busy: true };
  inflight.add(uid);
  try {
    const p = pending(); p[uid] = { op, tries: (p[uid] ? p[uid].tries : 0) + 1 }; setPending(p);
    let r;
    try { r = await C.call("fiscal_check", { uid, op }); }
    catch (e) { if (!quiet) toast((op === "return" ? "Возврат" : "Чек") + " не пробит в налоговой: нет связи. Пробьётся сам, когда связь появится", "bad"); return null; }
    if (r && r.ok && (r.fiscal || r.done || r.skip)) {
      unqueue(uid);
      if (r.skip) return r;
      const f = r.fiscal || {};
      if (!quiet || r.auto_z) toast((op === "return" ? "Возврат пробит в налоговой" + (f.return_number ? " · ФП " + f.return_number : "")
        : "Чек пробит в налоговой" + (f.number ? " · ФП " + f.number : "")) + (note ? " · " + note : "") + autoZText(r));
      if (print) printReceipt(uid, op === "return" ? "return" : "sale", f);
      return r;
    }
    // Пробивается другим запросом (вторая вкладка, чужой повтор) - его ответ и решит; чек остаётся в списке.
    if (r && r.busy) return r;
    // В налоговой этот чек на другую сумму: повтор не поможет - сказать всегда, из списка повтора убрать.
    if (r && r.mismatch) { unqueue(uid); toast(errText(r, "Расхождение с налоговой - позвоните в офис"), "bad"); return r; }
    // Отказ Webkassa или сервера, «неизвестно, пробит ли»: чек остаётся в списке «не пробит», текст - продавцу.
    if (!quiet) toast(errText(r, "Чек не пробит в налоговой"), "bad");
    if (r && !r.network && (r.error === "Нет доступа" || r.error === "Чек не найден")) unqueue(uid);
    return r;
  } finally { inflight.delete(uid); changed(); }
}

// Повторить всё, что не пробилось (после досылки чеков, при появлении связи, по таймеру). Ответ - сколько
// чеков пробилось за этот проход (0 - ничего нового: экран можно не перерисовывать).
// 0065: вызов во время прохода не теряется - проход повторится по свежему списку (новый чек не ждёт следующей досылки).
let retrying = false, again = false;
export async function retryPending() {
  if (!fiscalOn() || blocked()) return 0;
  if (retrying) { again = true; return 0; }
  retrying = true;
  let done = 0, late = 0;
  const tried = new Set();
  try {
    do {
      again = false;
      for (const [uid, v] of Object.entries(pending())) {
        if (inflight.has(uid) || tried.has(uid)) continue;   // 0065: пробивается сейчас или уже пробовали в этот раз
        tried.add(uid);
        if (blocked()) break;
        const r = await fiscalize(uid, { op: v.op, quiet: true });
        if (r && r.ok && !r.skip) { done++; if (v.op !== "return" && !r.done) late++; }
      }
    } while (again && !blocked());
  } finally { retrying = false; again = false; }
  // 0065: повтор пробил чек, когда покупатель уже ушёл, и сам не печатает - сказать, где напечатать
  if (late && autoPrint()) toast("Пробиты в налоговой повтором чеков: " + late + ". Если покупатель ждёт чек - «Печать чека» во вкладке «Смена»");
  return done;
}

// Печать: строки печатной формы Webkassa моноширинным шрифтом на ширину ленты; ссылка на чек в ОФД -
// QR-кодом (строка-ссылка формы или ссылка из ответа).
export async function printReceipt(uid, which = "sale", fiscal = null) {
  let r;
  try { r = await C.call("fiscal_print", { uid, which }); } catch (e) { toast("Нет связи - печатная форма не получена", "bad"); return; }
  if (!r || !r.ok) { toast(errText(r, "Печатная форма не получена"), "bad"); return; }
  const lines = r.lines || [];
  const url = lines.find((l) => /^https?:\/\//i.test(l.trim())) || (fiscal && (which === "return" ? fiscal.return_url : fiscal.url)) || "";
  let qrSvg = "";
  if (url) { try { await loadQr(); const q = window.qrcode(0, "M"); q.addData(url); q.make(); qrSvg = q.createSvgTag({ cellSize: 3, margin: 0 }); } catch (e) { /* без QR */ } }
  // 0065: QR не построен (библиотека не загрузилась) - ссылка на чек печатается строкой, а не пропадает совсем
  const text = qrSvg ? lines.filter((l) => !/^https?:\/\//i.test(l.trim())) : url && !lines.some((l) => l.trim() === url) ? [...lines, url] : lines;
  const wide = C.point().fiscal_paper === 80;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Чек</title><style>
    @page { size: ${wide ? "80mm" : "58mm"} auto; margin: 0 }
    body { margin: 0; padding: 2mm; width: ${wide ? "76mm" : "54mm"}; font: ${wide ? "12px" : "10.5px"}/1.25 "Courier New", monospace; color: #000 }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; font: inherit }
    .qr { text-align: center; margin: 2mm 0 } .qr svg { width: 34mm; height: 34mm }
  </style></head><body><pre>${text.map(esc).join("\n")}</pre>
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
  if (!r || !r.ok) { toast(errText(r, "X-отчёт не получен"), "bad"); return null; }
  return r.report;
}

// Внесение (in) и изъятие (out) наличных в Webkassa. ext - номер операции: повтор с тем же номером (ответ
// потерялся, нажали ещё раз) не задвоит. Ответ: {ok, cash - наличных в Webkassa после операции} или ошибка.
// 0065: network - и когда без ответа остался сервер учёта, и когда Webkassa не ответила серверу: окно держит номер.
export async function moneyOp(kind, sum, reason, ext) {
  let r;
  try { r = await C.call("fiscal_money", { kind, sum, reason, ext, seller: C.seller ? C.seller() : null }); }
  catch (e) { return { ok: false, error: "Нет связи с сервером. Нажмите ещё раз, когда связь появится - операция не задвоится", network: true }; }
  if (!r || !r.ok) return { ok: false, error: errText(r, "Операция не проведена"), network: !!(r && r.network) };
  if (r.auto_z) r.note = autoZText(r).replace(/^\. /, "");
  return r;
}

// 0065: внесения и изъятия дня в Webkassa - для сверки с формой закрытия смены. null - не получить.
export async function moneyJournal(date) {
  try { const r = await C.call("fiscal_journal", { date }); return r && r.ok && Array.isArray(r.journal) ? r : null; }
  catch (e) { return null; }
}

// Пометка и кнопки чека в списке смены. c.fiscal - из check_list; null - чек не пробивался.
export function fiscalBadges(c, { onAct } = {}) {
  const f = (c && c.fiscal) || {};
  // 0058: чек пробит до включения фискализации у точки - в налоговую он не идёт, пометок нет
  if (!C || !c || c.state || f.status === "off") return { pills: [], acts: [], note: null };
  // Фискализацию у точки выключили, а чек пробит раньше: он по-прежнему не исправляется - пусть видно почему.
  if (!fiscalOn()) return { pills: f.status === "ok" && c.status !== "void" ? [el("span", { class: "pill ok" }, "в налоговой")] : [], acts: [], note: null };
  const pend = pending()[c.uid], busy = inflight.has(c.uid);
  const pills = [], acts = []; let note = null;
  // 0065: кнопка на время запроса заблокирована - второй запрос того же чека не уйдёт
  const btn = (text, run) => el("button", { disabled: busy, onclick: async (e) => {
    const b = e.currentTarget; if (b) b.disabled = true;
    try { await run(); } finally { if (b) b.disabled = false; }
    if (onAct) onAct();
  } }, text);
  if (c.status === "void") {
    if (f.return_status === "check") {
      pills.push(el("span", { class: "pill warn" }, "проверяю налоговую"));
      note = "Продажа этого чека «неизвестно, пробита ли»: касса узнаёт у Webkassa и пробьёт возврат, только если продажа там есть.";
      acts.push(btn("Проверить и пробить возврат", () => fiscalize(c.uid, { op: "return", print: autoPrint() })));
    } else if (f.return_status === "manual") {
      pills.push(el("span", { class: "pill bad" }, "возврат - через офис"));
      note = f.error || "В налоговой этот чек пробит на другую сумму: возврат оформит офис в кабинете Webkassa.";
    } else if (f.status === "ok") {
      if (f.return_status === "ok") { pills.push(el("span", { class: "pill", title: "ФП возврата " + (f.return_number || "") }, "возврат пробит"));
        acts.push(el("button", { onclick: () => printReceipt(c.uid, "return", f) }, "Печать возврата")); }
      else { pills.push(el("span", { class: "pill bad" }, "возврат не пробит"));
        if (f.return_error) note = "Возврат не пробит в налоговой: " + f.return_error;
        acts.push(btn("Пробить возврат", () => fiscalize(c.uid, { op: "return", print: autoPrint() }))); }
    }
    return { pills, acts, note };
  }
  if (f.status === "ok") {
    pills.push(el("span", { class: "pill ok", title: "Фискальный признак " + (f.number || "") + (f.offline ? " · автономный режим" : "") }, "в налоговой"));
    acts.push(el("button", { onclick: () => printReceipt(c.uid, "sale", f) }, "Печать чека"));
  } else if (f.status === "mismatch") {
    pills.push(el("span", { class: "pill bad" }, "в налоговой другая сумма"));
    note = f.error || "В налоговой этот чек пробит на другую сумму: отмените чек и позвоните в офис.";
  } else if (f.status === "unknown") {
    pills.push(el("span", { class: "pill bad" }, "неизвестно, пробит ли"));
    note = "Webkassa не ответила - чек мог уйти в налоговую. Не исправляйте его: касса проверит сама, кнопка - сразу. "
      + "Продажи не было - «Отменить чек»: возврат будет, только если чек есть в налоговой." + (f.error ? " Ответ: " + f.error : "");
    acts.push(btn("Проверить в налоговой", () => fiscalize(c.uid, { print: autoPrint() })));
  } else {
    pills.push(f.status === "pending" || busy ? el("span", { class: "pill warn" }, "пробивается…")
      : el("span", { class: "pill bad" }, pend ? "не пробит, повторяю" : "не пробит в налоговой"));
    if (f.error && f.status !== "pending") note = "Не пробит в налоговой: " + f.error;
    acts.push(btn(f.status === "pending" ? "Проверить в налоговой" : "Пробить в налоговой", () => fiscalize(c.uid, { print: autoPrint() })));
  }
  return { pills, acts, note };
}
