import { api } from "./api.js?v=13";
import { el, toast, modal } from "./ui.js?v=13";

const ROLES = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" };
let root, stores = [];
export async function mount(r) { root = r; await load(); }

async function load() {
  const [d, st] = await Promise.all([api("users_list", {}), api("stores_list", {})]);
  if (!d.ok) { toast(d.message, "bad"); return; }
  stores = (st.stores || []).filter((x) => x.active);
  const storeName = (id) => (stores.find((x) => x.id === id) || {}).name || "склад выключен";
  root.innerHTML = "";
  const t = el("table");
  t.append(el("tr", {}, ...["Логин", "Имя", "Роль", "Склады", "Статус", ""].map((h) => el("th", {}, h))));
  for (const u of d.users) {
    t.append(el("tr", { class: "row" + (u.active ? "" : " off"), onclick: () => edit(u) },
      el("td", {}, u.login), el("td", {}, u.name), el("td", {}, ROLES[u.role] || u.role),
      el("td", { class: "dim" }, (u.store_ids || []).length ? u.store_ids.map(storeName).join(", ") : "все"),
      el("td", {}, u.active ? (u.must_change_pin ? el("span", { class: "tag" }, "временный PIN") : "") : el("span", { class: "tag bad" }, "выключен")),
      el("td", {}, el("button", { class: "link", onclick: (e) => { e.stopPropagation(); resetPin(u); } }, "сбросить PIN"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, "Один пользователь — одна роль. Кому нужно больше — администратор."),
      el("button", { onclick: () => edit(null) }, "+ Пользователь")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

function edit(u) {
  const m = modal(u ? u.name : "Новый пользователь");
  const f = {
    login: el("input", { value: u ? u.login : "", autocapitalize: "off" }),
    name: el("input", { value: u ? u.name : "" }),
    role: el("select", {}, ...Object.entries(ROLES).map(([v, t]) => el("option", { value: v, selected: u ? u.role === v : v === "storekeeper" }, t))),
    pin: el("input", { type: "password", inputmode: "numeric", placeholder: "не меньше 4 цифр" }),
    active: el("input", { type: "checkbox", checked: u ? u.active : true }),
  };
  // Закреплённые склады: кладовщик работает только с ними. Ни одной галочки — все склады.
  const mineIds = new Set(u ? u.store_ids || [] : []);
  const boxes = stores.map((st) => ({ id: st.id, box: el("input", { type: "checkbox", checked: mineIds.has(st.id) }), name: st.name }));
  const storeBox = el("div", { style: "max-height:180px;overflow:auto;border:1px solid var(--line,#ddd);border-radius:8px;padding:6px 10px" },
    ...boxes.map((b) => el("label", { style: "display:block;font-weight:normal;margin:3px 0" }, b.box, " " + b.name)));
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Логин"), f.login), el("div", {}, el("label", {}, "Имя"), f.name),
      el("div", {}, el("label", {}, "Роль"), f.role), u ? null : el("div", {}, el("label", {}, "Временный PIN"), f.pin)),
    el("label", { style: "margin-top:10px" }, "Склады пользователя — ни одной галочки: все склады"), storeBox,
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" }, el("button", { onclick: async () => {
      const r = await api("user_save", { id: u ? u.id : undefined, login: f.login.value, name: f.name.value, role: f.role.value, active: f.active.checked, pin: u ? undefined : f.pin.value,
        store_ids: boxes.filter((b) => b.box.checked).map((b) => b.id) });
      if (!r.ok) { err.textContent = r.message; return; }
      toast("Сохранено"); m.close(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  f.login.focus();
}

// Временный PIN вводится в скрытое поле своего окна: системный prompt показывал его открытым
// текстом каждому, кто стоит рядом (отложенное замечание подпроекта 1).
function resetPin(u) {
  const m = modal("Сбросить PIN — " + u.name);
  const pin = el("input", { type: "password", inputmode: "numeric", autocomplete: "new-password", placeholder: "не меньше 4 цифр" });
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    go.disabled = true;
    const r = await api("user_reset_pin", { id: u.id, pin: pin.value });
    go.disabled = false;
    if (!r.ok) { err.textContent = r.message; return; }
    toast("PIN сброшен, при входе попросит сменить"); m.close(); load();
  } }, "Сбросить PIN");
  pin.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  m.root.append(el("div", { class: "dim" }, "Пользователь войдёт с этим PIN и сразу задаст свой. Все его открытые сессии закроются."),
    el("label", {}, "Временный PIN"), pin, err, el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  setTimeout(() => pin.focus(), 0);
}
