// Дымовой тест RPC бэк-офиса.
// Запуск: node tools/office-smoke.mjs <auth|nomenclature|stores|counteragents|users|charts|training|migrate|reimport|all>
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
const SERVICE = new Set(["migrate", "test_cleanup", "sync_items", "sync_prices", "recalc_ranks", "set_packaging", "set_short_list",
  "bot_menu", "bot_order_quote", "bot_order_create", "bot_order_events", "bot_order_get", "bot_order_cancel", "bot_card_status", "bot_client_history"]);
export async function call(action, payload) {
  payload = payload || {};
  if (SERVICE.has(action) && !("service_key" in payload)) {
    const key = action.startsWith("bot_") && process.env.TANDEM_BOT_KEY ? process.env.TANDEM_BOT_KEY : process.env.TANDEM_SERVICE_KEY;
    payload = { ...payload, service_key: key || "" };
  }
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
// PIN тестовых пользователей — случайный на каждый прогон: код теста лежит в публичном репозитории,
// и известный PIN у недоубранного пользователя был бы входом в боевой бэк-офис (ревью, находка 30).
// Шесть цифр: администратору и собственнику короче нельзя (0042).
const rnd6 = () => String(100000 + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const TP = rnd6(); let TP2 = rnd6(); while (TP2 === TP) TP2 = rnd6();
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
  check("смена PIN без текущего PIN — отказ (0042)", r.ok === false && r.error === "validation", r);
  r = await call("office_change_pin", { token: ctx.token, old_pin: "0" + ctx.pin, pin: ctx.pin });
  check("смена PIN с неверным текущим — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_change_pin", { token: ctx.token, old_pin: ctx.pin, pin: ctx.pin });
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
  // ролей пять основных и smm (0061, раздел «Заявки WhatsApp» бота)
  check("пользователи: список", r.ok && r.users.some((u) => u.login === "admin")
    && ["admin", "owner", "accountant", "technologist", "storekeeper"].every((x) => r.roles.includes(x)), r);
  const me = r.users.find((u) => u.login === ctx.login);
  // «Последнего администратора нельзя понизить» проверяется, только если он и правда последний. В рабочей базе
  // администраторов два (admin и andrey): понижение проходит, и 22.11.2026 тест на её копии понизил admin до
  // собственника - на живой базе (smoke-live.ps1) было бы то же самое. Вернуть роль после понижения тест не может:
  // собственник администратора не назначает.
  const admins = r.users.filter((u) => u.role === "admin" && u.active !== false && !u.training);
  if (admins.length === 1 && admins[0].login === ctx.login) {
    r = await call("office_user_save", { token: t, id: me.id, login: me.login, name: me.name, role: "owner" });
    check("последнего администратора нельзя понизить — validation", r.ok === false && r.error === "validation", r);
  } else {
    console.log(`  skip последнего администратора нельзя понизить — администраторов ${admins.length}, понижать не стал`);
  }
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: TP });
  check("пользователь: создание", r.ok && r.id, r);
  const uid = r.id;
  r = await call("office_user_save", { token: t, login: "zz_test_sklad", name: "дубль", role: "storekeeper", pin: TP });
  check("дубль логина — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_user_save", { token: t, login: "zz_test_x", name: "x", role: "storekeeper" });
  check("без PIN при создании — validation", r.ok === false && r.error === "validation", r);
  // права кладовщика
  r = await call("office_login", { login: "zz_test_sklad", pin: TP });
  check("кладовщик входит", r.ok && r.user.role === "storekeeper" && r.must_change_pin === true, r);
  const st = r.token;
  r = await call("office_change_pin", { token: st, pin: TP });
  check("кладовщик снял временный PIN", r.ok && r.must_change_pin === false, r);
  r = await call("office_items_search", { token: st, q: "мука" });
  check("кладовщик видит номенклатуру", r.ok, r);
  r = await call("office_item_save", { token: st, name: "ZZ_TEST_нельзя", item_type: "goods", unit_id: "кг" });
  check("кладовщик не правит номенклатуру — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_users_list", { token: st });
  check("кладовщик не видит пользователей — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_user_reset_pin", { token: t, id: uid, pin: TP2 });
  check("сброс PIN администратором", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: TP2 });
  check("вход с новым PIN", r.ok, r);
  // Блокировка не выдаёт себя чужому: пока логин заблокирован, неверный PIN получает тот же
  // ответ, что и всегда; о блокировке узнаёт только тот, кто знает PIN.
  for (let i = 0; i < 5; i++) r = await call("office_login", { login: "zz_test_sklad", pin: "0000" });
  r = await call("office_login", { login: "zz_test_sklad", pin: "0000" });
  check("заблокирован, неверный PIN — обычный ответ", r.ok === false && r.error === "unauthorized" && /^Неверный логин или PIN/.test(r.message), r);
  const lockedWrong = r.message;
  const nobody = await call("office_login", { login: "zz_test_nobody", pin: "0000" });
  check("несуществующий логин — тот же ответ", nobody.ok === false && nobody.message === r.message, nobody);
  r = await call("office_login", { login: "zz_test_sklad", pin: TP2 });
  // Ответ на верный PIN во время блокировки обязан совпадать с ответом на неверный:
  // иначе перебор узнаёт PIN по тексту ответа, не дожидаясь конца блокировки.
  check("заблокирован, верный PIN — тот же ответ, что на неверный", r.ok === false && r.error === "unauthorized" && r.message === lockedWrong, r);
  r = await call("office_user_reset_pin", { token: t, id: uid, pin: TP2 });
  check("сброс PIN снимает блокировку", r.ok, r);
  r = await call("office_user_save", { token: t, id: uid, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", active: false });
  check("деактивация", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: TP2 });
  check("выключенный не входит", r.ok === false && r.error === "unauthorized", r);

  // --- матрица ролей: каждая роль видит ровно то, что записано в role_permissions ---
  // Ожидания взяты из спецификации 3.5 и обязаны совпасть с содержимым таблицы.
  // Раздел charts добавлен миграцией 0010 (техкарты): технолог правит, бухгалтер только смотрит.
  // Миграция 0015 (склад) добавила раздел stock всем ролям и права по типам документов
  // doc:<тип>: бухгалтеру только приход, технологу только производство.
  // Миграция 0049 добавила раздел clients (заказы клиентов): смотреть — собственник, администратор, технолог, бухгалтер; править — без бухгалтера.
  const MATRIX = {
    zz_test_owner: { role: "owner", name: "ZZ_TEST_Собственник",
      perms: ["charts:edit", "charts:view", "clients:edit", "clients:view", "counteragents:edit", "counteragents:view",
        "doc:inventory:edit", "doc:inventory:view", "doc:invoice_in:edit", "doc:invoice_in:view",
        "doc:invoice_out:edit", "doc:invoice_out:view",   // 0071: расходная накладная
        "doc:production:edit", "doc:production:view", "doc:transfer:edit", "doc:transfer:view",
        "doc:sale:edit", "doc:sale:view", "doc:writeoff:edit", "doc:writeoff:view",
        "nomenclature:edit", "nomenclature:view", "stock:edit", "stock:view", "stores:edit", "stores:view",
        "users:edit", "users:view", "leads:view"] },   // leads:view - раздел «Заявки WhatsApp» (0061)
    zz_test_buh: { role: "accountant", name: "ZZ_TEST_Бухгалтер",
      perms: ["charts:view", "clients:view", "counteragents:edit", "counteragents:view",
        "doc:invoice_in:edit", "doc:invoice_in:view", "doc:invoice_out:edit", "doc:invoice_out:view",
        "doc:sale:edit", "doc:sale:view", "nomenclature:view", "stock:edit", "stock:view", "stores:view"] },
    // 0072: технолог-бухгалтер - технолог + кладовщик + бухгалтер, без пользователей, правки складов и заявок WhatsApp.
    zz_test_techbuh: { role: "techbuh", name: "ZZ_TEST_Технолог-бухгалтер",
      perms: ["charts:edit", "charts:view", "clients:edit", "clients:view", "counteragents:edit", "counteragents:view",
        "doc:inventory:edit", "doc:inventory:view", "doc:invoice_in:edit", "doc:invoice_in:view", "doc:invoice_out:edit", "doc:invoice_out:view",
        "doc:production:edit", "doc:production:view", "doc:sale:edit", "doc:sale:view", "doc:transfer:edit", "doc:transfer:view",
        "doc:writeoff:edit", "doc:writeoff:view", "nomenclature:edit", "nomenclature:view", "stock:edit", "stock:view", "stores:view"] },
    zz_test_tech: { role: "technologist", name: "ZZ_TEST_Технолог",
      perms: ["charts:edit", "charts:view", "clients:edit", "clients:view", "counteragents:view",
        "doc:production:edit", "doc:production:view", "doc:sale:view", "nomenclature:edit", "nomenclature:view",
        "stock:edit", "stock:view", "stores:view"] },
  };
  const same = (a, b) => Array.isArray(a) && a.length === b.length && a.slice().sort().join("|") === b.slice().sort().join("|");
  const ids = {};

  for (const [login, want] of Object.entries(MATRIX)) {
    r = await call("office_user_save", { token: t, login, name: want.name, role: want.role, pin: TP });
    check(`${want.role}: создан`, r.ok && r.id, r);
    ids[login] = r.id;
    r = await call("office_login", { login, pin: TP });
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
    r = await call("office_change_pin", { token: tok, pin: TP });
    check(`${want.role}: временный PIN снят`, r.ok && r.must_change_pin === false, r);
    r = await call("office_me", { token: tok });
    check(`${want.role}: права ровно по матрице`, same(r.permissions, want.perms), r.permissions);
    r = await call("office_users_list", { token: tok });
    if (want.role === "owner") {
      // Сборка 21 (0047): собственник сам заводит сотрудников, но учётные записи администратора не трогает.
      check("owner: видит пользователей", r.ok && Array.isArray(r.users), r.ok);
      const adm = (r.users || []).find((u) => u.role === "admin");
      const f = await call("office_user_save", { token: tok, login: "zz_test_adm_by_owner", name: "ZZ_TEST_Админ", role: "admin", pin: rnd6() });
      check("owner: администратора не заводит — forbidden", f.ok === false && f.error === "forbidden", f);
      if (adm) {
        const f2 = await call("office_user_reset_pin", { token: tok, id: adm.id, pin: rnd6() });
        check("owner: PIN администратору не сбрасывает — forbidden", f2.ok === false && f2.error === "forbidden", f2);
      }
    } else check(`${want.role}: пользователей не видит`, r.ok === false && r.error === "forbidden", r);
  }
  // выборочно проверяем, что право edit действительно работает и действительно отсутствует
  r = await call("office_login", { login: "zz_test_buh", pin: TP });
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
  r = await call("office_login", { login: "zz_test_owner", pin: TP });
  check("лок: шестая попытка с верным PIN отбита",
    r.ok === false && r.error === "unauthorized" && /15 минут/.test(r.message || ""), r);

  // сброс PIN администратором обязан снимать и сам лок, не только менять хэш
  r = await call("office_user_reset_pin", { token: t, id: ids.zz_test_owner, pin: TP });
  check("сброс PIN снимает блокировку", r.ok, r);
  r = await call("office_login", { login: "zz_test_owner", pin: TP });
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
  // Сборка 21 (0047): единственную версию карты удалить нельзя — тесто без карты, а пирожок его списывает.
  check("удаление единственной версии карты — отказ с объяснением", r.ok === false && r.error === "validation" && /единственная версия/i.test(r.message || ""), r);
  r = await call("office_chart_new_version", { token: t, code: testo, id: testoChart, date_from: "2026-06-01" });
  check("новая версия карты теста с 01.06.2026", r.ok, r);
  r = await call("office_chart_get", { token: t, code: testo });
  const lastVer = r.ok && (r.versions || []).find((v) => String(v.date_from) === "2026-06-01");
  r = lastVer ? await call("office_chart_delete", { token: t, id: lastVer.id }) : { ok: false, error: "нет версии" };
  check("удаление поздней версии (ранняя остаётся) — ok", r.ok, r);
  r = await call("office_chart_get", { token: t, code: testo });
  check("после удаления поздней версии карта теста на месте", r.ok && r.chart && r.chart.id === testoChart, r.chart && r.chart.id);
  // права кладовщика
  r = await call("office_user_save", { token: t, login: "zz_test_sklad_ch", name: "ZZ_TEST_Кладовщик", role: "storekeeper", pin: TP });
  let l = await call("office_login", { login: "zz_test_sklad_ch", pin: TP });
  await call("office_change_pin", { token: l.token, pin: TP });
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
  // Расход средней не меняет: после отмены прихода остаток стоит по прежней средней, разница уйдёт
  // в переоценку при следующем приходе (0041, stock_moves.adj).
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
  // Сумма строки — стоимость остатка (0041): после отмены прихода она не равна qty × средняя.
  const expSum = r.rows.reduce((s, x) => s + Number(x.sum), 0);
  check("остатки: итог = Σ стоимостей строк по выборке", r.ok && near(r.total_sum, expSum, 0.05) && r.total === r.rows.length, { total_sum: r.total_sum, expSum });
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
  r = await call("office_user_save", { token: t, login: "zz_test_sklad_s", name: "ZZ_TEST_Кладовщик склада", role: "storekeeper", pin: TP });
  check("кладовщик заведён", r.ok && r.id, r);
  const sk = await call("office_login", { login: "zz_test_sklad_s", pin: TP });
  await call("office_change_pin", { token: sk.token, pin: TP });
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
  r = await call("office_user_save", { token: t, login: "zz_test_tech_s", name: "ZZ_TEST_Технолог", role: "technologist", pin: TP });
  let l = await call("office_login", { login: "zz_test_tech_s", pin: TP }); await call("office_change_pin", { token: l.token, pin: TP });
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
  r = await call("office_user_save", { token: t, login: "zz_test_buh_s", name: "ZZ_TEST_Бухгалтер", role: "accountant", pin: TP });
  l = await call("office_login", { login: "zz_test_buh_s", pin: TP }); await call("office_change_pin", { token: l.token, pin: TP });
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
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-02-01", store_to: S, counteragent_id: SUP,
    lines: [{ item_code: muka, qty: 10, price: 100 }, { item_code: bar, qty: 5, price: 50 }] });
  await call("office_doc_post", { token: t, id: r.id });
  const bal = async (code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };
  const report = (date, sales, takeout) => call("save_report", { pin, point_id: "zz_test", date, comment: "ZZ_TEST_продажи",
    cash: 1000, sales: sales || [], takeout: takeout || [] });
  const list = async (date) => (await call("office_doc_sales_list", { token: t, date_from: date, date_to: date, point_id: "zz_test" })).rows || [];

  // 1. Отчёт: блюдо с картой, товар без карты, строка без кода, услуга — в склад идут только первые два.
  r = await report("2024-03-01", [{ item_code: blin, item_name: "блин", qty: 3, price: 500 },
    { item_code: bar, item_name: "батончик", qty: 2, price: 150 }, { item_code: "", item_name: "без кода", qty: 1, price: 10 },
    { item_code: svc, item_name: "услуга", qty: 1, price: 100 }]);
  check("продажи: отчёт точки сохранён", r.ok, r);
  let rows = await list("2024-03-01");
  check("продажи: по отчёту проведён документ ПД", rows.length === 1 && (rows[0] || {}).state === "posted" && /^ПД-2024-\d{6}$/.test((rows[0] || {}).number)
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
  r = await report("2024-03-01", [{ item_code: blin, item_name: "блин", qty: 3, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2024-03-01");
  check("продажи: повторное сохранение — тот же документ, остатки те же", (rows[0] || {}).doc_id === saleId && near(await bal(muka), 9.4), rows);
  // 3. Изменили количество — документ пересчитан.
  r = await report("2024-03-01", [{ item_code: blin, item_name: "блин", qty: 5, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2024-03-01");
  check("продажи: изменение отчёта пересчитывает продажу", (rows[0] || {}).doc_id === saleId && (rows[0] || {}).state === "posted" && near(await bal(muka), 9), { rows, muka: await bal(muka) });

  // 4. Руками продажу не трогают.
  r = await call("office_doc_unpost", { token: t, id: saleId });
  check("продажи: ручная отмена — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_delete", { token: t, id: saleId });
  check("продажи: ручное удаление — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, doc_type: "sale", doc_date: "2024-03-01", store_from: S, lines: [{ item_code: bar, qty: 1 }] });
  check("продажи: ручное создание — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, id: saleId, doc_type: "writeoff", doc_date: "2024-03-01", store_from: S, reason: "other", lines: [{ item_code: bar, qty: 1 }] });
  check("продажи: правка продажи через другой тип — отказ", r.ok === false, r);

  // 5. Продаж с кодом нет — документа нет; отчёт с продажей, а потом без неё — документ удалён.
  await report("2024-03-02", [{ item_code: bar, item_name: "батончик", qty: 1, price: 150 }]);
  check("продажи: второй день — свой документ", ((await list("2024-03-02"))[0] || {}).state === "posted" && near(await bal(bar), 2), await list("2024-03-02"));
  await report("2024-03-02", [{ item_code: "", item_name: "без кода", qty: 1, price: 10 }]);
  rows = await list("2024-03-02");
  check("продажи: продажи ушли из отчёта — документ удалён, остаток вернулся", (rows[0] || {}).state === "none" && !(rows[0] || {}).doc_id && near(await bal(bar), 3), rows);

  // 6. Точка без склада — документа нет; после привязки — пересчёт за период.
  await call("office_store_save", { token: t, id: S, name: "ZZ_TEST_склад продаж", point_id: null, is_default: false });
  await report("2024-03-03", [{ item_code: bar, item_name: "батончик", qty: 1, price: 150 }]);
  rows = await list("2024-03-03");
  check("продажи: точка без склада — «нет склада»", (rows[0] || {}).state === "no_store" && !(rows[0] || {}).doc_id, rows);
  await call("office_store_save", { token: t, id: S, name: "ZZ_TEST_склад продаж", point_id: "zz_test", is_default: true });
  r = await call("office_user_save", { token: t, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", pin: TP });
  const skl = await call("office_login", { login: "zz_test_sales_sk", pin: TP }); await call("office_change_pin", { token: skl.token, pin: TP });
  r = await call("office_doc_sales_sync", { token: skl.token, date_from: "2024-03-01", date_to: "2024-03-03", point_id: "zz_test" });
  check("продажи: кладовщик не пересчитывает — forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2024-03-01", date_to: "2024-03-03", point_id: "zz_test" });
  check("продажи: кладовщик видит список продаж", r.ok && r.rows.length === 3, r);
  r = await call("office_doc_sales_sync", { token: t, date_from: "2024-03-01", date_to: "2024-03-03", point_id: "zz_test" });
  check("продажи: пересчёт за период — третий день проведён", r.ok && r.counts.posted === 1 && r.counts.unchanged === 1 && r.counts.empty === 1, r);
  check("продажи: после пересчёта батончик списан", near(await bal(bar), 2), await bal(bar));

  // 7. Дашборд собственницы: расход сырья по карте на дату отчёта.
  r = await call("dashboard", { pin, from: "2024-03-01", to: "2024-03-03" });
  check("продажи: дашборд — расход муки по карте", r.ok && (r.raw_usage || []).some((x) => x.name === "ZZ_TEST_мука продаж" && near(x.amount, 1)), r.raw_usage);

  // 8. Инвентаризация после продажи: изменение отчёта задним числом не переписывает склад.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-03-05", store_from: S, lines: [{ item_code: muka, fact_qty: 9 }] });
  await call("office_doc_post", { token: t, id: r.id });
  await report("2024-03-01", [{ item_code: blin, item_name: "блин", qty: 1, price: 500 }, { item_code: bar, item_name: "батончик", qty: 2, price: 150 }]);
  rows = await list("2024-03-01");
  check("продажи: отчёт изменён после инвентаризации — пометка, склад не тронут",
    (rows[0] || {}).state === "locked" && /инвентаризац/i.test((rows[0] || {}).sync_note || "") && near(await bal(muka), 9), { rows, muka: await bal(muka) });

  // 9. Оборотная ведомость склада (как «Расширенная оборотно-сальдовая ведомость» iiko).
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2024-03-01", date_to: "2024-03-31" });
  const tm = (r.rows || []).find((x) => x.item_code === muka), tb = (r.rows || []).find((x) => x.item_code === bar);
  check("ведомость: мука — начало 10, продано 1, конец 9", r.ok && tm && near(tm.start_qty, 10) && near(tm.sales, 1) && near(tm.end_qty, 9)
    && near(tm.income, 0) && near(tm.end_sum, 900), tm);
  check("ведомость: батончик — начало 5, продано 3, конец 2", tb && near(tb.start_qty, 5) && near(tb.sales, 3) && near(tb.end_qty, 2), tb);
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2024-02-01", date_to: "2024-02-29" });
  const tf = (r.rows || []).find((x) => x.item_code === muka);
  check("ведомость: февраль — приход 10 по 100, начало 0", r.ok && tf && near(tf.start_qty, 0) && near(tf.income, 10) && near(tf.income_sum, 1000) && near(tf.end_qty, 10), tf);
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2024-03-31", date_to: "2024-03-01" });
  check("ведомость: перепутанный период — validation", r.ok === false && r.error === "validation", r);
  r = await call("office_stock_turnover_report", { token: skl.token, store_id: S, date_from: "2024-03-01", date_to: "2024-03-31" });
  check("ведомость: кладовщик без привязки видит склад", r.ok && r.rows.length >= 2, r);

  // 10. Ревью: продажа задним числом до инвентаризации не проводится — иначе двойное списание.
  // Сборка 21 (0045): мешает только опись, пересчитавшая то, что продажа спишет, — блин списывает муку,
  // а опись 05.03 пересчитала муку.
  await report("2024-03-04", [{ item_code: blin, item_name: "блин", qty: 1, price: 500 }]);
  rows = await list("2024-03-04");
  check("продажи: отчёт за день до инвентаризации пересчитанной позиции — не проведён, пометка, склад не тронут",
    (rows[0] || {}).state === "draft" && /инвентаризац/i.test((rows[0] || {}).sync_note || "") && near(await bal(muka), 9), { rows, muka: await bal(muka) });
  // 11. Блюдо без карты списывается как есть; появилась карта — пересчёт проводит заново.
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_оладьи", item_type: "dish", unit_id: "порц" }); const olad = r.code;
  await report("2024-03-06", [{ item_code: olad, item_name: "оладьи", qty: 2, price: 300 }]);
  rows = await list("2024-03-06");
  check("продажи: блюдо без карты — списано как есть, пометка",
    (rows[0] || {}).state === "posted" && /Без техкарты/.test((rows[0] || {}).sync_note || "") && near(await bal(olad), -2), { rows, olad: await bal(olad) });
  await call("office_chart_save", { token: t, code: olad, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  r = await call("office_doc_sales_sync", { token: t, date_from: "2024-03-06", date_to: "2024-03-06", point_id: "zz_test" });
  rows = await list("2024-03-06");
  check("продажи: карта появилась — пересчёт списал муку, пометка снята",
    r.ok && r.counts.posted === 1 && !(rows[0] || {}).sync_note && near(await bal(muka), 8.8) && near(await bal(olad), 0), { r, rows, muka: await bal(muka) });
  // 12. Кладовщик с привязкой к чужому складу не видит отчёты и деньги точки.
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_чужой склад" }); const OTHER = r.id;
  const sklId = (await call("office_users_list", { token: t })).users.find((u) => u.login === "zz_test_sales_sk").id;
  await call("office_user_save", { token: t, id: sklId, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", store_ids: [OTHER] });
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2024-03-01", date_to: "2024-03-06", point_id: "zz_test" });
  check("продажи: кладовщик чужого склада не видит отчёты точки", r.ok && r.rows.length === 0, r.rows && r.rows.length);
  await call("office_user_save", { token: t, id: sklId, login: "zz_test_sales_sk", name: "ZZ_TEST_Кладовщик продаж", role: "storekeeper", store_ids: [S] });
  r = await call("office_doc_sales_list", { token: skl.token, date_from: "2024-03-01", date_to: "2024-03-06", point_id: "zz_test" });
  check("продажи: кладовщик своего склада видит отчёты точки", r.ok && r.rows.length === 5, r.rows && r.rows.length);
  // 13. Отчёт «Продажи и себестоимость»: только проведённые продажи. День 1 — 5 блинов по 500
  // (мука 5×0,2 по 100) и 2 батончика по 150 (по 50), день 3 — батончик, день 6 — 2 оладьи по 300
  // (мука 2×0,1 по 100). День 4 не проведён (инвентаризация) и в отчёт не входит.
  r = await call("office_doc_sales_report", { token: t, date_from: "2024-03-01", date_to: "2024-03-06", point_id: "zz_test" });
  const mp = (r.points || []).find((x) => x.point_id === "zz_test") || {};
  const mb = (r.items || []).find((x) => x.item_code === blin) || {}, mo = (r.items || []).find((x) => x.item_code === olad) || {};
  check("продажи и себестоимость: по точке выручка 3550, себестоимость 270, фудкост 7,6 %",
    r.ok && near(mp.revenue, 3550) && near(mp.cost, 270) && near(mp.margin, 3280) && near(mp.foodcost_pct, 7.61, 0.01) && mp.docs === 3, mp);
  check("продажи и себестоимость: по позициям — блины 5 шт на 2500 с себестоимостью 100, оладьи 600/20",
    near(mb.qty, 5) && near(mb.revenue, 2500) && near(mb.cost, 100) && near(mo.revenue, 600) && near(mo.cost, 20), { mb, mo });
  r = await call("office_doc_sales_report", { token: skl.token, date_from: "2024-03-01", date_to: "2024-03-06" });
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
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-02-01", store_to: S, counteragent_id: SUP,
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
  check("сводка: неверные коды за сутки отдаются списком", r.ok && Array.isArray(r.pin_failures), r.pin_failures);
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

  // Отчёты (миграция 0037): закупки склада кассы и прибыль точки за сегодня.
  r = await call("office_stock_purchases_report", { token: t, store_id: S, date_from: "2024-02-01", date_to: "2024-02-01" });
  const sup = (r.suppliers || [])[0] || {}, ps = (r.items || []).find((x) => x.item_code === sok) || {};
  check("отчёты: закупки — поставщик 4000 ₸, сок 20 шт по 150", r.ok && r.suppliers.length === 1 && near(sup.sum, 4000) && sup.docs === 1 && near(ps.qty, 20) && near(ps.avg_price, 150), r);
  // С 0067 «Прибыль» без выбора точки не показывает служебные точки zz_* - служебную кассу выбираем явно (point_id).
  r = await call("office_stock_pnl_report", { token: t, date_from: day, date_to: day, point_id: "zz_kassa" });
  const pk = (r.rows || []).find((x) => x.point_id === "zz_kassa") || {};
  check("отчёты: прибыль точки — выручка 1400, себестоимость 2 сока и 0,2 кг муки = 320", r.ok && near(pk.revenue, 1400) && near(pk.cost, 320) && near(pk.writeoff, 0), pk);
};

// Заявки и план выпечки (миграция 0038): заявки служебных точек на послезавтра, план, факт выпуска,
// документы из плана, продажа готового с остатка точки. Настройки заявок сохраняются и возвращаются.
SECTIONS.orders = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (заявка подаётся кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  // День без настоящих заявок: создание документов берёт ВСЕ заявки дня, и тест не должен задеть
  // заявки настоящих точек (ревью, находка 39). Ищем такой день со послезавтра на неделю вперёд.
  let d = null, before = null;
  for (let k = 2; k <= 7 && !d; k++) {
    const c = new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
    const x = await call("office_stock_orders_report", { token: t, for_date: c });
    const real = !x.ok || x.locked || (x.docs || []).length > 0
      || (x.plan || []).some((it) => Object.keys(it.by_point || {}).some((pt) => !pt.startsWith("zz_")));
    if (!real) { d = c; before = x; }
  }
  if (!d) { console.log("  пропуск: на неделю вперёд нет дня без настоящих заявок"); return; }
  check("заявки: отчёт дня открывается", before.ok && before.open === true, before);
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_кухня заявок" }); const K = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад точки заявок", point_id: "zz_test", is_default: true }); const P = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы заявок", point_id: "zz_kassa", is_default: true }); const Q = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик заявок", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука заявок", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирожок заявок", item_type: "dish", unit_id: "шт", for_sale: true, price: 200 }); const pir = r.code;
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("заявки: подготовка — кухня, склады точек, мука, пирожок с картой", K && P && Q && muka && pir && r.ok, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-02-01", store_to: K, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 100 }] });
  await call("office_doc_post", { token: t, id: r.id });
  const bal = async (store, code) => { const b = await call("office_stock_balances", { token: t, store_id: store, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };
  try {
    // Общую настройку склада кухни тест не трогает: склад передаётся в сам вызов создания документов.
    r = await call("office_stock_orders_settings_save", { token: t, store_id: before.store_id || "", cutoff: "25:00" });
    check("заявки: неверное время отсечки — отказ", r.ok === false && r.error === "validation", r);
    const O = (point, lines) => call("order_save", { pin, point_id: point, for_date: d, sent_by: "ZZ_TEST", lines });
    r = await O("zz_test", [{ item_code: pir, qty: 1.5 }]);
    check("заявки: полтора пирожка — отказ, штучное целым", r.ok === false && /целым/.test(r.error), r);
    r = await O("zz_test", [{ item_code: muka, qty: 1 }]);
    check("заявки: сырьё (не в продаже) заказать нельзя", r.ok === false && /нет в продаже/.test(r.error), r);
    r = await call("order_save", { pin, point_id: "zz_test", for_date: "2020-01-01", lines: [{ item_code: pir, qty: 1 }] });
    check("заявки: на прошедший день — приём закрыт", r.ok === false && /закрыт/.test(r.error), r);
    r = await O("zz_test", [{ item_code: pir, qty: 10 }]);
    check("заявки: заявка точки принята и читается", r.ok && r.order && r.order.lines.length === 1 && near(r.order.lines[0].qty, 10), r);
    r = await O("zz_kassa", [{ item_code: pir, qty: 5 }]);
    r = await call("office_stock_orders_report", { token: t, for_date: d });
    const pl = (r.plan || []).find((x) => x.item_code === pir) || {};
    check("заявки: сводный план — 15 пирожков, по точкам 10 и 5", r.ok && near(pl.qty, 15) && near(pl.by_point.zz_test, 10) && near(pl.by_point.zz_kassa, 5) && pl.has_chart, pl);
    r = await call("office_stock_orders_fact_save", { token: t, for_date: d, rows: [{ item_code: pir, fact: 14 }] });
    check("заявки: факт выпуска сохранён", r.ok && near(((r.plan || []).find((x) => x.item_code === pir) || {}).fact, 14), r.plan);
    r = await call("office_stock_orders_fact_save", { token: t, for_date: d, rows: [{ item_code: pir, fact: "NaN" }] });
    check("заявки: выпуск не числом — отказ", r.ok === false && r.error === "validation", r);
    r = await call("office_stock_orders_fact_save", { token: t, for_date: d, rows: [{ item_code: pir, fact: 14 }, { item_code: pir, fact: 1 }] });
    check("заявки: повтор позиции в выпуске — отказ", r.ok === false && r.error === "validation", r);
    r = await call("office_stock_orders_docs_save", { token: t, for_date: d, store_id: K });
    check("заявки: до отсечки документы не создаются без подтверждения", r.ok === false && /ещё открыт/.test(r.message), r);
    r = await call("office_stock_orders_docs_save", { token: t, for_date: d, force: true, store_id: K });
    check("заявки: из плана созданы акт производства и два перемещения", r.ok && r.made === 3, r);
    r = await call("office_stock_orders_docs_save", { token: t, for_date: d, force: true, store_id: K });
    check("заявки: повторное создание документов не дублирует", r.ok && r.made === 0, r);
    const rep = await call("office_stock_orders_report", { token: t, for_date: d });
    check("заявки: день закрыт для правок, документы видны", rep.ok && rep.locked && rep.docs.length === 3 && rep.docs.every((x) => x.status === "draft"), rep.docs);
    r = await O("zz_test", [{ item_code: pir, qty: 11 }]);
    check("заявки: после передачи в производство заявку не изменить", r.ok === false && /передан/.test(r.error), r);
    const prod = rep.docs.find((x) => x.doc_type === "production"), toP = rep.docs.find((x) => x.source_id.endsWith("/zz_test")),
      toQ = rep.docs.find((x) => x.source_id.endsWith("/zz_kassa"));
    // Выпуск 14 на заявки 10 и 5 раскладывается пропорционально: 9,33 → 9 и 4,67 → 5.
    const gq = async (id) => ((await call("office_doc_get", { token: t, id })).doc.lines.find((l) => l.item_code === pir) || {}).qty;
    check("заявки: выпуск 14 разложен по точкам — 9 и 5", near(await gq(toP.id), 9) && near(await gq(toQ.id), 5), { p: await gq(toP.id), q: await gq(toQ.id) });
    r = await call("office_doc_post", { token: t, id: toP.id });
    check("заявки: перемещение раньше акта производства не проводится", r.ok === false && /производства/.test(r.message || ""), r);
    r = await call("office_doc_post", { token: t, id: prod.id });
    check("заявки: акт производства проведён — 14 пирожков, мука 10 − 1,4", r.ok && near(await bal(K, pir), 14) && near(await bal(K, muka), 8.6), { r, pir: await bal(K, pir), muka: await bal(K, muka) });
    r = await call("office_doc_post", { token: t, id: toP.id });
    check("заявки: перемещение на точку проведено — у точки 9 пирожков, на кухне 5", r.ok && near(await bal(P, pir), 9) && near(await bal(K, pir), 5), r);
    // Пирожок выпущен по плану — продаётся готовым: 12 проданных списывают 12 пирожков (минус 3), муку не трогают.
    r = await call("save_report", { pin, point_id: "zz_test", date: d, comment: "ZZ_TEST_заявки", cash: 2400,
      sales: [{ item_code: pir, item_name: "пирожок", qty: 12, price: 200 }] });
    check("заявки: выпущенное по плану продаётся готовым — списан сам пирожок, мука не тронута", r.ok && near(await bal(P, pir), -3) && near(await bal(P, muka), 0),
      { r: r.ok, pir: await bal(P, pir), muka: await bal(P, muka) });
    r = await call("office_stock_1c_report", { token: t, store_id: P, date_from: d, date_to: d });
    check("заявки: проданное готовым не попадает в «Расход для 1С»", r.ok && !(r.rows || []).some((x) => x.item_code === pir), r.rows);
  } finally {
    // настройку не меняли; на всякий случай возвращаем отсечку, если проверка выше вдруг её приняла
    await call("office_stock_orders_settings_save", { token: t, store_id: before.store_id || "", cutoff: before.cutoff || "20:00" });
  }
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

// Полное ревью (миграции 0041–0043): отчёт точки с «человеческими» числами, XSS в названии,
// отмена чека с причиной и открытие смены заново, ключ повтора документа, инвентаризация сегодняшним
// днём, переоценка проданного в минус, «готовым со склада», окно дат, ошибки ввода, номенклатура.
SECTIONS.review = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN"); return; }
  const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;
  const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // местная дата (UTC+5)
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад ревью" }); const S = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик ревью", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука ревью", item_type: "goods", unit_id: "кг", artikul: "ZZREV1" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_сыр ревью", item_type: "goods", unit_id: "кг", for_sale: true, price: 1000 }); const syr = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог ревью", item_type: "dish", unit_id: "шт", for_sale: true, price: 500 }); const pirog = r.code;
  r = await call("office_chart_save", { token: t, code: pirog, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.2, netto: 0.2, output: 0.2 }] });
  check("ревью: подготовка", S && SUP && muka && syr && pirog && r.ok, r);

  // Отчёт точки: «1,5», «12 500», пустые поля — сохраняется; мусор — понятная ошибка, а не 500.
  r = await call("save_report", { pin, point_id: "zz_test", date: "2024-04-01", comment: "ZZ_TEST_ревью", cash: "12 500", kaspi_qr: "",
    cash_counted: "", qr_statement: " 1 000,50", sales: [{ item_code: syr, item_name: "<img src=x onerror=alert(1)>", qty: "1,5", price: "1 000" }],
    expenses: [{ purpose: "пусто", amount: "" }] });
  check("ревью: отчёт с «12 500», «1,5» и пустыми полями сохранён", r.ok && near(r.report.cash, 12500) && r.report.cash_counted === null && near(r.report.qr_statement, 1000.5), r);
  r = await call("get_report", { pin, point_id: "zz_test", date: "2024-04-01" });
  const ln = (r.sales || [])[0] || {};
  check("ревью: название строки — из справочника, не присланная разметка", ln.item_name === "ZZ_TEST_сыр ревью" && near(ln.qty, 1.5) && (r.expenses || []).length === 0, r.sales);
  r = await call("save_report", { pin, point_id: "zz_test", date: "2024-04-01", cash: "abc" });
  check("ревью: мусор в сумме — понятная ошибка", r.ok === false && /Неверное число/.test(r.error || ""), r);

  // Касса: отмена — только с причиной; закрытая смена не правится, собственник открывает её заново.
  const day = today;
  const K = (action, p) => call(action, { pin, point_id: "zz_kassa", ...p });
  // раздел кассы мог уже закрыть смену учебной кассы сегодня — собственник открывает её заново
  await call("reopen_shift", { pin, point_id: "zz_kassa", date: day });
  const u1 = crypto.randomUUID();
  r = await K("check_save", { uid: u1, date: day, pay_kind: "cash", lines: [{ item_code: syr, qty: 5 }] });
  const okSave = r.ok;
  r = await K("check_save", { uid: u1, date: day, pay_kind: "kaspi_qr", lines: [{ item_code: syr, qty: 1 }] });
  check("ревью: чек 5000 исправлен на 1000", okSave && r.ok && r.check.edited && near(r.check.total, 1000), r);
  r = await K("check_void", { uid: u1, reason: "" });
  check("ревью: отмена чека без причины — отказ", r.ok === false && /причин/i.test(r.error || ""), r);
  r = await call("save_report", { pin, point_id: "zz_kassa", date: day, cash_open: 0, cash_handed: 0 });
  check("ревью: смена кассы закрыта", r.ok && r.report.closed_at, r);
  r = await K("check_void", { uid: u1, reason: "ZZ_TEST_ошибка" });
  check("ревью: отмена в закрытую смену — отказ", r.ok === false && /Смена закрыта/.test(r.error || ""), r);
  r = await call("reopen_shift", { pin: "0000", point_id: "zz_kassa", date: day });
  check("ревью: открыть смену заново не кодом собственника — отказ", r.ok === false, r);
  r = await call("reopen_shift", { pin, point_id: "zz_kassa", date: day });
  check("ревью: собственник открыл смену заново", r.ok === true, r);
  r = await K("check_void", { uid: u1, reason: "ZZ_TEST_ошибка" });
  check("ревью: после открытия смены чек отменён с причиной", r.ok === true, r);
  r = await call("dashboard", { pin, from: day, to: day });
  const v = (r.voids || []).find((x) => x.point_id === "zz_kassa" && x.kind === "void");
  check("ревью: сводка видит отмену — было 5000 наличными, причина", r.ok && v && near(v.first_total, 5000) && v.first_pay_kind === "cash" && v.reason === "ZZ_TEST_ошибка", { v, n: (r.voids || []).length });

  // Документ: ключ повтора — второй вызов с тем же ключом правит тот же черновик, а не создаёт второй.
  const key = crypto.randomUUID();
  const doc = { token: t, doc_type: "invoice_in", doc_date: today, store_to: S, counteragent_id: SUP, client_key: key, lines: [{ item_code: muka, qty: 10, price: 100 }] };
  const d1 = await call("office_doc_save", doc);
  const d2 = await call("office_doc_save", doc);
  check("ревью: повтор doc_save с тем же client_key — тот же документ", d1.ok && d2.ok && d1.id === d2.id, { d1, d2 });
  r = await call("office_doc_save", { ...doc, client_key: undefined, doc_date: "2030-01-01" });
  check("ревью: дата документа далеко в будущем — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { ...doc, client_key: undefined, lines: [{ item_code: muka, qty: -2, price: 100 }] });
  check("ревью: отрицательное количество — понятная ошибка с позицией", r.ok === false && r.error === "validation" && /мука ревью/.test(r.message || ""), r);
  r = await call("office_doc_post", { token: t, id: d1.id });
  check("ревью: приход сегодня 10 кг проведён", r.ok, r);
  // Инвентаризация сегодняшним днём видит приход этого же дня (проведённый до пересчёта).
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: today, store_from: S, lines: [{ item_code: muka, fact_qty: 8 }] });
  const inv = r.id;
  r = await call("office_doc_post", { token: t, id: inv });
  const bal = async (code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    return (b.rows || []).find((x) => x.item_code === code) || {}; };
  let b = await bal(muka);
  check("ревью: инвентаризация сегодня: расчёт 10 (с приходом дня), недостача 2, остаток 8", r.ok && near(r.total_sum, -200) && near(b.qty, 8), { r, b });
  r = await call("office_doc_unpost", { token: t, id: d1.id });
  check("ревью: приход того же дня после пересчёта не отменяется", r.ok === false && r.error === "validation", r);
  // Переоценка: продано в минус по 100, приход по 200 — средняя 200, сумма остатка = сумме движений.
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: today, store_from: S, reason: "other", lines: [{ item_code: muka, qty: 13 }] });
  await call("office_doc_post", { token: t, id: r.id });
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: today, store_to: S, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 200 }] });
  await call("office_doc_post", { token: t, id: r.id });
  b = await bal(muka);
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: today, date_to: today });
  const tr = (r.rows || []).find((x) => x.item_code === muka) || {};
  check("ревью: приход на минус — средняя 200, остаток 5 на 1000, переоценка −500 в оборотке",
    near(b.qty, 5) && near(b.avg_cost, 200) && near(b.sum, 1000) && near(tr.end_sum, 1000) && near(tr.reval_sum, -500), { b, tr });

  // «Готовым со склада»: строка ставится и снимается, ответ говорит, сколько продаж осталось пересчитать.
  r = await call("office_stock_ready_save", { token: t, store_id: S, item_code: pirog, date_from: today });
  check("ревью: строка «готовым» сохранена", r.ok && "remaining" in r, r);
  r = await call("office_stock_ready_list", { token: t, store_id: S });
  check("ревью: строка «готовым» в списке", r.ok && (r.rows || []).some((x) => x.item_code === pirog && x.source === "manual"), r.rows);
  r = await call("office_stock_ready_delete", { token: t, store_id: S, item_code: pirog });
  const after = await call("office_stock_ready_list", { token: t, store_id: S });
  check("ревью: строка «готовым» удалена", r.ok && !(after.rows || []).some((x) => x.item_code === pirog), r);

  // Номенклатура: артикул очищается; единицу позиции с движениями не сменить; дата версии — ГГГГ-ММ-ДД.
  r = await call("office_item_save", { token: t, code: muka, name: "ZZ_TEST_мука ревью", item_type: "goods", unit_id: "кг", artikul: "" });
  const it = await call("office_item_get", { token: t, code: muka });
  check("ревью: артикул очищен", r.ok && it.ok && !it.item.artikul, it.item && it.item.artikul);
  r = await call("office_item_save", { token: t, code: muka, name: "ZZ_TEST_мука ревью", item_type: "goods", unit_id: "шт" });
  check("ревью: единицу позиции с движениями сменить нельзя", r.ok === false && r.error === "validation" && /Единицу нельзя/.test(r.message || ""), r);
  r = await call("office_chart_new_version", { token: t, code: pirog, date_from: "01.10.2026" });
  check("ревью: дата версии карты не в формате ГГГГ-ММ-ДД — отказ", r.ok === false && r.error === "validation", r);
};

// Сборка 21 (миграции 0044–0047): то, что люди из iiko делают каждый день. Июнь 2024 — свой месяц
// раздела, чтобы суммы отчётов не смешивались с другими разделами.
SECTIONS.daily = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад дня" }); const S = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад ввода остатков" }); const S2 = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик дня", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_сахар дня", item_type: "goods", unit_id: "кг", artikul: "ZZDAY1" }); const A = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_соль дня", item_type: "goods", unit_id: "кг", artikul: "ZZDAY2" }); const B = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_сахарная булка дня", item_type: "dish", unit_id: "шт" }); const D = r.code;
  check("день: подготовка", S && S2 && SUP && A && B && D, { S, S2, SUP, A, B, D });

  // V: БИН — ровно 12 цифр.
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_БИН дня", kind: "supplier", bin: "12345678901" });
  check("день: БИН из 11 цифр — отказ", r.ok === false && r.error === "validation" && /12 цифр/.test(r.message || ""), r);

  // E: поиск позиции — по виду, по нескольким словам, сначала начало названия.
  r = await call("office_items_search", { token: t, q: "сахар ZZ_TEST", types: ["goods"], limit: 5 });
  check("день: поиск «сахар ZZ_TEST» среди товаров — сахар, без булки", r.ok && (r.rows || []).some((x) => x.code === A) && (r.rows || []).every((x) => x.item_type === "goods"), r.rows);
  r = await call("office_items_search", { token: t, q: "ZZ_TEST_сахар", limit: 5 });
  check("день: начало названия выше — «ZZ_TEST_сахар дня» перед булкой", r.ok && r.rows.length >= 2 && r.rows[0].code === A, (r.rows || []).map((x) => x.name));

  // Приход с № накладной поставщика; дубль; поиск журнала по номеру с бумаги; цена из прошлого прихода.
  const ext = "ZZ-" + rnd6();
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-03", store_to: S, counteragent_id: SUP, ext_number: ext,
    lines: [{ item_code: A, qty: 10, price: 100 }, { item_code: B, qty: 5, price: 50 }] }); const d1 = r.id;
  check("день: черновик прихода сохранён", r.ok, r);
  r = await call("office_docs_list", { token: t, q: ext, status: "draft" });
  check("день: у черновика прихода сумма по строкам (1250)", r.ok && near(((r.rows || []).find((x) => x.id === d1) || {}).total_sum, 1250), r.rows);
  r = await call("office_doc_post", { token: t, id: d1 });
  check("день: приход проведён, ready_new — пустой список", r.ok && Array.isArray(r.ready_new) && r.ready_new.length === 0, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-03", store_to: S, counteragent_id: SUP,
    ext_number: " " + ext.toLowerCase() + " ", lines: [{ item_code: A, qty: 1, price: 100 }] });
  check("день: тот же № накладной у поставщика — сохранено с dup_of", r.ok && r.dup_of && r.dup_of.id === d1, r);
  if (r.id) await call("office_doc_delete", { token: t, id: r.id });
  r = await call("office_docs_list", { token: t, q: ext.slice(3) });
  const jr = (r.rows || []).find((x) => x.id === d1) || {};
  check("день: журнал находит приход по № накладной, видно кто провёл", r.ok && jr.id === d1 && !!jr.posted_by_name, jr);
  r = await call("office_items_search", { token: t, q: "ZZ_TEST_сахар дня", types: ["goods"] });
  check("день: цена прошлого прихода — 100 от 03.06.2024", r.ok && near((r.rows[0] || {}).last_price, 100) && String((r.rows[0] || {}).last_price_date).startsWith("2024-06-03"), r.rows && r.rows[0]);

  // M: остаток после каждого движения.
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-04", store_to: S, counteragent_id: SUP, lines: [{ item_code: A, qty: 5, price: 120 }] }); const d3 = r.id;
  await call("office_doc_post", { token: t, id: d3 });
  r = await call("office_stock_moves", { token: t, store_id: S, item_code: A, page: 1 });
  check("день: движения сахара — сверху приход 04.06, остаток после 15", r.ok && near((r.rows[0] || {}).balance_after, 15) && near((r.rows[1] || {}).balance_after, 10), r.rows);

  // C: частичный пересчёт держит только пересчитанные позиции.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-06-05", store_from: S, lines: [{ item_code: A, fact_qty: 14 }] }); const inv = r.id;
  r = await call("office_doc_post", { token: t, id: inv });
  check("день: пересчёт только сахара — недостача 1 по средней 106,67", r.ok && near(r.total_sum, -106.67), r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-04", store_to: S, counteragent_id: SUP, lines: [{ item_code: B, qty: 3, price: 50 }] }); const dB = r.id;
  r = await call("office_doc_post", { token: t, id: dB });
  check("день: приход соли задним числом после пересчёта сахара — проводится", r.ok, r);
  r = await call("office_doc_unpost", { token: t, id: dB });
  check("день: и отменяется", r.ok, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-04", store_to: S, counteragent_id: SUP, lines: [{ item_code: A, qty: 1, price: 100 }] }); const dA = r.id;
  r = await call("office_doc_post", { token: t, id: dA });
  check("день: приход сахара задним числом — отказ с номером описи и названием", r.ok === false && r.error === "validation" && /ИН-/.test(r.message || "") && /сахар дня/.test(r.message || ""), r);
  await call("office_doc_delete", { token: t, id: dA });
  r = await call("office_doc_unpost", { token: t, id: d3 });
  check("день: отмена прихода сахара, вошедшего в пересчёт, — отказ", r.ok === false && r.error === "validation", r);

  // A1: излишек по цене строки описи; цена переживает проведение.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-06-06", store_from: S, lines: [{ item_code: B, fact_qty: 7, price: 70 }] }); const inv2 = r.id;
  r = await call("office_doc_post", { token: t, id: inv2 });
  check("день: излишек соли 2 по цене строки 70 — +140", r.ok && near(r.total_sum, 140), r);
  r = await call("office_doc_get", { token: t, id: inv2 });
  const l2 = ((r.doc || {}).lines || [])[0] || {};
  check("день: в проведённой описи цена строки 70 осталась", near(l2.price, 70) && near(l2.sum, 140), l2);

  // A2: ввод остатков — в остатках по цене файла, в прибыли его нет, в ведомости отдельной колонкой.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-06-01", store_from: S2, reason: "opening", lines: [{ item_code: A, fact_qty: 3, price: 200 }] }); const op = r.id;
  r = await call("office_doc_post", { token: t, id: op });
  check("день: ввод остатков 3 по 200 проведён", r.ok && near(r.total_sum, 600), r);
  r = await call("office_stock_turnover_report", { token: t, store_id: S2, date_from: "2024-06-01", date_to: "2024-06-30" });
  const to = (r.rows || []).find((x) => x.item_code === A) || {};
  check("день: ведомость — «ввод остатков» 3 на 600, в «Инвент. ±» не попал", r.ok && near(to.opening, 3) && near(to.opening_sum, 600) && near(to.inventory || 0, 0) && near(to.end_sum, 600), to);
  r = await call("office_stock_pnl_report", { token: t, date_from: "2024-06-01", date_to: "2024-06-30" });
  const np = (r.rows || []).find((x) => !x.point_id) || {};
  check("день: прибыль — только недостача 106,67 и излишек 140, ввода остатков нет", r.ok && near(np.shortage, 106.67) && near(np.surplus, 140) && near(np.inventory, 33.33), np);
  r = await call("office_doc_set_opening", { token: t, id: op, opening: false });
  const r2 = await call("office_doc_set_opening", { token: t, id: op, opening: true });
  check("день: пометку ввода остатков у проведённой описи можно снять и вернуть", r.ok && r2.ok, { r, r2 });
  r = await call("office_doc_set_opening", { token: t, id: d1, opening: true });
  check("день: у прихода пометки ввода остатков нет — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-03", store_to: S, counteragent_id: SUP, reason: "opening", lines: [{ item_code: A, qty: 1, price: 1 }] });
  check("день: «ввод остатков» у прихода — отказ", r.ok === false && r.error === "validation", r);
  // A3: новые причины списания.
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2024-06-07", store_from: S, reason: "defect", lines: [{ item_code: A, qty: 1 }] });
  check("день: списание с причиной «брак» сохраняется", r.ok, r);
  if (r.id) await call("office_doc_delete", { token: t, id: r.id });

  // R6: новые проверки готовности.
  r = await call("office_stock_quality_report", { token: t });
  check("день: в «Готовности» есть проверки привязки склада и фудкоста", r.ok && r.checks.some((c) => /не привязан/i.test(c.title)) && r.checks.some((c) => /фудкост/i.test(c.title)), (r.checks || []).map((c) => c.title));

  // FB: замечания из бэк-офиса и с экрана по коду.
  r = await call("office_feedback_save", { token: t, message: "ZZ_TEST_замечание дымового теста", page: "smoke", source: "office", context: { build: 21, screen: "дымовой тест" } });
  const fid = r.id;
  check("замечание: записано из бэк-офиса", r.ok && fid, r);
  r = await call("office_feedback_list", { token: t, status: "new" });
  check("замечание: в списке новых", r.ok && (r.rows || []).some((x) => x.id === fid && x.source === "office"), r.new);
  r = await call("office_feedback_done", { token: t, id: fid, done: true, answer: "ZZ_TEST_разобрано" });
  const fl = await call("office_feedback_list", { token: t });
  check("замечание: отмечено «разобрано» с ответом", r.ok && (fl.rows || []).some((x) => x.id === fid && x.status === "done" && x.answer === "ZZ_TEST_разобрано"), r);
  r = await call("office_feedback_save", { token: t, message: "   " });
  check("замечание: пустое — отказ", r.ok === false, r);
  r = await call("feedback", { pin: "0000", point_id: "zz_test", source: "point", message: "ZZ_TEST_чужой код" });
  check("замечание: с неверным кодом точки — «Нет доступа»", r.ok === false && r.error === "Нет доступа", r);
  if (pin) {
    r = await call("feedback", { pin, source: "owner", message: "ZZ_TEST_замечание собственника", page: "index.html", context: { screen: "сводка" } });
    check("замечание: кодом собственника — записано", r.ok && r.id, r);
    // P: сводка собственника — чеки и средний чек.
    const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
    r = await call("dashboard", { pin, from: today, to: today });
    check("сводка: блок чеков есть", r.ok && Array.isArray(r.checks), r.ok ? Object.keys(r) : r);
  }
};

// --- разделы добавляются здесь ---

// Ревизия 22.11.2026, участок «Касса и фискальный чек» (миграция 0065, fiscal.js и webkassa.js): «неизвестно, пробит ли»
// (Webkassa не ответила) - правка закрыта, повтор находит чек по коду 14, отмена - через проверку в Webkassa; отказ Webkassa -
// правка открыта; «пробивается» - второй запрос и правка ждут; изъятие без ответа - повтор тем же номером, не задваивает;
// журнал размена и изъятий дня; предупреждение Z о не пробитых возвратах; сумма весового - в тиынах, как в учёте.
// Сбои даёт имитация Webkassa прокси (WEBKASSA_MODE=sim, сборка с 0065) по тиынам суммы: ,77 - ответ потерян, ,78 - отказ,
// ,79 - ответ через 3 с. Без такой имитации (Webkassa настоящая или прокси старой сборки) проверки сбоев пропускаются.
SECTIONS.rev_kassa = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (чек пробивается кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const K = (action, p) => call(action, { pin, point_id: "zz_kassa", ...p });
  const uid = () => crypto.randomUUID();
  const fis = async (u) => { const c = ((await K("check_list", { date: day })).checks || []).find((x) => x.uid === u) || {}; c.fiscal = c.fiscal || {}; return c; };
  let r = await K("fiscal_x", {});
  if (!r.ok) { console.log("  пропуск: у zz_kassa нет фискального чека или Webkassa не отвечает - " + (r.error || r.message)); return; }
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_товар фискальной кассы", item_type: "goods", unit_id: "шт", for_sale: true, price: 150 }); const sok = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_весовой фискальной кассы", item_type: "goods", unit_id: "кг", for_sale: true, price: 985 }); const ves = r.code;
  check("касса+налоговая: подготовка - штучный и весовой товар", sok && ves, r);
  // Не пробитые чеки прошлых разделов (касса, заказы) - пробить, иначе Z-отчёт ниже не снимется
  for (const c of ((await K("check_list", { date: day })).checks || [])) {
    const f = c.fiscal || {};
    if (c.status === "active" && Number(c.total) > 0 && !["ok", "off"].includes(f.status)) await K("fiscal_check", { uid: c.uid });
  }

  // 1. Обычный чек: пробит; повтор не пробивает второй; весовой - сумма в тиынах как в учёте (0,565 × 985 = 556,53)
  const u1 = uid();
  r = await K("check_save", { uid: u1, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: ves, qty: 0.565 }] });
  check("касса+налоговая: весовой 0,565 кг × 985 - в учёте 556,53 (касса считает так же, в тиынах)", r.ok && near(r.check.total, 556.53), r.check);
  r = await K("fiscal_check", { uid: u1 });
  const fp1 = r.ok && r.fiscal && r.fiscal.number;
  check("касса+налоговая: чек пробит", !!fp1, r);
  r = await K("fiscal_check", { uid: u1 });
  check("касса+налоговая: повтор - тот же фискальный признак", r.ok && r.fiscal && r.fiscal.number === fp1, r);
  r = await K("fiscal_print", { uid: u1 });
  const sim = r.ok && (r.lines || []).some((l) => /ИМИТАЦИЯ WEBKASSA/.test(l));
  if (!sim) console.log("  пропуск проверок сбоев: нет имитации Webkassa с памятью (настоящая Webkassa или прокси до 0065)");
  r = await K("check_save", { uid: u1, date: day, pay_kind: "card", lines: [{ item_code: ves, qty: 0.565 }] });
  check("касса+налоговая: пробитый чек не правится", r.ok === false && /^Чек уже пробит в налоговой/.test(r.error || ""), r);

  if (sim) {
    // 2. Ответ Webkassa потерялся: «неизвестно, пробит ли», правка закрыта, повтор находит чек (код 14)
    const u2 = uid();
    r = await K("check_save", { uid: u2, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 100.77 }] });
    r = await K("fiscal_check", { uid: u2 });
    check("касса+налоговая: обрыв - «неизвестно, пробит ли», а не «не пробит»", r.ok === false && r.unknown && /^Неизвестно, пробит ли/.test(r.error || "")
      && (await fis(u2)).fiscal.status === "unknown", r);
    r = await K("check_save", { uid: u2, date: day, pay_kind: "card", lines: [{ item_code: sok, qty: 2, price: 100.77 }] });
    check("касса+налоговая: такой чек не исправить", r.ok === false && /^Неизвестно, пробит ли чек/.test(r.error || ""), r);
    r = await K("fiscal_check", { uid: u2 });
    check("касса+налоговая: повтор - чек найден в Webkassa и записан пробитым", r.ok && r.fiscal && r.fiscal.status === "ok" && r.fiscal.number, r);
    // 3. Отмена «неизвестно, пробит ли»: сначала проверка в Webkassa, возврат - только если продажа там есть
    const u3 = uid();
    await K("check_save", { uid: u3, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 200.77 }] });
    await K("fiscal_check", { uid: u3 });
    r = await K("check_void", { uid: u3, reason: "ZZ_TEST_проверка" });
    let c = await fis(u3);
    check("касса+налоговая: отмена «неизвестно» - возврат ждёт проверки (check)", r.ok && c.fiscal.return_status === "check", c.fiscal);
    r = await K("fiscal_check", { uid: u3, op: "return" });
    c = await fis(u3);
    check("касса+налоговая: проверка нашла продажу в Webkassa - записана пробитой, возврат пробивался", c.fiscal.status === "ok" && c.fiscal.number
      && c.fiscal.return_status === "error" && /потерянного ответа/.test(c.fiscal.return_error || ""), c.fiscal);   // сумма ,77 - и у возврата ответ «потерян»
    r = await K("fiscal_check", { uid: u3, op: "return" });
    c = await fis(u3);
    check("касса+налоговая: повтор возврата - найден по коду 14, пробит", r.ok && c.fiscal.return_status === "ok" && c.fiscal.return_number, c.fiscal);
    // 4. Отказ Webkassa: «не пробит», правка открыта, после правки пробивается
    const u4 = uid();
    await K("check_save", { uid: u4, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 100.78 }] });
    r = await K("fiscal_check", { uid: u4 });
    check("касса+налоговая: отказ Webkassa - «не пробит» (error), не «неизвестно»", r.ok === false && !r.unknown && (await fis(u4)).fiscal.status === "error", r);
    r = await K("check_save", { uid: u4, date: day, pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 100 }] });
    check("касса+налоговая: чек с отказом исправляется", r.ok && near(r.check.total, 100), r);
    r = await K("fiscal_check", { uid: u4 });
    check("касса+налоговая: исправленный - пробит", r.ok && r.fiscal && r.fiscal.status === "ok", r);
    // 5. Чек пробивается: второй запрос, правка и отмена ждут ответа
    const u5 = uid();
    await K("check_save", { uid: u5, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 100.79 }] });
    const slow = K("fiscal_check", { uid: u5 });
    await new Promise((ok) => setTimeout(ok, 1000));
    r = await K("fiscal_check", { uid: u5 });
    check("касса+налоговая: второй запрос на пробивающийся чек - «пробивается», в Webkassa не уходит", r.ok === false && r.busy, r);
    r = await K("check_save", { uid: u5, date: day, pay_kind: "card", lines: [{ item_code: sok, qty: 1, price: 100.79 }] });
    check("касса+налоговая: пробивающийся чек не правится", r.ok === false && /^Чек пробивается в налоговой/.test(r.error || ""), r);
    r = await K("check_void", { uid: u5, reason: "ZZ_TEST_проверка" });
    check("касса+налоговая: и не отменяется, пока ждём ответ", r.ok === false && /пробивается/.test(r.error || ""), r);
    r = await slow;
    check("касса+налоговая: первый запрос пробил чек", r.ok && r.fiscal && r.fiscal.status === "ok", r);
    // 6. Изъятие без ответа Webkassa: «неизвестно, прошла ли»; повтор с тем же номером проведён один раз
    const ext = uid(), started = Date.now();
    r = await K("fiscal_money", { kind: "in", sum: 1000.77, reason: "Размен", seller: "ZZ_TEST_продавец", ext });
    check("касса+налоговая: внесение без ответа - network и «неизвестно, прошла ли»", r.ok === false && r.network && /неизвестно, прошла ли/.test(r.error || ""), r);
    r = await K("fiscal_money", { kind: "in", sum: 1000.77, reason: "Размен", seller: "ZZ_TEST_продавец", ext });
    check("касса+налоговая: повтор тем же номером - проведено (код 14 - уже было)", r.ok, r);
    r = await K("fiscal_journal", { date: day });
    const rows = (r.journal || []).filter((m) => near(m.sum, 1000.77) && m.kind === "in" && Date.parse(m.at) > started - 5000);
    check("касса+налоговая: журнал дня - одно внесение, проведено", r.ok && rows.length === 1 && rows[0].ok, r.journal);
    r = await call("fiscal_journal", { pin: "0000", point_id: "zz_kassa", date: day });
    check("касса+налоговая: журнал без кода точки - отказ", r.ok === false && r.error === "Нет доступа", r);
  }
  // 7. Z: не пробитый возврат - предупреждение (сервер с 0065), Z снимается
  const u7 = uid();
  await K("check_save", { uid: u7, date: day, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
  await K("fiscal_check", { uid: u7 });
  await K("check_void", { uid: u7, reason: "ZZ_TEST_проверка" });
  r = await K("fiscal_z", { date: day, seller: "ZZ_TEST_продавец" });
  check("касса+налоговая: Z при не пробитом возврате - снят" + (sim ? ", с предупреждением" : ""), r.ok && (!sim || /возвраты - \d+/.test(r.warn || "")), r);
  r = await K("fiscal_check", { uid: u7, op: "return" });
  check("касса+налоговая: возврат пробит после Z", r.ok && r.fiscal && r.fiscal.return_status === "ok", r);
};

// Ревизия 22.11.2026, участок «Точка, заявки, заказы клиентов, ежедневные операции» (миграция 0066): список точек для
// входа без zz_* и учебные - только в режиме обучения (5); сводка собственника (only_real) без учебных и zz_*, данные для
// флага «позиции против выручки» (4, 9); подсказки незакрытой смены и несданного вчерашнего отчёта (11); окно дат отчёта
// для кода точки (12); заявка только из меню точки (13); план выпечки без учебных точек, учебной учётке - только они (3, 18);
// «Акт по заказам клиентов» - кладовщику (7); стоп-лист бота - только точке выдачи (14); развоз: отказ нулевой записи и
// отмены без причины (15); правка заказа клиента - только изменённое, по прежней цене (8); незакрытые заказы дальше 14
// дней (17). Свой месяц - май 2024, заявки - через 30 дней.
SECTIONS.rev_daily = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const iso = (k) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
  const ids = (r) => (Array.isArray(r) ? r.map((p) => p.id) : []);

  // 5: список точек для входа
  const legacy = ids(await call("points", {})), real = ids(await call("points", { training: false })), all = ids(await call("points", { training: true }));
  const trainIds = all.filter((x) => !real.includes(x));
  check("rev_daily 5: zz_* в списке входа нет ни в каком режиме", legacy.length && ![...legacy, ...real, ...all].some((x) => x.startsWith("zz_")), { legacy, real, all });
  check("rev_daily 5: вне обучения учебных точек нет, в обучении и у экрана без признака - есть",
    real.every((x) => all.includes(x)) && JSON.stringify(legacy) === JSON.stringify(all), { real, all, legacy });
  if (trainIds.length) {
    const keep = ids(await call("points", { training: false, keep: trainIds[0] }));
    check("rev_daily 5: точка этого телефона (keep) остаётся, другие учебные - нет",
      keep.includes(trainIds[0]) && trainIds.slice(1).every((x) => !keep.includes(x)), { keep, trainIds });
  }

  // справочники раздела: позиция в продаже без группы меню, сок для чека кассы
  let r = await call("office_item_save", { token: t, name: "ZZ_TEST_сок ревизии дня", item_type: "goods", unit_id: "шт", for_sale: true, price: 100 });
  const sok = r.code;
  check("rev_daily: подготовка", !!sok, r);

  // 4, 9: сводка - вызов без признака (тесты) видит zz_*, экран собственника (only_real) - нет; данные сверки позиций
  r = await call("save_report", { pin, point_id: "zz_test", date: "2024-05-08", comment: "ZZ_TEST_ревизия дня", cash: 1000,
    sales: [{ item_code: sok, item_name: "сок", qty: 50, price: 100 }] });
  check("rev_daily 9: отчёт с позициями 5000 при выручке 1000 сохранён", r.ok && near(r.report.sales_amount, 5000) && near(r.report.revenue_total, 1000), r.report);
  r = await call("dashboard", { pin, from: "2024-05-01", to: "2024-05-31" });
  check("rev_daily 4: без признака сводка видит отчёт zz_test (дымовые тесты)", r.ok && (r.rows || []).some((x) => x.point_id === "zz_test"), r.ok ? (r.rows || []).length : r);
  r = await call("dashboard", { pin, from: "2024-05-01", to: "2024-05-31", only_real: true });
  const bad4 = (x) => String(x).startsWith("zz_") || trainIds.includes(x);
  check("rev_daily 4: экран собственника - без zz_* и учебных во всех разделах", r.ok
    && !(r.rows || []).some((x) => bad4(x.point_id)) && !(r.points || []).some((x) => bad4(x.id)) && !(r.missing || []).some((x) => bad4(x.id))
    && !(r.checks || []).some((x) => bad4(x.point_id)) && !(r.voids || []).some((x) => bad4(x.point_id)) && !(r.pin_failures || []).some((x) => bad4(x.key)),
    r.ok ? { rows: (r.rows || []).map((x) => x.point_id), points: (r.points || []).map((x) => x.id) } : r);

  // 11: подсказки дня
  r = await call("get_report", { pin, point_id: "zz_test", date: "2024-05-10" });
  check("rev_daily 11: вчерашний (09.05) отчёт не сдан - prev_missing", r.ok && r.prev_missing === "2024-05-09" && r.open_shift === null, r);
  r = await call("get_report", { pin, point_id: "zz_test", date: "2024-05-10", brief: true });
  check("rev_daily 11: brief - только подсказки, без отчёта", r.ok && r.prev_missing === "2024-05-09" && !("report" in r), r);
  const d2 = iso(-2);
  r = await call("check_save", { pin, point_id: "zz_kassa", uid: crypto.randomUUID(), date: d2, pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
  const sh = await call("get_report", { pin, point_id: "zz_kassa", date: iso(0), brief: true });
  check("rev_daily 11: касса пробила чек позавчера и не закрыла смену - open_shift", r.ok && sh.ok && sh.open_shift >= d2 && sh.open_shift <= iso(-1), { r: r.ok, sh });
  r = await call("corder_list", { pin, point_id: "zz_kassa" });
  check("rev_daily 11, 14: список заказов кассы - та же подсказка и признак точки выдачи", r.ok && r.open_shift === sh.open_shift && r.pickup === true, { open_shift: r.open_shift, pickup: r.pickup });
  r = await call("save_report", { pin, point_id: "zz_kassa", date: d2, cash_open: 0, cash_handed: 0 });
  const sh2 = await call("get_report", { pin, point_id: "zz_kassa", date: iso(0), brief: true });
  check("rev_daily 11: смену закрыли - подсказки о ней нет", r.ok && r.report.closed_at && sh2.ok && sh2.open_shift !== d2, sh2);

  // 12: окно дат отчёта для кода точки (код учебной точки из учебных входов; пишется только отказ)
  const tg = await call("office_training_get", { token: t });
  const tp = tg.ok && tg.creds && tg.creds.point && tg.creds.point.pin ? tg.creds.point : null;
  if (tp) {
    r = await call("save_report", { pin: tp.pin, point_id: tp.point, date: "2030-01-01", cash: 1 });
    check("rev_daily 12: код точки, отчёт на 2030 год - отказ", r.ok === false && /не позже завтрашнего/.test(r.error || ""), r);
    r = await call("save_report", { pin: tp.pin, point_id: tp.point, date: "2023-12-31", cash: 1 });
    check("rev_daily 12: код точки, отчёт раньше 2024 года - отказ", r.ok === false && /не раньше 01\.01\.2024/.test(r.error || ""), r);
  } else console.log("  пропуск 12: обучение не настроено - нет кода точки");
  r = await call("save_report", { pin, point_id: "zz_test", date: "2030-01-01", comment: "ZZ_TEST_ревизия дня", cash: 1 });
  check("rev_daily 12: собственник исправляет любой день", r.ok === true, r);

  // 13, 3, 18: заявка только из меню точки; план настоящего пользователя - без учебных точек, учебной учётке - только они
  const day = iso(30);
  const tpoint = tp ? tp.point : trainIds.find((x) => x !== "ucheb_kassa") || trainIds[0];
  if (tpoint) {
    r = await call("order_save", { pin, point_id: tpoint, for_date: day, sent_by: "ZZ_TEST", lines: [{ item_code: sok, qty: 1 }] });
    const menuOk = (await call("items", { pin, point_id: tpoint })).items || [];
    if (!menuOk.some((x) => x.code === sok)) check("rev_daily 13: позиция не из меню точки - отказ", r.ok === false && /нет в меню точки/.test(r.error || ""), r);
    // позиция, которая есть и в меню учебной точки, и у zz_test (учебные позиции у zz_test в меню нет)
    const zzMenu = new Set(((await call("items", { pin, point_id: "zz_test" })).items || []).map((x) => x.code));
    const inMenu = menuOk.find((x) => zzMenu.has(x.code));
    try {
      if (inMenu) {
        r = await call("order_save", { pin, point_id: tpoint, for_date: day, sent_by: "ZZ_TEST", lines: [{ item_code: inMenu.code, qty: 1 }] });
        const z = await call("order_save", { pin, point_id: "zz_test", for_date: day, sent_by: "ZZ_TEST", lines: [{ item_code: inMenu.code, qty: 2 }] });
        const rep = await call("office_stock_orders_report", { token: t, for_date: day });
        const pl = (rep.plan || []).find((x) => x.item_code === inMenu.code) || {};
        check("rev_daily 3: план настоящего пользователя - без учебной точки", r.ok && z.ok && rep.ok && (rep.orders || []).some((o) => o.point_id === "zz_test")
          && !(rep.orders || []).some((o) => o.point_id === tpoint) && !(tpoint in (pl.by_point || {})) && near(pl.qty, 2), { orders: (rep.orders || []).map((o) => o.point_id), pl });
        r = await call("office_user_save", { token: t, login: "zz_test_train_rev", name: "ZZ_TEST_учебный кладовщик ревизии", role: "storekeeper", pin: TP, training: true });
        const tu = (await call("office_login", { login: "zz_test_train_rev", pin: TP })).token;
        const trep = await call("office_stock_orders_report", { token: tu, for_date: day });
        check("rev_daily 18: учебная учётка видит в плане только учебные точки", trep.ok && (trep.orders || []).length > 0
          && (trep.orders || []).every((o) => o.point_id === tpoint) && !(trep.client_orders || []).some((o) => !trainIds.includes(o.point_id)),
          trep.ok ? (trep.orders || []).map((o) => o.point_id) : trep);
      }
    } finally {
      await call("order_save", { pin, point_id: tpoint, for_date: day, sent_by: "ZZ_TEST", lines: [] });   // учебная заявка - не след теста
    }
  }

  // 7: «Акт по заказам клиентов» - действие склада: кладовщик может, бухгалтер (нет права акта) - нет
  const user = async (login, role) => {
    await call("office_user_save", { token: t, login, name: "ZZ_TEST_" + role, role, pin: TP });
    const lg = await call("office_login", { login, pin: TP });
    await call("office_change_pin", { token: lg.token, pin: TP });
    return lg.token;
  };
  r = await call("office_corder_docs_save", { token: await user("zz_test_sklad_rev", "storekeeper"), for_date: day });
  check("rev_daily 7: кладовщик создаёт акт по заказам клиентов", r.ok === true, r);
  r = await call("office_corder_docs_save", { token: await user("zz_test_buh_rev", "accountant"), for_date: day });
  check("rev_daily 7: без права акта производства - отказ", r.ok === false && r.error === "forbidden", r);

  // 14: меню бота и стоп-лист - только точке выдачи
  const cs = (await call("office_cmenu_list", { token: t })).settings || {};
  const pickupIds = String(cs.client_pickup_points || "eneshka").replace(/\s/g, "").split(",");
  const notPickup = real.find((x) => !pickupIds.includes(x));
  if (notPickup) {
    r = await call("corder_list", { pin, point_id: notPickup });
    check("rev_daily 14: касса не точки выдачи - признак pickup=false", r.ok && r.pickup === false, { pickup: r.pickup });
    r = await call("cmenu_point_list", { pin, point_id: notPickup });
    check("rev_daily 14: меню бота не точке выдачи - отказ", r.ok === false && r.error === "forbidden", r);
    r = await call("cmenu_stop", { pin, point_id: notPickup, item_code: "ZZ_TEST_нет", until: "" });
    check("rev_daily 14: стоп-лист не точке выдачи - отказ", r.ok === false && r.error === "forbidden", r);
  }
  r = await call("cmenu_stop", { pin, point_id: "zz_kassa", item_code: "ZZ_TEST_нет", until: "" });
  check("rev_daily 14: точке выдачи стоп-лист открыт (позиции нет - not_found)", r.ok === false && r.error === "not_found", r);

  // 15: развоз - отказы без записи (записи развоза уборка теста не трогает)
  const cl = (await call("realization", { pin, op: "list" })).clients || [];
  if (cl.length) {
    r = await call("realization", { pin, op: "add", data: { client_id: cl[0].id, delivered: 0, paid: "", returned: "0", note: "ZZ_TEST" } });
    check("rev_daily 15: запись развоза из одних нулей - отказ", r.ok === false && /хотя бы одну сумму/.test(r.error || ""), r);
  }
  r = await call("realization", { pin, op: "cancel", data: { id: 1 } });
  check("rev_daily 15: отмена без причины - отказ", r.ok === false && /причину/.test(r.error || ""), r);
  r = await call("realization", { pin, op: "cancel", data: { id: "999999999999", reason: "ZZ_TEST" } });
  check("rev_daily 15: отмена несуществующей записи - отказ", r.ok === false && /не найдена/.test(r.error || ""), r);
  if (process.env.TANDEM_DRIVER_PIN) {
    r = await call("realization", { pin: process.env.TANDEM_DRIVER_PIN, op: "cancel", data: { id: 1, reason: "ZZ_TEST" } });
    check("rev_daily 15: водитель запись не отменяет", r.ok === false && r.code === "forbidden", r);
  }

  // Участок кассы (0065): код точки не закрывает смену кассы с фискальным чеком, пока продажи дня не пробиты в
  // налоговой; после отмены такого чека - закрывает; собственник (правка закрытой смены) - закрывает и так.
  // Код zz_kassa - TANDEM_ZZ_KASSA_PIN (на стенде rv - 111111); нет кода или фискального чека у zz_kassa - пропуск.
  const zk = process.env.TANDEM_ZZ_KASSA_PIN || "111111";
  const zlg = await call("login", { pin: zk, point_id: "zz_kassa" });
  if (!zlg.ok || !zlg.point || !zlg.point.fiscal) {
    console.log("  пропуск касса+налоговая: нет кода zz_kassa (TANDEM_ZZ_KASSA_PIN) или у неё не включён фискальный чек");
  } else {
    const Z = (a, p) => call(a, { pin: zk, point_id: "zz_kassa", ...p });
    const d0 = iso(0);
    // не пробитые чеки дня, оставшиеся от других разделов, - пробить (кодом собственника): счёт - только наш
    for (const c of ((await call("check_list", { pin, point_id: "zz_kassa", date: d0 })).checks || [])) {
      if (c.status === "active" && Number(c.total) > 0 && !["ok", "off"].includes((c.fiscal || {}).status)) await call("fiscal_check", { pin, point_id: "zz_kassa", uid: c.uid });
    }
    // имитация Webkassa (0065) на сумме ,77 теряет ответ - чек «неизвестно, пробит ли» (unknown); старая имитация его
    // пробивает - тогда держит смену второй чек без фискального признака (его fiscal_unfiscal считает так же)
    const u0 = crypto.randomUUID();
    await Z("check_save", { uid: u0, date: d0, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1, price: 100.77 }] });
    await Z("fiscal_check", { uid: u0 });
    const fst = ((((await Z("check_list", { date: d0 })).checks || []).find((c) => c.uid === u0) || {}).fiscal || {}).status || null;
    let blocker = u0;
    if (fst === "ok") {
      blocker = crypto.randomUUID();
      await Z("check_save", { uid: blocker, date: d0, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 1 }] });
    }
    r = await Z("get_report", { date: d0, brief: true });
    check("rev_daily касса: экран закрытия заранее видит не пробитые в налоговой", r.ok && r.unfiscal >= 1, r);
    r = await Z("save_report", { date: d0, cash_open: 0, cash_handed: 0 });
    check("rev_daily касса: код точки не закрывает смену с не пробитым чеком (" + (fst === "ok" ? "без признака" : fst || "без признака") + ")",
      r.ok === false && r.unfiscal >= 1 && /^Не пробиты в налоговой: \d+ - откройте кассу/.test(r.error || ""), r);
    r = await Z("check_void", { uid: blocker, reason: "ZZ_TEST_не пробит в налоговой" });
    check("rev_daily касса: такой чек отменяется", r.ok === true, r);
    r = await Z("save_report", { date: d0, cash_open: 0, cash_handed: 0 });
    check("rev_daily касса: после отмены смена закрывается кодом точки", r.ok === true && !!(r.report && r.report.closed_at), r);
    await Z("check_save", { uid: crypto.randomUUID(), date: d0, seller: "ZZ_TEST_продавец", pay_kind: "cash", lines: [{ item_code: sok, qty: 2 }] });
    r = await Z("save_report", { date: d0, cash_open: 0, cash_handed: 0 });
    check("rev_daily касса: поздний не пробитый чек - закрыть заново кодом точки нельзя", r.ok === false && r.unfiscal >= 1, r);
    r = await call("save_report", { pin, point_id: "zz_kassa", date: d0, cash_open: 0, cash_handed: 0 });
    check("rev_daily касса: собственник (правка закрытой смены) закрывает", r.ok === true, r);
  }

  // 8, 17: заказы клиентов (нужен ключ бота)
  if (!(await botKeyOk("rev_daily"))) return;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог правки", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_беляш правки", item_type: "goods", unit_id: "шт", for_sale: true, price: 300 }); const bel = r.code;
  await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог правки", unit_label: "кг", price: 4500, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  await call("office_cmenu_save", { token: t, item_code: bel, title_ru: "ZZ_TEST_Беляш правки", unit_label: "шт", price: 500, min_qty: 2, step: 1, ready_kind: "stock" });
  await call("office_cmenu_check", { token: t, item_code: pie, price: 4500 }); await call("office_cmenu_check", { token: t, item_code: bel, price: 500 });
  const S = (await call("bot_menu", {})).settings || {};
  const from = S.client_hours_from || "09:00";
  const ready = String(Number(from.slice(0, 2)) + 1).padStart(2, "0") + from.slice(2);
  const nb = Math.max(2, Math.ceil((Number(S.client_min_order || 0) - 6750) / 500) + 1);
  const base = { kind: "delivery", address: "ZZ_TEST ул. Правки 1", point_id: "zz_kassa", for_date: iso(2), ready_by: ready, client_phone: "77000000777",
    lines: [{ item_code: pie, qty: 1.5 }, { item_code: bel, qty: nb }] };
  const P = (a, p) => call(a, { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", ...p });
  r = await call("bot_order_create", { ...base, uid: crypto.randomUUID() }); const o1 = r.order;
  check("rev_daily 8: заказ с доставкой создан", r.ok && near(o1.total, 6750 + nb * 500), r);
  if (!o1) return;
  r = await P("corder_edit", { id: o1.id, lines: o1.lines.map((l) => ({ item_code: l.item_code, qty: l.qty })), for_date: o1.for_date, ready_by: o1.ready_by, address: "ZZ_TEST ул. Правки 2" });
  check("rev_daily 8: прежние строки, дата и время + новый адрес - правка только адреса", r.ok && r.order.address === "ZZ_TEST ул. Правки 2" && near(r.order.total, o1.total), r);
  await call("office_cmenu_save", { token: t, item_code: bel, title_ru: "ZZ_TEST_Беляш правки", unit_label: "шт", price: 600, min_qty: 2, step: 1, ready_kind: "stock" });
  await call("office_cmenu_check", { token: t, item_code: bel, price: 600 });
  r = await P("corder_edit", { id: o1.id, lines: [{ item_code: pie, qty: 2 }, { item_code: bel, qty: nb + 1 }] });
  check("rev_daily 8: меню подорожало - прежние строки остаются по цене заказа", r.ok && near(r.order.total, 2 * 4500 + (nb + 1) * 500), r.order && r.order.total);
  r = await P("corder_edit", { id: o1.id, lines: [{ item_code: pie, qty: 2 }, { item_code: bel, qty: 1 }] });
  check("rev_daily 8: меньше минимума позиции - отказ", r.ok === false && /Минимум/.test(r.message || ""), r);
  r = await call("bot_order_create", { ...base, uid: crypto.randomUUID() }); const o2 = r.order;
  await call("bot_card_status", { order_id: o2.id, to: "awaiting_prepay", by_name: "ZZ_TEST_телеграм" });
  r = await P("corder_edit", { id: o2.id, address: "ZZ_TEST ул. Правки 3" });
  check("rev_daily 8: заказ с предоплатой - адрес правится", r.ok && r.order.address === "ZZ_TEST ул. Правки 3", r);
  r = await P("corder_edit", { id: o2.id, lines: [{ item_code: pie, qty: 3 }, { item_code: bel, qty: nb }] });
  check("rev_daily 8: заказ с предоплатой - состав не правится", r.ok === false && r.error === "validation" && /предоплатой/.test(r.message || ""), r);
  if (Number(S.client_max_days_ahead || 14) >= 16) {
    r = await call("bot_order_create", { ...base, for_date: iso(16), uid: crypto.randomUUID() }); const o3 = r.order;
    await P("corder_status", { id: o3.id, to: "confirmed" });
    r = await P("corder_list", {});
    check("rev_daily 17: подтверждённый заказ через 16 дней виден кассе", r.ok && r.orders.some((o) => o.id === o3.id), r.ok ? r.orders.length : r);
  }
};

// Ревизия 22.11.2026, участок «Бэк-офис и склад» (миграция 0067). S-R3 1: опись не отменяется, пока после неё её днём
// проведены документы по её позициям (повторное проведение их поглощало); S-R3 2: отчёты склада по умолчанию без
// учебных складов («Расход для 1С», остатки, закупки, прибыль), явный выбор склада их показывает; S-R3 4: загрузка факта
// ищет сначала по артикулу (и без ведущих нулей); S-R3 8: права на типы документов и «готовым со склада»; S-R3 10: сумма
// черновика - из округлённых строк; S-R3 11: себестоимость в «Прибыли» = «Продажам по блюдам»; S-R3 12: отказ задним
// числом называет оба случая; S-R3 13: «Готовность» без zz_*; S-R3 14: пустая дата черновика; S-R3 15: CSV остатков.
// Свой месяц - август 2024.
SECTIONS.rev_stock = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const near = (a, b, e = 0.005) => Math.abs(Number(a) - Number(b)) < e;
  const forb = (x) => x.ok === false && x.error === "forbidden";
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад ревизии склада" }); const A = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад ревизии Б" }); const B = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_учебный склад ревизии", training: true }); const T = r.id;
  const trainingOk = r.ok && r.training === true;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик ревизии склада", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_соль ревизии склада", item_type: "goods", unit_id: "кг" }); const salt = r.code;
  // артикул муки - «0» + код учёта соли: Excel, срезав ноль, дал бы ровно код учёта соли (S-R3 4)
  const art = "0" + salt;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука ревизии склада", item_type: "goods", unit_id: "кг", artikul: art }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог ревизии склада", item_type: "dish", unit_id: "шт", for_sale: true, price: 300 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_булка ревизии склада", item_type: "dish", unit_id: "шт", for_sale: true, price: 200 }); const bun = r.code;
  const ch1 = await call("office_chart_save", { token: t, code: pie, date_from: "2024-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.5 }] });
  const ch2 = await call("office_chart_save", { token: t, code: bun, date_from: "2024-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.5 }] });
  check("склад-ревизия: подготовка - склады (один учебный), поставщик, позиции, карты", A && B && T && trainingOk && SUP && salt && muka && pie && bun && ch1.ok && ch2.ok,
    { A, B, T, trainingOk, SUP, salt, muka, pie, bun, ch1, ch2 });
  const post = async (p) => {
    const s = await call("office_doc_save", { token: t, ...p });
    if (!s.ok) return s;
    return { ...(await call("office_doc_post", { token: t, id: s.id })), id: s.id, number: s.number };
  };
  const bal = async (store, code) => {
    const b = await call("office_stock_balances", { token: t, store_id: store, only_nonzero: false });
    return Number(((b.rows || []).find((x) => x.item_code === code) || {}).qty || 0);
  };

  // S-R3 1: опись 05.08 (факт 9 при расчёте 10), затем тем же днём перемещение 2 кг на Б. Отменить опись нельзя:
  // повторное проведение посчитало бы расчёт вместе с перемещением, и 2 кг вернулись бы на А, оставшись на Б.
  const inv1 = await post({ doc_type: "invoice_in", doc_date: "2024-08-01", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 100 }] });
  let s = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-08-05", store_from: A, lines: [{ item_code: muka, fact_qty: 9 }] });
  const inv = s.id;
  r = await call("office_doc_preview", { token: t, id: inv });
  check("склад-ревизия: окно «Провести?» у описи - итог разницы −100 с сервера", r.ok && near(r.total_sum, -100), r);
  r = await call("office_doc_post", { token: t, id: inv });
  check("склад-ревизия: приход 10 и опись с недостачей 1 кг (−100) проведены", inv1.ok && r.ok && near(r.total_sum, -100), { inv1, r });
  const tr = await post({ doc_type: "transfer", doc_date: "2024-08-05", store_from: A, store_to: B, lines: [{ item_code: muka, qty: 2 }] });
  check("склад-ревизия: перемещение тем же днём после описи проведено", tr.ok, tr);
  r = await call("office_doc_unpost", { token: t, id: inv });
  check("склад-ревизия: опись с документом её дня после неё не отменяется - документ назван, совет «новой инвентаризацией»",
    r.ok === false && r.error === "validation" && (r.message || "").includes(tr.number) && /новой инвентаризацией/.test(r.message || ""), r);
  check("склад-ревизия: остатки после отказа не тронуты - А 7, Б 2", near(await bal(A, muka), 7) && near(await bal(B, muka), 2),
    { A: await bal(A, muka), B: await bal(B, muka) });
  r = await call("office_doc_unpost", { token: t, id: tr.id });
  let r2 = await call("office_doc_unpost", { token: t, id: inv });
  check("склад-ревизия: перемещение отменено - и опись отменяется", r.ok && r2.ok, { r, r2 });
  r = await call("office_doc_post", { token: t, id: inv });
  r2 = await call("office_doc_post", { token: t, id: tr.id });
  check("склад-ревизия: опись и перемещение проведены снова - недостача та же (−100), А 7, Б 2",
    r.ok && near(r.total_sum, -100) && r2.ok && near(await bal(A, muka), 7) && near(await bal(B, muka), 2), { r, r2 });

  // S-R3 12 и 14: приход задним числом - отказ называет оба случая; пустая дата у черновика - прежняя.
  s = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-08-03", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 1, price: 100 }] });
  r = await call("office_doc_post", { token: t, id: s.id });
  check("склад-ревизия: приход задним числом - отказ: «после пересчёта», «до пересчёта» и номер описи",
    r.ok === false && /после пересчёта/.test(r.message || "") && /до пересчёта/.test(r.message || "") && /ИН-/.test(r.message || ""), r);
  r = await call("office_doc_save", { token: t, id: s.id, doc_type: "invoice_in", doc_date: "", store_to: A, counteragent_id: SUP, lines: [{ item_code: muka, qty: 1, price: 100 }] });
  let g = await call("office_doc_get", { token: t, id: s.id });
  check("склад-ревизия: пустая дата у сохранённого черновика - дата прежняя (03.08.2024)", r.ok && g.ok && g.doc.doc_date === "2024-08-03", { r, d: g.doc && g.doc.doc_date });
  await call("office_doc_delete", { token: t, id: s.id });

  // S-R3 10: 2,5 × 12,37 = 30,925 и 0,7 × 18,05 = 12,635 - строки 30,93 и 12,64; черновик в журнале и проведённый - 43,57.
  const ext = "ZZR-" + rnd6();
  s = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-08-06", store_to: B, counteragent_id: SUP, ext_number: ext,
    lines: [{ item_code: muka, qty: 2.5, price: 12.37 }, { item_code: salt, qty: 0.7, price: 18.05 }] });
  r = await call("office_docs_list", { token: t, q: ext, status: "draft" });
  const dr = (r.rows || []).find((x) => x.id === s.id) || {};
  r2 = await call("office_doc_post", { token: t, id: s.id });
  check("склад-ревизия: сумма черновика в журнале 43,57 - как после проведения", near(dr.total_sum, 43.57) && r2.ok && near(r2.total_sum, 43.57), { draft: dr.total_sum, posted: r2.total_sum });

  // S-R3 2: учебный склад - не в «Расходе для 1С», «Остатках», «Закупках» и «Прибыли» по умолчанию; выбран явно - виден.
  const pt = await post({ doc_type: "invoice_in", doc_date: "2024-08-07", store_to: T, counteragent_id: SUP, lines: [{ item_code: muka, qty: 5, price: 100 }] });
  const pp = await post({ doc_type: "production", doc_date: "2024-08-08", store_from: T, lines: [{ item_code: pie, qty: 2 }] });
  const pw = await post({ doc_type: "writeoff", doc_date: "2024-08-09", store_from: T, reason: "spoilage", lines: [{ item_code: muka, qty: 0.5 }] });
  check("склад-ревизия: приход, производство и списание на учебном складе проведены", pt.ok && pp.ok && pw.ok, { pt, pp, pw });
  r = await call("office_stock_1c_report", { token: t, date_from: "2024-08-08", date_to: "2024-08-08" });
  check("склад-ревизия: «Расход для 1С» по всем складам - без учебного (мука учебного производства не в акте 1С)",
    r.ok && !(r.rows || []).some((x) => x.item_code === muka), r.rows);
  r = await call("office_stock_1c_report", { token: t, store_id: T, date_from: "2024-08-08", date_to: "2024-08-08" });
  check("склад-ревизия: «Расход для 1С» по учебному складу, выбранному явно, - мука 1 кг",
    r.ok && near(((r.rows || []).find((x) => x.item_code === muka) || {}).qty, 1), r.rows);
  r = await call("office_stock_balances", { token: t, q: "ZZ_TEST_мука ревизии склада", only_nonzero: false });
  r2 = await call("office_stock_balances", { token: t, store_id: T, q: "ZZ_TEST_мука ревизии склада", only_nonzero: false });
  check("склад-ревизия: «Остатки» по всем складам - без учебного; учебный явно - виден",
    r.ok && !(r.rows || []).some((x) => x.store_id === T) && (r.rows || []).some((x) => x.store_id === A) && r2.ok && (r2.rows || []).some((x) => x.store_id === T),
    { all: (r.rows || []).map((x) => x.store_name), T: r2.rows });
  r = await call("office_stock_purchases_report", { token: t, date_from: "2024-08-07", date_to: "2024-08-07" });
  r2 = await call("office_stock_purchases_report", { token: t, store_id: T, date_from: "2024-08-07", date_to: "2024-08-07" });
  check("склад-ревизия: «Закупки» по всем складам - без учебной накладной; по учебному складу - 500",
    r.ok && !(r.suppliers || []).some((x) => x.counteragent_id === SUP) && r2.ok && near(((r2.suppliers || [])[0] || {}).sum, 500), { all: r.suppliers, T: r2.suppliers });
  r = await call("office_stock_pnl_report", { token: t, date_from: "2024-08-09", date_to: "2024-08-09" });
  check("склад-ревизия: «Прибыль» - списание учебного склада не входит", r.ok && !(r.rows || []).some((x) => near(x.writeoff, 50)), r.rows);
  r = await call("office_stock_turnover_report", { token: t, date_from: "2024-08-01", date_to: "2024-08-31", q: "ZZ_TEST_мука ревизии склада" });
  const tm = (r.rows || []).find((x) => x.item_code === muka) || {};
  check("склад-ревизия: «Ведомость» по всем складам - без прихода учебного склада (приход 10 + 2,5, а не 17,5)",
    r.ok && near(tm.income, 12.5), tm);

  // S-R3 4: загрузка факта (prefer: artikul) - «код» без ведущего нуля находит муку по артикулу, а не соль по коду учёта.
  r = await call("office_items_lookup_list", { token: t, prefer: "artikul", keys: [
    { code: salt, name: "ZZ_TEST_мука ревизии склада" }, { code: salt, name: "что-то другое" }, { code: salt, name: "ZZ_TEST_соль ревизии склада" }, { code: art }] });
  const by = Object.fromEntries((r.rows || []).map((x) => [x.i, x]));
  check("склад-ревизия: загрузка факта - артикул без нуля важнее кода учёта; другое название - на проверку; совпало название - его позиция",
    r.ok && (by[0] || {}).item_code === muka && !(by[0] || {}).name_differs && (by[1] || {}).item_code === muka && (by[1] || {}).name_differs === true
    && (by[2] || {}).item_code === salt && (by[3] || {}).item_code === muka, r.rows);
  r = await call("office_items_lookup_list", { token: t, keys: [{ code: salt }] });
  check("склад-ревизия: без prefer - как раньше, сначала код учёта", r.ok && ((r.rows || [])[0] || {}).item_code === salt, r.rows);

  // S-R3 8: технолог - приходы в журнале и карточке закрыты, производство открыто; «готовым со склада» не правит.
  r = await call("office_user_save", { token: t, login: "zz_test_rs_tech", name: "ZZ_TEST_Технолог ревизии склада", role: "technologist", pin: TP });
  let lg = await call("office_login", { login: "zz_test_rs_tech", pin: TP });
  await call("office_change_pin", { token: lg.token, pin: TP2 });
  lg = await call("office_login", { login: "zz_test_rs_tech", pin: TP2 });
  const tt = lg.token;
  r = await call("office_docs_list", { token: tt, doc_type: "invoice_in", date_from: "2024-08-01", date_to: "2024-08-31" });
  r2 = await call("office_doc_get", { token: tt, id: inv1.id });
  const r3 = await call("office_doc_get", { token: tt, id: pp.id });
  check("склад-ревизия: технолог - приходов в журнале нет, карточка прихода закрыта, акт производства открыт",
    r.ok && (r.rows || []).length === 0 && forb(r2) && r3.ok, { list: r.ok && r.rows.length, get: r2, prod: r3.ok });
  r = await call("office_stock_ready_save", { token: tt, store_id: A, item_code: pie, date_from: "2024-08-01" });
  r2 = await call("office_stock_ready_list", { token: tt });
  check("склад-ревизия: технолог «готовым со склада» не правит и не смотрит", forb(r) && forb(r2), { r, r2 });

  // S-R3 13: «Готовность» - служебные точки zz_* не в счёт; проверка склада кухни заявок совпадает с настройкой.
  r = await call("office_stock_quality_report", { token: t });
  const zz = (r.checks || []).filter((c) => ["point_no_store", "point_store_unlinked", "fiscal_ntin"].includes(c.id))
    .flatMap((c) => c.rows || []).filter((x) => /^zz_/.test(String(x.code || x.point_id || "")));
  const ord = await call("office_stock_orders_report", { token: t, for_date: "2024-08-01" });
  const st = await call("office_stores_list", { token: t });
  const kitchen = ((st.stores || []).find((x) => x.id === ord.store_id) || {});
  check("склад-ревизия: «Готовность» без zz_*, проверка учебного склада кухни заявок - ровно когда он учебный",
    r.ok && zz.length === 0 && r.checks.some((c) => c.id === "orders_store_training") === !!kitchen.training, { zz, kitchen: kitchen.name, training: kitchen.training });

  // S-R3 15: CSV остатков - русские заголовки, артикул формулой ="0…" (Excel не срежет ноль).
  r = await call("office_stock_balances", { token: t, store_id: A, only_nonzero: false, export: true });
  check("склад-ревизия: CSV остатков - «Склад;Код учёта;Код iiko;Позиция…», артикул текстом", r.ok && String(r.csv || "").startsWith("Склад;Код учёта;Код iiko;Позиция")
    && String(r.csv).includes('="' + art + '"'), String(r.csv || "").slice(0, 200));

  // S-R3 11: «Прибыль» берёт себестоимость из строк продаж, как «Продажи по блюдам»: мука по 33,33, пирог и булка по
  // 0,5 кг - строки 16,67 + 16,67 = 33,34 (по движениям было бы 33,33). Отчёт служебной точки - кодом собственника.
  if (!pin) { console.log("  skip «Прибыль» = «Продажи по блюдам» - нужен TANDEM_OWNER_PIN"); return; }
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад точки ревизии склада", point_id: "zz_test", is_default: true }); const P = r.id;
  await post({ doc_type: "invoice_in", doc_date: "2024-08-10", store_to: P, counteragent_id: SUP, lines: [{ item_code: muka, qty: 10, price: 33.33 }] });
  r = await call("save_report", { pin, point_id: "zz_test", date: "2024-08-11", comment: "ZZ_TEST_ревизия склада", cash: 500,
    sales: [{ item_code: pie, item_name: "пирог", qty: 1, price: 300 }, { item_code: bun, item_name: "булка", qty: 1, price: 200 }] });
  const sr = await call("office_doc_sales_report", { token: t, date_from: "2024-08-11", date_to: "2024-08-11", point_id: "zz_test" });
  const pl = await call("office_stock_pnl_report", { token: t, date_from: "2024-08-11", date_to: "2024-08-11", point_id: "zz_test" });
  const sp = ((sr.points || []).find((x) => x.point_id === "zz_test") || {}), pz = ((pl.rows || []).find((x) => x.point_id === "zz_test") || {});
  check("склад-ревизия: себестоимость в «Прибыли» = «Продажам по блюдам» (33,34), выручка 500", r.ok && near(sp.cost, 33.34) && near(pz.cost, 33.34) && near(pz.revenue, 500),
    { sales: sp, pnl: pz });
  const pa = await call("office_stock_pnl_report", { token: t, date_from: "2024-08-11", date_to: "2024-08-11" });
  check("склад-ревизия: «Прибыль» без выбора точки - без служебной zz_test", pa.ok && !(pa.rows || []).some((x) => x.point_id === "zz_test"), pa.rows);
  // склад служебной точки отвязывается: следующие разделы настраивают zz_test сами
  await call("office_store_save", { token: t, id: P, name: "ZZ_TEST_склад точки ревизии склада", point_id: null, is_default: false });
};

// Ревизия 22.11.2026, участок «Сервер, доступы и безопасность» (миграция 0068): сброс своего PIN через «Пользователи» -
// отказ; учебная учётка не видит заявки WhatsApp, заказы клиентов и обычные учётки; код новой точки - от 6 цифр, «код
// занят» - последней проверкой формы; неверный код точки с запертого адреса засчитывается точке (перебора без счёта
// нет). Свой доступ проверяется вместе с чужим отказом. Адрес запирается заголовком x-real-ip: стенд без Caddy ему
// верит, а на рабочем сервере запирается адрес самого теста - уборка в конце раздела снимает и его.
// TANDEM_TRAINING_CODE - ещё и «верный код учебной точки с запертого адреса проходит». TANDEM_CHECK_PROXY=1 - проверки
// прокси своего сервера со сборки 0068 (fiscal_prepare снаружи, пределы тела, 500 без текста базы): у стенда со
// старым образом прокси их нет, у Edge Function пределов тела нет.
SECTIONS.rev_access = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  const forb = (x) => x.ok === false && x.error === "forbidden";
  // 1. свой PIN - только «Сменить PIN» с текущим
  let r = await call("office_user_save", { token: t, login: "zz_test_ra_owner", name: "ZZ_TEST_Собственник ревизии", role: "owner", pin: TP });
  const ownerId = r.id;
  r = await call("office_user_save", { token: t, login: "zz_test_ra_sklad", name: "ZZ_TEST_Кладовщик ревизии", role: "storekeeper", pin: TP });
  const skladId = r.id;
  r = await call("office_login", { login: "zz_test_ra_owner", pin: TP });
  let ot = r.token;
  r = await call("office_change_pin", { token: ot, pin: TP2 });
  check("доступ: подготовка - собственник и кладовщик заведены, временный PIN снят", ownerId && skladId && r.ok, r);
  r = await call("office_user_reset_pin", { token: ot, id: ownerId, pin: rnd6() });
  check("доступ: сброс своего PIN через «Пользователи» - отказ", forb(r), r);
  r = await call("office_login", { login: "zz_test_ra_owner", pin: TP2 });
  check("доступ: после отказа учётка входит прежним PIN", r.ok && r.must_change_pin === false, r);
  ot = r.token;
  r = await call("office_user_reset_pin", { token: ot, id: skladId, pin: TP });
  check("доступ: собственник сбрасывает PIN сотруднику - ok", r.ok, r);

  // 2. учебная учётка и настоящие персональные данные
  await call("office_user_save", { token: t, login: "zz_test_ra_train", name: "ZZ_TEST_Учебный собственник ревизии", role: "owner", pin: TP, training: true });
  r = await call("office_login", { login: "zz_test_ra_train", pin: TP });
  const tt = r.token;
  check("доступ: учебный собственник входит", r.ok && !!tt, r);
  const shut = [];
  for (const a of ["lead_list", "lead_report", "corder_list", "corder_get", "cmenu_list"]) {
    r = await call("office_" + a, { token: tt, id: 1 });
    if (!forb(r)) shut.push({ a, r });
  }
  check("доступ: учебной учётке заявки WhatsApp, заказы клиентов и меню заказов закрыты - forbidden", shut.length === 0, shut);
  r = await call("office_users_list", { token: tt });
  check("доступ: учебная учётка в «Пользователях» видит только учебные учётки", r.ok && r.users.length > 0 && r.users.every((u) => u.training),
    r.ok ? r.users.filter((u) => !u.training).map((u) => u.login) : r);
  const open = [];
  for (const a of ["lead_list", "lead_report", "corder_list", "cmenu_list"]) {
    r = await call("office_" + a, { token: ot });
    if (!r.ok) open.push({ a, r });
  }
  check("доступ: обычному собственнику заявки, заказы и меню открыты", open.length === 0, open);
  r = await call("office_users_list", { token: ot });
  check("доступ: обычный собственник видит и обычные учётки", r.ok && r.users.some((u) => !u.training), r.ok);
  r = await call("office_docs_list", { token: tt });
  const r2 = await call("office_items_search", { token: tt, q: "ZZ" });
  check("доступ: учебная учётка по-прежнему читает журнал и номенклатуру (уроки)", r.ok && r2.ok, { r: r.ok, r2: r2.ok });

  // 3. код новой точки: в обоих запросах ширина ленты неверная - точка не заводится ни при каком исходе
  r = await call("office_store_point_save", { token: t, id: "zztest_ra", name: "ZZ_TEST_точка ревизии", mode: "position", pin: "1234", fiscal_paper: "99" });
  check("доступ: код новой точки из 4 цифр - отказ (от 6 до 8)", r.ok === false && r.error === "validation" && /от 6 до 8/.test(r.message || ""), r);
  if (/^[0-9]{6,8}$/.test(pin)) {
    r = await call("office_store_point_save", { token: t, id: "zztest_ra", name: "ZZ_TEST_точка ревизии", mode: "position", pin, fiscal_paper: "99" });
    check("доступ: «код занят» - не раньше других проверок (ответ про ленту, совпадение с кодом собственника не выдаётся)",
      r.ok === false && /ленты/.test(r.message || "") && !/занят/.test(r.message || ""), r);
  }

  // 4. прокси своего сервера (TANDEM_CHECK_PROXY=1)
  if (process.env.TANDEM_CHECK_PROXY) {
    const raw = async (body) => {
      const res = await fetch(UCHET, { method: "POST", headers: { "content-type": "application/json" }, body });
      let j = null; try { j = await res.json(); } catch { /* не JSON */ }
      return { status: res.status, j };
    };
    let x = await raw(JSON.stringify({ action: "fiscal_prepare", payload: { point_id: "zz_kassa", pin, op: "x" } }));
    check("прокси: fiscal_prepare снаружи - «Некорректное действие»", x.status === 400 && x.j && x.j.error === "Некорректное действие", x);
    x = await raw('{"action":"points","payload":{"s":"' + "x".repeat(2100000) + '"}}');
    check("прокси: тело больше 2 МБ - 413", x.status === 413, x);
    x = await raw('{"action":"points","payload":{"a":[' + "{},".repeat(199999) + "{}]}}");
    check("прокси: 200 тысяч объектов в теле - 413, разбор не начат", x.status === 413, x);
    r = await fetch(UCHET).then((res) => res.json()).catch((e) => ({ error: String(e) }));
    check("прокси: после больших тел процесс жив (GET без Accept: text/html - {ok:true})", r.ok === true, r);
    if (pin) {
      x = await raw(JSON.stringify({ action: "corder_status", payload: { pin, point_id: "zz_test", id: "99999999999999999999", to: "cancelled" } }));
      check("прокси: ответ 500 - без текста ошибки базы", x.status === 500 && x.j && x.j.ok === false && !("detail" in x.j), x);
    }
  } else console.log("  skip проверки прокси - TANDEM_CHECK_PROXY=1, когда прокси собран с правками 0068");

  // 5. перебор кода точки с запертого адреса - последним: запирает служебную точку и общий замок, уборка снимает
  if (!process.env.TANDEM_SERVICE_KEY || !pin) {
    console.log("  skip перебор с запертого адреса - нужны TANDEM_SERVICE_KEY и TANDEM_OWNER_PIN (уборка счётчиков)");
    return;
  }
  const n = () => 1 + (Number(rnd6()) % 250);
  const ipX = `10.68.${n()}.${n()}`, ipY = `10.69.${n()}.${n()}`;
  const callIp = async (ip, action, payload) => {
    const res = await fetch(UCHET, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ action, payload }) });
    try { return await res.json(); } catch { return { ok: false, error: "bad_json" }; }
  };
  for (let i = 0; i < 30; i++) await callIp(ipX, "office_login", { login: "zz_test_ra_nobody", pin: "000000" });
  r = await callIp(ipX, "office_login", { login: ctx.login, pin: ctx.pin });
  check("доступ: 30 неверных входов запирают адрес - бэк-офис не пускает и с верным PIN", r.ok === false && r.code === "throttled", r);
  if (process.env.TANDEM_TRAINING_CODE) {
    const ti = await call("training_info", { code: process.env.TANDEM_TRAINING_CODE });
    const tp = ti.ok && ti.creds && ti.creds.point;
    if (tp) {
      r = await callIp(ipX, "login", { point_id: tp.point, pin: tp.pin });
      check("доступ: с запертого адреса верный код точки проходит (общий адрес магазина точку не запирает)", r.ok && r.role === "point", r);
    } else console.log("  skip верный код точки с запертого адреса - training_info не отдал вход учебной точки");
  } else console.log("  skip верный код точки с запертого адреса - задайте TANDEM_TRAINING_CODE");
  let last = null;
  for (let i = 0; i < 10; i++) last = await callIp(ipX, "login", { point_id: "zz_test", pin: String(900000 + i) });
  check("доступ: неверный код точки с запертого адреса - отказ", last.ok === false && last.code === "throttled", last);
  r = await callIp(ipY, "get_report", { pin, point_id: "zz_test", date: "2020-01-01" });
  check("доступ: эти неверные коды засчитаны точке - она заперта и для другого адреса (перебора без счёта нет)",
    r.ok === false && r.code === "throttled", r);
  r = await call("test_cleanup", {});
  check("доступ: уборка снимает замок точки и адреса", r.ok === true, r);
  r = await callIp(ipX, "get_report", { pin, point_id: "zz_test", date: "2020-01-01" });
  check("доступ: после уборки верный код снова работает и с прежнего адреса", r.ok === true, r);
};

// Ревизия 22.11.2026, участок «Обучение, памятки и тексты»: учатся только в тестовой базе (GitHub Pages и стенды на
// localhost/127.0.0.1), на рабочем адресе - заглушка, уроки не идут, ссылки обучения скрыты; сведения замечания - с
// базой и адресом; окно замечания выше карточки урока; тексты - без длинных тире. Без браузера: js/tour.js и
// js/feedback.js запускаются в песочнице Node с поддельным окном, остальное - по файлам репозитория.
SECTIONS.rev_obuchenie = async () => {
  const fs = await import("node:fs"), vm = await import("node:vm");
  const root = new URL("../", import.meta.url);
  const read = (f) => fs.readFileSync(new URL(f, root), "utf8");
  const exists = (f) => fs.existsSync(new URL(f, root));
  // Поддельное окно: элементы с атрибутами и детьми, localStorage в памяти, адрес страницы.
  function browser(url, { testBase = false, store = {}, marked = 0 } = {}) {
    const u = new URL(url), ls = { ...store };
    const mkEl = (tag) => ({ tagName: String(tag).toUpperCase(), children: [], attrs: {}, hidden: false, id: "", className: "", textContent: "",
      setAttribute(k, v) { this.attrs[k] = String(v); }, append(...n) { this.children.push(...n); }, prepend(...n) { this.children.unshift(...n); },
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
    const body = mkEl("body"), head = mkEl("head");
    const testOnly = Array.from({ length: marked }, () => Object.assign(mkEl("a"), { hidden: true }));
    const all = (n) => [n, ...n.children.flatMap(all)];
    const w = { location: { hostname: u.hostname, host: u.host, pathname: u.pathname, hash: u.hash, href: u.href },
      localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { userAgent: "node", onLine: true },
      innerWidth: 1024, innerHeight: 768, console: { info() {}, log() {} }, addEventListener() {},
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, MutationObserver: class { observe() {} } };
    if (testBase) w.TANDEM_TEST_BASE = true;
    w.document = { readyState: "complete", title: "", head, body, scripts: [{ src: u.origin + "/js/tour.js?v=1" }], createElement: mkEl,
      addEventListener() {}, getElementById: (id) => [...all(body), ...all(head)].find((n) => n.id === id) || null,
      querySelectorAll: (sel) => (sel === "[data-test-only]" ? testOnly : []), querySelector: () => null };
    w.window = w;
    const ctx = vm.createContext(w);
    // Подгрузка уроков роли (loadRole в js/tour.js): файл js/tours/<роль>.js выполняется в той же песочнице.
    head.append = (...nodes) => { for (const n of nodes) { head.children.push(n);
      const m = n.tagName === "SCRIPT" && /tours\/(\w+)\.js/.exec(n.src || ""); if (m) { vm.runInContext(read("js/tours/" + m[1] + ".js"), ctx); if (n.onload) n.onload(); } } };
    return { ctx, ls, body, testOnly, run: (f) => vm.runInContext(read(f), ctx, { filename: f }), js: (code) => vm.runInContext(code, ctx) };
  }
  const WORK = "https://uchet.eneshka.kz/", TEST = "https://umgroupkz-commits.github.io/tandem-uchet/", STAND = "http://127.0.0.1:8797/";

  // 1) рабочий адрес: заглушка со ссылкой на ту же страницу в тестовой базе, уроки не стартуют, ссылки обучения скрыты
  let b = browser(WORK + "test.html#kassa", { marked: 2 });
  b.run("js/tour.js"); b.run("js/tours/kassa.js");
  const stub = b.js("TandemTour.workStub()"), box = b.body.children[0] || {};
  const link = (box.children || []).find((n) => n.tagName === "A") || {};
  check("обучение: рабочий адрес - заглушка «Обучение - в тестовой базе» со ссылкой на ту же страницу",
    b.js("TandemTour.workSite()") === true && stub === true && box.id === "tt-stub"
      && (box.children || []).some((n) => n.textContent === "Обучение - в тестовой базе") && link.href === TEST + "test.html#kassa", { stub, href: link.href });
  check("обучение: рабочий адрес - урок не стартует, ссылки «Обучение»/«Маршрут проверки» скрыты",
    b.js('TandemTour.start("kassa.cash")') === false && !("tandem_tour" in b.ls) && b.testOnly.every((n) => n.hidden), b.ls);
  // 2) тестовая база и стенд: заглушки нет, ссылки видны
  for (const [name, url, testBase] of [["тестовая база", TEST + "test.html", true], ["стенд 127.0.0.1", STAND + "test.html", false]]) {
    b = browser(url, { testBase, marked: 2 }); b.run("js/tour.js");
    check(`обучение: ${name} - уроки идут, заглушки нет, ссылки обучения видны`,
      b.js("TandemTour.workSite()") === false && b.js("TandemTour.workStub()") === false && b.body.children.length === 0 && b.testOnly.every((n) => !n.hidden));
  }
  // 3) урок, начатый на рабочем адресе раньше, закрывается и возвращает прежний вход кассы (keep)
  const was = JSON.stringify({ point_id: "eneshka", pin: "1" }), train = JSON.stringify({ point_id: "ucheb_kassa", pin: "2" });
  b = browser(WORK + "kassa.html", { store: { tandem_tour: JSON.stringify({ lesson: "kassa.cash", step: 3, role: "kassa", autoplay: false }),
    tandem_tour_saved: JSON.stringify({ tandem_login: was }), tandem_login: train } });
  b.run("js/tour.js");
  check("обучение: рабочий адрес - старый урок закрыт, вход кассы до урока вернулся",
    !("tandem_tour" in b.ls) && !("tandem_tour_saved" in b.ls) && b.ls.tandem_login === was, b.ls);
  // 4) сведения замечания: база и адрес сайта
  const fbBase = [];
  for (const [url, testBase, want] of [[WORK + "kassa.html", false, "рабочая"], [TEST + "kassa.html", true, "тестовая"], [STAND + "kassa.html", false, "стенд"]]) {
    b = browser(url, { testBase }); b.run("js/feedback.js");
    const c = JSON.parse(b.js("JSON.stringify(TandemFeedback.context())"));
    fbBase.push([c.base, c.site]);
    if (c.base !== want || c.site !== new URL(url).host) fbBase.push("FAIL " + url);
  }
  check("замечание: в сведениях база (рабочая, тестовая, стенд) и адрес сайта", !fbBase.some((x) => typeof x === "string"), fbBase);
  // 5) окно замечания выше обучалки
  const fbZ = Number((read("js/feedback.js").match(/z-index:(\d+);display:flex;align-items:center/) || [])[1] || 0);
  const tourZ = Math.max(...[...read("js/tour.js").matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1])));
  check("замечание: окно выше затемнения и карточки урока", fbZ > tourZ, { fbZ, tourZ });
  // 6) страницы и шапка бэк-офиса
  const office = read("office.html");
  check("бэк-офис: ссылки «Обучение» и «Маршрут проверки» - только для тестовой базы (data-test-only, hidden)",
    /href="test\.html"[^>]*data-test-only hidden>Обучение</.test(office) && /href="guide\.html"[^>]*data-test-only hidden>Маршрут проверки</.test(office));
  const pages = ["test.html", "guide.html", "proverka-kassy.html"].filter((f) => {
    const s = read(f), c = s.indexOf('src="config.js'), t = s.indexOf('src="js/tour.js');
    return !(c >= 0 && t > c && /TandemTour\.workStub\(\)/.test(s));
  });
  check("обучение: test, guide, proverka-kassy - config.js, затем js/tour.js и заглушка рабочего адреса", pages.length === 0, pages);
  check("learn.html (старый тренажёр) удалён", !exists("learn.html"));
  // 7) номер сборки плана проверки кассы не отстаёт: тот же, что у экранов, и его поднимает bump-build
  const build = (read("js/office/api.js").match(/export const BUILD = (\d+);/) || [])[1];
  const plan = read("proverka-kassy.html"), nums = [...plan.matchAll(/сборка (\d+)/g)].map((m) => m[1]);
  check("план проверки кассы: номер сборки как у экранов, bump-build его поднимает",
    nums.length >= 3 && nums.every((n) => n === build) && /"proverka-kassy\.html"/.test(read("tools/bump-build.mjs")), { build, nums });
  // 8) маршрут проверки: шаги на месте, общие настройки не меняются
  const guide = read("guide.html");
  const parts = vm.runInNewContext("(" + guide.match(/const PARTS = (\[[\s\S]*?\r?\n\]);/)[1] + ")");
  const gsteps = parts.flatMap((p) => p.steps);
  const bad = ["здесь не ставьте", "Склад для учебной точки", "Склад для учебной кассы", "Склад кухни для заявок\", where"].filter((t) => guide.includes(t));
  check("маршрут проверки: шаги на месте, шагов про склад кухни, склады учебных точек и флажок «учебный» нет",
    gsteps.length >= 25 && bad.length === 0 && /только посмотреть/.test(guide) && /Ничего не меняйте/.test(guide), { steps: gsteps.length, bad });
  // 9) тексты обучения и памяток - без длинных и средних тире (help.html: строки про «не пробит» правит участок кассы)
  const dash = /[\u2014\u2013]/;
  const files = ["test.html", "guide.html", "proverka-kassy.html", "js/tour.js", "js/feedback.js",
    ...fs.readdirSync(new URL("js/tours/", root)).filter((f) => f.endsWith(".js")).map((f) => "js/tours/" + f)];
  const dashed = files.filter((f) => dash.test(read(f)));
  const helpBad = read("help.html").split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => dash.test(l) && !/не пробит/.test(l)).map(([i]) => "help.html:" + i);
  check("тексты обучения и памяток без длинных и средних тире", dashed.length === 0 && helpBad.length === 0, [...dashed, ...helpBad]);
  // 10) уроки загружаются; урок «Исправить отчёт дня» ловит расхождение и с тире, и с дефисом на экране
  b = browser(TEST + "test.html", { testBase: true }); b.run("js/tour.js");
  for (const r of ["sklad", "buh", "tech", "kassa", "point", "owner"]) b.run("js/tours/" + r + ".js");
  const roles = JSON.parse(b.js(`JSON.stringify(["sklad","buh","tech","kassa","point","owner"].map((r) => TandemTour.lessons(r).length))`));
  const any = JSON.parse(b.js(`JSON.stringify(TandemTour.lessons("point").find((l) => l.id === "point.fix").steps.find((s) => s.title === "Проверка заметила").until)`));
  check("обучение: уроки всех ролей загружены", roles.every((n) => n >= 4), roles);
  check("урок point.fix: расхождение ловится с длинным тире и с дефисом", Array.isArray(any.any)
    && any.any.some((x) => x.text === "₸ \u2014 расхождение") && any.any.some((x) => x.text === "₸ - расхождение"), any);
  // 11) код обучения отдаёт входы всех ролей (то, что рисует test.html) - если задан TANDEM_TRAINING_CODE
  if (process.env.TANDEM_TRAINING_CODE) {
    const r = await call("training_info", { code: process.env.TANDEM_TRAINING_CODE });
    const keys = r.ok && r.creds ? ["sklad", "buh", "tech", "owner", "kassa", "point", "owner_code"].filter((k) => !r.creds[k]) : ["нет ответа"];
    check("обучение: training_info по коду обучения - входы всех ролей", r.ok && keys.length === 0, r.ok ? { нет: keys } : r);
  } else console.log("  --   training_info по коду пропущен: задайте TANDEM_TRAINING_CODE");
};

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
  await call("office_user_save", { token: t, login: "zz_test_q", name: "ZZ_TEST_Кладовщик готовности", role: "storekeeper", pin: TP });
  const u = await call("office_login", { login: "zz_test_q", pin: TP }); await call("office_change_pin", { token: u.token, pin: TP });
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

  r = await call("office_user_save", { token: t, login: "zz_test_role", name: "ZZ_TEST_Роль", role: "storekeeper", pin: TP });
  const uid = r.id;
  const u = await call("office_login", { login: "zz_test_role", pin: TP });
  await call("office_change_pin", { token: u.token, pin: TP });
  r = await call("office_me", { token: u.token });
  check("сессии: пользователь в системе", r.ok, r);
  await call("office_user_save", { token: t, id: uid, login: "zz_test_role", name: "ZZ_TEST_Роль", role: "accountant" });
  r = await call("office_me", { token: u.token });
  check("сессии: смена роли выкидывает пользователя — войти заново с новыми правами", r.ok === false && r.error === "unauthorized", r);
  // Смена своего PIN закрывает остальные сессии пользователя, текущая остаётся (миграция 0030).
  await call("office_user_save", { token: t, login: "zz_test_pin2", name: "ZZ_TEST_Две сессии", role: "storekeeper", pin: TP });
  const sA = await call("office_login", { login: "zz_test_pin2", pin: TP });
  await call("office_change_pin", { token: sA.token, pin: TP });
  const sB = await call("office_login", { login: "zz_test_pin2", pin: TP });
  r = await call("office_change_pin", { token: sA.token, old_pin: TP, pin: TP2 });
  r = await call("office_me", { token: sA.token });
  check("сессии: после смены PIN текущая сессия жива", r.ok, r);
  r = await call("office_me", { token: sB.token });
  check("сессии: после смены PIN вторая сессия закрыта", r.ok === false && r.error === "unauthorized", r);
};

// Учебные учётные записи (миграция 0048). training_setup НЕ вызывается: на живой базе он сменил бы PIN
// настоящих учебных учёток, по которым люди учатся. Защита проверяется на своей учебной учётке zz_test_train
// (user_save с training:true), код обучения — только неверным (одна неудача с ключом 'training' остаётся
// в счётчике на сутки: уборка её не снимает — по ключу её не отличить от чужой).
SECTIONS.training = async (ctx) => {
  const t = ctx.token;
  const FS = "Учебная учётная запись работает только с учебными складами";
  const FR = "Учебная учётная запись: это действие меняет общие справочники — в обучении его только показывают";
  const forb = (r, msg) => r.ok === false && r.error === "forbidden" && r.message === msg;
  let r = await call("office_training_get", { token: t });
  check("обучение: training_get у администратора — ok, ничего не меняет", r.ok && typeof r.configured === "boolean", r);
  const configured = !!r.configured;
  r = await call("training_info", { code: "ZZ_TEST_не_тот_код_" + rnd6() });
  check("обучение: неверный код обучения — отказ, учебных входов нет", r.ok === false && !r.creds
    && r.error === (configured ? "Код обучения не подошёл" : "Обучение не настроено — попросите администратора"), r);
  // справочники администратора: учебный и обычный склад, поставщик, позиция
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_учебный склад", training: true }); const TS = r.id;
  check("обучение: учебный склад заведён", r.ok && r.training === true, r);
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_обычный склад" }); const RS = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик учёбы", kind: "supplier" }); const SUP = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_сырьё учёбы", item_type: "goods", unit_id: "кг" }); const raw = r.code;
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", store_to: RS, counteragent_id: SUP, lines: [{ item_code: raw, qty: 1, price: 10 }] });
  const realDoc = r.id;
  check("обучение: подготовка (склады, поставщик, позиция, черновик на обычном складе)", TS && RS && SUP && raw && realDoc, r);
  // учебная учётка через user_save: без временного PIN, в списке — training
  r = await call("office_user_save", { token: t, login: "zz_test_train", name: "ZZ_TEST_Учебный собственник", role: "owner", pin: TP, training: true });
  check("обучение: user_save {training:true} — ok", r.ok && r.id, r);
  r = await call("office_users_list", { token: t });
  const tu = (r.users || []).find((u) => u.login === "zz_test_train");
  check("обучение: users_list отдаёт training, временного PIN нет", tu && tu.training === true && tu.must_change_pin === false
    && (r.users || []).find((u) => u.login === ctx.login).training === false, tu);
  r = await call("office_login", { login: "zz_test_train", pin: TP });
  check("обучение: учебная учётка входит и сразу работает", r.ok && r.must_change_pin === false, r);
  const u = r.token;
  // чтение — как у роли
  r = await call("office_docs_list", { token: u });
  const r2 = await call("office_items_search", { token: u, q: "ZZ_TEST" });
  const r3 = await call("office_users_list", { token: u });
  check("обучение: чтение как у роли (журнал, номенклатура, пользователи)", r.ok && r2.ok && r3.ok, { r: r.ok, r2: r2.ok, r3: r3.ok });
  r = await call("office_change_pin", { token: u, old_pin: TP, pin: TP2 });
  check("обучение: change_pin — forbidden", forb(r, "У учебной учётной записи PIN не меняется: он показан в обучалке"), r);
  // документы: учебный склад — можно, обычный — нет
  r = await call("office_doc_save", { token: u, doc_type: "invoice_in", store_to: TS, counteragent_id: SUP, lines: [{ item_code: raw, qty: 2, price: 50 }] });
  check("обучение: приход на учебный склад — ok", r.ok, r);
  r = await call("office_doc_post", { token: u, id: r.id });
  check("обучение: проведение на учебном складе — ok", r.ok, r);
  r = await call("office_doc_save", { token: u, doc_type: "invoice_in", store_to: RS, counteragent_id: SUP, lines: [{ item_code: raw, qty: 2, price: 50 }] });
  check("обучение: приход на обычный склад — forbidden", forb(r, FS), r);
  r = await call("office_doc_save", { token: u, id: realDoc, doc_type: "invoice_in", store_to: TS, counteragent_id: SUP, lines: [{ item_code: raw, qty: 9, price: 9 }] });
  check("обучение: чужой черновик на учебный склад не перетащить — forbidden", forb(r, FS), r);
  r = await call("office_doc_post", { token: u, id: realDoc });
  check("обучение: проведение документа обычного склада — forbidden", forb(r, FS), r);
  r = await call("office_doc_get", { token: t, id: realDoc });
  check("обучение: документ обычного склада не тронут", r.ok && r.doc.status === "draft" && r.doc.store_to === RS && Number(r.doc.lines[0].qty) === 1, r.doc);
  // номенклатура: новая позиция — можно (она учебная), чужая — нет
  r = await call("office_item_save", { token: u, name: "ZZ_TEST_учебная позиция", item_type: "dish", unit_id: "шт" });
  const own = r.code;
  check("обучение: новая позиция — ok", r.ok && own, r);
  r = await call("office_item_save", { token: u, code: own, note: "правка учебной" });
  check("обучение: правка своей (учебной) позиции — ok", r.ok, r);
  r = await call("office_item_save", { token: u, code: raw, note: "правка чужой" });
  check("обучение: правка обычной позиции — forbidden", forb(r, FR), r);
  r = await call("office_chart_save", { token: u, code: own, date_from: "2026-01-01", output_amount: 1, lines: [{ ingredient_code: raw, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("обучение: техкарта учебной позиции — ok", r.ok, r);
  // общие справочники и настройки — нет
  const shared = [["group_save", { name: "ZZ_TEST_группа учёбы" }], ["counteragent_save", { name: "ZZ_TEST_контрагент учёбы", kind: "supplier" }],
    ["store_save", { name: "ZZ_TEST_склад учёбы", training: true }], ["user_save", { login: "zz_test_train2", name: "ZZ_TEST_x", role: "storekeeper", pin: TP }],
    ["item_prices_save", { code: own, prices: [] }], ["stock_orders_settings_save", { store_id: TS, cutoff: "20:00" }]];
  const bad = [];
  for (const [a, p] of shared) { r = await call("office_" + a, { token: u, ...p }); if (!forb(r, FR)) bad.push({ a, r }); }
  check("обучение: группы, контрагенты, склады, пользователи, цены точек, настройки заявок — forbidden", bad.length === 0, bad);
  r = await call("office_training_get", { token: u });
  check("обучение: учебная учётка учебные входы не видит — forbidden", r.ok === false && r.error === "forbidden", r);
  // замечания: записать и разобрать своё — можно
  r = await call("office_feedback_save", { token: u, message: "ZZ_TEST_замечание из обучения" });
  check("обучение: замечание учебной учётки — ok", r.ok && r.id, r);
  r = await call("office_feedback_done", { token: u, id: r.id });
  check("обучение: «разобрано» по своему замечанию — ok", r.ok, r);
};

// Меню заказов клиентов (миграция 0049): своя цена, отметка «сверена», стоп-лист, меню для бота.
// Разделы бота (cmenu, corders, corders_kitchen) зовут bot_* ключом бота: в базе с заданным bot_key_hash служебный
// ключ для них не годится. Без TANDEM_BOT_KEY такие разделы пропускаются: на живой базе десятки отказов подряд
// запирали бы вход с этого адреса на 10 минут (счётчик неверных кодов по IP).
let botKeyChecked = null;
async function botKeyOk(section) {
  if (botKeyChecked === null) {
    const r = await call("bot_menu", {});
    botKeyChecked = !(r.ok === false && r.error === "forbidden");
  }
  if (!botKeyChecked) console.log(`  skip раздел ${section} — ключ бота не подошёл (задайте TANDEM_BOT_KEY)`);
  return botKeyChecked;
}

SECTIONS.cmenu = async (ctx) => {
  if (!(await botKeyOk("cmenu"))) return;
  const t = ctx.token;
  let r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог меню", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука меню", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  check("меню: подготовка — пирог в продаже, мука не в продаже", pie && muka, r);
  r = await call("office_cmenu_save", { token: t, item_code: muka, title_ru: "Мука", price: 100 });
  check("меню: позицию не в продаже в меню не добавить", r.ok === false && r.error === "validation", r);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", price: 0 });
  check("меню: цена 0 — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", title_kz: "ZZ_TEST_Етті бәліш",
    unit_label: "кг", price: 4550, min_qty: 1, step: 0.5, section: "Татарские пироги", ready_kind: "fresh" });
  check("меню: позиция сохранена, цена не сверена, подсказка — цена кассы", r.ok && r.row.checked === false && Number(r.row.price) === 4550 && r.row.kassa_price != null, r);
  r = await call("bot_menu", {});
  check("меню: бот не видит несверенную цену", r.ok && !r.items.some((x) => x.item_code === pie), r.items && r.items.length);
  check("меню: бот получает настройки и точки выдачи", r.ok && r.settings && r.settings.client_hours_from && Array.isArray(r.points), r.settings);
  r = await call("bot_menu", { service_key: "zz-wrong-key" });
  check("меню: без верного ключа — отказ", r.ok === false && r.error === "forbidden", r);
  if (process.env.TANDEM_BOT_KEY) {
    r = await call("test_cleanup", { service_key: process.env.TANDEM_BOT_KEY });
    check("ключ бота не открывает уборку теста", r.ok === false && r.error === "forbidden", r);
  }
  r = await call("office_cmenu_check", { token: t, item_code: pie });
  check("меню: сверка без цены — conflict", r.ok === false && r.error === "conflict", r);
  r = await call("office_cmenu_check", { token: t, item_code: pie, price: 4000 });
  check("меню: сверка не той цены — conflict", r.ok === false && r.error === "conflict", r);
  r = await call("office_cmenu_check", { token: t, item_code: pie, price: 4550 });
  check("меню: цена отмечена сверенной", r.ok && r.row.checked === true && r.row.price_checked_by, r);
  r = await call("bot_menu", {});
  const seen = (r.items || []).find((x) => x.item_code === pie);
  check("меню: после сверки бот видит позицию без цены кассы", seen && Number(seen.price) === 4550 && seen.kassa_price === undefined && seen.ready_kind === "fresh", seen);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", unit_label: "кг", price: 4600, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  check("меню: смена цены снимает отметку «сверена»", r.ok && r.row.checked === false, r.row);
  await call("office_cmenu_check", { token: t, item_code: pie, price: 4600 });
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом и луком", unit_label: "кг", price: 4600, min_qty: 1, step: 0.5, ready_kind: "fresh", section: "Татарские пироги" });
  check("меню: правка без смены цены отметку «сверена» сохраняет", r.ok && r.row.checked === true, r.row);
  r = await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог с мясом", unit_label: "шт", price: 4600, min_qty: 0.5, step: 0.5, ready_kind: "fresh" });
  check("меню: у штучного дробный минимум — отказ", r.ok === false && r.error === "validation", r);
  const day = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  r = await call("office_cmenu_stop", { token: t, item_code: pie, until: day });
  check("меню: стоп на сегодня поставлен", r.ok && r.row.stopped === true, r.row);
  r = await call("bot_menu", {});
  check("меню: бот видит позицию со стопом", ((r.items || []).find((x) => x.item_code === pie) || {}).stopped === true, null);
  r = await call("office_cmenu_stop", { token: t, item_code: pie, until: "" });
  check("меню: стоп снят", r.ok && r.row.stopped === false, r.row);
  r = await call("office_cmenu_list", { token: t });
  check("меню: список с настройками", r.ok && r.rows.some((x) => x.item_code === pie) && r.settings, null);
  r = await call("office_client_settings_save", { token: t, values: { client_fresh_cutoff: "25:00" } });
  check("настройки: неверное время — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_client_settings_save", { token: t, values: { client_unknown_key: "1" } });
  check("настройки: неизвестный ключ — отказ", r.ok === false && r.error === "validation", r);
  // 0052: тексты бота — частые вопросы, доставка, оплата. Живой текст владельца сохраняется и возвращается.
  const was = (await call("office_cmenu_list", { token: t })).settings || {};
  r = await call("office_client_settings_save", { token: t, values: { client_faq: "x".repeat(6001) } });
  check("настройки: частые вопросы длиннее 6000 — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_client_settings_save", { token: t, values: { client_payment_methods: "y".repeat(301) } });
  check("настройки: способы оплаты длиннее 300 — отказ", r.ok === false && r.error === "validation", r);
  r = await call("office_client_settings_save", { token: t, values: { client_faq: "ZZ_TEST_ частые вопросы\nвторая строка" } });
  const bm = await call("bot_menu", {});
  check("настройки: частые вопросы сохранены и видны боту", r.ok && (bm.settings || {}).client_faq === "ZZ_TEST_ частые вопросы\nвторая строка", bm.settings);
  check("настройки: доставка и оплата видны боту", typeof (bm.settings || {}).client_delivery_text === "string" && typeof (bm.settings || {}).client_payment_methods === "string", bm.settings);
  r = await call("office_client_settings_save", { token: t, values: { client_faq: was.client_faq ?? "" } });
  check("настройки: прежний текст частых вопросов возвращён", r.ok && (r.settings || {}).client_faq === (was.client_faq ?? ""), r);
  ctx.menuPie = pie;
};

SECTIONS.corders = async (ctx) => {
  if (!(await botKeyOk("corders"))) return;
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (действия точки — кодом)"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const uid = () => crypto.randomUUID();
  const iso = (k) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы заказов", point_id: "zz_kassa", is_default: true });
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог заказов", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_беляш заказов", item_type: "goods", unit_id: "шт", for_sale: true, price: 300 }); const bel = r.code;
  await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог", unit_label: "кг", price: 4500, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  await call("office_cmenu_save", { token: t, item_code: bel, title_ru: "ZZ_TEST_Беляш", unit_label: "шт", price: 500, min_qty: 2, step: 1, ready_kind: "stock" });
  await call("office_cmenu_check", { token: t, item_code: pie, price: 4500 }); await call("office_cmenu_check", { token: t, item_code: bel, price: 500 });
  const menu = await call("bot_menu", {});
  const S = menu.settings || {};
  const hh = (s, add) => { const [h, m] = String(s).split(":").map(Number); const x = h * 60 + m + add; return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
  const READY = hh(S.client_hours_from || "09:00", 60);
  const base = { kind: "pickup", point_id: "zz_kassa", for_date: iso(2), ready_by: READY, lines: [{ item_code: pie, qty: 1.5 }, { item_code: bel, qty: 2 }] };
  const Q = (p) => call("bot_order_quote", { ...base, ...p });

  r = await Q({});
  check("заказ: расчёт — 1,5 кг × 4500 + 2 × 500 = 7750", r.ok && near(r.quote.total, 7750) && r.quote.lines.length === 2, r);
  r = await Q({ lines: [{ item_code: pie, qty: 1.5, price: 1 }] });
  check("заказ: присланная цена игнорируется", r.ok && near(r.quote.lines[0].price, 4500), r.quote);
  r = await Q({ kind: "courier" });
  check("заказ: неизвестный способ получения — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ point_id: "aktau" });
  check("заказ: точка не из списка выдачи — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ for_date: iso(100) });
  check("заказ: дата дальше предела — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ ready_by: "03:00" });
  check("заказ: время вне часов приёма — отказ", r.ok === false && r.error === "validation", r);
  r = await Q({ lines: [{ item_code: pie, qty: 0.5 }] });
  check("заказ: меньше минимума — отказ", r.ok === false && /Минимум/.test(r.message), r);
  r = await Q({ lines: [{ item_code: pie, qty: 1.3 }] });
  check("заказ: не по шагу — отказ", r.ok === false && /шагом/.test(r.message), r);
  r = await Q({ lines: [{ item_code: bel, qty: 2.5 }] });
  check("заказ: штучное дробью — отказ", r.ok === false && /целым/.test(r.message), r);
  r = await Q({ lines: [{ item_code: bel, qty: 2 }, { item_code: bel, qty: 3 }] });
  check("заказ: позиция дважды — отказ", r.ok === false && /дважды/.test(r.message), r);
  r = await Q({ kind: "delivery", address: "" });
  check("заказ: доставка без адреса — отказ", r.ok === false && /адрес/.test(r.message), r);
  r = await Q({ kind: "delivery", address: "ZZ_TEST ул. Мира 1", lines: [{ item_code: bel, qty: 2 }] });
  check("заказ: доставка меньше минимума — отказ min_order", r.ok === false && r.error === "min_order", r);
  r = await Q({ for_date: iso(0), ready_by: S.client_hours_from || "09:00", lines: [{ item_code: pie, qty: 1 }] });
  check("заказ: свежий пирог на сегодня к открытию — отказ slot", r.ok === false && r.error === "slot", r);
  await call("office_cmenu_stop", { token: t, item_code: bel, until: iso(2) });
  r = await Q({});
  check("заказ: позиция на стопе на эту дату — отказ stopped", r.ok === false && r.error === "stopped", r);
  await call("office_cmenu_stop", { token: t, item_code: bel, until: "" });

  const phone = "77000000" + String(Math.floor(Math.random() * 900) + 100);
  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: "" });
  check("заказ: без телефона — отказ", r.ok === false && r.error === "validation", r);
  const u1 = uid();
  r = await call("bot_order_create", { ...base, uid: u1, client_phone: phone, client_name: "ZZ_TEST_Клиент", lang: "kz" });
  check("заказ: создан, статус «новый», номер дня", r.ok && r.order.status === "new" && r.order.no >= 1 && r.order.lang === "kz" && near(r.order.total, 7750), r);
  const o1 = r.order;
  r = await call("bot_order_create", { ...base, uid: u1, client_phone: phone });
  check("заказ: повтор с тем же uid — тот же заказ", r.ok && r.repeat === true && r.order.id === o1.id, r);
  r = await call("bot_order_events", { after: 0, limit: 500 });
  check("журнал: читается, курсор last", r.ok && Number(r.last) > 0, r.last);
  const before = Number(r.last) - 1;
  r = await call("bot_order_events", { after: before - 50 < 0 ? 0 : before - 50, limit: 500 });
  check("журнал: событие создания заказа есть", r.ok && r.events.some((e) => e.order.id === o1.id && e.status_to === "new"), null);

  const P = (action, p) => call(action, { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", ...p });
  r = await P("corder_list", {});
  check("точка: видит свой новый заказ", r.ok && r.orders.some((o) => o.id === o1.id), null);
  r = await call("corder_get", { pin, point_id: "zz_test", id: o1.id });
  check("точка: чужой заказ не виден", r.ok === false && r.error === "not_found", r);
  r = await call("corder_status", { pin, point_id: "zz_test", seller: "ZZ_TEST_чужой", id: o1.id, to: "confirmed" });
  check("точка: чужой заказ не подтвердить", r.ok === false && r.error === "not_found", r);
  r = await call("corder_edit", { pin, point_id: "zz_test", seller: "ZZ_TEST_чужой", id: o1.id, address: "x" });
  check("точка: чужой заказ не править", r.ok === false && r.error === "not_found", r);
  r = await call("corder_list", { pin, point_id: "zz_test" });
  check("точка: в своём списке нет чужих заказов", r.ok && !r.orders.some((o) => o.id === o1.id), null);
  r = await P("corder_edit", { id: o1.id, lines: [{ item_code: pie, qty: 2 }, { item_code: bel, qty: 2 }] });
  check("точка: правка нового заказа пересчитала сумму (2 × 4500 + 1000)", r.ok && near(r.order.total, 10000), r);
  r = await P("corder_status", { id: o1.id, to: "confirmed" });
  check("точка: подтвердила", r.ok && r.order.status === "confirmed" && r.order.confirmed_by === "ZZ_TEST_продавец", r);
  r = await call("bot_card_status", { order_id: o1.id, to: "confirmed", by_name: "ZZ_TEST_телеграм" });
  check("телеграм: второе подтверждение — conflict с именем первого", r.ok === false && r.error === "conflict" && /ZZ_TEST_продавец/.test(r.message), r);
  r = await P("corder_status", { id: o1.id, to: "issued", pay_kind: "cash" });
  check("переход через ступень — conflict", r.ok === false && r.error === "conflict", r);
  r = await P("corder_status", { id: o1.id, to: "cooking" });
  check("готовится", r.ok && r.order.status === "cooking", r);
  r = await call("bot_order_cancel", { id: o1.id, reason: "клиент передумал" });
  check("бот не отменяет то, что уже готовится", r.ok === false && r.error === "forbidden", r);
  r = await P("corder_edit", { id: o1.id, address: "x", lines: [{ item_code: pie, qty: 3 }] });
  check("правка строк после «готовится» — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "assembled" });
  r = await P("corder_status", { id: o1.id, to: "handed_to_courier", courier: "Курьер" });
  check("самовывоз курьеру не передаётся", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "awaiting_pickup" });
  check("ждёт клиента", r.ok && r.order.status === "awaiting_pickup", r);
  r = await P("corder_status", { id: o1.id, to: "issued" });
  check("выдан без способа оплаты — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o1.id, to: "issued", pay_kind: "cash" });
  check("выдан — чек кассы пробит с uid заказа", r.ok && r.order.status === "issued" && r.order.check_uid === o1.uid, r);
  r = await P("check_list", { date: iso(0) });
  check("касса: чек заказа в списке на 10 000", r.ok !== false && JSON.stringify(r).includes(o1.uid) , null);

  // Доставка - от суммы client_min_order из настроек базы (в рабочей 10 000 ₸, в песочнице меньше): белешей столько,
  // чтобы заказ прошёл минимум (1,5 кг × 4500 = 6750 + 500 за штуку).
  const belQty = Math.max(2, Math.ceil((Number(S.client_min_order || 0) - 6750) / 500));
  r = await call("bot_order_create", { ...base, lines: [{ item_code: pie, qty: 1.5 }, { item_code: bel, qty: belQty }],
    uid: uid(), kind: "delivery", address: "ZZ_TEST ул. Мира 1", client_phone: phone, client_name: "ZZ_TEST_Клиент" });
  const o2 = r.order;
  check("доставка: создана", r.ok && o2.kind === "delivery", r);
  r = await call("bot_card_status", { order_id: o2.id, to: "awaiting_prepay", by_name: "ZZ_TEST_телеграм" });
  check("телеграм: подтверждение с предоплатой", r.ok && r.order.status === "awaiting_prepay" && r.order.prepay_required === true, r);
  r = await call("bot_card_status", { order_id: o2.id, to: "paid", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_order_cancel", { id: o2.id, reason: "клиент передумал" });
  check("бот не отменяет оплаченный", r.ok === false && r.error === "forbidden", r);
  r = await P("corder_edit", { id: o2.id, lines: [{ item_code: pie, qty: 3 }] });
  check("оплаченный: состав не правится", r.ok === false && r.error === "validation", r);
  r = await call("bot_card_status", { order_id: o2.id, to: "cooking", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "assembled", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "handed_to_courier", by_name: "ZZ_TEST_телеграм" });
  check("курьер обязателен", r.ok === false && r.error === "validation", r);
  r = await call("bot_card_status", { order_id: o2.id, to: "handed_to_courier", by_name: "ZZ_TEST_телеграм", courier: "ZZ_TEST_курьер" });
  r = await call("bot_card_status", { order_id: o2.id, to: "on_the_way", by_name: "ZZ_TEST_телеграм" });
  r = await call("bot_card_status", { order_id: o2.id, to: "delivered", by_name: "ZZ_TEST_телеграм", pay_kind: "kaspi_qr" });
  check("доставлен, чек пробит, курьер записан", r.ok && r.order.status === "delivered" && r.order.courier === "ZZ_TEST_курьер" && r.order.check_uid === o2.uid, r);

  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: phone });
  const o3 = r.order;
  r = await P("corder_status", { id: o3.id, to: "lost" });
  check("неизвестный статус — validation", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o3.id, to: "rejected" });
  check("отказ без причины — отказ", r.ok === false && r.error === "validation", r);
  r = await P("corder_status", { id: o3.id, to: "rejected", reason: "ZZ_TEST нет начинки" });
  check("отказ с причиной", r.ok && r.order.status === "rejected" && r.order.reason === "ZZ_TEST нет начинки", r);
  r = await call("bot_order_create", { ...base, uid: uid(), client_phone: phone });
  r = await call("bot_order_cancel", { id: r.order.id, reason: "клиент передумал" });
  check("бот отменяет новый заказ", r.ok && r.order.status === "cancelled", r);

  r = await call("bot_client_history", { phone });
  check("история клиента: имя и адрес", r.ok && r.name === "ZZ_TEST_Клиент" && r.addresses.includes("ZZ_TEST ул. Мира 1"), r);
  r = await call("office_corder_list", { token: t, date_from: iso(2), date_to: iso(2), point_id: "zz_kassa" });
  check("бэк-офис: список заказов точки на день", r.ok && r.orders.length >= 4, r.orders && r.orders.length);
  r = await call("office_corder_get", { token: t, id: o1.id });
  check("бэк-офис: карточка заказа с журналом", r.ok && r.order.id === o1.id && r.events.length >= 6, r.events && r.events.length);
  check("журнал: правка записана «было → стало»", r.ok && r.events.some((e) => e.payload && e.payload.edited
    && Number(e.payload.total_from) === 7750 && Number(e.payload.total_to) === 10000), r.events);
  ctx.corderItems = { pie, bel };
};

SECTIONS.corders_kitchen = async (ctx) => {
  if (!(await botKeyOk("corders_kitchen"))) return;
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN"); return; }
  const near = (a, b, e = 0.001) => Math.abs(Number(a) - Number(b)) < e;
  const iso = (k) => new Date(Date.now() + 5 * 3600e3 + k * 86400e3).toISOString().slice(0, 10);
  let d = null;
  for (let k = 3; k <= 9 && !d; k++) {
    const x = await call("office_stock_orders_report", { token: t, for_date: iso(k) });
    if (x.ok && !(x.docs || []).length && !(x.client_orders || []).some((o) => !String(o.point_id).startsWith("zz_"))) d = iso(k);
  }
  if (!d) { console.log("  пропуск: нет дня без настоящих документов плана"); return; }
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад кассы кухни", point_id: "zz_kassa", is_default: true }); const S = r.id;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_мука кухни", item_type: "goods", unit_id: "кг" }); const muka = r.code;
  r = await call("office_item_save", { token: t, name: "ZZ_TEST_пирог кухни", item_type: "dish", unit_id: "кг", for_sale: true, price: 1600 }); const pie = r.code;
  r = await call("office_chart_save", { token: t, code: pie, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.5, netto: 0.5, output: 0.5 }] });
  await call("office_cmenu_save", { token: t, item_code: pie, title_ru: "ZZ_TEST_Пирог кухни", unit_label: "кг", price: 4500, min_qty: 1, step: 0.5, ready_kind: "fresh" });
  await call("office_cmenu_check", { token: t, item_code: pie, price: 4500 });
  const menu = await call("bot_menu", {});
  const from = (menu.settings || {}).client_hours_from || "09:00";
  const ready = String(Number(from.slice(0, 2)) + 1).padStart(2, "0") + from.slice(2);
  const mk = async (qty) => {
    const x = await call("bot_order_create", { uid: crypto.randomUUID(), kind: "pickup", point_id: "zz_kassa", for_date: d, ready_by: ready,
      client_phone: "77000000999", lines: [{ item_code: pie, qty }] });
    await call("corder_status", { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", id: x.order.id, to: "confirmed" });
    return x.order;
  };
  const o1 = await mk(2);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  const c = (r.clients || []).find((x) => x.item_code === pie) || {};
  check("кухня: в плане колонка «Клиенты» — 2 кг пирога", r.ok && near(c.qty, 2) && near(c.in_act || 0, 0) && c.has_chart, c);
  check("кухня: заказ в списке дня, ещё не в акте", (r.client_orders || []).some((o) => o.id === o1.id && o.in_act === false), r.client_orders);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: акт по заказам клиентов создан", r.ok && r.made === 1, r);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  check("кухня: акт виден в документах плана, заявки точек не заперты", r.ok && r.docs.some((x) => /\/clients-zz_kassa-1$/.test(x.source_id)) && r.locked === false, { docs: r.docs, locked: r.locked });
  check("кухня: заказ отмечен «в акте»", (r.client_orders || []).some((o) => o.id === o1.id && o.in_act === true), null);
  const o2 = await mk(1);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  check("кухня: поздний заказ — «после акта»", (r.client_orders || []).some((o) => o.id === o2.id && o.in_act === false), null);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: дополнительный акт только на поздний заказ", r.ok && r.made === 1, r);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  const act2 = r.docs.find((x) => /\/clients-zz_kassa-2$/.test(x.source_id));
  const doc = act2 && await call("office_doc_get", { token: t, id: act2.id });
  check("кухня: во втором акте 1 кг", doc && doc.ok && near((doc.doc.lines.find((l) => l.item_code === pie) || {}).qty, 1), doc && doc.doc && doc.doc.lines);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: повтор без новых заказов — актов не добавилось", r.ok && r.made === 0, r);
  r = await call("office_doc_delete", { token: t, id: act2.id });
  check("кухня: черновик второго акта удалён", r.ok, r);
  r = await call("office_stock_orders_report", { token: t, for_date: d });
  check("кухня: после удаления акта заказ снова «после акта»", (r.client_orders || []).some((o) => o.id === o2.id && o.in_act === false), r.client_orders);
  r = await call("office_corder_docs_save", { token: t, for_date: d });
  check("кухня: акт создаётся заново, номер не конфликтует", r.ok && r.made === 1, r);
  r = await call("corder_edit", { pin, point_id: "zz_kassa", seller: "ZZ_TEST_продавец", id: o2.id, lines: [{ item_code: pie, qty: 3 }] });
  check("кухня: строки заказа в акте не правятся", r.ok === false && r.error === "validation", r);
};

// 0070: полуфабрикаты раскладываются до сырья, как в iiko Тандема (у всех блюд и ПФ там выключено «учитывать
// остатки»): при продаже, в акте производства, при списании и на ревизии. Исключение - то, что склад получил
// готовым (перемещением или своим актом): оно списывается и считается само.
SECTIONS.raskladka = async (ctx) => {
  const t = ctx.token;
  const pin = process.env.TANDEM_OWNER_PIN || "";
  if (!pin) { console.log("  пропуск: нужен TANDEM_OWNER_PIN (отчёт точки сдаётся кодом)"); return; }
  const near = (a, b, e = 0.0005) => Math.abs(Number(a) - Number(b)) < e;
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад раскладки", point_id: "zz_test", is_default: true }); const P = r.id;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_кухня раскладки" }); const K = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик раскладки", kind: "supplier" }); const SUP = r.id;
  const mk = async (name, item_type, unit_id) => (await call("office_item_save", { token: t, name, item_type, unit_id })).code;
  const muka = await mk("ZZ_TEST_р мука", "goods", "кг"), myaso = await mk("ZZ_TEST_р мясо", "goods", "кг");
  const luk = await mk("ZZ_TEST_р лук", "goods", "кг"), sahar = await mk("ZZ_TEST_р сахар", "goods", "кг");
  const lukPf = await mk("ZZ_TEST_р лук очищ ПФ", "prepared", "кг"), farsh = await mk("ZZ_TEST_р фарш ПФ", "prepared", "кг");
  const kompPf = await mk("ZZ_TEST_р компот ПФ", "prepared", "л");
  const kotl = await mk("ZZ_TEST_р котлета", "dish", "шт"), komp = await mk("ZZ_TEST_р компот 200", "dish", "порц");
  const chart = (code, out, lines) => call("office_chart_save", { token: t, code, date_from: "2020-01-01", output_amount: out,
    lines: lines.map(([ingredient_code, brutto]) => ({ ingredient_code, brutto, netto: brutto, output: brutto })) });
  const ch = [await chart(lukPf, 1, [[luk, 1.25]]), await chart(farsh, 1, [[myaso, 0.8], [lukPf, 0.2]]),
    await chart(kompPf, 1, [[sahar, 0.1]]), await chart(kotl, 1, [[farsh, 0.1], [muka, 0.01]]), await chart(komp, 1, [[kompPf, 0.2]])];
  check("раскладка: подготовка - склады, позиции, карты", P && K && SUP && kotl && komp && ch.every((x) => x.ok), ch);
  for (const S of [P, K]) {
    r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-06-01", store_to: S, counteragent_id: SUP,
      lines: [{ item_code: muka, qty: 10, price: 100 }, { item_code: myaso, qty: 10, price: 1000 }, { item_code: luk, qty: 10, price: 50 }, { item_code: sahar, qty: 10, price: 200 }] });
    await call("office_doc_post", { token: t, id: r.id });
  }
  const bal = async (S, code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };
  const report = (date, sales) => call("save_report", { pin, point_id: "zz_test", date, comment: "ZZ_TEST_раскладка", cash: 1000, sales, takeout: [] });
  const saleDoc = async (date) => { const rows = (await call("office_doc_sales_list", { token: t, date_from: date, date_to: date, point_id: "zz_test" })).rows || [];
    return rows[0] && rows[0].doc_id ? (await call("office_doc_get", { token: t, id: rows[0].doc_id })).doc : null; };
  const cq = (d, code) => ((d && d.consume) || []).filter((c) => c.item_code === code).reduce((s, c) => s + Number(c.qty), 0);
  const forItem = (d, root, code) => ((d && d.consume) || []).filter((c) => c.for_item === root && c.item_code === code).reduce((s, c) => s + Number(c.qty), 0);

  // 1. Продажа: котлета → фарш ПФ → мясо и лук очищ ПФ → лук; компот 200 → компот ПФ → сахар.
  r = await report("2024-06-02", [{ item_code: kotl, item_name: "котлета", qty: 10, price: 500 }, { item_code: komp, item_name: "компот", qty: 5, price: 200 }]);
  let doc = await saleDoc("2024-06-02");
  check("раскладка: продажа списала сырьё - мясо 0,8, лук 0,25, мука 0,1, сахар 0,1, полуфабрикаты не тронуты",
    r.ok && doc && near(cq(doc, myaso), 0.8) && near(cq(doc, luk), 0.25) && near(cq(doc, muka), 0.1) && near(cq(doc, sahar), 0.1)
    && !doc.consume.some((c) => [farsh, lukPf, kompPf].includes(c.item_code)), doc && doc.consume);
  check("раскладка: полуфабрикаты на складе точки не ушли в минус",
    near(await bal(P, farsh), 0) && near(await bal(P, kompPf), 0) && near(await bal(P, lukPf), 0) && near(await bal(P, myaso), 9.2),
    { farsh: await bal(P, farsh), kompPf: await bal(P, kompPf), myaso: await bal(P, myaso) });

  // 2. Акт производства на кухне: фарш раскладывается до мяса и лука (лук очищ ПФ кухня не выпускала).
  r = await call("office_doc_save", { token: t, doc_type: "production", doc_date: "2024-06-03", store_from: K, lines: [{ item_code: farsh, qty: 3 }] });
  const act1 = r.id;
  r = await call("office_doc_preview", { token: t, id: act1 });
  check("раскладка: предпросмотр акта - мясо 2,4 и лук 0,75, без лука очищ ПФ", r.ok && near((r.consume.find((c) => c.item_code === myaso) || {}).qty, 2.4)
    && near((r.consume.find((c) => c.item_code === luk) || {}).qty, 0.75) && !r.consume.some((c) => c.item_code === lukPf), r.consume);
  r = await call("office_doc_post", { token: t, id: act1 });
  check("раскладка: акт проведён - фарш на кухне 3, мясо 7,6, лук 9,25",
    r.ok && near(await bal(K, farsh), 3) && near(await bal(K, myaso), 7.6) && near(await bal(K, luk), 9.25) && near(await bal(K, lukPf), 0), r);

  // 3. Перемещение фарша на склад точки: там он «готовым», продажа котлеты списывает фарш, а не мясо.
  r = await call("office_doc_save", { token: t, doc_type: "transfer", doc_date: "2024-06-03", store_from: K, store_to: P, lines: [{ item_code: farsh, qty: 2 }] });
  r = await call("office_doc_post", { token: t, id: r.id });
  check("раскладка: фарш перемещён на точку", r.ok && near(await bal(P, farsh), 2), r);
  await report("2024-06-04", [{ item_code: kotl, item_name: "котлета", qty: 10, price: 500 }]);
  doc = await saleDoc("2024-06-04");
  check("раскладка: фарш на точке готовым - списан фарш 1 и мука 0,1, мясо не тронуто",
    doc && near(cq(doc, farsh), 1) && near(cq(doc, muka), 0.1) && cq(doc, myaso) === 0 && near(await bal(P, farsh), 1) && near(await bal(P, myaso), 9.2),
    doc && doc.consume);

  // 4. Полуфабрикат, выпущенный в том же акте, расходуется готовым: фарш берёт выпущенный лук очищ ПФ, а не лук.
  r = await call("office_doc_save", { token: t, doc_type: "production", doc_date: "2024-06-05", store_from: K, lines: [{ item_code: lukPf, qty: 1 }, { item_code: farsh, qty: 2 }] });
  const act2 = r.id;
  r = await call("office_doc_post", { token: t, id: act2 });
  doc = (await call("office_doc_get", { token: t, id: act2 })).doc;
  check("раскладка: акт с полуфабрикатом внутри - фарш: лук очищ ПФ 0,4 и мясо 1,6; лук очищ ПФ: лук 1,25",
    r.ok && near(forItem(doc, farsh, lukPf), 0.4) && near(forItem(doc, farsh, myaso), 1.6) && near(forItem(doc, lukPf, luk), 1.25) && forItem(doc, farsh, luk) === 0,
    doc && doc.consume);
  check("раскладка: лук очищ ПФ на кухне 0,6", near(await bal(K, lukPf), 0.6), await bal(K, lukPf));

  // 5. Списание: компот ПФ на точке не хранится - списывается сахар; фарш там готовым - списывается сам.
  r = await call("office_doc_save", { token: t, doc_type: "writeoff", doc_date: "2024-06-06", store_from: P, reason: "spoilage",
    lines: [{ item_code: kompPf, qty: 0.5 }, { item_code: farsh, qty: 0.2 }] });
  const wo = r.id;
  r = await call("office_doc_preview", { token: t, id: wo });
  check("раскладка: предпросмотр списания - сахар 0,05 по техкарте", r.ok && near((r.consume.find((c) => c.item_code === sahar) || {}).qty, 0.05), r.consume);
  r = await call("office_doc_post", { token: t, id: wo });
  check("раскладка: списание - сахар 0,05 по техкарте, фарш 0,2 как есть, компот ПФ не в минусе",
    // фарш пришёл с кухни по себестоимости акта: (2,4 × 1000 + 0,75 × 50) / 3 = 812,5 за кг
    r.ok && near(await bal(P, sahar), 9.85) && near(await bal(P, farsh), 0.8) && near(await bal(P, kompPf), 0) && near(r.total_sum, 0.05 * 200 + 0.2 * 812.5, 0.01),
    { r, sahar: await bal(P, sahar), farsh: await bal(P, farsh) });

  // 6. Ревизия: компот ПФ 2 л - это сахар 0,2 к пересчитанному сахару; котлеты 3 шт - фарш 0,3 (готовым) и мука 0,03.
  // Сырьё, которого нет в описи (мука), не трогается: пересчитано только то, что в строках, - предпросмотр это называет.
  r = await call("office_doc_save", { token: t, doc_type: "inventory", doc_date: "2024-06-07", store_from: P,
    lines: [{ item_code: kompPf, fact_qty: 2 }, { item_code: sahar, fact_qty: 9 }, { item_code: kotl, fact_qty: 3 }, { item_code: farsh, fact_qty: 0.5 }] });
  const inv = r.id;
  r = await call("office_doc_preview", { token: t, id: inv });
  check("раскладка: предпросмотр ревизии - разложит компот и котлеты, муки нет в описи",
    r.ok && near((r.consume.find((c) => c.item_code === sahar) || {}).qty, 0.2) && near((r.consume.find((c) => c.item_code === farsh) || {}).qty, 0.3)
    && (r.skipped || []).some((s) => s.item_code === muka) && !(r.skipped || []).some((s) => s.item_code === sahar), r);
  r = await call("office_doc_post", { token: t, id: inv });
  check("раскладка: ревизия - сахар 9 + 0,2 из компота, фарш 0,5 + 0,3 из котлет, мука не тронута, ПФ и блюдо без остатка",
    r.ok && near(await bal(P, sahar), 9.2) && near(await bal(P, farsh), 0.8) && near(await bal(P, muka), 9.8) && near(await bal(P, kompPf), 0) && near(await bal(P, kotl), 0),
    { r, sahar: await bal(P, sahar), farsh: await bal(P, farsh), muka: await bal(P, muka), kotl: await bal(P, kotl) });
  doc = (await call("office_doc_get", { token: t, id: inv })).doc;
  check("раскладка: в проведённой ревизии видно разложенное", doc && doc.consume.some((c) => c.item_code === sahar && c.for_item === kompPf && near(c.qty, 0.2)), doc && doc.consume);
  r = await call("office_doc_unpost", { token: t, id: inv });
  check("раскладка: отмена ревизии вернула остатки", r.ok && near(await bal(P, sahar), 9.85) && near(await bal(P, farsh), 0.8), { r, sahar: await bal(P, sahar) });
  doc = (await call("office_doc_get", { token: t, id: inv })).doc;
  check("раскладка: после отмены разложенного в ревизии нет", doc && doc.consume.length === 0, doc && doc.consume);
  await call("office_doc_delete", { token: t, id: inv });

  // 7. Сводка собственника: «расход сырья» - тоже до сырья (компот 200 → сахар, а не компот ПФ).
  r = await call("dashboard", { pin, from: "2024-06-02", to: "2024-06-02" });
  const ru = (r.raw_usage || []);
  check("раскладка: сводка - расход сырья до сырья (сахар 0,1, мясо 0,8), без полуфабрикатов",
    r.ok && ru.some((x) => x.name === "ZZ_TEST_р сахар" && near(x.amount, 0.1)) && ru.some((x) => x.name === "ZZ_TEST_р мясо" && near(x.amount, 0.8))
    && !ru.some((x) => /ПФ/.test(x.name) && /^ZZ_TEST_р/.test(x.name)), ru);

  await call("office_store_save", { token: t, id: P, name: "ZZ_TEST_склад раскладки", point_id: null, is_default: false });
};

// 0071: расходная накладная - отгрузка стороннему покупателю: цена продажи в строке, выручка в сумме, со склада - как
// продажа (блюдо, которого склад не получает готовым, - сырьём по техкарте), отгрузки в ведомости вместе с продажами.
SECTIONS.invoice_out = async (ctx) => {
  const t = ctx.token;
  const near = (a, b, e = 0.0005) => Math.abs(Number(a) - Number(b)) < e;
  let r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад отгрузки" }); const S = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_поставщик отгрузки", kind: "supplier" }); const SUP = r.id;
  r = await call("office_counteragent_save", { token: t, name: "ZZ_TEST_покупатель", kind: "customer" }); const BUY = r.id;
  const mk = async (name, item_type, unit_id) => (await call("office_item_save", { token: t, name, item_type, unit_id })).code;
  const muka = await mk("ZZ_TEST_о мука", "goods", "кг"), bar = await mk("ZZ_TEST_о батончик", "goods", "шт");
  const pir = await mk("ZZ_TEST_о пирожок", "dish", "шт");
  r = await call("office_chart_save", { token: t, code: pir, date_from: "2020-01-01", output_amount: 1, lines: [{ ingredient_code: muka, brutto: 0.1, netto: 0.1, output: 0.1 }] });
  check("отгрузка: подготовка - склад, поставщик, покупатель, позиции, карта", S && SUP && BUY && pir && r.ok, r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_in", doc_date: "2024-07-01", store_to: S, counteragent_id: SUP,
    lines: [{ item_code: muka, qty: 10, price: 100 }, { item_code: bar, qty: 10, price: 50 }] });
  await call("office_doc_post", { token: t, id: r.id });
  const bal = async (code) => { const b = await call("office_stock_balances", { token: t, store_id: S, only_nonzero: false });
    const row = (b.rows || []).find((x) => x.item_code === code); return row ? Number(row.qty) : 0; };

  r = await call("office_doc_save", { token: t, doc_type: "invoice_out", doc_date: "2024-07-02", store_from: S, lines: [{ item_code: bar, qty: 1, price: 80 }] });
  check("отгрузка: без покупателя - validation", r.ok === false && r.error === "validation" && /покупател/.test(r.message || ""), r);
  r = await call("office_doc_save", { token: t, doc_type: "invoice_out", doc_date: "2024-07-02", store_from: S, counteragent_id: BUY,
    lines: [{ item_code: pir, qty: 20, price: 150 }, { item_code: bar, qty: 5, price: 80 }] });
  const out = r.id;
  check("отгрузка: черновик с номером РН", r.ok && /^РН-2024-\d{6}$/.test(r.number || ""), r);
  r = await call("office_doc_preview", { token: t, id: out });
  check("отгрузка: предпросмотр - пирожки спишут муку 2 кг", r.ok && near((r.consume.find((c) => c.item_code === muka) || {}).qty, 2) && r.warnings.length === 0, r);
  r = await call("office_doc_post", { token: t, id: out });
  check("отгрузка: проведена, сумма - выручка 20 × 150 + 5 × 80", r.ok && near(r.total_sum, 3400, 0.01), r);
  check("отгрузка: со склада ушли мука 2 (по техкарте) и батончики 5", near(await bal(muka), 8) && near(await bal(bar), 5) && near(await bal(pir), 0),
    { muka: await bal(muka), bar: await bal(bar), pir: await bal(pir) });
  let doc = (await call("office_doc_get", { token: t, id: out })).doc;
  check("отгрузка: строки - цена и выручка продажи, расход - себестоимость",
    doc && near((doc.lines.find((l) => l.item_code === pir) || {}).price, 150) && near((doc.lines.find((l) => l.item_code === pir) || {}).sum, 3000)
    && doc.consume.some((c) => c.item_code === muka && near(c.qty, 2) && near(c.sum, 200))
    && doc.consume.some((c) => c.item_code === bar && near(c.qty, 5) && near(c.sum, 250)), doc && { lines: doc.lines, consume: doc.consume });
  r = await call("office_stock_turnover_report", { token: t, store_id: S, date_from: "2024-07-01", date_to: "2024-07-31" });
  const tm = (r.rows || []).find((x) => x.item_code === muka);
  check("отгрузка: в ведомости - вместе с продажами, остаток сходится", r.ok && tm && near(tm.sales, 2) && near(tm.end_qty, 8), tm);
  r = await call("office_doc_unpost", { token: t, id: out });
  doc = (await call("office_doc_get", { token: t, id: out })).doc;
  check("отгрузка: отмена вернула остатки, цена продажи в строке осталась",
    r.ok && near(await bal(muka), 10) && near(await bal(bar), 10) && near((doc.lines.find((l) => l.item_code === pir) || {}).price, 150), r);
  r = await call("office_doc_save", { token: t, id: out, doc_type: "invoice_out", doc_date: "2024-07-02", store_from: S, counteragent_id: BUY,
    lines: [{ item_code: bar, qty: 2 }] });
  r = await call("office_doc_post", { token: t, id: out });
  check("отгрузка: без цены не проводится", r.ok === false && r.error === "validation" && /цен/i.test(r.message || ""), r);
  await call("office_doc_delete", { token: t, id: out });

  r = await call("office_user_save", { token: t, login: "zz_test_out_tech", name: "ZZ_TEST_Технолог отгрузки", role: "technologist", pin: TP });
  const tl = await call("office_login", { login: "zz_test_out_tech", pin: TP }); await call("office_change_pin", { token: tl.token, pin: TP });
  r = await call("office_doc_save", { token: tl.token, doc_type: "invoice_out", doc_date: "2024-07-03", store_from: S, counteragent_id: BUY, lines: [{ item_code: bar, qty: 1, price: 80 }] });
  check("отгрузка: технологу нельзя - forbidden", r.ok === false && r.error === "forbidden", r);
  r = await call("office_user_save", { token: t, login: "zz_test_out_sk", name: "ZZ_TEST_Кладовщик отгрузки", role: "storekeeper", pin: TP });
  const sk = await call("office_login", { login: "zz_test_out_sk", pin: TP }); await call("office_change_pin", { token: sk.token, pin: TP });
  r = await call("office_doc_save", { token: sk.token, doc_type: "invoice_out", doc_date: "2024-07-03", store_from: S, counteragent_id: BUY, lines: [{ item_code: bar, qty: 1, price: 80 }] });
  check("отгрузка: кладовщику (заведующей) можно", r.ok && r.id, r);
  if (r.ok) await call("office_doc_delete", { token: t, id: r.id });
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
try {
  for (const n of names) {
    if (!SECTIONS[n]) { console.log("нет раздела " + n); process.exit(2); }
    console.log("\n== " + n);
    await SECTIONS[n](ctx);
  }
} catch (e) {
  failed++; console.log("  FAIL раздел упал исключением: " + (e && e.stack || e));
} finally {
  // Уборка: тестовые записи не должны пережить прогон — даже упавший посередине.
  if (process.env.TANDEM_SERVICE_KEY) {
    console.log("\n== очистка");
    const r = await call("test_cleanup", {});
    check("очистка: следов нет", r.ok && r.leftovers === 0, r);
  } else {
    console.log("\n== ВНИМАНИЕ: очистка пропущена — задайте TANDEM_SERVICE_KEY, иначе записи ZZ_TEST_/zz_test_ останутся в базе");
  }
}

console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
