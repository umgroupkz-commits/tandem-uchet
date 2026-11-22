// Проверка фискальной логики сервера (supabase/functions/uchet/fiscal.js) без сети: поддельная Webkassa
// с состоянием смены и наличных. Ветки: внесение/изъятие, повтор операции (код 14), смена дольше суток (код 11),
// закрытие смены с изъятием остатка, повторное закрытие дня; 0065 - «неизвестно, пробит ли» (таймаут, обрыв),
// код 14 с другой суммой, одна сессия Webkassa при одновременных чеках, проверка продажи отменённого чека,
// изъятие без ответа, рабочая точка на тестовом стенде, имитация с памятью. Запуск: node tools/fiscal-unit.mjs
import { handleFiscal, pickConfig } from "../supabase/functions/uchet/fiscal.js";
import { createWebkassa, webkassaConfig, resetWebkassaSessions, resetWebkassaSim } from "../supabase/functions/uchet/webkassa.js";
let pass = 0, fail = 0;
const ok = (t, c, x) => { c ? pass++ : fail++; console.log((c ? "ok   " : "FAIL ") + t + (x ? " - " + x : "")); };
// Поддельная Webkassa: смена (open/expired/closed), наличные в кассе, журнал вызовов. 0065: пробитые чеки
// помнятся (повтор - код 14, история смены), lost - внешние номера, на которые чек пробивается, а ответ теряется;
// netPath - путь, на котором «нет связи» без пробития; rnm - РНМ в списке касс.
function fake(st) {
  const calls = [], urls = [];
  st.docs = st.docs || new Map();
  const err = (Code, Text) => ({ Errors: [{ Code, Text }] });
  const handle = (path, b) => {
    calls.push(path.split("/").pop() + (b.OperationType != null ? ":" + b.OperationType : ""));
    if (path.endsWith("Authorize")) return { Data: { Token: "t" } };
    if (path.endsWith("XReport")) return { Data: { ShiftNumber: st.shift, SumInCashbox: st.cash } };
    if (path.endsWith("Cashboxes")) return { Data: { List: [{ UniqueNumber: "C", RegistrationNumber: st.rnm || "RNM-C" }] } };
    if (path.endsWith("History")) return { Data: { Items: [...st.docs.values()].filter((x) => x.ShiftNumber === b.ShiftNumber)
      .map((x) => ({ ExternalCheckNumber: x.ExternalCheckNumber, Number: x.CheckNumber, RegistratedOn: "2026-11-22T10:15:00", Total: x.Total })) } };
    if (path.endsWith("HistoryByNumber")) return { Data: null };
    if (path.endsWith("ZReport")) { if (st.state === "closed") return err(12, "Смена уже закрыта"); st.state = "closed"; return { Data: { ShiftNumber: st.shift } }; }
    if (st.state === "expired") return err(11, "Продолжительность смены превышает 24 часа");
    if (st.dupExt && b.ExternalCheckNumber === st.dupExt) return err(14, "уже присутствует");
    if (b.ExternalCheckNumber && st.docs.has(b.ExternalCheckNumber)) return err(14, "Чек с внешним номером уже присутствует");
    if (st.state === "closed") { st.state = "open"; st.shift++; }
    if (path.endsWith("MoneyOperation")) {
      st.cash += b.OperationType === 0 ? b.Sum : -b.Sum;
      if (st.lostMoney) { st.docs.set(b.ExternalCheckNumber, { ExternalCheckNumber: b.ExternalCheckNumber, money: true }); return "LOST"; }
      return { Data: { ShiftNumber: st.shift, Sum: st.cash } };
    }
    if (path.endsWith("check")) {
      if (st.refuse) return err(3, "Сумма оплат меньше суммы чека");
      st.cash += 100;
      const total = (b.Payments || []).reduce((s, p) => s + p.Sum, 0);
      const d = { CheckNumber: "F" + calls.length, ShiftNumber: st.shift, Total: total, ExternalCheckNumber: b.ExternalCheckNumber,
        DateTime: "22.11.2026 10:15:00", Cashbox: { RegistrationNumber: "RNM-C" } };
      st.docs.set(b.ExternalCheckNumber, d);
      if (st.lost && st.lost.has(b.ExternalCheckNumber)) { st.lost.delete(b.ExternalCheckNumber); return "LOST"; }
      return { Data: d };
    }
    return { Data: {} };
  };
  const fetchImpl = async (url, o) => {
    urls.push(url);
    if (st.netPath && url.endsWith(st.netPath)) throw new TypeError("fetch failed");
    const out = handle(url, JSON.parse(o.body));
    if (out === "LOST") throw new TypeError("fetch failed (ответ потерян)");
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return { calls, urls, fetchImpl };
}
// Рабочая точка «p» - на боевом адресе (0065: рабочая точка на тестовом стенде не пробивает)
const CFG = { WEBKASSA_BASE: "https://kkm.webkassa.kz", WEBKASSA_API_KEY: "k", WEBKASSA_LOGIN: "l", WEBKASSA_PASSWORD: "p" };
const run = async (action, payload, st, prep, cfg, storeImpl) => {
  const f = fake(st), stored = [], preps = Array.isArray(prep) ? [...prep] : null;
  const deps = { gate: async () => (preps ? preps.shift() : prep),
    store: async (...a) => { stored.push(a); if (storeImpl) return storeImpl(...a); return a[2] === "money" ? { ok: true, money: { ok: a[3] } } : { ok: true, fiscal: { status: a[3] ? "ok" : (a[4] && a[4].state) || "error" } }; },
    config: async () => cfg || CFG, fetchImpl: f.fetchImpl };
  const r = await handleFiscal(action, { point_id: "p", ...payload }, deps);
  return { r, calls: f.calls.filter((c) => c !== "Authorize").join(","), stored, urls: f.urls };
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
const SP_ = { ok: true, op: "sale", cashbox: "C", body: { ExternalCheckNumber: "u1", Positions: [], Payments: [{ Sum: 100, PaymentType: 0 }] } };
x = await run("fiscal_check", { uid: "u1" }, { state: "expired", shift: 5, cash: 0 }, SP_);
ok("чек при смене > 24ч: Z и повтор", x.r.ok && x.r.auto_z === 5 && x.calls === "check,ZReport,check", x.calls);
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, SP_);
ok("обычный чек без лишних вызовов", x.r.ok && !x.r.auto_z && x.calls === "check", x.calls);
// 0060: учебная касса - на тестовом стенде, рабочая - на общем (рабочем) наборе
const MAIN = { WEBKASSA_BASE: "https://kkm.webkassa.kz", WEBKASSA_API_KEY: "real", WEBKASSA_LOGIN: "l", WEBKASSA_PASSWORD: "p" };
const TEST = { WEBKASSA_TEST_BASE: "https://devkkm.webkassa.kz", WEBKASSA_TEST_API_KEY: "t", WEBKASSA_TEST_LOGIN: "tl", WEBKASSA_TEST_PASSWORD: "tp" };
ok("рабочая касса - общий набор", pickConfig({ ...MAIN, ...TEST }, false, "eneshka").WEBKASSA_API_KEY === "real");
const tc = pickConfig({ ...MAIN, ...TEST }, true);
ok("учебная касса - тестовый набор", tc.WEBKASSA_BASE === TEST.WEBKASSA_TEST_BASE && tc.WEBKASSA_API_KEY === "t" && tc.WEBKASSA_LOGIN === "tl");
ok("учебная без тестового набора, общий - стенд devkkm", pickConfig({ WEBKASSA_API_KEY: "k" }, true).WEBKASSA_API_KEY === "k");
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, { ...SP_, training: true }, { ...MAIN, ...TEST });
ok("учебный чек уходит на тестовый стенд", x.r.ok && x.urls.length && x.urls.every((u) => u.startsWith("https://devkkm.webkassa.kz/")), x.urls.join(" "));
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, { ...SP_, training: true }, MAIN);
ok("учебный чек при одном рабочем наборе - отказ без вызова Webkassa", !x.r.ok && !x.urls.length && x.stored[0][3] === false, x.r.error);
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, SP_, { ...MAIN, ...TEST });
ok("рабочий чек - на рабочий адрес", x.r.ok && x.urls.every((u) => u.startsWith("https://kkm.webkassa.kz/")), x.urls.join(" "));

// ---------------------------------------------------------------- 0065
// Рабочая точка на тестовом стенде или в имитации не пробивает; служебная zz_* - может (проверки)
const STAND = { WEBKASSA_API_KEY: "t", WEBKASSA_LOGIN: "tl", WEBKASSA_PASSWORD: "tp" };   // адреса нет - devkkm
let threw = null; try { pickConfig(STAND, false, "eneshka"); } catch (e) { threw = e.message; }
ok("рабочая точка на стенде devkkm - отказ", /тестовый стенд/.test(threw || ""), threw);
threw = null; try { pickConfig({ WEBKASSA_MODE: "sim" }, false, "aktau"); } catch (e) { threw = e.message; }
ok("рабочая точка в имитации - отказ", !!threw, threw);
ok("служебная zz_kassa на стенде - можно", pickConfig(STAND, false, "zz_kassa") === STAND);
x = await run("fiscal_check", { uid: "u1" }, { state: "open", shift: 5, cash: 0 }, SP_, STAND);
ok("чек рабочей точки на стенде: не пробит, Webkassa не вызывалась, правка не закрыта (error)", !x.r.ok && !x.r.unknown && !x.urls.length
  && x.stored[0][3] === false && !(x.stored[0][4] && x.stored[0][4].state), x.r.error);

// «Неизвестно, пробит ли»: чек пробит, ответ потерялся → unknown; повтор находит его по коду 14 в истории
const S1 = { ok: true, op: "sale", cashbox: "C", body: { ExternalCheckNumber: "u2", Positions: [{}], Payments: [{ Sum: 450, PaymentType: 0 }] } };
const st1 = { state: "open", shift: 7, cash: 0, lost: new Set(["u2"]), rnm: "RNM-77" };
x = await run("fiscal_check", { uid: "u2" }, st1, S1);
ok("ответ потерялся - «неизвестно, пробит ли», не «не пробит»", !x.r.ok && x.r.unknown && x.stored[0][4] && x.stored[0][4].state === "unknown"
  && /Неизвестно, пробит ли/.test(x.r.error), x.r.error);
x = await run("fiscal_check", { uid: "u2" }, st1, S1);
const d1 = x.stored[0] && x.stored[0][4];
ok("повтор: код 14 → чек из истории смены (номер смены из X-отчёта) записан", x.r.ok && x.stored[0][3] === true && d1.CheckNumber
  && x.calls.startsWith("check,XReport,Cashboxes,History"), x.calls);
ok("найденный чек: РНМ из списка касс, дата как в ответе на чек", d1 && d1.Cashbox.RegistrationNumber === "RNM-77" && d1.DateTime === "22.11.2026 10:15:00", JSON.stringify(d1));
// чек исправили после обрыва (до 0065): в налоговой 2,4 картой, у нас 450 наличными → не ok
const st2 = { state: "open", shift: 7, cash: 0, lost: new Set(["u3"]) };
await run("fiscal_check", { uid: "u3" }, st2, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u3", Payments: [{ Sum: 2.4, PaymentType: 1 }] } });
x = await run("fiscal_check", { uid: "u3" }, st2, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u3" } });
ok("код 14 с другой суммой - расхождение, чек не помечен пробитым", !x.r.ok && x.r.mismatch && x.stored[0][3] === false
  && x.stored[0][4].state === "mismatch" && /2,4/.test(x.r.error) && /450/.test(x.r.error), x.r.error);
// код 14, а в истории чека нет → unknown (не «не пробит»)
x = await run("fiscal_check", { uid: "u4" }, { state: "open", shift: 7, cash: 0, dupExt: "u4" }, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u4" } });
ok("код 14, в истории не нашёлся - «неизвестно»", !x.r.ok && x.r.unknown && x.stored[0][4].state === "unknown", x.r.error);
// отказ Webkassa (код 3) - «не пробит», правка открыта
x = await run("fiscal_check", { uid: "u5" }, { state: "open", shift: 7, cash: 0, refuse: true }, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u5" } });
ok("отказ Webkassa - «не пробит» (error), не «неизвестно»", !x.r.ok && !x.r.unknown && x.stored[0][3] === false && !x.stored[0][4], x.r.error);
// нет связи на входе (Authorize) - чек не уходил: «не пробит»
resetWebkassaSessions();
x = await run("fiscal_check", { uid: "u6" }, { state: "open", shift: 7, cash: 0, netPath: "/Authorize" }, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u6" } });
ok("обрыв на входе в Webkassa - «не пробит», чек не уходил", !x.r.ok && !x.r.unknown && !x.stored[0][4], x.r.error);
// Webkassa пробила, а база не записала ответ → вторая запись - «неизвестно»
let n = 0;
x = await run("fiscal_check", { uid: "u7" }, { state: "open", shift: 7, cash: 0 }, { ...S1, body: { ...S1.body, ExternalCheckNumber: "u7" } }, CFG,
  (...a) => { if (++n === 1) throw new Error("база недоступна"); return { ok: true, fiscal: { status: a[4] && a[4].state } }; });
ok("ответ Webkassa не записался в базу - «неизвестно»", !x.r.ok && x.r.unknown && x.stored[1][4].state === "unknown", JSON.stringify(x.stored.map((s) => s[3])));

// Одна сессия Webkassa: новый вход закрывает прежнюю (код 2). Четыре чека одновременно - все пробиты.
resetWebkassaSessions();
{
  let live = null, seq = 0, logins = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fetchImpl = async (url, o) => {
    const b = JSON.parse(o.body); await sleep(20 + Math.random() * 30);
    const res = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
    if (url.endsWith("Authorize")) { logins++; live = "t" + (++seq); return res({ Data: { Token: live } }); }
    if (b.Token !== live) return res({ Errors: [{ Code: 2, Text: "Срок действия сессии истек" }] });
    return res({ Data: { CheckNumber: "F" + Math.random(), ShiftNumber: 1 } });
  };
  const one = (i) => handleFiscal("fiscal_check", { point_id: "p" + i, uid: "s" + i }, {
    gate: async () => ({ ok: true, op: "sale", cashbox: "C", body: { ExternalCheckNumber: "s" + i, Positions: [{}], Payments: [{ Sum: 100, PaymentType: 0 }] } }),
    store: async (...a) => ({ ok: a[3] }), config: async () => CFG, fetchImpl });
  const rs = await Promise.all([0, 1, 2, 3].map(one));
  ok("одна сессия: 4 одновременных чека - все пробиты, вход один", rs.every((r) => r.ok) && logins === 1, "входов " + logins + ", отказов " + rs.filter((r) => !r.ok).length);
  live = "чужой вход";   // пользователь вошёл в приложение Webkassa - сессия сервера закрыта
  const r2 = await Promise.all([4, 5].map(one));
  ok("сессию закрыл чужой вход: оба чека пробиты после одного повторного входа", r2.every((r) => r.ok) && logins === 2, "входов " + logins);
}

// Изъятие без ответа Webkassa: «неизвестно, прошло ли», повтор с тем же номером не задваивает
{
  const st = { state: "open", shift: 5, cash: 1000, lostMoney: true };
  x = await run("fiscal_money", { reason: "хоз" }, st, MP("out", 500));
  ok("изъятие без ответа - network и текст «неизвестно, прошла ли»", !x.r.ok && x.r.network && /неизвестно, прошла ли/.test(x.r.error), x.r.error);
  st.lostMoney = false;
  x = await run("fiscal_money", { reason: "хоз" }, st, MP("out", 500));
  ok("повтор с тем же номером - код 14, проведено один раз", x.r.ok && st.cash === 500 && x.stored[0][3] === true, "в кассе " + st.cash);
}
// Закрытие смены: изъятие остатка без ответа - Z не снимается (повтор закрытия не задвоит изъятие)
{
  const st = { state: "open", shift: 5, cash: 800, lostMoney: true };
  x = await run("fiscal_z", { date: "2026-11-22" }, st, { ...ZP, warn: "Внимание: тест" });
  ok("Z: изъятие без ответа - Z не снят, ответ «неизвестно»", !x.r.ok && x.r.network && !x.calls.includes("ZReport") && /неизвестно/.test(x.r.error), x.calls);
  st.lostMoney = false;
  x = await run("fiscal_z", { date: "2026-11-22" }, st, { ...ZP, warn: "Внимание: тест" });
  ok("повторное закрытие: изъятие уже прошло (в кассе 0) - не задвоено, Z снят, предупреждение передано", x.r.ok && x.r.report && st.cash === 0
    && !x.r.withdrawn && x.calls === "XReport,ZReport" && x.r.warn === "Внимание: тест", x.calls);
  const st2 = { state: "open", shift: 5, cash: 800, netPath: "/MoneyOperation" };   // изъятие до Webkassa не дошло
  x = await run("fiscal_z", { date: "2026-11-22" }, st2, ZP);
  delete st2.netPath;
  x = await run("fiscal_z", { date: "2026-11-22" }, st2, ZP);
  ok("повторное закрытие: изъятие не дошло - проведено теперь, один раз, Z снят", x.r.ok && x.r.report && st2.cash === 0 && x.r.withdrawn === 800
    && x.calls === "XReport,MoneyOperation:1,ZReport", x.calls);
}
// Фискальный чек у точки выключен: закрытие смены не падает (ответ с already)
x = await run("fiscal_z", {}, { state: "open", shift: 5, cash: 0 }, { ok: true, skip: true });
ok("Z у точки без фискального чека - ok, already, без Webkassa", x.r.ok && x.r.already && x.r.skip && !x.urls.length, JSON.stringify(x.r));

// Отменённый чек, продажа которого «неизвестно, пробита ли» (возврат «проверить»)
const PROBE = (uid, sum = 450) => ({ ok: true, op: "return", probe: true, cashbox: "C",
  sale_body: { ExternalCheckNumber: uid, OperationType: 2, Positions: [{}], Payments: [{ Sum: sum, PaymentType: 0 }] } });
const RET = (uid) => ({ ok: true, op: "return", cashbox: "C", body: { ExternalCheckNumber: uid + ":r", OperationType: 3, Positions: [{}], Payments: [{ Sum: 450, PaymentType: 0 }] } });
{
  const st = { state: "open", shift: 7, cash: 0 };
  st.docs = new Map([["v1", { ExternalCheckNumber: "v1", CheckNumber: "F-v1", ShiftNumber: 7, Total: 450 }]]);
  x = await run("fiscal_check", { uid: "v1", op: "return" }, st, [PROBE("v1"), RET("v1")]);
  ok("проверка: продажа нашлась в истории - записана, затем пробит возврат", x.r.ok && x.stored.map((s) => s[2] + ":" + s[3]).join(",") === "sale:true,return:true"
    && !x.calls.includes("check:2"), x.calls);
  x = await run("fiscal_check", { uid: "v2", op: "return" }, { state: "open", shift: 7, cash: 0 }, [PROBE("v2"), RET("v2")]);
  ok("проверка: в истории нет - продажа пробита сейчас и сразу возврат", x.r.ok && x.stored.map((s) => s[2] + ":" + s[3]).join(",") === "sale:true,return:true", x.calls);
  x = await run("fiscal_check", { uid: "v3", op: "return" }, { state: "open", shift: 7, cash: 0, refuse: true }, [PROBE("v3"), RET("v3")]);
  ok("проверка: в истории нет и Webkassa отказала - продажи не было, возврат не нужен", x.r.ok && x.r.skip && x.stored.length === 1
    && x.stored[0][2] === "sale" && x.stored[0][3] === false && !x.stored[0][4], JSON.stringify(x.r));
  x = await run("fiscal_check", { uid: "v4", op: "return" }, { state: "open", shift: 7, cash: 0, netPath: "/History" }, [PROBE("v4"), RET("v4")]);
  ok("проверка: история не ответила - «неизвестно», возврат ждёт", !x.r.ok && x.r.unknown && x.stored[0][2] === "sale" && x.stored[0][4].state === "unknown", x.r.error);
}

// Имитация (WEBKASSA_MODE=sim) с памятью на процесс: как настоящая касса
resetWebkassaSim();
{
  const sim = () => createWebkassa(webkassaConfig({ WEBKASSA_MODE: "sim" }));
  const body = (ext, sum, op = 2) => ({ CashboxUniqueNumber: "SIM", OperationType: op, ExternalCheckNumber: ext, Positions: [{ Price: sum, Count: 1 }], Payments: [{ Sum: sum, PaymentType: 0 }] });
  const a = await sim().check(body("sim-1", 500));
  let e14 = null; try { await sim().check(body("sim-1", 500)); } catch (e) { e14 = e.code; }
  ok("имитация: повтор того же номера - код 14 (из другого запроса)", a.CheckNumber && e14 === 14, String(e14));
  const pf = await sim().printFormat("SIM", "sim-1", 3);
  ok("имитация: печатная форма пробитого чека", pf.Lines.length > 3 && pf.Lines.some((l) => /^https?:/.test(l.Value)), pf.Lines.length + " строк");
  await sim().money({ CashboxUniqueNumber: "SIM", OperationType: 0, Sum: 2000, ExternalCheckNumber: "sim-in" });
  const m = await sim().money({ CashboxUniqueNumber: "SIM", OperationType: 1, Sum: 300, ExternalCheckNumber: "sim-out" });
  const xr = await sim().xReport("SIM");
  ok("имитация: наличные копятся (500 + 2000 - 300)", m.Sum === 2200 && xr.SumInCashbox === 2200 && xr.Sell.Count === 1, JSON.stringify(xr.Sell));
  let lostErr = null; try { await sim().check(body("sim-2", 100.77)); } catch (e) { lostErr = e; }
  let again = null; try { await sim().check(body("sim-2", 100.77)); } catch (e) { again = e.code; }
  ok("имитация: тиыны ,77 - пробит, ответ потерян (обрыв), повтор - код 14", lostErr && lostErr.network && again === 14, lostErr && lostErr.message);
  let refused = null; try { await sim().check(body("sim-3", 100.78)); } catch (e) { refused = e; }
  ok("имитация: тиыны ,78 - отказ Webkassa", refused && !refused.network && refused.code === 1, refused && refused.message);
  const z = await sim().zReport("SIM");
  let z2 = null; try { await sim().zReport("SIM"); } catch (e) { z2 = e.code; }
  ok("имитация: Z закрывает смену, повторный Z - код 12", z.ShiftNumber === 1 && z2 === 12, String(z2));
  const h = await sim().history("SIM", 1, 0, 100);
  ok("имитация: история смены - чеки с внешним номером, без РНМ", h.Items.length >= 2 && h.Items.every((i) => i.ExternalCheckNumber && !i.Cashbox), h.Items.length + " чеков");
}
console.log(`\nпройдено ${pass}, провалено ${fail}`);
process.exit(fail ? 1 : 0);
