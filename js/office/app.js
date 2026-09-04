import { api, session, setSession, can, BUILD } from "./api.js?v=1";
import { toast } from "./ui.js?v=1";

const SECTIONS = [
  { id: "nomenclature", title: "Номенклатура" },
  { id: "stores", title: "Склады" },
  { id: "counteragents", title: "Контрагенты" },
  { id: "users", title: "Пользователи" },
];
const $ = (id) => document.getElementById(id);
let current = null;

function show(id) {
  for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id;
}

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = r.message || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  start();
}

async function doChangePin() {
  $("nerr").textContent = "";
  if ($("npin").value !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  const r = await api("change_pin", { pin: $("npin").value });
  if (!r.ok) { $("nerr").textContent = r.message; return; }
  setSession({ ...session(), must_change_pin: false });
  start();
}

async function open(id) {
  current = id;
  for (const b of $("menu").children) b.classList.toggle("on", b.dataset.id === id);
  const main = $("main");
  main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=${BUILD}`);
    main.innerHTML = "";
    await mod.mount(main);
  } catch (e) {
    main.innerHTML = "";
    main.append(Object.assign(document.createElement("div"), { className: "err", textContent: "Раздел не открылся: " + e.message }));
  }
  try { localStorage.setItem("tandem_office_section", id); } catch {}
}

function start() {
  const s = session();
  if (!s) { show("login"); $("llogin").focus(); return; }
  if (s.must_change_pin) { show("pinchange"); $("npin").focus(); return; }
  show("shell");
  $("uname").textContent = s.user.name;
  $("urole").textContent = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик" }[s.user.role] || s.user.role;
  const menu = $("menu"); menu.innerHTML = "";
  const allowed = SECTIONS.filter((x) => can(x.id, "view"));
  for (const x of allowed) {
    const b = document.createElement("button");
    b.textContent = x.title; b.dataset.id = x.id;
    b.addEventListener("click", () => open(x.id));
    menu.append(b);
  }
  let first = null;
  try { first = localStorage.getItem("tandem_office_section"); } catch {}
  if (!allowed.some((x) => x.id === first)) first = allowed[0] && allowed[0].id;
  if (first) open(first); else $("main").textContent = "У вашей роли нет разделов.";
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("logout").addEventListener("click", async () => { await api("logout", {}); setSession(null); location.reload(); });
// сессия могла протухнуть на сервере — проверяем при старте
(async () => {
  if (session()) {
    try {
      const r = await api("me", {});
      if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
    } catch (e) {
      // сети нет — показываем то, что помним; при первом же действии api() покажет ошибку
      toast("Нет связи с сервером: " + e.message, "bad");
    }
  }
  start();
})();
