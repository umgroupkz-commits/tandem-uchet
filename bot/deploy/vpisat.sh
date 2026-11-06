#!/usr/bin/env bash
# Вписать ключ в bot.env без показа на экране и в журнале. На сервере Енешки, в ~/bot-eneshka:
#   bash vpisat.sh UZEL_API_KEY | ANTHROPIC_API_KEY | TELEGRAM_BOT_TOKEN | TELEGRAM_OWNER_ID
# Файл правится на месте (тот же файл, права 600 остаются), прежнее значение заменяется.
# Бот подхватит ключ после перезапуска: docker compose up -d --force-recreate bot
set -euo pipefail
cd "$(dirname "$0")"

IMENA="UZEL_API_KEY ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID"
name="${1:-}"
case " $IMENA " in
  *" $name "*) [ -n "$name" ] || { echo "Укажите имя: $IMENA" >&2; exit 2; } ;;
  *) echo "Имя - одно из: $IMENA" >&2; exit 2 ;;
esac
[ -f bot.env ] || { echo "Нет bot.env рядом со скриптом - сначала den-ustanovki.sh bot" >&2; exit 1; }
[ -t 0 ] || { echo "Нужен терминал: значение вводится руками, без показа" >&2; exit 1; }

read -r -s -p "$name (ввод не виден): " val
echo
val="${val%$'\r'}"
[ -n "$val" ] || { echo "Пусто - ничего не меняю" >&2; exit 1; }
case "$val" in *[[:space:]]*) echo "В значении пробел или перевод строки - ничего не меняю" >&2; exit 1 ;; esac
if [ "$name" = TELEGRAM_OWNER_ID ] && ! [[ $val =~ ^[0-9]+$ ]]; then
  echo "TELEGRAM_OWNER_ID - только цифры (числовой id в Telegram)" >&2; exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -v "^$name=" bot.env > "$tmp" || true
printf '%s=%s\n' "$name" "$val" >> "$tmp"
cat "$tmp" > bot.env
echo "$name вписан (${#val} знаков). Перезапуск бота: docker compose up -d --force-recreate bot"
