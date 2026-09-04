import { api } from "./api.js?v=1";
import { el, toast, modal } from "./ui.js?v=1";

const ROLES = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" };
let root;
export async function mount(r) { root = r; await load(); }

async function load() {
  const d = await api("users_list", {});
  if (!d.ok) { toast(d.message, "bad"); return; }
  root.innerHTML = "";
  const t = el("table");
  t.append(el("tr", {}, ...["Логин", "Имя", "Роль", "Статус", ""].map((h) => el("th", {}, h))));
  for (const u of d.users) {
    t.append(el("tr", { class: "row" + (u.active ? "" : " off"), onclick: () => edit(u) },
      el("td", {}, u.login), el("td", {}, u.name), el("td", {}, ROLES[u.role] || u.role),
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
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Логин"), f.login), el("div", {}, el("label", {}, "Имя"), f.name),
      el("div", {}, el("label", {}, "Роль"), f.role), u ? null : el("div", {}, el("label", {}, "Временный PIN"), f.pin)),
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" }, el("button", { onclick: async () => {
      const r = await api("user_save", { id: u ? u.id : undefined, login: f.login.value, name: f.name.value, role: f.role.value, active: f.active.checked, pin: u ? undefined : f.pin.value });
      if (!r.ok) { err.textContent = r.message; return; }
      toast("Сохранено"); m.close(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.close }, "Отмена")));
  f.login.focus();
}

async function resetPin(u) {
  const pin = window.prompt(`Новый временный PIN для ${u.name} (не меньше 4 цифр):`);
  if (!pin) return;
  const r = await api("user_reset_pin", { id: u.id, pin });
  if (!r.ok) { toast(r.message, "bad"); return; }
  toast("PIN сброшен, при входе попросит сменить"); load();
}
