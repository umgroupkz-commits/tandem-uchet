import { ask, el, fmtMoney, today, toast, itemPicker, linesTable, drafts, warningsText, readyNotes, confirmMinus, commentOf, stockNote,
  withBusy, saveDoc, postDoc, showPosted, newKey, draftHint, okNum, numOf } from "./common.js?v=21";

// Списание с телефона: порча, проработка, питание персонала — то, что кладовщик видит
// первым. Устроено как перемещение: черновик на телефоне, предпросмотр остатков, проведение.
const SCN = "writeoff";
// Статьи списания — те же, что в бэк-офисе (сборка 21 добавила брак, представительские и хозяйственные
// нужды: в iiko их списывали отдельными статьями). Порядок — как в бэк-офисе, «прочее» последним.
const REASONS = { spoilage: "порча", defect: "брак", tasting: "проработка", staff_meals: "питание персонала",
  hospitality: "представительские", internal: "хозяйственные нужды", other: "прочее" };
export async function mount(root, ctx) {
  root.innerHTML = "";
  ctx.where = "Списание";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { reason: "", comment: "", lines: [], server_id: null, client_key: newKey() };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { reason: d.reason, comment: d.comment, lines, server_id: d.server_id || null, client_key: d.client_key });
  const reason = el("select", { id: "w_reason", onchange: (e) => { d.reason = e.target.value; save(); } }, el("option", { value: "" }, "— причина —"),
    ...Object.entries(REASONS).map(([v, t]) => el("option", { value: v, selected: v === d.reason }, t)));
  const comment = el("input", { id: "w_comment", value: d.comment || "", placeholder: "например: испортилось при хранении", autocomplete: "off",
    oninput: (e) => { d.comment = e.target.value; save(); } });
  const toPicker = () => { picker.input.scrollIntoView({ block: "center" }); picker.input.focus({ preventScroll: true }); };
  const table = linesTable(lines, { columns: [{ key: "qty", title: "Кол-во", input: true, width: "110px" }], onChange: save, onRemove: save, onLast: toPicker });
  // stock: поиск знает склад списания — позиции с остатком выше, рядом «ост. N».
  const picker = itemPicker({ storeId: st.id, stock: true, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { table.focusLine(it.code); toast("Уже в списке — вот эта строка"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", note: stockNote(it.stock_qty) || undefined }); table.redraw(); save();
    table.focusLine(it.code);
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
          reason: d.reason, comment: commentOf(d.comment),
          lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty) })) }, save);
        if (s.already) return showPosted(ctx, SCN, st.id, s, () => mount(root, ctx), d);
        d.server_id = s.id; save();
        // Как в перемещении: без предпросмотра остатков проводить нельзя — минус человек не увидит.
        let pv;
        try { pv = await ask("doc_preview", { id: s.id }); }
        catch (e) { err.textContent = "Не удалось проверить остатки: " + e.message + draftHint(s.number, e); return; }
        // Минус — своим окном: «Исправить» (главная) возвращает к количеству первой такой позиции.
        if (pv.warnings && pv.warnings.length && !(await confirmMinus(pv.warnings, lines, st.name))) {
          table.focusLine(pv.warnings[0].item_code);
          toast("Черновик " + s.number + " ждёт: исправьте и снова «Провести»");
          return;
        }
        const p = await postDoc(s.id);
        if (p.already) return showPosted(ctx, SCN, st.id, p, () => mount(root, ctx), d);
        drafts.clear(SCN, st.id);
        ctx.result({ title: "Списание проведено: " + s.number,
          lines: [st.name + " · " + (REASONS[d.reason] || d.reason), lines.length + " поз., себестоимость " + fmtMoney(p.total_sum) + " ₸",
            commentOf(d.comment) ? "Комментарий: " + commentOf(d.comment) : null].filter(Boolean),
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], notes: readyNotes(p), again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number, e);
      }
    });
  }
}
