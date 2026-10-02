import { ask, el, fmtMoney, today, toast, debounce, itemPicker, linesTable, drafts,
  withBusy, saveDoc, postDoc, showPosted, newKey, draftHint, okNum, numOf, hasNum, lineMatch, fmtQty, selectOnFocus } from "./common.js?v=21";

const SCN = "inventory";
export async function mount(root, ctx) {
  root.innerHTML = "";
  ctx.where = "Инвентаризация";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { lines: [], server_id: null, client_key: newKey() };
  const lines = d.lines;
  // Черновик пишется на каждый ввод цифры — без задержки это запись в localStorage
  // на каждое нажатие по списку в сотни строк.
  const save = debounce(() => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null, client_key: d.client_key }), 300);
  const saveNow = () => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null, client_key: d.client_key });

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

  // Список — сотни позиций (320 на складе кухни — 25 экранов прокрутки). Поэтому сверху, прилипая
  // при прокрутке, — поиск по списку и «только пересчитанные». Работа идёт кругом: набрал название →
  // Enter (курсор в «факт» первой найденной) → число → Enter (снова в поиск, старый текст выделен —
  // следующий набор его заменит).
  const q = el("input", { id: "i_q", placeholder: "Найти в списке: название или код", autocomplete: "off", autocapitalize: "off",
    spellcheck: "false", enterkeyhint: "go", "aria-label": "Найти в списке" });
  selectOnFocus(q);
  const onlyChk = el("input", { type: "checkbox", id: "i_only" });
  const counter = el("span", { class: "dim cnt" });
  const empty = el("div", { class: "empty" });
  empty.hidden = true;
  const toSearch = () => { q.focus(); q.select(); };
  const table = linesTable(lines, { columns: [{ key: "fact_qty", title: "Факт", input: true, width: "110px" }],
    onChange: () => { save(); count(); }, onRemove: () => { save(); refilter(); },
    // Ищут по одной позиции — после числа обратно в поиск; листают без поиска — к следующей строке.
    onEnter: () => { if (q.value.trim()) { toSearch(); return true; } return false; },
    onLast: toSearch });
  const picker = itemPicker({ storeId: st.id, tiles: false, label: "Найти в номенклатуре", onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { goTo(it, "Уже в списке — вот эта строка"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, fact_qty: "", avg_cost: Number(it.avg_cost) || null });
    table.redraw(); saveNow(); goTo(it);
  } });
  function count() {
    const n = lines.filter((l) => hasNum(l.fact_qty)).length;
    counter.textContent = "Пересчитано " + n + " из " + lines.length;
  }
  // Отбор: слова поиска и «только пересчитанные». Пусто — подсказка и поиск по всей номенклатуре
  // (позиции без остатка в списке нет, но её тоже можно пересчитать).
  function refilter() {
    const text = q.value.trim(), only = onlyChk.checked;
    const n = table.setFilter(text || only ? (l) => lineMatch(l, text) && (!only || hasNum(l.fact_qty)) : null);
    count();
    empty.innerHTML = "";
    empty.hidden = n > 0 || !lines.length;
    if (empty.hidden) return;
    // Позиция есть в списке, но ещё не пересчитана — предлагаем весь список, а не номенклатуру.
    if (text && only && lines.some((l) => lineMatch(l, text))) {
      empty.append(el("div", {}, "Среди пересчитанных нет «" + text + "»."),
        el("button", { type: "button", class: "ghost", onclick: () => { onlyChk.checked = false; refilter(); } }, "Показать весь список"));
    } else if (text) {
      empty.append(el("div", {}, "В списке нет «" + text + "»."),
        el("button", { type: "button", class: "ghost", onclick: () => { picker.find(text); picker.input.scrollIntoView({ block: "center" }); picker.input.focus({ preventScroll: true }); } },
          "Найти «" + text + "» в номенклатуре"));
    } else empty.append(el("div", {}, "Пока ничего не пересчитано."));
  }
  // К строке позиции: показываем только её (поиск — по названию), курсор в «факт».
  function goTo(it, msg) {
    q.value = it.name; onlyChk.checked = false; refilter();
    table.focusLine(it.code);
    if (msg) toast(msg);
  }
  q.addEventListener("input", refilter);
  q.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = [...table.root.querySelectorAll("input[data-nav]")].find((x) => x.offsetParent !== null);
    if (first) { first.scrollIntoView({ block: "center" }); first.focus({ preventScroll: true }); }
  });
  onlyChk.addEventListener("change", refilter);

  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" },
      el("div", { class: "dim" }, "Введите фактическое количество по каждой позиции. Пустое поле — позиция не пересчитывалась и в акт не попадёт."),
      el("div", { class: "tools sticky" }, q,
        el("div", { class: "trow" }, el("label", { class: "chk", for: "i_only" }, onlyChk, "только пересчитанные"), counter)),
      empty, table.root),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Добавить позицию, которой нет в списке"), picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));
  refilter();

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
        s = await saveDoc(d, { doc_type: "inventory", doc_date: today(), store_from: st.id,
          lines: counted.map((l) => ({ item_code: l.item_code, fact_qty: numOf(l.fact_qty) })) }, saveNow);
        if (s.already) return showPosted(ctx, SCN, st.id, s, () => mount(root, ctx), d);
        d.server_id = s.id; saveNow();
        const g = await ask("doc_get", { id: s.id });
        // сводка расхождений — только теперь показываем расчёт
        const cost = {}; for (const l of lines) cost[l.item_code] = l.avg_cost;
        const rows = g.doc.lines.map((l) => ({ name: l.name, unit: l.unit_id, fact: Number(l.fact_qty), calc: Number(l.current_qty || 0), cost: cost[l.item_code] }))
          .map((r) => ({ ...r, diff: r.fact - r.calc })).filter((r) => Math.abs(r.diff) > 1e-9);
        showSummary(s, rows, counted.length);
      } catch (e) {
        err.textContent = e.message + draftHint(s && s.number, e);
      }
    });
  }

  // Сводка расхождений. На телефоне — не таблица в пять колонок (в 390 px числа и заголовки рвались
  // по буквам: «214,3 / 4», «ФАК Т»), а карточка на позицию: название целиком, под ним четыре числа
  // с подписями, числа не переносятся. Внизу — итог недостачи и излишков в деньгах.
  function showSummary(s, rows, countedCount) {
    ctx.where = "Инвентаризация · сводка";
    root.innerHTML = "";
    const serr = el("div", { class: "err" });
    const list = el("div", { class: "disc-list" });
    let short = 0, surplus = 0, nocost = 0;
    const cell = (label, value, cls) => el("div", { class: cls || null }, el("span", {}, label), el("b", {}, value));
    for (const r of rows) {
      // Сумма расхождения — по средней себестоимости склада на момент построения списка.
      // Для позиций, добавленных поиском, средней нет: суммы нет.
      const sum = r.cost === null || r.cost === undefined ? null : r.diff * r.cost;
      if (sum === null) nocost++; else if (sum < 0) short -= sum; else surplus += sum;
      const cls = r.diff < 0 ? "bad" : "ok";
      list.append(el("div", { class: "disc" },
        el("div", { class: "dn" }, r.name, r.unit ? el("i", {}, " · " + r.unit) : null),
        el("div", { class: "dg" },
          cell("Факт", fmtQty(r.fact)), cell("Расчёт", fmtQty(r.calc)),
          cell("Разница", (r.diff > 0 ? "+" : "") + fmtQty(r.diff), cls),
          cell("Сумма, ₸", sum === null ? "—" : (sum > 0 ? "+" : "") + fmtMoney(sum), cls))));
    }
    const postBtn = el("button", { onclick: () => confirmPost(s, rows, postBtn) }, "Подтвердить и провести");
    root.append(el("div", { class: "card" }, el("div", { class: "favh" }, "Акт " + s.number + ": расхождения"),
      rows.length ? list : el("div", { class: "okbox" }, "Расхождений нет"),
      rows.length ? el("div", { class: "disc-tot" },
        el("div", {}, el("span", {}, "Недостача"), el("b", { class: "bad" }, fmtMoney(short) + " ₸")),
        el("div", {}, el("span", {}, "Излишки"), el("b", { class: "ok" }, fmtMoney(surplus) + " ₸"))) : null,
      nocost ? el("div", { class: "dim", style: "margin-top:4px" }, "Без суммы (позиция добавлена поиском, средней цены нет): " + nocost) : null,
      el("div", { class: "dim", style: "margin-top:8px" }, "Пересчитано позиций: " + countedCount),
      el("div", { class: "dim", style: "margin-top:4px" }, "Расчёт и суммы показаны на момент открытия сводки — остаток мог измениться, проведение пересчитает по текущим данным."),
      serr),
      el("div", { class: "bar" }, el("button", { class: "ghost", onclick: () => mount(root, ctx) }, "Назад к вводу"), postBtn));

    async function confirmPost(s, rows, btn) {
      serr.textContent = "";
      await withBusy(btn, async () => {
        try {
          const p = await postDoc(s.id);
          if (p.already) return showPosted(ctx, SCN, st.id, p, () => mount(root, ctx), d);
          drafts.clear(SCN, st.id);
          ctx.result({ title: "Инвентаризация проведена: " + s.number, lines: [st.name + " · расхождений " + rows.length + " · сумма " + fmtMoney(p.total_sum) + " ₸"], again: () => mount(root, ctx) });
        } catch (e) { serr.textContent = e.message + draftHint(s.number, e); }
      });
    }
  }
}
