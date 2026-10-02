// Заявка точки на кухню на завтра (миграция 0038). Точка выбирает позиции только из своего меню,
// до отсечки (по умолчанию 20:00 по времени Казахстана) заявку можно править; после — кухня печёт
// по сводному плану, а заявка этого дня только читается.
import { el, fmt, toast, debounce } from "../office/ui.js?v=20";

const API = window.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const $ = (id) => document.getElementById(id);
// menu — меню точки загружено; note — сообщение над заявкой ({kind: ok|warn|bad, text});
// lost — неотправленный черновик дня, на который приём уже закрыт; sending — идёт отправка.
const S = { point: null, pin: "", who: "", items: [], byCode: new Map(), menu: false, day: null, data: null, lines: [], q: "", dirty: false,
  note: null, lost: null, sending: false };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим — без запоминания */ } },
};
// Вызов сервера не бросает: обрыв связи, таймаут (20 с) и ответ не в JSON (502/504 шлюза)
// приходят как {ok:false, offline:true, error} — дошёл ли запрос до базы, тогда неизвестно.
async function post(body) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
    return await r.json().catch(() => ({ ok: false, offline: true,
      error: ac.signal.aborted ? "Нет связи с сервером" : "Сервер не ответил как положено (код " + r.status + ")" }));
  } catch { return { ok: false, offline: true, error: "Нет связи с сервером" }; }
  finally { clearTimeout(t); }
}
function call(action, payload) {
  return post({ action, payload: { pin: S.pin, point_id: S.point ? S.point.id : null, ...payload } });
}
// Черновик заявки живёт в телефоне по точке и дню до успешной отправки: обрыв связи,
// перезагрузка и смена дня его не теряют.
const DRAFT = "tandem_order_draft:";
const draftKey = (day) => DRAFT + (S.point ? S.point.id : "") + ":" + day;
const keepDraft = () => store.set(draftKey(S.day), { at: Date.now(), lines: S.lines.map(({ code, name, unit, qty }) => ({ code, name, unit, qty })) });
const dropDraft = (day) => { try { localStorage.removeItem(draftKey(day)); } catch { /* приватный режим */ } };
const touch = () => { S.dirty = true; keepDraft(); };
// Черновики на сегодня и раньше не нужны: заявки на эти дни уже не принимаются.
function dropOldDrafts(tomorrow) {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT) && k.slice(-10) < tomorrow) localStorage.removeItem(k); } catch { /* приватный режим */ }
}
// Одинаковы ли заявки: позиция → количество (повторы позиции складываются, как на сервере).
function sameLines(a, b) {
  const sum = (ls) => { const m = new Map(); for (const l of ls) { const c = l.code || l.item_code; m.set(c, (m.get(c) || 0) + Number(l.qty)); } return m; };
  const x = sum(a), y = sum(b);
  return x.size === y.size && [...x].every(([c, q]) => y.has(c) && Math.abs(y.get(c) - q) < 1e-6);
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
    const pts = await post({ action: "points", payload: {} });
    if (!Array.isArray(pts)) throw new Error(pts.error);
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
    if (r.offline) { err.textContent = r.error + ". Проверьте интернет и нажмите «Войти» ещё раз."; S.point = null; return; }
    if (!r.ok || r.role !== "point") { err.textContent = r.code === "throttled" ? r.error : "Код не подошёл. Проверьте точку и код."; S.point = null; return; }
    S.point = r.point; S.who = who;
    store.set("tandem_login", { point_id: pid, pin }); store.set("tandem_order_who", who);
    $("login").hidden = true; $("shell").hidden = false;
    $("pname").textContent = "Заявка · " + S.point.name; $("pwho").textContent = who;
    S.menu = false; S.data = null; $("main").innerHTML = "";
    await openDay(null);
  } catch { err.textContent = "Нет связи с сервером"; S.point = null; }
  finally { $("lbtn").disabled = false; }
}

// Сбой связи не роняет экран: открытый день остаётся на месте, а если показывать ещё
// нечего (сразу после входа) — карточка с «Повторить».
async function openDay(day) {
  if (!S.menu) {
    const it = await call("items", {});
    if (!it.ok) return failed(it.error || "Меню точки не загрузилось", () => openDay(day));
    S.items = (it.items || []).map((i) => ({ ...i, _n: norm(i.name) + " " + norm(i.artikul) }));
    S.byCode = new Map(S.items.map((i) => [i.code, i])); S.menu = true;
  }
  const r = await call("order_get", day ? { for_date: day } : {});
  if (!r.ok) return failed(r.error || "Заявка не загрузилась", () => openDay(day));
  dropOldDrafts(r.tomorrow);
  // Завтра уже закрыто — сразу предлагаем послезавтра, а завтрашнюю показываем по кнопке.
  if (!day && !r.open) { const n = await call("order_get", { for_date: addDays(r.for_date, 1) }); if (n.ok) { S.closedTomorrow = r; return show(n); } }
  show(r);
}
function failed(text, retry) {
  if (S.data) { toast(text, "bad"); return; }
  const m = $("main"); m.innerHTML = ""; m.classList.remove("busy");
  m.append(el("div", { class: "note bad" }, text + ". Проверьте интернет и попробуйте ещё раз."),
    el("button", { class: "big", onclick: (e) => { e.currentTarget.disabled = true; retry(); } }, "Повторить"));
}
function show(r, note) {
  S.data = r; S.day = r.for_date; S.dirty = false; S.note = note || null; S.lost = null;
  S.lines = r.order ? r.order.lines.map((l) => ({ code: l.item_code, name: l.name, unit: l.unit, qty: Number(l.qty) })) : [];
  // Неотправленный черновик этого телефона: совпал с заявкой на сервере — больше не нужен;
  // приём открыт — возвращается в работу; закрыт — видно, что до кухни он не дошёл.
  const dr = store.get(draftKey(S.day), null);
  if (dr && Array.isArray(dr.lines)) {
    if (sameLines(dr.lines, S.lines)) dropDraft(S.day);
    else if (r.open) {
      S.lines = dr.lines.map((l) => ({ ...l, qty: Number(l.qty) })); S.dirty = true;
      S.note = S.note || { kind: "warn", text: "Восстановлен неотправленный черновик с этого телефона"
        + (dr.at ? " (" + new Date(dr.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) + ")" : "") + " — проверьте и отправьте." };
    } else S.lost = dr.lines;
  }
  draw();
}
function draw() {
  const m = $("main"); m.innerHTML = "";
  m.classList.toggle("busy", S.sending);
  const r = S.data, t = r.tomorrow;
  m.append(el("div", { class: "day" },
    el("button", { class: S.day === t ? "" : "ghost", onclick: () => switchDay(t) }, "Завтра"),
    el("button", { class: S.day === addDays(t, 1) ? "" : "ghost", onclick: () => switchDay(addDays(t, 1)) }, "Послезавтра")));
  m.append(el("h1", { style: "margin:8px 0 0;text-transform:none" }, "На " + dayName(S.day)));
  m.append(el("div", { class: "status " + (r.open ? "open" : "closed") }, r.open
    ? (r.order ? "Заявка принята. Её можно поправить до " + r.cutoff + " накануне." : "Приём заявок открыт до " + r.cutoff + " накануне.")
    : (r.order ? "Приём закрыт — кухня работает по этой заявке. Изменить её можно только звонком на кухню." : "Приём заявок на этот день закрыт.")));
  if (S.note) m.append(el("div", { class: "note " + S.note.kind, role: "status" }, S.note.text));
  if (S.lost) m.append(el("div", { class: "note warn" },
    "На этом телефоне остался неотправленный черновик — до кухни он не дошёл, а приём уже закрыт. Позвоните на кухню: "
      + (S.lost.map((l) => l.name + " — " + fmt(l.qty)).join(", ") || "заявку отзывали") + ".",
    el("button", { class: "ghost", style: "margin-top:8px", onclick: () => { dropDraft(S.day); S.lost = null; draw(); } }, "Убрать черновик")));
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
      onchange: (e) => { const v = parseFloat(String(e.target.value).replace(",", ".")); if (v > 0) { l.qty = whole(l.unit) ? Math.round(v) : v; touch(); } draw(); } });
    box.append(el("div", { class: "ol" }, el("div", { class: "n" }, l.name, el("i", {}, l.unit || "")),
      r.open ? el("button", { "aria-label": "Меньше", onclick: () => { l.qty = Math.max(st, Math.round((l.qty - st) * 100) / 100); touch(); draw(); } }, "−") : el("span"),
      inp,
      r.open ? el("button", { "aria-label": "Больше", onclick: () => { l.qty = Math.round((l.qty + st) * 100) / 100; touch(); draw(); } }, "+") : el("span"),
      r.open ? el("button", { class: "x", "aria-label": "Убрать " + l.name, onclick: () => { S.lines.splice(k, 1); touch(); draw(); } }, "×") : el("span")));
  });
  m.append(box);
  if (r.open) {
    const label = r.order ? "Сохранить изменения" : "Отправить заявку";
    const send = el("button", { class: "big", disabled: S.sending || (!S.lines.length && !r.order) }, S.sending ? "Отправляю…" : label);
    send.onclick = sendOrder;
    m.append(send);
    if (S.dirty) m.append(el("div", { class: "warnbox" }, "Есть неотправленные изменения — нажмите «" + label + "»."));
  }
}
// Отправка. Пока ждём ответа, экран заявки не трогается (busy), кнопка возвращается при любом
// исходе. При обрыве запрос мог дойти до базы, а ответ потеряться — перечитываем заявку дня:
// совпала с отправленной — дошла; нет — черновик остаётся в телефоне до повтора.
async function sendOrder() {
  if (S.sending) return;
  if (!S.lines.length && !window.confirm("Отозвать заявку на этот день?")) return;
  const pt = S.point, day = S.day, lines = S.lines.map((l) => ({ item_code: l.code, qty: l.qty }));
  keepDraft();
  S.sending = true; S.note = null; draw();
  let res, chk = null;
  try {
    res = await call("order_save", { for_date: day, sent_by: S.who, lines });
    if (res.offline) {
      chk = await call("order_get", { for_date: day });
      if (chk.ok && sameLines(lines, chk.order ? chk.order.lines : [])) res = { ...chk, arrived: true };
    }
  } finally { S.sending = false; }
  if (S.point !== pt) return;   // пока ждали ответа, из точки вышли
  if (res.ok) {
    dropDraft(day);
    toast(lines.length ? "Заявка принята" : "Заявка отозвана");
    return show(res, res.arrived ? { kind: "ok", text: "Связь прерывалась, но заявка дошла — кухня её видит." } : null);
  }
  if (!res.offline) { S.note = { kind: "bad", text: res.error || "Заявка не отправилась" }; return draw(); }
  // Не дошла. Свежий ответ order_get показывается с черновиком поверх (show его восстановит),
  // и по нему же видно, не закрылся ли приём, пока шла отправка.
  if (chk.ok) return show(chk, { kind: "bad", text: chk.open
    ? "Нет связи — заявка НЕ отправлена. Черновик сохранён на телефоне — отправьте ещё раз."
    : "Заявка НЕ отправлена, а приём уже закрыт — позвоните на кухню." });
  S.note = { kind: "bad", text: "Нет связи с сервером — неизвестно, дошла ли заявка. Черновик сохранён на телефоне: когда связь появится, отправьте ещё раз." };
  draw();
}
async function switchDay(day) {
  if (S.sending) return;
  if (S.dirty && !window.confirm("Изменения на этот день не отправлены — черновик останется на телефоне до отправки. Перейти?")) return;
  await openDay(day);
}
function add(i) {
  const l = S.lines.find((x) => x.code === i.code);
  if (l) l.qty += whole(i.unit) ? 1 : 0.5; else S.lines.push({ code: i.code, name: i.name, unit: i.unit, qty: whole(i.unit) ? 1 : 0.5 });
  touch(); draw();
}

$("lbtn").onclick = doLogin;
$("lwho").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
$("logout").onclick = () => {
  if (S.dirty && !window.confirm("Изменения не отправлены — черновик останется на этом телефоне. Выйти?")) return;
  S.point = null; S.pin = ""; S.dirty = false; S.data = null; initLogin();
};
window.addEventListener("beforeunload", (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
initLogin();
