// Дымовой тест RPC бэк-офиса.
// Запуск: node tools/office-smoke.mjs <auth|nomenclature|stores|counteragents|users|charts|migrate|reimport|all>
// Переменные окружения: TANDEM_ADMIN_LOGIN (по умолчанию admin), TANDEM_ADMIN_PIN,
//   TANDEM_OWNER_PIN — код собственника; без него не идут разделы migrate/reimport и уборка.
// Создаёт сущности с префиксом ZZ_TEST_ (пользователи — zz_test_). В конце прогона раннер
// зовёт действие test_cleanup (RPC public.tandem_test_cleanup) и проверяет, что следов не осталось.
// TANDEM_API_URL — прогон по другому стенду (репетиция переезда: server/README.md).
const UCHET = process.env.TANDEM_API_URL || "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const section = process.argv[2] || "all";
let failed = 0, passed = 0;

// Служебные действия (перенос, уборка теста) с миграции 0029 требуют длинного ключа
// TANDEM_SERVICE_KEY — кода собственника для них больше недостаточно.
const SERVICE = new Set(["migrate", "test_cleanup", "sync_items", "sync_prices", "recalc_ranks", "set_packaging", "set_short_list"]);
export async function call(action, payload) {
  payload = payload || {};
  if (SERVICE.has(action) && !("service_key" in payload)) payload = { ...payload, service_key: process.env.TANDEM_SERVICE_KEY || "" };
  const r = await fetch(UCHET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: "bad_json", message: text.slice(0, 200) }; }
}

export function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? "  → " + JSON.stringify(detail).slice(0, 300) : "")); }
}

const SECTIONS = {};   // имя → async (ctx) => void; заполняется ниже по задачам
const ctx = { token: null, login: process.env.TANDEM_ADMIN_LOGIN || "admin", pin: process.env.TANDEM_ADMIN_PIN || "" };

SECTIONS.migrate = async () => {
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const G = "11111111-1111-4111-8111-111111111111";
  const S = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const I = "44444444-4444-4444-8444-444444444444";
  let r = await call("migrate", { pin, kind: "groups", rows: [{ id: G, name: "ZZ_TEST_группа", deleted: false, sort: 1 }] });
  check("groups: вставка", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "groups", rows: [{ id: G, name: "ZZ_TEST_группа2", deleted: true, sort: 1 }] });
  check("groups: повтор обновляет, не дублирует", r.ok && r.updated === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "stores", rows: [{ id: S, name: "ZZ_TEST_склад", organization_id: null, deleted: false }] });
  check("stores: вставка", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "counteragents", rows: [{ id: C, name: "ZZ_TEST_поставщик", kind: "supplier", bin: "123", phone: null, deleted: false }] });
  check("counteragents: вставка", r.ok && r.inserted === 1, r);
  // Имя нарочно не содержит «ZZ_TEST_мука» — этот текст ищет секция nomenclature,
  // и совпадение подстроки ломает её проверку total===1, когда секции идут вместе (all).
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_сырьё_миграция", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
  check("items: вставка нового", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_сырьё_миграция2", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
  check("items: повтор по iiko_id обновляет", r.ok && r.updated === 1 && r.inserted === 0, r);

  // Fix round 1 (ревью, замечание 2): дубли ключей внутри одной пачки не должны падать
  // сырой ошибкой Postgres. Оба id ниже — новые, ни один ещё не привязан ни к одному iiko_id,
  // поэтому обе строки метят в insert по одному и тому же code — именно эта гонка и роняла
  // функцию unique_violation до фикса. (I и 55555… из брифа сюда не годятся: I уже привязан
  // к ZZ_TEST_1 предыдущими проверками и это превращает тест в update чужой записи, а не в
  // конфликт двух insert.)
  const ID_DUP_A = "66666666-6666-4666-8666-666666666666";
  const ID_DUP_B = "77777777-7777-4777-8777-777777777777";
  r = await call("migrate", { pin, kind: "items", rows: [
    { id: ID_DUP_A, code: "ZZ_TEST_DUP", name: "ZZ_TEST_дубль_удалённая", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: true, price: null },
    { id: ID_DUP_B, code: "ZZ_TEST_DUP", name: "ZZ_TEST_дубль_живая", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null },
  ] });
  check("items: дубль code в пачке — не падает, побеждает живая", r.ok && r.inserted + r.updated === 1 && r.skipped === 1, r);

  r = await call("migrate", { pin, kind: "groups", rows: [
    { id: G, name: "ZZ_TEST_группа_дубль1", deleted: false, sort: 1 },
    { id: G, name: "ZZ_TEST_группа_дубль2", deleted: true, sort: 2 },
  ] });
  check("groups: дубль id в пачке считается один раз", r.ok && r.inserted + r.updated === 1, r);

  // техкарты: две версии одного блюда + строка с неизвестным ингредиентом + цены закупа
  const CH1 = "88888888-8888-4888-8888-888888888801", CH2 = "88888888-8888-4888-8888-888888888802";
  const I2 = "44444444-4444-4444-8444-444444444402";
  r = await call("migrate", { pin, kind: "items", rows: [
    { id: I2, code: "ZZ_TEST_2", name: "ZZ_TEST_пф_миграция", artikul: "", group_id: G, unit: "кг", type: "prepared", deleted: false, price: null }] });
  r = await call("migrate", { pin, kind: "chart_candidates", rows: [] });
  check("кандидаты: тестовый полуфабрикат в списке", r.ok && (r.rows || []).some((x) => x.code === "ZZ_TEST_2" && x.iiko_id === I2), { n: r.rows && r.rows.length });
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH1, code: "ZZ_TEST_2", date_from: "2026-01-01", date_to: null, output_amount: 1, technology: "смешать",
      lines: [{ ingredient_iiko_id: I, brutto: 2, netto: 2, output: 1.8, sort: 0 }, { ingredient_iiko_id: "99999999-9999-4999-8999-999999999999", brutto: 1, netto: 1, output: 1, sort: 1 }] },
    { iiko_id: CH2, code: "ZZ_TEST_2", date_from: "2026-05-01", date_to: null, output_amount: 1, technology: null,
      lines: [{ ingredient_iiko_id: I, brutto: 3, netto: 3, output: 2.7, sort: 0 }] },
  ] });
  check("карты: 2 вставлены, 1 строка пропущена, неизвестный ингредиент назван", r.ok && r.inserted === 2 && r.skipped_lines === 1 && Array.isArray(r.unknown) && r.unknown.length === 1, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH2, code: "ZZ_TEST_2", date_from: "2026-05-01", date_to: null, output_amount: 1.5, technology: null,
      lines: [{ ingredient_iiko_id: I, brutto: 3, netto: 3, output: 2.7, sort: 0 }] } ] });
  check("карты: повтор обновляет, не дублирует", r.ok && r.updated === 1 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: "88888888-8888-4888-8888-888888888803", code: "ZZ_TEST_2", date_from: "2026-03-01", date_to: null, output_amount: 1,
      lines: [{ ingredient_iiko_id: "99999999-9999-4999-8999-999999999999", brutto: 1, netto: 1, output: 1, sort: 0 }] } ] });
  check("карта без единой известной строки пропущена", r.ok && r.skipped === 1 && r.inserted === 0, r);

  // Fix round 1: версии приходят не по порядку, повторный прогон ничего не меняет,
  // а совпадение даты начала не затирает уже записанную карту.
  // Отдельная позиция ZZ_TEST_3: даты на ZZ_TEST_2 уже заняты CH1/CH2 и пересеклись бы.
  const I3 = "44444444-4444-4444-8444-444444444403";
  const CH4 = "88888888-8888-4888-8888-888888888811", CH5 = "88888888-8888-4888-8888-888888888812";
  const CH6 = "88888888-8888-4888-8888-888888888821", CH7 = "88888888-8888-4888-8888-888888888822";
  await call("migrate", { pin, kind: "items", rows: [
    { id: I3, code: "ZZ_TEST_3", name: "ZZ_TEST_блюдо_миграция", artikul: "", group_id: G, unit: "кг", type: "dish", deleted: false, price: null }] });
  const pack = [
    { iiko_id: CH4, code: "ZZ_TEST_3", date_from: "2026-05-01", date_to: null, output_amount: 1,
      lines: [{ ingredient_iiko_id: I, brutto: 1, netto: 1, output: 1, sort: 0 }] },
    { iiko_id: CH5, code: "ZZ_TEST_3", date_from: "2026-01-01", date_to: "2026-12-31", output_amount: 1,
      lines: [{ ingredient_iiko_id: I, brutto: 1, netto: 1, output: 1, sort: 0 }] },
  ];
  r = await call("migrate", { pin, kind: "charts", rows: pack });
  check("карты: поздняя версия пришла раньше ранней — вставлены обе", r.ok && r.inserted === 2 && r.skipped === 0, r);
  // Что ранняя версия при этом укоротилась до 2026-04-30, тест не видит: вид charts дат не
  // возвращает, а office_chart_get требует токен бэк-офиса, которого в разделе migrate нет
  // (он идёт без auth). Даты проверены вручную через SQL, результат — в task-4-report.md.
  r = await call("migrate", { pin, kind: "charts", rows: pack });
  check("карты: повтор пачки только обновляет", r.ok && r.updated === 2 && r.inserted === 0, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH6, code: "ZZ_TEST_3", date_from: "2027-01-01", date_to: null, output_amount: 1,
      lines: [{ ingredient_iiko_id: I, brutto: 1, netto: 1, output: 1, sort: 0 }] } ] });
  check("карты: следующая версия вставлена", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "charts", rows: [
    { iiko_id: CH7, code: "ZZ_TEST_3", date_from: "2027-01-01", date_to: null, output_amount: 1,
      lines: [{ ingredient_iiko_id: I, brutto: 1, netto: 1, output: 1, sort: 0 }] } ] });
  check("карты: дубль даты начала не удаляет уже записанную", r.ok && r.skipped === 1 && r.inserted === 0
        && Array.isArray(r.errors) && r.errors.length === 1, r);
  // Тот же путь для карты офиса (source='office') проверен вручную: подменой source у CH6
  // через SQL и повторной подачей CH7 — карта офиса осталась на месте. См. task-4-report.md.

  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 77.5, date: "2026-07-15", source: "iiko_invoice" }] });
  check("цены: обновлена 1", r.ok && r.updated === 1, r);
  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 1, date: "2026-07-16", source: "iiko_invoice" }] });
  check("цены: повтор из накладной обновляет", r.ok && r.updated === 1, r);
  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 0, date: "2026-07-17", source: "iiko_invoice" }] });
  check("цены: неположительная цена отброшена", r.ok && r.updated === 0, r);
  r = await call("migrate", { pin, kind: "costs", rows: [{ iiko_id: I, price: 2, date: "2026-07-18", source: "document" }] });
  check("цены: чужой source во входе не мешает обновлению", r.ok && r.updated === 1, r);
  // Что записался именно cost_source='iiko_invoice', а не 'document' (иначе следующий перенос
  // сам себя заблокировал бы), видно только в базе — проверено SQL, см. task-4-report.md.

  // I1: карту, правленную в бэк-офисе, перенос обязан пропускать с пометкой «правлена в офисе».
  // Автоматизировать здесь нельзя: карту с source='iiko' заводит только этот раздел (код
  // собственника, без токена), а сделать её офисной может только office_chart_save — ему нужен
  // токен бэк-офиса, которого в разделе migrate нет, и разделы независимы. Обе стороны проверены
  // вручную одноразовым скриптом (перенос → правка офисом → повторный перенос) — см.
  // .superpowers/sdd/2026-09-05-uchet-charts/fix-wave-report.md. Автоматизируемая половина —
  // «сохранение из офиса ставит source=office» — стоит в разделе charts.

  // I2: экран точки («расход сырья») читает те же charts/chart_lines. tandem_charts пускает
  // по коду собственника, поэтому проверка живёт здесь, а не в разделе с токеном.
  r = await call("charts", { pin, point_id: "eneshka" });
  const keys = Object.keys(r.charts || {});
  const first = keys.length ? r.charts[keys[0]] : [];
  check("экран точки: расход сырья по картам",
    r.ok && keys.length > 100 && Array.isArray(first) && first.length > 0
      && typeof first[0].n === "string" && Number(first[0].a) > 0,
    { n: keys.length, first: first[0] });

  r = await call("migrate", { service_key: "wrong", kind: "groups", rows: [] });
  check("чужой код — отказ", r.ok === false, r);
};

SECTIONS.auth = async (ctx) => {
  let r = await call("office_login", { login: ctx.login, pin: "нет-такого" });
  check("неверный PIN — unauthorized", r.ok === false && r.error === "unauthorized", r);
  r = await call("office_login", { login: ctx.login, pin: ctx.pin });
  check("вход администратора", r.ok && r.token && r.user && r.user.role === "admin", r);
  ctx.token = r.token;
  check("права пришли списком", Array.isArray(r.permissions) && r.permissions.includes("users:edit"), r.permissions);
  r = await call("office_me", { token: ctx.token });
  check("me по токену", r.ok && r.user.login === ctx.login, r);
  r = await call("office_me", { token: "мусор" });
  check("me по чужому токену — unauthorized", r.ok === false && r.error === "unauthorized", r);
  r = await call("office_change_pin", { token: ctx.token, pin: "12" });
  check("короткий PIN — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_change_pin", { token: ctx.token, pin: ctx.pin });
  check("смена PIN на тот же — ok, must_change снят", r.ok && r.must_change_pin === false, r);
  r = await call("office_nonsense", { token: ctx.token });
  check("неизвестное действие", r.ok === false && r.error === "unknown_action", r);
  r = await call("office_logout", { token: ctx.token });
  check("выход", r.ok, r);
  r = await call("office_me", { token: ctx.token });
  check("после выхода токен мёртв", r.ok === false && r.error === "unauthorized", r);
  // и снова входим — токен нужен следующим разделам
  r = await call("office_login", { login: ctx.login, pin: ctx.pin });
  ctx.token = r.token;
};

SECTIONS.nomenclature = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_groups_list", { token: t });
  check("группы: список", r.ok && Array.isArray(r.groups) && r.groups.length > 50, r);
  r = await call("office_group_save", { token: t, name: "ZZ_TEST_группа" });
  check("группа: создание", r.ok && r.id, r);
  const gid = r.id;
  r = await call("office_group_save", { token: t, id: gid, name: "ZZ_TEST_группа переим.", active: true });
  check("группа: переименование", r.ok, r);
  r = await call("office_group_save", { token: t, name: "" });
  check("группа: пустое имя — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг", group_id: gid, artikul: "ZZ1" });
  check("позиция: создание, код выдан", r.ok && /^\d+$/.test(r.code), r);
  const code = r.code;
  r = await call("office_items_search", { token: t, q: "ZZ_TEST_мука" });
  check("поиск по имени", r.ok && r.total === 1 && r.rows[0].code === code && r.rows[0].group_name.startsWith("ZZ_TEST"), r);
  r = await call("office_items_search", { token: t, q: "ZZ1" });
  check("поиск по артикулу", r.ok && r.total === 1, r);
  r = await call("office_items_search", { token: t, page: 1 });
  check("страница 200", r.ok && r.rows.length === 200 && r.pages >= 15, { total: r.total, pages: r.pages });
  r = await call("office_item_save", { token: t, code, name: "ZZ_TEST_мука в/с", for_sale: true, price: 350 });
  check("позиция: правка", r.ok, r);
  r = await call("office_item_save", { token: t, code, name: "ZZ_TEST_мука в/с", unit_id: "", item_type: "" });
  check("правка с пустыми unit_id/item_type — поля не тронуты", r.ok, r);
  r = await call("office_item_get", { token: t, code });
  check("после правки единица и тип прежние", r.ok && r.item.unit_id === "кг" && r.item.item_type === "goods", r.item);
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_x", item_type: "goods", unit_id: "" });
  check("создание без единицы — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_item_prices_save", { token: t, code, prices: [{ point_id: "eneshka", price: 400 }] });
  check("цена точки: сохранение", r.ok, r);
  r = await call("office_item_get", { token: t, code });
  const ene = (r.points || []).find((p) => p.point_id === "eneshka");
  check("карточка: имя, цена точки", r.ok && r.item.name === "ZZ_TEST_мука в/с" && ene && Number(ene.price) === 400, r);
  r = await call("office_item_save", { token: t, code, cost_price: 55 });
  r = await call("office_item_get", { token: t, code });
  check("учётная цена товара в карточке", r.ok && Number(r.item.cost_price) === 55 && r.item.cost_source === "manual" && r.item.cost_date, r.item);
  r = await call("office_item_prices_save", { token: t, code, prices: [{ point_id: "eneshka", price: null }] });
  r = await call("office_item_get", { token: t, code });
  check("цена точки: снята", r.ok && (r.points.find((p) => p.point_id === "eneshka").price === null), r.points);
  // Прейскурант кнопкой (миграция 0036): пара по артикулу ZZ1, чужой артикул — в «без пары», служебная точка — отказ.
  r = await call("office_item_prices_import", { token: t, rows: [{ pt: "eneshka", a: "ZZ1", p: 777 }, { pt: "eneshka", a: "ZZ_нет_артикула", p: 5 }] });
  check("прейскурант: цена по артикулу загружена, чужой артикул посчитан", r.ok && r.loaded === 1 && r.unmatched === 1 && r.unmatched_sample.includes("ZZ_нет_артикула"), r);
  r = await call("office_item_get", { token: t, code });
  check("прейскурант: цена точки в карточке", r.ok && Number((r.points.find((p) => p.point_id === "eneshka") || {}).price) === 777, r.points);
  r = await call("office_item_prices_import", { token: t, rows: [{ pt: "zz_test", a: "ZZ1", p: 1 }] });
  check("прейскурант: служебная точка — отказ", r.ok === false && r.error === "validation", r);
  await call("office_item_prices_save", { token: t, code, prices: [{ point_id: "eneshka", price: null }] });
  r = await call("office_item_get", { token: t, code: "нет-такого" });
  check("карточка: not_found", r.ok === false && r.error === "not_found", r);
  r = await call("office_item_save", { token: t, name: "x", item_type: "фигня", unit_id: "кг" });
  check("тип не из списка — validation", r.ok === false && r.error === "validation", r);

  // Сопоставление пачки ключей — им пользуется загрузка факта инвентаризации из файла iiko.
  // Тестовую позицию из выборки исключаем: её код тоже числовой, а в сортировке по имени
  // латинское «ZZ_TEST_мука в/с» встаёт впереди кириллической «Муки», и «реальной» позицией
  // оказалась бы она сама — проверка артикула выродилась бы в повтор проверки по коду.
  r = await call("office_items_search", { token: t, q: "мука", active: true, page: 1 });
  const real = (r.rows || []).find((x) => /^\d+$/.test(x.code) && !/^ZZ_TEST/.test(x.name) && x.artikul);
  check("нашлась перенесённая позиция с артикулом", !!real, { n: r.rows && r.rows.length });
  const realGet = await call("office_item_get", { token: t, code: real.code });
  r = await call("office_items_lookup_list", { token: t, keys: [
    { code }, { code: real.code }, { name: "ZZ_TEST_мука в/с" },
    { code: realGet.item.artikul }, { code: "нет-такого", name: "нет такого названия" }] });
  check("lookup: по коду, коду iiko, названию и артикулу; неизвестный отсутствует", r.ok && r.rows.length === 4
    && r.rows.find((x) => x.i === 0 && x.item_code === code && x.matched_by === "code")
    && r.rows.find((x) => x.i === 1 && x.item_code === real.code)
    && r.rows.find((x) => x.i === 2 && x.item_code === code && x.matched_by === "name")
    && r.rows.find((x) => x.i === 3 && x.item_code === real.code && x.matched_by === "artikul")
    && !r.rows.find((x) => x.i === 4), r.rows);
  r = await call("office_items_lookup_list", { token: t, keys: "не массив" });
  check("lookup: не массив — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_items_lookup_list", { token: t, keys: [] });
  check("lookup: пустой массив — пустой ответ", r.ok && Array.isArray(r.rows) && r.rows.length === 0, r);
};

SECTIONS.stores = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_stores_list", { token: t });
  check("склады: список с точками", r.ok && r.stores.length >= 27 && Array.isArray(r.points) && r.points.length >= 5, { n: r.stores && r.stores.length });
  // Раздел трогает склад по умолчанию точки «Аян» — запоминаем, чтобы вернуть как было.
  const tpWas = (r.stores || []).find((x) => x.point_id === "zz_test" && x.is_default === true) || null;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад", point_id: "zz_test", is_default: true });
  check("склад: создание с привязкой и по умолчанию", r.ok && r.id, r);
  const id = r.id;
  r = await call("office_stores_list", { token: t });
  const s = r.stores.find((x) => x.id === id);
  check("склад: виден как по умолчанию у тестовой точки", s && s.point_id === "zz_test" && s.is_default === true, s);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: null, is_default: false, active: false });
  check("склад: отвязка и деактивация", r.ok, r);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: "zz_test", active: false, is_default: true });
  check("выключенный склад не становится складом по умолчанию", r.ok, r);
  r = await call("office_stores_list", { token: t });
  const s2 = r.stores.find((x) => x.id === id);
  check("у тестовой точки нет склада по умолчанию после этого", s2 && s2.is_default !== true && !r.stores.some((x) => x.point_id === "zz_test" && x.is_default === true), s2);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: "нет-такой" });
  check("склад: чужая точка — validation", r.ok === false && r.error === "validation", r);
  // возвращаем точке её прежний склад по умолчанию
  if (tpWas) {
    await call("office_store_save", { token: t, id: tpWas.id, name: tpWas.name,
      point_id: "zz_test", active: tpWas.active !== false, is_default: true });
  }
  r = await call("office_stores_list", { token: t });
  const tpNow = (r.stores || []).find((x) => x.point_id === "zz_test" && x.is_default === true) || null;
  check("склад по умолчанию точки «Аян» — как до теста",
    (tpNow && tpNow.id) === (tpWas && tpWas.id) || (!tpNow && !tpWas),
    { было: tpWas && tpWas.id, стало: tpNow && tpNow.id });
};

// Раздел «Точки» (миграция 0035). Настоящие точки тест не меняет: сохраняет учебную точку теми же
// значениями и проверяет отказы. Служебные zz_* в списке не видны и не правятся.
SECTIONS.points = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_store_points_list", { token: t });
  check("точки: список, группы меню, юрлица", r.ok && r.points.length > 0 && r.categories.length > 0 && Array.isArray(r.legal_entities), r.ok ? r.points.length : r);
  check("точки: служебные zz_* и коды входа не отдаются", r.ok && !r.points.some((x) => x.id.startsWith("zz_")) && r.points.every((x) => !("pin" in x) && "has_pin" in x), r.points && r.points[0]);
  const u = (r.points || []).find((x) => x.id === "ucheb");
  if (!u) { check("точки: учебная точка есть", false, null); return; }
  const same = { id: u.id, name: u.name, mode: u.mode, legal_entity: u.legal_entity || "", active: u.active, item_categories: u.item_categories };
  r = await call("office_store_point_save", { token: t, ...same });
  const again = ((await call("office_store_points_list", { token: t })).points || []).find((x) => x.id === "ucheb");
  check("точки: сохранение теми же значениями ничего не меняет", r.ok && again && again.name === u.name && again.mode === u.mode
    && JSON.stringify(again.item_categories) === JSON.stringify(u.item_categories), { r, again });
  r = await call("office_store_point_save", { token: t, ...same, mode: "cash_register" });
  check("точки: неизвестный режим — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_store_point_save", { token: t, ...same, pin: "12ab" });
  check("точки: код не из цифр — отказ", r.ok === false && r.error === "validation", r);
  const owner = process.env.TANDEM_OWNER_PIN || "";
  if (owner) {
    r = await call("office_store_point_save", { token: t, ...same, pin: owner });
    check("точки: код собственника точке не дать", r.ok === false && /занят/.test(r.message || ""), r);
  }
  r = await call("office_store_point_save", { token: t, id: "zz_test", name: "x", mode: "position" });
  check("точки: служебную точку не правят", r.ok === false && r.error === "validation", r);
  r = await call("office_store_point_save", { token: t, id: "Новая точка", name: "x", mode: "position", pin: "98765432" });
  check("точки: код новой точки только латиницей", r.ok === false && r.error === "validation", r);
};

SECTIONS.counteragents = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_ИП Ромашка", kind: "supplier", bin: "990101300123", phone: "+7 700 000 00 00" });
  check("контрагент: создание", r.ok && r.id, r);
  const id = r.id;
  r = await call("office_counteragents_list", { token: t, q: "Ромашка" });
  check("контрагент: поиск", r.ok && r.total === 1 && r.rows[0].id === id && r.rows[0].kind === "supplier", r);
  r = await call("office_counteragents_list", { token: t, kind: "supplier" });
  check("контрагент: фильтр по виду", r.ok && r.total >= 175, { total: r.total });
  r = await call("office_counteragent_save", { token: t, id, name: "ZZ_TEST_ИП Ромашка", kind: "customer", active: false });
  check("контрагент: правка вида и деактивация", r.ok, r);
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_x", kind: "бред" });
  check("контрагент: вид не из списка — validation", r.ok === false && r.error === "validation", r);
};

SECTIONS.users = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_users_list", { token: t });
  check("пользователи: список", r.ok && r.users.some((u) => u.login === "admin") && r.roles.length === 5, r);
  const me = r.users.find((u) => u.login === ctx.login);
  r = await call("office_user_save", { token: t, id: me.id, login: me.login, name: me.name, role: "owner" });
  check("последнего администратора нельзя понизить — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: "4321" });
  check("пользователь: создание", r.ok && r.id, r);
  const uid = r.id;
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "дубль", role: "storekeeper", pin: "4321" });
  check("дубль логина — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_user_save", { token: t, login: "zz_test_x", name: "x", role: "storekeeper" });
  check("без PIN при создании — validation", r.ok === false && r.error === "validation", r);
  // права кладовщика
  r = await call("office_login", { login: "zz_test_sklad", pin: "4321" });
  check("кладовщик входит", r.ok && r.user.role === "storekeeper" && r.must_change_pin === true, r);
  const st = r.token;
  r = await call("office_change_pin", { token: st, pin: "4321" });
  check("кладовщик снял временный PIN", r.ok && r.must_change_pin === false, r);
  r = await call("office_items_search", { token: st, q: "мука" });
  check("кладовщик видит номенклатуру", r.ok, r);
  r = await call("office_item_save", { token: st, name: "ZZ_TEST_нельзя", item_type: "goods", unit_id: "кг" });
  check("кладовщик не правит номенклатуру — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_users_list", { token: st });
  check("кладовщик не видит пользователей — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_user_reset_pin", { token: t, id: uid, pin: "5555" });
  check("сброс PIN администратором", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  check("вход с новым PIN", r.ok, r);
  // Блокировка не выдаёт себя чужому: пока логин заблокирован, неверный PIN получает тот же
  // ответ, что и всегда; о блокировке узнаёт только тот, кто знает PIN.
  for (let i = 0; i < 5; i++) r = await call("office_login", { login: "zz_test_sklad", pin: "0000" });
  r = await call("office_login", { login: "zz_test_sklad", pin: "0000" });
  check("заблокирован, неверный PIN — обычный ответ", r.ok === false && r.error === "unauthorized" && /^Неверный логин или PIN/.test(r.message), r);
  const lockedWrong = r.message;
  const nobody = await call("office_login", { login: "zz_test_nobody", pin: "0000" });
  check("несуществующий логин — тот же ответ", nobody.ok === false && nobody.message === r.message, nobody);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  // Ответ на верный PIN во время блокировки обязан совпадать с ответом на неверный:
  // иначе перебор узнаёт PIN по тексту ответа, не дожидаясь конца блокировки.
  check("заблокирован, верный PIN — тот же ответ, что на неверный", r.ok === false && r.error === "unauthorized" && r.message === lockedWrong, r);
  r = await call("office_user_reset_pin", { token: t, id: uid, pin: "5555" });
  check("сброс PIN снимает блокировку", r.ok, r);
  r = await call("office_user_save", { token: t, id: uid, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", active: false });
  check("деактивация", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  check("выключенный не входит", r.ok === false && r.error === "unauthorized", r);

  // --- матрица ролей: каждая роль видит ровно то, что записано в role_permissions ---
  // Ожидания взяты из спецификации 3.5 и обязаны совпасть с содержимым таблицы.
  // Раздел charts добавлен миграцией 0010 (техкарты): технолог правит, бухгалтер только смотрит.
  // Миграция 0015 (склад) добавила раздел stock всем ролям и права по типам документов
  // doc:<тип>: бухгалтеру только приход, технологу только производство.
  const MATRIX = {
    zz_test_owner: { role: "owner", name: "ZZ_TEST_Собственник",
      perms: ["charts:edit", "charts:view", "counteragents:edit", "counteragents:view",
        "doc:inventory:edit", "doc:inventory:view", "doc:invoice_in:edit", "doc:invoice_in:view",
        "doc:production:edit", "doc:production:view", "doc:transfer:edit", "doc:transfer:view",
        "doc:sale:edit", "doc:sale:view", "doc:writeoff:edit", "doc:writeoff:view",
        "nomenclature:edit", "nomenclature:view", "stock:edit", "stock:view", "stores:edit", "stores:view"] },
    zz_test_buh: { role: "accountant", name: "ZZ_TEST_Бухгалтер",
      perms: ["charts:view", "counteragents:edit", "counteragents:view",
        "doc:invoice_in:edit", "doc:invoice_in:view", "doc:sale:edit", "doc:sale:view", "nomenclature:view", "stock:edit", "stock:view", "stores:view"] },
    zz_test_tech: { role: "technologist", name: "ZZ_TEST_Технолог",
      perms: ["charts:edit", "charts:view", "counteragents:view",
        "doc:production:edit", "doc:production:view", "doc:sale:view", "nomenclature:edit", "nomenclature:view",
        "stock:edit", "stock:view", "stores:view"] },
  };
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.slice().sort().join("|") === b.slice().sort().join("|");
  const ids = {};

  for (const [login, want] of Object.entries(MATRIX)) {
    r = await call("office_user_save", { token: t, login, name: want.name, role: want.role, pin: "4321" });
    check(`${want.role}: создан`, r.ok && r.id, r);
    ids[login] = r.id;
    r = await call("office_login", { login, pin: "4321" });
    check(`${want.role}: входит с временным PIN`, r.ok && r.user.role === want.role && r.must_change_pin === true, r);
    const tok = r.token;
    if (login === "zz_test_owner") {
      // I2: до смены временного PIN разделы закрыты на сервере, а не только на фронте
      const f = await call("office_items_search", { token: tok, q: "мука" });
      check("временный PIN: раздел закрыт до смены",
        f.ok === false && f.error === "forbidden" && /временный PIN/.test(f.message || ""), f);
      const f2 = await call("office_me", { token: tok });
      check("временный PIN: me по-прежнему отвечает", f2.ok === true && f2.must_change_pin === true, f2);
    }
    r = await call("office_change_pin", { token: tok, pin: "4321" });
    check(`${want.role}: временный PIN снят`, r.ok && r.must_change_pin === false, r);
    r = await call("office_me", { token: tok });
    check(`${want.role}: права ровно по матрице`, same(r.permissions, want.perms), r.permissions);
    r = await call("office_users_list", { token: tok });
    check(`${want.role}: пользователей не видит`, r.ok === false && r.error === "forbidden", r);
  }
  // выборочно проверяем, что право edit действительно работает и действительно отсутствует
  r = await call("office_login", { login: "zz_test_buh", pin: "4321" });
  const buh = r.token;
  r = await call("office_item_save", { token: buh, name: "ZZ_TEST_нельзя_буху", item_type: "goods", unit_id: "кг" });
  check("бухгалтер не правит номенклатуру — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_counteragent_save", { token: buh, name: "ZZ_TEST_Поставщик буха", kind: "supplier" });
  check("бухгалтер правит контрагентов", r.ok && r.id, r);

  // --- C1: пять неверных PIN подряд запирают логин на 15 минут ---
  for (let i = 1; i <= 5; i++) {
    r = await call("office_login", { login: "zz_test_owner", pin: "0000" });
    check(`лок: попытка ${i} — unauthorized`, r.ok === false && r.error === "unauthorized", r);
  }
  r = await call("office_login", { login: "zz_test_owner", pin: "4321" });
  check("лок: шестая попытка с верным PIN отбита",
    r.ok === false && r.error === "unauthorized" && /15 минут/.test(r.message || ""), r);

  // сброс PIN администратором обязан снимать и сам лок, не только менять хэш
  r = await call("office_user_reset_pin", { token: t, id: ids.zz_test_owner, pin: "4321" });
  check("сброс PIN снимает блокировку", r.ok, r);
  r = await call("office_login", { login: "zz_test_owner", pin: "4321" });
  check("после сброса вход работает", r.ok, r);
  // лок снимается вместе с пользователем — его удалит test_cleanup в конце прогона
};

SECTIONS.reimport = async (ctx) => {
  // I7: повторный перенос из iiko не затирает позицию, правленную в бэк-офисе.
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const ID = "99999999-9999-4999-8999-999999999999";
  const row = { id: ID, code: "ZZ_TEST_RE", name: "ZZ_TEST_переимпорт", artikul: "", group_id: null, unit: "кг", type: "goods", deleted: false, price: null };
  let r = await call("migrate", { pin, kind: "items", rows: [row] });
  check("переимпорт: позиция заведена переносом", r.ok && r.inserted === 1, r);
  r = await call("office_group_save", { token: t, name: "ZZ_TEST_группа переимпорта" });
  check("reimport: тестовая группа создана", r.ok && r.id, r);
  const gid = r.id;
  r = await call("office_item_save", { token: t, code: "ZZ_TEST_RE", name: "ZZ_TEST_переимпорт правлено", group_id: gid });
  check("переимпорт: правка в бэк-офисе", r.ok, r);
  r = await call("migrate", { pin, kind: "items", rows: [row] });
  check("переимпорт: правленная позиция пропущена", r.ok && r.updated === 0 && r.inserted === 0 && r.skipped === 1, r);
  r = await call("office_items_search", { token: t, q: "ZZ_TEST_переимпорт" });
  check("переимпорт: имя из бэк-офиса уцелело",
    r.ok && r.total === 1 && r.rows[0].name === "ZZ_TEST_переимпорт правлено" && r.rows[0].group_id === gid, r.rows);
};

SECTIONS.charts = async (ctx) => {
  const t = ctx.token;
  const mk = async (p) => { const r = await call("office_item_save", { token: t, ...p }); check("создана " + p.name, r.ok && r.code, r); return r.code; };
  const muka = await mk({ name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг", cost_price: 100 });
  const sol  = await mk({ name: "ZZ_TEST_соль", item_type: "goods", unit_id: "кг" });
  const testo = await mk({ name: "ZZ_TEST_тесто", item_type: "prepared", unit_id: "кг" });
  const pir  = await mk({ name: "ZZ_TEST_пирожок", item_type: "dish", unit_id: "шт", price: 50, for_sale: true });
  let r = await call("office_item_get", { token: t, code: muka });
  check("учётная цена сохранена, источник manual", r.ok && Number(r.item.cost_price) === 100 && r.item.cost_source === "manual", r.item);
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }] });
  check("карта теста сохранена", r.ok && r.id, r);
  const testoChart = r.id;
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-01-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.08, netto: 0.08, output: 0.07 }] });
  check("карта пирожка сохранена", r.ok && r.id, r);
  const pirChart = r.id;
  r = await call("office_chart_get", { token: t, code: pir });
  check("себестоимость пирожка 8.8889", r.ok && Number(r.cost) === 8.8889 && r.chart.lines.length === 1 && Number(r.chart.lines[0].ing_cost) === 111.1111, { cost: r.cost, line: r.chart && r.chart.lines[0] });
  // I1: всё, что сохранено из бэк-офиса, помечено source='office' — на карте из iiko эта
  // пометка и есть отсечка от повторного переноса (см. комментарий в разделе migrate).
  check("карта из офиса помечена source=office", r.ok && r.chart && r.chart.source === "office", r.chart);
  check("потери в строке посчитаны", r.ok && Number(r.chart.lines[0].hot_loss_pct) === 12.5 && Number(r.chart.lines[0].cold_loss_pct) === 0, r.chart && r.chart.lines[0]);
  r = await call("office_chart_get", { token: t, code: pir, id: testoChart });
  check("chart_get с чужим id — not_found", r.ok === false && r.error === "not_found", r);
  r = await call("office_item_cost_get", { token: t, code: testo });
  check("item_cost_get теста 111.1111", r.ok && Number(r.cost) === 111.1111, r);
  // ингредиент без цены → cost null, missing
  r = await call("office_chart_save", { token: t, id: testoChart, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }, { ingredient_code: sol, brutto: 0.01, netto: 0.01, output: 0.01 }] });
  check("карта теста дополнена солью", r.ok, r);
  r = await call("office_chart_get", { token: t, code: pir });
  check("без цены соли себестоимость null, missing содержит соль", r.ok && r.cost === null && r.missing.includes(sol) && r.partial !== null, { cost: r.cost, missing: r.missing });
  // цикл: в тесто добавить пирожок
  r = await call("office_chart_save", { token: t, id: testoChart, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }, { ingredient_code: pir, brutto: 1, netto: 1, output: 1 }] });
  check("цикл отклонён — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45,
    lines: [{ ingredient_code: testo, brutto: 1, netto: 1, output: 1 }] });
  check("блюдо само в себе — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: muka, date_from: "2026-01-01", output_amount: 1, lines: [{ ingredient_code: sol, brutto: 1, netto: 1, output: 1 }] });
  check("карта у товара — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-01-01", output_amount: 1, lines: [] });
  check("карта без строк — validation", r.ok === false && r.error === "validation", r);
  // с id своей же карты — иначе перекрытие дат с самой собой скрыло бы проверку строки
  r = await call("office_chart_save", { token: t, id: pirChart, code: pir, date_from: "2026-01-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.05, netto: 0.08, output: 0.07 }] });
  check("нетто больше брутто — validation", r.ok === false && r.error === "validation", r);
  // пересечение дат: вторая карта пирожка с 2026-03-01 при открытой первой
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2026-03-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.09 }] });
  check("пересечение дат — validation", r.ok === false && r.error === "validation", r);
  // новая версия с даты
  r = await call("office_chart_new_version", { token: t, code: pir, date_from: "2026-06-01" });
  check("новая версия создана", r.ok && r.id, r);
  const v2 = r.id;
  r = await call("office_chart_save", { token: t, id: v2, code: pir, date_from: "2026-06-01", output_amount: 1,
    lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.09 }] });
  check("версия 2 изменена", r.ok, r);
  await call("office_item_save", { token: t, code: sol, cost_price: 20 });
  r = await call("office_chart_get", { token: t, code: pir, date: "2026-02-01" });
  const c1 = r.cost;
  r = await call("office_chart_get", { token: t, code: pir, date: "2026-07-01" });
  check("две версии: расчёт на разные даты различается", c1 !== null && r.cost !== null && Number(c1) < Number(r.cost) && r.versions.length === 2, { c1, c2: r.cost, versions: r.versions });
  check("старая версия закрыта датой", r.versions.some((v) => v.date_to === "2026-05-31"), r.versions);
  // I3: версию, запрошенную по id, считаем целиком на её дату начала. Пока строки брали цену
  // на сегодня, а итог — на дату версии, эти числа расходились и карточка сама себе противоречила.
  r = await call("office_chart_get", { token: t, code: pir, id: v2 });
  check("chart_get по id: итог = сумма строк / выход",
    r.ok && r.cost !== null
      && Math.abs(Number(r.cost) - r.chart.lines.reduce((s, l) => s + Number(l.line_cost || 0), 0) / Number(r.chart.output_amount)) < 0.001,
    { cost: r.cost, lines: r.chart && r.chart.lines });
  r = await call("office_charts_list", { token: t, q: "ZZ_TEST_пирожок" });
  check("список: пирожок с картой и себестоимостью", r.ok && r.total === 1 && r.rows[0].chart_id && r.rows[0].cost !== null && r.rows[0].foodcost_pct !== null && r.rows[0].missing_count === 0, r.rows && r.rows[0]);
  r = await call("office_charts_list", { token: t, q: "ZZ_TEST_", only: "no_chart" });
  check("список: фильтр без карты пуст для тестовых (у всех блюд карты)", r.ok && r.rows.every((x) => !x.chart_id), r.rows);
  r = await call("office_charts_list", { token: t, only: "no_chart", page: 1 });
  check("фильтр без карты возвращает позиции без карты", r.ok && r.total > 0 && r.rows.every((x) => !x.chart_id && x.missing_count === 0), { total: r.total, first: r.rows[0] });
  r = await call("office_foodcost_report", { token: t });
  const row = (r.rows || []).find((x) => x.code === pir);
  check("отчёт: пирожок с фудкостом и CSV", r.ok && row && row.foodcost_pct !== null && typeof r.csv === "string" && r.csv.includes("ZZ_TEST_пирожок"), row);
  r = await call("office_chart_delete", { token: t, id: testoChart });
  check("удаление карты офиса без версий после — ok", r.ok, r);
  r = await call("office_chart_get", { token: t, code: testo });
  check("после удаления карты у теста нет", r.ok && r.chart === null, r);
  // права кладовщика
  r = await call("office_user_save", { token: t, login: "zz_test_sklad_ch", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: "4321" });
  let l = await call("office_login", { login: "zz_test_sklad_ch", pin: "4321" });
  await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_charts_list", { token: l.token });
  check("кладовщик видит список карт", r.ok, r);
  r = await call("office_chart_save", { token: l.token, code: pir, date_from: "2026-09-01", output_amount: 1, lines: [{ ingredient_code: testo, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("кладовщик не правит карты — forbidden", r.ok === false && r.error === "forbidden", r);
};

SECTIONS.stock = async (ctx) => {
  const t = ctx.token;
  const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;
  // справочники
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад А" }); const A = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад Б" }); const B = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_ИП", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_тесто", item_type: "prepared", unit_id: "кг" }); const testo = r.code;
  r = await call("office_chart_save", { token: t, code: testo, date_from: "2026-01-01", output_amount: 0.45, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.45 }] });
  check("подготовка: склады, поставщик, позиции, карта", A && B && SUP && muka && testo && r.ok, r);
  const bal = async (store, code) => { const b = await call("office_stock_balances", { token: t, store_id: store, q: code }); const row = (b.rows || []).find((x) => x.item_code === code); return row ? { qty: Number(row.qty), avg: Number(row.avg_cost) } : { qty: 0, avg: 0 }; };
  // 1. приход 10×100
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-01", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 100 }] });
  check("приход: черновик с номером ПН", r.ok && /^ПН-\d{4}-\d{6}$/.test(r.number), r);
  const inv1 = r.id, num1 = r.number;
  r = await call("office_doc_post", { token: t, id: inv1 });
  check("приход 1 проведён без предупреждений", r.ok && r.warnings.length === 0 && near(r.total_sum, 1000), r);
  let b = await bal(A, muka); check("остаток А: 10 по 100", b.qty === 10 && near(b.avg, 100), b);
  r = await call("office_item_get", { token: t, code: muka });
  check("учётная цена муки из прихода", r.ok && near(r.item.cost_price, 100) && r.item.cost_source === "document", r.item);
  // 2. приход 10×200
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-01", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 200 }] });
  check("номера растут на 1", r.ok && Number(r.number.slice(-6)) === Number(num1.slice(-6)) + 1, { num1, num2: r.number });
  await call("office_doc_post", { token: t, id: r.id });
  b = await bal(A, muka); check("остаток А: 20 по 150", b.qty === 20 && near(b.avg, 150), b);
  // 3. перемещение 5 А→Б
  r = await call("office_doc_save", { token: t, doc_type: "transfer", doc_date: "2026-09-02", store_from: A, store_to: B, lines: [{ item_code: muka, qty: 5 }] });
  r = await call("office_doc_post", { token: t, id: r.id });
  check("перемещение проведено", r.ok && near(r.total_sum, 750), r);
  b = await bal(B, muka); check("остаток Б: 5 по 150", b.qty === 5 && near(b.avg, 150), b);
  // 4. списание 2
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-02", store_from: A, reason: "spoilage", lines: [{ item_code: muka, qty: 2 }] });
  const wo = r.id; r = await call("office_doc_post", { token: t, id: wo });
  check("списание по средней 150", r.ok && near(r.total_sum, 300), r);
  b = await bal(A, muka); check("остаток А после списания: 13", b.qty === 13, b);
  // 5. производство 0.9 теста
  r = await call("office_doc_save", { token: t, doc_type: "production", doc_date: "2026-09-03", store_from: A, lines: [{ item_code: testo, qty: 0.9 }] });
  const prod = r.id;
  r = await call("office_doc_preview", { token: t, id: prod });
  check("предпросмотр производства: расход 1 кг муки по 150", r.ok && r.consume.length === 1 && near(r.consume[0].qty, 1) && near(r.consume[0].price, 150), r.consume);
  r = await call("office_doc_post", { token: t, id: prod });
  check("производство проведено, сумма 150", r.ok && near(r.total_sum, 150), r);
  r = await call("office_doc_get", { token: t, id: prod });
  check("строки расхода сохранены, выпуск по 166.67", r.ok && r.doc.consume.length === 1 && near(r.doc.lines[0].price, 166.6667, 0.001), r.doc);
  b = await bal(A, muka); check("мука А: 12", b.qty === 12, b);
  b = await bal(A, testo); check("тесто А: 0.9 по 166.67", near(b.qty, 0.9) && near(b.avg, 166.6667, 0.001), b);
  // 6. минус: предупреждение, проведение допускается, отмена возвращает
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-03", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 20 }] });
  const wo20 = r.id;
  r = await call("office_doc_preview", { token: t, id: wo20 });
  check("предпросмотр: уйдёт в минус −8", r.ok && r.warnings.length === 1 && near(r.warnings[0].balance_after, -8), r.warnings);
  r = await call("office_doc_post", { token: t, id: wo20 });
  check("проведение в минус допущено с предупреждением", r.ok && r.warnings.length === 1, r);
  r = await call("office_doc_unpost", { token: t, id: wo20 });
  b = await bal(A, muka); check("отмена вернула остаток 12", r.ok && b.qty === 12, b);
  await call("office_doc_delete", { token: t, id: wo20 });
  // 7. инвентаризация: факт 11 при расчёте 12
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2026-09-04", store_from: A, lines: [{ item_code: muka, fact_qty: 11 }, { item_code: testo, fact_qty: 0.9 }] });
  const inv = r.id;
  r = await call("office_doc_get", { token: t, id: inv });
  check("инвентаризация: подсказка расчётного остатка 12", r.ok && near(r.doc.lines.find((x) => x.item_code === muka).current_qty, 12), r.doc.lines);
  r = await call("office_doc_post", { token: t, id: inv });
  check("инвентаризация: недостача 1 × 150", r.ok && near(r.total_sum, -150), r);
  b = await bal(A, muka); check("мука А после инвентаризации: 11", b.qty === 11, b);
  // 8. запрет отмены раннего документа
  r = await call("office_doc_unpost", { token: t, id: inv1 });
  check("отмена прихода после инвентаризации — validation", r.ok === false && r.error === "validation" && /ИН-/.test(r.message), r);
  // 9. отмена инвентаризации, затем прихода — средняя пересобирается
  r = await call("office_doc_unpost", { token: t, id: inv }); check("инвентаризация отменена", r.ok, r);
  r = await call("office_doc_unpost", { token: t, id: inv1 }); check("приход 1 отменён", r.ok, r);
  b = await bal(A, muka); check("после отмены прихода 1: 2 по 200", b.qty === 2 && near(b.avg, 200), b);
  // 10. движения и пересборка
  r = await call("office_stock_moves", { token: t, store_id: A, item_code: muka });
  check("движения по муке на А", r.ok && r.total >= 4 && r.rows.every((x) => x.number), { total: r.total });
  r = await call("office_stock_rebuild", { token: t });
  check("пересборка остатков: расхождений 0", r.ok && r.mismatches_before === 0, r);
  r = await call("office_item_stock", { token: t, code: muka });
  check("остатки в карточке: А и Б", r.ok && r.balances.length === 2 && r.moves.length > 0, r.balances);
  // 10б. остатки: итог по выборке, CSV только по флагу export
  r = await call("office_stock_balances", { token: t, store_id: A, only_nonzero: true, export: true });
  const expSum = r.rows.reduce((s, x) => s + Number(x.qty) * Number(x.avg_cost), 0);
  check("остатки: итог = Σ qty×avg по выборке", r.ok && near(r.total_sum, expSum, 0.05) && r.total === r.rows.length, { total_sum: r.total_sum, expSum });
  check("остатки: CSV при export — шапка + строки", typeof r.csv === "string" && r.csv.split("\n").length === r.rows.length + 1, { lines: r.csv && r.csv.split("\n").length });
  r = await call("office_stock_balances", { token: t, store_id: A, only_nonzero: true });
  check("остатки: без export csv не отдаётся", r.ok && (r.csv === undefined || r.csv === null), Object.keys(r));
  r = await call("office_stock_balances", { token: t, store_id: A, only_nonzero: false });
  check("остатки: only_nonzero=false показывает и нули", r.ok && r.rows.length >= 2, { n: r.rows.length });

  // 10в. Проведённый документ не проводится второй раз и не правится (C1: обе ветки под локом).
  r = await call("office_doc_post", { token: t, id: prod });
  check("повторное проведение — validation", r.ok === false && r.error === "validation" && /уже проведён/.test(r.message || ""), r);
  r = await call("office_doc_save", { token: t, id: prod, doc_type: "production", doc_date: "2026-09-03", store_from: A, lines: [{ item_code: testo, qty: 5 }] });
  check("правка проведённого — validation", r.ok === false && r.error === "validation" && /отмените проведение/.test(r.message || ""), r);

  // 10г. Дубль позиции в строках: отказ до первой записи, остаток не тронут.
  const dupBefore = await bal(A, muka);
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-05", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 1 }, { item_code: muka, qty: 2 }] });
  const dupDoc = r.id;
  r = await call("office_doc_post", { token: t, id: dupDoc });
  check("дубль позиции в строках — validation", r.ok === false && r.error === "validation" && /повторяется/.test(r.message || ""), r);
  const dupAfter = await bal(A, muka);
  check("после отказа по дублю остаток не изменился", near(dupAfter.qty, dupBefore.qty) && near(dupAfter.avg, dupBefore.avg), { dupBefore, dupAfter });
  await call("office_doc_delete", { token: t, id: dupDoc });

  // 10д. Взвешивание при перемещении: на Б 5 по 150, на А средняя 200 → Б 8 по 168.75.
  r = await call("office_doc_save", { token: t, doc_type: "transfer", doc_date: "2026-09-05", store_from: A, store_to: B, lines: [{ item_code: muka, qty: 3 }] });
  const tr2 = r.id;
  r = await call("office_doc_post", { token: t, id: tr2 });
  check("перемещение 3 кг по 200 проведено", r.ok && near(r.total_sum, 600), r);
  b = await bal(B, muka); check("Б: 8 по 168.75 = (5×150 + 3×200) / 8", near(b.qty, 8) && near(b.avg, 168.75), b);
  // 10е. Отмена перемещения пересобирает обе пары, а не только склад-источник.
  r = await call("office_doc_unpost", { token: t, id: tr2 });
  check("перемещение отменено", r.ok, r);
  b = await bal(A, muka); check("отмена перемещения: А снова 2 по 200", near(b.qty, 2) && near(b.avg, 200), b);
  b = await bal(B, muka); check("отмена перемещения: Б снова 5 по 150", near(b.qty, 5) && near(b.avg, 150), b);
  await call("office_doc_delete", { token: t, id: tr2 });

  // 10ж. Излишек инвентаризации: факт больше расчёта → движение со знаком плюс и сумма > 0.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2026-09-05", store_from: A, lines: [{ item_code: muka, fact_qty: 3 }] });
  const inv2 = r.id;
  r = await call("office_doc_post", { token: t, id: inv2 });
  check("инвентаризация: излишек +1 по 200, сумма > 0", r.ok && r.total_sum > 0 && near(r.total_sum, 200), r);
  b = await bal(A, muka); check("мука А после излишка: 3", near(b.qty, 3), b);
  r = await call("office_stock_moves", { token: t, store_id: A, item_code: muka, date_from: "2026-09-05", date_to: "2026-09-05" });
  check("излишек дал движение +1", r.ok && (r.rows || []).some((x) => x.doc_type === "inventory" && Number(x.qty) === 1), { n: r.total });

  // 10з. Накладная поставщика (0018): № и дата принимаются приходом и возвращаются карточкой и журналом.
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-05", store_to: A, counteragent_id: SUP,
    ext_number: "А-1", ext_date: "2026-09-04", lines: [{ item_code: muka, qty: 1, price: 100 }] });
  const extDoc = r.id;
  check("приход с № накладной сохранён", r.ok && extDoc, r);
  r = await call("office_doc_get", { token: t, id: extDoc });
  check("doc_get отдаёт № и дату накладной поставщика",
    r.ok && r.doc.ext_number === "А-1" && r.doc.ext_date === "2026-09-04", { n: r.doc && r.doc.ext_number, d: r.doc && r.doc.ext_date });
  r = await call("office_docs_list", { token: t, store_id: A, doc_type: "invoice_in" });
  check("журнал отдаёт № накладной", r.ok && (r.rows || []).some((x) => x.ext_number === "А-1"), { n: r.total });
  await call("office_doc_delete", { token: t, id: extDoc });

  // 10и. Кладовщик проводит приход — приёмка его работа (спецификация 3.5).
  r = await call("office_user_save", { token: t, login: "zz_test_sklad_s", name: "ZZ_TEST_Кладовщик склада", role: "storekeeper", pin: "4321" });
  check("кладовщик заведён", r.ok && r.id, r);
  const sk = await call("office_login", { login: "zz_test_sklad_s", pin: "4321" });
  await call("office_change_pin", { token: sk.token, pin: "4321" });
  r = await call("office_doc_save", { token: sk.token, doc_type: "invoice_in", doc_date: "2026-09-05", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 2, price: 210 }] });
  check("кладовщик создаёт приход", r.ok && r.id, r);
  r = await call("office_doc_post", { token: sk.token, id: r.id });
  check("кладовщик проводит приход", r.ok && near(r.total_sum, 420), r);

  // 10к. Привязка кладовщика к складам: с привязкой он видит и трогает только свои склады.
  const skId = (await call("office_users_list", { token: t })).users.find((u) => u.login === "zz_test_sklad_s").id;
  r = await call("office_user_save", { token: t, id: skId, login: "zz_test_sklad_s", name: "ZZ_TEST_Кладовщик склада", role: "storekeeper", store_ids: [A] });
  check("кладовщик привязан к складу А", r.ok, r);
  r = await call("office_users_list", { token: t });
  check("users_list отдаёт склады пользователя", r.ok && JSON.stringify(r.users.find((u) => u.id === skId).store_ids) === JSON.stringify([A]), r.users && r.users.find((u) => u.id === skId));
  r = await call("office_me", { token: sk.token });
  check("me отдаёт склады кладовщика", r.ok && JSON.stringify(r.user.store_ids) === JSON.stringify([A]), r.user);
  r = await call("office_doc_save", { token: sk.token, doc_type: "writeoff", doc_date: "2026-09-05", store_from: B, reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  check("чужой склад: списание — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_save", { token: sk.token, doc_type: "transfer", doc_date: "2026-09-05", store_from: B, store_to: A, lines: [{ item_code: muka, qty: 1 }] });
  check("чужой склад: перемещение с чужого — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_save", { token: sk.token, doc_type: "transfer", doc_date: "2026-09-05", store_from: A, store_to: B, lines: [{ item_code: muka, qty: 1 }] });
  check("свой склад: перемещение со своего — ok", r.ok, r);
  const skTr = r.id;
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-05", store_from: B, reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  const draftB = r.id;
  r = await call("office_doc_save", { token: sk.token, id: draftB, doc_type: "writeoff", doc_date: "2026-09-05", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  check("чужой черновик нельзя перетащить на свой склад — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_get", { token: sk.token, id: draftB });
  check("чужой склад: карточка — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_preview", { token: sk.token, id: draftB });
  check("чужой склад: предпросмотр — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_post", { token: sk.token, id: draftB });
  check("чужой склад: проведение — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_delete", { token: sk.token, id: draftB });
  check("чужой склад: удаление — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_docs_list", { token: sk.token });
  check("журнал кладовщика — только документы его склада", r.ok && r.rows.length > 0 && r.rows.every((x) => x.store_from === A || x.store_to === A), r.rows && r.rows.map((x) => [x.store_from_name, x.store_to_name]));
  r = await call("office_stock_balances", { token: sk.token, only_nonzero: false });
  check("остатки кладовщика — только его склад", r.ok && r.rows.length > 0 && r.rows.every((x) => x.store_id === A), r.rows && r.rows.slice(0, 3));
  r = await call("office_stock_balances", { token: sk.token, store_id: B });
  check("остатки чужого склада — пусто", r.ok && r.rows.length === 0, r.total);
  r = await call("office_stock_moves", { token: sk.token });
  check("движения кладовщика — только его склад", r.ok && r.rows.every((x) => x.store_id === A), r.rows && r.rows.slice(0, 3));
  r = await call("office_user_save", { token: t, id: skId, login: "zz_test_sklad_s", name: "ZZ_TEST_Кладовщик склада", role: "storekeeper", store_ids: [] });
  r = await call("office_doc_get", { token: sk.token, id: draftB });
  check("без привязки — снова все склады", r.ok, r);
  await call("office_doc_delete", { token: t, id: draftB });
  await call("office_doc_delete", { token: t, id: skTr });

  // 11. права по типам
  r = await call("office_user_save", { token: t, login: "zz_test_tech_s", name: "ZZ_TEST_Технолог", role: "technologist", pin: "4321" });
  let l = await call("office_login", { login: "zz_test_tech_s", pin: "4321" }); await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_doc_save", { token: l.token, doc_type: "invoice_in", doc_date: "2026-09-05", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 1, price: 1 }] });
  check("технолог не создаёт приход — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_save", { token: l.token, doc_type: "production", doc_date: "2026-09-05", store_from: A, lines: [{ item_code: testo, qty: 0.1 }] });
  check("технолог создаёт производство", r.ok, r);
  r = await call("office_doc_post", { token: l.token, id: r.id });
  check("технолог проводит производство", r.ok, r);
  // 11б. чужой черновик, чужие права, ссылки на несуществующее
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2026-09-05", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 1, price: 1 }] });
  const draftIn = r.id;
  r = await call("office_doc_save", { token: l.token, id: draftIn, doc_type: "production", doc_date: "2026-09-05", store_from: A, lines: [{ item_code: testo, qty: 1 }] });
  check("технолог не может сменить тип чужого черновика", r.ok === false && r.error === "validation" && /менять нельзя/.test(r.message), r);
  r = await call("office_doc_delete", { token: l.token, id: draftIn });
  check("технолог не удаляет приход — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_stock_rebuild", { token: l.token });
  check("пересборка под неадминистратором — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-05", store_from: A, reason: "other", lines: [{ item_code: "нет-такого", qty: 1 }] });
  check("неизвестная позиция — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2026-09-05", store_from: "00000000-0000-4000-8000-000000000000", reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  check("несуществующий склад — validation, не 500", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_delete", { token: t, id: draftIn });
  check("удалить черновой приход админом", r.ok, r);
  r = await call("office_user_save", { token: t, login: "zz_test_buh_s", name: "ZZ_TEST_Бухгалтер", role: "accountant", pin: "4321" });
  l = await call("office_login", { login: "zz_test_buh_s", pin: "4321" }); await call("office_change_pin", { token: l.token, pin: "4321" });
  r = await call("office_doc_save", { token: l.token, doc_type: "writeoff", doc_date: "2026-09-05", store_from: A, reason: "other", lines: [{ item_code: muka, qty: 1 }] });
  check("бухгалтер не создаёт списание — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_docs_list", { token: t, store_id: A });
  check("журнал: документы тестового склада", r.ok && r.total >= 6 && r.rows[0].number, { total: r.total });
  r = await call("office_doc_delete", { token: t, id: prod });
  check("удалить проведённый нельзя — validation", r.ok === false && r.error === "validation", r);
};


// Подпроект 4: отчёт точки порождает документ «Продажа» на складе точки. Отчёты пишутся на
// служебную выключенную точку «zz_test» (миграция 0023) датами 2020 года — их убирает test_cleanup.
SECTIONS.sales = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (отчёт точки сдаётся кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад продаж", point_id: "zz_test", is_default: true });
  const S = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик продаж", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука продаж", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_батончик", item_type: "goods", unit_id: "шт" }); const bar = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_блин", item_type: "dish", unit_id: "порц" }); const blin = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_услуга", item_type: "service", unit_id: "шт" }); const svc = r.code;
  r = await call("office_chart_save", { token: t, code: blin, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.2, netto: 0.2, output: 0.2 }] });
  check("продажи: подготовка — склад точки, позиции, карта", S && SUP && muka && bar && blin && svc && r.ok, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2020-02-01", store_to: S, counteragent_id: SUP,
    lines: [{ item_code: muka, qty: 10, price: 100 }, { item_code: bar, qty: 5, price: 50 }] });
  await call("office_doc_post", { token: t, id: r.id });
  const bal = async (code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };
  const report = (date, sales, takeout) => call("save_report", { pin, point_id: "zz_test", date, comment: "ZZ_TEST_продажи",
    cash: 1000, sales: sales || [], takeout: takeout || [] });
  const list = async (date) => (await call("office_doc_sales_list", { token: t, date_from: date, date_to: date, point_id: "zz_test" })).rows || [];

  // 1. Отчёт: блюдо с картой, товар без карты, строка без кода, услуга — в склад идут только первые два.
  r = await report("2020-03-01", [{ item_code: blin, item_name: "блин", qty: 3, price: 500 },
    { item_code: bar, item_name: "батончик", qty: 2, price: 150 }, { item_code: "", item_name: "без кода", qty: 1, price: 10 },
    { item_code: svc, item_name: "услуга", qty: 1, price: 100 }]);
  check("продажи: отчёт точки сохранён", r.ok, r);
  let rows = await list("2020-03-01");
  check("продажи: по отчёту проведён документ ПД", rows.length === 1 && (rows[0] || {}).state === "posted" && /^ПД-2020-\d{6}$/.test((rows[0] || {}).number)
    && near((rows[0] || {}).sale_sum, 1800), rows);
  const saleId = rows[0] && (rows[0] || {}).doc_id;
  check("продажи: мука списана по карте (10 − 3×0,2), батончик как есть (5 − 2)", near(await bal(muka), 9.4) && near(await bal(bar), 3),
    { muka: await bal(muka), bar: await bal(bar) });
  r = await call("office_doc_get", { token: t, id: saleId });
  check("продажи: карточка — проданное с выручкой и списанное по картам",
    r.ok && r.doc.doc_type === "sale" && r.doc.lines.length === 2 && r.doc.lines.some((l) => l.item_code === blin && near(l.sum, 1500))
    && r.doc.consume.some((c) => c.item_code === muka && near(c.qty, 0.6)) && r.doc.consume.some((c) => c.item_code === bar && near(c.qty, 2))
    && near(r.doc.total_sum, 0.6 * 100 + 2 * 50), r.doc && { lines: r.doc.lines, consume: r.doc.consume, total: r.doc.total_sum });

  // 2. Повторное сохранение без изменений — тот же документ, движения не задвоены.
  r = await report("2020-03-01", [{ item_code: blin, item_name: "блин", qty: 3, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2020-03-01");
  check("продажи: повторное сохранение — тот же документ, остатки те же", (rows[0] || {}).doc_id === saleId && near(await bal(muka), 9.4), rows);
  // 3. Изменили количество — документ пересчитан.
  r = await report("2020-03-01", [{ item_code: blin, item_name: "блин", qty: 5, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2020-03-01");
  check("продажи: изменение отчёта пересчитывает продажу", (rows[0] || {}).doc_id === saleId && (rows[0] || {}).state === "posted" && near(await bal(muka), 9), { rows, muka: await bal(muka) });

  // 4. Руками продажу не трогают.
  r = await call("office_doc_unpost", { token: t, id: saleId });
  check("продажи: ручная отмена — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_delete", { token: t, id: saleId });
  check("продажи: ручное удаление — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, doc_type: "sale", doc_date: "2020-03-01", store_from: S, lines: [{ item_code: bar, qty: 1 }] });
  check("продажи: ручное создание — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, id: saleId, doc_type: "writeoff", doc_date: "2020-03-01", store_from: S, reason: "other", lines: [{ item_code: bar, qty: 1 }] });
  check("продажи: правка продажи через другой тип — отказ", r.ok === false, r);

  // 5. Продаж с кодом нет — документа нет; отчёт с продажей, а потом без неё — документ удалён.
  await report("2020-03-02", [{ item_code: bar, item_name: "батончик", qty: 1, price: 150 }]);
  check("продажи: второй день — свой документ", ((await list("2020-03-02"))[0] || {}).state === "posted" && near(await bal(bar), 2), await list("2020-03-02"));
  await report("2020-03-02", [{ item_code: "", item_name: "без кода", qty: 1, price: 10 }]);
  rows = await list("2020-03-02");
  check("продажи: продажи ушли из отчёта — документ удалён, остаток вернулся", (rows[0] || {}).state === "none" && !(rows[0] || {}).doc_id && near(await bal(bar), 3), rows);

  // 6. Точка без склада — документа нет; после привязки — пересчёт за период.
  await call("office_store_save", { token: t, id: S, name: "ZZ_TEST_склад продаж", point_id: null, is_default: false });
  await report("2020-03-03", [{ item_code: bar, item_name: "батончик", qty: 1, price: 150 }]);
  rows = await list("2020-03-03");
  check("продажи: точка без склада — «нет склада»", (rows[0] || {}).state === "no_store" && !(rows[0] || {}).doc_id, rows);
  await call("office_store_save", { token: t, id: S, name: "ZZ_TEST_склад продаж", point_id: "zz_test", is_default: true });
  r = await call("office_user_save", { token: t, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", pin: "4321" });
  const skl = await call("office_login", { login: "zz_test_sales_sk", pin: "4321" }); await call("office_change_pin", { token: skl.token, pin: "4321" });
  r = await call("office_doc_sales_sync", { token: skl.token, date_from: "2020-03-01", date_to: "2020-03-03", point_id: "zz_test" });
  check("продажи: кладовщик не пересчитывает — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2020-03-01", date_to: "2020-03-03", point_id: "zz_test" });
  check("продажи: кладовщик видит список продаж", r.ok && r.rows.length === 3, r);
  r = await call("office_doc_sales_sync", { token: t, date_from: "2020-03-01", date_to: "2020-03-03", point_id: "zz_test" });
  check("продажи: пересчёт за период — третий день проведён", r.ok && r.counts.posted === 1 && r.counts.unchanged === 1 && r.counts.empty === 1, r);
  check("продажи: после пересчёта батончик списан", near(await bal(bar), 2), await bal(bar));

  // 7. Дашборд собственницы: расход сырья по карте на дату отчёта.
  r = await call("dashboard", { pin, from: "2020-03-01", to: "2020-03-03" });
  check("продажи: дашборд — расход муки по карте", r.ok && (r.raw_usage || []).some((x) => x.name === "ZZ_TEST_мука продаж" && near(x.amount, 1)), r.raw_usage);

  // 8. Инвентаризация после продажи: изменение отчёта задним числом не переписывает склад.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2020-03-05", store_from: S, lines: [{ item_code: muka, fact_qty: 9 }] });
  await call("office_doc_post", { token: t, id: r.id });
  await report("2020-03-01", [{ item_code: blin, item_name: "блин", qty: 1, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2020-03-01");
  check("продажи: отчёт изменён после инвентаризации — пометка, склад не тронут",
    (rows[0] || {}).state === "locked" && /инвентаризац/i.test((rows[0] || {}).sync_note || "") && near(await bal(muka), 9), { rows, muka: await bal(muka) });

  // 9. Оборотная ведомость склада (как «Расширенная оборотно-сальдовая ведомость» iiko).
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2020-03-01", date_to: "2020-03-31" });
  const tm = (r.rows || []).find((x) => x.item_code === muka), tb = (r.rows || []).find((x) => x.item_code === bar);
  check("ведомость: мука — начало 10, продано 1, конец 9", r.ok && tm && near(tm.start_qty, 10) && near(tm.sales, 1) && near(tm.end_qty, 9)
    && near(tm.income, 0) && near(tm.end_sum, 900), tm);
  check("ведомость: батончик — начало 5, продано 3, конец 2", tb && near(tb.start_qty, 5) && near(tb.sales, 3) && near(tb.end_qty, 2), tb);
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2020-02-01", date_to: "2020-02-29" });
  const tf = (r.rows || []).find((x) => x.item_code === muka);
  check("ведомость: февраль — приход 10 по 100, начало 0", r.ok && tf && near(tf.start_qty, 0) && near(tf.income, 10) && near(tf.income_sum, 1000) && near(tf.end_qty, 10), tf);
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2020-03-31", date_to: "2020-03-01" });
  check("ведомость: перепутанный период — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_stock_turnover_report", { token: skl.token, store_id: S, date_from: "2020-03-01", date_to: "2020-03-31" });
  check("ведомость: кладовщик без привязки видит склад", r.ok && r.rows.length >= 2, r);

  // 10. Ревью: продажа задним числом до инвентаризации не проводится — иначе двойное списание.
  await report("2020-03-04", [{ item_code: bar, item_name: "батончик", qty: 1, price: 150 }]);
  rows = await list("2020-03-04");
  check("продажи: отчёт за день до инвентаризации — не проведён, пометка, склад не тронут",
    (rows[0] || {}).state === "draft" && /инвентаризац/i.test((rows[0] || {}).sync_note || "") && near(await bal(bar), 2), { rows, bar: await bal(bar) });
  // 11. Блюдо без карты списывается как есть; появилась карта — пересчёт проводит заново.
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_оладьи", item_type: "dish", unit_id: "порц" }); const olad = r.code;
  await report("2020-03-06", [{ item_code: olad, item_name: "оладьи", qty: 2, price: 300 }]);
  rows = await list("2020-03-06");
  check("продажи: блюдо без карты — списано как есть, пометка",
    (rows[0] || {}).state === "posted" && /Без техкарты/.test((rows[0] || {}).sync_note || "") && near(await bal(olad), -2), { rows, olad: await bal(olad) });
  await call("office_chart_save", { token: t, code: olad, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  r = await call("office_doc_sales_sync", { token: t, date_from: "2020-03-06", date_to: "2020-03-06", point_id: "zz_test" });
  rows = await list("2020-03-06");
  check("продажи: карта появилась — пересчёт списал муку, пометка снята",
    r.ok && r.counts.posted === 1 && !(rows[0] || {}).sync_note && near(await bal(muka), 8.8) && near(await bal(olad), 0), { r, rows, muka: await bal(muka) });
  // 12. Кладовщик с привязкой к чужому складу не видит отчёты и деньги точки.
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_чужой склад" }); const OTHER = r.id;
  const sklId = (await call("office_users_list", { token: t })).users.find((u) => u.login === "zz_test_sales_sk").id;
  await call("office_user_save", { token: t, id: sklId, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", store_ids: [OTHER] });
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2020-03-01", date_to: "2020-03-06", point_id: "zz_test" });
  check("продажи: кладовщик чужого склада не видит отчёты точки", r.ok && r.rows.length === 0, r.rows && r.rows.length);
  await call("office_user_save", { token: t, id: sklId, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", store_ids: [S] });
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2020-03-01", date_to: "2020-03-06", point_id: "zz_test" });
  check("продажи: кладовщик своего склада видит отчёты точки", r.ok && r.rows.length === 5, r.rows && r.rows.length);
  // 13. Отчёт «Продажи и себестоимость»: только проведённые продажи. День 1 — 5 блинов по 500
  // (мука 5×0,2 по 100) и 2 батончика по 150 (по 50), день 3 — батончик, день 6 — 2 оладьи по 300
  // (мука 2×0,1 по 100). День 4 не проведён (инвентаризация) и в отчёт не входит.
  r = await call("office_doc_sales_report", { token: t, date_from: "2020-03-01", date_to: "2020-03-06", point_id: "zz_test" });
  const mp = (r.points || []).find((x) => x.point_id === "zz_test") || {};
  const mb = (r.items || []).find((x) => x.item_code === blin) || {}, mo = (r.items || []).find((x) => x.item_code === olad) || {};
  check("продажи и себестоимость: по точке выручка 3550, себестоимость 270, фудкост 7,6 %",
    r.ok && near(mp.revenue, 3550) && near(mp.cost, 270) && near(mp.margin, 3280) && near(mp.foodcost_pct, 7.61, 0.01) && mp.docs === 3, mp);
  check("продажи и себестоимость: по позициям — блины 5 шт на 2500 с себестоимостью 100, оладьи 600/20",
    near(mb.qty, 5) && near(mb.revenue, 2500) && near(mb.cost, 100) && near(mo.revenue, 600) && near(mo.cost, 20), { mb, mo });
  r = await call("office_doc_sales_report", { token: skl.token, date_from: "2020-03-01", date_to: "2020-03-06" });
  check("продажи и себестоимость: кладовщик своего склада видит свою точку", r.ok && (r.points || []).some((x) => x.point_id === "zz_test"), r);
};

// Касса (миграция 0033): чек в течение дня → строки и деньги дневного отчёта → документ «Продажа».
// Служебная выключенная точка «zz_kassa» (режим checks); день — сегодняшний, всё убирает test_cleanup.
SECTIONS.kassa = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (чек пробивается кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const day = new Date().toISOString().slice(0, 10);
  const uid = () => crypto.randomUUID();
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы", point_id: "zz_kassa", is_default: true }); const S = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик кассы", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука кассы", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_сок кассы", item_type: "goods", unit_id: "шт", for_sale: true, price: 300 }); const sok = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_беляш кассы", item_type: "dish", unit_id: "шт", for_sale: true, price: 400 }); const bel = r.code;
  r = await call("office_chart_save", { token: t, code: bel, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("касса: подготовка — склад точки, позиции, карта", S && SUP && muka && sok && bel && r.ok, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2020-02-01", store_to: S, counteragent_id: SUP,
    lines: [{ item_code: muka, qty: 10, price: 100 }, { item_code: sok, qty: 20, price: 150 }] });
  await call("office_doc_post", { token: t, id: r.id });
  const bal = async (code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };
  const K = (action, p) => call(action, { pin, point_id: "zz_kassa", ...p });
  const sales = async () => ((await call("office_doc_sales_list", { token: t, date_from: day, date_to: day, point_id: "zz_kassa" })).rows || [])[0] || {};

  // 1. Первый чек: номер 1, сумма по ценам базы, отчёт дня и продажа появились сразу.
  const u1 = uid();
  r = await K("check_save", { uid: u1, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: bel, qty: 2 }, { item_code: sok, qty: 1 }] });
  check("касса: чек №1 принят, сумма по ценам базы (2×400 + 300)", r.ok && r.check.no === 1 && near(r.check.total, 1100), r);
  let s = await sales();
  check("касса: продажа проведена сразу — ПД, 1100, мука и сок списаны", s.state === "posted" && near(s.sale_sum, 1100) && near(s.money, 1100)
    && near(await bal(muka), 9.8) && near(await bal(sok), 19), { s, muka: await bal(muka), sok: await bal(sok) });
  // 2. Досылка того же чека (обрыв связи) второго чека не создаёт.
  r = await K("check_save", { uid: u1, date: day, pay_kind: "cash", lines: [{ item_code: bel, qty: 2 }, { item_code: sok, qty: 1 }] });
  let l = await K("check_list", { date: day });
  check("касса: повторная досылка — чек один, остатки те же", r.ok && r.check.no === 1 && l.checks.length === 1 && near(await bal(sok), 19), l.totals);
  // 3. Второй чек: другая оплата и скидка на строку — в отчёте одна строка на позицию, цена средняя, рядом цена прейскуранта.
  const u2 = uid();
  r = await K("check_save", { uid: u2, date: day, pay_kind: "kaspi_qr", lines: [{ item_code: sok, qty: 2, price: 250 }] });
  l = await K("check_list", { date: day });
  check("касса: чек №2, итоги по каналам оплаты", r.ok && r.check.no === 2 && near(l.totals.cash, 1100) && near(l.totals.kaspi_qr, 500) && l.totals.count === 2, { r, totals: l.totals });
  r = await call("get_report", { pin, point_id: "zz_kassa", date: day });
  const sokLines = (r.sales || []).filter((x) => x.item_code === sok);
  check("касса: отчёт дня собран из чеков — деньги по каналам, скидка видна в строке",
    r.ok && near(r.report.cash, 1100) && near(r.report.kaspi_qr, 500) && near(r.report.revenue_total, 1600) && Number(r.report.checks_count) === 2
    && sokLines.length === 1 && near(sokLines[0].qty, 3) && near(sokLines[0].price, 266.67) && near(sokLines[0].price_list, 300), { rep: r.report, sokLines });
  // 4. Исправление чека: оплата картой, сока больше — деньги и склад пересчитаны, карта входит в выручку.
  r = await K("check_save", { uid: u2, date: day, pay_kind: "card", lines: [{ item_code: sok, qty: 3, price: 250 }] });
  s = await sales();
  r = await call("get_report", { pin, point_id: "zz_kassa", date: day });
  check("касса: исправленный чек — карта в выручке, склад пересчитан", near(r.report.card, 750) && near(r.report.kaspi_qr, 0) && near(r.report.revenue_total, 1850)
    && near(s.money, 1850) && near(await bal(sok), 16), { rep: r.report, s, sok: await bal(sok) });
  // 5. Отмена чека возвращает товар и деньги.
  r = await K("check_void", { uid: u2, reason: "ZZ_TEST_ошибка" });
  l = await K("check_list", { date: day });
  check("касса: отмена чека — деньги и остаток вернулись, чек остался в списке отменённым", r.ok && near(l.totals.total, 1100) && near(await bal(sok), 19)
    && l.checks.some((c) => c.uid === u2 && c.status === "void"), l.totals);
  r = await K("check_save", { uid: u2, date: day, pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
  check("касса: отменённый чек исправить нельзя", r.ok === false, r);
  // 6. Отказы: нет в продаже, ноль, чужая дата, без оплаты, точка без кассы, неверный код.
  r = await K("check_save", { uid: uid(), date: day, pay_kind: "cash", lines: [{ item_code: muka, qty: 1 }] });
  check("касса: сырьё (не в продаже) пробить нельзя", r.ok === false && /нет в продаже/.test(r.error), r);
  r = await K("check_save", { uid: uid(), date: day, pay_kind: "cash", lines: [{ item_code: sok, qty: 0 }] });
  check("касса: нулевое количество — отказ", r.ok === false, r);
  r = await K("check_save", { uid: uid(), date: "2020-03-01", pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
  check("касса: чек давней датой — отказ", r.ok === false && /Дата/.test(r.error), r);
  r = await K("check_save", { uid: uid(), date: day, pay_kind: "bonus", lines: [{ item_code: sok, qty: 1 }] });
  check("касса: неизвестный способ оплаты — отказ", r.ok === false, r);
  r = await call("check_save", { pin, point_id: "zz_test", uid: uid(), date: day, pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
  check("касса: у точки без режима кассы чеки не принимаются", r.ok === false && /не включена/.test(r.error), r);
  r = await call("check_list", { pin: "0000", point_id: "zz_kassa", date: day });
  check("касса: без кода точки чеков не видно", r.ok === false && r.error === "Нет доступа", r);
  // 7. Закрытие смены: форма присылает свои деньги и продажи — сервер берёт их из чеков.
  r = await call("save_report", { pin, point_id: "zz_kassa", date: day, shift_by: "ZZ_TEST_продавец", cash: 99999, kaspi_qr: 5,
    cash_open: 1000, cash_counted: 2100, comment: "ZZ_TEST_касса", sales: [{ item_code: sok, item_name: "подлог", qty: 50, price: 1 }] });
  check("касса: закрытие смены — деньги и продажи из чеков, а не из формы; наличные сошлись",
    r.ok && near(r.report.cash, 1100) && near(r.report.kaspi_qr, 0) && near(r.report.sales_amount, 1100) && near(r.report.diff_cash, 0) && r.report.closed_at, r.report);
  check("касса: после закрытия склад тот же", near(await bal(sok), 19) && near(await bal(muka), 9.8), { sok: await bal(sok) });
  // 8. Чек после закрытия смены принимается — продажа не теряется, отчёт пересобран.
  r = await K("check_save", { uid: uid(), date: day, pay_kind: "transfer", lines: [{ item_code: sok, qty: 1 }] });
  s = await sales();
  check("касса: чек после закрытия смены учтён", r.ok && r.check.no === 3 && near(s.money, 1400) && near(await bal(sok), 18), s);
  r = await call("dashboard", { pin, from: day, to: day });
  check("касса: сводка собственника видит канал «карта» и отчёт кассы", r.ok && "card" in r.channels && (r.rows || []).some((x) => x.point_id === "zz_kassa" && near(x.revenue_total, 1400)), r.channels);

  // Расход для 1С (миграция 0034): тот же склад — продано 2 сока, беляши списали 0,2 кг муки по карте.
  const cat = await call("office_stock_1c_catalog_list", { token: t });
  const code1c = cat.ok && cat.rows.length ? cat.rows[0].code : null;
  check("1С: справочник позиций 1С отдаётся", !!code1c, cat.ok ? cat.rows.length : cat);
  r = await call("office_stock_1c_link_save", { token: t, item_code: sok, code_1c: code1c, k_1c: 0 });
  check("1С: нулевой коэффициент — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_stock_1c_link_save", { token: t, item_code: sok, code_1c: "ZZ_нет_такого", k_1c: 1 });
  check("1С: код не из справочника — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_stock_1c_link_save", { token: t, item_code: sok, code_1c: code1c, k_1c: 2 });
  check("1С: соответствие сохранено", r.ok, r);
  r = await call("office_stock_1c_report", { token: t, store_id: S, date_from: day, date_to: day });
  const rs = (r.rows || []).find((x) => x.item_code === sok), rm = (r.rows || []).find((x) => x.item_code === muka);
  check("1С: расход сока 2 шт → 4 ед. 1С, мука 0,2 кг без позиции 1С", r.ok && rs && near(rs.qty, 2) && near(rs.qty_1c, 4) && rs.code_1c === code1c
    && rm && near(rm.qty, 0.2) && !rm.code_1c && rm.qty_1c === null, { rs, rm });
  check("1С: сумма по себестоимости склада (сок 2 × 150)", rs && near(rs.sum, 300), rs);
  r = await call("office_stock_1c_link_save", { token: t, item_code: sok, code_1c: "", k_1c: "" });
  const again = await call("office_stock_1c_report", { token: t, store_id: S, date_from: day, date_to: day });
  check("1С: связь снимается", r.ok && !(again.rows || []).find((x) => x.item_code === sok).code_1c, again.rows);
};

// Единый вход (миграция 0029): служебный ключ и счётчик неверных кодов. Идёт последним:
// раздел сам запирает вход по коду для служебной точки, замок снимает уборка теста.
SECTIONS.gate = async () => {
  const pin = process.env.TANDEM_OWNER_PIN || "";
  let r = await call("test_cleanup", { pin, service_key: "" });
  check("служебное действие с одним кодом собственника — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("migrate", { pin, service_key: "не тот ключ", kind: "groups", rows: [] });
  check("служебное действие с неверным ключом — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("migrate", { kind: "groups", rows: [] });
  check("служебное действие с ключом и без кода собственника — проходит", r.ok === true, r);
  await call("test_cleanup", {});   // счётчик служебной точки — с нуля, что бы ни было до этого
  for (let i = 0; i < 10; i++) r = await call("login", { pin: "000" + i, point_id: "zz_test" });
  check("десятый неверный код — ещё обычный отказ", r.ok === false && r.error === "Неверный код", r);
  r = await call("login", { pin: "0011", point_id: "zz_test" });
  check("одиннадцатый — вход по коду закрыт на 5 минут", r.ok === false && r.code === "throttled", r);
  if (pin) {
    r = await call("get_report", { pin, point_id: "zz_test", date: "2020-01-01" });
    check("во время замка верный код получает тот же отказ (нет подсказки перебору)", r.ok === false && r.code === "throttled", r);
  }
  r = await call("points", {});
  check("другие точки и действия без кода не заперты", Array.isArray(r) && r.length > 0, r);
  r = await call("test_cleanup", {});
  check("уборка теста снимает замок служебной точки", r.ok === true, r);
  if (pin) {
    r = await call("get_report", { pin, point_id: "zz_test", date: "2020-01-01" });
    check("после уборки верный код снова работает", r.ok === true, r);
  }
};

// --- разделы добавляются здесь ---

// Проверка готовности (миграция 0028): отчёт о том, что в справочниках помешает учёту.
SECTIONS.quality = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_item_save", { token: t, name: "ZZ_TEST_сырьё без цены", item_type: "goods", unit_id: "кг" }); const raw = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_блюдо без карты", item_type: "dish", unit_id: "порц", for_sale: true }); const dish = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_блюдо с картой", item_type: "dish", unit_id: "порц", for_sale: true, price: 100 }); const dish2 = r.code;
  await call("office_chart_save", { token: t, code: dish2, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: raw, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  r = await call("office_stock_quality_report", { token: t });
  const by = Object.fromEntries((r.checks || []).map((c) => [c.id, c]));
  check("готовность: отчёт пришёл со всеми проверками", r.ok && ["raw_no_cost", "dish_no_chart", "sale_no_price", "dup_names", "no_group", "point_no_store", "sales_not_posted", "negative_stock", "users"].every((k) => by[k]), Object.keys(by));
  check("готовность: сырьё без цены найдено, с числом карт", (by.raw_no_cost.rows || []).some((x) => x.code === raw && /1 карт/.test(x.detail)), by.raw_no_cost && by.raw_no_cost.count);
  check("готовность: блюдо без карты найдено, блюдо с картой — нет",
    by.dish_no_chart.rows.some((x) => x.code === dish) && !by.dish_no_chart.rows.some((x) => x.code === dish2), by.dish_no_chart.count);
  check("готовность: на продаже без цены — только блюдо без цены",
    by.sale_no_price.rows.some((x) => x.code === dish) && !by.sale_no_price.rows.some((x) => x.code === dish2), by.sale_no_price.count);
  check("готовность: счётчики bad/warn посчитаны", r.bad >= 2 && r.warn >= 1, { bad: r.bad, warn: r.warn });
  await call("office_item_save", { token: t, code: raw, cost_price: 50 });
  r = await call("office_stock_quality_report", { token: t });
  check("готовность: цена задана — сырьё ушло из списка", !(r.checks.find((c) => c.id === "raw_no_cost").rows || []).some((x) => x.code === raw), null);
  await call("office_user_save", { token: t, login: "zz_test_q", name: "ZZ_TEST_Кладовщик готовности", role: "storekeeper", pin: "4321" });
  const u = await call("office_login", { login: "zz_test_q", pin: "4321" }); await call("office_change_pin", { token: u.token, pin: "4321" });
  r = await call("office_stock_quality_report", { token: u.token });
  check("готовность: кладовщик видит отчёт без проверки пользователей", r.ok && !r.checks.some((c) => c.id === "users"), r.checks && r.checks.map((c) => c.id));
};

// Отложенные замечания подпроекта 1 (миграция 0026): поиск без «жокеров», часть БИН и телефон,
// очистка цены, цикл групп, обрыв сессий при смене роли.
SECTIONS.polish = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_ИП Поиск", kind: "supplier", bin: "990101123456", phone: "+7 (701) 555-12-34" });
  check("поиск: контрагент заведён", r.ok, r);
  r = await call("office_counteragents_list", { token: t, q: "0101123" });
  check("поиск: контрагент по части БИН", r.ok && r.rows.some((x) => x.name === "ZZ_TEST_ИП Поиск"), r.total);
  r = await call("office_counteragents_list", { token: t, q: "87015551234" });
  check("поиск: контрагент по телефону в другом написании", r.ok && r.rows.some((x) => x.name === "ZZ_TEST_ИП Поиск"), r.total);
  r = await call("office_counteragents_list", { token: t, q: "%" });
  check("поиск: «%» ищется буквально, а не как «всё»", r.ok && r.total === 0, r.total);
  r = await call("office_items_search", { token: t, q: "мука%", page: 1 });
  check("поиск: «мука%» в номенклатуре — буквально, ничего не находит", r.ok && r.total === 0, r.total);

  r = await call("office_item_save", { token: t, name: "ZZ_TEST_цена", item_type: "goods", unit_id: "шт", price: 100 });
  const code = r.code;
  r = await call("office_item_save", { token: t, code, name: "ZZ_TEST_цена", price: "" });
  r = await call("office_item_get", { token: t, code });
  check("позиция: пустая цена очищает цену по умолчанию", r.ok && r.item.price === null, r.item && r.item.price);
  r = await call("office_item_save", { token: t, code, note: "без цены в запросе" });
  r = await call("office_item_save", { token: t, code, price: 250 });
  r = await call("office_item_save", { token: t, code, note: "правка без цены" });
  r = await call("office_item_get", { token: t, code });
  check("позиция: правка без ключа цены цену не трогает", r.ok && Number(r.item.price) === 250, r.item && r.item.price);

  r = await call("office_group_save", { token: t, name: "ZZ_TEST_группа А" }); const gA = r.id;
  r = await call("office_group_save", { token: t, name: "ZZ_TEST_группа Б", parent_id: gA }); const gB = r.id;
  r = await call("office_group_save", { token: t, id: gA, name: "ZZ_TEST_группа А", parent_id: gB });
  check("группы: родителем нельзя сделать свою подгруппу", r.ok === false && r.error === "validation", r);
  r = await call("office_group_save", { token: t, id: gA, name: "ZZ_TEST_группа А", parent_id: gA });
  check("группы: группа не может быть родителем самой себе", r.ok === false && r.error === "validation", r);

  r = await call("office_user_save", { token: t, login: "zz_test_role", name: "ZZ_TEST_Роль", role: "storekeeper", pin: "4321" });
  const uid = r.id;
  const u = await call("office_login", { login: "zz_test_role", pin: "4321" });
  await call("office_change_pin", { token: u.token, pin: "4321" });
  r = await call("office_me", { token: u.token });
  check("сессии: пользователь в системе", r.ok, r);
  await call("office_user_save", { token: t, id: uid, login: "zz_test_role", name: "ZZ_TEST_Роль", role: "accountant" });
  r = await call("office_me", { token: u.token });
  check("сессии: смена роли выкидывает пользователя — войти заново с новыми правами", r.ok === false && r.error === "unauthorized", r);
  // Смена своего PIN закрывает остальные сессии пользователя, текущая остаётся (миграция 0030).
  await call("office_user_save", { token: t, login: "zz_test_pin2", name: "ZZ_TEST_Две сессии", role: "storekeeper", pin: "4321" });
  const sA = await call("office_login", { login: "zz_test_pin2", pin: "4321" });
  await call("office_change_pin", { token: sA.token, pin: "4321" });
  const sB = await call("office_login", { login: "zz_test_pin2", pin: "4321" });
  r = await call("office_change_pin", { token: sA.token, pin: "5678" });
  r = await call("office_me", { token: sA.token });
  check("сессии: после смены PIN текущая сессия жива", r.ok, r);
  r = await call("office_me", { token: sB.token });
  check("сессии: после смены PIN вторая сессия закрыта", r.ok === false && r.error === "unauthorized", r);
};

// migrate и reimport требуют TANDEM_OWNER_PIN и в "all" входят только при его наличии;
// любой раздел кроме auth/migrate сначала прогоняет auth — ему нужен токен.
const NEEDS_OWNER = ["migrate", "reimport", "gate"];
let names = section === "all"
  ? Object.keys(SECTIONS).filter((n) => !NEEDS_OWNER.includes(n) || (process.env.TANDEM_OWNER_PIN && process.env.TANDEM_SERVICE_KEY))
  : [section];
// gate запирает вход по коду служебной точки — он обязан идти последним.
if (names.includes("gate")) names = [...names.filter((n) => n !== "gate"), "gate"];
if (!names.includes("auth") && names.some((n) => n !== "migrate")) names = ["auth", ...names];
for (const n of names) {
  if (!SECTIONS[n]) { console.log("нет раздела " + n); process.exit(2); }
  console.log("\n== " + n);
  await SECTIONS[n](ctx);
}

// Уборка: тестовые записи не должны пережить прогон.
if (process.env.TANDEM_SERVICE_KEY) {
  console.log("\n== очистка");
  const r = await call("test_cleanup", {});
  check("очистка: следов нет", r.ok && r.leftovers === 0, r);
} else {
  console.log("\n== очистка пропущена: задайте TANDEM_SERVICE_KEY, чтобы убрать записи ZZ_TEST_/zz_test_");
}

console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
