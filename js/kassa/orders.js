// Вкладка «Заказы» кассы (0050): заказы клиентов из WhatsApp-бота. Новый заказ продавец подтверждает
// здесь или в Telegram — кто первым; дальше ведёт статусы до выдачи. «Выдан»/«Доставлен» пробивает чек
// на сервере (uid заказа), очередь чеков планшета не участвует.
import { el, fmt, toast } from "../office/ui.js?v=34";

const POLL = 20000;
const PAY = { cash: "Наличные", kaspi_qr: "Kaspi QR", transfer: "Перевод", card: "Карта" };
const NEXT = {
  new: [["confirmed", "Подтвердить"], ["awaiting_prepay", "С предоплатой"], ["rejected", "Отказать"]],
  awaiting_prepay: [["paid", "Оплата пришла"], ["cancelled", "Отменить"]],
  paid: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  confirmed: [["cooking", "Готовится"], ["cancelled", "Отменить"]],
  cooking: [["assembled", "Собран"], ["cancelled", "Отменить"]],
  assembled: [["handed_to_courier", "Передан курьеру"], ["awaiting_pickup", "Ждёт клиента"], ["cancelled", "Отменить"]],
  handed_to_courier: [["on_the_way", "В пути"], ["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  on_the_way: [["delivered", "Доставлен"], ["not_collected", "Не доставлено"]],
  awaiting_pickup: [["issued", "Выдан"], ["not_collected", "Не забрали"]],
};
const REASON = new Set(["rejected", "cancelled", "not_collected"]);
const PAYTO = new Set(["delivered", "issued"]);
const OPEN = new Set(Object.keys(NEXT));
// 0066 (ревизия): authFail - сервер не принял код точки (его сменили): опрос остановлен, иначе каждые 20 секунд
// «неверный код» держал бы общий замок входа собственника и водителя; lastOk/lastFail - когда список обновился и с
// какого времени нет связи; busy - идёт смена статуса или правка, кнопки выключены; recheck - статус «Выдан»/«Доставлен»
// ушёл, а ответ потерялся: после обновления списка выданный заказ отдаёт свой чек кассе на пробитие; pickup - точка
// выдачи заказов (кнопка «Стоп-лист»); bar - полоса «смена за ДД.ММ не закрыта» над вкладками кассы.
let R = null, C = null, timer = null, known = new Set(), first = true, sess = 0;
let authFail = false, lastOk = null, lastFail = null, busy = false, recheck = null, pickup = true, bar = null;

export function mountOrders(root, ctx) {
  R = root; C = ctx; first = true; known = new Set(); sess++;
  authFail = false; lastOk = null; lastFail = null; busy = false; recheck = null; pickup = true;
  clearInterval(timer); timer = setInterval(load, POLL);
  load();
}
export function stopOrders() {
  sess++; clearInterval(timer); timer = null;
  if (R) R.innerHTML = "";
  if (C) C.onCount(0);
  shiftBar(null);
}

function beep() {
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); o.frequency.value = 880;
    o.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 350); } catch {}
}
const hm = (d) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const noAccess = (r) => !!r && r.ok === false && r.error === "Нет доступа";

async function load() {
  if (!R || authFail) return;
  const s = sess;
  let r;
  try { r = await C.call("corder_list", {}); }
  catch { if (s === sess) { lastFail = lastFail || new Date(); drawStatus(); } return; }   // нет связи - следующий опрос
  if (s !== sess) return;                                          // вышли или перешли к другой точке
  if (noAccess(r)) { stopAuth(); return; }
  if (!r || !r.ok) { lastFail = lastFail || new Date(); drawStatus(); return; }
  lastOk = new Date(); lastFail = null; pickup = r.pickup !== false;
  shiftBar(r.open_shift || null);
  const fresh = r.orders.filter((o) => o.status === "new" && !known.has(o.id));
  if (!first && fresh.length) { beep(); toast(`Новый заказ: №${fresh.map((o) => o.no).join(", №")}`); }
  for (const o of r.orders) known.add(o.id);
  first = false;
  C.onCount(r.orders.filter((o) => o.status === "new").length);
  // Статус ушёл, а ответ потерялся: если заказ уже выдан, его чек (uid заказа) кассе нужно пробить в налоговой.
  if (recheck) {
    const x = r.orders.find((o) => o.id === recheck.id);
    if (x && x.status === recheck.to && C.onCheck) C.onCheck(recheck.uid, recheck.to);
    recheck = null;
  }
  draw(r.orders);
}

// Код точки не принят: опрос останавливается, продавец видит, что делать (как досылка чеков в js/kassa/app.js).
function stopAuth() {
  authFail = true; clearInterval(timer); timer = null;
  if (C) C.onCount(0);
  shiftBar(null);
  toast("Сервер не принял код точки: заказы не обновляются. Выйдите и войдите в кассу заново", "bad");
  if (!R) return;
  R.innerHTML = "";
  R.append(el("div", { class: "note" }, "Сервер не принял код точки - его могли сменить. Заказы больше не обновляются: выйдите из кассы и войдите заново с новым кодом."));
}

// Когда список обновлялся: без этого продавец не знает, что новых заказов не видно из-за связи.
function statusText() {
  if (lastFail) return "Нет связи с " + hm(lastFail) + (lastOk ? ": список от " + hm(lastOk) + ", новые заказы могут не показываться" : "");
  return lastOk ? "Обновлено в " + hm(lastOk) : "";
}
function drawStatus() {
  const s = R && R.querySelector(".ordstatus");
  if (s) { s.textContent = statusText(); s.className = "ordstatus " + (lastFail ? "pill bad" : "dim"); }
}

// Полоса «смена за ДД.ММ не закрыта» (0066): над всеми вкладками кассы, под полосой закрытой смены.
function shiftBar(day) {
  if (!day) { if (bar) bar.remove(); bar = null; return; }
  if (!bar || !bar.isConnected) {
    bar = el("div", { class: "closedbar", role: "alert" });
    const anchor = document.getElementById("closedbar");
    if (anchor) anchor.after(bar); else if (R && R.parentNode) R.parentNode.insertBefore(bar, R);
  }
  const d = String(day).split("-").reverse().join(".");
  bar.textContent = "";
  bar.append(el("span", {}, `Смена за ${d} не закрыта. Закройте её: «Смена» → «Закрыть смену», в отчёте выберите дату ${d}.`));
}

function draw(orders) {
  R.innerHTML = "";
  R.append(el("div", { class: "tools" },
    pickup ? el("button", { class: "ghost", onclick: stopList, disabled: busy }, "Стоп-лист") : null,
    el("button", { class: "ghost", onclick: load, disabled: busy }, "Обновить"),
    el("span", { class: "ordstatus dim", style: "align-self:center" }, statusText())));
  drawStatus();
  const groups = [["Новые", (o) => o.status === "new"], ["В работе", (o) => OPEN.has(o.status) && o.status !== "new"],
                  ["Закрытые", (o) => !OPEN.has(o.status)]];
  for (const [title, f] of groups) {
    const list = orders.filter(f);
    if (!list.length) continue;
    R.append(el("h3", {}, `${title} (${list.length})`), ...list.map(card));
  }
  if (!orders.length) R.append(el("div", { class: "dim" }, "Заказов нет"));
}

function card(o) {
  const lines = o.lines.map((l) => `${l.title} — ${fmt(l.qty)} ${l.unit}`).join(", ");
  const btns = (NEXT[o.status] || []).filter(([to]) => !(o.kind === "pickup" && (to === "handed_to_courier")) && !(o.kind === "delivery" && to === "awaiting_pickup"))
    .map(([to, title]) => el("button", { class: to === "rejected" || to === "cancelled" || to === "not_collected" ? "ghost" : "", disabled: busy, onclick: () => move(o, to) }, title));
  if (["new", "awaiting_prepay", "paid", "confirmed"].includes(o.status)) btns.push(el("button", { class: "link", disabled: busy, onclick: () => editOrder(o) }, "Править"));
  return el("div", { class: "card" + (o.status === "new" ? " hot" : "") },
    el("div", { style: "font-weight:700" }, `№${o.no} · ${o.for_date.split("-").reverse().join(".")} к ${o.ready_by} · ${fmt(o.total)} ₸ · ${o.status_name}`),
    el("div", {}, o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз`, " · ", o.client_name || "", " ",
      el("a", { href: "tel:+" + o.client_phone }, "+" + o.client_phone)),
    el("div", { class: "dim" }, lines),
    o.prepay_suggested && o.status === "new" ? el("div", { class: "pill bad" }, "по правилу нужна предоплата") : null,
    o.courier ? el("div", { class: "dim" }, "Курьер: " + o.courier) : null,
    o.reason ? el("div", { class: "dim" }, "Причина: " + o.reason) : null,
    el("div", { class: "actions" }, ...btns));
}

// Пока идёт смена статуса или правка, кнопки заказов выключены: второе нажатие не уходит вторым запросом (0066).
function setBusy(on) {
  busy = on;
  if (R) for (const b of R.querySelectorAll(".actions button, .tools button")) b.disabled = on;
}

async function move(o, to) {
  if (busy) return;
  const p = { id: o.id, to };
  if (REASON.has(to)) { const v = window.prompt("Причина (её увидит клиент при отказе или отмене):", ""); if (!v || !v.trim()) return; p.reason = v.trim(); }
  if (to === "handed_to_courier") { const v = window.prompt("Кто везёт? (имя курьера)", ""); if (!v || !v.trim()) return; p.courier = v.trim(); }
  if (PAYTO.has(to)) { const v = await payDialog(o); if (!v) return; p.pay_kind = v; }
  if (busy) return;
  setBusy(true);
  let r;
  try { r = await C.call("corder_status", { ...p, seller: C.seller() }); }
  catch (e) {
    // Запрос мог дойти: статус и чек заказа уже могли записаться. Проверяем по списку (выданный - пробиваем его чек).
    setBusy(false);
    if (PAYTO.has(to)) recheck = { id: o.id, uid: o.uid, to };
    toast("Нет связи - неизвестно, изменился ли статус. Проверьте заказ в списке", "bad"); load(); return;
  }
  setBusy(false);
  if (noAccess(r)) { stopAuth(); return; }
  if (!r.ok) { toast(r.message || r.error || "Не получилось - повторите", "bad"); load(); return; }
  toast(`№${o.no}: ${r.order.status_name}`); load();
  // 0053: чек заказа (uid заказа) создал сервер - касса пробивает его в налоговой, как свой
  if (PAYTO.has(to) && C.onCheck) C.onCheck(o.uid, to);
}

function payDialog(o) {
  return new Promise((done) => {
    const ov = el("div", { class: "overlay" });
    const box = el("div", { class: "card" }, el("h3", {}, `№${o.no}: ${fmt(o.total)} ₸ — чем оплатили?`),
      ...Object.entries(PAY).map(([k, t]) => el("button", { onclick: () => { ov.remove(); done(k); } }, t)),
      el("button", { class: "ghost", onclick: () => { ov.remove(); done(null); } }, "Назад"));
    ov.append(box); document.body.append(ov);
  });
}

// Что изменилось в окне правки (0066): на сервер уходят только изменённые поля - правка адреса не гоняет заказ через
// проверки нового заказа, а прежние строки сохраняют цену, по которой заказ приняли. Пустое или 0 - строку убрать;
// не число - ошибка (раньше такая строка молча пропадала из заказа).
export function editChanges(o, v) {
  const out = {}, lines = [];
  for (const l of o.lines) {
    const raw = String(v.qty[l.item_code] ?? "").replace(/\s/g, "").replace(",", ".");
    if (raw === "" || Number(raw) === 0) continue;
    if (!/^\d+(\.\d+)?$/.test(raw)) return { error: "Количество «" + l.title + "» - число" };
    lines.push({ item_code: l.item_code, qty: raw });
  }
  const was = new Map(o.lines.map((l) => [l.item_code, Number(l.qty)]));
  if (lines.length !== o.lines.length || lines.some((l) => Math.abs(Number(l.qty) - was.get(l.item_code)) > 1e-9)) out.lines = lines;
  if (v.date && v.date !== o.for_date) out.for_date = v.date;
  if (v.time && v.time !== o.ready_by) out.ready_by = v.time;
  if (o.kind === "delivery" && String(v.address || "").trim() !== String(o.address || "").trim()) out.address = String(v.address || "").trim();
  return out;
}

async function editOrder(o) {
  if (busy) return;
  const ov = el("div", { class: "overlay" });
  const qty = new Map();
  const date = el("input", { type: "date", value: o.for_date });
  const time = el("input", { type: "time", value: o.ready_by });
  const addr = el("input", { value: o.address || "", placeholder: "Адрес" });
  const rows = o.lines.map((l) => { const i = el("input", { inputmode: "decimal", value: String(l.qty).replace(".", ","), style: "width:80px" }); qty.set(l.item_code, i);
    return el("div", {}, l.title, " ", i, " ", l.unit); });
  const save = el("button", { onclick: async () => {
    const ch = editChanges(o, { qty: Object.fromEntries([...qty].map(([k, i]) => [k, i.value])), date: date.value, time: time.value, address: addr.value });
    if (ch.error) { toast(ch.error, "bad"); return; }
    if (!Object.keys(ch).length) { ov.remove(); toast("Ничего не изменилось"); return; }
    save.disabled = true;
    let r; try { r = await C.call("corder_edit", { id: o.id, seller: C.seller(), ...ch }); }
    catch { save.disabled = false; toast("Нет связи - неизвестно, сохранилась ли правка. Проверьте заказ в списке", "bad"); load(); return; }
    save.disabled = false;
    if (noAccess(r)) { ov.remove(); stopAuth(); return; }
    if (!r.ok) { toast(r.message || r.error || "Не получилось - повторите", "bad"); return; }
    ov.remove(); toast(`№${o.no}: сумма ${fmt(r.order.total)} ₸`); load(); } }, "Сохранить");
  const box = el("div", { class: "card" }, el("h3", {}, `Правка №${o.no}`), ...rows, el("div", {}, "Дата ", date, " к ", time),
    o.kind === "delivery" ? addr : null,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => ov.remove() }, "Отмена"), save));
  ov.append(box); document.body.append(ov);
}

async function stopList() {
  let r; try { r = await C.call("cmenu_point_list", {}); } catch { toast("Нет связи", "bad"); return; }
  if (noAccess(r)) { stopAuth(); return; }
  if (!r.ok) { toast(r.message || "Не получилось — повторите", "bad"); return; }
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const ov = el("div", { class: "overlay" });
  const box = el("div", { class: "card" }, el("h3", {}, "Сегодня нет (бот перестанет предлагать)"),
    ...r.rows.map((x) => el("label", {}, el("input", { type: "checkbox", checked: x.stopped, onchange: async (e) => {
      let s; try { s = await C.call("cmenu_stop", { item_code: x.item_code, until: e.target.checked ? today : "" }); } catch { s = null; }
      if (!s || !s.ok) { e.target.checked = !e.target.checked; toast((s && s.message) || (s ? "Не получилось — повторите" : "Нет связи"), "bad"); } } }), " ", x.title_ru)),
    el("button", { onclick: () => ov.remove() }, "Готово"));
  ov.append(box); document.body.append(ov);
}
