# GCM Notified — single image: NestJS API + React dashboard
# Built by GitHub Actions → ghcr.io/gcm-convent-school/gcm-notified, hosted on Coolify.

# ---------- 1. dashboard (React + Vite) ----------
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# vite outDir is ../server/public → /app/server/public
RUN npm run build

# ---------- 2. server (NestJS) ----------
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- 3. runtime ----------
FROM node:22-alpine
RUN apk add --no-cache tini tzdata curl
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Asia/Kolkata \
    NODE_OPTIONS=--max-old-space-size=128
WORKDIR /app
COPY --from=server /app/server/package.json ./
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=web /app/server/public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
