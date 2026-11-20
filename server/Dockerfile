# Сборка из корня репозитория (docker-compose: context ..): прокси берёт общие модули фискализации
# из supabase/functions/uchet (webkassa.js, fiscal.js) - те же, что у Edge Function.
FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/proxy.mjs ./
COPY supabase/functions/uchet/webkassa.js supabase/functions/uchet/fiscal.js /app/supabase/functions/uchet/
# Экраны учёта (рабочая программа на адресе сервера). config.js из репозитория не копируется: он для GitHub Pages
# (тестовая база), рабочий прокси пишет сам.
COPY *.html *.css app.js /app/site/
COPY js /app/site/js
COPY vendor /app/site/vendor
ENV SITE_DIR=/app/site
USER node
CMD ["node", "proxy.mjs"]
