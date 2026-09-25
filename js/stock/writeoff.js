import { ask, el, fmt, today, toast, itemPicker, linesTable, drafts, warningsText,
  withBusy, saveDoc, draftHint, okNum, numOf } from "./common.js?v=13";

// Списание с телефона: порча, проработка, питание персонала — то, что кладовщик видит
// первым. Устроено как перемещение: черновик на телефоне, предпросмотр остатков, проведение.
const SCN = "writeoff";
const REASONS = { spoilage: "порча", tasting: "проработка", staff_meals: "питание персонала", other: "прочее" };
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { reason: "", comment: "", lines: [], server_id: null };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { reason: d.reason, comment: d.comment, lines, server_id: d.server_id || null });
  const reason = el("select", { id: "w_reason", onchange: (e) => { d.reason = e.target.value; save(); } }, el("option", { value: "" }, "— причина —"),
    ...Object.entries(REASONS).map(([v, t]) => el("option", { value: v, selected: v === d.reason }, t)));
  const comment = el("input", { id: "w_comment", value: d.comment || "", placeholder: "например: испортилось при хранении",
    oninput: (e) => { d.comment = e.target.value; save(); } });
  const table = linesTable(lines, { columns: [{ key: "qty", title: "кол-во", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "favh" }, "Склад: " + st.name),
      el("label", { for: "w_reason" }, "Причина"), reason, el("label", { for: "w_comment" }, "Комментарий"), comment),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    if (!d.reason) { err.textContent = "Выберите причину списания"; return; }
    if (!lines.length) { err.textContent = "Добавьте позиции"; return; }
    const bad = lines.find((l) => !okNum(l.qty) || !(numOf(l.qty) > 0));
    if (bad) { err.textContent = "Укажите количество: " + bad.name; return; }
    await withBusy(document.getElementById("post"), async () => {
      let s = null;
      try {
        s = await saveDoc(d, { doc_type: "writeoff", doc_date: today(), store_from: st.id,
          reason: d.reason, comment: d.comment || "",
          lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty) })) }, save);
        d.server_id = s.id; save();
        // Как в перемещении: без предпросмотра остатков проводить нельзя — минус человек не увидит.
        let pv;
        try { pv = await ask("doc_preview", { id: s.id }); }
        catch (e) { err.textContent = "Не удалось проверить остатки: " + e.message + draftHint(s.number); return; }
        const wt = warningsText(pv.warnings);
        if (wt && !window.confirm(wt + "\nПровести всё равно?")) { toast("Черновик " + s.number + " сохранён в бэк-офисе"); return; }
        const p = await ask("doc_post", { id: s.id });
        drafts.clear(SCN, st.id);
        ctx.result({ title: "Списание проведено: " + s.number,
          lines: [st.name + " · " + REASONS[d.reason], lines.length + " поз., себестоимость " + fmt(p.total_sum) + " ₸"],
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number);
      }
    });
  }
}
