// Собирает db/schema/tandem_full.sql из результата запроса db/schema/snapshot-query.sql.
// Запуск: node tools/build-schema-snapshot.mjs <файл с JSON-результатом запроса>
// Файл может быть «грязным» (обёртка MCP вокруг массива) — берётся первый JSON-массив строк.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) { console.error("укажите файл с результатом запроса"); process.exit(2); }
let txt = fs.readFileSync(src, "utf8");
try { const o = JSON.parse(txt); if (o && typeof o.result === "string") txt = o.result; } catch {}
const rows = JSON.parse(txt.slice(txt.indexOf('[{"'), txt.lastIndexOf("}]") + 2));
const TITLES = { sequence: "последовательности", table: "таблицы", constraint: "ограничения", index: "индексы", fk: "внешние ключи",
  seqowner: "владельцы последовательностей", function: "функции", view: "представления", trigger: "триггеры",
  rls: "RLS: запрет всего, доступ только через функции" };
let out = `-- Полный снимок схемы учёта Тандем KZ (схема tandem + функции public.tandem_*).
-- Снят из боевой базы каталогом PostgreSQL ${new Date().toISOString().slice(0, 10)} запросом db/schema/snapshot-query.sql
-- и собран tools/build-schema-snapshot.mjs. Данных не содержит.
-- Назначение: поднять пустую базу на собственном сервере одной командой
--   psql -v ON_ERROR_STOP=1 -f db/schema/tandem_full.sql
-- затем db/schema/tandem_seed.sql. Проверяется подъёмом в Docker и дымовым тестом (server/README.md).

set check_function_bodies = off;   -- функции ссылаются друг на друга и на таблицы: порядок создания не важен
create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create schema if not exists tandem;
-- На Supabase pgcrypto живёт в схеме extensions, и функции ищут её в search_path; на своём сервере
-- схемы нет — создаём пустую, чтобы set search_path в функциях не ругался.
create schema if not exists extensions;
`;
let last = null; const count = {};
for (const r of rows.sort((a, b) => a.ord - b.ord || a.nm.localeCompare(b.nm))) {
  const kind = r.kind === "constraint" && r.ord === 40 ? "fk" : r.kind;
  count[kind] = (count[kind] || 0) + 1;
  if (kind !== last) { out += `\n-- ---------------------------------------------------------------- ${TITLES[kind]}\n`; last = kind; }
  out += r.sql.replace(/\r\n/g, "\n") + "\n" + (["function", "table", "view"].includes(r.kind) ? "\n" : "");
}
fs.writeFileSync(path.join(root, "db/schema/tandem_full.sql"), out);
console.log(JSON.stringify(count), "байт:", out.length);
