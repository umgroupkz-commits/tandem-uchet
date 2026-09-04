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
// Оверлей с карточкой; возвращает {root, close}
export function modal(title) {
  const card = el("div", { class: "card" }, el("h1", {}, title));
  const ov = el("div", { class: "overlay" }, card);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  function close() { ov.remove(); }
  document.body.append(ov);
  return { root: card, close };
}
