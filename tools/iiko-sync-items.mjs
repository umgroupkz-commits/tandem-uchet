// Синхронизация номенклатуры iiko → база программы.
//
// Читает товары из iikoCloud, отбирает группы, которые продаются на наших точках,
// и отправляет их пачками в edge-функцию. Данные идут напрямую, минуя переписку.
//
// Переменные окружения:
//   IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET — доступ к iiko
//   TANDEM_OWNER_PIN — код собственника (по умолчанию спрашивается явно)
//
// Запуск:  node tools/iiko-sync-items.mjs [--dry]

const IIKO = "https://api-ru.iiko.services";
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const DRY = process.argv.includes("--dry");

// Группы номенклатуры iiko, которые реально продаются на точках Тандема.
// Соответствие проверено сопоставлением 699 позиций старой выгрузки с базой iiko.
const GROUPS = [
  "Выпечка Пф", "Блюда на продажу", "Блюда ПФ",           // отдел п/ф «Аян»
  "ТЭМК Вып", "ТЭМК блюда", "ТЭМК с/т", "ТЭМК супы",      // Енешка (в iiko названы ТЭМК)
  "ТЭМК гарниры", "ТЭМК", "Реализация тэмк",
  "РЕАЛ с/т", "РЕАЛ ВТОРЫЕ БЛ", "Фуршет",
  "Актау",                                                 // столовая Актау
  "Сарань", "Мини выпечка Сарань", "Салаты Сарань Банкет", // Сарань
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function iiko(path, body, token, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(IIKO + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 429) { await sleep(3000); continue; }
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok) throw new Error(path + " → HTTP " + r.status + " " + (j?.errorDescription || t.slice(0, 200)));
    return j;
  }
  throw new Error(path + ": не удалось, постоянный 429");
}

const UNITS = {
  "6040d92d-e286-f4f9-a613-ed0e6fd241e1": "порц",
  "69859c74-db72-b006-cba5-326cf6f4fc6e": "л",
  "7ba81c3a-8de5-8f9d-fb9f-e39efcbc57cc": "кг",
  "cd19b5ea-1b32-a6e5-1df7-5d2784a0549a": "шт",
};

async function main() {
  const pin = process.env.TANDEM_OWNER_PIN;
  if (!pin && !DRY) throw new Error("TANDEM_OWNER_PIN не задан");

  const auth = await iiko("/api/v2/access_token", {
    apiKey: process.env.IIKO_API_KEY,
    appId: process.env.IIKO_APP_ID,
    clientSecret: process.env.IIKO_CLIENT_SECRET,
  });
  const token = auth.token;
  console.log("токен получен");

  // Группы: нужны, чтобы понять, в какой группе лежит позиция.
  const g = await iiko("/api/nomenclature/v1/group/list", { filters: [], limit: 500, offset: 0 }, token);
  const gName = Object.fromEntries((g.groups || []).map((x) => [x.group, x.name]));
  await sleep(1500);

  // Товары: постранично.
  let products = [];
  for (let off = 0; off < 8000; off += 500) {
    const p = await iiko("/api/nomenclature/v1/product/list", { filters: [], limit: 500, offset: off }, token);
    const chunk = p.products || [];
    products = products.concat(chunk);
    if (chunk.length < 500) break;
    await sleep(1500);
  }
  console.log("получено из iiko:", products.length, "позиций");

  const items = products
    .filter((p) => !p.deleted && GROUPS.includes(gName[p.parentGroupId] || ""))
    .map((p) => ({
      c: String(p.code),
      n: p.name,
      a: p.productArticle || "",
      g: gName[p.parentGroupId] || "",
      t: p.type || "",
      u: UNITS[p.amountUnitId] || "шт",
      pr: p.defaultSalePrice ? String(p.defaultSalePrice) : "",
      ch: !!p.assemblyChartModifiedAt,
    }));

  const byGroup = {};
  for (const i of items) byGroup[i.g] = (byGroup[i.g] || 0) + 1;
  console.log("\nк загрузке:", items.length, "позиций");
  for (const [k, v] of Object.entries(byGroup).sort((a, b) => b[1] - a[1])) {
    console.log("   " + String(v).padStart(4) + "  " + k);
  }

  if (DRY) { console.log("\n--dry: в базу ничего не отправлено"); return; }

  let ins = 0, upd = 0;
  const SIZE = 300;
  for (let i = 0; i < items.length; i += SIZE) {
    const batch = items.slice(i, i + SIZE);
    const r = await fetch(UCHET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sync_items", payload: { pin, items: batch } }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error("пачка " + (i / SIZE + 1) + ": " + (j.error || JSON.stringify(j).slice(0, 200)));
    ins += j.inserted || 0; upd += j.updated || 0;
    console.log(`  пачка ${i / SIZE + 1}: +${j.inserted} новых, ${j.updated} обновлено`);
  }
  console.log(`\nитого: добавлено ${ins}, обновлено ${upd}`);
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exitCode = 1; });
