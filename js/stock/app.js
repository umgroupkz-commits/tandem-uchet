import { api, session, setSession } from "../office/api.js?v=3";
import { el, toast } from "../office/ui.js?v=3";
import { ask, clearDraftsAll } from "./common.js?v=2";

const $ = (id) => document.getElementById(id);
const SCENARIOS = [
  { id: "receive", title: "Приёмка", hint: "приход от поставщика", perm: "doc:invoice_in:edit" },
  { id: "inventory", title: "Инвентаризация", hint: "пересчёт склада", perm: "doc:inventory:edit" },
  { id: "transfer", title: "Перемещение", hint: "на другой склад", perm: "doc:transfer:edit" },
];
const ctx = { store: null, stores: [], home, result };
function show(id) { for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id; }
const perms = () => (session() && session().permissions) || [];

// login/me/logout ходят мимо ask(): у входа своя обработка отказа (текст под полем,
// сессия ещё не заведена), а выход обязан очистить телефон даже при недоступном сервере.
async function doLogin() {
  $("lerr").textContent = "";
  let r;
  try { r = await api("login", { login: $("llogin").value, pin: $("lpin").value }); }
  catch (e) { $("lerr").textContent = "Нет связи с сервером"; return; }
  if (!r.ok) { $("lerr").textContent = r.message || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  try { localStorage.setItem("tandem_stock_login", $("llogin").value.trim()); } catch {}
  start();
}
async function doChangePin() {
  $("nerr").textContent = "";
  if ($("npin").value !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  try {
    await ask("change_pin", { pin: $("npin").value });
    setSession({ ...session(), must_change_pin: false }); start();
  } catch (e) { $("nerr").textContent = e.message; }
}
// Выход всегда доводится до конца: сервер мог не ответить, но телефон обязан забыть
// и сессию, и чужие черновики.
async function doLogout() {
  try { await api("logout", {}); } catch {}
  finally { setSession(null); clearDraftsAll(); location.reload(); }
}

async function start() {
  const s = session();
  if (!s) { show("login"); try { $("llogin").value = localStorage.getItem("tandem_stock_login") || ""; } catch {} return; }
  if (s.must_change_pin) { show("pinchange"); return; }
  show("shell");
  $("uname").textContent = s.user.name;
  if (!ctx.stores.length) {
    try {
      const r = await ask("stores_list", {});
      ctx.stores = (r.stores || []).filter((x) => x.active);
    } catch (e) {
      const main = $("main"); main.innerHTML = "";
      main.append(el("div", { class: "card" }, el("div", { class: "err" }, "Список складов не загрузился: " + e.message),
        el("div", { class: "dim", style: "margin-top:6px" }, "Проверьте связь и попробуйте ещё раз.")),
        el("div", { class: "bar" }, el("button", { class: "ghost", onclick: doLogout }, "Выйти"), el("button", { onclick: start }, "Повторить")));
      return;
    }
  }
  let saved = null; try { saved = localStorage.getItem("tandem_stock_store"); } catch {}
  ctx.store = ctx.stores.find((x) => x.id === saved) || null;
  if (!ctx.store) { chooseStore(); return; }
  home();
}

function chooseStore() {
  $("storename").textContent = "Выберите склад";
  const main = $("main"); main.innerHTML = "";
  const list = el("div", { class: "menu" });
  for (const s of ctx.stores) list.append(el("button", { type: "button", onclick: () => { ctx.store = s; try { localStorage.setItem("tandem_stock_store", s.id); } catch {} home(); } },
    s.name, el("span", {}, s.point_name || "без точки")));
  main.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Склад запомнится на этом телефоне"), list));
}

function home() {
  $("storename").textContent = ctx.store.name;
  const main = $("main"); main.innerHTML = "";
  const menu = el("div", { class: "menu" });
  const allowed = SCENARIOS.filter((x) => perms().includes(x.perm));
  for (const x of allowed) menu.append(el("button", { type: "button", onclick: () => openScenario(x.id) }, x.title, el("span", {}, x.hint)));
  if (!allowed.length) menu.append(el("div", { class: "err" }, "У вашей роли нет складских операций"));
  main.append(menu,
    el("div", {}, el("a", { class: "link", href: "index.html" }, "← отчёт точки")),
    el("div", {}, el("button", { class: "link", onclick: doLogout }, "Выйти")));
}

async function openScenario(id) {
  const main = $("main"); main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=2`);
    main.innerHTML = ""; await mod.mount(main, ctx);
  } catch (e) { main.innerHTML = ""; main.append(el("div", { class: "err" }, "Сценарий не открылся: " + e.message)); }
}

// Экран результата после проведения.
function result({ title, lines = [], again, warnings = [] }) {
  const main = $("main"); main.innerHTML = "";
  main.append(el("div", { class: "okbox" }, title), ...lines.map((t) => el("div", { class: "dim", style: "margin-top:6px" }, t)));
  if (warnings.length) main.append(el("div", { class: "warnbox" }, warnings.join("; ")));
  main.append(el("div", { class: "bar" }, el("button", { onclick: again }, "Ещё"), el("button", { class: "ghost", onclick: home }, "В меню")));
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("changestore").addEventListener("click", chooseStore);
(async () => {
  if (session()) { try { const r = await api("me", {}); if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin }); } catch (e) { toast("Нет связи: " + e.message, "bad"); } }
  start();
})();
