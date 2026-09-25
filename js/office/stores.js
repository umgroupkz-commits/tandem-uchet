import { api, can } from "./api.js?v=16";
import { el, toast, modal } from "./ui.js?v=16";

let root, data, pts;
// Режимы экрана точки: как продавец сдаёт продажи.
const MODES = { checks: "касса — чек на каждую продажу", position: "отчёт с продажами по позициям", takeout: "заборный лист",
  import: "загрузка листа продаж из файла", manual: "только суммы" };
export async function mount(r) { root = r; await load(); }

async function load() {
  [data, pts] = await Promise.all([api("stores_list", {}), api("store_points_list", {})]);
  if (!data.ok) { toast(data.message, "bad"); return; }
  root.innerHTML = "";
  if (pts.ok) {
    const pt = el("table");
    pt.append(el("tr", {}, ...["Точка", "Режим", "Юрлицо", "Склад", "Групп меню", "Статус"].map((h) => el("th", {}, h))));
    for (const x of pts.points) {
      pt.append(el("tr", { class: "row" + (x.active ? "" : " off"), onclick: () => editPoint(x) },
        el("td", {}, x.name), el("td", {}, MODES[x.mode] || x.mode), el("td", {}, x.legal_entity || ""),
        el("td", {}, x.store_name || el("span", { class: "tag bad" }, "нет склада")),
        el("td", {}, x.item_categories.length ? String(x.item_categories.length) : el("span", { class: "dim" }, "все")),
        el("td", {}, x.active ? "" : el("span", { class: "tag bad" }, "выключена"))));
    }
    root.append(el("div", { class: "tools" }, el("h3", { style: "margin:0" }, "Точки продаж"),
        can("stores", "edit") ? el("button", { onclick: () => editPoint(null) }, "+ Точка") : null),
      el("div", { class: "card", style: "padding:0;overflow:auto;margin-bottom:18px" }, pt),
      el("h3", { style: "margin:0 0 8px" }, "Склады"));
  }
  const t = el("table");
  t.append(el("tr", {}, ...["Склад", "Точка", "По умолчанию", "Статус"].map((h) => el("th", {}, h))));
  for (const s of data.stores) {
    t.append(el("tr", { class: "row" + (s.active ? "" : " off"), onclick: () => edit(s) },
      el("td", {}, s.name), el("td", {}, s.point_name || el("span", { class: "dim" }, "без точки")),
      el("td", {}, s.is_default ? el("span", { class: "tag ok" }, "да") : ""),
      el("td", {}, s.active ? "" : el("span", { class: "tag bad" }, "выключен"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, `${data.stores.length} складов`),
      can("stores", "edit") ? el("button", { onclick: () => edit(null) }, "+ Склад") : null),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

function edit(s) {
  const ro = !can("stores", "edit");
  const m = modal(s ? s.name : "Новый склад");
  const name = el("input", { value: s ? s.name : "", readonly: ro });
  const point = el("select", { disabled: ro }, el("option", { value: "" }, "— без точки —"),
    ...data.points.map((p) => el("option", { value: p.id, selected: s && p.id === s.point_id }, p.name)));
  const def = el("input", { type: "checkbox", checked: s ? s.is_default : false, disabled: ro });
  const active = el("input", { type: "checkbox", checked: s ? s.active : true, disabled: ro });
  const err = el("div", { class: "err" });
  if (!ro) setTimeout(() => name.focus(), 0);
  m.root.append(el("label", {}, "Название"), name, el("label", {}, "Точка"), point,
    el("div", { class: "actions" }, el("label", {}, def, " склад точки по умолчанию"), el("label", {}, active, " активен")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async () => {
        const r = await api("store_save", { id: s ? s.id : undefined, name: name.value, point_id: point.value || null, is_default: def.checked, active: active.checked });
        if (!r.ok) { err.textContent = r.message; return; }
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
}

function editPoint(x) {
  const ro = !can("stores", "edit");
  const m = modal(x ? x.name : "Новая точка");
  const id = el("input", { value: x ? x.id : "", readonly: !!x || ro, placeholder: "латиницей, например eneshka2" });
  const name = el("input", { value: x ? x.name : "", readonly: ro });
  const mode = el("select", { disabled: ro }, ...Object.entries(MODES).map(([k, v]) => el("option", { value: k, selected: x ? x.mode === k : k === "position" }, v)));
  const le = el("select", { disabled: ro }, el("option", { value: "" }, "—"),
    ...pts.legal_entities.map((v) => el("option", { value: v, selected: x && x.legal_entity === v }, v)));
  const pin = el("input", { inputmode: "numeric", autocomplete: "off", readonly: ro, placeholder: x && x.has_pin ? "не менять" : "4–8 цифр" });
  const active = el("input", { type: "checkbox", checked: x ? x.active : true, disabled: ro });
  const chosen = new Set(x ? x.item_categories : []);
  const cats = el("div", { class: "cats" }, ...pts.categories.map((c) => el("label", { class: "chk" },
    el("input", { type: "checkbox", checked: chosen.has(c), disabled: ro, onchange: (e) => { e.target.checked ? chosen.add(c) : chosen.delete(c); } }), " " + c)));
  const err = el("div", { class: "err" });
  m.root.append(x ? null : el("label", {}, "Код точки в системе"), x ? null : id,
    el("label", {}, "Название"), name,
    el("label", {}, "Как точка сдаёт продажи"), mode,
    el("div", { class: "dim" }, "Касса — продавец пробивает каждую продажу на планшете, отчёт дня собирается сам. Смена режима действует со следующего входа на экран точки."),
    el("label", {}, "Юрлицо"), le,
    el("label", {}, x ? "Новый код входа" : "Код входа"), pin,
    el("div", { class: "dim" }, "Код, по которому продавцы входят на экран точки и в кассу. Сменили — сообщите его точке."),
    el("label", {}, "Группы меню на экране точки"),
    el("div", { class: "dim" }, "Ничего не отмечено — точка видит всё, что в продаже."), cats,
    el("div", { class: "actions" }, el("label", {}, active, " точка работает")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async (e) => {
        e.target.disabled = true;
        const r = await api("store_point_save", { id: x ? x.id : id.value.trim(), name: name.value, mode: mode.value, legal_entity: le.value,
          pin: pin.value.trim(), active: active.checked, item_categories: [...chosen] });
        e.target.disabled = false;
        if (!r.ok) { err.textContent = r.message; return; }
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.close }, ro ? "Закрыть" : "Отмена")));
}
