import { api, session, setSession, can, BUILD } from "./api.js?v=21";
import { el, toast, errText, modal } from "./ui.js?v=21";
import { fmtDateTime } from "./inputs.js?v=21";

// Замечания разбирают администратор и собственник (сервер 0044 проверяет роль, а не права раздела:
// в role_permissions такого раздела нет).
const role = () => { const s = session(); return (s && s.user && s.user.role) || ""; };
const fbReader = () => ["admin", "owner"].includes(role());
const SECTIONS = [
  { id: "nomenclature", title: "Номенклатура" },
  { id: "charts", title: "Техкарты" },
  { id: "stock", title: "Склад" },
  { id: "stores", title: "Склады" },
  { id: "counteragents", title: "Контрагенты" },
  { id: "users", title: "Пользователи" },
  { id: "feedback", title: "Замечания", allow: fbReader },
];
const allowedSections = () => SECTIONS.filter((x) => (x.allow ? x.allow() : can(x.id, "view")));
// С чего начинается работа роли сразу после входа: кладовщик и бухгалтер — журнал документов,
// собственник — отчёты склада, технолог — техкарты. Раньше все попадали в «Номенклатуру»
// (1 644 позиции), и первым делом приходилось искать нужный раздел. Администратор — как раньше.
const ROLE_START = { storekeeper: { id: "stock", tab: "docs" }, accountant: { id: "stock", tab: "docs" },
  owner: { id: "stock", tab: "rep" }, technologist: { id: "charts" } };
const $ = (id) => document.getElementById(id);
let current = null;
// Вход только что выполнен (а не страница перезагружена с живой сессией): стартовый экран роли.
let freshLogin = false;
// Новый PIN: только цифры, не меньше 4; у администратора и собственника — не меньше 6 (сервер проверяет так же).
const pinMin = () => { const s = session(); return s && s.user && ["admin", "owner"].includes(s.user.role) ? 6 : 4; };
const pinBad = (pin) => !/^[0-9]+$/.test(pin) || pin.length < pinMin() ? `PIN — только цифры, не меньше ${pinMin()}` : "";

// Кнопка «Замечание» живёт в шапке (#fbbtn) и прячется вместе с ней на экранах входа и смены PIN.
function show(id) {
  for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id;
}

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = errText(r); return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  freshLogin = true;
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

// o.tab — вкладка, на которой открыть раздел (сейчас — «Склад»: setTab из stock.js).
async function open(id, o = {}) {
  current = id;
  for (const b of $("menu").children) b.classList.toggle("on", b.dataset.id === id);
  const main = $("main");
  main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    // «Замечания» живут здесь же, в оболочке: отдельного модуля раздела у них нет.
    if (id === "feedback") { main.innerHTML = ""; await mountFeedback(main); try { localStorage.setItem("tandem_office_section", id); } catch {} return; }
    const mod = await import(`./${id}.js?v=${BUILD}`);
    main.innerHTML = "";
    // Вкладку ставим до mount, чтобы раздел сразу грузил её, а не журнал. Если setTab сам рисует
    // и без смонтированного раздела упал — повторяем после mount.
    let tabSet = false;
    if (o.tab && typeof mod.setTab === "function") { try { mod.setTab(o.tab); tabSet = true; } catch {} }
    await mod.mount(main);
    if (o.tab && typeof mod.setTab === "function" && !tabSet) { try { mod.setTab(o.tab); } catch {} }
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
  const allowed = allowedSections();
  for (const x of allowed) {
    const b = el("button", { onclick: () => open(x.id) }, x.title, x.id === "feedback" ? el("span", { class: "mcount", hidden: true }) : null);
    b.dataset.id = x.id;
    menu.append(b);
  }
  const has = (id) => allowed.some((x) => x.id === id);
  let first = null, tab = null;
  // Сразу после входа — стартовый экран роли; после перезагрузки страницы — раздел, где человек был.
  const rs = freshLogin ? ROLE_START[role()] : null;
  freshLogin = false;
  if (rs && has(rs.id)) { first = rs.id; tab = rs.tab || null; }
  else { try { first = localStorage.getItem("tandem_office_section"); } catch {} }
  if (!has(first)) first = allowed[0] && allowed[0].id;
  if (location.hash.startsWith("#charts/") && has("charts")) { first = "charts"; tab = null; }
  if (location.hash.startsWith("#item/") && has("nomenclature")) { first = "nomenclature"; tab = null; }
  mountFeedbackButton();
  if (fbReader()) refreshFbCount();
  if (first) open(first, { tab }); else $("main").textContent = "У вашей роли нет разделов.";
}

// ---------- замечания ----------
// Где человек сейчас: раздел, вкладка, вид отчёта и заголовок открытого окна — кнопка «Замечание»
// прикладывает это сама, чтобы по тексту «не сходится сумма» было понятно, о каком экране речь.
function screenText() {
  const parts = [];
  const sec = SECTIONS.find((x) => x.id === current);
  if (sec) parts.push(sec.title);
  const tab = document.querySelector("#main .tabs button:not(.ghost)");
  if (tab) parts.push(tab.textContent.trim());
  const rk = document.querySelector("#rep-root .tools select");
  if (rk && rk.selectedIndex >= 0) parts.push(rk.options[rk.selectedIndex].text);
  const titles = [...document.querySelectorAll(".overlay:not(#relogin) .card > h1")];
  if (titles.length) parts.push("окно «" + titles[titles.length - 1].textContent.trim() + "»");
  return parts.join(" → ");
}
// Кнопка — в шапке рядом с «Сменить PIN» и «Выйти» (attachTo), а не плавающая в углу: плавающая
// закрывала первую колонку таблиц внизу слева. Скрипт замечаний не загрузился — кнопки нет.
let fbMounted = false;
function mountFeedbackButton() {
  if (fbMounted || !window.TandemFeedback) return;
  fbMounted = true;
  window.TandemFeedback.mount({
    source: "office", build: BUILD, attachTo: $("fbbtn"), screen: screenText,
    send: async (message, context) => {
      const r = await api("feedback_save", { message, page: screenText(), source: "office", context });
      if (r.ok && fbReader()) refreshFbCount();
      return r;
    },
  });
  $("fbbtn").hidden = false;
}
// Число новых замечаний — в пункте меню. Отдельного счётчика на сервере нет: берём поле new из списка.
function setFbCount(n) {
  const sp = document.querySelector('#menu button[data-id="feedback"] .mcount');
  if (!sp) return;
  sp.textContent = n > 0 ? String(n) : "";
  sp.hidden = !(n > 0);
}
async function refreshFbCount(quiet) {
  const r = await api("feedback_list", { status: "new" }, quiet ? { quiet: true } : undefined);
  if (r.ok) setFbCount(Number(r.new) || 0);
}
// Новые замечания приходят и с точек, и с кассы — раз в 10 минут счётчик обновляется сам.
setInterval(() => { if (session() && fbReader() && !$("shell").hidden && !document.hidden) refreshFbCount(true); }, 600000);

const FB_SRC = { office: "бэк-офис", stock: "склад с телефона", kassa: "касса", point: "точка", order: "заявка", owner: "собственник", driver: "водитель" };
const FB_ROLE = { admin: "администратор", owner: "собственник", accountant: "бухгалтер", technologist: "технолог", storekeeper: "кладовщик", driver: "водитель" };
// Сведения, которые приложила кнопка: подписи по-русски, неизвестные поля — как пришли.
const FB_CTX = { screen: "Экран", url: "Страница", build: "Сборка", w: "Ширина окна", h: "Высота окна", online: "Связь", last_error: "Последняя ошибка",
  on_screen: "На экране", at: "Время на устройстве", ua: "Браузер" };
const fbState = { status: "new" };
let fbSeq = 0;
async function mountFeedback(main) {
  const n = ++fbSeq;
  main.innerHTML = '<div class="dim">Загрузка…</div>';
  const r = await api("feedback_list", fbState.status ? { status: fbState.status } : {});
  if (n !== fbSeq || current !== "feedback") return;
  main.innerHTML = "";
  const tabBtn = (st, text) => el("button", { class: fbState.status === st ? "" : "ghost", onclick: () => { fbState.status = st; mountFeedback(main); } }, text);
  main.append(el("div", { class: "tabs" }, tabBtn("new", "Новые" + (r.ok && r.new ? ` (${r.new})` : "")), tabBtn("", "Все"),
    el("button", { class: "ghost", style: "margin-left:auto", onclick: () => mountFeedback(main) }, "Обновить")));
  if (!r.ok) { main.append(el("div", { class: "err" }, errText(r))); return; }
  setFbCount(Number(r.new) || 0);
  const rows = r.rows || [];
  main.append(el("div", { class: "dim", style: "margin-bottom:8px" },
    "Замечания тестировщиков со всех экранов: бэк-офис, склад с телефона, касса, точка, заявка, сводка собственника, водитель. " +
    "Разобрали — нажмите «Разобрано» и, если нужно, напишите ответ." + (rows.length >= 300 ? " Показаны последние 300." : "")));
  if (!rows.length) { main.append(el("div", { class: "card dim" }, fbState.status === "new" ? "Новых замечаний нет." : "Замечаний пока нет.")); return; }
  const t = el("table", { class: "fb" });
  t.append(el("tr", {}, ...["Когда", "Откуда", "Кто", "Где", "Замечание", ""].map((h) => el("th", {}, h))));
  for (const f of rows) {
    const ctx = f.context && typeof f.context === "object" ? f.context : null;
    const where = f.page || (ctx && (ctx.screen || ctx.url)) || "";
    const who = f.author || "";
    const roleName = f.role ? (FB_ROLE[f.role] || (String(f.role).startsWith("point:") ? "" : f.role)) : "";
    const det = el("tr", { class: "fbdet", hidden: true }, el("td", { colspan: 6 }, fbDetails(f, ctx)));
    const done = f.status === "done";
    t.append(el("tr", { class: done ? "off" : "" },
      el("td", { class: "nowrap" }, fmtDateTime(f.created_at), el("div", { class: "dim" }, "№" + f.id)),
      el("td", { class: "nowrap" }, FB_SRC[f.source] || f.source || ""),
      el("td", {}, who, roleName && roleName !== who ? el("div", { class: "dim" }, roleName) : null),
      el("td", { class: "dim" }, where),
      el("td", { class: "fbmsg" }, f.message || "",
        done ? el("div", { class: "fbdone" }, el("span", { class: "tag ok" }, "разобрано"),
          " " + [fmtDateTime(f.done_at), f.done_by].filter(Boolean).join(" · ")) : null,
        f.answer ? el("div", { class: "fbans" }, "Ответ: " + f.answer) : null),
      el("td", { class: "nowrap" },
        el("button", { class: "link", onclick: () => { det.hidden = !det.hidden; } }, "подробности"),
        done ? el("button", { class: "link", onclick: (e) => fbDone(f, false, e.target, main) }, "вернуть в новые")
             : el("button", { class: "small", onclick: () => fbDoneDlg(f, main) }, "Разобрано"))), det);
  }
  main.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}
function fbDetails(f, ctx) {
  const box = el("div", { class: "fbctx" });
  if (!ctx) { box.append(el("div", { class: "dim" }, "Сведений не приложено.")); return box; }
  for (const [k, v] of Object.entries(ctx)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    let text = Array.isArray(v) ? v.join(" | ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (k === "online") text = v ? "есть" : "нет";
    box.append(el("div", {}, el("b", {}, (FB_CTX[k] || k) + ": "), text));
  }
  if (!box.childNodes.length) box.append(el("div", { class: "dim" }, "Сведений не приложено."));
  return box;
}
// «Разобрано» — с необязательным ответом: его увидит тот, кто будет читать список после вас.
function fbDoneDlg(f, main) {
  const m = modal("Замечание №" + f.id + " — разобрано", { keep: true });
  const ans = el("textarea", { maxlength: 2000, placeholder: "Что сделано или почему не нужно (необязательно)" });
  if (f.answer) ans.value = f.answer;
  const err = el("div", { class: "err" });
  const go = el("button", { onclick: async () => {
    go.disabled = true;
    const r = await api("feedback_done", { id: f.id, done: true, answer: ans.value.trim() });
    go.disabled = false;
    if (!r.ok) { err.textContent = errText(r); return; }
    m.close(); toast("Отмечено: разобрано"); mountFeedback(main);
  } }, "Разобрано");
  m.root.append(el("div", { class: "fbquote" }, f.message || ""), el("label", {}, "Ответ"), ans, err,
    el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  setTimeout(() => ans.focus(), 0);
}
async function fbDone(f, done, btn, main) {
  btn.disabled = true;
  const r = await api("feedback_done", { id: f.id, done });
  btn.disabled = false;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  toast(done ? "Отмечено: разобрано" : "Замечание снова в новых"); mountFeedback(main);
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
