// Вкладки отчётов склада: продажи точек, оборотная ведомость, заявки и план выпечки, «готовым со
// склада», расход для 1С, отчёты (прибыль, закупки, продажи по блюдам) и «Готовность». Журнал и форма
// документа — stock.js.
import { api, LONG_MS } from "./api.js?v=21";
import { el, fmt, toast, debounce, modal, confirmDlg, today, isoDate, errText } from "./ui.js?v=21";
import { fmtDate, fmtMoney } from "./inputs.js?v=21";
import { TYPES, perms, stores, active, opts, myIds, mine, seqs, nextSeq, tabOut, sel, hooks } from "./stock-common.js?v=21";
const editDoc = (id) => hooks.editDoc(id);

// ---------- общее для отчётов ----------
const iso = isoDate;
const monthStart = () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12));
const tomorrow = () => iso(new Date(Date.now() + 86400e3));
// Деньги — всегда с копейками (105 649,10), количество — до 4 знаков без хвоста нулей: раньше
// 0,004 кг округлялось до «0» при сумме 1,2 ₸, и строка выглядела ошибкой.
const money = (v) => fmtMoney(v);
const qtyStr = (v) => v === null || v === undefined || v === "" ? "" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 4 });
const pctStr = (v) => v === null || v === undefined ? "" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " %";
const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const sumOf = (rows, k) => n2(rows.reduce((a, x) => a + Number(x[k] || 0), 0));
const has = (rows, k) => rows.some((x) => x && k in x);
const nonZero = (rows, k) => rows.some((x) => Number(x[k] || 0) !== 0);
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
// Element.append(null) пишет на экран слово «null» (было под «Прибылью по точкам») — пустое отсекаем.
const put = (node, ...items) => node.append(...items.flat().filter((x) => x !== null && x !== undefined && x !== false));
const FC_ALERT = 35;
// Фудкост строки: выше порога — красным, в норме — зелёным. Если себестоимость неполная (в техкарте
// есть ингредиент без цены), цифра занижена: в норме — без цвета, чтобы зелёный не успокаивал зря;
// выше порога — всё равно красным (настоящий фудкост ещё выше), метка «неполная» стоит рядом.
// Раньше неполная гасила и красный: «Мини Пельмени» 55 % были серыми (owner Д2).
function fcTag(pct, incomplete, title) {
  if (pct === null || pct === undefined || pct === "") return "";
  const cls = Number(pct) > FC_ALERT ? "bad" : incomplete ? "" : "ok";
  return el("span", { class: "tag " + cls, style: "white-space:nowrap", title: title || null }, pctStr(pct));
}
const noPriceTitle = (names) => "Себестоимость неполная: в техкарте есть ингредиент без цены"
  + (names && names.length ? " — " + names.join(", ") : "") + ". Фудкост занижен. Список — «Готовность» → «Сырьё без цены».";

// Быстрые периоды, как в iiko: «Вчера», «Этот месяц» (с 1-го числа по сегодня), «Прошлый месяц».
// «Этот месяц» — умолчание всех отчётов. Пока человек сам не менял даты (auto), месяц считается
// заново при каждом открытии вкладки: вкладка, открытая вчера, иначе показывала бы вчерашний день.
const PRESETS = [
  ["Вчера", () => { const d = new Date(Date.now() - 864e5); return [iso(d), iso(d)]; }, false],
  ["Этот месяц", () => [monthStart(), today()], true],
  ["Прошлый месяц", () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1, 12)), iso(new Date(n.getFullYear(), n.getMonth(), 0, 12))]; }, false],
];
// Поля «с — по» и кнопки периодов для строки фильтров. st: {date_from, date_to, auto}; reload — перечитать.
function periodTools(st, reload) {
  if (st.auto) [st.date_from, st.date_to] = PRESETS[1][1]();
  const later = debounce(reload, 400);
  const btns = [];
  const mark = () => btns.forEach((b, i) => { const [a, z] = PRESETS[i][1](); b.className = "small" + (st.date_from === a && st.date_to === z ? "" : " ghost"); });
  const from = el("input", { type: "date", title: "с", value: st.date_from, onchange: (e) => { st.date_from = e.target.value; st.auto = false; mark(); later(); } });
  const to = el("input", { type: "date", title: "по", value: st.date_to, onchange: (e) => { st.date_to = e.target.value; st.auto = false; mark(); later(); } });
  PRESETS.forEach(([label, range, auto]) => btns.push(el("button", { type: "button", class: "small ghost", onclick: () => {
    const [a, z] = range(); st.date_from = a; st.date_to = z; st.auto = auto; from.value = a; to.value = z; mark(); reload();
  } }, label)));
  mark();
  return [from, el("span", { class: "dim" }, "—"), to, ...btns];
}
const periodText = (st) => `${fmtDate(st.date_from)}—${fmtDate(st.date_to)}`;

// Фильтры складов в отчётах — только действующие и закреплённые за пользователем, по алфавиту:
// выключенные («Основной», «Центральный») только мешали найти нужный, по чужим сервер откажет.
const storeList = () => mine(active()).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
const allStores = () => myIds.length ? "мои склады" : "все склады";
function storeSel(st, allLabel, reload) {
  const list = storeList();
  if (st.store_id && !list.some((s) => s.id === st.store_id)) st.store_id = "";
  return sel({ "": allLabel, ...opts(list) }, st.store_id, (v) => { st.store_id = v; reload(); });
}
const storeName = (id) => { const s = id && stores.find((x) => x.id === id); return s ? s.name : allStores(); };

// CSV для русского Excel: «;», запятая в числах, BOM для кириллицы. lines — массив строк-массивов
// (первой строкой — заголовок «что · склад · период», пустые строки разделяют разделы).
// Коды iiko вида «00725» Excel превращает в число 725, и сверка по коду с ведомостью iiko не сходится:
// такие коды пишем формулой ="00725" — Excel показывает её как текст с нулями.
const textCode = (v) => /^0\d+$/.test(String(v || "")) ? { raw: `="${v}"` } : (v ?? "");
function csvSave(fileName, lines) {
  const q = (v) => {
    if (v && typeof v === "object" && "raw" in v) return v.raw;
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const text = lines.map((r) => r.map(q).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  a.download = String(fileName).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() + ".csv";
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvNum = (v) => v === null || v === undefined || v === "" ? "" : Number(v);

// ---------- продажи: отчёты точек и их складские документы ----------
const sales = { date_from: "", date_to: "", auto: true, point_id: "" };
// Точки фильтра — из справочника точек, а не из строк ответа: раньше после пустого периода в
// списке оставалось только «все точки», а фильтром по-прежнему уходила выбранная точка (и
// «Провести продажи за период» шла только по ней). Справочник читается раз на заход в раздел.
let salePoints = null;
// Новый заход в раздел «Склад» перечитывает справочник точек (stock.js зовёт при mount).
export function resetReports() { salePoints = null; }
async function loadSalePoints() {
  if (!salePoints) { const p = await api("store_points_list", {}); salePoints = p.ok ? p.points : []; }
  return salePoints;
}
const pointOpts = () => ({ "": "все точки", ...Object.fromEntries(salePoints.map((x) => [x.id, x.name + (x.active ? "" : " (выключена)")])) });
const SALE_STATE = {
  posted: ["проведена", "ok"], none: ["нет продаж с кодом", ""], no_store: ["у точки нет склада", "bad"],
  locked: ["изменён после инвентаризации", "bad"], draft: ["не проведена", "bad"],
  pending: ["не проведена — нажмите «Провести продажи за период»", "bad"], stale: ["устарела — проведите заново", "bad"],
};
export async function loadSales() {
  if (!document.getElementById("sales-root")) return;
  await loadSalePoints();
  if (sales.point_id && !salePoints.some((x) => x.id === sales.point_id)) sales.point_id = "";
  const out = tabOut("sales-root", () => {
    const canSync = perms().includes("doc:sale:edit");
    const syncBtn = canSync ? el("button", { onclick: async (e) => {
      e.target.disabled = true;
      const s = await api("doc_sales_sync", { date_from: sales.date_from, date_to: sales.date_to, point_id: sales.point_id || null }, { timeout: LONG_MS });
      e.target.disabled = false;
      // обрыв: часть продаж могла провестись — перечитываем список
      if (!s.ok) { toast(errText(s), "bad"); if (s.error === "network") loadSales(); return; }
      const c = s.counts || {};
      toast(`Проведено ${c.posted || 0}, без изменений ${c.unchanged || 0}, без продаж ${c.empty || 0}, без склада ${c.no_store || 0}, заблокировано ${c.locked || 0}`
        + (c.error ? `, ошибок ${c.error}` : ""), c.error || c.locked ? "bad" : undefined);
      loadSales();
    } }, "Провести продажи за период") : null;
    return [el("div", { class: "tools" },
      ...periodTools(sales, loadSales),
      sel(pointOpts(), sales.point_id, (v) => { sales.point_id = v; loadSales(); }),
      syncBtn)];
  });
  if (!out) return;
  const n = nextSeq("sales");
  const period = { date_from: sales.date_from, date_to: sales.date_to, point_id: sales.point_id || null };
  const r = await api("doc_sales_list", period);
  if (n !== seqs.sales) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  const t = el("table");
  t.append(el("tr", {}, ...["Дата", "Точка", "Склад", "Строк", "Деньги в отчёте", "Продано", "Себестоимость", "Документ", "Состояние"]
    .map((h, i) => el("th", { class: i >= 3 && i <= 6 ? "num" : "" }, h))));
  for (const x of r.rows) {
    const [label, cls] = SALE_STATE[x.state] || [x.state, ""];
    t.append(el("tr", { class: x.doc_id ? "row" : "", onclick: x.doc_id ? () => editDoc(x.doc_id) : null },
      el("td", {}, fmtDate(x.report_date)), el("td", {}, x.point_name), el("td", {}, x.store_name || el("span", { class: "dim" }, "—")),
      el("td", { class: "num" }, String(x.lines)), el("td", { class: "num" }, money(x.money)),
      el("td", { class: "num" }, x.sale_sum != null ? money(x.sale_sum) : ""), el("td", { class: "num" }, x.cost != null ? money(x.cost) : ""),
      el("td", {}, x.number || ""),
      el("td", {}, el("span", { class: "tag " + cls }, label), x.sync_note ? el("div", { class: "dim", style: "font-size:12px;max-width:320px" }, x.sync_note) : null)));
  }
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "За период отчётов точек нет")));
  // Итоги по проведённым продажам: выручка, себестоимость, валовая прибыль, фудкост.
  const sum = await api("doc_sales_report", period);
  if (n !== seqs.sales) return;
  if (sum.ok && sum.points.length) {
    const pt = el("table");
    // «Документов», а не «Продаж»: одна продажа — это документ дня точки, а чеков в нём может быть много.
    pt.append(el("tr", {}, ...["Точка", "Документов", "Выручка", "Себестоимость", "Валовая прибыль", "Фудкост"].map((h, i) => el("th", { class: i ? "num" : "" }, h))));
    for (const x of sum.points) {
      const inc = Number(x.incomplete || 0);
      pt.append(el("tr", {}, el("td", {}, x.point_name, inc ? el("div", {}, el("span", { class: "tag", title: noPriceTitle() }, `себестоимость неполная (${inc} поз.)`)) : null),
        el("td", { class: "num" }, String(x.docs)), el("td", { class: "num" }, money(x.revenue)), el("td", { class: "num" }, money(x.cost)),
        el("td", { class: "num" }, money(x.margin)), el("td", { class: "num" }, fcTag(x.foodcost_pct, inc > 0, inc ? noPriceTitle() : null))));
    }
    const it = el("table");
    it.append(el("tr", {}, ...["Позиция", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост"].map((h, i) => el("th", { class: i ? "num" : "" }, h))));
    for (const x of sum.items.slice(0, 30)) it.append(dishRow(x));
    put(out, el("h2", { style: "margin-top:4px" }, "Итоги по проведённым продажам"),
      el("div", { class: "card", style: "padding:0;overflow:auto" }, pt),
      el("details", { style: "margin:8px 0 14px" }, el("summary", {}, `Позиции по выручке (${Math.min(sum.items.length, 30)} из ${sum.items.length})`),
        el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, it),
        el("div", { class: "dim", style: "margin-top:6px" }, "Все позиции, итоги и выгрузка — Отчёты → «Продажи по блюдам».")),
      el("h2", {}, "Отчёты точек"));
  }
  put(out, el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "dim", style: "margin-top:8px" },
      "Продажа проводится сама, когда точка сохраняет отчёт. «Провести продажи за период» нужна, если склад точке привязали позже или отчёт правили."));
}
// Строка проданной позиции (вкладка «Продажи» и «Продажи по блюдам»): у неполной себестоимости — метка
// с названиями ингредиентов без цены (missing_names), фудкост такой строки не зелёный (выше порога — красный).
function dishRow(x) {
  const inc = !!x.cost_incomplete;
  const title = inc ? noPriceTitle(x.missing_names) : null;
  return el("tr", {}, el("td", {}, x.name, inc ? el("span", { class: "tag", style: "margin-left:6px", title }, "себест. неполная") : null),
    el("td", { class: "num" }, qtyStr(x.qty) + " " + (x.unit_id || "")),
    el("td", { class: "num" }, money(x.revenue)), el("td", { class: "num" }, money(x.cost)), el("td", { class: "num" }, money(x.margin)),
    el("td", { class: "num" }, fcTag(x.foodcost_pct, inc, title)));
}

// ---------- оборотная ведомость склада ----------
// По позиции остаток на начало, обороты по видам документов и остаток на конец — по количеству и по
// сумме, как «Расширенная оборотно-сальдовая ведомость». Нужна для сверки в параллельной работе.
let turnMode = "both";
try { turnMode = localStorage.getItem("tandem_turn_mode") || "both"; } catch {}
const turn = { store_id: "", date_from: "", date_to: "", auto: true, q: "", last: null };
// [поле количества, поле суммы, заголовок, когда показывать]. Сервер до миграции 0046 отдаёт суммы
// не у всех движений и инвентаризацию одной цифрой — тогда колонки «Излишки/Недостача» заменяет
// «Инвент. ±», а сумм перемещений и производства просто нет (пустые ячейки).
const TURN_MOVES = [
  ["start_qty", "start_sum", "Начало"],
  ["income", "income_sum", "Приход"],
  ["transfer_in", "transfer_in_sum", "Перемещ. +"],
  ["transfer_out", "transfer_out_sum", "Перемещ. −"],
  ["production_in", "production_in_sum", "Произв. +"],
  ["production_out", "production_out_sum", "Произв. −"],
  ["sales", "sales_sum", "Продажи"],
  ["writeoff", "writeoff_sum", "Списания"],
  ["opening", "opening_sum", "Ввод остатков", "opening"],
  ["surplus", "surplus_sum", "Излишки", "split"],
  ["shortage", "shortage_sum", "Недостача", "split"],
  ["inventory", "inventory_sum", "Инвент. ±", "net"],
  [null, "reval_sum", "Переоценка", "reval"],
  ["end_qty", "end_sum", "Конец"],
];
const TURN_MODES = [["qty", "Количество"], ["sum", "Суммы"], ["both", "Количество и суммы"]];
export async function loadTurnover() {
  const out = tabOut("turn-root", () => {
    const modeBtns = TURN_MODES.map(([m, label]) => el("button", { type: "button", "data-mode": m, class: "small" + (turnMode === m ? "" : " ghost"), onclick: (e) => {
      turnMode = m;
      try { localStorage.setItem("tandem_turn_mode", m); } catch {}
      for (const b of e.target.parentNode.querySelectorAll("button[data-mode]")) b.className = "small" + (b.dataset.mode === m ? "" : " ghost");
      // Вид меняет только отрисовку — тот же ответ сервера рисуем заново, без нового запроса (идущий
      // запрос нарисуется уже в новом виде).
      if (turn.last && turn.last.out.isConnected) drawTurnover(turn.last.out, turn.last.r, turn.last.ctx);
    } }, label));
    return [el("div", { class: "tools" },
      storeSel(turn, myIds.length ? "мои склады вместе" : "все склады вместе", loadTurnover),
      ...periodTools(turn, loadTurnover),
      el("input", { placeholder: "Позиция или код", value: turn.q, oninput: debounce((e) => { turn.q = e.target.value; loadTurnover(); }, 400) }),
      el("button", { class: "ghost csv" }, "Скачать CSV")),
      el("div", { class: "tools", style: "margin-top:-4px" }, el("span", { class: "dim" }, "Показать:"), ...modeBtns)];
  });
  if (!out) return;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("turn");
  turn.last = null;
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
  const ctx = { store_id: turn.store_id, date_from: turn.date_from, date_to: turn.date_to };
  const r = await api("stock_turnover_report", { store_id: turn.store_id || null, date_from: turn.date_from, date_to: turn.date_to, q: turn.q });
  if (n !== seqs.turn) return;
  if (!r.ok) { turn.last = null; out.innerHTML = ""; out.append(el("div", { class: "err" }, errText(r))); return; }
  turn.last = { out, r, ctx };
  drawTurnover(out, r, ctx);
  csvBtn.onclick = () => { if (turn.last) turnoverCsv(turn.last.r, turn.last.ctx); };
}
// Колонки ведомости под ответ сервера: «Ввод остатков» и «Переоценка» — только если они есть в периоде.
// Пустой ответ — шапка нынешняя («Излишки / Недостача»), как и в «Прибыли по точкам».
const splitInv = (rows) => !rows.length || has(rows, "surplus") || has(rows, "shortage");
function turnMoves(rows) {
  const split = splitInv(rows);
  return TURN_MOVES.filter(([, , , when]) => when === "opening" ? nonZero(rows, "opening") || nonZero(rows, "opening_sum")
    : when === "split" ? split : when === "net" ? !split : when === "reval" ? nonZero(rows, "reval_sum") : true);
}
// Колонки для выбранного вида: {h — заголовок, q — поле количества, s — поле суммы}.
function turnCols(rows, mode) {
  const cols = [];
  for (const [qk, sk, label] of turnMoves(rows)) {
    if (mode === "qty") {
      cols.push(qk ? { h: label, q: qk } : { h: label + ", ₸", s: sk });
      if (qk === "end_qty") cols.push({ h: "Сумма на конец, ₸", s: "end_sum" });
    } else if (mode === "sum") cols.push({ h: label + ", ₸", s: sk });
    else cols.push({ h: label, q: qk, s: sk });
  }
  return cols;
}
// Итог суммы по отчёту: из ответа сервера (totals, миграция 0046), иначе — сложением строк.
const turnTotal = (r, k) => r.totals && r.totals[k] !== undefined && r.totals[k] !== null ? Number(r.totals[k]) : sumOf(r.rows, k);
// Ведомость шире экрана: при 1366 px «Конец» уходил за правый край карточки, и главное было видно
// только прокруткой вбок (buh 6, owner У3). «Позиция» прилипает слева, остаток на конец — справа
// (position: sticky внутри прокрутки карточки). Фон у прилипших ячеек свой, иначе под ними
// просвечивают уезжающие колонки; тонкая линия по краю отделяет их от прокручиваемой части.
const TOT_BG = "#EEF2F8";
const pinL = (bg) => `position:sticky;left:0;z-index:1;background:${bg || "var(--card,#fff)"};box-shadow:inset -1px 0 0 var(--line)`;
// off — отступ справа в px; null — без прилипания (его включит pinRightCols после замера).
const pinR = (bg, off) => (off === null ? "" : `position:sticky;right:${off}px;`) + `z-index:1;background:${bg || "var(--card,#fff)"};box-shadow:inset 1px 0 0 var(--line)`;
// Колонок остатка на конец справа может быть две (вид «Количество»: «Конец» и «Сумма на конец»):
// последняя прилипает к краю сразу, предпоследняя — на ширину последней, когда таблица уже на экране
// и ширину можно измерить. Не измерилось (вкладку успели сменить) — предпоследняя просто не прилипает.
function pinRightCols(t) {
  requestAnimationFrame(() => {
    if (!t.isConnected) return;
    const last = t.querySelector("th[data-pin-r='0']");
    const w = last ? last.getBoundingClientRect().width : 0;
    if (!w) return;
    for (const c of t.querySelectorAll("[data-pin-r='1']")) { c.style.position = "sticky"; c.style.right = w + "px"; }
  });
}
function drawTurnover(out, r, ctx) {
  out.innerHTML = "";
  const rows = r.rows, mode = turnMode;
  const cols = turnCols(rows, mode);
  const showArt = has(rows, "artikul");
  const lead = showArt ? 3 : 2;
  const qCell = (x, k) => { const v = Number(x[k] || 0); return v ? qtyStr(v) : ""; };
  const sCell = (x, k) => { if (!(k in x)) return ""; const v = Number(x[k] || 0); return v ? money(v) : ""; };
  // Номер колонки остатка на конец от правого края (0 — последняя) или null для прочих.
  const isEnd = (c) => c.q === "end_qty" || c.s === "end_sum";
  const pinIdx = cols.map((c, i) => isEnd(c) && cols.slice(i + 1).every(isEnd) ? cols.length - 1 - i : null);
  // Атрибуты ячейки колонки i: прилипание справа (последняя — сразу, предпоследняя — после замера).
  const pinAttrs = (i, cls, bg) => {
    const p = pinIdx[i];
    if (p === null || p > 1) return { class: cls };
    return { class: cls, "data-pin-r": String(p), style: pinR(bg, p === 0 ? 0 : null) };
  };
  const t = el("table");
  t.append(el("tr", {}, showArt ? el("th", {}, "Код iiko") : null, el("th", { style: pinL() }, "Позиция"), el("th", {}, "Ед."),
    ...cols.map((c, i) => el("th", pinAttrs(i, "num"), c.h, mode === "both" && c.q && c.s ? el("div", { style: "font-weight:400;text-transform:none;white-space:nowrap" }, "кол-во / ₸") : null))));
  let group = null;
  for (const x of rows) {
    // Название группы во всю ширину — тоже прилипает слева, чтобы не уезжать при прокрутке вбок.
    if ((x.group_name || "") !== group) { group = x.group_name || ""; t.append(el("tr", {}, el("td", { colspan: lead + cols.length, class: "dim", style: "font-weight:700;padding-top:10px" },
      el("span", { style: "position:sticky;left:10px;display:inline-block" }, group || "без группы")))); }
    t.append(el("tr", {}, showArt ? el("td", { class: "dim" }, x.artikul || "") : null, el("td", { style: pinL() }, x.name), el("td", {}, x.unit_id || ""),
      ...cols.map((c, i) => {
        const neg = c.q === "end_qty" && Number(x.end_qty || 0) < 0 ? " bad" : "";
        const a = pinAttrs(i, "num" + neg);
        if (c.q && c.s) return el("td", a, el("div", {}, qCell(x, c.q)), el("div", { class: "dim", style: "font-size:12px" }, sCell(x, c.s)));
        return el("td", a, c.q ? qCell(x, c.q) : sCell(x, c.s));
      })));
  }
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: lead + cols.length, class: "dim" }, "За период движений нет")));
  // «Итого» — по суммам: количества в разных единицах (кг, шт) складывать бессмысленно.
  // Ячейки «Итого» — по колонкам, как у строк: подпись в колонке «Позиция» и прилипает вместе с ней.
  else t.append(el("tr", { style: `font-weight:700;background:${TOT_BG}` }, showArt ? el("td", {}) : null,
    el("td", { style: pinL(TOT_BG) + ";white-space:nowrap" }, `Итого: ${rows.length} ${plural(rows.length, "позиция", "позиции", "позиций")}`), el("td", {}),
    ...cols.map((c, i) => el("td", pinAttrs(i, "num", TOT_BG), c.s && (c.s in (r.totals || {}) || has(rows, c.s)) ? money(turnTotal(r, c.s)) : ""))));
  const split = has(rows, "surplus") || has(rows, "shortage");
  const opening = nonZero(rows, "opening") || nonZero(rows, "opening_sum");
  const reval = nonZero(rows, "reval_sum");
  put(out, el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    // Итог колонки — сумма строк, каждая округлена до копейки; «Начало» + обороты по итогам может
    // разойтись с итогом «Конца» на копейки (5 547 877,25 против 5 547 877,27 — buh 7, owner Д5).
    rows.length ? el("div", { class: "dim", style: "margin:-8px 0 10px;font-size:12.5px" },
      "Итоги сложены из округлённых строк; расхождение итогов с «Концом» в копейки (тиыны) — округление, не ошибка.") : null,
    el("div", { class: "tot" }, el("span", {}, `${storeName(ctx.store_id)} · ${periodText(ctx)} · на начало ${money(turnTotal(r, "start_sum"))} ₸`),
      el("span", {}, `на конец ${money(turnTotal(r, "end_sum"))} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Суммы — по себестоимости движений: количество × себестоимость позиции на складе в момент движения. Расход показан положительными числами."
      + (split ? " «Излишки» и «Недостача» — итоги инвентаризаций, оба положительными числами." : "")
      + (opening ? " «Ввод остатков» — инвентаризации с отметкой «ввод начальных остатков»: это не излишек и не недостача, в прибыль не входят." : "")
      + (reval ? " «Переоценка» — поправка стоимости без количества: приход на склад, ушедший в минус, пересчитал недостающее по цене прихода; суммы на начало и конец её включают." : "")));
  pinRightCols(t);
}
function turnoverCsv(r, ctx) {
  const rows = r.rows, mode = turnMode;
  const head = [], get = [];
  for (const c of turnCols(rows, mode)) {
    if (c.q) { head.push(mode === "both" ? c.h + ", кол-во" : c.h); get.push((x) => csvNum(x[c.q] ?? 0)); }
    if (c.s) { head.push(mode === "both" ? c.h + ", ₸" : c.h); get.push((x) => c.s in x ? csvNum(x[c.s] ?? 0) : ""); }
  }
  const totals = [];
  for (const c of turnCols(rows, mode)) {
    if (c.q) totals.push("");
    if (c.s) totals.push(c.s in (r.totals || {}) || has(rows, c.s) ? turnTotal(r, c.s) : "");
  }
  csvSave(`ведомость ${storeName(ctx.store_id)} ${periodText(ctx)}`, [
    [`Оборотная ведомость · ${storeName(ctx.store_id)} · ${periodText(ctx)}`],
    ["Код учёта", "Код iiko", "Позиция", "Ед.", "Группа", ...head],
    ...rows.map((x) => [x.item_code, textCode(x.artikul), x.name, x.unit_id || "", x.group_name || "", ...get.map((g) => g(x))]),
    ["", "", "Итого", "", "", ...totals],
  ]);
}

// ---------- заявки точек и сводный план выпечки (миграция 0038) ----------
// Точки подают заявки на завтра со страницы order.html до отсечки. Здесь — сводный план дня: сколько
// заказано по позициям и точкам, факт выпуска (отмечает пекарь), и одной кнопкой черновики акта
// производства на склад кухни и перемещений на склады точек.
const ord = { date: "", auto: true };
export async function loadOrders() {
  const out = tabOut("ord-root", () => {
    if (ord.auto) ord.date = tomorrow();
    const d = el("input", { type: "date", value: ord.date, onchange: debounce((e) => { ord.date = e.target.value; ord.auto = false; loadOrders(); }, 400) });
    return [el("div", { class: "tools" }, d,
      el("button", { class: "ghost", onclick: () => { ord.auto = true; ord.date = tomorrow(); d.value = ord.date; loadOrders(); } }, "Завтра"),
      el("button", { class: "ghost", onclick: () => window.print() }, "Печать плана"),
      el("a", { class: "link", href: "order.html", target: "_blank" }, "Страница заявки для точек"))];
  });
  if (!out) return;
  // Список «готовым» перечитывается при каждой загрузке плана: после «Создать производство и
  // перемещения», проведения документов плана и смены дня в нём могли появиться или уйти строки.
  if (!out.nextSibling) out.after(storeReadyBox());
  loadStoreReady();
  const n = nextSeq("ord");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Загружаю…"));
  const r = await api("stock_orders_report", { for_date: ord.date });
  if (n !== seqs.ord) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  // День, который показан, — из ответа: кнопки ниже сохраняют выпуск и создают документы именно
  // на него, даже если поле даты успели сменить.
  const day = r.for_date || ord.date;
  // Заголовок с датой виден и на печати: поле даты в печать не идёт, и план уходил на кухню без дня.
  out.append(el("h3", { style: "margin:0 0 8px" }, `План выпечки на ${fmtDate(day)}` + (day === tomorrow() ? " (завтра)" : day === today() ? " (сегодня)" : "")));
  const kitchen = stores.find((s) => s.id === r.store_id);
  // Настройки: склад кухни и отсечка — только у тех, кто правит склады.
  if (perms().includes("stores:edit")) {
    const ks = sel({ "": "— склад кухни не выбран —", ...opts(active().slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"))) }, r.store_id || "", () => {});
    const cut = el("input", { value: r.cutoff, style: "width:80px", title: "Время отсечки заявок" });
    out.append(el("details", { style: "margin-bottom:10px" }, el("summary", {}, `Настройки: склад кухни — ${kitchen ? kitchen.name : "не выбран"}, отсечка ${r.cutoff}`),
      el("div", { class: "tools", style: "margin-top:8px" }, el("span", {}, "Склад кухни"), ks, el("span", {}, "Отсечка"), cut,
        el("button", { onclick: async (e) => { e.target.disabled = true; const x = await api("stock_orders_settings_save", { store_id: ks.value, cutoff: cut.value.trim() }); e.target.disabled = false;
          if (!x.ok) { toast(errText(x), "bad"); return; } toast("Сохранено"); loadOrders(); } }, "Сохранить"))));
  }
  out.append(el("div", { class: "dim", style: "margin-bottom:8px" },
    r.locked ? "План передан в производство: документы созданы, заявки этого дня закрыты для правок."
      : r.open ? `Приём заявок на этот день открыт до ${r.cutoff} накануне — план ещё может измениться.` : "Приём заявок на этот день закрыт — можно печатать план и отмечать выпуск."));
  const pts = r.orders.map((o) => o.point_id);
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Ед."), el("th", { class: "num" }, "Заявлено"), el("th", { class: "num" }, "Выпуск"),
    el("th", { class: "num" }, "Расхождение"), ...r.orders.map((o) => el("th", { class: "num" }, o.point_name))));
  const facts = new Map();
  const canFact = perms().includes("doc:production:edit") && !r.locked;
  for (const x of r.plan) {
    const inp = el("input", { inputmode: "decimal", value: x.fact ?? "", disabled: !canFact, style: "width:80px;text-align:right" });
    facts.set(x.item_code, inp);
    const diff = x.fact == null ? "" : fmt(Number(x.fact) - Number(x.qty));
    t.append(el("tr", {}, el("td", {}, x.name, x.has_chart ? null : el("span", { class: "tag bad", title: "Без техкарты в акт производства не попадёт" }, " нет техкарты")),
      el("td", {}, x.unit || ""), el("td", { class: "num", style: "font-weight:700" }, fmt(x.qty)), el("td", { class: "num" }, inp),
      el("td", { class: "num" + (x.fact != null && Number(x.fact) < Number(x.qty) ? " bad" : "") }, diff),
      ...pts.map((p) => el("td", { class: "num" }, x.by_point[p] != null ? fmt(x.by_point[p]) : ""))));
  }
  if (!r.plan.length) t.append(el("tr", {}, el("td", { colspan: 5, class: "dim" }, "На этот день заявок нет")));
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
  const factRows = () => r.plan.map((p) => ({ item_code: p.item_code, fact: String(facts.get(p.item_code).value).replace(",", ".").trim() }));
  const acts = el("div", { class: "actions" });
  if (canFact && r.plan.length) acts.append(el("button", { class: "ghost", onclick: async (e) => {
    e.target.disabled = true;
    const x = await api("stock_orders_fact_save", { for_date: day, rows: factRows() });
    e.target.disabled = false;
    if (!x.ok) { toast(errText(x), "bad"); return; } toast("Выпуск сохранён"); loadOrders(); } }, "Сохранить выпуск"));
  if (r.plan.length && perms().includes("doc:production:edit") && perms().includes("doc:transfer:edit")) acts.append(el("button", { onclick: async (e) => {
    if (!r.locked && !confirmDlg(r.open
      ? `Приём заявок на этот день ещё открыт до ${r.cutoff}. Если создать документы сейчас, точки больше не смогут поправить заявки. Создать всё равно?`
      : "Создать черновики акта производства и перемещений на точки? После этого заявки этого дня не изменить.")) return;
    e.target.disabled = true;
    // Введённый, но не сохранённый «Выпуск» сначала сохраняется: документы строятся по сохранённому
    // выпуску, и без этого шага акт и перемещения ушли бы по заявке, а введённые цифры пропали бы.
    if (canFact) {
      const fx = await api("stock_orders_fact_save", { for_date: day, rows: factRows() });
      if (!fx.ok) { e.target.disabled = false; toast("Выпуск не сохранён, документы не созданы: " + errText(fx), "bad"); return; }
    }
    const x = await api("stock_orders_docs_save", { for_date: day, force: r.open }, { timeout: LONG_MS });
    e.target.disabled = false;
    // обрыв: документы могли создаться — показываем, что есть на самом деле
    if (!x.ok) { toast(errText(x), "bad"); if (x.error === "network") loadOrders(); return; }
    toast(x.made ? `Создано документов: ${x.made}` : "Все документы уже созданы");
    if (x.skipped) toast("Без склада точки, перемещение не создано: " + x.skipped, "bad");
    loadOrders(); } }, r.locked ? "Досоздать документы" : "Создать производство и перемещения"));
  out.append(acts);
  out.append(el("div", { class: "dim", style: "margin-top:8px" }, "Выпуск раскладывается по точкам пропорционально заявкам. Сначала проводится акт производства, затем перемещения. Когда документы плана проведены, позиции на складах точек продаются готовыми: продажа списывает саму позицию, а не ингредиенты (строки появятся в блоке «Что склады получают готовым» ниже)."));
  if (r.docs.length) out.append(el("h3", { style: "margin:14px 0 6px" }, "Документы по плану"),
    el("div", {}, ...r.docs.map((d) => el("div", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); editDoc(d.id); } }, `${TYPES[d.doc_type]} ${d.number}`),
      " — ", d.status === "draft" ? el("span", { class: "tag" }, "черновик") : el("span", { class: "tag ok" }, "проведён")))));
  if (r.orders.length) out.append(el("h3", { style: "margin:14px 0 6px" }, "Кто подал"),
    el("div", {}, ...r.orders.map((o) => el("div", { class: "dim" }, `${o.point_name}: ${o.lines} поз., ${o.sent_by || "—"}, ${new Date(o.updated_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
      o.has_store ? null : el("span", { class: "tag bad" }, " у точки нет склада")))));
}

// ---------- что склады получают готовым (контракт п. 11, таблица store_ready) ----------
// На складе с указанной даты позиция продаётся готовой: продажа списывает саму позицию (то, что
// привезли с кухни), а не ингредиенты по техкарте. Строки «по плану» ставит проведение документов
// плана заявок, «по документу» — проведение любого перемещения или акта производства на склад точки
// (миграция 0045, для позиций с техкартой); снимает отмена их проведения. Здесь их видно и можно
// поправить руками.
const SR_SOURCE = { manual: "вручную", office: "вручную", plan: "по плану", orders: "по плану", auto: "по документу" };
const sr = { store_id: "" };
let srSeq = 0;
// Пересчёт продаж после правки идёт частями: сервер за один вызов пересобирает не больше 5 продаж
// и отвечает, сколько осталось (remaining); остальные добирает stock_ready_resync, пока не станет 0.
// Цикл один на страницу: правка, сделанная во время пересчёта, только добавляет ему работы.
let srLoop = null;
function srNote(...parts) {
  const note = document.querySelector("#ord-root .sr-note"); if (!note) return;
  note.innerHTML = ""; note.append(...parts);
}
export function srResync(o = {}) {
  if (srLoop) return srLoop;
  srLoop = (async () => {
    let total = o.done || 0, left = o.left || 0;
    // quiet — проверка после проведения документа плана: если пересчитывать нечего, молчим
    if (!o.quiet || left) srNote(left ? `Пересчитываю продажи: осталось ${left}` : "Пересчитываю продажи…");
    for (;;) {
      const r = await api("stock_ready_resync", {}, { timeout: LONG_MS });
      if (!r.ok) {
        if (o.quiet && !total) return;
        // Обрыв или отказ: что успело пересчитаться, неизвестно — перечитываем список и даём продолжить.
        srNote(`Пересчёт продаж прервался: ${errText(r)}. `, el("button", { class: "link", onclick: () => srResync() }, "Продолжить пересчёт"));
        toast(errText(r), "bad");
        loadStoreReady();
        return;
      }
      total += Number(r.resynced) || 0;
      left = Number(r.remaining) || 0;
      if (!left) break;
      // Ни одной за вызов — дальше не сдвинется (например, мешает инвентаризация): не крутимся впустую.
      if (!Number(r.resynced)) {
        srNote(`Пересчитано продаж: ${total}. Ещё ${left} сейчас не пересчитать — причина видна во вкладке «Продажи». `,
          el("button", { class: "link", onclick: () => srResync() }, "Повторить"));
        loadStoreReady();
        return;
      }
      srNote(`Пересчитываю продажи: осталось ${left}`);
    }
    if (o.quiet && !total) return;
    srNote(`Готово: пересчитано продаж — ${total}`);
    toast(`Продажи пересчитаны: ${total}`);
    loadStoreReady();
  })().finally(() => { srLoop = null; });
  return srLoop;
}
function storeReadyBox() {
  const canEdit = perms().includes("stock:edit");
  return el("div", { class: "card sr-box noprint", style: "margin-top:18px" },
    el("h3", { style: "margin:0 0 4px" }, "Что склады получают готовым"),
    el("div", { class: "dim", style: "margin-bottom:8px" },
      "Если склад получает позицию готовой (выпечку с кухни), её продажа на этом складе списывает саму позицию, а не муку, масло и начинку по техкарте. "
      + "Строки «по плану» ставят проведённые документы плана заявок, «по документу» — проведённое перемещение или акт производства на склад точки (для блюд и полуфабрикатов с техкартой); отмена проведения их снимает. Здесь строки можно добавить или убрать. "
      + "После правки продажи склада с этой даты пересчитываются — частями, ход пересчёта виден здесь же. Если закрыть страницу раньше, остаток пересчитается при «Провести продажи за период»."),
    el("div", { class: "tools" },
      // Склады — только действующие и закреплённые за пользователем: по чужим сервер откажет.
      storeSel(sr, allStores(), loadStoreReady),
      canEdit ? el("button", { class: "ghost", onclick: addStoreReady }, "+ Добавить позицию") : null),
    el("div", { class: "dim sr-note" }),
    el("div", { class: "sr-list" }));
}
async function loadStoreReady() {
  const box = document.querySelector("#ord-root .sr-box"); if (!box) return;
  const list = box.querySelector(".sr-list");
  const n = ++srSeq;
  const r = await api("stock_ready_list", { store_id: sr.store_id || null }, { timeout: LONG_MS });
  if (n !== srSeq) return;
  list.innerHTML = "";
  if (!r.ok) { list.append(el("div", { class: "err" }, errText(r))); return; }
  const canEdit = perms().includes("stock:edit");
  const t = el("table");
  t.append(el("tr", {}, ...["Склад", "Позиция", "Ед.", "Готовым с", "Откуда", ""].map((h) => el("th", {}, h))));
  for (const x of r.rows) t.append(el("tr", {}, el("td", {}, x.store_name), el("td", {}, x.item_name), el("td", {}, x.unit_id || ""),
    el("td", {}, fmtDate(x.date_from)), el("td", { class: "dim" }, SR_SOURCE[x.source] || x.source || ""),
    el("td", {}, canEdit ? el("button", { class: "x", title: "Убрать", tabindex: "-1", onclick: (e) => delStoreReady(x, e.target) }, "×") : null)));
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Ни один склад пока не получает позиции готовыми")));
  list.append(el("div", { style: "overflow:auto;max-height:420px" }, t));
}
// После правки сервер сразу пересчитывает до 5 продаж склада и говорит, сколько ещё осталось.
function storeReadyDone(r) {
  const done = Number(r.resynced) || 0, left = Number(r.remaining) || 0;
  const text = `Сохранено. Пересчитано продаж: ${done}` + (left ? `, осталось ${left}` : "");
  srNote(text);
  toast(text);
  loadStoreReady();
  if (left > 0) srResync({ done, left });
}
async function delStoreReady(x, b) {
  if (!confirmDlg(`Убрать «${x.item_name}» со склада «${x.store_name}»? Продажи этой позиции на складе снова будут списывать ингредиенты по техкарте.`)) return;
  b.disabled = true;
  const r = await api("stock_ready_delete", { store_id: x.store_id, item_code: x.item_code }, { timeout: LONG_MS });
  b.disabled = false;
  // Обрыв или «пересчёт уже идёт»: применилось ли удаление — видно только по свежему списку.
  if (!r.ok) { toast(errText(r), "bad"); loadStoreReady(); return; }
  storeReadyDone(r);
}
function addStoreReady() {
  const m = modal("Склад получает позицию готовой", { keep: true });
  let item = null;
  const search = el("input", { placeholder: "Позиция: название или код" });
  const res = el("div", { class: "sres" });
  search.addEventListener("input", debounce(async () => {
    item = null; res.innerHTML = ""; const q = search.value.trim(); if (q.length < 2) return;
    const s = await api("items_search", { q, active: true, page: 1, types: ["dish", "prepared"], limit: 30 });
    for (const it of (s.rows || []).filter((it) => ["dish", "prepared"].includes(it.item_type)).slice(0, 30)) {   // товар и так продаётся как есть
      res.append(el("button", { class: "sitem", onclick: () => { item = it; search.value = it.name; res.innerHTML = ""; } },
        it.name, el("span", { class: "dim" }, ` · ${it.unit_id}`)));
    }
  }, 300));
  const st = sel({ "": "— склад —", ...opts(storeList()) }, sr.store_id, () => {});
  const date = el("input", { type: "date", value: today() });
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    err.textContent = "";
    if (!item) { err.textContent = "Выберите позицию из списка"; return; }
    if (!st.value) { err.textContent = "Выберите склад"; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { err.textContent = "Выберите дату в календаре"; return; }
    go.disabled = true;
    const r = await api("stock_ready_save", { store_id: st.value, item_code: item.code, date_from: date.value }, { timeout: LONG_MS });
    go.disabled = false;
    // Строка склада и позиции одна (повтор её просто перезапишет), но применилась ли правка после
    // обрыва — видно только по свежему списку под окном.
    if (!r.ok) { err.textContent = errText(r); loadStoreReady(); return; }
    m.close(); storeReadyDone(r);
  } }, "Добавить");
  m.root.append(el("div", { class: "dim" }, "С этой даты продажа позиции на складе списывает саму позицию, а не ингредиенты. Продажи склада с этой даты будут пересчитаны."),
    el("div", { class: "sbox" }, el("label", {}, "Позиция"), search, res),
    el("div", { class: "grid2" }, el("div", {}, el("label", {}, "Склад"), st), el("div", {}, el("label", {}, "Готовым с"), date)),
    err, el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  search.focus();
}

// ---------- расход для 1С: основа акта списания «на основании продаж» ----------
// Бухгалтер списывает в 1С продукты, ушедшие на проданное. Номенклатура 1С своя, поэтому у позиции
// учёта хранится код 1С и сколько единиц 1С в одной нашей (кофе 3в1: пакетик = 1/25 блока).
const c1 = { store_id: "", date_from: "", date_to: "", auto: true, catalog: null, notice: "" };
export async function loadC1() {
  const canEdit = perms().includes("doc:sale:edit");
  const out = tabOut("c1-root", () => {
    // Справочник 1С загружается из Excel — материальной ведомости 1С (действие stock_1c_catalog_save
    // было на сервере, а кнопки не было, и в новой базе «Расход для 1С» оставался пустым).
    const file = el("input", { type: "file", accept: ".xlsx,.xls", style: "display:none", onchange: (e) => { if (e.target.files[0]) upload1c(e.target, e.target.nextSibling); } });
    return [el("div", { class: "tools" },
      storeSel(c1, myIds.length ? "мои склады вместе" : "все склады вместе", loadC1),
      ...periodTools(c1, loadC1),
      el("button", { class: "ghost csv" }, "Скачать для 1С (CSV)"),
      canEdit ? file : null,
      canEdit ? el("button", { class: "ghost", onclick: () => file.click() }, "Загрузить справочник 1С (xlsx)") : null)];
  });
  if (!out) return;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("c1");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
  const ctx = { store_id: c1.store_id, date_from: c1.date_from, date_to: c1.date_to };
  const [r, cat] = await Promise.all([api("stock_1c_report", { store_id: c1.store_id || null, date_from: c1.date_from, date_to: c1.date_to }),
    c1.catalog ? { ok: true, rows: c1.catalog } : api("stock_1c_catalog_list", {})]);
  if (n !== seqs.c1) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  if (cat.ok) c1.catalog = cat.rows;
  const byCode = new Map();
  for (const x of r.rows.filter((x) => x.code_1c && x.qty_1c !== null)) {
    const g = byCode.get(x.code_1c) || { code: x.code_1c, name: x.name_1c, unit: x.unit_1c, account: x.account_1c, qty: 0, sum: 0, src: [] };
    g.qty += Number(x.qty_1c); g.sum += Number(x.sum); g.src.push(x); byCode.set(x.code_1c, g);
  }
  const groups = [...byCode.values()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru"));
  const free = r.rows.filter((x) => !x.code_1c || x.qty_1c === null);
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Код 1С"), el("th", {}, "Номенклатура 1С"), el("th", {}, "Счёт"), el("th", {}, "Ед."),
    el("th", { class: "num" }, "Списать"), el("th", { class: "num" }, "Себестоимость, ₸"), el("th", {}, "Из позиций учёта")));
  let total = 0;
  for (const g of groups) {
    total += g.sum;
    t.append(el("tr", {}, el("td", {}, g.code), el("td", {}, g.name), el("td", {}, g.account || ""), el("td", {}, g.unit || ""),
      el("td", { class: "num" }, qtyStr(Math.round(g.qty * 1000) / 1000)), el("td", { class: "num" }, money(g.sum)),
      el("td", { class: "dim" }, ...g.src.map((x, j) => el("span", {}, j ? "; " : "",
        canEdit ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); linkC1(x); } }, x.name) : x.name,
        ` ${qtyStr(x.qty)} ${x.unit_id || ""}`)))));
  }
  if (!groups.length) t.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "За период расхода по позициям с кодом 1С нет")));
  const catSize = (c1.catalog || []).length;
  put(out, c1.notice ? el("div", { class: "okbox", style: "margin-bottom:10px" }, c1.notice) : null,
    cat.ok && !catSize ? el("div", { class: "warnbox", style: "margin:0 0 10px" }, "Справочник 1С пуст: связать позиции учёта не с чем, и в файл для 1С ничего не попадёт. "
      + (canEdit ? "Загрузите материальную ведомость 1С кнопкой «Загрузить справочник 1С (xlsx)»." : "Загрузить его может бухгалтер или собственник.")) : null,
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "tot" }, el("span", {}, `Позиций 1С: ${groups.length}` + (cat.ok ? ` · в справочнике 1С: ${catSize}` : "")), el("span", {}, `${money(total)} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Расход проведённых продаж и актов производства, кроме полуфабрикатов и выпечки с кухни, проданной готовой: 1С знает сырьё, из которого они сделаны. Себестоимость — по нашему складу; в акте 1С сумму поставит сама 1С по своим ценам."));
  c1.notice = "";
  if (free.length) {
    const ft = el("table");
    ft.append(el("tr", {}, el("th", {}, "Позиция учёта"), el("th", {}, "Ед."), el("th", { class: "num" }, "Расход"), el("th", { class: "num" }, "₸"), canEdit ? el("th", {}, "") : null));
    for (const x of free) ft.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""), el("td", { class: "num" }, qtyStr(x.qty)), el("td", { class: "num" }, money(x.sum)),
      canEdit ? el("td", {}, el("button", { class: "ghost", onclick: () => linkC1(x) }, "Указать позицию 1С")) : null));
    out.append(el("h3", { style: "margin-top:18px" }, `Без позиции 1С: ${free.length}`),
      el("div", { class: "dim" }, "Эти продукты расходовались, но не связаны с 1С — в список на списание не попали. Если такого товара в 1С нет (не было прихода по документам), списать его в 1С нельзя."),
      el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, ft));
  }
  csvBtn.onclick = () => csvSave(`расход для 1С ${storeName(ctx.store_id)} ${periodText(ctx)}`, [
    ["Код 1С", "Номенклатура 1С", "Счёт", "Ед.", "Количество", "Себестоимость учёта, ₸"],
    ...groups.map((g) => [g.code, g.name, g.account || "", g.unit || "", Math.round(g.qty * 1000) / 1000, n2(g.sum)]),
    // Бухгалтер должен видеть в самом файле, что списано не всё: раньше пустой файл молчал о 26 позициях.
    ...(free.length ? [[`Не попали: ${free.length} ${plural(free.length, "позиция", "позиции", "позиций")} без связи с 1С`]] : []),
  ]);
}
// Разбор листа Excel со справочником 1С → {ok, rows:[{code, name, unit, account}], skipped, dups} или
// {ok:false, error}. Шапку ищем по словам (над ней бывает сколько угодно строк заголовка отчёта):
// «Код» и «Номенклатура»/«Наименование» обязательны, «Ед.» и «Счёт» — если есть. В выгрузке 1С счёт
// часто стоит отдельной строкой («1310») над своими позициями — тогда он переходит на строки ниже.
// Чистая функция: проверяется отдельно, без окна и сервера.
export function parse1cSheet(g) {
  const txt = (v) => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim();
  let hi = -1, cCode = -1, cName = -1, cUnit = -1, cAcc = -1;
  for (let i = 0; i < Math.min(g.length, 50); i++) {
    const row = (g[i] || []).map(txt);
    const nm = row.findIndex((c) => /^(номенклатура|наименование)/i.test(c));
    const cd = row.findIndex((c) => /^код(\s*1\s*с)?$/i.test(c));
    if (nm < 0 || cd < 0) continue;
    hi = i; cName = nm; cCode = cd;
    cUnit = row.findIndex((c) => /^ед(\.|иниц|\s|$)/i.test(c));
    cAcc = row.findIndex((c) => /^сч[её]т/i.test(c));
    break;
  }
  if (hi < 0) return { ok: false, error: "Не нашёл строку шапки с колонками «Код» и «Номенклатура» (или «Наименование»)" };
  const byCode = new Map();
  let acc = "", skipped = 0, dups = 0;
  for (const raw of g.slice(hi + 1)) {
    const row = (raw || []).map(txt);
    const code = row[cCode] || "", name = row[cName] || "", a = cAcc >= 0 ? row[cAcc] || "" : "";
    if (/^итог/i.test(name) || /^итог/i.test(code) || /^итог/i.test(row[0] || "")) continue;
    // строка-группа счёта, без кода позиции: «1310» в колонке счёта при пустом названии или само
    // название — номер счёта («1310» или «1310, Сырьё и материалы»)
    const accName = /^(\d{4})(\.\d+)?(\b|$)/.exec(name);
    if (!code && ((!name && /^\d{4}(\.\d+)?$/.test(a)) || accName)) { acc = accName ? accName[1] + (accName[2] || "") : a; continue; }
    if (!code && !name) continue;
    if (!code || !name) { skipped++; continue; }
    if (byCode.has(code)) dups++;
    byCode.set(code, { code, name, unit: cUnit >= 0 ? row[cUnit] || "" : "", account: a || acc });
  }
  return { ok: true, rows: [...byCode.values()], skipped, dups };
}
async function upload1c(input, btn) {
  const file = input.files[0];
  if (btn) btn.disabled = true;
  try {
    // Файл читаем сразу, до сброса поля: файл, сброшенный из поля раньше чтения, Chrome уже не отдаёт.
    // SheetJS грузит stock.js (там же разбор файла остатков iiko); импорт — внутри функции, без
    // взаимного импорта модулей при загрузке.
    let wb;
    try {
      const buf = await file.arrayBuffer();
      const { loadXlsx } = await import("./stock.js?v=21");
      await loadXlsx();
      wb = window.XLSX.read(new Uint8Array(buf), { type: "array" });
    } catch (e) { toast("Файл не прочитан: " + (e && e.message || e), "bad"); return; }
    // Лист — тот, где больше всего позиций: в книге сверки рядом лежат сводка и пояснения.
    let best = null, firstErr = "";
    for (const name of wb.SheetNames) {
      const p = parse1cSheet(window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" }));
      if (!p.ok) { firstErr = firstErr || p.error; continue; }
      if (!best || p.rows.length > best.rows.length) best = { sheet: name, ...p };
    }
    if (!best || !best.rows.length) { toast(best ? "В файле нет строк с кодом и названием" : firstErr, "bad"); return; }
    const sample = best.rows.slice(0, 3).map((x) => `«${x.name}» (${x.code}${x.unit ? ", " + x.unit : ""})`).join(", ");
    if (!confirmDlg(`Файл «${file.name}», лист «${best.sheet}»: ${best.rows.length} ${plural(best.rows.length, "позиция", "позиции", "позиций")} 1С`
      + (best.skipped ? `, пропущено строк без кода или названия: ${best.skipped}` : "") + `.\nНапример: ${sample}.\n\n`
      + "Загрузить в справочник 1С? Позиции с теми же кодами обновятся; связи с позициями учёта не меняются.")) return;
    // Частями: большой справочник одним запросом мог не уложиться в лимит запроса и время ответа.
    let saved = 0, last = null;
    for (let i = 0; i < best.rows.length; i += 500) {
      const part = best.rows.slice(i, i + 500);
      const r = await api("stock_1c_catalog_save", { rows: part }, { timeout: LONG_MS });
      if (!r.ok) { toast((saved ? `Загружено ${saved} из ${best.rows.length}, дальше ошибка: ` : "") + errText(r), "bad"); c1.catalog = null; loadC1(); return; }
      saved += part.length; last = r;
    }
    c1.notice = `Справочник 1С загружен: ${saved} ${plural(saved, "позиция", "позиции", "позиций")} из файла. `
      + `В справочнике теперь ${last.catalog}, связано позиций учёта: ${last.linked}. Несвязанные — ниже, кнопка «Указать позицию 1С».`;
    toast(`Загружено позиций 1С: ${saved}`);
    c1.catalog = null;
    loadC1();
  } finally {
    // поле сбрасываем в конце — иначе повторный выбор того же файла не даёт события change
    input.value = "";
    if (btn) btn.disabled = false;
  }
}
function linkC1(x) {
  const m = modal("Позиция 1С для «" + x.name + "»", { keep: true });
  const label = (c) => c.code + " · " + c.name + " · " + (c.unit || "");
  const list = el("datalist", { id: "c1-cat" }, ...(c1.catalog || []).map((c) => el("option", { value: label(c) })));
  const cur = (c1.catalog || []).find((c) => c.code === x.code_1c);
  const pick = el("input", { list: "c1-cat", placeholder: "Начните вводить название из 1С", value: cur ? label(cur) : "" });
  const k = el("input", { inputmode: "decimal", value: x.k_1c ?? "1" });
  const err = el("div", { class: "err" }, (c1.catalog || []).length ? "" : "Справочник 1С пуст — сначала загрузите его кнопкой «Загрузить справочник 1С (xlsx)».");
  const save = el("button", {}, "Сохранить");
  const clear = x.code_1c ? el("button", { class: "ghost" }, "Снять связь") : null;
  m.root.append(list, el("label", {}, "Позиция 1С"), pick,
    el("label", {}, `Сколько единиц 1С в одной нашей (${x.unit_id || "ед."})`), k,
    el("div", { class: "dim" }, "Единицы совпадают — 1. Мы считаем пакетики кофе, а 1С — блоки по 25: 0,04. Мы в кг, а в 1С банки по 400 г: 2,5."),
    err, el("div", { class: "actions" }, save, clear, el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  const send = async (code, kv) => {
    save.disabled = true; if (clear) clear.disabled = true;
    const r = await api("stock_1c_link_save", { item_code: x.item_code, code_1c: code, k_1c: kv });
    save.disabled = false; if (clear) clear.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    m.close(); toast("Сохранено"); loadC1();
  };
  save.onclick = () => {
    const code = pick.value.split(" · ")[0].trim();
    if (!(c1.catalog || []).some((c) => c.code === code)) { err.textContent = "Выберите позицию из списка 1С"; return; }
    send(code, String(k.value).replace(",", "."));
  };
  if (clear) clear.onclick = () => send("", "");
}

// ---------- отчёты: прибыль по точкам, закупки, продажи по блюдам ----------
const rep = { kind: "pnl", store_id: "", point_id: "", q: "", date_from: "", date_to: "", auto: true };
export async function loadReports() {
  const KINDS = { pnl: "Прибыль по точкам", purchases: "Закупки", dishes: "Продажи по блюдам" };
  if (rep.kind === "dishes") {
    await loadSalePoints();
    if (rep.point_id && !salePoints.some((x) => x.id === rep.point_id)) rep.point_id = "";
  }
  let redraw = null;   // «Продажи по блюдам»: поиск фильтрует уже полученный ответ, без нового запроса
  const out = tabOut("rep-root", () => [el("div", { class: "tools" },
    // Вид отчёта меняет и строку фильтров (склад есть только у закупок, точка и поиск — у продаж по
    // блюдам) — её строим заново. Выбор вида — первым полем: на него опирается проверка ui-smoke.
    sel(KINDS, rep.kind, (v) => { rep.kind = v; const h = document.getElementById("rep-root"); if (h) h.innerHTML = ""; loadReports(); }),
    rep.kind === "purchases" ? storeSel(rep, allStores(), loadReports) : null,
    rep.kind === "dishes" ? sel(pointOpts(), rep.point_id, (v) => { rep.point_id = v; loadReports(); }) : null,
    rep.kind === "dishes" ? el("input", { placeholder: "Поиск по названию", value: rep.q, oninput: debounce((e) => { rep.q = e.target.value; if (rep.redraw) rep.redraw(); }, 250) }) : null,
    ...periodTools(rep, loadReports),
    el("button", { class: "ghost csv" }, "Скачать CSV"))]);
  if (!out) return;
  rep.redraw = null;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("rep");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
  const period = { date_from: rep.date_from, date_to: rep.date_to };
  if (rep.kind === "pnl") await reportPnl(out, csvBtn, n, period);
  else if (rep.kind === "purchases") await reportPurchases(out, csvBtn, n, { ...period, store_id: rep.store_id || null });
  else redraw = await reportDishes(out, csvBtn, n, { ...period, point_id: rep.point_id || null });
  if (redraw && n === seqs.rep) rep.redraw = redraw;
}
const th = (h, i) => el("th", { class: i ? "num" : "" }, h);
const totRow = (...cells) => el("tr", { style: "font-weight:700;background:#EEF2F8" }, ...cells);

// Прибыль по точкам — как «Отчёт о прибылях и убытках» iiko в части продуктов.
async function reportPnl(out, csvBtn, n, period) {
  // Прошлый период той же длины, вплотную перед выбранным: чтобы видеть, растёт точка или падает.
  const d1 = new Date(period.date_from + "T12:00:00"), d2 = new Date(period.date_to + "T12:00:00");
  const okDates = !Number.isNaN(d1.getTime()) && !Number.isNaN(d2.getTime()) && d2 >= d1;
  const len = okDates ? Math.round((d2 - d1) / 86400e3) + 1 : 0;
  const prev = okDates ? { date_from: iso(new Date(d1.getTime() - len * 86400e3)), date_to: iso(new Date(d1.getTime() - 86400e3)) } : null;
  const [r, rp] = await Promise.all([api("stock_pnl_report", period), prev ? api("stock_pnl_report", prev) : { ok: false }]);
  if (n !== seqs.rep) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  const rows = r.rows;
  const pv = new Map(((rp.ok && rp.rows) || []).map((x) => [x.point_id ?? "", x]));
  const delta = (now, was) => { if (!was) return ""; const p = Math.round((now - was) / Math.abs(was) * 100); return (p > 0 ? "+" : "") + p + " %"; };
  // Сервер с миграцией 0046 отдаёт излишки и недостачу отдельно (inventory — их разность), скидки
  // кассы и число позиций с неполной себестоимостью; до неё — одна «Инвентаризация ±». Без строк
  // (пустой период) узнать не по чему — шапка нынешняя, «Излишки / Недостача» (owner Д7: за
  // «Прошлый месяц» и пустое «Вчера» в шапке стояла старая «Инвентаризация ±»).
  const split = !rows.length || has(rows, "surplus") || has(rows, "shortage");
  const disc = rows.some((x) => Number(x.discounts || 0) > 0);
  const hasInc = has(rows, "incomplete");
  const num = (x, k) => Number(x[k] || 0);
  const res = (x) => num(x, "revenue") - num(x, "cost") - num(x, "writeoff") + (split ? num(x, "surplus") - num(x, "shortage") : num(x, "inventory"));
  const fc = (x) => num(x, "revenue") ? Math.round(num(x, "cost") / num(x, "revenue") * 10000) / 100 : null;
  // reval — переоценка проданного в минус (−сумма поправок стоимости по складам точки за период):
  // она уже входит в себестоимость, ячейку помечаем звёздочкой и поясняем под таблицей.
  const rv = (x) => num(x, "reval");
  const costCell = (x) => rv(x) ? el("td", { class: "num", title: "в том числе переоценка " + money(rv(x)) + " ₸" }, money(x.cost) + " *") : el("td", { class: "num" }, money(x.cost));
  const heads = ["Точка", "Выручка", ...(disc ? ["Скидки"] : []), "Себестоимость проданного", "Валовая прибыль", "Фудкост", "Списания",
    ...(split ? ["Излишки", "Недостача"] : ["Инвентаризация ±"]), "Итог по продуктам", "Выручка к прошлому периоду"];
  const t = el("table");
  t.append(el("tr", {}, ...heads.map(th)));
  const tot = { revenue: 0, discounts: 0, cost: 0, writeoff: 0, inventory: 0, surplus: 0, shortage: 0, reval: 0, incomplete: 0 };
  const cells = (x, isTot) => {
    const inc = num(x, "incomplete");
    const incTitle = inc ? `У ${inc} ${plural(inc, "проданной позиции", "проданных позиций", "проданных позиций")} в техкарте есть ингредиент без цены: себестоимость и фудкост занижены. Список — «Готовность» → «Сырьё без цены».` : null;
    return [
      // у «Итого» без числа: одна и та же позиция могла продаваться в нескольких точках
      el("td", {}, isTot ? "Итого" : x.point_name, inc ? el("div", {}, el("span", { class: "tag", title: incTitle }, isTot ? "себестоимость неполная" : `себестоимость неполная (${inc} поз.)`)) : null),
      el("td", { class: "num" }, money(x.revenue)),
      disc ? el("td", { class: "num", title: "Скидки кассы — для сведения: выручка уже за их вычетом" }, num(x, "discounts") ? money(x.discounts) : "") : null,
      costCell(x),
      el("td", { class: "num" }, money(num(x, "revenue") - num(x, "cost"))),
      el("td", { class: "num" }, fc(x) === null ? "" : fcTag(fc(x), inc > 0, incTitle)),
      el("td", { class: "num" }, money(x.writeoff)),
      ...(split ? [el("td", { class: "num" }, money(x.surplus || 0)), el("td", { class: "num" + (num(x, "shortage") > 0 ? " bad" : "") }, money(x.shortage || 0))]
        : [el("td", { class: "num" + (num(x, "inventory") < 0 ? " bad" : "") }, money(x.inventory))]),
      el("td", { class: "num", style: "font-weight:700" }, money(res(x))),
    ];
  };
  for (const x of rows) {
    for (const k of Object.keys(tot)) tot[k] += num(x, k);
    t.append(el("tr", {}, ...cells(x, false),
      el("td", { class: "num", title: prev ? "Прошлый период: " + fmtDate(prev.date_from) + " — " + fmtDate(prev.date_to) : null },
        delta(num(x, "revenue"), pv.has(x.point_id ?? "") ? Number(pv.get(x.point_id ?? "").revenue) : 0))));
  }
  for (const k of Object.keys(tot)) tot[k] = n2(tot[k]);
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: heads.length, class: "dim" }, "За период проведённых продаж, списаний и инвентаризаций нет")));
  else t.append(totRow(...cells(tot, true), el("td", { class: "num" }, delta(tot.revenue, [...pv.values()].reduce((a, x) => a + Number(x.revenue || 0), 0)))));
  const revalPts = rows.filter((x) => rv(x));
  put(out, el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    revalPts.length ? el("div", { class: "warnbox" }, "* Себестоимость включает переоценку проданного в минус: товар продали раньше, чем его оприходовали, и приход пересчитал недостающее по своей цене — "
      + revalPts.map((x) => `${x.point_name} ${rv(x) > 0 ? "+" : ""}${money(rv(x))} ₸`).join(", ") + ". Чтобы такого не было, заносите приходы до продаж.") : null,
    el("div", { class: "dim", style: "margin-top:8px" }, "Только продукты: выручка и себестоимость проданного, списания (порча, брак, проработка, питание персонала и прочее) "
      + (split ? "и итоги инвентаризаций со складов точки: излишки в плюс, недостача в минус. " : "и итог инвентаризаций со складов точки — недостача с минусом. ")
      + "Итог по продуктам = выручка − себестоимость − списания + излишки − недостача. Ввод начальных остатков (день X) в прибыль не входит. "
      + (disc ? "Скидки кассы показаны для сведения: выручка уже за их вычетом. " : "")
      + "Склады, не привязанные к точке, — строкой «Склады без точки». Зарплата, аренда и прочие расходы появятся с разделом «Финансы»."));
  csvBtn.onclick = () => {
    const head = ["Точка", "Выручка", ...(disc ? ["Скидки"] : []), "Себестоимость", ...(revalPts.length ? ["в т. ч. переоценка"] : []), "Валовая прибыль", "Фудкост, %", "Списания",
      ...(split ? ["Излишки", "Недостача"] : ["Инвентаризация"]), "Итог по продуктам", ...(hasInc ? ["Себестоимость неполная, поз."] : [])];
    const line = (x, name) => [name, csvNum(x.revenue), ...(disc ? [csvNum(x.discounts || 0)] : []), csvNum(x.cost), ...(revalPts.length ? [rv(x)] : []),
      n2(num(x, "revenue") - num(x, "cost")), fc(x) ?? "", csvNum(x.writeoff),
      ...(split ? [csvNum(x.surplus || 0), csvNum(x.shortage || 0)] : [csvNum(x.inventory)]), n2(res(x)), ...(hasInc ? [num(x, "incomplete") || ""] : [])];
    csvSave(`прибыль по точкам ${periodText(period)}`, [[`Прибыль по точкам · ${periodText(period)}`], head,
      ...rows.map((x) => line(x, x.point_name)), ...(rows.length ? [line(tot, "Итого")] : [])]);
  };
}

// Закупки — как «Отчёт о закупках по поставщикам» iiko: накладных, сумма, средняя накладная.
async function reportPurchases(out, csvBtn, n, period) {
  const r = await api("stock_purchases_report", period);
  if (n !== seqs.rep) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  // Итоги — из ответа сервера (миграция 0046), иначе сложением: у накладной один поставщик, поэтому
  // накладные поставщиков складываются; товаров — сколько разных позиций в разделе «По товарам».
  const tt = r.totals || {};
  const tot = { docs: tt.docs ?? r.suppliers.reduce((a, x) => a + Number(x.docs || 0), 0), sum: tt.sum ?? sumOf(r.suppliers, "sum"), items: tt.items ?? r.items.length };
  tot.avg = tt.avg ?? (tot.docs ? n2(tot.sum / tot.docs) : null);
  const avg = (x) => x.avg ?? (Number(x.docs) ? n2(Number(x.sum) / Number(x.docs)) : null);
  const st = el("table");
  st.append(el("tr", {}, ...["Поставщик", "Накладных", "Товаров", "Сумма, ₸", "Средняя накладная, ₸"].map(th)));
  for (const x of r.suppliers) {
    // Щелчок — журнал документов: приходы этого поставщика за период и по складу отчёта (раньше журнал
    // открывался за все даты и по всем складам — buh 4). Склад «все» — пустой фильтр журнала.
    const go = x.counteragent_id ? () => hooks.openDocs(x.name, { doc_type: "invoice_in", status: "posted", store_id: period.store_id || "",
      date_from: period.date_from, date_to: period.date_to }) : null;
    st.append(el("tr", { class: go ? "row" : "", onclick: go, title: go ? "Открыть накладные поставщика в журнале документов" : null },
      el("td", {}, go ? el("a", { href: "#", onclick: (e) => e.preventDefault() }, x.name) : x.name),
      el("td", { class: "num" }, String(x.docs)), el("td", { class: "num" }, String(x.items)), el("td", { class: "num" }, money(x.sum)), el("td", { class: "num" }, money(avg(x)))));
  }
  if (!r.suppliers.length) st.append(el("tr", {}, el("td", { colspan: 5, class: "dim" }, "За период проведённых приходов нет")));
  else st.append(totRow(el("td", {}, "Итого"), el("td", { class: "num" }, String(tot.docs)), el("td", { class: "num" }, String(tot.items)),
    el("td", { class: "num" }, money(tot.sum)), el("td", { class: "num" }, money(tot.avg))));
  // «Код iiko» (артикул) — первой колонкой, как в ведомости: по нему сверяют с отчётом iiko (buh 11).
  // Сервер отдаёт artikul у товаров с правкой 0046; до неё колонки нет.
  const showArt = has(r.items, "artikul");
  const lead = showArt ? 1 : 0;
  const t = el("table");
  t.append(el("tr", {}, ...[...(showArt ? ["Код iiko"] : []), "Товар", "Ед.", "Количество", "Сумма, ₸", "Средняя цена", "Мин. цена", "Макс. цена", "Поставщиков"]
    .map((h, i) => el("th", { class: i > lead + 1 ? "num" : "" }, h))));
  for (const x of r.items) t.append(el("tr", {}, showArt ? el("td", { class: "dim" }, x.artikul || "") : null,
    el("td", {}, x.name), el("td", {}, x.unit_id || ""), el("td", { class: "num" }, qtyStr(x.qty)), el("td", { class: "num" }, money(x.sum)),
    el("td", { class: "num" }, money(x.avg_price)), el("td", { class: "num" }, money(x.min_price)),
    el("td", { class: "num" + (x.max_price > x.min_price * 1.1 ? " bad" : "") }, money(x.max_price)), el("td", { class: "num" }, String(x.suppliers))));
  if (r.items.length) t.append(totRow(el("td", { colspan: lead + 3 }, `Итого: ${r.items.length} ${plural(r.items.length, "товар", "товара", "товаров")}`), el("td", { class: "num" }, money(sumOf(r.items, "sum"))), el("td", { colspan: 4 })));
  const where = storeName(period.store_id);
  put(out, el("h3", { style: "margin:0 0 8px" }, "По поставщикам"),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, st),
    r.suppliers.length ? el("div", { class: "dim", style: "margin:-6px 0 0" }, "Щелчок по поставщику — его приходные накладные за этот период и по этому складу в журнале документов.") : null,
    el("h3", { style: "margin:16px 0 8px" }, "По товарам"), el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "dim", style: "margin-top:8px" }, `${where} · ${periodText(period)}. Проведённые приходные накладные за период. Красным — максимальная цена выше минимальной больше чем на 10 %: стоит спросить поставщика.`));
  // Оба раздела в одном файле, как отчёт iiko: сначала поставщики, затем товары; в шапке и в имени — склад и период.
  csvBtn.onclick = () => csvSave(`закупки ${where} ${periodText(period)}`, [
    [`Закупки · ${where} · ${periodText(period)}`],
    [],
    ["По поставщикам"],
    ["Поставщик", "Накладных", "Товаров", "Сумма, ₸", "Средняя накладная, ₸"],
    ...r.suppliers.map((x) => [x.name, csvNum(x.docs), csvNum(x.items), csvNum(x.sum), csvNum(avg(x))]),
    ["Итого", tot.docs, tot.items, n2(tot.sum), csvNum(tot.avg)],
    [],
    ["По товарам"],
    [...(showArt ? ["Код iiko"] : []), "Товар", "Ед.", "Количество", "Сумма, ₸", "Средняя цена", "Мин. цена", "Макс. цена", "Поставщиков"],
    ...r.items.map((x) => [...(showArt ? [textCode(x.artikul)] : []), x.name, x.unit_id || "", csvNum(x.qty), csvNum(x.sum), csvNum(x.avg_price), csvNum(x.min_price), csvNum(x.max_price), csvNum(x.suppliers)]),
    [...(showArt ? [""] : []), "Итого", "", "", sumOf(r.items, "sum"), "", "", "", ""],
  ]);
}

// Продажи по блюдам — все проданные позиции за период по точке или по всем, с поиском и итогом.
// Возвращает перерисовку для поиска (фильтрует полученный ответ без нового запроса).
async function reportDishes(out, csvBtn, n, period) {
  const r = await api("doc_sales_report", period);
  if (n !== seqs.rep) return null;
  if (!r.ok) { out.innerHTML = ""; out.append(el("div", { class: "err" }, errText(r))); return null; }
  const where = period.point_id ? ((salePoints || []).find((p) => p.id === period.point_id) || {}).name || "точка" : "все точки";
  const words = () => rep.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = () => { const w = words(); return w.length ? r.items.filter((x) => { const s = String(x.name || "").toLowerCase(); return w.every((p) => s.includes(p)); }) : r.items; };
  const totals = (list) => { const rev = sumOf(list, "revenue"), cost = sumOf(list, "cost"); return { revenue: rev, cost, margin: n2(rev - cost), foodcost_pct: rev ? Math.round(cost / rev * 10000) / 100 : null }; };
  const draw = () => {
    if (!out.isConnected) return;
    out.innerHTML = "";
    const list = shown(), tot = totals(list);
    const t = el("table");
    t.append(el("tr", {}, ...["Блюдо / товар", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост"].map(th)));
    for (const x of list) t.append(dishRow(x));
    const inc = list.filter((x) => x.cost_incomplete).length;
    if (!list.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, r.items.length ? "Ничего не найдено" : "За период проведённых продаж нет")));
    else t.append(totRow(el("td", {}, `Итого: ${list.length} ${plural(list.length, "позиция", "позиции", "позиций")}`), el("td", {}),
      el("td", { class: "num" }, money(tot.revenue)), el("td", { class: "num" }, money(tot.cost)), el("td", { class: "num" }, money(tot.margin)),
      el("td", { class: "num" }, fcTag(tot.foodcost_pct, inc > 0, inc ? noPriceTitle() : null))));
    put(out, el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
      el("div", { class: "dim", style: "margin-top:8px" }, `${where} · ${periodText(period)}. Проданные позиции по выручке. Фудкост выше ${FC_ALERT} % — красным; `
        + "«себест. неполная» — в техкарте есть ингредиент без цены, себестоимость и фудкост занижены (наведите на метку — какие): "
        + `такой фудкост до ${FC_ALERT} % — без цвета, выше — тоже красным.`));
  };
  draw();
  csvBtn.onclick = () => {
    const list = shown(), tot = totals(list);
    csvSave(`продажи по блюдам ${where} ${periodText(period)}`, [
      [`Продажи по блюдам · ${where} · ${periodText(period)}` + (rep.q.trim() ? ` · поиск «${rep.q.trim()}»` : "")],
      ["Позиция", "Ед.", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост, %", "Себестоимость неполная", "Нет цены у"],
      ...list.map((x) => [x.name, x.unit_id || "", csvNum(x.qty), csvNum(x.revenue), csvNum(x.cost), csvNum(x.margin), csvNum(x.foodcost_pct),
        x.cost_incomplete ? "да" : "", (x.missing_names || []).join(", ")]),
      ["Итого", "", "", tot.revenue, tot.cost, tot.margin, csvNum(tot.foodcost_pct), "", ""],
    ]);
  };
  return draw;
}

// ---------- готовность: что в справочниках и документах помешает учёту ----------
// Переход из строки проверки: позиция и техкарта — по адресу (раздел перечитывается), склады и
// пользователи — пунктом меню (если раздел роли доступен), непроведённые продажи — вкладкой «Продажи».
const menuBtn = (id) => document.querySelector(`#menu button[data-id="${id}"]`);
const tabBtn = (title) => [...document.querySelectorAll("#main .tabs button")].find((b) => b.textContent === title);
const READY_GO = {
  item: { ok: (x) => !!(x.code || x.item_code), go: (x) => { location.hash = "#item/" + encodeURIComponent(x.code || x.item_code); location.reload(); } },
  chart: { ok: (x) => !!(x.code || x.item_code), go: (x) => { location.hash = "#charts/" + encodeURIComponent(x.code || x.item_code); location.reload(); } },
  store: { ok: () => !!menuBtn("stores"), go: () => { const b = menuBtn("stores"); if (b) b.click(); } },
  user: { ok: () => !!menuBtn("users"), go: () => { const b = menuBtn("users"); if (b) b.click(); } },
  sale: { ok: () => !!tabBtn("Продажи"), go: () => { const b = tabBtn("Продажи"); if (b) b.click(); } },
};
export async function loadReady() {
  const host = document.getElementById("ready-root"); if (!host) return;
  host.innerHTML = ""; const wait = el("div", { class: "dim" }, "Проверяю…"); host.append(wait);
  const r = await api("stock_quality_report", {});
  wait.remove();
  if (!r.ok) { host.append(el("div", { class: "err" }, errText(r)), el("button", { class: "ghost", onclick: loadReady }, "Повторить")); return; }
  // Справочные проверки (severity info — например, «Учебные склады») в «нужно внимание» не входят.
  const open = r.checks.filter((c) => c.count > 0 && c.severity !== "info");
  host.append(el("div", { class: "tot" },
    el("span", {}, open.length ? `Нужно внимание: ${open.length} из ${r.checks.length} проверок` : "Все проверки чистые"),
    el("span", {}, r.bad ? `мешают учёту: ${r.bad}` : "критичного нет")));
  // Проверки рисуются по ответу сервера как есть: новые (миграция 0046 — склад точки не привязан к ней,
  // подозрительный фудкост) появляются здесь без правки экрана.
  for (const c of r.checks) {
    const clean = !c.count;
    const d = el("details", { class: "card", style: "padding:12px 16px" });
    d.append(el("summary", { style: "cursor:pointer;display:flex;gap:10px;align-items:center" },
      el("span", { class: "tag " + (clean ? "ok" : c.severity === "bad" ? "bad" : "") }, clean ? "чисто" : String(c.count)),
      el("b", {}, c.title)));
    put(d, c.hint ? el("div", { class: "dim", style: "margin:8px 0" }, c.hint) : null);
    if (!clean) {
      const nav = READY_GO[c.target];
      const t = el("table");
      for (const x of c.rows || []) {
        const go = nav && nav.ok(x) ? () => nav.go(x) : null;
        t.append(el("tr", { class: go ? "row" : "", onclick: go },
          el("td", {}, x.name), el("td", { class: "dim" }, x.detail || ""), el("td", { class: "dim" }, go ? "открыть →" : "")));
      }
      if (c.count > (c.rows || []).length) t.append(el("tr", {}, el("td", { colspan: 3, class: "dim" }, `…и ещё ${c.count - (c.rows || []).length}`)));
      d.append(el("div", { style: "overflow:auto;max-height:420px" }, t));
    }
    host.append(d);
  }
}
