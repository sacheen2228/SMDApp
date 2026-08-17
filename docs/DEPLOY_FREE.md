# SMDApp — Free Deployment Guide (Render free tier, no card)

> **Status: DONE + verified locally.** The Docker image builds, all 3 processes
> start inside the container, the scanner works, and INTRADAY signals are
> recorded to the in-container audit sidecar.

## What this deploys

A single Docker container running all 3 processes (Render free tier = 512MB):

| Process | Port | Runtime |
|---|---|---|
| Next.js app (standalone) | 3000 | Node 22 |
| trade-audit sidecar | 4001 | Node + better-sqlite3 |
| market-history sidecar | 4002 | Node + better-sqlite3 |

The Next.js app talks to the sidecars over `localhost`, so one container is enough.

## Files created this session

- `Dockerfile` — multi-stage: Next.js build (node 22, npm), sidecar builds (tsc), runtime node 22-slim
- `entrypoint.sh` — starts the 3 processes with correct per-process PORT/DB_PATH
- `render.yaml` — Render blueprint (free plan, healthCheckPath `/api/health`)
- `.dockerignore` — excludes node_modules/.next/.env/db etc. from build context
- `.npmrc` — npm retry settings (sandbox network was flaky during testing)
- `src/app/api/health/route.ts` — liveness endpoint + probes both sidecars

## Verified locally (this machine)

```
docker build --network=host -t smdapp:test .     # SUCCESS (~7 min)
docker run -d --name smdapp-test -p 3800:3000 \
  -e BREEZE_API_KEY=... -e BREEZE_SECRET_KEY=... -e BREEZE_SESSION_TOKEN=... \
  smdapp:test
curl localhost:3800/api/health   # {"ok":true,"checks":{"trade-audit":"up","market-history":"up"}}
curl "localhost:3800/api/scanner?symbol=NIFTY"  # 30 candidates, engine scores
# INTRADAY signals recorded to in-container :4001
```

## How to deploy (free, no card)

### Option A — Render Dashboard (recommended, easiest)
1. Push this repo to GitHub (or GitLab).
2. Sign up at https://render.com (free, no card needed for free web service).
3. **New + → Blueprint** → select your repo. Render reads `render.yaml` automatically.
4. After the deploy, set these **secret env vars** in the Render dashboard
   (Services → smdapp → Environment):
   - `BREEZE_API_KEY`
   - `BREEZE_SECRET_KEY`
   - `BREEZE_SESSION_TOKEN` (the `apisession=...` value)
   - `DATABASE_URL=file:/data/custom.db`
5. Render restarts the service → done. URL is `https://smdapp.onrender.com`.

### Option B — Direct web service (no render.yaml)
1. **New + → Web Service** → connect repo.
2. Runtime: **Docker** (Render reads the root `Dockerfile`).
3. Plan: **Free**.
4. Health check path: `/api/health`.
5. Add the same env vars as above.

## ⚠️ CRITICAL: data persistence on free tier

Render free has an **ephemeral filesystem** — everything in `/data` (the SQLite
databases) is **erased on every redeploy/restart**. Free tier also **sleeps after
15 min idle**.

**This means for a 3-4 month accuracy observation, free tier alone is NOT enough**
— the recorded INTRADAY signals get wiped. Options:

1. **Keep it alive + back up** (free workaround):
   - UptimeRobot (free) pings `/api/health` every 5 min → prevents sleep.
   - Export the DBs daily to somewhere persistent.
2. **Upgrade to Render Starter** (~$7/mo) + attach a **persistent disk** at `/data`
   → data survives restarts. This is the "if accuracy proves good, go paid" step.

## Why the migration to a cloud DB (Neon) was NOT done

We evaluated moving SQLite → Neon/Supabase free Postgres (so data persists on the
free tier). It requires rewriting both sidecars (~2,200 lines, 33 SQL queries).
**Not done** — keeping the container simple for testing; revisit only if you want
free-tier persistence without upgrading.

## Local re-build & test commands

```bash
docker build --network=host -t smdapp:test .       # rebuild
docker run -d --name t -p 3800:3000 \
  -e BREEZE_API_KEY="..." -e BREEZE_SECRET_KEY="..." -e BREEZE_SESSION_TOKEN="..." \
  smdapp:test
curl localhost:3800/api/health
curl "localhost:3800/api/scanner?symbol=NIFTY"
docker rm -f t
```

## Notes
- The `.next/standalone` output runs under plain Node (no bun needed at runtime).
- Breeze stock F&O is still account-blocked (the "contact admin" error) → scanner
  falls back to EST option trades on the live server too. NIFTY index data is real.
- The local dev server on :3000 must be stopped before running the container on
  port 3000 (use 3800 for tests as done above).