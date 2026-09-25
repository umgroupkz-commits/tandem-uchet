import { api, session } from "./api.js?v=15";
import { el, fmt, toast, debounce, modal, confirmDlg, today, isoDate } from "./ui.js?v=15";

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

export async function mount(r) {
  root = r; state.page = 1;
  stores = (await api("stores_list", {})).stores || [];
  const me = await api("me", {});
  myIds = (me.ok && me.user && me.user.store_ids) || [];
  drawShell();
  await loadDocs();
}

function drawShell() {
  root.innerHTML = "";
  root.append(el("div", { class: "tabs" },
    el("button", { class: state.tab === "docs" ? "" : "ghost", onclick: () => { state.tab = "docs"; drawShell(); loadDocs(); } }, "Документы"),
    el("button", { class: state.tab === "bal" ? "" : "ghost", onclick: () => { state.tab = "bal"; drawShell(); loadBalances(); } }, "Остатки"),
    canSales() ? el("button", { class: state.tab === "sales" ? "" : "ghost", onclick: () => { state.tab = "sales"; drawShell(); loadSales(); } }, "Продажи") : null,
    el("button", { class: state.tab === "turn" ? "" : "ghost", onclick: () => { state.tab = "turn"; drawShell(); loadTurnover(); } }, "Ведомость"),
    canSales() ? el("button", { class: state.tab === "c1" ? "" : "ghost", onclick: () => { state.tab = "c1"; drawShell(); loadC1(); } }, "Расход для 1С") : null,
    el("button", { class: state.tab === "ready" ? "" : "ghost", onclick: () => { state.tab = "ready"; drawShell(); loadReady(); } }, "Готовность")));
  if (state.tab === "bal") { root.append(el("div", { id: "bal-root" })); return; }
  if (state.tab === "sales") { root.append(el("div", { id: "sales-root" })); return; }
  if (state.tab === "turn") { root.append(el("div", { id: "turn-root" })); return; }
  if (state.tab === "c1") { root.append(el("div", { id: "c1-root" })); return; }
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
      el("input", { type: "date", title: "с", value: state.date_from, onchange: (e) => { state.date_from = e.target.value; state.page = 1; loadDocs(); } }),
      el("span", { class: "dim" }, "—"),
      el("input", { type: "date", title: "по", value: state.date_to, onchange: (e) => { state.date_to = e.target.value; state.page = 1; loadDocs(); } }),
      newBtn),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}
function sel(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

async function loadDocs() {
  const r = await api("docs_list", { doc_type: state.doc_type || null, store_id: state.store_id || null, status: state.status || null, q: state.q, date_from: state.date_from || null, date_to: state.date_to || null, page: state.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
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
  if (id) { const r = await api("doc_get", { id }); if (!r.ok) { toast(r.message, "bad"); return; } doc = r.doc; }
  const type = doc.doc_type, posted = doc.status === "posted";
  const isSale = type === "sale";
  const ro = posted || !canDoc(type) || isSale;
  const m = modal(`${TYPES[type]} ${doc.number || ""}`); m.root.style.maxWidth = "960px";
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
  function drawLines() {
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
      if (!b.ok) { toast(b.message, "bad"); return; }
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
      if (!r.ok) { err.textContent = r.message; return; }
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
    const search = el("input", { placeholder: "Добавить позицию: название или код" }); const res = el("div", { class: "sres" });
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
  const payload = () => ({ id: doc.id, doc_type: type, doc_date: f.date.value, store_from: f.from.value || null, store_to: f.to.value || null,
    counteragent_id: f.caId, reason: f.reason.value || null, comment: f.comment.value,
    ext_number: f.ext.value.trim() || null, ext_date: f.extd.value || null,
    lines: lines.map((l) => ({ item_code: l.item_code, qty: l.qty === "" ? null : l.qty, fact_qty: l.fact_qty === "" ? null : l.fact_qty, price: l.price === "" ? null : l.price })) });
  async function save() { const r = await api("doc_save", payload()); if (!r.ok) { err.textContent = r.message; return null; } doc.id = r.id; doc.number = r.number; return r.id; }
  async function post() {
    const id = await save(); if (!id) return;
    const pv = await api("doc_preview", { id }); if (!pv.ok) { err.textContent = pv.message; return; }
    const box = el("div", {});
    if (pv.consume.length) box.append(el("div", { class: "dim" }, "Будет списано: " + pv.consume.map((c) => `${c.name} ${fmt(c.qty)} ${c.unit_id}`).join(", ")));
    if (pv.warnings.length) box.append(el("div", { class: "warnbox" }, "Уйдут в минус: " + pv.warnings.map((w) => `${w.name} (${w.store_name}) → ${fmt(w.balance_after)}`).join("; ")));
    const cm = modal("Провести документ?"); cm.root.append(box, el("div", { class: "actions" },
      el("button", { onclick: async () => { cm.close(); const r = await api("doc_post", { id }); if (!r.ok) { err.textContent = r.message; return; } toast("Проведено" + (r.warnings.length ? " — есть минусы" : "")); m.close(); loadDocs(); } }, "Провести"),
      el("button", { class: "ghost", onclick: cm.close }, "Отмена")));
  }
  if (!ro) actions.append(el("button", { class: "ghost", onclick: async () => { if (await save()) { toast("Черновик сохранён"); m.close(); loadDocs(); } } }, "Сохранить черновик"), el("button", { onclick: post }, "Провести"));
  if (posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async () => {
    if (!confirmDlg("Отменить проведение?")) return;
    const r = await api("doc_unpost", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; }
    const hasWarn = r.warnings && r.warnings.length;
    toast("Проведение отменено" + (hasWarn ? " — в минусе: " + r.warnings.map((w) => `${w.name} (${w.store_name}) ${fmt(w.balance_after)}`).join("; ") : ""), hasWarn ? "bad" : "ok");
    m.close(); loadDocs();
  } }, "Отменить проведение"));
  if (doc.id && !posted && canDoc(type) && !isSale) actions.append(el("button", { class: "ghost", onclick: async () => { if (!confirmDlg("Удалить черновик?")) return; const r = await api("doc_delete", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; } toast("Удалено"); m.close(); loadDocs(); } }, "Удалить"));
  actions.append(el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);
}

// ---------- остатки ----------
let bal = { store_id: "", q: "", nonzero: true, page: 1 };
async function loadBalances() {
  const host = document.getElementById("bal-root"); host.innerHTML = "";
  const r = await api("stock_balances", { store_id: bal.store_id || null, q: bal.q, only_nonzero: bal.nonzero, page: bal.page });
  if (!r.ok) { toast(r.message, "bad"); return; }
  const t = el("table"); t.append(el("tr", {}, ...["Склад", "Позиция", "Ед.", "Кол-во", "Средняя", "Сумма"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) t.append(el("tr", { class: "row", onclick: () => showMoves(x) }, el("td", { class: "dim" }, x.store_name), el("td", {}, x.name), el("td", {}, x.unit_id),
    el("td", { class: "num" + (Number(x.qty) < 0 ? " bad" : "") }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.avg_cost)), el("td", { class: "num" }, fmt(x.sum))));
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "dim" }, "Остатков нет — проведите первую инвентаризацию или приход")));
  host.append(el("div", { class: "tools" },
      sel({ "": myIds.length ? "мои склады" : "все склады", ...opts(mine(stores)) }, bal.store_id, (v) => { bal.store_id = v; bal.page = 1; loadBalances(); }),
      el("input", { placeholder: "Поиск позиции", value: bal.q, oninput: debounce((e) => { bal.q = e.target.value; bal.page = 1; loadBalances(); }, 300) }),
      el("label", { style: "margin:0" }, el("input", { type: "checkbox", checked: bal.nonzero, onchange: (e) => { bal.nonzero = e.target.checked; loadBalances(); } }), " только с остатком"),
      el("span", { class: "dim" }, `итого ${fmt(r.total_sum)} ₸`),
      el("button", { class: "ghost", onclick: async () => {
        // CSV считается сервером отдельным запросом (export:true) по тем же фильтрам, а не по уже
        // загруженной странице — office_stock_balances отдаёт csv только когда его явно просят.
        const rex = await api("stock_balances", { store_id: bal.store_id || null, q: bal.q, only_nonzero: bal.nonzero, export: true });
        if (!rex.ok) { toast(rex.message, "bad"); return; }
        const b = new Blob(["﻿" + rex.csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "ostatki.csv"; a.click(); URL.revokeObjectURL(a.href);
      } }, "CSV")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "pager" }, `всего ${r.total} · стр. ${r.page} из ${r.pages}`,
      el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { bal.page--; loadBalances(); } }, "←"),
      el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { bal.page++; loadBalances(); } }, "→")));
}
async function showMoves(x) {
  const r = await api("stock_moves", { store_id: x.store_id, item_code: x.item_code, page: 1 });
  if (!r.ok) { toast(r.message, "bad"); return; }
  const m = modal(`${x.name} · ${x.store_name}`);
  const t = el("table"); t.append(el("tr", {}, ...["Дата", "Документ", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
  for (const mv of (r.rows || [])) t.append(el("tr", { class: "row", onclick: () => { m.close(); editDoc(mv.document_id); } }, el("td", {}, mv.move_date), el("td", {}, `${TYPES[mv.doc_type] || mv.doc_type} ${mv.number}`),
    el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty)), el("td", { class: "num" }, fmt(mv.unit_cost)), el("td", { class: "num" }, fmt(mv.sum))));
  m.root.append(t, el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
}

// ---------- разбор файла остатков ----------
// ---------- продажи: отчёты точек и их складские документы ----------
const iso = isoDate;
const sales = { date_from: iso(new Date(Date.now() - 7 * 864e5)), date_to: iso(new Date()), point_id: "" };
const SALE_STATE = {
  posted: ["проведена", "ok"], none: ["нет продаж с кодом", ""], no_store: ["у точки нет склада", "bad"],
  locked: ["изменён после инвентаризации", "bad"], draft: ["не проведена", "bad"],
  pending: ["не проведена — нажмите «Провести продажи за период»", "bad"], stale: ["устарела — проведите заново", "bad"],
};
async function loadSales() {
  const host = document.getElementById("sales-root"); if (!host) return;
  host.innerHTML = "";
  const r = await api("doc_sales_list", { date_from: sales.date_from, date_to: sales.date_to, point_id: sales.point_id || null });
  if (!r.ok) { host.append(el("div", { class: "err" }, r.message)); return; }
  const points = {}; for (const x of r.rows) points[x.point_id] = x.point_name;
  const canSync = perms().includes("doc:sale:edit");
  const syncBtn = canSync ? el("button", { onclick: async (e) => {
    e.target.disabled = true;
    const s = await api("doc_sales_sync", { date_from: sales.date_from, date_to: sales.date_to, point_id: sales.point_id || null });
    e.target.disabled = false;
    if (!s.ok) { toast(s.message, "bad"); return; }
    const c = s.counts || {};
    toast(`Проведено ${c.posted || 0}, без изменений ${c.unchanged || 0}, без продаж ${c.empty || 0}, без склада ${c.no_store || 0}, заблокировано ${c.locked || 0}`
      + (c.error ? `, ошибок ${c.error}` : ""), c.error || c.locked ? "bad" : undefined);
    loadSales();
  } }, "Провести продажи за период") : null;
  host.append(el("div", { class: "tools" },
    el("input", { type: "date", title: "с", value: sales.date_from, onchange: (e) => { sales.date_from = e.target.value; loadSales(); } }),
    el("span", { class: "dim" }, "—"),
    el("input", { type: "date", title: "по", value: sales.date_to, onchange: (e) => { sales.date_to = e.target.value; loadSales(); } }),
    sel({ "": "все точки", ...points }, sales.point_id, (v) => { sales.point_id = v; loadSales(); }),
    syncBtn));
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
  const sum = await api("doc_sales_report", { date_from: sales.date_from, date_to: sales.date_to, point_id: sales.point_id || null });
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
    host.append(el("h2", { style: "margin-top:4px" }, "Итоги по проведённым продажам"),
      el("div", { class: "card", style: "padding:0;overflow:auto" }, pt),
      el("details", { style: "margin:8px 0 14px" }, el("summary", {}, `Позиции по выручке (${Math.min(sum.items.length, 30)} из ${sum.items.length})`),
        el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, it)),
      el("h2", {}, "Отчёты точек"));
  }
  host.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "dim", style: "margin-top:8px" },
      "Продажа проводится сама, когда точка сохраняет отчёт. «Провести продажи за период» нужна, если склад точке привязали позже или отчёт правили."));
}

// ---------- оборотная ведомость склада ----------
// Аналог «Расширенной оборотно-сальдовой ведомости» iiko: по позиции остаток на начало,
// обороты по видам документов и остаток на конец. Нужна для сверки с iiko в параллельной работе.
const turn = { store_id: "", date_from: iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12)), date_to: iso(new Date()), q: "" };
const TURN_COLS = [["start_qty", "Начало"], ["income", "Приход"], ["transfer_in", "Перемещ. +"], ["transfer_out", "Перемещ. −"],
  ["production_in", "Произв. +"], ["production_out", "Произв. −"], ["sales", "Продажи"], ["writeoff", "Списания"],
  ["inventory", "Инвент. ±"], ["end_qty", "Конец"], ["end_sum", "Сумма на конец"]];
async function loadTurnover() {
  const host = document.getElementById("turn-root"); if (!host) return;
  host.innerHTML = "";
  const storeSel = sel({ "": myIds.length ? "мои склады вместе" : "все склады вместе", ...opts(mine(stores)) }, turn.store_id, (v) => { turn.store_id = v; loadTurnover(); });
  const csvBtn = el("button", { class: "ghost" }, "Скачать CSV");
  host.append(el("div", { class: "tools" }, storeSel,
    el("input", { type: "date", title: "с", value: turn.date_from, onchange: (e) => { turn.date_from = e.target.value; loadTurnover(); } }),
    el("span", { class: "dim" }, "—"),
    el("input", { type: "date", title: "по", value: turn.date_to, onchange: (e) => { turn.date_to = e.target.value; loadTurnover(); } }),
    el("input", { placeholder: "Позиция или код", value: turn.q, oninput: debounce((e) => { turn.q = e.target.value; loadTurnover(); }, 400) }),
    csvBtn));
  const wait = el("div", { class: "dim" }, "Считаю…"); host.append(wait);
  const r = await api("stock_turnover_report", { store_id: turn.store_id || null, date_from: turn.date_from, date_to: turn.date_to, q: turn.q });
  wait.remove();
  if (!r.ok) { host.append(el("div", { class: "err" }, r.message)); return; }
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Ед."), ...TURN_COLS.map(([, h]) => el("th", { class: "num" }, h))));
  let group = null; const tot = { start_sum: 0, income_sum: 0, sales_sum: 0, writeoff_sum: 0, inventory_sum: 0, end_sum: 0 };
  for (const x of r.rows) {
    if ((x.group_name || "") !== group) { group = x.group_name || ""; t.append(el("tr", {}, el("td", { colspan: 2 + TURN_COLS.length, class: "dim", style: "font-weight:700;padding-top:10px" }, group || "без группы"))); }
    for (const k of Object.keys(tot)) tot[k] += Number(x[k] || 0);
    t.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""),
      ...TURN_COLS.map(([k]) => { const v = Number(x[k] || 0); return el("td", { class: "num" + (k === "end_qty" && v < 0 ? " bad" : "") }, v ? fmt(v) : ""); })));
  }
  if (!r.rows.length) t.append(el("tr", {}, el("td", { colspan: 2 + TURN_COLS.length, class: "dim" }, "За период движений нет")));
  host.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "tot" }, el("span", {}, `Позиций ${r.rows.length} · сумма на начало ${fmt(tot.start_sum)} · приход ${fmt(tot.income_sum)} · продажи ${fmt(tot.sales_sum)} · списания ${fmt(tot.writeoff_sum)} · инвентаризация ${fmt(tot.inventory_sum)}`),
      el("span", {}, `на конец ${fmt(tot.end_sum)} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Суммы — по себестоимости движений, как «Сумма с/н» в оборотной ведомости iiko. Расход показан положительными числами."));
  csvBtn.onclick = () => {
    const head = ["Код", "Позиция", "Ед.", "Группа", ...TURN_COLS.map(([, h]) => h)];
    const lines = [head, ...r.rows.map((x) => [x.item_code, x.name, x.unit_id || "", x.group_name || "", ...TURN_COLS.map(([k]) => String(x[k] ?? 0).replace(".", ","))])]
      .map((row) => row.map((v) => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + lines], { type: "text/csv;charset=utf-8" }));
    a.download = `ведомость ${turn.date_from}—${turn.date_to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// ---------- расход для 1С: основа акта списания «на основании продаж» ----------
// Бухгалтер списывает в 1С продукты, ушедшие на проданное. Номенклатура 1С своя, поэтому у позиции
// учёта хранится код 1С и сколько единиц 1С в одной нашей (кофе 3в1: пакетик = 1/25 блока).
const c1 = { store_id: "", date_from: turn.date_from, date_to: turn.date_to, catalog: null };
async function loadC1() {
  const host = document.getElementById("c1-root"); if (!host) return;
  host.innerHTML = "";
  const storeSel = sel({ "": myIds.length ? "мои склады вместе" : "все склады вместе", ...opts(mine(stores)) }, c1.store_id, (v) => { c1.store_id = v; loadC1(); });
  const csvBtn = el("button", { class: "ghost" }, "Скачать для 1С (CSV)");
  host.append(el("div", { class: "tools" }, storeSel,
    el("input", { type: "date", title: "с", value: c1.date_from, onchange: (e) => { c1.date_from = e.target.value; loadC1(); } }),
    el("span", { class: "dim" }, "—"),
    el("input", { type: "date", title: "по", value: c1.date_to, onchange: (e) => { c1.date_to = e.target.value; loadC1(); } }),
    csvBtn));
  const wait = el("div", { class: "dim" }, "Считаю…"); host.append(wait);
  const [r, cat] = await Promise.all([api("stock_1c_report", { store_id: c1.store_id || null, date_from: c1.date_from, date_to: c1.date_to }),
    c1.catalog ? { ok: true, rows: c1.catalog } : api("stock_1c_catalog_list", {})]);
  wait.remove();
  if (!r.ok) { host.append(el("div", { class: "err" }, r.message)); return; }
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
  host.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t),
    el("div", { class: "tot" }, el("span", {}, `Позиций 1С: ${groups.length}`), el("span", {}, `${fmt(total)} ₸`)),
    el("div", { class: "dim", style: "margin-top:8px" }, "Расход проведённых продаж и актов производства, кроме полуфабрикатов: 1С знает сырьё, из которого они сделаны. Себестоимость — по нашему складу; в акте 1С сумму поставит сама 1С по своим ценам."));
  if (free.length) {
    const ft = el("table");
    ft.append(el("tr", {}, el("th", {}, "Позиция учёта"), el("th", {}, "Ед."), el("th", { class: "num" }, "Расход"), el("th", { class: "num" }, "₸"), canEdit ? el("th", {}, "") : null));
    for (const x of free) ft.append(el("tr", {}, el("td", {}, x.name), el("td", {}, x.unit_id || ""), el("td", { class: "num" }, fmt(x.qty)), el("td", { class: "num" }, fmt(x.sum)),
      canEdit ? el("td", {}, el("button", { class: "ghost", onclick: () => linkC1(x) }, "Указать позицию 1С")) : null));
    host.append(el("h3", { style: "margin-top:18px" }, `Без позиции 1С: ${free.length}`),
      el("div", { class: "dim" }, "Эти продукты расходовались, но не связаны с 1С — в список на списание не попали. Если такого товара в 1С нет (не было прихода по документам), списать его в 1С нельзя."),
      el("div", { class: "card", style: "padding:0;overflow:auto;margin-top:8px" }, ft));
  }
  csvBtn.onclick = () => {
    const q = (v) => /[;"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [["Код 1С", "Номенклатура 1С", "Счёт", "Ед.", "Количество", "Себестоимость учёта, ₸"],
      ...groups.map((g) => [g.code, g.name, g.account || "", g.unit || "", String(Math.round(g.qty * 1000) / 1000).replace(".", ","), String(g.sum).replace(".", ",")])]
      .map((row) => row.map(q).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" }));
    a.download = `расход для 1С ${c1.date_from}—${c1.date_to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}
function linkC1(x) {
  const m = modal("Позиция 1С для «" + x.name + "»");
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
    err, el("div", { class: "actions" }, save, clear));
  const send = async (code, kv) => {
    save.disabled = true;
    const r = await api("stock_1c_link_save", { item_code: x.item_code, code_1c: code, k_1c: kv });
    save.disabled = false;
    if (!r.ok) { err.textContent = r.message; return; }
    m.close(); toast("Сохранено"); loadC1();
  };
  save.onclick = () => {
    const code = pick.value.split(" · ")[0].trim();
    if (!(c1.catalog || []).some((c) => c.code === code)) { err.textContent = "Выберите позицию из списка 1С"; return; }
    send(code, String(k.value).replace(",", "."));
  };
  if (clear) clear.onclick = () => send("", "");
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
  if (!r.ok) { host.append(el("div", { class: "err" }, r.message), el("button", { class: "ghost", onclick: loadReady }, "Повторить")); return; }
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
