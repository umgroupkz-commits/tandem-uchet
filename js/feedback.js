// Кнопка «Замечание» на всех экранах (сборка 21). Человек пишет, что не так, — экран сам прикладывает,
// где он был: страница и раздел, сборка, размер окна, последняя ошибка на экране. Обычный скрипт (не
// модуль): его подключают и модульные страницы, и index.html с классическим app.js.
// Страница вызывает TandemFeedback.mount({ source, send, screen, build, corner, attachTo }):
//   send(message, context) → Promise<{ok, id?, error?, message?}> — отправка своим путём (бэк-офис —
//     api('feedback_save'), точка и касса — действие feedback с кодом точки);
//   screen() → строка «где я» (раздел, вкладка, точка); build — номер сборки;
//   corner — 'br' (по умолчанию), 'bl', 'tr', 'tl'; attachTo — своя кнопка вместо плавающей.
// TandemFeedback.noteError(text) — страница сообщает текст ошибки, показанной человеку.
// Коды, PIN и токены в сведения не попадают: адрес берётся без строки запроса.
(function () {
  if (window.TandemFeedback) return;
  let lastError = "", lastErrorAt = 0, opts = null, btn = null;
  const DRAFT = "tandem_feedback_draft";
  function noteError(t) {
    t = String(t || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    lastError = t.slice(0, 500); lastErrorAt = Date.now();
  }
  window.addEventListener("error", (e) => noteError("JS: " + (e && e.message ? e.message : "ошибка") + (e && e.filename ? " @ " + String(e.filename).split("/").pop() + ":" + e.lineno : "")));
  window.addEventListener("unhandledrejection", (e) => noteError("JS: " + (e && e.reason && e.reason.message ? e.reason.message : String(e && e.reason))));
  // Видимые сейчас тексты ошибок экрана: тосты «плохо», блоки .err и предупреждения.
  function visibleErrors() {
    const out = [];
    document.querySelectorAll(".toast.bad, .err, .note.bad, .warnbox, .bad.msg").forEach((n) => {
      if (n.offsetParent === null && getComputedStyle(n).position !== "fixed") return;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !out.includes(t)) out.push(t.slice(0, 300));
    });
    return out.slice(0, 3);
  }
  // Тост пропадает через пару секунд — запоминаем его текст, пока он виден.
  function watchToast() {
    const t = document.getElementById("toast"); if (!t || t._fbWatch) return;
    t._fbWatch = true;
    new MutationObserver(() => { if (!t.hidden && /\bbad\b/.test(t.className)) noteError(t.textContent); })
      .observe(t, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  function context() {
    let screen = "";
    try { screen = opts && opts.screen ? String(opts.screen() || "") : ""; } catch (e) { screen = ""; }
    const vis = visibleErrors();
    return {
      build: opts && opts.build ? String(opts.build) : "",
      screen: screen.slice(0, 200),
      url: location.pathname.split("/").pop() + location.hash,
      w: window.innerWidth, h: window.innerHeight,
      ua: navigator.userAgent.slice(0, 160),
      online: navigator.onLine,
      last_error: lastError ? lastError + (lastErrorAt ? " (" + Math.round((Date.now() - lastErrorAt) / 60000) + " мин назад)" : "") : "",
      on_screen: vis,
      at: new Date().toLocaleString("ru-RU"),
    };
  }
  const css = (n, s) => { n.setAttribute("style", s); return n; };
  const mk = (tag, s, text) => { const n = document.createElement(tag); if (s) css(n, s); if (text != null) n.textContent = text; return n; };
  function open() {
    if (document.getElementById("tfb-ov")) return;
    const ctx = context();
    const ov = mk("div", "position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px");
    ov.id = "tfb-ov";
    const card = mk("div", "background:#fff;color:#111827;border-radius:12px;max-width:520px;width:100%;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.25);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-height:92vh;overflow:auto");
    card.append(mk("div", "font-weight:700;font-size:18px;margin-bottom:6px", "Замечание"));
    card.append(mk("div", "color:#6b7280;font-size:13px;margin-bottom:10px", "Что делали, что получилось и что ожидали увидеть. Где вы были, программа приложит сама."));
    const ta = mk("textarea", "display:block;width:100%;box-sizing:border-box;min-height:120px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;resize:vertical");
    ta.maxLength = 2000;
    try { ta.value = localStorage.getItem(DRAFT) || ""; } catch (e) {}
    ta.placeholder = "Например: провёл приход, а в остатках сумма другая — ожидал 15 000";
    ta.addEventListener("input", () => { try { localStorage.setItem(DRAFT, ta.value); } catch (e) {} });
    card.append(ta);
    const info = mk("details", "margin-top:8px;font-size:12px;color:#6b7280");
    const sum = mk("summary", "cursor:pointer", "Что приложится: " + [ctx.screen || ctx.url, ctx.build ? "сборка " + ctx.build : "", ctx.last_error ? "последняя ошибка" : ""].filter(Boolean).join(", "));
    info.append(sum);
    const pre = mk("div", "white-space:pre-wrap;margin-top:6px;word-break:break-word");
    pre.textContent = ["Экран: " + (ctx.screen || "—"), "Страница: " + ctx.url, "Сборка: " + (ctx.build || "—"), "Окно: " + ctx.w + "×" + ctx.h,
      "Последняя ошибка: " + (ctx.last_error || "—"), ctx.on_screen.length ? "Сейчас на экране: " + ctx.on_screen.join(" | ") : ""].filter(Boolean).join("\n");
    info.append(pre); card.append(info);
    const msg = mk("div", "margin-top:8px;font-size:14px;min-height:1em");
    card.append(msg);
    const row = mk("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap");
    const cancel = mk("button", "width:auto;min-height:0;padding:10px 16px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#111827;font:inherit;cursor:pointer", "Отмена");
    const send = mk("button", "width:auto;min-height:0;padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer", "Отправить");
    cancel.type = send.type = "button";
    row.append(cancel, send); card.append(row);
    ov.append(card); document.body.append(ov);
    const close = () => ov.remove();
    cancel.onclick = close;
    ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { msg.style.color = "#b91c1c"; msg.textContent = "Напишите, что случилось"; ta.focus(); return; }
      send.disabled = cancel.disabled = true; msg.style.color = "#6b7280"; msg.textContent = "Отправляю…";
      let r;
      try { r = await opts.send(text, ctx); } catch (e) { r = { ok: false, error: "network" }; }
      send.disabled = cancel.disabled = false;
      if (r && r.ok) {
        try { localStorage.removeItem(DRAFT); } catch (e) {}
        card.innerHTML = "";
        card.append(mk("div", "font-weight:700;font-size:18px;margin-bottom:8px", "Спасибо!"),
          mk("div", "", "Замечание" + (r.id ? " №" + r.id : "") + " записано. Его разберут и ответят."));
        const ok = mk("button", "width:auto;min-height:0;margin-top:14px;padding:10px 16px;border-radius:8px;border:none;background:#2563eb;color:#fff;font:inherit;cursor:pointer", "Закрыть");
        ok.type = "button"; ok.onclick = close; card.append(ok); ok.focus();
        return;
      }
      msg.style.color = "#b91c1c";
      msg.textContent = r && r.error === "network" ? "Нет связи. Текст сохранён на этом устройстве — отправьте позже."
        : (r && (r.message || r.error)) || "Не получилось отправить — повторите";
    };
    ta.focus();
  }
  function mount(o) {
    opts = o || {};
    watchToast();
    if (opts.attachTo) { opts.attachTo.addEventListener("click", open); return; }
    if (btn) return;
    const c = opts.corner || "br";
    const pos = (c[0] === "t" ? "top:10px;" : "bottom:10px;") + (c[1] === "l" ? "left:10px;" : "right:10px;");
    btn = mk("button", "position:fixed;" + pos + "z-index:9000;width:auto;min-height:0;padding:7px 12px;border-radius:999px;border:1px solid #d1d5db;background:#fff;color:#374151;font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;opacity:.92", "✎ Замечание");
    btn.type = "button"; btn.title = "Сообщить о проблеме или неудобстве"; btn.className = "noprint tfb-btn";
    btn.onclick = open;
    document.body.append(btn);
  }
  window.TandemFeedback = { mount, open, noteError, context };
})();
