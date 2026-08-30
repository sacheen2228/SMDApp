# SMD Market Intelligence Upgrade — Implementation Plan

## Status: APPROVED — Implementation Phase

## Architecture Decision: INCREMENTAL UPGRADE
Build new components/APIs that consume existing engines. Never rebuild existing code.

---

## PHASE 1 — Normalized Market Data Layer ✅ ALREADY EXISTS
- `market/canonical.ts` — Canonical Market Snapshot (already normalizes data)
- `yahoo-finance-api.ts` — Yahoo Finance provider (batch quotes, charts)
- `nse-api.ts` — NSE provider (option chain, market status)
- `breeze-fno-data.ts` — Breeze provider (option chain, futures)
- `fii-dii.ts` — FII/DII data provider

**Action:** No new code needed. Existing providers already feed normalized data.

---

## PHASE 2 — Market Breadth API + Dashboard
**New files:**
- `src/app/api/market/breadth/route.ts` — Aggregates advance/decline from Yahoo batch quotes
- `src/components/dashboard/MarketBreadth.tsx` — Breadth dashboard card

**Data source:** Yahoo Finance batch quotes for NIFTY 50 stocks → calculate advance/decline, % above EMA, new highs/lows.

**Reuse:** `yahoo-finance-api.ts` `fetchBatchQuotes()`, `ml-engine.ts` EMA calculations.

---

## PHASE 3 — Sector Intelligence API + Dashboard
**New files:**
- `src/app/api/market/sectors/route.ts` — Sector performance + rotation
- `src/components/dashboard/SectorRotation.tsx` — Sector rotation UI

**Data source:** Yahoo Finance batch quotes for sector ETFs (NIFTY BANK, NIFTY IT, NIFTY AUTO, etc.) + sector mapping from `fo-universe.ts`.

**Reuse:** `fo-universe.ts` sector mapping, `yahoo-finance-api.ts`.

---

## PHASE 4 — NSE Equity Heatmap
**New files:**
- `src/app/api/market/heatmap/route.ts` — Heatmap data (stocks + sectors + metrics)
- `src/components/dashboard/MarketHeatmap.tsx` — Interactive treemap visualization

**Data source:** Yahoo Finance batch quotes for NIFTY 50/100/200 stocks + sector mapping.

**Reuse:** `fo-universe.ts` stock list, `yahoo-finance-api.ts` batch quotes, `ml-engine.ts` for indicators.

---

## PHASE 5 — Market Regime Dashboard
**New files:**
- `src/app/api/market/regime/route.ts` — Regime analysis endpoint
- `src/components/dashboard/MarketRegimePanel.tsx` — Standalone regime display

**Data source:** Existing `regime-classifier.ts` + `index-comparison.ts` data.

**Reuse:** `regime-classifier.ts` `classifyMarketRegime()`, `index-comparison.ts` `analyzeAllIndices()`.

---

## PHASE 6 — Unified Trade Opportunity Engine
**New files:**
- `src/lib/trade-opportunity-engine.ts` — Aggregates all signals into ranked opportunities
- `src/app/api/market/opportunities/route.ts` — Best trades endpoint
- `src/components/dashboard/BestTradesNow.tsx` — Top 5 trade cards

**Data source:** Combines scanner results + SDM scores + sector strength + volume + F&O.

**Reuse:** `sdm-recommendation.ts`, `intraday-scanner.ts`, `weekly-equity-scanner.ts`, `smc-engine.ts`.

---

## PHASE 7 — In-App Alert Center
**New files:**
- `src/components/dashboard/AlertCenter.tsx` — Alert notification panel
- Modify `sendIntradayAlerts.ts` to also store alerts in memory for in-app display

**Reuse:** Existing alert generation engines.

---

## PHASE 8 — Unified Stock Analysis Page
**New files:**
- `src/app/api/stocks/[symbol]/route.ts` — Stock deep dive endpoint
- `src/components/dashboard/StockAnalysisDrawer.tsx` — Slide-out analysis panel

**Data source:** Combines equity-cash + F&O + technicals + CAS for a single stock.

**Reuse:** `equity-cash-engine.ts`, `fno-engine.ts`, `ml-engine.ts`, `sdm-recommendation.ts`.

---

## PHASE 9 — CAS Analysis UI
**New files:**
- `src/app/api/market/cas/route.ts` — CAS analysis endpoint
- `src/components/dashboard/CASPanel.tsx` — Accumulation/distribution display

**Data source:** Volume profile + delivery data + institutional positioning.

**Reuse:** `volume-analysis.ts`, `institutional-positioning-engine.ts`.

---

## PHASE 10 — Main Dashboard Integration
**Modify:** `src/app/page.tsx` — Add new tabs/sections for:
- Market Intelligence overview (regime + breadth + sectors)
- Heatmap tab
- Best Trades Now section
- Alert center

---

## Development Order (aligned with user's STEP 1-20):
1. ~~Audit existing application~~ ✅ DONE
2. Create normalized market-data layer ✅ ALREADY EXISTS
3. Integrate existing technical engine ✅ ALREADY EXISTS
4. Integrate existing CAS engine ✅ ALREADY EXISTS  
5. Integrate existing F&O engine ✅ ALREADY EXISTS
6. **Create market breadth** → PHASE 2
7. **Create sector intelligence** → PHASE 3
8. **Create heatmap** → PHASE 4
9. **Create stock intelligence page** → PHASE 8
10. **Create Trade Opportunity Engine** → PHASE 6
11. **Create Trade Score** → PHASE 6 (unified)
12. **Create entry/SL/target engine** → ALREADY EXISTS
13. **Create position sizing** → ALREADY EXISTS
14. **Create Best Trades Now** → PHASE 6
15. **Create alerts** → PHASE 7
16. **Create trade journal** → ALREADY EXISTS
17. **Create backtesting architecture** → ALREADY EXISTS
18. **Optimize performance** → Caching + batch
19. **Run tests** → Manual verification
20. **Final UI/UX polish** → PHASE 10

## Key Constraints
- All data from real APIs (Yahoo Finance, Breeze, NSE)
- Never fabricate market data
- Show DATA UNAVAILABLE when sources fail
- Reuse existing engines — no duplication
- Mobile responsive
- Works on Render free tier (512MB)
