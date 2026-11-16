# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
# better-sqlite3 / argon2 fall back to compiling when no musl prebuild matches
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm -w web run build && npm -w server run build \
 && cp server/src/db/schema.sql server/dist/db/schema.sql \
 && npm prune --omit=dev

FROM node:22-alpine
# take Alpine's security fixes newer than the base image
RUN apk upgrade --no-cache
ENV NODE_ENV=production PORT=9010 SOURCES_DIR=/sources TZ=Asia/Tehran
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 9010
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9010/healthz >/dev/null || exit 1
CMD ["node", "server/dist/main.js"]
