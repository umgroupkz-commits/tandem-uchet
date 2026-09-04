import { api, can } from "./api.js?v=1";
import { el, toast, modal } from "./ui.js?v=1";

let root, data;
export async function mount(r) { root = r; await load(); }

async function load() {
  data = await api("stores_list", {});
  if (!data.ok) { toast(data.message, "bad"); return; }
  root.innerHTML = "";
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
