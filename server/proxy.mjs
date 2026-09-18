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

// Вся маршрутизация, служебный ключ и счётчик неверных кодов — в базе (public.tandem_gate).
async function gate(action, payload) {
  const q = await pool.query("select public.tandem_gate(action => $1, payload => $2::jsonb) as r", [action, JSON.stringify(payload)]);
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
      send(res, 200, await gate(action, payload));
    } catch (e) {
      console.error(action, e.message);
      send(res, 500, { ok: false, error: "Ошибка базы данных", detail: String(e.message).slice(0, 300) });
    }
  });
}).listen(Number(process.env.PORT || 8787), () => console.log("tandem proxy :" + (process.env.PORT || 8787)));
