// Прокси «JSON → функция базы» для собственного сервера: замена Supabase Edge Function `uchet`.
// Логики здесь нет намеренно — вся она в SQL-функциях. Маршрутизация повторяет
// supabase/functions/uchet/index.ts один в один; при правке одного правьте и другой.
//
// Переменные окружения: DATABASE_URL (postgres://…), PORT (8787),
//   CORS_ORIGIN (* или адрес сайта), PG_STATEMENT_TIMEOUT_MS (20000).
import http from "node:http";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000) });
const CORS = {
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};
const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CORS }); res.end(JSON.stringify(obj)); };

// Имя функции и её именованные аргументы по действию. Значения уходят параметрами запроса,
// имена — только из этой таблицы: из запроса пользователя в текст SQL ничего не попадает.
function route(action, payload) {
  const pin = payload.pin ?? "";
  switch (action) {
    case "charts": return ["tandem_charts", { p_pin: pin, p_point: payload.point_id ?? "" }];
    case "realization": return ["tandem_realization", { p_pin: pin, p_action: payload.op ?? "list", p_data: payload.data ?? {} }];
    case "save_aliases": return ["tandem_save_aliases", { p_pin: pin, p_point: payload.point_id ?? "", p_data: payload.data ?? [] }];
    case "sync_items": return ["tandem_sync_items", { p_pin: pin, p_items: payload.items ?? [] }];
    case "sync_prices": return ["tandem_sync_prices", { p_pin: pin, p_data: payload.data ?? [] }];
    case "recalc_ranks": return ["tandem_recalc_ranks", { p_pin: pin, p_days: payload.days ?? 30 }];
    case "set_packaging": return ["tandem_set_packaging", { p_pin: pin, p_data: payload.data ?? [] }];
    case "set_short_list": return ["tandem_set_short_list", { p_pin: pin, p_point: payload.point ?? "", p_codes: payload.codes ?? [] }];
    case "migrate": return ["tandem_migrate", { p_pin: pin, p_kind: payload.kind ?? "", p_rows: payload.rows ?? [] }];
    case "test_cleanup": return ["tandem_test_cleanup", { p_pin: pin }];
  }
  if (action.startsWith("office_")) return ["tandem_office", { action: action.slice(7), payload }];
  return ["tandem_api", { action, payload }];
}

const JSON_ARGS = new Set(["payload", "p_data", "p_items", "p_rows", "p_codes"]);
async function callFn(fn, args) {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}${JSON_ARGS.has(n) ? "::jsonb" : ""}`).join(", ")}) as r`;
  const values = names.map((n) => JSON_ARGS.has(n) ? JSON.stringify(args[n]) : args[n]);
  const q = await pool.query(sql, values);
  return q.rows[0].r;
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end("ok"); }
  if (req.method === "GET") return send(res, 200, { ok: true, service: "tandem-uchet-proxy" });
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Метод не поддерживается" });
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 8e6) req.destroy(); });
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "Некорректный запрос" }); }
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    if (!/^[a-z_]{1,60}$/.test(action)) return send(res, 400, { ok: false, error: "Некорректное действие" });
    try {
      const [fn, args] = route(action, payload);
      send(res, 200, await callFn(fn, args));
    } catch (e) {
      console.error(action, e.message);
      send(res, 500, { ok: false, error: "Ошибка базы данных", detail: String(e.message).slice(0, 300) });
    }
  });
}).listen(Number(process.env.PORT || 8787), () => console.log("tandem proxy :" + (process.env.PORT || 8787)));
