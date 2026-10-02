// Превращает выгрузку таблиц (JSON {таблица: [строки]}) в SQL для загрузки в пустую базу со схемой
// db/schema/tandem_full.sql. Нужен для репетиции переезда и разового восстановления справочников.
// Запуск: node tools/backup-to-sql.mjs data/backup/<дата> > data/backup/restore.sql
//   затем psql -v ON_ERROR_STOP=1 -f data/backup/restore.sql (всё в одной транзакции: ошибка — откат целиком).
// Коды точек и PIN пользователей в выгрузку не входят: точкам ставятся случайные коды,
// пользователи не переносятся вовсе (заводятся заново).
import fs from "fs"; import path from "path"; import crypto from "crypto";
const dir = process.argv[2];
if (!dir) { console.error("укажите папку с выгрузкой"); process.exit(2); }
// catalog_1c — раньше items: items.code_1c ссылается на него.
const ORDER = ["item_groups", "points", "stores", "counteragents", "catalog_1c", "items", "item_prices", "item_rank", "item_aliases",
  "charts", "chart_lines", "doc_counters", "realization_clients", "realization_ledger"];
const data = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) Object.assign(data, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const out = ["begin;", "set local session_replication_role = replica;  -- триггеры и внешние ключи выключены на загрузку; ссылки проверяются в конце",
  // Вставка с явным списком колонок — тех, что есть и в выгрузке, и в таблице. Колонка, которой в выгрузке нет
  // (добавлена позже, например NOT NULL с умолчанием), получает своё DEFAULT, а не NULL; лишние ключи выгрузки
  // (колонку с тех пор убрали) пропускаются.
  `create function pg_temp.load(t text, j jsonb) returns void language plpgsql as $f$
declare cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
  from pg_attribute a
  where a.attrelid = format('tandem.%I', t)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and exists (select 1 from jsonb_array_elements(j) x where x ? a.attname);
  if cols is null then raise exception 'tandem.%: в выгрузке нет ни одной колонки таблицы', t; end if;
  execute format('insert into tandem.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::tandem.%I, $1)', t, cols, cols, t) using j;
end $f$;`];
const loaded = [];
for (const t of ORDER) {
  let rows = data[t]; if (!rows || !rows.length) continue;
  if (t === "points") rows = rows.map((r) => ({ ...r, pin: crypto.randomBytes(8).toString("hex") }));
  const tag = "$j" + crypto.randomBytes(4).toString("hex") + "$";
  // Данные есть — таблица перезаписывается целиком: загрузка рассчитана на пустую базу.
  out.push(`delete from tandem.${t};`);
  for (let i = 0; i < rows.length; i += 2000)
    out.push(`select pg_temp.load('${t}', ${tag}${JSON.stringify(rows.slice(i, i + 2000))}${tag}::jsonb);`);
  out.push(`-- ${t}: ${rows.length}`);
  loaded.push(t);
}
// Счётчик кодов позиций — дальше самого большого числового кода, иначе новая позиция получит занятый код.
out.push("select setval('tandem.item_code_seq', greatest((select coalesce(max(code::bigint), 0) from tandem.items where code ~ '^[0-9]+" + "$" + "'), (select last_value from tandem.item_code_seq)));");
// Счётчики identity-колонок загруженных таблиц — за самым большим id: строки пришли со своими id
// (overriding system value), и без сдвига первая новая запись упала бы на занятом ключе.
out.push(`do $$ declare r record; v bigint; begin
  for r in select c.relname t, a.attname col, pg_get_serial_sequence(format('tandem.%I', c.relname), a.attname) s
           from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'tandem'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
             and c.relname = any(array[${loaded.map((t) => `'${t}'`).join(", ")}]::name[])
             and pg_get_serial_sequence(format('tandem.%I', c.relname), a.attname) is not null loop
    execute format('select max(%I) from tandem.%I', r.col, r.t) into v;
    if v is not null then perform setval(r.s, v); end if;
  end loop;
end $$;`);
// Внешние ключи на загрузке не проверялись (replica) — проверяем все разом: висячая ссылка отменяет
// загрузку целиком, со списком ограничений и числом строк.
out.push(`do $$ declare r record; n bigint; bad text := ''; begin
  for r in select con.conname, con.conrelid::regclass child, con.confrelid::regclass parent,
                  (select string_agg(format('c.%I', a.attname), ', ' order by k.i) from unnest(con.conkey) with ordinality k(n, i)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) ccols,
                  (select string_agg(format('c.%I is not null', a.attname), ' and ' order by k.i) from unnest(con.conkey) with ordinality k(n, i)
                     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) filled,
                  (select string_agg(format('p.%I', a.attname), ', ' order by k.i) from unnest(con.confkey) with ordinality k(n, i)
                     join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) pcols
           from pg_constraint con where con.contype = 'f' and con.connamespace = 'tandem'::regnamespace loop
    execute format('select count(*) from %s c where %s and not exists (select 1 from %s p where (%s) = (%s))',
                   r.child, r.filled, r.parent, r.pcols, r.ccols) into n;
    if n > 0 then bad := bad || chr(10) || format('  %s (%s → %s): %s строк', r.conname, r.child, r.parent, n); end if;
  end loop;
  if bad <> '' then raise exception 'Висячие ссылки — загрузка отменена:%', bad; end if;
end $$;`);
out.push("commit;");
process.stdout.write(out.join("\n") + "\n");
