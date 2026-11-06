# Бот приёма заказов Енешки. Образ собирается на машине владельца (на 1 ГБ сервере сборка не идёт)
# и передаётся на сервер: docker save | ssh ... docker load, как образы «Узла».
FROM denoland/deno:2.9.5
WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
COPY sql ./sql
COPY main.ts ./
# Скрипты ключа учёта и вебхуков запускаются на сервере одноразовым контейнером: Deno на сервере нет.
COPY scripts ./scripts
RUN deno install --entrypoint main.ts scripts/bot-key.ts scripts/register.ts && chown -R deno:deno /app
USER deno
EXPOSE 8080
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
