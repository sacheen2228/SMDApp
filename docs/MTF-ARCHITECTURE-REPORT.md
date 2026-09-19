# Phase 1: Multi-Timeframe Architecture Report

## Executive Summary

The SMDApp has **52 signal engines** with **200+ exported functions**. The challenge is NOT building new engines — it is creating a **canonical multi-timeframe indicator confirmation layer** that feeds into the existing validation and trade execution pipeline without duplicating any logic.

---

## 1. EXISTING ENGINES TO REUSE (Not Rebuild)

### 1.1 Indicator Calculations (Already Exist)

| Indicator | File | Function | Configurable? |
|---|---|---|---|
| **SuperTrend** | `supertrend-engine.ts` | `computeSuperTrend(candles, config?)` | YES — `{ period: 10, multiplier: 3.0 }` |
| **RSI** | `ml-engine.ts` | `calculateRSI(candles, period=14)` | YES — period parameter |
| **EMA** | `ml-engine.ts` | `calculateEMA(data, period)` | YES — period parameter |
| **Bollinger Bands** | `ml-engine.ts` | `calculateBollingerBands(closes, period=20, multiplier=2)` | YES — period + multiplier |
| **VWAP** | `ml-engine.ts` | `calculateVWAP(candles)` | NO (session-based) |
| **VWAP (Advanced)** | `vwap-engine.ts` | `calculateSessionVWAP(candles)` + deviation bands | YES — multipliers |
| **ADX** | `ml-engine.ts` | `calculateADX(candles, period=14)` | YES — period parameter |
| **ATR** | `smart-entry.ts` | `computeATR(candles, period=14)` | YES — period parameter |
| **MACD** | `ml-engine.ts` | Computed as EMA(12) - EMA(26) + signal EMA(9) | Standard 12/26/9 |
| **Pivot Points** | `candlestick-breakout.ts` | `_calculatePivots()` — R1/R2/S1/S2 | YES — Camarilla style |
| **Volume Profile** | `auction-engine.ts` | `calculateVolumeProfile(candles, tickSize)` | YES — tick size |
| **Market Structure** | `market-structure.ts` | `analyzeMarketStructure(candles)` | Swing lookback=3 |
| **MSS (BOS/CHoCH)** | `mss-engine.ts` | `analyzeMSS(candles, config)` | YES — sweep gate |
| **GEX** | `gex-engine.ts` | `calculateGEX(optionChain, spot)` | NO (derives from chain) |

### 1.2 Multi-Timeframe Analysis (Already Exists)

| Engine | File | What It Does |
|---|---|---|
| **Multi-TF Consensus** | `multi-timeframe.ts` | `analyzeMultiTimeframe(candlesByTimeframe)` — accepts `Record<string, CandleData[]>`, computes EMA/structure/volume per TF, returns consensus bias |
| **HTF Candle Aggregation** | `liquidity-engine.ts` | `aggregateToHTF(candles, targetTF)` — aggregates lower-TF to 1H/4H/1D/1W |
| **Master Bot MTF** | `master-bot-engine.ts` | `fetchAllTimeframes()` — fetches 3m/5m/15m/1h/daily from Yahoo |

### 1.3 Candle Data Sources (Already Exist)

| Source | File | Timeframes | Auth Required |
|---|---|---|---|
| **Breeze** | `breeze-historical.ts` | 1m, 5m, 15m | YES (ICICI) |
| **Breeze→Yahoo** | `historical-data.ts` | 1m–1M (interval map) | Breeze fallback to Yahoo |
| **Yahoo Finance** | `trade-backtest-engine.ts` | 5m, 15m, 1h, 1d | NO (free) |
| **Yahoo Intraday** | `intraday-scanner.ts` | Daily + 5m | NO (free) |
| **Yahoo MTF** | `master-bot-engine.ts` | 3m/5m/15m/1h/daily | NO (free) |

### 1.4 Validation & Trade Execution (Already Exist)

| System | File | Checks |
|---|---|---|
| **Canonical Trade Validator** | `trade-validator-gate.ts` | 24 checks (option buying only, premium, freshness, OI, Greeks, spread, R:R, active lock) |
| **SDM Validation Gate** | `validation-gate.ts` | 13 checks (health, Greeks, OI, stale, confidence, risk, entry, liquidity, spread, MTF, volume, news) |
| **Hermes Trade Validator** | `hermes/trade-validator.ts` | 15 steps (data, freshness, market, spot, chain, expiry, strike, premium, liquidity, OI, Greeks, spread, structure, R:R, session) |
| **No-Trade Engine** | `hermes/no-trade-engine.ts` | 12 categories (data, market, VIX, news, liquidity, spread, R:R, quality, expected move, data health) |
| **Data Health** | `data-health.ts` | 4-factor scoring (latency, freshness, completeness, Greeks) |
| **Active Trade Lock** | `active-trade-lock.ts` | One trade per underlying, atomic acquire, DB persistence |
| **Signal Dedup** | `signalTracker.ts` | Full-day signature dedup |
| **Score Freeze** | `score-frozen.ts` | Immutable snapshot at entry |
| **Signal Lifecycle** | `agents/signal-lifecycle.ts` | RESEARCH→CANDIDATE→VALIDATING→VALIDATED→FINAL→ACTIVE |

### 1.5 OI/Greeks/CAS Analysis (Already Exist)

| Engine | File | What It Does |
|---|---|---|
| **OI Analysis** | `sdm-oianalysis.ts` | OI classification, fresh writing, traps, S/R from OI, max pain, PCR |
| **Greeks Calculator** | `greeks.ts` | Black-Scholes: delta, gamma, theta, vega |
| **GEX Engine** | `gex-engine.ts` | Gamma exposure, gamma flip, gamma walls |
| **Buyer Confluence** | `buyer-confluence-engine.ts` | 9-factor scoring (FII/DII, OI, IV, technicals, VIX, session) |
| **CAS Strategy** | `cas-straddle-strategy-v2.ts` | CAS reference, dislocation, regime, straddle evaluation |
| **Institutional** | `institutional-positioning-engine.ts` | NSE Participant OI, FII/Pro/Client, retail trap |

---

## 2. WHAT IS MISSING (Needs Implementation)

### 2.1 No 3-Minute Candle Source
- Yahoo Finance does NOT support 3m interval
- Breeze supports 1m (can aggregate to 3m)
- **Solution:** Aggregate 1m candles to 3m bars in-memory, or use 5m as closest alternative

### 2.2 No Canonical MTF Indicator Engine
- Each dashboard computes indicators independently
- No single function that computes ALL indicators across ALL timeframes
- **Solution:** Create `src/lib/mtf-indicator-engine.ts` that:
  1. Takes multi-TF candles as input
  2. Computes SuperTrend, RSI, Bollinger, VWAP, ATR, ADX, Pivots per timeframe
  3. Returns structured result per timeframe
  4. Does NOT fetch data — caller provides candles

### 2.3 No Canonical MTF Signal Confirmation
- No function that applies 15M→5M→3M workflow
- **Solution:** Create `src/lib/mtf-signal-engine.ts` that:
  1. Takes MTF indicator results
  2. Applies 15M trend filter → 5M signal → 3M entry confirmation
  3. Computes confirmation score
  4. Returns BUY_CE/BUY_PE/WAIT/INVALID with reasons
  5. Does NOT fetch data — caller provides candles + indicators

### 2.4 No Strike Selection Engine
- Each dashboard selects strikes differently
- **Solution:** Create `src/lib/strike-selector.ts` that:
  1. Takes option chain + direction + entry/SL/TP from underlying
  2. Evaluates ATM/ITM/OTM on delta, gamma, theta, IV, spread, volume, OI, liquidity
  3. Returns best strike with reasons

---

## 3. PROPOSED ARCHITECTURE

```
┌─────────────────────────────────────────────────────────┐
│                    CANDLE SOURCES                        │
│  Breeze (1m/5m/15m) → Yahoo (5m/15m/1h/1d) → MTF      │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              MTF INDICATOR ENGINE (NEW)                  │
│  src/lib/mtf-indicator-engine.ts                        │
│  - computeMTFIndicators(candlesByTimeframe)              │
│  - SuperTrend(10,3), RSI(14), BB(20,2), VWAP, ATR(14) │
│  - ADX(14), Pivots(R1/S1), Volume confirm               │
│  - Returns: { 15m: {...}, 5m: {...}, 3m: {...} }       │
│  - PURE COMPUTATION — no data fetching                   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              MTF SIGNAL ENGINE (NEW)                     │
│  src/lib/mtf-signal-engine.ts                           │
│  - generateMTFSignal(indicators, optionChain, context)   │
│  - 15M TREND FILTER → 5M SIGNAL → 3M ENTRY CONFIRM     │
│  - Score: 15M(20) + ST(15) + RSI(15) + Pivot(15)      │
│           + BB(10) + VWAP(10) + 3M(10) + DataQ(5)     │
│  - Returns: BUY_CE/BUY_PE/WAIT/INVALID                  │
│  - PURE COMPUTATION — no data fetching                   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              STRIKE SELECTOR (NEW)                       │
│  src/lib/strike-selector.ts                             │
│  - selectOptimalStrike(chain, direction, entry, SL, TP) │
│  - Evaluates: delta, gamma, theta, IV, spread, volume   │
│  - Returns: best strike + reasoning                     │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│         EXISTING VALIDATION PIPELINE (REUSE)             │
│  validateCandidateTrade() → acquireTradeLock()           │
│  → create/register trade → score-frozen → lifecycle      │
└─────────────────────────────────────────────────────────┘
```

---

## 4. FILES TO CREATE

| File | Purpose | Lines Est. |
|---|---|---|
| `src/lib/mtf-indicator-engine.ts` | Compute indicators across all timeframes | ~300 |
| `src/lib/mtf-signal-engine.ts` | MTF signal confirmation workflow | ~400 |
| `src/lib/strike-selector.ts` | Optimal strike selection | ~200 |
| `src/lib/mtf-config.ts` | Configurable indicator parameters | ~50 |

**Total new code: ~950 lines**

## 5. FILES TO MODIFY (Integration Only)

| File | Change | Risk |
|---|---|---|
| `src/app/api/sdm-signal/route.ts` | Feed MTF indicators into signal generation | LOW — wraps existing |
| `src/lib/sdm-recommendation.ts` | Add MTF confirmation as additional input | LOW — additive |
| `src/components/terminal/ZeroHeroTerminal.tsx` | Display MTF status in UI | LOW — display only |
| `src/components/zerohero/ZeroHeroLiveTerminal.tsx` | Display MTF alignment | LOW — display only |
| `src/components/dashboard/SimpleMode.tsx` | Show MTF trend status | LOW — display only |
| `src/components/dashboard/IntelTab.tsx` | Show MTF vs Intel alignment | LOW — display only |
| `src/lib/hermes/agent.ts` | Add MTF context to Hermes tools | LOW — additive |
| `src/lib/sendIntradayAlerts.ts` | Include MTF data in alerts | LOW — additive |

## 6. EXISTING MODULES REUSED (Complete List)

- `supertrend-engine.ts` — SuperTrend computation
- `ml-engine.ts` — RSI, EMA, Bollinger, VWAP, ADX
- `vwap-engine.ts` — Advanced VWAP with deviation bands
- `market-structure.ts` — Swing points, S/R levels
- `mss-engine.ts` — BOS/CHoCH detection
- `candlestick-breakout.ts` — Pivot points (R1/S1)
- `auction-engine.ts` — Volume profile (POC/VAH/VAL)
- `volume-engine.ts` — Relative volume
- `multi-timeframe.ts` — Consensus aggregation
- `liquidity-engine.ts` — HTF candle aggregation
- `greeks.ts` — Black-Scholes Greeks
- `gex-engine.ts` — Gamma exposure
- `sdm-oianalysis.ts` — OI classification, PCR, max pain
- `data-health.ts` — Health scoring
- `validation-gate.ts` — 13-check validation
- `trade-validator-gate.ts` — 24-check validation
- `hermes/trade-validator.ts` — 15-step Hermes validation
- `active-trade-lock.ts` — One trade per underlying
- `risk-management.ts` — Position sizing, risk limits
- `signalTracker.ts` — Deduplication
- `score-frozen.ts` — Score snapshot
- `agents/signal-lifecycle.ts` — Signal state machine
- `breeze-historical.ts` — 1m/5m/15m candles
- `historical-data.ts` — Breeze→Yahoo fallback candles
- `trade-backtest-engine.ts` — Yahoo candles
- `master-bot-engine.ts` — Yahoo MTF candles (3m/5m/15m/1h/daily)

---

## 7. ASSUMPTIONS

1. **Breeze not authenticated** — All intraday candles come from Yahoo (5m minimum). 3m candles will use 5m as closest.
2. **VIX hardcoded to 15** — Live VIX fetched when NSE available; fallback to 15.
3. **No real-time tick data** — Signals based on candle close, not tick-level.
4. **Option chain from NSE API** — Not real-time; delayed by ~15min after hours.
5. **One active trade per underlying** — Enforced by active-trade-lock.
6. **No ML** — All indicators are classical TA (RSI, SuperTrend, etc.).
7. **Option buying only** — CE BUY and PE BUY only, never selling.

## 8. DATA LIMITATIONS

1. **3m candles unavailable** — Yahoo doesn't support 3m. Will use 5m as the entry timeframe.
2. **1m candles require Breeze auth** — Currently not authenticated. 1m/3m monitoring limited.
3. **After-hours data** — NSE blocks API access after 3:30 PM. Signals only during market hours.
4. **Breeze session expiry** — Auto-retry exists but session may expire during trading hours.
5. **Yahoo rate limits** — No known limits but occasional timeouts observed.

## 9. IMPLEMENTATION ORDER

1. Create `mtf-config.ts` (indicator parameters)
2. Create `mtf-indicator-engine.ts` (compute indicators per TF)
3. Create `mtf-signal-engine.ts` (15M→5M→3M workflow)
4. Create `strike-selector.ts` (optimal strike)
5. Integrate with `/api/sdm-signal` (feed MTF into existing pipeline)
6. Integrate with `sdm-recommendation.ts` (add MTF confirmation)
7. Add MTF status to UI components
8. Add MTF context to Hermes agent tools
9. Include MTF data in Telegram alerts
10. Add tests for bullish/bearish/conflicting/missing data scenarios

---

*Report generated: 2026-09-19*
*Status: Phase 1 complete — no code changes made*
