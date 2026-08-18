FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
COPY ui ./ui

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "server.mjs"]
