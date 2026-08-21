# Тандем KZ — учёт продаж и денег (прототип)

Статическая страница (`index.html` + `app.js`) для GitHub Pages.
API — edge-функция Supabase `uchet` (`https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet`), POST `{action, payload}`.

Почему страница здесь, а не в Supabase: на домене `*.supabase.co` и Edge Functions, и Storage
переписывают `text/html` в `text/plain` и ставят CSP `sandbox` — HTML там не отдать
(https://supabase.com/docs/guides/functions/http-methods). Функция на GET делает редирект сюда.

Публикация: коммит в `main` → GitHub Pages обновляет страницу за 1–2 минуты.
