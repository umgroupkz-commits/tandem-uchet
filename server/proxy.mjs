// Прокси «JSON → функция базы» для собственного сервера: замена Supabase Edge Function `uchet`.
// Логики здесь нет намеренно — вся она в SQL-функциях. Маршрутизация повторяет
// supabase/functions/uchet/index.ts один в один; при правке одного правьте и другой.
//
// Переменные окружения: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE — подключение к базе
//   (pg читает их сам; пароль отдельной переменной, а не внутри postgres://…, где знаки / # ? +
//   ломают разбор адреса), PORT (8787), CORS_ORIGIN (* или адрес сайта), PG_STATEMENT_TIMEOUT_MS (20000).
import http from "node:http";
import pg from "pg";

const MAX_BODY = 8e6;   // байт; nginx перед прокси должен пропускать больше (client_max_body_size 10m), иначе 413 отдаст он сам
const pool = new pg.Pool({ max: 10, statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 120000) });
// База закрыла простаивающее соединение (перезапуск db, pg_terminate_backend, сбой сети): без обработчика
// pg.Pool бросает необработанное 'error' и роняет весь процесс. Следующий запрос возьмёт новое соединение.
pool.on("error", (e) => console.error("pg: соединение закрыто базой:", e.message));
const CORS = {
  "access-control-allow-origin": process.env.CORS_ORIGIN || "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};
const send = (res, status, obj, extra) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...CORS, ...extra }); res.end(JSON.stringify(obj)); };

// Вся маршрутизация, служебный ключ и счётчик неверных кодов — в базе (public.tandem_gate).
async function gate(action, payload) {
  const q = await pool.query("select public.tandem_gate(action => $1, payload => $2::jsonb) as r", [action, JSON.stringify(payload)]);
  return q.rows[0].r;
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end("ok"); }
  if (req.method === "GET") return send(res, 200, { ok: true, service: "tandem-uchet-proxy" });
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Метод не поддерживается" });
  // Тело копится кусками Buffer и декодируется один раз: при склейке в строку по кускам русская буква,
  // разрезанная границей куска, превращалась в U+FFFD — тихо, с ответом ok:true.
  const chunks = []; let size = 0, tooBig = false;
  req.on("error", () => {});   // клиент оборвал передачу — отвечать некому
  req.on("data", (c) => {
    if (tooBig) return;
    size += c.length;
    if (size <= MAX_BODY) return chunks.push(c);
    // Понятный ответ вместо молча оборванного соединения (касса приняла бы обрыв за отсутствие связи)
    tooBig = true; chunks.length = 0;
    send(res, 413, { ok: false, error: "Слишком большой запрос" }, { connection: "close" });
  });
  req.on("end", async () => {
    if (tooBig) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send(res, 400, { ok: false, error: "Некорректный запрос" }); }
    // null, число или строка вместо объекта: без проверки body.action бросал исключение и ронял процесс
    if (!body || typeof body !== "object") return send(res, 400, { ok: false, error: "Некорректный запрос" });
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
    if (!/^[a-z0-9_]{1,60}$/.test(action)) return send(res, 400, { ok: false, error: "Некорректное действие" });
    // IP клиента для счётчика неверных кодов в tandem_gate: x-real-ip ставит nginx ($remote_addr),
    // без nginx — адрес соединения. Присланное клиентом _ip всегда перезаписывается.
    payload._ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress || "").slice(0, 64) || null;
    try {
      send(res, 200, await gate(action, payload));
    } catch (e) {
      console.error(action, e.message);
      send(res, 500, { ok: false, error: "Ошибка базы данных", detail: String(e.message).slice(0, 300) });
    }
  });
}).listen(Number(process.env.PORT || 8787), () => console.log("tandem proxy :" + (process.env.PORT || 8787)));
