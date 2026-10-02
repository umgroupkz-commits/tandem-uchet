import { api, can } from "./api.js?v=21";
import { el, fmt, toast, debounce, modal, confirmDlg, today, isoDate, errText, uid, saveFailed } from "./ui.js?v=21";
import { parseNum, numStr, numInput, enterNext, fmtDate, fmtDateTime, fmtMoney, itemPicker } from "./inputs.js?v=21";
import { TYPES, MANUAL, REASONS, perms, canDoc, canAnyDoc, canSales, stores, setStores, active, opts, myIds, setMyIds, mine,
  seqs, nextSeq, tabOut, sel, hooks } from "./stock-common.js?v=21";
import { loadSales, loadTurnover, loadOrders, loadC1, loadReports, loadReady, srResync, resetReports } from "./stock-reports.js?v=21";

let root, state = { tab: "docs", doc_type: "", store_id: "", status: "", q: "", date_from: "", date_to: "", page: 1 };
let table, pager;

// Числа строк: в поле — текст, как его набрал человек («12,5»), в расчётах — число; пусто и мусор — 0.
const num0 = (v) => { const x = parseNum(v); return x === null || Number.isNaN(x) ? 0 : x; };
const r2 = (x) => Math.round(x * 100) / 100;
const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
const rows_ = (n) => `${n} ${plural(n, "строка", "строки", "строк")}`;
// Список названий в сообщении — как в ответах сервера: до трёх, дальше «и ещё N».
const listNames = (a) => a.slice(0, 3).join(", ") + (a.length > 3 ? ` и ещё ${a.length - 3}` : "");
const storeName = (id) => (stores.find((s) => s.id === id) || {}).name || "";
// Цена на экране — с копейками, но не короче записанной: цена из «сумма / кол-во» бывает с 4 знаками.
const priceTxt = (v) => (v === null || v === undefined || v === "" ? "" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
// Пометка инвентаризации «ввод начальных остатков» (0045): у списания reason — причина, у инвентаризации — только она.
const OPENING = "opening";
const reasonOf = (d) => d.doc_type === "writeoff" && d.reason ? REASONS[d.reason] || d.reason
  : d.doc_type === "inventory" && d.reason === OPENING ? "ввод остатков" : "";

export async function mount(r) {
  root = r; state.page = 1;
  setStores((await api("stores_list", {})).stores || []);
  resetReports();
  const me = await api("me", {});
  setMyIds((me.ok && me.user && me.user.store_ids) || []);
  if (!tabOk(state.tab)) state.tab = "docs";
  drawShell();
  // Вкладка помнится между заходами в раздел: грузим её, а не журнал документов (раньше при
  // возврате в «Склад» на вкладке «Остатки» или «Заявки» она оставалась пустой).
  await LOADERS[state.tab]();
}
const LOADERS = { docs: loadDocs, bal: loadBalances, sales: loadSales, turn: loadTurnover, ord: loadOrders, c1: loadC1, rep: loadReports, ready: loadReady };
// Вкладки, которые видны не всем ролям: открыть такую через setTab без права нельзя — откроется журнал.
const TAB_OK = { sales: canSales, c1: canSales, rep: canSales, ord: () => perms().includes("doc:transfer:view") };
const tabOk = (t) => !!LOADERS[t] && (!TAB_OK[t] || TAB_OK[t]());

// Открыть «Склад» сразу на вкладке (стартовый экран собственника — «Отчёты»). До mount — только запоминаем:
// mount сам откроет эту вкладку. После — перерисовываем, но только если в root по-прежнему наш раздел:
// app.js отдаёт один и тот же <main> всем разделам.
export function setTab(tab) {
  if (!LOADERS[tab]) return;
  state.tab = tab;
  if (root && root.querySelector(":scope > .tabs[data-stock]")) {
    if (!tabOk(state.tab)) state.tab = "docs";
    drawShell(); LOADERS[state.tab]();
  }
}

// После проведения, отмены или удаления документа обновляется открытая вкладка. Документ плана
// заявок (source_kind='orders') ставит или снимает строки «готовым со склада» и может оставить
// помеченные к пересчёту продажи — их добирает тот же цикл, что и после ручной правки.
hooks.editDoc = (id, newType) => editDoc(id, newType);
// Переход в журнал извне: поиск и, если передан o, фильтр ровно из него — тип, склад, период (щелчок
// по поставщику в «Закупках» приводит в приходы того же склада за тот же период, buh 4); чего в o нет —
// пусто, статус «все». Без o прежние фильтры журнала остаются, меняется только поиск. Раздел «Склад»
// не на экране — только запоминаем, как setTab: mount откроет журнал с этим фильтром.
hooks.openDocs = (q, o) => {
  state.tab = "docs"; state.q = q || ""; state.page = 1;
  if (o) Object.assign(state, { doc_type: o.doc_type || "", store_id: o.store_id || "", status: o.status || "",
    date_from: o.date_from || "", date_to: o.date_to || "" });
  if (root && root.querySelector(":scope > .tabs[data-stock]")) { drawShell(); loadDocs(); }
};
// r — ответ doc_post/doc_unpost. С 0045 «готовым» ставит и ручное перемещение на склад точки: сервер
// сразу пересобирает до 5 продаж и говорит, сколько осталось (resynced/remaining — в ответе или в его
// поле ready); остаток добирает srResync. Старый сервер про ручные документы молчит — тогда как раньше:
// тихая проверка только после документа плана.
function afterDocChange(d, r) {
  // Документ могли открыть и не из раздела «Склад» (ссылка на приход в карточке позиции): тогда
  // журнала на экране нет и перерисовывать нечего — иначе loadDocs падал на пустой таблице.
  if (root && root.isConnected) (LOADERS[state.tab] || loadDocs)();
  if (!perms().includes("stock:edit")) return;
  const rd = (r && (r.ready && typeof r.ready === "object" ? r.ready : r)) || {};
  const left = Number(rd.remaining) || 0;
  if (left > 0) srResync({ done: Number(rd.resynced) || 0, left });
  else if (d && d.source_kind === "orders" && !("remaining" in rd)) srResync({ quiet: true });
}
// Что сказать после проведения (r — ответ doc_post), одним окном, а не стопкой:
//  * later_moves (0045, sklad 2): документ проведён задним числом внутри уже прожитого — после него на
//    этом складе по его позициям уже проведены расходы (N); их себестоимость программа не пересчитывает,
//    и человек должен это знать (исправленный приход: перемещения остались по прежней цене);
//  * ready_new (0045): позиции, которые документ впервые сделал «готовыми» на складе точки — продажа там
//    теперь списывает саму выпечку, а не ингредиенты.
// Старый сервер этих полей не отдаёт — окна нет.
function postNotes(r, type) {
  const later = Number(r && r.later_moves) || 0;
  const list = r && Array.isArray(r.ready_new) ? r.ready_new : [];
  if (later <= 0 && !list.length) return;
  const cm = modal(later > 0 ? "Документ проведён" : "Продаются готовыми");
  if (later > 0) cm.root.append(el("div", { class: "warnbox" },
    `После этого документа уже были расходы (${later}): их себестоимость посчитана по прежней цене.`,
    type === "invoice_in" ? el("div", { style: "margin-top:4px" }, "Средняя цена склада уже новая — по ней спишутся следующие расходы.") : null));
  if (list.length) {
    const by = new Map();
    for (const x of list) { const k = x.store_name || ""; if (!by.has(k)) by.set(k, []); by.get(k).push(x.item_name || x.item_code || ""); }
    for (const [st, items] of by) cm.root.append(el("div", { style: "margin:8px 0" }, `Теперь на складе «${st}» продаются готовыми: ${items.join(", ")}.`));
    cm.root.append(el("div", { class: "dim" }, "Продажа этих позиций на складе списывает саму позицию, привезённую с кухни, а не муку и начинку по техкарте. "
      + "Список — «Склад» → «Заявки», блок «Что склады получают готовым»; там же строку можно убрать."));
  }
  cm.root.append(el("div", { class: "actions" }, el("button", { onclick: cm.close }, "Понятно")));
}

function drawShell() {
  root.innerHTML = "";
  const tab = (id, title) => el("button", { class: state.tab === id ? "" : "ghost", onclick: () => setTab(id) }, title);
  root.append(el("div", { class: "tabs", "data-stock": "" },
    tab("docs", "Документы"), tab("bal", "Остатки"),
    canSales() ? tab("sales", "Продажи") : null,
    tab("turn", "Ведомость"),
    tabOk("ord") ? tab("ord", "Заявки") : null,
    canSales() ? tab("c1", "Расход для 1С") : null,
    canSales() ? tab("rep", "Отчёты") : null,
    tab("ready", "Готовность")));
  if (state.tab !== "docs") { root.append(el("div", { id: state.tab + "-root" })); return; }
  // Роли без единого doc:*:edit (пока таких нет, но право снимается настройкой) видят
  // журнал и остатки, но пустого выпадающего списка «+ Новый документ…» им не показываем.
  const newBtn = canAnyDoc()
    ? el("select", { onchange: (e) => { if (e.target.value) { editDoc(null, e.target.value); e.target.value = ""; } } },
        el("option", { value: "" }, "+ Новый документ…"),
        ...MANUAL.filter(canDoc).map((k) => el("option", { value: k }, TYPES[k])))
    : null;
  table = el("table"); pager = el("div", { class: "pager" });
  // Быстрый период подсвечивается, пока даты совпадают с ним. Поля дат при этом не пересоздаются:
  // пересозданное поле теряло бы фокус посреди набора года.
  const P = periods();
  const pBtns = Object.entries(P).map(([k, [a, b, t]]) => el("button", { "data-p": k, onclick: () => setPeriod(a, b) }, t));
  const markPeriod = () => { for (const b of pBtns) { const [a, z] = P[b.dataset.p]; b.className = "small" + (a === state.date_from && z === state.date_to ? "" : " ghost"); } };
  const dateIn = (key, title) => el("input", { type: "date", title, value: state[key], style: "flex:0 1 160px",
    onchange: debounce((e) => { state[key] = e.target.value; state.page = 1; markPeriod(); loadDocs(); }, 400) });
  const dFrom = dateIn("date_from", "с"), dTo = dateIn("date_to", "по");
  function setPeriod(from, to) { state.date_from = from; state.date_to = to; state.page = 1; dFrom.value = from; dTo.value = to; markPeriod(); loadDocs(); }
  markPeriod();
  // Склады фильтра — только свои, как в «Остатках» (admin 8, owner У8): сервер и так отдаёт лишь
  // документы складов пользователя, и выбор чужого склада давал пустой журнал. Склад, пришедший
  // извне (openDocs из отчёта), остаётся в списке и выключенным — иначе фильтр стоял бы невидимым;
  // склада, которого нет в справочнике вовсе, фильтр не держит.
  if (state.store_id && !stores.some((s) => s.id === state.store_id)) state.store_id = "";
  const jStores = mine(active());
  if (state.store_id && !jStores.some((s) => s.id === state.store_id)) jStores.push(stores.find((s) => s.id === state.store_id));
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Номер, № накладной, поставщик, комментарий", value: state.q, style: "flex:2 1 340px;min-width:340px",
        oninput: debounce((e) => { state.q = e.target.value; state.page = 1; loadDocs(); }, 300) }),
      sel({ "": "все типы", ...TYPES }, state.doc_type, (v) => { state.doc_type = v; state.page = 1; loadDocs(); }),
      sel({ "": myIds.length ? "мои склады" : "все склады", ...opts(jStores) }, state.store_id, (v) => { state.store_id = v; state.page = 1; loadDocs(); }),
      sel({ "": "все", draft: "черновики", posted: "проведённые" }, state.status, (v) => { state.status = v; state.page = 1; loadDocs(); }),
      newBtn),
    el("div", { class: "tools" },
      dFrom, el("span", { class: "dim" }, "—"), dTo, ...pBtns,
      el("span", { style: "flex:1" }),
      el("button", { class: "ghost small", title: "Журнал по текущему фильтру, все страницы — для Excel", onclick: (e) => docsCsv(e.currentTarget) }, "CSV")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}
// Быстрые периоды журнала, как в iiko: [с, по, подпись]. Даты — по часам пользователя (isoDate).
function periods() {
  const d = new Date(), y = d.getFullYear(), mo = d.getMonth(), t = today();
  const yst = isoDate(new Date(y, mo, d.getDate() - 1, 12));
  return { today: [t, t, "Сегодня"], yesterday: [yst, yst, "Вчера"], month: [isoDate(new Date(y, mo, 1, 12)), t, "Этот месяц"],
    prev: [isoDate(new Date(y, mo - 1, 1, 12)), isoDate(new Date(y, mo, 0, 12)), "Прошлый месяц"], all: ["", "", "Все даты"] };
}
const docFilter = () => ({ doc_type: state.doc_type || null, store_id: state.store_id || null, status: state.status || null, q: state.q,
  date_from: state.date_from || null, date_to: state.date_to || null });
const docWho = (d) => d.doc_type === "invoice_in" ? `${d.counteragent_name || ""} → ${d.store_to_name || ""}`
  : d.doc_type === "transfer" ? `${d.store_from_name || ""} → ${d.store_to_name || ""}`
  : d.doc_type === "sale" ? `${d.store_from_name || ""} · ${d.comment || ""}` : (d.store_from_name || "");
// Подсказка строки журнала: кто завёл, кто и когда провёл (posted_by_name — с 0045; без него — только время).
function docTip(d) {
  const t = [];
  if (d.created_by_name) t.push("Создал: " + d.created_by_name);
  if (d.status === "posted") t.push((d.posted_by_name ? "Провёл: " + d.posted_by_name + (d.posted_at ? ", " : "") : "Проведён ") + (d.posted_at ? fmtDateTime(d.posted_at) : ""));
  if (d.doc_type === "invoice_in" && (d.ext_number || d.ext_date)) t.push("Накладная поставщика" + (d.ext_number ? " № " + d.ext_number : "") + (d.ext_date ? " от " + fmtDate(d.ext_date) : ""));
  if (d.comment && d.doc_type !== "sale") t.push("Комментарий: " + d.comment);
  return t.join("\n");
}

async function loadDocs() {
  const n = nextSeq("docs");
  const r = await api("docs_list", { ...docFilter(), page: state.page });
  if (n !== seqs.docs) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Номер", "Тип", "Дата", "№ вх.", "Склады / поставщик", "Сумма", "Автор", "Статус"].map((h, i) => el("th", { class: i === 5 ? "num" : "" }, h))));
  for (const d of r.rows) {
    const why = reasonOf(d);
    table.append(el("tr", { class: "row", title: docTip(d), onclick: () => editDoc(d.id) },
      el("td", { style: "white-space:nowrap" }, d.number), el("td", {}, TYPES[d.doc_type] || d.doc_type, why ? el("span", { class: "dim" }, " · " + why) : null),
      el("td", { style: "white-space:nowrap" }, fmtDate(d.doc_date)),
      el("td", {}, d.doc_type === "invoice_in" ? d.ext_number || "" : ""), el("td", {}, docWho(d)),
      el("td", { class: "num" }, d.total_sum != null ? fmtMoney(d.total_sum) : ""),
      el("td", { class: "dim" }, d.created_by_name || ""),
      el("td", {}, el("span", { class: "badge " + d.status }, d.status === "posted" ? "проведён" : "черновик"))));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 8, class: "dim" }, "Документов нет")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; loadDocs(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; loadDocs(); } }, "→"));
}

// CSV для Excel: «;», BOM, числа с запятой. Скачивается без всплывающего окна.
function csvFile(name, rows) {
  const q = (v) => { const s = String(v ?? ""); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(q).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvNum = (v) => (v === null || v === undefined || v === "" ? "" : String(r2(Number(v))).replace(".", ","));
// Журнал по текущему фильтру — все страницы (сервер отдаёт по 200), а не только видимая.
async function docsCsv(btn) {
  btn.disabled = true;
  const all = [];
  try {
    let page = 1, pages = 1;
    do {
      const r = await api("docs_list", { ...docFilter(), page });
      if (!r.ok) { toast(errText(r), "bad"); return; }
      all.push(...(r.rows || [])); pages = r.pages || 1; page++;
    } while (page <= pages);
  } finally { btn.disabled = false; }
  const head = ["Номер", "Тип", "Дата", "№ накладной поставщика", "Дата накладной", "Откуда", "Куда", "Поставщик", "Причина / пометка", "Сумма", "Статус", "Создал", "Провёл", "Проведён", "Комментарий"];
  csvFile(`журнал документов${state.date_from || state.date_to ? ` ${state.date_from || "…"}—${state.date_to || "…"}` : ""}.csv`,
    [head, ...all.map((d) => [d.number, TYPES[d.doc_type] || d.doc_type, fmtDate(d.doc_date), d.ext_number || "", fmtDate(d.ext_date),
      d.store_from_name || "", d.store_to_name || "", d.counteragent_name || "", reasonOf(d), csvNum(d.total_sum),
      d.status === "posted" ? "проведён" : "черновик", d.created_by_name || "", d.posted_by_name || "", d.posted_at ? fmtDateTime(d.posted_at) : "", d.comment || ""])]);
}

// ---------- форма документа ----------
// preset — новый документ «как этот» (кнопка «Копировать»): склады, поставщик, причина и строки.
async function editDoc(id, newType, preset) {
  let doc = { doc_type: newType, doc_date: today(), status: "draft", lines: [], consume: [] };
  if (id) { const r = await api("doc_get", { id }); if (!r.ok) { toast(errText(r), "bad"); return; } doc = r.doc; }
  else if (preset) doc = { ...doc, ...preset };
  const type = doc.doc_type, posted = doc.status === "posted";
  const isSale = type === "sale", isInv = type === "inventory", isIn = type === "invoice_in", isProd = type === "production";
  const ro = posted || !canDoc(type) || isSale;
  // Форма с вводом по фону не закрывается; «Отмена» при изменениях переспрашивает (cancelForm ниже).
  const m = modal(`${TYPES[type]} ${doc.number || (doc.copy_of ? "— копия " + doc.copy_of : "")}`, { keep: !ro }); m.root.style.maxWidth = "1040px";
  const setTitle = () => { const h = m.root.querySelector("h1"); if (h) h.textContent = `${TYPES[type]} ${doc.number || ""}`; };
  // В новом документе выбирать можно только действующие склады; в уже заведённом
  // список полный, иначе выключенный позже склад пропал бы из карточки вместе с именем.
  // «Свой» склад документа (приход — получатель, прочие — источник) — только из закреплённых;
  // куда перемещать — любой действующий.
  const storeOpts = { "": "— склад —", ...opts(doc.id ? stores : active()) };
  const ownOpts = { "": "— склад —", ...opts(doc.id ? stores : mine(active())) };
  // Единственный свой склад подставляется в новый документ сам (owner У8): у прихода — получатель,
  // у прочих — источник. Склад, уже заданный копией, не заменяется.
  const ownOnly = doc.id ? [] : mine(active());
  if (ownOnly.length === 1) { if (isIn) doc.store_to = doc.store_to || ownOnly[0].id; else doc.store_from = doc.store_from || ownOnly[0].id; }
  const f = {
    date: el("input", { type: "date", value: doc.doc_date, readonly: ro }),
    from: sel(ownOpts, doc.store_from || "", () => { if (isInv) checkFirstInventory(); }, ro),
    to: sel(isIn ? ownOpts : storeOpts, doc.store_to || "", () => {}, ro),
    reason: sel({ "": "— причина —", ...REASONS }, type === "writeoff" ? doc.reason || "" : "", () => {}, ro),
    comment: el("input", { value: doc.comment || "", readonly: ro }),
    caId: doc.counteragent_id || null,
    ca: el("input", { placeholder: "поставщик: начните вводить", value: doc.counteragent_name || "", readonly: ro, autocomplete: "off" }),
    // Реквизиты бумажной накладной поставщика — только у прихода (сервер их и принимает только там).
    ext: el("input", { placeholder: "как в накладной", value: doc.ext_number || "", readonly: ro }),
    extd: el("input", { type: "date", value: doc.ext_date || "", readonly: ro }),
  };

  // ----- поставщик: выбор из списка или новый прямо из накладной -----
  // Название в поле без выбора из списка — не поставщик: сервер ответил бы «Приходу нужны склад и
  // поставщик», хотя поле выглядит заполненным. Поэтому id сбрасывается на первом же символе, а
  // нет совпадений — тут же можно завести нового (право counteragents:edit есть у бухгалтера).
  const caRes = el("div", { class: "sres" });
  let caRows = [], caHl = -1, caSeq = 0;
  function caDraw(q) {
    caRes.innerHTML = "";
    caRows.forEach((c, i) => caRes.append(el("button", { type: "button", class: "sitem" + (i === caHl ? " hl" : ""), tabindex: "-1",
      onmousedown: (e) => e.preventDefault(), onclick: () => caPick(c) }, c.name, c.bin ? el("span", { class: "dim" }, "  БИН " + c.bin) : null)));
    if (!caRows.length && q) {
      if (can("counteragents", "edit")) caRes.append(el("button", { type: "button", class: "sitem", tabindex: "-1", style: "color:var(--accent2)",
        onmousedown: (e) => e.preventDefault(), onclick: () => newSupplier(q) }, `+ Завести поставщика «${q}»`));
      else caRes.append(el("div", { class: "dim", style: "padding:9px 12px" }, "Такого поставщика нет. Нового заводит бухгалтер или администратор в разделе «Контрагенты»."));
    }
  }
  const NO_CA = "Поставщик не выбран из списка — выберите или заведите нового";
  function caPick(c) {
    f.caId = c.id; f.ca.value = c.name; caRows = []; caHl = -1; caRes.innerHTML = ""; m.dirty = true;
    if (err.textContent === NO_CA) err.textContent = "";
    if (isIn && !ro) checkDup();   // № накладной уже вписан — проверяем его у нового поставщика
  }
  // Поставщика переписывают — предупреждение о дубле было про прежнего: снимаем до нового выбора.
  f.ca.addEventListener("input", () => { f.caId = null; if (isIn && !ro) checkDup(); });
  f.ca.addEventListener("input", debounce(async () => {
    const q = f.ca.value.trim(); const n = ++caSeq;
    if (q.length < 2) { caRows = []; caDraw(""); return; }
    const s = await api("counteragents_list", { q, kind: "supplier", active: true });
    if (n !== caSeq) return;
    caRows = (s.rows || []).slice(0, 10); caHl = caRows.length ? 0 : -1; caDraw(q);
  }, 300));
  f.ca.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && caRows.length) { e.preventDefault(); caHl = (caHl + 1) % caRows.length; caDraw(f.ca.value.trim()); }
    else if (e.key === "ArrowUp" && caRows.length) { e.preventDefault(); caHl = (caHl - 1 + caRows.length) % caRows.length; caDraw(f.ca.value.trim()); }
    else if (e.key === "Enter" && caRows.length) { e.preventDefault(); caPick(caRows[Math.max(caHl, 0)]); f.ext.focus(); }
    else if (e.key === "Escape" && caRes.firstChild) { e.preventDefault(); caRows = []; caRes.innerHTML = ""; }
  });
  function newSupplier(q) {
    const cm = modal("Новый поставщик", { keep: true });
    const name = el("input", { value: q }), bin = el("input", { inputmode: "numeric", placeholder: "12 цифр, можно не заполнять" });
    const e2 = el("div", { class: "err" }), go = el("button", {}, "Завести");
    go.onclick = async () => {
      e2.textContent = "";
      const nm = name.value.trim(), b = bin.value.replace(/\s/g, "");
      if (!nm) { e2.textContent = "Впишите название"; return; }
      if (b && !/^\d{12}$/.test(b)) { e2.textContent = "БИН/ИИН — 12 цифр"; return; }
      go.disabled = true;   // второе нажатие до ответа завело бы двух одинаковых поставщиков
      const r = await api("counteragent_save", { name: nm, kind: "supplier", bin: b, active: true });
      if (!r.ok) { saveFailed(r, true, go, e2); return; }
      cm.close(); caPick({ id: r.id, name: nm }); toast("Поставщик заведён: " + nm); f.ext.focus();
    };
    for (const x of [name, bin]) x.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
    cm.root.append(el("div", { class: "dim" }, "Остальное (телефон, заметку) можно дописать потом в разделе «Контрагенты»."),
      el("label", {}, "Название"), name, el("label", {}, "БИН/ИИН"), bin, e2,
      el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: cm.close }, "Отмена")));
    setTimeout(() => name.focus(), 0);
  }

  // ----- пометка «ввод начальных остатков» у инвентаризации (день X) -----
  // Первые остатки склада — не излишек: в прибыль они не входят (0046). У черновика флажок уходит
  // с сохранением, у проведённой меняется сразу отдельным действием: движения от него не меняются.
  let opening = null;
  const openHint = el("div", { class: "warnbox", hidden: true });
  if (isInv) {
    opening = el("input", { type: "checkbox", checked: doc.reason === OPENING, disabled: !canDoc("inventory") });
    opening.addEventListener("change", async () => {
      if (!posted) { checkFirstInventory(); return; }
      const want = opening.checked; opening.disabled = true; err.textContent = "";
      const r = await api("doc_set_opening", { id: doc.id, opening: want });
      opening.disabled = false;
      if (!r.ok) { opening.checked = !want; err.textContent = errText(r); return; }
      doc.reason = want ? OPENING : null; saved = true;
      toast(want ? "Отмечено: ввод начальных остатков — в прибыль не входит" : "Пометка «ввод остатков» снята");
    });
  }
  // У склада ещё нет ни одной проведённой инвентаризации — скорее всего, это и есть день X.
  async function checkFirstInventory() {
    openHint.hidden = true;
    if (!isInv || posted || !opening || opening.checked || opening.disabled) return;
    const st = f.from.value; if (!st) return;
    const r = await api("docs_list", { doc_type: "inventory", store_id: st, status: "posted", page: 1 });
    if (!r.ok || f.from.value !== st || opening.checked || Number(r.total) > 0) return;
    openHint.textContent = `У склада «${storeName(st)}» ещё нет ни одной проведённой инвентаризации. Если это первые остатки (день X) — `
      + "поставьте флажок «Ввод начальных остатков»: тогда они не попадут в прибыль как излишек.";
    openHint.hidden = false;
  }

  const head = el("div", { class: "grid2" }, el("div", {}, el("label", {}, "Дата"), f.date));
  if (isIn) head.append(el("div", {}, el("label", {}, "Склад-получатель"), f.to), el("div", { class: "sbox" }, el("label", {}, "Поставщик"), f.ca, caRes),
    el("div", {}, el("label", {}, "№ накладной поставщика"), f.ext), el("div", {}, el("label", {}, "Дата накладной"), f.extd));
  if (type === "transfer") head.append(el("div", {}, el("label", {}, "Откуда"), f.from), el("div", {}, el("label", {}, "Куда"), f.to));
  if (type === "writeoff") head.append(el("div", {}, el("label", {}, "Склад"), f.from), el("div", {}, el("label", {}, "Причина"), f.reason));
  if (isProd) head.append(el("div", {}, el("label", {}, "Склад кухни (расход и выпуск)"), f.from));
  if (isInv) head.append(el("div", {}, el("label", {}, "Склад"), f.from));
  if (isSale) head.append(el("div", {}, el("label", {}, "Склад точки"), f.from));
  head.append(el("div", {}, el("label", {}, isSale ? "Источник" : "Комментарий"), f.comment));
  if (isInv) head.append(el("div", { style: "grid-column:1/-1" },
    el("label", { style: "margin-top:12px" }, opening, "Ввод начальных остатков (день X) — не входит в прибыль")));
  m.root.append(head);
  // Кто завёл и кто провёл (имена — с 0045; старый сервер отдаёт только время проведения).
  const who = [doc.created_by_name ? "Создал " + doc.created_by_name : null,
    posted ? (doc.posted_by_name ? "Провёл " + doc.posted_by_name + " " : "Проведён ") + (doc.posted_at ? fmtDateTime(doc.posted_at) : "") : null].filter(Boolean);
  if (who.length) m.root.append(el("div", { class: "dim", style: "margin-top:8px" }, who.join(" · ")));
  if (isSale) m.root.append(el("div", { class: "dim", style: "margin-top:6px" },
    "Документ ведёт отчёт точки: он меняется, когда точка правит отчёт. Руками его не правят: если отчёт правили, во вкладке «Продажи» есть «Провести продажи за период»."));
  if (doc.sync_note) m.root.append(el("div", { class: "warnbox", style: "margin-top:8px" }, doc.sync_note));
  // Дубль накладной (0045, dup_of в ответе doc_save): сохраняется, но человек видит, что такая уже есть.
  const dupBox = el("div", { class: "warnbox", hidden: true });
  const dupText = (d) => `У поставщика уже есть накладная № ${f.ext.value.trim()} — ${d.number} от ${fmtDate(d.doc_date)} (${d.status === "posted" ? "проведена" : "черновик"})`;
  function showDup(d) {
    dupBox.innerHTML = ""; dupBox.hidden = !d; if (!d) return;
    dupBox.append(`У поставщика уже есть накладная № ${f.ext.value.trim()} — `,
      el("a", { href: "#", class: "link", style: "padding:0", onclick: (e) => { e.preventDefault(); editDoc(d.id); } }, `${d.number} от ${fmtDate(d.doc_date)}`),
      ` (${d.status === "posted" ? "проведена" : "черновик"}). Проверьте, не внесена ли она второй раз.`);
  }
  // То же предупреждение — до сохранения, как только курсор ушёл из «№ накладной поставщика» (buh 3):
  // раньше дубль всплывал только в ответе doc_save, когда черновик с номером ПН уже записан. Ищем
  // журналом (он ищет и по № накладной) приход того же поставщика с тем же номером — без регистра и
  // крайних пробелов, как сверяет сервер, — кроме этого документа; первым — проведённый, затем ранний.
  // Журнал отдаёт только документы складов пользователя; что он не увидит, покажет ответ сохранения.
  let dupSeq = 0;
  async function checkDup() {
    const no = f.ext.value.trim(), ca = f.caId, n = ++dupSeq;
    if (!no || !ca) { showDup(null); return; }
    const hits = [];
    for (let page = 1, pages = 1; page <= Math.min(pages, 5); page++) {
      const r = await api("docs_list", { doc_type: "invoice_in", q: no, page });
      if (n !== dupSeq) return;   // номер или поставщика уже поменяли — ответ устарел
      if (!r.ok) return;
      hits.push(...(r.rows || []).filter((d) => d.id !== doc.id && d.counteragent_id === ca
        && String(d.ext_number || "").trim().toLowerCase() === no.toLowerCase()));
      pages = r.pages || 1;
    }
    hits.sort((a, b) => (b.status === "posted") - (a.status === "posted") || String(a.doc_date).localeCompare(String(b.doc_date))
      || String(a.number).localeCompare(String(b.number)));
    showDup(hits[0] || null);
  }
  if (isIn && !ro) {
    f.ext.addEventListener("change", checkDup);
    if (doc.id && doc.ext_number) checkDup();   // открыли черновик с номером — дубль виден сразу
  }
  m.root.append(dupBox, openHint);

  // ----- строки -----
  const lines = doc.lines.map((l) => ({ ...l }));
  const tbl = el("table"); const tot = el("div", { class: "tot" });
  let picker = null;
  const focusSearch = () => { if (picker) picker.focus(); };
  // Enter в строке: следующее поле этой строки, с последнего — в поиск следующей позиции (накладную
  // набирают так: позиция → кол-во → цена → сумма → следующая позиция). У инвентаризации строки уже
  // стоят списком (с остатком, из файла), и пересчёт идёт сверху вниз — там Enter ведёт вниз по той же
  // колонке, с последней строки — в поиск.
  const downCol = (key) => (e) => {
    const all = [...tbl.querySelectorAll(`input[data-key="${key}"]`)].filter((x) => !x.readOnly);
    const i = all.indexOf(e.target);
    if (i >= 0 && i < all.length - 1) all[i + 1].focus(); else focusSearch();
  };
  const qkey = isInv ? "fact_qty" : "qty";
  const lineSum = (l) => r2(num0(l[qkey]) * num0(l.price));
  const docSum = () => r2(lines.reduce((a, l) => a + lineSum(l), 0));
  // Цена из суммы строки (накладная, где по строке только сумма): до 4 знаков; если при большом
  // количестве кол-во × цена с 4 знаками не даёт ту же сумму до тиына — до 6: итог должен сойтись с бумагой.
  const priceOf = (s, q) => { const p4 = Math.round(s / q * 1e4) / 1e4; return Math.abs(r2(q * p4) - s) < 0.005 ? p4 : Math.round(s / q * 1e6) / 1e6; };
  let liveCells = [];   // ячейки «Сумма» у инвентаризации: пересчитываются при вводе без перерисовки таблицы
  let paper = null, paperNote = null;
  // Ввод в строке меняет только свои ячейки и итог; полная перерисовка — при добавлении и удалении строк
  // (на каждый символ поле пересоздавалось бы, и каретка прыгала). Фокус после перерисовки возвращается.
  let drawn = false;
  function drawLines() {
    if (drawn) m.dirty = true; drawn = true;
    const ae = document.activeElement;
    const keep = ae && tbl.contains(ae) && ae.dataset && ae.dataset.li != null ? { li: ae.dataset.li, key: ae.dataset.key } : null;
    tbl.innerHTML = ""; liveCells = [];
    const cols = ["№", "Позиция", "Ед.", isInv ? "Факт" : "Кол-во"];
    if (isInv && posted) cols.push("Расчёт", "Разница");
    if (isIn || isInv) cols.push("Цена", isInv && posted ? "Сумма разницы" : "Сумма");
    else if (posted) cols.push(isSale ? "Цена продажи" : "Себест.", isSale ? "Выручка" : "Сумма");
    if (!ro) cols.push("");
    tbl.append(el("tr", {}, ...cols.map((h, i) => el("th", { class: i >= 3 && h ? "num" : "", style: i === 0 ? "width:34px" : null,
      title: isInv && h === "Цена" ? "Цена излишка: по ней оценится найденное сверх расчёта. Пусто — по средней цене склада" : null }, h))));
    lines.forEach((l, idx) => {
      const tr = el("tr", {});
      const rowNav = enterNext(tr, focusSearch);
      const inp = (key, o = {}) => numInput({ value: l[key], width: o.width || "110px",
        attrs: { "data-li": String(idx), "data-key": key, "data-nav": "" },
        onInput: (t) => { l[key] = t; if (o.onInput) o.onInput(t); refreshSums(); },
        onEnter: isInv ? downCol(key) : rowNav });
      const tds = [el("td", { class: "dim" }, String(idx + 1)),
        el("td", {}, l.name, isInv && !posted && l.current_qty != null ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, "расчёт: " + fmt(l.current_qty)) : null),
        el("td", {}, l.unit_id || "")];
      if (ro) {
        tds.push(el("td", { class: "num" }, fmt(l[qkey])));
        if (isInv && posted) {
          const diff = num0(l.fact_qty ?? l.qty) - num0(l.calc_qty);
          tds.push(el("td", { class: "num" }, fmt(l.calc_qty)), el("td", { class: "num" + (diff < 0 ? " bad" : "") }, fmt(diff)),
            el("td", { class: "num" }, priceTxt(l.price)), el("td", { class: "num" }, fmtMoney(l.sum)));
        } else if (isIn || isInv) tds.push(el("td", { class: "num" }, priceTxt(l.price)), el("td", { class: "num" }, fmtMoney(posted && l.sum != null ? l.sum : lineSum(l) || null)));
        else if (posted) tds.push(el("td", { class: "num" }, priceTxt(l.price)), el("td", { class: "num" }, fmtMoney(l.sum)));
      } else if (isIn) {
        // Приход: кол-во, цена и сумма связаны. Сумма введена — цена = сумма / кол-во; меняют кол-во или
        // цену — сумма пересчитывается по цене. Кол-во ещё пустое, а сумма уже есть — цена появится с ним.
        if (l._sum === undefined) l._sum = lineSum(l) || "";
        let note = l._last !== undefined && l._last !== null
          ? el("div", { class: "dim", style: "font-size:11px;white-space:nowrap" }, "как в прошлом приходе" + (l._last ? " от " + fmtDate(l._last).slice(0, 5) : "")) : null;
        const dropNote = () => { l._last = null; if (note) { note.remove(); note = null; } };
        let pIn = null, sIn = null;
        const qIn = inp("qty", { onInput: (t) => {
          const q = num0(t);
          if (!(num0(l.price) > 0) && num0(l._sum) > 0 && q > 0) { l.price = priceOf(num0(l._sum), q); pIn.value = numStr(l.price); }
          else { l._sum = lineSum(l) || ""; sIn.value = numStr(l._sum); }
        } });
        pIn = inp("price", { onInput: () => { dropNote(); l._sum = lineSum(l) || ""; sIn.value = numStr(l._sum); } });
        sIn = inp("_sum", { width: "130px", onInput: (t) => {
          const s = parseNum(t), q = num0(l.qty);
          if (q > 0 && s !== null && !Number.isNaN(s)) { l.price = priceOf(s, q); pIn.value = numStr(l.price); dropNote(); }
        } });
        sIn.title = "Можно ввести сумму строки — цена посчитается сама";
        tds.push(el("td", { class: "num" }, qIn), el("td", { class: "num" }, pIn, note), el("td", { class: "num" }, sIn));
      } else if (isInv) {
        const sc = el("td", { class: "num" }); liveCells.push({ l, td: sc });
        tds.push(el("td", { class: "num" }, inp("fact_qty")), el("td", { class: "num" }, inp("price")), sc);
      } else tds.push(el("td", { class: "num" }, inp("qty")));
      // «×» — не в порядке Tab: Tab с цены попадал на «×», и Enter удалял строку без вопроса.
      if (!ro) tds.push(el("td", {}, el("button", { class: "x", tabindex: "-1", title: "Убрать строку", onclick: () => { lines.splice(idx, 1); drawLines(); } }, "×")));
      tr.append(...tds);
      tbl.append(tr);
    });
    refreshSums();
    if (keep) { const n = tbl.querySelector(`input[data-li="${keep.li}"][data-key="${keep.key}"]`); if (n) n.focus(); }
  }
  function refreshSums() {
    for (const c of liveCells) { const v = lineSum(c.l); c.td.textContent = v ? fmtMoney(v) : ""; }
    const n = lines.length, sum = docSum();
    tot.innerHTML = "";
    if (posted) tot.append(el("span", {}, (isSale ? "Себестоимость проданного" : isInv ? "Итог разницы (излишки − недостача)" : "Сумма документа") + " · " + rows_(n)),
      el("span", {}, fmtMoney(doc.total_sum || 0) + " ₸"));
    else if (isIn) tot.append(el("span", {}, "Сумма · " + rows_(n)), el("span", {}, fmtMoney(sum) + " ₸"));
    else if (isInv) {
      const withFact = lines.filter((l) => l.fact_qty !== "" && l.fact_qty !== null && l.fact_qty !== undefined).length;
      tot.append(el("span", {}, `Строк ${n} · с фактом ${withFact}`), el("span", {}, sum ? "оценка по ценам " + fmtMoney(sum) + " ₸" : ""));
    } else tot.append(el("span", {}, "Строк"), el("span", {}, String(n)));
    if (paperNote) {
      // «Итого по накладной (на бумаге)» — живая сверка с суммой строк; поле не сохраняется.
      paperNote.innerHTML = "";
      const p = parseNum(paper.value);
      if (p !== null && !Number.isNaN(p)) {
        const d = r2(p - sum);
        paperNote.append(Math.abs(d) < 0.005 ? el("span", { class: "tag ok" }, "сходится")
          : el("span", { class: "tag bad", title: d > 0 ? "В документе меньше, чем на бумаге" : "В документе больше, чем на бумаге" }, `расходится на ${fmtMoney(Math.abs(d))} ₸`));
      }
    }
  }
  if (isIn && !ro) {
    paper = numInput({ placeholder: "как на бумаге", width: "160px", attrs: { "data-nodirty": "" }, onInput: () => refreshSums() });
    paperNote = el("span", {});
  }
  drawLines();
  // Итог загрузки из файла живёт под таблицей: сверка, предупреждения и список ненайденных строк.
  const warn = el("div", { hidden: true });
  // append() пишет пустое значение текстом «null» — необязательное добавляется отдельно.
  m.root.append(el("h2", { style: "margin-top:14px" }, isInv ? "Позиции и факт" : (isProd ? "Выпуск" : isSale ? "Продано по отчёту" : "Строки")), tbl, tot);
  if (paper) m.root.append(el("div", { style: "display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:8px;flex-wrap:wrap" },
    el("span", { class: "dim" }, "Итого по накладной (на бумаге)"), paper, paperNote));
  m.root.append(warn);

  async function fillFromBalances() {
    const st = f.from.value; if (!st) { toast("Сначала выберите склад", "bad"); return; }
    let page = 1, pages = 1;
    do {
      const b = await api("stock_balances", { store_id: st, only_nonzero: true, page });
      if (!b.ok) { toast(errText(b), "bad"); return; }
      for (const x of (b.rows || [])) {
        if (lines.some((l) => l.item_code === x.item_code)) continue;
        const l = { item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "", price: "", current_qty: x.qty };
        // Артикул (код iiko, stock_balances с 0045) — чтобы бланк пересчёта печатался с «Код iiko», как
        // итоговая опись (sklad 16). Старый сервер его не отдаёт — ключа нет, и бланк печатает код учёта.
        if ("artikul" in x) l.artikul = x.artikul;
        lines.push(l);
      }
      pages = b.pages || 1; page++;
    } while (page <= pages);
    drawLines();
  }
  // Пересчитали часть склада (sklad 15: 12 позиций из 35 после «заполнить позициями с остатком») —
  // строки без факта убираются одной кнопкой, а не крестиком по одной. Инвентаризация меняет остаток
  // только тех позиций, что в ней есть, поэтому убранные останутся как были. Введённое не теряется:
  // убираются только пустые строки, а вернуть их можно той же кнопкой «Заполнить позициями с остатком».
  function dropNoFact() {
    const keep = lines.filter((l) => parseNum(l.fact_qty) !== null);
    const n = lines.length - keep.length;
    if (!n) { toast("Строк без факта нет"); return; }
    lines.splice(0, lines.length, ...keep);
    drawLines();
    if (err.textContent.startsWith("Укажите факт")) err.textContent = "";   // отказ проведения был ровно про эти строки
    toast(`Убрано ${rows_(n)} без факта — их остатки документ не изменит`);
  }

  // Загрузка факта из файла остатков iiko. Разбор вынесен в parseStockFile — форма выбирает
  // лист (оборотка iiko приходит книгой: лист на фильтр складов), подтверждает сводный лист,
  // зовёт сопоставление и правит строки. Документ не сохраняется и не проводится: человек
  // смотрит итог и решает сам. Вместе с количеством берётся «Сумма с/н» остатка: цена строки =
  // сумма / кол-во — иначе излишек дня X оценился бы по учётной цене программы, а не по iiko.
  async function importFact(file) {
    err.textContent = ""; warn.hidden = true; warn.innerHTML = "";
    const store = stores.find((s) => s.id === f.from.value);
    if (!store) { err.textContent = "Сначала выберите склад — файл грузится на него"; return; }
    let p;
    try { p = await parseStockFile(await file.arrayBuffer()); }
    catch (e) { err.textContent = "Не получилось разобрать файл: " + (e && e.message ? e.message : e); return; }
    if (!p.ok) { err.textContent = p.error; return; }
    const sh = await pickSheet(p.sheets, store);
    if (!sh) return;
    let rows = sh.rows, filtered = false;
    if (sh.has_store_col && sh.stores.length > 1) {
      const pick = await pickStore(sh.stores);
      if (!pick) return;
      rows = rows.filter((x) => x.store === pick); filtered = true;
    }
    if (!rows.length) { err.textContent = "В листе нет строк с количеством"; return; }
    // Ключи уходят пачками: сервер принимает до 2000 за вызов.
    const found = new Map();
    for (let from = 0; from < rows.length; from += 1000) {
      const chunk = rows.slice(from, from + 1000);
      const r = await api("items_lookup_list", { keys: chunk.map((x) => ({ code: x.code || null, name: x.name || null })) });
      if (!r.ok) { err.textContent = errText(r); return; }
      for (const x of (r.rows || [])) found.set(from + x.i, x);
    }
    // Одна позиция может прийти файлом несколькими строками (разные группы отчёта) — складываем
    // и количество, и сумму. Сумма строки с минусом не берётся: факт у неё 0.
    const got = new Map(), miss = [];
    rows.forEach((row, i) => {
      const it = found.get(i);
      if (!it) { if (row.qty > 0) miss.push(row); return; }   // ненайденный ноль грузить некуда и незачем
      const s = row.qty > 0 && row.sum > 0 ? row.sum : 0;
      const prev = got.get(it.item_code);
      if (prev) { prev.qty += row.qty; prev.sum += s; } else got.set(it.item_code, { it, qty: row.qty, sum: s });
    });
    let loadedSum = 0; const noPrice = [];
    for (const [itemCode, v] of got) {
      const val = Math.round(v.qty * 1000) / 1000;
      // цена — от округлённого факта: факт × цена должен вернуть сумму файла, а не потерять тиыны на округлении
      const price = val > 0 && v.sum > 0 ? Math.round(v.sum / val * 1e6) / 1e6 : null;
      if (val > 0 && price === null) noPrice.push(v.it.name);
      if (price !== null) loadedSum += r2(val * price);
      const line = lines.find((l) => l.item_code === itemCode);
      if (line) { line.fact_qty = val; if (price !== null) line.price = price; }
      else lines.push({ item_code: itemCode, name: v.it.name, unit_id: v.it.unit_id, qty: "", fact_qty: val, price: price ?? "" });
    }
    drawLines();
    const sumOf = (list) => r2(list.reduce((a, x) => a + (Number(x.sum) || 0), 0));
    warn.className = "warnbox"; warn.hidden = false; warn.innerHTML = "";
    // Сверка с файлом: сколько и на какую сумму в файле, что из этого встало в документ и что нет.
    warn.append(el("div", { style: "font-weight:600" }, sh.has_sum
      ? `В файле ${rows.length} поз. на ${fmtMoney(sumOf(rows))} ₸` + (sh.total !== null && !filtered ? ` (итог файла ${fmtMoney(sh.total)} ₸)` : "")
        + ` — загружено ${got.size} на ${fmtMoney(r2(loadedSum))} ₸, не найдено ${miss.length} на ${fmtMoney(sumOf(miss))} ₸, без цены ${noPrice.length}`
      : `В файле ${rows.length} поз. — загружено ${got.size}, не найдено ${miss.length}. Колонки суммы в листе нет: цены не загружены`));
    warn.append(el("div", { class: "dim" }, `Лист «${sh.sheet}»` + (sh.zeros ? `, нулевых ${sh.zeros}` : "") + (sh.blanks ? `, пропущено без количества ${sh.blanks}` : "")));
    for (const w of sh.warnings) warn.append(el("div", { class: "dim" }, w));
    if (sh.period_to && sh.period_to !== f.date.value) warn.append(el("div", {},
      `Остатки в файле — на конец ${fmtDate(sh.period_to)}, а дата документа — ${fmtDate(f.date.value)}. Проверьте, тот ли это файл и та ли дата.`));
    if (sh.combined) warn.append(el("div", {}, `Лист сводный (${sh.stores.join(", ")}) — всё загружено на склад «${store.name}»`));
    if (sh.negatives.length) warn.append(el("details", {},
      el("summary", {}, `В iiko минус у ${sh.negatives.length} поз.` + (sh.has_sum ? ` на ${fmtMoney(sumOf(sh.negatives))} ₸` : "") + " — факт поставлен 0"),
      el("div", { class: "dim" }, sh.negatives.map((x) => `${x.name} (${fmt(x.qty)})`).join("; "))));
    // Сумма без количества (посуда, списанная в iiko «в ноль» по количеству) — в остаток её не положить.
    const zeroSum = rows.filter((x) => x.qty === 0 && !x.neg && x.sum);
    if (sh.has_sum && zeroSum.length) warn.append(el("details", {},
      el("summary", {}, `Кол-во 0, а сумма есть у ${zeroSum.length} поз. на ${fmtMoney(sumOf(zeroSum))} ₸ — сумма без количества не загружается`),
      el("div", { class: "dim" }, zeroSum.map((x) => `${x.name} (${fmtMoney(x.sum)} ₸)`).join("; "))));
    if (sh.has_sum && noPrice.length) warn.append(el("details", {},
      el("summary", {}, `Без цены ${noPrice.length} поз.: в файле у них нет суммы — излишек оценится по средней цене склада`),
      el("div", { class: "dim" }, noPrice.join("; "))));
    if (miss.length) {
      const mt = el("table");
      mt.append(el("tr", {}, ...["Не найдено в номенклатуре", "Код", "Кол-во", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
      for (const w of miss) mt.append(el("tr", {}, el("td", {}, w.name), el("td", {}, w.code), el("td", { class: "num" }, fmt(w.qty)), el("td", { class: "num" }, w.sum ? fmtMoney(w.sum) : "")));
      warn.append(mt);
    }
    // Строки, которых нет в файле, но есть в документе (например, после «заполнить позициями
    // с остатком»), остаются без факта — провести такой документ сервер не даст. Раз файл —
    // полный остаток склада по iiko, их честно обнулить; но решает человек, одной кнопкой.
    const empty = lines.filter((l) => l.fact_qty === "" || l.fact_qty == null);
    const acts = el("div", { class: "actions" });
    if (empty.length) {
      warn.append(el("div", {}, `Без факта ${empty.length} поз.: их нет в файле`));
      acts.append(el("button", { class: "small", onclick: (e) => { for (const l of empty) l.fact_qty = "0"; drawLines(); e.target.remove(); } }, "Поставить им 0"));
    }
    acts.append(el("button", { class: "ghost small", onclick: () => { warn.hidden = true; } }, "Скрыть"));
    warn.append(acts);
  }
  // Какой лист книги брать. Спрашиваем, когда листов несколько, когда лист сводный или когда
  // склад в листе не тот, что в документе; лист с тем же складом предлагается первым.
  function pickSheet(sheets, store) {
    const mine = sheets.find((s) => s.stores.length === 1 && sameStore(s.stores[0], store.name))
      || sheets.find((s) => s.stores.some((n) => sameStore(n, store.name))) || sheets[0];
    const clean = (s) => !s.combined && (!s.stores.length || s.stores.some((n) => sameStore(n, store.name)));
    if (sheets.length === 1 && clean(mine)) return Promise.resolve(mine);
    return new Promise((resolve) => {
      const label = (x) => `${x.sheet} — ${x.stores.length ? x.stores.join(", ") : "склад не указан"} (${x.rows.length} строк)`;
      const s = sel(Object.fromEntries(sheets.map((x, i) => [String(i), label(x)])), String(sheets.indexOf(mine)), () => note());
      const info = el("div", {});
      const cm = modal("Какой лист загрузить");
      function note() {
        const x = sheets[Number(s.value)]; info.innerHTML = "";
        if (x.combined) info.append(el("div", { class: "warnbox" },
          `В листе ${x.stores.length} скл.: ${x.stores.join(", ")}. Остатки по ним сложены в одну строку, `
          + `разложить обратно нельзя. Всё ляжет на «${store.name}»; хозтовары и посуду потом можно переместить. `
          + "Точнее — выгрузить из iiko отчёт по одному складу."));
        else if (x.stores.length && !x.stores.some((n) => sameStore(n, store.name)))
          info.append(el("div", { class: "warnbox" }, `Склад в листе — «${x.stores[0]}», а в документе — «${store.name}». Проверьте, тот ли это склад.`));
      }
      note();
      cm.root.append(el("label", {}, "Лист файла"), s, info,
        el("div", { class: "actions" },
          el("button", { onclick: () => { cm.close(); resolve(sheets[Number(s.value)]); } }, `Загрузить на склад «${store.name}»`),
          el("button", { class: "ghost", onclick: () => { cm.close(); resolve(null); } }, "Отмена")));
    });
  }
  // Выбор склада, когда в простом листе есть колонка склада и складов в ней несколько.
  function pickStore(list) {
    return new Promise((resolve) => {
      const mine = (stores.find((s) => s.id === f.from.value) || {}).name || "";
      const cur = list.find((n) => sameStore(n, mine)) || list[0];
      const s = sel(Object.fromEntries(list.map((n) => [n, n])), cur, () => {});
      const cm = modal("Какой склад брать из файла");
      cm.root.append(el("div", { class: "dim" }, "В листе несколько складов — возьмём строки одного"), s,
        el("div", { class: "actions" },
          el("button", { onclick: () => { cm.close(); resolve(s.value); } }, "Загрузить"),
          el("button", { class: "ghost", onclick: () => { cm.close(); resolve(null); } }, "Отмена")));
    });
  }

  if (!ro) {
    // Поиск позиции: в приходе — только товары (блюда не приходуют), в акте производства — что выпускают
    // (блюда и полуфабрикаты), в прочих — всё. Уже добавленные не показываются; после выбора — курсор
    // в количество новой строки. В приходе цена подставляется из последнего прихода (last_price, 0047).
    // В перемещении и списании поиск знает склад-отправитель (sklad 12): сервер отдаёт остаток на нём
    // (stock_qty, 0047) и ставит позиции с остатком выше, а в подсказке виден «ост. N» — беляш без
    // остатка не выбирается вслепую. Склад читается в момент поиска: его могли сменить после открытия.
    const fromStore = type === "transfer" || type === "writeoff" ? () => f.from.value || null : null;
    picker = itemPicker({ types: isIn ? ["goods"] : isProd ? ["dish", "prepared"] : null, limit: 30, store_id: fromStore,
      exclude: (it) => lines.some((l) => l.item_code === it.code),
      onPick: (it) => {
        const l = { item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", fact_qty: "", price: "" };
        if (it.artikul) l.artikul = it.artikul;
        if (it.group_name) l.group_name = it.group_name;
        if (isIn && it.last_price !== null && it.last_price !== undefined && Number(it.last_price) > 0) { l.price = Number(it.last_price); l._last = it.last_price_date || ""; }
        lines.push(l); drawLines();
        const q = tbl.querySelector(`input[data-li="${lines.length - 1}"][data-key="${qkey}"]`); if (q) q.focus();
      } });
    const tools = el("div", { style: "margin-top:10px" }, picker.root);
    if (isInv) {
      // Файл выбирается скрытым input'ом: своя кнопка рядом с «заполнить с остатком» читается
      // лучше, чем системный «Обзор…», и остаётся на месте после каждой загрузки.
      const file = el("input", { type: "file", accept: ".xlsx,.xls", style: "display:none",
        onchange: (e) => { const x = e.target.files[0]; e.target.value = ""; if (x) importFact(x); } });
      tools.prepend(el("div", { style: "margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap" },
        el("button", { class: "ghost small", onclick: fillFromBalances }, "Заполнить позициями с остатком"),
        el("button", { class: "ghost small", onclick: () => file.click() }, "Загрузить факт из файла"),
        el("button", { class: "ghost small", title: "Пересчитали не всё — строки без факта уберутся, остатки этих позиций документ не изменит",
          onclick: dropNoFact }, "Убрать строки без факта"),
        file));
    }
    m.root.append(tools);
  }
  if (doc.consume && doc.consume.length) {
    const ct = el("table"); ct.append(el("tr", {}, ...["Расход сырья", "Ед.", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    for (const c of doc.consume) ct.append(el("tr", {}, el("td", {}, c.name), el("td", {}, c.unit_id), el("td", { class: "num" }, fmt(c.qty)), el("td", { class: "num" }, priceTxt(c.price)), el("td", { class: "num" }, fmtMoney(c.sum))));
    m.root.append(el("h2", { style: "margin-top:14px" }, isSale ? "Списано со склада (по техкартам и как есть)" : "Списано по техкартам"), ct);
  }
  const err = el("div", { class: "err" }); const actions = el("div", { class: "actions" });
  // Ключ повтора нового документа (контракт п. 8) — один на открытую форму: если ответ на первое
  // сохранение потерялся и человек нажал ещё раз, сервер узнает документ по ключу и не заведёт второй.
  const clientKey = doc.id ? undefined : uid();
  const payloadReason = () => isInv ? (opening && opening.checked ? OPENING : null) : type === "writeoff" ? f.reason.value || null : null;
  const numOrNull = (v) => { const x = parseNum(v); return x === null || Number.isNaN(x) ? null : x; };
  const payload = () => ({ id: doc.id, client_key: clientKey, doc_type: type, doc_date: f.date.value, store_from: f.from.value || null, store_to: f.to.value || null,
    counteragent_id: f.caId, reason: payloadReason(), comment: f.comment.value,
    ext_number: f.ext.value.trim() || null, ext_date: f.extd.value || null,
    // Цену хранят приход (закупка) и инвентаризация (цена излишка); у прочих её ставит проведение.
    lines: lines.map((l) => ({ item_code: l.item_code, qty: isInv ? null : numOrNull(l.qty), fact_qty: isInv ? numOrNull(l.fact_qty) : null,
      price: isIn || isInv ? numOrNull(l.price) : null })) });
  // Проверки до сервера — те, что человек может поправить в форме: число, которое не число, и поставщик,
  // набранный, но не выбранный из списка.
  function check() {
    for (const l of lines) for (const k of [qkey, ...(isIn || isInv ? ["price"] : [])]) {
      const x = parseNum(l[k]);
      if (x !== null && Number.isNaN(x)) return `${k === "price" ? "Цена" : isInv ? "Факт" : "Количество"} — число: ${l.name}`;
    }
    if (isIn && !f.caId) return NO_CA;
    return "";
  }
  // Сохранено ли что-то за время формы: тогда при закрытии обновляется журнал (новый черновик в нём виден).
  let saved = false;
  function closeForm() { m.close(); if (saved) (LOADERS[state.tab] || loadDocs)(); }
  // Черновик уже на сервере — «пропадёт» было бы неправдой: пропадут только правки после сохранения.
  function cancelForm() {
    if (!ro && m.dirty && !confirmDlg(doc.id ? `Черновик ${doc.number} сохранён, последние изменения пропадут. Закрыть?` : "Закрыть без сохранения? Введённое пропадёт.")) return;
    closeForm();
  }
  // Один запрос сохранения за раз: повторное нажатие (двойной щелчок, медленная связь) ждёт уже
  // идущий и получает тот же ответ, а не создаёт второй документ. Кнопки на время запроса выключены.
  let saving = null;
  function save() {
    if (!saving) saving = (async () => {
      err.textContent = "";
      const bad = check(); if (bad) { err.textContent = bad; return null; }
      const r = await api("doc_save", payload());
      if (!r.ok) { err.textContent = errText(r); return null; }
      const first = !doc.id;
      doc.id = r.id; doc.number = r.number; saved = true; m.dirty = false;
      if (first) { setTitle(); drawActions(); }
      dupSeq++; showDup(isIn ? r.dup_of : null);   // ответ сервера точнее проверки по журналу — она уже не нужна
      return r;
    })().finally(() => { saving = null; });
    return saving;
  }
  const draftBtn = el("button", { class: "ghost" }, "Сохранить черновик"), postBtn = el("button", {}, "Провести");
  const busy = (on) => { draftBtn.disabled = postBtn.disabled = on; };
  // Окно «Провести документ?» не бывает пустым: что за документ, сколько строк и на какую сумму, откуда
  // и куда, затем что спишется и что уйдёт в минус.
  // Поля preview новых версий сервера необязательны — без них окно такое же, как раньше: сумма
  // документа total_sum (у прихода сумма своя — из строк формы), тип позиции item_type у минусов и
  // позиции выпуска без действующей техкарты warnings_charts [{item_name}].
  function postSummary(pv) {
    const box = el("div", {});
    const n = lines.length;
    // Сумма у списания и инвентаризации (sklad 18) — только посчитанная сервером: списание идёт по
    // средней склада, разница инвентаризации — по расчёту на дату, ни того ни другого в форме нет.
    // Не отдал — в заголовке только число строк.
    const raw = pv.total_sum ?? pv.sum;
    const srvSum = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    const sumTxt = isIn ? "на " + fmtMoney(docSum()) + " ₸"
      : srvSum === null ? null : (isInv ? "итог разницы " : "на ") + fmtMoney(srvSum) + " ₸";
    box.append(el("div", { style: "font-weight:600" }, [`${TYPES[type]} ${doc.number}`, rows_(n), sumTxt].filter(Boolean).join(" · ")));
    const from = storeName(f.from.value), to = storeName(f.to.value);
    const where = isIn ? `${f.ca.value.trim()}${f.ext.value.trim() ? ", накладная № " + f.ext.value.trim() : ""}${f.extd.value ? " от " + fmtDate(f.extd.value) : ""} → ${to}`
      : type === "transfer" ? `${from} → ${to}`
      : type === "writeoff" ? `${from}, причина: ${REASONS[f.reason.value] || "—"}`
      : isInv ? `Склад ${from}` + (opening && opening.checked ? " · ввод начальных остатков — в прибыль не войдёт" : "")
      : `Склад ${from}`;
    box.append(el("div", { class: "dim" }, `от ${fmtDate(f.date.value)} · ${where}`));
    // Позиции выпуска без действующей техкарты (sklad 1, «Вода ПФ»): проведение откажет — говорим заранее.
    const charts = (Array.isArray(pv.warnings_charts) ? pv.warnings_charts : []).map((c) => c.item_name || c.name || c.item_code).filter(Boolean);
    if (charts.length) box.append(el("div", { class: "warnbox" },
      `Нет действующей техкарты на ${fmtDate(f.date.value)}: ${listNames(charts)} — документ не проведётся. `
      + "Уберите эти позиции из выпуска или заведите техкарту в разделе «Техкарты»."));
    if (pv.consume && pv.consume.length) box.append(el("div", { class: "dim", style: "margin-top:6px" }, "Будет списано: " + pv.consume.map((c) => `${c.name} ${fmt(c.qty)} ${c.unit_id}`).join(", ")));
    const minus = (Array.isArray(pv.warnings) ? pv.warnings : []).filter((w) => w.balance_after !== null && w.balance_after !== undefined);
    if (minus.length) box.append(el("div", { class: "warnbox" }, "Уйдут в минус: " + minus.map((w) => `${w.name} (${w.store_name}) → ${fmt(w.balance_after)}`).join("; "),
      prepHint(minus)));
    return box;
  }
  // Подсказка про акт приготовления (sklad 14) — только когда в минус уходит полуфабрикат: у товара
  // («Приправа Черный молотый перец») она сбивала. Тип берётся из warnings[].item_type; старый сервер
  // его не отдаёт — тогда, как раньше, общий текст у производства (по «ПФ» в названии не гадаем).
  function prepHint(minus) {
    const st = { style: "margin-top:4px" };
    if (!minus.some((w) => w.item_type !== undefined && w.item_type !== null)) {
      return isProd ? el("div", st, "Если это полуфабрикат — сначала проведите его акт приготовления, потом этот.") : null;
    }
    const pf = minus.filter((w) => w.item_type === "prepared").map((w) => w.name);
    if (!pf.length) return null;
    return el("div", st, (pf.length > 1 ? `Полуфабрикаты ${listNames(pf)} — сначала проведите их акты приготовления`
      : `Полуфабрикат ${pf[0]} — сначала проведите его акт приготовления`) + ", потом этот документ.");
  }
  async function post() {
    busy(true);
    try {
      if (isInv) {
        const empty = lines.filter((l) => numOrNull(l.fact_qty) === null);
        if (empty.length) { err.textContent = `Укажите факт у ${empty.length} поз.: ${empty.slice(0, 3).map((l) => l.name).join(", ")}${empty.length > 3 ? "…" : ""} `
          + "(нет в наличии — 0; не пересчитывали — кнопка «Убрать строки без факта»)"; return; }
      }
      const sr = await save(); if (!sr) return;
      const id = sr.id;
      if (isIn && sr.dup_of && !confirmDlg(dupText(sr.dup_of) + ".\n\nВсё равно провести?")) return;
      const pv = await api("doc_preview", { id }); if (!pv.ok) { err.textContent = errText(pv); return; }
      const cm = modal("Провести документ?"); cm.root.append(postSummary(pv), el("div", { class: "actions" },
        el("button", { onclick: async () => {
          cm.close(); busy(true);
          const r = await api("doc_post", { id });
          busy(false);
          if (!r.ok) { err.textContent = errText(r); return; }
          toast("Проведено" + ((r.warnings || []).length ? " — есть минусы" : "")); m.close(); afterDocChange(doc, r); postNotes(r, type);
        } }, "Провести"),
        el("button", { class: "ghost", onclick: cm.close }, "Отмена")));
    } finally { busy(false); }
  }
  draftBtn.onclick = async () => {
    busy(true); const r = await save(); busy(false);
    if (!r) return;
    // Дубль накладной: форма остаётся открытой, чтобы предупреждение было видно.
    if (isIn && r.dup_of) { toast("Черновик сохранён — проверьте: такая накладная уже есть", "bad"); return; }
    toast("Черновик сохранён"); closeForm();
  };
  postBtn.onclick = post;
  // Документ в форме, как его отдал бы doc_get: печать черновика — с тем, что сейчас в форме
  // (бланк пересчёта после «заполнить позициями с остатком» печатается и без сохранения).
  function formDoc() {
    const clean = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => !k.startsWith("_")));
    if (ro) return { ...doc, lines: lines.map(clean) };
    const fromId = f.from.value || null, toId = f.to.value || null;
    return { ...doc, doc_date: f.date.value || doc.doc_date, store_from: fromId, store_to: toId,
      store_from_name: storeName(fromId) || null, store_to_name: storeName(toId) || null,
      counteragent_id: f.caId, counteragent_name: f.ca.value.trim() || null, reason: payloadReason(), comment: f.comment.value,
      ext_number: f.ext.value.trim() || null, ext_date: f.extd.value || null,
      total_sum: isIn ? docSum() : doc.total_sum,
      lines: lines.map((l) => ({ ...clean(l), sum: isIn || isInv ? lineSum(l) : l.sum })) };
  }
  function choose(title, list) {
    return new Promise((resolve) => {
      const cm = modal(title);
      cm.root.append(el("div", { class: "actions" },
        ...list.map(([t, o], i) => el("button", { class: i ? "ghost" : "", onclick: () => { cm.close(); resolve(o); } }, t)),
        el("button", { class: "ghost", onclick: () => { cm.close(); resolve(null); } }, "Отмена")));
    });
  }
  async function doPrint() {
    let o = { withCost: type !== "transfer" };
    // Перемещение: без цен — для водителя и точки, с ценами — для бухгалтерии (цены есть только у проведённого).
    if (type === "transfer" && posted) { o = await choose("Печать накладной на перемещение", [["Без цен", { withCost: false }], ["С ценами", { withCost: true }]]); if (!o) return; }
    // Инвентаризация: бланк для пересчёта — у любой (без факта), итоговая опись — у проведённой.
    if (isInv) {
      o = posted ? await choose("Печать инвентаризации", [["Итоговая опись", { blank: false, withCost: true }], ["Бланк для пересчёта", { blank: true }]]) : { blank: true };
      if (!o) return;
    }
    let mod;
    try { mod = await import("./print.js?v=21"); }
    catch (e) { toast("Печать не загрузилась: " + (e && e.message ? e.message : e), "bad"); return; }
    try {
      const res = await mod.printDoc(formDoc(), o);
      if (res && res.ok === false) toast(res.error || "Не получилось напечатать", "bad");
    } catch (e) { toast("Не получилось напечатать: " + (e && e.message ? e.message : e), "bad"); }
  }
  // «Копировать»: новый документ того же типа на сегодня — склады, поставщик, строки. У прихода — кол-во
  // и цены, без № и даты накладной поставщика; у инвентаризации — только позиции, без факта.
  function doCopy() {
    if (!ro && m.dirty && !confirmDlg(doc.id ? `Черновик ${doc.number} сохранён, последние изменения пропадут. Сделать копию?` : "Введённое пропадёт. Сделать копию?")) return;
    const pre = { copy_of: doc.number || "", store_from: f.from.value || null, store_to: f.to.value || null,
      counteragent_id: isIn ? f.caId : null, counteragent_name: isIn ? f.ca.value.trim() : null,
      reason: type === "writeoff" ? f.reason.value || null : null,
      lines: lines.map((l) => {
        const c = { item_code: l.item_code, name: l.name, unit_id: l.unit_id, qty: isInv ? "" : l.qty ?? "", fact_qty: "", price: isIn ? l.price ?? "" : "" };
        if (l.artikul) c.artikul = l.artikul;
        if (l.group_name) c.group_name = l.group_name;
        return c;
      }) };
    closeForm();
    editDoc(null, type, pre);
  }
  function drawActions() {
    actions.innerHTML = "";
    if (!ro) actions.append(draftBtn, postBtn);
    if (!isSale) actions.append(el("button", { class: "ghost", onclick: doPrint }, "Печать"));
    if (doc.id && !isSale && canDoc(type)) actions.append(el("button", { class: "ghost", onclick: doCopy }, "Копировать"));
    if (posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async (e) => {
      if (!confirmDlg("Отменить проведение?")) return;
      e.target.disabled = true;
      const r = await api("doc_unpost", { id: doc.id });
      e.target.disabled = false;
      if (!r.ok) { err.textContent = errText(r); return; }
      const hasWarn = r.warnings && r.warnings.length;
      toast("Проведение отменено — документ открыт для правки" + (hasWarn ? ". В минусе: " + r.warnings.map((w) => `${w.name} (${w.store_name}) ${fmt(w.balance_after)}`).join("; ") : ""), hasWarn ? "bad" : "ok");
      // Как в iiko: распровели — поправили — провели. Форма открывается снова, уже черновиком.
      m.close(); afterDocChange(doc, r); editDoc(doc.id);
    } }, "Отменить проведение"));
    if (doc.id && !posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async (e) => {
      if (!confirmDlg("Удалить черновик?")) return;
      e.target.disabled = true;
      const r = await api("doc_delete", { id: doc.id });
      e.target.disabled = false;
      if (!r.ok) { err.textContent = errText(r); return; } toast("Удалено"); m.close(); afterDocChange(null); } }, "Удалить"));
    actions.append(el("button", { class: "ghost", onclick: cancelForm }, ro ? "Закрыть" : "Отмена"));
  }
  drawActions();
  m.root.append(err, actions);
  // Копия — уже введённое, но не сохранённое: закрытие переспросит.
  if (preset) m.dirty = true;
  if (isInv && !posted) checkFirstInventory();
}

// ---------- остатки ----------
let bal = { store_id: "", q: "", nonzero: true, page: 1 };
// Средняя строки в минусе: сервер отдаёт 0, а сумма не ноль (owner Д4: «−3,9 кг · 0,00 · −6 254,82») —
// показываем цену, по которой сумма посчитана: сумма / кол-во.
const balAvg = (x) => {
  const q = Number(x.qty), s = Number(x.sum), a = s / q;
  return q < 0 && !(Number(x.avg_cost) > 0) && a > 0 && Number.isFinite(a) ? Math.round(a * 1e4) / 1e4 : x.avg_cost;
};
// Пустой список остатков. Поиск без совпадений — не пустой склад (sklad 15: «самс» по кухне пугал
// советом «проведите первую инвентаризацию»): называем, что искали и где. Совет про первую
// инвентаризацию — только когда пусто без поиска.
function balEmpty() {
  const q = bal.q.trim();
  if (!q) return "Остатков нет — проведите первую инвентаризацию или приход";
  const where = bal.store_id ? `на складе «${storeName(bal.store_id)}»` : myIds.length ? "на ваших складах" : "на складах";
  return `По «${q}» ${where} ничего нет` + (bal.nonzero ? ". Нулевые остатки скрыты флажком «только с остатком»" : "");
}
async function loadBalances() {
  const out = tabOut("bal-root", () => [el("div", { class: "tools" },
    sel({ "": myIds.length ? "мои склады" : "все склады", ...opts(mine(stores)) }, bal.store_id, (v) => { bal.store_id = v; bal.page = 1; loadBalances(); }),
    el("input", { placeholder: "Поиск позиции", value: bal.q, oninput: debounce((e) => { bal.q = e.target.value; bal.page = 1; loadBalances(); }, 300) }),
    el("label", { style: "margin:0" }, el("input", { type: "checkbox", checked: bal.nonzero, onchange: (e) => { bal.nonzero = e.target.checked; bal.page = 1; loadBalances(); } }), " только с остатком"),
    el("span", { class: "dim bal-sum" }),
    el("button", { class: "ghost", onclick: async (e) => {
      // CSV считается сервером отдельным запросом (export:true) по тем же фильтрам, а не по уже
      // загруженной странице — office_stock_balances отдаёт csv только когда его явно просят.
      e.target.disabled = true;
      const rex = await api("stock_balances", { store_id: bal.store_id || null, q: bal.q, only_nonzero: bal.nonzero, export: true });
      e.target.disabled = false;
      if (!rex.ok) { toast(errText(rex), "bad"); return; }
      const b = new Blob(["﻿" + rex.csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "ostatki.csv"; a.click(); URL.revokeObjectURL(a.href);
    } }, "CSV"))]);
  if (!out) return;
  const n = nextSeq("bal");
  const r = await api("stock_balances", { store_id: bal.store_id || null, q: bal.q, only_nonzero: bal.nonzero, page: bal.page });
  if (n !== seqs.bal) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  out.parentNode.querySelector(".bal-sum").textContent = `итого ${fmtMoney(r.total_sum)} ₸`;
  const t = el("table"); t.append(el("tr", {}, ...["Склад", "Позиция", "Ед.", "Кол-во", "Средняя", "Сумма"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) t.append(el("tr", { class: "row", onclick: () => showMoves(x) }, el("td", { class: "dim" }, x.store_name), el("td", {}, x.name), el("td", {}, x.unit_id),
    el("td", { class: "num" + (Number(x.qty) < 0 ? " bad" : "") }, fmt(x.qty)), el("td", { class: "num" }, priceTxt(balAvg(x))), el("td", { class: "num" }, fmtMoney(x.sum))));
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, balEmpty())));
  out.innerHTML = "";
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "pager" }, `всего ${r.total} · стр. ${r.page} из ${r.pages}`,
      el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { bal.page--; loadBalances(); } }, "←"),
      el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { bal.page++; loadBalances(); } }, "→")));
}
// Движения позиции на складе — как карточка товара в iiko: с остатком после каждого движения
// (balance_after, 0045). Старый сервер его не отдаёт — тогда колонки нет.
async function showMoves(x) {
  const r = await api("stock_moves", { store_id: x.store_id, item_code: x.item_code, page: 1 });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const rows = r.rows || [];
  const m = modal(`${x.name} · ${x.store_name}`); m.root.style.maxWidth = "820px";
  const hasBal = rows.some((mv) => mv.balance_after !== null && mv.balance_after !== undefined);
  const t = el("table"); t.append(el("tr", {}, ...["Дата", "Документ", "Кол-во", "Себест.", "Сумма", ...(hasBal ? ["Остаток после"] : [])].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
  // Строка без количества (qty = 0) — переоценка: приход на склад, ушедший в минус, переоценил
  // недостающее по своей цене; её сумма — поправка стоимости остатка (adj).
  let reval = false;
  for (const mv of rows) {
    const isReval = Number(mv.qty) === 0; reval = reval || isReval;
    t.append(el("tr", { class: "row", onclick: () => { m.close(); editDoc(mv.document_id); } },
      el("td", { style: "white-space:nowrap" }, fmtDate(mv.move_date)), el("td", {}, `${TYPES[mv.doc_type] || mv.doc_type} ${mv.number}`),
      isReval ? el("td", { class: "num dim" }, "переоценка") : el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty)),
      el("td", { class: "num" }, isReval ? "" : priceTxt(mv.unit_cost)), el("td", { class: "num" }, fmtMoney(isReval && mv.adj != null ? mv.adj : mv.sum)),
      hasBal ? el("td", { class: "num" + (Number(mv.balance_after) < 0 ? " bad" : "") }, fmt(mv.balance_after)) : null));
  }
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: hasBal ? 6 : 5, class: "dim" }, "Движений нет")));
  // Пустое значение в append() браузер пишет текстом «null» — поэтому необязательное добавляется только если есть.
  m.root.append(el("div", { style: "overflow:auto;max-height:60vh" }, t));
  if (reval) m.root.append(el("div", { class: "dim", style: "margin-top:8px" }, "«Переоценка» — поправка стоимости без количества: приход на склад, ушедший в минус, пересчитал недостающее по цене прихода."));
  if (Number(r.total) > rows.length) m.root.append(el("div", { class: "dim", style: "margin-top:8px" }, `Показаны последние ${rows.length} из ${r.total} движений.`));
  m.root.append(el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
}

// ---------- разбор файла остатков ----------
// SheetJS тянем один раз и только когда файл действительно выбрали: библиотека тяжёлая,
// а в бэк-офис заходят не ради инвентаризации.
let xlsxLoading = null;
export function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxLoading) xlsxLoading = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "vendor/xlsx.full.min.js";
    sc.onload = () => resolve();
    sc.onerror = () => { xlsxLoading = null; reject(new Error("Не удалось загрузить обработчик Excel")); };
    document.head.append(sc);
  });
  return xlsxLoading;
}

const txt = (v) => String(v === null || v === undefined ? "" : v).replace(/\s+/g, " ").trim();
// Количество: числом из ячейки как есть, строкой — с запятой вместо точки и без пробелов
// разрядов (iiko и Excel пишут неразрывные). Всё, что не число, — не количество.
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = txt(v).replace(/\s/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
const findCol = (row, re) => row.findIndex((c) => re.test(txt(c)));

// Разбор книги остатков → { ok:true, sheets:[лист] } либо { ok:false, error }.
// Лист: { sheet, mode, stores, combined, has_store_col, has_sum, total, period_to,
// rows:[{code,name,qty,sum,store,neg}], warnings, zeros, negatives:[{code,name,qty,sum}], blanks }.
// Iiko отдаёт оборотку книгой, где каждый лист — отдельный фильтр по складам, поэтому разбираются
// все листы, а какой брать, решает форма. Вынесен из формы намеренно: так его можно проверить
// отдельно, без модалки.
export async function parseStockFile(buf) {
  await loadXlsx();
  const wb = window.XLSX.read(new Uint8Array(buf), { type: "array" });
  if (!wb.SheetNames.length) return { ok: false, error: "В файле нет ни одного листа" };
  const sheets = [], errors = [];
  for (const name of wb.SheetNames) {
    const g = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
    const r = parseSheet(g);
    if (r.ok) sheets.push({ sheet: name, ...r }); else errors.push(r.error);
  }
  if (!sheets.length) return { ok: false, error: errors[0] || "Не нашёл строку заголовка с названием и количеством" };
  return { ok: true, sheets };
}

export function parseSheet(g) {
  const warnings = [];
  // Отчёт iiko узнаётся по строке колонок с «Код» и «Наименование»: в нём колонок «Кол-во»
  // много (приход, продажи, списания…), и нужную выбирает не имя колонки, а группа над ней.
  let hdr = g.findIndex((r) => findCol(r, /^код$/i) >= 0 && findCol(r, /наимен/i) >= 0);
  let qtyCol = -1, sumCol = -1, nameCol = -1, codeCol = -1, storeCol = -1, mode = "plain";
  if (hdr >= 0) {
    mode = "iiko";
    nameCol = findCol(g[hdr], /наимен/i);
    codeCol = findCol(g[hdr], /^код$/i);
    const grp = hdr > 0 ? g[hdr - 1] : [];
    let gi = findCol(grp, /остатки на конец/i);
    if (gi < 0) {
      gi = findCol(grp, /остат/i);
      if (gi >= 0) warnings.push("Группы «Остатки на конец» в файле нет — взял ближайшую группу остатков: " + txt(grp[gi]));
    }
    if (gi >= 0) for (let c = gi; c < g[hdr].length; c++) {
      const h = txt(g[hdr][c]);
      if (/^кол/i.test(h) && !/сумм/i.test(h)) { qtyCol = c; break; }
    }
    // «Сумма с/н» той же группы — сразу за «Кол-во»; следующая группа (её имя в строке групп) — уже не наша.
    if (qtyCol >= 0) for (let c = qtyCol + 1; c < g[hdr].length; c++) {
      if (c > gi && txt(grp[c])) break;
      const h = txt(g[hdr][c]);
      if (/сумм/i.test(h)) { sumCol = c; break; }
      if (/^кол/i.test(h)) break;
    }
    if (qtyCol < 0) { mode = "plain"; hdr = -1; }
  }
  if (hdr < 0) {
    // Универсальный лист: название + количество, код, сумма и склад — если есть.
    hdr = g.findIndex((r) => findCol(r, /наимен|номенклат|товар|позиц/i) >= 0 && findCol(r, /кол|остат/i) >= 0);
    if (hdr < 0) return { ok: false, error: "Не нашёл строку заголовка с названием и количеством" };
    nameCol = findCol(g[hdr], /наимен|номенклат|товар|позиц/i);
    codeCol = findCol(g[hdr], /^код|артикул/i);
    qtyCol = g[hdr].findIndex((c) => /кол|остат/i.test(txt(c)) && !/сумм/i.test(txt(c)));
    sumCol = findCol(g[hdr], /сумм/i);
    storeCol = findCol(g[hdr], /склад/i);
    if (qtyCol < 0) return { ok: false, error: "Не нашёл строку заголовка с названием и количеством" };
  }

  // Нулевой и отрицательный остаток — тоже факт: ноль. Строка остаётся в документе, чтобы
  // повторная загрузка (тест, потом день запуска) обнуляла то, что iiko считает пустым,
  // а не оставляла прошлое количество. Минус физически невозможен — это недоучёт в iiko;
  // сервер минус в факте и не примет, поэтому ставим 0 и показываем такие строки списком.
  // Итоговая строка отчёта (внизу, без кода и названия) — «итог файла» для сверки.
  const rows = [], negatives = []; let zeros = 0, blanks = 0, total = null;
  for (let i = hdr + 1; i < g.length; i++) {
    const r = g[i];
    const name = nameCol >= 0 ? txt(r[nameCol]) : "";
    const code = codeCol >= 0 ? txt(r[codeCol]) : "";
    if (!name && !code) {                         // итоговая строка отчёта и разделители
      const t = sumCol >= 0 ? num(r[sumCol]) : null;
      if (t !== null) total = t;
      continue;
    }
    const q = num(r[qtyCol]);
    if (q === null) { blanks++; continue; }
    const s = sumCol >= 0 ? num(r[sumCol]) : null;
    if (q === 0) zeros++;
    if (q < 0) negatives.push({ code, name, qty: q, sum: s });
    rows.push({ code, name, qty: Math.max(q, 0), sum: s, neg: q < 0, store: storeCol >= 0 ? txt(r[storeCol]) : "" });
  }

  // Склады: в отчёте iiko — из строки шапки «Склад: …», в универсальном листе — из колонки.
  // Лист iiko с несколькими складами — сводный: остатки в строке сложены, и разложить их
  // обратно нечем. Такой лист не отвергается, а помечается: грузить его целиком на один
  // склад форма разрешает только после явного подтверждения.
  // Конец периода отчёта («За период: с 01.07.2026 по 31.07.2026») — дата остатков на конец:
  // форма предупредит, если документ датирован другим днём.
  let stores = [], periodTo = null;
  if (mode === "iiko") {
    for (let i = 0; i < hdr; i++) {
      const cells = (g[i] || []).map(txt);
      const c = cells.find((x) => /^склад\s*:/i.test(x));
      if (c && !stores.length) stores = c.replace(/^склад\s*:/i, "").split(",").map((x) => x.trim()).filter(Boolean);
      const p = cells.map((x) => /по\s+(\d{2})\.(\d{2})\.(\d{4})/i.exec(x)).find(Boolean);
      if (p && !periodTo) periodTo = `${p[3]}-${p[2]}-${p[1]}`;
    }
  } else if (storeCol >= 0) {
    stores = [...new Set(rows.map((x) => x.store).filter(Boolean))];
  }
  return { ok: true, mode, stores, combined: mode === "iiko" && stores.length > 1,
    has_store_col: mode !== "iiko" && storeCol >= 0, has_sum: sumCol >= 0, total, period_to: periodTo,
    rows, warnings, zeros, negatives, blanks };
}

// Склады в названиях сравниваются без регистра и лишних пробелов: в справочнике есть
// «Магазин  кухни» с двойным пробелом, а iiko в шапке отчёта пишет как придётся.
export const sameStore = (a, b) => txt(a).toLowerCase() === txt(b).toLowerCase();
