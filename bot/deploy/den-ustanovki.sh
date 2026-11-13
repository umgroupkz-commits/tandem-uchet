#!/usr/bin/env bash
# День установки сервера Енешки (PS.kz eneshka-bot): «Узел» и бот заказов. С машины владельца, Git Bash,
# из корня репозитория учёта. Шаги по порядку, каждый можно повторить:
#
#   bash bot/deploy/den-ustanovki.sh proverka    # DNS uzel/bot.eneshka.kz и вход по ключу
#   bash bot/deploy/den-ustanovki.sh podgotovka  # podgotovka-servera.sh «Узла» от root: пользователь uzel, ufw, Docker, подкачка
#   bash bot/deploy/den-ustanovki.sh uzel        # выкатка «Узла» (deploy/vykatit.sh его репозитория) на этот сервер
#   bash bot/deploy/den-ustanovki.sh bot         # образ бота, папка ~/bot-eneshka, .env, заготовка bot.env
#   bash bot/deploy/den-ustanovki.sh klyuch      # ключ бота к учёту в bot.env; печатает отпечаток для bot_key_hash
#   bash bot/deploy/den-ustanovki.sh pusk        # бот, поддомен через sayt.sh «Узла», вебхуки, /health
#
# Между «bot» и «klyuch» Андрей сам вписывает ключи на сервере: ssh uzel@IP, cd ~/bot-eneshka,
# bash vpisat.sh UZEL_API_KEY (и ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID).
# Секреты этот сценарий не печатает и с сервера не забирает.
set -euo pipefail
cd "$(dirname "$0")/../.."

IP=213.155.20.51
KEY="$HOME/.ssh/eneshka_vps"
UZEL_REPO="/c/Вайбкодинг/Альтернатива Wazzup"
DOMEN_UZLA=uzel.eneshka.kz
DOMEN_BOTA=bot.eneshka.kz
NAZVANIE="Енешка"                  # видно на экране входа «Узла» и в тревогах
POCHTA_LE="${POCHTA_LE:-tandem_kz@bk.ru}"   # учётная запись Let's Encrypt (писем о сроке нет)
PAPKA=bot-eneshka
OBRAZ=tandem.invalid/eneshka-bot

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15)
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
[ -f "$KEY" ] || die "нет ключа $KEY"

# Первые две строки ответа nslookup - сам DNS-сервер; «Name:» не ищем: русская Windows пишет «Имя:».
dns_ok() { nslookup "$1" 8.8.8.8 2>/dev/null | tail -n +3 | grep -qF "$IP"; }
na_servere() { "${SSH[@]}" "uzel@$IP" "$@"; }

case "${1:-}" in
proverka)
  for d in "$DOMEN_UZLA" "$DOMEN_BOTA"; do
    if dns_ok "$d"; then echo "DNS $d -> $IP: да"; else echo "DNS $d -> $IP: пока нет"; fi
  done
  if "${SSH[@]}" -o BatchMode=yes "uzel@$IP" true 2>/dev/null; then echo "вход uzel@$IP по ключу: да (сервер подготовлен)"
  elif "${SSH[@]}" -o BatchMode=yes "root@$IP" true 2>/dev/null; then echo "вход root@$IP по ключу: да (можно podgotovka)"
  else echo "вход по ключу: нет (ключ ещё не на сервере)"; fi
  ;;

podgotovka)
  say "Подготовка сервера сценарием «Узла» (от root)"
  "${SSH[@]}" -o BatchMode=yes "root@$IP" true || die "root@$IP по ключу не пускает - ключ ещё не добавлен"
  "${SCP[@]}" "$UZEL_REPO/deploy/podgotovka-servera.sh" "root@$IP:"
  "${SSH[@]}" "root@$IP" "bash podgotovka-servera.sh '$(cat "$KEY.pub")'"
  na_servere -o BatchMode=yes 'echo "вход uzel: да, $(free -m | awk "/Mem:/{print \$2}") МБ памяти, подкачка $(free -m | awk "/Swap:/{print \$2}") МБ"'
  ;;

uzel)
  dns_ok "$DOMEN_UZLA" || die "$DOMEN_UZLA ещё не указывает на $IP: без этого сертификат не выдадут"
  say "Выкатка «Узла» на $IP ($DOMEN_UZLA)"
  ( cd "$UZEL_REPO" && UZEL_SSH_KEY="$KEY" UZEL_DOMAIN="$DOMEN_UZLA" INSTALL_NAME="$NAZVANIE" UZEL_TLS="$POCHTA_LE" \
      bash deploy/vykatit.sh "uzel@$IP" )
  ;;

bot)
  VER="$(git rev-parse --short=12 HEAD)"
  [ -z "$(git status --porcelain -- bot)" ] || die "в папке bot есть незакоммиченные правки - образ собирается из коммита"
  say "Образ $OBRAZ:$VER"
  docker image inspect "$OBRAZ:$VER" >/dev/null 2>&1 || docker build -q --platform linux/amd64 -t "$OBRAZ:$VER" bot
  if na_servere "docker image inspect $OBRAZ:$VER >/dev/null 2>&1"; then echo "на сервере уже есть"
  else docker save "$OBRAZ:$VER" | gzip | na_servere 'gunzip | docker load'; fi
  say "Папка ~/$PAPKA"
  na_servere "mkdir -p ~/$PAPKA && chmod 700 ~/$PAPKA"
  "${SCP[@]}" bot/deploy/docker-compose.yml bot/deploy/vpisat.sh "uzel@$IP:$PAPKA/"
  [ -f bot/deploy/bot.env.example ] && "${SCP[@]}" bot/deploy/bot.env.example "uzel@$IP:$PAPKA/"
  na_servere "VER=$VER PAPKA=$PAPKA bash -s" <<'NA_SERVERE'
set -euo pipefail
cd ~/"$PAPKA"
umask 077
rnd() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# .env compose: пароль базы бота создаётся один раз и не печатается; версия образа - каждый раз.
[ -f .env ] || printf 'BOT_DB_PASSWORD=%s\n' "$(rnd)" > .env
grep -v '^BOT_VERSIYA=' .env > .env.tmp || true
printf 'BOT_VERSIYA=%s\n' "$VER" >> .env.tmp
cat .env.tmp > .env && rm -f .env.tmp
if [ ! -f bot.env ]; then
  cp bot.env.example bot.env
  sed -i "s/^TELEGRAM_WEBHOOK_SECRET=$/TELEGRAM_WEBHOOK_SECRET=$(rnd)/" bot.env
fi
chmod 600 .env bot.env
rm -f bot.env.example
pusto="$(grep -E '^[A-Z_]+=$' bot.env | cut -d= -f1 | tr '\n' ' ')"
echo "bot.env на месте. Пустые: ${pusto:-нет}"
NA_SERVERE
  ;;

klyuch)
  say "Ключ бота к учёту"
  na_servere "PAPKA=$PAPKA bash -s" <<'NA_SERVERE'
set -euo pipefail
cd ~/"$PAPKA"
if grep -qE '^UCHET_SERVICE_KEY=.+' bot.env; then echo "UCHET_SERVICE_KEY уже есть - новый не делаю"; exit 0; fi
# Одноразовый контейнер из образа бота: Deno на сервере нет. root внутри - чтобы прочесть bot.env с правами 600.
docker compose run --rm --no-deps -T --user 0 -v "$PWD/bot.env:/tmp/bot.env" --entrypoint deno bot \
  run --allow-read=/tmp/bot.env --allow-write=/tmp/bot.env scripts/bot-key.ts /tmp/bot.env
NA_SERVERE
  echo "Отпечаток выше - в настройку учёта bot_key_hash (сам ключ остался только в bot.env на сервере)."
  ;;

pusk)
  dns_ok "$DOMEN_BOTA" || die "$DOMEN_BOTA ещё не указывает на $IP"
  say "Проверка bot.env и запуск бота"
  na_servere "PAPKA=$PAPKA bash -s" <<'NA_SERVERE'
set -euo pipefail
cd ~/"$PAPKA"
nuzhny="UZEL_BASE_URL UZEL_API_KEY UCHET_API_URL UCHET_SERVICE_KEY PUBLIC_BASE_URL"
# Тихий режим (BOT_MODE=silent): бот только слушает WhatsApp, модель и Telegram ему не нужны.
grep -qE '^BOT_MODE=silent' bot.env || nuzhny="$nuzhny ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_OWNER_ID"
net=""
for n in $nuzhny; do grep -qE "^$n=.+" bot.env || net="$net $n"; done
[ -z "$net" ] || { echo "ОШИБКА: в bot.env пусто:$net (bash vpisat.sh ИМЯ / den-ustanovki.sh klyuch)" >&2; exit 1; }
docker compose up -d
for i in $(seq 1 30); do
  docker compose exec -T bot deno eval "const r=await fetch('http://127.0.0.1:8080/health');if(!r.ok)Deno.exit(1)" 2>/dev/null && break
  [ "$i" = 30 ] && { docker compose logs --tail 30 bot; echo "ОШИБКА: бот не отвечает на /health" >&2; exit 1; }
  sleep 2
done
echo "бот отвечает внутри сервера"
NA_SERVERE
  say "Поддомен $DOMEN_BOTA через дверь «Узла»"
  na_servere "cd ~/uzel && (bash deploy/sayt.sh spisok | grep -q '$DOMEN_BOTA' || bash deploy/sayt.sh dobavit $DOMEN_BOTA bot-eneshka:8080)"
  for i in $(seq 1 30); do
    curl -fsS --max-time 10 "https://$DOMEN_BOTA/health" >/dev/null 2>&1 && break
    [ "$i" = 30 ] && die "https://$DOMEN_BOTA/health не отвечает (сертификат или дверь)"
    sleep 5
  done
  say "Вебхуки «Узла» и Telegram"
  na_servere "PAPKA=$PAPKA bash -s" <<'NA_SERVERE'
set -euo pipefail
cd ~/"$PAPKA"
docker compose run --rm --no-deps -T --user 0 -v "$PWD/bot.env:/tmp/bot.env" --entrypoint deno bot \
  run --allow-net --allow-env --allow-read=/tmp/bot.env --allow-write=/tmp/bot.env scripts/register.ts /tmp/bot.env
docker compose up -d --force-recreate bot
NA_SERVERE
  sleep 10
  echo "Снаружи: $(curl -fsS --max-time 10 "https://$DOMEN_BOTA/health")"
  ;;

*)
  sed -n '2,14p' "$0"; exit 2 ;;
esac
