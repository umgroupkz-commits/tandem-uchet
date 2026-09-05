import { api, session } from "./api.js?v=2";
import { el, fmt, toast, debounce, modal, confirmDlg } from "./ui.js?v=2";

const TYPES = { invoice_in: "Приход", transfer: "Перемещение", writeoff: "Списание", production: "Производство", inventory: "Инвентаризация" };
const REASONS = { spoilage: "порча", tasting: "проработка", staff_meals: "питание персонала", other: "прочее" };
const perms = () => (session() && session().permissions) || [];
const canDoc = (type) => perms().includes("doc:" + type + ":edit");
let root, stores = [], state = { tab: "docs", doc_type: "", store_id: "", status: "", q: "", date_from: "", date_to: "", page: 1 };
let table, pager;

export async function mount(r) {
  root = r; state.page = 1;
  stores = ((await api("stores_list", {})).stores || []).filter((s) => s.active);
  drawShell();
  await loadDocs();
}

function drawShell() {
  root.innerHTML = "";
  root.append(el("div", { class: "tabs" },
    el("button", { class: state.tab === "docs" ? "" : "ghost", onclick: () => { state.tab = "docs"; drawShell(); loadDocs(); } }, "Документы"),
    el("button", { class: state.tab === "bal" ? "" : "ghost", onclick: () => { state.tab = "bal"; drawShell(); loadBalances(); } }, "Остатки")));
  if (state.tab === "bal") { root.append(el("div", { id: "bal-root" })); return; }
  const newBtn = el("select", { onchange: (e) => { if (e.target.value) { editDoc(null, e.target.value); e.target.value = ""; } } },
    el("option", { value: "" }, "+ Новый документ…"),
    ...Object.entries(TYPES).filter(([k]) => canDoc(k)).map(([k, v]) => el("option", { value: k }, v)));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Номер, поставщик, комментарий", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; loadDocs(); }, 300) }),
      sel({ "": "все типы", ...TYPES }, state.doc_type, (v) => { state.doc_type = v; state.page = 1; loadDocs(); }),
      sel({ "": "все склады", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) }, state.store_id, (v) => { state.store_id = v; state.page = 1; loadDocs(); }),
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
      : d.doc_type === "transfer" ? `${d.store_from_name || ""} → ${d.store_to_name || ""}` : (d.store_from_name || "");
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
  let doc = { doc_type: newType, doc_date: new Date().toISOString().slice(0, 10), status: "draft", lines: [], consume: [] };
  if (id) { const r = await api("doc_get", { id }); if (!r.ok) { toast(r.message, "bad"); return; } doc = r.doc; }
  const type = doc.doc_type, posted = doc.status === "posted";
  const ro = posted || !canDoc(type);
  const m = modal(`${TYPES[type]} ${doc.number || ""}`); m.root.style.maxWidth = "960px";
  const storeOpts = { "": "— склад —", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) };
  const f = {
    date: el("input", { type: "date", value: doc.doc_date, readonly: ro }),
    from: sel(storeOpts, doc.store_from || "", () => {}, ro),
    to: sel(storeOpts, doc.store_to || "", () => {}, ro),
    reason: sel({ "": "— причина —", ...REASONS }, doc.reason || "", () => {}, ro),
    comment: el("input", { value: doc.comment || "", readonly: ro }),
    caId: doc.counteragent_id || null,
    ca: el("input", { placeholder: "поставщик: начните вводить", value: doc.counteragent_name || "", readonly: ro }),
  };
  const caRes = el("div", { class: "sres" });
  f.ca.addEventListener("input", debounce(async () => {
    caRes.innerHTML = ""; f.caId = null; const q = f.ca.value.trim(); if (q.length < 2) return;
    const s = await api("counteragents_list", { q, kind: "supplier" });
    for (const c of (s.rows || []).slice(0, 10)) caRes.append(el("button", { class: "sitem", onclick: () => { f.caId = c.id; f.ca.value = c.name; caRes.innerHTML = ""; } }, c.name));
  }, 300));
  const head = el("div", { class: "grid2" }, el("div", {}, el("label", {}, "Дата"), f.date));
  if (type === "invoice_in") head.append(el("div", {}, el("label", {}, "Склад-получатель"), f.to), el("div", { class: "sbox" }, el("label", {}, "Поставщик"), f.ca, caRes));
  if (type === "transfer") head.append(el("div", {}, el("label", {}, "Откуда"), f.from), el("div", {}, el("label", {}, "Куда"), f.to));
  if (type === "writeoff") head.append(el("div", {}, el("label", {}, "Склад"), f.from), el("div", {}, el("label", {}, "Причина"), f.reason));
  if (type === "production") head.append(el("div", {}, el("label", {}, "Склад кухни (расход и выпуск)"), f.from));
  if (type === "inventory") head.append(el("div", {}, el("label", {}, "Склад"), f.from));
  head.append(el("div", {}, el("label", {}, "Комментарий"), f.comment));
  m.root.append(head);
  // строки
  const lines = doc.lines.map((l) => ({ ...l }));
  const tbl = el("table"); const tot = el("div", { class: "tot" });
  const isInv = type === "inventory", isIn = type === "invoice_in";
  function drawLines() {
    const ae = document.activeElement; const keep = ae && ae.dataset && ae.dataset.li != null ? { li: ae.dataset.li, key: ae.dataset.key } : null;
    tbl.innerHTML = "";
    const cols = ["Позиция", "Ед.", isInv ? "Факт" : "Кол-во"]; if (isInv && posted) cols.push("Расчёт", "Разница"); if (isIn) cols.push("Цена", "Сумма"); if (posted && !isIn && !isInv) cols.push("Себест.", "Сумма"); if (isInv && posted) cols.push("Сумма"); cols.push("");
    tbl.append(el("tr", {}, ...cols.map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    let sum = 0;
    lines.forEach((l, idx) => {
      const q = Number(isInv ? l.fact_qty : l.qty) || 0, p = Number(l.price) || 0;
      const inp = (key) => el("input", { type: "number", step: "0.001", value: l[key] ?? "", readonly: ro, "data-li": String(idx), "data-key": key, style: "text-align:right;padding:6px", oninput: (e) => { l[key] = e.target.value; drawLines(); } });
      const tds = [el("td", {}, l.name, isInv && !posted && l.current_qty != null ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, "расчёт: " + fmt(l.current_qty)) : null), el("td", {}, l.unit_id || ""), el("td", { class: "num" }, inp(isInv ? "fact_qty" : "qty"))];
      if (isInv && posted) tds.push(el("td", { class: "num" }, fmt(l.calc_qty)), el("td", { class: "num" }, fmt(q - Number(l.calc_qty || 0))));
      if (isIn) { tds.push(el("td", { class: "num" }, inp("price")), el("td", { class: "num" }, fmt(q * p))); sum += q * p; }
      if (posted && !isIn && !isInv) { tds.push(el("td", { class: "num" }, fmt(l.price)), el("td", { class: "num" }, fmt(l.sum))); sum += Number(l.sum || 0); }
      if (isInv && posted) { tds.push(el("td", { class: "num" }, fmt(l.sum))); sum += Number(l.sum || 0); }
      tds.push(el("td", {}, ro ? null : el("button", { class: "x", onclick: () => { lines.splice(idx, 1); drawLines(); } }, "×")));
      tbl.append(el("tr", {}, ...tds));
    });
    tot.innerHTML = ""; tot.append(el("span", {}, posted ? "Сумма документа" : (isIn ? "Сумма" : "Строк")), el("span", {}, posted || isIn ? fmt(posted ? doc.total_sum : sum) + " ₸" : String(lines.length)));
    if (keep) { const n = tbl.querySelector(`input[data-li="${keep.li}"][data-key="${keep.key}"]`); if (n) n.focus(); }
  }
  drawLines();
  m.root.append(el("h2", { style: "margin-top:14px" }, isInv ? "Позиции и факт" : (type === "production" ? "Выпуск" : "Строки")), tbl, tot);
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
    if (isInv) tools.prepend(el("button", { class: "ghost small", style: "margin-bottom:8px", onclick: async () => {
      const st = f.from.value; if (!st) { toast("Сначала выберите склад", "bad"); return; }
      let page = 1, pages = 1;
      do {
        const b = await api("stock_balances", { store_id: st, only_nonzero: true, page });
        if (!b.ok) { toast(b.message, "bad"); return; }
        for (const x of (b.rows || [])) if (!lines.some((l) => l.item_code === x.item_code)) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "", current_qty: x.qty });
        pages = b.pages || 1; page++;
      } while (page <= pages);
      drawLines();
    } }, "Заполнить позициями с остатком"));
    m.root.append(tools);
  }
  if (doc.consume && doc.consume.length) {
    const ct = el("table"); ct.append(el("tr", {}, ...["Расход сырья", "Ед.", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    for (const c of doc.consume) ct.append(el("tr", {}, el("td", {}, c.name), el("td", {}, c.unit_id), el("td", { class: "num" }, fmt(c.qty)), el("td", { class: "num" }, fmt(c.price)), el("td", { class: "num" }, fmt(c.sum))));
    m.root.append(el("h2", { style: "margin-top:14px" }, "Списано по техкартам"), ct);
  }
  const err = el("div", { class: "err" }); const actions = el("div", { class: "actions" });
  const payload = () => ({ id: doc.id, doc_type: type, doc_date: f.date.value, store_from: f.from.value || null, store_to: f.to.value || null,
    counteragent_id: f.caId, reason: f.reason.value || null, comment: f.comment.value,
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
  if (posted && canDoc(type)) actions.append(el("button", { class: "ghost", onclick: async () => {
    if (!confirmDlg("Отменить проведение?")) return;
    const r = await api("doc_unpost", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; }
    const hasWarn = r.warnings && r.warnings.length;
    toast("Проведение отменено" + (hasWarn ? " — в минусе: " + r.warnings.map((w) => `${w.name} (${w.store_name}) ${fmt(w.balance_after)}`).join("; ") : ""), hasWarn ? "bad" : "ok");
    m.close(); loadDocs();
  } }, "Отменить проведение"));
  if (doc.id && !posted && canDoc(type)) actions.append(el("button", { class: "ghost", onclick: async () => { if (!confirmDlg("Удалить черновик?")) return; const r = await api("doc_delete", { id: doc.id }); if (!r.ok) { err.textContent = r.message; return; } toast("Удалено"); m.close(); loadDocs(); } }, "Удалить"));
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
      sel({ "": "все склады", ...Object.fromEntries(stores.map((s) => [s.id, s.name])) }, bal.store_id, (v) => { bal.store_id = v; bal.page = 1; loadBalances(); }),
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
  const m = modal(`${x.name} · ${x.store_name}`);
  const t = el("table"); t.append(el("tr", {}, ...["Дата", "Документ", "Кол-во", "Себест.", "Сумма"].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
  for (const mv of (r.rows || [])) t.append(el("tr", { class: "row", onclick: () => { m.close(); editDoc(mv.document_id); } }, el("td", {}, mv.move_date), el("td", {}, `${TYPES[mv.doc_type] || mv.doc_type} ${mv.number}`),
    el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty)), el("td", { class: "num" }, fmt(mv.unit_cost)), el("td", { class: "num" }, fmt(mv.sum))));
  m.root.append(t, el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
}
