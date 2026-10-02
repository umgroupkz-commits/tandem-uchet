import { api, session, setSession, BUILD } from "../office/api.js?v=21";
import { el, toast } from "../office/ui.js?v=21";
import { ask, clearDraftsAll } from "./common.js?v=21";

const $ = (id) => document.getElementById(id);
const SCENARIOS = [
  { id: "receive", title: "Приёмка", hint: "приход от поставщика", perm: "doc:invoice_in:edit" },
  { id: "inventory", title: "Инвентаризация", hint: "пересчёт склада", perm: "doc:inventory:edit" },
  { id: "transfer", title: "Перемещение", hint: "на другой склад", perm: "doc:transfer:edit" },
  { id: "writeoff", title: "Списание", hint: "порча, проработка, питание персонала", perm: "doc:writeoff:edit" },
];
// stores — все действующие склады (куда перемещать), mine — те, от имени которых работает
// пользователь: закреплённые за ним в бэк-офисе, а без закрепления — все.
// resume — чей экран остался под входом после истёкшей сессии (см. tandem:unauthorized).
// where — где человек сейчас (для кнопки «Замечание»): сценарий или экран.
const ctx = { store: null, stores: [], mine: [], home, result, resume: null, where: "" };
function show(id) { for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id; }
const perms = () => (session() && session().permissions) || [];

// login/me/logout ходят мимо ask(): у входа своя обработка отказа (текст под полем,
// сессия ещё не заведена), а выход обязан очистить телефон даже при недоступном сервере.
async function doLogin() {
  $("lerr").textContent = "";
  let r;
  try { r = await api("login", { login: $("llogin").value, pin: $("lpin").value }); }
  catch (e) { $("lerr").textContent = "Нет связи с сервером"; return; }
  if (r.error === "network") { $("lerr").textContent = "Нет связи с сервером"; return; }
  if (!r.ok) { $("lerr").textContent = r.message || r.error || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  try { localStorage.setItem("tandem_stock_login", $("llogin").value.trim()); } catch {}
  // Вошёл тот же человек, у которого истекла сессия, — возвращаем его экран как был:
  // введённое не пропадает. Другой человек начинает заново, со своими складами.
  const same = ctx.resume && r.user && ctx.resume === r.user.id && !r.must_change_pin;
  ctx.resume = null;
  if (same) { show("shell"); return; }
  ctx.stores = []; ctx.mine = []; ctx.store = null;
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

// Кнопка «Замечание» — в шапке, а не плавающая: внизу экрана сценария стоит панель «В меню / Провести»,
// плавающая кнопка закрыла бы её. Замечание уходит той же сессией бэк-офиса (feedback_save) с пометкой
// source 'stock': разбирающий видит, что писали со склада с телефона, с какого склада и экрана.
let fbMounted = false;
function mountFeedback() {
  // feedback.js не загрузился (старый кэш, обрыв) — кнопку, которая ничего не делает, не показываем.
  $("fbbtn").hidden = !window.TandemFeedback;
  if (fbMounted || !window.TandemFeedback) return;
  fbMounted = true;
  const where = () => ["Склад с телефона", ctx.store && ctx.store.name, ctx.where].filter(Boolean).join(" · ");
  window.TandemFeedback.mount({ source: "stock", build: BUILD, attachTo: $("fbbtn"), screen: where,
    send: (message, context) => api("feedback_save", { message, page: where(), source: "stock", context }) });
}

async function start() {
  const s = session();
  if (!s) { show("login"); try { $("llogin").value = localStorage.getItem("tandem_stock_login") || ""; } catch {} return; }
  if (s.must_change_pin) { show("pinchange"); return; }
  show("shell");
  mountFeedback();
  $("uname").textContent = s.user.name;
  if (!ctx.stores.length) {
    try {
      const r = await ask("stores_list", {});
      // По алфавиту, как в бэк-офисе: «Учебный склад кухни» не теряется в конце списка из 30.
      ctx.stores = (r.stores || []).filter((x) => x.active).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
      // Склады пользователя спрашиваются у сервера заново: в сохранённой сессии их может
      // не быть (вход до обновления) или они уже поменялись.
      const me = await ask("me", {});
      const ids = (me.user && me.user.store_ids) || [];
      ctx.mine = ids.length ? ctx.stores.filter((x) => ids.includes(x.id)) : ctx.stores;
    } catch (e) {
      const main = $("main"); main.innerHTML = "";
      main.append(el("div", { class: "card" }, el("div", { class: "err" }, "Список складов не загрузился: " + e.message),
        el("div", { class: "dim", style: "margin-top:6px" }, "Проверьте связь и попробуйте ещё раз.")),
        el("div", { class: "bar" }, el("button", { class: "ghost", onclick: doLogout }, "Выйти"), el("button", { onclick: start }, "Повторить")));
      return;
    }
  }
  let saved = null; try { saved = localStorage.getItem("tandem_stock_store"); } catch {}
  ctx.store = ctx.mine.find((x) => x.id === saved) || (ctx.mine.length === 1 ? ctx.mine[0] : null);
  if (!ctx.store) { chooseStore(); return; }
  home();
}

function chooseStore() {
  ctx.where = "выбор склада";
  $("storename").textContent = "Выберите склад";
  const main = $("main"); main.innerHTML = "";
  const list = el("div", { class: "menu" });
  if (!ctx.mine.length) {
    main.append(el("div", { class: "card" }, el("div", { class: "err" }, "За вами не закреплён ни один действующий склад"),
      el("div", { class: "dim", style: "margin-top:6px" }, "Попросите администратора выбрать склады в карточке пользователя.")));
    return;
  }
  for (const s of ctx.mine) list.append(el("button", { type: "button", onclick: () => { ctx.store = s; try { localStorage.setItem("tandem_stock_store", s.id); } catch {} home(); } },
    s.name + (s.training ? " (учебный)" : ""), el("span", {}, s.point_name || "без точки")));
  main.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Склад запомнится на этом телефоне"), list));
}

function home() {
  ctx.where = "меню";
  $("storename").textContent = ctx.store.name;
  const main = $("main"); main.innerHTML = "";
  const menu = el("div", { class: "menu" });
  const allowed = SCENARIOS.filter((x) => perms().includes(x.perm));
  for (const x of allowed) menu.append(el("button", { type: "button", onclick: () => openScenario(x.id) }, x.title, el("span", {}, x.hint)));
  if (!allowed.length) menu.append(el("div", { class: "err" }, "У вашей роли нет складских операций"));
  main.append(menu,
    el("div", {}, el("a", { class: "link", href: "index.html" }, "← отчёт точки"), " · ",
      el("a", { class: "link", href: "help.html#sklad", target: "_blank", rel: "noopener" }, "памятка кладовщика")),
    el("div", {}, el("button", { class: "link", onclick: doLogout }, "Выйти")));
}

async function openScenario(id) {
  ctx.where = (SCENARIOS.find((x) => x.id === id) || {}).title || id;
  const main = $("main"); main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=21`);
    main.innerHTML = ""; await mod.mount(main, ctx);
  } catch (e) { main.innerHTML = ""; main.append(el("div", { class: "err" }, "Сценарий не открылся: " + e.message)); }
}

// Экран результата после проведения. bad — не успех, а предупреждение (документ проведён в другом
// виде, V22); buttons — свои действия вместо «Ещё»: [{ label, onclick, ghost }]; notes — узлы под
// итогом (например, «теперь продаются готовыми» и ход пересчёта продаж).
function result({ title, lines = [], again, warnings = [], bad = false, buttons = null, notes = [] }) {
  ctx.where = (ctx.where || "").replace(/ · итог$/, "") + " · итог";
  const main = $("main"); main.innerHTML = "";
  main.append(bad ? el("div", { class: "warnbox", style: "font-size:16px;font-weight:600" }, title) : el("div", { class: "okbox" }, title),
    ...lines.map((t) => el("div", { class: "dim", style: "margin-top:6px" }, t)));
  if (warnings.length) main.append(el("div", { class: "warnbox" }, warnings.join("; ")));
  if (notes.length) main.append(...notes);
  const acts = buttons ? buttons.map((b) => el("button", b.ghost ? { class: "ghost", onclick: b.onclick } : { onclick: b.onclick }, b.label))
    : [el("button", { onclick: again }, "Ещё")];
  main.append(el("div", { class: "bar" }, ...acts, el("button", { class: "ghost", onclick: home }, "В меню")));
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("changestore").addEventListener("click", chooseStore);
// Сессия истекла посреди работы: api() не перезагружает страницу, а шлёт это событие.
// Показываем вход поверх; экран сценария остаётся в DOM, черновики — в телефоне.
window.addEventListener("tandem:unauthorized", (e) => {
  const s = session();
  if (!$("shell").hidden && s && s.user) ctx.resume = s.user.id;
  setSession(null);
  show("login");
  $("lpin").value = "";
  try { $("llogin").value = localStorage.getItem("tandem_stock_login") || $("llogin").value; } catch {}
  $("lerr").textContent = (e.detail && e.detail.message) || "Сессия истекла — войдите снова";
});
(async () => {
  if (session()) {
    try {
      const r = await api("me", {});
      if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
      else if (r.error === "network") toast("Нет связи с сервером", "bad");
    } catch (e) { toast("Нет связи: " + e.message, "bad"); }
  }
  start();
})();
