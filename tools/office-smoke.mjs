// Дымовой тест RPC бэк-офиса.
// Запуск: node tools/office-smoke.mjs <auth|nomenclature|stores|counteragents|users|charts|migrate|reimport|all>
// Переменные окружения: TANDEM_ADMIN_LOGIN (по умолчанию admin), TANDEM_ADMIN_PIN,
//   TANDEM_OWNER_PIN — код собственника; без него не идут разделы migrate/reimport и уборка.
// Создаёт сущности с префиксом ZZ_TEST_ (пользователи — zz_test_). В конце прогона раннер
// зовёт действие test_cleanup (RPC public.tandem_test_cleanup) и проверяет, что следов не осталось.
const UCHET = "https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/uchet";
const section = process.argv[2] || "all";
let failed = 0, passed = 0;

export async function call(action, payload) {
  const r = await fetch(UCHET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload: payload || {} }),
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

  r = await call("migrate", { pin: "wrong", kind: "groups", rows: [] });
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
  r = await call("office_item_get", { token: t, code: "нет-такого" });
  check("карточка: not_found", r.ok === false && r.error === "not_found", r);
  r = await call("office_item_save", { token: t, name: "x", item_type: "фигня", unit_id: "кг" });
  check("тип не из списка — validation", r.ok === false && r.error === "validation", r);
};

SECTIONS.stores = async (ctx) => {
  const t = ctx.token;
  let r = await call("office_stores_list", { token: t });
  check("склады: список с точками", r.ok && r.stores.length >= 27 && Array.isArray(r.points) && r.points.length >= 5, { n: r.stores && r.stores.length });
  // Раздел трогает склад по умолчанию точки «Аян» — запоминаем, чтобы вернуть как было.
  const aianWas = (r.stores || []).find((x) => x.point_id === "aian" && x.is_default === true) || null;
  r = await call("office_store_save", { token: t, name: "ZZ_TEST_склад", point_id: "aian", is_default: true });
  check("склад: создание с привязкой и по умолчанию", r.ok && r.id, r);
  const id = r.id;
  r = await call("office_stores_list", { token: t });
  const s = r.stores.find((x) => x.id === id);
  check("склад: виден как по умолчанию у Аяна", s && s.point_id === "aian" && s.is_default === true, s);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: null, is_default: false, active: false });
  check("склад: отвязка и деактивация", r.ok, r);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: "aian", active: false, is_default: true });
  check("выключенный склад не становится складом по умолчанию", r.ok, r);
  r = await call("office_stores_list", { token: t });
  const s2 = r.stores.find((x) => x.id === id);
  check("у Аяна нет склада по умолчанию после этого", s2 && s2.is_default !== true && !r.stores.some((x) => x.point_id === "aian" && x.is_default === true), s2);
  r = await call("office_store_save", { token: t, id, name: "ZZ_TEST_склад", point_id: "нет-такой" });
  check("склад: чужая точка — validation", r.ok === false && r.error === "validation", r);
  // возвращаем точке её прежний склад по умолчанию
  if (aianWas) {
    await call("office_store_save", { token: t, id: aianWas.id, name: aianWas.name,
      point_id: "aian", active: aianWas.active !== false, is_default: true });
  }
  r = await call("office_stores_list", { token: t });
  const aianNow = (r.stores || []).find((x) => x.point_id === "aian" && x.is_default === true) || null;
  check("склад по умолчанию точки «Аян» — как до теста",
    (aianNow && aianNow.id) === (aianWas && aianWas.id) || (!aianNow && !aianWas),
    { было: aianWas && aianWas.id, стало: aianNow && aianNow.id });
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
  r = await call("office_user_save", { token: t, id: uid, login: "zz_test_sklad", name: "ZZ_TEST_Кладовщик", role: "storekeeper", active: false });
  check("деактивация", r.ok, r);
  r = await call("office_login", { login: "zz_test_sklad", pin: "5555" });
  check("выключенный не входит", r.ok === false && r.error === "unauthorized", r);

  // --- матрица ролей: каждая роль видит ровно то, что записано в role_permissions ---
  // Ожидания взяты из спецификации 3.5 и обязаны совпасть с содержимым таблицы.
  // Раздел charts добавлен миграцией 0010 (техкарты): технолог правит, бухгалтер только смотрит.
  const MATRIX = {
    zz_test_owner: { role: "owner", name: "ZZ_TEST_Собственник",
      perms: ["charts:edit", "charts:view", "counteragents:edit", "counteragents:view", "nomenclature:edit", "nomenclature:view", "stores:edit", "stores:view"] },
    zz_test_buh: { role: "accountant", name: "ZZ_TEST_Бухгалтер",
      perms: ["charts:view", "counteragents:edit", "counteragents:view", "nomenclature:view", "stores:view"] },
    zz_test_tech: { role: "technologist", name: "ZZ_TEST_Технолог",
      perms: ["charts:edit", "charts:view", "counteragents:view", "nomenclature:edit", "nomenclature:view", "stores:view"] },
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
    r.ok === false && r.error === "unauthorized" && /Слишком много попыток/.test(r.message || ""), r);

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

// --- разделы добавляются здесь ---

// migrate и reimport требуют TANDEM_OWNER_PIN и в "all" входят только при его наличии;
// любой раздел кроме auth/migrate сначала прогоняет auth — ему нужен токен.
const NEEDS_OWNER = ["migrate", "reimport"];
let names = section === "all"
  ? Object.keys(SECTIONS).filter((n) => !NEEDS_OWNER.includes(n) || process.env.TANDEM_OWNER_PIN)
  : [section];
if (!names.includes("auth") && names.some((n) => n !== "migrate")) names = ["auth", ...names];
for (const n of names) {
  if (!SECTIONS[n]) { console.log("нет раздела " + n); process.exit(2); }
  console.log("\n== " + n);
  await SECTIONS[n](ctx);
}

// Уборка: тестовые записи не должны пережить прогон.
if (process.env.TANDEM_OWNER_PIN) {
  console.log("\n== очистка");
  const r = await call("test_cleanup", { pin: process.env.TANDEM_OWNER_PIN });
  check("очистка: следов нет", r.ok && r.leftovers === 0, r);
} else {
  console.log("\n== очистка пропущена: задайте TANDEM_OWNER_PIN, чтобы убрать записи ZZ_TEST_/zz_test_");
}

console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
