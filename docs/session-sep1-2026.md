# Session: Sep 1 2026 — What We Built

## Expiry Liquidity Shift Engine (14 sub-engines)
- Fixed all build errors: duplicate `getCurrentSession` functions in `market-session.ts` and `market-session-config.ts`
- Fixed import paths: all `expiry-liquidity/` files import from `./market-session-config` (SessionState with `phase`, `isCasActive`), not `@/lib/market-session` (SessionInfo without those)
- Fixed null guard: `gammaPressureEngine.calculateAggregate({strikes: []})` instead of `{}`
- Engine returns valid data: 28 expiry score, NO_TRADE signal with no live data

## New API Endpoints (6 total)
| Endpoint | Purpose |
|---|---|
| `/api/alerts` | GET history/stats, POST fire alert, PATCH acknowledge |
| `/api/watchlist` | GET/POST/DELETE with JSON file persistence (data/watchlist.json) |
| `/api/scanner/fno` | Dedicated F&O scanner: OI change, IV percentile, premium velocity, volume |
| `/api/backtest/expiry` | Deterministic expiry liquidity backtest |
| `/api/backtest/trades` | Real trade backtest against Yahoo Finance historical candles |
| `/api/market/opportunities` | Enhanced — now merges intraday scanner (20% weight) + TA engines (80%) |

## Real Trade Backtest Engine
- `src/lib/trade-backtest-engine.ts` — replays every closed trade against real Yahoo Finance candles
- Smart interval: 5m for recent intraday (≤5 days), 15m for swing (≤30 days), 1h for older, 1d for ancient
- Direct Yahoo Finance fetch (bypasses Breeze timeout when session expired)
- Tested: **99/100 trades backtestable**, 65.7% WR, +2882 P&L, 5.34 profit factor
- SMART_MONEY: 100% WR, +1840 | BTST: 59% WR, +800

## Files Created/Modified
- `src/lib/expiry-liquidity/` — 16 engine files, types, config
- `src/app/api/expiry-liquidity/route.ts` + `opportunities/route.ts`
- `src/lib/trade-backtest-engine.ts` + `src/app/api/backtest/trades/route.ts`
- `src/app/api/alerts/route.ts` + `src/app/api/watchlist/route.ts`
- `src/app/api/scanner/fno/route.ts` + `src/app/api/backtest/expiry/route.ts`
- `src/stores/useWatchlistStore.ts`
- `src/components/dashboard/AlertCenter.tsx` — updated to poll `/api/alerts`
- `src/app/api/market/opportunities/route.ts` — merged intraday scanner
- `AGENTS.md` — fully updated with all new APIs and session notes

## Key Import Fix Pattern
Files in `src/lib/expiry-liquidity/` that need session state (`phase`, `isCasActive`, `minutesRemaining`):
```typescript
import { getCurrentSession } from './market-session-config';  // returns SessionState
```
Files that need raw config (CAS timings, expiry rules):
```typescript
import { NSE_SESSION_CONFIG } from './market-session-config';  // returns MarketSessionConfig
```
**NOT** `@/lib/market-session` — that returns `SessionInfo` (different type, no `phase`).

## Git Commits (4)
1. `06a5a8b` — fix: expiry liquidity engine build errors
2. `486fb0b` — feat: alerts API, watchlist, F&O scanner, expiry backtest
3. `5dc23cd` — feat: real trade backtest engine
4. `0f24b3b` — docs: update AGENTS.md

## Monday To-Do
- Re-login Breeze session for live F&O data
- Test `/api/backtest/trades` with full 400+ closed trades
- Verify Render deployment
