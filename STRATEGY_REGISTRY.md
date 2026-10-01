# STRATEGY_REGISTRY.md

*Honest audit of what's live vs. scaffolding across the 30 agents and strategy sets.*
*Generated: 2026-09-26. Spot-checked 7 entries against actual code.*

---

## Part A — 30-Agent Status

**Architecture fact:** All 30 agents exist as functions inside **one file** (`src/lib/agents/registry-30.ts`, 1694 lines). There are no per-agent files. Data flows through one shared snapshot (`src/lib/agents/snapshot.ts` → `collectHermesContext()`).

**Critical finding:** The entire 30-agent system is **uncommitted** (`git status` shows all files as `??`), has **two compile errors**, and **no test feeds real market data to any agent**.

### Tally

| Status | Count | Agents |
|--------|-------|--------|
| **LIVE** | 16 | 01, 02, 04, 07, 08, 09, 11, 14, 15, 18, 19, 22, 24, 26, 28, 30 |
| **PARTIAL** | 3 | 10, 21, 25 |
| **STUBBED** | 10 | 03, 05, 06, 12, 13, 16, 17, 23, 27, 29 |
| **BROKEN** | 1 | 20 (VWAP) |
| **NOT_BUILT (as files)** | 30/30 | No per-agent files exist — design was abandoned |

---

### Per-Agent Detail

| # | Agent | Status | Real Data Source | Jarvis Reuse | Last Verified |
|---|-------|--------|-----------------|-------------|---------------|
| 01 | Market Regime | **LIVE** | `/api/market/regime` (regime, bias, confidence) | No | Mock test (5 pass) |
| 02 | FII/DII | **LIVE** | `/api/fii-dii` → `ctx.fiiNet/diiNet` | **Yes** `scoring.fiiScore` | Mock test (11 pass) |
| 03 | Global Market | **STUBBED** | Uses `newsSentiment` as proxy — no US/Asia index fetch | No | None |
| 04 | India VIX | **LIVE** | Option-chain summary `indiaVIX` (falls back to hardcoded 15) | No | Mock test |
| 05 | Market Breadth | **STUBBED** | Declares `/api/market/breadth` — **never fetched**. Uses trend+PDH/PDL proxy | No | None |
| 06 | Sector Rotation | **STUBBED** | Declares `/api/market/heatmap` — **never fetched**. Symbol-name heuristics | No | None |
| 07 | OI/PCR | **LIVE** | Real chain OI totals + OI changes | **Yes** `scoring.optionChainScore` | Mock test (11 pass) |
| 08 | OI Classification | **LIVE (simplified)** | Real `spot-prevClose` × OI change; declared `oi-classification-engine.ts` not used | No | Mock test |
| 09 | Greeks | **LIVE** | `analyseGreeks()` over `ctx.jarvisChain` (real NSE per-strike IV → BS) | **Yes** | Mock test (11 pass) |
| 10 | Gamma | **PARTIAL** | Jarvis `netGex`/`gammaFlip` real; **hermes gamma half always absent** (`get_gamma` not in RESEARCH tool list) | **Yes** | Mock test |
| 11 | IV/HV | **LIVE (mis-named)** | Jarvis `atmIv`, `atmStraddle`, `skew` real; **"HV" is actually VIX** — no historical volatility | **Yes** | Mock test |
| 12 | Option Acceleration | **STUBBED** | Declares `option-acceleration-engine.ts` — **not imported**. Just spot change % | No | None |
| 13 | Buyer Confluence | **STUBBED** | Declares `buyer-confluence-engine.ts` — **not imported**. Inline 4-factor ad-hoc | No | None |
| 14 | Strike Selection | **LIVE** | Real strike list/liquidity + 0.50-Δ strike from jarvis `perStrike` | **Yes** | Mock test (11 pass) |
| 15 | Expiry/Theta | **LIVE** | Real `daysToExpiry` + ATM theta | No | Mock test |
| 16 | Zero Hero | **STUBBED** | Declares `zero-hero.ts` — **not imported**. Only DTE + day change | No | None |
| 17 | CAS | **STUBBED** | Declares `cas-straddle-strategy-v2` — **not imported**. Wall-clock check only | No | None |
| 18 | Market Structure | **LIVE** | `/api/sdm-signal` → trend/swings/PDH/PDL/BOS/CHOCH | No | Mock test |
| 19 | Support/Resistance | **LIVE** | Jarvis `buildLevels()` + PDH/PDL + structure levels | **Yes** | Mock test (11 pass) |
| 20 | VWAP | **BROKEN** | Reads `ctx.poc` but `hermes/context.ts:396` hardcodes `poc:0` → always `NO_DATA`, confidence 0 | No | None |
| 21 | Volume/Profile | **PARTIAL** | `totalVolume` real; **POC/VAH/VAL always 0** (same hardcode) | No | Mock test |
| 22 | Breakout/Fakeout | **LIVE** | Real spot vs PDH/PDL + volume | No | Mock test |
| 23 | MTF Confirmation | **STUBBED** | Declares `mtf-signal-engine.ts` — **not imported**. Uses trend proxy | No | None |
| 24 | Momentum | **LIVE (trivial)** | Real `spot vs prevClose` % | No | Mock test |
| 25 | ATR/Volatility | **PARTIAL** | Jarvis `expectedMove1Sigma` real; **`ctx.rawContext.atr` never exists** → ATR always 0 | **Yes** | Mock test |
| 26 | News | **LIVE** | `/api/news` headlines + sentiment | **Yes** `signedNewsScore` | Mock test |
| 27 | Event Risk | **STUBBED** | DTE + weekday check only. **No RBI/Fed/earnings calendar exists** | No | None |
| 28 | Sentiment | **LIVE (duplicate of 26)** | Same `newsSentiment`/`newsScore` inputs as Agent 26 | **Yes** | Mock test |
| 29 | BTST | **STUBBED** | Declares `btst-scanner.ts` — **not imported**. Time-of-day + trend only | No | None |
| 30 | Commodity/MCX | **LIVE (MCX only)** | Reads `rawContext.mcxIntelligence` from `/api/mcx/intelligence` (only for MCX symbols) | No | None |

---

### Agent Scope Violations Found

| Agent | Violation |
|-------|-----------|
| 05 Breadth | Uses trend+PDH/PDL as breadth proxy — not actual advance/decline |
| 06 Sector Rotation | Symbol-name heuristics instead of actual sector heatmap data |
| 12 Option Acceleration | Spot change % instead of premium momentum vs underlying |
| 13 Buyer Confluence | Inline ad-hoc 4-factor instead of full confluence checklist |
| 16 Zero Hero | DTE + day change instead of expiry-day explosive-move potential |
| 17 CAS | Wall-clock time check instead of CAS reference/dislocation |
| 20 VWAP | Always NO_DATA due to hardcoded `poc:0` — dead code |
| 23 MTF | Trend proxy instead of multi-timeframe agreement |
| 27 Event Risk | No calendar source — DTE + weekday only |
| 29 BTST | Time-of-day + trend instead of end-of-day structure analysis |

---

## Part B — Strategy Layer Status

| Item | Status | Evidence |
|------|--------|----------|
| **S1-S8 (index)** | **LIVE in Jarvis, ABSENT from 30-agent path** | `pickStrategy()` called only from `orchestrator.ts:102` → reachable via `/api/jarvis`. Option Engine (`option-engine.ts`) imports zero jarvis modules — S1-S8 never checked. |
| **Stock event-driven set** | **SCAFFOLDING** | `stock_event_driven` strategy set defined in `instrument-router.ts` but no stock-specific gates implemented. Earnings-calendar gate = **stub** (no calendar source). |
| **Instrument Router** | **DEAD CODE** | `src/lib/instrument-router.ts` exists (170 lines) but **zero importers** in `src/`, `tests/`, or `*.md`. Nothing routes through it. |
| **Grok diff-backstop** | **LIVE + TESTED** | `hermesResponseMatchesSignal()` in `jarvis-adapters.ts:580`. Used by `/api/agent` (lines 488, 838) and `/api/jarvis/chat` (line 84). **23 tests pass / 0 fail** ✅ |
| **Grok backstop (§6 numeric)** | **BROKEN** | `grokBackstop()` in `supervisor.ts:225`. `tests/agent-backstop.test.ts` **cannot load** — supervisor.ts:332 has `const` reassignment error. |
| **Confidence-tiered risk sizing** | **NOT BUILT in 30-agent system** | Neither engine computes `quantity`. Confidence only sets letter grade (A/B/C/D). Confidence-scaled sizing exists only in unrelated `zero-hero-ai/position-size-calculator.ts`. |
| **Liquidity Trading (S3-STOCK)** | **NOT BUILT** | No `src/lib/strategies/` directory exists. This is what Part B of this prompt builds. |

---

## Critical Blockers

### Compile Errors (system cannot load)

1. **`src/lib/agents/supervisor.ts:332`** — `const` reassignment
   ```
   line 290: const { consensus, confidence } = determineConsensus(...)
   line 332: consensusConfidence = Math.max(...)  ← ERROR: reassign const
   ```
   Module cannot be imported at all. Blocks `pipeline.ts`, `index.ts`, `option-engine.ts`, `cash-futures-engine.ts`.

2. **`src/lib/agents/learning-db.ts`** — truncated to 30 lines, missing exports
   ```
   pipeline.ts:20 → import { storeDecisionRecord, updateOutcome }  ← does not exist
   index.ts:41 → export { storeDecisionRecord, ... }  ← does not exist
   ```

### Runtime State

3. **`/api/agents/pipeline` returns 500** — only entry point, compile errors above.
4. **No UI/cron/chat calls the 30-agent system** — only reachable via manual `GET /api/agents/pipeline`.
5. **Option Engine always NO_TRADE** — `grokDecision.candidate === undefined` → `entry = 0` → `checkStopLoss` fails.
6. **All 30-agent files uncommitted** — `git status` shows every file as `??`.
7. **No test uses real data** — all agent tests mock the snapshot.

### Test Evidence

| Test File | Result | Data Type |
|-----------|--------|-----------|
| `tests/agent-snapshot.test.ts` | 5 pass / 0 fail ✅ | MOCK (fetch stub) |
| `tests/agent-bridge.test.ts` | 11 pass / 0 fail ✅ | MOCK (synthetic chain) |
| `tests/agent-system.test.ts` | **0 pass / 1 fail / 1 error** ❌ | MOCK — cannot load supervisor |
| `tests/agent-backstop.test.ts` | **0 pass / 1 fail / 1 error** ❌ | MOCK — cannot load supervisor |
| `tests/jarvis-classifier.test.ts` | 23 pass / 0 fail ✅ | Unit (diff backstop) |
| **Full `bun test`** | **ABORTS** — hangs on agent-system.test.ts | — |
| **Excluding broken files** | **532 pass / 0 fail / 23 files** ✅ | — |

**No test feeds live market data to any of the 30 agents.**

---

## What's Genuinely LIVE Today

| Component | Status | Evidence |
|-----------|--------|----------|
| `telegram-alerts.ts` | **LIVE** | Used by `tiger-monitor.ts` (production TP/SL alerts) |
| `kill-switch.ts` | **LIVE** | Used by `/api/agent` + `/api/jarvis/chat` |
| `hermesResponseMatchesSignal` diff backstop | **LIVE** | Used by `/api/agent` + `/api/jarvis/chat`, 23 tests green |
| Old `registry.ts` external-agent subsystem | **LIVE** | Webhook/hermes/ai-trader/health/leaderboard |
| 16 "LIVE" agent analysis functions | **Correct code, real inputs, but unreachable** | No caller, no real-data test |

---

## Spot-Checks (7 entries verified against code)

| Agent | Checked In | Finding |
|-------|-----------|---------|
| 05 Breadth | `registry-30.ts:231` | `/api/market/breadth` never called → **STUBBED** ✅ |
| 06 Sector Rotation | `registry-30.ts:271` | `/api/market/heatmap` never called → **STUBBED** ✅ |
| 26 News | `registry-30.ts:1353` | Real `/api/news` + jarvis → **LIVE** ✅ |
| 27 Event Risk | `registry-30.ts:1400` | DTE + weekday only → **STUBBED** ✅ |
| 28 Sentiment | `registry-30.ts:1441` | Real news + jarvis → **LIVE** ✅ |
| 29 BTST | `registry-30.ts:1487` | `btst-scanner.ts` never called → **STUBBED** ✅ |
| 30 Commodity | `registry-30.ts:1544` | Real `/api/mcx/intelligence` → **LIVE (MCX only)** ✅ |
