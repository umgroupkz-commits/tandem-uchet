# Сборка из корня репозитория (docker-compose: context ..): прокси берёт общие модули фискализации
# из supabase/functions/uchet (webkassa.js, fiscal.js) - те же, что у Edge Function.
FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/proxy.mjs ./
COPY supabase/functions/uchet/webkassa.js supabase/functions/uchet/fiscal.js /app/supabase/functions/uchet/
USER node
CMD ["node", "proxy.mjs"]
