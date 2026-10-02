// Касса: продавец пробивает каждую продажу в течение дня. Чек уходит на сервер сразу и там же
// попадает в дневной отчёт точки и на склад (миграция 0033). Связь на точках нестабильная, поэтому
// чек сначала кладётся в очередь планшета (localStorage) и досылается в фоне; сервер узнаёт
// повторную досылку по uid и второй чек не создаёт.
import { el, fmt, toast, today, debounce } from "../office/ui.js?v=20";

const API = window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const $ = (id) => document.getElementById(id);
const PAY = { cash: "Наличные", kaspi_qr: "Kaspi QR", transfer: "Перевод", card: "Карта" };
const MAX_TILES = 150;
const TIMEOUT = 20000;   // дольше ответа не ждём: повисший запрос не должен останавливать досылку

// sess меняется при каждом входе и выходе: ответ, пришедший после смены точки, к новой смене не относится.
// flushing — идущий проход досылки, sending — запись, которая сейчас в пути ({uid, ver}).
const S = { point: null, pin: "", seller: "", items: [], byCode: new Map(), cat: "__fav", q: "",
  cart: [], editUid: null, editNo: null, editDate: null, queue: [], flushing: null, sending: null,
  online: true, authFail: false, sess: 0 };

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
// Отказ сервера (ok:false) возвращается как есть; обрыв связи, таймаут и 5xx — исключение с offline=true.
// server=true — сервер ответил ошибкой; maybe=true — запрос мог дойти до сервера (всё, кроме обрыва
// при выключенной сети). who = {pin, point} — от чьего имени слать: досылка шлёт от имени точки, чья
// это очередь, а не той, что открыта сейчас.
async function call(action, payload, who) {
  const pin = who ? who.pin : S.pin, point_id = who ? who.point : (S.point ? S.point.id : null);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const fail = (text, server) => { const w = new Error(text); w.offline = true; w.server = server;
    w.maybe = server || ctl.signal.aborted || !(typeof navigator !== "undefined" && navigator.onLine === false); return w; };
  try {
    let res;
    try {
      res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ action, payload: { pin, point_id, ...payload } }) });
    } catch (e) { throw fail("Нет связи с сервером", false); }
    if (res.status >= 500) throw fail("Сервер не ответил", true);
    try { return await res.json(); }
    catch { throw ctl.signal.aborted ? fail("Нет связи с сервером", false) : fail("Сервер ответил непонятно", true); }
  } finally { clearTimeout(timer); }
}
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const money = (n) => fmt(n || 0) + " ₸";
const step = (unit) => (/^(кг|л)$/i.test(unit || "") ? 0.1 : 1);
const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const x = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : NaN; };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const ddmm = (d) => d.split("-").reverse().join(".");

// ---------------------------------------------------------------- вход
async function initLogin() {
  $("shell").hidden = true; $("login").hidden = false;
  const saved = store.get("tandem_login", null);
  $("lseller").value = store.get("tandem_kassa_seller", "") || "";
  const sel = $("lpoint");
  let points = null;
  try {
    points = (await call("points", {}, {})).filter((p) => p.mode === "checks");
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
  const n = S.queue.filter(unsent).length;
  if (n && !window.confirm("Ещё не ушли на сервер чеки: " + n + ". Они останутся на планшете и уйдут, когда сюда снова войдут в эту точку. Выйти?")) return;
  // Идущая досылка увидит смену sess и остановится; чеки этой точки остаются в её очереди на планшете.
  S.sess++; S.flushing = null; S.sending = null; clearTimeout(retryTimer); retryTimer = null;
  S.point = null; S.pin = ""; S.cart = []; S.editUid = null; S.queue = []; S.authFail = false;
  initLogin();
}

// ---------------------------------------------------------------- каркас
function openShell() {
  S.sess++; S.authFail = false; S.online = true;
  $("login").hidden = true; $("shell").hidden = false; $("shift").innerHTML = "";
  $("pname").textContent = S.point.name || "Касса";
  $("sellerbtn").textContent = "Продавец: " + S.seller;
  // Записи прежних сборок — без версии и точки: очередь хранится по точке, значит запись её.
  S.queue = (store.get(qKey(), []) || []).map((q) => ({ ...q, ver: q.ver || nextVer(), point: q.point || S.point.id }));
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
  const sess = S.sess, key = iKey();
  const cached = store.get(key, null);
  if (cached) setItems(cached); else drawState("Загружаю меню точки…");
  try {
    const r = await call("items", {});
    if (sess !== S.sess) return;   // пока грузилось, вошли в другую точку — это меню не её
    if (!r.ok) throw new Error(r.error || "Меню не загрузилось");
    store.set(key, r.items); setItems(r.items);
  } catch (e) {
    if (!cached && sess === S.sess) drawState(e.offline ? "Нет связи — меню не загрузилось." : e.message, loadItems);
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
  // Правка чека, который ещё в очереди: та же запись с новой версией. День, продавец и время пробития —
  // прежние; «правкой» (edit) она становится, только если чек уже был на сервере.
  const prev = S.editUid ? S.queue.find((q) => q.uid === S.editUid) : null;
  const entry = { uid: S.editUid || uuid(), ver: nextVer(), point: S.point.id, no: S.editNo || (prev && prev.no) || null,
    date: prev ? prev.date : S.editUid ? (S.editDate || today()) : today(), seller: prev ? prev.seller : S.seller,
    pay_kind: kind, total: cartTotal(), created: prev ? prev.created : new Date().toISOString(), state: "wait",
    edit: prev ? !!prev.edit : !!S.editUid, sent: !!prev && (!!prev.sent || inFlight(prev.uid)),
    lines: S.cart.map((c) => ({ item_code: c.code, item_name: c.name, unit: c.unit, qty: c.qty, price: c.price, price_list: c.price_list })) };
  const k = S.queue.findIndex((q) => q.uid === entry.uid);   // правка остаётся на месте: номера чекам сервер даёт по порядку
  if (k >= 0) S.queue[k] = entry; else S.queue.push(entry);
  saveQueue();
  toast((S.editUid ? "Чек исправлен · " : "Чек пробит · ") + money(entry.total) + " · " + PAY[kind]);
  S.cart = []; S.editUid = null; S.editNo = null; drawCart(); drawTiles(); sheet(false);
  flush();
}

// Наличные: сколько дал покупатель и сколько сдачи. Можно пропустить — сдача ни на что не влияет,
// в учёт идёт сумма чека.
function askCash() {
  if (!S.cart.length) return;
  const total = cartTotal(), box = $("cashbox"), inp = $("cashgot");
  const round = (n, s) => Math.ceil(n / s) * s;
  const opts = [...new Set([total, round(total, 500), round(total, 1000), round(total, 5000), round(total, 10000)])].filter((v) => v >= total).slice(0, 4);
  $("cashsum").textContent = money(total); inp.value = "";
  const quick = $("cashquick"); quick.innerHTML = "";
  for (const v of opts) quick.append(el("button", { type: "button", onclick: () => { inp.value = v; show(); } }, v === total ? "Без сдачи" : fmt(v)));
  const show = () => { const got = num(inp.value); const ch = got - total;
    $("cashchange").textContent = !(got > 0) ? "—" : ch < 0 ? "не хватает " + money(-ch) : money(ch);
    $("cashchange").className = ch < 0 && got > 0 ? "bad" : ""; $("cashok").disabled = got > 0 && ch < 0; };
  inp.oninput = show; show();
  $("cashok").onclick = () => { box.hidden = true; pay("cash"); };
  $("cashcancel").onclick = () => { box.hidden = true; };
  box.hidden = false; setTimeout(() => inp.focus(), 0);
}

// ---------------------------------------------------------------- очередь и досылка
// Запись очереди — чек целиком плюс служебные поля: ver — версия, меняется при каждой правке на планшете;
// point — чья запись; sent — отправка уже уходила без ответа, чек мог дойти до сервера.
// Состояния: wait — ждёт отправки; bad — сервер отказал; drop — продавец удалил чек, который мог уже
// дойти до сервера: досылка отменит его там (check_void) с причиной продавца.
let verSeq = Date.now();
const nextVer = () => ++verSeq;
const unsent = (q) => q.state === "wait" || q.state === "drop";
const inFlight = (uid) => !!S.sending && S.sending.uid === uid;
// Правку уже существующего чека сервер не принимает: смена закрыта или чек старый (контракт п. 5).
const LOCKED = /^(Смена закрыта|Чек слишком старый)/;
const sig = (pay, lines) => pay + "|" + lines.map((l) => l.item_code + ":" + Number(l.qty) + ":" + Number(l.price)).join(",");
let retryTimer = null;
function retry(ms) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryTimer = null; flush(); }, ms); }

// Повтор после потерянного ответа: чек с этим uid уже на сервере, и правку сервер не принимает. Если там
// ровно то, что ушло с планшета, чек на месте — отказ относится не к нему.
async function landed(q, who) {
  try {
    const r = await call("check_list", { date: q.date }, who);
    const c = r && r.ok && (r.checks || []).find((x) => x.uid === q.uid);
    return !!c && c.status === "active" && sig(c.pay_kind, c.lines || []) === sig(q.pay_kind, q.lines);
  } catch { return false; }
}

// Досылка идёт по живой очереди, а не по снимку: каждый шаг берёт первую неотправленную запись своей
// точки. Пробитый во время отправки чек уйдёт следующим шагом, исправленный — новой версией: запись
// убирается из очереди, только если за время запроса её версия не изменилась.
async function flush() {
  if (S.flushing || !S.point || S.authFail) return;
  const run = {}, sess = S.sess, who = { pin: S.pin, point: S.point.id };
  const skip = new Set();   // uid:ver, на которых сервер ответил ошибкой 5xx: вернёмся к ним по таймеру
  S.flushing = run; clearTimeout(retryTimer); retryTimer = null;
  try {
    for (;;) {
      const q = S.queue.find((x) => unsent(x) && x.point === who.point && !skip.has(x.uid + ":" + x.ver));
      if (!q) break;
      const sent = { uid: q.uid, ver: q.ver }, act = q.state === "drop" ? "check_void" : "check_save";
      let r;
      S.sending = sent;
      try {
        r = act === "check_void" ? await call("check_void", { uid: q.uid, reason: q.drop_reason }, who)
          : await call("check_save", { uid: q.uid, date: q.date, seller: q.seller, pay_kind: q.pay_kind,
              lines: q.lines.map((l) => ({ item_code: l.item_code, qty: l.qty, price: l.price })) }, who);
        r = r || {};
        if (act === "check_save" && !r.ok && LOCKED.test(r.error || "") && await landed(q, who)) r = { ok: true };
      } catch (e) {
        if (sess !== S.sess) return;
        const cur = S.queue.find((x) => x.uid === sent.uid);
        if (cur && act === "check_save" && !cur.sent && e.maybe) { cur.sent = true; saveQueue(); }
        if (e.server) { skip.add(sent.uid + ":" + sent.ver); continue; }
        S.online = false; retry(15000); return;
      } finally { if (S.sending === sent) S.sending = null; }
      if (sess !== S.sess) return;   // вышли или вошли в другую точку: её очередь этот проход не трогает
      S.online = true;
      if (r.code === "throttled") {
        toast("Сервер временно закрыл вход по коду. Чеки сохранены на планшете и уйдут позже.", "bad"); retry(60000); return;
      }
      if (r.error === "Нет доступа") {   // код точки сменили: каждый повтор считался бы неверным кодом
        S.authFail = true; toast("Сервер не принял код точки. Чеки сохранены на планшете — выйдите и войдите заново.", "bad"); return;
      }
      const cur = S.queue.find((x) => x.uid === sent.uid), same = !!cur && cur.ver === sent.ver;
      if (act === "check_void") {
        if (r.ok || r.error === "Чек не найден") {
          if (same) S.queue = S.queue.filter((x) => x !== cur);
          if (r.ok) toast("Удалённый чек успел дойти до сервера — там он отменён");
        } else if (same) { cur.state = "bad"; cur.error = r.error || "Сервер не отменил чек"; toast("Чек не отменён: " + cur.error, "bad"); }
      } else if (r.ok) {
        if (same) S.queue = S.queue.filter((x) => x !== cur);
        else if (cur) { cur.sent = true; if (!cur.no && r.check) cur.no = r.check.no; }   // уйдёт новая версия
      } else if (same && cur.state === "wait") {
        cur.state = "bad"; cur.error = r.error || "Сервер не принял чек"; toast("Чек не принят: " + cur.error, "bad");
      }
      saveQueue();
    }
    if (skip.size) retry(15000);
  } finally {
    if (S.flushing === run) S.flushing = null;
    if (sess === S.sess) { drawSync(); if (!$("shift").hidden) drawShift(); }
  }
}
function drawSync() {
  const s = $("sync"); if (!S.point) return;
  const wait = S.queue.filter(unsent).length, bad = S.queue.filter((q) => q.state === "bad").length;
  s.className = "sync" + (bad || S.authFail ? " bad" : wait ? " wait" : "");
  s.textContent = bad ? "Не приняты сервером: " + bad + (wait ? " · ждут: " + wait : "")
    : wait ? (S.authFail ? "Код точки не принят — войдите заново · ждут: " : S.online ? "Отправляю: " : "Нет связи · ждут отправки: ") + wait
    : "Все чеки на сервере";
}

// ---------------------------------------------------------------- смена
// Закрыть смену с неотправленными чеками сегодняшнего дня нельзя: отчёт выйдет без них, а опоздавший чек
// потом молча изменит закрытый день. Чеки прошлых дней и непринятые — предупреждение.
let leaving = false;
function closeShift(e) {
  const day = today(), now = S.queue.filter((q) => unsent(q) && q.date === day).length;
  if (now) {
    e.preventDefault(); flush();
    window.alert("Ещё не ушли на сервер чеки за сегодня: " + now + ". Без них отчёт смены выйдет неполным и касса не сойдётся. " +
      (S.authFail ? "Сервер не принимает код точки — выйдите, войдите заново и дождитесь надписи «Все чеки на сервере»."
        : S.online ? "Дождитесь надписи «Все чеки на сервере» и закройте смену."
        : "Нет связи: когда она появится и чеки уйдут (надпись «Все чеки на сервере»), закройте смену."));
    return;
  }
  const old = S.queue.filter(unsent).length, bad = S.queue.filter((q) => q.state === "bad").length;
  if ((old || bad) && !window.confirm("На планшете есть чеки не на сервере" + (old ? ": прошлых дней ждут отправки — " + old : "") +
      (bad ? (old ? ", " : ": ") + "не приняты сервером — " + bad : "") +
      ". В отчёт они не попадут. Разберите их во вкладке «Смена» или позвоните в офис. Всё равно перейти к закрытию смены?")) { e.preventDefault(); return; }
  leaving = true; setTimeout(() => { leaving = false; }, 3000);
}

let shiftSeq = 0;
async function drawShift() {
  const box = $("shift"), seq = ++shiftSeq, sess = S.sess, day = today();
  const head = (extra) => { box.innerHTML = ""; box.append(el("h2", {}, "Смена · " + ddmm(day)), ...(extra || []).filter(Boolean)); };
  if (!box.firstChild) head([el("div", { class: "state" }, "Загружаю чеки…")]);
  let data = null, offline = false;
  try { const r = await call("check_list", { date: day }); if (r.ok) data = r; else throw new Error(r.error); }
  catch (e) { offline = true; }
  if (seq !== shiftSeq || sess !== S.sess) return;
  const server = data ? data.checks.map((c) => ({ ...c, date: day })) : [];
  const onSrv = new Map(server.map((c) => [c.uid, c]));
  const t = { count: 0, total: 0, cash: 0, kaspi_qr: 0, transfer: 0, card: 0 };
  if (data) for (const k of Object.keys(t)) t[k] = Number(data.totals[k]) || 0;
  // Итоги — по тому, что пробито, а не по тому, что дошло: неотправленный чек добавляем, правка дошедшего
  // заменяет его сумму, удаляемый вычитаем.
  for (const q of S.queue.filter((x) => unsent(x) && x.date === day)) {
    const c = onSrv.get(q.uid);
    if (c && c.status !== "active") continue;
    if (c) { t.count -= 1; t.total -= Number(c.total); t[c.pay_kind] -= Number(c.total); }
    if (q.state === "wait") { t.count += 1; t.total += q.total; t[q.pay_kind] += q.total; }
  }
  // Всё, что лежит на планшете, — любой даты: ждёт отправки, удаляется или отклонено сервером.
  const local = [...S.queue].sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));
  head([
    offline ? el("div", { class: "note" }, "Нет связи: показаны только чеки, которые ещё не ушли на сервер. ", el("button", { class: "link", onclick: drawShift }, "Обновить")) : null,
    data && data.closed_at ? el("div", { class: "note ok" }, "Смена закрыта в " + new Date(data.closed_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) + ". Новые чеки всё равно попадут в отчёт этого дня, а исправить или отменить чек теперь можно только через офис.") : null,
    el("div", { class: "kpis" },
      el("div", { class: "kpi main" }, el("span", {}, "Итого за смену"), el("b", {}, money(t.total))),
      el("div", { class: "kpi" }, el("span", {}, "Чеков"), el("b", {}, String(t.count))),
      ...Object.entries(PAY).map(([k, title]) => el("div", { class: "kpi" }, el("span", {}, title), el("b", {}, money(t[k]))))),
    el("div", { class: "shiftbar" },
      el("a", { class: "link", href: "index.html", onclick: closeShift }, "Закрыть смену: пересчёт наличных и расходы →"),
      el("button", { class: "link", onclick: drawShift }, "Обновить список")),
    local.length ? el("h3", { class: "qhead" }, "Не на сервере: " + local.length) : null,
    local.some((q) => q.date !== day) ? el("div", { class: "dim" }, "Здесь и чеки прошлых дней: они уходят в отчёт своего дня. Если сервер не принял чек по дате — позвоните в офис.") : null,
  ]);
  for (const q of local) box.append(checkCard(q, true));
  const list = server.filter((c) => !S.queue.some((q) => q.uid === c.uid));
  if (local.length && list.length) box.append(el("h3", { class: "qhead" }, "На сервере"));
  for (const c of list) box.append(checkCard(c, false, !!data.closed_at));
  if (!local.length && !list.length && !offline) box.append(el("div", { class: "state" }, "За сегодня чеков ещё нет. Пробейте первый на вкладке «Продажа»."));
}
// Что сказать продавцу о записи очереди и какие действия ей оставить.
function localNote(c) {
  if (c.state === "drop") return { text: "Чек уже отправлялся. Если он дошёл до сервера, его там отменят с причиной: " + c.drop_reason, acts: [] };
  if (c.state !== "bad") return { text: null, acts: ["edit", "drop"] };
  if (c.drop_reason) return { text: "Чек удалён на планшете, но на сервере остался: " + c.error + ".", acts: ["forget"] };
  if (LOCKED.test(c.error || "")) return { text: c.error + (c.edit ? ". На сервере чек остался прежним." : "."), acts: ["forget"] };
  if (/^Дата чека/.test(c.error || "")) return { text: "Сервер не принял чек за " + ddmm(c.date) + ": " + c.error + ". Позвоните в офис — чек внесут вручную, после этого удалите его здесь.", acts: ["edit", "drop"] };
  return { text: c.error + ". Исправьте чек или удалите его.", acts: ["edit", "drop"] };
}
// closed — смена дня закрыта: чек на сервере правит и отменяет уже только офис.
function checkCard(c, local, closed) {
  const isVoid = c.status === "void", bad = local && c.state === "bad", drop = local && c.state === "drop";
  const time = new Date(c.created_at || c.created).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const n = local ? localNote(c) : null;
  const acts = local ? n.acts : isVoid || closed ? [] : ["edit", "void"];
  return el("div", { class: "chk" + (isVoid ? " void" : "") + (local ? (bad ? " rejected" : " pending") : "") },
    el("div", { class: "chead" },
      el("b", {}, c.no ? "Чек №" + c.no : "Новый чек"), el("span", { class: "dim" }, (local ? ddmm(c.date) + " " : "") + time + (c.seller ? " · " + c.seller : "")),
      el("span", { class: "pill" }, PAY[c.pay_kind] || c.pay_kind),
      local ? el("span", { class: "pill " + (bad ? "bad" : "warn") }, drop ? "удаляется" : bad ? "не принят" : "ждёт отправки") : null,
      !local && c.edited ? el("span", { class: "pill warn" }, "исправлен") : null,
      isVoid ? el("span", { class: "pill bad" }, "отменён" + (c.void_reason ? ": " + c.void_reason : "")) : null,
      el("span", { class: "sum" }, money(c.total))),
    n && n.text ? el("div", { class: bad ? "err" : "dim" }, n.text) : null,
    el("ul", { class: "clines" }, c.lines.map((l) => el("li", {}, el("span", {}, l.item_name + " × " + fmt(l.qty)), el("span", {}, fmt(r2(l.qty * l.price)))))),
    acts.length ? el("div", { class: "cact" },
      acts.includes("edit") ? el("button", { onclick: () => startEdit(c) }, "Исправить") : null,
      acts.includes("drop") ? el("button", { onclick: () => dropLocal(c) }, "Удалить") : null,
      acts.includes("forget") ? el("button", { onclick: () => dropLocal(c) }, "Убрать с планшета") : null,
      acts.includes("void") ? el("button", { onclick: (e) => voidCheck(c, e.target) }, "Отменить чек") : null) : null);
}
function startEdit(c) {
  if (S.cart.length && !window.confirm("В чеке уже есть позиции. Заменить их исправляемым чеком?")) return;
  S.editUid = c.uid; S.editNo = c.no || null; S.editDate = c.date || today();
  S.cart = c.lines.map((l) => { const i = S.byCode.get(l.item_code);
    return { code: l.item_code, name: l.item_name, unit: l.unit || (i && i.unit) || "шт", qty: Number(l.qty), price: Number(l.price),
      price_list: l.price_list === null || l.price_list === undefined ? null : Number(l.price_list) }; });
  showTab("sale"); drawCart(); drawTiles(); sheet(true);
}
// Причина отмены обязательна: её видят собственник и офис.
function askReason(text) {
  for (;;) {
    const v = window.prompt(text, "");
    if (v === null) return null;
    if (v.trim()) return v.trim();
    text = "Без причины чек не отменить. " + text;
  }
}
function dropLocal(c) {
  const q = S.queue.find((x) => x.uid === c.uid);
  if (!q) { drawShift(); return; }   // уже ушёл на сервер или убран
  const maybe = q.sent || inFlight(q.uid);   // мог уже дойти до сервера
  if (q.state === "bad" && (q.drop_reason || LOCKED.test(q.error || ""))) {
    if (!window.confirm("Убрать чек с планшета? На сервере он останется таким, какой там сейчас. Если это неверно — позвоните в офис.")) return;
  } else if (q.edit) {
    if (!window.confirm(maybe ? "Правка уже отправлялась и могла дойти до сервера. Убрать её с планшета? Если дошла, чек на сервере останется исправленным — его можно исправить ещё раз."
      : "Убрать неотправленную правку? На сервере чек останется прежним.")) return;
  } else if (maybe) {
    // Удалённый чек не должен молча появиться на сервере: досылка проверит и, если он там, отменит его.
    const reason = askReason("Чек уже отправлялся и мог дойти до сервера — тогда его там отменят. Почему удаляете чек на " + money(q.total) + "?");
    if (reason === null) return;
    Object.assign(q, { state: "drop", drop_reason: reason, error: null, ver: nextVer() });
    saveQueue(); drawShift(); flush(); return;
  } else if (!window.confirm("Удалить чек, который ещё не ушёл на сервер?")) return;
  S.queue = S.queue.filter((x) => x !== q); saveQueue(); drawShift();
}
async function voidCheck(c, btn) {
  const reason = askReason("Почему отменяете чек №" + c.no + " на " + money(c.total) + "? Причину увидит собственник.");
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
for (const b of $("pay").querySelectorAll("button")) b.onclick = () => (b.dataset.pay === "cash" ? askCash() : pay(b.dataset.pay));
$("sellerbtn").onclick = () => {
  const v = window.prompt("Кто сейчас за кассой?", S.seller);
  if (v && v.trim()) { S.seller = v.trim(); store.set("tandem_kassa_seller", S.seller); $("sellerbtn").textContent = "Продавец: " + S.seller; }
};
window.addEventListener("online", flush);
// Неотправленные чеки лежат в памяти планшета и переживут закрытие вкладки, но предупредить стоит:
// без открытой кассы они не уйдут.
window.addEventListener("beforeunload", (e) => { if (S.cart.length || (!leaving && S.queue.some(unsent))) { e.preventDefault(); e.returnValue = ""; } });
initLogin();
