// Адрес сервера учёта для экранов на GitHub Pages.
// С 20.11.2026 GitHub Pages - ТЕСТОВАЯ база (Supabase, копия рабочей на 20.11.2026, решение Андрея): здесь
// сотрудники учатся и пробуют, данные не настоящие. Рабочая программа - https://uchet.eneshka.kz/ (сервер PS.kz
// в Казахстане отдаёт экраны сам и пишет свой config.js с рабочим адресом). Плашка «ТЕСТОВАЯ БАЗА» - на всех экранах.
window.TANDEM_API_URL = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
window.TANDEM_TEST_BASE = true;
(function () {
  function badge() {
    if (document.getElementById("tandem-test-badge")) return;
    var b = document.createElement("div");
    b.id = "tandem-test-badge";
    b.textContent = "ТЕСТОВАЯ БАЗА - для обучения, данные не настоящие";
    b.setAttribute("style", "position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483646;" +
      "background:#c62828;color:#fff;font:600 12px/1.7 system-ui,-apple-system,sans-serif;padding:0 10px;" +
      "border-radius:0 0 6px 6px;pointer-events:none;opacity:.92;white-space:nowrap");
    document.body.appendChild(b);
    if (document.title.indexOf("ТЕСТ") !== 0) document.title = "ТЕСТ · " + document.title;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", badge); else badge();
})();
