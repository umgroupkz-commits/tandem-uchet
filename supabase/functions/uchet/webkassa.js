// Клиент Webkassa (онлайн-ККМ) для фискализации чеков кассы. Обычный JS-модуль без зависимостей: его
// подключают и Edge Function uchet (Deno), и прокси своего сервера (Node), и проверка tools/webkassa-probe.mjs.
// Контракт - docs/webkassa-api.md (Postman «Интеграторы_v4-2.0.3»). Ключи сюда не вписываются: конфиг
// приходит из переменных окружения вызывающего (WEBKASSA_BASE, WEBKASSA_API_KEY, WEBKASSA_LOGIN,
// WEBKASSA_PASSWORD; WEBKASSA_MODE=sim - имитация без сети для песочницы и тестов).

const SIM_RNM = "000000000000";
export const CHECK_PATH = "/api/v4/check";

export function webkassaConfig(env) {
  const get = (k) => (typeof env === "function" ? env(k) : env[k]) || "";
  return {
    mode: get("WEBKASSA_MODE") === "sim" ? "sim" : "real",
    base: (get("WEBKASSA_BASE") || "https://devkkm.webkassa.kz").replace(/\/+$/, ""),
    apiKey: get("WEBKASSA_API_KEY"), login: get("WEBKASSA_LOGIN"), password: get("WEBKASSA_PASSWORD"),
  };
}

// Ошибка Webkassa: code - их код из Errors[], text - их текст; network - не дошли или не получили ответ
// (тогда чек мог и пробиться: повтор с тем же ExternalCheckNumber не создаст второй); path - какой запрос
// (0065: «неизвестно, пробит ли» - только когда без ответа остался сам запрос чека, а не вход).
export class WebkassaError extends Error {
  constructor(text, { code = null, network = false, status = 0, path = "" } = {}) {
    super(text); this.code = code; this.network = network; this.status = status; this.path = path;
  }
}

// 0065: вход в Webkassa - один на процесс для пары «адрес + логин»: у пользователя Webkassa одна сессия, и
// новый вход закрывает прежнюю (код 2). Когда каждый запрос входил сам, одновременные чеки (несколько точек
// или повтор кассы) выбивали друг друга: «Срок действия сессии истек».
const sessions = new Map();   // адрес|логин → { token, login: общий промис идущего входа }
export function resetWebkassaSessions() { sessions.clear(); }   // для проверок

export function createWebkassa(cfg, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  if (cfg.mode === "sim") return simulator();
  if (!cfg.apiKey || !cfg.login || !cfg.password) {
    const fail = async () => { throw new WebkassaError("Касса Webkassa не настроена: нет ключа, логина или пароля на сервере"); };
    return { authorize: fail, check: fail, money: fail, xReport: fail, zReport: fail, printFormat: fail, byNumber: fail, history: fail, cashboxes: fail, refUnits: fail };
  }
  const key = cfg.base + "|" + cfg.login;
  if (!sessions.has(key)) sessions.set(key, { token: null, login: null });
  const sess = sessions.get(key);

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
      throw new WebkassaError("Нет связи с Webkassa: " + (e && e.name === "AbortError" ? "не ответила за " + timeoutMs / 1000 + " с" : (e && e.message) || e), { network: true, path });
    } finally { clearTimeout(t); }
    let j = null; try { j = JSON.parse(text); } catch { /* не JSON */ }
    if (!r.ok && !j) throw new WebkassaError("Webkassa ответила HTTP " + r.status + ": " + String(text).slice(0, 200), { status: r.status, network: r.status >= 500, path });
    const errs = (j && (j.Errors || j.errors)) || [];
    if (errs.length) {
      const e = errs[0];
      throw new WebkassaError(String(e.Text || e.text || e.Message || JSON.stringify(e)), { code: e.Code ?? e.code ?? null, status: r.status, path });
    }
    return (j && (j.Data ?? j.data)) ?? j;
  }

  // Вход: идущий вход общий - второй запрос ждёт его, а не входит сам (и не закрывает сессию первого).
  function authorize() {
    if (!sess.login) {
      sess.login = (async () => {
        try {
          const d = await post("/api/v4/Authorize", { Login: cfg.login, Password: cfg.password });
          const t = d && (d.Token || d.token);
          if (!t) throw new WebkassaError("Webkassa не выдала токен");
          sess.token = t;
          return t;
        } finally { sess.login = null; }
      })();
    }
    return sess.login;
  }
  // Токен живёт ограниченное время, и его закрывает любой новый вход того же пользователя (другой сервер,
  // приложение Webkassa): на ошибке авторизации берём токен, который уже получил соседний запрос, или входим
  // заново - до двух раз.
  async function withToken(path, body, headers) {
    let used = sess.token || await authorize();
    for (let i = 0; ; i++) {
      try { return await post(path, { Token: used, ...body }, headers); }
      catch (e) {
        if (e.network || !isAuthError(e) || i >= 2) throw e;
        used = sess.token && sess.token !== used ? sess.token : await authorize();
      }
    }
  }

  return {
    authorize,
    check: (body) => withToken(CHECK_PATH, body),
    money: (body) => withToken("/api/v4/MoneyOperation", body),
    xReport: (cashbox) => withToken("/api/v4/XReport", { CashboxUniqueNumber: cashbox }),
    zReport: (cashbox) => withToken("/api/v4/ZReport", { CashboxUniqueNumber: cashbox }),
    printFormat: (cashbox, externalNumber, paperKind = 3) => withToken("/api/v4/Ticket/PrintFormat",
      { CashboxUniqueNumber: cashbox, ExternalCheckNumber: externalNumber, PaperKind: paperKind },
      { "Accept-Language": "ru-RU", "Secondary-Language": "kk-KZ" }),
    byNumber: (cashbox, number, shift) => withToken("/api/v4/Check/HistoryByNumber", { CashboxUniqueNumber: cashbox, Number: number, ShiftNumber: shift }),
    history: (cashbox, shift, skip = 0, take = 50) => withToken("/api/v4/Check/History", { CashboxUniqueNumber: cashbox, ShiftNumber: shift, Skip: skip, Take: take }),
    cashboxes: () => withToken("/api/v4/Cashboxes", {}),
    refUnits: () => withToken("/api/v4/references/RefUnits", {}),
  };
}

// Код 2 «Срок действия сессии истек»: у пользователя Webkassa одна сессия, новый вход (другой сервер,
// проверка) закрывает прежнюю - тогда входим заново и повторяем запрос.
function isAuthError(e) {
  return e.code === 2 || e.status === 401 || /сесси|токен|token|авториз|authoriz/i.test(e.message || "");
}
// Код 14 «Чек с внешним номером … уже присутствует»: чек уже пробит (ответ на первую попытку потерялся).
export const isAlreadyIssued = (e) => !!e && e.code === 14;

// Имитация Webkassa: те же формы ответов и то же поведение, что у кассы, без сети. 0065: состояние - на процесс,
// отдельно по каждой кассе (CashboxUniqueNumber), а не на запрос: пробитый чек помнится по ExternalCheckNumber
// (повтор - код 14, как у настоящей кассы), наличные и номер смены копятся, Z закрывает смену (повторный Z - код 12),
// X её показывает, печатная форма и история смены отдают пробитое. Для проверок сбоев (стенд, office-smoke) - тиыны
// суммы чека или операции: ,77 - пробито, но ответ «потерялся» (обрыв связи); ,78 - отказ Webkassa; ,79 - ответ через 3 с.
const SIM = new Map();   // касса → {docs, shift, open, start, order, n, cash, sell, ret}
export function resetWebkassaSim() { SIM.clear(); }

function simulator() {
  const pad = (x) => String(x).padStart(2, "0");
  const wkTime = (t = new Date()) => pad(t.getDate()) + "." + pad(t.getMonth() + 1) + "." + t.getFullYear() + " "
    + pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds());
  const r2 = (x) => Math.round(x * 100) / 100;
  const box = (cb) => {
    const k = String(cb || "SIM");
    if (!SIM.has(k)) SIM.set(k, { docs: new Map(), shift: 0, open: false, start: null, order: 0, n: 0, cash: 0, sell: null, ret: null });
    return SIM.get(k);
  };
  const openShift = (k) => {
    if (k.open) return;
    k.shift++; k.open = true; k.start = wkTime(); k.order = 0; k.n = 0;
    k.sell = { Count: 0, by: {} }; k.ret = { Count: 0, by: {} };
  };
  // сбой по тиынам суммы: ,78 - отказ, ,79 - медленный ответ; true - «ответ потерялся» (,77)
  const hook = async (sum) => {
    const c = Math.round(Number(sum || 0) * 100) % 100;
    if (c === 78) throw new WebkassaError("Имитация: отказ Webkassa (тиыны ,78)", { code: 1 });
    if (c === 79) await new Promise((ok) => setTimeout(ok, 3000));
    return c === 77;
  };
  const lost = (path) => new WebkassaError("Нет связи с Webkassa: имитация потерянного ответа (тиыны ,77)", { network: true, path });
  const part = (p) => ({ Count: p ? p.Count : 0, PaymentsByTypesApiModel: p ? Object.entries(p.by).map(([Type, Sum]) => ({ Type: Number(Type), Sum })) : [] });
  return {
    authorize: async () => "sim-token",
    check: async (b) => {
      if (!b || !Array.isArray(b.Positions) || !b.Positions.length) throw new WebkassaError("Нет позиций в чеке", { code: 1 });
      const k = box(b.CashboxUniqueNumber);
      const pay = r2((b.Payments || []).reduce((s, p) => s + Number(p.Sum || 0), 0));
      const total = r2(b.Positions.reduce((s, p) => s + r2(Number(p.Price) * Number(p.Count)) - Number(p.Discount || 0) + Number(p.Markup || 0), 0));
      if (pay + 0.009 < total) throw new WebkassaError("Сумма оплат меньше суммы чека", { code: 3 });
      if (k.docs.has(b.ExternalCheckNumber)) throw new WebkassaError("Чек с внешним номером " + b.ExternalCheckNumber + " уже присутствует", { code: 14 });
      const isLost = await hook(pay);
      openShift(k);
      const ret = Number(b.OperationType) === 3, n = String(Math.floor(1e11 + Math.random() * 9e11));
      const d = { CheckNumber: n, DateTime: wkTime(), OfflineMode: false, CashboxOfflineMode: false, ShiftNumber: k.shift,
        CheckOrderNumber: ++k.order, EmployeeName: "Имитация", Total: total, ExternalCheckNumber: b.ExternalCheckNumber,
        Cashbox: { UniqueNumber: b.CashboxUniqueNumber, RegistrationNumber: SIM_RNM, IdentityNumber: "SIM" },
        TicketUrl: "https://devkkm.webkassa.kz/sim/" + n };
      const p = ret ? k.ret : k.sell; p.Count++; k.n++;
      for (const x of b.Payments || []) {
        const t = Number(x.PaymentType) || 0, sum = Number(x.Sum || 0);
        p.by[t] = r2((p.by[t] || 0) + sum);
        if (t === 0) k.cash = r2(k.cash + (ret ? -sum : sum));
      }
      k.docs.set(b.ExternalCheckNumber, { d, shift: k.shift, at: new Date(), payments: b.Payments || [], positions: b.Positions, ret });
      if (isLost) throw lost(CHECK_PATH);
      return d;
    },
    money: async (b) => {
      const k = box(b.CashboxUniqueNumber ?? b.cashboxUniqueNumber);
      const ext = b.ExternalCheckNumber ?? b.externalCheckNumber, sum = Number(b.Sum ?? b.sum ?? 0);
      const out = Number(b.OperationType ?? b.operationType) === 1;
      if (ext && k.docs.has(ext)) throw new WebkassaError("Операция с внешним номером " + ext + " уже присутствует", { code: 14 });
      const isLost = await hook(sum);
      openShift(k);
      k.cash = r2(k.cash + (out ? -sum : sum)); k.n++;
      if (ext) k.docs.set(ext, { money: true, shift: k.shift, at: new Date() });
      if (isLost) throw lost("/api/v4/MoneyOperation");
      return { OfflineMode: false, Sum: k.cash, ShiftNumber: k.shift, DateTime: wkTime() };
    },
    xReport: async (cb) => {
      const k = box(cb);
      return { ShiftNumber: k.shift || 1, StartOn: k.start, DateTime: wkTime(), DocumentCount: k.n,
        SumInCashbox: k.cash, OfflineMode: false, CashboxOfflineMode: false, Sell: part(k.sell), ReturnSell: part(k.ret) };
    },
    zReport: async (cb) => {
      const k = box(cb);
      if (!k.open) throw new WebkassaError("Смена уже закрыта", { code: 12 });
      const d = { ShiftNumber: k.shift, DateTime: wkTime(), CloseOn: wkTime(), StartOn: k.start, DocumentCount: k.n,
        SumInCashbox: k.cash, Sell: part(k.sell), ReturnSell: part(k.ret) };
      k.open = false;
      return d;
    },
    printFormat: async (cb, ext) => {
      const x = box(cb).docs.get(ext);
      if (!x || !x.d) return { Lines: [] };
      const d = x.d, pay = { 0: "Наличные", 1: "Банковская карта", 4: "Мобильный платёж" };
      const lines = ["ИМИТАЦИЯ WEBKASSA - НЕ ФИСКАЛЬНЫЙ ЧЕК", "ЗНК " + (d.Cashbox.UniqueNumber || "SIM") + "  РНМ " + SIM_RNM,
        "Смена №" + d.ShiftNumber + "  Чек №" + d.CheckOrderNumber, d.DateTime, x.ret ? "ВОЗВРАТ ПРОДАЖИ" : "ПРОДАЖА", "--------------------------------",
        ...(x.positions || []).map((p) => String(p.PositionName || "Позиция").slice(0, 30) + " " + p.Count + " x " + p.Price
          + (Number(p.Discount) ? " скидка " + p.Discount : "")),
        "--------------------------------", "ИТОГО: " + d.Total, ...x.payments.map((p) => (pay[p.PaymentType] || "Оплата") + ": " + p.Sum),
        "Фискальный признак: " + d.CheckNumber, "Кассир: " + d.EmployeeName, "Проверить чек на сайте ОФД:", d.TicketUrl];
      return { Lines: lines.map((Value, Order) => ({ Order, Value })) };
    },
    byNumber: async (cb, number) => {
      for (const x of box(cb).docs.values()) if (x.d && x.d.CheckNumber === String(number)) return { ...x.d, Payments: x.payments };
      return null;
    },
    // История смены: как у Webkassa (docs/webkassa-api.md) - номер, внешний номер, время, ссылка; РНМ здесь нет
    history: async (cb, shift, skip = 0, take = 50) => ({ Items: [...box(cb).docs.values()].filter((x) => x.d && x.shift === Number(shift))
      .slice(skip, skip + take).map((x) => ({ ExternalCheckNumber: x.d.ExternalCheckNumber, Number: x.d.CheckNumber,
        RegistratedOn: x.at.toISOString().slice(0, 19), TicketUrl: x.d.TicketUrl, Total: x.d.Total })) }),
    cashboxes: async () => ({ List: [...new Set(["SIM", ...SIM.keys()])].map((UniqueNumber) => ({ UniqueNumber, RegistrationNumber: SIM_RNM })) }),
    refUnits: async () => [],
  };
}
