# Подпроект 2 — «Техкарты и себестоимость»

Дата: 5 сентября 2026. Статус: утверждено к реализации.
Родительская спецификация: `2026-09-04-uchet-core-design.md` (архитектура, разделы 3.1а, 3.4, 3.5).
Отложенное из подпроекта 1, что закрывается здесь: `items.unit_id not null`; старый скрипт
`iiko-sync-items.mjs` и RPC `tandem_sync_items` выводятся из употребления (перенос — единственный путь).

## 1. Цель

Технолог ведёт технологические карты в бэк-офисе вместо iiko; система считает себестоимость
блюд и полуфабрикатов по действующей карте и учётным ценам сырья; собственница видит фудкост
меню. Все карты и цены закупа переносятся из iiko один раз, дальше живут у нас.

Не входит: акты производства и списание сырья по картам (подпроекты 3–4), фото блюд,
печатные формы ТТК, пищевая ценность.

## 2. Решения

- **Форма карты как в iiko**: по каждому ингредиенту брутто (взято со склада), нетто (после
  холодной обработки), выход (в готовом блюде); у карты — выход блюда и срок действия.
  Потери не хранятся, а считаются: холодные = (брутто − нетто) / брутто, горячие =
  (нетто − выход) / нетто.
- **Себестоимость считается на лету в SQL** функцией на дату; ничего не кэшируется
  (объём — тысячи строк, один рекурсивный запрос).
- **Цены сырья** — учётная цена в позиции (`cost_price`), источник помечается. Первое
  наполнение: последняя цена закупа из приходных накладных iiko за 2026 год, запасной
  вариант — оценочная закупочная цена из карточки iiko. Далее правится руками; в подпроекте 3
  цену будут обновлять приходные накладные.
- **Версии карт** — по датам: у блюда на любую дату действует не больше одной карты
  (ограничение в базе). «Новая версия с даты D» копирует строки и ставит старой `date_to = D − 1`.

## 3. Модель данных

```
items (+)     cost_price numeric null      -- учётная цена за единицу unit_id
              cost_date  date null
              cost_source text null        -- 'iiko_invoice' | 'iiko_estimate' | 'manual' | 'document'
              unit_id    -> not null (после проверки, что пустых нет)

charts        id uuid PK default gen_random_uuid(),
              item_code text -> items (блюдо или полуфабрикат: item_type in ('dish','prepared')),
              date_from date not null default current_date,
              date_to   date null,                 -- null = действует
              output_amount numeric not null check (> 0),   -- выход, в unit_id блюда
              technology text null,                -- описание технологии (из iiko technologyDescription)
              note text null,
              source text not null default 'office',        -- 'office' | 'iiko'
              iiko_id uuid unique null,
              created_by uuid null -> users, created_at timestamptz default now(),
              updated_by uuid null -> users, updated_at timestamptz default now(),
              exclude using gist (item_code with =,
                daterange(date_from, coalesce(date_to, 'infinity'::date), '[]') with &&)
              -- требует btree_gist (стандартное расширение Postgres)

chart_lines   id uuid PK default gen_random_uuid(),
              chart_id uuid -> charts on delete cascade,
              ingredient_code text -> items,       -- goods | prepared | dish (вложение)
              brutto numeric not null check (>= 0),
              netto  numeric not null check (>= 0),
              output numeric not null check (>= 0),
              sort_order int not null default 0,
              note text null,
              check (netto <= brutto)              -- выход может быть больше нетто (набухание круп),
                                                   -- поэтому проверяется только нетто <= брутто
settings      + 'foodcost_alert' = '35'          -- порог подсветки, %
role_permissions + раздел 'charts': admin v+e, owner v+e, technologist v+e,
                                    accountant v, storekeeper v
```

Единицы: количества в строке — в `unit_id` ингредиента (так хранит iiko), выход карты —
в `unit_id` блюда. Пересчёта единиц нет: если ингредиент в кг, брутто в кг.

Старая `tandem.item_chart` и RPC `tandem_sync_charts` удаляются после переноса; `tandem_charts`
(экран точки, «расход сырья») переписывается на `charts`/`chart_lines`: для позиции —
действующая на сегодня карта, строки `{n: имя, a: брутто на единицу блюда}` — тот же формат
ответа, экран не меняется.

## 4. Расчёт себестоимости

`tandem.item_cost(p_code text, p_date date default current_date) returns table(cost numeric,
partial numeric, missing text[])`:
- `goods`: `cost = cost_price`; если null — `cost = null`, `missing = [code]`;
- `dish` / `prepared`: карта, действующая на дату (`date_from <= p_date and (date_to is null or
  date_to >= p_date)`); нет карты → `cost = null, missing = [code]`; иначе
  `cost = Σ(brutto_i × cost(ingredient_i)) / output_amount`, `missing` — объединение по строкам;
  если хоть один ингредиент без цены — `cost = null`, а сумма по строкам с ценой отдаётся в
  `partial` для подсказки в редакторе.
- Глубина вложения ограничена 10; цикл в данных → `validation` при сохранении карты
  (проверка обходом вверх: ингредиент не может содержать редактируемое блюдо), при расчёте —
  обрыв по глубине с `missing = ['cycle:' || code]`.

Отчёт «Фудкост меню» — функция `tandem.menu_foodcost(p_point text, p_date date, p_group uuid)`:
для всех `for_sale and active` блюд — себестоимость, цена (цена точки или по умолчанию),
наценка % = (цена − себестоимость) / себестоимость × 100, фудкост % = себестоимость / цена × 100,
флаг «выше порога» (`settings.foodcost_alert`), список ингредиентов без цены. Реализация —
рекурсивный CTE по всем картам разом, не вызов функции в цикле.

## 5. RPC (через `tandem_office`, раздел `charts`)

- `charts_list {q?, group_id?, only_missing?, page?}` → строки: код, имя, тип, группа, есть ли
  действующая карта, выход, себестоимость, цена, фудкост %, флаг порога, есть ли ингредиенты
  без цены; по 200.
- `chart_get {code, date?}` → `{item, chart:{id, date_from, date_to, output_amount, technology,
  note, lines:[{id, ingredient_code, name, unit, brutto, netto, output, cost_price, line_cost,
  cold_loss_pct, hot_loss_pct}]}, cost, partial, missing, versions:[{id, date_from, date_to}]}`.
- `chart_save {id?, code, date_from, date_to?, output_amount, technology?, note?,
  lines:[{ingredient_code, brutto, netto, output, note?}]}` → `{ok, id}`; валидации: блюдо
  типа dish/prepared; строк ≥ 1; ингредиент активен и не равен блюду; нет цикла; пересечение
  дат с другой картой → `validation` с текстом «закройте прежнюю версию» (кроме правки той же
  карты).
- `chart_new_version {code, date_from}` → копирует действующую карту с новым `date_from`,
  старой ставит `date_to = date_from − 1` → `{ok, id}`.
- `chart_delete {id}` → удаление только карт с `source = 'office'`, у которых нет версий после;
  иначе `validation`. Карты из iiko не удаляются — закрываются датой.
- `item_cost_get {code, date?}` → `{cost, partial, missing}` — для карточки номенклатуры.
- Цена сырья: `item_save` (раздел `nomenclature`) принимает `cost_price`; при передаче ставит
  `cost_source = 'manual'`, `cost_date = current_date`; `item_get` отдаёт три поля.
- `foodcost_report {point_id?, date?, group_id?}` → строки отчёта и `csv` (текст) для выгрузки.

Права: `*_list`, `*_get`, `*_report` → `view`, остальное → `edit`; правило вывода раздела в
диспетчере дополняется: `chart%` и `foodcost%` → `charts`; `item_cost_get` попадает в
`nomenclature` по существующему правилу `item%` (view).

## 6. Перенос из iiko

Скрипт `tools/iiko-migrate-charts.mjs` (кэш в `data/iiko/charts/`, флаги `--dry`,
`--from-cache`, `--limit N`), маршрут прокси `migrate` с новыми видами:
1. Кандидаты: `migrate {kind: 'chart_candidates'}` → `[{code, iiko_id}]` — позиции с `iiko_id`
   и `item_type in ('dish','prepared')`.
2. Для каждого — `assembly-chart/list {productId}` (пауза 1,3 с, повтор на 429); из ответа:
   `id`, `assembledAmount`, `dateFrom`, `dateTo`, `technologyDescription`, `items[]`
   (`product`, `amountIn`, `amountMiddle`, `amountOut`, `sortWeight`). Переносятся все версии.
3. `migrate {kind: 'charts', rows: [{iiko_id, code, date_from, date_to, output_amount,
   technology, lines: [{ingredient_iiko_id, brutto, netto, output, sort}]}]}` — RPC сопоставляет
   ингредиенты по `items.iiko_id`; строки с неизвестным ингредиентом пропускаются и считаются
   (`skipped_lines`), карта без единой строки не создаётся (`skipped_charts`); пересечение
   дат между версиями iiko решается в пользу более поздней `dateFrom` (ранней ставится
   `date_to`).
4. Цены: `incoming_invoice/list` за `2026-01-01 … сегодня` по каждой из четырёх организаций,
   для каждой накладной `incoming_invoice/get` → строки `{product, price, date}`; последняя по
   дате цена на товар → `migrate {kind: 'costs', rows: [{iiko_id, price, date, source: 'iiko_invoice'}]}`;
   оценочная закупочная цена из карточки iiko (`estimatedPurchasePrice`) у Тандема не
   заполнена ни у одного товара (проверено по выгрузке 3 726 позиций) — запасного источника
   нет, товары без накладной остаются без цены до ручного ввода. RPC не перезаписывает
   `cost_source in ('manual','document')`.
5. Отчёт скрипта: карт получено / создано / обновлено / пропущено; строк / пропущено (имена
   первых 20 неизвестных ингредиентов); цен из накладных / оценочных / без цены.

Идемпотентность: карты — по `iiko_id`; цены — по `iiko_id` товара с правилом источников.

## 7. Бэк-офис

Раздел «Техкарты» (`js/office/charts.js`):
- список: поиск, фильтр по группе, переключатель «только без карты / без цены», колонки
  «Позиция · Тип · Карта (с даты) · Выход · Себестоимость · Цена · Фудкост %» с подсветкой выше
  порога; клик — редактор;
- редактор: шапка (выход и единица, действует с/по, технология), строки: ингредиент (поиск по
  номенклатуре, только активные), брутто/нетто/выход с автоподстановкой нетто = брутто и
  выход = нетто при вводе, потери % (считаются), цена, сумма; итог: себестоимость на выход и
  на единицу, цена продажи, наценка %, фудкост %; предупреждение «нет цены: …» со ссылками на
  карточки; кнопки «Сохранить», «Новая версия с даты…», «Версии» (переключение), «Удалить»
  (только для карт офиса без версий после);
- в карточке номенклатуры (`nomenclature.js`): поле «Учётная цена» для товаров, строка
  «Себестоимость на сегодня: … (нет цены у: …)» для блюд и полуфабрикатов, ссылка «Открыть
  техкарту»;
- отчёт «Фудкост меню» — вкладка внутри раздела: точка, дата, группа; таблица с сортировкой по
  фудкосту; кнопка «CSV» (текст отдаёт сервер, браузер сохраняет файл).
Доступ без права `edit` — только чтение (все поля `readonly/disabled`, кнопок правки нет).

## 8. Проверка

- Дымовой тест `office-smoke.mjs`, раздел `charts`: товар ZZ_TEST_мука (цена 100/кг),
  полуфабрикат ZZ_TEST_тесто (карта: мука 0,5/0,5/0,45; выход 0,45 кг) → себестоимость
  111,11 ₸/кг; блюдо ZZ_TEST_пирожок (тесто 0,08/0,08/0,07; выход 1 шт) → 8,89 ₸; товар без
  цены в строке → `cost null`, `missing` содержит код; цикл (тесто ← пирожок) → `validation`;
  новая версия с даты → две версии, расчёт на разные даты даёт разные числа; пересечение дат
  → `validation`; кладовщик: `chart_save` → `forbidden`, `charts_list` → `ok`; отчёт содержит
  тестовое блюдо с фудкостом. `tandem_test_cleanup` расширяется на `charts` и `chart_lines`.
- Перенос: сухой прогон печатает число кандидатов (около 1 638); боевой — счётчики; SQL-сверка:
  карт создано = получено − пропущено; число блюд с действующей картой; доля ингредиентов с ценой.
- Регресс точки Енешка: `charts` (экран «расход сырья») возвращает те же позиции и брутто, что
  до подпроекта, для 45 ранее загруженных карт (снимок до миграции, сравнение после).
- Финальное ревью ветки — как в подпроекте 1.

## 9. Критерии готовности

1. Технолог открывает любое блюдо из iiko и видит его карту с теми же числами, что в iiko.
2. Себестоимость считается не меньше чем для 80 % продаваемых блюд (остальные — со списком
   ингредиентов без цены); числа сходятся с ручным пересчётом на трёх контрольных блюдах.
3. Новая версия карты не меняет расчёт за прошлые даты.
4. Отчёт «Фудкост меню» открывается у собственницы и подсвечивает блюда выше порога.
5. Экран точки не изменился.
