import { api, session, setSession } from "../office/api.js?v=3";
import { el, toast } from "../office/ui.js?v=3";

const $ = (id) => document.getElementById(id);
const SCENARIOS = [
  { id: "receive", title: "Приёмка", hint: "приход от поставщика", perm: "doc:invoice_in:edit" },
  { id: "inventory", title: "Инвентаризация", hint: "пересчёт склада", perm: "doc:inventory:edit" },
  { id: "transfer", title: "Перемещение", hint: "на другой склад", perm: "doc:transfer:edit" },
];
const ctx = { store: null, stores: [], home, result };
function show(id) { for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id; }
const perms = () => (session() && session().permissions) || [];

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = r.message || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  try { localStorage.setItem("tandem_stock_login", $("llogin").value.trim()); } catch {}
  start();
}
async function doChangePin() {
  $("nerr").textContent = "";
  if ($("npin").value !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  const r = await api("change_pin", { pin: $("npin").value });
  if (!r.ok) { $("nerr").textContent = r.message; return; }
  setSession({ ...session(), must_change_pin: false }); start();
}

async function start() {
  const s = session();
  if (!s) { show("login"); try { $("llogin").value = localStorage.getItem("tandem_stock_login") || ""; } catch {} return; }
  if (s.must_change_pin) { show("pinchange"); return; }
  show("shell");
  $("uname").textContent = s.user.name;
  if (!ctx.stores.length) {
    const r = await api("stores_list", {});
    if (!r.ok) { toast(r.message, "bad"); return; }
    ctx.stores = (r.stores || []).filter((x) => x.active);
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
  main.append(menu, el("button", { class: "link", onclick: async () => { await api("logout", {}); setSession(null); location.reload(); } }, "Выйти"));
}

async function openScenario(id) {
  const main = $("main"); main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=1`);
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
