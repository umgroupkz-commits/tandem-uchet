# Тандем KZ — учёт продаж и денег (прототип)

Статическая страница (`index.html` + `app.js`) для GitHub Pages.
API — edge-функция Supabase `uchet` (`https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet`), POST `{action, payload}`.

Почему страница здесь, а не в Supabase: на домене `*.supabase.co` и Edge Functions, и Storage
переписывают `text/html` в `text/plain` и ставят CSP `sandbox` — HTML там не отдать
(https://supabase.com/docs/guides/functions/http-methods). Функция на GET делает редирект сюда.

Публикация: коммит в `main` → GitHub Pages обновляет страницу за 1–2 минуты.

## Бэк-офис (`office.html`)

Справочники: номенклатура с группами, склады, контрагенты, пользователи. Вход — логин и PIN,
роли: администратор, собственник, бухгалтер, технолог, кладовщик (права — таблица
`tandem.role_permissions`). Логика — RPC `tandem_office` (диспетчер) и функции
`tandem.office_*`; файлы миграций — `db/migrations/`. Дымовой тест: `node tools/office-smoke.mjs all`
(нужен `TANDEM_ADMIN_PIN`). Перенос справочников из iiko: `node tools/iiko-migrate.mjs`
(см. шапку скрипта). Спецификация и план — `docs/superpowers/`.
