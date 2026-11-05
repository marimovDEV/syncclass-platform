# syntax=docker/dockerfile:1.7
# SyncClass frontend — Next.js (App Router) `output: 'standalone'`.
# Multi-stage: deps -> builder -> runner. Runner'da Node modullari yo'q,
# faqat Next.js'ning o'zi yig'gan `standalone` serveri.

# ------------------------------------------------------------------- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Lock fayli bo'lsa — aniq `npm ci`, bo'lmasa `npm install`.
COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      echo ">> package-lock.json topilmadi, npm install ishlatiladi"; \
      npm install; \
    fi

# ---------------------------------------------------------------- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# NEXT_PUBLIC_* qiymatlari build vaqtida bundle ichiga "qotib" qoladi,
# shuning uchun ular runtime env emas, build-arg sifatida kiradi.
ARG NEXT_PUBLIC_API_URL=http://localhost/api/v1
ARG NEXT_PUBLIC_WS_URL=ws://localhost/ws
ARG NEXT_PUBLIC_LIVEKIT_URL=
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_PUBLIC_LIVEKIT_URL=${NEXT_PUBLIC_LIVEKIT_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next.config.*` da `output: 'standalone'` bo'lishi SHART (CONTRACTS.md §0 bo'yicha
# frontend konfigi `frontend-core` agentining fayli).
RUN npm run build \
 && test -f .next/standalone/server.js \
    || (echo "XATO: .next/standalone/server.js yo'q — next.config da output:'standalone' yoqilmagan" && exit 1)

# ----------------------------------------------------------------- runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 10002 nodejs \
 && adduser --system --uid 10002 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
