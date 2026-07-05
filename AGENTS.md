# SMDApp

Real-time option chain viewer for Indian markets (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) with ICICI Breeze API integration and SDM analysis engine.

## Quick start

```bash
bun install
bun run db:push    # sync SQLite schema
bun run dev        # starts on :3000
```

## Package manager

**bun** — not npm or yarn. Lockfile is `bun.lock`.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Dev server on port 3000, logs to `dev.log` |
| `bun run build` | Standalone build (output in `.next/standalone/`) |
| `bun run start` | Production server from standalone build |
| `bun run lint` | ESLint (very lenient — see below) |
| `bun run db:push` | Push Prisma schema to SQLite |
| `bun run db:generate` | Regenerate Prisma client |
| `bun run db:migrate` | Create migration |
| `bun run db:reset` | Reset database |

## Architecture

- **Framework**: Next.js 16, App Router, standalone output mode
- **Database**: SQLite via Prisma (`db/custom.db`), schema is minimal (User, Post — mostly unused)
- **UI**: shadcn/ui (new-york style), Tailwind CSS v4, lucide icons
- **State**: React Query for server state, Zustand for global state (`src/stores/useTradingStore.ts`), React useState for local UI state
- **Data flow**: Single API route (`/api/option-chain`) with two-tier fallback:
  1. ICICI Breeze API (requires API key + secret)
  2. Simulation (`src/lib/option-chain-data.ts`)
- **Analysis**: SDM Options Intelligence Engine (`src/lib/sdm-engine.ts`) runs on all data

### Key source files

| File | Role |
|---|---|
| `src/app/page.tsx` | Main UI component (518 lines) |
| `src/app/api/option-chain/route.ts` | Core API: orchestrates data sources + SDM analysis |
| `src/lib/icici-breeze/` | ICICI Breeze API: auth, option chain, orders, positions |
| `src/lib/sdm-engine.ts` | SDM Options Intelligence Engine (861 lines) |
| `src/lib/yahoo-finance-api.ts` | Yahoo Finance index data + VIX (not used in current data flow) |
| `src/lib/yahoo-finance-api.ts` | Yahoo Finance index data + VIX (exists but not used in current flow) |
| `src/lib/option-chain-data.ts` | Simulated option chain generator |
| `src/lib/greeks.ts` | Black-Scholes Greeks calculator |
| `src/stores/useTradingStore.ts` | Zustand store for trading state |

## TypeScript / ESLint

- `noImplicitAny: false` — code uses untyped `any` freely
- `ignoreBuildErrors: true` in `next.config.ts` — build won't fail on TS errors
- ESLint has nearly all rules disabled (`no-unused-vars`, `no-console`, `no-explicit-any`, etc. all off)
- Do not add strict linting or typing without explicit request — it will conflict with existing code

## Build & deploy

The build creates a standalone Next.js bundle with Caddy as reverse proxy:

```bash
bun run build  # creates .next/standalone/
```

- Caddy listens on `:81`, proxies to Next.js on `:3000`
- `.zscripts/build.sh` handles full build + packaging (references `/home/z/my-project` — adjust if needed)
- `.zscripts/start.sh` runs production: Next.js + Caddy + optional mini-services

## Environment

The `.env` file (gitignored) is required for ICICI Breeze API access:

```
DATABASE_URL=file:/path/to/db/custom.db
BREEZE_API_KEY=...
BREEZE_SECRET_KEY=...
```

**Note**: Motilal Oswal API credentials in existing code are not currently used in the data flow.

## Path references to fix

`.zscripts/build.sh` and `start-dev.sh` contain hardcoded path `/home/z/my-project`. If running locally, either:
- Symlink: `ln -s /home/sachin/Desktop/SMDApp /home/z/my-project`
- Or update the scripts to use the actual project path
