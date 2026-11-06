// Записать настройки Webkassa (адрес стенда, API-ключ, логин, пароль) в зашифрованное хранилище базы (Vault)
// через служебное действие гейта fiscal_config_set. Значения берутся из data/webkassa.local (вне git) и
// никуда не печатаются; служебный ключ - data/service_key.txt или TANDEM_SERVICE_KEY.
// Запуск: node tools/webkassa-config.mjs [--sim]   (--sim - включить имитацию вместо настоящей Webkassa)
import fs from "node:fs";

const API = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const env = {};
for (const line of fs.readFileSync("data/webkassa.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && m[2]) env[m[1]] = m[2];
}
const serviceKey = process.env.TANDEM_SERVICE_KEY || fs.readFileSync("data/service_key.txt", "utf8").trim();
const payload = { service_key: serviceKey,
  base: env.WEBKASSA_BASE, api_key: env.WEBKASSA_API_KEY, login: env.WEBKASSA_LOGIN, password: env.WEBKASSA_PASSWORD,
  mode: process.argv.includes("--sim") ? "sim" : "real" };
const r = await (await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "fiscal_config_set", payload }) })).json();
console.log(r.ok ? "записано: " + (r.set || []).join(", ") : "отказ: " + (r.message || r.error));
