// Печатные формы склада и техкарты: приходная накладная, накладная на перемещение, акт списания,
// инвентаризационная опись (бланк для пересчёта и итоговая), акт приготовления, технологическая карта.
//
// Печать — через скрытый iframe со своей разметкой A4, а не печать экрана: Ctrl+P печатал журнал
// за окном и обрезал длинный документ до первого листа (ИН-48: 14 строк из 436). Здесь документ —
// обычная таблица в потоке страницы: браузер сам режет её на листы и повторяет шапку (thead) на каждом.
// Всплывающее окно не годится — его режет блокировщик, а iframe печатается из того же нажатия.
//
//   printDoc(doc, o)    doc — документ в форме ответа doc_get (r.doc; весь ответ r тоже принимается);
//                       o.withCost — печатать цены и суммы (у перемещения по умолчанию нет, у прочих да);
//                       o.blank — у инвентаризации бланк для пересчёта: пустая колонка «Факт», без расчёта и сумм.
//   printChart(r, o)    r — ответ chart_get ({item, chart, cost, …}); можно и саму карту r.chart, тогда
//                       позиция — в o.item.
// Обе возвращают Promise<{ok:true} | {ok:false, error}> и не бросают: экран показывает error текстом.
// docHtml/chartHtml отдают ту же разметку строкой (проверки сохраняют из неё PDF).
// Поля новых версий сервера (artikul, posted_by_name, counteragent_bin, from_iiko…) необязательны:
// нет поля — форма печатается без него. Числа в строках могут прийти и текстом из формы («0,5»).
import { parseNum, fmtDate, fmtMoney } from "./inputs.js?v=22";
import { TYPES, REASONS } from "./stock-common.js?v=22";

// Причины, которых может ещё не быть в общем справочнике (новые причины списания и ввод остатков).
const MORE_REASONS = { defect: "брак", hospitality: "представительские", internal: "хозяйственные нужды", opening: "ввод начальных остатков" };
const reasonText = (r) => (r ? REASONS[r] || MORE_REASONS[r] || r : "");

// ---------- числа и текст ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function num(v) { const n = parseNum(v); return n === null || Number.isNaN(n) ? null : n; }
// Количество — без лишних нулей, до 4 знаков: в техкартах бывает 0,0001 кг лаврового листа.
const qty = (v) => { const n = num(v); return n === null ? "" : n.toLocaleString("ru-RU", { maximumFractionDigits: 4 }); };
const money = (v) => { const n = num(v); return n === null ? "" : fmtMoney(n); };
// Цена — с копейками, но не короче, чем записана: цена из «сумма / кол-во» бывает с 4 знаками.
const price = (v) => { const n = num(v); return n === null ? "" : n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 }); };
const pct = (n) => (n === null || !Number.isFinite(n) ? "" : n.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const pad = (n) => String(n).padStart(2, "0");
function dateTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (!v || Number.isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Строка внутри CSS content: "…" — кавычки и обратная косая экранируются, переносы — пробелом.
const cssStr = (s) => '"' + String(s ?? "").replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ") + '"';
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ---------- кирпичики разметки ----------
// Колонка таблицы: h — заголовок, cls — 'num' для чисел, w — ширина, get(строка, индекс) → готовый HTML.
const colNo = { h: "№", cls: "c", w: "8mm", get: (l, i) => String(i + 1) };
const colName = (h = "Наименование") => ({ h, get: (l) => esc(l.name || l.item_code || "") });
const colUnit = { h: "Ед.", cls: "c", w: "11mm", get: (l) => esc(l.unit_id || l.unit || "") };
// «Код iiko» — артикул позиции (сервер отдаёт его с 0045). Старый сервер артикула не знает —
// тогда колонка честно называется «Код» и показывает код учёта, а не пустоту под чужим названием.
// optional: таблица без артикула обходится без колонки (расход по техкартам рядом с выпуском).
function colCode(lines, optional) {
  if (lines.some((l) => has(l, "artikul"))) return { h: "Код iiko", w: "17mm", get: (l) => esc(l.artikul || "") };
  return optional ? null : { h: "Код", w: "14mm", get: (l) => esc(l.item_code || "") };
}
function grid(cols, lines, totalRow = "", cls = "") {
  cols = cols.filter(Boolean);
  const head = `<thead><tr>${cols.map((c) => `<th class="${c.cls || ""}"${c.w ? ` style="width:${c.w}"` : ""}>${esc(c.h)}</th>`).join("")}</tr></thead>`;
  const body = lines.map((l, i) => `<tr>${cols.map((c) => `<td class="${c.cls || ""}">${c.get(l, i)}</td>`).join("")}</tr>`).join("");
  const empty = lines.length ? "" : `<tr><td colspan="${cols.length}" class="dim">Строк нет</td></tr>`;
  return `<table class="grid ${cls}">${head}<tbody>${body}${empty}${totalRow}</tbody></table>`;
}
// Строка «Итого» под таблицей: подпись на все колонки до первой итоговой, дальше — значения по колонкам.
function totalRow(cols, values, label = "Итого") {
  cols = cols.filter(Boolean);
  const first = cols.findIndex((c) => values[c.h] !== undefined);
  if (first < 0) return "";
  return `<tr class="total"><td colspan="${first}">${esc(label)}</td>`
    + cols.slice(first).map((c) => `<td class="${c.cls || ""}">${values[c.h] ?? ""}</td>`).join("") + "</tr>";
}
const req = (rows) => {
  const list = rows.filter((x) => x && x[1] !== undefined && x[1] !== null && x[1] !== "");
  return list.length ? `<table class="req">${list.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>` : "";
};
// Подписи: «Принял ____________ / ____________» с подсказкой под чертой.
function signs(labels) {
  return `<table class="sign">${labels.map((t) => `<tr><td class="sl">${esc(t)}</td><td class="ln"></td><td class="sep">/</td><td class="ln"></td></tr>`
    + `<tr class="cap"><td></td><td>подпись</td><td></td><td>расшифровка подписи</td></tr>`).join("")}</table>`;
}
// Кто завёл и кто провёл документ — для бумаги, которую потом ищут в программе.
function authors(doc) {
  const a = [];
  if (doc.created_by_name) a.push(`Создал: ${doc.created_by_name}${doc.created_at ? ", " + dateTime(doc.created_at) : ""}`);
  if (doc.status === "posted") {
    const when = doc.posted_at ? dateTime(doc.posted_at) : "";
    if (doc.posted_by_name) a.push(`Провёл: ${doc.posted_by_name}${when ? ", " + when : ""}`);
    else if (when) a.push(`Проведён ${when}`);
  }
  return a.length ? `<div class="meta">${esc(a.join(" · "))}</div>` : "";
}
const draftMark = (doc) => (doc.status === "posted" ? "" : `<span class="badge">Черновик — не проведён</span>`);
const title = (name, doc) => `${name}${doc.number ? " № " + doc.number : ""}${doc.doc_date ? " от " + fmtDate(doc.doc_date) : ""}`;

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#000}
body{font:9.5pt/1.3 Arial,"Helvetica Neue",Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.org{font-size:8pt;color:#444;letter-spacing:.03em}
h1{font-size:14pt;margin:1.5mm 0 1mm;font-weight:700}
h2{font-size:11pt;margin:5mm 0 1.5mm;break-after:avoid;page-break-after:avoid}
.big{font-size:13pt;font-weight:700;margin:1mm 0}
.sub{font-size:10pt;margin:0 0 1mm}
.badge{display:inline-block;border:1.4pt solid #000;padding:.4mm 2mm;font-size:8.5pt;font-weight:700;text-transform:uppercase;margin:1mm 0}
.meta{font-size:8pt;color:#444;margin:1mm 0}
.dim{color:#555}
.note{font-size:8.5pt;color:#333;margin:1.5mm 0}
table.req{border-collapse:collapse;margin:2.5mm 0 1mm}
.req td{padding:.5mm 5mm .5mm 0;vertical-align:top}
.req td:first-child{color:#444;white-space:nowrap}
table.grid{width:100%;border-collapse:collapse;margin-top:2mm}
.grid thead{display:table-header-group}
.grid tr{break-inside:avoid;page-break-inside:avoid}
.grid th,.grid td{border:.6pt solid #000;padding:.7mm 1.2mm;vertical-align:top}
.grid th{font-size:8.5pt;font-weight:700;text-align:left;background:#ececec}
.grid th.num,.grid th.c{text-align:center}
.grid td.num{text-align:right;white-space:nowrap}
.grid td.c{text-align:center}
.grid tr.total td{font-weight:700;border-top:1.3pt solid #000}
.grid.blank td{height:7mm;vertical-align:middle}
.grid small{display:block;font-size:7.5pt;color:#444}
.end{break-inside:avoid;page-break-inside:avoid}
.sum{margin-top:3mm}
.sum div{margin:.6mm 0}
.tech{white-space:pre-wrap;border:.6pt solid #000;padding:2mm;margin-top:1.5mm;min-height:12mm}
table.sign{border-collapse:collapse;margin-top:7mm}
.sign td{padding:0 1.5mm}
.sign td.sl{padding:0 3mm 0 0;white-space:nowrap;vertical-align:bottom;height:8mm}
.sign td.ln{width:45mm;border-bottom:.6pt solid #000}
.sign td.sep{vertical-align:bottom}
.sign tr.cap td{font-size:7pt;color:#555;text-align:center;padding-top:.3mm}
.printed{margin-top:6mm;font-size:7pt;color:#666}
@media screen{body{padding:12mm;max-width:210mm;margin:0 auto}}
`;
// Целая страница: своя шапка, своё оформление; внизу каждого листа — номер документа и «стр. N из M»
// (поля страницы @page; браузер без их поддержки просто не печатает номер листа).
function page(docTitle, footer, body) {
  const now = new Date();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(docTitle)}</title><style>${CSS}
@page{size:A4 portrait;margin:12mm 10mm 14mm 14mm;
@bottom-left{content:${cssStr(footer)};font:7pt Arial,sans-serif;color:#555}
@bottom-right{content:"стр. " counter(page) " из " counter(pages);font:7pt Arial,sans-serif;color:#555}}
</style></head><body>${body}<div class="printed">Тандем · напечатано ${fmtDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}</div></body></html>`;
}

// ---------- документы ----------
// Сумма строки: проведённая — как записал сервер; в черновике прихода — кол-во × цена.
function lineSum(l, calc) {
  const s = num(l.sum);
  if (s !== null) return s;
  if (!calc) return null;
  const q = num(l.qty), p = num(l.price);
  return q === null || p === null ? null : r2(q * p);
}
const sumOf = (vals) => r2(vals.reduce((a, v) => a + (v || 0), 0));
const names = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "наименование" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "наименования" : "наименований"}`;

function invoiceForm(doc, o) {
  const L = doc.lines || [];
  const sums = L.map((l) => lineSum(l, true));
  const cols = [colNo, colCode(L), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (l) => qty(l.qty) }];
  if (o.withCost) cols.push({ h: "Цена", cls: "num", w: "22mm", get: (l) => price(l.price) },
    { h: "Сумма", cls: "num", w: "25mm", get: (l, i) => money(sums[i]) });
  const total = sumOf(sums);
  const ext = doc.ext_number || doc.ext_date
    ? esc(`№ ${doc.ext_number || "—"}${doc.ext_date ? " от " + fmtDate(doc.ext_date) : ""}`) : "—";
  const body = `<div class="org">Тандем</div><h1>${esc(title("Приходная накладная", doc))}</h1>${draftMark(doc)}
${req([["Поставщик", esc(doc.counteragent_name || "—") + (doc.counteragent_bin ? `, БИН/ИИН ${esc(doc.counteragent_bin)}` : "")],
  ["Накладная поставщика", ext], ["Склад-получатель", esc(doc.store_to_name || "")], ["Комментарий", esc(doc.comment || "")]])}
${grid(cols, L, o.withCost ? totalRow(cols, { "Сумма": money(total) }) : "")}
<div class="end"><div class="sum"><div>Всего ${names(L.length)}${o.withCost ? `, на сумму <b>${money(total)} ₸</b>` : ""}</div></div>
${authors(doc)}${signs(["Сдал (поставщик)", "Принял"])}</div>`;
  return { name: "Приходная накладная", body };
}

function transferForm(doc, o) {
  const L = doc.lines || [];
  const posted = doc.status === "posted";
  // Себестоимость перемещения сервер считает при проведении: у черновика цен ещё нет.
  const cost = o.withCost && posted;
  const sums = L.map((l) => lineSum(l, false));
  const cols = [colNo, colCode(L), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (l) => qty(l.qty) }];
  if (cost) cols.push({ h: "Себест.", cls: "num", w: "22mm", get: (l) => price(l.price) },
    { h: "Сумма", cls: "num", w: "25mm", get: (l, i) => money(sums[i]) });
  const total = sumOf(sums);
  const body = `<div class="org">Тандем</div><h1>${esc(title("Накладная на перемещение", doc))}</h1>${draftMark(doc)}
${req([["Откуда", esc(doc.store_from_name || "")], ["Куда", esc(doc.store_to_name || "")], ["Комментарий", esc(doc.comment || "")]])}
${o.withCost && !posted ? `<div class="note">Себестоимость появится после проведения — в черновике цен нет.</div>` : ""}
${grid(cols, L, cost ? totalRow(cols, { "Сумма": money(total) }) : "")}
<div class="end"><div class="sum"><div>Всего ${names(L.length)}${cost ? `, на сумму <b>${money(total)} ₸</b> (по себестоимости)` : ""}</div></div>
${authors(doc)}${signs(["Отпустил", "Принял"])}</div>`;
  return { name: "Накладная на перемещение", body };
}

function writeoffForm(doc, o) {
  const L = doc.lines || [];
  const posted = doc.status === "posted";
  const cost = o.withCost && posted;
  const sums = L.map((l) => lineSum(l, false));
  const cols = [colNo, colCode(L), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (l) => qty(l.qty) }];
  if (cost) cols.push({ h: "Себест.", cls: "num", w: "22mm", get: (l) => price(l.price) },
    { h: "Сумма", cls: "num", w: "25mm", get: (l, i) => money(sums[i]) });
  const total = sumOf(sums);
  const body = `<div class="org">Тандем</div><h1>${esc(title("Акт списания", doc))}</h1>${draftMark(doc)}
${req([["Склад", esc(doc.store_from_name || "")], ["Причина списания", esc(reasonText(doc.reason) || "—")], ["Комментарий", esc(doc.comment || "")]])}
${o.withCost && !posted ? `<div class="note">Себестоимость появится после проведения — в черновике сумм нет.</div>` : ""}
${grid(cols, L, cost ? totalRow(cols, { "Сумма": money(total) }) : "")}
<div class="end"><div class="sum"><div>Всего ${names(L.length)}${cost ? `, на сумму <b>${money(total)} ₸</b> (по себестоимости)` : ""}</div></div>
${authors(doc)}<div class="note" style="margin-top:4mm">Комиссия:</div>${signs(["Председатель комиссии", "Член комиссии", "Член комиссии"])}</div>`;
  return { name: "Акт списания", body };
}

// Расход по техкартам (акт приготовления, продажа): строки consume, «для чего» — по выпущенной позиции.
function consumeGrid(doc, o) {
  const C = doc.consume || [];
  const out = new Map((doc.lines || []).map((l) => [String(l.item_code), l.name]));
  const many = new Set(C.map((c) => c.for_item).filter(Boolean)).size > 1;
  const sums = C.map((c) => lineSum(c, false));
  const cols = [colNo, colCode(C, true), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (c) => qty(c.qty) }];
  if (o.withCost) cols.push({ h: "Себест.", cls: "num", w: "22mm", get: (c) => price(c.price) },
    { h: "Сумма", cls: "num", w: "25mm", get: (c, i) => money(sums[i]) });
  if (many) cols.push({ h: "Для", w: "38mm", get: (c) => esc(out.get(String(c.for_item)) || c.for_item || "") });
  return { html: grid(cols, C, o.withCost ? totalRow(cols, { "Сумма": money(sumOf(sums)) }) : ""), total: sumOf(sums), count: C.length };
}

function productionForm(doc, o) {
  const L = doc.lines || [];
  const posted = doc.status === "posted";
  const cost = o.withCost && posted;
  const sums = L.map((l) => lineSum(l, false));
  const cols = [colNo, colCode(L), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (l) => qty(l.qty) }];
  if (cost) cols.push({ h: "Себест.", cls: "num", w: "22mm", get: (l) => price(l.price) },
    { h: "Сумма", cls: "num", w: "25mm", get: (l, i) => money(sums[i]) });
  const cons = consumeGrid(doc, { withCost: cost });
  const body = `<div class="org">Тандем</div><h1>${esc(title("Акт приготовления", doc))}</h1>${draftMark(doc)}
${req([["Склад кухни", esc(doc.store_from_name || "")], ["Комментарий", esc(doc.comment || "")]])}
<h2>Выпуск</h2>${grid(cols, L, cost ? totalRow(cols, { "Сумма": money(sumOf(sums)) }) : "")}
<h2>Списано по техкартам</h2>${cons.count ? cons.html : `<div class="note">${posted ? "Расхода по техкартам нет." : "Расход по техкартам посчитается при проведении."}</div>`}
<div class="end"><div class="sum"><div>Выпущено ${names(L.length)}${cost ? ` на <b>${money(sumOf(sums))} ₸</b> (по себестоимости)` : ""}</div></div>
${authors(doc)}${signs(["Приготовил", "Принял"])}</div>`;
  return { name: "Акт приготовления", body };
}

function inventoryForm(doc, o) {
  const L = doc.lines || [];
  const posted = doc.status === "posted";
  const opening = doc.reason === "opening";
  const sub = (o.blank ? "Бланк для пересчёта" : "Итоговая опись") + (opening ? " · ввод начальных остатков" : "");
  const head = `<div class="org">Тандем</div><h1>${esc(title("Инвентаризационная опись", doc))}</h1><div class="sub">${esc(sub)}</div>`;
  if (o.blank) {
    // Бланк — для счёта на складе: без расчётного остатка (чтобы не переписывали его в факт) и без сумм;
    // строки выше обычных — под запись от руки.
    const cols = [colNo, colCode(L), colName(), colUnit, { h: "Факт", cls: "num", w: "32mm", get: () => "" }];
    const body = `${head}${req([["Склад", esc(doc.store_from_name || "")], ["Пересчёт", "дата ____.____.________ время ____:____"], ["Комментарий", esc(doc.comment || "")]])}
${grid(cols, L, "", "blank")}
<div class="end"><div class="sum"><div>Всего ${names(L.length)}</div></div>
${signs(["Считал", "Считал", "Материально ответственное лицо"])}</div>`;
    return { name: "Инвентаризационная опись (бланк)", body };
  }
  // Итоговая: расчёт — то, с чем проведение сравнило факт (у черновика — подсказка сервера на дату
  // документа), разница — факт − расчёт, сумма — оценка разницы при проведении (у черновика её нет).
  const calcOf = (l) => num(posted ? l.calc_qty : (l.calc_qty ?? l.current_qty));
  const diffOf = (l) => { const f = num(l.fact_qty), c = calcOf(l); return f === null ? null : r4(f - (c || 0)); };
  const cost = o.withCost && posted;
  let surN = 0, surS = 0, shN = 0, shS = 0;
  for (const l of L) {
    const d = diffOf(l), s = num(l.sum) || 0;
    if (d > 0) { surN++; surS += Math.abs(s); } else if (d < 0) { shN++; shS += Math.abs(s); }
  }
  const sign = (n) => (n > 0 ? "+" : "") + qty(n);
  const cols = [colNo, colCode(L), colName(), colUnit,
    { h: "Расчёт", cls: "num", w: "19mm", get: (l) => qty(calcOf(l)) },
    { h: "Факт", cls: "num", w: "19mm", get: (l) => qty(l.fact_qty) },
    { h: "Разница", cls: "num", w: "19mm", get: (l) => { const d = diffOf(l); return d === null ? "" : d === 0 ? "0" : sign(d); } }];
  if (cost) cols.push({ h: "Сумма", cls: "num", w: "25mm", get: (l) => money(l.sum) });
  const net = r2(surS - shS);
  const body = `${head}${draftMark(doc)}
${req([["Склад", esc(doc.store_from_name || "")], ["Комментарий", esc(doc.comment || "")]])}
${opening ? `<div class="note">Ввод начальных остатков — не доход и не убыток: в прибыль не входит.</div>` : ""}
${!posted ? `<div class="note">Черновик: расчёт — по проведённым документам на дату описи; суммы появятся после проведения.</div>` : ""}
${grid(cols, L, cost ? totalRow(cols, { "Сумма": money(net) }) : "")}
<div class="end"><div class="sum"><div>Всего ${names(L.length)}</div>
<div>Излишки: ${surN} поз.${cost ? ` на <b>${money(r2(surS))} ₸</b>` : ""}</div>
<div>Недостача: ${shN} поз.${cost ? ` на <b>${money(r2(shS))} ₸</b>` : ""}</div>
${cost ? `<div>Итог инвентаризации: <b>${net > 0 ? "+" : ""}${money(net)} ₸</b></div>` : ""}</div>
${authors(doc)}<div class="note" style="margin-top:4mm">Комиссия:</div>${signs(["Председатель комиссии", "Член комиссии", "Член комиссии"])}
${signs(["С результатами ознакомлен (материально ответственное лицо)"])}</div>`;
  return { name: "Инвентаризационная опись", body };
}

// Продажу печатать кнопкой не предлагают (её ведёт отчёт точки), но форма на случай вызова есть.
function saleForm(doc, o) {
  const L = doc.lines || [];
  const cols = [colNo, colCode(L), colName(), colUnit, { h: "Кол-во", cls: "num", w: "19mm", get: (l) => qty(l.qty) }];
  if (o.withCost) cols.push({ h: "Цена продажи", cls: "num", w: "24mm", get: (l) => price(l.price) },
    { h: "Выручка", cls: "num", w: "25mm", get: (l) => money(l.sum) });
  const cons = consumeGrid(doc, o);
  const body = `<div class="org">Тандем</div><h1>${esc(title("Продажа", doc))}</h1>${draftMark(doc)}
${req([["Склад точки", esc(doc.store_from_name || "")], ["Источник", esc(doc.comment || "")]])}
<h2>Продано по отчёту</h2>${grid(cols, L, o.withCost ? totalRow(cols, { "Выручка": money(sumOf(L.map((l) => num(l.sum)))) }) : "")}
${cons.count ? `<h2>Списано со склада</h2>${cons.html}` : ""}
<div class="end">${o.withCost && doc.total_sum != null ? `<div class="sum"><div>Себестоимость проданного: <b>${money(doc.total_sum)} ₸</b></div></div>` : ""}${authors(doc)}</div>`;
  return { name: TYPES.sale || "Продажа", body };
}

const FORMS = { invoice_in: invoiceForm, transfer: transferForm, writeoff: writeoffForm, production: productionForm, inventory: inventoryForm, sale: saleForm };

export function docHtml(src, o = {}) {
  // Принимаем и документ (r.doc), и весь ответ doc_get.
  const doc = src && src.doc && !src.doc_type ? src.doc : src;
  if (!doc || !FORMS[doc.doc_type]) throw new Error("Нечего печатать: документ не загружен");
  const opt = { withCost: o.withCost ?? doc.doc_type !== "transfer", blank: !!o.blank && doc.doc_type === "inventory" };
  const f = FORMS[doc.doc_type](doc, opt);
  const label = `${doc.number || ""} ${f.name}`.trim();
  return page(label, `Тандем · ${label}${doc.doc_date ? " от " + fmtDate(doc.doc_date) : ""}`, f.body);
}

// ---------- технологическая карта ----------
export function chartHtml(src, o = {}) {
  const resp = src && has(src, "chart");
  const ch = resp ? src.chart : src;
  const item = (resp && src.item) || o.item || {};
  if (!ch) throw new Error("У позиции нет технологической карты — печатать нечего");
  const L = ch.lines || [];
  const out = num(ch.output_amount);
  const unit = item.unit_id || "";
  // Стоимость и потери считаются из строк так же, как на экране карты: брутто × учётная цена
  // ингредиента; потери — холодная (брутто → нетто) и горячая (нетто → выход). Строки могут прийти
  // из открытой формы с правками, поэтому серверные line_cost/…_loss_pct не берём.
  const rows = L.map((l) => {
    const b = num(l.brutto), n = num(l.netto), w = num(l.output), c = num(l.ing_cost);
    return { l, b, n, w, c,
      // «нет цены» — только когда нет цены; пустое брутто в несохранённой карте — ноль, а не пропуск
      cost: c !== null ? (b || 0) * c : null,
      cold: b > 0 && n !== null ? (b - n) / b * 100 : null,
      hot: n > 0 && w !== null ? (n - w) / n * 100 : null };
  });
  const lossCell = (x) => {
    const t = `${pct(x.cold) || "—"} / ${pct(x.hot) || "—"}`;
    // Отрицательная потеря при варке — привар (крупа, макароны набирают воду), а не ошибка.
    return esc(t) + ((x.cold !== null && x.cold < 0) || (x.hot !== null && x.hot < 0) ? "<small>привар</small>" : "");
  };
  const cols = [colNo,
    { h: "Ингредиент", get: (l, i) => esc(l.name || l.ingredient_code || "") + (l.item_type === "prepared" ? "<small>полуфабрикат</small>" : "") },
    { h: "Ед.", cls: "c", w: "11mm", get: (l) => esc(l.unit || l.unit_id || "") },
    { h: "Брутто", cls: "num", w: "17mm", get: (l, i) => qty(rows[i].b) },
    { h: "Нетто", cls: "num", w: "17mm", get: (l, i) => qty(rows[i].n) },
    { h: "Выход", cls: "num", w: "17mm", get: (l, i) => qty(rows[i].w) },
    { h: "Потери, % хол./гор.", cls: "num", w: "24mm", get: (l, i) => lossCell(rows[i]) },
    { h: "Цена", cls: "num", w: "20mm", get: (l, i) => (rows[i].c !== null ? price(rows[i].c) : "нет цены") },
    { h: "Сумма", cls: "num", w: "20mm", get: (l, i) => money(rows[i].cost) }];
  // Итог веса складывает только строки в килограммах: «0,2 кг + 3 шт» — не вес.
  const kg = rows.filter((x) => String(x.l.unit || x.l.unit_id || "").trim().toLowerCase() === "кг");
  const other = rows.length - kg.length;
  const sumW = (k) => r4(kg.reduce((a, x) => a + (x[k] || 0), 0));
  const missing = rows.filter((x) => x.cost === null).map((x) => x.l.name || x.l.ingredient_code);
  const full = r4(rows.reduce((a, x) => a + (x.cost || 0), 0));
  const complete = rows.length > 0 && !missing.length;
  // Себестоимость за единицу — по строкам, как сервер считает cost (Σ брутто × цена / выход): у карты
  // с несохранёнными правками серверное cost уже устарело.
  const perUnit = complete && out > 0 ? r4(full / out) : null;
  const sale = num(item.price);
  const fc = perUnit !== null && sale > 0 ? perUnit / sale * 100 : null;
  const tot = { "Сумма": money(full) };
  if (kg.length) { tot["Брутто"] = qty(sumW("b")); tot["Нетто"] = qty(sumW("n")); tot["Выход"] = qty(sumW("w")); }
  const period = `с ${fmtDate(ch.date_from)}${ch.date_to ? " по " + fmtDate(ch.date_to) : ", бессрочно"}`;
  const kind = item.item_type === "prepared" ? "полуфабрикат" : item.item_type === "dish" ? "блюдо" : "";
  // Строка без цены — это ингредиент карты (часто полуфабрикат); чего не хватает в глубине, сервер
  // с 0047 называет сам (missing_names) — тогда печатаем и это.
  const deep = resp && Array.isArray(src.missing_names) ? src.missing_names.filter((x) => x && !missing.includes(x)) : [];
  const body = `<div class="org">Тандем</div><h1>Технологическая карта</h1><div class="big">${esc(item.name || "")}</div>
${req([["Вид", esc(kind)], ["Код iiko", esc(item.artikul || "")],
  ["Выход", out !== null ? esc(`${qty(out)} ${unit}`) : ""], ["Действует", esc(period)],
  ["Цена продажи", sale !== null ? `${money(sale)} ₸` : ""]])}
${grid(cols, L, rows.length ? totalRow(cols, tot, kg.length && other ? "Итого (вес — по строкам в кг)" : "Итого") : "")}
<div class="end"><div class="sum">
${kg.length ? `<div>Вес: брутто ${qty(sumW("b"))} кг, нетто ${qty(sumW("n"))} кг, выход по строкам ${qty(sumW("w"))} кг${other ? ` (без ${other} стр. в других единицах)` : ""}</div>` : ""}
<div>Себестоимость${complete ? "" : " неполная"}: на выход ${out !== null ? esc(`${qty(out)} ${unit}`) : ""} — <b>${money(full)} ₸</b>${perUnit !== null && out !== 1 ? `, за 1 ${esc(unit)} — <b>${money(perUnit)} ₸</b>` : ""}</div>
${!complete && missing.length ? `<div>Нет цены у: ${esc(missing.slice(0, 8).join(", "))}${missing.length > 8 ? "…" : ""} — себестоимость посчитана без них${deep.length ? `; не хватает цены сырья: ${esc(deep.slice(0, 5).join(", "))}${deep.length > 5 ? "…" : ""}` : ""}</div>` : ""}
${fc !== null ? `<div>Цена продажи ${money(sale)} ₸ · фудкост <b>${pct(fc)} %</b></div>` : ""}
</div></div>
<h2>Технология приготовления</h2><div class="tech">${esc(String(ch.technology || "").replace(/\s+$/, "")) || '<span class="dim">не описана</span>'}</div>
<div class="end">${signs(["Составил (технолог)", "Утвердил"])}</div>`;
  const label = `Техкарта ${item.name || ""}`.trim();
  return page(label, `Тандем · ${label} · ${period}`, body);
}

// ---------- печать ----------
// Один скрытый iframe на страницу: прежний убирается перед новой печатью или после печати.
// Убранный до печати iframe отвечает своему вызову «отменено»: у отцепленного документа
// fonts.ready не наступает никогда, и обещание первой из двух быстрых печатей висело бы вечно.
let frame = null;
const pending = new WeakMap();
function dropFrame(f) {
  if (!f) return;
  if (f.parentNode) f.remove();
  if (frame === f) frame = null;
  const done = pending.get(f);
  if (done) { pending.delete(f); done({ ok: false, error: "Печать отменена" }); }
}
function printHtml(html) {
  dropFrame(frame);
  const f = document.createElement("iframe");
  f.className = "print-frame";
  f.setAttribute("aria-hidden", "true"); f.tabIndex = -1;
  // Не display:none — такой iframe часть браузеров печатает пустым; нулевой размер и прозрачность.
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.append(f);
  frame = f;
  // Разметка пишется сразу в документ iframe (без загрузки по адресу): окно iframe остаётся тем же,
  // и печать вызывается у готовой страницы.
  const d = f.contentDocument;
  d.open(); d.write(html); d.close();
  const w = f.contentWindow;
  w.addEventListener("afterprint", () => setTimeout(() => dropFrame(f), 1000));
  return new Promise((resolve) => {
    pending.set(f, resolve);
    const go = () => {
      if (!pending.has(f)) return;            // уже отменена новой печатью
      pending.delete(f);
      if (!f.isConnected) { resolve({ ok: false, error: "Печать отменена" }); return; }
      try { w.focus(); w.print(); resolve({ ok: true }); }
      catch (e) { dropFrame(f); resolve({ ok: false, error: "Не получилось открыть печать: " + (e && e.message ? e.message : e) }); }
    };
    // Печать — после раскладки страницы и шрифтов, иначе первый лист бывает пустым; шрифты ждём
    // не дольше 1,5 с (шрифты здесь системные, ждать нечего, но обещание не должно зависнуть).
    const ready = d.fonts && d.fonts.ready ? d.fonts.ready : Promise.resolve();
    Promise.race([ready, new Promise((ok) => setTimeout(ok, 1500))]).then(() => setTimeout(go, 60), () => setTimeout(go, 60));
  });
}

export function printDoc(doc, o = {}) {
  let html;
  try { html = docHtml(doc, o); } catch (e) { return Promise.resolve({ ok: false, error: e.message || String(e) }); }
  return printHtml(html);
}
export function printChart(chart, o = {}) {
  let html;
  try { html = chartHtml(chart, o); } catch (e) { return Promise.resolve({ ok: false, error: e.message || String(e) }); }
  return printHtml(html);
}
