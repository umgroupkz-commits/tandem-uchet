// Фискальные действия кассы: одна логика для Edge Function uchet (Deno) и прокси своего сервера (Node).
// Порядок: гейт проверяет код точки и отдаёт тело запроса (fiscal_prepare) → Webkassa → результат пишет
// tandem_fiscal_store (её может вызвать только сервер). Ключи Webkassa - из окружения сервера или из
// Vault базы (tandem_fiscal_config), в браузер не попадают.
//
// Действия: fiscal_check {uid, op: sale|return} - пробить чек или возврат отменённого;
//           fiscal_print {uid, which?: return} - печатная форма чека (строки);
//           fiscal_x - X-отчёт; fiscal_z {date, seller?} - изъятие остатка наличных и закрытие смены;
//           fiscal_money {kind: in|out, sum, reason, seller, ext} - внесение или изъятие наличных (0056).
// Смена Webkassa дольше суток (код 11) закрывается сама (Z-отчёт), и операция повторяется: иначе забытое
// закрытие смены остановило бы все чеки следующего дня.
import { webkassaConfig, createWebkassa, isAlreadyIssued } from "./webkassa.js";

export const FISCAL_ACTIONS = new Set(["fiscal_check", "fiscal_print", "fiscal_x", "fiscal_z", "fiscal_money"]);
const SHIFT_EXPIRED = 11, SHIFT_CLOSED = 12;

// deps: gate(action, payload) → ответ гейта; store(point, uid, op, ok, data, error) → ответ tandem_fiscal_store;
// config() → {WEBKASSA_*} (переменные окружения, иначе Vault); fetchImpl - для проверок.
export async function handleFiscal(action, payload, deps) {
  const op = action === "fiscal_x" ? "x" : action === "fiscal_z" ? "z" : action === "fiscal_print" ? "print"
    : action === "fiscal_money" ? "money" : (payload.op === "return" ? "return" : "sale");
  const prep = await deps.gate("fiscal_prepare", { ...payload, op });
  // нет доступа, точка без фискализации, чек отменён или уже пробит - ответ гейта как есть
  if (!prep || prep.ok !== true || prep.skip || prep.done) return prep;

  const wk = createWebkassa(webkassaConfig(await deps.config()), deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const point = payload.point_id;
  try {
    if (op === "x") return { ok: true, report: await wk.xReport(prep.cashbox) };
    if (op === "z") return await closeShift(wk, prep, point, payload, deps);
    if (op === "money") {
      const m = { ext: prep.ext, kind: prep.kind, sum: Number(prep.sum), reason: payload.reason || null, seller: payload.seller || null };
      const body = { CashboxUniqueNumber: prep.cashbox, OperationType: m.kind === "in" ? 0 : 1, Sum: m.sum, ExternalCheckNumber: m.ext };
      let r = null, autoZ = null;
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
    let data, autoZ = null;
    try {
      data = await wk.check(prep.body);
    } catch (e) {
      if (e && e.code === SHIFT_EXPIRED) { autoZ = await zNumber(wk, prep.cashbox); data = await wk.check(prep.body); }
      else {
        // ответ на первую попытку потерялся, а чек пробит - берём его из истории смены
        if (!isAlreadyIssued(e)) throw e;
        data = await findIssued(wk, prep.cashbox, prep.body.ExternalCheckNumber, prep.shift_hint);
        if (!data) throw e;
      }
    }
    const st = await deps.store(point, payload.uid, op, true, data, null);
    return autoZ ? { ...st, auto_z: autoZ } : st;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (op === "sale" || op === "return") {
      const r = await deps.store(point, payload.uid, op, false, null, msg);
      return { ok: false, error: (op === "return" ? "Возврат не пробит в налоговой: " : "Чек не пробит в налоговой: ") + msg,
        network: !!(e && e.network), code: e && e.code != null ? e.code : null, fiscal: r && r.fiscal };
    }
    if (op === "money") {
      await deps.store(point, null, "money", false, { ext: prep.ext, kind: prep.kind, sum: Number(prep.sum), reason: payload.reason || null, seller: payload.seller || null }, msg);
      return { ok: false, error: (prep.kind === "in" ? "Внесение" : "Изъятие") + " не проведено в Webkassa: " + msg,
        network: !!(e && e.network), code: e && e.code != null ? e.code : null };
    }
    if (op === "z") await deps.store(point, null, "z", false, { report_date: payload.date || prep.date }, msg);
    return { ok: false, error: "Webkassa: " + msg, network: !!(e && e.network), code: e && e.code != null ? e.code : null };
  }
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
    }
  }
  d = (await zOnce()) || d;
  if (!d) return { ok: true, already: true, withdrawn };
  await deps.store(point, null, "z", true, { ...d, report_date: date }, null);
  return { ok: true, report: d, withdrawn, withdraw_error: wErr };
}

// Чек с нашим номером в истории текущей (и прошлой) смены кассы.
async function findIssued(wk, cashbox, ext, shiftHint) {
  const shifts = [];
  try {
    const list = await wk.cashboxes();
    const cb = ((list && (list.List || list.Items)) || []).find((c) => c.UniqueNumber === cashbox);
    if (cb && Number(cb.Shift) > 0) shifts.push(Number(cb.Shift), Number(cb.Shift) - 1);
  } catch { /* список касс недоступен - пробуем подсказку */ }
  if (shiftHint) shifts.push(Number(shiftHint));
  for (const sh of [...new Set(shifts)].filter((x) => x > 0)) {
    for (let skip = 0; skip < 1000; skip += 100) {
      const h = await wk.history(cashbox, sh, skip, 100);
      const items = (h && h.Items) || [];
      const hit = items.find((x) => x.ExternalCheckNumber === ext);
      if (hit) return hit;
      if (items.length < 100) break;
    }
  }
  return null;
}
