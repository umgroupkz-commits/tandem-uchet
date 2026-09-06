import { ask, el, fmt, toast, itemPicker, linesTable, drafts, warningsText,
  withBusy, saveDoc, draftHint, okNum, numOf } from "./common.js?v=2";

const SCN = "transfer";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { to: "", lines: [], server_id: null };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { to: d.to, lines, server_id: d.server_id || null });
  const to = el("select", { id: "t_to", onchange: (e) => { d.to = e.target.value; save(); } }, el("option", { value: "" }, "— склад-получатель —"),
    ...ctx.stores.filter((s) => s.id !== st.id).map((s) => el("option", { value: s.id, selected: s.id === d.to }, s.name)));
  const table = linesTable(lines, { columns: [{ key: "qty", title: "кол-во", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "favh" }, "Откуда: " + st.name), el("label", { for: "t_to" }, "Куда"), to),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    if (!d.to) { err.textContent = "Выберите склад-получатель"; return; }
    if (!lines.length) { err.textContent = "Добавьте позиции"; return; }
    const bad = lines.find((l) => !okNum(l.qty) || !(numOf(l.qty) > 0));
    if (bad) { err.textContent = "Укажите количество: " + bad.name; return; }
    await withBusy(document.getElementById("post"), async () => {
      let s = null;
      try {
        s = await saveDoc(d, { doc_type: "transfer", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id, store_to: d.to,
          lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty) })) }, save);
        d.server_id = s.id; save();
        // Предпросмотр — единственная проверка остатков до записи движений. Если он не
        // прошёл, проводить вслепую нельзя: минус по складу человек так и не увидит.
        let pv;
        try { pv = await ask("doc_preview", { id: s.id }); }
        catch (e) { err.textContent = "Не удалось проверить остатки: " + e.message + draftHint(s.number); return; }
        const wt = warningsText(pv.warnings);
        if (wt && !window.confirm(wt + "\nПровести всё равно?")) { toast("Черновик " + s.number + " сохранён в бэк-офисе"); return; }
        const p = await ask("doc_post", { id: s.id });
        drafts.clear(SCN, st.id);
        const toName = (ctx.stores.find((x) => x.id === d.to) || {}).name || "";
        ctx.result({ title: "Перемещение проведено: " + s.number, lines: [st.name + " → " + toName, lines.length + " поз., сумма " + fmt(p.total_sum) + " ₸"],
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number);
      }
    });
  }
}
