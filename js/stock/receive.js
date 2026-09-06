import { ask, el, fmt, toast, debounce, itemPicker, linesTable, drafts, warningsText,
  withBusy, saveDoc, draftHint, okNum, numOf } from "./common.js?v=2";

const SCN = "receive";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { supplier: null, ext_number: "", lines: [], server_id: null };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { supplier: d.supplier, ext_number: d.ext_number, lines, server_id: d.server_id || null });
  // поставщик
  const sup = el("input", { id: "r_sup", placeholder: "Поставщик: начните вводить", value: d.supplier ? d.supplier.name : "", autocomplete: "off" });
  const supRes = el("div", { class: "sres" });
  const supErr = el("div", { class: "err" });
  sup.addEventListener("input", debounce(async () => {
    // Сброс выбранного поставщика — часть черновика: без save() телефон помнил бы старого.
    d.supplier = null; save(); supRes.innerHTML = ""; supErr.textContent = "";
    const q = sup.value.trim(); if (q.length < 2) return;
    try {
      const r = await ask("counteragents_list", { q, kind: "supplier", active: true, page: 1 });
      for (const c of (r.rows || []).slice(0, 8)) supRes.append(el("button", { type: "button", class: "sitem", onclick: () => { d.supplier = { id: c.id, name: c.name }; sup.value = c.name; supRes.innerHTML = ""; save(); } }, c.name));
      if (!supRes.children.length) supRes.append(el("div", { class: "sitem dim" }, "Не найдено"));
    } catch (e) { supErr.textContent = "Поставщики не загрузились: " + e.message; }
  }, 300));
  const ext = el("input", { id: "r_ext", placeholder: "№ накладной поставщика (необязательно)", value: d.ext_number, oninput: (e) => { d.ext_number = e.target.value; save(); } });
  // строки
  const tot = el("div", { class: "tot" }, el("span", {}, "Сумма прихода"), el("span", {}, "0 ₸"));
  const total = () => { const s = lines.reduce((a, l) => a + (numOf(l.qty) || 0) * (numOf(l.price) || 0), 0); tot.lastChild.textContent = fmt(s) + " ₸"; return s; };
  const table = linesTable(lines, {
    columns: [{ key: "qty", title: "кол-во", input: true }, { key: "price", title: "цена", input: true },
      { key: "sum", title: "", render: (l) => fmt((numOf(l.qty) || 0) * (numOf(l.price) || 0)) }],
    onChange: (l, key, row) => { table.updateRow(row, l); total(); save(); }, onRemove: () => { total(); save(); },
  });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", price: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", { for: "r_sup" }, "Поставщик"), sup, supRes, supErr, el("label", { for: "r_ext" }, "Накладная поставщика"), ext),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root, tot),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));
  total();

  async function post() {
    err.textContent = "";
    if (!d.supplier) { err.textContent = "Выберите поставщика из списка"; return; }
    if (!lines.length) { err.textContent = "Добавьте хотя бы одну позицию"; return; }
    const bad = lines.find((l) => !okNum(l.qty) || !(numOf(l.qty) > 0) || !okNum(l.price));
    if (bad) { err.textContent = "Укажите количество и цену: " + bad.name; return; }
    await withBusy(document.getElementById("post"), async () => {
      let s = null;
      try {
        s = await saveDoc(d, { doc_type: "invoice_in", doc_date: new Date().toISOString().slice(0, 10), store_to: st.id, counteragent_id: d.supplier.id,
          ext_number: d.ext_number || null, lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty), price: numOf(l.price) })) }, save);
        d.server_id = s.id; save();
        const p = await ask("doc_post", { id: s.id });
        drafts.clear(SCN, st.id);
        ctx.result({ title: "Проведено: " + s.number, lines: [d.supplier.name + " → " + st.name, lines.length + " поз., сумма " + fmt(p.total_sum) + " ₸"],
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number);
      }
    });
  }
}
