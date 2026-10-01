// Заявка точки на кухню на завтра (миграция 0038). Точка выбирает позиции только из своего меню,
// до отсечки (по умолчанию 20:00 по времени Казахстана) заявку можно править; после — кухня печёт
// по сводному плану, а заявка этого дня только читается.
import { el, fmt, toast, debounce } from "../office/ui.js?v=19";

const API = window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const $ = (id) => document.getElementById(id);
const S = { point: null, pin: "", who: "", items: [], byCode: new Map(), day: null, data: null, lines: [], q: "", dirty: false };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим — без запоминания */ } },
};
async function call(action, payload) {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload: { pin: S.pin, point_id: S.point ? S.point.id : null, ...payload } }) });
  return r.json();
}
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
const whole = (u) => /^(шт|порц)$/i.test(u || "");
const dayName = (iso) => { const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + ", " + d.toLocaleDateString("ru-RU", { weekday: "long" }); };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function initLogin() {
  $("shell").hidden = true; $("login").hidden = false;
  const saved = store.get("tandem_login", null);
  $("lwho").value = store.get("tandem_order_who", "") || "";
  const sel = $("lpoint"); sel.innerHTML = "";
  try {
    const pts = await (await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "points", payload: {} }) })).json();
    sel.append(el("option", { value: "" }, "— выберите точку —"));
    for (const p of pts) sel.append(el("option", { value: p.id }, p.name));
    if (saved && pts.some((p) => p.id === saved.point_id)) { sel.value = saved.point_id; $("lpin").value = saved.pin || ""; }
  } catch { sel.append(el("option", { value: "" }, "Нет связи")); $("lerr").textContent = "Нет связи с сервером. Проверьте интернет и обновите страницу."; }
}
async function doLogin() {
  const pid = $("lpoint").value, pin = $("lpin").value.trim(), who = $("lwho").value.trim(), err = $("lerr");
  err.textContent = "";
  if (!pid) { err.textContent = "Выберите точку"; return; }
  if (!pin) { err.textContent = "Введите код точки"; return; }
  if (!who) { err.textContent = "Напишите, кто подаёт заявку"; return; }
  $("lbtn").disabled = true;
  S.pin = pin; S.point = { id: pid };
  try {
    const r = await call("login", {});
    if (!r.ok || r.role !== "point") { err.textContent = r.code === "throttled" ? r.error : "Код не подошёл. Проверьте точку и код."; S.point = null; return; }
    S.point = r.point; S.who = who;
    store.set("tandem_login", { point_id: pid, pin }); store.set("tandem_order_who", who);
    $("login").hidden = true; $("shell").hidden = false;
    $("pname").textContent = "Заявка · " + S.point.name; $("pwho").textContent = who;
    const it = await call("items", {});
    S.items = (it.items || []).map((i) => ({ ...i, _n: norm(i.name) + " " + norm(i.artikul) }));
    S.byCode = new Map(S.items.map((i) => [i.code, i]));
    await openDay(null);
  } catch { err.textContent = "Нет связи с сервером"; S.point = null; }
  finally { $("lbtn").disabled = false; }
}

async function openDay(day) {
  const r = await call("order_get", day ? { for_date: day } : {});
  if (!r.ok) { toast(r.error || "Заявка не загрузилась", "bad"); return; }
  // Завтра уже закрыто — сразу предлагаем послезавтра, а завтрашнюю показываем по кнопке.
  if (!day && !r.open) { const n = await call("order_get", { for_date: addDays(r.for_date, 1) }); if (n.ok) { S.closedTomorrow = r; return show(n); } }
  show(r);
}
function show(r) {
  S.data = r; S.day = r.for_date; S.dirty = false;
  S.lines = r.order ? r.order.lines.map((l) => ({ code: l.item_code, name: l.name, unit: l.unit, qty: Number(l.qty) })) : [];
  draw();
}
function draw() {
  const m = $("main"); m.innerHTML = "";
  const r = S.data, t = r.tomorrow;
  m.append(el("div", { class: "day" },
    el("button", { class: S.day === t ? "" : "ghost", onclick: () => switchDay(t) }, "Завтра"),
    el("button", { class: S.day === addDays(t, 1) ? "" : "ghost", onclick: () => switchDay(addDays(t, 1)) }, "Послезавтра")));
  m.append(el("h1", { style: "margin:8px 0 0;text-transform:none" }, "На " + dayName(S.day)));
  m.append(el("div", { class: "status " + (r.open ? "open" : "closed") }, r.open
    ? (r.order ? "Заявка принята. Её можно поправить до " + r.cutoff + " накануне." : "Приём заявок открыт до " + r.cutoff + " накануне.")
    : (r.order ? "Приём закрыт — кухня работает по этой заявке. Изменить её можно только звонком на кухню." : "Приём заявок на этот день закрыт.")));
  if (r.open) {
    const res = el("div", { class: "sres" });
    const search = el("input", { placeholder: "Найти позицию: название или артикул", value: S.q, autocomplete: "off",
      oninput: debounce((e) => { S.q = e.target.value; fill(); }, 150) });
    const fill = () => {
      res.innerHTML = "";
      const words = norm(S.q).split(" ").filter(Boolean); if (!words.length) return;
      for (const i of S.items.filter((x) => words.every((w) => x._n.includes(w))).slice(0, 30))
        res.append(el("button", { class: "sitem", onclick: () => { add(i); S.q = ""; search.value = ""; res.innerHTML = ""; } }, i.name, el("i", {}, i.unit || "")));
      if (!res.childNodes.length) res.append(el("div", { class: "dim", style: "padding:10px" }, "В меню точки такой позиции нет"));
    };
    m.append(el("label", {}, "Добавить в заявку"), search, res);
    fill();
  }
  const box = el("div", { class: "card", style: "margin-top:12px" });
  if (!S.lines.length) box.append(el("div", { class: "dim" }, r.open ? "Позиций пока нет. Найдите позицию поиском выше." : "Заявки на этот день нет."));
  S.lines.forEach((l, k) => {
    const st = whole(l.unit) ? 1 : 0.5;
    const inp = el("input", { inputmode: "decimal", value: String(l.qty).replace(".", ","), disabled: !r.open, "aria-label": "Количество: " + l.name,
      onchange: (e) => { const v = parseFloat(String(e.target.value).replace(",", ".")); if (v > 0) { l.qty = whole(l.unit) ? Math.round(v) : v; S.dirty = true; } draw(); } });
    box.append(el("div", { class: "ol" }, el("div", { class: "n" }, l.name, el("i", {}, l.unit || "")),
      r.open ? el("button", { "aria-label": "Меньше", onclick: () => { l.qty = Math.max(st, Math.round((l.qty - st) * 100) / 100); S.dirty = true; draw(); } }, "−") : el("span"),
      inp,
      r.open ? el("button", { "aria-label": "Больше", onclick: () => { l.qty = Math.round((l.qty + st) * 100) / 100; S.dirty = true; draw(); } }, "+") : el("span"),
      r.open ? el("button", { class: "x", "aria-label": "Убрать " + l.name, onclick: () => { S.lines.splice(k, 1); S.dirty = true; draw(); } }, "×") : el("span")));
  });
  m.append(box);
  if (r.open) {
    const send = el("button", { class: "big", disabled: !S.lines.length && !r.order }, r.order ? "Сохранить изменения" : "Отправить заявку");
    send.onclick = async () => {
      if (!S.lines.length && !window.confirm("Отозвать заявку на этот день?")) return;
      send.disabled = true;
      const res = await call("order_save", { for_date: S.day, sent_by: S.who, lines: S.lines.map((l) => ({ item_code: l.code, qty: l.qty })) });
      send.disabled = false;
      if (!res.ok) { toast(res.error || "Заявка не отправилась", "bad"); return; }
      toast(S.lines.length ? "Заявка принята" : "Заявка отозвана"); show(res);
    };
    m.append(send);
    if (S.dirty) m.append(el("div", { class: "warnbox" }, "Есть неотправленные изменения — нажмите «" + send.textContent + "»."));
  }
}
async function switchDay(day) {
  if (S.dirty && !window.confirm("Изменения в заявке не отправлены. Перейти без них?")) return;
  await openDay(day);
}
function add(i) {
  const l = S.lines.find((x) => x.code === i.code);
  if (l) l.qty += whole(i.unit) ? 1 : 0.5; else S.lines.push({ code: i.code, name: i.name, unit: i.unit, qty: whole(i.unit) ? 1 : 0.5 });
  S.dirty = true; draw();
}

$("lbtn").onclick = doLogin;
$("lwho").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
$("logout").onclick = () => { if (S.dirty && !window.confirm("Изменения не отправлены. Выйти?")) return; S.point = null; S.pin = ""; initLogin(); };
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
initLogin();
