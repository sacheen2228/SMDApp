# Integration Report — Platform Integration Phase

Generated: 2026-07-14. Scope: verify every strategy uses the new architecture
(M0–M7) correctly; identify legacy / duplicate / deprecated / unused code.
**No working code was rewritten and no new architecture was introduced** (per instructions).

Legend: ✅ integrated · ⚠️ partial / passive · ❌ not integrated

## 1. Strategy verification

| Strategy | Records Scanner Results | Records Trade Audit | Uses Canonical Snapshot | Supports Replay | Supports Evaluation |
|---|---|---|---|---|---|
| **Zero Hero** (ZERO_HERO_AI) | ✅ `ZeroHeroTerminal.recordScannerCycle` → `/api/market-recorder/scanner` (strategy=`ZERO_HERO`, `snapshotId` set) | ✅ `registerTrades("ZERO_HERO_AI", …)` + via `audit-recorders.ts` | ✅ recorder stores `CanonicalMarketSnapshot`; `snapshotId` attached to scanner results + audit `marketContext` | ✅ data persisted in `market_history.db` (recorder captures `RECORDER_SYMBOLS`) | ⚠️ Trade metrics ✅; **Classification ❌** (no outcome filled) |
| **SMC** | ❌ `recordScannerCycle` only emits `ZERO_HERO`; SMC cycles never posted to scanner API | ✅ `registerTrades("SMC", …)` in `ZeroHeroTerminal` | ✅ (recorder) | ✅ (symbol captured) | ⚠️ Trade metrics ✅; Classification ❌ (no scanner results) |
| **Intraday Scanner** (`intraday-scanner.ts`) | ❌ pure analysis fn, no recording | ❌ (consumed by BTST flow, but the "intraday" strategy itself records no audit signal) | ❌ not used | ⚠️ passive only | ❌ |
| **BTST** (`btst-scanner.ts`) | ❌ | ✅ `recordSignal("BTST", …)` (+ `updatePrice`, `closeTrade`) | ❌ uses live `getOptionChain` directly | ⚠️ passive only | ⚠️ Trade metrics ✅; Classification ❌ |

### Key gaps (block full Evaluation — objective 2)
1. **No outcome-filling pipeline for `scanner_results`.** Each `ScannerResult.outcome`
   (`filled`/`result`/`finalPnl`) is defined in the contract but **never written** by any
   code path. Consequence: `evaluateScanner` always sees `outcomeFilled=false` →
   every row is *unlabeled* → Precision / Recall / F1 / Confusion are `null`.
   The Trade Audit ledger HAS win/loss outcomes, but they are not bridged back into
   `scanner_results.outcome`.
2. **Only Zero Hero records Scanner Results.** SMC / Intraday / BTST never post to
   `/api/market-recorder/scanner`, so the classification leg of Evaluation cannot
   cover them.
3. **Replay is passive.** Strategies do not explicitly write snapshots; replay works only
   because the global recorder captures `RECORDER_SYMBOLS`. Strategies trading those symbols
   are replayable, but there is no per-strategy snapshot guarantee.

## 2. Module inventory

### Fully migrated (use the architecture end-to-end)
- **Market Recorder** (M0–M3): `src/lib/market/capture.ts`, `recorder-config.ts`,
  `src/app/api/market-recorder/{record,status,snapshots,scanner,integrity}/route.ts`,
  `market-recorder/` scheduler.
- **Replay Engine** (M4): `src/lib/market/replay-engine.ts`.
- **Scanner Recording** (M5): `src/lib/market/record-scanner.ts`,
  `src/app/api/market-recorder/scanner/route.ts`.
- **Backtest Data Provider** (M6): `src/lib/market/data-provider.ts` (live/history/replay/auto).
- **Evaluation Framework** (M7): `src/lib/market/evaluation-framework.ts`,
  `src/app/api/evaluate/route.ts`.
- **Zero Hero Terminal**: records ZH scanner results + ZH/SMC audit signals.

### Partially migrated
- **SMC**: Trade Audit ✅, Scanner Results ❌.
- **BTST**: Trade Audit ✅, Scanner Results ❌, no Canonical usage.
- **Intraday Scanner**: no architecture integration at all (analysis-only function).
- **`backtest-audit.ts`**: now routes data through `data-provider`, but still retains a
  legacy `getRealDayRange` (NSE + Breeze) path and dead code (see Unused).

### Legacy / duplicate implementations (consolidation candidates — NOT broken)
- **SDM engine family** overlaps: `sdm-engine.ts`, `sdm-oianalysis.ts`,
  `sdm-recommendation.ts`, `sdm-scores.ts`, `sdm-signal-engine.ts`,
  `sdm-anti-repaint.ts`, `sdm-sellersl.ts` — multiple scoring / recommendation
  engines in one family.
- **`zero-hero.ts` (active) vs `zero-hero-ai/*` (deprecated)**: overlapping ZH logic.
- **Three backtest paths** now all route through `data-provider` but logic overlaps:
  `backtest-engine.ts`, `sdm-backtest.ts`, `backtest-audit.ts`.
- **Many sibling engines** (not arch duplicates): `master-bot-engine.ts`, `orca-engine.ts`,
  `gex-engine.ts`, `ml-engine.ts`, `volume-analysis.ts`, `dom-analysis.ts`,
  `bse-dom-analysis.ts`.

### Deprecated (kept per Guardian Phase 8 — do NOT delete until verified)
- `src/components/terminal/ZHAIEngine.tsx`
- `src/components/terminal/ZeroHeroScannerFull.tsx`
- `src/lib/zero-hero-ai/` (scan-engine, smart-money-engine, entry-tp-sl-engine,
  gamma-theta-engine, greeks-engine)
- `src/lib/expiry-engine.ts`
- `src/app/api/zero-hero/route.ts`

### Unused / orphaned
- **`getRealDayRange`** in `backtest-audit.ts` (≈line 111): defined but **never called**
  (dead code, leftover from before the data-provider migration).
- **`intraday-scanner.ts`**: imported by `btst-scanner.ts`, `/api/scanner`,
  `ScannerPanel.tsx` (so not dead), but carries **zero architecture integration**.

## 3. Conclusion
- The **platform architecture (Recorder → Replay → Scanner Results → Trade Audit →
  Data Provider → Evaluation)** is complete and internally consistent.
- Zero Hero is the **reference fully-migrated strategy** (scanner results + audit + replay + eval).
- **Evaluation is currently degraded**: its classification leg cannot produce Precision/Recall/F1/
  Confusion until (a) an outcome-filling pipeline writes `scanner_results.outcome` and
  (b) SMC / Intraday / BTST also record Scanner Results.
- No code was rewritten; no new architecture was added.

## Next phase (per user direction)
Improve **trading performance** rather than expanding the platform. The highest-leverage
fix is bridging Trade Audit outcomes → `scanner_results.outcome` so Evaluation becomes
fully operational for all four strategies.
