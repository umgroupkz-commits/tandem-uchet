FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY proxy.mjs ./
USER node
CMD ["node", "proxy.mjs"]
