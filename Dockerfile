# ── Stage 1: build the React client ──────────────────────────────
FROM node:22-slim AS frontend-build

WORKDIR /build/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Stage 2: backend runtime ────────────────────────────────────
FROM node:22-slim AS backend-runtime

RUN groupadd --gid 1001 lexflow \
 && useradd  --uid 1001 --gid lexflow --shell /bin/false --create-home lexflow

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ ./

RUN mkdir -p /data /backups /logs \
 && chown -R lexflow:lexflow /data /backups /logs /app

USER lexflow

EXPOSE 5000

CMD ["node", "server.js"]

# ── Stage 3: nginx frontend ─────────────────────────────────────
FROM nginx:stable-alpine AS web

RUN rm -rf /usr/share/nginx/html/*
COPY --from=frontend-build /build/client/dist /usr/share/nginx/html

EXPOSE 80
