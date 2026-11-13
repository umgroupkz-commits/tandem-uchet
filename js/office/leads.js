// Раздел «Заявки WhatsApp» (0059): обращения клиентов Енешки и итог разбора переписки ботом - для рекламы.
// Бот молча читает разговор клиента с продавцом и пишет: был ли заказ, что заказали, сумма, время первого
// обращения. Смотрят СММ (роль smm - только этот раздел), собственник и администратор. Обновляется сам.
import { api } from "./api.js?v=28";
import { el, errText, today, isoDate } from "./ui.js?v=28";
import { fmtDate, fmtDateTime, fmtMoney } from "./inputs.js?v=28";

const OUTCOME = { order: "заказ", no_order: "не заказали", unclear: "непонятно", pending: "разговор идёт" };
const OUT_CLASS = { order: "ok", no_order: "dim", unclear: "warn", pending: "dim" };
const KIND = { delivery: "доставка", pickup: "самовывоз" };
const REFRESH_MS = 30_000;
const st = { from: today(), to: today(), outcome: "" };
let root, seq = 0, timer = null, lastList = [], lastReport = null;

export async function mount(main) {
  root = main;
  clearInterval(timer);
  // Живая страница: новые обращения появляются сами. Раздел закрыли - обновление останавливается.
  timer = setInterval(() => {
    if (!root || !root.isConnected) { clearInterval(timer); return; }
    if (!document.hidden) draw(true);
  }, REFRESH_MS);
  await draw(false);
}

const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d); };
function setPeriod(from, to) { st.from = from; st.to = to; draw(false); }

async function draw(quiet) {
  const n = ++seq;
  if (!quiet) root.replaceChildren(el("div", { class: "dim" }, "Загрузка…"));
  const [list, rep] = await Promise.all([api("lead_list", { from: st.from, to: st.to }), api("lead_report", { from: st.from, to: st.to })]);
  if (n !== seq) return;
  if (!list.ok || !rep.ok) {
    if (!quiet) root.replaceChildren(el("div", { class: "err" }, errText(list.ok ? rep : list)));
    return;
  }
  lastList = list.leads; lastReport = rep;
  const y = window.scrollY;
  root.replaceChildren(tools(), kpis(rep), table(list.leads), daysTable(rep), reasons(rep),
    el("div", { class: "dim", style: "margin-top:8px" }, `Обновлено ${new Date().toLocaleTimeString("ru-RU")}, само - каждые 30 секунд.`));
  if (quiet) window.scrollTo(0, y);
}

function tools() {
  const from = el("input", { type: "date", value: st.from, onchange: (e) => { if (e.target.value) setPeriod(e.target.value, st.to < e.target.value ? e.target.value : st.to); } });
  const to = el("input", { type: "date", value: st.to, onchange: (e) => { if (e.target.value) setPeriod(st.from > e.target.value ? e.target.value : st.from, e.target.value); } });
  const sel = el("select", { onchange: (e) => { st.outcome = e.target.value; draw(false); } },
    el("option", { value: "" }, "все"), ...Object.entries(OUTCOME).map(([k, v]) => el("option", { value: k }, v)));
  sel.value = st.outcome;
  return el("div", { class: "tools" },
    el("span", {}, "Первое обращение с"), from, el("span", {}, "по"), to,
    el("button", { class: "ghost", onclick: () => setPeriod(today(), today()) }, "Сегодня"),
    el("button", { class: "ghost", onclick: () => setPeriod(daysAgo(6), today()) }, "7 дней"),
    el("button", { class: "ghost", onclick: () => setPeriod(daysAgo(29), today()) }, "30 дней"),
    el("span", {}, "Итог"), sel,
    el("button", { onclick: exportXlsx }, "Excel"),
    el("button", { class: "ghost", title: "Номера заказавших в виде, который принимает Facebook (SHA-256), для аудиторий и похожих аудиторий",
      onclick: exportFacebook }, "Для Facebook"));
}

function kpis(r) {
  const conv = r.leads ? Math.round((r.orders / r.leads) * 100) : 0;
  const box = (title, value, hint) => el("div", { class: "card", style: "min-width:140px;flex:1" },
    el("div", { class: "dim" }, title), el("div", { style: "font-size:1.6em;font-weight:700" }, value), hint ? el("div", { class: "dim" }, hint) : null);
  return el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0" },
    box("Обращений", String(r.leads), r.pending ? `разговор идёт: ${r.pending}` : ""),
    box("Заказов", String(r.orders), r.unclear ? `непонятно: ${r.unclear}` : ""),
    box("Конверсия", `${conv} %`, "из обращения в заказ"),
    box("Выручка", fmtMoney(r.revenue), "по заказам из WhatsApp"),
    box("Средний чек", r.avg_check ? fmtMoney(r.avg_check) : "—"),
    box("Первый ответ", r.reply_median_min != null ? `${r.reply_median_min} мин` : "—", "медиана"));
}

const itemsText = (items) => (items || []).map((x) => `${x.title} ${String(x.qty).replace(".", ",")}${x.unit ? " " + x.unit : ""}`).join("; ");
const shown = (rows) => st.outcome ? rows.filter((l) => l.outcome === st.outcome) : rows;

function table(rows) {
  const t = el("table");
  t.append(el("tr", {}, ...["Первое обращение", "Клиент", "Первое сообщение", "Итог", "Что заказали", "Сумма", "На когда", "Ответили через", "Что произошло"]
    .map((h) => el("th", {}, h))));
  const list = shown(rows);
  for (const l of list) t.append(el("tr", {},
    el("td", {}, fmtDateTime(l.first_at)),
    el("td", {}, l.name || "—", el("div", { class: "dim" }, l.phone ? "+" + l.phone : "номер скрыт")),
    el("td", { style: "max-width:260px" }, l.first_text || ""),
    el("td", { class: OUT_CLASS[l.outcome] || "" }, OUTCOME[l.outcome] || l.outcome),
    el("td", { style: "max-width:280px" }, itemsText(l.items)),
    el("td", { class: "num" }, l.total != null ? fmtMoney(l.total) : "",
      l.total != null && l.total_menu != null && Math.abs(l.total - l.total_menu) >= 1
        ? el("div", { class: "dim", title: "сумма по ценам меню" }, "по меню " + fmtMoney(l.total_menu)) : null),
    el("td", {}, l.for_date ? fmtDate(l.for_date) : "", l.kind ? el("div", { class: "dim" }, KIND[l.kind]) : null),
    el("td", { class: "num" }, l.reply_min != null ? `${l.reply_min} мин` : "—"),
    el("td", { style: "max-width:320px" }, l.summary || (l.outcome === "pending" ? "ждём, пока разговор затихнет" : ""),
      l.reason ? el("div", { class: "dim" }, "почему: " + l.reason) : null)));
  if (!list.length) t.append(el("tr", {}, el("td", { colspan: 9, class: "dim" }, "Обращений за период нет")));
  return el("div", { class: "card", style: "padding:0;overflow:auto" }, t);
}

function daysTable(r) {
  if (!r.days.length) return el("span");
  const t = el("table");
  t.append(el("tr", {}, ...["День", "Обращений", "Заказов", "Конверсия", "Выручка"].map((h) => el("th", {}, h))));
  for (const d of r.days) t.append(el("tr", {}, el("td", {}, fmtDate(d.date)), el("td", { class: "num" }, String(d.leads)),
    el("td", { class: "num" }, String(d.orders)), el("td", { class: "num" }, d.leads ? Math.round(d.orders / d.leads * 100) + " %" : "—"),
    el("td", { class: "num" }, fmtMoney(d.revenue))));
  return el("div", {}, el("h3", {}, "По дням"), el("div", { class: "card", style: "padding:0;overflow:auto" }, t));
}

function reasons(r) {
  if (!r.reasons.length) return el("span");
  return el("div", {}, el("h3", {}, "Почему не заказали"),
    el("div", { class: "card" }, ...r.reasons.map((x) => el("div", {}, `${x.reason} - ${x.n}`))));
}

// SheetJS - один раз и только по кнопке: библиотека тяжёлая.
let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxLoading) xlsxLoading = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "vendor/xlsx.full.min.js";
    sc.onload = () => resolve();
    sc.onerror = () => { xlsxLoading = null; reject(new Error("Не удалось загрузить обработчик Excel")); };
    document.head.append(sc);
  });
  return xlsxLoading;
}

async function exportXlsx() {
  await loadXlsx();
  const X = window.XLSX, wb = X.utils.book_new();
  const rows = shown(lastList).map((l) => ({
    "Первое обращение": new Date(l.first_at).toLocaleString("ru-RU"), "Имя": l.name || "", "Телефон": l.phone ? "+" + l.phone : "",
    "Первое сообщение": l.first_text || "", "Итог": OUTCOME[l.outcome] || l.outcome, "Что заказали": itemsText(l.items),
    "Сумма": l.total ?? "", "Сумма по меню": l.total_menu ?? "", "На когда": l.for_date || "", "Получение": KIND[l.kind] || "",
    "Ответили через, мин": l.reply_min ?? "", "Что произошло": l.summary || "", "Почему не заказали": l.reason || "",
    "Сообщений клиента": l.msgs_in, "Ответов": l.msgs_out, "Источник": l.source || "" }));
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows), "Заявки");
  if (lastReport) {
    X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lastReport.days.map((d) => ({ "День": d.date, "Обращений": d.leads, "Заказов": d.orders,
      "Конверсия, %": d.leads ? Math.round(d.orders / d.leads * 100) : 0, "Выручка": Number(d.revenue) }))), "По дням");
  }
  X.writeFile(wb, `zayavki_whatsapp_${st.from}_${st.to}.xlsx`);
}

// Facebook принимает номера зашифрованными: цифры с кодом страны, SHA-256. Так номер не уходит открытым,
// а Meta всё равно находит людей. Только заказавшие - лучшая основа для похожей аудитории; value - сумма заказа.
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function exportFacebook() {
  const buyers = lastList.filter((l) => l.outcome === "order" && l.phone);
  const seen = new Set(), lines = ["phone,value"];
  for (const l of buyers) {
    const h = await sha256hex(l.phone.replace(/\D/g, ""));
    if (seen.has(h)) continue;
    seen.add(h);
    lines.push(`${h},${l.total != null ? Math.round(l.total) : ""}`);
  }
  const a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" })),
    download: `facebook_zakazavshie_${st.from}_${st.to}.csv` });
  document.body.append(a); a.click(); a.remove();
}
