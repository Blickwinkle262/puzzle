FROM node:20-alpine AS deps
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

RUN apk add --no-cache python3 py3-pip \
  && python3 -m pip install --no-cache-dir uv openai aiohttp ebooklib \
  && ln -sf python3 /usr/bin/python

COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY scripts ./scripts
COPY web/public ./web/public

RUN mkdir -p /app/backend/data

EXPOSE 8787
CMD ["node", "backend/src/server.js"]
