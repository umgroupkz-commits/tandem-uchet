// Ввод чисел, даты для людей и поиск позиции — общие для форм бэк-офиса (документы склада, техкарта).
// Числовое поле браузера (type=number) здесь не годится: в Chrome с английским интерфейсом запятая
// в нём молча пропадает (0,065 → 65), колёсико мыши меняет число под курсором (2900 → 2899,999),
// а щелчок ставит каретку в начало, и набранное дописывается к старому (0,06 → 650,06).
import { api } from "./api.js?v=21";
import { el, debounce } from "./ui.js?v=21";

// Разбор числа, как его пишут люди: «1 234,5», «1234.5», «0,065», неразрывные пробелы из Excel.
// Пусто — null; не число — NaN (форма решает, ругаться ли).
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v).replace(/[\s  ]/g, "").replace(",", ".");
  if (s === "") return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}
// Число для поля ввода: с запятой, без разрядов и без хвоста плавающей точки (0.1+0.2 → «0,3»).
export function numStr(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : parseNum(v);
  if (n === null || Number.isNaN(n)) return String(v);
  return String(Math.round(n * 1e6) / 1e6).replace(".", ",");
}

// Поле для количества или цены. Значение при входе выделяется целиком (набор заменяет, а не
// дописывает), Enter зовёт onEnter (форма переводит фокус дальше), колёсико ничего не меняет.
// o: { value, readonly, onInput(text, num), onEnter(event), placeholder, title, width, attrs }.
// Прочитать число: parseNum(input.value).
export function numInput(o = {}) {
  const inp = el("input", {
    type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false",
    value: numStr(o.value), readonly: !!o.readonly, placeholder: o.placeholder || null, title: o.title || null,
    style: "text-align:right;padding:6px" + (o.width ? ";width:" + o.width : ""), ...(o.attrs || {}),
  });
  inp.classList.add("num-in");
  // Выделение после щелчка мышью: mouseup иначе тут же снимает выделение, сделанное в focus.
  let justFocused = false;
  inp.addEventListener("focus", () => { if (inp.readOnly) return; justFocused = true; inp.select(); });
  inp.addEventListener("mouseup", (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });
  inp.addEventListener("blur", () => { justFocused = false; });
  inp.addEventListener("input", () => {
    // Буквы и прочий мусор не пускаем: остаются цифры, запятая, точка, минус и пробелы.
    const clean = inp.value.replace(/[^\d.,\-\s ]/g, "");
    if (clean !== inp.value) { const p = inp.selectionStart - (inp.value.length - clean.length); inp.value = clean; try { inp.setSelectionRange(p, p); } catch {} }
    if (o.onInput) o.onInput(inp.value, parseNum(inp.value));
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && o.onEnter) { e.preventDefault(); o.onEnter(e); }
  });
  return inp;
}

// Перевод фокуса по Enter внутри формы: следующее поле с атрибутом data-nav в порядке документа.
// С последнего — last() (например, в поиск следующей позиции). Возвращает обработчик для onEnter.
export function enterNext(container, last) {
  return (e) => {
    const all = [...container.querySelectorAll("[data-nav]")].filter((x) => !x.disabled && !x.readOnly && x.offsetParent !== null);
    const i = all.indexOf(e.target);
    if (i >= 0 && i < all.length - 1) { all[i + 1].focus(); return; }
    if (last) last();
  };
}

// Даты для людей: 02.10.2026, а не 2026-10-02. Принимает «YYYY-MM-DD», отметку времени или Date.
export function fmtDate(v) {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}
export function fmtDateTime(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
// Деньги с копейками всегда: «105 649,10 ₸», как на бумаге, а не «105 649,1».
export function fmtMoney(n) {
  if (n === null || n === undefined || n === "") return "";
  return Number(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Поиск позиции для строки документа или техкарты. До limit результатов со скроллом; в строке —
// название, артикул (код iiko), группа и единица; выбор стрелками и Enter или мышью; Esc закрывает.
// o: { types: ['goods','prepared','dish',…] | null, limit = 30, placeholder, exclude(it) → true — не показывать,
//      onPick(it), focusAfter }. Возвращает { root, input, focus(), clear() }.
// Сервер (items_search) сам фильтрует по types и ставит выше совпадения с начала названия и слова;
// здесь то же повторено на случай старого сервера — порядок от этого не портится.
// o.store_id — склад-отправитель (перемещение, списание): сервер отдаёт остаток stock_qty и ставит
// позиции с остатком выше; в строке результата виден остаток. Enter, нажатый раньше, чем пришёл
// ответ, не теряется: как в iiko, выбирается первая строка, как только список появится.
export function itemPicker(o = {}) {
  const limit = o.limit || 30;
  const input = el("input", { placeholder: o.placeholder || "Добавить позицию: название или код", "data-nodirty": "", autocomplete: "off" });
  const res = el("div", { class: "sres" });
  const root = el("div", { class: "sbox" }, input, res);
  let rows = [], hl = -1, seq = 0, pendingEnter = false, loading = false;
  const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  function rank(it, q) {
    const n = String(it.name || "").toLowerCase(), w = words(q), a = String(it.artikul || "").toLowerCase();
    if (n === q.toLowerCase() || a === q.toLowerCase()) return 0;
    if (n.startsWith(w[0] || "")) return 1;
    if (n.split(/[\s,.()«»"-]+/).some((x) => x.startsWith(w[0] || ""))) return 2;
    return 3;
  }
  function draw() {
    res.innerHTML = "";
    rows.forEach((it, i) => {
      const stock = it.stock_qty !== undefined && it.stock_qty !== null
        ? "ост. " + String(Math.round(Number(it.stock_qty) * 1000) / 1000).replace(".", ",") : null;
      const meta = [it.artikul ? "код " + it.artikul : null, it.group_name || null, it.unit_id || null, stock].filter(Boolean).join(" · ");
      const b = el("button", { type: "button", class: "sitem" + (i === hl ? " hl" : ""), tabindex: "-1",
        onmousedown: (e) => e.preventDefault(), onclick: () => pick(i) },
        it.name, meta ? el("span", { class: "dim" }, "  " + meta) : null);
      res.append(b);
    });
    const cur = res.children[hl]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function pick(i) {
    const it = rows[i]; if (!it) return;
    clear();
    if (o.onPick) o.onPick(it);
  }
  function clear() { input.value = ""; rows = []; hl = -1; res.innerHTML = ""; pendingEnter = false; }
  const run = debounce(async () => {
    const q = input.value.trim(); const n = ++seq;
    if (q.length < 2) { rows = []; hl = -1; loading = false; draw(); return; }
    loading = true;
    const storeId = typeof o.store_id === "function" ? o.store_id() : o.store_id;
    const s = await api("items_search", { q, active: true, page: 1, limit, types: o.types || null, store_id: storeId || null });
    if (n !== seq) return;
    loading = false;
    let list = (s.rows || []).filter((it) => !o.types || !it.item_type || o.types.includes(it.item_type));
    if (o.exclude) list = list.filter((it) => !o.exclude(it));
    // Точное совпадение — первым (как на сервере), затем с остатком на складе-отправителе (если сервер
    // отдал stock_qty), затем по совпадению названия.
    const has = (it) => (it.stock_qty !== undefined && it.stock_qty !== null && Number(it.stock_qty) > 0 ? 0 : 1);
    list = list.map((it, i) => ({ it, i, r: rank(it, q), s: storeId ? has(it) : 0 }))
      .sort((a, b) => (a.r === 0 ? 0 : 1) - (b.r === 0 ? 0 : 1) || a.s - b.s || a.r - b.r || a.i - b.i).map((x) => x.it).slice(0, limit);
    rows = list; hl = rows.length ? 0 : -1; draw();
    if (!rows.length) { pendingEnter = false; if (buffer) { input.value += buffer; buffer = ""; } res.append(el("div", { class: "dim", style: "padding:9px 12px" }, "Ничего не найдено")); return; }
    if (pendingEnter) {
      pendingEnter = false; pick(0);
      // Цифры, набранные после Enter до прихода списка, — это уже количество: отдаём их полю, куда
      // форма перевела фокус после выбора позиции.
      const typed = buffer; buffer = "";
      if (typed) setTimeout(() => {
        const t = document.activeElement;
        if (t && t !== input && t.tagName === "INPUT" && !t.readOnly) { t.value = typed; t.dispatchEvent(new Event("input", { bubbles: true })); }
      }, 0);
    }
  }, 250);
  let buffer = "";
  input.addEventListener("input", () => { pendingEnter = false; loading = input.value.trim().length >= 2; run(); });
  input.addEventListener("keydown", (e) => {
    if (pendingEnter && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); buffer += e.key; return; }
    if (pendingEnter && e.key === "Backspace") { e.preventDefault(); buffer = buffer.slice(0, -1); return; }
    if (e.key === "ArrowDown" && rows.length) { e.preventDefault(); hl = (hl + 1) % rows.length; draw(); }
    else if (e.key === "ArrowUp" && rows.length) { e.preventDefault(); hl = (hl - 1 + rows.length) % rows.length; draw(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // Список ещё не пришёл (набрали быстро и сразу Enter) — выберем первую строку, когда придёт.
      if (loading) { pendingEnter = true; return; }
      if (rows.length) pick(hl >= 0 ? hl : 0);
    }
    else if (e.key === "Escape" && rows.length) { e.preventDefault(); e.stopPropagation(); rows = []; hl = -1; draw(); }
  });
  return { root, input, focus: () => input.focus(), clear };
}
