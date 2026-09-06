# Загрузка факта инвентаризации из файла (остатки iiko) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Одна задача.

**Goal:** В форме инвентаризации бэк-офиса — кнопка «Загрузить факт из файла»: разбор Excel-отчёта «Остатки на складах» из iiko (или любого листа с колонками название / код / количество), сопоставление позиций по коду iiko, коду, псевдониму и названию, заполнение факта; несопоставленные строки показываются списком. Так стартовые остатки переносятся из iiko одним документом, а последующая инвентаризация их корректирует.

**Architecture:** Разбор файла — в браузере (`vendor/xlsx.full.min.js`, уже в репозитории; грузится динамически как в `app.js`). Сопоставление — одним вызовом нового действия `items_lookup_list` раздела номенклатуры (пачка ключей → найденные позиции). Форма инвентаризации получает строки с `fact_qty` и обычным путём сохраняется/проводится.

## Global Constraints

- Бэкенд: одна миграция `db/migrations/0019_items_lookup.sql` — пересоздание `tandem.office_nomenclature` (актуальное тело из базы) с новым действием; имя действия `items_lookup_list` — попадает в раздел `nomenclature` по `item%` и в право `view` по `%\_list`, диспетчер не меняется.
- Контракт: `office_items_lookup_list {keys:[{code?:text, name?:text}]}` → `{ok, rows:[{i:int, item_code, name, unit_id, matched_by:'code'|'iiko_code'|'artikul'|'alias'|'name'}]}` — `i` — индекс ключа во входном массиве; несопоставленные ключи в `rows` отсутствуют; порядок сопоставления: `items.code = code` → `items.iiko_code = code` → `items.artikul = code` (в отчётах iiko колонка «Код» — это артикул, пятизначный с ведущими нулями, например `02580`) → `item_aliases.alias = name` → единственная активная позиция с `lower(name) = lower(trim(name))` (если таких несколько — не сопоставлять); только `active` позиции; до 2 000 ключей за вызов.
- **Формат файла iiko «Расширенная оборотно-сальдовая ведомость»** (образцы: `C:\Работа\Fractional CEO - клиенты\Тандем\Расширенная оборотно-сальдовая ведомость 21.08.2026 *.xlsx`, для чтения только): строки 0–4 — шапка (`За период: …`, `Склад: <список через запятую>`); строка 5 — группы колонок (`Товар`, `Остатки на начало`, `Приход`, `Продажи`, `Внутр. перемещения`, `Списания`, …, `Остатки на конец`); строка 6 — колонки (`Код`, `Наименование`, `Категория`, `Группа`, …, `Ед. изм.`, затем пары `Кол-во`/`Сумма с/н` под каждой группой); дальше строки товаров; последняя строка — итоги (пустые код и название). Разбор: найти строку колонок (есть `Код` и `Наименование`); строкой выше найти группу `/остатки на конец/i` и взять первую колонку `Кол-во` начиная с её индекса; если группы «на конец» нет — искать группу `/остат/i` и предупредить; из строки `Склад:` посчитать склады — если их больше одного, показать предупреждение «в файле N складов, остатки сводные — выгрузите отчёт по одному складу» и **не загружать** (кнопка «всё равно загрузить» — нет). Универсальный запасной разбор (лист с колонками название / код / количество без групп) — как ниже.
- Фронт: только `js/office/stock.js` (форма инвентаризации, черновик, выбранный склад) — кнопка рядом с «Заполнить позициями с остатком»; файл читается через `<input type=file accept=".xlsx,.xls">`; текст по-русски; данные в DOM только через `el()`.
- Разбор листа: берётся первый лист; строка заголовка — первая строка, где есть ячейка с /наимен|номенклат|товар|позиц/i **и** ячейка с /кол|остат/i; колонка кода — /^код|артикул/i (если нет — код не используется); колонка количества — первая с /остат|кол/i, не содержащая /сумм/i; колонка склада — /склад/i (если есть и в файле больше одного склада — показать выбор склада из файла, по умолчанию совпадающий по названию с выбранным складом документа). Если заголовок не найден — ошибка «Не нашёл строку заголовка с названием и количеством». Количество: запятая → точка; пустые и нечисловые — пропуск; строки с нулевым количеством — пропуск (в отчёт «пропущено нулевых N»).
- Результат загрузки: строки формы обновляются (существующая позиция — факт заменяется; новые добавляются), внизу — сводка «загружено N, не найдено M» и список ненайденных (название, код, количество) в `warnbox`; загрузка не сохраняет и не проводит документ — пользователь проверяет и жмёт «Сохранить черновик»/«Провести».
- Тест: `tools/office-smoke.mjs`, раздел `nomenclature` — проверки `items_lookup_list` по коду, коду iiko (у тестовой позиции задать `iiko_code`? нельзя через RPC — использовать реальную позицию с известным `iiko_code`: взять первую из `office_items_search {q:"мука"}` и её `code`; для проверки ветки `iiko_code` подойдёт та же позиция: у перенесённых `iiko_code = code`), по названию (тестовая `ZZ_TEST_мука` — единственная), по неизвестному ключу (отсутствует в `rows`); порядок `i` сохраняется.
- Файлы для браузерной проверки — сгенерировать скриптом на SheetJS (`XLSX.read(fs.readFileSync(...), {type:"buffer"})` / `XLSX.write(...)`; `require('./vendor/xlsx.full.min.js')` работает в Node): (а) `data/test_osv.xlsx` — точная копия структуры iiko: строки шапки, `Склад: ZZ_TEST_склад`, строка групп с «Остатки на конец» в колонке 29, строка колонок как в образце, 3 товарные строки (тестовая позиция по артикулу-«Коду», реальная позиция по артикулу, строка с неизвестным названием) с количеством в колонке 29 и мусором в колонке 7 («на начало»), итоговая строка с пустым кодом; (б) `data/test_osv_multi.xlsx` — то же, но `Склад: А, Б` → должно отказать; (в) `data/test_plain.xlsx` — простой лист `Номенклатура | Код | Количество`. `data/` в git не попадает. Настоящие образцы iiko в папке клиента можно читать для сверки структуры, но в репозиторий и в тестовые файлы их содержимое не копировать.
- Секреты — как всегда; тестовые данные `ZZ_TEST_`, очистка `tandem_test_cleanup`.
- Коммит: `git -c user.name="UM Group" -c user.email="umgroup.kz@gmail.com" commit`, хвост `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Задача 1 (единственная)

1. Тест в `office-smoke.mjs` (раздел `nomenclature`, после создания `ZZ_TEST_мука`):
```js
  r = await call("office_items_search", { token: t, q: "мука", active: true, page: 1 });
  const real = (r.rows || []).find((x) => /^\d+$/.test(x.code));
  const realGet = await call("office_item_get", { token: t, code: real.code });   // нужен артикул реальной позиции
  r = await call("office_items_lookup_list", { token: t, keys: [{ code }, { code: real.code }, { name: "ZZ_TEST_мука" }, { code: realGet.item.artikul }, { code: "нет-такого", name: "нет такого названия" }] });
  check("lookup: по коду, коду iiko, названию и артикулу; неизвестный отсутствует", r.ok && r.rows.length === 4
    && r.rows.find((x) => x.i === 0 && x.item_code === code && x.matched_by === "code")
    && r.rows.find((x) => x.i === 1 && x.item_code === real.code)
    && r.rows.find((x) => x.i === 2 && x.item_code === code && x.matched_by === "name")
    && r.rows.find((x) => x.i === 3 && x.item_code === real.code && x.matched_by === "artikul")
    && !r.rows.find((x) => x.i === 4), r.rows);
```
   Красный прогон → `unknown_action`.
2. Миграция 0019: в `tandem.office_nomenclature` новое действие:
```sql
  if action = 'items_lookup_list' then
    if jsonb_typeof(payload->'keys') <> 'array' or jsonb_array_length(payload->'keys') > 2000 then
      return tandem.err('validation', 'Передайте массив ключей (до 2000)');
    end if;
    return jsonb_build_object('ok', true, 'rows', (
      with k as (
        select (ord - 1)::int as i, nullif(btrim(x->>'code'),'') as code, nullif(btrim(x->>'name'),'') as name
        from jsonb_array_elements(payload->'keys') with ordinality t(x, ord)
      ),
      m as (
        select k.i, i.code as item_code, i.name, i.unit_id, 'code' as matched_by, 1 as pr
          from k join tandem.items i on i.active and k.code is not null and i.code = k.code
        union all
        select k.i, i.code, i.name, i.unit_id, 'iiko_code', 2
          from k join tandem.items i on i.active and k.code is not null and i.iiko_code = k.code
        union all
        select k.i, i.code, i.name, i.unit_id, 'artikul', 3
          from k join tandem.items i on i.active and k.code is not null and i.artikul = k.code
        union all
        select k.i, i.code, i.name, i.unit_id, 'alias', 4
          from k join tandem.item_aliases a on k.name is not null and a.alias = k.name
          join tandem.items i on i.code = a.item_code and i.active
        union all
        select k.i, i.code, i.name, i.unit_id, 'name', 5
          from k join lateral (
            select i.code, i.name, i.unit_id from tandem.items i
            where k.name is not null and i.active and lower(i.name) = lower(k.name)
          ) i on true
          where (select count(*) from tandem.items j where j.active and lower(j.name) = lower(k.name)) = 1
      ),
      best as (select distinct on (i) i, item_code, name, unit_id, matched_by from m order by i, pr)
      select coalesce(jsonb_agg(jsonb_build_object('i', i, 'item_code', item_code, 'name', name, 'unit_id', unit_id, 'matched_by', matched_by) order by i), '[]'::jsonb) from best));
  end if;
```
   Применить `apply_migration(name: "0019_items_lookup")`, зелёный прогон `nomenclature`, затем `all` (206 + 1).
3. Фронт `stock.js`, форма инвентаризации: кнопка «Загрузить факт из файла» → скрытый `input type=file` → `loadXlsx()` (динамический `<script src="vendor/xlsx.full.min.js">`, один раз) → `XLSX.read(ArrayBuffer)` → `sheet_to_json(ws, {header:1, defval:""})` → эвристика заголовка из ограничений → если колонка склада есть и складов > 1 — модалка с выбором → сбор `keys` (`code`, `name`) и `qty` → `items_lookup_list` → обновление `lines` (по `item_code`; сумма при дублях) → `drawLines()` → сводка и список ненайденных в `warnbox` под таблицей (с кнопкой «скрыть»). Ошибки разбора — в `err` формы.
4. Проверка: сгенерировать `data/test_ostatki.xlsx`; в браузере (администратор, склад `ZZ_TEST_склад`, новый документ «Инвентаризация») загрузить файл → две строки заполнены фактом, одна в «не найдено»; сохранить черновик → `doc_get` содержит `fact_qty`; провести (излишек на пустом складе) → остатки появились; очистка `tandem_test_cleanup`. Также проверить файл без колонки склада и файл без заголовка (ошибка).
5. README (раздел «Склад»: абзац про загрузку остатков из iiko и порядок «день X»), спецификация склада — уточнение. Коммит: «Склад: загрузка факта инвентаризации из файла остатков iiko».
