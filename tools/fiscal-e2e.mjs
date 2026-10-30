// Сквозная проверка фискализации через сервер учёта на «Учебной кассе» (касса Webkassa тестового стенда):
// чек → fiscal_check → повтор без второго чека → печатная форма → отмена → чек возврата → X-отчёт.
// Код учебной кассы берётся по коду обучения (TANDEM_TRAINING_CODE) и не печатается.
// Запуск: TANDEM_TRAINING_CODE=… node tools/fiscal-e2e.mjs [--z]   (--z - в конце закрыть смену Z-отчётом)
import crypto from "node:crypto";

const API = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const call = async (action, payload) => (await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action, payload }) })).json();
const ok = (title, cond, extra) => console.log((cond ? "ok   " : "FAIL ") + title + (extra ? " - " + extra : ""));

const ti = await call("training_info", { code: process.env.TANDEM_TRAINING_CODE || "" });
if (!ti.ok) { console.log("нет учёток:", ti.error); process.exit(2); }
const who = { point_id: ti.creds.kassa.point, pin: ti.creds.kassa.pin };
const login = await call("login", who);
ok("вход в учебную кассу, фискализация включена", login.ok && login.point && login.point.fiscal === true, JSON.stringify(login.point || login.error));

const menu = await call("items", who);
const goods = (menu.items || []).filter((i) => Number(i.price) > 0).slice(0, 2);
ok("меню учебной кассы", goods.length === 2, goods.map((g) => g.name + " " + g.price).join("; "));

const uid = crypto.randomUUID(); const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
const saved = await call("check_save", { ...who, uid, date: day, seller: "Проверка фискализации", pay_kind: "cash",
  lines: goods.map((g) => ({ item_code: g.code, qty: 1, price: g.price })) });
ok("чек сохранён", saved.ok, saved.ok ? "№" + saved.check.no + " на " + saved.check.total : saved.error);

const f1 = await call("fiscal_check", { ...who, uid });
ok("чек пробит в Webkassa", f1.ok && f1.fiscal && f1.fiscal.status === "ok", f1.ok ? "ФП " + f1.fiscal.number + ", смена " + f1.fiscal.shift : f1.error);
const f2 = await call("fiscal_check", { ...who, uid });
ok("повтор не пробивает второй чек", f2.ok && f2.done && f2.fiscal.number === (f1.fiscal && f1.fiscal.number), JSON.stringify(f2).slice(0, 120));

const pr = await call("fiscal_print", { ...who, uid });
ok("печатная форма", pr.ok && (pr.lines || []).length > 10, pr.ok ? pr.lines.length + " строк" : pr.error);
if (pr.ok) console.log(pr.lines.slice(0, 14).map((l) => "     | " + l).join("\n"));

const edit = await call("check_save", { ...who, uid, date: day, pay_kind: "card", lines: goods.map((g) => ({ item_code: g.code, qty: 1, price: g.price })) });
ok("пробитый чек не правится", !edit.ok && /пробит в налоговой/.test(edit.error || ""), edit.error);

const v = await call("check_void", { ...who, uid, reason: "Проверка фискализации: возврат" });
ok("чек отменён", v.ok, v.error);
const r1 = await call("fiscal_check", { ...who, uid, op: "return" });
ok("чек возврата пробит", r1.ok && r1.fiscal && r1.fiscal.return_status === "ok", r1.ok ? "ФП возврата " + r1.fiscal.return_number : r1.error);

const list = await call("check_list", { ...who, date: day });
const mine = (list.checks || []).find((c) => c.uid === uid);
ok("в списке кассы видны фискальные данные", !!(mine && mine.fiscal && mine.fiscal.number && mine.fiscal.return_number));

const x = await call("fiscal_x", who);
ok("X-отчёт", x.ok, x.ok ? "смена " + x.report.ShiftNumber + ", документов " + x.report.DocumentCount : x.error);
if (process.argv.includes("--z")) {
  const z = await call("fiscal_z", { ...who, date: day });
  ok("Z-отчёт (смена закрыта)", z.ok, z.ok ? "смена " + z.report.ShiftNumber : z.error);
}
