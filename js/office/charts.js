import { api, can } from "./api.js?v=20";
import { el, fmt, toast, debounce, modal, confirmDlg, today, errText } from "./ui.js?v=20";

const TYPES = { dish: "блюдо", prepared: "полуфабрикат" };
let root, table, pager, groups = [];
let state = { q: "", group_id: "", only: "", page: 1, tab: "list" };
// Номер последнего запроса списка: ответ на устаревший поиск («му» после «мука») не рисуется.
let listSeq = 0;

export async function mount(r) {
  root = r; state.page = 1;
  groups = (await api("groups_list", {})).groups || [];
  drawShell();
  // Вкладка помнится между заходами в раздел: вернулись на «Фудкост меню» — грузим его, а не пустой список.
  await (state.tab === "report" ? loadReport() : load());
}
export function openChart(code) { editChart(code); }

function drawShell() {
  root.innerHTML = "";
  const tabs = el("div", { class: "tools" },
    el("button", { class: state.tab === "list" ? "" : "ghost", onclick: () => { state.tab = "list"; drawShell(); load(); } }, "Карты"),
    el("button", { class: state.tab === "report" ? "" : "ghost", onclick: () => { state.tab = "report"; drawShell(); loadReport(); } }, "Фудкост меню"));
  root.append(tabs);
  if (state.tab === "report") { root.append(el("div", { id: "fc-root" })); return; }
  const groupSel = el("select", { onchange: (e) => { state.group_id = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.group_id === "" }, "все группы"),
    ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === state.group_id }, g.name)));
  const onlySel = el("select", { onchange: (e) => { state.only = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.only === "" }, "все блюда"),
    el("option", { value: "no_chart", selected: state.only === "no_chart" }, "без карты"),
    el("option", { value: "no_cost", selected: state.only === "no_cost" }, "без себестоимости"));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Поиск блюда или полуфабриката", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
      groupSel, onlySel),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}

async function load() {
  if (state.tab !== "list") return;
  const n = ++listSeq;
  const r = await api("charts_list", { q: state.q, group_id: state.group_id || null, only: state.only || null, page: state.page });
  if (n !== listSeq) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Позиция", "Тип", "Карта", "Выход", "Себестоимость", "Цена", "Фудкост"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) {
    table.append(el("tr", { class: "row", onclick: () => editChart(x.code) },
      el("td", {}, x.name, el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, x.group_name || "")),
      el("td", {}, TYPES[x.item_type] || x.item_type),
      el("td", {}, x.chart_id ? "с " + x.date_from : el("span", { class: "tag bad" }, "нет карты")),
      el("td", { class: "num" }, x.output_amount != null ? fmt(x.output_amount) + " " + (x.unit_id || "") : ""),
      el("td", { class: "num" }, x.cost != null ? fmt(x.cost) : (x.chart_id ? el("span", { class: "tag" }, "нет цены у " + x.missing_count) : "")),
      el("td", { class: "num" }, fmt(x.price)),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok") }, fmt(x.foodcost_pct) + " %") : "")));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

// ---------- редактор ----------
async function editChart(code, chartId) {
  const r = await api("chart_get", { code, id: chartId || null });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const ro = !can("charts", "edit");
  const item = r.item, ch = r.chart;
  // Форма с вводом: по фону не закрывается, «Отмена» и смена версии при правках переспрашивают.
  const m = modal(`${item.name} · техкарта`, { keep: !ro });
  m.root.style.maxWidth = "900px";
  // версии
  if (r.versions.length) {
    const vs = el("select", { "data-nodirty": "", onchange: (e) => {
        if (m.dirty && !confirmDlg("Открыть другую версию? Несохранённые правки этой пропадут.")) { e.target.value = ch ? ch.id : ""; return; }
        m.close(); editChart(code, e.target.value);
      } },
      ...r.versions.map((v) => el("option", { value: v.id, selected: ch && v.id === ch.id }, `с ${v.date_from}${v.date_to ? " по " + v.date_to : " — действует"}${v.source === "iiko" ? " · iiko" : ""}`)));
    m.root.append(el("div", { class: "tools" }, el("span", { class: "dim" }, "Версия:"), vs));
  }
  // Закрытая версия правится «задним числом»: расчёты за её период поедут. Для изменений
  // с новой даты есть «Новая версия» — говорим об этом прямо над формой.
  if (ch && ch.date_to) {
    m.root.append(el("div", { class: "dim" },
      `Вы правите версию, закрытую датой ${ch.date_to}; для изменений с новой даты используйте «Новая версия».`));
  }
  const f = {
    date_from: el("input", { type: "date", value: ch ? ch.date_from : today(), readonly: ro }),
    date_to: el("input", { type: "date", value: ch && ch.date_to ? ch.date_to : "", readonly: ro }),
    output: el("input", { type: "number", step: "0.001", value: ch ? ch.output_amount : 1, readonly: ro }),
    technology: el("textarea", { readonly: ro }, ch && ch.technology ? ch.technology : ""),
  };
  m.root.append(el("div", { class: "grid2" },
    el("div", {}, el("label", {}, "Действует с"), f.date_from), el("div", {}, el("label", {}, "по (пусто — бессрочно)"), f.date_to),
    el("div", {}, el("label", {}, `Выход, ${item.unit_id}`), f.output),
    el("div", {}, el("label", {}, "Цена продажи"), el("input", { value: fmt(item.price), readonly: true }))),
    el("label", {}, "Технология"), f.technology);
  // строки
  const lines = (ch ? ch.lines : []).map((l) => ({ ...l }));
  const tbl = el("table");
  const totals = el("div", { class: "tot" });
  const warn = el("div", { class: "err" });
  function num(v) { return v === "" || v == null ? 0 : Number(v); }
  // Ввод в строке меняет только данные строки, её ячейки (потери, сумма, подсветка) и итог —
  // поля ввода не пересоздаются. Раньше на каждый input таблица собиралась заново, новое поле
  // получало фокус с кареткой в начале, и «0.5» превращалось в «50», а «120» — в «021».
  // Полная перерисовка (drawLines) — только при добавлении и удалении строк.
  let rows = [];
  function refresh() {
    let sum = 0, complete = true;
    const missing = [];
    for (const { l, c } of rows) {
      const cold = num(l.brutto) > 0 ? (num(l.brutto) - num(l.netto)) / num(l.brutto) * 100 : 0;
      const hot = num(l.netto) > 0 ? (num(l.netto) - num(l.output)) / num(l.netto) * 100 : 0;
      const lineCost = l.ing_cost != null ? num(l.brutto) * Number(l.ing_cost) : null;
      if (lineCost == null) { complete = false; missing.push(l.name); } else sum += lineCost;
      c.loss.textContent = `${cold.toFixed(1)} / ${hot.toFixed(1)} %`;
      c.cost.textContent = lineCost != null ? fmt(lineCost) : "";
      c.tr.className = num(l.netto) > num(l.brutto) ? "off" : "";
    }
    const out = num(f.output.value) || 0;
    const perUnit = complete && out > 0 ? sum / out : null;
    totals.innerHTML = "";
    totals.append(el("span", {}, complete ? "Себестоимость на выход / за единицу" : "Посчитано частично (нет цен)"),
      el("span", {}, `${fmt(sum)} / ${perUnit != null ? fmt(perUnit) : "—"} ₸` +
        (perUnit != null && item.price ? ` · фудкост ${fmt(perUnit / item.price * 100)} % · наценка ${fmt((item.price - perUnit) / perUnit * 100)} %` : "")));
    warn.textContent = missing.length ? "Нет учётной цены: " + missing.join(", ") + " — задайте её в карточке товара" : "";
    if (lines.some((l) => num(l.netto) > num(l.brutto))) warn.textContent += (warn.textContent ? " · " : "") + "Есть строки, где нетто больше брутто";
  }
  function drawLines() {
    tbl.innerHTML = ""; rows = [];
    tbl.append(el("tr", {}, ...["Ингредиент", "Ед.", "Брутто", "Нетто", "Выход", "Потери хол./гор.", "Цена", "Сумма", ""].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    for (const l of lines) {
      const c = {};
      const inp = (key) => (c[key] = el("input", { type: "number", step: "0.001", value: l[key] ?? "", readonly: ro, style: "text-align:right;padding:6px",
        oninput: (e) => {
          const v = e.target.value; const prev = l[key]; l[key] = v;
          // автоподстановка вниз по цепочке, если поля ещё не правились вручную: значение пишется
          // в соседние поля через .value, само поле, в котором набирают, не трогается
          if (key === "brutto" && (l.netto === prev || l.netto === "" || l.netto == null)) { l.netto = v; c.netto.value = v; }
          if ((key === "brutto" || key === "netto") && (l.output === prev || l.output === "" || l.output == null)) { l.output = l.netto; c.output.value = l.netto; }
          refresh();
        } }));
      c.loss = el("td", { class: "num dim" });
      c.cost = el("td", { class: "num" });
      c.tr = el("tr", {},
        el("td", {}, l.name, l.item_type !== "goods" ? el("span", { class: "tag", style: "margin-left:6px" }, TYPES[l.item_type] || l.item_type) : null),
        el("td", {}, l.unit), el("td", { class: "num" }, inp("brutto")), el("td", { class: "num" }, inp("netto")), el("td", { class: "num" }, inp("output")),
        c.loss,
        el("td", { class: "num" }, l.ing_cost != null ? fmt(l.ing_cost) : el("span", { class: "tag bad" }, "нет")),
        c.cost,
        el("td", {}, ro ? null : el("button", { class: "x", onclick: () => { lines.splice(lines.indexOf(l), 1); m.dirty = true; drawLines(); } }, "×")));
      tbl.append(c.tr);
      rows.push({ l, c });
    }
    refresh();
  }
  f.output.addEventListener("input", refresh);
  drawLines();
  m.root.append(el("h2", { style: "margin-top:14px" }, "Состав"), tbl, totals, warn);
  // добавление ингредиента
  if (!ro) {
    const search = el("input", { placeholder: "Добавить ингредиент: начните вводить название", "data-nodirty": "" });
    const res = el("div", { class: "sres" });
    search.addEventListener("input", debounce(async () => {
      const q = search.value.trim(); res.innerHTML = "";
      if (q.length < 2) return;
      const s = await api("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).slice(0, 12)) {
        if (it.code === code || lines.some((l) => l.ingredient_code === it.code)) continue;
        res.append(el("button", { class: "sitem", onclick: async () => {
          const c = await api("item_cost_get", { code: it.code });
          lines.push({ ingredient_code: it.code, name: it.name, unit: it.unit_id, item_type: it.item_type, brutto: "", netto: "", output: "", ing_cost: c.ok ? c.cost : null });
          search.value = ""; res.innerHTML = ""; m.dirty = true; drawLines();
        } }, it.name, el("span", { class: "dim" }, ` · ${it.unit_id} · ${it.item_type === "goods" ? "товар" : TYPES[it.item_type] || it.item_type}`)));
      }
    }, 300));
    m.root.append(el("div", { class: "sbox", style: "margin-top:10px" }, search, res));
  }
  const err = el("div", { class: "err" });
  const actions = el("div", { class: "actions" });
  if (!ro) {
    actions.append(el("button", { onclick: save }, "Сохранить"));
    if (ch) actions.append(el("button", { class: "ghost", onclick: newVersion }, "Новая версия с даты…"));
    if (ch && ch.source === "office") actions.append(el("button", { class: "ghost", onclick: del }, "Удалить версию"));
  }
  actions.append(el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);

  async function save(e) {
    err.textContent = "";
    // Пустое брутто — забытое количество, а не ноль: строка молча ушла бы нулём, ингредиент не
    // списывался бы и не попадал в себестоимость. Ноль, вписанный явно, допустим (так пришли карты iiko).
    const empty = lines.filter((l) => l.brutto === "" || l.brutto == null);
    if (empty.length) { err.textContent = "Впишите брутто: " + empty.map((l) => l.name).join(", ") + ". Ноль допустим, если так и задумано."; return; }
    const p = { id: ch ? ch.id : undefined, code, date_from: f.date_from.value, date_to: f.date_to.value || null,
      output_amount: f.output.value, technology: f.technology.value,
      lines: lines.map((l) => ({ ingredient_code: l.ingredient_code, brutto: Number(l.brutto), netto: num(l.netto), output: num(l.output) })) };
    const b = e.target; b.disabled = true;   // второе нажатие до ответа не уходит вторым сохранением
    const r2 = await api("chart_save", p);
    b.disabled = false;
    if (!r2.ok) { err.textContent = errText(r2); return; }
    toast("Сохранено"); m.close(); load();
  }
  // Дата новой версии — календарём, а не свободным текстом: «01.10.2026» в окне prompt база
  // понимала как месяц-день и тихо создавала версию с 10 января.
  function newVersion() {
    if (m.dirty && !confirmDlg("Несохранённые правки этой версии пропадут. Создать новую версию?")) return;
    const d = modal("Новая версия карты", { keep: true });
    const date = el("input", { type: "date", value: today() });
    const e2 = el("div", { class: "err" });
    const go = el("button", { onclick: async () => {
      e2.textContent = "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { e2.textContent = "Выберите дату в календаре"; return; }
      go.disabled = true;
      const r2 = await api("chart_new_version", { code, date_from: date.value });
      go.disabled = false;
      if (!r2.ok) { e2.textContent = errText(r2); return; }
      d.close(); toast("Версия создана"); m.close(); editChart(code, r2.id);
    } }, "Создать версию");
    d.root.append(el("div", { class: "dim" }, "Новая версия — копия действующей; правки внесите в неё. Текущая версия закроется днём раньше выбранной даты."),
      el("label", {}, "Действует с"), date, e2,
      el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: d.close }, "Отмена")));
    date.focus();
  }
  async function del(e) {
    if (!confirmDlg("Удалить эту версию карты?")) return;
    const b = e.target; b.disabled = true;
    const r2 = await api("chart_delete", { id: ch.id });
    b.disabled = false;
    if (!r2.ok) { err.textContent = errText(r2); return; }
    toast("Удалено"); m.close(); load();
  }
}

// ---------- отчёт ----------
// Дата по умолчанию — сегодня на момент открытия вкладки, а не загрузки модуля: бэк-офис,
// открытый вчера, считал бы фудкост на вчерашнее число. Дату, выбранную руками, не трогаем.
let fc = { point_id: "", group_id: "", date: "", auto: true, sort: "foodcost_pct" };
let fcSeq = 0;
async function loadReport() {
  const host = document.getElementById("fc-root"); if (!host) return;
  // Строка фильтров строится один раз при открытии вкладки; дальше обновляется только результат,
  // а ответ, обогнанный более новым запросом, не рисуется.
  if (!host.firstChild) {
    if (fc.auto) fc.date = today();
    const ptSel = el("select", { onchange: (e) => { fc.point_id = e.target.value; loadReport(); } },
      el("option", { value: "", selected: fc.point_id === "" }, "цена по умолчанию"));
    host.append(el("div", { class: "tools" }, ptSel,
      el("select", { onchange: (e) => { fc.group_id = e.target.value; loadReport(); } },
        el("option", { value: "", selected: fc.group_id === "" }, "все группы"),
        ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === fc.group_id }, g.name))),
      el("input", { type: "date", value: fc.date, onchange: debounce((e) => { fc.date = e.target.value; fc.auto = false; loadReport(); }, 400) }),
      el("span", { class: "dim fc-info" }), el("button", { class: "ghost fc-csv" }, "CSV")),
      el("div", { class: "out" }));
    api("stores_list", {}).then((s) => {   // список точек уже отдаёт stores_list
      const pts = s.points || [];
      for (const p of pts) ptSel.append(el("option", { value: p.id, selected: p.id === fc.point_id }, "цены точки: " + p.name));
      if (fc.point_id && !pts.some((p) => p.id === fc.point_id)) { fc.point_id = ""; ptSel.value = ""; loadReport(); }
    });
  }
  const out = host.querySelector(":scope > .out"), info = host.querySelector(".fc-info"), csvBtn = host.querySelector(".fc-csv");
  const n = ++fcSeq;
  const r = await api("foodcost_report", { point_id: fc.point_id || null, group_id: fc.group_id || null, date: fc.date });
  if (n !== fcSeq) return;
  out.innerHTML = ""; info.textContent = ""; csvBtn.onclick = null;
  if (!r.ok) { out.append(el("div", { class: "err" }, errText(r))); return; }
  const rows = r.rows.slice().sort((a, b) => (b[fc.sort] ?? -1) - (a[fc.sort] ?? -1));
  const priced = rows.filter((x) => x.cost != null).length;
  csvBtn.onclick = () => {
    const blob = new Blob(["﻿" + r.csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `foodcost_${fc.date}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  info.textContent = `позиций ${rows.length}, с себестоимостью ${priced}, порог ${fmt(r.limit)} %`;
  const t = el("table");
  const th = (key, title, cls) => el("th", { class: (cls || "") + " row", onclick: () => { fc.sort = key; loadReport(); } }, title + (fc.sort === key ? " ▼" : ""));
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Группа"), th("cost", "Себестоимость", "num"), th("price", "Цена", "num"), th("markup_pct", "Наценка %", "num"), th("foodcost_pct", "Фудкост %", "num"), el("th", {}, "Нет цены у")));
  for (const x of rows) {
    t.append(el("tr", { class: "row", onclick: () => editChart(x.code) },
      el("td", {}, x.name), el("td", { class: "dim" }, x.group_name || ""), el("td", { class: "num" }, fmt(x.cost)), el("td", { class: "num" }, fmt(x.price)),
      el("td", { class: "num" }, x.markup_pct != null ? fmt(x.markup_pct) : ""),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok") }, fmt(x.foodcost_pct)) : ""),
      el("td", { class: "dim" }, (x.missing || []).slice(0, 3).join(", ") + ((x.missing || []).length > 3 ? "…" : ""))));
  }
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}
