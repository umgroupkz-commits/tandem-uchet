// Проверка фискальной логики сервера (supabase/functions/uchet/fiscal.js) без сети: поддельная Webkassa
// с состоянием смены и наличных. Ветки: внесение/изъятие, повтор операции (код 14), смена дольше суток (код 11),
// закрытие смены с изъятием остатка, повторное закрытие дня. Запуск: node tools/fiscal-unit.mjs
import { handleFiscal } from "../supabase/functions/uchet/fiscal.js";
let pass = 0, fail = 0;
const ok = (t, c, x) => { c ? pass++ : fail++; console.log((c ? "ok   " : "FAIL ") + t + (x ? " - " + x : "")); };
// Поддельная Webkassa: смена (open/expired/closed), наличные в кассе, журнал вызовов.
function fake(st) {
  const calls = [];
  const err = (Code, Text) => ({ Errors: [{ Code, Text }] });
  const handle = (path, b) => {
    calls.push(path.split("/").pop() + (b.OperationType != null ? ":" + b.OperationType : ""));
    if (path.endsWith("Authorize")) return { Data: { Token: "t" } };
    if (path.endsWith("XReport")) return { Data: { ShiftNumber: st.shift, SumInCashbox: st.cash } };
    if (path.endsWith("ZReport")) { if (st.state === "closed") return err(12, "Смена уже закрыта"); st.state = "closed"; return { Data: { ShiftNumber: st.shift } }; }
    if (st.state === "expired") return err(11, "Продолжительность смены превышает 24 часа");
    if (st.dupExt && b.ExternalCheckNumber === st.dupExt) return err(14, "уже присутствует");
    if (st.state === "closed") { st.state = "open"; st.shift++; }
    if (path.endsWith("MoneyOperation")) { st.cash += b.OperationType === 0 ? b.Sum : -b.Sum; return { Data: { ShiftNumber: st.shift, Sum: st.cash } }; }
    if (path.endsWith("check")) { st.cash += 100; return { Data: { CheckNumber: "F" + calls.length, ShiftNumber: st.shift } }; }
    return { Data: {} };
  };
  return { calls, fetchImpl: async (url, o) => ({ ok: true, status: 200, text: async () => JSON.stringify(handle(url, JSON.parse(o.body))) }) };
}
const run = async (action, payload, st, prep) => {
  const f = fake(st), stored = [];
  const deps = { gate: async () => prep, store: async (...a) => { stored.push(a); return a[2] === "money" ? { ok: true, money: { ok: a[3] } } : { ok: true, fiscal: { status: "ok" } }; },
    config: async () => ({ WEBKASSA_API_KEY: "k", WEBKASSA_LOGIN: "l", WEBKASSA_PASSWORD: "p" }), fetchImpl: f.fetchImpl };
  const r = await handleFiscal(action, { point_id: "p", ...payload }, deps);
  return { r, calls: f.calls.filter((c) => c !== "Authorize").join(","), stored };
};
const MP = (kind, sum) => ({ ok: true, op: "money", cashbox: "C", kind, sum, ext: "e1" });
let x;
x = await run("fiscal_money", { reason: "размен" }, { state: "open", shift: 5, cash: 0 }, MP("in", 3000));
ok("внесение", x.r.ok && x.r.cash === 3000 && x.calls === "MoneyOperation:0" && x.stored[0][3] === true, x.calls);
x = await run("fiscal_money", {}, { state: "open", shift: 5, cash: 0, dupExt: "e1" }, MP("out", 500));
ok("повтор операции (код 14) - уже проведена", x.r.ok && x.stored[0][3] === true, JSON.stringify(x.r));
x = await run("fiscal_money", {}, { state: "expired", shift: 5, cash: 900 }, MP("out", 500));
ok("изъятие при смене > 24ч: Z и повтор", x.r.ok && x.r.auto_z === 5 && x.calls === "MoneyOperation:1,ZReport,MoneyOperation:1", x.calls);
const ZP = { ok: true, op: "z", cashbox: "C", date: "2026-10-30" };
x = await run("fiscal_z", { date: "2026-10-30" }, { state: "open", shift: 5, cash: 1250 }, ZP);
ok("Z: изъят остаток, затем Z", x.r.ok && x.r.withdrawn === 1250 && x.r.report.ShiftNumber === 5 && x.calls === "XReport,MoneyOperation:1,ZReport", x.calls);
ok("Z: изъятие записано как авто", x.stored.some((s) => s[2] === "money" && s[4].auto && s[4].ext === "p:z:5:2026-10-30"), "");
x = await run("fiscal_z", {}, { state: "open", shift: 5, cash: 0 }, ZP);
ok("Z без наличных", x.r.ok && !x.r.withdrawn && x.calls === "XReport,ZReport", x.calls);
x = await run("fiscal_z", {}, { state: "closed", shift: 5, cash: 0 }, ZP);
ok("повторное закрытие дня", x.r.ok && x.r.already && x.calls === "XReport,ZReport", x.calls);
x = await run("fiscal_z", {}, { state: "closed", shift: 5, cash: 300 }, ZP);
ok("закрытая смена с остатком: изъятие открывает смену, Z её закрывает", x.r.ok && x.r.withdrawn === 300 && x.r.report.ShiftNumber === 6, x.calls);
x = await run("fiscal_z", {}, { state: "expired", shift: 5, cash: 700 }, ZP);
ok("Z при смене > 24ч: Z, изъятие, Z", x.r.ok && x.r.withdrawn === 700 && x.calls === "XReport,MoneyOperation:1,ZReport,MoneyOperation:1,ZReport", x.calls);
const SP_ = { ok: true, op: "sale", cashbox: "C", body: { ExternalCheckNumber: "u1", Positions: [] } };
x = await run("fiscal_check", { uid: "u1" }, { state: "expired", shift: 5, cash: 0 }, SP_);
ok("чек при смене > 24ч: Z и повтор", x.r.ok && x.r.auto_z === 5 && x.calls === "check,ZReport,check", x.calls);
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, SP_);
ok("обычный чек без лишних вызовов", x.r.ok && !x.r.auto_z && x.calls === "check", x.calls);
console.log(`\nпройдено ${pass}, провалено ${fail}`);
process.exit(fail ? 1 : 0);
