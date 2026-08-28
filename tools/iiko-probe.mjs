// Разведка iikoCloud API для Тандема: что доступно и что можно синхронизировать.
//
// Секреты берутся только из переменных окружения — в код и в репозиторий не попадают:
//   IIKO_API_KEY        ключ ресторана из iikoWeb → Интеграции → API-ключи
//   IIKO_APP_ID         идентификатор приложения с public-api.iikoweb.ru/portal
//   IIKO_CLIENT_SECRET  секрет приложения оттуда же (показывается один раз)
//
// Запуск:  node tools/iiko-probe.mjs
//
// Авторизация v2 требует все три значения. Ключ ресторана сам по себе токен не даёт:
// он определяет, к каким организациям будет доступ, но приложение должно быть
// зарегистрировано отдельно.

const BASE = "https://api-ru.iiko.services";

const API_KEY = process.env.IIKO_API_KEY || "";
const APP_ID = process.env.IIKO_APP_ID || "";
const CLIENT_SECRET = process.env.IIKO_CLIENT_SECRET || "";

const mask = (s) => (s ? s.slice(0, 4) + "…" + s.slice(-4) + ` (${s.length})` : "не задан");

async function call(path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function getToken() {
  if (!API_KEY) throw new Error("IIKO_API_KEY не задан");
  if (!APP_ID || !CLIENT_SECRET) {
    const r = await call("/api/v2/access_token", { apiKey: API_KEY });
    throw new Error(
      "Нет IIKO_APP_ID и/или IIKO_CLIENT_SECRET. Сервер отвечает: " +
      ((r.json && r.json.errorDescription) || r.status)
    );
  }
  const r = await call("/api/v2/access_token", {
    apiKey: API_KEY, appId: APP_ID, clientSecret: CLIENT_SECRET,
  });
  if (!r.ok || !r.json?.token) {
    throw new Error("Токен не выдан: HTTP " + r.status + " " +
      ((r.json && r.json.errorDescription) || r.text.slice(0, 200)));
  }
  return r.json.token;
}

// Что проверяем: слева — человеческое название, справа — метод и тело.
const PROBES = [
  ["Организации", "/api/1/organizations", (ctx) => ({ returnAdditionalInfo: true })],
  ["Лицензии", "/api/licenses/v2/list", (ctx) => ({ organizationIds: ctx.orgs })],
  ["Терминальные группы", "/api/1/terminal_groups", (ctx) => ({ organizationIds: ctx.orgs })],
  ["Типы оплаты", "/api/1/payment_types", (ctx) => ({ organizationIds: ctx.orgs })],
  ["Склады", "/api/inventory/v1/stores/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Единицы измерения", "/api/inventory/v1/measure_units/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Концепции", "/api/inventory/v1/conceptions/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Номенклатура (меню)", "/api/1/nomenclature", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Товары", "/api/nomenclature/v1/product/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Группы номенклатуры", "/api/nomenclature/v1/group/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Фасовки (шкалы размеров)", "/api/nomenclature/v1/product-scale/list", (ctx) => ({ organizationId: ctx.orgs[0] })],
  ["Акты реализации", "/api/inventory/v1/sales_document/list", (ctx) => ({
    organizationId: ctx.orgs[0],
    dateFrom: "2026-07-01T00:00:00.000",
    dateTo: "2026-08-01T00:00:00.000",
  })],
];

function size(json) {
  if (json == null) return "—";
  if (Array.isArray(json)) return json.length + " записей";
  for (const k of ["organizations", "items", "products", "groups", "terminalGroups", "data", "result", "licenses", "stores"]) {
    if (Array.isArray(json[k])) return k + ": " + json[k].length;
    if (json[k] && Array.isArray(json[k].items)) return k + ".items: " + json[k].items.length;
  }
  return Object.keys(json).slice(0, 6).join(", ");
}

async function main() {
  console.log("Ключ ресторана :", mask(API_KEY));
  console.log("appId          :", mask(APP_ID));
  console.log("clientSecret   :", mask(CLIENT_SECRET));
  console.log("");

  let token;
  try {
    token = await getToken();
  } catch (e) {
    console.log("АВТОРИЗАЦИЯ НЕ ПРОШЛА");
    console.log(" ", e.message);
    console.log("");
    console.log("Что нужно: зарегистрировать приложение на https://public-api.iikoweb.ru/portal");
    console.log("и получить appId и clientSecret. Ключ ресторана уже есть.");
    process.exitCode = 1;
    return;
  }
  console.log("Токен получен, длина", token.length, "\n");

  const org = await call("/api/1/organizations", { returnAdditionalInfo: true }, token);
  const orgs = (org.json?.organizations || []).map((o) => o.id);
  console.log("Организаций:", orgs.length);
  for (const o of org.json?.organizations || []) console.log("  ·", o.name, "—", o.id);
  console.log("");

  const ctx = { orgs };
  for (const [label, path, mk] of PROBES) {
    try {
      const r = await call(path, mk(ctx), token);
      const note = r.ok ? size(r.json) : "HTTP " + r.status + " " + ((r.json && r.json.errorDescription) || "").slice(0, 70);
      console.log((r.ok ? "  ok   " : "  нет  ") + label.padEnd(26) + note);
    } catch (e) {
      console.log("  сбой " + label.padEnd(26) + e.message.slice(0, 70));
    }
  }
}

main();
