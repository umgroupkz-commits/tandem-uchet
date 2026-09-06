import { api } from "../office/api.js?v=3";
import { el, fmt, toast, debounce } from "../office/ui.js?v=3";

// Плитки частых позиций склада (те, что уже двигались на нём) + поиск по номенклатуре.
export function itemPicker({ storeId, onPick, filter = () => true }) {
  const fav = el("div", { class: "fav" });
  const search = el("input", { placeholder: "Поиск: название или код", autocomplete: "off" });
  const res = el("div", { class: "sres" });
  const root = el("div", {}, el("div", { class: "favh" }, "Частые на этом складе"), fav, el("label", {}, "Найти позицию"), search, res);
  async function refresh() {
    fav.innerHTML = "";
    const b = await api("stock_balances", { store_id: storeId, only_nonzero: false, page: 1 });
    const items = (b.rows || []).filter((x) => filter({ code: x.item_code, name: x.name, unit_id: x.unit_id, item_type: x.item_type }))
      .sort((a, c) => a.name.localeCompare(c.name, "ru")).slice(0, 12);
    for (const x of items) fav.append(el("button", { type: "button", onclick: () => onPick({ code: x.item_code, name: x.name, unit_id: x.unit_id }) }, x.name));
    if (!items.length) fav.append(el("span", { class: "dim" }, "пока пусто — найдите позицию поиском"));
  }
  search.addEventListener("input", debounce(async () => {
    res.innerHTML = ""; const q = search.value.trim(); if (q.length < 2) return;
    const s = await api("items_search", { q, active: true, page: 1 });
    for (const it of (s.rows || []).filter(filter).slice(0, 8)) {
      res.append(el("button", { type: "button", class: "sitem", onclick: () => { onPick({ code: it.code, name: it.name, unit_id: it.unit_id, item_type: it.item_type }); search.value = ""; res.innerHTML = ""; } },
        it.name, el("i", {}, it.unit_id)));
    }
    if (!res.children.length) res.append(el("div", { class: "sitem dim" }, "Не найдено"));
  }, 300));
  refresh();
  return { root, refresh };
}

export function qtyInput(value, onChange, opts = {}) {
  return el("input", { type: "number", inputmode: "decimal", step: opts.step || "0.001", min: "0", placeholder: opts.placeholder || "кол-во",
    value: value ?? "", oninput: (e) => onChange(e.target.value) });
}

// Строки документа: инпуты не пересоздаются при вводе — перерисовываются только суммы.
export function linesTable(lines, { columns, onRemove, onChange }) {
  const root = el("div", {});
  function redraw() {
    root.innerHTML = "";
    if (!lines.length) { root.append(el("div", { class: "dim", style: "padding:10px 0" }, "Добавьте позиции")); return; }
    lines.forEach((l, idx) => {
      const cells = [el("div", { class: "ln" }, l.name, el("i", {}, l.unit_id || ""))];
      for (const c of columns) {
        if (c.input) cells.push(qtyInput(l[c.key], (v) => { l[c.key] = v; onChange && onChange(l, c.key, row); }, { step: c.step, placeholder: c.title }));
        else cells.push(el("div", { class: "num", "data-key": c.key }, c.render ? c.render(l) : fmt(l[c.key])));
      }
      cells.push(el("button", { type: "button", class: "x", onclick: () => { lines.splice(idx, 1); onRemove && onRemove(); redraw(); } }, "×"));
      const row = el("div", { class: "lrow", style: `grid-template-columns:1fr ${columns.map((c) => c.width || "84px").join(" ")} 40px` }, ...cells);
      root.append(row);
    });
  }
  redraw();
  return { root, redraw, updateRow(row, l) { for (const c of columns) if (!c.input) { const cell = row.querySelector(`[data-key="${c.key}"]`); if (cell) cell.textContent = c.render ? c.render(l) : fmt(l[c.key]); } } };
}

export const drafts = {
  key: (scn, storeId) => `tandem_stock_draft:${scn}:${storeId}`,
  load(scn, storeId) { try { return JSON.parse(localStorage.getItem(this.key(scn, storeId)) || "null"); } catch { return null; } },
  save(scn, storeId, data) { try { localStorage.setItem(this.key(scn, storeId), JSON.stringify(data)); } catch {} },
  clear(scn, storeId) { try { localStorage.removeItem(this.key(scn, storeId)); } catch {} },
};

export function warningsText(warnings) {
  return warnings && warnings.length ? "Уйдут в минус: " + warnings.map((w) => `${w.name} (${w.store_name}) → ${fmt(w.balance_after)}`).join("; ") : "";
}
export { el, fmt, toast, debounce, api };
