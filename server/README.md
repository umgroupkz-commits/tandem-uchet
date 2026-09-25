# Учёт Тандем KZ на собственном сервере

Всё, что нужно для переезда с Supabase + GitHub Pages на свой сервер. Проверено репетицией
18.09.2026: пустой PostgreSQL 17 в Docker, схема из `db/schema/tandem_full.sql`, справочники из
выгрузки, прокси из этой папки — дымовой тест `tools/office-smoke.mjs all` прошёл 292 из 292 (19.09.2026 на пустом стенде из снимка с миграцией 0033: касса 30 из 30, продажи 44 из 44),
бэк-офис в браузере работал через локальный прокси.

## Что где

| Файл | Зачем |
|---|---|
| `../db/schema/tandem_full.sql` | полный снимок схемы: таблицы, ограничения, индексы, функции, RLS |
| `../db/schema/tandem_seed.sql` | обязательные справочники: единицы, права ролей, настройки-заглушки |
| `proxy.mjs` | прокси «JSON → функция базы», замена Supabase Edge Function `uchet` |
| `docker-compose.yml` | база, прокси и ежедневная резервная копия (`./backups`, 30 последних) |
| `seed-dev.sql` | только для репетиции: известные коды и демо-данные |
| `../config.js` | адрес сервера для экранов — единственная правка фронта при переезде |

## Переезд по шагам

1. Сервер с Docker. В этой папке файл `.env`:
   ```
   DB_PASSWORD=<длинный пароль>
   CORS_ORIGIN=https://<адрес сайта>
   ```
2. `docker compose up -d db` — поднимется пустая база: схема и обязательные справочники создаются сами.
3. Данные. Правильный путь — дамп боевой базы (строка подключения — в панели Supabase, Settings → Database):
   ```
   docker run --rm postgres:17 pg_dump "<строка подключения Supabase>" --schema=tandem --data-only -Fc > tandem.dump
   docker compose exec -T db pg_restore -U tandem -d tandem --data-only --disable-triggers < tandem.dump
   ```
   Перед восстановлением очистите справочники из шага 2 (`truncate tandem.units, tandem.role_permissions,
   tandem.settings, tandem.points cascade`) — в дампе они есть свои.
   Если дампа нет — справочники поднимаются из JSON-выгрузки:
   `node tools/backup-to-sql.mjs data/backup/<дата> > restore.sql`, затем `psql -f restore.sql`.
   В выгрузку не входят коды точек и PIN пользователей: точкам ставятся случайные коды, пользователи
   заводятся заново.
4. `docker compose up -d` — поднимутся прокси (порт 8787 на localhost) и резервное копирование.
5. nginx: сайт — статические файлы репозитория; `location /api/ { proxy_pass http://127.0.0.1:8787/; }`.
   HTTPS обязателен: по сети ходят коды и PIN.
6. В `config.js` вписать `window.TANDEM_API_URL = "https://<адрес>/api/";`.
7. Сменить `owner_pin` и `driver_pin` в `tandem.settings`, задать служебный ключ
   (`service_key_hash` = sha256 от длинной случайной строки), завести администратора:
   ```sql
   insert into tandem.users (login, name, role, pin_hash)
   values ('admin', 'Администратор', 'admin', crypt('<временный PIN>', gen_salt('bf')));
   ```
8. Проверка: `TANDEM_API_URL=https://<адрес>/api/ TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… node tools/office-smoke.mjs all`.
   Тест создаёт только записи `ZZ_TEST_…` и убирает их за собой.

## Репетиция на своей машине

```
cd server
printf 'DB_PASSWORD=rehearsal_local_only\n' > .env
docker compose -p tandem-rehearsal up -d --build
docker compose -p tandem-rehearsal exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < seed-dev.sql
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs all
docker compose -p tandem-rehearsal down -v     # убрать стенд вместе с данными
```
Часть проверок рассчитана на настоящие справочники (точка «Енешка», сотни позиций) — для полного
прохода загрузите выгрузку (шаг 3).

## Резервная копия, пока учёт живёт в Supabase

На бесплатном тарифе Supabase копий не делает. Раз в сутки (планировщик Windows или cron):
```
docker run --rm postgres:17 pg_dump "<строка подключения Supabase>" --schema=tandem -Fc > tandem_$(date +%F).dump
```
Строку подключения с паролем храните в переменной окружения, не в файле репозитория. Без неё копию
снять нельзя: через сайт и прокси выгрузка всей базы намеренно не предусмотрена — их защищает
только короткий код собственника.

## Обновление снимка схемы

Снимок снят запросом к каталогу PostgreSQL (последовательности, таблицы, ограничения, индексы, функции
`tandem.*` и `public.tandem_*`, представления, триггеры, RLS). После каждой новой миграции его надо
переснять, иначе новая установка отстанет от боевой базы; до пересъёмки догоняется файлами
`db/migrations` новее снимка. Сейчас снимок включает миграции 0001–0037 (0033–0037 внесены скриптом, тела функций сверены с базой по md5). Запрос — `db/schema/snapshot-query.sql`, сборка файла —
`node tools/build-schema-snapshot.mjs <результат запроса>`.

## Чего прокси не делает намеренно

Логики в нём нет: маршрутизация, проверка прав, сессии, счётчик неверных кодов и служебный ключ —
в функции базы `public.tandem_gate`. Прокси передаёт ей действие и возвращает ответ.
