import { api, can } from "./api.js?v=22";
import { el, toast, modal, errText, saveFailed, confirmDlg, fmt } from "./ui.js?v=22";

let root, data, pts;
// Склады — по алфавиту, выключенные внизу: «Учебный склад кухни» стоял последним из 30 в порядке точек.
const byName = (a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)
  || String(a.name || "").trim().localeCompare(String(b.name || "").trim(), "ru", { sensitivity: "base" });
// Режимы экрана точки: как продавец сдаёт продажи.
const MODES = { checks: "касса — чек на каждую продажу", position: "отчёт с продажами по позициям", takeout: "заборный лист",
  import: "загрузка листа продаж из файла", manual: "только суммы" };
// Подсказка под режимом в карточке точки — своя у каждого режима (раньше всегда была про кассу).
const MODE_HINTS = {
  checks: "Касса — продавец пробивает каждую продажу на планшете (страница кассы), отчёт дня собирается из чеков сам; вечером смену закрывают на экране точки. Перевести точку в кассу можно, пока за сегодня нет сданного отчёта, иначе — завтра.",
  position: "Отчёт по позициям — в конце дня продавец на экране точки вносит выручку по способам оплаты и сколько продано каждой позиции (поиском или из частых позиций).",
  takeout: "Заборный лист — точка записывает, сколько каждой позиции выдали на раздачу и сколько осталось в конце дня; продано считается само (выдано − остаток). Есть кнопка «Заполнить как вчера».",
  import: "Загрузка из файла — точка выгружает из своей программы «Сводку по товарообороту» за день (xls, xlsx или csv) и загружает её на экране точки; незнакомые названия сопоставляются один раз.",
  manual: "Только суммы — точка сдаёт выручку по способам оплаты и расходы, без позиций: продаж по блюдам и списания продаж со склада у неё не будет.",
};
// Склад точки по умолчанию для щелчка в колонке «Склад» таблицы точек. Список точек отдаёт только
// название склада (store_id — если сервер начнёт его отдавать): сначала склад, привязанный к точке как
// склад по умолчанию, иначе единственный склад с таким названием; несколько одноимённых — null.
function storeOf(x) {
  if (!x.store_name || !data || !data.stores) return null;
  if (x.store_id) return data.stores.find((s) => s.id === x.store_id) || null;
  const own = data.stores.find((s) => s.point_id === x.id && s.is_default && s.name === x.store_name);
  if (own) return own;
  const same = data.stores.filter((s) => s.name === x.store_name);
  return same.length === 1 ? same[0] : null;
}
const trainingTag = () => el("span", { class: "tag warn", title: "Учебный склад: приходы на него не меняют учётные цены позиций" }, "учебный");
export async function mount(r) { root = r; await load(); }

async function load() {
  // Неудачный ответ не затирает уже показанный список: карточки складов и точек открываются
  // по data/pts, и без этого строка на экране после обрыва переставала открываться.
  const [d, p] = await Promise.all([api("stores_list", {}), api("store_points_list", {})]);
  if (!d.ok) { toast(errText(d), "bad"); return; }
  data = { ...d, stores: (d.stores || []).slice().sort(byName) }; pts = p;
  root.innerHTML = "";
  if (pts.ok) {
    const pt = el("table");
    pt.append(el("tr", {}, ...["Точка", "Режим", "Юрлицо", "Склад", "Групп меню", "Статус"].map((h) => el("th", {}, h))));
    const loose = [];
    for (const x of pts.points) {
      const u = unbound(x);
      if (u && x.active) loose.push([x, u]);
      // Щелчок по складу открывает карточку склада (привязка и «по умолчанию» правятся там), по остальной
      // строке — карточку точки. Склад не определился однозначно — строка ведёт в карточку точки, как раньше.
      const st = storeOf(x);
      pt.append(el("tr", { class: "row" + (x.active ? "" : " off"), onclick: () => editPoint(x) },
        el("td", {}, x.name), el("td", {}, MODES[x.mode] || x.mode), el("td", {}, x.legal_entity || ""),
        el("td", {}, !x.store_name ? el("span", { class: "tag bad" }, "нет склада")
            : st ? el("button", { class: "link cell", title: "Открыть карточку склада", onclick: (e) => { e.stopPropagation(); edit(st); } }, x.store_name)
            : x.store_name,
          st && st.training ? [" ", trainingTag()] : null,
          u ? el("div", {}, el("span", { class: "tag warn", title: "Склад по умолчанию не привязан к этой точке" }, "склад не привязан к точке")) : null),
        el("td", {}, x.item_categories.length ? String(x.item_categories.length) : el("span", { class: "dim" }, "все")),
        el("td", {}, x.active ? "" : el("span", { class: "tag bad" }, "выключена"))));
    }
    root.append(el("div", { class: "tools" }, el("h3", { style: "margin:0" }, "Точки продаж"),
        can("stores", "edit") ? el("button", { onclick: () => editPoint(null) }, "+ Точка") : null),
      ...loose.map(([x, u]) => looseBox(x, u)),
      el("div", { class: "card", style: "padding:0;overflow:auto;margin:10px 0 18px" }, pt),
      el("h3", { style: "margin:0 0 8px" }, "Склады"));
  }
  const t = el("table");
  t.append(el("tr", {}, ...["Склад", "Точка", "По умолчанию", "Статус"].map((h) => el("th", {}, h))));
  for (const s of data.stores) {
    t.append(el("tr", { class: "row" + (s.active ? "" : " off"), onclick: () => edit(s) },
      el("td", {}, s.name, s.training ? [" ", trainingTag()] : null), el("td", {}, s.point_name || el("span", { class: "dim" }, "без точки")),
      el("td", {}, s.is_default ? el("span", { class: "tag ok" }, "да") : ""),
      el("td", {}, s.active ? "" : el("span", { class: "tag bad" }, "выключен"))));
  }
  root.append(el("div", { class: "tools" }, el("div", { class: "dim" }, `${data.stores.length} складов`),
      can("stores", "edit") ? el("button", { onclick: () => edit(null) }, "+ Склад") : null),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

// Склад по умолчанию точки, который к самой точке не привязан (stores.point_id пуст или другой).
// Продажи точки списываются с её склада по умолчанию, а «Прибыль по точкам» собирает склады по
// привязке — выручка такой точки уходила в «Склады без точки» (Столовая Актау → «Кухня Актау»).
// Список точек отдаёт только название склада (store_id — если сервер начнёт его отдавать): ищем склад по
// id, иначе по названию. Возвращает {store} — найден один, {many} — несколько с таким названием (какой —
// решает человек), иначе null.
function unbound(x) {
  if (!x.store_name || !data || !data.stores) return null;
  if (data.stores.some((s) => s.point_id === x.id && s.is_default)) return null;
  const same = data.stores.filter((s) => (x.store_id ? s.id === x.store_id : s.name === x.store_name));
  if (same.length === 1) return { store: same[0] };
  return same.length ? { many: same.length } : null;
}
// Предупреждение с кнопкой «Привязать склад к точке» — над таблицей точек и в карточке точки.
function looseBox(x, u, after) {
  const err = el("div", { class: "err", style: "min-height:0" });
  const s = u.store;
  const text = `Склад точки «${x.name}» — «${x.store_name}» — к точке не привязан` + (s && s.point_name ? ` (привязан к «${s.point_name}»)` : "") +
    ". Продажи точки списываются с этого склада, а в «Прибыли по точкам» его выручка уйдёт в «Склады без точки».";
  let tail = null;
  if (u.many) tail = el("div", {}, `Складов с названием «${x.store_name}» несколько — откройте нужный ниже и выберите в нём точку «${x.name}».`);
  else if (!s.active) tail = el("div", {}, `Склад «${s.name}» выключен — включите его в карточке склада и привяжите к точке.`);
  else if (can("stores", "edit")) tail = el("div", { class: "actions", style: "margin-top:8px" },
    el("button", { class: "small", onclick: (e) => { e.stopPropagation(); bindStore(x, s, e.target, err, after); } }, "Привязать склад к точке"));
  return el("div", { class: "warnbox" }, text, tail, err);
}
async function bindStore(x, s, btn, err, after) {
  // Привязка ставит склад складом по умолчанию этой точки; если он же склад по умолчанию других точек,
  // сервер снимет его у них — об этом спрашиваем заранее.
  const others = ((pts && pts.points) || []).filter((p) => p.id !== x.id && p.store_name === s.name);
  if (others.length && !confirmDlg(`Склад «${s.name}» — склад по умолчанию и у точек: ${others.map((p) => "«" + p.name + "»").join(", ")}. ` +
      `После привязки к «${x.name}» у них склада по умолчанию не останется. Привязать?`)) return;
  btn.disabled = true; err.textContent = "";
  const r = await api("store_save", { id: s.id, name: s.name, point_id: x.id, is_default: true, active: s.active });
  if (!r.ok) { btn.disabled = false; err.textContent = errText(r); return; }
  toast(`Склад «${s.name}» привязан к точке «${x.name}»`);
  if (after) after();
  load();
}

function edit(s) {
  const ro = !can("stores", "edit");
  const m = modal(s ? s.name : "Новый склад", { keep: !ro });
  const name = el("input", { value: s ? s.name : "", readonly: ro });
  const point = el("select", { disabled: ro }, el("option", { value: "" }, "— без точки —"),
    ...data.points.map((p) => el("option", { value: p.id, selected: s && p.id === s.point_id }, p.name)));
  const def = el("input", { type: "checkbox", checked: s ? s.is_default : false, disabled: ro });
  const active = el("input", { type: "checkbox", checked: s ? s.active : true, disabled: ro });
  // Учебный склад (сборка 22): приходы на него не меняют учётную цену позиции. Флажок — только если
  // сервер уже знает поле (stores_list отдаёт training): старый сервер молча не сохранил бы отметку.
  const knowsTraining = data.stores.some((x) => "training" in x);
  const training = el("input", { type: "checkbox", checked: !!(s && s.training), disabled: ro });
  const err = el("div", { class: "err" });
  if (!ro) setTimeout(() => name.focus(), 0);
  // Склад — склад по умолчанию точки, но к ней не привязан: подсказать, как поправить, и предупредить,
  // что сохранение без точки снимет его с точки (сервер отвязанный склад складом по умолчанию не держит).
  const owners = s && pts && pts.ok ? pts.points.filter((p) => p.store_name === s.name && !(s.point_id === p.id && s.is_default)) : [];
  m.root.append(owners.length ? el("div", { class: "warnbox", style: "margin:0 0 6px" },
      `Это склад по умолчанию точки ${owners.map((p) => "«" + p.name + "»").join(", ")}, но к ней он не привязан. ` +
      "Выберите эту точку и отметьте «склад точки по умолчанию». Если сохранить склад без точки, у точки не останется склада по умолчанию.") : "",
    el("label", {}, "Название"), name, el("label", {}, "Точка"), point,
    el("div", { class: "actions" }, el("label", {}, def, " склад точки по умолчанию"), el("label", {}, active, " активен")),
    knowsTraining ? el("div", { class: "actions", style: "margin-top:6px" }, el("label", {}, training, " Учебный склад (приходы не меняют учётные цены)")) : "",
    knowsTraining ? el("div", { class: "dim" }, "Для тестирования и обучения. Остатки, движения и отчёты — как у любого склада, но цена прихода " +
      "на этот склад не становится учётной ценой позиции и не меняет себестоимость техкарт; цены, которые его приходы уже поставили, " +
      "при отметке вернутся к прежним. После тестирования выключите склад.") : "",
    err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async (e) => {
        e.target.disabled = true;   // второе нажатие до ответа заводило второй склад
        const r = await api("store_save", { id: s ? s.id : undefined, name: name.value, point_id: point.value || null, is_default: def.checked, active: active.checked,
          ...(knowsTraining ? { training: training.checked } : {}) });
        // новый склад после обрыва связи: повтор завёл бы второй — сначала проверить список
        if (!r.ok) { if (saveFailed(r, !s, e.target, err)) load(); return; }
        e.target.disabled = false;
        toast("Сохранено"); m.close(); load();
        if (Array.isArray(r.costs_restored) && r.costs_restored.length) showRestored(r.costs_restored, name.value.trim());
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена")));
}
// Склад отметили учебным, а его приходы уже успели поставить учётные цены: сервер вернул их к прежним
// (store_save → costs_restored [{code, name, was, now}]) — показываем, что изменилось.
function showRestored(rows, storeName) {
  const m = modal("Учётные цены возвращены");
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", { class: "num" }, "Была — с учебного прихода, ₸"), el("th", { class: "num" }, "Стала, ₸")));
  for (const x of rows) {
    t.append(el("tr", {}, el("td", {}, x.name || x.code, el("div", { class: "dim" }, "код " + x.code)),
      el("td", { class: "num" }, fmt(x.was)),
      el("td", { class: "num" }, x.now === null || x.now === undefined ? el("span", { class: "dim" }, "нет цены") : fmt(x.now))));
  }
  m.root.append(el("div", { class: "dim" }, `Склад «${storeName}» отмечен учебным. Приходы на него ставили учётные цены этих позиций (${rows.length}) — ` +
      "цены возвращены к прежним: последняя закупка на обычный склад или цена до учебного прихода. Себестоимость техкарт считается по ним. " +
      "«Нет цены» — других закупок не было: позиция покажется в «Готовности» как сырьё без цены."),
    el("div", { class: "card", style: "padding:0;overflow:auto;max-height:50vh;margin:10px 0 0" }, t),
    el("div", { class: "actions" }, el("button", { onclick: m.close }, "Понятно")));
}

function editPoint(x) {
  const ro = !can("stores", "edit");
  const m = modal(x ? x.name : "Новая точка", { keep: !ro });
  const id = el("input", { value: x ? x.id : "", readonly: !!x || ro, placeholder: "латиницей, например eneshka2" });
  const name = el("input", { value: x ? x.name : "", readonly: ro });
  const mode = el("select", { disabled: ro }, ...Object.entries(MODES).map(([k, v]) => el("option", { value: k, selected: x ? x.mode === k : k === "position" }, v)));
  const modeHint = el("div", { class: "dim" });
  const setModeHint = () => { modeHint.textContent = (MODE_HINTS[mode.value] || "") + " Смена режима действует со следующего входа на экран точки."; };
  mode.addEventListener("change", setModeHint);
  setModeHint();
  const le = el("select", { disabled: ro }, el("option", { value: "" }, "—"),
    ...pts.legal_entities.map((v) => el("option", { value: v, selected: x && x.legal_entity === v }, v)));
  const pin = el("input", { inputmode: "numeric", autocomplete: "off", readonly: ro, placeholder: x && x.has_pin ? "не менять" : "4–8 цифр" });
  const active = el("input", { type: "checkbox", checked: x ? x.active : true, disabled: ro });
  const chosen = new Set(x ? x.item_categories : []);
  const cats = el("div", { class: "cats" }, ...pts.categories.map((c) => el("label", { class: "chk" },
    el("input", { type: "checkbox", checked: chosen.has(c), disabled: ro, onchange: (e) => { e.target.checked ? chosen.add(c) : chosen.delete(c); } }), " " + c)));
  const err = el("div", { class: "err" });
  // Пустые места — пустой строкой, а не null: родной append печатал null текстом («nullnull» под заголовком).
  const u = x ? unbound(x) : null;
  m.root.append(u ? looseBox(x, u, () => m.close()) : "",
    x ? "" : el("label", {}, "Код точки в системе"), x ? "" : id,
    el("label", {}, "Название"), name,
    el("label", {}, "Как точка сдаёт продажи"), mode, modeHint,
    el("label", {}, "Юрлицо"), le,
    el("label", {}, x ? "Новый код входа" : "Код входа"), pin,
    el("div", { class: "dim" }, "Код, по которому продавцы входят на экран точки и в кассу. Сменили — сообщите его точке."),
    el("label", {}, "Группы меню на экране точки"),
    el("div", { class: "dim" }, "Ничего не отмечено — точка видит всё, что в продаже."), cats,
    el("div", { class: "actions" }, el("label", {}, active, " точка работает")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async (e) => {
        e.target.disabled = true;
        const r = await api("store_point_save", { id: x ? x.id : id.value.trim(), name: name.value, mode: mode.value, legal_entity: le.value,
          pin: pin.value.trim(), active: active.checked, item_categories: [...chosen] });
        e.target.disabled = false;
        if (!r.ok) { err.textContent = errText(r); return; }
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена")));
}
