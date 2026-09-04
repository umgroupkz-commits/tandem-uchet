// Дымовой тест RPC бэк-офиса. Запуск: node tools/office-smoke.mjs <auth|nomenclature|stores|counteragents|users|all>
// Переменные окружения: TANDEM_ADMIN_LOGIN (по умолчанию admin), TANDEM_ADMIN_PIN.
// Создаёт сущности с префиксом ZZ_TEST_; удаление — SQL-ом после прогона (см. план).
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
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_мука", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
  check("items: вставка нового", r.ok && r.inserted === 1, r);
  r = await call("migrate", { pin, kind: "items", rows: [{ id: I, code: "ZZ_TEST_1", name: "ZZ_TEST_мука2", artikul: "", group_id: G, unit: "кг", type: "goods", deleted: false, price: null }] });
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
};

// --- разделы добавляются здесь ---

// migrate требует TANDEM_OWNER_PIN и в "all" входит только при его наличии;
// любой раздел кроме auth/migrate сначала прогоняет auth — ему нужен токен.
let names = section === "all"
  ? Object.keys(SECTIONS).filter((n) => n !== "migrate" || process.env.TANDEM_OWNER_PIN)
  : [section];
if (!names.includes("auth") && names.some((n) => n !== "migrate")) names = ["auth", ...names];
for (const n of names) {
  if (!SECTIONS[n]) { console.log("нет раздела " + n); process.exit(2); }
  console.log("\n== " + n);
  await SECTIONS[n](ctx);
}
console.log(`\nпройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
