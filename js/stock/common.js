import { api, session } from "../office/api.js?v=20";
import { el, fmt, toast, debounce, today } from "../office/ui.js?v=20";

// ---------------------------------------------------------------- единый слой вызовов
// Экраны склада не разбирают ответ сервера сами: ask() возвращает уже удачный ответ,
// а любую неудачу — и отказ сервера, и обрыв связи — бросает исключением с текстом,
// который можно показать человеку как есть. Один try/catch на сценарий вместо проверки
// `if (!r.ok)` в каждой точке (и вместо молчаливого падения на сетевом сбое).
export async function ask(action, payload) {
  let r;
  try {
    r = await api(action, payload);
  } catch (e) {
    // Прежний api() бросал, когда fetch не дошёл до сервера (офлайн, DNS, обрыв).
    throw offline(e);
  }
  // Нынешний api() не бросает: обрыв и таймаут приходят ответом error:'network'.
  if (r && r.error === "network") throw offline(r);
  if (!r.ok) { const e = new Error(r.message || r.error || "Ошибка сервера"); e.code = r.error || ""; throw e; }
  return r;
}
// Исходная причина (исключение или ответ api) остаётся в cause.
function offline(cause) { const w = new Error("Нет связи с сервером"); w.cause = cause; w.offline = true; return w; }

// Кнопка блокируется на время запроса и разблокируется всегда — даже когда fn упала.
export async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------- числа с телефона
// Ru-раскладка на телефоне даёт запятую, а Number("1,5") — NaN; type=number с запятой
// вообще отдаёт пустой value. Поэтому поля количества текстовые, а нормализация — здесь.
export function normNum(v) { return String(v === null || v === undefined ? "" : v).replace(",", ".").trim(); }
export function numOf(v) { return Number(normNum(v)); }
export function hasNum(v) { return normNum(v) !== ""; }
export function okNum(v) { const s = normNum(v); return s !== "" && Number.isFinite(Number(s)) && Number(s) >= 0; }

export function qtyInput(value, onChange, opts) {
  const o = opts || {};
  return el("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: o.class || null,
    placeholder: o.placeholder || "кол-во", value: value === null || value === undefined ? "" : value,
    oninput: (e) => onChange(e.target.value) });
}

// ---------------------------------------------------------------- подбор позиций
let pickSeq = 0;
// Плитки частых позиций склада (те, что уже двигались на нём) + поиск по номенклатуре.
export function itemPicker({ storeId, onPick, filter = () => true }) {
  const fav = el("div", { class: "fav" });
  const perr = el("div", { class: "err" });
  const sid = "pick" + (++pickSeq);
  const search = el("input", { id: sid, placeholder: "Поиск: название или код", autocomplete: "off" });
  const res = el("div", { class: "sres" });
  const root = el("div", {}, el("div", { class: "favh" }, "Частые на этом складе"), fav, perr,
    el("label", { for: sid }, "Найти позицию"), search, res);
  async function refresh() {
    fav.innerHTML = ""; perr.textContent = "";
    try {
      const b = await ask("stock_balances", { store_id: storeId, only_nonzero: false, page: 1 });
      // stock_balances отдаёт остаток, а не карточку номенклатуры: поля item_type в нём нет,
      // поэтому фильтр здесь получает только код, название и единицу. Отбирать плитки по типу
      // позиции нельзя — для этого понадобился бы отдельный запрос к номенклатуре.
      const items = (b.rows || []).filter((x) => filter({ code: x.item_code, name: x.name, unit_id: x.unit_id }))
        .sort((a, c) => a.name.localeCompare(c.name, "ru")).slice(0, 12);
      for (const x of items) fav.append(el("button", { type: "button", onclick: () => onPick({ code: x.item_code, name: x.name, unit_id: x.unit_id, avg_cost: x.avg_cost }) }, x.name));
      if (!items.length) fav.append(el("span", { class: "dim" }, "пока пусто — найдите позицию поиском"));
    } catch (e) {
      perr.textContent = "Частые позиции не загрузились: " + e.message;
      fav.append(el("button", { type: "button", onclick: refresh }, "Повторить"));
    }
  }
  search.addEventListener("input", debounce(async () => {
    res.innerHTML = ""; perr.textContent = ""; const q = search.value.trim(); if (q.length < 2) return;
    try {
      const s = await ask("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).filter(filter).slice(0, 8)) {
        res.append(el("button", { type: "button", class: "sitem", onclick: () => { onPick({ code: it.code, name: it.name, unit_id: it.unit_id }); search.value = ""; res.innerHTML = ""; } },
          it.name, el("i", {}, it.unit_id)));
      }
      if (!res.children.length) res.append(el("div", { class: "sitem dim" }, "Не найдено"));
    } catch (e) { perr.textContent = "Поиск не сработал: " + e.message; }
  }, 300));
  refresh();
  return { root, refresh };
}

// ---------------------------------------------------------------- строки документа
// Инпуты не пересоздаются при вводе — перерисовываются только суммы.
// Одна колонка (инвентаризация, перемещение) — строка в один ряд; несколько колонок
// (приёмка) — название на своей строке, поля под ним: иначе на 360 px не помещается.
export function linesTable(lines, { columns, onRemove, onChange }) {
  const two = columns.length > 1;
  const root = el("div", {});
  function redraw() {
    root.innerHTML = "";
    if (!lines.length) { root.append(el("div", { class: "dim", style: "padding:10px 0" }, "Добавьте позиции")); return; }
    lines.forEach((l, idx) => {
      const cells = [el("div", { class: "ln" }, l.name, el("i", {}, l.unit_id || ""))];
      columns.forEach((c, i) => {
        if (c.input) cells.push(qtyInput(l[c.key], (v) => { l[c.key] = v; onChange && onChange(l, c.key, row); }, { placeholder: c.title, class: "c" + i }));
        else cells.push(el("div", { class: "num c" + i, "data-key": c.key }, c.render ? c.render(l) : fmt(l[c.key])));
      });
      cells.push(el("button", { type: "button", class: "x", onclick: () => { lines.splice(idx, 1); onRemove && onRemove(); redraw(); } }, "×"));
      const row = two ? el("div", { class: "lrow two" }, ...cells)
        : el("div", { class: "lrow", style: "grid-template-columns:1fr " + columns.map((c) => c.width || "84px").join(" ") + " 44px" }, ...cells);
      root.append(row);
    });
  }
  redraw();
  return { root, redraw, updateRow(row, l) { for (const c of columns) if (!c.input) { const cell = row.querySelector('[data-key="' + c.key + '"]'); if (cell) cell.textContent = c.render ? c.render(l) : fmt(l[c.key]); } } };
}

// ---------------------------------------------------------------- черновики телефона
// Ключ включает пользователя: на общем телефоне точки сменщик не должен видеть и
// дописывать чужой недоделанный документ.
export const DRAFT_PREFIX = "tandem_stock_draft:";
// Пока на экране вход после истёкшей сессии (сессия уже сброшена), открытый сценарий
// дописывает черновик под последним вошедшим, а не под "anon".
let lastUser = null;
const uid = () => { const s = session(); if (s && s.user && s.user.id) lastUser = s.user.id; return lastUser || "anon"; };
// Ключ черновика телефона (client_key для doc_save): заводится вместе с черновиком и живёт в нём.
// По нему сервер узнаёт уже созданный документ, даже если ответ на первый doc_save потерялся.
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
export const drafts = {
  key: (scn, storeId) => DRAFT_PREFIX + uid() + ":" + scn + ":" + storeId,
  load(scn, storeId) { try { return JSON.parse(localStorage.getItem(this.key(scn, storeId)) || "null"); } catch { return null; } },
  save(scn, storeId, data) { try { localStorage.setItem(this.key(scn, storeId), JSON.stringify(data)); } catch {} },
  clear(scn, storeId) { try { localStorage.removeItem(this.key(scn, storeId)); } catch {} },
};
// Выход с телефона стирает черновики всех пользователей и складов: следующий, кто войдёт,
// начинает с чистого экрана.
export function clearDraftsAll() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k); } catch {}
}

// ---------------------------------------------------------------- серверный черновик
// Повторное «Провести» правит тот же серверный документ, а не плодит новые: id, выданный
// первым doc_save, живёт в черновике телефона как server_id, а client_key черновика сервер
// узнаёт и без id. Ответ «не правится» значит, что документ уже проведён: ответ на doc_post
// потерялся или его провели из бэк-офиса. Тогда операция считается выполненной — ответ
// {already: true, number, doc}; showPosted сверяет его строки с черновиком и стирает черновик,
// только если они совпали. Второй документ
// заводится только вместо удалённого (not_found), и под тем же client_key.
export async function saveDoc(d, payload, persist) {
  // Черновик, заведённый до client_key, получает ключ здесь — и в телефон до отправки.
  if (!d.client_key) { d.client_key = newKey(); persist && persist(); }
  const send = (id) => ask("doc_save", { ...payload, id: id || undefined, client_key: d.client_key });
  const anew = () => { d.server_id = null; persist && persist(); return send(null); };
  try {
    return await send(d.server_id);
  } catch (e) {
    if (e.code === "not_found" && d.server_id) return await anew();
    if (!/не правится|уже проведён/i.test(e.message || "")) throw e;
    // id не дошёл до телефона, а документ этого client_key уже проведён: номера не знаем,
    // но и второй раз не проводим.
    if (!d.server_id) return { ok: true, already: true, id: null, number: null, doc: null };
    let g;
    try { g = await ask("doc_get", { id: d.server_id }); }
    catch (e2) { if (e2.code === "not_found") return await anew(); throw e2; }
    if (g.doc.status === "posted") return { ok: true, already: true, id: g.doc.id, number: g.doc.number, doc: g.doc };
    // Проведение успели отменить, пока шёл ответ, — документ снова черновик: правим его.
    return await send(d.server_id);
  }
}

// Проведение с той же страховкой: «уже проведён» после потерянного ответа — не ошибка,
// если doc_get подтверждает, что документ проведён.
export async function postDoc(id) {
  try {
    return await ask("doc_post", { id });
  } catch (e) {
    if (!/уже проведён|не правится/i.test(e.message || "")) throw e;
    const g = await ask("doc_get", { id });
    if (g.doc.status !== "posted") throw e;
    return { ok: true, already: true, id, number: g.doc.number, doc: g.doc };
  }
}

// Документ черновика уже проведён: черновик телефона стирается, человек видит номер и сумму
// проведённого и знает, что второго документа нет. d — черновик телефона: если проведённый документ
// с ним расходится (правки после сохранения, а провели из бэк-офиса исходный), черновик не стирается —
// см. showMismatch.
export function showPosted(ctx, scn, storeId, s, again, d) {
  const diff = d && s.doc ? postedDiff(scn, d.lines, s.doc.lines) : [];
  if (diff.length) return showMismatch(ctx, scn, storeId, s, again, d, diff);
  drafts.clear(scn, storeId);
  const doc = s.doc;
  ctx.result({ title: s.number ? "Документ " + s.number + " уже проведён" : "Документ по этому черновику уже проведён",
    lines: ["Повторно не проводился — второго такого документа нет.",
      doc ? (doc.lines || []).length + " поз., сумма " + fmt(doc.total_sum) + " ₸" : "Номер и строки — в журнале бэк-офиса."],
    again });
}

// Строки черновика телефона против строк проведённого документа, по позициям (повторы позиции
// складываются). Сравнивается количество — у инвентаризации факт, и только пересчитанные на телефоне
// позиции: остальные в акт не шли, и чужой пересчёт — не потерянная правка. У приёмки ещё и цена.
// Пустой список — документ проведён ровно по черновику. add — что войдёт в документ на разницу:
// у инвентаризации ваш факт (он абсолютный), у прочих — недостающее количество; over — проведено
// больше, чем в черновике (отдельным документом того же типа не исправить).
const EPS = 1e-6;
export function postedDiff(scn, draftLines, docLines) {
  const inv = scn === "inventory", f = inv ? "fact_qty" : "qty";
  const group = (list, num, skip) => {
    const m = new Map();
    for (const l of list || []) {
      if (skip && skip(l)) continue;
      const a = m.get(l.item_code) || { l, qty: 0, sum: 0 };
      const q = num(l[f]) || 0;
      a.qty += q; a.sum += q * (num(l.price) || 0); m.set(l.item_code, a);
    }
    return m;
  };
  const mine = group(draftLines, numOf, inv ? (l) => !hasNum(l[f]) : null);
  const done = group(docLines, Number);
  const price = (a) => (a && a.qty > EPS ? a.sum / a.qty : null);
  const out = [];
  for (const code of new Set([...mine.keys(), ...done.keys()])) {
    const m = mine.get(code), p = done.get(code);
    if (inv && !m) continue;
    const mq = m ? m.qty : 0, pq = p ? p.qty : 0;
    const qtyDiff = Math.abs(mq - pq) > EPS;
    const mp = price(m), pp = price(p);
    const priceDiff = scn === "receive" && mp !== null && pp !== null && Math.abs(mp - pp) > 0.005;
    if (!qtyDiff && !priceDiff) continue;
    const base = (m || p).l;
    out.push({ item_code: code, name: base.name || code, unit_id: base.unit_id || "", mine: m ? mq : null, posted: p ? pq : null,
      add: inv ? mq : Math.max(0, Math.round((mq - pq) * 1000) / 1000), over: !inv && pq - mq > EPS,
      price_mine: priceDiff ? mp : null, price_posted: priceDiff ? pp : null, line: m ? m.l : null });
  }
  return out;
}

// Документ провели не в том виде, что на телефоне (V22): черновик НЕ стирается. Два выхода.
// 1) Отменить проведение в бэк-офисе и снова нажать «Провести» — server_id в черновике остался,
//    документ поправится по черновику (это и для «проведено больше», и для другой цены).
// 2) «Оформить разницу» — черновик становится новым документом (свой client_key, без server_id),
//    в нём только недостающее; проведённый остаётся как есть. Второго такого же документа не будет:
//    в разнице нет того, что уже проведено.
function showMismatch(ctx, scn, storeId, s, again, d, diff) {
  const inv = scn === "inventory";
  const q = (r, x) => (x === null ? "нет" : fmt(x) + (r.unit_id ? " " + r.unit_id : ""));
  const rows = diff.map((r) => r.name + ": " + (r.posted === null ? (inv ? "в акте нет" : "в документе нет") : (inv ? "в акте " : "проведено ") + q(r, r.posted))
    + ", у вас " + q(r, r.mine)
    + (r.price_mine !== null ? "; цена в документе " + fmt(r.price_posted) + " ₸, у вас " + fmt(r.price_mine) + " ₸" : ""));
  const add = diff.filter((r) => r.add > EPS);
  const stuck = diff.filter((r) => r.over || r.price_mine !== null);
  const addLines = add.map((r) => inv ? { ...r.line }
    : { item_code: r.item_code, name: r.name, unit_id: r.unit_id, qty: String(r.add), ...(scn === "receive" ? { price: r.line.price } : {}) });
  const doc = s.doc, num = s.number || "документа";
  const lines = [(s.number ? s.number + " провели" : "Документ провели") + " из бэк-офиса: " + (doc.lines || []).length + " поз., сумма "
      + fmt(doc.total_sum) + " ₸. Черновик на телефоне не стёрт.", ...rows,
    "Провести по-вашему целиком: отмените проведение " + num + " в бэк-офисе и снова нажмите «Провести» — документ поправится по черновику."];
  if (add.length) lines.push("Или оформите разницу отдельным документом: " + add.map((r) => r.name + " " + (inv ? "" : "+") + q(r, r.add)).join("; ") + ".");
  const warnings = add.length && stuck.length
    ? ["Разницей не исправить: " + stuck.map((r) => r.name).join(", ") + " — только отменой проведения " + num + " в бэк-офисе."] : [];
  const buttons = [];
  if (add.length) buttons.push({ label: "Оформить разницу", onclick: () => {
    drafts.save(scn, storeId, { ...d, lines: addLines, server_id: null, client_key: newKey() });
    again();
  } });
  buttons.push({ label: "Удалить черновик", ghost: true, onclick: () => {
    if (!window.confirm("Удалить черновик? Ваши правки пропадут, останется проведённый " + num + ".")) return;
    drafts.clear(scn, storeId); ctx.home();
  } });
  ctx.result({ title: "Документ проведён в другом виде — ваши изменения не учтены", bad: true, lines, warnings, buttons, again });
}

// Хвост к сообщению об ошибке: документ на сервере мог сохраниться и даже провестись, но
// повтор его не задвоит (saveDoc/postDoc узнают проведённый) — человеку надо просто повторить.
export function draftHint(number, e) {
  if (number) return " — документ " + number + " мог сохраниться или провестись. Когда связь вернётся, нажмите ещё раз: второго документа не будет.";
  return e && e.offline ? " — черновик остался на телефоне, повторите, когда появится связь." : "";
}

export function warningsText(warnings) {
  return warnings && warnings.length ? "Уйдут в минус: " + warnings.map((w) => w.name + " (" + w.store_name + ") → " + fmt(w.balance_after)).join("; ") : "";
}
export { el, fmt, toast, debounce, today, api, session };
