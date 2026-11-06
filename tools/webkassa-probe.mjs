// Проверка связи с Webkassa на тестовом стенде: вход, кассы, единицы, чек продажи с НТИН, печатная форма,
// возврат, внесение и изъятие, X-отчёт, Z-отчёт. Настоящие чеки на тестовой кассе не фискальные.
// Настройки - из data/webkassa.local (вне git): WEBKASSA_BASE, WEBKASSA_API_KEY, WEBKASSA_CASHBOX,
// WEBKASSA_LOGIN, WEBKASSA_PASSWORD; или WEBKASSA_MODE=sim - имитация без сети.
// Запуск: node tools/webkassa-probe.mjs [--sim] [--no-z]
import fs from "node:fs";
import { webkassaConfig, createWebkassa } from "../supabase/functions/uchet/webkassa.js";

const env = { ...process.env };
if (fs.existsSync("data/webkassa.local")) {
  for (const line of fs.readFileSync("data/webkassa.local", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && m[2] && !env[m[1]]) env[m[1]] = m[2];
  }
}
if (process.argv.includes("--sim")) env.WEBKASSA_MODE = "sim";
const cfg = webkassaConfig(env); const wk = createWebkassa(cfg);
const cashbox = env.WEBKASSA_CASHBOX || "SIM";
const show = (title, d) => console.log("\n== " + title + "\n" + JSON.stringify(d, (k, v) => /token/i.test(k) ? "…" : v, 1).slice(0, 1800));
const step = async (title, fn) => { try { const d = await fn(); show(title, d); return d; } catch (e) { console.log("\n== " + title + "\n  ОШИБКА: " + e.message + (e.code != null ? " (код " + e.code + ")" : "") + (e.network ? " [связь]" : "")); return null; } };

console.log("режим:", cfg.mode, "| стенд:", cfg.base, "| касса:", cashbox);
await step("Авторизация", async () => ({ token: await wk.authorize() ? "получен" : "нет" }));
await step("Кассы пользователя", () => wk.cashboxes());
const units = await step("Справочник единиц (первые)", async () => { const u = await wk.refUnits(); return Array.isArray(u) ? u.slice(0, 40) : u; });

const uid = "probe-" + Date.now();
const sale = { CashboxUniqueNumber: cashbox, OperationType: 2, RoundType: 0, ExternalCheckNumber: uid,
  Positions: [
    { Count: 2, Price: 300, TaxPercent: 0, Tax: 0, TaxType: 0, PositionName: "Вода ASU 0,5 (тест)", PositionCode: "1001", UnitCode: 796, PositionType: 0, NTIN: "0200000000001" },
    { Count: 1, Price: 450, TaxPercent: 0, Tax: 0, TaxType: 0, PositionName: "Самса (тест)", PositionCode: "2002", UnitCode: 796, PositionType: 0 },
  ],
  Payments: [{ Sum: 1050, PaymentType: 0 }] };
const d1 = await step("Чек продажи", () => wk.check(sale));
await step("Повтор того же чека (не должен задвоиться)", () => wk.check(sale));
await step("Печатная форма 58 мм", () => wk.printFormat(cashbox, uid, 3));
if (d1) {
  const ret = { ...sale, OperationType: 3, ExternalCheckNumber: uid + "-r",
    ReturnBasisDetails: { CheckNumber: d1.CheckNumber, DateTime: d1.DateTime, RegistrationNumber: d1.Cashbox && d1.Cashbox.RegistrationNumber, Total: 1050, IsOffline: !!d1.OfflineMode } };
  await step("Возврат продажи", () => wk.check(ret));
}
await step("Внесение 1000", () => wk.money({ cashboxUniqueNumber: cashbox, operationType: 0, sum: 1000, externalCheckNumber: uid + "-in" }));
await step("Изъятие 500", () => wk.money({ cashboxUniqueNumber: cashbox, operationType: 1, sum: 500, externalCheckNumber: uid + "-out" }));
await step("X-отчёт", () => wk.xReport(cashbox));
if (!process.argv.includes("--no-z")) await step("Z-отчёт (закрытие смены)", () => wk.zReport(cashbox));
