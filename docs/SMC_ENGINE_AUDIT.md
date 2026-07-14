# SMC (Smart Money / Unusual OI Buildup) Engine Audit

**Date**: 2026-07-14  
**Scope**: Complete production flow from market data to trade generation  
**Status**: READ-ONLY analysis (no code modifications)

---

## Table of Contents

1. [Scanner Architecture — Execution Flow](#1-scanner-architecture--execution-flow)
2. [Backend Trade Calculation](#2-backend-trade-calculation)
3. [SMC Detection Logic](#3-smc-detection-logic)
4. [Filters & Rejection Rules](#4-filters--rejection-rules)
5. [Trade Lifecycle](#5-trade-lifecycle)
6. [Database Schema & Relationships](#6-database-schema--relationships)
7. [Improvement Audit](#7-improvement-audit)

---

## 1. Scanner Architecture — Execution Flow

### 1.1 Data Source Pipeline

```
┌───────────────────────────────────────────────────────────────┐
│  /api/option-chain (route.ts:487)                             │
│                                                               │
│  Symbol + Expiry                                              │
│       │                                                       │
│       ▼                                                       │
│  ICICI Breeze API ──► NSE HTML API ──► BSE API ──► Yahoo     │
│  (getOptionChain)    (getNSEOptionChain)  (SENSEX/BANKEX)    │
│                                                               │
│       ▼                                                       │
│  Returns: { data: [{ strike, ce, pe }], spotPrice, summary } │
└───────────────────────────────────────────────────────────────┘
```

**Files**:
- `src/app/api/option-chain/route.ts` — orchestrates all 4 data sources
- `src/lib/icici-breeze/option-chain.ts` — Breeze API integration
- `src/lib/nse-api.ts` — NSE India scraper
- `src/lib/bse-api.ts` — BSE public API
- `src/lib/yahoo-finance-api.ts` — spot price fallback

### 1.2 Terminal UI Flow (Client-Side Scanner)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ZeroHeroTerminal.tsx                                                │
│                                                                      │
│  1. User selects symbol (e.g. NIFTY)                                 │
│  2. fetchChain() → GET /api/option-chain?symbol=NIFTY               │
│  3. Response parsed into ChainRow[]                                  │
│  4. ChainRow[] passed to SmartMoneyTab as `chain` prop              │
│                                                                      │
│  SmartMoneyTab receives:                                             │
│    • chain: ChainRow[]         — option chain data                   │
│    • flowData                  — FII/Pro OI flow (from parent)      │
│    • symbol: string            — active symbol                       │
│    • openTrade: function       — opens trade modal                   │
│    • setSymbol: function       — switches active symbol              │
└──────────────────────────────────────────────────────────────────────┘
```

**Files**:
- `src/components/terminal/ZeroHeroTerminal.tsx` (lines 206–473) — parent component
  - `fetchChain()` — line 246: fetches `/api/option-chain?symbol=...`
  - `SmartMoneyTab` — line 1213: the SMC scanner UI
  - `registerTrades()` — lines 24–48: POST to `/api/trade/register`
  - `recordScannerCycle()` — lines 57–96: POST to `/api/market-recorder/scanner`

### 1.3 Smart Money Detection (Inside SmartMoneyTab)

```
┌───────────────────────────────────────────────────────────────┐
│  SmartMoneyTab (line 1213)                                    │
│                                                               │
│  1. enrich(chain) → sorted by |oiChg| desc, top 8 rows       │
│     • Extracts CE/PE with higher |oiChg|                     │
│     • Computes type, buildupText, entry, sl, tp1, tp2, conf  │
│                                                               │
│  2. candidatesFromEnriched(enriched)                          │
│     • Filters: oiChg >= 50,000 AND entry > 0                 │
│     • Builds trade candidate objects                          │
│                                                               │
│  3. useEffect → records SMC trades (once per symbol)         │
│     • Calls registerTrades("SMC", symbol, candidates)         │
│     • Calls recordScannerCycle(symbol, "SMC", candidates)    │
│                                                               │
│  4. Scan All mode (toggle)                                    │
│     • Fetches ALL_SYMBOLS chains in parallel                  │
│     • Shows per-symbol results with "Sym" column              │
│     • Records SMC trades per symbol                           │
│                                                               │
│  5. User clicks row → handleRowClick()                        │
│     • If scanAll + different symbol → setSymbol() first       │
│     • Calls openTrade(strike, type, entry, rr)                │
└───────────────────────────────────────────────────────────────┘
```

**Key formulas** (inside `enrich()`):
- `oiChg ≥ 50000` — minimum OI change threshold
- `entry = d.ltp || 0` — entry price = option premium LTP
- `slPct = 0.22` — fixed 22%
- `sl = entry × (1 − 0.22)`
- `tp1 = entry × (1 + 0.22)`
- `tp2 = entry × (1 + 0.22 × 2)` = `entry × 1.44`
- `rr = 2` — fixed 1:2 risk:reward
- `conf = min(95, 60 + min(35, oiChg / 20000))` — minimum 60, max 95

### 1.4 Registration Pipeline

```
  SmartMoneyTab                                activeTradeTracker
  registerTrades() ─────► /api/trade/register ─────► addTrade()
       │                                                     │
       │                                                     ├──► tradeStore.createTrade() → POST /api/trade-journal
       │                                                     │        → Prisma db.trade.upsert()
       │                                                     │
       │                                                     └──► recordAuditSignal() → POST :4001/api/signals
       │                                                              (Trade Audit sidecar)
       │
       └──► /api/market-recorder/scanner ─────► recordScannerResult()
                → market-history-client
```

**Files involved**:
- `src/app/api/trade/register/route.ts` — POST handler (88 lines)
- `src/lib/activeTradeTracker.ts` — in-memory + Prisma + audit (262 lines)
- `src/lib/tradeStore.ts` — Prisma wrapper (84 lines)
- `src/lib/trade-audit-client.ts` — HTTP client to :4001 (261 lines)
- `src/lib/audit-recorders.ts` — builds SignalInput for audit (92 lines)
- `src/app/api/trade-journal/route.ts` — CRUD Prisma (180 lines)
- `src/app/api/market-recorder/scanner/route.ts` — scanner cycle recorder
- `src/lib/market/record-scanner.ts` — builds ScannerResult (208 lines)

### 1.5 Server-Side Alert Flow (sendIntradayAlerts)

```
  sendIntradayAlerts.ts (runs every 15 min, 09:10–15:20 IST)
       │
       ├── 1. checkSLTP(getCurrentOptionPrice)
       │        → hits /api/option-chain for live premium
       │        → updates Prisma + Trade Audit + removes from memory
       │        → sends Telegram for each SL/TP hit
       │
       ├── 2. Filter symbols without active trades
       │
       ├── 3. For each symbol:
       │        → /api/sdm-signal?symbol=X&dir=CALL
       │        → /api/sdm-signal?symbol=X&dir=PUT
       │        → Weekly + Monthly expiry
       │
       ├── 4. Sort by confidence, top 12
       │        → Filter: confidence ≥ 60%, R:R ≥ 1.5
       │        → Deduplicate via alreadySentToday()
       │
       ├── 5. Send Telegram alerts
       │        → addTrade() + recordIntradayTrade()
       │
       └── 6. Stock scanner → /api/scanner
                → monthly options, totalScore ≥ 80
                → send Telegram + addTrade() + recordIntradayTrade()
```

**Files**:
- `src/lib/sendIntradayAlerts.ts` — alert engine (345 lines)
- `src/lib/intraday-scanner.ts` — `recordIntradayTrade()` at line 868 (905 lines)
- `src/lib/marketHours.ts` — market window check
- `src/lib/intradayState.ts` — deduplication
- `src/lib/telegramSend.ts` — Telegram integration

### 1.6 Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────┐
│                      COMPLETE DEPENDENCY GRAPH                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ZeroHeroTerminal.tsx (UI)                                          │
│    ├── SmartMoneyTab                                                │
│    │    ├── enrich() / candidatesFromEnriched()                     │
│    │    ├── registerTrades() → /api/trade/register                  │
│    │    ├── recordScannerCycle() → /api/market-recorder/scanner     │
│    │    └── handleRowClick() → openTrade()                          │
│    │                                                                 │
│    ├── FIIFlowPanel (child component)                               │
│    ├── flowData useMemo (FII/Pro OI flow from chain data)           │
│    └── useTerminalStore (Zustand: symbol, expiry)                   │
│                                                                     │
│  /api/trade/register                                                │
│    └── addTrade() (activeTradeTracker.ts)                           │
│         ├── tradeStore.createTrade() → /api/trade-journal → Prisma  │
│         └── recordAuditSignal() → :4001/api/signals (Trade Audit)  │
│                                                                     │
│  /api/market-recorder/scanner                                       │
│    └── recordScannerResult() → market-history-client (:4002)        │
│                                                                     │
│  /api/trade-journal (Prisma CRUD)                                   │
│    └── db.trade table (SQLite)                                      │
│                                                                     │
│  sendIntradayAlerts.ts (server-side cron)                           │
│    ├── checkSLTP() → /api/option-chain (live prices)               │
│    ├── /api/sdm-signal for each symbol                              │
│    ├── addTrade() + recordIntradayTrade()                           │
│    └── /api/scanner (stock options)                                 │
│                                                                     │
│  Trade Audit Sidecar (:4001)                                        │
│    ├── recordSignal() → stores + tracks SL/TP                       │
│    ├── updatePrice() → MFE/MAE tracking ticks                       │
│    └── closeTrade() → marks trade closed                            │
│                                                                     │
│  Market History Sidecar (:4002)                                      │
│    ├── recordScannerResults() → ML dataset storage                  │
│    └── getScannerResults() → query stored results                   │
│                                                                     │
│  Libraries in play:                                                 │
│    ├── @/lib/greeks.ts — Black-Scholes                              │
│    ├── @/lib/ml-engine.ts — VWAP, RSI, EMA, ADX (TA only)          │
│    ├── @/lib/sdm-oianalysis.ts — PCR, max pain, OI concentration    │
│    ├── @/lib/market-structure.ts — swing points, BOS, CHoCH        │
│    ├── @/lib/volume-analysis.ts — volume profile, POC, value area  │
│    ├── @/lib/market/canonical.ts — CanonicalMarketSnapshot builder │
│    ├── @/lib/zero-hero.ts — evaluateZeroHeroCandidate (SMC bias)   │
│    └── @/lib/zero-hero-ai/smart-money-engine.ts — DEPRECATED       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Backend Trade Calculation

### 2.1 Entry Price

| Source | Entry Formula | Location |
|--------|--------------|----------|
| **SMC Scanner** (client) | `entry = d.ltp` — option premium LTP from chain data | `ZeroHeroTerminal.tsx:enrich()` |
| **Trade Register** (server) | `entry = Number(entry)` — passed from client as-is | `register/route.ts:61` |
| **Active Trade Tracker** | `trade.entry = entry` — stored unchanged | `activeTradeTracker.ts:19` |
| **Trade Audit** | `entryPrice: trade.entry` — mirrored as-is | `audit-recorders.ts:74` |

**Notable**: The SDM signal route (called by `sendIntradayAlerts`) uses its own entry price calculation. Entry comes from `sdm-engine.ts` which picks the ATM option premium. The SMC scanner always uses the live LTP from the chain.

**Slippage / Buffer**: None. Entry price is the raw LTP with zero buffer.

### 2.2 Stop Loss

| Formula | Value | Location |
|---------|-------|----------|
| `sl = entry × (1 − 0.22)` for CE | 22% below entry | `enrich()` (client) |
| `sl = entry × (1 + 0.22)` for PE | 22% above entry | `enrich()` (client) |
| Default fallback | `sl = entry × 0.78` | `register/route.ts:64` |
| `recordOptionSignals` (CE) | `sl = entry × 0.78` | `audit-recorders.ts:60` |
| `recordOptionSignals` (PE) | `sl = entry × 1.22` | `audit-recorders.ts:60` |

**Stop Loss Determination**:
- ❌ NOT swing high/low based
- ❌ NOT ATR based
- ❌ NOT order block based
- ❌ NOT liquidity based
- ❌ NOT volatility adjusted
- ✅ Fixed percentage: **22% of premium**

**Formula** (CE, from `enrich()`):
```
sl = Math.round(entry * (1 - 0.22) * 100) / 100
   = entry × 0.78
```

**Formula** (PE, from `audit-recorders.ts:60`):
```
sl = entry * (1 + 0.22)
   = entry × 1.22
```

### 2.3 Take Profit

| Target | Formula | Value | R Multiple |
|--------|---------|-------|------------|
| TP1 | `entry × (1 + 0.22)` | 1.22× entry | 1R |
| TP2 | `entry × (1 + 0.22 × 2)` | 1.44× entry | 2R |
| TP3 | Not set | N/A | N/A |

**Take Profit Determination**:
- ❌ NOT ATR based
- ❌ NOT liquidity based
- ❌ NOT max pain based
- ❌ NOT dynamic
- ✅ Fixed 22% increments for 1:2 risk:reward

**Note**: The default in `register/route.ts` is:
```
tp1: Number(tp1) || Number(entry),
tp2: Number(tp2) || Number(tp1) || Number(entry),
```
If TP values are not provided, they default to the entry price (0R, no profit).

### 2.4 Position Size

**The SMC scanner does NOT compute position size.** It only provides:
- `entry` (premium)
- `strike`
- `type` (CE/PE)
- `conf` (confidence score)
- `sl`, `tp1`, `tp2` (price levels)

Position sizing is handled by the parent `executeBuy()` function:
```
positionSize = modalQty × lotSize
             = 1 × lotSize (default)
```
The user can adjust `modalQty` in the trade modal. There is no automatic position sizing.

**Missing position sizing in SMC trade recording**: The `registerTrades` → `/api/trade/register` → `addTrade()` → `tradeStore.createTrade()` flow records confidence as 0 (hardcoded in `activeTradeTracker.ts:63`). Position size is never computed.

### 2.5 Confidence Score

**SMC Client-Side Confidence** (in `enrich()`):
```
conf = Math.min(95, 60 + Math.min(35, Math.abs(oiChg) / 20000))
```

| OI Change | Confidence | Notes |
|-----------|-----------|-------|
| 0 | 60 | Minimum baseline |
| 50,000 | 62.5 | Threshold for trade generation |
| 200,000 | 63.5 | +3.5 from oiChg |
| 700,000 | 95 | Maximum (capped) |

**Confidence Factors**:
| Factor | Weight | Source |
|--------|--------|--------|
| Baseline | 60/95 | Hardcoded minimum |
| OI Change magnitude | up to +35 | `min(35, oiChg / 20000)` |
| Volume | 0 | Not used directly |
| PCR | 0 | Not used |
| Greeks | 0 | Not used |
| VWAP | 0 | Not used |
| Market Structure | 0 | Not used |
| SMC events | 0 | Not used |
| Historical accuracy | 0 | Not used |

**Notable**: The SMC scanner's confidence is **solely based on OI change magnitude**. It does NOT incorporate:
- Trend direction
- Volume confirmation
- PCR analysis
- Greeks (delta, gamma, theta)
- VWAP proximity
- Market structure (BOS, CHoCH, FVG, OB)
- Liquidity sweeps
- Historical win rate
- VIX regime

**Compare with Zero Hero AI confidence** (in `evaluateZeroHeroCandidate`):
| Factor | Weight |
|--------|--------|
| Delta proximity to ATM | up to 25 |
| OI change | up to 25 |
| Volume | up to 15 |
| IV rank | 10 |
| Gamma blast | up to 10 |
| SMC bias match | up to 10 |
| POC proximity | up to 5 |
| **Total** | **100** |

---

## 3. SMC Detection Logic

### 3.1 Client-Side (SmartMoneyTab — Production)

The production SMC scanner uses **one criterion**:

```
1. Sort all strikes by |oiChg| descending
2. Take top 8
3. For each, pick CE or PE based on which has higher |oiChg|
4. Filter: oiChg >= 50000 AND entry > 0
5. These are the "Unusual OI Buildup" trades
```

**No execution order. No BOS. No CHoCH. No Order Blocks. No FVG. No Liquidity Sweep. No Delta. No VWAP.**

The "Smart Money" name refers to unusual OI buildup detection, not actual ICT/SMC price action concepts.

### 3.2 Server-Side (zero-hero-ai/smart-money-engine.ts — DEPRECATED)

This file contains a **complete but deprecated** SMC engine:

| Feature | Implementation | Lines |
|---------|---------------|-------|
| BOS (Break of Structure) | Compare last 3 candles vs prior 3 | 73–87 |
| CHoCH (Change of Character) | Last close beyond last swing but within prior swing | 73–87 |
| FVG (Fair Value Gap) | Gap between prev high and next low | 38–53 |
| Order Block | Strong candle + reversal | 55–71 |
| Liquidity Sweep | Wick beyond prior swing + close back inside | 89–103 |
| Trend confirmation | Swing point sequence | 125–143 |
| Gap detection | Not present | — |
| Volume confirmation | Not present | — |
| Delta confirmation | Not present | — |
| VWAP confirmation | Not present | — |
| ATR filter | Not present | — |

**Bias determination** (6-factor simple count):
```
bullishCount = 0
bearishCount = 0

if (BOS && green close)   bullishCount++
if (CHoCH && green close) bullishCount++
if (FVG UP present)       bullishCount++
if (OB BULLISH present)    bullishCount++
if (LIQ SWEEP && green)   bullishCount++

if (BOS && red close)     bearishCount++
if (CHoCH && red close)   bearishCount++
if (FVG DOWN present)     bearishCount++
if (OB BEARISH present)    bearishCount++
if (LIQ SWEEP && red)     bearishCount++

if (bullishCount > bearishCount) → BULLISH
if (bearishCount > bullishCount) → BEARISH
else → NEUTRAL

confidence = min(100, (bullishCount + bearishCount) × 15)
```

### 3.3 Canonical Market Snapshot (market/canonical.ts — Production)

The `buildCanonicalSnapshot()` function at `canonical.ts:173` recreates FVG + Order Block detection (ported from the deprecated `smart-money-engine.ts`):

- FVG detection: `canonical.ts:118–131` — identical algorithm to deprecated engine
- Order Block detection: `canonical.ts:133–147` — identical algorithm to deprecated engine
- Swing points: `detectSwingPoints()` from `market-structure.ts:10`
- Structure events: `detectStructureEvents()` from `market-structure.ts:65`
- Volume Profile: `buildVolumeProfile()` at `canonical.ts:164`

**However, the CanonicalMarketSnapshot is NOT used by SmartMoneyTab.** It is used by the Market Recorder architecture (scanner recording, evaluation framework, outcome pipeline). The SMC scanner in the Terminal UI is completely independent.

### 3.4 Zero Hero SMC Bias Integration (zero-hero.ts — Production)

In `evaluateZeroHeroCandidate()` (line 496–498):
```
if (input.smcBias === 'BULLISH' && type === 'CE') { conf += 10; }
if (input.smcBias === 'BEARISH' && type === 'PE') { conf += 10; }
```

This is a flat +10 bonus when SMC bias matches the trade direction. It is applied only when `smcBias` is explicitly provided (which requires candle data to be wired).

---

## 4. Filters & Rejection Rules

### 4.1 SMC Scanner (Client-Side)

| Rule | Condition | Location |
|------|-----------|----------|
| Minimum OI change | `Math.abs(oiChg) < 50000` → reject | `ZeroHeroTerminal.tsx:1273` |
| Zero premium | `entry <= 0` → reject | `ZeroHeroTerminal.tsx:1273` |

**All other filters are absent:**
- ❌ No low volume filter
- ❌ No low confidence filter
- ❌ No poor R:R filter
- ❌ No wrong trend filter
- ❌ No high VIX filter
- ❌ No OI conflict filter
- ❌ No Greeks conflict filter
- ❌ No near expiry filter
- ❌ No weak market filter

### 4.2 SDM Signal (Server-Side, used by sendIntradayAlerts)

| Rule | Condition | Location |
|------|-----------|----------|
| Minimum confidence | `conf < 60` → reject | `sendIntradayAlerts.ts:53` |
| Minimum R:R | `rr < 1.5` → reject | `sendIntradayAlerts.ts:53` |
| Has active trade | `hasActiveTrade(sym)` → skip symbol | `sendIntradayAlerts.ts:180` |
| Already sent today | `alreadySentToday(sig)` → skip | `sendIntradayAlerts.ts:213` |

### 4.3 Zero Hero AI Filters (scan-engine.ts — DEPRECATED)

| Rule | Condition | Location |
|------|-----------|----------|
| Premium too low | `ltp < 1` → skip | `scan-engine.ts:104` |
| Outside bandwidth | `|strike - spot| > spot × 4%` → skip | `scan-engine.ts:98` |
| No LTP | `!leg.ltp || leg.ltp <= 0` → skip | `scan-engine.ts:102` |
| Low execution confidence | `execution.decision !== 'BUY_OPTION' && !== 'SMALL_POSITION'` → NO_TRADE | `scan-engine.ts:181` |
| SMC conflict | `type='CE' && smcBias='BEARISH'` → NO_TRADE | `scan-engine.ts:184` |

---

## 5. Trade Lifecycle

### 5.1 Complete Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  SCANNER FINDS SIGNAL                                              │
│  SmartMoneyTab: enrich() detects oiChg >= 50000                   │
│  useEffect → registerTrades("SMC", symbol, candidates)            │
│                                                                    │
│  ▼                                                                │
│  TRADE GENERATED                                                   │
│  POST /api/trade/register  →  addTrade()                          │
│    ├─ Prisma: tradeStore.createTrade() → db.trade.upsert()        │
│    └─ Audit:  recordAuditSignal() → POST :4001/api/signals        │
│                                                                    │
│  ▼                                                                │
│  SCANNER RECORDED                                                  │
│  POST /api/market-recorder/scanner → recordScannerResult()        │
│    └─ Market History (:4002): ScannerResult stored                │
│                                                                    │
│  ▼                                                                │
│  LIVE PRICE FEED                                                   │
│  User opens trade → positions[] (in-memory, local state)          │
│  OR server-side: addTrade() tracks in ActiveTrade Map             │
│                                                                    │
│  ▼                                                                │
│  SL/TP MONITORING                                                 │
│  sendIntradayAlerts.checkSLTP() runs every 15 min                 │
│    ├─ Fetches live premium from /api/option-chain                 │
│    ├─ Compares: currentPrice vs trade.sl, trade.tp1, trade.tp2    │
│    └─ updateTradeStatus() if hit                                  │
│                                                                    │
│  ▼                                                                │
│  TRADE CLOSED                                                      │
│  updateTradeStatus() →                                            │
│    ├─ Prisma:   tradeStore.updateTrade() → PATCH /api/trade-journal│
│    ├─ Audit:    updatePrice() + closeTrade() → :4001              │
│    └─ In-memory: activeTrades.delete(id)                          │
│                                                                    │
│  ▼                                                                │
│  TELEGRAM NOTIFICATION                                             │
│  formatSLTPHit() → sendTelegramMessage()                          │
│                                                                    │
│  ▼                                                                │
│  OUTCOME RESOLVED                                                  │
│  outcome-pipeline.resolveOutcomes()                                │
│    ├─ Maps Trade Audit closed trade → ScannerResult outcome       │
│    ├─ Paper simulates if no trade record (replay engine)          │
│    └─ Updates ScannerResult with WIN/LOSS/CANCELLED               │
│                                                                    │
│  ▼                                                                │
│  EVALUATION                                                        │
│  evaluation-framework.evaluate()                                   │
│    ├─ Trade metrics: win rate, profit factor, expectancy, drawdown │
│    └─ Classification: precision, recall, F1, confusion matrix     │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 Functions Involved (Complete List)

| Phase | File | Function | Line |
|-------|------|----------|------|
| Scan | `ZeroHeroTerminal.tsx` | `SmartMoneyTab.enrich()` | 1262 |
| Scan | `ZeroHeroTerminal.tsx` | `candidatesFromEnriched()` | 1296 |
| Register | `ZeroHeroTerminal.tsx` | `registerTrades()` | 24 |
| Register | `register/route.ts` | `POST` handler | 36 |
| Register | `activeTradeTracker.ts` | `addTrade()` | 49 |
| Register | `tradeStore.ts` | `createTrade()` | 28 |
| Register | `audit-recorders.ts` | `recordAuditSignal()` | 85 |
| Register | `trade-audit-client.ts` | `recordSignal()` | 196 |
| Record | `ZeroHeroTerminal.tsx` | `recordScannerCycle()` | 57 |
| Record | `market/record-scanner.ts` | `recordScannerResult()` | 202 |
| Record | `market-history-client` | `recordScannerResults()` | — |
| Monitor | `activeTradeTracker.ts` | `checkSLTP()` | 198 |
| Monitor | `sendIntradayAlerts.ts` | `getCurrentOptionPrice()` | 62 |
| Close | `activeTradeTracker.ts` | `updateTradeStatus()` | 126 |
| Close | `tradeStore.ts` | `updateTrade()` | 42 |
| Close | `trade-audit-client.ts` | `updatePrice()` | 211 |
| Close | `trade-audit-client.ts` | `closeTrade()` | 223 |
| Notify | `activeTradeTracker.ts` | `formatSLTPHit()` | 242 |
| Notify | `sendIntradayAlerts.ts` | `formatSDMMessage()` | 115 |
| Resolve | `market/outcome-pipeline.ts` | `resolveOutcomes()` | 260 |
| Resolve | `market/outcome-pipeline.ts` | `mapTradeToOutcome()` | 98 |
| Resolve | `market/outcome-pipeline.ts` | `simulatePaperOutcome()` | 139 |
| Evaluate | `market/evaluation-framework.ts` | `evaluate()` | 374 |
| Evaluate | `market/evaluation-framework.ts` | `computeTradeMetrics()` | 120 |
| Evaluate | `market/evaluation-framework.ts` | `computeClassification()` | 252 |

---

## 6. Database Schema & Relationships

### 6.1 SQLite — Prisma (`db/custom.db`)

**Trade** table (`prisma/schema.prisma:34`):
```
Trade
├── id             String  (PK, cuid)
├── tradeId        String  (UNIQUE) — deterministic: STRAT-SYMBOL-STRIKE-TYPE-YYYYMMDD
├── symbol         String
├── strike         Float
├── type           String  (CE / PE)
├── side           String  (BUY / SELL)
├── entryTime      DateTime
├── entryPrice     Float
├── exitTime       DateTime?  → set on SL/TP hit
├── exitPrice      Float?     → SL/TP price
├── pnl            Float?     → calculated on close
├── pnlPercent     Float?
├── holdingTimeMin Float?
├── confidence     Float      → 0 for SMC trades (hardcoded)
├── qualityScore   Float      → 0 for SMC trades
├── qualityGrade   String     → "N/A" for SMC trades
├── aiReasonSnapshot String   → empty for SMC trades
├── exitReason     String?    → "SL_HIT" | "TP1_HIT" | "TP2_HIT" | "MANUAL"
├── status         String     → "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "CLOSED"
├── riskPerTrade   Float      → 0 for SMC trades
├── positionSize   Float      → 0 for SMC trades
├── stopLoss       Float
├── target1        Float?
├── target2        Float?
├── target3        Float?     → never set (SMC has no TP3)
├── tpHitLevel     String?
├── strategy       String     → "SMC" for Smart Money trades
├── tradedAt       DateTime   → daily grouping
└── createdAt      DateTime
```

**DomAnalysis** table (unused by SMC):
```
DomAnalysis
├── id             String (PK)
├── symbol         String
├── date           DateTime
├── spot           Float
├── atmStrike      Float
├── pcr            Float
├── maxPain        Float
├── expiry         String
├── timestamp      DateTime
├── strikes        Json
├── unusualBuildup Json
├── resistance     Json
├── support        Json
└── createdAt      DateTime
```

### 6.2 Trade Audit Sidecar — SQLite (`trade-audit/`)

Referenced by `trade-audit-client.ts` → `:4001/api/signals` / `/api/trades` / `/api/stats`

Schema is not in this repo (separate sidecar in `trade-audit/` directory). It contains:
- `TradeRecord` with strategyId, MFE/MAE, TP1/TP2/SL hits, R-multiple, holding time, verification

### 6.3 Market History Sidecar — SQLite

Referenced by `market-history-client` → `:4002`

Contains:
- `CanonicalMarketSnapshot` records (full market state at scan time)
- `ScannerResult` records (per-cycle decisions with resolved outcomes)

### 6.4 Relationship Diagram

```
┌─────────────────┐         ┌──────────────────────┐
│  Prisma (SQLite) │         │  Trade Audit (:4001) │
│  db.trade        │         │  TradeRecord          │
│                  │         │                      │
│  tradeId ────────┼────────►│  id (deterministic)  │
│  strategy="SMC"  │         │  strategyId="SMC"    │
│  entryPrice      │         │  entryPrice           │
│  stopLoss        │         │  stopLoss             │
│  target1         │         │  tp1                  │
│  target2         │         │  tp2                  │
│  status          │         │  status (open/closed) │
│  pnl             │         │  netPnl               │
│  exitPrice       │         │  exitPrice            │
│  exitReason      │         │  exitReason           │
└─────────────────┘         │  mfe / mae            │
        ▲                   │  rMultiple            │
        │                   │  tp1Hit / tp2Hit      │
        │                   │  verification          │
        │                   └──────────────────────┘
        │
        │                   ┌──────────────────────────┐
        │                   │  Market History (:4002)  │
        │                   │  ScannerResult            │
        │                   │                           │
        └───────────────────┤  sessionId                │
                            │  snapshotId ────► Snapshot│
                            │  decision                 │
                            │  confidence               │
                            │  outcome (WIN/LOSS/...)  │
                            │  exitReason               │
                            └──────────────────────────┘
```

---

## 7. Improvement Audit

### 7.1 Weak Calculations

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| W1 | **Fixed 22% SL** ignores volatility, ATR, market regime | `ZeroHeroTerminal.tsx:enrich()` | Wrong SL in high/low vol regimes |
| W2 | **Fixed 22% TP1/TP2** (1:2 R:R) never adjusts to market conditions | `ZeroHeroTerminal.tsx:enrich()` | Fixed targets miss when trend allows more |
| W3 | **Confidence = OI change only** — ignores trend, volume, Greeks, PCR, VIX, market structure, historical accuracy | `ZeroHeroTerminal.tsx:enrich()` | False positives from OI anomalies without price confirmation |
| W4 | **Entry = LTP raw** — no slippage buffer, no spread consideration | `ZeroHeroTerminal.tsx:enrich()` | Executable price may differ |
| W5 | **Confidence hardcoded to 0** when registering SMC trades | `activeTradeTracker.ts:63` | Prisma stores confidence=0 for all SMC trades, breaks analytics |
| W6 | **Min OI threshold (50,000)** is same for all symbols regardless of contract size | `ZeroHeroTerminal.tsx:enrich()` | BANKNIFTY OI is ~10× NIFTY — threshold should be proportional |
| W7 | **`spotPrice = entry`** when recording to audit engine | `audit-recorders.ts:71` | Audit engine stores option premium as spot price — incorrect for MFE/MAE calculations |
| W8 | **R:R capped at 4** in SDM signal conversion | `sendIntradayAlerts.ts:84` | `rr > 3 → 4`, `> 2 → 3`, `> 1 → 2` — crude quantization |
| W9 | **Position size = 0** in SMC trades | `activeTradeTracker.ts:63-64` | No risk-based position sizing |
| W10 | **No TP3** — SMC only uses TP2 | `enrich()` | Misses extended trend captures |

### 7.2 Missing Confirmations

| # | Missing Check | Required Before | Location |
|---|--------------|-----------------|----------|
| M1 | **Trend confirmation** — BOS/CHoCH direction | Generating BUY/SELL signal | `SmartMoneyTab` — absent |
| M2 | **Volume confirmation** — volume above average for the strike | Recording candidate | `SmartMoneyTab` — absent |
| M3 | **Delta confirmation** — delta should support directional bias | Setting SL/TP levels | `SmartMoneyTab` — absent |
| M4 | **VWAP proximity** — entry near VWAP for better fill | Placing trade | `SmartMoneyTab` — absent |
| M5 | **PCR confirmation** — PCR OI should align with direction | Generating signal | `SmartMoneyTab` — absent |
| M6 | **Max Pain check** — strike relative to max pain | Selecting strike | `SmartMoneyTab` — absent |
| M7 | **IV check** — IV percentile shouldn't be extreme | Entering position | `SmartMoneyTab` — absent |
| M8 | **Greeks coherence** — gamma/theta relationship | Setting targets | `SmartMoneyTab` — absent |
| M9 | **Near-expiry warning** — skip trades with < 1 DTE | Signal generation | `SmartMoneyTab` — absent |
| M10 | **VIX regime** — skip high-volatility periods | Signal generation | `SmartMoneyTab` — absent |
| M11 | **OI buildup direction** — check if buildup is in money or out of money | Signal direction | `SmartMoneyTab` — absent |
| M12 | **Market structure** — support/resistance nearby | SL placement | `SmartMoneyTab` — absent |
| M13 | **Breadth** — market breadth supporting directional bias | Signal generation | `SmartMoneyTab` — absent |

### 7.3 Duplicate Logic

| # | Description | Files | Status |
|---|-------------|-------|--------|
| D1 | FVG detection — identical algorithm in 3 places | `canonical.ts:118`, `smart-money-engine.ts:38`, `zero-hero-ai` | canonical.ts is production; smart-money-engine.ts is DEPRECATED |
| D2 | Order Block detection — identical in 2 places | `canonical.ts:133`, `smart-money-engine.ts:55` | canonical.ts is production; smart-money-engine.ts is DEPRECATED |
| D3 | Swing point detection — used by both | `market-structure.ts:10`, `canonical.ts:151` | canonical.ts imports from market-structure.ts — clean |
| D4 | Trade registration — 3 parallel flows: | `registerTrades()` client, `addTrade()` activeTradeTracker, `recordIntradayTrade()` | All ultimately call different endpoints — some redundancy |
| D5 | SL/TP calculation — same formula in 4 places: | `enrich()`, `register/route.ts:64`, `audit-recorders.ts:60-62`, `recordOptionSignals()` | 22% fixed formula duplicated |

### 7.4 Dead Code

| # | Description | File | Line(s) | Notes |
|---|-------------|------|---------|-------|
| X1 | `DomAnalysis` model | `prisma/schema.prisma:66` | Whole model | Not referenced by any scanner or API |
| X2 | `DomAnalysis` API routes | `app/api/...` | — | Data goes into DomAnalysis table but nothing reads it for SMC |
| X3 | Entire `zero-hero-ai/` directory | `src/lib/zero-hero-ai/` | All files | Marked DEPRECATED; logic ported to `canonical.ts` + `zero-hero.ts` |
| X4 | User + Post Prisma models | `prisma/schema.prisma:16-32` | — | Unused legacy |
| X5 | `llm-summary.ts` | — | — | If it exists, unused by SMC |
| X6 | Gamma blast integration in `analyzeZeroHeroChain` | `zero-hero.ts:437-438` | — | Works but never called from SMC path |
| X7 | `DomAnalysis.unusualBuildup` JSON field | `prisma/schema.prisma:77` | — | SMC writes to trade table, not DomAnalysis |
| X8 | `trade.target3` field | `prisma/schema.prisma:59` | — | Never set by SMC (no TP3) |

### 7.5 Unused Indicators

The following data is available in the option chain response but **never used** by the SMC scanner:

| Indicator | Available in Chain? | Used by SMC? |
|-----------|--------------------|--------------|
| OI (open interest) | ✅ | ❌ (only oiChg) |
| Volume | ✅ | ❌ (displayed but not filtered on) |
| IV (implied volatility) | ✅ | ❌ |
| Delta | ✅ | ❌ |
| Gamma | ✅ | ❌ |
| Theta | ✅ | ❌ |
| Vega | ✅ | ❌ |
| Bid/Ask spread | ✅ | ❌ |
| IV percentile | ❌ (not fetched) | ❌ |
| Greeks from Black-Scholes | ✅ (calculated in greeks.ts) | ❌ |
| Gamma blast detection | ✅ (gamma-blast.ts) | ❌ |
| PCR OI | ✅ (computed from chain) | ❌ |
| PCR Volume | ✅ (computed from chain) | ❌ |
| Max Pain | ✅ (returned by API) | ❌ |
| VIX | ✅ (fetched separately) | ❌ |
| ATR | ❌ (needs candle data) | ❌ |
| VWAP | ❌ (needs candle data) | ❌ |
| Volume Profile / POC | ❌ (needs candle data) | ❌ |
| FII/Pro OI flow | ✅ (computed in flowData) | ❌ (displayed as FIIFlowPanel separate) |

### 7.6 Bottlenecks

| # | Bottleneck | File | Impact |
|---|-----------|------|--------|
| B1 | **Sequential chain fetches** for Scan All mode | `SmartMoneyTab` useEffect | 5 sequential fetches (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX) — each can take 2-5s |
| B2 | **Option chain refetched** on every tab switch + every 15s poll cycle | `ZeroHeroTerminal.tsx:310` | High API load during market hours |
| B3 | **No data caching** — chain re-fetched from scratch every cycle | `fetchChain()` | Every tab switch or poll triggers full Breeze → NSE → Yahoo fallback chain |
| B4 | **SL/TP check fetches full option chain** for each active trade | `getCurrentOptionPrice():64` | Fetches entire chain just for one strike's LTP — wasteful |
| B5 | **In-memory positions** only (user's local state) | `ZeroHeroTerminal.tsx:233` | Trades lost on page refresh; discord between UI positions and server-tracked trades |

### 7.7 Potential Bugs

| # | Bug | Location | Description |
|---|-----|----------|-------------|
| P1 | **Confidence hardcoded 0** in addTrade → Prisma | `activeTradeTracker.ts:63` | `confidence: 0` — all SMC trades stored with 0 confidence in DB |
| P2 | **`spotPrice = entry`** passed to audit engine | `audit-recorders.ts:71` | Option premium stored as spot price — MFE/MAE calculations on wrong reference |
| P3 | **No-op trade registration** when API fails | `registerTrades():45` | `.catch(() => {})` — silent failure; user thinks trade is registered but it's not |
| P4 | **`recordScannerCycle` always sends NO_TRACE** when no candidates | `recordScannerCycle():78-90` | Even when no eligible strikes exist, records a NO_TRADE row — correct but may skew metrics |
| P5 | **`recordAuditSignal` `updatePrice` silently fails** | `audit-recorders.ts:88` | `.catch(() => {})` — price update failures unnoticed |
| P6 | **Scan All fetches re-run on every render** | `SmartMoneyTab` useEffect — dependent on `chain` | When chain updates, useEffect re-fires and re-checks `missing` — if a fetch is in-flight, it still adds a new one because `allChains[sym]` is not set until fetch completes |
| P7 | **`computeSMC` / `enrich` always runs on all 8 rows** | `enrich()` | Even rows with 0 OI change are included in the enriched output if they're in the top 8 |
| P8 | **SDM signal `sdmSignalToAlert` uses `rr > 3 → 4`** | `sendIntradayAlerts.ts:84` | Crude bucketing loses precision — R:R 2.5 rounds to 2, R:R 3.5 rounds to 4 |
| P9 | **Simulated paper outcome uses underlying price** for options | `outcome-pipeline.ts:162-215` | Paper simulations on option trades compare underlying price against option premium levels (SL/TP) — incorrect comparison |
| P10 | **lookback=3 swing points may miss structure** | `market-structure.ts:12` | Fixed 3-candle lookback may miss significant swing points |

### 7.8 Performance Issues

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| R1 | **Unnecessary re-renders** | `SmartMoneyTab` — state updates for each symbol's chain fetch | Every state set in `allChains` triggers re-render of entire table |
| R2 | **`enrich()` called on every render** | `SmartMoneyTab` render section | Not memoized — recomputes sort + filter unconditionally |
| R3 | **No pagination** on trade journal GET | `trade-journal/route.ts:78` | Returns up to 200 trades unfiltered |
| R4 | **No index on `trade.tradedAt`** | Prisma schema | The GET handler sorts by `entryTime DESC` with no DB index |

### 7.9 Institutional Improvements (Recommended)

| # | Improvement | Priority | Effort | Notes |
|---|-------------|----------|--------|-------|
| I1 | **Add ATR-based SL** instead of fixed 22% | High | Medium | Use 1.5× ATR of underlying for SL placement |
| I2 | **Add trend confirmation** before generating signals | High | Medium | Check BOS/CHoCH direction aligns with CE/PE selection |
| I3 | **Add volume filter** — only trade strikes with above-average volume | High | Low | Filter from chain data directly |
| I4 | **Add delta filter** — only trade delta between 0.20-0.60 | High | Low | Filter from chain data directly |
| I5 | **Proportional OI threshold** — scale to symbol's average OI | High | Low | Use percentiles instead of absolute 50,000 |
| I6 | **Add slippage buffer** — entry = LTP × 1.02 (CE) / 0.98 (PE) | Medium | Low | Prevents unfillable orders |
| I7 | **Wire CanonicalMarketSnapshot** into SMC scanner | Medium | High | Reuse existing FVG/OB/swing detection for signal validation |
| I8 | **Add VIX regime filter** — skip when VIX > 25 or VIX < 10 | Medium | Low | Extreme VIX = unreliable OI signals |
| I9 | **Add max pain check** — opposite direction from max pain is risky | Medium | Low | Available from API response |
| I10 | **Add position sizing** — Kelly or fixed % risk | Medium | Low | Currently no auto position sizing |
| I11 | **Unify confidence across all scanners** | Medium | Medium | SMC uses 0 in DB, Zero Hero uses calculated — inconsistent |
| I12 | **Add near-expiry skip** — skip if DTE < 7 (or DTE < 1) | Medium | Low | Theta decay makes short-dated OI signals unreliable |
| I13 | **Cache option chain data** — reduce API load | Medium | Medium | Cache for 5-10s within market hours |
| I14 | **Add III (Institutional/Volume profile) confirmation** | Low | High | Use market/canonical.ts volume profile data |
| I15 | **Add OTM/ITM context** — OI buildup in OTM is stronger signal than ITM | Medium | Low | Compare strike to spot price |
| I16 | **Auto-adjust SL/TP to round numbers** — better fills | Low | Low | Round to nearest 5 paise |
| I17 | **Add TP3** — trailing TP after TP2 hit | Low | Medium | Capture extended moves |
| I18 | **Add historical accuracy weighting** — adjust confidence based on past win rate for that symbol/direction | High | Medium | Use outcome-pipeline resolved outcomes |
| I19 | **Fix `spotPrice = entry` in audit recorder** | High | Low | Pass actual spot price, not option premium |
| I20 | **Fix `confidence = 0` in SMC trade store** | High | Low | Pass the computed SMC confidence |

---

## Appendix A: File Index

| # | File Path | Lines | Role |
|---|-----------|-------|------|
| 1 | `src/components/terminal/ZeroHeroTerminal.tsx` | 1573 | SMC UI scanner + enrichment logic |
| 2 | `src/app/api/trade/register/route.ts` | 88 | Trade registration endpoint |
| 3 | `src/lib/activeTradeTracker.ts` | 262 | In-memory trade tracking, SL/TP monitoring |
| 4 | `src/lib/tradeStore.ts` | 84 | Prisma trade persistence |
| 5 | `src/lib/trade-audit-client.ts` | 261 | Trade Audit sidecar HTTP client |
| 6 | `src/lib/audit-recorders.ts` | 92 | Builds audit SignalInput for SMC |
| 7 | `src/lib/market/record-scanner.ts` | 208 | Scanner result builder + recorder |
| 8 | `src/lib/market/evaluation-framework.ts` | 394 | Trade + classification metrics |
| 9 | `src/lib/market/outcome-pipeline.ts` | 393 | Resolves scanner outcomes |
| 10 | `src/lib/market/canonical.ts` | 239 | CanonicalMarketSnapshot builder |
| 11 | `src/lib/market-structure.ts` | 241 | Swing points, BOS, CHoCH |
| 12 | `src/lib/zero-hero.ts` | 534 | Zero Hero engine (uses SMC bias +10) |
| 13 | `src/lib/zero-hero-ai/smart-money-engine.ts` | 154 | DEPRECATED full SMC engine |
| 14 | `src/lib/zero-hero-ai/scan-engine.ts` | 231 | DEPRECATED Zero Hero scanner |
| 15 | `src/lib/sendIntradayAlerts.ts` | 345 | Server-side Telegram alert cron |
| 16 | `src/lib/intraday-scanner.ts` | 905 | Intraday scanner + recordIntradayTrade |
| 17 | `src/app/api/option-chain/route.ts` | 487 | Option chain data source |
| 18 | `src/app/api/trade-journal/route.ts` | 180 | Prisma trade CRUD |
| 19 | `prisma/schema.prisma` | 83 | Database schema |

## Appendix B: Key Formulas Reference

```
SMC Scanner (enrich):
  entry = d.ltp || 0
  sl = entry × (1 - 0.22)      [CE]
  sl = entry × (1 + 0.22)      [PE]
  tp1 = entry × (1 + 0.22)     [CE]
  tp1 = entry × (1 - 0.22)     [PE]
  tp2 = entry × (1 + 0.22 × 2) [CE]
  tp2 = entry × (1 - 0.22 × 2) [PE]
  rr = 2
  conf = min(95, 60 + min(35, |oiChg| / 20000))
  oiChg >= 50000 → trade candidate
  entry > 0 → trade candidate

Trade register fallback:
  sl = entry × 0.78
  tp1 = entry
  tp2 = tp1 || entry

SDM signal filter:
  conf >= 60% AND rr >= 1.5

Zero Hero confidence:
  Delta 0.40-0.60: +25
  OI change: +min(25, |oiChg|/50000 × 25)
  Volume: +min(15, volume/100000 × 15)
  IV < 60: +10
  Gamma blast: +0-15
  SMC bias match: +10
  POC proximity: +5
  Total capped at 100

Zero Hero SMC bias:
  conf += 10 when smcBias matches trade direction
```
