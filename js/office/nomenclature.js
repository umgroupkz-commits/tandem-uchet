import { api, can } from "./api.js?v=1";
import { el, fmt, toast, debounce, modal } from "./ui.js?v=1";

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
  );
  table = el("table");
  pager = el("div", { class: "pager" });
  root.append(el("div", { class: "split" }, tree, el("div", {}, tools, el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager)));
  drawTree();
  await load();
}

function select(opts, value, onchange) {
  const s = el("select", { onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

function drawTree() {
  tree.innerHTML = "";
  tree.append(el("h2", {}, "Группы"),
    el("button", { class: state.group_id === "" ? "on" : "", onclick: () => pick("") }, "Все позиции"));
  const kids = (pid) => groups.filter((g) => (g.parent_id || null) === pid && g.active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
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

async function editItem(code) {
  let item = { item_type: "dish", unit_id: "шт", group_id: state.group_id || "", active: true, for_sale: false }, points = [];
  if (code) {
    const r = await api("item_get", { code });
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
    field("item_type", "Тип", select(TYPES, item.item_type, () => {})),
    field("unit_id", "Единица", select({ "шт": "шт", "кг": "кг", "л": "л", "порц": "порц" }, item.unit_id, () => {})),
    field("group_id", "Группа", groupSel),
    field("price", "Цена по умолчанию", el("input", { type: "number", step: "0.01", value: item.price ?? "", readonly: ro })),
    field("pack_factor", "Фасовка: множитель", el("input", { type: "number", step: "0.001", value: item.pack_factor ?? "", readonly: ro })),
    field("pack_unit", "Фасовка: единица", el("input", { value: item.pack_unit || "", readonly: ro })),
    field("pack_price", "Фасовка: цена", el("input", { type: "number", step: "0.01", value: item.pack_price ?? "", readonly: ro })),
    field("note", "Заметка", el("input", { value: item.note || "", readonly: ro })),
  ));
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
  const err = el("div", { class: "err" });
  m.root.append(err, el("div", { class: "actions" },
    ro ? null : el("button", { onclick: save }, "Сохранить"),
    el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
  async function save() {
    const p = { code: code || undefined, name: f.name.value, artikul: f.artikul.value, item_type: f.item_type.value, unit_id: f.unit_id.value,
      group_id: f.group_id.value || null, price: f.price.value, pack_factor: f.pack_factor.value, pack_unit: f.pack_unit.value,
      pack_price: f.pack_price.value, note: f.note.value, active: f.active.checked, for_sale: f.for_sale.checked };
    const r = await api("item_save", p);
    if (!r.ok) { err.textContent = r.message; return; }
    if (f._prices) {
      const prices = Object.entries(f._prices).map(([point_id, inp]) => ({ point_id, price: inp.value === "" ? null : Number(inp.value) }));
      const r2 = await api("item_prices_save", { code: r.code, prices });
      if (!r2.ok) { err.textContent = r2.message; return; }
    }
    toast("Сохранено"); m.close();
    const g = await api("groups_list", {}); groups = g.groups || []; drawTree(); load();
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
