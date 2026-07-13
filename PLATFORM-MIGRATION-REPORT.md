# Platform Migration Report — SMDApp Strategy Architecture

_Generated after migrating SMC, BTST, and the Intraday Scanner into the unified
Canonical Snapshot + Scanner Results + Trade Audit + Replay + Evaluation architecture._

## Objective
Make all four trading strategies (Zero Hero, SMC, BTST, Intraday) use the **same**
data architecture so the Evaluation framework, Replay engine, and Backtest Verification
sidecar can grade every strategy identically — a prerequisite for the upcoming
strategy-optimization phase.

## Architecture contract (shared by all four)
| Layer | Store | Port | Notes |
|---|---|---|---|
| Canonical Snapshot | `market_history.db` (sidecar) | 4002 | Index snapshots, recorded by market-recorder tick; shared version context |
| Scanner Results | `market_history.db` (sidecar) | 4002 | `recordScannerResult` → `/api/scanner` on sidecar |
| Trade Audit (executed trades) | `trade_audit.db` (sidecar) | 4001 | `recordSignal` / `registerTrades` |
| Replay | reads Canonical + Scanner Results | — | `replay-engine.ts` |
| Evaluation | reads all three | — | `evaluation-framework.ts` |

## Status by strategy

### ✅ Fully migrated
- **Zero Hero** (`ZERO_HERO_AI`)
  - Scanner Results: `recordScannerCycle(symbol, "ZERO_HERO", …)` → `registerTrades`/`recordScannerResult` path.
  - Trade Audit: `registerTrades("ZERO_HERO_AI", symbol, …)` (ZeroHeroTerminal.tsx:469).
  - Canonical/Replay/Evaluation: shares index snapshots.
- **SMC** (`SMC`)
  - Scanner Results: `recordScannerCycle(symbol, "SMC", …)` (ZeroHeroTerminal.tsx:1243, added `rr`).
  - Trade Audit: `registerTrades("SMC", symbol, …)` (ZeroHeroTerminal.tsx:1245).
  - Canonical/Replay/Evaluation: shared.
- **BTST** (`BTST`)
  - Scanner Results: `recordBTSTScannerResults` (btst-scanner.ts, reuses `recordScannerResult`); validated — 21 results recorded.
  - Trade Audit: `recordBTSTSignals` (btst-scanner.ts:273, fixed `ymd` regression).
  - Canonical/Replay/Evaluation: shared.

### 🟡 Partially migrated (architecture wired, runtime-unverified)
- **Intraday Scanner** (`INTRADAY`)
  - Scanner Results: `recordIntradayScannerResults` (intraday-scanner.ts:801) — **validated live**, 30 results across NIFTY50, `snapshotId` auto-resolved.
  - Trade Audit: `recordIntradayTrade` (intraday-scanner.ts:868) wired into both `addTrade` sites in `sendIntradayAlerts.ts` (sdm-v2 engine + stock-scanner). Compiles cleanly; **fires only when market is open AND `TELEGRAM_DIGEST_CHAT_IDS` is configured**, so not runtime-verified in this environment.
  - Canonical/Replay/Evaluation: reads shared index snapshots (equity fallback resolves to latest index snapshot).

### 🗄️ Legacy (still present, not on new path)
- `src/lib/zero-hero-ai/*` — original Zero Hero engine, superseded.
- `src/lib/expiry-engine.ts` — standalone expiry logic.
- `ZHAIEngine.tsx`, `ZeroHeroScannerFull.tsx` — legacy UI/scanner.
- `src/app/api/zero-hero/route.ts` — legacy API.

### ⚠️ Deprecated (kept pending verification, per AGENTS.md Phase 8)
The above Legacy files are retained until the new production path is verified end-to-end.
They are not imported by any migrated strategy path.

## Blocking gap before optimization
The **outcome-filling pipeline** for `scanner_results.outcome` is still absent. The
Evaluation framework's classification leg (HIT_RATE / FAKE_DETECTION) has no ground truth
to compare against. This is a **shared** gap affecting all four strategies equally — not a
per-strategy migration defect. It must be added (close scanner results against subsequent
Trade Audit outcomes / price feeds) before per-strategy quality optimization can be measured.

## Ready for optimization?
| Strategy | Shares architecture? | Outcome data? | Ready? |
|---|---|---|---|
| Zero Hero | Yes | No (shared gap) | After outcome pipeline |
| SMC | Yes | No (shared gap) | After outcome pipeline |
| BTST | Yes | No (shared gap) | After outcome pipeline |
| Intraday | Yes (TA unverified) | No (shared gap) | After outcome pipeline + verify TA recording |

**Conclusion:** All four strategies now use the same architecture (Canonical + Scanner Results
+ Trade Audit + Replay + Evaluation). The only remaining blocker for the optimization phase
is the shared outcome-filling pipeline. Once that lands, strategy-optimization/threshold
tuning can begin across the board.
