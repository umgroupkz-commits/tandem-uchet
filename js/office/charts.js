import { api, can } from "./api.js?v=21";
import { el, fmt, toast, debounce, modal, confirmDlg, today, isoDate, errText } from "./ui.js?v=21";
import { numInput, parseNum, numStr, enterNext, fmtDate, fmtMoney, itemPicker } from "./inputs.js?v=21";

const TYPES = { dish: "блюдо", prepared: "полуфабрикат", goods: "товар" };
let root, table, pager, groups = [];
// by: «name» — поиск блюда по названию, «ingredient» — «где используется»: карты с этим ингредиентом.
let state = { q: "", by: "name", group_id: "", only: "", page: 1, tab: "list" };
// Номер последнего запроса списка: ответ на устаревший поиск («му» после «мука») не рисуется.
let listSeq = 0;

// Проценты с одной цифрой после запятой, как остальные числа экрана: «7,7», «-154,4».
const pct1 = (v) => (Math.round(v * 10) / 10).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// «из iiko»: сервер (0047) отдаёт from_iiko — карта пришла переносом и остаётся «из iiko» и после
// правки в бэк-офисе. Старый сервер знает только source='iiko' — до первой правки.
const fromIiko = (x) => !!x && (x.from_iiko === true || x.source === "iiko");
// Вес по строкам складывается только у весовых единиц: штуки с килограммами не суммируются.
const isWeight = (u) => u === "кг" || u === "л";
// ДД.ММ для коротких пометок в списке («есть версия с 03.10»).
const dayMonth = (d) => fmtDate(d).slice(0, 5);

function versionLabel(v, now) {
  const span = `с ${fmtDate(v.date_from)}${v.date_to ? " по " + fmtDate(v.date_to) : ""}`;
  // Версия с завтрашней даты ещё не действует: раньше она уже была подписана «— действует».
  const st = v.date_from > now ? " — будет действовать" : (!v.date_to || v.date_to >= now ? " — действует" : "");
  return span + st + (fromIiko(v) ? " · из iiko" : "");
}

export async function mount(r) {
  root = r; state.page = 1; fcArt = null;
  groups =(await api("groups_list", {})).groups || [];
  drawShell();
  // Вкладка помнится между заходами в раздел: вернулись на «Фудкост меню» — грузим его, а не пустой список.
  await (state.tab === "report" ? loadReport() : load());
}
export function openChart(code) { editChart(code); }
// После сохранения или удаления карты обновляется открытая вкладка — список или отчёт.
function reloadTab() { return state.tab === "report" ? loadReport() : load(); }

function drawShell() {
  root.innerHTML = "";
  const tabs = el("div", { class: "tools" },
    el("button", { class: state.tab === "list" ? "" : "ghost", onclick: () => { state.tab = "list"; drawShell(); load(); } }, "Карты"),
    el("button", { class: state.tab === "report" ? "" : "ghost", onclick: () => { state.tab = "report"; drawShell(); loadReport(); } }, "Фудкост меню"));
  root.append(tabs);
  if (state.tab === "report") { root.append(el("div", { id: "fc-root" })); return; }
  const groupSel = el("select", { onchange: (e) => { state.group_id = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.group_id === "" }, "все группы"),
    ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === state.group_id }, g.name)));
  const onlySel = el("select", { onchange: (e) => { state.only = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.only === "" }, "все блюда"),
    el("option", { value: "no_chart", selected: state.only === "no_chart" }, "без карты"),
    el("option", { value: "no_cost", selected: state.only === "no_cost" }, "без себестоимости"));
  const holder = () => state.by === "ingredient" ? "Ингредиент: название, код или код iiko — покажу карты, где он есть" : "Поиск блюда или полуфабриката";
  const search = el("input", { placeholder: holder(), value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) });
  // «Где используется»: в iiko это отдельный отчёт; здесь — тот же поиск, переключённый на ингредиенты.
  const bySel = el("select", { style: "flex:none;min-width:0", title: "Искать карту по названию блюда или по ингредиенту в её составе",
    onchange: (e) => { state.by = e.target.value; state.page = 1; search.placeholder = holder(); search.focus(); load(); } },
    el("option", { value: "name", selected: state.by === "name" }, "по блюду"),
    el("option", { value: "ingredient", selected: state.by === "ingredient" }, "по ингредиенту (где используется)"));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" }, bySel, search, groupSel, onlySel),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
}

async function load() {
  if (state.tab !== "list") return;
  const n = ++listSeq;
  const q = state.q.trim();
  const byIng = state.by === "ingredient" && q !== "";
  const r = await api("charts_list", { q: byIng ? "" : state.q, ingredient: byIng ? q : undefined,
    group_id: state.group_id || null, only: state.only || null, page: state.page });
  if (n !== listSeq) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = ""; pager.innerHTML = "";
  // Сервер до 0047 не знает поиска по ингредиенту и молча отдал бы все карты, будто ингредиент
  // есть в каждой. Новый сервер в каждой строке отдаёт ключ next_from (пусть и пустой) — по нему
  // и узнаём; без него честно говорим, что поиск ещё не работает, а не показываем неправду.
  if (byIng && r.rows.length && !r.rows.some((x) => "next_from" in x)) {
    table.append(el("tr", {}, el("td", { class: "dim" }, "Поиск по ингредиенту заработает после обновления сервера. Пока ищите по названию блюда.")));
    return;
  }
  table.append(el("tr", {}, ...["Позиция", "Тип", "Карта", "Выход", "Себестоимость", "Цена", "Фудкост"].map((h, i) => el("th", { class: i >= 3 ? "num" : "" }, h))));
  for (const x of r.rows) {
    // Будущая версия видна прямо в списке: технолог не заводит её второй раз и знает, с какого дня поменяется расход.
    const next = x.next_from ? el("span", { class: "tag", style: "margin-left:6px", title: "С " + fmtDate(x.next_from) + " начнёт действовать новая версия карты" }, "есть версия с " + dayMonth(x.next_from)) : null;
    // «Где используется»: сервер называет, какие из найденных ингредиентов стоят в этой карте.
    const ing = byIng && Array.isArray(x.ingredient_names) && x.ingredient_names.length
      ? el("i", { class: "dim", style: "display:block;font-style:normal;font-size:12px" }, "в составе: " + x.ingredient_names.join(", ")) : null;
    table.append(el("tr", { class: "row", onclick: () => editChart(x.code) },
      el("td", {}, x.name, el("i", { class: "dim", style: "display:block;font-style:normal;font-size:11px" }, x.group_name || ""), ing),
      el("td", {}, TYPES[x.item_type] || x.item_type),
      el("td", {}, x.chart_id ? "с " + fmtDate(x.date_from) : el("span", { class: "tag bad" }, "нет карты"), next),
      el("td", { class: "num" }, x.output_amount != null ? fmt(x.output_amount) + " " + (x.unit_id || "") : ""),
      el("td", { class: "num" }, x.cost != null ? fmtMoney(x.cost) : (x.chart_id ? el("span", { class: "tag" }, "нет цены у " + x.missing_count) : "")),
      el("td", { class: "num" }, fmtMoney(x.price)),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok") }, fmt(x.foodcost_pct) + " %") : "")));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, byIng ? `Ингредиент «${q}» не найден ни в одной карте` : "Ничего не найдено")));
  pager.append((byIng ? `карт с «${q}»: ${r.total}` : `всего ${r.total}`) + ` · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

// ---------- редактор ----------
async function editChart(code, chartId) {
  const r = await api("chart_get", { code, id: chartId || null });
  if (!r.ok) { toast(errText(r), "bad"); return; }
  const ro = !can("charts", "edit");
  const item = r.item, ch = r.chart;
  const now = today();
  // Форма с вводом: по фону не закрывается, «Отмена» и смена версии при правках переспрашивают.
  const m = modal(`${item.name} · техкарта`, { keep: !ro });
  m.root.style.maxWidth = "960px";
  // Происхождение карты — рядом с названием: карта из iiko остаётся «из iiko» и после правки.
  if (fromIiko(ch)) m.root.firstChild.append(" ", el("span", { class: "tag", style: "vertical-align:middle",
    title: ch.source === "iiko" ? "Карта перенесена из iiko" : "Карта перенесена из iiko и правлена в бэк-офисе" }, "из iiko"));
  // версии
  if (r.versions.length) {
    const vs = el("select", { "data-nodirty": "", onchange: (e) => {
        if (m.dirty && !confirmDlg("Открыть другую версию? Несохранённые правки этой пропадут.")) { e.target.value = ch ? ch.id : ""; return; }
        m.close(); editChart(code, e.target.value);
      } },
      ...r.versions.map((v) => el("option", { value: v.id, selected: ch && v.id === ch.id }, versionLabel(v, now))));
    m.root.append(el("div", { class: "tools" }, el("span", { class: "dim" }, "Версия:"), vs));
  }
  // Будущая версия ещё не списывает: до её даты продажи идут по предыдущей.
  if (ch && ch.date_from > now) {
    m.root.append(el("div", { class: "dim" }, `Эта версия начнёт действовать с ${fmtDate(ch.date_from)}; до этого продажи списываются по предыдущей.`));
  }
  // Закрытая версия правится «задним числом»: расчёты за её период поедут. Для изменений
  // с новой даты есть «Новая версия» — говорим об этом прямо над формой.
  if (ch && ch.date_to) {
    m.root.append(el("div", { class: "dim" },
      `Вы правите версию, закрытую датой ${fmtDate(ch.date_to)}; для изменений с новой даты используйте «Новая версия».`));
  }
  // Числа — текстовым полем с цифровой клавиатурой (numInput): щелчок выделяет значение и набор его
  // заменяет, запятая работает при любом языке браузера. Раньше числовое поле браузера ставило
  // каретку в начало, и «0,065» поверх «0,06» давало 650,06, а в английском Chrome — 65.
  let tbl = null;
  const firstLine = () => { const x = tbl && tbl.querySelector("[data-nav]"); if (x) x.focus(); else if (picker) picker.focus(); };
  const f = {
    date_from: el("input", { type: "date", value: ch ? ch.date_from : now, readonly: ro }),
    date_to: el("input", { type: "date", value: ch && ch.date_to ? ch.date_to : "", readonly: ro }),
    output: numInput({ value: ch ? ch.output_amount : 1, readonly: ro, onInput: () => refresh(), onEnter: firstLine }),
    technology: el("textarea", { readonly: ro }, ch && ch.technology ? ch.technology : ""),
  };
  m.root.append(el("div", { class: "grid2" },
    el("div", {}, el("label", {}, "Действует с"), f.date_from), el("div", {}, el("label", {}, "по (пусто — бессрочно)"), f.date_to),
    el("div", {}, el("label", {}, `Выход, ${item.unit_id}`), f.output),
    el("div", {}, el("label", {}, "Цена продажи"), el("input", { value: fmtMoney(item.price), readonly: true, style: "text-align:right" }))),
    el("label", {}, "Технология"), f.technology);
  // Строки держат числа текстом, как их набрали («0,065»); b0 — брутто при открытии карты:
  // с ним сравнивается новое, чтобы поймать ошибку в разы (0,06 → 650,06).
  // kn и ko — доли потерь строки на момент открытия, как проценты потерь в iiko: kn = нетто/брутто
  // (1 − холодные), ko = выход/нетто (1 − горячие). Правка брутто пересчитывает по ним нетто и выход:
  // курица 0,15/0,15/0,12, брутто 0,065 → нетто 0,065, выход 0,052 (горячие 20 % остаются). Раньше
  // выход оставался 0,12 и строка становилась «приваром». null — долю не вычислить (брутто 0 при
  // ненулевом нетто): такое поле само не пересчитывается. handN/handO — поле правили руками.
  const share = (part, whole) => whole > 0 ? part / whole : (part > 0 ? null : 1);
  const lines = (ch ? ch.lines : []).map((l) => {
    const b = parseNum(l.brutto) || 0, n = parseNum(l.netto) || 0, o = parseNum(l.output) || 0;
    return { ...l, brutto: numStr(l.brutto), netto: numStr(l.netto), output: numStr(l.output), b0: parseNum(l.brutto), kn: share(n, b), ko: share(o, n) };
  });
  tbl = el("table");
  const totals = el("div", { class: "tot" });
  const weightNote = el("div", { class: "dim", style: "margin-top:6px" });
  const warn = el("div", { class: "err" });
  // Пусто — ноль (так и было); не число — NaN: его ловит проверка при сохранении.
  const num = (v) => { const x = parseNum(v); return x == null || Number.isNaN(x) ? 0 : x; };
  const notNum = (v) => Number.isNaN(parseNum(v));
  const jumped = (l) => l.b0 > 0 && num(l.brutto) > l.b0 * 5;
  // Расчёт карты по тому, что сейчас на экране: им пользуются итог, предупреждения и печать.
  function calc() {
    let sum = 0, complete = true;
    const missing = [], costs = [];
    for (const l of lines) {
      const lineCost = l.ing_cost != null ? num(l.brutto) * Number(l.ing_cost) : null;
      if (lineCost == null) { complete = false; missing.push(l.name); } else { sum += lineCost; costs.push({ l, cost: lineCost }); }
    }
    const out = num(f.output.value);
    const perUnit = complete && out > 0 ? sum / out : null;
    const foodcost = perUnit != null && Number(item.price) > 0 ? perUnit / Number(item.price) * 100 : null;
    return { sum, complete, missing, costs, out, perUnit, foodcost };
  }
  // Ввод в строке меняет только данные строки, её ячейки (потери, сумма, подсветка) и итог —
  // поля ввода не пересоздаются. Раньше на каждый input таблица собиралась заново, новое поле
  // получало фокус с кареткой в начале, и «0.5» превращалось в «50», а «120» — в «021».
  // Полная перерисовка (drawLines) — только при добавлении и удалении строк.
  let rows = [], foot = null;
  function refresh() {
    let wB = 0, wN = 0, wO = 0, pieces = 0;
    for (const { l, c } of rows) {
      const b = num(l.brutto), n = num(l.netto), o = num(l.output);
      const cold = b > 0 ? (b - n) / b * 100 : 0;
      const hot = n > 0 ? (n - o) / n * 100 : 0;
      c.loss.innerHTML = "";
      c.loss.append(`${pct1(cold)} / ${pct1(hot)} %`);
      // Отрицательные потери при варке — не ошибка, а привар: крупа и макароны набирают вес.
      if (hot < 0) c.loss.append(el("span", { class: "tag", style: "margin-left:4px", title: "Выход больше нетто: продукт при варке набирает вес (крупы, макароны). Это нормально." }, "привар"));
      c.cost.textContent = l.ing_cost != null ? fmtMoney(b * Number(l.ing_cost)) : "";
      c.tr.className = n > b ? "off" : "";
      c.tr.style.background = jumped(l) || notNum(l.brutto) || notNum(l.netto) || notNum(l.output) ? "#FCF3E1" : "";
      if (isWeight(l.unit)) { wB += b; wN += n; wO += o; } else pieces++;
    }
    const k = calc();
    totals.innerHTML = "";
    if (!lines.length) totals.append(el("span", {}, "Себестоимость"), el("span", {}, "— добавьте ингредиенты"));
    else totals.append(el("span", {}, k.complete ? "Себестоимость на выход / за единицу" : "Посчитано частично (нет цен)"),
      el("span", {}, `${fmtMoney(k.sum)} / ${k.perUnit != null ? fmtMoney(k.perUnit) : "—"} ₸` +
        (k.foodcost != null ? ` · фудкост ${fmt(k.foodcost)} % · наценка ${k.perUnit > 0 ? fmt((Number(item.price) - k.perUnit) / k.perUnit * 100) : "—"} %` : "")));
    // Итог веса по строкам — как строка «Итого» в карте iiko; рядом выход карты, чтобы расхождение было видно.
    if (foot) {
      foot.b.textContent = numStr(Math.round(wB * 1000) / 1000);
      foot.n.textContent = numStr(Math.round(wN * 1000) / 1000);
      foot.o.textContent = numStr(Math.round(wO * 1000) / 1000);
      foot.cost.textContent = fmtMoney(k.sum);
      foot.label.title = pieces ? "Строки в штуках и порциях в вес не входят" : "";
      foot.tr.hidden = pieces === rows.length;   // одни штуки — складывать нечего
    }
    weightNote.textContent = rows.length && isWeight(item.unit_id)
      ? `Σ нетто по строкам ${numStr(Math.round(wN * 1000) / 1000)} ${item.unit_id} · выход по строкам ${numStr(Math.round(wO * 1000) / 1000)} ${item.unit_id} · выход карты ${numStr(k.out)} ${item.unit_id}` +
        (pieces ? " (без строк в штуках)" : "")
      : "";
    const msg = [];
    // Не число («0,12,5», «1.2.3») в расчёт идёт нулём — говорим сразу, сохранить его не даст save().
    const wrong = lines.filter((l) => notNum(l.brutto) || notNum(l.netto) || notNum(l.output));
    if (wrong.length) msg.push("Не число в строке: " + wrong.map((l) => `«${l.name}»`).join(", ") + " — пишите цифры, дробь через запятую: 0,065");
    if (k.missing.length) msg.push("Нет учётной цены: " + k.missing.join(", ") + " — задайте её в карточке товара");
    if (lines.some((l) => num(l.netto) > num(l.brutto))) msg.push("Есть строки, где нетто больше брутто");
    // Выход больше суммы нетто — почти всегда забытый пересчёт (поправили брутто, а выход остался
    // прежним); законно это только при приваре. У карты в кг/л сравниваем её выход (если нет строк
    // в штуках), иначе — выход по строкам. Округление — до грамма, как в строке «Итого вес».
    const g = (x) => Math.round(x * 1000) / 1000;
    if (rows.length > pieces) {
      const tail = " — проверьте выход; больше нетто бывает только при приваре (крупы, макароны)";
      if (isWeight(item.unit_id) && !pieces && g(k.out) > g(wN)) msg.push(`Выход карты ${numStr(g(k.out))} ${item.unit_id} больше суммы нетто ${numStr(g(wN))} ${item.unit_id}` + tail);
      else if (g(wO) > g(wN)) msg.push(`Выход по строкам ${numStr(g(wO))} больше суммы нетто ${numStr(g(wN))}` + tail);
    }
    const jumps = lines.filter(jumped);
    if (jumps.length) msg.push("Брутто выросло больше чем в 5 раз: " + jumps.map((l) => `«${l.name}» ${numStr(l.b0)} → ${l.brutto}`).join(", ") + " — проверьте запятую");
    if (k.foodcost != null && k.foodcost > 100) msg.push(`Фудкост ${fmt(k.foodcost)} % — больше 100 %: проверьте брутто и единицы`);
    warn.textContent = msg.join(" · ");
  }
  function drawLines() {
    tbl.innerHTML = ""; rows = []; foot = null;
    tbl.append(el("tr", {}, ...["Ингредиент", "Ед.", "Брутто", "Нетто", "Выход", "Потери хол./гор.", "Цена", "Сумма", ""].map((h, i) => el("th", { class: i >= 2 ? "num" : "" }, h))));
    // Enter в строке ведёт брутто → нетто → выход → брутто следующей строки, с последнего поля — в поиск ингредиента.
    const next = enterNext(tbl, () => { if (picker) picker.focus(); });
    for (const l of lines) {
      const c = {};
      const inp = (key) => (c[key] = numInput({ value: l[key], readonly: ro, width: "90px", attrs: { "data-nav": "" }, onEnter: next,
        onInput: (v) => {
          l[key] = v;
          if (key === "netto") l.handN = true;
          if (key === "output") l.handO = true;
          // Пересчёт вниз по цепочке по долям потерь (kn, ko): брутто → нетто → выход. Поле, которое в
          // этом сеансе правили руками, не трогается; не число в поле — соседние ждут исправления.
          // Значение пишется в соседние поля через .value, само поле, в котором набирают, не трогается.
          const r4 = (x) => numStr(Math.round(x * 10000) / 10000);
          let nChanged = key === "netto";
          const b = parseNum(l.brutto);
          if (key === "brutto" && !l.handN && l.kn != null && !Number.isNaN(b)) {
            l.netto = b == null ? "" : r4(b * l.kn); c.netto.value = l.netto; nChanged = true;
          }
          const n = parseNum(l.netto);
          if (nChanged && !l.handO && l.ko != null && !Number.isNaN(n)) { l.output = n == null ? "" : r4(n * l.ko); c.output.value = l.output; }
          refresh();
        } }));
      c.loss = el("td", { class: "num dim", style: "white-space:nowrap" });
      c.cost = el("td", { class: "num" });
      c.tr = el("tr", {},
        el("td", {}, l.name, l.item_type !== "goods" ? el("span", { class: "tag", style: "margin-left:6px" }, TYPES[l.item_type] || l.item_type) : null),
        el("td", {}, l.unit), el("td", { class: "num" }, inp("brutto")), el("td", { class: "num" }, inp("netto")), el("td", { class: "num" }, inp("output")),
        c.loss,
        el("td", { class: "num" }, l.ing_cost != null ? fmtMoney(l.ing_cost) : el("span", { class: "tag bad" }, "нет")),
        c.cost,
        // «×» не в порядке Tab: проход по полям строки не должен останавливаться на удалении.
        el("td", {}, ro ? null : el("button", { class: "x", tabindex: "-1", title: "Убрать строку", onclick: () => { lines.splice(lines.indexOf(l), 1); m.dirty = true; drawLines(); } }, "×")));
      tbl.append(c.tr);
      rows.push({ l, c });
    }
    if (lines.length) {
      foot = { label: el("td", { style: "font-weight:700" }, "Итого вес"), b: el("td", { class: "num", style: "font-weight:700;padding-right:16px" }),
        n: el("td", { class: "num", style: "font-weight:700;padding-right:16px" }), o: el("td", { class: "num", style: "font-weight:700;padding-right:16px" }),
        cost: el("td", { class: "num", style: "font-weight:700" }) };
      foot.tr = el("tr", {}, foot.label, el("td", { class: "dim" }, "кг, л"), foot.b, foot.n, foot.o, el("td", {}), el("td", {}), foot.cost, el("td", {}));
      tbl.append(foot.tr);
    }
    refresh();
  }
  // добавление ингредиента
  let picker = null;
  if (!ro) {
    // В карту идут товары и полуфабрикаты; блюда — редкость (комбо), их показываем по флажку.
    // Раньше поиск давал 12 строк вперемешку с блюдами, и «Мясо говядина триммер» за ними не находилось.
    const po = { types: ["goods", "prepared"], limit: 30, placeholder: "Добавить ингредиент: название или код iiko",
      exclude: (it) => it.code === code || lines.some((l) => l.ingredient_code === it.code),
      onPick: async (it) => {
        const c = await api("item_cost_get", { code: it.code });
        if (lines.some((l) => l.ingredient_code === it.code)) return;   // второй щелчок до ответа не задваивает строку
        // Новая строка без потерь: нетто и выход идут за брутто, пока их не поправят руками.
        lines.push({ ingredient_code: it.code, name: it.name, unit: it.unit_id, item_type: it.item_type, brutto: "", netto: "", output: "", ing_cost: c.ok ? c.cost : null, b0: null, kn: 1, ko: 1 });
        m.dirty = true; drawLines();
        const last = rows[rows.length - 1]; if (last) last.c.brutto.focus();
      } };
    picker = itemPicker(po);
    const dishes = el("input", { type: "checkbox", "data-nodirty": "", onchange: (e) => {
      po.types = e.target.checked ? ["goods", "prepared", "dish"] : ["goods", "prepared"];
      picker.input.dispatchEvent(new Event("input"));
    } });
    drawLines();
    m.root.append(el("h2", { style: "margin-top:14px" }, "Состав"), tbl, totals, weightNote, warn,
      el("div", { style: "margin-top:10px" }, picker.root,
        el("label", { style: "font-weight:400;margin:6px 0 0" }, dishes, " и блюда (обычно в карту идут товары и полуфабрикаты)")));
  } else {
    drawLines();
    m.root.append(el("h2", { style: "margin-top:14px" }, "Состав"), tbl, totals, weightNote, warn);
  }
  const err = el("div", { class: "err" });
  const actions = el("div", { class: "actions" });
  if (!ro) {
    actions.append(el("button", { onclick: save }, "Сохранить"));
    if (ch) actions.append(el("button", { class: "ghost", onclick: newVersion }, "Новая версия с даты…"));
  }
  if (ch || lines.length) actions.append(el("button", { class: "ghost", onclick: print }, "Печать"));
  // Единственную версию не удаляем: блюдо осталось бы без техкарты, и продажи списывали бы само
  // блюдо. Сервер откажет и сам (его текст показывается ниже), но кнопку такой версии не показываем.
  if (!ro && ch && ch.source === "office" && r.versions.length > 1) actions.append(el("button", { class: "ghost", onclick: del }, "Удалить версию"));
  actions.append(el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена"));
  m.root.append(err, actions);

  // Что переспросить перед сохранением: ошибка в разы (запятая не там) и фудкост больше 100 %.
  // Раньше «650,06» вместо «0,065» и фудкост 43 927 % сохранялись без единого слова.
  function doubts() {
    const k = calc(), out = [];
    const jumps = lines.filter(jumped);
    if (jumps.length) out.push("брутто выросло больше чем в 5 раз: " + jumps.map((l) => `«${l.name}» ${numStr(l.b0)} → ${l.brutto} ${l.unit || ""}`.trim()).join("; "));
    if (k.foodcost != null && k.foodcost > 100) {
      const top = k.costs.slice().sort((a, b) => b.cost - a.cost).slice(0, 3)
        .map((x) => `«${x.l.name}» ${x.l.brutto} ${x.l.unit || ""} — ${fmtMoney(x.cost)} ₸`.replace(/ +/g, " "));
      out.push(`фудкост карты ${fmt(k.foodcost)} % — больше 100 %` + (top.length ? ". Больше всего дают: " + top.join("; ") : ""));
    }
    return out.length ? "Проверьте, прежде чем сохранить:\n• " + out.join("\n• ") + "\n\nСохранить так?" : "";
  }
  async function save(e) {
    err.textContent = "";
    // Пустое брутто — забытое количество, а не ноль: строка молча ушла бы нулём, ингредиент не
    // списывался бы и не попадал в себестоимость. Ноль, вписанный явно, допустим (так пришли карты iiko).
    const empty = lines.filter((l) => String(l.brutto ?? "").trim() === "");
    if (empty.length) { err.textContent = "Впишите брутто: " + empty.map((l) => l.name).join(", ") + ". Ноль допустим, если так и задумано."; return; }
    const wrong = lines.filter((l) => notNum(l.brutto) || notNum(l.netto) || notNum(l.output));
    if (wrong.length) { err.textContent = "Не число в строке: " + wrong.map((l) => l.name).join(", ") + ". Пишите цифры, дробь — через запятую: 0,065"; return; }
    const out = parseNum(f.output.value);
    if (out == null || Number.isNaN(out) || out <= 0) { err.textContent = "Выход должен быть числом больше нуля"; f.output.focus(); return; }
    const ask = doubts();
    if (ask && !confirmDlg(ask)) return;
    const p = { id: ch ? ch.id : undefined, code, date_from: f.date_from.value, date_to: f.date_to.value || null,
      output_amount: out, technology: f.technology.value,
      // note строки уходит обратно как была: сервер пересобирает строки, и без неё примечание стиралось
      lines: lines.map((l) => ({ ingredient_code: l.ingredient_code, brutto: num(l.brutto), netto: num(l.netto), output: num(l.output), note: l.note || null })) };
    const b = e.target; b.disabled = true;   // второе нажатие до ответа не уходит вторым сохранением
    const r2 = await api("chart_save", p);
    b.disabled = false;
    if (!r2.ok) { err.textContent = errText(r2); return; }
    toast("Сохранено"); m.close(); reloadTab();
  }
  // Печать — то, что на экране (с несохранёнными правками — после вопроса), в форме ответа chart_get.
  // print.js подгружается при нажатии: без него остальной экран техкарт работает как прежде.
  async function print() {
    if (m.dirty && !confirmDlg("Карта не сохранена. Напечатать так, как сейчас на экране?")) return;
    let mod = null;
    try { mod = await import("./print.js?v=21"); } catch { mod = null; }
    if (!mod || typeof mod.printChart !== "function") { toast("Печать техкарты пока недоступна — обновите страницу позже", "bad"); return; }
    const k = calc();
    const ln = lines.map((l) => {
      const b = num(l.brutto), n = num(l.netto), o = num(l.output);
      return { ...l, brutto: b, netto: n, output: o,
        line_cost: l.ing_cost != null ? Math.round(b * Number(l.ing_cost) * 10000) / 10000 : null,
        cold_loss_pct: b > 0 ? Math.round((b - n) / b * 1000) / 10 : null,
        hot_loss_pct: n > 0 ? Math.round((n - o) / n * 1000) / 10 : null };
    });
    const chart = { ...(ch || {}), date_from: f.date_from.value, date_to: f.date_to.value || null,
      output_amount: k.out, technology: f.technology.value, lines: ln };
    // printChart не бросает: отвечает {ok:false, error} — показываем текст.
    let res;
    try {
      res = await mod.printChart({ ok: true, item, chart, versions: r.versions,
        cost: k.perUnit, partial: k.out > 0 ? k.sum / k.out : null, missing: r.missing || [],
        missing_names: r.missing_names, missing_text: r.missing_text, foodcost_pct: k.foodcost }, {});
    } catch (x) { res = { ok: false, error: x && x.message ? x.message : String(x) }; }
    if (res && res.ok === false && res.error !== "Печать отменена") toast(res.error || "Не получилось напечатать", "bad");
  }
  // Дата новой версии — календарём, а не свободным текстом: «01.10.2026» в окне prompt база
  // понимала как месяц-день и тихо создавала версию с 10 января.
  function newVersion() {
    if (m.dirty && !confirmDlg("Несохранённые правки этой версии пропадут. Создать новую версию?")) return;
    const d = modal("Новая версия карты", { keep: true });
    // По умолчанию — завтра: с сегодняшней датой действующая карта закрылась бы вчерашним днём, а
    // сегодняшние продажи пересчитались бы по новой. Если уже есть версия с завтра или позже, сервер
    // такую дату не примет — тогда предлагаем день после самой поздней.
    const nextDay = (iso) => { const [y, mo, dd] = iso.split("-").map(Number); return isoDate(new Date(y, mo - 1, dd + 1)); };
    const latest = r.versions.reduce((a, v) => (v.date_from > a ? v.date_from : a), "");
    const tomorrow = nextDay(today());
    const date = el("input", { type: "date", value: latest >= tomorrow ? nextDay(latest) : tomorrow });
    const e2 = el("div", { class: "err" });
    const go = el("button", { onclick: async () => {
      e2.textContent = "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { e2.textContent = "Выберите дату в календаре"; return; }
      go.disabled = true;
      const r2 = await api("chart_new_version", { code, date_from: date.value });
      go.disabled = false;
      if (!r2.ok) { e2.textContent = errText(r2); return; }
      d.close(); toast("Версия создана"); m.close(); editChart(code, r2.id);
    } }, "Создать версию");
    d.root.append(el("div", { class: "dim" }, "Новая версия — копия действующей; правки внесите в неё. Текущая версия закроется днём раньше выбранной даты. " +
      (latest >= tomorrow ? `Уже есть версия с ${fmtDate(latest)} — новая может начаться только позже.` : "По умолчанию — завтра: сегодняшние продажи остаются по текущей версии.")),
      el("label", {}, "Действует с"), date, e2,
      el("div", { class: "actions" }, go, el("button", { class: "ghost", onclick: d.close }, "Отмена")));
    date.focus();
  }
  async function del(e) {
    const prev = r.versions.some((v) => v.id !== ch.id && v.date_from < ch.date_from);
    if (!confirmDlg(`Удалить версию карты с ${fmtDate(ch.date_from)}?` + (prev ? " Предыдущая версия снова станет действующей." : ""))) return;
    const b = e.target; b.disabled = true;
    const r2 = await api("chart_delete", { id: ch.id });
    b.disabled = false;
    if (!r2.ok) { err.textContent = errText(r2); return; }
    toast("Удалено"); m.close(); reloadTab();
  }
}

// ---------- отчёт ----------
// Дата по умолчанию — сегодня на момент открытия вкладки, а не загрузки модуля: бэк-офис,
// открытый вчера, считал бы фудкост на вчерашнее число. Дату, выбранную руками, не трогаем.
// q — поиск по названию, over — только выше порога, own — только с ценой выбранной точки.
let fc = { point_id: "", group_id: "", date: "", auto: true, sort: "foodcost_pct", q: "", over: false, own: false };
let fcSeq = 0;
let fcData = null;     // последний ответ отчёта: фильтры по названию и флажкам не ходят на сервер
let fcBase = null;     // отчёт с ценами по умолчанию — для «только с ценой точки» на старом сервере
let fcPoints = [];
// Код позиции → код iiko (артикул) для CSV (сверка с iiko). Отчёт фудкоста артикула не отдаёт —
// дочитываем его поиском по номенклатуре один раз за заход в раздел (те же позиции: включённые,
// продаются, блюда и полуфабрикаты). Если сервер начнёт отдавать artikul в строке — берём оттуда.
let fcArt = null;
async function artikuls() {
  if (fcArt) return fcArt;
  const get = (page) => api("items_search", { q: "", types: ["dish", "prepared"], active: true, for_sale: true, limit: 200, page });
  // Первая страница называет число страниц, остальные — разом: по одной выгрузка ждала ~10 с.
  const first = await get(1);
  if (!first.ok) return null;
  const rest = await Promise.all(Array.from({ length: Math.min(first.pages, 100) - 1 }, (_, i) => get(i + 2)));
  if (rest.some((r) => !r.ok)) return null;
  const map = new Map();
  for (const r of [first, ...rest]) for (const x of r.rows) map.set(x.code, x.artikul || "");
  return (fcArt = map);
}

// Флажок в строке фильтров: у .tools input ширина как у поля поиска — флажку её сбрасываем.
function chk(checked, text, title, onchange) {
  const box = el("input", { type: "checkbox", checked, style: "min-width:0;flex:none;width:auto", onchange: (e) => onchange(e.target.checked) });
  return el("label", { style: "margin:0;font-weight:400;white-space:nowrap", title }, box, text);
}

async function loadReport() {
  const host = document.getElementById("fc-root"); if (!host) return;
  // Строка фильтров строится один раз при открытии вкладки; дальше обновляется только результат,
  // а ответ, обогнанный более новым запросом, не рисуется.
  if (!host.firstChild) {
    if (fc.auto) fc.date = today();
    const ptSel = el("select", { onchange: (e) => { fc.point_id = e.target.value; ownBox.hidden = !fc.point_id; loadReport(); } },
      el("option", { value: "", selected: fc.point_id === "" }, "цена по умолчанию"));
    const ownBox = chk(fc.own, " только с ценой точки", "Только позиции, у которых у выбранной точки своя цена (продаются на точке)", (v) => { fc.own = v; drawReport(); });
    ownBox.hidden = !fc.point_id;
    host.append(el("div", { class: "tools" },
      el("input", { placeholder: "Поиск по названию", value: fc.q, oninput: debounce((e) => { fc.q = e.target.value; drawReport(); }, 250) }),
      ptSel,
      el("select", { onchange: (e) => { fc.group_id = e.target.value; loadReport(); } },
        el("option", { value: "", selected: fc.group_id === "" }, "все группы"),
        ...groups.filter((g) => g.active).map((g) => el("option", { value: g.id, selected: g.id === fc.group_id }, g.name))),
      el("input", { type: "date", value: fc.date, style: "flex:none;min-width:0;width:auto", onchange: debounce((e) => { fc.date = e.target.value; fc.auto = false; loadReport(); }, 400) })),
      el("div", { class: "tools" },
        chk(fc.over, " только выше порога", "Только позиции с фудкостом выше порога", (v) => { fc.over = v; drawReport(); }), ownBox,
        el("span", { class: "dim fc-info", style: "flex:1" }), el("button", { class: "ghost fc-csv" }, "CSV")),
      el("div", { class: "out" }));
    api("stores_list", {}).then((s) => {   // список точек уже отдаёт stores_list
      fcPoints = s.points || [];
      for (const p of fcPoints) ptSel.append(el("option", { value: p.id, selected: p.id === fc.point_id }, "цены точки: " + p.name));
      if (fc.point_id && !fcPoints.some((p) => p.id === fc.point_id)) { fc.point_id = ""; ptSel.value = ""; ownBox.hidden = true; loadReport(); }
    });
  }
  const out = host.querySelector(":scope > .out");
  const n = ++fcSeq;
  const req = { point_id: fc.point_id || null, group_id: fc.group_id || null, date: fc.date };
  const r = await api("foodcost_report", req);
  if (n !== fcSeq) return;
  fcData = null; fcBase = null;
  if (!r.ok) { out.innerHTML = ""; out.append(el("div", { class: "err" }, errText(r))); host.querySelector(".fc-info").textContent = ""; host.querySelector(".fc-csv").onclick = null; return; }
  // «Своя цена точки»: новый сервер отдаёт её в строке (point_price). Старый — только итоговую цену
  // (цена точки, а если её нет — общая); тогда сравниваем с отчётом по общим ценам: совпавшая цена
  // считается общей — так позиция с ценой точки, равной общей, в фильтр не попадёт (это видно в подсказке).
  if (req.point_id && !r.rows.some((x) => "point_price" in x)) {
    const b = await api("foodcost_report", { ...req, point_id: null });
    if (n !== fcSeq) return;
    if (b.ok) fcBase = new Map(b.rows.map((x) => [x.code, x.price]));
  }
  fcData = { r, point_id: req.point_id, group_id: req.group_id, date: req.date };
  drawReport();
}

function drawReport() {
  const host = document.getElementById("fc-root"); if (!host || !fcData) return;
  const out = host.querySelector(":scope > .out"), info = host.querySelector(".fc-info"), csvBtn = host.querySelector(".fc-csv");
  const { r } = fcData;
  // Названия вместо кодов «нет цены у»: сервер (0047) отдаёт missing_names; на старом подставляем
  // названия из самого отчёта, где они есть, остальное — «код …».
  const names = new Map(r.rows.map((x) => [x.code, x.name]));
  const missingText = (x) => {
    if (Array.isArray(x.missing_names) && x.missing_names.length) return x.missing_names;
    return (x.missing || []).map((c) => {
      const s = String(c), cyc = s.startsWith("cycle:"), code = cyc ? s.slice(6) : s;
      const nm = names.get(code) || "код " + code;
      return cyc ? "цикл: " + nm : nm;
    });
  };
  const hasOwnField = r.rows.some((x) => "point_price" in x);
  // С 0047 (K2) у точки со своими ценами позиция без своей цены приходит без цены: тогда любая цена в
  // строке — своя цена точки. Узнаём это по позициям, у которых общая цена есть, а в отчёте точки — нет.
  const k2 = !hasOwnField && fcBase && r.rows.some((x) => x.price == null && fcBase.get(x.code) != null);
  const ownPrice = (x) => hasOwnField ? x.point_price != null
    : k2 ? x.price != null
    : fcBase ? x.price != null && Number(x.price) !== Number(fcBase.get(x.code)) : true;
  // Каждое слово запроса — с начала слова названия («азу» не находит «глазурью»); слово от 4 букв —
  // и внутри («говяд» найдёт «Фрикаделькиговяд…»). Код позиции — точным совпадением.
  const words = fc.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (x) => {
    const nm = String(x.name || "").toLowerCase(), parts = nm.split(/[\s,.()«»"\/-]+/);
    return (words.length === 1 && String(x.code) === words[0])
      || words.every((w) => parts.some((p) => p.startsWith(w)) || (w.length >= 4 && nm.includes(w)));
  };
  let rows = r.rows.filter((x) => {
    if (words.length && !hit(x)) return false;
    if (fc.over && !x.over_limit) return false;
    if (fc.own && fcData.point_id && !ownPrice(x)) return false;
    return true;
  });
  rows = rows.slice().sort((a, b) => (b[fc.sort] ?? -1) - (a[fc.sort] ?? -1));
  const priced = rows.filter((x) => x.cost != null).length;
  const pt = fcPoints.find((p) => p.id === fcData.point_id);
  info.textContent = `показано ${rows.length} из ${r.rows.length}, с себестоимостью ${priced}, порог ${fmt(r.limit)} %` +
    (fc.own && fcData.point_id && !hasOwnField && !k2 ? " · своя цена точки — та, что отличается от общей" : "");
  // CSV — по текущему фильтру и сортировке, с русскими заголовками и названиями вместо кодов;
  // десятичная запятая и «;» — как читает русский Excel.
  csvBtn.onclick = async () => {
    const cell = (v) => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const dec = (v) => v == null || v === "" ? "" : String(v).replace(".", ",");
    // Код iiko — для сверки с iiko (этап 2): из строки отчёта, а если сервер его не отдаёт — из номенклатуры.
    let art = null;
    if (rows.some((x) => !("artikul" in x))) {
      csvBtn.disabled = true; csvBtn.textContent = "CSV…";
      art = await artikuls();
      csvBtn.disabled = false; csvBtn.textContent = "CSV";
      if (!art) toast("Коды iiko не загрузились — колонка «Код iiko» в файле пустая", "bad");
    }
    const artOf = (x) => "artikul" in x ? x.artikul || "" : (art && art.get(x.code)) || "";
    // «00161» Excel превратил бы в число 161 — такой код пишем формулой ="00161", как в отчётах склада.
    const artCell = (v) => /^0\d+$/.test(v) ? `="${v}"` : cell(v);
    const head = ["Код", "Код iiko (артикул)", "Позиция", "Группа", "Ед.", "Себестоимость, ₸", "Цена, ₸", "Наценка, %", "Фудкост, %", "Выше порога", "Нет цены у"];
    const body = rows.map((x) => [cell(x.code), artCell(artOf(x)), ...[x.name, x.group_name || "", x.unit_id || "", dec(x.cost), dec(x.price), dec(x.markup_pct), dec(x.foodcost_pct),
      x.over_limit ? "да" : "", missingText(x).join(" | ")].map(cell)].join(";"));
    const title = `Фудкост меню на ${fmtDate(fcData.date)} · ${pt ? "цены точки " + pt.name : "цены по умолчанию"}`;
    const blob = new Blob(["\uFEFF" + [cell(title), head.map(cell).join(";"), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `фудкост_${fcData.date}${pt ? "_" + pt.name.replace(/[\\/:*?"<>|]/g, " ") : ""}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  out.innerHTML = "";
  const t = el("table");
  const th = (key, title, cls) => el("th", { class: (cls || "") + " row", onclick: () => { fc.sort = key; drawReport(); } }, title + (fc.sort === key ? " ▼" : ""));
  t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", {}, "Группа"), th("cost", "Себестоимость", "num"), th("price", "Цена", "num"), th("markup_pct", "Наценка %", "num"), th("foodcost_pct", "Фудкост %", "num"), el("th", {}, "Нет цены у")));
  for (const x of rows) {
    const miss = missingText(x);
    // Фудкост больше 100 % почти всегда ошибка данных (кг вместо порции, запятая) — подсказываем, что проверить.
    const odd = x.foodcost_pct != null && Number(x.foodcost_pct) > 100;
    t.append(el("tr", { class: "row", onclick: () => editChart(x.code) },
      el("td", {}, x.name), el("td", { class: "dim" }, x.group_name || ""), el("td", { class: "num" }, fmtMoney(x.cost)), el("td", { class: "num" }, fmtMoney(x.price)),
      el("td", { class: "num" }, x.markup_pct != null ? fmt(x.markup_pct) : ""),
      el("td", { class: "num" }, x.foodcost_pct != null ? el("span", { class: "tag " + (x.over_limit ? "bad" : "ok"),
        title: odd ? "Больше 100 % — проверьте брутто и единицы в карте (кг или порция) и цену продажи" : null }, fmt(x.foodcost_pct) + (odd ? " ?" : "")) : ""),
      el("td", { class: "dim", title: miss.length > 3 ? miss.join(", ") : null }, miss.slice(0, 3).join(", ") + (miss.length > 3 ? "…" : ""))));
  }
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: 7, class: "dim" }, "Ничего не найдено")));
  out.append(el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}
