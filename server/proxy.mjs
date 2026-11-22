// Прокси «JSON → функция базы» для собственного сервера: замена Supabase Edge Function `uchet`.
// Логики здесь нет намеренно — вся она в SQL-функциях. Маршрутизация повторяет
// supabase/functions/uchet/index.ts один в один; при правке одного правьте и другой.
//
// Переменные окружения: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE — подключение к базе
//   (pg читает их сам; пароль отдельной переменной, а не внутри postgres://…, где знаки / # ? +
//   ломают разбор адреса), PORT (8787), CORS_ORIGIN (* или адрес сайта), PG_STATEMENT_TIMEOUT_MS (120000),
//   SITE_DIR - папка с экранами учёта (Dockerfile: /app/site): прокси отдаёт их сам, и рабочая программа живёт на
//   том же адресе, что и сервер (с 20.11.2026: https://uchet.eneshka.kz/; GitHub Pages - тестовая база в Supabase).
//   Рабочий config.js прокси пишет сам: адрес сервера - тот, с которого открыт экран.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { FISCAL_ACTIONS, handleFiscal } from "../supabase/functions/uchet/fiscal.js";

// Пределы тела запроса (ревизия 22.11.2026). На сервере PS.kz у прокси куча 64 МБ, а JSON из мелких объектов при разборе
// занимает в памяти в 20 с лишним раз больше себя: одно анонимное тело 7,9 МБ роняло процесс, и учёт лежал целиком.
// Самые большие пачки (перенос из iiko по 500 строк, техкарты по 100, прейскурант по 1000, справочник 1С по 500) -
// до 150 КБ и до 20 тысяч скобок и запятых. Caddy или nginx перед прокси должны пропускать не меньше MAX_BODY
// (client_max_body_size 3m), иначе 413 отдаст он сам.
const MAX_BODY = 2e6;        // байт в одном запросе
const MAX_ITEMS = 100000;    // скобок { [ и запятых в одном запросе - столько объектов и значений создаст разбор
const MAX_INFLIGHT = 6e6;    // байт во всех запросах, которые сейчас принимаются и обрабатываются, вместе
let inflight = 0;
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

const fiscalDeps = {
  gate,
  store: async (point, uid, op, ok, data, error) => (await pool.query(
    "select public.tandem_fiscal_store($1, $2::uuid, $3, $4, $5::jsonb, $6) as r", [point, uid, op, ok, data == null ? null : JSON.stringify(data), error])).rows[0].r,
  config: async () => process.env,
};

// Экраны учёта (SITE_DIR): только файлы с известными расширениями и только внутри папки. GET / без text/html
// в Accept (проверки curl, бот) по-прежнему получает {"ok":true,...}.
const SITE = process.env.SITE_DIR ? path.resolve(process.env.SITE_DIR) : "";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const PAGE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "SAMEORIGIN" };
const CONFIG_JS = "// Рабочая база учёта Тандема (сервер PS.kz): экраны и сервер на одном адресе.\n" +
  "window.TANDEM_API_URL = location.origin + \"/\";\n";
function serveSite(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return false; }
  if (p === "/") {
    if (!/text\/html/.test(String(req.headers.accept || ""))) return false;
    p = "/index.html";
  }
  if (p === "/config.js") {
    res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-cache", ...PAGE_HEADERS });
    return res.end(req.method === "HEAD" ? undefined : CONFIG_JS), true;
  }
  const file = path.resolve(SITE, "." + p);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(SITE + path.sep) || path.basename(file).startsWith(".")) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  // Страницы - всегда свежие; скрипты и стили приходят с ?v=<сборка>, им хватит пяти минут
  res.writeHead(200, { "content-type": type, "content-length": st.size,
    "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=300", ...PAGE_HEADERS });
  if (req.method === "HEAD") return res.end(), true;
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(200, CORS); return res.end("ok"); }
  if (req.method === "GET" || req.method === "HEAD") {
    if (SITE && serveSite(req, res)) return;
    const root = new URL(req.url, "http://x").pathname === "/";
    return send(res, SITE && !root ? 404 : 200, SITE && !root ? { ok: false, error: "Нет такой страницы" } : { ok: true, service: "tandem-uchet-proxy" });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Метод не поддерживается" });
  // Тело копится кусками Buffer и декодируется один раз: при склейке в строку по кускам русская буква,
  // разрезанная границей куска, превращалась в U+FFFD — тихо, с ответом ok:true.
  // Принятые байты занимают общий предел MAX_INFLIGHT до конца ответа: несколько больших запросов разом получают
  // 503 «повторите», а не роняют процесс (касса считает 503 обрывом связи и держит чеки в очереди).
  const chunks = []; let size = 0, done = false;
  res.on("close", () => { inflight -= size; size = 0; });
  // Понятный ответ вместо молча оборванного соединения (касса приняла бы обрыв за отсутствие связи)
  const refuse = (status, error) => { done = true; chunks.length = 0; send(res, status, { ok: false, error }, { connection: "close" }); };
  req.on("error", () => {});   // клиент оборвал передачу — отвечать некому
  req.on("data", (c) => {
    if (done) return;
    size += c.length; inflight += c.length;
    if (size > MAX_BODY) return refuse(413, "Слишком большой запрос");
    if (inflight > MAX_INFLIGHT) return refuse(503, "Сервер занят - повторите через минуту");
    chunks.push(c);
  });
  req.on("end", async () => {
    if (done) return;
    const buf = Buffer.concat(chunks); chunks.length = 0;
    let items = 0;
    for (let i = 0; i < buf.length; i++) { const b = buf[i]; if (b === 0x7b || b === 0x5b || b === 0x2c) items++; }
    if (items > MAX_ITEMS) return send(res, 413, { ok: false, error: "Слишком большой запрос" });
    let body;
    try { body = JSON.parse(buf.toString("utf8") || "{}"); } catch { return send(res, 400, { ok: false, error: "Некорректный запрос" }); }
    // null, число или строка вместо объекта: без проверки body.action бросал исключение и ронял процесс
    if (!body || typeof body !== "object") return send(res, 400, { ok: false, error: "Некорректный запрос" });
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
    // fiscal_prepare зовёт только фискальный модуль (fiscal.js) - через gate(), без сети. Снаружи он не нужен: заводит
    // строку журнала размена и изъятия и помечает чек «пробивается» без Webkassa (ревизия 22.11.2026).
    if (!/^[a-z0-9_]{1,60}$/.test(action) || action === "fiscal_prepare") return send(res, 400, { ok: false, error: "Некорректное действие" });
    // IP клиента для счётчика неверных кодов в tandem_gate: x-real-ip ставит nginx ($remote_addr),
    // без nginx — адрес соединения. За Caddy (сервер PS.kz, CLIENT_IP_HEADER=x-forwarded-for) - последний адрес
    // x-forwarded-for: его пишет сам Caddy, а x-real-ip он пропускает от клиента как есть. Присланное клиентом
    // _ip всегда перезаписывается.
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const fromHeader = process.env.CLIENT_IP_HEADER === "x-forwarded-for" ? xff[xff.length - 1] : req.headers["x-real-ip"];
    payload._ip = String(fromHeader || req.socket.remoteAddress || "").slice(0, 64) || null;
    try {
      // 0053: фискальные действия кассы (Webkassa) - как в Edge Function uchet; настройки Webkassa - переменные
      // окружения WEBKASSA_* этого прокси.
      if (FISCAL_ACTIONS.has(action)) return send(res, 200, await handleFiscal(action, payload, fiscalDeps));
      send(res, 200, await gate(action, payload));
    } catch (e) {
      // Текст ошибки базы - только в журнал сервера (docker compose logs uchet-proxy): снаружи по нему видно устройство базы
      console.error(action, e.message);
      send(res, 500, { ok: false, error: "Ошибка базы данных" });
    }
  });
});
// Медленная отправка тела держит место в MAX_INFLIGHT: на весь запрос - минута (2 МБ проходят и по слабой связи)
server.requestTimeout = 60000;
server.listen(Number(process.env.PORT || 8787), () => console.log("tandem proxy :" + (process.env.PORT || 8787)));
