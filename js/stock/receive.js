import { api, el, fmt, toast, debounce, itemPicker, linesTable, drafts, warningsText } from "./common.js?v=1";

const SCN = "receive";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { supplier: null, ext_number: "", lines: [] };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { supplier: d.supplier, ext_number: d.ext_number, lines });
  // поставщик
  const sup = el("input", { placeholder: "Поставщик: начните вводить", value: d.supplier ? d.supplier.name : "", autocomplete: "off" });
  const supRes = el("div", { class: "sres" });
  sup.addEventListener("input", debounce(async () => {
    d.supplier = null; supRes.innerHTML = ""; const q = sup.value.trim(); if (q.length < 2) return;
    const r = await api("counteragents_list", { q, kind: "supplier", page: 1 });
    for (const c of (r.rows || []).slice(0, 8)) supRes.append(el("button", { type: "button", class: "sitem", onclick: () => { d.supplier = { id: c.id, name: c.name }; sup.value = c.name; supRes.innerHTML = ""; save(); } }, c.name));
  }, 300));
  const ext = el("input", { placeholder: "№ накладной поставщика (необязательно)", value: d.ext_number, oninput: (e) => { d.ext_number = e.target.value; save(); } });
  // строки
  const tot = el("div", { class: "tot" }, el("span", {}, "Сумма прихода"), el("span", {}, "0 ₸"));
  const total = () => { const s = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0); tot.lastChild.textContent = fmt(s) + " ₸"; return s; };
  const table = linesTable(lines, {
    columns: [{ key: "qty", title: "кол-во", input: true, width: "88px" }, { key: "price", title: "цена", input: true, step: "0.01", width: "96px" }, { key: "sum", title: "", render: (l) => fmt((Number(l.qty) || 0) * (Number(l.price) || 0)), width: "76px" }],
    onChange: (l, key, row) => { table.updateRow(row, l); total(); save(); }, onRemove: () => { total(); save(); },
  });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", price: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", {}, "Поставщик"), sup, supRes, el("label", {}, "Накладная поставщика"), ext),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root, tot),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));
  total();

  async function post() {
    err.textContent = "";
    if (!d.supplier) { err.textContent = "Выберите поставщика из списка"; return; }
    if (!lines.length) { err.textContent = "Добавьте хотя бы одну позицию"; return; }
    const bad = lines.find((l) => !(Number(l.qty) > 0) || !(Number(l.price) >= 0) || l.price === "");
    if (bad) { err.textContent = `Укажите количество и цену: ${bad.name}`; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      const s = await api("doc_save", { doc_type: "invoice_in", doc_date: new Date().toISOString().slice(0, 10), store_to: st.id, counteragent_id: d.supplier.id,
        ext_number: d.ext_number || null, lines: lines.map((l) => ({ item_code: l.item_code, qty: Number(l.qty), price: Number(l.price) })) });
      if (!s.ok) { err.textContent = s.message; return; }
      const p = await api("doc_post", { id: s.id });
      if (!p.ok) { err.textContent = p.message + ` (черновик ${s.number} сохранён в бэк-офисе)`; return; }
      drafts.clear(SCN, st.id);
      ctx.result({ title: `Проведено: ${s.number}`, lines: [`${d.supplier.name} → ${st.name}`, `${lines.length} поз., сумма ${fmt(p.total_sum)} ₸`],
        warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
    } finally { btn.disabled = false; }
  }
}
