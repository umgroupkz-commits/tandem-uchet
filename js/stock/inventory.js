import { ask, el, fmt, toast, debounce, itemPicker, linesTable, drafts,
  withBusy, saveDoc, draftHint, okNum, numOf, hasNum } from "./common.js?v=2";

const SCN = "inventory";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { lines: [], server_id: null };
  const lines = d.lines;
  // Черновик пишется на каждый ввод цифры — без задержки это запись в localStorage
  // на каждое нажатие по списку в сотни строк.
  const save = debounce(() => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null }), 300);
  const saveNow = () => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null });

  // список позиций с остатком — без расчётного количества (слепой подсчёт);
  // avg_cost берём здесь же, чтобы в сводке показать сумму расхождения
  if (!lines.length) {
    try {
      let page = 1, pages = 1;
      do {
        const b = await ask("stock_balances", { store_id: st.id, only_nonzero: true, page });
        for (const x of (b.rows || [])) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "", avg_cost: Number(x.avg_cost) || 0 });
        pages = b.pages || 1; page++;
      } while (page <= pages);
      lines.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    } catch (e) {
      root.append(el("div", { class: "card" }, el("div", { class: "err" }, "Список позиций не загрузился: " + e.message)),
        el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { onclick: () => mount(root, ctx) }, "Повторить")));
      return;
    }
  }
  const table = linesTable(lines, { columns: [{ key: "fact_qty", title: "факт", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, fact_qty: "", avg_cost: Number(it.avg_cost) || null }); table.redraw(); saveNow();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Введите фактическое количество по каждой позиции. Пустое поле — позиция не пересчитывалась и в акт не попадёт."), table.root),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Добавить позицию, которой нет в списке"), picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    const counted = lines.filter((l) => hasNum(l.fact_qty));
    if (!counted.length) { err.textContent = "Ни одна позиция не пересчитана"; return; }
    // Строку с непустым, но нечитаемым вводом молча пропускать нельзя: человек считал
    // эту позицию, и в акт она обязана попасть.
    const bad = counted.find((l) => !okNum(l.fact_qty));
    if (bad) { err.textContent = "Факт не может быть отрицательным или пустым/некорректным: " + bad.name; return; }
    await withBusy(document.getElementById("post"), async () => {
      let s = null;
      try {
        s = await saveDoc(d, { doc_type: "inventory", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id,
          lines: counted.map((l) => ({ item_code: l.item_code, fact_qty: numOf(l.fact_qty) })) }, saveNow);
        d.server_id = s.id; saveNow();
        const g = await ask("doc_get", { id: s.id });
        // сводка расхождений — только теперь показываем расчёт
        const cost = {}; for (const l of lines) cost[l.item_code] = l.avg_cost;
        const rows = g.doc.lines.map((l) => ({ name: l.name, unit: l.unit_id, fact: Number(l.fact_qty), calc: Number(l.current_qty || 0), cost: cost[l.item_code] }))
          .map((r) => ({ ...r, diff: r.fact - r.calc })).filter((r) => Math.abs(r.diff) > 1e-9);
        showSummary(s, rows, counted.length);
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number);
      }
    });
  }

  function showSummary(s, rows, countedCount) {
    root.innerHTML = "";
    const serr = el("div", { class: "err" });
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", { class: "num" }, "Факт"), el("th", { class: "num" }, "Расчёт"), el("th", { class: "num" }, "Разница"), el("th", { class: "num" }, "Сумма")));
    for (const r of rows) {
      // Сумма расхождения — по средней себестоимости склада на момент построения списка.
      // Для позиций, добавленных поиском, средней нет: столбец остаётся пустым.
      const sum = r.cost === null || r.cost === undefined ? "" : fmt(r.diff * r.cost);
      t.append(el("tr", {}, el("td", {}, r.name, el("i", { class: "dim", style: "display:block;font-style:normal" }, r.unit)),
        el("td", { class: "num" }, fmt(r.fact)), el("td", { class: "num" }, fmt(r.calc)),
        el("td", { class: "num", style: r.diff < 0 ? "color:var(--bad)" : "color:var(--ok)" }, (r.diff > 0 ? "+" : "") + fmt(r.diff)),
        el("td", { class: "num", style: r.diff < 0 ? "color:var(--bad)" : "color:var(--ok)" }, sum)));
    }
    const postBtn = el("button", { onclick: () => confirmPost(s, rows, postBtn) }, "Подтвердить и провести");
    root.append(el("div", { class: "card" }, el("div", { class: "favh" }, "Акт " + s.number + ": расхождения"),
      rows.length ? el("div", { class: "tscroll" }, t) : el("div", { class: "okbox" }, "Расхождений нет"),
      el("div", { class: "dim", style: "margin-top:8px" }, "Пересчитано позиций: " + countedCount),
      el("div", { class: "dim", style: "margin-top:4px" }, "Расчёт и суммы показаны на момент открытия сводки — остаток мог измениться, проведение пересчитает по текущим данным."),
      serr),
      el("div", { class: "bar" }, el("button", { class: "ghost", onclick: () => mount(root, ctx) }, "Назад к вводу"), postBtn));

    async function confirmPost(s, rows, btn) {
      serr.textContent = "";
      await withBusy(btn, async () => {
        try {
          const p = await ask("doc_post", { id: s.id });
          drafts.clear(SCN, st.id);
          ctx.result({ title: "Инвентаризация проведена: " + s.number, lines: [st.name + " · расхождений " + rows.length + " · сумма " + fmt(p.total_sum) + " ₸"], again: () => mount(root, ctx) });
        } catch (e) { serr.textContent = e.message + draftHint(s.number); }
      });
    }
  }
}
