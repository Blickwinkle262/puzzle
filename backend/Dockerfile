FROM node:20-alpine AS deps
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

RUN apk add --no-cache python3 py3-pip \
  && python3 -m venv /opt/storygen-venv \
  && /opt/storygen-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/storygen-venv/bin/pip install --no-cache-dir uv openai aiohttp ebooklib \
  && ln -sf /opt/storygen-venv/bin/python /usr/local/bin/storygen-python \
  && ln -sf python3 /usr/bin/python

ENV STORY_GENERATOR_PYTHON_BIN=/usr/local/bin/storygen-python

COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY scripts ./scripts
COPY web/public ./web/public

RUN mkdir -p /app/backend/data

EXPOSE 8787
CMD ["node", "backend/src/server.js"]
