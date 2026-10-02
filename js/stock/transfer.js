import { ask, el, fmtMoney, today, toast, itemPicker, linesTable, drafts, warningsText, readyNotes, confirmMinus, commentOf, stockNote,
  withBusy, saveDoc, postDoc, showPosted, newKey, draftHint, okNum, numOf } from "./common.js?v=22";

const SCN = "transfer";
export async function mount(root, ctx) {
  root.innerHTML = "";
  ctx.where = "Перемещение";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { to: "", comment: "", lines: [], server_id: null, client_key: newKey() };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { to: d.to, comment: d.comment || "", lines, server_id: d.server_id || null, client_key: d.client_key });
  const to = el("select", { id: "t_to", onchange: (e) => { d.to = e.target.value; save(); } }, el("option", { value: "" }, "— склад-получатель —"),
    ...ctx.stores.filter((s) => s.id !== st.id).map((s) => el("option", { value: s.id, selected: s.id === d.to }, s.name)));
  const comment = el("input", { id: "t_comment", value: d.comment || "", placeholder: "например: выпечка на завтра", autocomplete: "off",
    oninput: (e) => { d.comment = e.target.value; save(); } });
  const toPicker = () => { picker.input.scrollIntoView({ block: "center" }); picker.input.focus({ preventScroll: true }); };
  const table = linesTable(lines, { columns: [{ key: "qty", title: "Кол-во", input: true, width: "110px" }], onChange: save, onRemove: save, onLast: toPicker });
  // stock: поиск знает склад-отправитель — позиции с остатком выше, рядом «ост. N».
  const picker = itemPicker({ storeId: st.id, stock: true, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { table.focusLine(it.code); toast("Уже в списке — вот эта строка"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", note: stockNote(it.stock_qty) || undefined }); table.redraw(); save();
    table.focusLine(it.code);
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "favh" }, "Откуда: " + st.name), el("label", { for: "t_to" }, "Куда"), to,
      el("label", { for: "t_comment" }, "Комментарий"), comment),
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
        s = await saveDoc(d, { doc_type: "transfer", doc_date: today(), store_from: st.id, store_to: d.to, comment: commentOf(d.comment),
          lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty) })) }, save);
        if (s.already) return showPosted(ctx, SCN, st.id, s, () => mount(root, ctx), d);
        d.server_id = s.id; save();
        // Предпросмотр — единственная проверка остатков до записи движений. Если он не
        // прошёл, проводить вслепую нельзя: минус по складу человек так и не увидит.
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
        const toName = (ctx.stores.find((x) => x.id === d.to) || {}).name || "";
        // На склад точки перемещают выпечку с кухни: сервер сборки 21 отвечает, какие позиции теперь
        // продаются там готовыми (ready_new), и сколько продаж ещё пересчитать (remaining) — как в бэк-офисе.
        ctx.result({ title: "Перемещение проведено: " + s.number,
          lines: [st.name + " → " + toName, lines.length + " поз., сумма " + fmtMoney(p.total_sum) + " ₸",
            commentOf(d.comment) ? "Комментарий: " + commentOf(d.comment) : null].filter(Boolean),
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], notes: readyNotes(p), again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number, e);
      }
    });
  }
}
