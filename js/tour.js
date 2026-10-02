// Интерактивная обучалка (сборка 22). Человек выбирает роль на странице обучения (test.html), и программа
// ведёт его по урокам прямо в рабочих экранах: подсвечивает кнопку или поле, объясняет, просит нажать или
// ввести — и сама переходит к следующему шагу, когда действие сделано. Урок может идти через несколько
// страниц (бэк-офис → склад с телефона): состояние урока живёт в localStorage и подхватывается на
// следующей странице.
// Обычный скрипт (не модуль): его подключают и модульные страницы, и index.html с классическим app.js.
// Уроки описываются в js/tours/<роль>.js вызовами TandemTour.register({...}) — формат в docs/tour-format.md.
// Автопрогон (для проверки уроков и показа «как это делается»): TandemTour.start(id, {autoplay: true}) —
// движок сам нажимает и вводит; в консоль пишет «[tour] ok N» / «[tour] FAIL N: …» / «[tour] done id».
(function () {
  if (window.TandemTour) return;
  const KEY = "tandem_tour", DONE = "tandem_tour_done", CREDS = "tandem_training";
  const lessons = {}; const order = [];
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватное окно */ } },
  };
  const pageName = () => decodeURIComponent(location.pathname.split("/").pop() || "index.html");
  const scriptBase = () => {
    const s = [...document.scripts].map((x) => x.src).find((x) => /\/js\/tour\.js/.test(x)) || "";
    const v = (s.match(/[?&]v=(\d+)/) || [])[1] || "0";
    return { root: s ? s.replace(/js\/tour\.js.*$/, "") : "", v };
  };
  const norm = (s) => String(s == null ? "" : s).replace(/[\s ]+/g, " ").trim().toLowerCase();
  const log = (m) => { try { console.info("[tour] " + m); } catch (e) { /* */ } };

  // ------------------------------------------------------------------ учётки обучения
  // Приходят со страницы обучения по коду обучения (действие training_info) и лежат в localStorage этого
  // браузера: {creds: {sklad: {login, pin, name}, buh, tech, owner, kassa: {point, point_name, pin},
  // point: {…}, owner_code}, at}. В шагах на них ссылаются шаблоны {{sklad.login}}, {{kassa.pin}}.
  function creds() { const c = ls.get(CREDS); return (c && c.creds) || {}; }
  function tpl(v) {
    if (typeof v === "function") { try { v = v(); } catch (e) { v = ""; } }
    if (typeof v !== "string") return v;
    return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path) => {
      let o = creds(); for (const k of path.split(".")) o = o == null ? undefined : o[k];
      return o == null ? "" : String(o);
    });
  }

  // ------------------------------------------------------------------ поиск элемента по описанию
  // Описание цели: строка (CSS) или {css|sel, text, exact, placeholder, near, within, nth}.
  //   text — видимый текст элемента (без учёта регистра, вхождение; exact — целиком); берётся самый
  //          «внутренний» подходящий элемент; sel ограничивает теги (по умолчанию кнопки, ссылки, вкладки…);
  //   placeholder — поле с такой подсказкой; near — поле ввода у подписи с этим текстом;
  //   within — где искать: "modal" (верхнее открытое окно) или такое же описание; nth — какой по счёту.
  function visible(n) {
    if (!n || !n.isConnected) return false;
    const r = n.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(n); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  }
  function topModal() {
    const all = [...document.querySelectorAll(".overlay > .card, .overlay .card, [role=dialog], .modal, .sheet, .dlg, #tfb-ov > div")]
      .filter((n) => visible(n) && !n.closest(".tt-ui"));
    return all.length ? all[all.length - 1] : null;
  }
  function scope(spec) {
    if (!spec.within) return document;
    if (spec.within === "modal") return topModal();
    return find(spec.within);
  }
  const CONTROLS = "input, select, textarea";
  function find(spec) {
    if (!spec) return null;
    // Массив — запасные цели по порядку: первая, что есть на экране (колонка бывает не всегда).
    if (Array.isArray(spec)) { for (const x of spec) { const n = find(x); if (n) return n; } return null; }
    if (typeof spec === "string") spec = { css: spec };
    const root = scope(spec); if (!root) return null;
    if (spec.near) {
      const want = norm(spec.near);
      const own = (n) => norm([...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" "));
      const word = (n) => { const x = own(n), k = x.indexOf(want); return k === 0 || (k > 0 && !/[\p{L}\d]/u.test(x[k - 1])); };
      const labs = [...root.querySelectorAll("label, legend, .lbl, h3, th, b, span, div")].filter((n) => visible(n) && !n.closest(".tt-ui")
        && own(n).includes(want)).sort((a, b) => word(b) - word(a));
      for (const l of labs) {
        if (l.htmlFor) { const c = document.getElementById(l.htmlFor); if (visible(c)) return c; }
        let c = l.querySelector(CONTROLS); if (visible(c)) return c;
        for (let n = l.nextElementSibling, i = 0; n && i < 5; n = n.nextElementSibling, i++) {
          if (n.matches(CONTROLS) && visible(n)) return n;
          c = n.querySelector && [...n.querySelectorAll(CONTROLS)].find(visible); if (c) return c;
        }
        c = l.parentElement && [...l.parentElement.querySelectorAll(CONTROLS)].find(visible); if (c) return c;
      }
      return null;
    }
    const sel = spec.css || spec.sel || (spec.placeholder ? "input, textarea"
      : "button, a, [role=button], [role=tab], summary, label, td, th, li, .tile, .sitem, .row, option, h1, h2, h3, input[type=checkbox], input[type=radio]");
    let c = [...root.querySelectorAll(sel)].filter((n) => visible(n) && !n.closest(".tt-ui"));
    if (spec.placeholder) c = c.filter((n) => norm(n.placeholder).includes(norm(spec.placeholder)));
    if (spec.text != null) {
      const t = norm(spec.text);
      c = c.filter((n) => { const x = norm(n.innerText || n.value || n.textContent); return spec.exact ? x === t : x.includes(t); });
      c = c.filter((n) => !c.some((m) => m !== n && n.contains(m)));
    }
    return c[spec.nth || 0] || null;
  }
  // Условие шага (until / wait): описание цели — «появилось на экране»; {gone: цель} — «исчезло»;
  // {textOnPage: "…"} — такой текст есть где-то на экране (например, «Проведено» во всплывающем сообщении).
  function cond(spec) {
    if (!spec) return true;
    if (spec.gone) return !find(spec.gone);
    if (spec.textOnPage) return norm(document.body.innerText).includes(norm(tpl(spec.textOnPage)));
    if (spec.any) return spec.any.some(cond);
    return !!find(spec);
  }

  // ------------------------------------------------------------------ ввод от имени человека
  function setValue(el, v) {
    if (!el) return;
    v = tpl(v);
    el.focus();
    if (el.tagName === "SELECT") {
      const o = [...el.options].find((x) => x.value === v) || [...el.options].find((x) => norm(x.text).includes(norm(v)));
      if (o) el.value = o.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      el.checked = v === true || v === "true" || v === "1";
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set; setter.call(el, v);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function matches(el, v) {
    if (!el) return false;
    v = tpl(v);
    if (el.tagName === "SELECT") { const o = el.options[el.selectedIndex]; return !!o && (o.value === v || norm(o.text).includes(norm(v))); }
    if (el.type === "checkbox" || el.type === "radio") return el.checked === (v === true || v === "true" || v === "1");
    const a = norm(el.value), b = norm(v);
    return b === "" ? a !== "" : a === b || a.replace(",", ".") === b.replace(",", ".") || (b.length >= 3 && a.includes(b));
  }

  // ------------------------------------------------------------------ интерфейс: затемнение, рамка, карточка
  let ui = null;
  function css() {
    if (document.getElementById("tt-style")) return;
    const s = document.createElement("style"); s.id = "tt-style";
    s.textContent = `
.tt-ui{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111827}
.tt-dim{position:fixed;background:rgba(15,23,42,.42);z-index:2147483000;pointer-events:none;transition:all .15s}
.tt-ring{position:fixed;z-index:2147483001;pointer-events:none;border:3px solid #f59e0b;border-radius:9px;box-shadow:0 0 0 4px rgba(245,158,11,.35);animation:tt-pulse 1.4s ease-in-out infinite;transition:all .15s}
@keyframes tt-pulse{50%{box-shadow:0 0 0 10px rgba(245,158,11,.12)}}
@media (prefers-reduced-motion:reduce){.tt-ring{animation:none}}
.tt-card{position:fixed;z-index:2147483002;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:14px 16px;width:min(380px,calc(100vw - 24px));max-height:60vh;overflow:auto}
.tt-card .tt-top{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#6b7280;margin-bottom:4px}
.tt-card h4{margin:0 0 6px;font-size:17px;line-height:1.3;color:#1f3864}
.tt-card p{margin:0 0 8px}
.tt-card .tt-do{background:#fff7e6;border-left:4px solid #f59e0b;border-radius:6px;padding:7px 10px;font-size:14px;margin:6px 0 10px}
.tt-card .tt-warn{background:#fdecea;border-left:4px solid #b4453c;border-radius:6px;padding:7px 10px;font-size:14px;margin:6px 0 10px}
.tt-card .tt-btns{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.tt-card button{width:auto;min-height:0;margin:0;padding:8px 12px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#1f2937;font:inherit;font-size:14px;cursor:pointer}
.tt-card button.tt-main{background:#1f3864;border-color:#1f3864;color:#fff;font-weight:600}
.tt-card button.tt-quiet{border-color:transparent;color:#6b7280}
.tt-card code{background:#eef2f8;padding:1px 5px;border-radius:4px}
.tt-bar{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483002;background:#1f3864;color:#fff;border-radius:999px;padding:6px 8px 6px 14px;display:flex;gap:8px;align-items:center;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.tt-bar button{width:auto;min-height:0;margin:0;background:#fff;color:#1f3864;border:none;border-radius:999px;padding:5px 10px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
@media print{.tt-ui{display:none!important}}`;
    document.head.append(s);
  }
  function mk(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function buildUi() {
    css();
    const dims = ["t", "l", "r", "b"].map(() => mk("div", "tt-ui tt-dim"));
    const ring = mk("div", "tt-ui tt-ring");
    const card = mk("div", "tt-ui tt-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
    document.body.append(...dims, ring, card);
    ui = { dims, ring, card };
  }
  function dropUi() { if (!ui) return; [...ui.dims, ui.ring, ui.card].forEach((n) => n.remove()); ui = null; }
  // Затемнение вокруг цели четырьмя полосами; клики сквозь них проходят (pointer-events: none) — обучалка
  // подсказывает, но не запирает экран: если что-то пошло не так, человек всегда может нажать сам.
  function place(target) {
    const W = window.innerWidth, H = window.innerHeight, [t, l, r, b] = ui.dims;
    if (!target) {
      ui.ring.style.display = "none";
      Object.assign(t.style, { left: 0, top: 0, width: W + "px", height: H + "px", display: "block" });
      [l, r, b].forEach((d) => { d.style.display = "none"; });
      return null;
    }
    const q = target.getBoundingClientRect(), p = 6;
    const x1 = Math.max(0, q.left - p), y1 = Math.max(0, q.top - p), x2 = Math.min(W, q.right + p), y2 = Math.min(H, q.bottom + p);
    [t, l, r, b].forEach((d) => { d.style.display = "block"; });
    Object.assign(t.style, { left: 0, top: 0, width: W + "px", height: y1 + "px" });
    Object.assign(b.style, { left: 0, top: y2 + "px", width: W + "px", height: Math.max(0, H - y2) + "px" });
    Object.assign(l.style, { left: 0, top: y1 + "px", width: x1 + "px", height: Math.max(0, y2 - y1) + "px" });
    Object.assign(r.style, { left: x2 + "px", top: y1 + "px", width: Math.max(0, W - x2) + "px", height: Math.max(0, y2 - y1) + "px" });
    Object.assign(ui.ring.style, { display: "block", left: x1 + "px", top: y1 + "px", width: (x2 - x1) + "px", height: (y2 - y1) + "px" });
    return { x1, y1, x2, y2 };
  }
  function placeCard(box, inTable) {
    const c = ui.card, W = window.innerWidth, H = window.innerHeight;
    const cw = c.offsetWidth, ch = c.offsetHeight, m = 12;
    if (box && inTable && W >= 640) {
      let top = box.y2 + m; if (top + ch > H - m) top = box.y1 - ch - m;
      Object.assign(c.style, { left: Math.min(Math.max(m, box.x1), W - cw - m) + "px", top: Math.min(Math.max(m, top), H - ch - m) + "px" });
      return;
    }
    if (W < 640 || !box) {   // телефон или шаг без цели: карточка внизу (или по центру), не закрывает цель
      const top = box && box.y2 > H - ch - 24 ? Math.max(m, box.y1 - ch - m) : H - ch - m;
      Object.assign(c.style, { left: Math.max(m, (W - cw) / 2) + "px", top: (box ? top : Math.max(m, (H - ch) / 2)) + "px" });
      return;
    }
    let left = box.x2 + m, top = box.y1;   // справа от цели, иначе слева, снизу, сверху
    if (left + cw > W - m) left = box.x1 - cw - m;
    if (left < m) { left = Math.min(Math.max(m, box.x1), W - cw - m); top = box.y2 + m; if (top + ch > H - m) top = box.y1 - ch - m; }
    top = Math.min(Math.max(m, top), H - ch - m);
    Object.assign(c.style, { left: left + "px", top: top + "px" });
  }

  // ------------------------------------------------------------------ ход урока
  let st = null;            // {lesson, step, role, autoplay}
  let cur = null;           // текущий шаг: {i, step, target, clicked, since, missingSince, filled}
  let timer = null;
  function lesson() { return st && lessons[st.lesson]; }
  function save() { ls.set(KEY, st); }
  function steps() { const l = lesson(); return l ? l.steps : []; }
  function stepPage(s) { return (s && s.page) || (lesson() && lesson().page) || pageName(); }

  function start(id, opts) {
    const l = lessons[id]; if (!l) { log("FAIL нет урока " + id); return false; }
    // Урок начинается «с чистого листа»: выходим из учёток, под которыми были раньше (их ключи урок называет
    // сам в reset), иначе бэк-офис открылся бы под чужим логином и шаг «Войдите» не нашёл бы формы.
    const saved = ls.get("tandem_tour_saved") || {};
    for (const k of [...new Set([...(l.keep || []), ...(l.reset || [])])]) {
      try { if (!(k in saved)) saved[k] = localStorage.getItem(k); } catch (e) { /* */ }
    }
    ls.set("tandem_tour_saved", saved);
    for (const k of l.reset || []) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* */ } }
    st = { lesson: id, step: 0, role: l.role, autoplay: !!(opts && opts.autoplay) };
    save();
    const target = stepPage(l.steps[0]);
    if (target !== pageName() || (opts && opts.reload)) { location.href = target + (l.hash || ""); return true; }
    run(); return true;
  }
  function restoreSaved() {
    const saved = ls.get("tandem_tour_saved"); if (!saved) return;
    for (const [k, v] of Object.entries(saved)) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* */ } }
    ls.set("tandem_tour_saved", null);
  }
  function stop(done) {
    const l = lesson();
    if (done && l) { const d = ls.get(DONE) || {}; d[l.id] = new Date().toISOString(); ls.set(DONE, d); log("done " + l.id); }
    st = null; save(); cur = null; clearInterval(timer); timer = null; dropUi();
    // Вернуть то, что было до обучения (вход точки, сессия бэк-офиса), — только когда урок закончился или
    // прерван, а не между уроками (следующий урок сам сотрёт, что ему нужно).
    restoreSaved();
  }
  function go(i) {
    const n = steps().length;
    if (i >= n) { finish(); return; }
    st.step = Math.max(0, i); save(); cur = null; tick();
  }
  function finish() {
    const l = lesson(); const role = l.role;
    const next = order.map((id) => lessons[id]).filter((x) => x.role === role)
      .find((x, k, arr) => arr[k - 1] && arr[k - 1].id === l.id);
    const auto = st.autoplay;
    stop(true);
    if (auto) return;
    buildUi(); place(null);
    const c = ui.card; c.innerHTML = "";
    c.append(mk("div", "tt-top", "Урок пройден"), mk("h4", null, "Готово: «" + l.title + "»"));
    const p = mk("p", null, next ? "Дальше — урок «" + next.title + "»." : "Все уроки этой роли пройдены. Теперь попробуйте сами, без подсказок: список заданий — на странице обучения.");
    const btns = mk("div", "tt-btns");
    const toList = mk("button", null, "К списку уроков");
    toList.onclick = () => { dropUi(); location.href = "test.html#" + role; };
    btns.append(toList);
    if (next) { const b = mk("button", "tt-main", "Следующий урок"); b.onclick = () => { dropUi(); start(next.id, { reload: true }); }; btns.append(b); }
    else { const b = mk("button", "tt-main", "Закрыть"); b.onclick = dropUi; btns.append(b); }
    c.append(p, btns); placeCard(null);
  }

  function hintFor(s) {
    switch (s.action) {
      case "click": return "Нажмите на подсвеченное" + (s.target && s.target.text ? ": «" + s.target.text + "»" : "") + ".";
      case "type": return "Введите в подсвеченное поле: «" + tpl(s.label || s.value) + "».";
      case "select": return "Выберите в подсвеченном списке: «" + tpl(s.label || s.value) + "».";
      case "fill": return "Введите " + (s.fields || []).map((f) => (f.label ? f.label + " — " : "") + "«" + tpl(f.show || f.value) + "»").join(", ")
        + " (или нажмите «Подставить за меня»).";
      case "wait": return "Подождите — программа ответит сама.";
      default: return "";
    }
  }
  function render(i, s, target) {
    if (!ui) buildUi();
    const box = place(target);
    const key = i + "|" + !!target + "|" + (cur && cur.lost ? 1 : 0) + "|" + (cur && cur.onOtherPage ? 1 : 0) + "|" + (cur && cur.absent ? 1 : 0);
    if (ui.card.dataset.key !== key) {
      ui.card.dataset.key = key;
      const c = ui.card; c.innerHTML = "";
      const l = lesson();
      c.append(mk("div", "tt-top", l.title + " · шаг " + (i + 1) + " из " + steps().length));
      if (cur && cur.onOtherPage) {
        c.append(mk("h4", null, "Этот шаг — на другом экране"), mk("p", null, "Урок продолжается на странице «" + stepPage(s) + "»."));
        const b = mk("button", "tt-main", "Открыть"); b.onclick = () => { location.href = stepPage(s); };
        const btns = mk("div", "tt-btns"); btns.append(quit(), b); c.append(btns);
        placeCard(null); return;
      }
      if (s.title) c.append(mk("h4", null, s.title));
      if (s.text) { const p = mk("p"); p.innerHTML = tpl(s.text); c.append(p); }
      const h = hintFor(s); if (h && s.action !== "next") c.append(mk("div", "tt-do", h));
      if (cur && cur.lost) c.append(mk("div", "tt-warn", "Не вижу этого на экране. Если окно закрылось или вы ушли в другой раздел — нажмите «Назад» или вернитесь туда, где были."));
      if (cur && cur.absent) c.append(mk("div", "tt-do", s.missing || "Сейчас этого нет на экране — шаг можно пропустить."));
      const btns = mk("div", "tt-btns");
      btns.append(quit());
      if (i > 0) { const b = mk("button", null, "Назад"); b.onclick = () => go(i - 1); btns.append(b); }
      if (s.action === "type" || s.action === "select" || s.action === "fill") {
        const b = mk("button", null, s.action === "fill" ? "Подставить за меня" : s.action === "select" ? "Выбрать за меня" : "Ввести за меня");
        b.onclick = () => { act(s, find(s.target)); };
        btns.append(b);
      }
      if (s.action === "next" || s.optional || (cur && cur.lost)) {
        const b = mk("button", s.action === "next" || (cur && cur.absent) ? "tt-main" : null, s.action === "next" ? (s.button || "Дальше") : "Пропустить шаг");
        // «Дальше» у шага-объяснения ведёт на следующий шаг; пропуск (или объяснение, которого нет на экране) —
        // мимо зависимых шагов (skipAlso).
        const skip = s.optional && (s.action !== "next" || (cur && cur.absent));
        b.onclick = () => go(skip ? skipNext(i, s) : i + 1); btns.append(b);
      }
      c.append(btns);
    }
    placeCard(box, !!(target && target.closest && target.closest("table")));
  }
  function quit() {
    const b = mk("button", "tt-quiet", "Выйти из обучения");
    b.onclick = () => { stop(false); };
    return b;
  }
  // Действие за человека: и кнопки «Ввести за меня», и автопрогон.
  function act(s, target) {
    if (s.action === "click" && target) {
      cur.clicked = Date.now();
      if (s.navigates) { st.step = cur.i + 1; save(); log("ok " + (cur.i + 1)); }
      target.click();
    }
    else if (s.action === "type" || s.action === "select") { setValue(target, s.value); if (s.action === "select" && matches(target, s.value)) cur.changed = true; }
    else if (s.action === "fill") for (const f of s.fields || []) setValue(find(f.target), f.value);
  }
  // Пропуск необязательного шага: вместе с ним — skipAlso следующих (они идут в окне, которое он открывал).
  function skipNext(i, s) { return i + 1 + (s.skipAlso || 0); }
  function fieldsOk(s) { return (s.fields || []).every((f) => matches(find(f.target), f.value)); }
  // Цель шага: своя (target) или — у fill без target — общий блок всех его полей (форма входа целиком),
  // чтобы подсветка обводила форму, а карточка вставала рядом, а не поверх неё.
  function targetOf(s) {
    if (s.target) return find(s.target);
    if (s.action !== "fill") return null;
    const els = (s.fields || []).map((f) => find(f.target)).filter(Boolean);
    if (!els.length) return null;
    let a = els[0].parentElement;
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a && a !== document.body ? a : els[0];
  }

  function tick() {
    if (!st) return;
    const l = lesson(); if (!l) return;
    const i = st.step, s = l.steps[i]; if (!s) { finish(); return; }
    if (!cur || cur.i !== i) cur = { i, step: s, since: Date.now(), clicked: 0, lost: false, onOtherPage: false, played: false };
    if (stepPage(s) !== pageName()) {
      cur.onOtherPage = true;
      if (st.autoplay) { location.href = stepPage(s); return; }
      render(i, s, null); return;
    }
    cur.onOtherPage = false;
    const target = targetOf(s);
    // Цель ищется до 10 с (экраны дорисовываются по ответу сервера); дольше — «не вижу» и выход вперёд/назад.
    // Необязательный шаг без цели (например, неразобранных замечаний нет) — не «не вижу», а «пропускаем»:
    // через 4 с карточка объясняет (missing), автопрогон пропускает его и skipAlso следующих за ним шагов.
    cur.absent = !!s.optional && !!s.target && !target && Date.now() - cur.since > 4000;
    if (cur.absent && st.autoplay) { log("ok " + (i + 1) + " (пропущен: нет на экране)"); go(skipNext(i, s)); return; }
    cur.lost = !s.optional && (!!s.target || s.action === "fill") && !target && Date.now() - cur.since > 10000;
    if (st.autoplay && cur.lost) { log("FAIL " + (i + 1) + ": не найдена цель " + JSON.stringify(s.target)); stop(false); return; }
    render(i, s, target);
    if (target && !cur.scrolled) { cur.scrolled = true; try { target.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* */ } }
    // Автопрогон: действие за человека через полсекунды после появления цели.
    // Выключенную кнопку (экран ещё загружает данные) автопрогон не нажимает — ждёт, пока включится.
    if (st.autoplay && !cur.played && (target || (!s.target && s.action !== "fill")) && !(s.action === "click" && target && target.disabled)
        && Date.now() - cur.since > (s.delay || 500)) {
      cur.played = true;
      if (s.action === "next") { log("ok " + (i + 1)); go(i + 1); return; }
      act(s, target);
    }
    // Условие перехода. click — переход после нажатия на цель (и, если задано, когда выполнилось until);
    // type/select/fill — когда значение совпало; wait — когда выполнилось until; next — только кнопкой.
    let ready = false;
    if (s.action === "click") ready = ((!!cur.clicked && Date.now() - cur.clicked > 250) || (s.match === false && !!s.until)) && cond(s.until);
    else if (s.action === "type" || s.action === "select") ready = (s.match === false ? !!s.until : cur.changed || matches(target, s.value)) && cond(s.until);
    else if (s.action === "fill") ready = fieldsOk(s) && cond(s.until);
    else if (s.action === "wait") ready = cond(s.until);
    if (ready) { if (st.autoplay) log("ok " + (i + 1)); go(i + 1); return; }
    if (st.autoplay && Date.now() - cur.since > (s.timeout || 20000)) { log("FAIL " + (i + 1) + ": шаг не завершился за " + ((s.timeout || 20000) / 1000) + " с"); stop(false); }
  }
  // Нажатие на цель ловим на всплытии до обработчиков экрана (capture): экран мог тут же перерисоваться.
  document.addEventListener("click", (e) => {
    if (!st || !cur || cur.step.action !== "click" || !cur.step.target) return;
    if (e.target.closest && e.target.closest(".tt-ui")) return;
    const t = find(cur.step.target);
    if (t && (t === e.target || t.contains(e.target))) {
      cur.clicked = Date.now();
      // Нажатие уводит на другую страницу (navigates: true) — шаг засчитываем сразу, до ухода со страницы.
      if (cur.step.navigates) { st.step = cur.i + 1; save(); }
    }
  }, true);
  // Выбор в списке ловим в момент change: некоторые списки («+ Новый документ…») сразу сбрасываются обратно.
  document.addEventListener("change", (e) => {
    if (!st || !cur || cur.step.action !== "select") return;
    const t = find(cur.step.target);
    if (t && t === e.target && matches(t, cur.step.value)) cur.changed = true;
  }, true);

  function run() {
    if (!st) return;
    if (!lesson()) return;
    clearInterval(timer); timer = setInterval(tick, 200); tick();
    addEventListener("resize", () => { if (ui && cur) render(cur.i, cur.step, targetOf(cur.step)); });
    addEventListener("scroll", () => { if (ui && cur) render(cur.i, cur.step, targetOf(cur.step)); }, true);
  }
  // Подгрузка уроков роли (js/tours/<роль>.js) — на рабочей странице, где урок продолжается.
  function loadRole(role, cb) {
    if (order.some((id) => lessons[id].role === role)) { cb(); return; }
    const b = scriptBase(); const sc = document.createElement("script");
    sc.src = b.root + "js/tours/" + role + ".js?v=" + b.v; sc.onload = cb; sc.onerror = () => log("FAIL нет файла уроков " + role);
    document.head.append(sc);
  }
  function resume() {
    st = ls.get(KEY);
    if (!st || !st.lesson) { st = null; return; }
    loadRole(st.role, () => {
      if (!lessons[st.lesson]) { log("FAIL нет урока " + st.lesson); st = null; save(); return; }
      run();
    });
  }

  window.TandemTour = {
    register(l) { if (!lessons[l.id]) order.push(l.id); lessons[l.id] = l; },
    lessons(role) { return order.map((id) => lessons[id]).filter((l) => !role || l.role === role); },
    start, stop: () => stop(false), creds, find, done: () => ls.get(DONE) || {}, active: () => st,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resume); else resume();
})();
