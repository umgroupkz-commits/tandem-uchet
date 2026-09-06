import { api, session } from "../office/api.js?v=3";
import { el, fmt, toast, debounce } from "../office/ui.js?v=3";

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
    // fetch не дошёл до сервера (офлайн, DNS, обрыв). Исходное исключение остаётся в cause.
    const w = new Error("Нет связи с сервером");
    w.cause = e; w.offline = true;
    throw w;
  }
  if (!r.ok) { const e = new Error(r.message || "Ошибка сервера"); e.code = r.error || ""; throw e; }
  return r;
}

// Кнопка блокируется на время запроса и разблокируется всегда — даже когда fn упала.
export async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

// ---------------------------------------------------------------- числа с телефона
// Ru-раскладка на телефоне даёт запятую, а Number("1,5") — NaN; type=number с запятой
// вообще отдаёт пустой value. Поэтому поля количества текстовые, а нормализация — здесь.
export function normNum(v) { return String(v === null || v === undefined ? "" : v).replace(",", ".").trim(); }
export function numOf(v) { return Number(normNum(v)); }
export function hasNum(v) { return normNum(v) !== ""; }
export function okNum(v) { const s = normNum(v); return s !== "" && Number.isFinite(Number(s)) && Number(s) >= 0; }

export function qtyInput(value, onChange, opts) {
  const o = opts || {};
  return el("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: o.class || null,
    placeholder: o.placeholder || "кол-во", value: value === null || value === undefined ? "" : value,
    oninput: (e) => onChange(e.target.value) });
}

// ---------------------------------------------------------------- подбор позиций
let pickSeq = 0;
// Плитки частых позиций склада (те, что уже двигались на нём) + поиск по номенклатуре.
export function itemPicker({ storeId, onPick, filter = () => true }) {
  const fav = el("div", { class: "fav" });
  const perr = el("div", { class: "err" });
  const sid = "pick" + (++pickSeq);
  const search = el("input", { id: sid, placeholder: "Поиск: название или код", autocomplete: "off" });
  const res = el("div", { class: "sres" });
  const root = el("div", {}, el("div", { class: "favh" }, "Частые на этом складе"), fav, perr,
    el("label", { for: sid }, "Найти позицию"), search, res);
  async function refresh() {
    fav.innerHTML = ""; perr.textContent = "";
    try {
      const b = await ask("stock_balances", { store_id: storeId, only_nonzero: false, page: 1 });
      // stock_balances отдаёт остаток, а не карточку номенклатуры: поля item_type в нём нет,
      // поэтому фильтр здесь получает только код, название и единицу. Отбирать плитки по типу
      // позиции нельзя — для этого понадобился бы отдельный запрос к номенклатуре.
      const items = (b.rows || []).filter((x) => filter({ code: x.item_code, name: x.name, unit_id: x.unit_id }))
        .sort((a, c) => a.name.localeCompare(c.name, "ru")).slice(0, 12);
      for (const x of items) fav.append(el("button", { type: "button", onclick: () => onPick({ code: x.item_code, name: x.name, unit_id: x.unit_id, avg_cost: x.avg_cost }) }, x.name));
      if (!items.length) fav.append(el("span", { class: "dim" }, "пока пусто — найдите позицию поиском"));
    } catch (e) {
      perr.textContent = "Частые позиции не загрузились: " + e.message;
      fav.append(el("button", { type: "button", onclick: refresh }, "Повторить"));
    }
  }
  search.addEventListener("input", debounce(async () => {
    res.innerHTML = ""; perr.textContent = ""; const q = search.value.trim(); if (q.length < 2) return;
    try {
      const s = await ask("items_search", { q, active: true, page: 1 });
      for (const it of (s.rows || []).filter(filter).slice(0, 8)) {
        res.append(el("button", { type: "button", class: "sitem", onclick: () => { onPick({ code: it.code, name: it.name, unit_id: it.unit_id }); search.value = ""; res.innerHTML = ""; } },
          it.name, el("i", {}, it.unit_id)));
      }
      if (!res.children.length) res.append(el("div", { class: "sitem dim" }, "Не найдено"));
    } catch (e) { perr.textContent = "Поиск не сработал: " + e.message; }
  }, 300));
  refresh();
  return { root, refresh };
}

// ---------------------------------------------------------------- строки документа
// Инпуты не пересоздаются при вводе — перерисовываются только суммы.
// Одна колонка (инвентаризация, перемещение) — строка в один ряд; несколько колонок
// (приёмка) — название на своей строке, поля под ним: иначе на 360 px не помещается.
export function linesTable(lines, { columns, onRemove, onChange }) {
  const two = columns.length > 1;
  const root = el("div", {});
  function redraw() {
    root.innerHTML = "";
    if (!lines.length) { root.append(el("div", { class: "dim", style: "padding:10px 0" }, "Добавьте позиции")); return; }
    lines.forEach((l, idx) => {
      const cells = [el("div", { class: "ln" }, l.name, el("i", {}, l.unit_id || ""))];
      columns.forEach((c, i) => {
        if (c.input) cells.push(qtyInput(l[c.key], (v) => { l[c.key] = v; onChange && onChange(l, c.key, row); }, { placeholder: c.title, class: "c" + i }));
        else cells.push(el("div", { class: "num c" + i, "data-key": c.key }, c.render ? c.render(l) : fmt(l[c.key])));
      });
      cells.push(el("button", { type: "button", class: "x", onclick: () => { lines.splice(idx, 1); onRemove && onRemove(); redraw(); } }, "×"));
      const row = two ? el("div", { class: "lrow two" }, ...cells)
        : el("div", { class: "lrow", style: "grid-template-columns:1fr " + columns.map((c) => c.width || "84px").join(" ") + " 44px" }, ...cells);
      root.append(row);
    });
  }
  redraw();
  return { root, redraw, updateRow(row, l) { for (const c of columns) if (!c.input) { const cell = row.querySelector('[data-key="' + c.key + '"]'); if (cell) cell.textContent = c.render ? c.render(l) : fmt(l[c.key]); } } };
}

// ---------------------------------------------------------------- черновики телефона
// Ключ включает пользователя: на общем телефоне точки сменщик не должен видеть и
// дописывать чужой недоделанный документ.
export const DRAFT_PREFIX = "tandem_stock_draft:";
const uid = () => { const s = session(); return (s && s.user && s.user.id) || "anon"; };
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
// первым doc_save, живёт в черновике телефона как server_id. Если сервер этот документ
// потерял или его уже провели из бэк-офиса — сохраняем заново, без id.
export async function saveDoc(d, payload, persist) {
  try {
    return await ask("doc_save", { ...payload, id: d.server_id || undefined });
  } catch (e) {
    if (d.server_id && (e.code === "not_found" || /не правится/i.test(e.message || ""))) {
      d.server_id = null; persist && persist();
      return await ask("doc_save", { ...payload, id: undefined });
    }
    throw e;
  }
}

// Хвост к сообщению об ошибке проведения: черновик на сервере уже есть, повтор его не
// задвоит, но человек должен знать, что документ в журнале появился.
export function draftHint(number) {
  return number ? " Документ " + number + " мог сохраниться — проверьте журнал в бэк-офисе перед повтором." : "";
}

export function warningsText(warnings) {
  return warnings && warnings.length ? "Уйдут в минус: " + warnings.map((w) => w.name + " (" + w.store_name + ") → " + fmt(w.balance_after)).join("; ") : "";
}
export { el, fmt, toast, debounce, api, session };
