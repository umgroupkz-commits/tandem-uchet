# Подпроект «Документы склада», план 3б (телефонный экран кладовщика)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Отдельная страница `stock.html` для телефона: вход логином и PIN, выбор склада, три сценария — приёмка, «слепая» инвентаризация, перемещение — поверх готовых RPC раздела «Склад» (спецификация `docs/superpowers/specs/2026-09-05-uchet-stock-design.md`, раздел 7). Бэкенд не меняется.

**Architecture:** Статическая страница в стиле экранов точек (`index.html`): крупные элементы, минимум полей, черновик в `localStorage`. ES-модули `js/stock/*.js` переиспользуют `js/office/api.js` (сессия, вызовы `office_*`) и `js/office/ui.js` (`el`, `fmt`, `toast`, `debounce`). Каждый сценарий — свой модуль с `mount(root, ctx)`; общие части (поиск позиции, плитки частых, ввод количества, черновики, экран результата) — в `js/stock/common.js`.

**Tech Stack:** ванильный JS (ES-модули), CSS без препроцессора, GitHub Pages; RPC `office_stores_list`, `office_counteragents_list`, `office_items_search`, `office_stock_balances`, `office_doc_save`, `office_doc_preview`, `office_doc_post`, `office_doc_get`.

## Global Constraints

- Бэкенд не меняется: ни новых RPC, ни миграций. Все вызовы — через `api()` из `js/office/api.js` (префикс `office_` и токен добавляет она).
- Права: сценарий показывается, если в `session().permissions` есть `doc:invoice_in:edit` (приёмка), `doc:inventory:edit` (инвентаризация), `doc:transfer:edit` (перемещение); без единого — сообщение «У вашей роли нет складских операций».
- «Слепая» инвентаризация: расчётный остаток **не показывается** до нажатия «Провести»; после сохранения черновика показывается сводка расхождений и требуется подтверждение.
- Черновик каждого сценария хранится в `localStorage` по ключу `tandem_stock_draft:<сценарий>:<store_id>` и восстанавливается при повторном открытии; очищается после успешного проведения.
- Элементы управления не меньше 44 px по высоте; поля количества — `type=number`, `inputmode=decimal`; тексты по-русски; никакого `innerHTML` с данными сервера (только `el()`/`textContent`).
- Версия сборки страницы — `?v=1` на `stock.css`, `js/stock/app.js` и в импортах `js/stock/*` друг друга; импорты из `js/office/*` — `?v=3` (текущая сборка бэк-офиса).
- Секреты только в окружении/скретчпаде; тестовые данные — `ZZ_TEST_`, очистка `tandem_test_cleanup`, `leftovers = 0`.
- Коммиты: `git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit`, хвост `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Карта файлов

| Файл | Ответственность |
|------|-----------------|
| `stock.html`, `stock.css` | каркас страницы и стили телефона |
| `js/stock/app.js` | вход, смена временного PIN, выбор склада, меню сценариев по правам, загрузка модулей, экран результата |
| `js/stock/common.js` | `itemPicker` (плитки частых + поиск), `qtyInput`, `drafts` (сохранить/восстановить/очистить), `showResult`, `showWarnings` |
| `js/stock/receive.js` | приёмка: поставщик, позиции, количество и цена, проведение |
| `js/stock/inventory.js` | инвентаризация: позиции с остатком + поиск, факт, сводка расхождений, проведение |
| `js/stock/transfer.js` | перемещение: склад-куда, позиции, количество, проведение |
| `index.html`, `office.html`, `README.md`, спецификация | ссылки на `stock.html`, документация |

Контракты, которые используют модули (все — существующие RPC):
- `stores_list {}` → `{stores:[{id,name,active,point_id,point_name}], points}`
- `counteragents_list {q, kind:'supplier', page:1}` → `{rows:[{id,name}]}`
- `items_search {q, active:true, page:1}` → `{rows:[{code,name,unit_id,item_type}]}`
- `stock_balances {store_id, only_nonzero:true|false, page}` → `{rows:[{item_code,name,unit_id,qty,avg_cost}], pages}`
- `doc_save {doc_type, doc_date, store_to|store_from, counteragent_id?, ext_number?, lines:[{item_code, qty|fact_qty, price?}]}` → `{ok,id,number}`
- `doc_preview {id}` → `{warnings:[{name,store_name,balance_after}], consume}`; `doc_post {id}` → `{ok,warnings,total_sum}`; `doc_get {id}` → `{doc:{lines:[{item_code,name,unit_id,fact_qty,current_qty}]}}`
- Ошибки — `{ok:false, message}`; при `unauthorized` `api()` сама сбрасывает сессию и перезагружает страницу.

---

### Task 1: Каркас `stock.html`: вход, склад, меню, общие части

**Files:**
- Create: `stock.html`, `stock.css`, `js/stock/app.js`, `js/stock/common.js`

**Interfaces:**
- Produces:
  - `app.js`: глобальный контекст `ctx = { store: {id,name}, stores: [...] }`; функция `openScenario(id)`; модуль сценария экспортирует `export async function mount(root, ctx)`; для возврата в меню модуль вызывает `ctx.home()`; после проведения — `ctx.result({title, lines:[...], again:() => …})`.
  - `common.js`:
    - `export function itemPicker({ storeId, onPick, filter })` → `{root, refresh()}` — блок «частые» (позиции из `stock_balances` этого склада, до 12, по алфавиту) + поле поиска с результатами (`items_search`, 8 строк); `onPick({code,name,unit_id,item_type})`; `filter(item) → boolean` — какие можно выбирать.
    - `export function qtyInput(value, onChange, opts={step:"0.001", placeholder:"кол-во"})` → `<input type=number inputmode=decimal>` 48 px.
    - `export const drafts = { key(scn, storeId), load(scn, storeId), save(scn, storeId, data), clear(scn, storeId) }`.
    - `export function linesTable(lines, { columns, onRemove, onChange })` → `{root, redraw()}` — таблица строк с полями по описанию колонок (`{key, title, input:true|false, width}`) без перерисовки инпутов при вводе.
    - `export function warningsText(warnings)` → строка «Уйдут в минус: …» или пустая.

- [ ] **Step 1: stock.html**

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="theme-color" content="#1F3864">
<title>Тандем KZ — склад</title>
<link rel="stylesheet" href="stock.css?v=1">
</head>
<body>
<div id="login" class="screen" hidden>
  <header><h1>Склад · Тандем KZ</h1><div class="sub">Вход для кладовщика · сборка 1</div></header>
  <label for="llogin">Логин</label><input id="llogin" autocomplete="username" autocapitalize="off">
  <label for="lpin">PIN</label><input id="lpin" type="password" inputmode="numeric" autocomplete="current-password">
  <button id="lbtn" class="big">Войти</button>
  <div class="err" id="lerr"></div>
  <a class="link" href="index.html">← отчёт точки</a>
</div>
<div id="pinchange" class="screen" hidden>
  <header><h1>Смените PIN</h1><div class="sub">Временный PIN нужно заменить своим — не меньше 4 цифр.</div></header>
  <label for="npin">Новый PIN</label><input id="npin" type="password" inputmode="numeric">
  <label for="npin2">Ещё раз</label><input id="npin2" type="password" inputmode="numeric">
  <button id="nbtn" class="big">Сохранить</button>
  <div class="err" id="nerr"></div>
</div>
<div id="shell" class="screen" hidden>
  <header class="top">
    <div><div class="brand" id="storename">Склад</div><div class="sub" id="uname"></div></div>
    <button class="link" id="changestore">сменить склад</button>
  </header>
  <main id="main"></main>
</div>
<div id="toast" class="toast" hidden></div>
<script type="module" src="js/stock/app.js?v=1"></script>
</body>
</html>
```

- [ ] **Step 2: stock.css**

```css
:root{--ink:#1B2430;--ink2:#4A5568;--muted:#8A94A6;--line:#E2E7EF;--bg:#F5F7FB;--card:#fff;--accent:#1F3864;--accent2:#3E6EA8;
      --ok:#0B6B4F;--okbg:#E3F3EC;--bad:#B4453C;--badbg:#FBEAE8;--warnbg:#FCF3E1;--warn:#8A6412;--in:#FFFBF0}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.screen{max-width:560px;margin:0 auto;padding:14px 12px 90px}
header{padding-bottom:10px;border-bottom:2px solid var(--accent);margin-bottom:14px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:10px}
h1{font-size:19px;margin:0;color:var(--accent)}.brand{font-weight:700;color:var(--accent);font-size:17px}
.sub{font-size:12.5px;color:var(--muted);margin-top:2px}
label{display:block;font-size:12.5px;color:var(--ink2);margin:12px 0 5px;font-weight:600}
input,select{width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:17px;background:var(--in);color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--accent2);outline-offset:-1px;background:#fff}
button{font:inherit;font-size:16px;font-weight:600;min-height:48px;padding:10px 16px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;width:100%}
button.big{margin-top:16px;font-size:18px;min-height:54px}
button.ghost{background:#fff;color:var(--accent)}
button.link{background:none;border:none;color:var(--accent2);width:auto;min-height:36px;padding:4px 6px;font-weight:500;font-size:14px}
button:disabled{opacity:.5}
.err{color:var(--bad);font-size:14px;margin-top:8px;min-height:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.menu button{display:flex;justify-content:space-between;align-items:center;text-align:left;margin-bottom:10px;min-height:64px;font-size:18px}
.menu button span{font-size:12.5px;color:#DCE4F0;font-weight:400}
.fav{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.fav button{width:auto;flex:0 0 auto;padding:10px 13px;font-size:14px;min-height:44px;background:#EEF2F8;color:var(--accent);border:1px solid #D6DFEC}
.favh{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700;margin-top:10px}
.sres{margin-top:6px;max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;background:#fff}
.sres:empty{display:none}
.sitem{display:flex;justify-content:space-between;width:100%;text-align:left;background:#fff;border:none;border-bottom:1px solid var(--line);border-radius:0;padding:12px;color:var(--ink);font-weight:500;font-size:15px;min-height:44px}
.sitem:last-child{border-bottom:none}.sitem i{font-style:normal;color:var(--muted);font-size:13px}
.lrow{display:grid;gap:6px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.lrow .ln{font-size:14.5px;line-height:1.25}.lrow .ln i{display:block;font-style:normal;font-size:11.5px;color:var(--muted)}
.lrow input{text-align:right;padding:8px 6px;font-size:16px;min-height:44px}
.lrow button.x{width:40px;min-height:40px;padding:0;background:#fff;color:var(--bad);border-color:var(--line);font-size:20px;font-weight:400}
.tot{display:flex;justify-content:space-between;align-items:baseline;padding:12px 14px;background:#EEF2F8;border-radius:10px;margin-top:12px}
.tot span:last-child{font-size:20px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.warnbox{background:var(--warnbg);color:var(--warn);border-radius:10px;padding:10px 12px;margin-top:10px;font-size:14px}
.okbox{background:var(--okbg);color:var(--ok);border-radius:10px;padding:14px;font-size:16px;font-weight:600;margin-top:10px}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:10px 12px;display:flex;gap:8px;max-width:560px;margin:0 auto}
.bar button{margin:0}
.dim{color:var(--muted);font-size:13.5px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 16px;border-radius:9px;font-size:14px;z-index:10;max-width:90%}
.toast.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14.5px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left}th{font-size:11px;text-transform:uppercase;color:var(--muted)}
```

- [ ] **Step 3: js/stock/common.js**

```js
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
```

- [ ] **Step 4: js/stock/app.js**

```js
import { api, session, setSession } from "../office/api.js?v=3";
import { el, toast } from "../office/ui.js?v=3";

const $ = (id) => document.getElementById(id);
const SCENARIOS = [
  { id: "receive", title: "Приёмка", hint: "приход от поставщика", perm: "doc:invoice_in:edit" },
  { id: "inventory", title: "Инвентаризация", hint: "пересчёт склада", perm: "doc:inventory:edit" },
  { id: "transfer", title: "Перемещение", hint: "на другой склад", perm: "doc:transfer:edit" },
];
const ctx = { store: null, stores: [], home, result };
function show(id) { for (const s of ["login", "pinchange", "shell"]) $(s).hidden = s !== id; }
const perms = () => (session() && session().permissions) || [];

async function doLogin() {
  $("lerr").textContent = "";
  const r = await api("login", { login: $("llogin").value, pin: $("lpin").value });
  if (!r.ok) { $("lerr").textContent = r.message || "Не пустило"; return; }
  setSession({ token: r.token, user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin });
  try { localStorage.setItem("tandem_stock_login", $("llogin").value.trim()); } catch {}
  start();
}
async function doChangePin() {
  $("nerr").textContent = "";
  if ($("npin").value !== $("npin2").value) { $("nerr").textContent = "PIN не совпадают"; return; }
  const r = await api("change_pin", { pin: $("npin").value });
  if (!r.ok) { $("nerr").textContent = r.message; return; }
  setSession({ ...session(), must_change_pin: false }); start();
}

async function start() {
  const s = session();
  if (!s) { show("login"); try { $("llogin").value = localStorage.getItem("tandem_stock_login") || ""; } catch {} return; }
  if (s.must_change_pin) { show("pinchange"); return; }
  show("shell");
  $("uname").textContent = s.user.name;
  if (!ctx.stores.length) {
    const r = await api("stores_list", {});
    if (!r.ok) { toast(r.message, "bad"); return; }
    ctx.stores = (r.stores || []).filter((x) => x.active);
  }
  let saved = null; try { saved = localStorage.getItem("tandem_stock_store"); } catch {}
  ctx.store = ctx.stores.find((x) => x.id === saved) || null;
  if (!ctx.store) { chooseStore(); return; }
  home();
}

function chooseStore() {
  $("storename").textContent = "Выберите склад";
  const main = $("main"); main.innerHTML = "";
  const list = el("div", { class: "menu" });
  for (const s of ctx.stores) list.append(el("button", { type: "button", onclick: () => { ctx.store = s; try { localStorage.setItem("tandem_stock_store", s.id); } catch {} home(); } },
    s.name, el("span", {}, s.point_name || "без точки")));
  main.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Склад запомнится на этом телефоне"), list));
}

function home() {
  $("storename").textContent = ctx.store.name;
  const main = $("main"); main.innerHTML = "";
  const menu = el("div", { class: "menu" });
  const allowed = SCENARIOS.filter((x) => perms().includes(x.perm));
  for (const x of allowed) menu.append(el("button", { type: "button", onclick: () => openScenario(x.id) }, x.title, el("span", {}, x.hint)));
  if (!allowed.length) menu.append(el("div", { class: "err" }, "У вашей роли нет складских операций"));
  main.append(menu, el("button", { class: "link", onclick: async () => { await api("logout", {}); setSession(null); location.reload(); } }, "Выйти"));
}

async function openScenario(id) {
  const main = $("main"); main.innerHTML = '<div class="dim">Загрузка…</div>';
  try {
    const mod = await import(`./${id}.js?v=1`);
    main.innerHTML = ""; await mod.mount(main, ctx);
  } catch (e) { main.innerHTML = ""; main.append(el("div", { class: "err" }, "Сценарий не открылся: " + e.message)); }
}

// Экран результата после проведения.
function result({ title, lines = [], again, warnings = [] }) {
  const main = $("main"); main.innerHTML = "";
  main.append(el("div", { class: "okbox" }, title), ...lines.map((t) => el("div", { class: "dim", style: "margin-top:6px" }, t)));
  if (warnings.length) main.append(el("div", { class: "warnbox" }, warnings.join("; ")));
  main.append(el("div", { class: "bar" }, el("button", { onclick: again }, "Ещё"), el("button", { class: "ghost", onclick: home }, "В меню")));
}

$("lbtn").addEventListener("click", doLogin);
$("lpin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("nbtn").addEventListener("click", doChangePin);
$("changestore").addEventListener("click", chooseStore);
(async () => {
  if (session()) { try { const r = await api("me", {}); if (r.ok) setSession({ ...session(), user: r.user, permissions: r.permissions, must_change_pin: r.must_change_pin }); } catch (e) { toast("Нет связи: " + e.message, "bad"); } }
  start();
})();
```

- [ ] **Step 5: Проверка в браузере (мобильный размер)**

`npx --yes serve -l 8077 .`, окно 375×812 (`resize_window` preset mobile), `http://localhost:8077/stock.html`: вход администратором (PIN из скретчпада) → экран выбора склада (28 карточек) → выбор → меню из трёх сценариев (администратор имеет все `doc:*`) → клик по сценарию даёт «Сценарий не открылся» (модулей ещё нет — норма) → «сменить склад» работает → перезагрузка сохраняет склад и вход → «Выйти». Консоль без ошибок кроме 404 на `receive.js`.

- [ ] **Step 6: Commit**

```bash
git add stock.html stock.css js/stock/app.js js/stock/common.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад с телефона: каркас — вход, выбор склада, меню сценариев, общие части

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Сценарий «Приёмка»

**Files:**
- Create: `js/stock/receive.js`

**Interfaces:**
- Consumes: `ctx.store`, `ctx.home()`, `ctx.result(...)`; `itemPicker`, `linesTable`, `drafts`, `warningsText` из `common.js`.
- Produces: `export async function mount(root, ctx)`.

- [ ] **Step 1: Модуль**

```js
import { api, el, fmt, toast, debounce, itemPicker, linesTable, drafts, warningsText } from "./common.js?v=1";

const SCN = "receive";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { supplier: null, ext_number: "", lines: [] };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { supplier: d.supplier, ext_number: d.ext_number, lines });
  // поставщик
  const sup = el("input", { placeholder: "Поставщик: начните вводить", value: d.supplier ? d.supplier.name : "", autocomplete: "off" });
  const supRes = el("div", { class: "sres" });
  sup.addEventListener("input", debounce(async () => {
    d.supplier = null; supRes.innerHTML = ""; const q = sup.value.trim(); if (q.length < 2) return;
    const r = await api("counteragents_list", { q, kind: "supplier", page: 1 });
    for (const c of (r.rows || []).slice(0, 8)) supRes.append(el("button", { type: "button", class: "sitem", onclick: () => { d.supplier = { id: c.id, name: c.name }; sup.value = c.name; supRes.innerHTML = ""; save(); } }, c.name));
  }, 300));
  const ext = el("input", { placeholder: "№ накладной поставщика (необязательно)", value: d.ext_number, oninput: (e) => { d.ext_number = e.target.value; save(); } });
  // строки
  const tot = el("div", { class: "tot" }, el("span", {}, "Сумма прихода"), el("span", {}, "0 ₸"));
  const total = () => { const s = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0); tot.lastChild.textContent = fmt(s) + " ₸"; return s; };
  const table = linesTable(lines, {
    columns: [{ key: "qty", title: "кол-во", input: true, width: "88px" }, { key: "price", title: "цена", input: true, step: "0.01", width: "96px" }, { key: "sum", title: "", render: (l) => fmt((Number(l.qty) || 0) * (Number(l.price) || 0)), width: "76px" }],
    onChange: (l, key, row) => { table.updateRow(row, l); total(); save(); }, onRemove: () => { total(); save(); },
  });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "", price: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", {}, "Поставщик"), sup, supRes, el("label", {}, "Накладная поставщика"), ext),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root, tot),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));
  total();

  async function post() {
    err.textContent = "";
    if (!d.supplier) { err.textContent = "Выберите поставщика из списка"; return; }
    if (!lines.length) { err.textContent = "Добавьте хотя бы одну позицию"; return; }
    const bad = lines.find((l) => !(Number(l.qty) > 0) || !(Number(l.price) >= 0) || l.price === "");
    if (bad) { err.textContent = `Укажите количество и цену: ${bad.name}`; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      const s = await api("doc_save", { doc_type: "invoice_in", doc_date: new Date().toISOString().slice(0, 10), store_to: st.id, counteragent_id: d.supplier.id,
        ext_number: d.ext_number || null, lines: lines.map((l) => ({ item_code: l.item_code, qty: Number(l.qty), price: Number(l.price) })) });
      if (!s.ok) { err.textContent = s.message; return; }
      const p = await api("doc_post", { id: s.id });
      if (!p.ok) { err.textContent = p.message + ` (черновик ${s.number} сохранён в бэк-офисе)`; return; }
      drafts.clear(SCN, st.id);
      ctx.result({ title: `Проведено: ${s.number}`, lines: [`${d.supplier.name} → ${st.name}`, `${lines.length} поз., сумма ${fmt(p.total_sum)} ₸`],
        warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
    } finally { btn.disabled = false; }
  }
}
```
Примечание: `ctx.result` очищает `main`; при `again` — `root` тот же элемент `main`, поэтому перед `mount` его нужно очистить: в начале `mount` добавить `root.innerHTML = "";`.

- [ ] **Step 2: Проверка в браузере (мобильный размер)**

Создать через бэк-офис тестовый склад `ZZ_TEST_склад Т`, поставщика `ZZ_TEST_ИП Т`, товар `ZZ_TEST_товар Т` (кг). На телефоне: выбрать склад → Приёмка → поставщик поиском → позиция поиском (частых нет) → количество 5, цена 120 → сумма 600 → «Провести» → экран «Проведено: ПН-…» с суммой; «Ещё» → чистая форма; повторно добавить позицию, закрыть страницу и открыть — черновик восстановился (поставщик, позиция); частые плитки теперь содержат `ZZ_TEST_товар Т`; попытка провести без цены — понятный текст. В бэк-офисе документ виден проведённым с `ext_number`. Очистка через `tandem_test_cleanup` → `leftovers 0`; черновик в `localStorage` удалить руками (`localStorage.clear()` в консоли).

- [ ] **Step 3: Commit**

```bash
git add js/stock/receive.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад с телефона: приёмка

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Сценарии «Инвентаризация» и «Перемещение»

**Files:**
- Create: `js/stock/inventory.js`, `js/stock/transfer.js`

- [ ] **Step 1: inventory.js**

```js
import { api, el, fmt, toast, itemPicker, linesTable, drafts } from "./common.js?v=1";

const SCN = "inventory";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { lines: [], server_id: null };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { lines, server_id: d.server_id || null });
  // список позиций с остатком — без расчётного количества (слепой подсчёт)
  if (!lines.length) {
    let page = 1, pages = 1;
    do {
      const b = await api("stock_balances", { store_id: st.id, only_nonzero: true, page });
      for (const x of (b.rows || [])) lines.push({ item_code: x.item_code, name: x.name, unit_id: x.unit_id, fact_qty: "" });
      pages = b.pages || 1; page++;
    } while (page <= pages);
    lines.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }
  const table = linesTable(lines, { columns: [{ key: "fact_qty", title: "факт", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, fact_qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("div", { class: "dim" }, "Введите фактическое количество по каждой позиции. Пустое поле — позиция не пересчитывалась и в акт не попадёт."), table.root),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Добавить позицию, которой нет в списке"), picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    const counted = lines.filter((l) => l.fact_qty !== "" && l.fact_qty != null);
    if (!counted.length) { err.textContent = "Ни одна позиция не пересчитана"; return; }
    if (counted.some((l) => Number(l.fact_qty) < 0 || isNaN(Number(l.fact_qty)))) { err.textContent = "Факт не может быть отрицательным"; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      // повторное «Провести» после «Назад к вводу» обновляет тот же серверный черновик, а не плодит новые
      const s = await api("doc_save", { id: d.server_id || undefined, doc_type: "inventory", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id,
        lines: counted.map((l) => ({ item_code: l.item_code, fact_qty: Number(l.fact_qty) })) });
      if (!s.ok) { if (d.server_id) { d.server_id = null; save(); } err.textContent = s.message; return; }
      d.server_id = s.id; drafts.save(SCN, st.id, { lines, server_id: s.id });
      const g = await api("doc_get", { id: s.id });
      if (!g.ok) { err.textContent = g.message; return; }
      // сводка расхождений — только теперь показываем расчёт
      const rows = g.doc.lines.map((l) => ({ name: l.name, unit: l.unit_id, fact: Number(l.fact_qty), calc: Number(l.current_qty || 0) }))
        .map((r) => ({ ...r, diff: r.fact - r.calc })).filter((r) => Math.abs(r.diff) > 1e-9);
      root.innerHTML = "";
      const t = el("table"); t.append(el("tr", {}, el("th", {}, "Позиция"), el("th", { class: "num" }, "Факт"), el("th", { class: "num" }, "Расчёт"), el("th", { class: "num" }, "Разница")));
      for (const r of rows) t.append(el("tr", {}, el("td", {}, r.name, el("i", { class: "dim", style: "display:block;font-style:normal" }, r.unit)), el("td", { class: "num" }, fmt(r.fact)), el("td", { class: "num" }, fmt(r.calc)), el("td", { class: "num", style: r.diff < 0 ? "color:var(--bad)" : "color:var(--ok)" }, (r.diff > 0 ? "+" : "") + fmt(r.diff))));
      root.append(el("div", { class: "card" }, el("div", { class: "favh" }, `Акт ${s.number}: расхождения`), rows.length ? t : el("div", { class: "okbox" }, "Расхождений нет"), el("div", { class: "dim", style: "margin-top:8px" }, `Пересчитано позиций: ${counted.length}`)),
        el("div", { class: "bar" }, el("button", { class: "ghost", onclick: () => mount(root, ctx) }, "Назад к вводу"), el("button", { onclick: async () => {
          const p = await api("doc_post", { id: s.id });
          if (!p.ok) { toast(p.message, "bad"); return; }
          drafts.clear(SCN, st.id);
          ctx.result({ title: `Инвентаризация проведена: ${s.number}`, lines: [`${st.name} · расхождений ${rows.length} · сумма ${fmt(p.total_sum)} ₸`], again: () => mount(root, ctx) });
        } }, "Подтвердить и провести")));
    } finally { btn.disabled = false; }
  }
}
```
Замечание: черновик на сервере создаётся при «Провести» и остаётся в бэк-офисе, если пользователь нажал «Назад к вводу» и не провёл — это допустимо (черновики видны в журнале и удаляются там); повторное «Провести» создаст новый черновик — чтобы не плодить, хранить `d.server_id` и при повторе передавать `id` в `doc_save`.

- [ ] **Step 2: transfer.js**

```js
import { api, el, fmt, toast, itemPicker, linesTable, drafts, warningsText } from "./common.js?v=1";

const SCN = "transfer";
export async function mount(root, ctx) {
  root.innerHTML = "";
  const st = ctx.store;
  const d = drafts.load(SCN, st.id) || { to: "", lines: [] };
  const lines = d.lines;
  const save = () => drafts.save(SCN, st.id, { to: d.to, lines });
  const to = el("select", { onchange: (e) => { d.to = e.target.value; save(); } }, el("option", { value: "" }, "— склад-получатель —"),
    ...ctx.stores.filter((s) => s.id !== st.id).map((s) => el("option", { value: s.id, selected: s.id === d.to }, s.name)));
  const table = linesTable(lines, { columns: [{ key: "qty", title: "кол-во", input: true, width: "110px" }], onChange: save, onRemove: save });
  const picker = itemPicker({ storeId: st.id, onPick: (it) => {
    if (lines.some((l) => l.item_code === it.code)) { toast("Уже в списке"); return; }
    lines.push({ item_code: it.code, name: it.name, unit_id: it.unit_id, qty: "" }); table.redraw(); save();
  } });
  const err = el("div", { class: "err" });
  root.append(el("div", { class: "card" }, el("label", {}, `Откуда: ${st.name}`), el("label", {}, "Куда"), to),
    el("div", { class: "card" }, el("div", { class: "favh" }, "Позиции"), table.root),
    el("div", { class: "card" }, picker.root), err,
    el("div", { class: "bar" }, el("button", { class: "ghost", onclick: ctx.home }, "В меню"), el("button", { id: "post", onclick: post }, "Провести")));

  async function post() {
    err.textContent = "";
    if (!d.to) { err.textContent = "Выберите склад-получатель"; return; }
    if (!lines.length) { err.textContent = "Добавьте позиции"; return; }
    const bad = lines.find((l) => !(Number(l.qty) > 0));
    if (bad) { err.textContent = `Укажите количество: ${bad.name}`; return; }
    const btn = document.getElementById("post"); btn.disabled = true;
    try {
      const s = await api("doc_save", { doc_type: "transfer", doc_date: new Date().toISOString().slice(0, 10), store_from: st.id, store_to: d.to,
        lines: lines.map((l) => ({ item_code: l.item_code, qty: Number(l.qty) })) });
      if (!s.ok) { err.textContent = s.message; return; }
      const pv = await api("doc_preview", { id: s.id });
      const wt = pv.ok ? warningsText(pv.warnings) : "";
      if (wt && !window.confirm(wt + "\nПровести всё равно?")) { toast(`Черновик ${s.number} сохранён в бэк-офисе`); return; }
      const p = await api("doc_post", { id: s.id });
      if (!p.ok) { err.textContent = p.message; return; }
      drafts.clear(SCN, st.id);
      const toName = (ctx.stores.find((x) => x.id === d.to) || {}).name || "";
      ctx.result({ title: `Перемещение проведено: ${s.number}`, lines: [`${st.name} → ${toName}`, `${lines.length} поз., сумма ${fmt(p.total_sum)} ₸`],
        warnings: warningsText(p.warnings) ? [warningsText(p.warnings)] : [], again: () => mount(root, ctx) });
    } finally { btn.disabled = false; }
  }
}
```

- [ ] **Step 3: Проверка в браузере (мобильный размер)**

На тестовом складе с остатком (приход из Task 2 или новый): Инвентаризация — список позиций без расчёта, ввод факта у одной, «Провести» → сводка с расчётом и разницей → «Назад к вводу» (черновик остался в журнале бэк-офиса) → снова «Провести» → «Подтвердить» → результат; в бэк-офисе `ИН-…` проведён с `calc_qty`. Перемещение — на второй тестовый склад, количество больше остатка → `confirm` с предупреждением → провести → результат с предупреждением; в бэк-офисе остатки обоих складов. Очистка `tandem_test_cleanup`, `localStorage.clear()`.

- [ ] **Step 4: Commit**

```bash
git add js/stock/inventory.js js/stock/transfer.js
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад с телефона: слепая инвентаризация со сводкой расхождений и перемещение

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Ссылки, документация, полный прогон

**Files:**
- Modify: `index.html` (под ссылкой на бэк-офис — `<a class="link" href="stock.html">Склад с телефона — приёмка, инвентаризация</a>`), `office.html` (в шапке рядом с «Выйти» — ссылка `stock.html` «Телефон»), `README.md`, спецификация склада (раздел «Уточнения», пункт про 3б: черновик на сервере при «Назад к вводу», `confirm` для минусов в перемещении, частые — из остатков склада, а не из последних приходов — уточнение к §7).

- [ ] **Step 1: Правки и прогон** — `node tools/office-smoke.mjs all` (бэкенд не менялся, должно быть 206/0, «очистка: следов нет»); локально `stock.html` и `index.html` открываются, ссылки ведут куда надо; `office.html` без 404.
- [ ] **Step 2: Commit**

```bash
git add index.html office.html README.md docs/superpowers/specs/2026-09-05-uchet-stock-design.md
git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit -m "Склад с телефона: ссылки, README, уточнения спецификации

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Слияние в `main` — контроллер после финального ревью ветки.
