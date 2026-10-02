import { ask, el, fmtMoney, fmtDate, today, toast, debounce, itemPicker, linesTable, drafts, warningsText, readyNotes, commentOf,
  withBusy, saveDoc, postDoc, showPosted, newKey, draftHint, okNum, numOf, hasNum, selectOnFocus } from "./common.js?v=22";
import { isoDate } from "../office/ui.js?v=22";
import { numStr } from "../office/inputs.js?v=22";

const SCN = "receive";
const shift = (days) => { const t = new Date(); t.setDate(t.getDate() + days); return isoDate(t); };

// Поле даты с быстрыми кнопками «сегодня» и «вчера» (накладные часто заносят на следующее утро).
// Пока человек дату не трогал, в черновике её нет (null) и при проведении берётся «сегодня» того дня:
// черновик, начатый вчера и проведённый сегодня, сам во вчерашний день не уедет.
function dateField(id, label, value, set) {
  const inp = el("input", { id, type: "date", max: today(), value: value || today() });
  const chip = (title, v) => el("button", { type: "button", "data-v": v, onclick: () => { inp.value = v; set(v); mark(); } }, title + ", " + fmtDate(v).slice(0, 5));
  const chips = el("div", { class: "chips" }, chip("сегодня", today()), chip("вчера", shift(-1)));
  function mark() { for (const b of chips.children) b.classList.toggle("on", b.getAttribute("data-v") === inp.value); }
  inp.addEventListener("change", () => { set(inp.value || null); mark(); });
  mark();
  return [el("label", { for: id }, label), inp, chips];
}

export async function mount(root, ctx) {
  root.innerHTML = "";
  ctx.where = "Приёмка";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { supplier: null, ext_number: "", ext_date: null, doc_date: null, comment: "", paper: "", lines: [], server_id: null, client_key: newKey() };
  const lines = d.lines;
  // paper («Итого по накладной») живёт только в черновике телефона — в документ не уходит.
  const save = () => drafts.save(SCN, st.id, { supplier: d.supplier, ext_number: d.ext_number, ext_date: d.ext_date || null, doc_date: d.doc_date || null,
    comment: d.comment || "", paper: d.paper || "", lines, server_id: d.server_id || null, client_key: d.client_key });
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
  const comment = el("input", { id: "r_comment", value: d.comment || "", placeholder: "например: недовес 2 кг", autocomplete: "off",
    oninput: (e) => { d.comment = e.target.value; save(); } });
  // строки: у каждого поля подпись над ним (linesTable), сумма — по кол-ву и цене
  const tot = el("div", { class: "tot" }, el("span", {}, "Сумма прихода"), el("span", {}, "0 ₸"));
  const lineSum = (l) => (numOf(l.qty) || 0) * (numOf(l.price) || 0);
  // «Итого по накладной (на бумаге)» — необязательное: живая сверка с суммой строк, как в бэк-офисе.
  // Сумма строк — по строкам с копейками (как считает сервер), иначе «расходится на 0,01» на ровной накладной.
  const r2 = (x) => Math.round(x * 100) / 100;
  const paper = el("input", { id: "r_paper", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", enterkeyhint: "done",
    placeholder: "сумма с накладной", value: d.paper || "" });
  selectOnFocus(paper);
  const paperNote = el("div", { class: "pnote", "aria-live": "polite" });
  paper.addEventListener("input", () => { d.paper = paper.value; save(); total(); });
  paper.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); paper.blur(); } });
  function paperCheck(sum) {
    paperNote.className = "pnote"; paperNote.textContent = "";
    if (!hasNum(paper.value)) return "";
    if (!okNum(paper.value)) { paperNote.classList.add("bad"); paperNote.textContent = "не число"; return ""; }
    const diff = r2(numOf(paper.value) - sum);
    const t = Math.abs(diff) < 0.005 ? "сходится" : "расходится на " + fmtMoney(Math.abs(diff)) + " ₸ (в документе " + (diff > 0 ? "меньше" : "больше") + ")";
    paperNote.classList.add(Math.abs(diff) < 0.005 ? "ok" : "bad"); paperNote.textContent = t;
    return t;
  }
  const total = () => { const s = r2(lines.reduce((a, l) => a + r2(lineSum(l)), 0)); tot.lastChild.textContent = fmtMoney(s) + " ₸"; paperCheck(s); return s; };
  const toPicker = () => { picker.input.scrollIntoView({ block: "center" }); picker.input.focus({ preventScroll: true }); };
  const table = linesTable(lines, {
    columns: [{ key: "qty", title: "Кол-во", input: true }, { key: "price", title: "Цена", input: true },
      { key: "sum", title: "Сумма", render: (l) => fmtMoney(lineSum(l)) }],
    onChange: (l, key, row) => {
      // Цену поправили руками — пометка «как в прошлом приходе» больше не про неё.
      if (key === "price" && l.note) { delete l.note; const i = row.querySelector(".ln i"); if (i) i.textContent = l.unit_id || ""; }
      table.updateRow(row, l); total(); save();
    },
    onRemove: () => { total(); save(); },
    onLast: toPicker,
  });
  // Поиск — только товары: блюда и полуфабрикаты от поставщика не приходят, а в выдаче они
  // заслоняли нужное («творог» — восемь блинов вместо «Молочка Творог»).
  const picker = itemPicker({ storeId: st.id, types: ["goods"], limit: 30, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { table.focusLine(it.code); toast("Уже в списке — вот эта строка"); return; }
    // Сервер сборки 21 отдаёт цену последнего прихода — подставляем, как iiko; старый не отдаёт — пусто.
    const lp = Number(it.last_price);
    const line = { item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", price: lp > 0 ? numStr(lp) : "" };
    if (lp > 0) line.note = "цена как в прошлом приходе" + (it.last_price_date ? " от " + fmtDate(it.last_price_date).slice(0, 5) : "");
    lines.push(line); table.redraw(); total(); save();
    table.focusLine(it.code);
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", { for: "r_sup" }, "Поставщик"), sup, supRes, supErr,
      el("label", { for: "r_ext" }, "Накладная поставщика"), ext,
      ...dateField("r_extdate", "Дата накладной", d.ext_date, (v) => { d.ext_date = v; save(); }),
      ...dateField("r_docdate", "Дата документа (приход на склад)", d.doc_date, (v) => { d.doc_date = v; save(); }),
      el("label", { for: "r_comment" }, "Комментарий"), comment),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root, tot,
      el("label", { for: "r_paper" }, "Итого по накладной (на бумаге)"), el("div", { class: "paper" }, paper, paperNote)),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));
  total();

  async function post() {
    err.textContent = "";
    if (!d.supplier) { err.textContent = "Выберите поставщика из списка"; return; }
    if (!lines.length) { err.textContent = "Добавьте хотя бы одну позицию"; return; }
    const bad = lines.find((l) => !okNum(l.qty) || !(numOf(l.qty) > 0) || !okNum(l.price));
    if (bad) { err.textContent = "Укажите количество и цену: " + bad.name; return; }
    const docDate = d.doc_date || today(), extDate = d.ext_date || today();
    // Дата из будущего — опечатка: поставщик не выписывает завтрашних накладных, товар не приходит завтра.
    if (docDate > today()) { err.textContent = "Дата документа позже сегодняшней — проверьте"; return; }
    if (extDate > today()) { err.textContent = "Дата накладной позже сегодняшней — проверьте"; return; }
    await withBusy(document.getElementById("post"), async () => {
      let s = null;
      try {
        s = await saveDoc(d, { doc_type: "invoice_in", doc_date: docDate, store_to: st.id, counteragent_id: d.supplier.id,
          ext_number: d.ext_number || null, ext_date: extDate, comment: commentOf(d.comment),
          lines: lines.map((l) => ({ item_code: l.item_code, qty: numOf(l.qty), price: numOf(l.price) })) }, save);
        if (s.already) return showPosted(ctx, SCN, st.id, s, () => mount(root, ctx), d);
        d.server_id = s.id; save();
        const p = await postDoc(s.id);
        if (p.already) return showPosted(ctx, SCN, st.id, p, () => mount(root, ctx), d);
        drafts.clear(SCN, st.id);
        ctx.result({ title: "Проведено: " + s.number,
          lines: [d.supplier.name + " → " + st.name,
            "Накладная" + (d.ext_number ? " № " + d.ext_number : "") + " от " + fmtDate(extDate) + (docDate !== today() ? " · документ от " + fmtDate(docDate) : ""),
            lines.length + " поз., сумма " + fmtMoney(p.total_sum) + " ₸",
            // Сверка с бумагой — по сумме, которую провёл сервер.
            hasNum(d.paper) && okNum(d.paper) ? "Итого по накладной: " + paperCheck(Number(p.total_sum) || 0) : null,
            commentOf(d.comment) ? "Комментарий: " + commentOf(d.comment) : null].filter(Boolean),
          warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], notes: readyNotes(p), again: () => mount(root, ctx) });
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number, e);
      }
    });
  }
}
