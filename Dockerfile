# ═══════════════════════════════════════════════════════════════════
# SMDApp — single-container deployment for Render free tier
# Runs all 3 processes inside one container:
#   - Next.js standalone app (port 3000)         [Node]
#   - trade-audit sidecar      (port 4001)       [Node + better-sqlite3]
#   - market-history sidecar   (port 4002)       [Node + better-sqlite3]
#
# Render free tier: 512MB RAM, no persistent disk. SQLite data is stored
# on an ephemeral filesystem and will be LOST on redeploy/restart. For
# the paid plan, mount a persistent disk at /data.
# ═══════════════════════════════════════════════════════════════════

# ─── Stage 1: build the Next.js standalone app ────────────────────
FROM node:22-bookworm AS next-build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install via npm (bun has tarball-extraction issues inside Docker).
# Next.js build runs under node. Copy sources first so the postinstall
# patch (patches/fix-breeze-sdk-validation.js) is present when npm runs.
COPY package.json ./
COPY patches ./patches
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

COPY . .
RUN npx prisma generate || true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 2: build the two Node sidecars ─────────────────────────
FROM node:22-bookworm AS sidecar-build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# trade-audit
COPY trade-audit/package.json trade-audit/tsconfig.json ./ta/
COPY trade-audit/src ./ta/src/
RUN cd ta && npm install --no-audit --no-fund && npx tsc -p tsconfig.json

# market-history
COPY market-history/package.json market-history/tsconfig.json ./mh/
COPY market-history/src ./mh/src/
RUN cd mh && npm install --no-audit --no-fund && npx tsc -p tsconfig.json

# ─── Stage 3: runtime — everything under Node ─────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# DB location (SQLite files). On Render free this is ephemeral; on paid
# plans mount a persistent disk here.
ENV DB_ROOT=/data
ENV DATABASE_URL=file:/data/custom.db

# Sidecar base URLs (all inside the same container)
ENV TRADE_AUDIT_BASE=http://localhost:4001
ENV MARKET_HISTORY_BASE=http://localhost:4002
ENV NEXT_PUBLIC_MARKET_HISTORY_URL=http://localhost:4002

RUN mkdir -p /data /app/trade-audit/data /app/market-history/data

# Next.js standalone
COPY --from=next-build /app/.next/standalone ./
COPY --from=next-build /app/.next/standalone/.next/static ./.next/static
COPY --from=next-build /app/public ./public

# Sidecars (compiled JS + prod node_modules)
COPY --from=sidecar-build /build/ta/dist /app/trade-audit/dist
COPY --from=sidecar-build /build/ta/node_modules /app/trade-audit/node_modules
COPY --from=sidecar-build /build/ta/package.json /app/trade-audit/package.json
COPY --from=sidecar-build /build/mh/dist /app/market-history/dist
COPY --from=sidecar-build /build/mh/node_modules /app/market-history/node_modules
COPY --from=sidecar-build /build/mh/package.json /app/market-history/package.json

# Sidecar schemas expect DB_PATH under their data dir by default; point
# them at the shared /data volume so nothing is lost across restarts on
# platforms that do persist it. (trade-audit reads PORT/DB_PATH; the
# market-history sidecar reads MARKET_HISTORY_PORT / MARKET_HISTORY_DB.)
ENV DB_PATH=/data/trade_audit.db
ENV MARKET_HISTORY_DB=/data/market_history.db

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/usr/local/bin/entrypoint.sh"]