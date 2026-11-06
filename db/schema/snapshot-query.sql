-- Запрос, которым снимается db/schema/tandem_full.sql. Сам запрос по каталогу PostgreSQL живёт в функции
-- tandem.schema_snapshot() (миграция 0056): её же отдаёт служебное действие гейта schema_snapshot, так что обычно
-- достаточно одной команды:  node tools/schema-snapshot-pull.mjs
-- Вручную (SQL-редактор Supabase или MCP execute_sql): результат этого запроса сохранить в файл и собрать
--   node tools/build-schema-snapshot.mjs <файл-с-результатом>
select (r->>'ord')::int as ord, r->>'kind' as kind, r->>'nm' as nm, r->>'sql' as sql
from jsonb_array_elements(tandem.schema_snapshot()) r
order by 1, 3;
