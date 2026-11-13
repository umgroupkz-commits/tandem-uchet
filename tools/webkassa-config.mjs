// Записать настройки Webkassa (адрес стенда, API-ключ, логин, пароль) в зашифрованное хранилище базы (Vault)
// через служебное действие гейта fiscal_config_set. Значения никуда не печатаются; служебный ключ -
// data/service_key.txt или TANDEM_SERVICE_KEY.
//
// Наборов два (0060): тестовый стенд - для учебной кассы, общий - для остальных касс.
//   node tools/webkassa-config.mjs             - общий набор из data/webkassa.local (пока рабочей кассы нет,
//                                                общий - тот же тестовый стенд)
//   node tools/webkassa-config.mjs --test      - тестовый набор из data/webkassa.local: делается до подключения
//                                                рабочей кассы, чтобы учебная касса осталась на стенде
//   node tools/webkassa-config.mjs --rabochaya - общий набор из data/webkassa-rabochaya.local (боевой адрес, ключ,
//                                                пользователь клиента); без тестового набора откажет
//   --sim - имитация вместо настоящей Webkassa (с любым из вариантов)
// Оба файла - вне git (data/ в .gitignore), строки вида WEBKASSA_BASE=..., WEBKASSA_API_KEY=..., WEBKASSA_LOGIN=...,
// WEBKASSA_PASSWORD=...
import fs from "node:fs";

const API = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const TEST = process.argv.includes("--test"), WORK = process.argv.includes("--rabochaya");
if (TEST && WORK) { console.log("укажите что-то одно: --test или --rabochaya"); process.exit(2); }
const file = WORK ? "data/webkassa-rabochaya.local" : "data/webkassa.local";
if (!fs.existsSync(file)) { console.log(`нет файла ${file}`); process.exit(2); }
const env = {};
for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && m[2]) env[m[1]] = m[2];
}
const serviceKey = process.env.TANDEM_SERVICE_KEY || fs.readFileSync("data/service_key.txt", "utf8").trim();
const send = async (payload) => (await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "fiscal_config_set", payload: { service_key: serviceKey, ...payload } }) })).json();

if (WORK) {
  if (/devkkm/i.test(env.WEBKASSA_BASE || "devkkm")) { console.log(`в ${file} адрес тестового стенда, а нужен боевой`); process.exit(2); }
  // пустая запись в тестовый набор ничего не меняет, но говорит, есть ли он
  const probe = await send({ set: "test" });
  if (!probe.ok) { console.log("отказ: " + (probe.message || probe.error)); process.exit(1); }
  if (!probe.has_test) { console.log("сначала node tools/webkassa-config.mjs --test: иначе учебная касса останется без стенда"); process.exit(2); }
}
const r = await send({ set: TEST ? "test" : "main",
  base: env.WEBKASSA_BASE, api_key: env.WEBKASSA_API_KEY, login: env.WEBKASSA_LOGIN, password: env.WEBKASSA_PASSWORD,
  mode: process.argv.includes("--sim") ? "sim" : "real" });
console.log(r.ok ? `записано в ${r.target === "test" ? "тестовый" : "общий"} набор: ` + (r.set || []).join(", ") : "отказ: " + (r.message || r.error));
