# SMDApp — lightweight Docker for Render free tier (512MB RAM)
# Next.js standalone + live-data-service sidecar (pure stdlib Python, binds
# 127.0.0.1:8765 in-container for the agent feed-gate / Hermes live check).

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY patches ./patches
COPY prisma ./prisma
# Cache mount + retry loop: flaky connections reset npm mid-install; the
# cache makes each retry resume instead of restarting.
RUN --mount=type=cache,target=/root/.npm \
    for i in 1 2 3 4 5; do \
      npm install --no-audit --no-fund \
        --maxsockets=3 \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000 \
        --fetch-timeout=600000 \
      && s=0 && break; \
      echo "npm install attempt $i failed, retrying..."; sleep 15; \
      s=1; \
    done; exit $s

COPY . .

# Create db directory + generate Prisma + push schema
RUN mkdir -p db && npx prisma generate && DATABASE_URL="file:./db/custom.db" npx prisma db push --skip-generate || true

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# live-data-service is pure stdlib Python — no pip installs needed.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=file:/tmp/custom.db

RUN mkdir -p /app/.next/static /app/public /app/db

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/standalone/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY live-data-service ./live-data-service
COPY docker-entrypoint.sh ./docker-entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "docker-entrypoint.sh"]
