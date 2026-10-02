// Автопрогон уроков обучалки: открывает Chrome без окна, кладёт учебные учётки в localStorage, запускает урок
// с autoplay — движок (js/tour.js) сам нажимает и вводит — и ждёт «[tour] done <урок>» в консоли.
// Урок готов, если проходит целиком. Зависимостей нет (CDP по WebSocket, как tools/ui-smoke.mjs).
//
// Запуск:  node tools/tour-run.mjs <id урока> [id …]     или     node tools/tour-run.mjs role:sklad
// Переменные: TANDEM_SITE_URL — сайт (по умолчанию GitHub Pages); TOUR_CREDS — путь к JSON с учётками в форме
//   ответа training_info ({sklad:{login,pin}, buh, tech, owner, kassa:{point,pin}, point:{point,pin}, owner_code});
//   без него учётки берутся кодом обучения TANDEM_TRAINING_CODE через сервер; CHROME_PATH; TOUR_WIDTH/TOUR_HEIGHT
//   (по умолчанию 1366×900; для телефона 390×844 — урок с page: "stock.html" включает эмуляцию сам, если
//   в уроке mobile: true); TOUR_SHOTS — папка для снимка экрана при сбое.
import { spawn } from "child_process";
import fs from "fs"; import os from "os"; import path from "path";

const SITE = (process.env.TANDEM_SITE_URL || "https://umgroupkz-commits.github.io/tandem-uchet/").replace(/\/?$/, "/");
const CHROME = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("Не нашёл браузер: задайте CHROME_PATH"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
if (!args.length) { console.error("укажите id урока или role:<роль>"); process.exit(2); }

const port = 9400 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-tour-"));
fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ credentials_enable_service: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false } }));
const W = Number(process.env.TOUR_WIDTH || 1366), H = Number(process.env.TOUR_HEIGHT || 900);
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--password-store=basic", "--lang=ru-RU",
  `--window-size=${W},${H}`, "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });

let finished = false;
chrome.on("exit", () => { if (!finished) { console.error("браузер закрылся во время прогона (его остановили снаружи?)"); process.exit(3); } });
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = list.find((t) => t.type === "page"); if (pg) return pg.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error("браузер не ответил");
}
const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
ws.addEventListener("close", () => { if (!finished) { console.error("связь с браузером оборвалась во время прогона"); process.exit(3); } });
let seq = 0; const waiting = new Map(); const events = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") {
    const t = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (t.startsWith("[tour]")) events.push(t);
  }
  if (m.method === "Runtime.exceptionThrown") events.push("[error] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").slice(0, 300));
  // Окна confirm/prompt экрана: подтверждаем (как человек, который нажал «ОК»).
  if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true, promptText: "учебная причина" });
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "ошибка в странице");
  return r.result?.result?.value;
}

// Учётки: файл или код обучения.
let creds = null;
if (process.env.TOUR_CREDS) creds = JSON.parse(fs.readFileSync(process.env.TOUR_CREDS, "utf8"));
await send("Page.navigate", { url: SITE + "test.html" }); await sleep(2500);
if (!creds && process.env.TANDEM_TRAINING_CODE) {
  creds = await js(`const r = await fetch(window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet",
    {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({action:"training_info", payload:{code:${JSON.stringify(process.env.TANDEM_TRAINING_CODE)}}})});
    const j = await r.json(); return j.ok ? j.creds : null;`);
}
if (!creds) { console.error("нет учёток: задайте TOUR_CREDS или TANDEM_TRAINING_CODE"); process.exit(2); }
await js(`localStorage.setItem("tandem_training", ${JSON.stringify(JSON.stringify({ creds, at: new Date().toISOString() }))}); return true;`);

// Список уроков: id или role:<роль> (все уроки роли по порядку).
let ids = [];
for (const a of args) {
  if (a.startsWith("role:")) ids.push(...(await js(`return TandemTour.lessons(${JSON.stringify(a.slice(5))}).map((l) => l.id)`)) || []);
  else ids.push(a);
}
let ok = 0, bad = 0;
for (const id of ids) {
  events.length = 0;
  const info = await js(`const l = TandemTour.lessons().find((x) => x.id === ${JSON.stringify(id)}); return l ? {page: l.page, mobile: !!l.mobile, n: l.steps.length} : null`);
  if (!info) { console.log(`FAIL ${id}: урока нет`); bad++; continue; }
  // Узкий экран (TOUR_WIDTH < 500) или урок для телефона — настоящая эмуляция: окно без рамки уже 500 px не сжимается.
  // Размер окна задан (TOUR_WIDTH) — ровно такая область страницы, как у планшета или телефона: у окна без рамки
  // --window-size даёт меньшую область. Уже 500 px — ещё и телефон (касание, мобильная разметка).
  if (info.mobile) await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  else if (process.env.TOUR_WIDTH) await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: W < 500 ? 2 : 1, mobile: W < 500 });
  else await send("Emulation.clearDeviceMetricsOverride");
  await js(`TandemTour.start(${JSON.stringify(id)}, {autoplay: true, reload: true}); return true;`);
  const t0 = Date.now(); let res = null;
  while (Date.now() - t0 < 240000) {
    await sleep(500);
    const fail = events.find((e) => e.startsWith("[tour] FAIL")); if (fail) { res = fail; break; }
    if (events.some((e) => e === "[tour] done " + id)) { res = "done"; break; }
  }
  const okSteps = events.filter((e) => /^\[tour\] ok \d+/.test(e)).length;
  const skipped = events.filter((e) => /пропущен/.test(e)).length;
  if (res === "done") { ok++; console.log(`ok   ${id}  (${info.n} шагов${skipped ? ", пропущено необязательных: " + skipped : ""})`); }
  else {
    bad++;
    console.log(`FAIL ${id}: ${res || "не закончился за 4 мин"}; пройдено шагов ${okSteps} из ${info.n}`);
    for (const e of events.filter((x) => x.startsWith("[error]"))) console.log("     " + e);
    // что экран сказал человеку (сообщения об ошибке, всплывающие), — чтобы понять причину без снимка
    try {
      const said = await js(`return [...document.querySelectorAll(".msg, .err, .bad, .toast, .warn, [role=alert]")].filter((n) => n.offsetParent && !n.closest(".tt-ui"))
        .map((n) => n.textContent.trim().replace(/\\s+/g, " ").slice(0, 200)).filter(Boolean).slice(0, 5)`);
      for (const t of said || []) console.log("     на экране: " + t);
    } catch {}
    if (process.env.TOUR_SHOTS) {
      const sh = await send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(process.env.TOUR_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.TOUR_SHOTS, id + ".png"), Buffer.from(sh.result.data, "base64"));
    }
  }
  // следующий урок — снова со страницы обучения (там подключены все уроки)
  await send("Page.navigate", { url: SITE + "test.html" }); await sleep(1500);
}
console.log(`\nуроков пройдено ${ok}, провалено ${bad}`);
finished = true; try { ws.close(); } catch {} chrome.kill();
process.exit(bad ? 1 : 0);
