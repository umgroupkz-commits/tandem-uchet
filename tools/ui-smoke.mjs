// Дымовой тест интерфейса: открывает экраны в настоящем браузере и проверяет, что они живы.
// Только читает — ничего не создаёт и не проводит, поэтому безопасен на боевом сайте.
// Зависимостей нет: Chrome запускается без окна и управляется по протоколу отладки (CDP).
//
// Запуск:  node tools/ui-smoke.mjs
// Переменные: TANDEM_SITE_URL (по умолчанию сайт на GitHub Pages), TANDEM_ADMIN_LOGIN (admin),
//   TANDEM_ADMIN_PIN — без него проверяются только экраны без входа; CHROME_PATH — путь к браузеру.
import { spawn } from "child_process";
import fs from "fs"; import os from "os"; import path from "path";

const SITE = (process.env.TANDEM_SITE_URL || "https://umgroupkz-commits.github.io/tandem-uchet/").replace(/\/?$/, "/");
const LOGIN = process.env.TANDEM_ADMIN_LOGIN || "admin", PIN = process.env.TANDEM_ADMIN_PIN || "";
const CHROME = process.env.CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
if (!CHROME) { console.error("Не нашёл браузер: задайте CHROME_PATH"); process.exit(2); }

let passed = 0, failed = 0;
const check = (name, cond, detail) => { if (cond) { passed++; console.log("  ok   " + name); } else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 300) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-ui-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=1280,900",
  "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });

async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = list.find((t) => t.type === "page"); if (pg) return pg.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error("браузер не ответил");
}
const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0; const waiting = new Map(); const pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url || "")) pageErrors.push(m.params.entry.text + " " + (m.params.entry.url || ""));
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
async function go(page) { pageErrors.length = 0; await send("Page.navigate", { url: SITE + page }); await sleep(1500); }
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "ошибка в странице");
  return r.result?.result?.value;
}
// Ждём условия на странице, а не фиксированную паузу: сеть бывает медленной.
async function until(expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await js("return (" + expr + ")"); if (v) return v; } catch {} await sleep(300); }
  return null;
}
const clickText = (sel, text) => js(`const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b;`);

try {
  console.log("сайт: " + SITE + "\n\n== экраны без входа");
  await go("index.html");
  check("экран точки: список точек загрузился", await until("document.querySelector('select') && document.querySelector('select').options.length > 2"), null);
  await go("guide.html");
  const steps = await until("document.querySelectorAll('details.step').length");
  check("маршрут проверки: шаги отрисованы", steps >= 25, steps);
  check("маршрут проверки: отчёт собирается", (await js("return document.getElementById('report').value.length")) > 200);
  await go("help.html#tech");
  check("памятки: роль из адреса выбрана, шапка на месте", await js("return document.querySelector('nav button[aria-selected=true]').textContent === 'Технолог' && window.scrollY === 0"));
  await clickText("nav button", "Собственник");
  check("памятки: переключение роли", await js("return [...document.querySelectorAll('section')].filter((s) => !s.hidden).map((s) => s.id).join() === 'r-owner'"));
  check("экраны без входа: ошибок в консоли нет", pageErrors.length === 0, pageErrors);

  if (!PIN) console.log("\n== бэк-офис пропущен: задайте TANDEM_ADMIN_PIN");
  else {
    console.log("\n== бэк-офис");
    await go("office.html");
    await until("document.getElementById('llogin')");
    await js(`document.getElementById('llogin').value = ${JSON.stringify(LOGIN)}; document.getElementById('lpin').value = ${JSON.stringify(PIN)}; document.getElementById('lbtn').click();`);
    check("вход администратора", await until("document.getElementById('uname') && document.getElementById('uname').textContent.length > 0 && !document.getElementById('shell').hidden"), null);
    const sections = { "Номенклатура": "#main table tr.row, #main .tree, #main input", "Техкарты": "#main table tr", "Склады": "#main table tr.row",
      "Контрагенты": "#main table tr.row", "Пользователи": "#main table tr.row", "Склад": "#main table" };
    for (const [title, probe] of Object.entries(sections)) {
      await clickText("#menu button", title);
      check("раздел «" + title + "» открылся", await until(`document.querySelector(${JSON.stringify(probe)}) && !/Раздел не открылся|Загрузка…/.test(document.getElementById('main').innerText)`), await js("return document.getElementById('main').innerText.slice(0, 120)"));
    }
    for (const [tab, probe] of Object.entries({ "Остатки": "#bal-root table", "Продажи": "#sales-root table", "Ведомость": "#turn-root table", "Готовность": "#ready-root details", "Документы": "#main table" })) {
      await clickText("#main .tabs button", tab);
      check("склад → «" + tab + "»", await until(`document.querySelector(${JSON.stringify(probe)})`), await js("return document.getElementById('main').innerText.slice(0, 120)"));
    }
    await clickText("#main .tabs button", "Готовность");
    const checks = await until("document.querySelectorAll('#ready-root details').length");
    check("готовность: все проверки отрисованы", checks >= 8, checks);
    await clickText("#menu button", "Техкарты");
    await until("document.querySelector('#main table tr.row')");
    await js("document.querySelector('#main table tr.row').click()");
    check("техкарта открывается в окне", await until("[...document.querySelectorAll('h2')].some((h) => h.offsetParent && h.textContent === 'Состав')"), null);
    check("бэк-офис: ошибок в консоли нет", pageErrors.length === 0, pageErrors);

    console.log("\n== склад с телефона");
    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await go("stock.html");
    // Сессия общая с бэк-офисом: вход уже выполнен, экран должен показать выбор склада или меню.
    check("открылся выбор склада или меню сценариев", await until("document.querySelectorAll('#main button').length > 0"), await js("return document.body.innerText.slice(0, 160)"));
    check("страница не шире экрана телефона", await js("return document.documentElement.scrollWidth <= 380"), await js("return document.documentElement.scrollWidth"));
    check("склад с телефона: ошибок в консоли нет", pageErrors.length === 0, pageErrors);
    await js("const b = document.getElementById('logout') || [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Выйти'); if (b) b.click();");
    await sleep(1500);
  }
} catch (e) {
  failed++; console.log("  FAIL тест оборвался: " + e.message);
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
