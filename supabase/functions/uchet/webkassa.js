// Клиент Webkassa (онлайн-ККМ) для фискализации чеков кассы. Обычный JS-модуль без зависимостей: его
// подключают и Edge Function uchet (Deno), и прокси своего сервера (Node), и проверка tools/webkassa-probe.mjs.
// Контракт - docs/webkassa-api.md (Postman «Интеграторы_v4-2.0.3»). Ключи сюда не вписываются: конфиг
// приходит из переменных окружения вызывающего (WEBKASSA_BASE, WEBKASSA_API_KEY, WEBKASSA_LOGIN,
// WEBKASSA_PASSWORD; WEBKASSA_MODE=sim - имитация без сети для песочницы и тестов).

const SIM_RNM = "000000000000";

export function webkassaConfig(env) {
  const get = (k) => (typeof env === "function" ? env(k) : env[k]) || "";
  return {
    mode: get("WEBKASSA_MODE") === "sim" ? "sim" : "real",
    base: (get("WEBKASSA_BASE") || "https://devkkm.webkassa.kz").replace(/\/+$/, ""),
    apiKey: get("WEBKASSA_API_KEY"), login: get("WEBKASSA_LOGIN"), password: get("WEBKASSA_PASSWORD"),
  };
}

// Ошибка Webkassa: code - их код из Errors[], text - их текст; network - не дошли или не получили ответ
// (тогда чек мог и пробиться: повтор с тем же ExternalCheckNumber не создаст второй).
export class WebkassaError extends Error {
  constructor(text, { code = null, network = false, status = 0 } = {}) {
    super(text); this.code = code; this.network = network; this.status = status;
  }
}

export function createWebkassa(cfg, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  let token = null;
  if (cfg.mode === "sim") return simulator();
  if (!cfg.apiKey || !cfg.login || !cfg.password) {
    const fail = async () => { throw new WebkassaError("Касса Webkassa не настроена: нет ключа, логина или пароля на сервере"); };
    return { authorize: fail, check: fail, money: fail, xReport: fail, zReport: fail, printFormat: fail, byNumber: fail, cashboxes: fail, refUnits: fail };
  }

  async function post(path, body, extraHeaders = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r, text;
    try {
      r = await fetchImpl(cfg.base + path, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, ...extraHeaders },
        body: JSON.stringify(body),
      });
      text = await r.text();
    } catch (e) {
      throw new WebkassaError("Нет связи с Webkassa: " + (e && e.name === "AbortError" ? "не ответила за " + timeoutMs / 1000 + " с" : (e && e.message) || e), { network: true });
    } finally { clearTimeout(t); }
    let j = null; try { j = JSON.parse(text); } catch { /* не JSON */ }
    if (!r.ok && !j) throw new WebkassaError("Webkassa ответила HTTP " + r.status + ": " + String(text).slice(0, 200), { status: r.status, network: r.status >= 500 });
    const errs = (j && (j.Errors || j.errors)) || [];
    if (errs.length) {
      const e = errs[0];
      throw new WebkassaError(String(e.Text || e.text || e.Message || JSON.stringify(e)), { code: e.Code ?? e.code ?? null, status: r.status });
    }
    return (j && (j.Data ?? j.data)) ?? j;
  }

  async function authorize() {
    const d = await post("/api/v4/Authorize", { Login: cfg.login, Password: cfg.password });
    token = d && (d.Token || d.token);
    if (!token) throw new WebkassaError("Webkassa не выдала токен");
    return token;
  }
  // Токен живёт ограниченное время: на ошибке авторизации получаем новый и повторяем один раз.
  async function withToken(path, body, headers) {
    if (!token) await authorize();
    try { return await post(path, { Token: token, ...body }, headers); }
    catch (e) {
      if (!e.network && isAuthError(e)) { await authorize(); return await post(path, { Token: token, ...body }, headers); }
      throw e;
    }
  }

  return {
    authorize,
    check: (body) => withToken("/api/v4/check", body),
    money: (body) => withToken("/api/v4/MoneyOperation", body),
    xReport: (cashbox) => withToken("/api/v4/XReport", { CashboxUniqueNumber: cashbox }),
    zReport: (cashbox) => withToken("/api/v4/ZReport", { CashboxUniqueNumber: cashbox }),
    printFormat: (cashbox, externalNumber, paperKind = 3) => withToken("/api/v4/Ticket/PrintFormat",
      { CashboxUniqueNumber: cashbox, ExternalCheckNumber: externalNumber, PaperKind: paperKind },
      { "Accept-Language": "ru-RU", "Secondary-Language": "kk-KZ" }),
    byNumber: (cashbox, number, shift) => withToken("/api/v4/Check/HistoryByNumber", { CashboxUniqueNumber: cashbox, Number: number, ShiftNumber: shift }),
    cashboxes: () => withToken("/api/v4/Cashboxes", {}),
    refUnits: () => withToken("/api/v4/references/RefUnits", {}),
  };
}

function isAuthError(e) {
  return e.status === 401 || /токен|token|авториз|authoriz/i.test(e.message || "");
}

// Имитация Webkassa: те же формы ответов, без сети. Пробитый чек запоминается по ExternalCheckNumber, так
// что повтор возвращает тот же фискальный признак - как настоящая касса.
function simulator() {
  const issued = new Map(); let shift = 1, order = 0;
  const now = () => new Date().toISOString();
  return {
    authorize: async () => "sim-token",
    check: async (b) => {
      if (!b || !Array.isArray(b.Positions) || !b.Positions.length) throw new WebkassaError("Нет позиций в чеке", { code: 1 });
      const pay = (b.Payments || []).reduce((s, p) => s + Number(p.Sum || 0), 0);
      const total = b.Positions.reduce((s, p) => s + Number(p.Price) * Number(p.Count) - Number(p.Discount || 0) + Number(p.Markup || 0), 0);
      if (pay + 0.009 < total) throw new WebkassaError("Сумма оплат меньше суммы чека", { code: 3 });
      if (issued.has(b.ExternalCheckNumber)) return issued.get(b.ExternalCheckNumber);
      const n = String(Math.floor(1e11 + Math.random() * 9e11));
      const d = { CheckNumber: n, DateTime: now(), OfflineMode: false, CashboxOfflineMode: false, ShiftNumber: shift,
        CheckOrderNumber: ++order, EmployeeName: "Имитация",
        Cashbox: { UniqueNumber: b.CashboxUniqueNumber, RegistrationNumber: SIM_RNM, IdentityNumber: "SIM" },
        TicketUrl: "https://devkkm.webkassa.kz/sim/" + n };
      issued.set(b.ExternalCheckNumber, d); return d;
    },
    money: async (b) => ({ OfflineMode: false, Sum: b.sum ?? b.Sum, DateTime: now() }),
    xReport: async () => ({ ShiftNumber: shift, DateTime: now() }),
    zReport: async () => { const d = { ShiftNumber: shift, DateTime: now() }; shift++; order = 0; return d; },
    printFormat: async (_c, ext) => { const d = issued.get(ext); return { Lines: d ? [{ Value: "ИМИТАЦИЯ ЧЕКА" }, { Value: "ФП " + d.CheckNumber }] : [] }; },
    byNumber: async () => null, cashboxes: async () => ({ List: [{ UniqueNumber: "SIM" }] }), refUnits: async () => [],
  };
}
