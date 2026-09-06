import { api, el, fmt, toast, itemPicker, linesTable, drafts } from "./common.js?v=1";

const SCN = "inventory";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { lines: [], server_id: null };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null });
  // список позиций с остатком — без расчётного количества (слепой подсчёт)
  if (!lines.length) {
    let page = 1, pages = 1;
    do {
      const b = await api("stock_balances", { store_id: st.id, only_nonzero: true, page });
      for (const x of (b.rows || [])) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "" });
      pages = b.pages || 1; page++;
    } while (page <= pages);
    lines.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  const table = linesTable(lines, { columns: [{ key: "fact_qty", title: "факт", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, fact_qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Введите фактическое количество по каждой позиции. Пустое поле — позиция не пересчитывалась и в акт не попадёт."), table.root),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Добавить позицию, которой нет в списке"), picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    const counted = lines.filter((l) => l.fact_qty !== "" && l.fact_qty != null);
    if (!counted.length) { err.textContent = "Ни одна позиция не пересчитана"; return; }
    if (counted.some((l) => Number(l.fact_qty) < 0 || isNaN(Number(l.fact_qty)))) { err.textContent = "Факт не может быть отрицательным"; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      // повторное «Провести» после «Назад к вводу» обновляет тот же серверный черновик, а не плодит новые
      const s = await api("doc_save", { id: d.server_id || undefined, doc_type: "inventory", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id,
        lines: counted.map((l) => ({ item_code: l.item_code, fact_qty: Number(l.fact_qty) })) });
      if (!s.ok) { if (d.server_id) { d.server_id = null; save(); } err.textContent = s.message; return; }
      d.server_id = s.id; drafts.save(SCN, st.id, { lines, server_id: s.id });
      const g = await api("doc_get", { id: s.id });
      if (!g.ok) { err.textContent = g.message; return; }
      // сводка расхождений — только теперь показываем расчёт
      const rows = g.doc.lines.map((l) => ({ name: l.name, unit: l.unit_id, fact: Number(l.fact_qty), calc: Number(l.current_qty || 0) }))
        .map((r) => ({ ...r, diff: r.fact - r.calc })).filter((r) => Math.abs(r.diff) > 1e-9);
      root.innerHTML = "";
      const t = el("table"); t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", { class: "num" }, "Факт"), el("th", { class: "num" }, "Расчёт"), el("th", { class: "num" }, "Разница")));
      for (const r of rows) t.append(el("tr", {}, el("td", {}, r.name, el("i", { class: "dim", style: "display:block;font-style:normal" }, r.unit)), el("td", { class: "num" }, fmt(r.fact)), el("td", { class: "num" }, fmt(r.calc)), el("td", { class: "num", style: r.diff < 0 ? "color:var(--bad)" : "color:var(--ok)" }, (r.diff > 0 ? "+" : "") + fmt(r.diff))));
      root.append(el("div", { class: "card" }, el("div", { class: "favh" }, `Акт ${s.number}: расхождения`), rows.length ? t : el("div", { class: "okbox" }, "Расхождений нет"), el("div", { class: "dim", style: "margin-top:8px" }, `Пересчитано позиций: ${counted.length}`)),
        el("div", { class: "bar" }, el("button", { class: "ghost", onclick: () => mount(root, ctx) }, "Назад к вводу"), el("button", { onclick: async () => {
          const p = await api("doc_post", { id: s.id });
          if (!p.ok) { toast(p.message, "bad"); return; }
          drafts.clear(SCN, st.id);
          ctx.result({ title: `Инвентаризация проведена: ${s.number}`, lines: [`${st.name} · расхождений ${rows.length} · сумма ${fmt(p.total_sum)} ₸`], again: () => mount(root, ctx) });
        } }, "Подтвердить и провести")));
    } finally { btn.disabled = false; }
  }
}
