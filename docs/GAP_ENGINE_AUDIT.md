# Gap Analysis Engine — Full Audit Report

**Date:** 2026-07-14
**Auditor:** SMDPro Platform Architecture Guardian
**Scope:** All gap-related code across the entire codebase

---

## 1. Executive Summary

The current Gap Analysis engine has **no predictive capability**. It is a collection of **5 independent, uncoordinated heuristic implementations** spread across the codebase, each computing gap-related metrics using **different formulas, thresholds, and data sources with zero shared code**. There is **no historical gap database**, **no trained model**, and **no validation framework**.

**The engine predicted 75% Gap Up — the market opened Gap Down.** This failure is not a bug; it is a direct consequence of building a prediction system without data.

---

## 2. File Inventory

| # | File | Lines | Role | Gap Logic |
|---|---|---|---|---|
| 1 | `src/components/dashboard/GapAnalysis.tsx` | 633 | UI component | `predictGap()` heuristic scoring |
| 2 | `src/app/api/gift-nifty/route.ts` | 38 | Data API | Fetches Gift Nifty from Yahoo |
| 3 | `src/lib/sdmChat.ts` | 508 | Chat intent | `GapInfo` interface, `formatGap()` |
| 4 | `src/lib/btst-engine.ts` | 273 | BTST scoring | `gapRisk` heuristic |
| 5 | `src/lib/candlestick-breakout.ts` | 636 | Breakout detection | `setGiftNiftyBias()` |
| 6 | `src/lib/backtest-engine.ts` | 708 | Backtest engine | **BUG** — wrong Gift Nifty data |
| 7 | `src/lib/agent-brain.ts` | 771 | LLM agent | **BUG** — `giftNifty.gap` undefined |
| 8 | `src/lib/yahoo-finance-api.ts` | 131 | Yahoo fetcher | Maps GIFTNIFTY → `SGXNIFTY.NS` |
| 9 | `src/app/api/option-chain/route.ts` | 487 | Option chain API | Provides `prevClose` |
| 10 | `src/lib/master-bot-engine.ts` | 577 | Master bot | Gap Fade setup (different gap meaning) |
| 11 | `src/lib/tradeAlertEngine.ts` | 365 | Intent detection | `"gap"` intent regex |
| 12 | `src/lib/llmResolve.ts` | ~30 | LLM resolution | `"gap"` as valid intent |
| 13 | `src/lib/correlation-engine.ts` | 227 | Correlation | "gap" = return difference (unrelated) |
| 14 | `src/lib/bse-api.ts` | 217 | BSE data | Provides real `Prev_Close` |
| 15 | `src/lib/zero-hero.ts` | ~400 | Zero Hero scanner | Hardcoded 1.5% gap stop |

---

## 3. Current Architecture

```
Yahoo Finance (SGXNIFTY.NS)
        │
        ▼
  /api/gift-nifty/route.ts
        │
        ├──► estimated fallback when Yahoo fails (gap=0, no warning)
        │
        ├──► GapAnalysis.tsx (useEffect fetch)
        │       └── predictGap() — pure heuristic, 5 factors
        │
        ├──► sdm-chat/route.ts (gapLookup)
        │       └── sdmChat.ts — qualitative narrative only
        │
        └──► agent-brain.ts (get_gift_nifty tool)
                └── reads giftNifty.gap — FIELD DOES NOT EXIST

    BTST Engine            Candlestick Breakout       Master Bot
    (5-factor heuristic)   (bias +/-10 points)        (period gap fade)
```

---

## 4. Data Sources — Verified

| Source | Symbol | Real? | Issue |
|---|---|---|---|
| Yahoo Finance | GIFTNIFTY → `SGXNIFTY.NS` | Real (when Yahoo works) | Symbol may be outdated post-2023 |
| Yahoo Finance | `^NSEI` (Nifty 50) | Real | Fetched independently from Gift Nifty |
| Yahoo Finance | `^INDIAVIX` (VIX) | Real | |
| BSE API | SENSEX | Real | |
| Option Chain route | prevClose (from Yahoo) | Real | |

---

## 5. Critical Bugs Found

### CRITICAL BUG #1: `backtest-engine.ts:589,609`
**Gift Nifty = `candles[0]?.close`** (opening candle of backtest day) instead of actual Gift Nifty data. This completely invalidates the Gift Nifty bias in every breakout backtest ever run.

### CRITICAL BUG #2: `agent-brain.ts:59,633`
References **`giftNifty.gap`** which does not exist in the gift-nifty API response. The API returns `price`, `change`, `changePct`, `previousClose` — but NOT `gap`. The agent LLM prompt always gets `undefined` for gap.

### CRITICAL BUG #3: `gift-nifty/route.ts:22-31`
**Fraudulent fallback.** When Yahoo fails, returns `success: true` with `price = spotPrice, previousClose = spotPrice`. Gap = 0 always. Callers cannot distinguish real from fabricated.

---

## 6. Fabricated Values (No Data Backing)

| Value | Formula | File |
|---|---|---|
| `avgGapUp` | `20 + vix * 2.5` | GapAnalysis.tsx:91 |
| `avgGapDown` | `15 + vix * 2` | GapAnalysis.tsx:92 |
| `expectedGapPct` | Low=+0.8%, Med=+0.3%, High=-0.5% | btst-engine.ts:220 |
| Gap entry premium | `vix * 0.5 + 40` | GapAnalysis.tsx (setups) |
| Gift Nifty bias threshold | 0.3% | candlestick-breakout.ts:86 |
| Pivot range | Fixed 1.2% | GapAnalysis.tsx |

---

## 7. Current Prediction Formula (GapAnalysis.tsx:60-95)

```
Score = 50 (base)
       + PCR factor ±12
       + VIX factor ±3
       + OI buildup ±10
       + Max Pain distance ±5
       + Sentiment ±8
     clamped to [10, 90]

Up%     = score
Down%   = 100 - score - 10 (flat reserved 10%)
Flat%   = residual
```

**Issues:**
- Weights are arbitrary integers with no statistical basis
- PCR factor of ±12 dominates all other factors
- Flat is always the residual (10%), never independently scored
- No historical data used anywhere
- No validation has ever been performed

---

## 8. Duplicate Logic

| Concept | Implemented In | Formula |
|---|---|---|
| Gap risk scoring | `btst-engine.ts:213` | 5-factor heuristic (RSI/PCR/sector/VRM/change) |
| Gap prediction | `GapAnalysis.tsx:60` | 5-factor heuristic (PCR/VIX/OI/MaxPain/sentiment) |
| Gift Nifty bias | `candlestick-breakout.ts:86` | Gap% from Gift Nifty vs prev close |
| Gift Nifty data | `/api/gift-nifty/route.ts` | Yahoo fetch |
| Gap intent | `sdmChat.ts`, `agent-brain.ts` | Duplicate gap-related logic |

**Total: 5 separate gap implementations, 0 shared code, 0 data backing.**

---

## 9. Scoring Formulas (All Heuristics, None Backed By Data)

### GapAnalysis.tsx `predictGap()`
```
Score = BASE(50) + PCR(±12) + VIX(±3) + OI(±10) + MaxPain(±5) + Sentiment(±8)
Up = Score, Down = 100 - Score - 10, Flat = 10
```
- Weights: 50% PCR dominates
- No gap size prediction — only direction probabilities
- Clamped to [10,90]

### btst-engine.ts `gapRisk`
```
gapRisk = RSI>72(+2) + PCR>1.4(+1) + sector<5(+1) + vrm<1.0(+1) + change<-0.5%(+1)
Low=0, Medium=≤2, High=>
ExpectedGap: Low=+0.8%, Med=+0.3%, High=-0.5%
```

### candlestick-breakout.ts Gift Nifty Bias
```
gap% = (giftOpen - prevClose) / prevClose * 100
if gap > 0.3% → bullish bias (+10)
if gap < -0.3% → bearish bias (+10)
else → neutral
```

---

## 10. Missing Data

- **No historical gap database** — nowhere in the project is next-day gap data stored or analyzed
- **No gap distribution data** — mean, median, stddev of Nifty gaps unknown
- **No correlation analysis** — PCR/VIX/OI-to-gap correlation never measured
- **No real `SGXNIFTY.NS` symbol validity** — may be dead post-2023
- **No `gap` field in Gift Nifty API response** — consumer code tries to read it

---

## 11. Confidence Calculation (Current)

```
Confidence = abs(score - 50) * 2 (implicit in probability distance from 50%)
```

No safety cap. No historical accuracy check. 75% confidence is displayed freely even though the engine has never been validated.

---

## 12. Recommended Architecture for Rebuild

```
Historical Yahoo Data           Gift Nifty API         Option Chain API
        │                              │                      │
        ▼                              ▼                      ▼
  Historical Gap DB            Real-time Data            PCR/OI/VIX/MaxPain
  (computed gaps)              Collector                 Collector
        │                              │                      │
        └──────────────────────┬───────┴──────────────────────┘
                               │
                               ▼
                    Gap Engine (src/lib/gap-analysis/)
                    ┌─────────────────────────┐
                    │  12 Weighted Factors    │
                    │  - Gift Nifty           │
                    │  - Futures Premium      │
                    │  - PCR OI               │
                    │  - OI Buildup           │
                    │  - Max Pain Distance    │
                    │  - VWAP                 │
                    │  - ATR                  │
                    │  - VIX                  │
                    │  - Breadth              │
                    │  - Global Cues          │
                    │  - Expected Move (IV)   │
                    │  - Historical Gap Stats │
                    └─────────────────────────┘
                               │
                     ┌─────────┼─────────┐
                     ▼         ▼         ▼
               Prediction  Explain-   Confidence
               (Up/Flat/   ability    (capped by
                Down)      (factors)  hist accuracy)
                     │         │         │
                     └─────────┼─────────┘
                               │
                               ▼
                      Validation Framework
                      (250+ sessions)
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
                Auto-Calibrator    UI Dashboard
                (weight optimizer) (GapAnalysis.tsx)
```

---

## 13. Files to Create

| File | Purpose |
|---|---|
| `src/lib/gap-analysis/types.ts` | All interfaces (GapInput, GapOutput, GapFactor, etc.) |
| `src/lib/gap-analysis/gap-engine.ts` | Main prediction engine (12 weighted factors, scoring, explainability) |
| `src/lib/gap-analysis/data-collector.ts` | Historical gap data from Yahoo |
| `src/lib/gap-analysis/calibrator.ts` | Weight optimization via grid search |
| `src/lib/gap-analysis/validator.ts` | Historical validation framework |
| `tests/gap-engine.test.ts` | 300+ session validation tests |
| `validation/gap-validation.md` | Validation report |

## 14. Files to Modify

| File | Change |
|---|---|
| `src/app/api/gift-nifty/route.ts` | Remove fraudulent fallback; add `gap` field; return 503 on failure |
| `src/lib/agent-brain.ts:59,633` | Change `giftNifty.gap` to `giftNifty.price - giftNifty.previousClose` |
| `src/lib/backtest-engine.ts:589` | Fix Gift Nifty data source or remove bias call |
| `src/components/dashboard/GapAnalysis.tsx` | Replace with Institutional Gap Dashboard |
| `src/app/api/option-chain/route.ts` | Add `giftNifty` field to summary |
| `src/lib/btst-engine.ts` | Replace gap risk with engine call |

---

## 15. Risks

1. **Symbol dead**: `SGXNIFTY.NS` may no longer be accurate for Gift Nifty post-2023 transition
2. **Data gaps**: Historical data collection may be incomplete (Yahoo rate limits, missing days)
3. **Correlation weak**: PCR/VIX may have minimal correlation with gap direction — the engine must detect this and reduce confidence
4. **Overnight gap decoupling**: Global events between market close and next open may completely override any model
5. **Regime change**: Market gap behavior changes over time — model trained on 250 days may be stale after a regime shift

## 16. Rollback Plan

1. Keep existing `GapAnalysis.tsx` as `GapAnalysisLegacy.tsx`
2. Build new engine in `src/lib/gap-analysis/` (never imported by production code yet)
3. Run parallel validation: old vs new engine on same historical data
4. Only swap UI and API after: new engine accuracy > old engine accuracy AND all tests pass
5. If new engine fails: delete `src/lib/gap-analysis/`, restore legacy component import
