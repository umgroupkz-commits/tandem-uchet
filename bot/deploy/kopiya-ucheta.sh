#!/usr/bin/env bash
# Копия базы учёта Тандема - С СЕРВЕРА PS.kz НА ЭТОТ КОМПЬЮТЕР (20.11.2026, переезд учёта из Supabase на сервер).
# На сервере служба tandem-backup раз в сутки (03:40 по Алматы) снимает дамп в /home/uzel/tandem-backups и
# держит 30 последних. Копия на том же диске не спасает от потери сервера - поэтому каждый день самая свежая
# копия забирается сюда. Совпадение проверяется sha256 на обеих сторонах: оборванная передача не встанет копией.
#
# Запуск из Git Bash:   bash bot/deploy/kopiya-ucheta.sh
# Каждый день сам - задание Планировщика ставит bot/deploy/kopiya-ucheta-raspisanie.ps1.
# Куда: TANDEM_KOPII_DIR, по умолчанию «Копии учёта Тандема» в папке пользователя (не «Документы»: их часто
# синхронизирует OneDrive). Копия НЕ ЗАШИФРОВАНА: в ней коды точек, хэши PIN, клиенты и выручка.
# Восстановление - server/README.md, «Восстановление из своей копии».
set -euo pipefail
SERVER="${TANDEM_SERVER:-uzel@213.155.20.51}"
KEY="${TANDEM_SSH_KEY:-$HOME/.ssh/eneshka_vps}"
DIR="${TANDEM_KOPII_DIR:-$HOME/Копии учёта Тандема}"
HRANIT="${TANDEM_KOPII_HRANIT:-30}"
REMOTE_DIR=/home/uzel/tandem-backups

mkdir -p "$DIR"
LOG="$DIR/zhurnal.txt"
[ "${1:-}" = "--zhurnal" ] && exec >>"$LOG" 2>&1
stamp() { date '+%F %T'; }
s() { ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 "$SERVER" "$@"; }

# Файлы копий пишет root (umask 077) - читаем через sudo.
latest=$(s "sudo sh -c 'ls -1t $REMOTE_DIR/tandem_*.dump 2>/dev/null | head -1'")
if [ -z "$latest" ]; then echo "$(stamp) ОШИБКА: на сервере нет ни одной копии в $REMOTE_DIR"; exit 1; fi
name=$(basename "$latest")
if [ -f "$DIR/$name" ]; then echo "$(stamp) уже есть $name"; exit 0; fi

s "sudo cat '$latest'" > "$DIR/$name.part"
want=$(s "sudo sha256sum '$latest'" | cut -d' ' -f1)
got=$(sha256sum "$DIR/$name.part" | cut -d' ' -f1)
if [ "$want" != "$got" ]; then rm -f "$DIR/$name.part"; echo "$(stamp) ОШИБКА: $name пришла не целиком (sha256 не совпал)"; exit 1; fi
mv "$DIR/$name.part" "$DIR/$name"
echo "$(stamp) копия $name, $(du -h "$DIR/$name" | cut -f1)"

# Оставить последние HRANIT копий
ls -1t "$DIR"/tandem_*.dump 2>/dev/null | tail -n +"$((HRANIT + 1))" | while read -r f; do rm -f -- "$f"; done
