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
`tandem.office_*`; файлы миграций — `db/migrations/`.

Вход защищён: пять неверных PIN подряд запирают логин на 15 минут, а пока пользователь
не сменил временный PIN, ему доступны только `me`, `logout` и `change_pin`.

Дымовой тест: `node tools/office-smoke.mjs all` (нужен `TANDEM_ADMIN_PIN`; с
`TANDEM_OWNER_PIN` дополнительно идут разделы переноса и в конце — уборка). Тест заводит
записи `ZZ_TEST_*` и пользователей `zz_test_*` и сам их убирает действием `test_cleanup`
(RPC `public.tandem_test_cleanup`, защита — код собственника); последняя проверка прогона
подтверждает, что следов не осталось. Без `TANDEM_OWNER_PIN` уборка не выполняется —
записи придётся снести вручную.

Перенос справочников из iiko: `node tools/iiko-migrate.mjs` (см. шапку скрипта).
**Повторный перенос обновляет только позиции, не правленные в бэк-офисе** (правка ставит
`items.source='office'`, и такая строка при переносе пропускается). А вот названия
групп, складов и контрагентов, изменённые в офисе, перенос перезапишет.

Техкарты: раздел `office.html` → Техкарты; перенос из iiko — `node tools/iiko-migrate-charts.mjs`
(около часа, в фоне, кэш в `data/iiko/charts`); себестоимость считает `tandem.item_cost`,
отчёт — `tandem.menu_foodcost`; порог фудкоста — `settings.foodcost_alert`.

Спецификация и план — `docs/superpowers/`.
