# Webkassa API (онлайн-ККМ) - что известно для интеграции кассы

Источник: официальная Postman-коллекция Webkassa «Интеграторы_v4-2.0.3» и записка «ОФД 2.0.4. Новый обязательный
тег» из открытого репозитория драйвера OPOS для Webkassa (github.com/VitalyKravtsov2016/OposWebkassa, папка
doc/Webkassa). Там же: описание API General v35/v39 (PDF, скан), руководство по WK.LocalServer (локальный
сервер для работы без интернета), методичка по возвратам и маркировке. Актуальная документация и Postman -
в личном кабинете Webkassa после регистрации; перед выходом в бой сверить с ней.

## Доступ

- Тестовый стенд: `https://devkkm.webkassa.kz`. Регистрация в личном кабинете бесплатна: «Добавить кассу» -
  тестовая касса и API-KEY. Боевой доступ - после совместного теста с командой Webkassa.
- Каждый запрос - с заголовком `x-api-key: <API-KEY интегратора>`.
- `POST /api/v4/Authorize` `{ Login, Password }` - токен пользователя-кассира; дальше `Token` в теле запросов.
- Касса указывается заводским номером ЗНК: `CashboxUniqueNumber` (вида `SWK00033717`).

## Основные методы

| Метод | Что делает |
|---|---|
| `POST /api/v4/check` | фискализация чека: продажа, возврат продажи, покупка, возврат покупки |
| `POST /api/v4/MoneyOperation` | внесение (0) и изъятие (1) наличных |
| `POST /api/v4/XReport` | X-отчёт |
| `POST /api/v4/ZReport` | закрытие смены (Z-отчёт) |
| `POST /api/v4/Ticket/PrintFormat` | чек для печати в текстовом виде; `PaperKind`: 0 - 80 мм, 3 - 57(58) мм, 12/13 - A4 |
| `POST /api/v4/Check/HistoryByNumber`, `/Check/History` | чек по номеру, история чеков кассы |
| `POST /api/v4/ZReport/History`, `/ZReport/ByShiftNumber`, `/Reports/ControlTape` | история смен, контрольная лента |
| `POST /api/v4/Cashboxes`, `/Cashbox/ShiftHistory`, `/Employee/List` | кассы, смены, кассиры |
| `POST /api/v4/references/RefUnits` | справочник единиц измерения (`UnitCode`, 796 - штука) |
| `GET /api-history/v4/Ticket/GetTicketGroupUrl?ExternalLinkId=` | внешняя ссылка на чек |
| `POST /api/v4/Courier/UploadExternalOrder` | заказ для курьера (фискализация при доставке) |

## Чек `POST /api/v4/check`

- `OperationType`: 0 - покупка, 1 - возврат покупки, **2 - продажа**, **3 - возврат продажи**.
- `Positions[]`: `Count`, `Price`, `TaxPercent`, `Tax` (в тенге), `TaxType` (0 - без налога, НДС - см. пример
  в коллекции: 100), `PositionName`, `PositionCode`, `Discount`, `Markup`, `SectionCode`, `UnitCode`,
  `Mark`/`MarkList` (маркировка), **`GTIN`**, **`NTIN`** (штрихкод из Национального каталога товаров),
  `ProductId`, `WarehouseType`, **`PositionType`** (0 - товар, 1 - работа, 2 - услуга; обязателен с
  протоколом ОФД 2.0.4, записка от 26.08.2026).
- `TicketModifiers[]` - скидка (1) / наценка (2) на весь чек.
- `Payments[]`: `Sum`, `PaymentType` (0 - наличные, 1 - банковская карта, 4 - мобильный платёж); каждый тип
  не больше одного раза, смешанная оплата - несколькими записями.
- `ReturnBasisDetails` - только для возвратов, обязательно с протокола 2.0.3: `CheckNumber` (фискальный
  признак чека-основания), `DateTime`, `RegistrationNumber` (РНМ кассы), `Total`, `IsOffline`.
- `Change` (сдача; пусто - считает Webkassa), `RoundType` (0 - без округления, 2 - по позициям, 3 - по итогу).
- **`ExternalCheckNumber`** - номер операции нашей системы: идемпотентность при обрыве связи (повтор с тем же
  номером не пробивает чек дважды). У нас это `checks.uid`.
- `ExternalOrderNumber`, `CustomerEmail` (Webkassa сама отправит электронный чек), `CustomerPhone`,
  `CustomerXin`, `ExternalLinkId`.
- Сумма налогов в чеке с учётом скидок и наценок должна быть положительной.

## НТИН (с 01.07.2026)

Товары, купленные для перепродажи, уходят в чек с НТИН из Национального каталога товаров (nationalcatalog.kz);
свои блюда - без НТИН, если у юрлица нет ОКЭД производства. В iiko НТИН ставится штрихкодом с типом NTIN в
карточке товара - выгрузка iiko отдаёт его в `products[].barcodes[]` (тип штрихкода), так что проставленные
в iiko коды программа может забирать сама. Один товар - один НТИН (разные вкусы - разные позиции или
модификаторы).
