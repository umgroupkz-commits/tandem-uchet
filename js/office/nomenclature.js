import { api, can } from "./api.js?v=22";
import { el, fmt, toast, debounce, modal, confirmDlg, errText, saveFailed } from "./ui.js?v=22";
import { loadXlsx } from "./stock.js?v=22";
import { numInput, parseNum, fmtDate, fmtMoney } from "./inputs.js?v=22";
// hooks.editDoc ставит stock.js при загрузке (он уже импортирован выше ради loadXlsx): ссылка на приход
// из карточки открывает тот же документ, что и журнал склада.
import { hooks, stores, setStores } from "./stock-common.js?v=22";

const TYPES = { goods: "товар", dish: "блюдо", prepared: "полуфабрикат", service: "услуга" };
let groups = [], state = { q: "", group_id: "", item_type: "", active: "true", page: 1 };
// Список групп загрузился. Без него (сбой, истёкшая сессия при открытии раздела) карточка не
// даёт менять группу: иначе «— без группы —» в селекте уходило бы на сервер и стирало группу.
let groupsOk = false;
// Неудачное перечитывание не затирает уже загруженный список (дерево не пустеет после обрыва).
async function loadGroups() { const g = await api("groups_list", {}); if (g.ok) { groups = g.groups || []; groupsOk = true; } }
let tree, table, pager, root;
// Номер последнего запроса списка: ответ на устаревший поиск не рисуется поверх нового.
let listSeq = 0;

export async function mount(r) {
  root = r;
  await loadGroups();
  tree = el("div", { class: "card tree" });
  const tools = el("div", { class: "tools" },
    el("input", { placeholder: "Поиск: название, код iiko, код", value: state.q,
      oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
    select({ "": "все типы", ...TYPES }, state.item_type, (v) => { state.item_type = v; state.page = 1; load(); }),
    select({ "true": "активные", "false": "выключенные", "": "все" }, state.active, (v) => { state.active = v; state.page = 1; load(); }),
    can("nomenclature", "edit") ? el("button", { onclick: () => editItem(null) }, "+ Позиция") : null,
    can("nomenclature", "edit") ? el("button", { class: "ghost", onclick: importPrices }, "Загрузить прейскурант") : null,
  );
  table = el("table");
  pager = el("div", { class: "pager" });
  root.append(el("div", { class: "split" }, tree, el("div", {}, tools, el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager)));
  drawTree();
  await load();
}

function select(opts, value, onchange, disabled = false) {
  const s = el("select", { disabled, onchange: (e) => onchange(e.target.value) });
  for (const [v, t] of Object.entries(opts)) s.append(el("option", { value: v, selected: v === value }, t));
  return s;
}

function drawTree() {
  tree.innerHTML = "";
  tree.append(el("h2", {}, "Группы"),
    el("button", { class: state.group_id === "" ? "on" : "", onclick: () => pick("") }, "Все позиции"));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const shownParent = (g) => { const p = g.parent_id ? byId.get(g.parent_id) : null; return p && p.active ? p.id : null; };
  const kids = (pid) => groups.filter((g) => g.active && shownParent(g) === pid).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  const walk = (pid, depth) => {
    for (const g of kids(pid)) {
      tree.append(el("button", { class: state.group_id === g.id ? "on" : "", style: `padding-left:${8 + depth * 14}px`, onclick: () => pick(g.id) },
        g.name, el("i", {}, g.items_count)));
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  // append(null) вывел бы текст «null» под кнопкой — вторая кнопка только при выбранной группе
  if (can("nomenclature", "edit")) tree.append(...[el("button", { class: "link", onclick: () => editGroup(null) }, "+ Группа"),
    state.group_id ? el("button", { class: "link", onclick: () => editGroup(groups.find((g) => g.id === state.group_id)) }, "Переименовать / переместить") : null].filter(Boolean));
}

function pick(id) { state.group_id = id; state.page = 1; drawTree(); load(); }

async function load() {
  const p = { q: state.q, group_id: state.group_id || null, item_type: state.item_type || null, page: state.page };
  if (state.active !== "") p.active = state.active === "true";
  const n = ++listSeq;
  const r = await api("items_search", p);
  if (n !== listSeq) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Код", "Название", "Код iiko", "Тип", "Ед.", "Группа", "Цена", ""].map((h, i) => el("th", { class: i === 6 ? "num" : "", title: i === 2 ? "Артикул позиции в iiko" : null }, h))));
  for (const it of r.rows) {
    table.append(el("tr", { class: "row" + (it.active ? "" : " off"), onclick: () => editItem(it.code) },
      el("td", {}, it.code), el("td", {}, it.name), el("td", {}, it.artikul || ""), el("td", {}, TYPES[it.item_type] || it.item_type),
      el("td", {}, it.unit_id || ""), el("td", { class: "dim" }, it.group_name || "—"), el("td", { class: "num" }, fmtMoney(it.price)),
      el("td", {}, it.for_sale ? el("span", { class: "tag ok" }, "продаётся") : null)));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 8, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

// Открыть карточку по ссылке #item/<код> (из вкладки «Готовность»).
export function openItem(code) { editItem(code); }
async function editItem(code) {
  let item = { item_type: "dish", unit_id: "шт", group_id: state.group_id || "", active: true, for_sale: false }, points = [], r = null;
  if (code) {
    r = await api("item_get", { code });
    if (!r.ok) { toast(errText(r), "bad"); return; }
    item = r.item; points = r.points;
  }
  // Список групп не загрузился при открытии раздела (сессия истекла, и вход был поверх страницы) или
  // группу позиции завели позже (другой пользователь, перенос из iiko) — перечитываем его, прежде
  // чем строить селект группы.
  if (!groupsOk || (item.group_id && !groups.some((g) => g.id === item.group_id))) { await loadGroups(); if (groupsOk) drawTree(); }
  const ro = !can("nomenclature", "edit");
  // Форма с вводом по фону не закрывается; «Отмена» при изменениях переспрашивает.
  const m = modal(code ? `Позиция ${code}` : "Новая позиция", { keep: !ro });
  const f = {};
  const field = (key, label, node) => { f[key] = node; return el("div", {}, el("label", {}, label), node); };
  // Группы позиции может не быть в загруженном списке: список не загрузился или группу завели
  // после открытия раздела (другой пользователь, перенос из iiko). Тогда селект выключен и
  // показывает текущую группу, а group_id на сервер не уходит — группа остаётся как была.
  const curGroup = item.group_id || "";
  const groupKnown = groupsOk && (!curGroup || groups.some((g) => g.id === curGroup));
  const groupSel = el("select", { disabled: ro || !groupKnown }, el("option", { value: "" }, "— без группы —"),
    ...groups.map((g) => el("option", { value: g.id, selected: g.id === curGroup }, g.name)),
    curGroup && !groups.some((g) => g.id === curGroup) ? el("option", { value: curGroup, selected: true }, item.group_name || "текущая группа") : null);
  // Цены и количества — текстовым полем с цифровой клавиатурой (numInput): запятая работает при
  // любом языке браузера, колёсико мыши не меняет число, щелчок выделяет значение целиком.
  const nIn = (v) => numInput({ value: v, readonly: ro, attrs: { style: "text-align:right" } });
  // Учётная цена есть только у товара: блюдо и полуфабрикат считаются по техкарте. Подпись
  // следует за выбранной единицей — раньше у новой позиции она оставалась «за шт» и после «кг».
  const costLabel = el("label", { title: "Цена последнего прихода (или введённая вручную). По ней считается себестоимость в техкартах. «Средняя» в остатках ниже — средняя цена остатка на складе." });
  const costBox = el("div", {}, costLabel);
  let origin = null;
  const syncCost = () => {
    costBox.hidden = f.item_type.value !== "goods";
    costLabel.textContent = "Учётная цена сырья (за " + (f.unit_id.value || "ед.") + ")";
    if (origin) origin.hidden = costBox.hidden;
  };
  m.root.append(el("div", { class: "grid2" },
    field("name", "Название", el("input", { value: item.name || "", readonly: ro })),
    field("artikul", "Код iiko (артикул)", el("input", { value: item.artikul || "", readonly: ro })),
    field("item_type", "Тип", select(TYPES, item.item_type, syncCost, ro)),
    field("unit_id", "Единица", select({ "шт": "шт", "кг": "кг", "л": "л", "порц": "порц" }, item.unit_id, syncCost, ro)),
    el("div", {}, el("label", {}, "Группа"), (f.group_id = groupSel),
      ro || groupKnown ? null : el("div", { class: "dim" }, groupsOk
        ? "Этой группы нет в списке — обновите страницу, чтобы сменить группу"
        : "Список групп не загрузился — обновите страницу, чтобы выбрать группу")),
    field("price", "Цена по умолчанию", nIn(item.price)),
    field("pack_factor", "Фасовка: множитель", nIn(item.pack_factor)),
    field("pack_unit", "Фасовка: единица", el("input", { value: item.pack_unit || "", readonly: ro })),
    field("pack_price", "Фасовка: цена", nIn(item.pack_price)),
    field("note", "Заметка", el("input", { value: item.note || "", readonly: ro })),
    costBox,
  ));
  costBox.append((f.cost_price = nIn(item.cost_price)));
  // Откуда учётная цена: «из прихода ПН-… от …, поставщик …» со ссылкой на документ и история цен
  // по последним приходам (сервер 0047: source_doc и price_history в item_get и item_cost_get). Цена
  // последнего прихода сразу меняет себестоимость всех карт — опечатку в накладной (2 800 вместо
  // 280) отсюда видно и можно открыть документ. Старый сервер — только «из прихода от <даты>».
  origin = el("div");
  m.root.append(origin);
  syncCost();
  // Сервер 0047 отдаёт source_doc/price_history сразу в item_get; если их там нет — спрашиваем item_cost_get.
  if (code && item.item_type === "goods") {
    const c = r && "price_history" in r ? r : await api("item_cost_get", { code });
    drawOrigin(origin, item, c.ok ? c : null);
  }
  f.active = el("input", { type: "checkbox", checked: item.active, disabled: ro });
  f.for_sale = el("input", { type: "checkbox", checked: item.for_sale, disabled: ro });
  m.root.append(el("div", { class: "actions" }, el("label", {}, f.active, " активна"), el("label", {}, f.for_sale, " продаётся на точках")));
  if (code) {
    const pt = el("table");
    pt.append(el("tr", {}, el("th", {}, "Точка"), el("th", { class: "num" }, "Цена точки"),
      el("th", { title: SHORT_HINT }, "Короткий лист"), el("th", { class: "num", title: RANK_HINT }, "Ранг")));
    const priceInputs = {};
    for (const p of points) {
      priceInputs[p.point_id] = nIn(p.price);
      pt.append(el("tr", {}, el("td", {}, p.point_name), el("td", { class: "num" }, priceInputs[p.point_id]),
        el("td", {}, p.short ? el("span", { class: "tag" }, "да") : ""), el("td", { class: "num" }, p.rank ?? "")));
    }
    // Подсказки и под таблицей: на планшете всплывающих подсказок не видно.
    m.root.append(el("h2", { style: "margin-top:16px" }, "Цены по точкам"), pt,
      el("div", { class: "dim", style: "margin-top:6px" }, "Короткий лист — " + lc(SHORT_HINT) + " Ранг — " + lc(RANK_HINT)));
    f._prices = priceInputs;
  }
  if (code && (item.item_type === "dish" || item.item_type === "prepared")) {
    // Названия вместо кодов: сервер 0047 отдаёт missing_names; старый — только коды.
    // Позиция без своей карты попадает в missing сама — это «нет техкарты», а не «нет цены у 90003».
    const noChart = (r.missing || []).includes(code);
    const miss = Array.isArray(r.missing_names) && r.missing_names.length ? r.missing_names : (r.missing || []);
    // Сервер 0047 сам складывает фразу (missing_text: «нет цены у: …; нет техкарты у «…»»).
    const costText = r.cost != null ? `${fmtMoney(r.cost)} ₸ за ${item.unit_id}` : r.missing_text ? "не посчитана — " + r.missing_text
      : noChart ? "не посчитана — у позиции нет техкарты"
      : (miss.length ? `не посчитана — нет цены у: ${miss.slice(0, 5).join(", ")}${miss.length > 5 ? "…" : ""}` : "не посчитана");
    m.root.append(el("div", { class: "tot" }, el("span", {}, "Себестоимость на сегодня"), el("span", {}, costText)),
      el("div", { style: "margin-top:8px" }, el("a", { class: "link", href: "#charts/" + encodeURIComponent(code), onclick: (e) => { e.preventDefault(); m.close(); location.hash = "#charts/" + encodeURIComponent(code); location.reload(); } }, "Открыть техкарту →")));
  }
  if (code) {
    const st = await api("item_stock", { code });
    if (st.ok && (st.balances.length || st.moves.length)) {
      const bt = el("table"); bt.append(el("tr", {}, el("th", {}, "Склад"), el("th", { class: "num" }, "Остаток"),
        el("th", { class: "num", title: "Средняя цена остатка на этом складе. Себестоимость в техкартах считается по учётной цене — цене последнего прихода." }, "Средняя")));
      for (const b of st.balances) bt.append(el("tr", {}, el("td", {}, b.store_name), el("td", { class: "num" + (Number(b.qty) < 0 ? " bad" : "") }, fmt(b.qty)), el("td", { class: "num" }, fmtMoney(b.avg_cost))));
      const mt = el("table"); mt.append(el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Документ"), el("th", {}, "Склад"), el("th", { class: "num" }, "Кол-во")));
      // Строка без количества — переоценка: приход на ушедший в минус остаток поправил его стоимость.
      for (const mv of st.moves.slice(0, 10)) mt.append(el("tr", {}, el("td", {}, fmtDate(mv.move_date)), el("td", {}, mv.number), el("td", { class: "dim" }, mv.store_name),
        Number(mv.qty) === 0 ? el("td", { class: "num dim" }, "переоценка" + (mv.adj != null ? " " + fmtMoney(mv.adj) + " ₸" : ""))
          : el("td", { class: "num" + (Number(mv.qty) < 0 ? " bad" : "") }, fmt(mv.qty))));
      m.root.append(el("h2", { style: "margin-top:16px" }, "Остатки по складам"), bt, el("h2", { style: "margin-top:12px" }, "Последние движения"), mt);
    }
  }
  const err = el("div", { class: "err" });
  m.root.append(err, el("div", { class: "actions" },
    ro ? null : el("button", { onclick: save }, "Сохранить"),
    el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена")));
  async function save(e) {
    // Учётная цена уходит, только если её правили: сервер на любую присланную цену ставит
    // источник «вручную» и сегодняшнюю дату, и цена из накладной теряла бы своё происхождение.
    // Группа — так же, только если её сменили: сервер применяет присланный group_id (пустой снимает
    // группу и category, и позиция пропадает с точек), а селект мог не знать текущей группы.
    // Артикул уходит всегда, пустым тоже: очистка артикула — тоже правка.
    // Числа набраны как у людей («1 250,5») — сервер ждёт число: разбираем здесь, пустое уходит "" (снимает).
    err.textContent = "";
    const n = {}, bad = [];
    for (const [k, label] of [["price", "Цена по умолчанию"], ["pack_factor", "Фасовка: множитель"], ["pack_price", "Фасовка: цена"], ["cost_price", "Учётная цена"]]) {
      if (k === "cost_price" && costBox.hidden) continue;
      const v = parseNum(f[k].value);
      if (Number.isNaN(v)) bad.push(label); else n[k] = v == null ? "" : v;
    }
    const prices = f._prices ? Object.entries(f._prices).map(([point_id, inp]) => ({ point_id, price: parseNum(inp.value),
      name: (points.find((x) => x.point_id === point_id) || {}).point_name })) : [];
    for (const x of prices) if (Number.isNaN(x.price)) bad.push("цена точки «" + x.name + "»");
    if (bad.length) { err.textContent = "Не число: " + bad.join(", ") + ". Пишите цифры, копейки — через запятую."; return; }
    // Учётная цена скрыта у блюда и полуфабриката — тогда она не уходит вовсе.
    const costChanged = !costBox.hidden && n.cost_price !== (item.cost_price == null ? "" : Number(item.cost_price));
    const groupChanged = !code || (!f.group_id.disabled && f.group_id.value !== curGroup);
    const p = { code: code || undefined, name: f.name.value, artikul: f.artikul.value, item_type: f.item_type.value, unit_id: f.unit_id.value,
      group_id: groupChanged ? f.group_id.value || null : undefined, price: n.price, pack_factor: n.pack_factor, pack_unit: f.pack_unit.value,
      pack_price: n.pack_price, note: f.note.value, cost_price: costChanged ? n.cost_price : undefined,
      active: f.active.checked, for_sale: f.for_sale.checked };
    // Кнопка выключена до ответа: второе нажатие новой позиции заводило дубль с другим кодом.
    const b = e.target; b.disabled = true;
    const r = await api("item_save", p);
    // Новая позиция после обрыва связи: повтор «Сохранить» завёл бы вторую с другим кодом.
    if (!r.ok) { if (saveFailed(r, !code, b, err)) load(); return; }
    if (f._prices) {
      const r2 = await api("item_prices_save", { code: r.code, prices: prices.map((x) => ({ point_id: x.point_id, price: x.price })) });
      if (!r2.ok) { b.disabled = false; err.textContent = errText(r2); return; }
    }
    m.close();
    await loadGroups(); drawTree(); load();
    // Цены по точкам привязаны к коду позиции, а у новой его до сохранения нет — поэтому
    // новая карточка сразу открывается снова, уже с таблицей цен (раньше — только со второго раза).
    if (!code) { toast("Позиция создана — задайте цены по точкам"); editItem(r.code); } else toast("Сохранено");
  }
}

// Подсказки к колонкам цен по точкам: что это и откуда берётся.
const SHORT_HINT = "Строка позиции сама подставляется в отчёт точки (выдача на раздачу). Список задаёт собственник.";
const RANK_HINT = "Место среди самых ходовых на точке по продажам: 1 — самая ходовая, первые 12 — быстрые кнопки на экране точки.";
const lc = (t) => t.charAt(0).toLowerCase() + t.slice(1);
// «в 10 раз», «в 3 раза», «в 2,5 раза».
function times(x) {
  const v = Math.round(x * 10) / 10, n = Math.round(v);
  const word = v !== n || (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? "раза" : "раз";
  return "в " + v.toLocaleString("ru-RU") + " " + word;
}

// Документ по ссылке из карточки открывается формой склада. Если раздел «Склад» в этой сессии ещё
// не открывали, список складов пуст и в форме не было бы их названий — сначала загружаем его.
async function openDoc(id) {
  if (!stores.length) { const s = await api("stores_list", {}); if (s.ok) setStores(s.stores || []); }
  hooks.editDoc(id);
}
const docLink = (id, number) => id && can("stock", "view")
  ? el("button", { type: "button", class: "link", style: "padding:0", title: "Открыть документ", onclick: () => openDoc(id) }, number || "документ")
  : (number || "");

// Происхождение учётной цены и история цен приходов (c — ответ item_cost_get или null).
function drawOrigin(box, item, c) {
  box.innerHTML = "";
  const line = el("div", { class: "dim", style: "margin-top:4px" });
  const sd = c && c.source_doc;
  if (sd && sd.id) {
    line.append("из прихода ", docLink(sd.id, sd.number), ` от ${fmtDate(sd.doc_date)}` + (sd.counteragent_name ? `, поставщик ${sd.counteragent_name}` : ""));
  } else if (item.cost_price != null) {
    const src = { manual: "введена вручную", iiko_invoice: "из накладной iiko", document: "из прихода" }[item.cost_source] || item.cost_source || "";
    line.append(src + (item.cost_date ? (item.cost_source === "manual" ? " " : " от ") + fmtDate(item.cost_date) : ""));
  }
  // «Средняя» в остатках и учётная цена — разные числа; объясняем, какая из них идёт в техкарты.
  if (item.cost_price != null) line.append(sd && sd.id || item.cost_source === "document" || item.cost_source === "iiko_invoice"
    ? ". Это цена последнего прихода, а не средняя по складу: по ней считаются техкарты." : ". По ней считаются техкарты.");
  if (line.childNodes.length) box.append(line);
  const hist = c && Array.isArray(c.price_history) ? c.price_history : [];
  if (!hist.length) return;
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Дата"), el("th", {}, "Приход"), el("th", {}, "Поставщик"), el("th", { class: "num" }, "Цена")));
  hist.forEach((h, i) => {
    // Цена в разы от предыдущего прихода — чаще всего опечатка в накладной (2 800 вместо 280).
    const older = hist[i + 1], ratio = older && Number(older.price) > 0 ? Number(h.price) / Number(older.price) : null;
    const jump = ratio != null && ratio > 0 && (ratio > 3 || ratio < 1 / 3);
    t.append(el("tr", {}, el("td", {}, fmtDate(h.doc_date)), el("td", {}, docLink(h.doc_id, h.number)), el("td", { class: "dim" }, h.counteragent_name || ""),
      el("td", { class: "num" }, fmtMoney(h.price), jump ? el("span", { class: "tag bad", style: "margin-left:6px",
        title: "Цена отличается от предыдущего прихода больше чем в 3 раза — проверьте накладную" }, (ratio > 1 ? "дороже" : "дешевле") + " " + times(ratio > 1 ? ratio : 1 / ratio)) : null)));
  });
  box.append(el("h2", { style: "margin-top:12px" }, "История цен (последние приходы)"), el("div", { class: "card", style: "padding:0;overflow:auto;margin-bottom:0" }, t));
}

async function editGroup(g) {
  const m = modal(g ? "Группа" : "Новая группа", { keep: true });
  const name = el("input", { value: g ? g.name : "" });
  const parent = el("select", {}, el("option", { value: "" }, "— верхний уровень —"),
    ...groups.filter((x) => !g || x.id !== g.id).map((x) => el("option", { value: x.id, selected: g && x.id === g.parent_id }, x.name)));
  const active = el("input", { type: "checkbox", checked: g ? g.active : true });
  const err = el("div", { class: "err" });
  m.root.append(el("label", {}, "Название"), name, el("label", {}, "Родитель"), parent,
    el("div", { class: "actions" }, el("label", {}, active, " активна")), err,
    el("div", { class: "actions" }, el("button", { onclick: async (e) => {
      e.target.disabled = true;
      const r = await api("group_save", { id: g ? g.id : undefined, name: name.value, parent_id: parent.value || null, active: active.checked });
      // Новая группа после обрыва связи: повтор завёл бы вторую такую же — сначала проверить дерево.
      if (!r.ok) { if (saveFailed(r, !g, e.target, err)) { await loadGroups(); drawTree(); } return; }
      e.target.disabled = false;
      toast("Сохранено"); m.close();
      await loadGroups(); drawTree(); load();
    } }, "Сохранить"), el("button", { class: "ghost", onclick: m.cancel }, "Отмена")));
  name.focus();
}

// ---------- цены по точкам из «Сводного прейскуранта» iiko ----------
// Файл разбирается здесь: строка заголовка «Блюдо … Артикул», по подразделению — первая колонка
// «Цена, тг.» (базовый прейскурант; «Реал» не берётся). Для каждого подразделения человек сам
// отмечает, каким точкам взять его цены. Заранее не отмечается ничего: раньше программа ставила
// галочки настоящим точкам, и загрузка для учебных заодно перезаписывала цены настоящих. Сопоставление,
// подтверждённое Андреем 19.09.2026, показывается подсказкой «обычно: …» рядом с подразделением.
const DEP_HINTS = [[/ЕНЕШКА/i, ["eneshka"]], [/^Буфеты/i, ["univer_b", "kmk"]], [/Тандем Университет/i, ["univer_s"]], [/^Актау/i, ["aktau"]]];
function importPrices() {
  const m = modal("Загрузить прейскурант", { keep: true });
  const file = el("input", { type: "file", accept: ".xlsx,.xls" });
  const body = el("div");
  const err = el("div", { class: "err" });
  m.root.append(el("div", { class: "dim" }, "Файл из iiko: «Сводный прейскурант» в Excel. Цены сопоставляются с позициями по артикулу и заменяют текущие цены выбранных точек."),
    el("label", {}, "Файл"), file, body, err, el("div", { class: "actions" }, el("button", { class: "ghost", onclick: m.close }, "Закрыть")));
  file.onchange = async () => {
    err.textContent = ""; body.innerHTML = "";
    const f = file.files[0]; if (!f) return;
    let a, points;
    try {
      await loadXlsx();
      const wb = window.XLSX.read(await f.arrayBuffer(), { type: "array" });
      a = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
      const pr = await api("store_points_list", {}); points = pr.ok ? pr.points.filter((x) => x.active) : [];
    } catch (e) { err.textContent = "Файл не прочитался: " + e.message; return; }
    const h = a.findIndex((r) => String(r[0]).trim() === "Блюдо" && /Артикул/i.test(String(r[2])));
    if (h < 0) { err.textContent = "Это не «Сводный прейскурант»: не нашёл строку заголовка «Блюдо … Артикул»."; return; }
    const date = (String(a[0][0]).match(/\d{2}\.\d{2}\.\d{4}/) || [""])[0];
    const num = (v) => { const t = String(v).replace(/\s/g, "").replace(",", "."); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
    const deps = [];
    a[h].forEach((v, c) => { if (c >= 3 && String(v).trim()) deps.push({ name: String(v).trim(), col: c, pick: new Set(),
      hint: (DEP_HINTS.find(([re]) => re.test(String(v))) || [null, []])[1] }); });
    const rows = a.slice(h + 3).filter((r) => String(r[2]).trim() && !/^Группа:/.test(String(r[0])));
    for (const d of deps) d.count = rows.filter((r) => num(r[d.col]) > 0).length;
    const ptName = (id) => (points.find((x) => x.id === id) || {}).name || id;
    const t = el("table");
    t.append(el("tr", {}, el("th", {}, "Подразделение в прейскуранте"), el("th", { class: "num" }, "Цен"), el("th", {}, "Взять цены для точек")));
    for (const d of deps) {
      const usual = d.hint.filter((id) => points.some((x) => x.id === id)).map(ptName);
      t.append(el("tr", {}, el("td", {}, d.name, usual.length ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:12px",
          title: "Какие точки обычно берут цены этого подразделения. Галочки не ставятся сами — отметьте нужные точки." }, "обычно: " + usual.join(", ")) : null),
        el("td", { class: "num" }, String(d.count)),
        el("td", {}, ...points.map((pt) => el("label", { class: "chk", style: "display:inline-flex;margin-right:10px;font-weight:400" },
          el("input", { type: "checkbox", onchange: (e) => { e.target.checked ? d.pick.add(pt.id) : d.pick.delete(pt.id); } }), " " + pt.name)))));
    }
    const go = el("button", {}, "Загрузить цены");
    body.append(el("div", { class: "dim", style: "margin:10px 0" }, (date ? "Прейскурант на " + date + ". " : "") + "Позиций в файле: " + rows.length + ". Точка может брать цены только из одного подразделения."),
      el("div", { style: "margin:0 0 10px" }, "Отметьте точки, для которых взять цены; берётся базовая цена подразделения (колонка «Цена, тг.» базового прейскуранта, цены «Реал» не загружаются). Заранее не отмечено ничего."),
      el("div", { class: "card", style: "padding:0;overflow:auto" }, t), el("div", { class: "actions" }, go));
    go.onclick = async () => {
      err.textContent = "";
      const owner = new Map();
      for (const d of deps) for (const pt of d.pick) { if (owner.has(pt)) { err.textContent = "Точка «" + ptName(pt) + "» отмечена у двух подразделений."; return; } owner.set(pt, d); }
      if (!owner.size) { err.textContent = "Не отмечено ни одной точки."; return; }
      const data = [];
      for (const [pt, d] of owner) for (const r of rows) { const pv = num(r[d.col]); if (pv > 0) data.push({ pt, a: String(r[2]).trim(), p: pv }); }
      if (!data.length) { err.textContent = "У отмеченных подразделений в файле нет цен."; return; }
      // Перед записью — список точек словами: цены точки заменяются сразу, отменить загрузку нельзя.
      const list = [...owner].map(([pt, d]) => `• ${ptName(pt)} ← «${d.name}» (цен: ${d.count})`).join("\n");
      if (!confirmDlg(`Загрузить цены${date ? " прейскуранта на " + date : ""} для ${owner.size} ${owner.size === 1 ? "точки" : "точек"}?\n\n${list}\n\n` +
        "У этих точек цены позиций с совпавшим артикулом заменятся базовыми ценами подразделения; остальные цены точек не изменятся.")) return;
      go.disabled = true; go.textContent = "Загружаю…";
      let loaded = 0, unmatched = 0, sample = [];
      for (let i = 0; i < data.length; i += 1000) {
        const r = await api("item_prices_import", { rows: data.slice(i, i + 1000) });
        if (!r.ok) { err.textContent = errText(r); go.disabled = false; go.textContent = "Загрузить цены"; return; }
        loaded += r.loaded; unmatched = Math.max(unmatched, r.unmatched); sample = sample.length ? sample : r.unmatched_sample;
      }
      body.innerHTML = "";
      body.append(el("div", { class: "okbox", style: "margin-top:10px" }, "Загружено цен: " + loaded + " для " + owner.size + " точек."),
        unmatched ? el("div", { class: "dim", style: "margin-top:8px" }, "Артикулов без позиции в учёте: " + unmatched + (sample.length ? " (например: " + sample.slice(0, 10).join(", ") + ")" : "") + ". Их цены не загружены — у позиции в номенклатуре нет такого артикула.") : null);
      load();
    };
  };
}
