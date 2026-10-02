# Учёт Тандем KZ на собственном сервере

Всё, что нужно для переезда с Supabase + GitHub Pages на свой сервер. Проверено репетицией
18.09.2026: пустой PostgreSQL 17 в Docker, схема из `db/schema/tandem_full.sql`, справочники из
выгрузки, прокси из этой папки — дымовой тест `tools/office-smoke.mjs all` прошёл 292 из 292 (19.09.2026 на пустом стенде из снимка с миграцией 0033: касса 30 из 30, продажи 44 из 44),
бэк-офис в браузере работал через локальный прокси.

## Что где

| Файл | Зачем |
|---|---|
| `../db/schema/tandem_full.sql` | полный снимок схемы: таблицы, ограничения, индексы, функции, RLS |
| `../db/schema/tandem_seed.sql` | обязательные справочники: единицы, права ролей, настройки (коды — случайные) |
| `proxy.mjs` | прокси «JSON → функция базы», замена Supabase Edge Function `uchet` |
| `docker-compose.yml` | база, прокси и ежедневная резервная копия (`BACKUP_DIR`, 30 последних) |
| `seed-dev.sql` | только для репетиции: известные коды и демо-данные |
| `../config.js` | адрес сервера для экранов — единственная правка фронта при переезде |
| `../supabase/config.toml` | настройки Supabase CLI: функция `uchet` выкладывается без проверки JWT (см. «Выкладка функции uchet») |

## Переезд по шагам

Сервер готовится и проверяется заранее, а данные переносятся одним окном, когда запись в Supabase
закрыта. Иначе чеки, отчёты и заявки, пришедшие в Supabase после снятия дампа, останутся только там,
а очередь кассы, открытой со старого адреса, может так и не дойти до нового сервера.

### Подготовка (точки работают как обычно)

1. Сервер с Docker, клон репозитория. В папке `server/` файл `.env`:
   ```
   DB_PASSWORD=<вывод openssl rand -hex 24>
   BACKUP_DIR=/var/backups/tandem
   ```
   Пароль прокси получает отдельной переменной (`PGPASSWORD`), поэтому знаки `/ + # ?` в нём не мешают;
   только `$` docker compose считает подстановкой — такой пароль берите в одинарные кавычки.
   `BACKUP_DIR` — папка вне клона (`sudo mkdir -p /var/backups/tandem`): в копиях коды точек и
   собственника, хэши PIN и вся выручка. `CORS_ORIGIN` пока не задавайте (см. шаг 13).
2. `docker compose up -d db` — поднимется пустая база: схема и обязательные справочники создаются сами.
   Коды собственника и водителя в ней случайные и никому не известны.
3. Свои коды, служебный ключ и администратор — сразу, до того как сервер увидит интернет
   (`docker compose exec db psql -U tandem -d tandem`):
   ```sql
   update tandem.settings set value = '<код собственника>' where key = 'owner_pin';
   update tandem.settings set value = '<код водителя>' where key = 'driver_pin';
   insert into tandem.settings (key, value) values ('service_key_hash', encode(digest('<длинная случайная строка>', 'sha256'), 'hex'))
   on conflict (key) do update set value = excluded.value;
   insert into tandem.users (login, name, role, pin_hash)
   values ('admin', 'Администратор', 'admin', crypt('<временный PIN>', gen_salt('bf')));
   ```
   При переносе дампа (шаг 9) их заменят боевые коды и пользователи из Supabase; при переносе из JSON
   (раздел ниже) останутся эти.
4. `docker compose up -d` — поднимутся прокси (порт 8787 только на localhost) и резервное копирование.
5. nginx и HTTPS (по сети ходят коды и PIN). Сайту — отдельная папка только со статикой, не клон:
   в клоне лежат `server/.env`, `tools/`, `data/`, `.git`.
   ```
   sudo mkdir -p /var/www/tandem && cd <клон> && sudo cp -r *.html *.css app.js config.js js vendor /var/www/tandem/
   ```
   (после каждого обновления клона — повторить). Конфигурация:
   ```nginx
   server {
       listen 443 ssl;
       server_name <адрес>;
       # ssl_certificate …; ssl_certificate_key …;
       root /var/www/tandem;
       index index.html;
       location /api/ {
           proxy_pass http://127.0.0.1:8787/;
           proxy_set_header X-Real-IP $remote_addr;   # IP для счётчика неверных кодов; заголовок клиента затирается
           client_max_body_size 10m;                   # прокси сам отвечает 413 с понятной ошибкой после 8 МБ
       }
       # Подстраховка, если root всё же смотрит в клон: служебные папки и файлы с точкой не отдавать.
       location ^~ /.well-known/acme-challenge/ { }
       location ~ ^/(server|db|tools|data|docs|supabase|\.git)(/|$) { deny all; }
       location ~ /\. { deny all; }
   }
   ```
   Проверка: `curl -I https://<адрес>/server/.env` и `curl -I https://<адрес>/.git/config` — должно быть 403
   или 404, а `curl -I https://<адрес>/index.html` — 200.
6. Проверка стека до переноса данных: `TANDEM_API_URL=https://<адрес>/api/ TANDEM_ADMIN_PIN=… TANDEM_OWNER_PIN=… TANDEM_SERVICE_KEY=… node tools/office-smoke.mjs all`.
   Всё, что он заведёт, сотрёт шаг 9.

### Переключение (одно окно, вечером после закрытия точек)

7. На каждом планшете: касса показывает «Все чеки на сервере» (нет «ждут отправки» и «не приняты»),
   отчёты смены сданы, заявки отправлены.
8. Закрыть запись в Supabase: `supabase secrets set UCHET_MAINTENANCE=1` (или в панели: Edge Functions →
   Secrets). Проверка — ответ 503:
   ```
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet -d '{}'
   ```
   Если пришло не 503, развёрнута старая версия функции — выложите её из этого репозитория, как в разделе
   «Выкладка функции uchet в Supabase» ниже (обязательно без проверки JWT: иначе вместо 503 будет 401,
   а 401 касса считает отказом сервера и помечает очередь чеков «не принят»).
   Касса принимает 503 за обрыв связи: чеки остаются в её очереди и уйдут на новый сервер (шаг 12).
   Секрет после переезда не снимать — иначе забытая вкладка снова начнёт писать в Supabase.
9. Перенос данных: дамп Supabase (строка подключения — в панели Supabase, Settings → Database; храните
   её в переменной окружения, не в файле), очистка всех таблиц схемы `tandem`, восстановление:
   ```
   docker run --rm postgres:17 pg_dump "$SUPABASE_DB_URL" --schema=tandem --data-only -Fc > /var/backups/tandem/supabase_$(date +%F).dump
   docker compose exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 -c "do \$\$ begin execute (select 'truncate ' || string_agg(format('tandem.%I', tablename), ', ') || ' cascade' from pg_tables where schemaname = 'tandem'); end \$\$"
   docker compose exec -T db pg_restore -U tandem -d tandem --data-only --disable-triggers --exit-on-error --single-transaction < /var/backups/tandem/supabase_<дата>.dump
   ```
   `--single-transaction` с `--exit-on-error`: при любой ошибке не остаётся половины данных — восстановление
   откатывается целиком и останавливается с сообщением.
10. Сверка: один и тот же запрос — в Supabase (SQL Editor) и на новом сервере; число строк должно совпасть
    по каждой таблице.
    ```sql
    select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from tandem.%I', table_name), false, true, '')))[1]::text::bigint as rows
    from information_schema.tables where table_schema = 'tandem' and table_type = 'BASE TABLE' order by 1;
    ```
11. В `config.js` вписать `window.TANDEM_API_URL = "https://<адрес>/api/";` — в клоне на сервере (и скопировать
    в `/var/www/tandem`) и в репозитории на GitHub Pages: планшеты, открытые со старого адреса, после
    перезагрузки пойдут на новый сервер.
12. Перезагрузить экраны на всех планшетах (касса, точка, заявки, склад, бэк-офис). Очередь кассы живёт
    в браузере отдельно для каждого адреса сайта: касса, открытая с github.io, дошлёт свои чеки, только
    если её открыть с того же github.io. Дождаться «Все чеки на сервере», проверить вход в бэк-офис и
    сводку собственника.
13. `CORS_ORIGIN` — только когда ни один планшет не держит очередь на другом адресе: если экраны остаются
    на GitHub Pages — `CORS_ORIGIN=https://umgroupkz-commits.github.io`, если переехали на свой адрес —
    `CORS_ORIGIN=https://<адрес>`; затем `docker compose up -d proxy`. До этого прокси отвечает любому
    источнику (`*`), иначе касса со старого адреса получит отказ CORS и будет копить чеки впустую.

### Если дампа нет — справочники из JSON-выгрузки

На свежую базу после шагов 2–3 (если на шаге 6 гоняли дымовой тест — `docker compose down -v`,
`docker compose up -d db` и снова шаг 3; копии в `BACKUP_DIR` при этом не трогаются). Из папки `server/`:
```
node ../tools/backup-to-sql.mjs ../data/backup/<дата> > ../data/backup/restore.sql
docker compose exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < ../data/backup/restore.sql
```
Загрузка идёт одной транзакцией и в конце проверяет внешние ключи: висячая ссылка отменяет её целиком.
В выгрузку не входят коды точек, PIN пользователей и настройки: точкам ставятся случайные коды,
пользователи заводятся заново, коды собственника и водителя — те, что заданы на шаге 3.

## Резервные копии

Сервис `backup` раз в сутки снимает полный дамп в `BACKUP_DIR` и хранит 30 последних. Копия пишется во
временный файл и получает имя `tandem_ГГГГММДД_ЧЧММ.dump` только после успеха; сбой — строка `ОШИБКА`
в `docker compose logs backup` и повтор через час. Проверка свежести: `ls -lt /var/backups/tandem | head -3`.
Ротация трогает только свои `tandem_*.dump`: дамп Supabase для переезда (`supabase_*.dump`, шаг 9) и копии
из раздела «Резервная копия, пока учёт живёт в Supabase» в той же папке она не удаляет — эталон переезда
не пропадёт, а лимит в 30 своих копий не делится с чужими. Старые `supabase_*.dump` чистите сами.
Копии на том же диске, что и база, — раз в сутки увозите свежую с сервера (`rsync`/`scp` на другую машину
или в облако по cron), иначе потеря диска уносит и базу, и все копии.

### Восстановление из своей копии

Новый стек (`docker compose up -d db`) уже содержит справочники из init-скриптов, поэтому простой
`pg_restore` в него упадёт на дублях и внешних ключах. Порядок — тот же, что на шаге 9:
```
docker compose exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 -c "do \$\$ begin execute (select 'truncate ' || string_agg(format('tandem.%I', tablename), ', ') || ' cascade' from pg_tables where schemaname = 'tandem'); end \$\$"
docker compose exec -T db pg_restore -U tandem -d tandem --data-only --disable-triggers --exit-on-error --single-transaction < /var/backups/tandem/tandem_<дата>.dump
```
Затем сверка: запрос из шага 10 — в таблицах есть настоящие точки и отчёты по дату копии,
`select value from tandem.settings where key = 'owner_pin'` — боевой код, а не случайная строка из init.

## Репетиция на своей машине

```
cd server
printf 'DB_PASSWORD=rehearsal_local_only\nBACKUP_DIR=./backups\n' > .env
docker compose -p tandem-rehearsal up -d --build
docker compose -p tandem-rehearsal exec -T db psql -U tandem -d tandem -v ON_ERROR_STOP=1 < seed-dev.sql
TANDEM_API_URL=http://127.0.0.1:8787 TANDEM_ADMIN_PIN=123456 TANDEM_OWNER_PIN=000111 TANDEM_SERVICE_KEY=dev-service-key node ../tools/office-smoke.mjs all
docker compose -p tandem-rehearsal down -v     # убрать стенд вместе с данными
```
Часть проверок рассчитана на настоящие справочники (точка «Енешка», сотни позиций) — для полного
прохода загрузите выгрузку (шаг 9 или JSON).

## Выкладка функции uchet в Supabase

Пока учёт живёт в Supabase, экраны ходят в Edge Function `uchet` и заголовок `Authorization` не шлют:
вход, сессии и права проверяет сама функция базы `tandem_gate`. Поэтому функция выкладывается
**без проверки JWT** — с ней шлюз Supabase отвечает 401 до кода функции, и ложатся все экраны сразу,
а касса помечает очередь чеков «не принят» и сама их больше не досылает. Из корня репозитория:
```
supabase functions deploy uchet --no-verify-jwt --project-ref qeehxcnnuzuwskznhdyg
```
То же записано в `supabase/config.toml` (`[functions.uchet] verify_jwt = false`), но флаг в команде
оставляйте — он не зависит от того, из какой папки и с каким конфигом запущен CLI. Через MCP
(`deploy_edge_function`) — с параметром `verify_jwt: false`: там по умолчанию проверка включена.

Проверка сразу после выкладки — POST без заголовка `Authorization`:
```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet -d '{}'
```
Должно прийти 200 (или 503, если запись закрыта секретом `UCHET_MAINTENANCE`, шаг 8), но не 401.
Пришло 401 — выложите ещё раз командой выше.

Порядок с миграциями: функцию — раньше миграции `0042_point_auth_review.sql`. Новая функция сама
подставляет `_ip` (адрес клиента для счётчика неверных кодов), старый гейт это поле не читает. Наоборот
нельзя: старая функция передаёт payload как есть, и новый гейт поверил бы `_ip`, присланному клиентом, —
счётчик по IP обходился бы подменой адреса.

## Резервная копия, пока учёт живёт в Supabase

На бесплатном тарифе Supabase копий не делает. Раз в сутки (планировщик Windows или cron) — в папку вне
репозитория (репозиторий публичный, файлы `*.dump` в нём игнорируются, но копия в клоне — лишний риск):
```
docker run --rm postgres:17 pg_dump "$SUPABASE_DB_URL" --schema=tandem -Fc > /var/backups/tandem/supabase_$(date +%F).dump
```
Строку подключения с паролем храните в переменной окружения, не в файле репозитория. Без неё копию
снять нельзя: через сайт и прокси выгрузка всей базы намеренно не предусмотрена — их защищает
только короткий код собственника.

## Обновление снимка схемы

Снимок снят запросом к каталогу PostgreSQL (последовательности, таблицы, ограничения, индексы, функции
`tandem.*` и `public.tandem_*`, представления, триггеры, RLS). После каждой новой миграции его надо
переснять, иначе новая установка отстанет от боевой базы; до пересъёмки догоняется файлами
`db/migrations` новее снимка. Сейчас снимок включает миграции 0001–0043 (снимок пересобран после 0043 скриптом, тела функций сверены с базой по md5). Запрос — `db/schema/snapshot-query.sql`, сборка файла —
`node tools/build-schema-snapshot.mjs <результат запроса>`.

## Чего прокси не делает намеренно

Логики в нём нет: маршрутизация, проверка прав, сессии, счётчик неверных кодов и служебный ключ —
в функции базы `public.tandem_gate`. Прокси передаёт ей действие и возвращает ответ, добавив в payload
только `_ip` — адрес клиента для счётчика неверных кодов (из `X-Real-IP`, который ставит nginx;
присланное клиентом значение затирается).
