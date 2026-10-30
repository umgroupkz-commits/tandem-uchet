// Вкладка «Заказы» кассы (0050): заказы клиентов из WhatsApp-бота. Новый заказ продавец подтверждает
// здесь или в Telegram — кто первым; дальше ведёт статусы до выдачи. «Выдан»/«Доставлен» пробивает чек
// на сервере (uid заказа), очередь чеков планшета не участвует.
import { el, fmt, toast } from "../office/ui.js?v=26";

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
let R = null, C = null, timer = null, known = new Set(), first = true, sess = 0;

export function mountOrders(root, ctx) {
  R = root; C = ctx; first = true; known = new Set(); sess++;
  clearInterval(timer); timer = setInterval(load, POLL);
  load();
}
export function stopOrders() {
  sess++; clearInterval(timer); timer = null;
  if (R) R.innerHTML = "";
  if (C) C.onCount(0);
}

function beep() {
  try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); o.frequency.value = 880;
    o.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 350); } catch {}
}

async function load() {
  if (!R) return;
  const s = sess;
  let r;
  try { r = await C.call("corder_list", {}); } catch { return; }   // нет связи — следующий опрос
  if (s !== sess) return;                                          // вышли или перешли к другой точке
  if (!r || !r.ok) return;
  const fresh = r.orders.filter((o) => o.status === "new" && !known.has(o.id));
  if (!first && fresh.length) { beep(); toast(`Новый заказ: №${fresh.map((o) => o.no).join(", №")}`); }
  for (const o of r.orders) known.add(o.id);
  first = false;
  C.onCount(r.orders.filter((o) => o.status === "new").length);
  draw(r.orders);
}

function draw(orders) {
  R.innerHTML = "";
  R.append(el("div", { class: "tools" }, el("button", { class: "ghost", onclick: stopList }, "Стоп-лист"), el("button", { class: "ghost", onclick: load }, "Обновить")));
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
    .map(([to, title]) => el("button", { class: to === "rejected" || to === "cancelled" || to === "not_collected" ? "ghost" : "", onclick: () => move(o, to) }, title));
  if (["new", "awaiting_prepay", "paid", "confirmed"].includes(o.status)) btns.push(el("button", { class: "link", onclick: () => editOrder(o) }, "Править"));
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

async function move(o, to) {
  const p = { id: o.id, to };
  if (REASON.has(to)) { const v = window.prompt("Причина (её увидит клиент при отказе или отмене):", ""); if (!v || !v.trim()) return; p.reason = v.trim(); }
  if (to === "handed_to_courier") { const v = window.prompt("Кто везёт? (имя курьера)", ""); if (!v || !v.trim()) return; p.courier = v.trim(); }
  if (PAYTO.has(to)) { const v = await payDialog(o); if (!v) return; p.pay_kind = v; }
  let r;
  try { r = await C.call("corder_status", { ...p, seller: C.seller() }); } catch (e) { toast("Нет связи — статус не изменён", "bad"); return; }
  if (!r.ok) { toast(r.message || "Не получилось — повторите", "bad"); load(); return; }
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

async function editOrder(o) {
  const ov = el("div", { class: "overlay" });
  const qty = new Map();
  const date = el("input", { type: "date", value: o.for_date });
  const time = el("input", { type: "time", value: o.ready_by });
  const addr = el("input", { value: o.address || "", placeholder: "Адрес" });
  const rows = o.lines.map((l) => { const i = el("input", { inputmode: "decimal", value: String(l.qty).replace(".", ","), style: "width:80px" }); qty.set(l.item_code, i);
    return el("div", {}, l.title, " ", i, " ", l.unit); });
  const box = el("div", { class: "card" }, el("h3", {}, `Правка №${o.no}`), ...rows, el("div", {}, "Дата ", date, " к ", time),
    o.kind === "delivery" ? addr : null,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => ov.remove() }, "Отмена"),
      el("button", { onclick: async () => {
        const lines = [...qty].map(([item_code, i]) => ({ item_code, qty: String(i.value).replace(",", ".").trim() })).filter((l) => Number(l.qty) > 0);
        const p = { id: o.id, lines, for_date: date.value, ready_by: time.value, seller: C.seller() };
        if (o.kind === "delivery") p.address = addr.value.trim();
        let r; try { r = await C.call("corder_edit", p); } catch { toast("Нет связи — правка не сохранена", "bad"); return; }
        if (!r.ok) { toast(r.message || "Не получилось — повторите", "bad"); return; }
        ov.remove(); toast(`№${o.no}: сумма ${fmt(r.order.total)} ₸`); load(); } }, "Сохранить")));
  ov.append(box); document.body.append(ov);
}

async function stopList() {
  let r; try { r = await C.call("cmenu_point_list", {}); } catch { toast("Нет связи", "bad"); return; }
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
