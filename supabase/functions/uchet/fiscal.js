// Фискальные действия кассы: одна логика для Edge Function uchet (Deno) и прокси своего сервера (Node).
// Порядок: гейт проверяет код точки и отдаёт тело запроса (fiscal_prepare) → Webkassa → результат пишет
// tandem_fiscal_store (её может вызвать только сервер). Ключи Webkassa - из окружения сервера или из
// Vault базы (tandem_fiscal_config), в браузер не попадают.
//
// Действия: fiscal_check {uid, op: sale|return} - пробить чек или возврат отменённого;
//           fiscal_print {uid, which?: return} - печатная форма чека (строки);
//           fiscal_x - X-отчёт; fiscal_z {date, seller?} - изъятие остатка наличных и закрытие смены;
//           fiscal_money {kind: in|out, sum, reason, seller, ext} - внесение или изъятие наличных (0056);
//           fiscal_journal {date?} - внесения и изъятия дня (0065, без Webkassa).
// Смена Webkassa дольше суток (код 11) закрывается сама (Z-отчёт), и операция повторяется: иначе забытое
// закрытие смены остановило бы все чеки следующего дня.
// 0065: исход продажи, кроме «пробит» и «отказ», - «неизвестно, пробит ли» (unknown: запрос чека ушёл, а ответа
// нет; или Webkassa сказала «уже есть», а чек не нашёлся; или ответ не записался в базу) и «в налоговой другой
// чек» (mismatch: найденный по коду 14 чек на другую сумму или с другой оплатой). Такие чеки не исправляются.
import { webkassaConfig, createWebkassa, isAlreadyIssued, WebkassaError, CHECK_PATH } from "./webkassa.js";

export const FISCAL_ACTIONS = new Set(["fiscal_check", "fiscal_print", "fiscal_x", "fiscal_z", "fiscal_money", "fiscal_journal"]);
const SHIFT_EXPIRED = 11, SHIFT_CLOSED = 12;
const PAY_NAME = { 0: "наличные", 1: "карта", 4: "мобильный платёж" };

// deps: gate(action, payload) → ответ гейта; store(point, uid, op, ok, data, error) → ответ tandem_fiscal_store;
// config() → {WEBKASSA_*} (переменные окружения, иначе Vault); fetchImpl - для проверок.
export async function handleFiscal(action, payload, deps) {
  const op = action === "fiscal_x" ? "x" : action === "fiscal_z" ? "z" : action === "fiscal_print" ? "print"
    : action === "fiscal_money" ? "money" : action === "fiscal_journal" ? "journal" : (payload.op === "return" ? "return" : "sale");
  let prep = await deps.gate("fiscal_prepare", { ...payload, op });
  // 0065: у точки выключен фискальный чек - экрану закрытия смены ответ без Z, но в привычной ему форме
  if (op === "z" && prep && prep.ok === true && prep.skip) return { ...prep, already: true, withdrawn: 0 };
  // нет доступа, точка без фискализации, чек отменён, уже пробит или пробивается, журнал - ответ гейта как есть
  if (!prep || prep.ok !== true || prep.skip || prep.done) return prep;

  const point = payload.point_id;
  let issued = false, exists = false;   // 0065: чек точно в Webkassa (пробит / ответ «уже есть»)
  let autoZ = null;
  try {
    const wk = createWebkassa(webkassaConfig(pickConfig(await deps.config(), prep.training, point)), deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
    if (op === "x") return { ok: true, report: await wk.xReport(prep.cashbox) };
    if (op === "z") return await closeShift(wk, prep, point, payload, deps);
    if (op === "money") {
      const m = { ext: prep.ext, kind: prep.kind, sum: Number(prep.sum), reason: payload.reason || null, seller: payload.seller || null };
      const body = { CashboxUniqueNumber: prep.cashbox, OperationType: m.kind === "in" ? 0 : 1, Sum: m.sum, ExternalCheckNumber: m.ext };
      let r = null;
      try { r = await wk.money(body); }
      catch (e) {
        if (isAlreadyIssued(e)) r = null;   // операция уже проведена, ответ на первую попытку потерялся
        else if (e && e.code === SHIFT_EXPIRED) { autoZ = await zNumber(wk, prep.cashbox); r = await wk.money(body); }
        else throw e;
      }
      const st = await deps.store(point, null, "money", true, { ...m, response: r }, null);
      return { ok: true, money: st && st.money, cash: r ? r.Sum : null, auto_z: autoZ };
    }
    if (op === "print") {
      const d = await wk.printFormat(prep.cashbox, prep.ext, prep.paper);
      return { ok: true, lines: ((d && d.Lines) || []).map((l) => String(l.Value ?? "")) };
    }
    // 0065: отменённый чек, продажа которого «неизвестно, пробита ли», - сначала узнать у Webkassa
    if (op === "return" && prep.probe) {
      const p = await probeSale(wk, prep, point, payload, deps);
      if (p) return p;   // продажи в налоговой нет или расхождение - возврат не нужен / через офис
      prep = await deps.gate("fiscal_prepare", { ...payload, op });   // продажа записана - теперь обычный возврат
      if (!prep || prep.ok !== true || prep.skip || prep.done) return prep;
    }
    let data;
    try {
      data = await wk.check(prep.body);
    } catch (e) {
      if (e && e.code === SHIFT_EXPIRED) { autoZ = await zNumber(wk, prep.cashbox); data = await wk.check(prep.body); }
      else {
        // ответ на первую попытку потерялся, а чек пробит - берём его из истории смены
        if (!isAlreadyIssued(e)) throw e;
        exists = true;
        data = await findIssued(wk, prep.cashbox, prep.body.ExternalCheckNumber, prep.shift_hint);
        if (!data) throw e;
        const bad = op === "sale" && differs(data, prep.body);
        if (bad) return await mismatch(point, payload.uid, data, bad, deps);
      }
    }
    issued = true;
    const st = await deps.store(point, payload.uid, op, true, data, null);
    return autoZ ? { ...st, auto_z: autoZ } : st;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (op === "sale" || op === "return") {
      // 0065: запрос чека ушёл без ответа, Webkassa сказала «уже есть» (а чек не нашёлся) или ответ не записался в
      // базу - чек мог уйти в налоговую: «неизвестно», правка закрыта, касса проверит его повтором. Проверка
      // отменённого (probe) без ясного ответа - тоже «неизвестно»: «продажи не было» решает только отказ Webkassa.
      const unknown = issued || exists || !!prep.probe || (e instanceof WebkassaError && e.network && e.path === CHECK_PATH);
      const sold = op === "sale" || !!prep.probe;   // исход продажи (у проверки отменённого - тоже продажа)
      const r = await deps.store(point, payload.uid, sold ? "sale" : "return", false, unknown && sold ? { state: "unknown" } : null, msg);
      if (unknown && sold) {
        return { ok: false, unknown: true, network: true, code: e && e.code != null ? e.code : null, fiscal: r && r.fiscal,
          error: "Неизвестно, пробит ли чек в налоговой: " + msg + ". Не исправляйте чек - касса проверит его сама" };
      }
      return { ok: false, error: (op === "return" ? "Возврат не пробит в налоговой: " : "Чек не пробит в налоговой: ") + msg,
        network: !!(e && e.network), code: e && e.code != null ? e.code : null, fiscal: r && r.fiscal };
    }
    if (op === "money") {
      await deps.store(point, null, "money", false, { ext: prep.ext, kind: prep.kind, sum: Number(prep.sum), reason: payload.reason || null, seller: payload.seller || null }, msg);
      const what = prep.kind === "in" ? "Внесение" : "Изъятие";
      // 0065: без ответа Webkassa операция могла пройти: повтор - с тем же номером (касса держит его), не задвоится
      if (e && e.network) {
        return { ok: false, network: true, code: e.code != null ? e.code : null,
          error: what + ": Webkassa не ответила - неизвестно, прошла ли операция. Нажмите ещё раз - она не задвоится" };
      }
      return { ok: false, error: what + " не проведено в Webkassa: " + msg, network: false, code: e && e.code != null ? e.code : null };
    }
    if (op === "z") await deps.store(point, null, "z", false, { report_date: payload.date || prep.date }, msg);
    return { ok: false, error: "Webkassa: " + msg, network: !!(e && e.network), code: e && e.code != null ? e.code : null };
  }
}

// Учебная касса (points.training) пробивает на тестовом стенде Webkassa: свой набор WEBKASSA_TEST_* (в Vault -
// webkassa_test_*, 0060). Пока его нет, берётся общий, но только если он сам тестовый (стенд devkkm или имитация):
// учебный чек не должен уйти в налоговую с рабочей кассы.
// 0065: и наоборот - рабочая точка (не учебная и не служебная zz_*) на тестовом стенде или в имитации не
// пробивает: её «чеки» не дошли бы до налоговой, а кассир видел бы «Чек пробит в налоговой».
export function pickConfig(raw, training, point) {
  const get = (k) => (typeof raw === "function" ? raw(k) : raw[k]) || "";
  const test = (g) => g("WEBKASSA_MODE") === "sim" || /devkkm/i.test(g("WEBKASSA_BASE") || "devkkm");
  if (!training) {
    if (test(get) && !/^zz_/i.test(String(point || ""))) {
      throw new Error("на сервере стоит тестовый стенд Webkassa, а не боевая касса: чек рабочей точки в налоговую не уйдёт. Позвоните в офис");
    }
    return raw;
  }
  if (get("WEBKASSA_TEST_API_KEY") || get("WEBKASSA_TEST_MODE")) {
    const t = {};
    for (const k of ["MODE", "BASE", "API_KEY", "LOGIN", "PASSWORD"]) t["WEBKASSA_" + k] = get("WEBKASSA_TEST_" + k);
    return t;
  }
  if (test(get)) return raw;
  throw new Error("учебной кассе не задан тестовый стенд Webkassa (node tools/webkassa-config.mjs --test)");
}

// Z-отчёт смены, закрытой сама собой (код 11): номер закрытой смены для сообщения кассиру.
async function zNumber(wk, cashbox) {
  const z = await wk.zReport(cashbox);
  return (z && z.ShiftNumber) || true;
}

// Закрытие смены: остаток наличных в Webkassa изымается («выручка сдана»), затем Z-отчёт. Так каждая смена
// начинается с нуля, а размен на утро вносят кнопкой «Внести размен». Изъятие, которое не прошло, Z не
// останавливает - о нём сказано в ответе. Изъятие открывает смену, если она уже закрыта, поэтому Z после него
// снимается всегда; без изъятия смена, уже закрытая первым Z (повторное закрытие дня), - не ошибка.
// 0065: Webkassa не ответила на изъятие - неизвестно, прошло ли оно: Z не снимаем, повторное закрытие смены
// повторит изъятие с тем же номером (номер смены и дата те же) и не задвоит его. warn - о чём предупредить (prep).
async function closeShift(wk, prep, point, payload, deps) {
  const date = payload.date || prep.date;
  const zOnce = async () => { try { return await wk.zReport(prep.cashbox); } catch (e) { if (e && e.code === SHIFT_CLOSED) return null; throw e; } };
  let x = null;
  try { x = await wk.xReport(prep.cashbox); } catch (e) { if (!e || (e.code !== SHIFT_CLOSED && e.code !== SHIFT_EXPIRED)) throw e; }
  const cash = x ? Math.round(Number(x.SumInCashbox || 0) * 100) / 100 : 0;
  let d = null, withdrawn = 0, wErr = null;
  if (cash > 0) {
    const m = { ext: point + ":z:" + (x.ShiftNumber || 0) + ":" + date, kind: "out", sum: cash, auto: true,
      reason: "Выручка сдана при закрытии смены", seller: payload.seller || null };
    const body = { CashboxUniqueNumber: prep.cashbox, OperationType: 1, Sum: cash, ExternalCheckNumber: m.ext };
    try {
      let r = null;
      try { r = await wk.money(body); }
      catch (e) {
        if (e && e.code === SHIFT_EXPIRED) { d = await zOnce(); r = await wk.money(body); }
        else if (!isAlreadyIssued(e)) throw e;
      }
      await deps.store(point, null, "money", true, { ...m, response: r }, null);
      withdrawn = cash;
    } catch (e) {
      wErr = String((e && e.message) || e);
      await deps.store(point, null, "money", false, m, wErr);
      if (e && e.network) {
        return { ok: false, network: true, warn: prep.warn || null,
          error: "Webkassa не ответила при изъятии остатка наличных (" + wErr + "): неизвестно, прошло ли оно, повтор его не задвоит" };
      }
    }
  }
  d = (await zOnce()) || d;
  if (!d) return { ok: true, already: true, withdrawn, warn: prep.warn || null };
  await deps.store(point, null, "z", true, { ...d, report_date: date }, null);
  return { ok: true, report: d, withdrawn, withdraw_error: wErr, warn: prep.warn || null };
}

// 0065: продажа отменённого чека «неизвестно, пробита ли» (возврат «проверить»). Сначала история смены: нашлась -
// записываем её (база ставит возврат в очередь). Нет - тот же запрос продажи: прошёл - пробит сейчас (возврат тоже
// нужен), «уже есть» - ищем ещё раз; отказ Webkassa - продажи в налоговой нет, возврат не нужен.
// Ответ: null - продажа записана, дальше обычный возврат; иначе - ответ кассе.
async function probeSale(wk, prep, point, payload, deps) {
  const body = prep.sale_body, ext = body.ExternalCheckNumber;
  let data = await findIssued(wk, prep.cashbox, ext, prep.shift_hint);
  if (!data) {
    try { data = await wk.check(body); }
    catch (e) {
      if (e && e.code === SHIFT_EXPIRED) { await zNumber(wk, prep.cashbox); data = await wk.check(body); }
      else if (isAlreadyIssued(e)) { data = await findIssued(wk, prep.cashbox, ext, prep.shift_hint); if (!data) throw e; }
      else if (e && !e.network && e.code != null) {
        // в истории нет, и Webkassa отказала в той же продаже - её в налоговой нет
        const r = await deps.store(point, payload.uid, "sale", false, null, String(e.message || e));
        return { ok: true, skip: true, reason: "Продажи в налоговой не было - возврат не нужен", fiscal: r && r.fiscal };
      }
      else throw e;
    }
  }
  const bad = differs(data, body);
  if (bad) return await mismatch(point, payload.uid, data, bad, deps);
  await deps.store(point, payload.uid, "sale", true, data, null);
  return null;
}

// 0065: найденный по коду 14 чек - тот ли? Сумма и тип оплаты против нашего тела. null - совпадает (или
// сравнить нечем: история Webkassa может не отдать сумму), иначе - текст расхождения.
function differs(found, body) {
  const want = (body.Payments || []).reduce((s, p) => s + Number(p.Sum || 0), 0);
  const wType = body.Payments && body.Payments.length ? Number(body.Payments[0].PaymentType) : null;
  const total = found.Total ?? found.Sum ?? found.TotalSum ?? null;
  const pays = Array.isArray(found.Payments) ? found.Payments : null;
  const fType = found.PaymentType != null ? Number(found.PaymentType) : pays && pays.length ? Number(pays[0].PaymentType) : null;
  const sumBad = total != null && Math.abs(Number(total) - want) > 0.009, typeBad = fType != null && wType != null && fType !== wType;
  if (!sumBad && !typeBad) return null;
  const tenge = (n) => String(Math.round(Number(n) * 100) / 100).replace(".", ",") + " ₸";
  return "в налоговой этот чек пробит на " + (total != null ? tenge(total) : "другую сумму") + (fType != null ? " (" + (PAY_NAME[fType] || "оплата " + fType) + ")" : "")
    + ", а в учёте " + tenge(want) + (wType != null ? " (" + (PAY_NAME[wType] || "оплата " + wType) + ")" : "")
    + ": чек исправили после обрыва связи. Отмените чек в кассе и позвоните в офис - возврат того чека оформят в кабинете Webkassa";
}
async function mismatch(point, uid, data, text, deps) {
  const r = await deps.store(point, uid, "sale", false, { ...data, state: "mismatch" }, text.charAt(0).toUpperCase() + text.slice(1));
  return { ok: false, mismatch: true, error: "Расхождение с налоговой: " + text, fiscal: r && r.fiscal };
}

// Чек с нашим номером в истории текущей и прошлой смены кассы. 0065: номер смены - из X-отчёта (его поля описаны
// в docs/webkassa-api.md), запасные - поле смены в списке касс и смена прошлой попытки; РНМ кассы - из списка касс
// (в истории чека его нет, а без него Webkassa не примет возврат); дата - к виду ответа на чек (ДД.ММ.ГГГГ чч:мм:сс).
async function findIssued(wk, cashbox, ext, shiftHint) {
  const shifts = [];
  let rnm = null;
  try {
    const x = await wk.xReport(cashbox);
    const s = Number(x && x.ShiftNumber);
    if (s > 0) shifts.push(s, s - 1);
  } catch { /* смена закрыта или X недоступен - пробуем список касс */ }
  try {
    const list = await wk.cashboxes();
    const all = (list && (list.List || list.Items)) || (Array.isArray(list) ? list : []);
    const cb = all.find((c) => c.UniqueNumber === cashbox);
    if (cb) {
      rnm = cb.RegistrationNumber || null;
      const s = Number(cb.CurrentShiftNumber ?? cb.ShiftNumber ?? cb.Shift);
      if (s > 0) shifts.push(s, s - 1);
    }
  } catch { /* список касс недоступен - пробуем подсказку */ }
  if (shiftHint) shifts.push(Number(shiftHint));
  for (const sh of [...new Set(shifts)].filter((x) => x > 0)) {
    for (let skip = 0; skip < 1000; skip += 100) {
      const h = await wk.history(cashbox, sh, skip, 100);
      const items = (h && (h.Items || h.List)) || [];
      const hit = items.find((x) => x.ExternalCheckNumber === ext);
      if (hit) {
        let full = null;
        try { full = await wk.byNumber(cashbox, hit.Number || hit.CheckNumber, sh); } catch { /* хватит строки истории */ }
        const d = { ...hit, ...(full && typeof full === "object" ? full : {}) };
        const cb = d.Cashbox || {};
        return { ...d, CheckNumber: d.CheckNumber || d.Number, ShiftNumber: d.ShiftNumber || sh,
          DateTime: wkDate(d.DateTime || d.RegistratedOn),
          Cashbox: { ...cb, RegistrationNumber: cb.RegistrationNumber || d.CashboxRegistrationNumber || rnm } };
      }
      if (items.length < 100) break;
    }
  }
  return null;
}

// Дата для основания возврата - как в ответе на чек (ДД.ММ.ГГГГ чч:мм:сс); история отдаёт её иначе (2026-11-22T10:15:00).
function wkDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ""));
  return m ? m[3] + "." + m[2] + "." + m[1] + " " + m[4] + ":" + m[5] + ":" + m[6] : (s || null);
}
