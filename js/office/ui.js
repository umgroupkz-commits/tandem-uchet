// Мелкие помощники для экранов бэк-офиса.
export function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
// Дата по часам пользователя, а не по Гринвичу: toISOString() до пяти утра по Казахстану
// отдавал вчерашний день, и ночной документ получал вчерашнюю дату.
export function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export const today = () => isoDate(new Date());
export function fmt(n) {
  if (n === null || n === undefined || n === "") return "";
  return (Math.round(Number(n) * 100) / 100).toLocaleString("ru-RU");
}
let toastTimer = null;
export function toast(text, kind = "ok") {
  const t = document.getElementById("toast");
  t.textContent = text; t.className = "toast " + (kind === "bad" ? "bad" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
export function debounce(fn, ms) {
  let h = null;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}
export function confirmDlg(text) { return window.confirm(text); }
// Текст отказа сервера: у ошибок ввода он в message, у сбоя базы — только в error.
export const errText = (r) => (r && (r.message || r.error)) || "Не получилось — повторите";
// Отказ при сохранении записи из окна. У НОВОЙ записи (позиция, группа, контрагент, склад) обрыв
// связи — особый случай: сервер мог успеть её создать, а повторное «Сохранить» ушло бы без кода
// и завело вторую такую же (уникальности по имени нет). Поэтому кнопка остаётся выключенной,
// а человек сначала проверяет список. Возвращает true, если это был такой обрыв.
export const NET_NEW = "Нет связи — запись могла сохраниться. Закройте окно и проверьте список, прежде чем заводить снова";
export function saveFailed(r, isNew, btn, errEl) {
  if (isNew && r && r.error === "network") { btn.disabled = true; errEl.textContent = NET_NEW; return true; }
  btn.disabled = false; errEl.textContent = errText(r); return false;
}
// Ключ повтора для сервера. crypto.randomUUID есть только на https и localhost, а свой сервер
// может открываться по http — там собираем тот же вид UUID из getRandomValues.
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Оверлей с карточкой; возвращает {root, close, cancel, dirty}.
// По фону окно закрывается, только если и нажатие, и отпускание мыши пришлись на сам фон:
// раньше выделение текста в поле, отпущенное за краем карточки, давало click по фону и
// закрывало форму со всем введённым. Окна с вводом (keep) по фону не закрываются вовсе.
// dirty ставится при любом вводе в карточке (кроме полей с data-nodirty — поиск и выбор
// версии); cancel() при изменениях спрашивает, точно ли бросить введённое.
export function modal(title, opts = {}) {
  const card = el("div", { class: "card" }, el("h1", {}, title));
  const ov = el("div", { class: "overlay" }, card);
  let downOv = false, upOv = false;
  ov.addEventListener("mousedown", (e) => { downOv = e.target === ov; });
  ov.addEventListener("mouseup", (e) => { upOv = e.target === ov; });
  ov.addEventListener("click", (e) => {
    if (e.target === ov && downOv && upOv && !opts.keep) close();
    downOv = upOv = false;
  });
  const m = { root: card, close, cancel, dirty: false };
  const touch = (e) => { if (!(e.target.closest && e.target.closest("[data-nodirty]"))) m.dirty = true; };
  card.addEventListener("input", touch);
  card.addEventListener("change", touch);
  function close() { ov.remove(); }
  function cancel() {
    if (m.dirty && !confirmDlg("Закрыть без сохранения? Введённое пропадёт.")) return;
    close();
  }
  document.body.append(ov);
  return m;
}
