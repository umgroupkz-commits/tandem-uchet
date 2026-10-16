// Раздел «Заказы клиентов» (0049–0051): меню заказов для бота со своей ценой и отметкой «цена сверена»,
// список заказов с журналом, настройки окон готовности и доставки. Права — раздел clients.
import { api, can, session } from "./api.js?v=22";
import { el, toast, errText, modal, today } from "./ui.js?v=22";
import { itemPicker, fmtDate, fmtMoney } from "./inputs.js?v=22";

const UNITS = ["кг", "шт", "сет"];
const READY = { fresh: "печём под заказ", stock: "с витрины" };
const SETTINGS = [
  ["client_hours_from", "Приём заказов с"], ["client_hours_to", "до"],
  ["client_fresh_cutoff", "Свежие пироги на сегодня — заказ до"], ["client_fresh_ready", "готовность к"],
  ["stock_ready_minutes", "С витрины — через, мин"], ["client_min_order", "Доставка от, ₸"],
  ["client_max_days_ahead", "Заказ вперёд, дней"], ["client_pickup_points", "Точки выдачи (коды через запятую)"],
  ["client_prepay_rule", "Предоплата: off / fresh / from_sum:N"], ["client_confirm_remind_min", "Напомнить продавцу через, мин"],
  ["client_confirm_client_notice_min", "Написать клиенту «скоро ответим» через, мин"],
  ["couriers", "Курьеры (через запятую)"], ["kaspi_details_ru", "Реквизиты Kaspi (рус.)"], ["kaspi_details_kz", "Реквизиты Kaspi (каз.)"],
];
const TABS = [["menu", "Меню заказов"], ["orders", "Заказы"], ["settings", "Настройки"]];
let root, body, tabsBar, tab = "menu";
// Номер последней отрисовки: ответ на устаревший запрос не рисуется поверх нового.
let seq = 0;
const ord = { from: today(), to: today(), status: "" };

// Настройки на сервере правят только собственник и администратор (право раздела clients:edit есть и у технолога).
const canSettings = () => { const s = session(); return can("clients", "edit") && !!s && !!s.user && ["owner", "admin"].includes(s.user.role); };

// Активная вкладка — без класса ghost (так же сделаны вкладки склада; по этому классу экран узнаёт кнопка «Замечание»).
function markTabs() {
  if (!tabsBar) return;
  for (const b of tabsBar.children) b.classList.toggle("ghost", b.dataset.id !== tab);
}

export function setTab(name) {
  if (!TABS.some(([id]) => id === name)) return;
  tab = name; markTabs();
  if (body) draw();
}

export async function mount(r) {
  root = r;
  tabsBar = el("div", { class: "tabs" },
    ...TABS.map(([id, title]) => el("button", { "data-id": id, class: tab === id ? "" : "ghost", onclick: () => setTab(id) }, title)));
  body = el("div");
  root.append(tabsBar, body);
  await draw();
}

async function draw() {
  const n = ++seq;
  body.innerHTML = '<div class="dim">Загрузка…</div>';
  if (tab === "orders") return drawOrders(n);
  const r = await api("cmenu_list", {});
  if (n !== seq) return;
  body.innerHTML = "";
  if (!r.ok) { body.append(el("div", { class: "err" }, errText(r))); return; }
  if (tab === "settings") return drawSettings(r.settings || {});
  drawMenu(r.rows);
}

function drawMenu(rows) {
  const edit = can("clients", "edit");
  const unchecked = rows.filter((x) => x.active && !x.checked).length;
  body.append(el("div", { class: "tools" },
    edit ? el("button", { onclick: () => editRow(null) }, "+ Позиция в меню") : null,
    el("span", { class: unchecked ? "tag bad" : "dim" }, unchecked ? `Цена не сверена: ${unchecked} — бот их не видит` : "Все цены сверены")));
  const t = el("table");
  t.append(el("tr", {}, ...["Раздел", "Для клиента", "Ед.", "Цена заказа", "Цена кассы", "Готовность", "Цена", "Стоп", ""].map((h) => el("th", {}, h))));
  for (const x of rows) {
    const diff = x.kassa_price != null && Number(x.kassa_price) !== Number(x.price);
    t.append(el("tr", { class: x.active ? "" : "dim" },
      el("td", {}, x.section), el("td", {}, x.title_ru, x.title_kz ? el("div", { class: "dim" }, x.title_kz) : null),
      el("td", {}, x.unit_label), el("td", { class: "num" }, fmtMoney(x.price)),
      el("td", { class: "num" + (diff ? " bad" : ""), title: diff ? "Цена кассы отличается" : "" }, x.kassa_price == null ? "—" : fmtMoney(x.kassa_price)),
      el("td", {}, READY[x.ready_kind]),
      // сверяют ту цену, что человек видит в строке: если её успели сменить, сервер ответит conflict
      el("td", {}, x.checked ? el("span", { class: "tag ok", title: x.price_checked_by || "" }, "сверена")
        : edit ? el("button", { class: "ghost small", onclick: () => act("cmenu_check", { item_code: x.item_code, price: x.price }, "Цена отмечена сверенной") }, "Сверить") : el("span", { class: "tag bad" }, "не сверена")),
      el("td", {}, x.stopped ? el("span", { class: "tag bad" }, "до " + fmtDate(x.stop_until)) : "",
        edit ? el("button", { class: "link", onclick: () => act("cmenu_stop", { item_code: x.item_code, until: x.stopped ? "" : today() }, x.stopped ? "Стоп снят" : "Сегодня нет") }, x.stopped ? "снять" : "сегодня нет") : null),
      el("td", {}, edit ? el("button", { class: "link", onclick: () => editRow(x) }, "править") : null)));
  }
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "Меню пусто: добавьте позиции из закреплённых постов Instagram")));
  body.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

async function act(action, payload, ok) {
  const r = await api(action, payload);
  if (!r.ok) { toast(errText(r), "bad"); if (r.error === "conflict") draw(); return; }
  toast(ok); draw();
}

function editRow(x) {
  const m = modal(x ? "Позиция меню заказов" : "Новая позиция меню заказов", { keep: true });
  const f = {};
  let picked = null;
  const pickedName = el("div", { class: "dim" }, "Позиция не выбрана");
  // itemPicker сам выбранное не хранит: отдаёт позицию в onPick и очищает своё поле — запоминаем здесь.
  const pick = x ? null : itemPicker({
    placeholder: "Позиция учёта (в продаже): название или код",
    exclude: (it) => it.for_sale === false,   // в меню заказов — только то, что продаётся (сервер проверяет так же)
    onPick: (it) => {
      picked = it;
      pickedName.textContent = "Выбрано: " + it.name + (it.artikul ? " · код " + it.artikul : "");
      if (f.title_ru && !f.title_ru.value.trim()) f.title_ru.value = it.name;
    },
  });
  const inp = (k, v, attrs = {}) => (f[k] = el("input", { value: v ?? "", ...attrs }));
  const sel = (k, opts, v) => (f[k] = el("select", {}, ...opts.map(([val, t]) => el("option", { value: val, selected: val === v }, t))));
  const err = el("div", { class: "err" });
  m.root.append(
    x ? el("div", { class: "dim" }, "Позиция учёта: " + x.item_name) : el("div", {}, el("label", {}, "Позиция учёта"), pick.root, pickedName),
    el("label", {}, "Название для клиента", inp("title_ru", x && x.title_ru)),
    el("label", {}, "Название по-казахски", inp("title_kz", x && x.title_kz)),
    el("label", {}, "Состав", inp("composition_ru", x && x.composition_ru)),
    el("label", {}, "Состав по-казахски", inp("composition_kz", x && x.composition_kz)),
    el("label", {}, "Раздел", inp("section", (x && x.section) || "Выпечка")),
    el("label", {}, "Единица", sel("unit_label", UNITS.map((u) => [u, u]), (x && x.unit_label) || "шт")),
    el("label", {}, "Цена для заказов, ₸", inp("price", x && x.price, { inputmode: "decimal" })),
    x ? el("div", { class: "dim" }, "Цена кассы Енешки: " + (x.kassa_price == null ? "—" : fmtMoney(x.kassa_price)) + ". Смена цены снимает отметку «сверена».") : null,
    el("label", {}, "Минимум", inp("min_qty", (x && x.min_qty) || 1, { inputmode: "decimal" })),
    el("label", {}, "Шаг", inp("step", (x && x.step) || 1, { inputmode: "decimal" })),
    el("label", {}, "Готовность", sel("ready_kind", Object.entries(READY), (x && x.ready_kind) || "stock")),
    el("label", {}, "Порядок", inp("sort_order", (x && x.sort_order) || 0, { inputmode: "numeric" })),
    el("label", {}, (f.active = el("input", { type: "checkbox", checked: x ? x.active : true })), " в меню"),
    err,
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => m.cancel() }, "Отмена"),
      el("button", { onclick: async (e) => {
        const code = x ? x.item_code : picked && picked.code;
        if (!code) { err.textContent = "Выберите позицию учёта из списка"; return; }
        err.textContent = "";
        const payload = { item_code: code, active: f.active.checked };
        for (const k of Object.keys(f)) if (k !== "active") payload[k] = String(f[k].value).replace(",", ".").trim();
        e.target.disabled = true;
        const r = await api("cmenu_save", payload);
        e.target.disabled = false;
        if (!r.ok) { err.textContent = errText(r); return; }
        m.close(); toast(r.row.checked ? "Сохранено" : "Сохранено. Цену нужно сверить — до этого бот позицию не видит"); draw(); } }, "Сохранить")));
}

function drawSettings(s) {
  const edit = canSettings();
  const f = {};
  const card = el("div", { class: "card" });
  for (const [k, title] of SETTINGS) card.append(el("label", {}, title, (f[k] = el("input", { value: s[k] ?? "", disabled: !edit }))));
  if (edit) card.append(el("div", { class: "actions" }, el("button", { onclick: async (e) => {
    const values = {}; for (const [k] of SETTINGS) if (String(f[k].value).trim() !== String(s[k] ?? "")) values[k] = f[k].value.trim();
    if (!Object.keys(values).length) { toast("Ничего не изменилось"); return; }
    e.target.disabled = true; const r = await api("client_settings_save", { values }); e.target.disabled = false;
    if (!r.ok) { toast(errText(r), "bad"); return; } toast("Настройки сохранены"); draw(); } }, "Сохранить")));
  body.append(el("div", { class: "dim", style: "margin-bottom:8px" }, "Правила, по которым бот принимает заказы. Меняют собственник и администратор."), card);
}

async function drawOrders(n) {
  const r = await api("corder_list", { date_from: ord.from, date_to: ord.to, status: ord.status });
  if (n !== seq) return;
  body.innerHTML = "";
  const from = el("input", { type: "date", value: ord.from, onchange: (e) => { if (e.target.value) { ord.from = e.target.value; draw(); } } });
  const to = el("input", { type: "date", value: ord.to, onchange: (e) => { if (e.target.value) { ord.to = e.target.value; draw(); } } });
  body.append(el("div", { class: "tools" }, el("span", {}, "Дата заказа с"), from, el("span", {}, "по"), to));
  if (!r.ok) { body.append(el("div", { class: "err" }, errText(r))); return; }
  const t = el("table");
  t.append(el("tr", {}, ...["№", "Дата, к часу", "Клиент", "Получение", "Сумма", "Статус", "Подтвердил"].map((h) => el("th", {}, h))));
  for (const o of r.orders) t.append(el("tr", { class: "row", style: "cursor:pointer", onclick: () => openOrder(o.id) },
    el("td", {}, `${o.no} от ${fmtDate(o.no_date)}`), el("td", {}, `${fmtDate(o.for_date)} ${o.ready_by}`),
    el("td", {}, o.client_name || "—", el("div", { class: "dim" }, "+" + o.client_phone)),
    el("td", {}, o.kind === "delivery" ? "доставка: " + (o.address || "") : "самовывоз: " + o.point_name),
    el("td", { class: "num" }, fmtMoney(o.total)), el("td", {}, o.status_name), el("td", {}, o.confirmed_by || "")));
  if (!r.orders.length) t.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "Заказов нет")));
  body.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

async function openOrder(id) {
  const r = await api("corder_get", { id });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const o = r.order, m = modal(`Заказ №${o.no} от ${fmtDate(o.no_date)}`);
  m.root.append(
    el("div", {}, `${o.client_name || "—"}, +${o.client_phone}, язык: ${o.lang === "kz" ? "казахский" : "русский"}`),
    el("div", {}, o.kind === "delivery" ? `Доставка: ${o.address}` : `Самовывоз: ${o.point_name}`, ` · ${fmtDate(o.for_date)} к ${o.ready_by}`),
    el("table", {}, ...o.lines.map((l) => el("tr", {}, el("td", {}, l.title), el("td", { class: "num" }, `${l.qty} ${l.unit}`), el("td", { class: "num" }, fmtMoney(l.sum))))),
    el("div", { style: "font-weight:700" }, "Итого: " + fmtMoney(o.total)),
    el("h3", {}, "Журнал"),
    ...r.events.map((e) => el("div", { class: "dim" }, `${new Date(e.at).toLocaleString("ru-RU")} — ${e.payload && e.payload.edited ? "правка" : e.status_name} — ${e.by_name}`,
      e.payload && e.payload.reason ? ` (${e.payload.reason})` : "")),
    el("div", { class: "actions" }, el("button", { class: "ghost", onclick: () => m.close() }, "Закрыть")));
}
