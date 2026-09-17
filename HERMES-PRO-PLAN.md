# HERMES PRO — IMPLEMENTATION PLAN

## Current Architecture

**98 files, ~37,734 lines.** TypeScript strict mode ON, `noImplicitAny: false`, `ignoreBuildErrors: true`.

### Existing Engines (REUSE — do NOT rebuild)
| Engine | File | Lines | Key Export |
|--------|------|-------|------------|
| Market Structure | `market-structure.ts` | 241 | `analyzeMarketStructure()` |
| OI Analysis | `sdm-oianalysis.ts` | 400 | `analyzeOptionChain()` (6 sub-functions) |
| Greeks | `greeks.ts` | 61 | `calculateGreeks()` (Black-Scholes) |
| Gamma Blast | `gamma-blast.ts` | 153 | `detectGammaBlast()` |
| Volume Analysis | `volume-analysis.ts` | 283 | `analyzeVolume()` (POC/VAH/VAL) |
| Multi-Timeframe | `multi-timeframe.ts` | ~150 | `analyzeMultiTimeframe()` |
| Sentiment | `sentiment-analyzer.ts` | 176 | `analyzeSentiment()` (80+ keywords) |
| Risk Management | `risk-management.ts` | 135 | `calculatePositionSize()`, `checkRiskLimits()` |
| Market Session | `market-session.ts` | 441 | `getCurrentSession()` (15 phases) |
| Unified Scoring | `unified-scoring-engine.ts` | 968 | 6 strategy profiles, weighted scoring |
| SMDContext | `smd-context.ts` | 219 | `buildSMDContext()` (parallel 6-API fetch) |
| Provider Health | `provider-health.ts` | 329 | 8 providers, circuit breaker, cooldown |
| CAS Time Engine | `cas-time-engine.ts` | 1236 | CAS timing, IBTR |
| SDM Engine | `sdm-engine.ts` | 1268 | 14-factor scoring |
| MCX Module | `mcx/*.ts` (7 files) | ~1500 | Types, market-data, scanner, session, instrument-master |
| FII/DII | `fii-dii.ts` | 293 | NSE India + MrChartist history |
| News Engine | `news-engine.ts` | 369 | News fetcher + sentiment |

### Existing LLM Provider Chain
TokenRa → Groq → OpenRouter → Ollama → Pattern Matcher (deterministic fallback)

### Existing Tool System
43 tools in `agent-brain.ts` (1,773 lines), single `executeTool()` switch statement (800 lines), `TOOL_ROUTER` maps 16 keyword patterns to 8-14 tools.

### Existing Test Infrastructure
10 test files under `tests/`, using `bun:test` native runner. No test script in package.json.

### What Does NOT Exist (must create)
- `src/lib/hermes/` directory
- `src/lib/providers/` directory
- `src/lib/breeze-session-manager.ts`
- `src/lib/data-freshness-engine.ts`
- `src/lib/instrument-config.ts`
- `src/lib/no-trade-engine.ts`

### What Already Exists (must NOT duplicate)
- `market-data-manager.ts` — already exists, check what it does
- `provider-health.ts` — already tracks breeze/nse/moapi/yahoo
- `mcx/` module — 7 files already exist
- `smd-context.ts` — parallel data fetch already works

---

## Files to Create (18 new files)

### Core Hermes (`src/lib/hermes/`)
| # | File | Est Lines | Purpose |
|---|------|-----------|---------|
| 1 | `types.ts` | 250 | All Hermes types, interfaces, enums |
| 2 | `tool-registry.ts` | 400 | Tool definitions with schemas, freshness, reliability |
| 3 | `task-router.ts` | 300 | Intent detection + execution planning |
| 4 | `context.ts` | 350 | Parallel data collector using existing engines |
| 5 | `freshness.ts` | 150 | Data freshness engine |
| 6 | `regime-engine.ts` | 250 | Market regime (wraps existing regime API) |
| 7 | `oi-intel.ts` | 200 | OI intelligence (wraps sdm-oianalysis.ts) |
| 8 | `gamma-intel.ts` | 150 | Gamma intelligence (wraps gamma-blast.ts) |
| 9 | `flow-intel.ts` | 150 | FII/DII + participant OI intelligence |
| 10 | `scoring-engine.ts` | 350 | Deterministic 100-point scoring |
| 11 | `strike-selector.ts` | 300 | ITM/ATM/OTM selection engine |
| 12 | `trade-validator.ts` | 350 | 15-step validation pipeline |
| 13 | `no-trade-engine.ts` | 200 | NO TRADE decision engine |
| 14 | `agent.ts` | 500 | Main orchestrator |
| 15 | `explainer.ts` | 200 | Evidence-based explanation generator |
| 16 | `response.ts` | 150 | Response formatting (trade card, no-trade, research) |

### Provider Layer (`src/lib/providers/`)
| # | File | Est Lines | Purpose |
|---|------|-----------|---------|
| 17 | `market-data-manager.ts` | 400 | Unified data manager with provider fallback |

### Config
| # | File | Est Lines | Purpose |
|---|------|-----------|---------|
| 18 | `instrument-config.ts` | 150 | Lot sizes, contract metadata, configurable |

## Files to Modify (4 existing files)
| # | File | Change |
|---|------|--------|
| 1 | `src/app/api/agent/route.ts` | Replace monolithic data fetch with hermes/agent.ts orchestrator |
| 2 | `src/lib/agent-brain.ts` | Import tool definitions from hermes/tool-registry.ts, keep executeTool for backward compat |
| 3 | `src/components/dashboard/AgentChat.tsx` | Parse HermesDecision format, show regime/score/evidence/risks |
| 4 | `src/lib/provider-health.ts` | Add data provider tracking (breeze/nse/moapi/yahoo status exposure) |

## Files to Test (1 new test file)
| # | File | Purpose |
|---|------|---------|
| 1 | `tests/hermes-pro.test.ts` | 50+ acceptance tests |

---

## PHASE 1: Types + Config + Freshness

### `src/lib/hermes/types.ts`
All types for the Hermes system. Enums for MarketStatus, DataFreshness, Direction, OptionSide, TradeGrade, HermesMode, Decision, FlowBias. Interfaces for FreshData<T>, HermesContext, TradeCandidate, HermesDecision, EvidencePoint, ScoreResult, ValidationResult.

### `src/lib/instrument-config.ts`
Configurable contract metadata: lot sizes (NIFTY=65, SENSEX=20, BANKNIFTY=30, etc.), tick sizes, expiry days, supported instruments per exchange (NSE/MCX).

### `src/lib/hermes/freshness.ts`
Data freshness engine: `classifyFreshness(timestamp, maxAge)`, thresholds by data type (tick <15s, option chain <30s, FII/DII <86400s).

---

## PHASE 2: Market Data Manager + Provider Layer

### `src/lib/providers/market-data-manager.ts`
Unified interface: `fetchMarketData<T>(instrument, dataType, options)` → `MarketDataResponse<T>`.

Provider fallback chain:
```
Breeze → MOAPI → NSE → Yahoo (delayed标记)
```

Each provider call wrapped in try/catch with freshness tagging. Never fabricate data.

### Modify `src/lib/provider-health.ts`
Add data provider status exposure: `getDataProviderStatus()` returns breeze/nse/moapi/yahoo health for UI.

---

## PHASE 3: Hermes Core (Router + Context + Registry)

### `src/lib/hermes/tool-registry.ts`
~20 tool definitions (not 43 — consolidate overlapping tools). Each with name, description, category, inputSchema, source, freshnessMaxAge, reliability, timeout, tags.

### `src/lib/hermes/task-router.ts`
Intent detection: regex + keyword matching for 15+ intents (LIVE_TRADE, OPTION_ANALYSIS, MCX_ANALYSIS, RESEARCH, etc.). Creates ExecutionPlan with required/optional tools, parallel batches.

### `src/lib/hermes/context.ts`
Parallel data collector. Uses `Promise.allSettled` to fetch only what the plan requires. Wraps each result in FreshData with timestamp/source/age/freshness.

---

## PHASE 4: Intelligence Layers

### `src/lib/hermes/regime-engine.ts`
Wraps existing `/api/market/regime` + interprets for trade decisions. VIX override at >25.

### `src/lib/hermes/oi-intel.ts`
Wraps `sdm-oianalysis.ts` functions. Classifies OI patterns, identifies OI walls, PCR intelligence.

### `src/lib/hermes/gamma-intel.ts`
Wraps `gamma-blast.ts`. Interprets dealer positioning, gamma walls, squeeze potential.

### `src/lib/hermes/flow-intel.ts`
Wraps `fii-dii.ts` data. Classifies flow bias, participant OI interpretation.

---

## PHASE 5: Trade Pipeline

### `src/lib/hermes/scoring-engine.ts`
100-point deterministic scoring: Structure(20), OI(15), Greeks(10), Volume(10), Gamma(10), VIX(5), FII/DII(5), CAS(10), ExpectedMove(5), News(5), RiskReward(5).

Grade: A(80+), B(70-79), C(60-69), D(50-59), F(<50).

### `src/lib/hermes/strike-selector.ts`
Evaluates ATM/ITM/OTM using delta, gamma, theta, iv, liquidity, volume, OI, spread, expected move. Returns ranked StrikeCandidate[].

### `src/lib/hermes/trade-validator.ts`
15-step pipeline: DATA_CHECK → FRESHNESS → MARKET_STATUS → STRUCTURE → OI → VOLUME → GREEKS → IV → GAMMA → EXPECTED_MOVE → NEWS → RISK_REWARD → LIQUIDITY → SESSION → POSITION_SIZE.

### `src/lib/hermes/no-trade-engine.ts`
Evaluates all rejection reasons. Returns NoTradeReason[] with category, reason, severity, suggestion.

---

## PHASE 6: Agent Orchestration

### `src/lib/hermes/agent.ts`
Main orchestrator: detectIntent → createPlan → collectContext → analyzeIntelligence → scoreCandidates → validate → riskCheck → noTradeGate → decide → explain → audit → format.

Hard limits: MAX_TOOL_CALLS=20, MAX_AGENT_TIME=30s.

### `src/lib/hermes/explainer.ts`
Generates evidence-based explanation from ScoreResult + ValidationResult + Context.

### `src/lib/hermes/response.ts`
Formats HermesDecision into structured response: trade card, no-trade card, research card.

---

## PHASE 7: Integration + Testing

### Modify `src/app/api/agent/route.ts`
Replace monolithic data fetch + early exits with `hermesPro()` from `hermes/agent.ts`. Keep conversation store, Telegram alerts, pattern matcher fallback.

### Modify `src/lib/agent-brain.ts`
Import tool definitions from `hermes/tool-registry.ts`. Keep `executeTool()` for backward compatibility. Add new Hermes tools.

### Modify `src/components/dashboard/AgentChat.tsx`
Parse HermesDecision response. Show: regime badge, score/grade, evidence bullets, risks, data health, provider status.

### `tests/hermes-pro.test.ts`
50+ tests: tool registry, intent detection, freshness, scoring, strike selection, validation, no-trade, market closed, provider fallback, option buying only, response format.

---

## Acceptance Tests (must pass)

1. Breeze disabled → MOAPI takes over automatically
2. Breeze+MOAPI disabled → NSE attempted
3. All live sources down → research allowed, live trade blocked
4. MCX via MOAPI → MCX_LIVE, trade eligible
5. MCX via Yahoo only → MCX_DELAYED, trade blocked
6. Invalid provider data → reject, fallback
7. Breeze expired → BREEZE AUTH REQUIRED, MOAPI fallback
8. LLM unavailable → deterministic engines + pattern matcher work
9. Option seller signal → rejected, only CE/PE BUY
10. Market closed → no live trade, research allowed

---

## Implementation Order

| Phase | What | Est. Lines | Depends On |
|-------|------|------------|------------|
| 1 | Types + Config + Freshness | 550 | Nothing |
| 2 | Market Data Manager | 400 | Phase 1 |
| 3 | Router + Context + Registry | 1050 | Phase 1, 2 |
| 4 | Intelligence Layers | 750 | Phase 3 |
| 5 | Trade Pipeline | 1000 | Phase 4 |
| 6 | Agent Orchestration | 850 | Phase 5 |
| 7 | Integration + Tests | 500+ | Phase 6 |

**Total: ~5,100 new lines across 18 files + 4 modifications + 1 test file**
