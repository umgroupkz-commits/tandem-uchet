// Превращает выгрузку таблиц (JSON {таблица: [строки]}) в SQL для загрузки в пустую базу со схемой
// db/schema/tandem_full.sql. Нужен для репетиции переезда и разового восстановления справочников.
// Запуск: node tools/backup-to-sql.mjs data/backup/<дата> > restore.sql
// Коды точек и PIN пользователей в выгрузку не входят: точкам ставятся случайные коды,
// пользователи не переносятся вовсе (заводятся заново).
import fs from "fs"; import path from "path"; import crypto from "crypto";
const dir = process.argv[2];
if (!dir) { console.error("укажите папку с выгрузкой"); process.exit(2); }
const ORDER = ["item_groups", "points", "stores", "counteragents", "items", "item_prices", "item_rank", "item_aliases",
  "charts", "chart_lines", "doc_counters", "realization_clients", "realization_ledger"];
const data = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) Object.assign(data, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const out = ["begin;", "set local session_replication_role = replica;  -- внешние ключи проверим после загрузки"];
for (const t of ORDER) {
  let rows = data[t]; if (!rows || !rows.length) continue;
  if (t === "points") rows = rows.map((r) => ({ ...r, pin: crypto.randomBytes(8).toString("hex") }));
  const tag = "$j" + crypto.randomBytes(4).toString("hex") + "$";
  // Данные есть — таблица перезаписывается целиком: загрузка рассчитана на пустую базу.
  out.push(`delete from tandem.${t};`);
  for (let i = 0; i < rows.length; i += 2000)
    out.push(`insert into tandem.${t} overriding system value select * from jsonb_populate_recordset(null::tandem.${t}, ${tag}${JSON.stringify(rows.slice(i, i + 2000))}${tag}::jsonb);`);
  out.push(`-- ${t}: ${rows.length}`);
}
// Счётчик кодов позиций — дальше самого большого числового кода, иначе новая позиция получит занятый код.
out.push("select setval('tandem.item_code_seq', greatest((select coalesce(max(code::bigint), 0) from tandem.items where code ~ '^[0-9]+" + "$" + "'), (select last_value from tandem.item_code_seq)));");
out.push("commit;");
process.stdout.write(out.join("\n") + "\n");
