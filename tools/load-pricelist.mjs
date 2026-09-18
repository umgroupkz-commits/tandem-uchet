// Загрузка «Сводного прейскуранта» iiko (Excel): цены по точкам и себестоимость сырья без цены.
// Запуск: node tools/load-pricelist.mjs "<файл.xlsx>" [--dry]
// Нужен TANDEM_SERVICE_KEY. Сопоставление — по артикулу (действие sync_prices), себестоимость —
// действием migrate/costs и только тем товарам, у которых учётной цены ещё нет (её передаёт
// вызывающий списком кодов через office_items_search не нужно: фильтр делает сервер по source).
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { createRequire } from "module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XLSX = createRequire(import.meta.url)(path.join(root, "vendor/xlsx.full.min.js"));
const UCHET = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const KEY = process.env.TANDEM_SERVICE_KEY || "";
const file = process.argv[2], DRY = process.argv.includes("--dry");
if (!file) { console.error("укажите файл прейскуранта"); process.exit(2); }
if (!KEY && !DRY) { console.error("TANDEM_SERVICE_KEY не задан"); process.exit(2); }
// Подразделение прейскуранта → наши точки. Подтверждено Андреем 19.09.2026; «Алиханова 5» и «ВТУЗ»
// точек у нас не имеют, «Аян» в прейскуранте отдельно не выделен.
const DEPS = [[/ЕНЕШКА/i, ["eneshka"]], [/^Буфеты/i, ["univer_b", "kmk"]], [/Тандем Университет/i, ["univer_s"]], [/^Актау/i, ["aktau"]]];
const call = async (action, payload) => (await fetch(UCHET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) })).json();
const num = (v) => { const s = String(v).replace(/\s/g, "").replace(",", "."); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };

const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
const a = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
const h = a.findIndex((r) => String(r[0]).trim() === "Блюдо" && /Артикул/i.test(String(r[2])));
if (h < 0) { console.error("не нашёл строку заголовка «Блюдо … Артикул»"); process.exit(1); }
const date = (String(a[0][0]).match(/(\d{2})\.(\d{2})\.(\d{4})/) || []).slice(1).reverse().join("-") || new Date().toISOString().slice(0, 10);
// Колонка подразделения — первая его «Цена, тг.» (базовый прейскурант); себестоимость — ближайшая «Себест.» справа.
const cols = [];
a[h].forEach((v, c) => { const dep = DEPS.find(([re]) => re.test(String(v))); if (String(v).trim() && c >= 3) {
  let cost = c; while (cost < a[h + 1].length && !/Себест/i.test(String(a[h + 1][cost]))) cost++;
  cols.push({ name: String(v).trim(), price: c, cost, points: dep ? dep[1] : [] }); } });
console.log("дата прейскуранта " + date + "; подразделения: " + cols.map((c) => c.name + (c.points.length ? " → " + c.points.join(",") : " → пропуск")).join("; "));
const prices = [], costs = new Map();
for (const r of a.slice(h + 3)) {
  const art = String(r[2]).trim(); if (!art || /^Группа:/.test(String(r[0]))) continue;
  for (const c of cols) { const p = num(r[c.price]); if (p > 0) for (const pt of c.points) prices.push({ pt, a: art, p }); const k = num(r[c.cost]); if (k > 0 && !costs.has(art)) costs.set(art, k); }
}
console.log(`строк цен по точкам: ${prices.length}, позиций с себестоимостью: ${costs.size}`);
fs.writeFileSync(path.join(root, "data/pricelist_costs.json"), JSON.stringify({ date, costs: [...costs] }));
if (DRY) process.exit(0);
let loaded = 0, unmatched = 0;
for (let i = 0; i < prices.length; i += 1000) {
  const r = await call("sync_prices", { service_key: KEY, data: prices.slice(i, i + 1000) });
  if (!r.ok) { console.error("sync_prices:", r); process.exit(1); }
  loaded += r.loaded; unmatched += r.unmatched;
}
console.log(`цены по точкам: загружено ${loaded}, без пары по артикулу ${unmatched}`);
