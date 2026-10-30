// Фискальные действия кассы: одна логика для Edge Function uchet (Deno) и прокси своего сервера (Node).
// Порядок: гейт проверяет код точки и отдаёт тело запроса (fiscal_prepare) → Webkassa → результат пишет
// tandem_fiscal_store (её может вызвать только сервер). Ключи Webkassa - из окружения сервера или из
// Vault базы (tandem_fiscal_config), в браузер не попадают.
//
// Действия: fiscal_check {uid, op: sale|return} - пробить чек или возврат отменённого;
//           fiscal_print {uid, which?: return} - печатная форма чека (строки);
//           fiscal_x - X-отчёт; fiscal_z {date} - закрытие смены.
import { webkassaConfig, createWebkassa, isAlreadyIssued } from "./webkassa.js";

export const FISCAL_ACTIONS = new Set(["fiscal_check", "fiscal_print", "fiscal_x", "fiscal_z"]);

// deps: gate(action, payload) → ответ гейта; store(point, uid, op, ok, data, error) → ответ tandem_fiscal_store;
// config() → {WEBKASSA_*} (переменные окружения, иначе Vault); fetchImpl - для проверок.
export async function handleFiscal(action, payload, deps) {
  const op = action === "fiscal_x" ? "x" : action === "fiscal_z" ? "z" : action === "fiscal_print" ? "print"
    : (payload.op === "return" ? "return" : "sale");
  const prep = await deps.gate("fiscal_prepare", { ...payload, op });
  // нет доступа, точка без фискализации, чек отменён или уже пробит - ответ гейта как есть
  if (!prep || prep.ok !== true || prep.skip || prep.done) return prep;

  const wk = createWebkassa(webkassaConfig(await deps.config()), deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const point = payload.point_id;
  try {
    if (op === "x") return { ok: true, report: await wk.xReport(prep.cashbox) };
    if (op === "z") {
      let d;
      // Повторное закрытие дня (поздний чек, исправление): смена Webkassa уже закрыта первым Z - это не ошибка.
      try { d = await wk.zReport(prep.cashbox); }
      catch (e) { if (e && e.code === 12) return { ok: true, already: true }; throw e; }
      await deps.store(point, null, "z", true, { ...d, report_date: payload.date || prep.date }, null);
      return { ok: true, report: d };
    }
    if (op === "print") {
      const d = await wk.printFormat(prep.cashbox, prep.ext, prep.paper);
      return { ok: true, lines: ((d && d.Lines) || []).map((l) => String(l.Value ?? "")) };
    }
    let data;
    try {
      data = await wk.check(prep.body);
    } catch (e) {
      // ответ на первую попытку потерялся, а чек пробит - берём его из истории смены
      if (!isAlreadyIssued(e)) throw e;
      data = await findIssued(wk, prep.cashbox, prep.body.ExternalCheckNumber, prep.shift_hint);
      if (!data) throw e;
    }
    return await deps.store(point, payload.uid, op, true, data, null);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (op === "sale" || op === "return") {
      const r = await deps.store(point, payload.uid, op, false, null, msg);
      return { ok: false, error: (op === "return" ? "Возврат не пробит в налоговой: " : "Чек не пробит в налоговой: ") + msg,
        network: !!(e && e.network), code: e && e.code != null ? e.code : null, fiscal: r && r.fiscal };
    }
    if (op === "z") await deps.store(point, null, "z", false, { report_date: payload.date || prep.date }, msg);
    return { ok: false, error: "Webkassa: " + msg, network: !!(e && e.network), code: e && e.code != null ? e.code : null };
  }
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
