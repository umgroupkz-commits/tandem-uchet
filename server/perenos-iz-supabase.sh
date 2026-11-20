#!/usr/bin/env bash
# Перенос данных учёта из Supabase в tandem-db на сервере PS.kz (20.11.2026) без строки подключения к базе
# Supabase: её знает только Андрей, а пароль сбрасывать нельзя - в том же проекте живёт FBSM. Временная функция
# Supabase tandem-export (public.tandem_export_tmp, только service role) отдаёт таблицы схемы tandem в JSON по
# ключу из ~/.tandem-export-key; загрузка - одной транзакцией с отключёнными внешними ключами и триггерами, затем
# сверка: число строк и md5 каждой таблицы против значений, посчитанных на стороне Supabase.
# Запуск на сервере из ~/tandem:  bash server/perenos-iz-supabase.sh
# Повторный запуск безопасен: таблицы tandem перед загрузкой очищаются. Финальный прогон - когда запись в
# Supabase закрыта (функция uchet в режиме «переехал»), иначе сверка покажет расхождения по живым таблицам.
set -euo pipefail
URL="https://qeehxcnnuzuwskznhdyg.supabase.co/functions/v1/tandem-export"
KEY=$(tr -dc '0-9a-f' < ~/.tandem-export-key)
DIR=$(mktemp -d ~/tandem-perenos.XXXX)
chmod 700 "$DIR"
trap 'rm -rf "$DIR"; docker exec tandem-db rm -rf /tmp/perenos >/dev/null 2>&1 || true' EXIT
get() { curl -fsS --retry 3 --max-time 120 -H "x-export-key: $KEY" "$URL?t=$1" -o "$DIR/$1.json"; }

get __meta
TABLES=$(python3 -c 'import json,sys; print(" ".join(t["t"] for t in json.load(open(sys.argv[1]))["tables"]))' "$DIR/__meta.json")
for t in $TABLES; do get "$t"; done
echo "выгружено таблиц: $(echo $TABLES | wc -w), $(du -sh "$DIR" | cut -f1)"

python3 - "$DIR" > "$DIR/load.sql" <<'PY'
import json, sys
m = json.load(open(sys.argv[1] + "/__meta.json"))
ts = [t["t"] for t in m["tables"]]
print("begin;")
print("set session_replication_role = replica;")   # внешние ключи и триггеры не мешают порядку загрузки
print("truncate " + ", ".join(f'tandem."{t}"' for t in ts) + " cascade;")
for t in ts:
    print(f"insert into tandem.\"{t}\" overriding system value select * from "
          f"json_populate_recordset(null::tandem.\"{t}\", pg_read_file('/tmp/perenos/{t}.json')::json);")
for s in m.get("seqs") or []:
    print(f"select setval('tandem.\"{s['s']}\"', {int(s['v'])}, true);")
print("commit;")
PY

docker exec tandem-db rm -rf /tmp/perenos
docker cp "$DIR" tandem-db:/tmp/perenos >/dev/null
docker exec tandem-db chown -R postgres /tmp/perenos
docker exec -i tandem-db psql -U tandem -d tandem -v ON_ERROR_STOP=1 -q < "$DIR/load.sql" >/dev/null
echo "загружено одной транзакцией"

# Сверка тем же выражением, что считает public.tandem_export_tmp('__meta') в Supabase. md5 - по to_jsonb(строка):
# ключи jsonb отсортированы, а порядок колонок в базе из снимка отличается от Supabase, где колонки добавляли
# миграциями (по тексту строки x::text расходились 5 таблиц при совпадающих данных). Порядок строк - побайтовый
# (collate "C"): сортировка по правилам языка в Supabase и здесь разная, и без него расходились ещё 4 таблицы.
docker exec -i tandem-db psql -U tandem -d tandem -At > "$DIR/target.json" <<'SQL'
select json_agg(json_build_object('t', tablename,
  'n', (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from tandem.%I', tablename), false, true, '')))[1]::text::bigint,
  'md5', (xpath('/row/m/text()', query_to_xml(format('select md5(coalesce(string_agg(to_jsonb(x)::text, E''\n'' order by to_jsonb(x)::text collate "C"), '''')) as m from tandem.%I x', tablename), false, true, '')))[1]::text
) order by tablename) from pg_tables where schemaname = 'tandem';
SQL
python3 - "$DIR/__meta.json" "$DIR/target.json" <<'PY'
import json, sys
src = {t["t"]: t for t in json.load(open(sys.argv[1]))["tables"]}
dst = {t["t"]: t for t in json.load(open(sys.argv[2]))}
bad = 0
for name in sorted(set(src) | set(dst)):
    a, b = src.get(name), dst.get(name)
    if not a or not b:
        print(f"  НЕТ ТАБЛИЦЫ {name}: Supabase {'есть' if a else 'нет'}, сервер {'есть' if b else 'нет'}"); bad += 1; continue
    if a["n"] != b["n"] or a["md5"] != b["md5"]:
        print(f"  РАСХОЖДЕНИЕ {name}: строк {a['n']} / {b['n']}, md5 {'совпал' if a['md5'] == b['md5'] else 'не совпал'}"); bad += 1
print(f"сверка: таблиц {len(src)}, строк {sum(t['n'] for t in src.values())}, расхождений {bad}")
sys.exit(1 if bad else 0)
PY
