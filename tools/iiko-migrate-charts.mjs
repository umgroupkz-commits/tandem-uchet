// Перенос технологических карт и цен закупа из iiko → charts/chart_lines и items.cost_price.
// Карты запрашиваются по одному блюду (assembly-chart/list требует productId): ~2 200 запросов
// с паузой от 1,3 с, которая сама подстраивается под лимит iiko, — около часа-полутора.
// Ответы кэшируются в data/iiko/charts/<productId>.json, повторный запуск берёт кэш
// и не ходит в iiko за уже полученным, поэтому обрыв на 429 не теряет сделанного.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET, TANDEM_OWNER_PIN.
// Запуск: node tools/iiko-migrate-charts.mjs [--dry] [--limit=N] [--skip-costs] [--only-costs]
// Прогресс пишется в data/iiko/charts.log — запускайте в фоне и смотрите лог.
import fs from "node:fs";
const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const CACHE = "data/iiko/charts";
const LOG = "data/iiko/charts.log";
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SKIP_COSTS = args.includes("--skip-costs");
const ONLY_COSTS = args.includes("--only-costs");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "--limit=0").split("=")[1]) || 0;
const PIN = process.env.TANDEM_OWNER_PIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CACHE, { recursive: true });
const log = (s) => { const line = new Date().toISOString().slice(11, 19) + " " + s; console.log(line); fs.appendFileSync(LOG, line + "\n"); };

let token = null, tokenAt = 0;
async function auth() {
  const r = await fetch(IIKO + "/api/v2/access_token", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: process.env.IIKO_API_KEY, appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET }) });
  const j = await r.json(); if (!j.token) throw new Error("нет токена: " + JSON.stringify(j).slice(0, 200));
  token = j.token; tokenAt = Date.now();
}
// iiko режет частоту не по одному запросу, а по их числу за минуты: фиксированная пауза
// в 1,3 с держится сотни полторы запросов, дальше идёт сплошной 429. Поэтому выдержка
// растёт вдвое до двух минут, а PAUSE — общая пауза между запросами — подрастает после
// каждого 429 и медленно спадает на удачных ответах, подстраиваясь под текущий лимит.
const PAUSE_MIN = 1300, PAUSE_MAX = 8000;
let pause = PAUSE_MIN, throttled = 0;
async function iiko(path, body) {
  if (!token || Date.now() - tokenAt > 50 * 60 * 1000) await auth();   // токен живёт час
  let wait = 5000, fails5xx = 0;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(IIKO + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body ?? {}) });
    if (r.status === 429) {
      throttled++;
      const retryAfter = Number(r.headers.get("retry-after")) * 1000 || 0;
      const w = Math.max(retryAfter, wait);
      if (i === 0 || i % 4 === 3) log(`  429, жду ${Math.round(w / 1000)} с (попытка ${i + 1}, пауза ${pause} мс)`);
      await sleep(w);
      wait = Math.min(wait * 2, 120000);
      pause = Math.min(pause + 400, PAUSE_MAX);
      continue;
    }
    if (r.status === 401) { await auth(); continue; }
    // 5xx у iiko бывают и transient, и намертво: их шлюз не может сходить в собственный
    // RMS («authentication failed» внутри 502), и по отдельным товарам это повторяется
    // бесконечно. Пять попыток с растущей выдержкой, дальше — ошибка с пометкой skippable:
    // вызывающий пропускает такой товар, а не роняет весь прогон.
    if (r.status >= 500) {
      if (++fails5xx >= 5) throw Object.assign(new Error(path + " → HTTP " + r.status), { skippable: true });
      log(`  HTTP ${r.status}, жду ${Math.round(wait / 1000)} с (попытка ${fails5xx})`);
      await sleep(wait); wait = Math.min(wait * 2, 60000); continue;
    }
    const t = await r.text();
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + t.slice(0, 200));
    pause = Math.max(PAUSE_MIN, pause - 15);
    return JSON.parse(t);
  }
  throw new Error(path + ": постоянный 429");
}
async function migrate(kind, rows) {
  const r = await fetch(UCHET, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "migrate", payload: { pin: PIN, kind, rows } }) }).then((x) => x.json());
  if (!r.ok) throw new Error(kind + ": " + (r.message || r.error));
  return r;
}

async function charts() {
  const cand = (await migrate("chart_candidates", [])).rows;
  const list = LIMIT ? cand.slice(0, LIMIT) : cand;
  log(`кандидатов: ${cand.length}${LIMIT ? ", берём " + list.length : ""}`);
  const rows = []; const failed = []; let fetched = 0, cached = 0, empty = 0;
  for (const c of list) {
    const f = `${CACHE}/${c.iiko_id}.json`;
    let resp;
    if (fs.existsSync(f)) { resp = JSON.parse(fs.readFileSync(f, "utf8")); cached++; }
    else {
      try {
        resp = await iiko("/api/nomenclature/v1/assembly-chart/list", { productId: c.iiko_id });
      } catch (e) {
        // товар, который шлюз iiko не отдаёт: в кэш не пишем (следующий запуск попробует
        // снова), в отчёт — списком; из-за одной такой позиции прогон не останавливается
        if (!e.skippable) throw e;
        failed.push(c.code + "/" + c.iiko_id); log(`  iiko не отдал карту ${c.code}: ${e.message}`);
        await sleep(pause); continue;
      }
      fs.writeFileSync(f, JSON.stringify(resp)); fetched++;
      await sleep(pause);
    }
    const items = resp.items || resp.assemblyCharts || [];
    if (!items.length) empty++;
    for (const ch of items) {
      rows.push({
        iiko_id: ch.id, code: c.code, date_from: ch.dateFrom || null, date_to: ch.dateTo || null,
        output_amount: Number(ch.assembledAmount) || 1, technology: ch.technologyDescription || null,
        lines: (ch.items || []).map((l) => ({ ingredient_iiko_id: l.product, brutto: Number(l.amountIn) || 0,
          netto: Number(l.amountMiddle) || 0, output: Number(l.amountOut) || 0, sort: Number(l.sortWeight) || 0 })),
      });
    }
    if ((fetched + cached) % 100 === 0) log(`  ${fetched + cached}/${list.length} (из iiko ${fetched}, из кэша ${cached}), карт ${rows.length}, пауза ${pause} мс, 429 ${throttled}`);
  }
  log(`получено карт: ${rows.length}; блюд без карты в iiko: ${empty}`);
  if (failed.length) {
    log(`  iiko не отдал карты по ${failed.length} блюдам:`);
    for (const f of failed) log(`    ${f}`);
  }
  if (DRY) return failed.length;
  let ins = 0, upd = 0, skip = 0, skipL = 0, unknown = new Set(), errors = [];
  // сортируем по блюду и дате начала — так закрытие версий внутри RPC идёт в естественном порядке
  rows.sort((a, b) => a.code.localeCompare(b.code) || String(a.date_from).localeCompare(String(b.date_from)));
  for (let i = 0; i < rows.length; i += 100) {
    const r = await migrate("charts", rows.slice(i, i + 100));
    ins += r.inserted; upd += r.updated; skip += r.skipped; skipL += r.skipped_lines;
    (r.unknown || []).forEach((u) => unknown.add(u));
    (r.errors || []).forEach((e) => errors.push(e));
  }
  log(`карты: вставлено ${ins}, обновлено ${upd}, пропущено ${skip}; строк пропущено ${skipL}; неизвестных ингредиентов ${unknown.size}`);
  if (unknown.size) log("  примеры неизвестных: " + [...unknown].slice(0, 20).join(", "));
  log(`  отказов при записи (errors): ${errors.length}`);
  if (errors.length) log("  первые: " + errors.slice(0, 10).join(" | "));
  return failed.length;
}

// Предприятия для накладных — только те, что открыты этому api-логину: дерево
// /api/inventory/v1/organizations/tree шире (в нём есть, например, Актау), но по чужому
// подразделению список накладных отвечает 400 «doesn't belong to your api login».
async function departments() {
  const orgs = (await iiko("/api/1/organizations", { returnAdditionalInfo: false, includeDisabled: false })).organizations || [];
  return orgs.map((o) => ({ id: o.id, name: o.name }));
}

async function costs() {
  const orgs = await departments();
  log(`предприятий: ${orgs.length}`);
  const from = "2026-01-01", to = new Date().toISOString().slice(0, 10);
  const last = new Map();   // product → {price, date}
  let docs = 0, lines = 0, badOrgs = 0, badDocs = 0;
  for (const o of orgs) {
    await sleep(pause);
    let l;
    try {
      l = await iiko("/api/inventory/v1/incoming_invoice/list", { organizationId: o.id, from, to });
    } catch (e) {
      // по части предприятий их же RMS отвечает 500 на список накладных: пропускаем
      // предприятие целиком, но прогон продолжаем — цены соберутся по остальным
      if (!e.skippable) throw e;
      badOrgs++; log(`  список накладных «${o.name}» не отдан: ${e.message}`); continue;
    }
    const list = Array.isArray(l) ? l : (l.incomingInvoices || l.documents || []);
    log(`накладных у «${o.name}»: ${list.length}`);
    for (const d of list) {
      if (d.deleted) continue;
      const f = `${CACHE}/inv_${d.documentId}.json`;
      let g;
      if (fs.existsSync(f)) g = JSON.parse(fs.readFileSync(f, "utf8"));
      else {
        await sleep(pause);
        try { g = await iiko("/api/inventory/v1/incoming_invoice/get", { organizationId: o.id, documentId: d.documentId }); }
        catch (e) { if (!e.skippable) throw e; badDocs++; continue; }
        fs.writeFileSync(f, JSON.stringify(g));
      }
      const inv = g.incomingInvoice || g;
      const date = String(d.date || inv.date).slice(0, 10);
      for (const it of (inv.items || [])) {
        const price = Number(it.price || (it.sum && it.amount ? it.sum / it.amount : 0));
        if (!it.product || !(price > 0)) continue;
        lines++;
        const prev = last.get(it.product);
        if (!prev || prev.date <= date) last.set(it.product, { price, date });
      }
      docs++;
    }
  }
  log(`накладных прочитано ${docs}, строк ${lines}, товаров с ценой ${last.size}; предприятий пропущено ${badOrgs}, накладных не отдано ${badDocs}`);
  if (DRY) return;
  const rows = [...last.entries()].map(([iiko_id, v]) => ({ iiko_id, price: v.price, date: v.date, source: "iiko_invoice" }));
  let upd = 0, skip = 0;
  for (let i = 0; i < rows.length; i += 500) { const r = await migrate("costs", rows.slice(i, i + 500)); upd += r.updated; skip += r.skipped; }
  log(`цены: обновлено ${upd}, пропущено ${skip} (не найдены по iiko_id или помечены manual)`);
}

if (!PIN) throw new Error("TANDEM_OWNER_PIN не задан");
let failedCount = 0;
if (!ONLY_COSTS) failedCount = await charts();
if (!SKIP_COSTS) await costs();
log("готово");
if (failedCount > 0) process.exitCode = 2;
