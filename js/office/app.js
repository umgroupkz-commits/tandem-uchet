import { api, session, setSession, can, BUILD } from "./api.js?v=20";
import { toast, errText } from "./ui.js?v=20";

const SECTIONS = [
  { id: "nomenclature", title: "Номенклатура" },
  { id: "charts", title: "Техкарты" },
  { id: "stock", title: "Склад" },
  { id: "stores", title: "Склады" },
  { id: "counteragents", title: "Контрагенты" },
  { id: "users", title: "Пользователи" },
];
const $ = (id) => document.getElementById(id);
let current = null;
// Новый PIN: только цифры, не меньше 4; у администратора и собственника — не меньше 6 (сервер проверяет так же).
const pinMin = () => { const s = session(); return s && s.user && ["admin", "owner"].includes(s.user.role) ? 6 : 4; };
const pinBad = (pin) => !/^[0-9]+$/.test(pin) || pin.length < pinMin() ? `PIN — только цифры, не меньше ${pinMin()}` : "";

function show(id) {
  for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id;
}

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = errText(r); return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  start();
}

// Смена PIN: после входа с временным PIN (must_change_pin) — без текущего, иначе по кнопке
// «Сменить PIN» в шапке и с текущим PIN: открытая сессия на общем компьютере не должна давать
// постороннему сменить PIN и забрать учётную запись.
function showPinChange(voluntary) {
  $("ptitle").textContent = voluntary ? "Смена PIN" : "Смените PIN";
  $("pfirst").hidden = voluntary;
  $("opinbox").hidden = !voluntary;
  $("ncancel").hidden = !voluntary;
  for (const id of ["opin", "npin", "npin2"]) $(id).value = "";
  $("nerr").textContent = "";
  show("pinchange");
  (voluntary ? $("opin") : $("npin")).focus();
}
async function doChangePin() {
  $("nerr").textContent = "";
  const first = !!(session() && session().must_change_pin);
  const pin = $("npin").value;
  if (!first && !$("opin").value) { $("nerr").textContent = "Введите текущий PIN"; return; }
  const bad = pinBad(pin); if (bad) { $("nerr").textContent = bad; return; }
  if (pin !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  $("nbtn").disabled = true;
  const r = await api("change_pin", first ? { pin } : { pin, old_pin: $("opin").value });
  $("nbtn").disabled = false;
  if (!r.ok) { $("nerr").textContent = errText(r); return; }
  setSession({ ...session(), must_change_pin: false });
  // Добровольная смена возвращает к открытому разделу как был, без перерисовки.
  if (first) start(); else { show("shell"); toast("PIN изменён"); }
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
    if (id === "charts" && location.hash.startsWith("#charts/") && mod.openChart) {
      let hashCode = null;
      try { hashCode = decodeURIComponent(location.hash.slice(8)); } catch { hashCode = null; }
      if (hashCode) mod.openChart(hashCode);
      history.replaceState(null, "", location.pathname);
    }
    if (id === "nomenclature" && location.hash.startsWith("#item/") && mod.openItem) {
      let itemCode = null;
      try { itemCode = decodeURIComponent(location.hash.slice(6)); } catch { itemCode = null; }
      if (itemCode) mod.openItem(itemCode);
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {
    main.innerHTML = "";
    main.append(Object.assign(document.createElement("div"), { className: "err", textContent: "Раздел не открылся: " + e.message }));
  }
  try { localStorage.setItem("tandem_office_section", id); } catch {}
}

// Вход заново на обычном экране входа — когда продолжать без новой сессии нечего.
function toLogin(message) {
  const login = (session() && session().user && session().user.login) || "";
  setSession(null);
  show("login");
  $("llogin").value = login; $("lpin").value = ""; $("lerr").textContent = message || "";
  (login ? $("lpin") : $("llogin")).focus();
}
// Сообщение, которое надо показать уже после перезагрузки страницы.
const NOTICE = "tandem_office_notice";
function noticeAfterReload(text) { try { sessionStorage.setItem(NOTICE, text); } catch {} }

function start() {
  const s = session();
  if (!s) { show("login"); $("llogin").focus(); return; }
  let notice = null;
  try { notice = sessionStorage.getItem(NOTICE); sessionStorage.removeItem(NOTICE); } catch {}
  if (notice) toast(notice);
  if (s.must_change_pin) { showPinChange(false); return; }
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
  if (location.hash.startsWith("#charts/") && allowed.some((x) => x.id === "charts")) first = "charts";
  if (location.hash.startsWith("#item/") && allowed.some((x) => x.id === "nomenclature")) first = "nomenclature";
  if (first) open(first); else $("main").textContent = "У вашей роли нет разделов.";
}

// ---------- повторный вход поверх страницы ----------
// Сессия кончилась посреди работы (12 часов, сброс PIN или смена роли администратором):
// api() сообщает событием, а не перезагружает страницу. Окно входа встаёт поверх всего,
// открытые формы под ним не трогаются; после входа человек повторяет последнее действие.
let relogin = false;
window.addEventListener("tandem:unauthorized", () => {
  // До входа (проверка сессии при старте) и после «Выйти» окно не нужно; второе событие — то же окно.
  if (relogin || !session()) return;
  // Экран обязательной смены временного PIN: сессию закрыли (PIN сменили на телефоне, администратор
  // сбросил его ещё раз). Ни «Отмены», ни «Выйти» там нет, и без сессии сделать на нём ничего
  // нельзя — возвращаем на вход, иначе человек застревал до F5.
  if (!$("pinchange").hidden && session().must_change_pin) { toLogin("Сессия закрыта — войдите снова"); return; }
  // Добровольная смена PIN (экран поверх разделов) — то же окно входа, что и над разделами.
  if ($("shell").hidden && $("pinchange").hidden) return;
  relogin = true;
  $("rlogin").value = (session().user && session().user.login) || "";
  $("rpin").value = ""; $("rerr").textContent = "";
  $("rstep1").hidden = false; $("rstep2").hidden = true;
  $("relogin").hidden = false;
  ($("rlogin").value ? $("rpin") : $("rlogin")).focus();
});
function closeRelogin() { relogin = false; $("relogin").hidden = true; toast("Вы снова вошли — повторите последнее действие"); }
async function doRelogin() {
  $("rerr").textContent = "";
  const was = session();
  $("rbtn").disabled = true;
  const r = await api("login", { login: $("rlogin").value, pin: $("rpin").value });
  $("rbtn").disabled = false;
  if (!r.ok) { $("rerr").textContent = errText(r); return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  // Вошёл другой человек — открытые формы и меню прежнего ему не принадлежат.
  if (!was || !was.user || was.user.id !== r.user.id) { location.reload(); return; }
  // Тот же человек, но администратор сменил ему роль, права или закреплённые склады (это и закрыло
  // сессию): меню, подпись роли и кнопки на открытых экранах нарисованы по старым правам —
  // открываем бэк-офис заново, по новым.
  const key = (x) => JSON.stringify([x.user && x.user.role, [...(x.permissions || [])].sort(), [...((x.user && x.user.store_ids) || [])].sort()]);
  if (key(was) !== key(r)) { noticeAfterReload("Права изменились — бэк-офис открыт заново"); location.reload(); return; }
  if (r.must_change_pin) {
    $("rstep1").hidden = true; $("rstep2").hidden = false;
    $("rnpin").value = ""; $("rnpin2").value = ""; $("rnpin").focus();
    return;
  }
  closeRelogin();
}
async function doReloginPin() {
  $("rerr").textContent = "";
  const pin = $("rnpin").value;
  const bad = pinBad(pin); if (bad) { $("rerr").textContent = bad; return; }
  if (pin !== $("rnpin2").value) { $("rerr").textContent = "PIN не совпадают"; return; }
  $("rnbtn").disabled = true;
  const r = await api("change_pin", { pin });
  $("rnbtn").disabled = false;
  // Сессию закрыли, пока задавали PIN, — войти заново (шаг 1 того же окна).
  if (!r.ok && r.error === "unauthorized") { $("rstep2").hidden = true; $("rstep1").hidden = false; $("rpin").value = ""; $("rerr").textContent = "Сессия закрыта — войдите снова"; $("rpin").focus(); return; }
  if (!r.ok) { $("rerr").textContent = errText(r); return; }
  setSession({ ...session(), must_change_pin: false });
  closeRelogin();
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("npin2").addEventListener("keydown", (e) => { if (e.key === "Enter") doChangePin(); });
$("ncancel").addEventListener("click", () => show("shell"));
$("chpin").addEventListener("click", () => showPinChange(true));
$("rbtn").addEventListener("click", doRelogin);
$("rpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doRelogin(); });
$("rnbtn").addEventListener("click", doReloginPin);
$("rnpin2").addEventListener("keydown", (e) => { if (e.key === "Enter") doReloginPin(); });
// «Выйти» сначала забывает сессию на этом компьютере и только потом сообщает серверу:
// без связи запрос не дойдёт, но на общем компьютере сессия всё равно не останется.
// Сервер ждём не дольше 3 секунд, чтобы кнопка не висела весь таймаут api().
$("logout").addEventListener("click", async () => {
  const s = session();
  setSession(null);
  if (s && s.token) await Promise.race([api("logout", { token: s.token }), new Promise((r) => setTimeout(r, 3000))]);
  location.reload();
});
// сессия могла протухнуть на сервере — проверяем при старте
(async () => {
  if (session()) {
    const r = await api("me", {});
    if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
    else if (r.error === "unauthorized") setSession(null);
    // сети нет — показываем то, что помним; первое же действие покажет ошибку связи
    else if (r.error === "network") toast(errText(r), "bad");
  }
  start();
})();
