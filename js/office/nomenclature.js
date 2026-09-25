import { api, can } from "./api.js?v=16";
import { el, fmt, toast, debounce, modal } from "./ui.js?v=16";
import { loadXlsx } from "./stock.js?v=16";

const TYPES = { goods: "товар", dish: "блюдо", prepared: "полуфабрикат", service: "услуга" };
let groups = [], state = { q: "", group_id: "", item_type: "", active: "true", page: 1 };
let tree, table, pager, root;

export async function mount(r) {
  root = r;
  const g = await api("groups_list", {});
  groups = g.groups || [];
  tree = el("div", { class: "card tree" });
  const tools = el("div", { class: "tools" },
    el("input", { placeholder: "Поиск: название, артикул, код", value: state.q,
      oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
    select({ "": "все типы", ...TYPES }, state.item_type, (v) => { state.item_type = v; state.page = 1; load(); }),
    select({ "true": "активные", "false": "выключенные", "": "все" }, state.active, (v) => { state.active = v; state.page = 1; load(); }),
    can("nomenclature", "edit") ? el("button", { onclick: () => editItem(null) }, "+ Позиция") : null,
    can("nomenclature", "edit") ? el("button", { class: "ghost", onclick: importPrices }, "Загрузить прейскурант") : null,
  );
  table = el("table");
  pager = el("div", { class: "pager" });
  root.append(el("div", { class: "split" }, tree, el("div", {}, tools, el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager)));
  drawTree();
  await load();
}

function select(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

function drawTree() {
  tree.innerHTML = "";
  tree.append(el("h2", {}, "Группы"),
    el("button", { class: state.group_id === "" ? "on" : "", onclick: () => pick("") }, "Все позиции"));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const shownParent = (g) => { const p = g.parent_id ? byId.get(g.parent_id) : null; return p && p.active ? p.id : null; };
  const kids = (pid) => groups.filter((g) => g.active && shownParent(g) === pid).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  const walk = (pid, depth) => {
    for (const g of kids(pid)) {
      tree.append(el("button", { class: state.group_id === g.id ? "on" : "", style: `padding-left:${8 + depth * 14}px`, onclick: () => pick(g.id) },
        g.name, el("i", {}, g.items_count)));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  if (can("nomenclature", "edit")) tree.append(el("button", { class: "link", onclick: () => editGroup(null) }, "+ Группа"),
    state.group_id ? el("button", { class: "link", onclick: () => editGroup(groups.find((g) => g.id === state.group_id)) }, "Переименовать / переместить") : null);
}

function pick(id) { state.group_id = id; state.page = 1; drawTree(); load(); }

async function load() {
  const p = { q: state.q, group_id: state.group_id || null, item_type: state.item_type || null, page: state.page };
  if (state.active !== "") p.active = state.active === "true";
  const r = await api("items_search", p);
  if (!r.ok) { toast(r.message, "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Код", "Название", "Артикул", "Тип", "Ед.", "Группа", "Цена", ""].map((h, i) => el("th", { class: i === 6 ? "num" : "" }, h))));
  for (const it of r.rows) {
    table.append(el("tr", { class: "row" + (it.active ? "" : " off"), onclick: () => editItem(it.code) },
      el("td", {}, it.code), el("td", {}, it.name), el("td", {}, it.artikul || ""), el("td", {}, TYPES[it.item_type] || it.item_type),
      el("td", {}, it.unit_id || ""), el("td", { class: "dim" }, it.group_name || "—"), el("td", { class: "num" }, fmt(it.price)),
      el("td", {}, it.for_sale ? el("span", { class: "tag ok" }, "продаётся") : null)));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 8, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

// Открыть карточку по ссылке #item/<код> (из вкладки «Готовность»).
export function openItem(code) { editItem(code); }
async function editItem(code) {
  let item = { item_type: "dish", unit_id: "шт", group_id: state.group_id || "", active: true, for_sale: false }, points = [], r = null;
  if (code) {
    r = await api("item_get", { code });
    if (!r.ok) { toast(r.message, "bad"); return; }
    item = r.item; points = r.points;
  }
  const ro = !can("nomenclature", "edit");
  const m = modal(code ? `Позиция ${code}` : "Новая позиция");
  const f = {};
  const field = (key, label, node) => { f[key] = node; return el("div", {}, el("label", {}, label), node); };
  const groupSel = el("select", { disabled: ro }, el("option", { value: "" }, "— без группы —"),
    ...groups.map((g) => el("option", { value: g.id, selected: g.id === item.group_id }, g.name)));
  m.root.append(el("div", { class: "grid2" },
    field("name", "Название", el("input", { value: item.name || "", readonly: ro })),
    field("artikul", "Артикул", el("input", { value: item.artikul || "", readonly: ro })),
    field("item_type", "Тип", select(TYPES, item.item_type, () => {}, ro)),
    field("unit_id", "Единица", select({ "шт": "шт", "кг": "кг", "л": "л", "порц": "порц" }, item.unit_id, () => {}, ro)),
    field("group_id", "Группа", groupSel),
    field("price", "Цена по умолчанию", el("input", { type: "number", step: "0.01", value: item.price ?? "", readonly: ro })),
    field("pack_factor", "Фасовка: множитель", el("input", { type: "number", step: "0.001", value: item.pack_factor ?? "", readonly: ro })),
    field("pack_unit", "Фасовка: единица", el("input", { value: item.pack_unit || "", readonly: ro })),
    field("pack_price", "Фасовка: цена", el("input", { type: "number", step: "0.01", value: item.pack_price ?? "", readonly: ro })),
    field("note", "Заметка", el("input", { value: item.note || "", readonly: ro })),
    item.item_type === "goods" || !code
      ? field("cost_price", "Учётная цена сырья (за " + (item.unit_id || "ед.") + ")", el("input", { type: "number", step: "0.01", value: item.cost_price ?? "", readonly: ro }))
      : null,
  ));
  if (f.cost_price && item.cost_price != null) {
    const srcLabel = { manual: "вручную", iiko_invoice: "накладная iiko", document: "документ" }[item.cost_source] || item.cost_source || "";
    const dateStr = item.cost_date ? new Date(item.cost_date).toLocaleDateString("ru-RU") : "";
    m.root.append(el("div", { class: "dim" }, `источник: ${srcLabel}${dateStr ? ", " + dateStr : ""}`));
  }
  f.active = el("input", { type: "checkbox", checked: item.active, disabled: ro });
  f.for_sale = el("input", { type: "checkbox", checked: item.for_sale, disabled: ro });
  m.root.append(el("div", { class: "actions" }, el("label", {}, f.active, " активна"), el("label", {}, f.for_sale, " продаётся на точках")));
  if (code) {
    const pt = el("table");
    pt.append(el("tr", {}, el("th", {}, "Точка"), el("th", { class: "num" }, "Цена точки"), el("th", {}, "Короткий лист"), el("th", { class: "num" }, "Ранг")));
    const priceInputs = {};
    for (const p of points) {
      priceInputs[p.point_id] = el("input", { type: "number", step: "0.01", value: p.price ?? "", readonly: ro, style: "text-align:right" });
      pt.append(el("tr", {}, el("td", {}, p.point_name), el("td", { class: "num" }, priceInputs[p.point_id]),
        el("td", {}, p.short ? el("span", { class: "tag" }, "да") : ""), el("td", { class: "num" }, p.rank ?? "")));
    }
    m.root.append(el("h2", { style: "margin-top:16px" }, "Цены по точкам"), pt);
    f._prices = priceInputs;
  }
  if (code && (item.item_type === "dish" || item.item_type === "prepared")) {
    const costText = r.cost != null ? `${fmt(r.cost)} ₸ за ${item.unit_id}` : (r.missing && r.missing.length ? `не посчитана — нет цены у: ${r.missing.slice(0, 5).join(", ")}${r.missing.length > 5 ? "…" : ""}` : "не посчитана");
    m.root.append(el("div", { class: "tot" }, el("span", {}, "Себестоимость на сегодня"), el("span", {}, costText)),
      el("div", { style: "margin-top:8px" }, el("a", { class: "link", href: "#charts/" + encodeURIComponent(code), onclick: (e) => { e.preventDefault(); m.close(); location.hash = "#charts/" + encodeURIComponent(code); location.reload(); } }, "Открыть техкарту →")));
  }
  if (code) {
    const st = await api("item_stock", { code });
    if (st.ok && (st.balances.length || st.moves.length)) {
      const bt = el("table"); bt.append(el("tr", {}, el("th", {}, "Склад"), el("th", { class: "num" }, "Остаток"), el("th", { class: "num" }, "Средняя")));
      for (const b of st.balances) bt.append(el("tr", {}, el("td", {}, b.store_name), el("td", { class: "num" + (Number(b.qty) < 0 ? " bad" : "") }, fmt(b.qty)), el("td", { class: "num" }, fmt(b.avg_cost))));
      const mt = el("table"); mt.append(el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Документ"), el("th", {}, "Склад"), el("th", { class: "num" }, "Кол-во")));
      for (const mv of st.moves.slice(0, 10)) mt.append(el("tr", {}, el("td", {}, mv.move_date), el("td", {}, mv.number), el("td", { class: "dim" }, mv.store_name), el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty))));
      m.root.append(el("h2", { style: "margin-top:16px" }, "Остатки по складам"), bt, el("h2", { style: "margin-top:12px" }, "Последние движения"), mt);
    }
  }
  const err = el("div", { class: "err" });
  m.root.append(err, el("div", { class: "actions" },
    ro ? null : el("button", { onclick: save }, "Сохранить"),
    el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
  async function save() {
    const p = { code: code || undefined, name: f.name.value, artikul: f.artikul.value, item_type: f.item_type.value, unit_id: f.unit_id.value,
      group_id: f.group_id.value || null, price: f.price.value, pack_factor: f.pack_factor.value, pack_unit: f.pack_unit.value,
      pack_price: f.pack_price.value, note: f.note.value, cost_price: f.cost_price ? f.cost_price.value : undefined,
      active: f.active.checked, for_sale: f.for_sale.checked };
    const r = await api("item_save", p);
    if (!r.ok) { err.textContent = r.message; return; }
    if (f._prices) {
      const prices = Object.entries(f._prices).map(([point_id, inp]) => ({ point_id, price: inp.value === "" ? null : Number(inp.value) }));
      const r2 = await api("item_prices_save", { code: r.code, prices });
      if (!r2.ok) { err.textContent = r2.message; return; }
    }
    m.close();
    const g = await api("groups_list", {}); groups = g.groups || []; drawTree(); load();
    // Цены по точкам привязаны к коду позиции, а у новой его до сохранения нет — поэтому
    // новая карточка сразу открывается снова, уже с таблицей цен (раньше — только со второго раза).
    if (!code) { toast("Позиция создана — задайте цены по точкам"); editItem(r.code); } else toast("Сохранено");
  }
}

async function editGroup(g) {
  const m = modal(g ? "Группа" : "Новая группа");
  const name = el("input", { value: g ? g.name : "" });
  const parent = el("select", {}, el("option", { value: "" }, "— верхний уровень —"),
    ...groups.filter((x) => !g || x.id !== g.id).map((x) => el("option", { value: x.id, selected: g && x.id === g.parent_id }, x.name)));
  const active = el("input", { type: "checkbox", checked: g ? g.active : true });
  const err = el("div", { class: "err" });
  m.root.append(el("label", {}, "Название"), name, el("label", {}, "Родитель"), parent,
    el("div", { class: "actions" }, el("label", {}, active, " активна")), err,
    el("div", { class: "actions" }, el("button", { onclick: async () => {
      const r = await api("group_save", { id: g ? g.id : undefined, name: name.value, parent_id: parent.value || null, active: active.checked });
      if (!r.ok) { err.textContent = r.message; return; }
      toast("Сохранено"); m.close();
      const gl = await api("groups_list", {}); groups = gl.groups || []; drawTree(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  name.focus();
}

// ---------- цены по точкам из «Сводного прейскуранта» iiko ----------
// Файл разбирается здесь: строка заголовка «Блюдо … Артикул», по подразделению — первая колонка
// «Цена, тг.». Для каждого подразделения человек отмечает, каким точкам взять его цены; подсказки —
// по названию (сопоставление, подтверждённое Андреем 19.09.2026).
const DEP_HINTS = [[/ЕНЕШКА/i, ["eneshka"]], [/^Буфеты/i, ["univer_b", "kmk"]], [/Тандем Университет/i, ["univer_s"]], [/^Актау/i, ["aktau"]]];
function importPrices() {
  const m = modal("Загрузить прейскурант");
  const file = el("input", { type: "file", accept: ".xlsx,.xls" });
  const body = el("div");
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "dim" }, "Файл из iiko: «Сводный прейскурант» в Excel. Цены сопоставляются с позициями по артикулу и заменяют текущие цены выбранных точек."),
    el("label", {}, "Файл"), file, body, err, el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
  file.onchange = async () => {
    err.textContent = ""; body.innerHTML = "";
    const f = file.files[0]; if (!f) return;
    let a, points;
    try {
      await loadXlsx();
      const wb = window.XLSX.read(await f.arrayBuffer(), { type: "array" });
      a = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
      const pr = await api("store_points_list", {}); points = pr.ok ? pr.points.filter((x) => x.active) : [];
    } catch (e) { err.textContent = "Файл не прочитался: " + e.message; return; }
    const h = a.findIndex((r) => String(r[0]).trim() === "Блюдо" && /Артикул/i.test(String(r[2])));
    if (h < 0) { err.textContent = "Это не «Сводный прейскурант»: не нашёл строку заголовка «Блюдо … Артикул»."; return; }
    const date = (String(a[0][0]).match(/\d{2}\.\d{2}\.\d{4}/) || [""])[0];
    const num = (v) => { const t = String(v).replace(/\s/g, "").replace(",", "."); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
    const deps = [];
    a[h].forEach((v, c) => { if (c >= 3 && String(v).trim()) deps.push({ name: String(v).trim(), col: c,
      pick: new Set((DEP_HINTS.find(([re]) => re.test(String(v))) || [null, []])[1]) }); });
    const rows = a.slice(h + 3).filter((r) => String(r[2]).trim() && !/^Группа:/.test(String(r[0])));
    for (const d of deps) d.count = rows.filter((r) => num(r[d.col]) > 0).length;
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Подразделение в прейскуранте"), el("th", { class: "num" }, "Цен"), el("th", {}, "Взять цены для точек")));
    for (const d of deps) t.append(el("tr", {}, el("td", {}, d.name), el("td", { class: "num" }, String(d.count)),
      el("td", {}, ...points.map((pt) => el("label", { class: "chk", style: "display:inline-flex;margin-right:10px;font-weight:400" },
        el("input", { type: "checkbox", checked: d.pick.has(pt.id), onchange: (e) => { e.target.checked ? d.pick.add(pt.id) : d.pick.delete(pt.id); } }), " " + pt.name)))));
    const go = el("button", {}, "Загрузить цены");
    body.append(el("div", { class: "dim", style: "margin:10px 0" }, (date ? "Прейскурант на " + date + ". " : "") + "Позиций в файле: " + rows.length + ". Точка может брать цены только из одного подразделения."),
      el("div", { class: "card", style: "padding:0;overflow:auto" }, t), el("div", { class: "actions" }, go));
    go.onclick = async () => {
      err.textContent = "";
      const owner = new Map();
      for (const d of deps) for (const pt of d.pick) { if (owner.has(pt)) { err.textContent = "Точка «" + (points.find((x) => x.id === pt) || {}).name + "» отмечена у двух подразделений."; return; } owner.set(pt, d); }
      const data = [];
      for (const [pt, d] of owner) for (const r of rows) { const pv = num(r[d.col]); if (pv > 0) data.push({ pt, a: String(r[2]).trim(), p: pv }); }
      if (!data.length) { err.textContent = "Не отмечено ни одной точки."; return; }
      go.disabled = true; go.textContent = "Загружаю…";
      let loaded = 0, unmatched = 0, sample = [];
      for (let i = 0; i < data.length; i += 1000) {
        const r = await api("item_prices_import", { rows: data.slice(i, i + 1000) });
        if (!r.ok) { err.textContent = r.message; go.disabled = false; go.textContent = "Загрузить цены"; return; }
        loaded += r.loaded; unmatched = Math.max(unmatched, r.unmatched); sample = sample.length ? sample : r.unmatched_sample;
      }
      body.innerHTML = "";
      body.append(el("div", { class: "okbox", style: "margin-top:10px" }, "Загружено цен: " + loaded + " для " + owner.size + " точек."),
        unmatched ? el("div", { class: "dim", style: "margin-top:8px" }, "Артикулов без позиции в учёте: " + unmatched + (sample.length ? " (например: " + sample.slice(0, 10).join(", ") + ")" : "") + ". Их цены не загружены — у позиции в номенклатуре нет такого артикула.") : null);
      load();
    };
  };
}
