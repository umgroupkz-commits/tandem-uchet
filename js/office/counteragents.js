import { api, can } from "./api.js?v=21";
import { el, toast, debounce, modal, errText, saveFailed } from "./ui.js?v=21";

const KINDS = { supplier: "поставщик", customer: "покупатель", employee: "сотрудник", other: "прочее" };
let root, state = { q: "", kind: "", page: 1 }, table, pager;
// Номер последнего запроса списка: ответ на устаревший поиск не рисуется поверх нового.
let listSeq = 0;

export async function mount(r) {
  root = r;
  state.page = 1;
  const kindSel = el("select", { onchange: (e) => { state.kind = e.target.value; state.page = 1; load(); } },
    el("option", { value: "", selected: state.kind === "" }, "все виды"),
    ...Object.entries(KINDS).map(([v, t]) => el("option", { value: v, selected: v === state.kind }, t)));
  table = el("table"); pager = el("div", { class: "pager" });
  root.append(el("div", { class: "tools" },
      el("input", { placeholder: "Поиск: название или БИН", value: state.q, oninput: debounce((e) => { state.q = e.target.value; state.page = 1; load(); }, 300) }),
      kindSel, can("counteragents", "edit") ? el("button", { onclick: () => edit(null) }, "+ Контрагент") : null),
    el("div", { class: "card", style: "padding:0;overflow:auto" }, table), pager);
  await load();
}

async function load() {
  const n = ++listSeq;
  const r = await api("counteragents_list", { q: state.q, kind: state.kind || null, page: state.page });
  if (n !== listSeq) return;
  if (!r.ok) { toast(errText(r), "bad"); return; }
  table.innerHTML = "";
  table.append(el("tr", {}, ...["Название", "Вид", "БИН/ИИН", "Телефон", ""].map((h) => el("th", {}, h))));
  for (const c of r.rows) {
    table.append(el("tr", { class: "row" + (c.active ? "" : " off"), onclick: () => edit(c) },
      el("td", {}, c.name), el("td", {}, KINDS[c.kind] || c.kind), el("td", {}, c.bin || ""), el("td", {}, c.phone || ""),
      el("td", {}, c.active ? "" : el("span", { class: "tag bad" }, "выключен"))));
  }
  if (!r.rows.length) table.append(el("tr", {}, el("td", { colspan: 5, class: "dim" }, "Ничего не найдено")));
  pager.innerHTML = "";
  pager.append(`всего ${r.total} · стр. ${r.page} из ${r.pages}`,
    el("button", { class: "ghost", disabled: r.page <= 1, onclick: () => { state.page--; load(); } }, "←"),
    el("button", { class: "ghost", disabled: r.page >= r.pages, onclick: () => { state.page++; load(); } }, "→"));
}

function edit(c) {
  const ro = !can("counteragents", "edit");
  const m = modal(c ? c.name : "Новый контрагент", { keep: !ro });
  const f = {
    name: el("input", { value: c ? c.name : "", readonly: ro }),
    kind: el("select", { disabled: ro }, ...Object.entries(KINDS).map(([v, t]) => el("option", { value: v, selected: c ? c.kind === v : v === "supplier" }, t))),
    bin: el("input", { value: c ? c.bin || "" : "", readonly: ro, inputmode: "numeric", autocomplete: "off", placeholder: "12 цифр" }),
    phone: el("input", { value: c ? c.phone || "" : "", readonly: ro }),
    note: el("input", { value: c ? c.note || "" : "", readonly: ro }),
    active: el("input", { type: "checkbox", checked: c ? c.active : true, disabled: ro }),
  };
  const err = el("div", { class: "err" });
  if (!ro) setTimeout(() => f.name.focus(), 0);
  m.root.append(el("div", { class: "grid2" },
      el("div", {}, el("label", {}, "Название"), f.name), el("div", {}, el("label", {}, "Вид"), f.kind),
      el("div", {}, el("label", {}, "БИН/ИИН"), f.bin), el("div", {}, el("label", {}, "Телефон"), f.phone)),
    el("label", {}, "Заметка"), f.note,
    el("div", { class: "actions" }, el("label", {}, f.active, " активен")), err,
    el("div", { class: "actions" },
      ro ? null : el("button", { onclick: async (e) => {
        // БИН/ИИН в Казахстане — ровно 12 цифр; раньше молча сохранялся и БИН из 11 цифр. Проверяем до
        // отправки (сервер проверяет так же). Пробелы из скопированного «1809 4001 2345» убираем; пустое поле — можно.
        const bin = f.bin.value.replace(/\s+/g, "");
        if (bin && !/^[0-9]{12}$/.test(bin)) { err.textContent = "БИН/ИИН — 12 цифр" + (/^[0-9]+$/.test(bin) ? ` (сейчас ${bin.length})` : ""); f.bin.focus(); return; }
        err.textContent = "";
        e.target.disabled = true;   // второе нажатие до ответа заводило дубль контрагента
        const r = await api("counteragent_save", { id: c ? c.id : undefined, name: f.name.value, kind: f.kind.value, bin, phone: f.phone.value, note: f.note.value, active: f.active.checked });
        // новый контрагент после обрыва связи: повтор завёл бы второго — сначала проверить список
        if (!r.ok) { if (saveFailed(r, !c, e.target, err)) load(); return; }
        e.target.disabled = false;
        toast("Сохранено"); m.close(); load();
      } }, "Сохранить"),
      el("button", { class: "ghost", onclick: m.cancel }, ro ? "Закрыть" : "Отмена")));
}
