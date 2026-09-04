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
