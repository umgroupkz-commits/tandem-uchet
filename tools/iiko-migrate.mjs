// Перенос справочников iiko → база программы. Чтение из iiko работает; запись туда — нет.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET, TANDEM_OWNER_PIN.
// Запуск: node tools/iiko-migrate.mjs [--dry] [--from-cache]
//   --from-cache — не ходить в iiko, взять data/iiko/*.json из прошлого запуска.
import fs from "node:fs";
const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const CACHE = "data/iiko";
const DRY = process.argv.includes("--dry");
const FROM_CACHE = process.argv.includes("--from-cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function iiko(path, body, token) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(IIKO + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 429) { await sleep(3000); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + t.slice(0, 200));
    return JSON.parse(t);
  }
  throw new Error(path + ": постоянный 429");
}

async function paged(path, keys, token) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  let all = [];
  for (let off = 0; off < 20000; off += 500) {
    const j = await iiko(path, { filters: [], limit: 500, offset: off }, token);
    const chunk = keyList.map((k) => j[k]).find((v) => Array.isArray(v)) || [];
    all = all.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1400);
  }
  return all;
}

function cacheGet(name) { return JSON.parse(fs.readFileSync(`${CACHE}/${name}.json`, "utf8")); }
function cachePut(name, data) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(`${CACHE}/${name}.json`, JSON.stringify(data)); }

async function load() {
  if (FROM_CACHE) return { units: cacheGet("units"), groups: cacheGet("groups"), products: cacheGet("products"), stores: cacheGet("stores"), counteragents: cacheGet("counteragents") };
  const auth = await iiko("/api/v2/access_token", { apiKey: process.env.IIKO_API_KEY, appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET });
  const token = auth.token; console.log("токен получен");
  const units = (await iiko("/api/inventory/v1/measure_units/list", { limit: 100, offset: 0 }, token)).entities || [];
  await sleep(1400);
  const groups = await paged("/api/nomenclature/v1/group/list", "groups", token);
  await sleep(1400);
  const products = await paged("/api/nomenclature/v1/product/list", ["products", "items", "entities"], token);
  await sleep(1400);
  const orgs = (await iiko("/api/1/organizations", { returnAdditionalInfo: false, includeDisabled: false }, token)).organizations || [];
  await sleep(1400);
  const stores = (await iiko("/api/inventory/v1/stores/list", { organizationId: orgs[0].id }, token)).stores || [];
  await sleep(1400);
  let counteragents = [];
  let firstCaRaw = null;
  for (let off = 0; off < 20000; off += 500) {
    const ca = await iiko("/api/inventory/v1/counteragents/list", { organizationId: orgs[0].id, limit: 500, offset: off }, token);
    if (firstCaRaw === null) firstCaRaw = ca;
    const chunk = ca.counteragents || ca.entities || ca.items || [];
    counteragents = counteragents.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1400);
  }
  if (counteragents.length === 0) throw new Error("BLOCKED: контрагентов получилось 0, сырой ответ: " + JSON.stringify(firstCaRaw).slice(0, 300));
  const data = { units, groups, products, stores, counteragents };
  for (const [k, v] of Object.entries(data)) cachePut(k, v);
  return data;
}

async function send(kind, rows) {
  let ins = 0, upd = 0, skip = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(UCHET, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "migrate", payload: { pin: process.env.TANDEM_OWNER_PIN, kind, rows: rows.slice(i, i + 500) } }),
    }).then((x) => x.json());
    if (!r.ok) throw new Error(kind + " пачка " + (i / 500 + 1) + ": " + (r.message || r.error));
    ins += r.inserted; upd += r.updated; skip += r.skipped;
  }
  console.log(`${kind.padEnd(14)} в файле ${String(rows.length).padStart(5)} | вставлено ${String(ins).padStart(5)} | обновлено ${String(upd).padStart(5)} | пропущено ${skip}`);
  return { ins, upd, skip };
}

const d = await load();
const unitName = Object.fromEntries(d.units.map((u) => [u.id, u.name]));
const typeMap = { GOODS: "goods", DISH: "dish", PREPARED: "prepared", SERVICE: "service" };

const groups = d.groups.map((g, i) => ({ id: g.groupId, name: g.name, deleted: !!g.isDeleted, sort: i }));
const stores = d.stores.map((s) => ({ id: s.id, name: s.name, organization_id: s.organizationId || null, deleted: !!s.deleted }));
const counteragents = d.counteragents.map((c) => ({
  id: c.id, name: c.name,
  kind: c.supplier ? "supplier" : c.client ? "customer" : c.employee ? "employee" : "other",
  bin: c.taxpayerIdNumber || null, phone: c.phone || c.cellPhone || null, deleted: !!c.deleted,
}));
// Код позиции у нас — первичный ключ, а в iiko удалённые могут делить код с живыми.
// На один код берём одну запись: живую, а из удалённых — первую; остальные считаем «дубли».
const byCode = new Map();
for (const p of d.products.slice().sort((a, b) => Number(!!a.deleted) - Number(!!b.deleted))) {
  const code = String(p.code);
  if (!byCode.has(code)) byCode.set(code, p);
}
const dupes = d.products.length - byCode.size;
const items = [...byCode.values()]
  .map((p) => ({
  id: p.productId, code: String(p.code), name: p.name, artikul: p.productArticle || "",
  group_id: p.parentGroupId || null, unit: unitName[p.amountUnitId] || "шт",
  type: typeMap[p.type] || "dish", deleted: !!p.deleted,
  price: p.defaultSalePrice ? String(p.defaultSalePrice) : null,
}));

console.log(`к переносу: групп ${groups.length}, складов ${stores.length}, контрагентов ${counteragents.length}, позиций ${items.length} (из них удалённых в iiko ${items.filter((x) => x.deleted).length}; дублей кода отброшено ${dupes})`);
if (DRY) { console.log("--dry: в базу ничего не отправлено"); process.exit(0); }
if (!process.env.TANDEM_OWNER_PIN) throw new Error("TANDEM_OWNER_PIN не задан");

await send("groups", groups);
await send("stores", stores);
await send("counteragents", counteragents);
await send("items", items);
console.log("готово");
