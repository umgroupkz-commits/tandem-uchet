import { api, el, fmt, toast, itemPicker, linesTable, drafts, warningsText } from "./common.js?v=1";

const SCN = "transfer";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { to: "", lines: [] };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { to: d.to, lines });
  const to = el("select", { onchange: (e) => { d.to = e.target.value; save(); } }, el("option", { value: "" }, "— склад-получатель —"),
    ...ctx.stores.filter((s) => s.id !== st.id).map((s) => el("option", { value: s.id, selected: s.id === d.to }, s.name)));
  const table = linesTable(lines, { columns: [{ key: "qty", title: "кол-во", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", {}, `Откуда: ${st.name}`), el("label", {}, "Куда"), to),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    if (!d.to) { err.textContent = "Выберите склад-получатель"; return; }
    if (!lines.length) { err.textContent = "Добавьте позиции"; return; }
    const bad = lines.find((l) => !(Number(l.qty) > 0));
    if (bad) { err.textContent = `Укажите количество: ${bad.name}`; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      const s = await api("doc_save", { doc_type: "transfer", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id, store_to: d.to,
        lines: lines.map((l) => ({ item_code: l.item_code, qty: Number(l.qty) })) });
      if (!s.ok) { err.textContent = s.message; return; }
      const pv = await api("doc_preview", { id: s.id });
      const wt = pv.ok ? warningsText(pv.warnings) : "";
      if (wt && !window.confirm(wt + "\nПровести всё равно?")) { toast(`Черновик ${s.number} сохранён в бэк-офисе`); return; }
      const p = await api("doc_post", { id: s.id });
      if (!p.ok) { err.textContent = p.message; return; }
      drafts.clear(SCN, st.id);
      const toName = (ctx.stores.find((x) => x.id === d.to) || {}).name || "";
      ctx.result({ title: `Перемещение проведено: ${s.number}`, lines: [`${st.name} → ${toName}`, `${lines.length} поз., сумма ${fmt(p.total_sum)} ₸`],
        warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
    } finally { btn.disabled = false; }
  }
}
