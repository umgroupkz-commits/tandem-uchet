// Обновление учёта из iiko одной командой: справочники, техкарты, цены закупа. Порядок - docs/zapusk.md.
//
//   node tools/iiko-obnovlenie.mjs proverka   - вхолостую: свежие данные iiko во временную папку
//                                               data/iiko/proverka_<дата>, сводка изменений; в базу ничего
//                                               не пишется, рабочий кэш data/iiko не трогается
//   node tools/iiko-obnovlenie.mjs zapusk     - по-настоящему: копия кэша в data/iiko/snap_<дата>, свежие
//                                               справочники, убрать из кэша изменённые техкарты, перенос
//                                               справочников, затем техкарт и цен закупа
//
// Копию таблиц базы (backup_<дата>) перед «zapusk» делают отдельно - SQL в docs/zapusk.md: прав на DDL у
// служебного ключа нет. Прейскурант и остатки грузятся в бэк-офисе после этой команды.
// Переменные окружения: IIKO_API_KEY, IIKO_APP_ID, IIKO_CLIENT_SECRET; служебный ключ - TANDEM_SERVICE_KEY или
// data/service_key.txt.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MODE = process.argv[2];
if (!["proverka", "zapusk"].includes(MODE)) { console.log("укажите режим: proverka или zapusk"); process.exit(2); }
const BASE = "data/iiko";
const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const key = process.env.TANDEM_SERVICE_KEY || (fs.existsSync("data/service_key.txt") ? fs.readFileSync("data/service_key.txt", "utf8").trim() : "");
if (!key) { console.log("нет служебного ключа (TANDEM_SERVICE_KEY или data/service_key.txt)"); process.exit(2); }
for (const v of ["IIKO_API_KEY", "IIKO_APP_ID", "IIKO_CLIENT_SECRET"]) if (!process.env[v]) { console.log(`нет переменной ${v}`); process.exit(2); }
const FILES = ["products", "groups", "units", "stores", "counteragents"];
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function run(title, script, args, cache) {
  console.log(`\n== ${title}`);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env: { ...process.env, TANDEM_SERVICE_KEY: key, IIKO_CACHE: cache } });
  if (r.status !== 0) { console.log(`остановлено: ${script} вернул ${r.status}`); process.exit(r.status || 1); }
}

// Рабочая папка: для проверки - копия кэша (техкарты и накладные тоже, чтобы не качать заново всё),
// для запуска - сам кэш, а его прежние справочники - в snap_<дата>.
let dir;
if (MODE === "proverka") {
  dir = `${BASE}/proverka_${day}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(`${BASE}/${f}.json`, `${dir}/${f}.json`);
  fs.cpSync(`${BASE}/charts`, `${dir}/charts`, { recursive: true });
} else {
  dir = BASE;
  const snap = `${BASE}/snap_${day}`;
  fs.mkdirSync(snap, { recursive: true });
  for (const f of FILES) fs.copyFileSync(`${BASE}/${f}.json`, `${snap}/${f}.json`);
  console.log(`прежние справочники сохранены в ${snap}`);
}
const old = read(`${dir}/products.json`);

run("справочники из iiko (без записи в базу)", "tools/iiko-migrate.mjs", ["--dry"], dir);

// Что изменилось в iiko с прошлого обновления
const now = read(`${dir}/products.json`);
const units = new Map(read(`${dir}/units.json`).map((u) => [u.id, u.name]));
const O = new Map(old.map((p) => [p.productId, p]));
const add = [], ren = [], unit = [], type = [], del = [], charts = [];
for (const p of now) {
  const o = O.get(p.productId);
  if (!o) { if (!p.deleted) add.push(p.name); continue; }
  if (!o.deleted && p.deleted) del.push(p.name);
  if (o.name !== p.name) ren.push(`${o.name} → ${p.name}`);
  if (o.amountUnitId !== p.amountUnitId) unit.push(`${p.name}: ${units.get(o.amountUnitId) || "?"} → ${units.get(p.amountUnitId) || "?"}`);
  if (o.type !== p.type) type.push(`${p.name}: ${o.type} → ${p.type}`);
  if (o.assemblyChartModifiedAt !== p.assemblyChartModifiedAt) charts.push(p);
}
const show = (t, a) => console.log(`${t}: ${a.length}${a.length ? " - " + a.slice(0, 12).join("; ") + (a.length > 12 ? "; …" : "") : ""}`);
console.log("\n== изменения в iiko с прошлого обновления");
show("новые позиции", add); show("переименованы", ren); show("сменили единицу", unit); show("сменили тип", type); show("удалены в iiko", del);
show("изменены техкарты", charts.map((p) => p.name));

// Изменённые техкарты - из кэша вон: перенос скачает их заново
let removed = 0;
for (const p of charts) { const f = `${dir}/charts/${p.productId}.json`; if (fs.existsSync(f)) { fs.rmSync(f); removed++; } }
fs.writeFileSync(`${dir}/charts_changed_ids_${day}.json`, JSON.stringify(charts.map((p) => p.productId)));
console.log(`из кэша убрано изменённых техкарт: ${removed}`);

if (MODE === "proverka") {
  run("техкарты и цены закупа (без записи в базу)", "tools/iiko-migrate-charts.mjs", ["--dry"], dir);
  console.log(`\nпроверка закончена, в базу ничего не записано; данные - ${dir} (можно удалить)`);
} else {
  run("перенос справочников", "tools/iiko-migrate.mjs", ["--from-cache"], dir);
  run("перенос техкарт и цен закупа", "tools/iiko-migrate-charts.mjs", [], dir);
  console.log("\nобновление из iiko закончено. Дальше по docs/zapusk.md: прейскурант, остатки, проверка «Готовности».");
}
