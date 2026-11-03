// Выгрузка действующих технологических карт всех п/ф из iiko для Excel (только чтение iiko, в учёт ничего не пишет).
// П/ф - это тип «заготовка» (PREPARED), позиции групп с «п/ф» в названии («Блюда ПФ», «Выпечка Пф») и позиции с «п/ф»
// в собственном названии («Соус карри ПФ»). Карта берётся та, что действует на сегодня; следующая версия - пометкой.
// Свежий список товаров кладётся в data/iiko/export_<дата>/, а не в data/iiko/products.json: иначе обновление учёта
// перед запуском не увидело бы, какие карты изменились. Карта скачивается, только если assemblyChartModifiedAt
// отличается от прошлой выгрузки; остальные читаются из data/iiko/charts.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET.
// Запуск: node tools/iiko-charts-export.mjs [--from-cache]   Дальше: python tools/iiko-charts-xlsx.py <файл.xlsx>
import fs from "node:fs";

const IIKO = "https://api-ru.iiko.services";
const BASE = "data/iiko", CHARTS = BASE + "/charts";
const local = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const OUT = `${BASE}/export_${local}`;
const FROM_CACHE = process.argv.includes("--from-cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT + "/charts", { recursive: true });

let token = null;
async function auth() {
  const r = await fetch(IIKO + "/api/v2/access_token", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.IIKO_API_KEY, appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET }) });
  const j = await r.json(); if (!j.token) throw new Error("нет токена: " + JSON.stringify(j).slice(0, 200));
  token = j.token;
}
async function iiko(path, body) {
  let wait = 5000;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(IIKO + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body ?? {}) });
    if (r.status === 429 || r.status >= 500) { console.log(`  HTTP ${r.status}, жду ${wait / 1000} с`); await sleep(wait); wait = Math.min(wait * 2, 120000); continue; }
    if (r.status === 401) { await auth(); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + t.slice(0, 200));
    return JSON.parse(t);
  }
  throw new Error(path + ": iiko не отвечает");
}
async function paged(path, keys) {
  let all = [];
  for (let off = 0; off < 50000; off += 500) {
    const j = await iiko(path, { limit: 500, offset: off });
    const chunk = keys.map((k) => j[k]).find(Array.isArray) || [];
    all = all.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1400);
  }
  return all;
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

const old = read(BASE + "/products.json");
let products, groups, units;
if (FROM_CACHE) { products = read(OUT + "/products.json"); groups = read(OUT + "/groups.json"); units = read(OUT + "/units.json"); }
else {
  await auth();
  units = (await iiko("/api/inventory/v1/measure_units/list", { limit: 100, offset: 0 })).entities || []; await sleep(1400);
  groups = await paged("/api/nomenclature/v1/group/list", ["groups"]); await sleep(1400);
  products = await paged("/api/nomenclature/v1/product/list", ["products", "items", "entities"]);
  for (const [k, v] of Object.entries({ products, groups, units })) fs.writeFileSync(`${OUT}/${k}.json`, JSON.stringify(v));
}
console.log(`из iiko: позиций ${products.length}, групп ${groups.length}`);

const PF = /(^|[^а-яёa-z])п\s*[\/\\.]?\s*ф([^а-яёa-z]|$)/i;
const G = new Map(groups.map((g) => [g.groupId, g]));
const U = new Map(units.map((u) => [u.id, u.name]));
const P = new Map(products.map((p) => [p.productId, p]));
const OLD = new Map(old.map((p) => [p.productId, p]));
const gname = (p) => (G.get(p.parentGroupId) || {}).name || "";
const kind = (p) => (p.type === "PREPARED" ? "Заготовка" : PF.test(gname(p)) ? "Блюдо в группе п/ф" : PF.test(p.name) ? "Блюдо с п/ф в названии" : null);
const TYPES = { GOODS: "Товар", DISH: "Блюдо", PREPARED: "Заготовка", SERVICE: "Услуга", MODIFIER: "Модификатор" };

const set = products.filter((p) => !p.deleted && p.type !== "GOODS" && kind(p));
const skippedGoods = products.filter((p) => !p.deleted && p.type === "GOODS" && PF.test(gname(p))).map((p) => p.name);
console.log(`п/ф: ${set.length}; товары в группе п/ф (карты у товара нет): ${skippedGoods.join(", ") || "-"}`);

let fetched = 0, cached = 0;
const failed = [], changed = [], records = [];
const today = local;
for (const p of set) {
  const was = OLD.get(p.productId);
  const same = was && was.assemblyChartModifiedAt === p.assemblyChartModifiedAt;
  const cacheFile = `${CHARTS}/${p.productId}.json`, newFile = `${OUT}/charts/${p.productId}.json`;
  let resp;
  if (fs.existsSync(newFile)) { resp = read(newFile); cached++; }
  else if (same && fs.existsSync(cacheFile)) { resp = read(cacheFile); cached++; }
  else if (FROM_CACHE) { failed.push(p.name + " (нет в кэше)"); continue; }
  else {
    try { resp = await iiko("/api/nomenclature/v1/assembly-chart/list", { productId: p.productId }); }
    catch (e) { failed.push(p.name + ": " + e.message); continue; }
    fs.writeFileSync(newFile, JSON.stringify(resp)); fetched++; changed.push(p.name);
    await sleep(1400);
  }
  const all = resp.items || resp.assemblyCharts || [];
  const active = all.filter((c) => (!c.dateFrom || c.dateFrom <= today) && (!c.dateTo || c.dateTo > today))
    .sort((a, b) => String(b.dateFrom || "").localeCompare(String(a.dateFrom || "")));
  const ch = active[0] || null;
  const next = all.filter((c) => c.dateFrom && c.dateFrom > today).map((c) => c.dateFrom).sort()[0] || null;
  records.push({
    article: p.productArticle || "", code: String(p.code ?? ""), name: p.name, kind: kind(p), group: gname(p),
    unit: U.get(p.amountUnitId) || "", modified: (p.assemblyChartModifiedAt || "").slice(0, 10), versions: all.length, next,
    chart: ch && {
      from: ch.dateFrom || null, to: ch.dateTo || null, output: Number(ch.assembledAmount) || 0,
      technology: ch.technologyDescription || "", description: ch.description || "", appearance: ch.appearance || "",
      organoleptic: ch.organoleptic || "", outputComment: ch.outputComment || "",
      lines: (ch.items || []).slice().sort((a, b) => (a.sortWeight || 0) - (b.sortWeight || 0)).map((l) => {
        const q = P.get(l.product);
        const s = l.storeSpecification || {};
        const n = (s.departments || []).length;
        return { name: q ? q.name : "", article: q ? q.productArticle || "" : "", type: q ? TYPES[q.type] || q.type : "", unit: q ? U.get(q.amountUnitId) || "" : "",
          deleted: q ? !!q.deleted : false, missing: !q, gross: Number(l.amountIn) || 0, net: Number(l.amountMiddle) || 0, out: Number(l.amountOut) || 0,
          dept: s.inverse === false ? `только ${n} подразд.` : n ? `кроме ${n} подразд.` : "" };
      }),
    },
  });
}
fs.writeFileSync(`${OUT}/pf_charts.json`, JSON.stringify({ date: local, skippedGoods, failed, changed, records }));
const withChart = records.filter((r) => r.chart);
console.log(`карт скачано заново: ${fetched}, из кэша: ${cached}; действующих: ${withChart.length}; без действующей: ${records.length - withChart.length}; не отдал iiko: ${failed.length}`);
if (changed.length) console.log("изменены с прошлой выгрузки: " + changed.join("; "));
if (failed.length) console.log("не получены: " + failed.join("; "));
console.log("файл: " + `${OUT}/pf_charts.json`);
