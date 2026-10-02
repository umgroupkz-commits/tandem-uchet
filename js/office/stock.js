import { api, session, LONG_MS } from "./api.js?v=20";
import { el, fmt, toast, debounce, modal, confirmDlg, today, isoDate, errText, uid } from "./ui.js?v=20";

const TYPES = { invoice_in: "Приход", transfer: "Перемещение", writeoff: "Списание", production: "Производство", inventory: "Инвентаризация", sale: "Продажа" };
// Продажу заводит отчёт точки, а не человек: в «+ Новый документ» её нет.
const MANUAL = Object.keys(TYPES).filter((k) => k !== "sale");
const REASONS = { spoilage: "порча", tasting: "проработка", staff_meals: "питание персонала", other: "прочее" };
const perms = () => (session() && session().permissions) || [];
const canDoc = (type) => perms().includes("doc:" + type + ":edit");
const canAnyDoc = () => MANUAL.some(canDoc);
const canSales = () => perms().includes("doc:sale:view");
let root, stores = [], state = { tab: "docs", doc_type: "", store_id: "", status: "", q: "", date_from: "", date_to: "", page: 1 };
let table, pager;
// Список складов держим полным: выключенный склад должен читаться в карточке старого
// документа и в остатках. Выбирать из него можно только действующие — active().
const active = () => stores.filter((s) => s.active);
const opts = (list) => Object.fromEntries(list.map((s) => [s.id, s.name]));
// Склады, закреплённые за пользователем (пусто — все). Сервер проверяет сам; здесь лишь
// не предлагаем то, что он отклонит.
let myIds = [];
const mine = (list) => myIds.length ? list.filter((s) => myIds.includes(s.id)) : list;
// Номер последнего запроса по вкладке: ответ, обогнанный более новым, не рисуется — иначе при
// быстрой смене фильтра на экране складывались таблицы всех запросов, в том числе устаревших.
const seqs = {};
const nextSeq = (k) => (seqs[k] = (seqs[k] || 0) + 1);
// Вкладка отчёта: строка фильтров строится один раз при открытии вкладки (build), дальше
// обновляется только область результата .out — пересозданное поле теряло фокус посреди ввода.
function tabOut(id, build) {
  const host = document.getElementById(id); if (!host) return null;
  if (!host.firstChild) host.append(...build(), el("div", { class: "out" }));
  return host.querySelector(":scope > .out");
}

export async function mount(r) {
  root = r; state.page = 1;
  stores = (await api("stores_list", {})).stores || [];
  salePoints = null;
  const me = await api("me", {});
  myIds = (me.ok && me.user && me.user.store_ids) || [];
  drawShell();
  // Вкладка помнится между заходами в раздел: грузим её, а не журнал документов (раньше при
  // возврате в «Склад» на вкладке «Остатки» или «Заявки» она оставалась пустой).
  await (LOADERS[state.tab] || loadDocs)();
}
const LOADERS = { docs: loadDocs, bal: loadBalances, sales: loadSales, turn: loadTurnover, ord: loadOrders, c1: loadC1, rep: loadReports, ready: loadReady };
// После проведения, отмены или удаления документа обновляется открытая вкладка. Документ плана
// заявок (source_kind='orders') ставит или снимает строки «готовым со склада» и может оставить
// помеченные к пересчёту продажи — их добирает тот же цикл, что и после ручной правки.
function afterDocChange(d) {
  (LOADERS[state.tab] || loadDocs)();
  if (d && d.source_kind === "orders" && perms().includes("stock:edit")) srResync({ quiet: true });
}

function drawShell() {
  root.innerHTML = "";
  root.append(el("div", { class: "tabs" },
    el("button", { class: state.tab === "docs" ? "" : "ghost", onclick: () => { state.tab = "docs"; drawShell(); loadDocs(); } }, "Документы"),
    el("button", { class: state.tab === "bal" ? "" : "ghost", onclick: () => { state.tab = "bal"; drawShell(); loadBalances(); } }, "Остатки"),
    canSales() ? el("button", { class: state.tab === "sales" ? "" : "ghost", onclick: () => { state.tab = "sales"; drawShell(); loadSales(); } }, "Продажи") : null,
    el("button", { class: state.tab === "turn" ? "" : "ghost", onclick: () => { state.tab = "turn"; drawShell(); loadTurnover(); } }, "Ведомость"),
    perms().includes("doc:transfer:view") ? el("button", { class: state.tab === "ord" ? "" : "ghost", onclick: () => { state.tab = "ord"; drawShell(); loadOrders(); } }, "Заявки") : null,
    canSales() ? el("button", { class: state.tab === "c1" ? "" : "ghost", onclick: () => { state.tab = "c1"; drawShell(); loadC1(); } }, "Расход для 1С") : null,
    canSales() ? el("button", { class: state.tab === "rep" ? "" : "ghost", onclick: () => { state.tab = "rep"; drawShell(); loadReports(); } }, "Отчёты") : null,
    el("button", { class: state.tab === "ready" ? "" : "ghost", onclick: () => { state.tab = "ready"; drawShell(); loadReady(); } }, "Готовность")));
  if (state.tab === "bal") { root.append(el("div", { id: "bal-root" })); return; }
  if (state.tab === "sales") { root.append(el("div", { id: "sales-root" })); return; }
  if (state.tab === "turn") { root.append(el("div", { id: "turn-root" })); return; }
  if (state.tab === "c1") { root.append(el("div", { id: "c1-root" })); return; }
  if (state.tab === "ord") { root.append(el("div", { id: "ord-root" })); return; }
  if (state.tab === "rep") { root.append(el("div", { id: "rep-root" })); return; }
  if (state.tab === "ready") { root.append(el("div", { id: "ready-root" })); return; }
  // Роли без единого doc:*:edit (пока таких нет, но право снимается настройкой) видят
  // журнал и остатки, но пустого выпадающего списка «+ Новый документ…» им не показываем.
  const newBtn = canAnyDoc()
    ? el("select", { onchange: (e) => { if (e.target.value) { editDoc(null, e.target.value); e.target.value = ""; } } },
        el("option", { value: "" }, "+ Новый документ…"),
        ...MANUAL.filter(canDoc).map((k) => el("option", { value: k }, TYPES[k])))
    : null;
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Номер, поставщик, комментарий", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; loadDocs(); }, 300) }),
      sel({ "": "все типы", ...TYPES }, state.doc_type, (v) => { state.doc_type = v; state.page = 1; loadDocs(); }),
      sel({ "": "все склады", ...opts(active()) }, state.store_id, (v) => { state.store_id = v; state.page = 1; loadDocs(); }),
      sel({ "": "все", draft: "черновики", posted: "проведённые" }, state.status, (v) => { state.status = v; state.page = 1; loadDocs(); }),
      el("input", { type: "date", title: "с", value: state.date_from, onchange: debounce((e) => { state.date_from = e.target.value; state.page = 1; loadDocs(); }, 400) }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: state.date_to, onchange: debounce((e) => { state.date_to = e.target.value; state.page = 1; loadDocs(); }, 400) }),
      newBtn),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}
function sel(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

async function loadDocs() {
  const n = nextSeq("docs");
  const r = await api("docs_list", { doc_type: state.doc_type || null, store_id: state.store_id || null, status: state.status || null, q: state.q, date_from: state.date_from || null, date_to: state.date_to || null, page: state.page });
  if (n !== seqs.docs) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Номер", "Тип", "Дата", "Склады / поставщик", "Сумма", "Статус"].map((h, i) => el("th", { class: i === 4 ? "num" : "" }, h))));
  for (const d of r.rows) {
    const who = d.doc_type === "invoice_in" ? `${d.counteragent_name || ""} → ${d.store_to_name || ""}`
      : d.doc_type === "transfer" ? `${d.store_from_name || ""} → ${d.store_to_name || ""}`
      : d.doc_type === "sale" ? `${d.store_from_name || ""} · ${d.comment || ""}` : (d.store_from_name || "");
    table.append(el("tr", { class: "row", onclick: () => editDoc(d.id) },
      el("td", {}, d.number), el("td", {}, TYPES[d.doc_type] || d.doc_type), el("td", {}, d.doc_date), el("td", {}, who),
      el("td", { class: "num" }, d.total_sum != null ? fmt(d.total_sum) : ""),
      el("td", {}, el("span", { class: "badge " + d.status }, d.status === "posted" ? "проведён" : "черновик"))));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Документов нет")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; loadDocs(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; loadDocs(); } }, "→"));
}

// ---------- форма документа ----------
async function editDoc(id, newType) {
  let doc = { doc_type: newType, doc_date: today(), status: "draft", lines: [], consume: [] };
  if (id) { const r = await api("doc_get", { id }); if (!r.ok) { toast(errText(r), "bad"); return; } doc = r.doc; }
  const type = doc.doc_type, posted = doc.status === "posted";
  const isSale = type === "sale";
  const ro = posted || !canDoc(type) || isSale;
  // Форма с вводом по фону не закрывается; «Отмена» при изменениях переспрашивает.
  const m = modal(`${TYPES[type]} ${doc.number || ""}`, { keep: !ro }); m.root.style.maxWidth = "960px";
  // В новом документе выбирать можно только действующие склады; в уже заведённом
  // список полный, иначе выключенный позже склад пропал бы из карточки вместе с именем.
  // «Свой» склад документа (приход — получатель, прочие — источник) — только из закреплённых;
  // куда перемещать — любой действующий.
  const storeOpts = { "": "— склад —", ...opts(doc.id ? stores : active()) };
  const ownOpts = { "": "— склад —", ...opts(doc.id ? stores : mine(active())) };
  const f = {
    date: el("input", { type: "date", value: doc.doc_date, readonly: ro }),
    from: sel(ownOpts, doc.store_from || "", () => {}, ro),
    to: sel(type === "invoice_in" ? ownOpts : storeOpts, doc.store_to || "", () => {}, ro),
    reason: sel({ "": "— причина —", ...REASONS }, doc.reason || "", () => {}, ro),
    comment: el("input", { value: doc.comment || "", readonly: ro }),
    caId: doc.counteragent_id || null,
    ca: el("input", { placeholder: "поставщик: начните вводить", value: doc.counteragent_name || "", readonly: ro }),
    // Реквизиты бумажной накладной поставщика — только у прихода (сервер их и принимает только там).
    ext: el("input", { placeholder: "как в накладной", value: doc.ext_number || "", readonly: ro }),
    extd: el("input", { type: "date", value: doc.ext_date || "", readonly: ro }),
  };
  const caRes = el("div", { class: "sres" });
  f.ca.addEventListener("input", debounce(async () => {
    caRes.innerHTML = ""; f.caId = null; const q = f.ca.value.trim(); if (q.length < 2) return;
    const s = await api("counteragents_list", { q, kind: "supplier" });
    for (const c of (s.rows || []).slice(0, 10)) caRes.append(el("button", { class: "sitem", onclick: () => { f.caId = c.id; f.ca.value = c.name; caRes.innerHTML = ""; } }, c.name));
  }, 300));
  const head = el("div", { class: "grid2" }, el("div", {}, el("label", {}, "Дата"), f.date));
  if (type === "invoice_in") head.append(el("div", {}, el("label", {}, "Склад-получатель"), f.to), el("div", { class: "sbox" }, el("label", {}, "Поставщик"), f.ca, caRes),
    el("div", {}, el("label", {}, "№ накладной поставщика"), f.ext), el("div", {}, el("label", {}, "Дата накладной"), f.extd));
  if (type === "transfer") head.append(el("div", {}, el("label", {}, "Откуда"), f.from), el("div", {}, el("label", {}, "Куда"), f.to));
  if (type === "writeoff") head.append(el("div", {}, el("label", {}, "Склад"), f.from), el("div", {}, el("label", {}, "Причина"), f.reason));
  if (type === "production") head.append(el("div", {}, el("label", {}, "Склад кухни (расход и выпуск)"), f.from));
  if (type === "inventory") head.append(el("div", {}, el("label", {}, "Склад"), f.from));
  if (isSale) head.append(el("div", {}, el("label", {}, "Склад точки"), f.from));
  head.append(el("div", {}, el("label", {}, isSale ? "Источник" : "Комментарий"), f.comment));
  m.root.append(head);
  if (isSale) m.root.append(el("div", { class: "dim", style: "margin-top:6px" },
    "Документ ведёт отчёт точки: он меняется, когда точка правит отчёт. Руками его не правят: если отчёт правили, во вкладке «Продажи» есть «Провести продажи за период»."));
  if (doc.sync_note) m.root.append(el("div", { class: "warnbox", style: "margin-top:8px" }, doc.sync_note));
  // строки
  const lines = doc.lines.map((l) => ({ ...l }));
  const tbl = el("table"); const tot = el("div", { class: "tot" });
  const isInv = type === "inventory", isIn = type === "invoice_in";
  // Ячейки сумм, которые пересчитываются при вводе; перерисовки таблицы не требуют.
  let sumCells = [];
  // Ввод в строке меняет только свою ячейку суммы и итог. Раньше здесь была полная
  // перерисовка таблицы на каждый input: браузер пересоздавал поле, и при наборе «10.5»
  // каретка прыгала в начало, а незавершённое число («10.») терялось. Восстановление
  // фокуса ниже оставлено как страховка на перерисовки от добавления/удаления строк.
  function refreshSums() {
    let sum = 0;
    for (const c of sumCells) {
      if (c.live) {
        const q = Number(isInv ? c.l.fact_qty : c.l.qty) || 0, p = Number(c.l.price) || 0;
        c.td.textContent = fmt(q * p); sum += q * p;
      } else sum += Number(c.l.sum || 0);
    }
    tot.innerHTML = ""; tot.append(el("span", {}, posted ? (isSale ? "Себестоимость проданного" : "Сумма документа") : (isIn ? "Сумма" : "Строк")), el("span", {}, posted || isIn ? fmt(posted ? doc.total_sum : sum) + " ₸" : String(lines.length)));
  }
  // Любая перерисовка после первой — добавление или удаление строк: форма изменена.
  let drawn = false;
  function drawLines() {
    if (drawn) m.dirty = true; drawn = true;
    const ae = document.activeElement; const keep = ae && ae.dataset && ae.dataset.li != null ? { li: ae.dataset.li, key: ae.dataset.key } : null;
    tbl.innerHTML = ""; sumCells = [];
    const cols = ["Позиция", "Ед.", isInv ? "Факт" : "Кол-во"]; if (isInv && posted) cols.push("Расчёт", "Разница"); if (isIn) cols.push("Цена", "Сумма"); if (posted && !isIn && !isInv) cols.push(isSale ? "Цена продажи" : "Себест.", isSale ? "Выручка" : "Сумма"); if (isInv && posted) cols.push("Сумма"); cols.push("");
    tbl.append(el("tr", {}, ...cols.map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    lines.forEach((l, idx) => {
      const q = Number(isInv ? l.fact_qty : l.qty) || 0, p = Number(l.price) || 0;
      const inp = (key) => el("input", { type: "number", step: "0.001", value: l[key] ?? "", readonly: ro, "data-li": String(idx), "data-key": key, style: "text-align:right;padding:6px", oninput: (e) => { l[key] = e.target.value; refreshSums(); } });
      const tds = [el("td", {}, l.name, isInv && !posted && l.current_qty != null ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, "расчёт: " + fmt(l.current_qty)) : null), el("td", {}, l.unit_id || ""), el("td", { class: "num" }, inp(isInv ? "fact_qty" : "qty"))];
      if (isInv && posted) tds.push(el("td", { class: "num" }, fmt(l.calc_qty)), el("td", { class: "num" }, fmt(q - Number(l.calc_qty || 0))));
      if (isIn) { const sc = el("td", { class: "num" }, fmt(q * p)); tds.push(el("td", { class: "num" }, inp("price")), sc); sumCells.push({ l, td: sc, live: true }); }
      if (posted && !isIn && !isInv) { tds.push(el("td", { class: "num" }, fmt(l.price)), el("td", { class: "num" }, fmt(l.sum))); sumCells.push({ l, live: false }); }
      if (isInv && posted) { tds.push(el("td", { class: "num" }, fmt(l.sum))); sumCells.push({ l, live: false }); }
      tds.push(el("td", {}, ro ? null : el("button", { class: "x", onclick: () => { lines.splice(idx, 1); drawLines(); } }, "×")));
      tbl.append(el("tr", {}, ...tds));
    });
    refreshSums();
    if (keep) { const n = tbl.querySelector(`input[data-li="${keep.li}"][data-key="${keep.key}"]`); if (n) n.focus(); }
  }
  drawLines();
  // Итог загрузки из файла живёт под таблицей: сводка и список ненайденных строк.
  const warn = el("div", { hidden: true });
  m.root.append(el("h2", { style: "margin-top:14px" }, isInv ? "Позиции и факт" : (type === "production" ? "Выпуск" : isSale ? "Продано по отчёту" : "Строки")), tbl, tot, warn);

  async function fillFromBalances() {
    const st = f.from.value; if (!st) { toast("Сначала выберите склад", "bad"); return; }
    let page = 1, pages = 1;
    do {
      const b = await api("stock_balances", { store_id: st, only_nonzero: true, page });
      if (!b.ok) { toast(errText(b), "bad"); return; }
      for (const x of (b.rows || [])) if (!lines.some((l) => l.item_code === x.item_code)) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "", current_qty: x.qty });
      pages = b.pages || 1; page++;
    } while (page <= pages);
    drawLines();
  }

  // Загрузка факта из файла остатков iiko. Разбор вынесен в parseStockFile — форма выбирает
  // лист (оборотка iiko приходит книгой: лист на фильтр складов), подтверждает сводный лист,
  // зовёт сопоставление и правит строки. Документ не сохраняется и не проводится: человек
  // смотрит итог и решает сам.
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
    let rows = sh.rows;
    if (sh.has_store_col && sh.stores.length > 1) {
      const pick = await pickStore(sh.stores);
      if (!pick) return;
      rows = rows.filter((x) => x.store === pick);
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
    // Одна позиция может прийти файлом несколькими строками (разные группы отчёта) — складываем.
    const got = new Map(), miss = [];
    rows.forEach((row, i) => {
      const it = found.get(i);
      if (!it) { if (row.qty > 0) miss.push(row); return; }   // ненайденный ноль грузить некуда и незачем
      const prev = got.get(it.item_code);
      if (prev) prev.qty += row.qty; else got.set(it.item_code, { it, qty: row.qty });
    });
    for (const [itemCode, v] of got) {
      const val = String(Math.round(v.qty * 1000) / 1000);
      const line = lines.find((l) => l.item_code === itemCode);
      if (line) line.fact_qty = val;
      else lines.push({ item_code: itemCode, name: v.it.name, unit_id: v.it.unit_id, qty: "", fact_qty: val, price: "" });
    }
    drawLines();
    warn.className = "warnbox"; warn.hidden = false; warn.innerHTML = "";
    warn.append(el("div", {}, `Лист «${sh.sheet}»: загружено ${got.size}, не найдено ${miss.length}`
      + (sh.zeros ? `, нулевых ${sh.zeros}` : "") + (sh.blanks ? `, пропущено без количества ${sh.blanks}` : "")));
    for (const w of sh.warnings) warn.append(el("div", { class: "dim" }, w));
    if (sh.combined) warn.append(el("div", {}, `Лист сводный (${sh.stores.join(", ")}) — всё загружено на склад «${store.name}»`));
    if (sh.negatives.length) warn.append(el("details", {},
      el("summary", {}, `В iiko минус у ${sh.negatives.length} поз. — факт поставлен 0`),
      el("div", { class: "dim" }, sh.negatives.map((x) => `${x.name} (${fmt(x.qty)})`).join("; "))));
    if (miss.length) {
      const mt = el("table");
      mt.append(el("tr", {}, ...["Не найдено в номенклатуре", "Код", "Кол-во"].map((h, i) => el("th", { class: i === 2 ? "num" : "" }, h))));
      for (const w of miss) mt.append(el("tr", {}, el("td", {}, w.name), el("td", {}, w.code), el("td", { class: "num" }, fmt(w.qty))));
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
    const search = el("input", { placeholder: "Добавить позицию: название или код", "data-nodirty": "" }); const res = el("div", { class: "sres" });
    search.addEventListener("input", debounce(async () => {
      res.innerHTML = ""; const q = search.value.trim(); if (q.length < 2) return;
      const s = await api("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).slice(0, 12)) {
        if (type === "production" && !["dish", "prepared"].includes(it.item_type)) continue;
        if (lines.some((l) => l.item_code === it.code)) continue;
        res.append(el("button", { class: "sitem", onclick: () => { lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", fact_qty: "", price: "" }); search.value = ""; res.innerHTML = ""; drawLines(); } },
          it.name, el("span", { class: "dim" }, ` · ${it.unit_id}`)));
      }
    }, 300));
    const tools = el("div", { class: "sbox", style: "margin-top:10px" }, search, res);
    if (isInv) {
      // Файл выбирается скрытым input'ом: своя кнопка рядом с «заполнить с остатком» читается
      // лучше, чем системный «Обзор…», и остаётся на месте после каждой загрузки.
      const file = el("input", { type: "file", accept: ".xlsx,.xls", style: "display:none",
        onchange: (e) => { const x = e.target.files[0]; e.target.value = ""; if (x) importFact(x); } });
      tools.prepend(el("div", { style: "margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap" },
        el("button", { class: "ghost small", onclick: fillFromBalances }, "Заполнить позициями с остатком"),
        el("button", { class: "ghost small", onclick: () => file.click() }, "Загрузить факт из файла"),
        file));
    }
    m.root.append(tools);
  }
  if (doc.consume && doc.consume.length) {
    const ct = el("table"); ct.append(el("tr", {}, ...["Расход сырья", "Ед.", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    for (const c of doc.consume) ct.append(el("tr", {}, el("td", {}, c.name), el("td", {}, c.unit_id), el("td", { class: "num" }, fmt(c.qty)), el("td", { class: "num" }, fmt(c.price)), el("td", { class: "num" }, fmt(c.sum))));
    m.root.append(el("h2", { style: "margin-top:14px" }, isSale ? "Списано со склада (по техкартам и как есть)" : "Списано по техкартам"), ct);
  }
  const err = el("div", { class: "err" }); const actions = el("div", { class: "actions" });
  // Ключ повтора нового документа (контракт п. 8) — один на открытую форму: если ответ на первое
  // сохранение потерялся и человек нажал ещё раз, сервер узнает документ по ключу и не заведёт второй.
  const clientKey = doc.id ? undefined : uid();
  const payload = () => ({ id: doc.id, client_key: clientKey, doc_type: type, doc_date: f.date.value, store_from: f.from.value || null, store_to: f.to.value || null,
    counteragent_id: f.caId, reason: f.reason.value || null, comment: f.comment.value,
    ext_number: f.ext.value.trim() || null, ext_date: f.extd.value || null,
    lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty === "" ? null : l.qty, fact_qty: l.fact_qty === "" ? null : l.fact_qty, price: l.price === "" ? null : l.price })) });
  // Один запрос сохранения за раз: повторное нажатие (двойной щелчок, медленная связь) ждёт уже
  // идущий и получает тот же id, а не создаёт второй документ. Кнопки на время запроса выключены.
  let saving = null;
  function save() {
    if (!saving) saving = (async () => {
      err.textContent = "";
      const r = await api("doc_save", payload());
      if (!r.ok) { err.textContent = errText(r); return null; }
      doc.id = r.id; doc.number = r.number; return r.id;
    })().finally(() => { saving = null; });
    return saving;
  }
  const draftBtn = el("button", { class: "ghost" }, "Сохранить черновик"), postBtn = el("button", {}, "Провести");
  const busy = (on) => { draftBtn.disabled = postBtn.disabled = on; };
  async function post() {
    busy(true);
    try {
      const id = await save(); if (!id) return;
      const pv = await api("doc_preview", { id }); if (!pv.ok) { err.textContent = errText(pv); return; }
      const box = el("div", {});
      if (pv.consume.length) box.append(el("div", { class: "dim" }, "Будет списано: " + pv.consume.map((c) => `${c.name} ${fmt(c.qty)} ${c.unit_id}`).join(", ")));
      if (pv.warnings.length) box.append(el("div", { class: "warnbox" }, "Уйдут в минус: " + pv.warnings.map((w) => `${w.name} (${w.store_name}) → ${fmt(w.balance_after)}`).join("; ")));
      const cm = modal("Провести документ?"); cm.root.append(box, el("div", { class: "actions" },
        el("button", { onclick: async () => {
          cm.close(); busy(true);
          const r = await api("doc_post", { id });
          busy(false);
          if (!r.ok) { err.textContent = errText(r); return; }
          toast("Проведено" + (r.warnings.length ? " — есть минусы" : "")); m.close(); afterDocChange(doc);
        } }, "Провести"),
        el("button", { class: "ghost", onclick: cm.close }, "Отмена")));
    } finally { busy(false); }
  }
  draftBtn.onclick = async () => { busy(true); const id = await save(); busy(false); if (id) { toast("Черновик сохранён"); m.close(); (LOADERS[state.tab] || loadDocs)(); } };
  postBtn.onclick = post;
  if (!ro) actions.append(draftBtn, postBtn);
  if (posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async (e) => {
    if (!confirmDlg("Отменить проведение?")) return;
    e.target.disabled = true;
    const r = await api("doc_unpost", { id: doc.id });
    e.target.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    const hasWarn = r.warnings && r.warnings.length;
    toast("Проведение отменено" + (hasWarn ? " — в минусе: " + r.warnings.map((w) => `${w.name} (${w.store_name}) ${fmt(w.balance_after)}`).join("; ") : ""), hasWarn ? "bad" : "ok");
    m.close(); afterDocChange(doc);
  } }, "Отменить проведение"));
  if (doc.id && !posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async (e) => {
    if (!confirmDlg("Удалить черновик?")) return;
    e.target.disabled = true;
    const r = await api("doc_delete", { id: doc.id });
    e.target.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; } toast("Удалено"); m.close(); afterDocChange(null); } }, "Удалить"));
  actions.append(el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);
}

// ---------- остатки ----------
let bal = { store_id: "", q: "", nonzero: true, page: 1 };
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
  out.parentNode.querySelector(".bal-sum").textContent = `итого ${fmt(r.total_sum)} ₸`;
  const t = el("table"); t.append(el("tr", {}, ...["Склад", "Позиция", "Ед.", "Кол-во", "Средняя", "Сумма"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) t.append(el("tr", { class: "row", onclick: () => showMoves(x) }, el("td", { class: "dim" }, x.store_name), el("td", {}, x.name), el("td", {}, x.unit_id),
    el("td", { class: "num" + (Number(x.qty) < 0 ? " bad" : "") }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.avg_cost)), el("td", { class: "num" }, fmt(x.sum))));
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Остатков нет — проведите первую инвентаризацию или приход")));
  out.innerHTML = "";
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "pager" }, `всего ${r.total} · стр. ${r.page} из ${r.pages}`,
      el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { bal.page--; loadBalances(); } }, "←"),
      el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { bal.page++; loadBalances(); } }, "→")));
}
async function showMoves(x) {
  const r = await api("stock_moves", { store_id: x.store_id, item_code: x.item_code, page: 1 });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const m = modal(`${x.name} · ${x.store_name}`);
  const t = el("table"); t.append(el("tr", {}, ...["Дата", "Документ", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
  // Строка без количества (qty = 0) — переоценка: приход на склад, ушедший в минус, переоценил
  // недостающее по своей цене; её сумма — поправка стоимости остатка (adj).
  let reval = false;
  for (const mv of (r.rows || [])) {
    const isReval = Number(mv.qty) === 0; reval = reval || isReval;
    t.append(el("tr", { class: "row", onclick: () => { m.close(); editDoc(mv.document_id); } }, el("td", {}, mv.move_date), el("td", {}, `${TYPES[mv.doc_type] || mv.doc_type} ${mv.number}`),
      isReval ? el("td", { class: "num dim" }, "переоценка") : el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty)),
      el("td", { class: "num" }, isReval ? "" : fmt(mv.unit_cost)), el("td", { class: "num" }, fmt(isReval && mv.adj != null ? mv.adj : mv.sum))));
  }
  m.root.append(t, reval ? el("div", { class: "dim", style: "margin-top:8px" }, "«Переоценка» — поправка стоимости без количества: приход на склад, ушедший в минус, пересчитал недостающее по цене прихода.") : null,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
}

// ---------- разбор файла остатков ----------
// ---------- продажи: отчёты точек и их складские документы ----------
const iso = isoDate;
// Даты по умолчанию («последняя неделя», «с начала месяца», «завтра») считаются при открытии
// вкладки, а не при загрузке модуля, — пока человек их не менял (auto): вкладка, открытая
// вчера утром, иначе показывала бы вчерашние «сегодня» и «завтра».
const monthStart = () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12));
const tomorrow = () => iso(new Date(Date.now() + 86400e3));
const sales = { date_from: "", date_to: "", auto: true, point_id: "" };
// Точки фильтра — из справочника точек, а не из строк ответа: раньше после пустого периода в
// списке оставалось только «все точки», а фильтром по-прежнему уходила выбранная точка (и
// «Провести продажи за период» шла только по ней). Справочник читается раз на заход в раздел.
let salePoints = null;
const SALE_STATE = {
  posted: ["проведена", "ok"], none: ["нет продаж с кодом", ""], no_store: ["у точки нет склада", "bad"],
  locked: ["изменён после инвентаризации", "bad"], draft: ["не проведена", "bad"],
  pending: ["не проведена — нажмите «Провести продажи за период»", "bad"], stale: ["устарела — проведите заново", "bad"],
};
async function loadSales() {
  if (!document.getElementById("sales-root")) return;
  if (!salePoints) { const p = await api("store_points_list", {}); salePoints = p.ok ? p.points : []; }
  if (sales.point_id && !salePoints.some((x) => x.id === sales.point_id)) sales.point_id = "";
  const out = tabOut("sales-root", () => {
    if (sales.auto) { sales.date_from = iso(new Date(Date.now() - 7 * 864e5)); sales.date_to = today(); }
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
      el("input", { type: "date", title: "с", value: sales.date_from, onchange: debounce((e) => { sales.date_from = e.target.value; sales.auto = false; loadSales(); }, 400) }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: sales.date_to, onchange: debounce((e) => { sales.date_to = e.target.value; sales.auto = false; loadSales(); }, 400) }),
      sel({ "": "все точки", ...Object.fromEntries(salePoints.map((x) => [x.id, x.name + (x.active ? "" : " (выключена)")])) }, sales.point_id, (v) => { sales.point_id = v; loadSales(); }),
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
      el("td", {}, x.report_date), el("td", {}, x.point_name), el("td", {}, x.store_name || el("span", { class: "dim" }, "—")),
      el("td", { class: "num" }, String(x.lines)), el("td", { class: "num" }, fmt(x.money)),
      el("td", { class: "num" }, x.sale_sum != null ? fmt(x.sale_sum) : ""), el("td", { class: "num" }, x.cost != null ? fmt(x.cost) : ""),
      el("td", {}, x.number || ""),
      el("td", {}, el("span", { class: "tag " + cls }, label), x.sync_note ? el("div", { class: "dim", style: "font-size:12px;max-width:320px" }, x.sync_note) : null)));
  }
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "За период отчётов точек нет")));
  // Итоги по проведённым продажам: выручка, себестоимость, валовая прибыль, фудкост.
  const sum = await api("doc_sales_report", period);
  if (n !== seqs.sales) return;
  if (sum.ok && sum.points.length) {
    const pct = (v) => v == null ? "" : fmt(v) + " %";
    const pt = el("table");
    pt.append(el("tr", {}, ...["Точка", "Продаж", "Выручка", "Себестоимость", "Валовая прибыль", "Фудкост"].map((h, i) => el("th", { class: i ? "num" : "" }, h))));
    for (const x of sum.points) pt.append(el("tr", {}, el("td", {}, x.point_name), el("td", { class: "num" }, String(x.docs)),
      el("td", { class: "num" }, fmt(x.revenue)), el("td", { class: "num" }, fmt(x.cost)), el("td", { class: "num" }, fmt(x.margin)), el("td", { class: "num" }, pct(x.foodcost_pct))));
    const it = el("table");
    it.append(el("tr", {}, ...["Позиция", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост"].map((h, i) => el("th", { class: i ? "num" : "" }, h))));
    for (const x of sum.items.slice(0, 30)) it.append(el("tr", {}, el("td", {}, x.name), el("td", { class: "num" }, fmt(x.qty) + " " + (x.unit_id || "")),
      el("td", { class: "num" }, fmt(x.revenue)), el("td", { class: "num" }, fmt(x.cost)), el("td", { class: "num" }, fmt(x.margin)),
      el("td", { class: "num" }, x.foodcost_pct == null ? "" : el("span", { class: "tag " + (x.foodcost_pct > 35 ? "bad" : "ok") }, pct(x.foodcost_pct)))));
    out.append(el("h2", { style: "margin-top:4px" }, "Итоги по проведённым продажам"),
      el("div", { class: "card", style: "padding:0;overflow:auto" }, pt),
      el("details", { style: "margin:8px 0 14px" }, el("summary", {}, `Позиции по выручке (${Math.min(sum.items.length, 30)} из ${sum.items.length})`),
        el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, it)),
      el("h2", {}, "Отчёты точек"));
  }
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "dim", style: "margin-top:8px" },
      "Продажа проводится сама, когда точка сохраняет отчёт. «Провести продажи за период» нужна, если склад точке привязали позже или отчёт правили."));
}

// ---------- оборотная ведомость склада ----------
// Аналог «Расширенной оборотно-сальдовой ведомости» iiko: по позиции остаток на начало,
// обороты по видам документов и остаток на конец. Нужна для сверки с iiko в параллельной работе.
const turn = { store_id: "", date_from: "", date_to: "", auto: true, q: "" };
const TURN_COLS = [["start_qty", "Начало"], ["income", "Приход"], ["transfer_in", "Перемещ. +"], ["transfer_out", "Перемещ. −"],
  ["production_in", "Произв. +"], ["production_out", "Произв. −"], ["sales", "Продажи"], ["writeoff", "Списания"],
  ["inventory", "Инвент. ±"], ["end_qty", "Конец"], ["end_sum", "Сумма на конец"]];
async function loadTurnover() {
  const out = tabOut("turn-root", () => {
    if (turn.auto) { turn.date_from = monthStart(); turn.date_to = today(); }
    return [el("div", { class: "tools" },
      sel({ "": myIds.length ? "мои склады вместе" : "все склады вместе", ...opts(mine(stores)) }, turn.store_id, (v) => { turn.store_id = v; loadTurnover(); }),
      el("input", { type: "date", title: "с", value: turn.date_from, onchange: debounce((e) => { turn.date_from = e.target.value; turn.auto = false; loadTurnover(); }, 400) }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: turn.date_to, onchange: debounce((e) => { turn.date_to = e.target.value; turn.auto = false; loadTurnover(); }, 400) }),
      el("input", { placeholder: "Позиция или код", value: turn.q, oninput: debounce((e) => { turn.q = e.target.value; loadTurnover(); }, 400) }),
      el("button", { class: "ghost csv" }, "Скачать CSV"))];
  });
  if (!out) return;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("turn");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
  const r = await api("stock_turnover_report", { store_id: turn.store_id || null, date_from: turn.date_from, date_to: turn.date_to, q: turn.q });
  if (n !== seqs.turn) return;
  out.innerHTML = "";
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  // Переоценка (reval_sum, ₸) — поправка стоимости без количества: приход на ушедший в минус остаток
  // пересчитывает недостающее по своей цене. Колонка появляется, только если она где-то есть;
  // суммы на начало и конец её уже включают.
  const hasReval = r.rows.some((x) => Number(x.reval_sum || 0) !== 0);
  const cols = hasReval ? [...TURN_COLS.slice(0, -1), ["reval_sum", "Переоценка, ₸"], TURN_COLS[TURN_COLS.length - 1]] : TURN_COLS;
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Ед."), ...cols.map(([, h]) => el("th", { class: "num" }, h))));
  let group = null; const tot = { start_sum: 0, income_sum: 0, sales_sum: 0, writeoff_sum: 0, inventory_sum: 0, reval_sum: 0, end_sum: 0 };
  for (const x of r.rows) {
    if ((x.group_name || "") !== group) { group = x.group_name || ""; t.append(el("tr", {}, el("td", { colspan: 2 + cols.length, class: "dim", style: "font-weight:700;padding-top:10px" }, group || "без группы"))); }
    for (const k of Object.keys(tot)) tot[k] += Number(x[k] || 0);
    t.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""),
      ...cols.map(([k]) => { const v = Number(x[k] || 0); return el("td", { class: "num" + (k === "end_qty" && v < 0 ? " bad" : "") }, v ? fmt(v) : ""); })));
  }
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 2 + cols.length, class: "dim" }, "За период движений нет")));
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "tot" }, el("span", {}, `Позиций ${r.rows.length} · сумма на начало ${fmt(tot.start_sum)} · приход ${fmt(tot.income_sum)} · продажи ${fmt(tot.sales_sum)} · списания ${fmt(tot.writeoff_sum)} · инвентаризация ${fmt(tot.inventory_sum)}`
      + (hasReval ? ` · переоценка ${fmt(tot.reval_sum)}` : "")),
      el("span", {}, `на конец ${fmt(tot.end_sum)} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Суммы — по себестоимости движений, как «Сумма с/н» в оборотной ведомости iiko. Расход показан положительными числами."
      + (hasReval ? " «Переоценка» — поправка стоимости без количества: приход на склад, ушедший в минус, пересчитал недостающее по цене прихода; суммы на начало и конец её включают." : "")));
  const period = { from: turn.date_from, to: turn.date_to };
  csvBtn.onclick = () => {
    const head = ["Код", "Позиция", "Ед.", "Группа", ...cols.map(([, h]) => h)];
    const lines = [head, ...r.rows.map((x) => [x.item_code, x.name, x.unit_id || "", x.group_name || "", ...cols.map(([k]) => String(x[k] ?? 0).replace(".", ","))])]
      .map((row) => row.map((v) => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" }));
    a.download = `ведомость ${period.from}—${period.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// ---------- заявки точек и сводный план выпечки (миграция 0038) ----------
// Точки подают заявки на завтра со страницы order.html до отсечки. Здесь — сводный план дня: сколько
// заказано по позициям и точкам, факт выпуска (отмечает пекарь), и одной кнопкой черновики акта
// производства на склад кухни и перемещений на склады точек.
const ord = { date: "", auto: true };
async function loadOrders() {
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
  const [y, mo, dd] = String(day).split("-");
  out.append(el("h3", { style: "margin:0 0 8px" }, `План выпечки на ${dd}.${mo}.${y}` + (day === tomorrow() ? " (завтра)" : day === today() ? " (сегодня)" : "")));
  const kitchen = stores.find((s) => s.id === r.store_id);
  // Настройки: склад кухни и отсечка — только у тех, кто правит склады.
  if (perms().includes("stores:edit")) {
    const ks = sel({ "": "— склад кухни не выбран —", ...opts(active()) }, r.store_id || "", () => {});
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
// плана (перемещение на точку, производство на склад кухни, который и есть склад точки) и снимает
// отмена их проведения; здесь их видно и можно поправить руками.
const SR_SOURCE = { manual: "вручную", office: "вручную", plan: "по плану", orders: "по плану", auto: "по плану" };
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
function srResync(o = {}) {
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
      + "Строки «по плану» появляются, когда проведены документы плана (производство и перемещения), и снимаются отменой их проведения; здесь строки можно добавить или убрать. "
      + "После правки продажи склада с этой даты пересчитываются — частями, ход пересчёта виден здесь же. Если закрыть страницу раньше, остаток пересчитается при «Провести продажи за период»."),
    el("div", { class: "tools" },
      // Склады — только закреплённые за пользователем, как в «Остатках»: по чужим сервер откажет.
      sel({ "": myIds.length ? "мои склады" : "все склады", ...opts(mine(stores)) }, sr.store_id, (v) => { sr.store_id = v; loadStoreReady(); }),
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
    el("td", {}, x.date_from), el("td", { class: "dim" }, SR_SOURCE[x.source] || x.source || ""),
    el("td", {}, canEdit ? el("button", { class: "x", title: "Убрать", onclick: (e) => delStoreReady(x, e.target) }, "×") : null)));
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
    const s = await api("items_search", { q, active: true, page: 1 });
    for (const it of (s.rows || []).slice(0, 12)) {
      if (!["dish", "prepared"].includes(it.item_type)) continue;   // товар и так продаётся как есть
      res.append(el("button", { class: "sitem", onclick: () => { item = it; search.value = it.name; res.innerHTML = ""; } },
        it.name, el("span", { class: "dim" }, ` · ${it.unit_id}`)));
    }
  }, 300));
  const st = sel({ "": "— склад —", ...opts(mine(active())) }, sr.store_id, () => {});
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
const c1 = { store_id: "", date_from: "", date_to: "", auto: true, catalog: null };
async function loadC1() {
  const out = tabOut("c1-root", () => {
    if (c1.auto) { c1.date_from = monthStart(); c1.date_to = today(); }
    return [el("div", { class: "tools" },
      sel({ "": myIds.length ? "мои склады вместе" : "все склады вместе", ...opts(mine(stores)) }, c1.store_id, (v) => { c1.store_id = v; loadC1(); }),
      el("input", { type: "date", title: "с", value: c1.date_from, onchange: debounce((e) => { c1.date_from = e.target.value; c1.auto = false; loadC1(); }, 400) }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: c1.date_to, onchange: debounce((e) => { c1.date_to = e.target.value; c1.auto = false; loadC1(); }, 400) }),
      el("button", { class: "ghost csv" }, "Скачать для 1С (CSV)"))];
  });
  if (!out) return;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("c1");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
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
  const groups = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const free = r.rows.filter((x) => !x.code_1c || x.qty_1c === null);
  const canEdit = perms().includes("doc:sale:edit");
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Код 1С"), el("th", {}, "Номенклатура 1С"), el("th", {}, "Счёт"), el("th", {}, "Ед."),
    el("th", { class: "num" }, "Списать"), el("th", { class: "num" }, "Себестоимость, ₸"), el("th", {}, "Из позиций учёта")));
  let total = 0;
  for (const g of groups) {
    total += g.sum;
    t.append(el("tr", {}, el("td", {}, g.code), el("td", {}, g.name), el("td", {}, g.account || ""), el("td", {}, g.unit || ""),
      el("td", { class: "num" }, fmt(Math.round(g.qty * 1000) / 1000)), el("td", { class: "num" }, fmt(g.sum)),
      el("td", { class: "dim" }, ...g.src.map((x, j) => el("span", {}, j ? "; " : "",
        canEdit ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); linkC1(x); } }, x.name) : x.name,
        ` ${fmt(x.qty)} ${x.unit_id || ""}`)))));
  }
  if (!groups.length) t.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "За период расхода по позициям с кодом 1С нет")));
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "tot" }, el("span", {}, `Позиций 1С: ${groups.length}`), el("span", {}, `${fmt(total)} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Расход проведённых продаж и актов производства, кроме полуфабрикатов и выпечки с кухни, проданной готовой: 1С знает сырьё, из которого они сделаны. Себестоимость — по нашему складу; в акте 1С сумму поставит сама 1С по своим ценам."));
  if (free.length) {
    const ft = el("table");
    ft.append(el("tr", {}, el("th", {}, "Позиция учёта"), el("th", {}, "Ед."), el("th", { class: "num" }, "Расход"), el("th", { class: "num" }, "₸"), canEdit ? el("th", {}, "") : null));
    for (const x of free) ft.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""), el("td", { class: "num" }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.sum)),
      canEdit ? el("td", {}, el("button", { class: "ghost", onclick: () => linkC1(x) }, "Указать позицию 1С")) : null));
    out.append(el("h3", { style: "margin-top:18px" }, `Без позиции 1С: ${free.length}`),
      el("div", { class: "dim" }, "Эти продукты расходовались, но не связаны с 1С — в список на списание не попали. Если такого товара в 1С нет (не было прихода по документам), списать его в 1С нельзя."),
      el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, ft));
  }
  const period = { from: c1.date_from, to: c1.date_to };
  csvBtn.onclick = () => {
    const q = (v) => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [["Код 1С", "Номенклатура 1С", "Счёт", "Ед.", "Количество", "Себестоимость учёта, ₸"],
      ...groups.map((g) => [g.code, g.name, g.account || "", g.unit || "", String(Math.round(g.qty * 1000) / 1000).replace(".", ","), String(g.sum).replace(".", ",")])]
      .map((row) => row.map(q).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" }));
    a.download = `расход для 1С ${period.from}—${period.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}
function linkC1(x) {
  const m = modal("Позиция 1С для «" + x.name + "»", { keep: true });
  const label = (c) => c.code + " · " + c.name + " · " + (c.unit || "");
  const list = el("datalist", { id: "c1-cat" }, ...(c1.catalog || []).map((c) => el("option", { value: label(c) })));
  const cur = (c1.catalog || []).find((c) => c.code === x.code_1c);
  const pick = el("input", { list: "c1-cat", placeholder: "Начните вводить название из 1С", value: cur ? label(cur) : "" });
  const k = el("input", { inputmode: "decimal", value: x.k_1c ?? "1" });
  const err = el("div", { class: "err" });
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

// ---------- отчёты как в iiko: прибыль по точкам, закупки, продажи по блюдам ----------
const rep = { kind: "pnl", store_id: "", point_id: "", date_from: "", date_to: "", auto: true };
function csvDownload(name, period, head, rows) {
  const q = (v) => /[;"\n]/.test(String(v ?? "")) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? "");
  const n = (v) => typeof v === "number" ? String(v).replace(".", ",") : v;
  const text = [head, ...rows].map((r) => r.map((v) => q(n(v))).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  a.download = `${name} ${period.date_from}—${period.date_to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function loadReports() {
  const KINDS = { pnl: "Прибыль по точкам", purchases: "Закупки", dishes: "Продажи по блюдам" };
  const out = tabOut("rep-root", () => {
    if (rep.auto) { rep.date_from = monthStart(); rep.date_to = today(); }
    return [el("div", { class: "tools" },
      // Вид отчёта меняет и строку фильтров (склад есть только у закупок) — её строим заново.
      sel(KINDS, rep.kind, (v) => { rep.kind = v; const h = document.getElementById("rep-root"); if (h) h.innerHTML = ""; loadReports(); }),
      rep.kind === "purchases" ? sel({ "": myIds.length ? "мои склады" : "все склады", ...opts(mine(stores)) }, rep.store_id, (v) => { rep.store_id = v; loadReports(); }) : null,
      el("input", { type: "date", title: "с", value: rep.date_from, onchange: debounce((e) => { rep.date_from = e.target.value; rep.auto = false; loadReports(); }, 400) }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: rep.date_to, onchange: debounce((e) => { rep.date_to = e.target.value; rep.auto = false; loadReports(); }, 400) }),
      el("button", { class: "ghost csv" }, "Скачать CSV"))];
  });
  if (!out) return;
  const csvBtn = out.parentNode.querySelector(".csv"); csvBtn.onclick = null;
  const n = nextSeq("rep");
  out.innerHTML = ""; out.append(el("div", { class: "dim" }, "Считаю…"));
  const period = { date_from: rep.date_from, date_to: rep.date_to };
  const th = (h, i) => el("th", { class: i ? "num" : "" }, h);
  const t = el("table");
  if (rep.kind === "pnl") {
    // Прошлый период той же длины, вплотную перед выбранным: чтобы видеть, растёт точка или падает.
    const d1 = new Date(rep.date_from + "T12:00:00"), d2 = new Date(rep.date_to + "T12:00:00");
    const len = Math.round((d2 - d1) / 86400e3) + 1;
    const prev = { date_from: isoDate(new Date(d1.getTime() - len * 86400e3)), date_to: isoDate(new Date(d1.getTime() - 86400e3)) };
    const [r, rp] = await Promise.all([api("stock_pnl_report", period), api("stock_pnl_report", prev)]);
    if (n !== seqs.rep) return;
    out.innerHTML = "";
    const pv = new Map(((rp.ok && rp.rows) || []).map((x) => [x.point_id ?? "", x]));
    const delta = (now, was) => { if (!was) return ""; const p = Math.round((now - was) / Math.abs(was) * 100); return (p > 0 ? "+" : "") + p + " %"; };
    if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
    t.append(el("tr", {}, ...["Точка", "Выручка", "Себестоимость проданного", "Валовая прибыль", "Фудкост", "Списания", "Инвентаризация ±", "Итог по продуктам", "Выручка к прошлому периоду"].map(th)));
    const tot = { revenue: 0, cost: 0, writeoff: 0, inventory: 0, reval: 0 };
    const res = (x) => x.revenue - x.cost - x.writeoff + x.inventory;
    // reval — переоценка проданного в минус (−сумма поправок стоимости по складам точки за период):
    // она уже входит в себестоимость, ячейку помечаем звёздочкой и поясняем под таблицей.
    const rv = (x) => Number(x.reval || 0);
    const costCell = (x) => rv(x) ? el("td", { class: "num", title: "в том числе переоценка " + fmt(rv(x)) + " ₸" }, fmt(x.cost) + " *") : el("td", { class: "num" }, fmt(x.cost));
    for (const x of r.rows) {
      for (const k of Object.keys(tot)) tot[k] += Number(x[k] || 0);
      t.append(el("tr", {}, el("td", {}, x.point_name), el("td", { class: "num" }, fmt(x.revenue)), costCell(x),
        el("td", { class: "num" }, fmt(x.revenue - x.cost)), el("td", { class: "num" }, x.revenue ? fmt(Math.round(x.cost / x.revenue * 1000) / 10) + " %" : ""),
        el("td", { class: "num" }, fmt(x.writeoff)), el("td", { class: "num" + (x.inventory < 0 ? " bad" : "") }, fmt(x.inventory)),
        el("td", { class: "num", style: "font-weight:700" }, fmt(res(x))),
        el("td", { class: "num", title: "Прошлый период: " + prev.date_from + " — " + prev.date_to }, delta(Number(x.revenue), pv.has(x.point_id ?? "") ? Number(pv.get(x.point_id ?? "").revenue) : 0))));
    }
    if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "За период проведённых продаж, списаний и инвентаризаций нет")));
    else t.append(el("tr", { style: "font-weight:700" }, el("td", {}, "Итого"), el("td", { class: "num" }, fmt(tot.revenue)), costCell(tot),
      el("td", { class: "num" }, fmt(tot.revenue - tot.cost)), el("td", { class: "num" }, tot.revenue ? fmt(Math.round(tot.cost / tot.revenue * 1000) / 10) + " %" : ""),
      el("td", { class: "num" }, fmt(tot.writeoff)), el("td", { class: "num" }, fmt(tot.inventory)), el("td", { class: "num" }, fmt(res(tot))),
      el("td", { class: "num" }, delta(tot.revenue, [...pv.values()].reduce((a, x) => a + Number(x.revenue), 0)))));
    const revalPts = r.rows.filter((x) => rv(x));
    out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
      revalPts.length ? el("div", { class: "warnbox" }, "* Себестоимость включает переоценку проданного в минус: товар продали раньше, чем его оприходовали, и приход пересчитал недостающее по своей цене — "
        + revalPts.map((x) => `${x.point_name} ${rv(x) > 0 ? "+" : ""}${fmt(rv(x))} ₸`).join(", ") + ". Чтобы такого не было, заносите приходы до продаж.") : null,
      el("div", { class: "dim", style: "margin-top:8px" }, "Только продукты: выручка и себестоимость проданного, списания (порча, проработка, питание персонала) и итог инвентаризаций со складов точки — недостача с минусом. Зарплата, аренда и прочие расходы появятся с разделом «Финансы»."));
    csvBtn.onclick = () => csvDownload("прибыль по точкам", period, ["Точка", "Выручка", "Себестоимость", ...(revalPts.length ? ["в т. ч. переоценка"] : []), "Валовая прибыль", "Списания", "Инвентаризация", "Итог"],
      r.rows.map((x) => [x.point_name, x.revenue, x.cost, ...(revalPts.length ? [rv(x)] : []), x.revenue - x.cost, x.writeoff, x.inventory, res(x)]));
  } else if (rep.kind === "purchases") {
    const r = await api("stock_purchases_report", { ...period, store_id: rep.store_id || null });
    if (n !== seqs.rep) return;
    out.innerHTML = "";
    if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
    const st = el("table");
    st.append(el("tr", {}, ...["Поставщик", "Приходов", "Товаров", "Сумма, ₸"].map(th)));
    for (const x of r.suppliers) st.append(el("tr", {}, el("td", {}, x.name), el("td", { class: "num" }, String(x.docs)), el("td", { class: "num" }, String(x.items)), el("td", { class: "num" }, fmt(x.sum))));
    if (!r.suppliers.length) st.append(el("tr", {}, el("td", { colspan: 4, class: "dim" }, "За период проведённых приходов нет")));
    t.append(el("tr", {}, ...["Товар", "Ед.", "Количество", "Сумма, ₸", "Средняя цена", "Мин. цена", "Макс. цена", "Поставщиков"].map((h, i) => el("th", { class: i > 1 ? "num" : "" }, h))));
    for (const x of r.items) t.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""), el("td", { class: "num" }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.sum)),
      el("td", { class: "num" }, fmt(x.avg_price)), el("td", { class: "num" }, fmt(x.min_price)),
      el("td", { class: "num" + (x.max_price > x.min_price * 1.1 ? " bad" : "") }, fmt(x.max_price)), el("td", { class: "num" }, String(x.suppliers))));
    out.append(el("h3", { style: "margin:0 0 8px" }, "По поставщикам"), el("div", { class: "card", style: "padding:0;overflow:auto" }, st),
      el("h3", { style: "margin:16px 0 8px" }, "По товарам"), el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
      el("div", { class: "dim", style: "margin-top:8px" }, "Проведённые приходы за период. Красным — максимальная цена выше минимальной больше чем на 10 %: стоит спросить поставщика."));
    csvBtn.onclick = () => csvDownload("закупки", period, ["Товар", "Ед.", "Количество", "Сумма", "Средняя цена", "Мин. цена", "Макс. цена", "Поставщиков"],
      r.items.map((x) => [x.name, x.unit_id || "", x.qty, x.sum, x.avg_price, x.min_price, x.max_price, x.suppliers]));
  } else {
    const r = await api("doc_sales_report", period);
    if (n !== seqs.rep) return;
    out.innerHTML = "";
    if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
    t.append(el("tr", {}, ...["Блюдо / товар", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост"].map(th)));
    for (const x of r.items) t.append(el("tr", {}, el("td", {}, x.name), el("td", { class: "num" }, fmt(x.qty) + " " + (x.unit_id || "")),
      el("td", { class: "num" }, fmt(x.revenue)), el("td", { class: "num" }, fmt(x.cost)), el("td", { class: "num" }, fmt(x.margin)),
      el("td", { class: "num" }, x.foodcost_pct == null ? "" : el("span", { class: "tag " + (x.foodcost_pct > 35 ? "bad" : "ok") }, fmt(x.foodcost_pct) + " %"))));
    if (!r.items.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "За период проведённых продаж нет")));
    out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
      el("div", { class: "dim", style: "margin-top:8px" }, "Все проданные позиции по всем точкам за период, по выручке. Фудкост выше 35 % — красным."));
    csvBtn.onclick = () => csvDownload("продажи по блюдам", period, ["Позиция", "Ед.", "Кол-во", "Выручка", "Себестоимость", "Прибыль", "Фудкост, %"],
      r.items.map((x) => [x.name, x.unit_id || "", x.qty, x.revenue, x.cost, x.margin, x.foodcost_pct ?? ""]));
  }
}

// ---------- готовность: что в справочниках и документах помешает учёту ----------
const READY_GO = {
  item: (x) => { location.hash = "#item/" + encodeURIComponent(x.code); location.reload(); },
  chart: (x) => { location.hash = "#charts/" + encodeURIComponent(x.code); location.reload(); },
};
async function loadReady() {
  const host = document.getElementById("ready-root"); if (!host) return;
  host.innerHTML = ""; const wait = el("div", { class: "dim" }, "Проверяю…"); host.append(wait);
  const r = await api("stock_quality_report", {});
  wait.remove();
  if (!r.ok) { host.append(el("div", { class: "err" }, errText(r)), el("button", { class: "ghost", onclick: loadReady }, "Повторить")); return; }
  const open = r.checks.filter((c) => c.count > 0);
  host.append(el("div", { class: "tot" },
    el("span", {}, open.length ? `Нужно внимание: ${open.length} из ${r.checks.length} проверок` : "Все проверки чистые"),
    el("span", {}, r.bad ? `мешают учёту: ${r.bad}` : "критичного нет")));
  for (const c of r.checks) {
    const clean = !c.count;
    const d = el("details", { class: "card", style: "padding:12px 16px" });
    d.append(el("summary", { style: "cursor:pointer;display:flex;gap:10px;align-items:center" },
      el("span", { class: "tag " + (clean ? "ok" : c.severity === "bad" ? "bad" : "") }, clean ? "чисто" : String(c.count)),
      el("b", {}, c.title)));
    d.append(el("div", { class: "dim", style: "margin:8px 0" }, c.hint));
    if (!clean) {
      const go = READY_GO[c.target];
      const t = el("table");
      for (const x of c.rows) t.append(el("tr", { class: go ? "row" : "", onclick: go ? () => go(x) : null },
        el("td", {}, x.name), el("td", { class: "dim" }, x.detail || ""), el("td", { class: "dim" }, go ? "открыть →" : "")));
      if (c.count > c.rows.length) t.append(el("tr", {}, el("td", { colspan: 3, class: "dim" }, `…и ещё ${c.count - c.rows.length}`)));
      d.append(el("div", { style: "overflow:auto;max-height:420px" }, t));
    }
    host.append(d);
  }
}

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
// Лист: { sheet, mode, stores, combined, has_store_col, rows:[{code,name,qty,store,neg}],
// warnings, zeros, negatives:[{code,name,qty}], blanks }. Iiko отдаёт оборотку книгой, где
// каждый лист — отдельный фильтр по складам, поэтому разбираются все листы, а какой брать,
// решает форма. Вынесен из формы намеренно: так его можно проверить отдельно, без модалки.
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

function parseSheet(g) {
  const warnings = [];
  // Отчёт iiko узнаётся по строке колонок с «Код» и «Наименование»: в нём колонок «Кол-во»
  // много (приход, продажи, списания…), и нужную выбирает не имя колонки, а группа над ней.
  let hdr = g.findIndex((r) => findCol(r, /^код$/i) >= 0 && findCol(r, /наимен/i) >= 0);
  let qtyCol = -1, nameCol = -1, codeCol = -1, storeCol = -1, mode = "plain";
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
    if (qtyCol < 0) { mode = "plain"; hdr = -1; }
  }
  if (hdr < 0) {
    // Универсальный лист: название + количество, код и склад — если есть.
    hdr = g.findIndex((r) => findCol(r, /наимен|номенклат|товар|позиц/i) >= 0 && findCol(r, /кол|остат/i) >= 0);
    if (hdr < 0) return { ok: false, error: "Не нашёл строку заголовка с названием и количеством" };
    nameCol = findCol(g[hdr], /наимен|номенклат|товар|позиц/i);
    codeCol = findCol(g[hdr], /^код|артикул/i);
    qtyCol = g[hdr].findIndex((c) => /кол|остат/i.test(txt(c)) && !/сумм/i.test(txt(c)));
    storeCol = findCol(g[hdr], /склад/i);
    if (qtyCol < 0) return { ok: false, error: "Не нашёл строку заголовка с названием и количеством" };
  }

  // Нулевой и отрицательный остаток — тоже факт: ноль. Строка остаётся в документе, чтобы
  // повторная загрузка (тест, потом день запуска) обнуляла то, что iiko считает пустым,
  // а не оставляла прошлое количество. Минус физически невозможен — это недоучёт в iiko;
  // сервер минус в факте и не примет, поэтому ставим 0 и показываем такие строки списком.
  const rows = [], negatives = []; let zeros = 0, blanks = 0;
  for (let i = hdr + 1; i < g.length; i++) {
    const r = g[i];
    const name = nameCol >= 0 ? txt(r[nameCol]) : "";
    const code = codeCol >= 0 ? txt(r[codeCol]) : "";
    if (!name && !code) continue;                 // итоговая строка отчёта и разделители
    const q = num(r[qtyCol]);
    if (q === null) { blanks++; continue; }
    if (q === 0) zeros++;
    if (q < 0) negatives.push({ code, name, qty: q });
    rows.push({ code, name, qty: Math.max(q, 0), neg: q < 0, store: storeCol >= 0 ? txt(r[storeCol]) : "" });
  }

  // Склады: в отчёте iiko — из строки шапки «Склад: …», в универсальном листе — из колонки.
  // Лист iiko с несколькими складами — сводный: остатки в строке сложены, и разложить их
  // обратно нечем. Такой лист не отвергается, а помечается: грузить его целиком на один
  // склад форма разрешает только после явного подтверждения.
  let stores = [];
  if (mode === "iiko") {
    for (let i = 0; i < hdr; i++) {
      const c = (g[i] || []).map(txt).find((x) => /^склад\s*:/i.test(x));
      if (c) { stores = c.replace(/^склад\s*:/i, "").split(",").map((x) => x.trim()).filter(Boolean); break; }
    }
  } else if (storeCol >= 0) {
    stores = [...new Set(rows.map((x) => x.store).filter(Boolean))];
  }
  return { ok: true, mode, stores, combined: mode === "iiko" && stores.length > 1,
    has_store_col: mode !== "iiko" && storeCol >= 0, rows, warnings, zeros, negatives, blanks };
}

// Склады в названиях сравниваются без регистра и лишних пробелов: в справочнике есть
// «Магазин  кухни» с двойным пробелом, а iiko в шапке отчёта пишет как придётся.
export const sameStore = (a, b) => txt(a).toLowerCase() === txt(b).toLowerCase();
