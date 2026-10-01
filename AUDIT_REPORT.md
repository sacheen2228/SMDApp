# SMDApp TRADE ENGINE AUDIT

## 1. Executive Summary

The SMDApp is a large Indian F&O trading platform built on Next.js 16 with App Router, running on port 3000. It has 28 active trade generation paths, 7+ scoring engines, 14+ duplicate PCR implementations, and 170+ total TypeScript files in the trading system. The system is built to be a comprehensive trading analysis platform, NOT an automated execution system — all trade alerts are advisory (Telegram notifications). No live orders are placed.

The TradeEngines directory at /home/sachin/Desktop/TradeEngines/ is a 100% mirror of SMDApp/src/lib/ — all 122 files are duplicates with zero active imports. It can be safely deleted.

CRITICAL FINDINGS:
- 25 confirmed deprecated files can be safely deleted (12 in zero-hero-ai + 12 in TradeEngines/deprecated + 1 orphaned engines/ai directory)
- CAS straddle strategy generates premium-selling signals (STRADDLE/STRANGLE) with no runtime rejection — violates CE/PE BUY ONLY rule
- SDM recommendation silently flips BUY_CE→SELL_PUT during theta window on expiry day (caught by trade tracker but still displayed)
- 7 separate scoring engines with contradictory thresholds — no single source of truth for confidence
- Multiple engines can generate duplicate Telegram alerts for the same trade
- Morning signal generator does NOT register trades or check active trade locks
- Master Bot sends Telegram but has zero trade lifecycle tracking

## 2. Total Files
- **SMDApp integrated files**: ~170 (src/lib + src/app/api)
- **TradeEngines duplicates**: 122 (all mirrored from SMDApp, zero active imports)
- **Deprecated (truly unused)**: 25 confirmed (12 zero-hero-ai + 12 TradeEngines/deprecated + 1 engines/ai)
- **Orphaned engines**: 29 files in src/engines/ (all dead code — ai-engine.ts is top, nothing imports it)
- **Python scripts**: 5 (standalone, 1 actively imported via /api/screener)
- **Total unique codebase**: ~220 files (170 active + 50 deletable)

## 3. Primary Trade Generators

28 active trade generation paths identified:

| ID | File | Function | Strategy | Telegram? | Trade Registration? |
|----|------|----------|----------|-----------|---------------------|
| TGP-01 | sdm-recommendation.ts | generateSDMRecommendation() | SDM V2 (10 modules) | YES | NO |
| TGP-02 | zero-hero.ts | analyzeZeroHeroChain() | Expiry + BTST | YES (via audit) | YES (via audit) |
| TGP-03 | hermes/agent.ts | hermesPro() | Hermes Pro deterministic | YES | NO |
| TGP-04 | hermes/paper-engine.ts | evaluatePaperCandidate() | Paper trading | YES (paper) | YES (paper) |
| TGP-05 | morningSignalGenerator.ts | generateMorningSignals() | Morning scan (all) | YES | NO |
| TGP-06 | btst-scanner.ts | runBTSTScan() | BTST equity | YES | YES |
| TGP-07 | intraday-scanner.ts | runIntradayScan() | Intraday equity | YES | YES |
| TGP-08 | sendIntradayAlerts.ts | runIntradayAlertCycle() | SDM V2 (via API) | YES | YES |
| TGP-09 | signal-engine.ts | generateSignal() | Rule-based options | NO (internal) | NO |
| TGP-10 | mtf-signal-engine.ts | generateMTFSignal() | Multi-timeframe | NO (internal) | NO |
| TGP-11 | buyer-confluence-engine.ts | scoreBuyerConfluence() | Buyer scoring | NO (internal) | NO |
| TGP-12 | cas-straddle-strategy-v2.ts | evaluateCAS() | CAS straddle/strangle | YES | NO |
| TGP-13 | daily-derivatives-recommendation.ts | generate() | IDE derivatives | YES | NO |
| TGP-14 | tradeAlertEngine.ts | generateTradeAlert() | Give me a trade | YES | NO |
| TGP-15 | challenge/challenge-engine.ts | scanChallenge() | 15K→1L | YES | YES |
| TGP-16 | smc-engine.ts | runSMCAnalysis() | Smart Money Concepts | NO (internal) | NO |
| TGP-17 | unified-scoring-engine.ts | scoreSetup() | Unified 5-profile | NO (internal) | NO |
| TGP-18 | option-acceleration-engine.ts | runAccelerationEngine() | 10 sub-engines | NO (UI only) | NO |
| TGP-19 | backtest-engine.ts | runMultiDayBacktest() | Breakout backtest | NO | NO |
| TGP-20 | master-bot-engine.ts | generateMasterBotTrades() | Correlation | YES | NO |
| TGP-21 | weekly-equity-scanner.ts | runWeeklyEquityScan() | Weekly swing | YES | NO |
| TGP-22 | fno-engine.ts | analyzeIndexFO() | Index F&O | NO (internal) | NO |
| TGP-23 | trade-intelligence/stock-fo-mode.ts | analyzeStockFO() | Stock F&O | NO (internal) | NO |
| TGP-24 | trade-intelligence/index-fo-mode.ts | analyzeIndexFO() | Index F&O (TI) | NO (internal) | NO |
| TGP-25 | trade-intelligence/equity-swing-mode.ts | analyzeEquitySwing() | Equity swing | NO (internal) | NO |
| TGP-26 | agent-brain.ts | executeTool() | Agent-driven | YES | NO |
| TGP-27 | option-buyer-alerts.ts | monitorTrades() | TP/SL monitoring | YES | NO |
| TGP-28 | mcx/intelligence route | MCX intelligence | MCX commodities | YES | NO |

## 4. Complete Trade Flow

```
DATA COLLECTION (MOAPI → Breeze → NSE → BSE → Yahoo)
    ↓
DATA NORMALIZATION (option-chain-normalizer, data-health, data-validation)
    ↓
ANALYSIS (7+ scoring engines in parallel)
    ↓
SIGNAL (BUY_CE / BUY_PE / WAIT / NO_TRADE)
    ↓
CANDIDATE (entry, SL, TP1/TP2/TP3, strike, confidence, grade)
    ↓
VALIDATION (trade-validator-gate, hermes/trade-validator, signal-conflict-detector)
    ↓
RISK (risk-management.ts — position sizing, drawdown limits)
    ↓
LOCK (active-trade-lock.ts — one trade per underlying)
    ↓
TRADE (activeTradeTracker.addTrade() → Prisma DB + Trade Audit sidecar)
    ↓
MONITOR (tiger-monitor.ts — SL/TP detection, trailing SL)
    ↓
TELEGRAM (telegram.ts — dedup + throttle + formatted alerts)
```

## 5. Cron Map

No internal Node cron exists. All scheduling is external (systemd timers or manual):

| Time (IST) | Job | Function | Strategies | Telegram |
|------------|-----|----------|------------|----------|
| 09:10 | Morning digest | runMorningSignalFlow() | Index F&O + Stock F&O + Equity Swing + MCX | YES |
| Every 15m | Intraday scan | sendIntradayAlerts() | SDM V2 (all indices) + Stock scanner | YES |
| 15:15 | BTST scan | runBTSTScan() → POST /api/btst?alert=1 | BTST equity | YES |
| 15:25 | Daily digest | sendDailyDigest() | All signals today | YES |
| 16:30 | Institutional | institutional-positioning update | FII/DII positioning | NO |

## 6. API Trade Paths

| Endpoint | Strategy | Telegram? | Trade Registration? |
|----------|----------|-----------|---------------------|
| /api/option-chain | SDM V1 analysis | YES (auto) | YES (activeTradeTracker) |
| /api/sdm-signal | SDM V2 engine | YES (auto) | NO |
| /api/btst | BTST 6-factor | YES (if ?alert=1) | YES |
| /api/master-bot | Correlation | YES (auto) | NO |
| /api/agent | Hermes/LLM | YES (if BUY) | NO |
| /api/greek-flow | Option acceleration | NO | NO |
| /api/institutional-greeks | Option acceleration | NO | NO |
| /api/cas-straddle | CAS straddle | YES (via panel) | NO |
| /api/scanner | Intraday scanner | NO | YES (audit) |
| /api/weekly-scanner | Weekly equity | YES | NO |
| /api/morning-signals | Morning scan | YES | NO |
| /api/intraday-scan | Intraday alerts | YES | YES |

## 7. SDM Architecture

**SDM V2 (sdm-recommendation.ts — 1821 lines):**
1. evaluateDataHealth → DataHealthReport
2. calculateGEX → GEXResult (dealer regime, gamma walls)
3. analyzeMarketStructure → MarketStructure (trend, S/R)
4. analyzeMultiTimeframe → ConsensusResult (direction consensus)
5. analyzeVolume → VolumeAnalysis (VWAP, absorption)
6. analyzeOptionChain → OIAnalysis (PCR, max pain, fresh writing)
7. findSellerSLLevels → SellerSLResult (CE/PE seller SL zones)
8. computeQualityScore → QualityScore (grade A+/A/B/C/D)
9. determineSmartEntry → SmartEntryResult
10. validateTrade → validation gate

**Plus:** Institutional positioning, Buyer confluence (Section 7), MTF confirmation

**Confidence:** qualityScore * 0.6 + dirConfidence * 0.4 (adjusted for session)

**Telegram auto-send:** action ≠ HOLD/NEUTRAL/WAIT/NO_TRADE + confidence ≥ 60 + source ≠ simulation

**SDM V1 (sdm-engine.ts — used by /api/option-chain):**
10 scoring functions: PCR, OI Concentration, Max Pain, IV Skew, Gamma/Theta, Delta, Volume, VIX, Smart Entry/Exit, Composite Score

## 8. Zero Hero Architecture

**Active:** `src/lib/zero-hero.ts` (638 lines) — consolidated engine
- Imported by: ZeroHeroTerminal.tsx
- Modes: 'expiry' (weekly/monthly F&O) and 'btst' (buy-today-sell-tomorrow)
- Features: gamma blast detection, volume/spread checks, premium metrics
- Default disabled (config.enabled = false)

**Deprecated:** `src/lib/zero-hero-ai/` (12 files) — all orphaned, zero imports, safely deletable

**Overlap with Option Acceleration:** Complementary (not overlapping). Option Acceleration predicts WHICH premium moves. Zero Hero decides IF a trade is viable.

## 9. Hermes Architecture

**Entry:** hermesPro() in src/lib/hermes/agent.ts
**Pipeline:**
1. detectIntent → detectSymbol → detectDirection
2. collectHermesContext → parallel data fetch (30+ fields)
3. interpretRegime → analyzeOIIntelligence → analyzeGammaIntelligence → analyzeFlowIntelligence
4. evaluateNoTrade → rejection check
5. runQualityGates → data quality
6. scoreWithUnifiedEngine (CE + PE separately)
7. detectAndResolveConflicts → CE vs PE conflict resolution
8. getTradeGrade → selectOptimalStrikes → compareCEvsPE
9. validateTrade → final validation
10. generateExplanation → human-readable output
11. sendTradeAlert (if BUY)

**41 Tools:** Market data (7), OI & Greeks (3), Flow & Intelligence (5), Scanners (6), Risk & Portfolio (4), Trade & Journal (4), Memory (3), System (2), NEW: send_telegram_signal, scan_all_instruments, get_mcx_data, morning_scan, get_trade_recommendation

**Paper Trading:** paper-engine.ts + paper-worker.ts (singleton background, 30s evaluation, 5s monitoring)

**Telegram:** telegram-queue.ts (priority queue, dedup, retry with exponential backoff)

**NO single source of truth** — Hermes uses hermes/scoring-engine.ts (11 factors, weighted) but ALSO calls unified-scoring-engine.ts through unified-scoring-bridge.ts

## 10. Option Acceleration Architecture

**Engine:** option-acceleration-engine.ts (970 lines)
**10 Sub-Engines:**
1. Delta Acceleration — delta*spotMove + gamma*spotMove²
2. Gamma Explosion — gamma efficiency * expiry boost
3. OI Absorption — OI change + price change classification
4. Volume Momentum — relative volume, spike, participation
5. Institutional Flow — large blocks, dealer hedging, OI walls
6. Premium Elasticity — expected premium for 10/20/30 pt move
7. Historical Memory — avg/median/p95 premium move, hit rate
8. Time Decay — session phase, theta drag
9. Regime — Gamma Pin/Vol Expansion/Breakout/Reversal/Range/Trend
10. Premium Velocity — weighted blend of all

**Weighting:** delta*0.20 + gamma*0.15 + oi*0.20 + volume*0.15 + institutional*0.10 + historical*0.10 + regime*0.05 + liquidity*0.05

**TP Projection:** ATR-based + delta/gamma model + historical blend

**Status:** RESEARCH ONLY — no Telegram, no trade registration. UI visualization only.

## 11. BTST Architecture

**Scanner:** btst-scanner.ts (458 lines) — reuses intraday-scanner's Yahoo Finance data
**Engine:** btst-engine.ts — 6-factor scoring:
1. Trend (25 pts): EMA alignment, MACD, RSI
2. Smart Money (20 pts): institutional positioning
3. OI (20 pts): OI change %, PCR, IV
4. Volume (15 pts): relative volume, delivery %
5. Sector (10 pts): sector strength
6. Breadth (10 pts): sector breadth

**Grades:** A+ (≥80), A (≥65), B (≥50), C (≥35), SKIP
**Data:** Yahoo Finance (real candles), Breeze (spot price)
**Risk:** Separate from intraday — uses ATR-based SL (1.5x ATR)
**Telegram:** Only via explicit POST /api/btst?alert=1
**Trade Registration:** YES — validateCandidateTrade → acquireTradeLock → recordSignal → createTrade

## 12. Master Bot Architecture

**Engine:** master-bot-engine.ts — NIFTY-SENSEX correlation trading
**Data:** Yahoo Finance (daily/hourly/15m/5m/3m candles for both indices)
**Strategies:**
1. Correlation Breakdown (corr5 < 0.94) → mean reversion
2. Gap Fade (daily/1h only) → fade gaps > 0.5%
3. EMA Bounce → bounce off EMA20

**Scoring:** Categorical only (HIGH/MEDIUM confidence), no numeric score
**SL/TP:** SL = premium * 0.65, TP = premium + R:R * (premium - SL)
**Telegram:** YES — sends formatted trade plan
**Trade Registration:** NONE — no addTrade, no recordSignal, no lifecycle tracking

## 13. CAS Architecture

**Files:**
- cas-straddle-strategy-v2.ts (840 lines) — STRATEGY ENGINE
- cas-straddle-backtest-v2.ts — BACKTEST
- cas-time-engine.ts (1236 lines) — TIME WINDOWS
- cas-reference-engine.ts — VWAP reference (in expiry-liquidity/)
- cas-dislocation-engine.ts — price vs reference (in expiry-liquidity/)
- api/cas-straddle/route.ts — API endpoint
- CASPanel.tsx, CASStraddleTab.tsx — UI

**CRITICAL: CAS IS A PREMIUM SELLING STRATEGY.**
- StrategyType includes "STRADDLE" | "STRANGLE"
- Line 508: "Ranging + IV > 18 → STRADDLE (sell premium)"
- Full backtest support for selling strategies
- NO equivalent runtime rejection for CAS selling signals (unlike sdm-trade-tracker for SELL_CALL/SELL_PUT)
- This violates the CE/PE BUY ONLY production restriction

## 14. MCX Architecture

**Files:** src/lib/mcx/ (15 files) — scanner, intelligence, scorer, regime, structure, volatility, volume-oi, option-intel, session, types, market-data, instrument-master, nse-commodity-scraper, bhaavbrief, option-chain

**Instruments:** CRUDEOIL, GOLD, SILVER, NATURALGAS
**Data Source:** Yahoo Finance (primary), NSE commodity scraper (secondary)
**Scoring:** Unified scoring engine with MCX_COMMODITY profile
**Telegram:** YES (via MCX intelligence API)
**Risk:** Uses unified-scoring-engine's risk profile
**No NSE/BSE logic incorrectly used** — MCX uses its own Yahoo Finance data path

## 15. Data Source Map

| Source | Primary Use | Reliability |
|--------|-------------|-------------|
| Motilal Oswal API (MOAPI) | Option chain (preferred) | 0.90 |
| ICICI Breeze | Option chain + historical | 0.95 |
| NSE India | Option chain + market status | 0.85 |
| BSE India | SENSEX/BANKEX option chain | 0.80 |
| Yahoo Finance | Stock prices, VIX, candles | 0.60 (research) |
| MrChartist | FII/DII 60-day history | 0.65 (delayed) |
| NSE Commodity | MCX data | 0.85 |
| RSS Feeds | News sentiment | 0.50 |

**Fallback chain (option chain):** MOAPI → Breeze → NSE → BSE → 503 UNAVAILABLE

## 16. Data Normalization

| File | Purpose |
|------|---------|
| option-chain-normalizer.ts | Canonical option chain format |
| data-health.ts | Quality scoring (latency, strikes, Greeks) |
| data-validation.ts | Pre-trade validation gates |
| api-freshness.ts | Provider reliability scoring |
| smd-context.ts | Centralized market context builder |
| market-data-manager.ts | Caching + provider health |

**NO single normalizer used by all engines** — each engine normalizes data differently.

## 17. Scoring Engines

| Engine | Factors | Max Score | Grade System |
|--------|---------|-----------|--------------|
| SDM V1 (sdm-engine.ts) | 10 functions | 0-100 | None (raw score) |
| SDM Quality (sdm-scores.ts) | 14 weighted factors | 0-100 | A+(≥90)/A(≥80)/B(≥65)/C(≥50)/D(<50) |
| Unified Scoring | 13 factors, 5 profiles | 0-100 | Profile-specific |
| Signal Engine | 5 factors (OI:30,Delta:25,PCR:20,IV:15,NEWS:10) | 0-100 | None |
| Buyer Confluence | 15+ factors | 0-100 | None |
| Hermes Scoring | 11 factors | 0-100 | A+/A/B/C/D (same thresholds) |
| BTST Engine | 6 factors | 0-100 | A+/A/B/C/SKIP |
| Option Acceleration | 10 sub-engines, 8 weighted | 0-100 | STRONG BUY/BUY/WATCH/WAIT/IGNORE |

**Contradictions:**
- 80 = "strong" in Signal Engine, "A" in SDM Quality, "medium" in some Unified profiles
- VIX thresholds differ: >25 EXTREME in zero-hero-ai, different in sdm-engine, different in option-acceleration
- 14 different PCR implementations with different strike ranges and thresholds

## 18. Risk Engines

**No single authoritative risk engine exists.**

| Engine | Position Sizing | SL | TP | Limits |
|--------|-----------------|----|----|--------|
| risk-management.ts | Capital * riskPct / premium | Entry - ATR*1.5 | Entry + R:R * risk | Daily/weekly/monthly loss |
| capital-manager.ts (Challenge) | 5% risk, max 50% position | ATR-based | R:R 1:2-1:4 | 5%/10%/20% drawdown |
| hermes/trade-validator.ts | Hermes-specific | Hermes-specific | Hermes-specific | 15-step validation |
| trade-validator-gate.ts | Canonical gate | — | — | Final validation for ALL paths |
| btst-engine.ts | Separate ATR | 1.5x ATR | R:R-based | Grade-based sizing |
| sdm-recommendation.ts | Built-in | entry - min(25%,1.5*ATR) | 1.5R/2.5R/4R | Session-adjusted confidence |

## 19. Active Trade Lock

**Lock file:** active-trade-lock.ts — one trade per underlying (in-memory + DB)
**Tracker:** activeTradeTracker.ts — SL/TP monitoring, Prisma persistence
**Monitor:** tiger-monitor.ts — background LTP polling + Telegram

**Who acquires:** sendIntradayAlerts, btst-scanner, option-chain route, challenge auto-executor
**Who releases:** closeTrade() on SL/TP hit, manual close
**When releases:** SL/TP hit detection (every 15 min via checkSLTP), or manual close

**BYPASSES FOUND:**
1. morningSignalGenerator.ts — does NOT check active trade lock (signals only, no trade registration)
2. master-bot-engine.ts — does NOT register trades at all
3. hermes/agent.ts — does NOT call addTrade() (advisory only)
4. sdm-signal route — does NOT register trades (only sends Telegram)
5. cas-straddle route — does NOT register trades

## 20. Telegram Paths

7 distinct Telegram sending functions identified:

| File | Function | Trigger | Message Type | Dedup Method |
|------|----------|---------|--------------|--------------|
| telegram.ts | sendTelegramMessage() | All sends | HTML | signalTracker + throttle |
| telegram.ts | sendTradeAlert() | Trade alerts | HTML | Full-day dedup + 5min throttle |
| telegramSend.ts | sendTelegramMessage() | Cron/digest | Markdown | IST window gate |
| telegram-bot.ts | Interactive bot | User commands | Various | Bot dedup |
| hermes/telegram-queue.ts | Priority queue | Hermes | HTML | Queue dedup + retry |
| hermes/paper-telegram.ts | Paper trades | Paper worker | HTML | Via queue |
| option-buyer-alerts.ts | TP/SL monitoring | Price check | HTML | Direct send |

**Risk of duplicate Telegram alerts:**
- /api/option-chain and /api/sdm-signal can both fire for same symbol+strike+direction
- Dedup layers: sendTradeAlert() full-day dedup + short-term throttle + activeTradeTracker check
- GAP: If V1 confidence (option-chain) > V2 confidence (sdm-signal), duplicate will fire

## 21. Paper Trading

**Files:** hermes/paper-engine.ts, hermes/paper-worker.ts, hermes/paper-telegram.ts, hermes/paper-performance.ts

**How it works:**
- Singleton background worker running in Next.js process
- Evaluates signals every 30s via Hermes Pro engine
- Simulated execution (no real orders)
- Paper trade alerts via Telegram (routed through telegram-queue)
- Performance tracking in Prisma DB

**Separation from live:** Paper trades are tagged with `source: "paper"` and stored separately. They cannot affect live trades or locks.

## 22. Backtesting

| Engine | File | Data Source | Purpose |
|--------|------|-------------|---------|
| Breakout Backtest | backtest-engine.ts | Breeze historical | Multi-day breakout strategy |
| Trade Backtest | trade-backtest-engine.ts | Yahoo Finance | Real trades vs historical |
| CAS Backtest | cas-straddle-backtest-v2.ts | Yahoo Finance | CAS straddle/strangle |
| SDM Backtest | sdm-backtest.ts | Yahoo Finance | SDM signals |
| Trade Audit | trade-audit/ (sidecar) | Prisma DB | Verification engine |

## 23. Duplicate Engines

| Concept | # Implementations | Severity |
|---------|-------------------|----------|
| PCR calculation | 14 | HIGH |
| VWAP calculation | 10+ | HIGH |
| ATR calculation | 10+ | HIGH |
| Gamma/GEX | 5+ | MEDIUM |
| Support/Resistance | 4+ | MEDIUM |
| Market Regime | 5+ | HIGH |
| Confidence scoring | 7+ | HIGH |
| Strike selection | 4+ | MEDIUM |
| SL calculation | 5+ | HIGH |
| TP calculation | 5+ | MEDIUM |
| Position sizing | 3+ | MEDIUM |
| FII/DII analysis | 3+ | LOW |

## 24. Conflicting Engines

**CE vs PE conflict:**
- signal-conflict-detector.ts handles this for Hermes path
- Other paths have NO conflict resolution
- morningSignalGenerator: scans both CE and PE independently, sends both
- sendIntradayAlerts: scans both CALL and PUT for each symbol

**Confidence contradictions:**
- Hermes: 70 = good
- SDM: 60 = tradeable
- BTST: 80 = A+ (strong)
- Signal Engine: 80 = high confidence
- No unified threshold across engines

**VIX contradictions:**
- zero-hero-ai: >25 = EXTREME, >18 = HIGH, >12 = NORMAL
- sdm-engine: different thresholds
- option-acceleration: different thresholds
- A VIX of 20 = "HIGH" in one engine, "NORMAL" in another

## 25. Option Selling Risk Audit

**PRODUCTION PATHS THAT GENERATE SELL DIRECTIONS:**

1. **CRITICAL:** sdm-recommendation.ts line 1502-1504:
   ```
   if (isExpiryDay && currentWindow === 'theta' && direction !== 'WAIT') {
       direction = direction === 'CALL' ? 'SELL_PUT' : 'SELL_CALL';
   }
   ```
   Flips BUY to SELL during theta window on expiry day.
   **CAUGHT BY:** sdm-trade-tracker.ts line 107-111 (rejects at trade recording)
   **NOT CAUGHT BY:** UI display (still shows SELL in UI)

2. **CRITICAL:** cas-straddle-strategy-v2.ts — STRADDLE/STRANGLE are premium-selling strategies
   - No equivalent runtime rejection
   - Signal goes to UI without filtering
   - Backtests support selling

**SAFE PATHS (never produce SELL):**
- signal-engine.ts: Explicit BUY_CE/BUY_PE only
- buyer-confluence-engine.ts: Explicit CE/PE buying only
- zero-hero.ts: Explicit CALL/PUT only
- option-acceleration-engine.ts: BUY/STRONG BUY/WATCH/WAIT/IGNORE only
- btst-engine.ts: BULLISH/BEARISH only (equity, no options)

## 26. Duplicate Trade Risk

**Possible duplicate alert paths:**
1. /api/option-chain (SDM V1) + /api/sdm-signal (SDM V2) — same symbol, different engines
2. morningSignalGenerator + sendIntradayAlerts — morning signal + intraday scan overlap
3. Hermes Pro + SDM V2 — both can fire for same symbol
4. BTST scanner + intraday scanner — shared underlying data

**Mitigation layers:**
- signalTracker full-day dedup
- sendTradeAlert short-term throttle (5 min)
- activeTradeTracker.hasActiveTrade() check
- trade-validator-gate canonical validation

**GAPS:**
- morningSignalGenerator does NOT check hasActiveTrade()
- sdm-signal does NOT check hasActiveTrade()
- No cross-engine dedup (SDM V1 vs V2 vs Hermes)

## 27. Data Quality Problems

1. **MOAPI not always available** — auto-login sometimes fails, falls to Breeze
2. **Breeze session can expire** — circuit breaker via providerHealth
3. **NSE API rate limiting** — scraped HTML, can be blocked
4. **Yahoo Finance delayed** — 15-20 min delay, marked as "research only"
5. **VIX hardcoded fallback** — 15 when live unavailable
6. **Stale option chain data** — 4440 minutes (3 days) accepted in some paths
7. **No holiday calendar** — market hours check only considers weekday, not NSE holidays
8. **Gift Nifty proxy** — uses ^NSEI (NIFTY 50) instead of actual SGX ticker

## 28. Critical Bugs

| ID | Severity | File | Problem | Impact |
|----|----------|------|---------|--------|
| BUG-01 | CRITICAL | cas-straddle-strategy-v2.ts | Generates STRADDLE/STRANGLE (selling) with no runtime rejection | Violates CE/PE BUY ONLY rule |
| BUG-02 | CRITICAL | sdm-recommendation.ts | Silently flips BUY→SELL during theta window | Produces prohibited trade direction |
| BUG-03 | HIGH | morningSignalGenerator.ts | No trade registration, no active trade lock check | Can suggest duplicate trades |
| BUG-04 | HIGH | master-bot-engine.ts | Sends Telegram but zero trade lifecycle tracking | Advisory only, no SL/TP monitoring |
| BUG-05 | HIGH | /api/option-chain | Uses SDM V1 while /api/sdm-signal uses V2 | Conflicting analysis on same data |
| BUG-06 | HIGH | 14 PCR implementations | Different strike ranges, thresholds, formulas | Inconsistent PCR values across engines |
| BUG-07 | MEDIUM | No single confidence threshold | 60 (SDM), 70 (morning), 80 (BTST), etc. | Inconsistent trade quality assessment |
| BUG-08 | MEDIUM | hermes/agent.ts | Does NOT register trades in activeTradeTracker | Advisory only, no lifecycle tracking |
| BUG-09 | LOW | VIX thresholds contradictory | 5+ files with different VIX level meanings | Different regime classification per engine |

## 29. HIGH Priority Problems

1. CAS straddle/strangle selling strategy has no runtime rejection
2. SDM recommendation silently produces SELL directions
3. Morning signal generator lacks trade registration and active trade lock
4. 7+ scoring engines with no unified arbitration
5. No cross-engine trade dedup (SDM V1 vs V2 vs Hermes)
6. 14 PCR implementations with different thresholds
7. No single source of truth for confidence/scoring
8. Master Bot has no trade lifecycle tracking
9. /api/option-chain uses V1 engine while /api/sdm-signal uses V2 — conflicting analysis

## 30. MEDIUM Priority Problems

1. VIX thresholds contradictory across 5+ files
2. ATR calculated differently in 10+ places
3. VWAP calculated differently in 10+ places
4. No holiday calendar for NSE
5. TradeEngines directory is 100% duplicate (122 files, zero imports)
6. src/engines/ directory is 100% orphaned (29 files, zero imports)
7. 12 deprecated zero-hero-ai files still on disk
8. Option-chain-normalizer used only by one path (not standardized)
9. No unified position sizing across all engines

## 31. LOW Priority Problems

1. Gift Nifty uses NIFTY 50 as proxy (SGX ticker dead)
2. VIX hardcoded fallback = 15
3. Some stale data accepted (4440 min age)
4. Python scripts mostly standalone (1 actively used)
5. CoinDCX integration exists but unused in trade flow
6. Market history sidecar (port 4002) not integrated into main flow
7. External AI trader adapter exists but not connected

## 32. Current Source of Truth

| Concept | Source of Truth | Competing Implementations |
|---------|-----------------|--------------------------|
| Market Price | NSE API (primary), Yahoo (fallback) | NSE, Yahoo, Moneycontrol, Breeze |
| Option Chain | MOAPI (primary), Breeze (fallback) | MOAPI, Breeze, NSE scraper, BSE |
| OI | Option chain provider | 14+ PCR implementations |
| Greeks | Black-Scholes calculation | Motilal (live), BS calc, option-acceleration |
| IV | Option chain provider | Multiple sources with different calculations |
| PCR | NO SINGLE SOURCE | 14 implementations with different thresholds |
| Confidence | NO SINGLE SOURCE | 7 scoring engines with different formulas |
| Strike | NO SINGLE SOURCE | 4+ strike selectors with different logic |
| Entry | NO SINGLE SOURCE | 5+ entry calculators |
| SL | NO SINGLE SOURCE | 5+ SL calculators |
| TP | NO SINGLE SOURCE | 5+ TP calculators |
| Trade Validation | trade-validator-gate.ts (canonical) | hermes/trade-validator, sdm validation |
| Active Trade | activeTradeTracker.ts | Multiple engines bypass it |
| Telegram | telegram.ts (canonical) | telegramSend.ts, hermes/telegram-queue |
| Trade Lifecycle | agents/signal-lifecycle.ts | Different engines use different models |

**VERDICT: NO SINGLE SOURCE OF TRUTH for scoring, confidence, SL, TP, strike selection, or risk management.**

## 33. Current Architecture Tree

```
DATA SOURCES
├── MOAPI (Motilal Oswal) → Option Chain
├── ICICI Breeze → Option Chain + Historical
├── NSE India → Option Chain + Market Status
├── BSE India → SENSEX/BANKEX
├── Yahoo Finance → Stock Prices + VIX + Candles
├── MrChartist → FII/DII History
├── RSS Feeds → News
└── NSE Commodity → MCX Data
    ↓
NORMALIZATION
├── option-chain-normalizer.ts
├── data-health.ts
├── data-validation.ts
├── api-freshness.ts
└── market-data-manager.ts
    ↓
ANALYSIS (7+ engines in parallel)
├── SDM V1 (sdm-engine.ts) → /api/option-chain
├── SDM V2 (sdm-recommendation.ts) → /api/sdm-signal
├── Unified Scoring (unified-scoring-engine.ts)
├── Signal Engine (signal-engine.ts)
├── Buyer Confluence (buyer-confluence-engine.ts)
├── Hermes Scoring (hermes/scoring-engine.ts)
├── BTST Engine (btst-engine.ts)
├── Option Acceleration (option-acceleration-engine.ts) [research only]
├── SMC Engine (smc-engine.ts)
├── CAS Strategy (cas-straddle-strategy-v2.ts) [SELLING!]
└── Trade Intelligence (index-fo, stock-fo, equity-swing)
    ↓
SIGNAL
├── BUY_CE / BUY_PE / WAIT / NO_TRADE
├── Grade: A+ / A / B / C / D
└── Confidence: 0-100
    ↓
CANDIDATE
├── Entry Price
├── Stop Loss
├── Target 1/2/3
├── Strike Selection
├── Position Size
└── Risk/Reward
    ↓
VALIDATION
├── trade-validator-gate.ts (canonical)
├── hermes/trade-validator.ts
├── signal-conflict-detector.ts
├── sdm-trade-tracker.ts (SELL rejection)
└── validation-gate.ts (SDM)
    ↓
RISK
├── risk-management.ts
├── capital-manager.ts (Challenge)
├── active-trade-lock.ts (one per underlying)
└── trade-validator-gate.ts (final gate)
    ↓
TRADE REGISTRATION
├── activeTradeTracker.ts → Prisma DB
├── trade-audit-client.ts → Audit sidecar (:4001)
├── agents/signal-lifecycle.ts
└── audit-recorders.ts
    ↓
MONITORING
├── tiger-monitor.ts → SL/TP detection
├── checkSLTP() → live price comparison
└── trailing SL (moves to breakeven after TP1)
    ↓
TELEGRAM
├── telegram.ts (HTML, dedup, trade alerts)
├── telegramSend.ts (Markdown, cron/digest)
├── hermes/telegram-queue.ts (priority, retry)
└── hermes/paper-telegram.ts (paper trades)
```

## 34. Recommended Target Architecture

```
SINGLE DATA NORMALIZER → SINGLE SCORING ENGINE → SINGLE TRADE CANDIDATE FORMAT
→ SINGLE VALIDATION GATE → SINGLE RISK ENGINE → SINGLE TRADE REGISTRATION
→ SINGLE TELEGRAM SENDER
```

Key changes needed:
1. Remove CAS selling strategy or add runtime rejection
2. Fix SDM recommendation SELL direction flip
3. Standardize confidence/scoring across all engines
4. Add morningSignalGenerator trade registration
5. Add active trade lock check to all trade paths
6. Consolidate 14 PCR implementations into 1
7. Consolidate 10+ ATR implementations into 1
8. Create unified SL/TP calculator
9. Add cross-engine trade dedup
10. Remove 160+ duplicate files (TradeEngines + zero-hero-ai + engines/ai)

## 35. Files That Should NOT Be Changed

- src/lib/telegram.ts (canonical Telegram sender)
- src/lib/activeTradeTracker.ts (canonical trade tracker)
- src/lib/active-trade-lock.ts (canonical trade lock)
- src/lib/trade-validator-gate.ts (canonical validation)
- src/lib/signalTracker.ts (canonical dedup)
- src/lib/marketHours.ts (canonical market hours)
- src/lib/expiry-calculator.ts (canonical expiry)
- src/lib/hermes/agent.ts (Hermes orchestrator — extend, don't replace)
- src/lib/hermes/scoring-engine.ts (Hermes scoring — extend, don't replace)
- src/lib/hermes/telegram-queue.ts (Telegram queue — extend, don't replace)
- src/lib/trade-audit-client.ts (audit sidecar client)
- trade-audit/ (standalone sidecar — do not modify)
- .env (environment variables)

## 36. Files That Need Fixing

| Priority | File | Issue | Fix |
|----------|------|-------|-----|
| CRITICAL | cas-straddle-strategy-v2.ts | Generates selling signals | Add runtime rejection or remove selling |
| CRITICAL | sdm-recommendation.ts | SELL direction flip | Remove theta window SELL logic |
| HIGH | morningSignalGenerator.ts | No trade registration | Add addTrade + acquireTradeLock |
| HIGH | /api/option-chain | Uses SDM V1 | Upgrade to V2 or remove duplicate |
| HIGH | 14 PCR files | Duplicate implementations | Consolidate to 1 |
| HIGH | 10+ ATR files | Duplicate implementations | Consolidate to 1 |
| MEDIUM | master-bot-engine.ts | No trade lifecycle | Add trade registration |
| MEDIUM | hermes/agent.ts | Advisory only | Optionally add trade registration |
| MEDIUM | src/engines/ai/ | 29 orphaned files | Delete entire directory |
| LOW | TradeEngines/ | 122 duplicate files | Delete entire directory |
| LOW | zero-hero-ai/ | 12 deprecated files | Delete directory |

## 37. Recommended Fix Order

1. **Phase 1: Safety (Day 1)**
   - Add SELL rejection to CAS strategy (like sdm-trade-tracker)
   - Remove SELL direction flip from sdm-recommendation.ts
   - Add active trade lock to morningSignalGenerator
   - Add trade registration to morningSignalGenerator

2. **Phase 2: Dedup (Day 2-3)**
   - Consolidate 14 PCR implementations → 1
   - Consolidate 10+ ATR implementations → 1
   - Add cross-engine trade dedup
   - Remove /api/option-chain SDM V1 duplicate (upgrade to V2)

3. **Phase 3: Cleanup (Day 4-5)**
   - Delete TradeEngines/ directory (122 files)
   - Delete zero-hero-ai/ directory (12 files)
   - Delete src/engines/ai/ directory (29 files)
   - Delete greek-flow-engine.ts (deprecated)

4. **Phase 4: Architecture (Week 2)**
   - Create unified scoring interface
   - Create unified SL/TP calculator
   - Create unified position sizer
   - Standardize confidence threshold (60 for all)
   - Add trade lifecycle to master-bot and Hermes

## 38. Pre-Multi-Agent Readiness Score

| Category | Score (1-10) | Notes |
|----------|-------------|-------|
| Data Quality | 6 | MOAPI/Breeze/NSE fallback works but 14 PCR impls |
| Signal Logic | 5 | 7 scoring engines with contradictory thresholds |
| Trade Validation | 7 | trade-validator-gate.ts is solid canonical gate |
| Risk Management | 5 | 5+ different SL/TP calculators, no unified risk |
| Duplicate Prevention | 6 | signalTracker + throttle work but cross-engine gaps |
| Trade Lifecycle | 4 | Many paths bypass lifecycle (morning, master-bot, hermes) |
| Telegram | 8 | 3-layer dedup, retry, queue — well-designed |
| Paper Trading | 7 | Separate from live, properly isolated |
| Architecture | 3 | 7 scoring engines, 14 PCR impls, no single source of truth |
| Test Coverage | 7 | 403 tests passing, good coverage |

**Overall Readiness: 5.8/10**

## 39. FINAL VERDICT

**NOT READY FOR MULTI-AGENT**

Reasons:
1. **No single source of truth** for scoring, confidence, SL, TP, or strike selection — adding more agents would multiply the confusion
2. **7 scoring engines** with contradictory thresholds — a multi-agent system needs ONE authoritative scoring path
3. **CAS selling strategy** has no runtime rejection — a multi-agent system would inherit this violation
4. **Morning signal generator** has no trade registration — a multi-agent system needs complete lifecycle tracking
5. **14 duplicate PCR implementations** — a multi-agent system needs ONE canonical data pipeline
6. **Multiple engines bypass active trade lock** — a multi-agent system needs guaranteed lock enforcement

**RECOMMENDATION:** Complete Phase 1-3 fixes first (safety + dedup + cleanup), then reassess for multi-agent. The system needs consolidation before it can safely support multiple autonomous agents.
