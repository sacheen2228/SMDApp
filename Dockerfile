# SMDApp — lightweight Docker for Render free tier (512MB RAM)
# Only Next.js standalone — sidecars need too much RAM for free tier.

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY patches ./patches
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

COPY . .
RUN npx prisma generate || true
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=file:/tmp/custom.db

RUN mkdir -p /app/.next/static /app/public

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/standalone/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
