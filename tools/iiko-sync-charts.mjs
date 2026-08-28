// Технологические карты iiko → база программы.
//
// Метод assembly-chart/list вопреки спецификации требует productId, поэтому
// карты запрашиваются по одному блюду. Берём только то, что реально нужно:
// позиции из коротких листов точек и частые позиции — остальное не окупает запросов.
//
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET, TANDEM_OWNER_PIN
// Запуск: node tools/iiko-sync-charts.mjs [--limit N]

const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const ENESHKA = "90ab84fe-12bb-475a-9c90-eb0599c95c8d";
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "--limit=60").split("=")[1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function iiko(path, body, token, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(IIKO + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(body),
    });
    if (r.status === 429) { await sleep(3000); continue; }
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok) return { error: j?.message || j?.errorDescription || ("HTTP " + r.status) };
    return j;
  }
  return { error: "постоянный 429" };
}

async function uchet(action, payload) {
  const r = await fetch(UCHET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  return await r.json();
}

async function main() {
  const pin = process.env.TANDEM_OWNER_PIN;
  if (!pin) throw new Error("TANDEM_OWNER_PIN не задан");

  const auth = await iiko("/api/v2/access_token", {
    apiKey: process.env.IIKO_API_KEY,
    appId: process.env.IIKO_APP_ID,
    clientSecret: process.env.IIKO_CLIENT_SECRET,
  });
  const token = auth.token;
  if (!token) throw new Error("токен не получен: " + JSON.stringify(auth).slice(0, 200));
  console.log("токен получен");

  // Полная номенклатура — чтобы знать productId по коду и имена ингредиентов.
  let products = [];
  for (let off = 0; off < 8000; off += 500) {
    const p = await iiko("/api/nomenclature/v1/product/list", { filters: [], limit: 500, offset: off }, token);
    const chunk = p.products || [];
    products = products.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1500);
  }
  const live = products.filter((p) => !p.deleted);
  const byCode = new Map(live.map((p) => [String(p.code), p]));
  const byId = new Map(live.map((p) => [p.productId, p]));
  console.log("номенклатура:", live.length);

  // Какие блюда грузим: короткие листы и частые позиции всех точек.
  const points = await uchet("points", {});
  const wanted = new Map();
  for (const pt of points) {
    const r = await uchet("items", { point_id: pt.id, pin });
    for (const it of (r.items || [])) {
      if ((it.short || it.rank) && it.has_chart) wanted.set(String(it.code), it.name);
    }
  }
  const codes = [...wanted.keys()].slice(0, LIMIT);
  console.log("блюд с картами к загрузке:", codes.length);

  const rows = [];
  let done = 0, empty = 0;
  for (const code of codes) {
    const p = byCode.get(code);
    if (!p) continue;
    const r = await iiko("/api/nomenclature/v1/assembly-chart/list",
      { organizationId: ENESHKA, productId: p.productId, from: "2026-08-01", to: "2026-08-22" }, token);
    const chart = (r.items || [])[0];
    if (!chart || !(chart.items || []).length) { empty++; await sleep(1200); continue; }
    const out = Number(chart.assembledAmount) || 1;
    for (const ing of chart.items) {
      const ip = byId.get(ing.product);
      const amount = Number(ing.amountMiddle ?? ing.amountIn ?? ing.amountOut ?? 0) / out;
      if (!ip || !(amount > 0)) continue;
      rows.push({ item: code, ic: String(ip.code), inm: ip.name, a: String(amount), u: "" });
    }
    done++;
    process.stdout.write(`\r  обработано ${done}/${codes.length}, строк ${rows.length}   `);
    await sleep(1200);
  }
  console.log(`\nкарт получено: ${done}, пустых: ${empty}, строк состава: ${rows.length}`);

  let saved = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const res = await uchet("sync_charts", { pin, data: rows.slice(i, i + 400) });
    if (!res.ok) throw new Error(JSON.stringify(res).slice(0, 200));
    saved += res.lines || 0;
  }
  console.log("сохранено строк:", saved);
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exitCode = 1; });
