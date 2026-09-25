// Касса: продавец пробивает каждую продажу в течение дня. Чек уходит на сервер сразу и там же
// попадает в дневной отчёт точки и на склад (миграция 0033). Связь на точках нестабильная, поэтому
// чек сначала кладётся в очередь планшета (localStorage) и досылается в фоне; сервер узнаёт
// повторную досылку по uid и второй чек не создаёт.
import { el, fmt, toast, today, debounce } from "../office/ui.js?v=13";

const API = window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const $ = (id) => document.getElementById(id);
const PAY = { cash: "Наличные", kaspi_qr: "Kaspi QR", transfer: "Перевод", card: "Карта" };
const MAX_TILES = 150;

const S = { point: null, pin: "", seller: "", items: [], byCode: new Map(), cat: "__fav", q: "",
  cart: [], editUid: null, editNo: null, queue: [], flushing: false, online: true };

// ---------------------------------------------------------------- хранилище планшета
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const qKey = () => "tandem_kassa_queue_" + S.point.id;
const iKey = () => "tandem_kassa_items_" + S.point.id;
function saveQueue() {
  if (!store.set(qKey(), S.queue)) toast("Память планшета переполнена — чеки не сохраняются. Позвоните в офис.", "bad");
  drawSync();
}

// ---------------------------------------------------------------- сервер
// Отказ сервера (ok:false) возвращается как есть; обрыв связи и 5xx — исключение с offline=true.
async function call(action, payload) {
  let res;
  try {
    res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, payload: { pin: S.pin, point_id: S.point ? S.point.id : null, ...payload } }) });
  } catch (e) { const w = new Error("Нет связи с сервером"); w.offline = true; throw w; }
  if (res.status >= 500) { const w = new Error("Сервер не ответил"); w.offline = true; throw w; }
  try { return await res.json(); } catch { const w = new Error("Сервер ответил непонятно"); w.offline = true; throw w; }
}
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const money = (n) => fmt(n || 0) + " ₸";
const step = (unit) => (/^(кг|л)$/i.test(unit || "") ? 0.1 : 1);
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const x = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : NaN; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// ---------------------------------------------------------------- вход
async function initLogin() {
  $("shell").hidden = true; $("login").hidden = false;
  const saved = store.get("tandem_login", null);
  $("lseller").value = store.get("tandem_kassa_seller", "") || "";
  const sel = $("lpoint");
  let points = null;
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "points", payload: {} }) });
    points = (await r.json()).filter((p) => p.mode === "checks");
    store.set("tandem_kassa_points", points);
  } catch { points = store.get("tandem_kassa_points", null); }
  sel.innerHTML = "";
  if (!points) { sel.append(el("option", { value: "" }, "Нет связи — точки не загрузились")); $("lerr").textContent = "Нет связи с сервером. Проверьте интернет и обновите страницу."; return; }
  if (!points.length) { sel.append(el("option", { value: "" }, "Касса не включена ни у одной точки")); $("lerr").textContent = "Режим «касса» включает администратор в настройках точки."; return; }
  if (points.length > 1) sel.append(el("option", { value: "" }, "— выберите точку —"));
  for (const p of points) sel.append(el("option", { value: p.id }, p.name));
  if (saved && points.some((p) => p.id === saved.point_id)) { sel.value = saved.point_id; $("lpin").value = saved.pin || ""; }
}

async function doLogin() {
  const pid = $("lpoint").value, pin = $("lpin").value.trim(), seller = $("lseller").value.trim();
  const err = $("lerr"); err.textContent = "";
  if (!pid) { err.textContent = "Выберите точку"; return; }
  if (!pin) { err.textContent = "Введите код точки"; return; }
  if (!seller) { err.textContent = "Напишите, кто за кассой — имя попадёт в каждый чек"; return; }
  const btn = $("lbtn"); btn.disabled = true;
  S.pin = pin; S.point = { id: pid };
  try {
    const r = await call("login", {});
    if (!r.ok) { err.textContent = r.code === "throttled" ? (r.error || "Вход временно закрыт") : "Код не подошёл. Проверьте точку и код."; S.point = null; return; }
    if (r.role !== "point" || r.point.mode !== "checks") { err.textContent = "У этой точки касса не включена"; S.point = null; return; }
    S.point = r.point;
  } catch (e) {
    // Без связи пускаем только на этот же планшет с тем же кодом, что входил раньше: меню есть в памяти.
    const saved = store.get("tandem_login", null), pts = store.get("tandem_kassa_points", []) || [];
    const p = pts.find((x) => x.id === pid);
    if (!(saved && saved.point_id === pid && saved.pin === pin && p && store.get("tandem_kassa_items_" + pid, null))) {
      err.textContent = "Нет связи с сервером — войти не получилось"; S.point = null; return;
    }
    S.point = { id: p.id, name: p.name, mode: p.mode };
  } finally { btn.disabled = false; }
  S.seller = seller;
  store.set("tandem_login", { point_id: pid, pin }); store.set("tandem_kassa_seller", seller);
  openShell();
}

function logout() {
  if (S.cart.length && !window.confirm("В чеке есть позиции. Выйти и очистить чек?")) return;
  S.point = null; S.pin = ""; S.cart = []; S.editUid = null; S.queue = [];
  initLogin();
}

// ---------------------------------------------------------------- каркас
function openShell() {
  $("login").hidden = true; $("shell").hidden = false;
  $("pname").textContent = S.point.name || "Касса";
  $("sellerbtn").textContent = "Продавец: " + S.seller;
  S.queue = store.get(qKey(), []) || [];
  S.cart = []; S.editUid = null; S.cat = "__fav"; S.q = ""; $("q").value = "";
  showTab("sale"); drawCart(); drawSync(); loadItems(); flush();
}
function showTab(name) {
  $("sale").hidden = name !== "sale"; $("shift").hidden = name !== "shift";
  $("tab-sale").setAttribute("aria-selected", String(name === "sale"));
  $("tab-shift").setAttribute("aria-selected", String(name === "shift"));
  $("cartbar").hidden = name !== "sale" || !S.cart.length;
  if (name === "shift") drawShift();
}

// ---------------------------------------------------------------- меню
async function loadItems() {
  const cached = store.get(iKey(), null);
  if (cached) setItems(cached); else drawState("Загружаю меню точки…");
  try {
    const r = await call("items", {});
    if (!r.ok) throw new Error(r.error || "Меню не загрузилось");
    store.set(iKey(), r.items); setItems(r.items);
  } catch (e) {
    if (!cached) drawState(e.offline ? "Нет связи — меню не загрузилось." : e.message, loadItems);
  }
}
function setItems(items) {
  S.items = items.map((i) => ({ ...i, _n: norm(i.name) + " " + norm(i.artikul) }));
  S.byCode = new Map(S.items.map((i) => [i.code, i]));
  if (S.cat === "__fav" && !S.items.some((i) => i.rank !== null && i.rank !== undefined)) S.cat = "__all";
  drawChips(); drawTiles();
}
function drawState(text, retry) {
  const t = $("tiles"); t.innerHTML = "";
  t.append(el("div", { class: "state" }, text, retry ? el("div", {}, el("button", { onclick: retry }, "Повторить")) : null));
}
function drawChips() {
  const c = $("chips"); c.innerHTML = "";
  const cats = [...new Set(S.items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const list = [["__all", "Все"], ...cats.map((x) => [x, x])];
  if (S.items.some((i) => i.rank !== null && i.rank !== undefined)) list.unshift(["__fav", "Частые"]);
  for (const [id, title] of list)
    c.append(el("button", { "aria-pressed": String(S.cat === id), onclick: () => { S.cat = id; S.q = ""; $("q").value = ""; drawChips(); drawTiles(); } }, title));
}
function visibleItems() {
  if (S.q) { const words = norm(S.q).split(" ").filter(Boolean); return S.items.filter((i) => words.every((w) => i._n.includes(w))); }
  if (S.cat === "__fav") return S.items.filter((i) => i.rank !== null && i.rank !== undefined).sort((a, b) => a.rank - b.rank);
  if (S.cat === "__all") return S.items;
  return S.items.filter((i) => i.category === S.cat);
}
function drawTiles() {
  const t = $("tiles"); t.innerHTML = "";
  if (!S.items.length) { drawState("В меню точки нет позиций. Их включает технолог в бэк-офисе: «Номенклатура» → позиция → «В продаже»."); return; }
  const list = visibleItems();
  if (!list.length) { drawState(S.q ? "По запросу «" + S.q + "» ничего не нашлось. Попробуйте часть названия или артикул." : "В этой группе пусто."); return; }
  for (const i of list.slice(0, MAX_TILES)) {
    const inCart = S.cart.find((c) => c.code === i.code);
    const hasPrice = i.price !== null && i.price !== undefined;
    t.append(el("button", { class: "tile", onclick: () => addItem(i.code) },
      el("span", { class: "tn" }, i.name),
      hasPrice ? el("span", { class: "tp" }, fmt(i.price) + " ₸ ", el("i", {}, "/ " + (i.unit || "шт"))) : el("span", { class: "noprice" }, "цена не задана"),
      inCart ? el("span", { class: "cnt" }, fmt(inCart.qty)) : null));
  }
  if (list.length > MAX_TILES) t.append(el("div", { class: "state dim" }, "Показаны первые " + MAX_TILES + " из " + list.length + ". Уточните поиском или выберите группу."));
}

// ---------------------------------------------------------------- чек
function addItem(code) {
  const i = S.byCode.get(code); if (!i) return;
  const line = S.cart.find((c) => c.code === code);
  if (line) line.qty = r2(line.qty + step(line.unit));
  else S.cart.push({ code, name: i.name, unit: i.unit || "шт", qty: step(i.unit) === 1 ? 1 : 0.1, price: Number(i.price) || 0, price_list: i.price === null || i.price === undefined ? null : Number(i.price) });
  drawCart(); drawTiles();
}
const cartTotal = () => r2(S.cart.reduce((s, c) => s + r2(c.qty * c.price), 0));
function drawCart() {
  const box = $("rlines"); box.innerHTML = "";
  $("receipt").classList.toggle("editing", !!S.editUid);
  $("rtitle").textContent = S.editUid ? "Исправление чека №" + (S.editNo || "—") : "Чек";
  $("rclear").hidden = !S.cart.length && !S.editUid;
  $("rclear").textContent = S.editUid ? "Отменить правку" : "Очистить";
  if (!S.cart.length) box.append(el("div", { class: "rempty" }, "Нажмите на позицию слева — она появится в чеке."));
  S.cart.forEach((c, k) => {
    const qty = el("input", { type: "text", inputmode: "decimal", value: String(c.qty).replace(".", ","), "aria-label": "Количество: " + c.name,
      onchange: (e) => { const v = num(e.target.value); if (v > 0) c.qty = r2(v); drawCart(); drawTiles(); } });
    const cut = c.price_list !== null && c.price !== c.price_list;
    const price = el("button", { class: "price" + (cut ? " cut" : ""), title: "Изменить цену строки", onclick: () => editPrice(k) },
      cut ? el("s", {}, fmt(c.price_list)) : null, fmt(c.price) + " ₸ / " + c.unit);
    box.append(el("div", { class: "rline" },
      el("div", { class: "rn" }, c.name), el("div", { class: "rs" }, fmt(r2(c.qty * c.price))),
      el("div", { class: "rctl" },
        el("button", { "aria-label": "Меньше", onclick: () => { c.qty = r2(c.qty - step(c.unit)); if (c.qty <= 0) S.cart.splice(k, 1); drawCart(); drawTiles(); } }, "−"),
        qty,
        el("button", { "aria-label": "Больше", onclick: () => { c.qty = r2(c.qty + step(c.unit)); drawCart(); drawTiles(); } }, "+"),
        price,
        el("button", { class: "x", "aria-label": "Убрать из чека: " + c.name, onclick: () => { S.cart.splice(k, 1); drawCart(); drawTiles(); } }, "×"))));
  });
  const total = cartTotal();
  $("rsum").textContent = money(total);
  for (const b of $("pay").querySelectorAll("button")) b.disabled = !S.cart.length;
  const bar = $("cartbar");
  bar.hidden = !S.cart.length || $("sale").hidden;
  bar.innerHTML = ""; bar.append(el("span", {}, (S.editUid ? "Правка чека · " : "Чек · ") + S.cart.length + " поз."), el("b", {}, money(total)));
}
function editPrice(k) {
  const c = S.cart[k];
  const v = window.prompt("Цена за " + c.unit + " для «" + c.name + "»" + (c.price_list !== null ? " (по прейскуранту " + fmt(c.price_list) + " ₸)" : ""), String(c.price));
  if (v === null) return;
  const n = num(v);
  if (!(n >= 0)) { toast("Цена — число не меньше нуля", "bad"); return; }
  c.price = r2(n); drawCart();
}
function clearCart() {
  if (S.editUid ? !window.confirm("Отменить правку чека? Чек останется прежним.") : (S.cart.length > 2 && !window.confirm("Очистить чек?"))) return;
  S.cart = []; S.editUid = null; S.editNo = null; drawCart(); drawTiles(); sheet(false);
}
function sheet(open) { $("receipt").classList.toggle("open", open); $("scrim").hidden = !open; }

function pay(kind) {
  if (!S.cart.length) return;
  if (S.cart.some((c) => !(c.price > 0)) && !window.confirm("В чеке есть позиция с нулевой ценой. Пробить так?")) return;
  const entry = { uid: S.editUid || uuid(), no: S.editNo, date: today(), seller: S.seller, pay_kind: kind, total: cartTotal(),
    created: new Date().toISOString(), state: "wait", edit: !!S.editUid,
    lines: S.cart.map((c) => ({ item_code: c.code, item_name: c.name, unit: c.unit, qty: c.qty, price: c.price, price_list: c.price_list })) };
  S.queue = S.queue.filter((q) => q.uid !== entry.uid); S.queue.push(entry); saveQueue();
  toast((entry.edit ? "Чек исправлен · " : "Чек пробит · ") + money(entry.total) + " · " + PAY[kind]);
  S.cart = []; S.editUid = null; S.editNo = null; drawCart(); drawTiles(); sheet(false);
  flush();
}

// ---------------------------------------------------------------- очередь и досылка
let retryTimer = null;
async function flush() {
  if (S.flushing || !S.point) return;
  S.flushing = true; clearTimeout(retryTimer);
  try {
    for (const q of S.queue.filter((x) => x.state === "wait")) {
      let r;
      try { r = await call("check_save", { uid: q.uid, date: q.date, seller: q.seller, pay_kind: q.pay_kind,
        lines: q.lines.map((l) => ({ item_code: l.item_code, qty: l.qty, price: l.price })) }); }
      catch (e) { S.online = false; retryTimer = setTimeout(flush, 15000); return; }
      S.online = true;
      if (r.ok) S.queue = S.queue.filter((x) => x.uid !== q.uid);
      else if (r.code === "throttled" || r.error === "Нет доступа") {   // код точки сменили или вход закрыт: чеки ждут, продавец входит заново
        toast("Сервер не принял код точки. Чеки сохранены на планшете — войдите заново.", "bad"); retryTimer = setTimeout(flush, 60000); return;
      } else { q.state = "bad"; q.error = r.error || "Сервер не принял чек"; toast("Чек не принят: " + q.error, "bad"); }
      saveQueue();
    }
  } finally { S.flushing = false; drawSync(); if (!$("shift").hidden) drawShift(); }
}
function drawSync() {
  const s = $("sync"); if (!S.point) return;
  const wait = S.queue.filter((q) => q.state === "wait").length, bad = S.queue.filter((q) => q.state === "bad").length;
  s.className = "sync" + (bad ? " bad" : wait ? " wait" : "");
  s.textContent = bad ? "Не приняты сервером: " + bad : wait ? (S.online ? "Отправляю: " : "Нет связи · ждут отправки: ") + wait : "Все чеки на сервере";
}

// ---------------------------------------------------------------- смена
let shiftSeq = 0;
async function drawShift() {
  const box = $("shift"), seq = ++shiftSeq, day = today();
  const head = (extra) => { box.innerHTML = ""; box.append(el("h2", {}, "Смена · " + day.split("-").reverse().join(".")), ...(extra || []).filter(Boolean)); };
  if (!box.firstChild) head([el("div", { class: "state" }, "Загружаю чеки…")]);
  let data = null, offline = false;
  try { const r = await call("check_list", { date: day }); if (r.ok) data = r; else throw new Error(r.error); }
  catch (e) { offline = true; }
  if (seq !== shiftSeq) return;
  const pending = S.queue.filter((q) => q.date === day);
  const t = data ? { ...data.totals } : { count: 0, total: 0, cash: 0, kaspi_qr: 0, transfer: 0, card: 0 };
  // Неотправленные новые чеки добавляем к итогам: продавец сверяет кассу с тем, что пробил, а не с тем, что дошло.
  for (const q of pending.filter((x) => x.state === "wait" && !x.edit)) { t.count = Number(t.count) + 1; t.total = Number(t.total) + q.total; t[q.pay_kind] = Number(t[q.pay_kind]) + q.total; }
  head([
    offline ? el("div", { class: "note" }, "Нет связи: показаны только чеки, которые ещё не ушли на сервер. ", el("button", { class: "link", onclick: drawShift }, "Обновить")) : null,
    data && data.closed_at ? el("div", { class: "note ok" }, "Смена закрыта в " + new Date(data.closed_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) + ". Новые чеки всё равно попадут в отчёт этого дня.") : null,
    el("div", { class: "kpis" },
      el("div", { class: "kpi main" }, el("span", {}, "Итого за смену"), el("b", {}, money(t.total))),
      el("div", { class: "kpi" }, el("span", {}, "Чеков"), el("b", {}, String(t.count))),
      ...Object.entries(PAY).map(([k, title]) => el("div", { class: "kpi" }, el("span", {}, title), el("b", {}, money(t[k]))))),
    el("div", { class: "shiftbar" },
      el("a", { class: "link", href: "index.html" }, "Закрыть смену: пересчёт наличных и расходы →"),
      el("button", { class: "link", onclick: drawShift }, "Обновить список")),
  ]);
  const pendingUids = new Set(pending.map((q) => q.uid));
  for (const q of [...pending].reverse()) box.append(checkCard(q, true));
  const list = data ? data.checks.filter((c) => !pendingUids.has(c.uid)) : [];
  for (const c of list) box.append(checkCard(c, false));
  if (!pending.length && !list.length && !offline) box.append(el("div", { class: "state" }, "За сегодня чеков ещё нет. Пробейте первый на вкладке «Продажа»."));
}
function checkCard(c, local) {
  const isVoid = c.status === "void", bad = local && c.state === "bad";
  const time = new Date(c.created_at || c.created).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return el("div", { class: "chk" + (isVoid ? " void" : "") + (local ? (bad ? " rejected" : " pending") : "") },
    el("div", { class: "chead" },
      el("b", {}, c.no ? "Чек №" + c.no : "Новый чек"), el("span", { class: "dim" }, time + (c.seller ? " · " + c.seller : "")),
      el("span", { class: "pill" }, PAY[c.pay_kind] || c.pay_kind),
      local ? el("span", { class: "pill " + (bad ? "bad" : "warn") }, bad ? "не принят" : "ждёт отправки") : null,
      !local && c.edited ? el("span", { class: "pill warn" }, "исправлен") : null,
      isVoid ? el("span", { class: "pill bad" }, "отменён" + (c.void_reason ? ": " + c.void_reason : "")) : null,
      el("span", { class: "sum" }, money(c.total))),
    bad ? el("div", { class: "err" }, c.error + ". Исправьте чек или удалите его.") : null,
    el("ul", { class: "clines" }, c.lines.map((l) => el("li", {}, el("span", {}, l.item_name + " × " + fmt(l.qty)), el("span", {}, fmt(r2(l.qty * l.price)))))),
    isVoid ? null : el("div", { class: "cact" },
      el("button", { onclick: () => startEdit(c) }, "Исправить"),
      local ? el("button", { onclick: () => dropLocal(c) }, "Удалить") : el("button", { onclick: (e) => voidCheck(c, e.target) }, "Отменить чек")));
}
function startEdit(c) {
  if (S.cart.length && !window.confirm("В чеке уже есть позиции. Заменить их исправляемым чеком?")) return;
  S.editUid = c.uid; S.editNo = c.no || null;
  S.cart = c.lines.map((l) => { const i = S.byCode.get(l.item_code);
    return { code: l.item_code, name: l.item_name, unit: l.unit || (i && i.unit) || "шт", qty: Number(l.qty), price: Number(l.price),
      price_list: l.price_list === null || l.price_list === undefined ? null : Number(l.price_list) }; });
  showTab("sale"); drawCart(); drawTiles(); sheet(true);
}
function dropLocal(c) {
  if (!window.confirm(c.edit ? "Убрать неотправленную правку? На сервере чек останется прежним." : "Удалить чек, который ещё не ушёл на сервер?")) return;
  S.queue = S.queue.filter((q) => q.uid !== c.uid); saveQueue(); drawShift();
}
async function voidCheck(c, btn) {
  const reason = window.prompt("Почему отменяете чек №" + c.no + " на " + money(c.total) + "?", "");
  if (reason === null) return;
  btn.disabled = true;
  try {
    const r = await call("check_void", { uid: c.uid, reason });
    if (!r.ok) toast(r.error || "Чек не отменился", "bad"); else toast("Чек №" + c.no + " отменён");
  } catch (e) { toast("Нет связи — отмените чек, когда она появится", "bad"); }
  drawShift();
}

// ---------------------------------------------------------------- запуск
$("lbtn").onclick = doLogin;
$("lpin").onkeydown = (e) => { if (e.key === "Enter") $("lseller").focus(); };
$("lseller").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
$("logout").onclick = logout;
$("tab-sale").onclick = () => showTab("sale");
$("tab-shift").onclick = () => showTab("shift");
$("q").oninput = debounce((e) => { S.q = e.target.value.trim(); drawTiles(); }, 120);
$("rclear").onclick = clearCart;
$("rclose").onclick = () => sheet(false);
$("scrim").onclick = () => sheet(false);
$("cartbar").onclick = () => sheet(true);
for (const b of $("pay").querySelectorAll("button")) b.onclick = () => pay(b.dataset.pay);
$("sellerbtn").onclick = () => {
  const v = window.prompt("Кто сейчас за кассой?", S.seller);
  if (v && v.trim()) { S.seller = v.trim(); store.set("tandem_kassa_seller", S.seller); $("sellerbtn").textContent = "Продавец: " + S.seller; }
};
window.addEventListener("online", flush);
// Неотправленные чеки лежат в памяти планшета и переживут закрытие вкладки, но предупредить стоит.
window.addEventListener("beforeunload", (e) => { if (S.cart.length) { e.preventDefault(); e.returnValue = ""; } });
initLogin();
