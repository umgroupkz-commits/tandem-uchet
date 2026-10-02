import { api, session } from "./api.js?v=22";
import { el, toast, modal, errText } from "./ui.js?v=22";

const ROLES = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" };
// Склады — полным списком, с выключенными: склад, закреплённый за пользователем и потом
// выключенный, должен оставаться в его карточке. По алфавиту — как ищут глазами.
let root, stores = [];
// Может ли вошедший заводить и менять администраторов. Сервер 0047 отдаёт can_manage_admins в users_list;
// до него раздел видел только администратор, а без поля судим по роли: собственнику — нельзя (U).
let canAdmins = true;
const byName = (a, b) => String(a.name || "").trim().localeCompare(String(b.name || "").trim(), "ru", { sensitivity: "base" });
export async function mount(r) { root = r; await load(); }

async function load() {
  const [d, st] = await Promise.all([api("users_list", {}), api("stores_list", {})]);
  if (!d.ok) { toast(errText(d), "bad"); return; }
  canAdmins = d.can_manage_admins !== undefined ? !!d.can_manage_admins : !(session() && session().user && session().user.role === "owner");
  stores = (st.stores || []).slice().sort(byName);
  const storeName = (id) => { const s = stores.find((x) => x.id === id); return s ? s.name + (s.training ? " (учебный)" : "") + (s.active ? "" : " (выключен)") : "склад не найден"; };
  root.innerHTML = "";
  const t = el("table");
  t.append(el("tr", {}, ...["Логин", "Имя", "Роль", "Склады", "Статус", ""].map((h) => el("th", {}, h))));
  for (const u of d.users) {
    t.append(el("tr", { class: "row" + (u.active ? "" : " off"), onclick: () => edit(u) },
      el("td", {}, u.login, u.training ? [" ", trainingTag()] : null), el("td", {}, u.name), el("td", {}, ROLES[u.role] || u.role),
      el("td", { class: "dim" }, (u.store_ids || []).length ? u.store_ids.map(storeName).sort((a, b) => a.localeCompare(b, "ru")).join(", ") : "все склады"),
      el("td", {}, u.active ? (u.must_change_pin ? el("span", { class: "tag" }, "временный PIN") : "") : el("span", { class: "tag bad" }, "выключен")),
      el("td", {}, u.role === "admin" && !canAdmins ? ""
        : el("button", { class: "link", onclick: (e) => { e.stopPropagation(); resetPin(u); } }, "сбросить PIN"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, "Один пользователь — одна роль. Кому нужно больше — администратор."),
      el("button", { onclick: () => edit(null) }, "+ Пользователь")),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
  // Учебные учётки (0048) настраивает только администратор: сервер отдаёт can_manage_admins по его роли.
  if (canAdmins) {
    const box = el("div", {});
    root.append(box);
    await trainingBlock(box);
  }
}

// ---------- Обучение (0048): учебные учётки и код обучения ----------
// Учебная учётка работает только с учебными складами и учебными позициями — сервер не даст ей испортить
// общие справочники и настоящие склады. Все учебные входы обучалка (test.html) показывает после одного
// кода обучения; сам код хранится на сервере хэшем, поэтому здесь его не видно — только сменить.
const trainingTag = () => el("span", { class: "tag warn", title: "Учебная учётная запись: работает только с учебными складами и учебными позициями, PIN показан в обучалке" }, "учебная");
const TRAIN_ROLES = [["sklad", "Кладовщик"], ["buh", "Бухгалтер"], ["tech", "Технолог"], ["owner", "Собственник (бэк-офис)"]];
const TRAIN_HINT = "Код обучения дайте тем, кто учится: на странице обучения (test.html) он откроет все эти входы";

async function trainingBlock(box) {
  const r = await api("training_get", {});
  box.innerHTML = "";
  // Сервер до 0048 действия не знает — блока нет; отказ (например, временный PIN) — тоже без блока.
  if (!r.ok && (r.error === "unknown_action" || r.error === "forbidden")) return;
  box.append(el("h2", { style: "margin-top:18px" }, "Обучение"));
  const card = el("div", { class: "card" });
  box.append(card);
  if (!r.ok) { card.append(el("div", { class: "err" }, errText(r))); return; }
  if (!r.configured) { trainingSetupForm(card); return; }
  const c = r.creds || {};
  const missing = (text) => el("span", { class: "dim" }, text);
  const t = el("table");
  t.append(el("tr", {}, ...["Роль", "Логин", "PIN"].map((h) => el("th", {}, h))));
  for (const [k, title] of TRAIN_ROLES) {
    const x = c[k];
    t.append(el("tr", {}, el("td", {}, title),
      x ? el("td", {}, x.login) : el("td", {}, missing("учётка выключена или не учебная — нажмите «Сменить код обучения и PIN»")),
      el("td", {}, x ? el("b", {}, x.pin) : "")));
  }
  for (const [k, title, id] of [["kassa", "Касса — код точки", "ucheb_kassa"], ["point", "Экран точки — код точки", "ucheb"]]) {
    const x = c[k];
    t.append(el("tr", {}, el("td", {}, title),
      x ? el("td", {}, x.point, x.point_name ? el("span", { class: "dim" }, " · " + x.point_name) : null)
        : el("td", {}, missing(`точки ${id} нет, она выключена или не учебная`)),
      el("td", {}, x ? el("b", {}, x.pin) : "")));
  }
  t.append(el("tr", {}, el("td", {}, "Код сводки собственника"), el("td", {}, missing("главная страница: «Я собственник или водитель — вход по коду»")),
    el("td", {}, c.owner_code ? el("b", {}, c.owner_code) : "")));
  card.append(el("div", { class: "dim", style: "margin-bottom:8px" },
      "Учебные учётки работают только с учебными складами и учебными позициями: ошибка в обучении ничего не портит."),
    el("div", { class: "card", style: "padding:0;overflow:auto;margin-bottom:8px" }, t),
    el("div", { class: "dim" }, TRAIN_HINT),
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => trainingChange() }, "Сменить код обучения и PIN")));
}

// Первая настройка: код обязателен, сервер заводит uch.sklad, uch.buh, uch.tech, uch.owner.
function trainingSetupForm(card) {
  const code = el("input", { autocomplete: "off", placeholder: "от 6 до 32 символов", maxlength: "32" });
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    err.textContent = "";
    if (code.value.trim().length < 6) { err.textContent = "Код обучения — от 6 до 32 символов"; return; }
    go.disabled = true;
    const r = await api("training_setup", { code: code.value.trim() });
    go.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    toast("Учебные учётки созданы"); load();   // весь раздел: в списке появятся uch.* с меткой «учебная»
  } }, "Создать учебные учётки");
  code.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  card.append(el("div", { class: "dim", style: "margin-bottom:8px" },
      "Учебные учётки (кладовщик, бухгалтер, технолог, собственник) работают только с учебными складами и учебными позициями: "
      + "ошибка в обучении ничего не портит. Нужны склады «Учебный склад кухни», «Учебный склад точки», «Учебный склад кассы» "
      + "с отметкой «Учебный склад» (раздел «Склады»)."),
    el("label", {}, "Код обучения"), code, err,
    el("div", { class: "actions" }, go),
    el("div", { class: "dim" }, TRAIN_HINT));
}

// Смена: новые PIN всем четырём учёткам (их открытые сессии закроются), код — если введён новый.
function trainingChange() {
  const m = modal("Сменить код обучения и PIN", { keep: true });
  const code = el("input", { autocomplete: "off", placeholder: "пусто — оставить прежний код", maxlength: "32" });
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    err.textContent = "";
    const v = code.value.trim();
    if (v && v.length < 6) { err.textContent = "Код обучения — от 6 до 32 символов"; return; }
    go.disabled = true;
    const r = await api("training_setup", v ? { code: v } : {});
    go.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    toast(v ? "Код обучения и PIN сменены" : "Учебные PIN сменены"); m.close(); load();
  } }, "Сменить");
  m.root.append(el("div", { class: "warnbox", style: "margin:0 0 8px" },
      "Старые учебные PIN перестанут работать: все, кто сейчас в учебных учётках, выйдут, а обучалка покажет новые PIN. "
      + "Коды учебных точек и код сводки не меняются."),
    el("label", {}, "Новый код обучения"), code, err,
    el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  setTimeout(() => code.focus(), 0);
}

function edit(u) {
  // Собственник заводит сотрудников, но учётные записи администратора меняет только администратор
  // (сервер откажет и сам): роль «администратор» ему не предлагаем, карточку администратора — только смотреть.
  const ro = !!(u && u.role === "admin" && !canAdmins);
  const m = modal(u ? u.name : "Новый пользователь", { keep: !ro });
  const roleList = Object.entries(ROLES).filter(([v]) => canAdmins || v !== "admin" || (u && u.role === "admin"));
  const f = {
    login: el("input", { value: u ? u.login : "", autocapitalize: "off" }),
    name: el("input", { value: u ? u.name : "" }),
    role: el("select", {}, ...roleList.map(([v, t]) => el("option", { value: v, selected: u ? u.role === v : v === "storekeeper" }, t))),
    pin: el("input", { type: "password", inputmode: "numeric", placeholder: "не меньше 4 цифр" }),
    active: el("input", { type: "checkbox", checked: u ? u.active : true }),
  };
  // Закреплённые склады: кладовщик работает только с ними. Раньше «ни одной галочки» значило
  // «все склады»: забыл отметить — сотрудник получал все 29 складов. Теперь «Все склады» выбирают
  // явно, а у нового пользователя по умолчанию «Выбранные».
  // Выключенный склад показывается, только если он уже закреплён, — отмеченным и с пометкой, и
  // уходит обратно. Раньше его в форме не было, правка имени отправляла пустую привязку, и
  // кладовщик, закреплённый лишь за выключенным складом, молча получал все склады.
  const mineIds = new Set(u ? u.store_ids || [] : []);
  const boxes = stores.filter((st) => st.active || mineIds.has(st.id))
    .map((st) => ({ id: st.id, box: el("input", { type: "checkbox", checked: mineIds.has(st.id) }),
      name: st.name + (st.training ? " (учебный)" : "") + (st.active ? "" : " — выключен"), point: st.point_name || "" }));
  // Закреплённые склады, которых нет в списке (список не загрузился), сохраняются как были.
  const unseen = [...mineIds].filter((id) => !stores.some((st) => st.id === id));
  const scope = u && !mineIds.size ? "all" : "some";
  const rAll = el("input", { type: "radio", name: "ustores", value: "all", checked: scope === "all" });
  const rSome = el("input", { type: "radio", name: "ustores", value: "some", checked: scope === "some" });
  const labels = boxes.map((b) => {
    const lb = el("label", { class: "chk" }, b.box, " " + b.name, b.point ? el("span", { class: "dim" }, " · " + b.point) : null);
    lb.dataset.q = (b.name + " " + b.point).toLowerCase();
    return lb;
  });
  const storeBox = el("div", { class: "ustores" }, ...labels,
    boxes.length ? null : el("div", { class: "dim" }, "Список складов не загрузился — закреплённые склады сохранятся как были."));
  const count = el("span", { class: "dim" });
  const err = el("div", { class: "err" });
  const NONE = "Отметьте склады или выберите «Все склады»";
  // Счётчик — только при «Выбранные»; отметили склад или выбрали «Все склады» — ошибка про склады уходит.
  const recount = () => {
    const n = boxes.filter((b) => b.box.checked).length + unseen.length;
    count.textContent = rAll.checked ? "" : n ? `отмечено: ${n}` : "ничего не отмечено";
    if (err.textContent === NONE && (rAll.checked || n)) err.textContent = "";
  };
  // Поиск только скрывает строки: отмеченные склады остаются отмеченными и уходят на сервер.
  const search = el("input", { placeholder: "Найти склад", "data-nodirty": true, autocomplete: "off", oninput: () => {
    const q = search.value.trim().toLowerCase();
    for (const lb of labels) lb.hidden = !!q && !lb.dataset.q.includes(q);
  } });
  const syncScope = () => {
    const some = rSome.checked;
    search.disabled = !some; storeBox.classList.toggle("off", !some);
    for (const b of boxes) b.box.disabled = !some;
    recount();
  };
  rAll.addEventListener("change", syncScope); rSome.addEventListener("change", syncScope);
  storeBox.addEventListener("change", recount);
  syncScope();
  m.root.append(ro ? el("div", { class: "warnbox", style: "margin:0 0 6px" }, "Учётные записи администратора меняет только администратор.") : "",
    el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Логин"), f.login), el("div", {}, el("label", {}, "Имя"), f.name),
      el("div", {}, el("label", {}, "Роль"), f.role), u ? null : el("div", {}, el("label", {}, "Временный PIN"), f.pin)),
    el("label", { style: "margin-top:10px" }, "Склады пользователя"),
    el("div", { class: "actions uscope", style: "margin-top:4px;align-items:center" },
      el("label", { class: "chk" }, rAll, " Все склады"), el("label", { class: "chk" }, rSome, " Выбранные"), count),
    el("div", { class: "tools", style: "margin:6px 0" }, search), storeBox,
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" }, ro ? null : el("button", { onclick: async (e) => {
      err.textContent = "";
      const picked = [...boxes.filter((b) => b.box.checked).map((b) => b.id), ...unseen];
      if (rSome.checked && !picked.length) { err.textContent = NONE; return; }
      e.target.disabled = true;
      const r = await api("user_save", { id: u ? u.id : undefined, login: f.login.value, name: f.name.value, role: f.role.value, active: f.active.checked, pin: u ? undefined : f.pin.value,
        store_ids: rAll.checked ? [] : picked });
      e.target.disabled = false;
      // Отказ сервера показываем его словами — например, собственнику про учётную запись администратора.
      if (!r.ok) { err.textContent = errText(r); return; }
      toast("Сохранено"); m.close(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена")));
  if (ro) for (const n of m.root.querySelectorAll("input, select")) n.disabled = true;
  else f.login.focus();
}

// Временный PIN вводится в скрытое поле своего окна: системный prompt показывал его открытым
// текстом каждому, кто стоит рядом (отложенное замечание подпроекта 1).
function resetPin(u) {
  const m = modal("Сбросить PIN — " + u.name, { keep: true });
  const pin = el("input", { type: "password", inputmode: "numeric", autocomplete: "new-password", placeholder: "не меньше 4 цифр" });
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    go.disabled = true;
    const r = await api("user_reset_pin", { id: u.id, pin: pin.value });
    go.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    toast(u.training ? "PIN сброшен — обучалка покажет новый" : "PIN сброшен, при входе попросит сменить"); m.close(); load();
  } }, "Сбросить PIN");
  pin.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  // Учебная учётка (0048) PIN не меняет: он показан в обучалке, туда сразу уходит и новый.
  m.root.append(el("div", { class: "dim" }, u.training
      ? "Учебная учётка свой PIN не меняет: новый сразу появится в обучалке. Все её открытые сессии закроются."
      : "Пользователь войдёт с этим PIN и сразу задаст свой. Все его открытые сессии закроются."),
    el("label", {}, "Временный PIN"), pin, err, el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  setTimeout(() => pin.focus(), 0);
}
