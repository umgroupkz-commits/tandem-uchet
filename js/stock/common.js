import { api, session, LONG_MS } from "../office/api.js?v=22";
import { el, fmt, toast, debounce, today } from "../office/ui.js?v=22";
import { fmtMoney, fmtDate } from "../office/inputs.js?v=22";

// ---------------------------------------------------------------- единый слой вызовов
// Экраны склада не разбирают ответ сервера сами: ask() возвращает уже удачный ответ,
// а любую неудачу — и отказ сервера, и обрыв связи — бросает исключением с текстом,
// который можно показать человеку как есть. Один try/catch на сценарий вместо проверки
// `if (!r.ok)` в каждой точке (и вместо молчаливого падения на сетевом сбое).
export async function ask(action, payload) {
  let r;
  try {
    r = await api(action, payload);
  } catch (e) {
    // Прежний api() бросал, когда fetch не дошёл до сервера (офлайн, DNS, обрыв).
    throw offline(e);
  }
  // Нынешний api() не бросает: обрыв и таймаут приходят ответом error:'network'.
  if (r && r.error === "network") throw offline(r);
  if (!r.ok) { const e = new Error(r.message || r.error || "Ошибка сервера"); e.code = r.error || ""; noteError(action, e.message); throw e; }
  return r;
}
// Исходная причина (исключение или ответ api) остаётся в cause.
function offline(cause) { const w = new Error("Нет связи с сервером"); w.cause = cause; w.offline = true; noteError("связь", w.message); return w; }
// Отказ сервера запоминается для кнопки «Замечание»: человек пишет «не провелось», а разбирающий
// видит, что именно ответил сервер. Только текст отказа — без запроса и токена.
function noteError(action, text) {
  try { if (window.TandemFeedback) window.TandemFeedback.noteError(action + ": " + text); } catch {}
}

// Кнопка блокируется на время запроса и разблокируется всегда — даже когда fn упала.
export async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------- числа с телефона
// Ru-раскладка на телефоне даёт запятую, а Number("1,5") — NaN; type=number с запятой
// вообще отдаёт пустой value. Поэтому поля количества текстовые, а нормализация — здесь.
// Пробелы (и неразрывные из вставленного «1 234,5») — разделители разрядов, а не ошибка.
export function normNum(v) { return String(v === null || v === undefined ? "" : v).replace(/[\s  ]/g, "").replace(",", "."); }
export function numOf(v) { return Number(normNum(v)); }
export function hasNum(v) { return normNum(v) !== ""; }
export function okNum(v) { const s = normNum(v); return s !== "" && Number.isFinite(Number(s)) && Number(s) >= 0; }
// Количество для людей: до 3 знаков (килограммы — с граммами: «0,065»), с запятой; fmt() режет до 2.
export function fmtQty(n) {
  if (n === null || n === undefined || n === "") return "";
  return (Math.round(Number(n) * 1000) / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

// Поле количества или цены. Текстовое (см. выше) — поэтому колёсико мыши число не меняет, как
// меняло у type=number (2900 → 2899,999). Значение при входе выделяется целиком: набор заменяет
// старое число, а не дописывается к нему. Enter (на клавиатуре телефона — «Далее») зовёт opts.onEnter.
export function qtyInput(value, onChange, opts) {
  const o = opts || {};
  const inp = el("input", { type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false", enterkeyhint: "next",
    "data-nav": "", class: o.class || null, placeholder: o.placeholder || null, "aria-label": o.label || o.placeholder || null,
    value: value === null || value === undefined ? "" : value,
    oninput: (e) => onChange(e.target.value) });
  selectOnFocus(inp);
  if (o.onEnter) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); o.onEnter(e); } });
  return inp;
}

// Выделить значение поля при входе (числа и строки поиска: новый набор заменяет старое). Касание или
// щелчок ставят курсор уже после focus и снимают выделение — их mouseup гасим один раз.
export function selectOnFocus(inp) {
  let justFocused = false;
  inp.addEventListener("focus", () => { justFocused = true; inp.select(); });
  inp.addEventListener("mouseup", (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });
  inp.addEventListener("blur", () => { justFocused = false; });
  return inp;
}

// ---------------------------------------------------------------- поиск: порядок и совпадения
// Сравнение без регистра и без «ё»: «Свёкла» находится по «свекла».
export const norm = (s) => String(s === null || s === undefined ? "" : s).toLowerCase().replace(/ё/g, "е");
const WORD_SPLIT = /[\s,.;:()«»"'/+-]+/;
// Насколько позиция подходит к запросу: 0 — точно название, артикул или код; 1 — название
// начинается с запроса; 2 — каждое слово запроса — начало какого-то слова названия (или артикула):
// «творог» → «Молочка Творог», «фарш» → «Мясо Фарш хороший»; 3 — только кусок внутри слова
// («соль» внутри «Фасоль»).
export function rankItem(it, q) {
  const qn = norm(q).trim();
  if (!qn) return 3;
  const n = norm(it.name), a = norm(it.artikul), c = norm(it.code);
  if (n === qn || (a && a === qn) || c === qn) return 0;
  if (n.startsWith(qn)) return 1;
  const nw = n.split(WORD_SPLIT).filter(Boolean);
  const ws = qn.split(/\s+/).filter(Boolean);
  if (ws.every((w) => nw.some((x) => x.startsWith(w)) || (a && a.startsWith(w)))) return 2;
  return 3;
}
// Результаты «с начала слова»: если хоть что-то совпало с начала слова, куски внутри слов
// («Фасоль», «Рассольник» на «соль») не показываются вовсе; иначе — они, чтобы не было пусто.
// Внутри одной ступени — порядок сервера (по алфавиту).
export function rankItems(rows, q, limit) {
  const list = (rows || []).map((it, i) => ({ it, i, r: rankItem(it, q) }));
  const best = list.some((x) => x.r < 3);
  return list.filter((x) => !best || x.r < 3).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.it).slice(0, limit || 30);
}
// Строка списка пересчёта подходит под поиск: каждое слово — кусок названия или начало кода.
// Здесь куски внутри слова оставлены: список — только позиции склада, он и так короткий.
export function lineMatch(l, q) {
  const ws = norm(q).split(/\s+/).filter(Boolean);
  if (!ws.length) return true;
  const n = norm(l.name), c = norm(l.item_code);
  return ws.every((w) => n.includes(w) || c.startsWith(w));
}

// ---------------------------------------------------------------- подбор позиций
let pickSeq = 0;
// Поиск по номенклатуре (сверху — его видно сразу, без прокрутки) и под ним плитки позиций склада
// по алфавиту — тех, что уже двигались на нём (не «частые»: частоту сервер не считает).
// types — какие виды позиций искать (приёмка — только товары ['goods']); limit — до скольких строк.
// tiles: false — без плиток (пересчёт: позиции склада и так в списке). Enter в поиске берёт первую строку.
// stock: true — перемещение и списание: в items_search уходит store_id склада-отправителя, позиции
// с остатком на нём идут выше, в подсказке — «ост. N» (в «Яйца куриные» не надо искать шестой строкой
// под «Яйца вареные», а беляш без остатка не выбирается вслепую). Остаток — из ответа сервера
// (stock_qty), а пока сервер его не отдаёт — из остатков склада, загруженных здесь же (все страницы
// stock_balances). onPick получает остаток в stock_qty (null — неизвестен).
// Enter, нажатый раньше, чем пришёл список, не теряется — как в iiko и в бэк-офисе: первая строка
// выбирается, как только список придёт. Цифры, набранные после такого Enter, — уже количество: они
// уходят в поле, куда экран поставил курсор после выбора (на телефоне клавиша часто шлёт не код
// символа, а «Unidentified», поэтому набранное берётся из хвоста поля поиска, а не из нажатий).
export function itemPicker({ storeId, onPick, filter = () => true, types = null, limit = 30, tiles = true, stock = false, label = "Найти позицию" }) {
  const fav = el("div", { class: "fav" });
  const perr = el("div", { class: "err" });
  const sid = "pick" + (++pickSeq);
  const search = el("input", { id: sid, placeholder: "Название или код", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search" });
  selectOnFocus(search);
  const res = el("div", { class: "sres" });
  const root = el("div", {}, el("label", { for: sid }, label), search, res, perr,
    tiles ? el("div", { class: "favh" }, "Позиции склада (А–Я)") : null, tiles ? fav : null);
  let all = [], shown = 0, found = [], seq = 0;
  // loading — запрос по набранному в пути (или ещё ждёт паузы в наборе); pendingEnter — Enter нажат до
  // ответа, qAtEnter — что стояло в поиске в этот момент (всё, что дописано после, — количество).
  let loading = false, pendingEnter = false, qAtEnter = "";
  let lastRows = [], lastQ = "";
  // Остатки склада по коду позиции; null — не загружены (или не нужны: stock выключен).
  let stockMap = null;
  const stockOf = (it) => {
    if (!stock) return null;
    if (it.stock_qty !== undefined && it.stock_qty !== null && it.stock_qty !== "") return Number(it.stock_qty);
    if (stockMap) return stockMap.has(it.code) ? stockMap.get(it.code) : 0;
    return null;
  };
  const withStock = (it) => (stock ? { ...it, stock_qty: stockOf(it) } : it);
  const pick = (it) => { seq++; loading = false; pendingEnter = false; search.value = ""; res.innerHTML = ""; found = []; onPick(withStock(it)); };
  function drawTiles() {
    fav.innerHTML = "";
    for (const x of all.slice(0, shown)) fav.append(el("button", { type: "button", onclick: () => { pendingEnter = false;
      onPick(withStock({ code: x.item_code, name: x.name, unit_id: x.unit_id, avg_cost: x.avg_cost, stock_qty: stock ? x.qty : undefined })); } }, x.name));
    if (!all.length) fav.append(el("span", { class: "dim" }, "пока пусто — найдите позицию поиском"));
    if (all.length > shown) fav.append(el("button", { type: "button", class: "more", onclick: () => { shown += 24; drawTiles(); } }, "ещё (" + (all.length - shown) + ")"));
  }
  async function refresh() {
    if (!tiles && !stock) return;
    fav.innerHTML = ""; perr.textContent = "";
    try {
      // Плиткам хватает первой страницы (200 позиций); остатки для поиска нужны все — склад кухни
      // держит больше 300 позиций, и позиция со второй страницы иначе считалась бы «без остатка».
      const rows = [];
      let page = 1, pages = 1;
      do {
        const b = await ask("stock_balances", { store_id: storeId, only_nonzero: false, page });
        rows.push(...(b.rows || []));
        pages = stock ? Math.min(Number(b.pages) || 1, 20) : 1; page++;
      } while (page <= pages);
      if (stock) {
        stockMap = new Map(rows.map((x) => [x.item_code, Number(x.qty) || 0]));
        // Список пришёл раньше остатков — перестраиваем его уже с остатками (если Enter не ждёт ответа).
        if (found.length && !loading) { found = order(lastRows, lastQ); drawFound(); }
      }
      if (!tiles) return;
      // stock_balances отдаёт остаток, а не карточку номенклатуры: поля item_type в нём нет,
      // поэтому фильтр здесь получает только код, название и единицу. Отбирать плитки по типу
      // позиции нельзя — для этого понадобился бы отдельный запрос к номенклатуре.
      all = rows.filter((x) => filter({ code: x.item_code, name: x.name, unit_id: x.unit_id }))
        .sort((a, c) => a.name.localeCompare(c.name, "ru"));
      shown = 12; drawTiles();
    } catch (e) {
      perr.textContent = "Позиции склада не загрузились: " + e.message;
      if (tiles) fav.append(el("button", { type: "button", onclick: refresh }, "Повторить"));
    }
  }
  // Порядок подсказок: с остатком на складе — выше (stock), внутри — «с начала слова» (rankItems).
  function order(rows, q) {
    const ranked = rankItems(rows, q, 1000);
    if (!stock) return ranked.slice(0, limit);
    const has = (it) => { const s = stockOf(it); return s !== null && s > 0 ? 0 : 1; };
    return ranked.map((it, i) => ({ it, i, h: has(it) })).sort((a, b) => a.h - b.h || a.i - b.i).map((x) => x.it).slice(0, limit);
  }
  function drawFound() {
    res.innerHTML = "";
    for (const it of found) {
      const meta = [it.artikul ? "код " + it.artikul : null, it.unit_id || null].filter(Boolean).join(" · ");
      const s = stockOf(it);
      // Остаток: есть — зелёный, ноль — серый (блюда и порции на складе не лежат), минус — красный.
      const stk = s === null ? null : [meta ? " · " : "", el("b", { class: "stk" + (s > 0 ? " pos" : s < 0 ? " neg" : "") }, "ост. " + fmtQty(s))];
      res.append(el("button", { type: "button", class: "sitem", onclick: () => pick(it) }, el("span", {}, it.name), el("i", {}, meta, stk)));
    }
    if (!found.length) res.append(el("div", { class: "sitem dim" }, types && types.length === 1 && types[0] === "goods" ? "Среди товаров не найдено" : "Не найдено"));
  }
  // Ответ пришёл, а Enter уже нажат: выбрать первую строку и отдать дописанные цифры полю количества.
  // Дописаны буквы — человек продолжал набирать название: ищем заново по всему набранному, без выбора.
  function finishEnter() {
    pendingEnter = false;
    const typed = (search.value.startsWith(qAtEnter) ? search.value.slice(qAtEnter.length) : "").trim();
    if (!found.length) return;   // «Не найдено» видно, набранное осталось в поиске
    if (typed && !/^[\d\s.,]+$/.test(typed)) { loading = true; run(); return; }
    pick(found[0]);
    const t = document.activeElement;
    if (typed && t && t !== search && t.tagName === "INPUT" && !t.readOnly) {
      t.value = typed; t.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const run = debounce(async () => {
    const n = ++seq;
    // Enter нажат во время паузы в наборе: искать то, что стояло в поиске при Enter, без дописанного после.
    const q = (pendingEnter ? qAtEnter : search.value).trim();
    res.innerHTML = ""; found = []; perr.textContent = "";
    if (q.length < 2) { loading = false; pendingEnter = false; return; }
    loading = true;
    try {
      // item_type — для сервера до сборки 21 (он знает только один тип), types и limit — для нового;
      // порядок «с начала слова» и отбор по типу повторены здесь, чтобы старый сервер вёл себя так же.
      // store_id — склад-отправитель (stock): сервер отдаёт stock_qty и ставит позиции с остатком выше;
      // строк просим больше, чтобы позиция с остатком не осталась за отрезанными 30 у старого сервера.
      const s = await ask("items_search", { q, active: true, page: 1, limit: stock ? Math.max(limit, 60) : limit, types: types || undefined,
        item_type: types && types.length === 1 ? types[0] : undefined, store_id: stock ? storeId : undefined });
      if (n !== seq) return;
      loading = false;
      lastRows = (s.rows || []).filter((it) => (!types || !it.item_type || types.includes(it.item_type)) && filter(it));
      lastQ = q;
      found = order(lastRows, q);
      drawFound();
      if (pendingEnter) finishEnter();
    } catch (e) {
      if (n !== seq) return;
      loading = false; pendingEnter = false;
      perr.textContent = "Поиск не сработал: " + e.message;
    }
  }, 300);
  search.addEventListener("input", () => {
    // После Enter, пока список в пути, дописанное — это количество (см. finishEnter): запрос не перезапускаем.
    // Стёрли часть запроса — Enter отменяется, ищем заново.
    if (pendingEnter && search.value.startsWith(qAtEnter)) return;
    pendingEnter = false;
    loading = search.value.trim().length >= 2;
    run();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (pendingEnter) return;
    // Список ещё не пришёл (набрали быстро и сразу Enter) — выберем первую строку, когда придёт.
    if (loading) { pendingEnter = true; qAtEnter = search.value; return; }
    if (found.length) pick(found[0]);
  });
  refresh();
  // find(q) — подставить запрос и искать (пересчёт: «в списке нет — найти в номенклатуре»).
  return { root, refresh, input: search, find(q) { search.value = q; pendingEnter = false; loading = q.trim().length >= 2; run(); } };
}

// ---------------------------------------------------------------- «Уйдут в минус» перед проведением
// Окно самой программы, а не системное «ОК / Отмена» браузера: там по привычке жмут «ОК» — так ушло
// перемещение на 5000 яиц вместо 30. Главная кнопка и фокус — «Исправить» (назад к вводу), «Провести
// всё равно» — второстепенная; Esc и касание фона — тоже «Исправить». В списке по каждой позиции: сколько
// есть сейчас (остаток после + количество в документе) и сколько станет. lines — строки документа
// (количество и единица), storeName — склад экрана: другой склад в предупреждении подписывается.
// Возвращает Promise<boolean>: true — провести всё равно.
export function confirmMinus(warnings, lines, storeName) {
  return new Promise((resolve) => {
    const by = new Map();
    for (const l of lines || []) {
      const a = by.get(l.item_code) || { qty: 0, unit: l.unit_id || "" };
      a.qty += numOf(l.qty) || 0; by.set(l.item_code, a);
    }
    const list = (warnings || []).map((w) => {
      const l = by.get(w.item_code), after = Number(w.balance_after);
      const unit = l && l.unit ? " " + l.unit : "";
      const now = l && Number.isFinite(after) ? after + l.qty : null;
      return el("div", { class: "mrow" },
        el("div", { class: "mn" }, w.name, w.store_name && w.store_name !== storeName ? el("i", {}, w.store_name) : null),
        el("div", { class: "mq" }, now === null ? null : el("span", {}, "сейчас " + fmtQty(now) + unit),
          el("b", {}, "после " + fmtQty(after) + unit)));
    });
    const n = list.length;
    const fix = el("button", { type: "button", class: "big" }, "Исправить");
    const go = el("button", { type: "button", class: "ghost" }, "Провести всё равно");
    const box = el("div", { class: "sheet", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "m_title", "aria-describedby": "m_desc" },
      el("h2", { id: "m_title" }, "Уйдут в минус"),
      el("div", { class: "warnbox", id: "m_desc" }, n === 1 ? "После проведения остаток этой позиции станет меньше нуля:"
        : "После проведения остаток " + n + " поз. станет меньше нуля:"),
      el("div", { class: "mlist" }, ...list),
      el("div", { class: "dim", style: "margin-top:8px" }, "Проверьте количество: частая причина — опечатка (999 вместо 9,99) или позиции нет на этом складе."),
      el("div", { class: "macts" }, fix, go));
    const ov = el("div", { class: "sheet-bg" }, box);
    const shell = document.getElementById("shell");
    const back = document.activeElement;
    let done = false;
    function close(v) {
      if (done) return; done = true;
      document.removeEventListener("keydown", onKey, true);
      ov.remove();
      if (shell) shell.inert = false;
      if (!v && back && back.focus && document.contains(back)) { try { back.focus({ preventScroll: true }); } catch {} }
      resolve(v);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(false); return; }
      // Фокус не уходит из окна: Tab ходит между двумя кнопками.
      if (e.key === "Tab") { e.preventDefault(); (document.activeElement === fix ? go : fix).focus(); }
    }
    fix.addEventListener("click", () => close(false));
    go.addEventListener("click", () => close(true));
    ov.addEventListener("click", (e) => { if (e.target === ov) close(false); });
    document.addEventListener("keydown", onKey, true);
    if (shell) shell.inert = true;
    document.body.append(ov);
    fix.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------- строки документа
// Инпуты не пересоздаются при вводе — перерисовываются только суммы.
// Одна колонка (инвентаризация, перемещение) — строка в один ряд, над списком шапка; несколько
// колонок (приёмка) — название на своей строке, поля под ним, у каждого поля подпись сверху:
// подсказка внутри поля пропадает, как только число введено, и уже не понятно, где кол-во, где цена.
// Enter в поле — к следующему видимому полю списка, с последнего — onLast() (поиск позиции);
// onEnter(e) может перехватить переход, вернув true. Кнопка «×» вне порядка Tab.
// Отбор строк (setFilter) прячет строки, не пересоздавая их: введённое и фокус не теряются.
export function linesTable(lines, { columns, onRemove, onChange, onEnter, onLast }) {
  const two = columns.length > 1;
  const root = el("div", {});
  let filterFn = null, rows = [];
  const grid = "grid-template-columns:1fr " + columns.map((c) => c.width || "84px").join(" ") + " 44px";
  function nav(e) {
    if (onEnter && onEnter(e) === true) return;
    const all = [...root.querySelectorAll("input[data-nav]")].filter((x) => x.offsetParent !== null);
    const i = all.indexOf(e.target);
    if (i >= 0 && i < all.length - 1) { all[i + 1].focus(); return; }
    if (onLast) onLast();
  }
  function applyFilter() {
    let n = 0;
    lines.forEach((l, i) => { const r = rows[i]; if (!r) return; const vis = !filterFn || filterFn(l); r.hidden = !vis; if (vis) n++; });
    return n;
  }
  function redraw() {
    root.innerHTML = ""; rows = [];
    if (!lines.length) { root.append(el("div", { class: "dim", style: "padding:10px 0" }, "Добавьте позиции")); return; }
    if (!two) root.append(el("div", { class: "lhead", style: grid }, el("span", {}, "Позиция"),
      ...columns.map((c) => el("span", { class: "num" }, c.title)), el("span", {})));
    lines.forEach((l, idx) => {
      const cells = [el("div", { class: "ln" }, l.name, el("i", {}, [l.unit_id || "", l.note || ""].filter(Boolean).join(" · ")))];
      columns.forEach((c, i) => {
        if (c.input) {
          const inp = qtyInput(l[c.key], (v) => { l[c.key] = v; onChange && onChange(l, c.key, row); },
            { placeholder: two ? null : c.title.toLowerCase(), label: c.title, onEnter: nav });
          cells.push(two ? el("label", { class: "fld c" + i }, el("span", {}, c.title), inp) : inp);
        } else {
          const v = el("div", { class: "num", "data-key": c.key }, c.render ? c.render(l) : fmt(l[c.key]));
          cells.push(two ? el("div", { class: "fld c" + i }, el("span", {}, c.title), v) : (v.classList.add("c" + i), v));
        }
      });
      // Сначала перерисовка, потом onRemove: отбор и счётчики экрана считаются уже по новым строкам.
      cells.push(el("button", { type: "button", class: "x", tabindex: "-1", title: "Убрать строку", "aria-label": "Убрать " + l.name,
        onclick: () => { lines.splice(idx, 1); redraw(); onRemove && onRemove(); } }, "×"));
      const row = two ? el("div", { class: "lrow two" }, ...cells) : el("div", { class: "lrow", style: grid }, ...cells);
      rows.push(row);
      root.append(row);
    });
    applyFilter();
  }
  redraw();
  return {
    root, redraw,
    updateRow(row, l) { for (const c of columns) if (!c.input) { const cell = row.querySelector('[data-key="' + c.key + '"]'); if (cell) cell.textContent = c.render ? c.render(l) : fmt(l[c.key]); } },
    // fn(line) → показывать ли строку; null — все. Возвращает, сколько строк видно.
    setFilter(fn) { filterFn = fn; return applyFilter(); },
    // Перейти к строке позиции: прокрутить к ней, поставить курсор в первое поле, подсветить.
    // false — такой строки нет или она спрятана отбором.
    focusLine(code) {
      const i = lines.findIndex((l) => l.item_code === code);
      const r = rows[i];
      if (!r || r.hidden) return false;
      r.scrollIntoView({ block: "center" });
      const inp = r.querySelector("input"); if (inp) inp.focus({ preventScroll: true });
      r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash");
      setTimeout(() => r.classList.remove("flash"), 1800);
      return true;
    },
  };
}

// ---------------------------------------------------------------- черновики телефона
// Ключ включает пользователя: на общем телефоне точки сменщик не должен видеть и
// дописывать чужой недоделанный документ.
export const DRAFT_PREFIX = "tandem_stock_draft:";
// Пока на экране вход после истёкшей сессии (сессия уже сброшена), открытый сценарий
// дописывает черновик под последним вошедшим, а не под "anon".
let lastUser = null;
const uid = () => { const s = session(); if (s && s.user && s.user.id) lastUser = s.user.id; return lastUser || "anon"; };
// Ключ черновика телефона (client_key для doc_save): заводится вместе с черновиком и живёт в нём.
// По нему сервер узнаёт уже созданный документ, даже если ответ на первый doc_save потерялся.
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
export const drafts = {
  key: (scn, storeId) => DRAFT_PREFIX + uid() + ":" + scn + ":" + storeId,
  load(scn, storeId) { try { return JSON.parse(localStorage.getItem(this.key(scn, storeId)) || "null"); } catch { return null; } },
  save(scn, storeId, data) { try { localStorage.setItem(this.key(scn, storeId), JSON.stringify(data)); } catch {} },
  clear(scn, storeId) { try { localStorage.removeItem(this.key(scn, storeId)); } catch {} },
};
// Выход с телефона стирает черновики всех пользователей и складов: следующий, кто войдёт,
// начинает с чистого экрана.
export function clearDraftsAll() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k); } catch {}
}

// ---------------------------------------------------------------- серверный черновик
// Повторное «Провести» правит тот же серверный документ, а не плодит новые: id, выданный
// первым doc_save, живёт в черновике телефона как server_id, а client_key черновика сервер
// узнаёт и без id. Ответ «не правится» значит, что документ уже проведён: ответ на doc_post
// потерялся или его провели из бэк-офиса. Тогда операция считается выполненной — ответ
// {already: true, number, doc}; showPosted сверяет его строки с черновиком и стирает черновик,
// только если они совпали. Второй документ
// заводится только вместо удалённого (not_found), и под тем же client_key.
export async function saveDoc(d, payload, persist) {
  // Черновик, заведённый до client_key, получает ключ здесь — и в телефон до отправки.
  if (!d.client_key) { d.client_key = newKey(); persist && persist(); }
  const send = (id) => ask("doc_save", { ...payload, id: id || undefined, client_key: d.client_key });
  const anew = () => { d.server_id = null; persist && persist(); return send(null); };
  try {
    return await send(d.server_id);
  } catch (e) {
    if (e.code === "not_found" && d.server_id) return await anew();
    if (!/не правится|уже проведён/i.test(e.message || "")) throw e;
    // id не дошёл до телефона, а документ этого client_key уже проведён: номера не знаем,
    // но и второй раз не проводим.
    if (!d.server_id) return { ok: true, already: true, id: null, number: null, doc: null };
    let g;
    try { g = await ask("doc_get", { id: d.server_id }); }
    catch (e2) { if (e2.code === "not_found") return await anew(); throw e2; }
    if (g.doc.status === "posted") return { ok: true, already: true, id: g.doc.id, number: g.doc.number, doc: g.doc };
    // Проведение успели отменить, пока шёл ответ, — документ снова черновик: правим его.
    return await send(d.server_id);
  }
}

// Проведение с той же страховкой: «уже проведён» после потерянного ответа — не ошибка,
// если doc_get подтверждает, что документ проведён.
export async function postDoc(id) {
  try {
    return await ask("doc_post", { id });
  } catch (e) {
    if (!/уже проведён|не правится/i.test(e.message || "")) throw e;
    const g = await ask("doc_get", { id });
    if (g.doc.status !== "posted") throw e;
    return { ok: true, already: true, id, number: g.doc.number, doc: g.doc };
  }
}

// Документ черновика уже проведён: черновик телефона стирается, человек видит номер и сумму
// проведённого и знает, что второго документа нет. d — черновик телефона: если проведённый документ
// с ним расходится (правки после сохранения, а провели из бэк-офиса исходный), черновик не стирается —
// см. showMismatch.
export function showPosted(ctx, scn, storeId, s, again, d) {
  const diff = d && s.doc ? postedDiff(scn, d.lines, s.doc.lines) : [];
  if (diff.length) return showMismatch(ctx, scn, storeId, s, again, d, diff);
  drafts.clear(scn, storeId);
  const doc = s.doc;
  ctx.result({ title: s.number ? "Документ " + s.number + " уже проведён" : "Документ по этому черновику уже проведён",
    lines: ["Повторно не проводился — второго такого документа нет.",
      doc ? (doc.lines || []).length + " поз., сумма " + fmtMoney(doc.total_sum) + " ₸" : "Номер и строки — в журнале бэк-офиса."],
    again });
}

// Строки черновика телефона против строк проведённого документа, по позициям (повторы позиции
// складываются). Сравнивается количество — у инвентаризации факт, и только пересчитанные на телефоне
// позиции: остальные в акт не шли, и чужой пересчёт — не потерянная правка. У приёмки ещё и цена.
// Пустой список — документ проведён ровно по черновику. add — что войдёт в документ на разницу:
// у инвентаризации ваш факт (он абсолютный), у прочих — недостающее количество; over — проведено
// больше, чем в черновике (отдельным документом того же типа не исправить).
const EPS = 1e-6;
export function postedDiff(scn, draftLines, docLines) {
  const inv = scn === "inventory", f = inv ? "fact_qty" : "qty";
  const group = (list, num, skip) => {
    const m = new Map();
    for (const l of list || []) {
      if (skip && skip(l)) continue;
      const a = m.get(l.item_code) || { l, qty: 0, sum: 0 };
      const q = num(l[f]) || 0;
      a.qty += q; a.sum += q * (num(l.price) || 0); m.set(l.item_code, a);
    }
    return m;
  };
  const mine = group(draftLines, numOf, inv ? (l) => !hasNum(l[f]) : null);
  const done = group(docLines, Number);
  const price = (a) => (a && a.qty > EPS ? a.sum / a.qty : null);
  const out = [];
  for (const code of new Set([...mine.keys(), ...done.keys()])) {
    const m = mine.get(code), p = done.get(code);
    if (inv && !m) continue;
    const mq = m ? m.qty : 0, pq = p ? p.qty : 0;
    const qtyDiff = Math.abs(mq - pq) > EPS;
    const mp = price(m), pp = price(p);
    const priceDiff = scn === "receive" && mp !== null && pp !== null && Math.abs(mp - pp) > 0.005;
    if (!qtyDiff && !priceDiff) continue;
    const base = (m || p).l;
    out.push({ item_code: code, name: base.name || code, unit_id: base.unit_id || "", mine: m ? mq : null, posted: p ? pq : null,
      add: inv ? mq : Math.max(0, Math.round((mq - pq) * 1000) / 1000), over: !inv && pq - mq > EPS,
      price_mine: priceDiff ? mp : null, price_posted: priceDiff ? pp : null, line: m ? m.l : null });
  }
  return out;
}

// Документ провели не в том виде, что на телефоне (V22): черновик НЕ стирается. Два выхода.
// 1) Отменить проведение в бэк-офисе и снова нажать «Провести» — server_id в черновике остался,
//    документ поправится по черновику (это и для «проведено больше», и для другой цены).
// 2) «Оформить разницу» — черновик становится новым документом (свой client_key, без server_id),
//    в нём только недостающее; проведённый остаётся как есть. Второго такого же документа не будет:
//    в разнице нет того, что уже проведено.
function showMismatch(ctx, scn, storeId, s, again, d, diff) {
  const inv = scn === "inventory";
  const q = (r, x) => (x === null ? "нет" : fmt(x) + (r.unit_id ? " " + r.unit_id : ""));
  const rows = diff.map((r) => r.name + ": " + (r.posted === null ? (inv ? "в акте нет" : "в документе нет") : (inv ? "в акте " : "проведено ") + q(r, r.posted))
    + ", у вас " + q(r, r.mine)
    + (r.price_mine !== null ? "; цена в документе " + fmtMoney(r.price_posted) + " ₸, у вас " + fmtMoney(r.price_mine) + " ₸" : ""));
  const add = diff.filter((r) => r.add > EPS);
  const stuck = diff.filter((r) => r.over || r.price_mine !== null);
  const addLines = add.map((r) => inv ? { ...r.line }
    : { item_code: r.item_code, name: r.name, unit_id: r.unit_id, qty: String(r.add), ...(scn === "receive" ? { price: r.line.price } : {}) });
  const doc = s.doc, num = s.number || "документа";
  const lines = [(s.number ? s.number + " провели" : "Документ провели") + " из бэк-офиса: " + (doc.lines || []).length + " поз., сумма "
      + fmtMoney(doc.total_sum) + " ₸. Черновик на телефоне не стёрт.", ...rows,
    "Провести по-вашему целиком: отмените проведение " + num + " в бэк-офисе и снова нажмите «Провести» — документ поправится по черновику."];
  if (add.length) lines.push("Или оформите разницу отдельным документом: " + add.map((r) => r.name + " " + (inv ? "" : "+") + q(r, r.add)).join("; ") + ".");
  const warnings = add.length && stuck.length
    ? ["Разницей не исправить: " + stuck.map((r) => r.name).join(", ") + " — только отменой проведения " + num + " в бэк-офисе."] : [];
  const buttons = [];
  if (add.length) buttons.push({ label: "Оформить разницу", onclick: () => {
    drafts.save(scn, storeId, { ...d, lines: addLines, server_id: null, client_key: newKey() });
    again();
  } });
  buttons.push({ label: "Удалить черновик", ghost: true, onclick: () => {
    if (!window.confirm("Удалить черновик? Ваши правки пропадут, останется проведённый " + num + ".")) return;
    drafts.clear(scn, storeId); ctx.home();
  } });
  ctx.result({ title: "Документ проведён в другом виде — ваши изменения не учтены", bad: true, lines, warnings, buttons, again });
}

// Хвост к сообщению об ошибке: документ на сервере мог сохраниться и даже провестись, но
// повтор его не задвоит (saveDoc/postDoc узнают проведённый) — человеку надо просто повторить.
export function draftHint(number, e) {
  // Хвост про связь — только при настоящем обрыве: на отказ сервера (связь есть, документ — черновик)
  // он путал людей («мог провестись», хотя сервер прямо отказал).
  if (number && e && e.offline) return " — документ " + number + " мог сохраниться или провестись. Когда связь вернётся, нажмите ещё раз: второго документа не будет.";
  if (number) return " — черновик " + number + " сохранён: исправьте и нажмите «Провести» ещё раз.";
  return e && e.offline ? " — черновик остался на телефоне, повторите, когда появится связь." : "";
}

// Комментарий документа для doc_save: пустой — null, а не пустая строка.
export const commentOf = (s) => String(s || "").trim() || null;
// Остаток на складе-отправителе в момент выбора — подписью под названием строки («ост. 8»): видно,
// сколько есть, пока вводишь количество (перемещение, списание). Проверка при проведении всё равно
// идёт по свежему остатку (doc_preview). Остаток неизвестен — подписи нет.
export const stockNote = (q) => (q === null || q === undefined || q === "" || !Number.isFinite(Number(q)) ? "" : "ост. " + fmtQty(q));

export function warningsText(warnings) {
  return warnings && warnings.length ? "Уйдут в минус: " + warnings.map((w) => w.name + " (" + w.store_name + ") → " + fmt(w.balance_after)).join("; ") : "";
}

// ---------------------------------------------------------------- «готовым со склада» после проведения
// Сервер сборки 21 (doc_post → ready_new) говорит, какие позиции этот документ впервые сделал
// «готовыми» на складе точки: их продажа там теперь списывает саму позицию, а не тесто и фарш по
// техкарте. Человек должен это увидеть — иначе «почему не списалась мука» станет загадкой.
// Старый сервер поля не отдаёт — текста нет. Названий — не больше 10 на склад, дальше «и ещё N».
export function readyNewText(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const by = new Map();
  for (const x of list) {
    const k = (x && x.store_name) || "склад";
    if (!by.has(k)) by.set(k, []);
    if (x && x.item_name) by.get(k).push(x.item_name);
  }
  const parts = [...by].map(([s, items]) => "Теперь на складе «" + s + "» продаются готовыми: "
    + items.slice(0, 10).join(", ") + (items.length > 10 ? " и ещё " + (items.length - 10) : "") + ".");
  return parts.join(" ") + " Их продажа там списывает сами позиции, а не сырьё по техкарте."
    + " Список — в бэк-офисе: Склад → Заявки → «Что склады получают готовым».";
}
// Проведение сразу пересобирает до 5 продаж склада (resynced) и говорит, сколько осталось
// (remaining). Остаток добираем тем же действием, что и бэк-офис (stock_ready_resync), частями,
// и показываем ход в box. Не вышло — остаток пересоберёт «Провести продажи за период» в бэк-офисе.
export async function resyncSales(p, box) {
  let total = Number(p && p.resynced) || 0, left = Number(p && p.remaining) || 0;
  if (!left || !box) return;
  const say = (t, more) => { box.innerHTML = ""; box.append(t); if (more) box.append(" ", more); };
  const again = () => el("button", { type: "button", class: "link", onclick: () => resyncSales({ resynced: total, remaining: left }, box) }, "Продолжить пересчёт");
  say("Пересчитываю продажи склада: осталось " + left);
  for (;;) {
    const r = await api("stock_ready_resync", {}, { timeout: LONG_MS });
    if (!r || !r.ok) {
      const why = !r || r.error === "network" ? "нет связи" : (r.message || r.error);
      say("Пересчёт продаж прервался: " + why + ". Остаток пересчитается при «Провести продажи за период» в бэк-офисе.", again());
      return;
    }
    total += Number(r.resynced) || 0;
    left = Number(r.remaining) || 0;
    if (!left) break;
    // Ни одной за вызов — дальше не сдвинется (например, мешает инвентаризация): не крутимся впустую.
    if (!Number(r.resynced)) {
      say("Пересчитано продаж: " + total + ". Ещё " + left + " сейчас не пересчитать — причина видна в бэк-офисе, вкладка «Продажи».", again());
      return;
    }
    say("Пересчитываю продажи склада: осталось " + left);
  }
  say("Продажи склада пересчитаны: " + total);
}
// Что показать под результатом проведения: «готовыми» и ход пересчёта продаж (если есть).
export function readyNotes(p) {
  const t = readyNewText(p && p.ready_new);
  const left = Number(p && p.remaining) || 0;
  if (!t && !left) return [];
  const prog = el("div", { class: "dim", style: "margin-top:6px" });
  const box = el("div", { class: "infobox" }, t || null, prog);
  if (left) setTimeout(() => resyncSales(p, prog), 0);
  return [box];
}

export { el, fmt, fmtMoney, fmtDate, toast, debounce, today, api, session };
