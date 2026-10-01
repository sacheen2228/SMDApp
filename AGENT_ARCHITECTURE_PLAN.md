# SMDApp Agent Architecture Plan v2 — 30 Agents + Grok + Trade Monitor + Telegram Alerts

## Status: v2 Phases A–C COMPLETE — Phases D–H pending (each gated by a verification table)

## §0 Scope (CONFIRMED — required before Phase 9/10 work)

**Alert-only.** Confirmed by Sachin on 2026-09-25.
The Trade Monitor watches LTP against SL/TP levels for human-registered
trades (manual registration, or a human confirming a Jarvis/agent
suggestion) and sends Telegram alerts. **No component in this system calls a
broker order-placement endpoint.** Audit finding: `grep placeOrder|
orderPlacement|executeOrder src/lib/agents/` → zero matches. Any future
change to auto-execution requires written re-confirmation plus: instant
Telegram kill-switch, N-day paper gate, and a second independent order
check — none of which exist because this build is alert-only by design.

## Architecture (v2 §4)

```
LIVE MARKET DATA (ONE shared MarketSnapshot per cycle, fetchedAtIso)
        ↓
30 SPECIALIST RESEARCH AGENTS  (read-only; wrap src/lib/jarvis/ per §2)
        ↓
CROSS-CONFLUENCE ANALYSIS      (cross-confluence.ts)
        ↓
GROK SUPERVISOR               (supervisor.ts — cannot invent data §6;
        ↓                       numeric backstop discards + logs violations)
ENGINE ROUTER
   ├─ OPTION ENGINE    → BUY_CE / BUY_PE / NO_TRADE   (own gates; may override
   └─ CASH/FUTURES ENGINE → BUY / SELL / NO_TRADE       Grok to NO_TRADE, never escalate)
        ↓
HERMES (shared context/validation — not a second decision-maker)
        ↓
RISK MANAGEMENT → FINAL VALIDATOR → CONFLICT CHECK → ACTIVE TRADE LOCK
        ↓
TRADE REGISTRATION  (human-confirmed; BLOCKED while kill switch is engaged §10)
        ↓
TRADE MONITOR (deterministic, no LLM) → TP/SL DETECTION
        ↓
TELEGRAM ALERT  (sole sender: telegram-alerts.ts → telegram.ts §9)
        ↓
TRADE OUTCOME → LEARNING DB (guardrailed §19)
```

## Hard Rules (inviolable, v2 §1 + §20)

- Options: `BUY_CE`, `BUY_PE`, `NO_TRADE` only. Any SELL proposal from any
  agent (incl. 16 Zero Hero, 17 CAS) is **discarded to NO_TRADE** — never converted.
- Equity/Futures/MCX: `BUY`, `SELL`, `NO_TRADE`. SELL is allowed — the
  options-only restriction must not leak between engines.
- Trade Monitor + TP/SL detection: deterministic math, no LLM.
- Exactly one component sends Telegram (§9): `agents/telegram-alerts.ts`
  on the Trade Monitor TP/SL path. No agent, Grok, Hermes, or engine sends.
- No agent fabricates evidence. Missing data → `dataFreshness: MISSING`,
  `status: ERROR`, `bias: NO_DATA` — never a plausible guess.
- Grok never asserts a number absent from the agent outputs it was handed.
- Self-learning may only adjust confidence weighting, only ≥30 samples/agent/
  regime, and always logs before/after (§19). It may never touch: option
  BUY-only, risk limits, active lock, validator, security, Telegram auth.

## §2 Reuse Map — Jarvis wrappers (Phase C) vs genuinely new

Frozen lib: `src/lib/jarvis/` (wrap, never fork). `jarvis-adapters.ts` is
the wiring layer around it.

| Agent | Wrap from `src/lib/jarvis/` | Current v1 state (gap) |
|---|---|---|
| 07 OI/PCR | `scoring.ts` `optionChainScore()` — PCR, OI-wall support/resistance, score (maxPain comes from `buildLevels`, not this fn) | ✅ Phase C — inline totals kept as fallback only |
| 09 Greeks | `greeks.ts` `analyseGreeks()` / `bsGreeks()` | ✅ Phase C — jarvis primary, hermes ATM greeks fallback |
| 10 Gamma | `greeks.ts` `analyseGreeks()` fields `netGex`, `gammaFlip`, `regime` (+ hermes greek-flow wall/dealerBias as complement) | ✅ Phase C |
| 11 IV/HV | `greeks.ts` `analyseGreeks()` fields `atmIv`, `skewPutMinusCall`, `atmStraddle` | ✅ Phase C |
| 14 Strike Selection | `greeks.ts` `analyseGreeks().perStrike` deltas — 0.50-delta strike pick (orchestrator has no exported strike fn) | ✅ Phase C |
| 19 Support/Resistance | `levels.ts` `buildLevels()` (OI walls, max pain, confluence zones, spreads) | ✅ Phase C |
| 25 ATR/Volatility | `greeks.ts` `analyseGreeks()` `expectedMove1Sigma` + `gatesFailed`/`notes` (+ Yahoo ATR when present) | ✅ Phase C |
| 02 FII/DII | `scoring.ts` `fiiScore()` thresholds over snapshot flow | ✅ Phase C |
| 26 News · 28 Sentiment | `jarvis-adapters.ts` shared `signedNewsScore()` (extracted so smdNews + agents use ONE formula; no second /api/news fetch) | ✅ Phase C |

**Wiring (all Phase C):** `ctx.jarvisChain` is a pure mapping of the same
Hermes fetch (`snapshot.ts toJarvisChain`) — wrapping jarvis adds **zero**
network calls. `agents/jarvis-bridge.ts` holds the fail-safe wrappers
(`bridgeChainScore/Greeks/Levels/FiiScore/NewsSigned`) — they reject
non-NSE expiry formats instead of feeding NaN to jarvis, and return
null/0 on any problem so agents degrade to their SMDApp-context inputs.

**Genuinely new (no Jarvis equivalent — wrap the listed SMDApp module
instead):** 01, 03, 04, 05, 06, 08, 12, 13, 15, 16, 17, 18, 20, 21, 22, 23,
24, 27, 29, 30. If an agent's required output is not in Jarvis, it is noted
here rather than duplicating a second OI/Greeks calculation — two independent
Greeks engines that can disagree is worse than one occasionally incomplete.

**Rule:** each §2 agent becomes a thin wrapper: call the Jarvis function,
reshape to `AgentResearchOutput`, add only the agent-specific angle Jarvis
doesn't compute (e.g. Agent 10's "gamma wall" framing vs raw `gammaFlip`).

## §3 One shared snapshot

- One `MarketSnapshot` (= `AgentContext` + `fetchedAtIso`) per cycle,
  built by a single builder (reusing `smd-context.ts` / hermes context /
  `jarvis-adapters` `DataSource`).
- All 30 agents read it; fast-tier agents re-read the same cycle's slice on
  their own cadence but never trigger independent NSE/MOAPI calls.
- Every agent's `dataFreshness` derives from the snapshot's ONE
  `fetchedAtIso` (§21) — never per-agent "fresh" opinions.
- Test (§28): instrument outbound fetch count during one full cycle →
  assert equals 1 (plus deliberate per-type fetches: FII/DII, news).

## Actual File Inventory (v1 plan's a01–a30.ts list was never used)

| File | Role |
|---|---|
| `src/lib/agents/agent-contract.ts` | AgentOutput schema, AgentContext, ids |
| `src/lib/agents/registry-30.ts` | all 30 analyze fns + REGISTRY + runAllAgents |
| `src/lib/agents/cross-confluence.ts` | conflict/confluence aggregation |
| `src/lib/agents/supervisor.ts` | Grok supervisor (+ §6 backstop, Phase D) |
| `src/lib/agents/option-engine.ts` | BUY_CE/BUY_PE/NO_TRADE, own gates |
| `src/lib/agents/cash-futures-engine.ts` | BUY/SELL/NO_TRADE, own gates |
| `src/lib/agents/trade-monitor.ts` | deterministic TP/SL detection |
| `src/lib/agents/telegram-alerts.ts` | SOLE Telegram sender wrapper (§9) |
| `src/lib/agents/learning-db.ts` | outcomes + §19 guardrails (Phase F) |
| `src/lib/agents/pipeline.ts` | full cycle orchestration |
| `src/lib/agents/snapshot.ts` | **Phase B — shared snapshot builder + `toJarvisChain` (done)** |
| `src/lib/agents/jarvis-bridge.ts` | **Phase C — fail-safe jarvis wrappers (done)** |
| `src/app/api/agents/pipeline/route.ts` | **Phase B — production entry, dryRun default true (done)** |
| `tests/agent-system.test.ts` | 33 tests (+ STRIKE_SELECTION riskFlags regression) |
| `tests/agent-snapshot.test.ts` | **Phase B — 5 tests (fetch count, single-ts freshness)** |
| `tests/agent-bridge.test.ts` | **Phase C — 11 tests (bridges + jarvis-evidence assertions)** |

`tpsl-detector.ts` from v1 never existed — detection lives in
`trade-monitor.ts`. No parallel module is being created for it.

## Existing Modules Reused (unchanged)

`trade-validator-gate.ts` (24 checks) · `active-trade-lock.ts` ·
`activeTradeTracker.ts` · `signalTracker.ts` · `signal-conflict-detector.ts` ·
`risk-management.ts` · `telegram.ts` · `hermes/{types,context,scoring-engine,
no-trade-engine,strike-selector,freshness}.ts` · `market-regime.ts` ·
`fii-dii.ts` · `sdm-oianalysis.ts` · `oi-classification-engine.ts` ·
`greeks.ts` · `option-acceleration-engine.ts` · `buyer-confluence-engine.ts` ·
`mtf-signal-engine.ts` · `zero-hero.ts` · `cas-straddle-strategy-v2.ts` ·
`market-structure-engine.ts` · `vwap-engine.ts` · `volume-analysis.ts` ·
`ml-engine.ts` · `yahoo-finance-api.ts` · `intraday-scanner.ts` ·
`btst-scanner.ts` · `mcx/mcx-intelligence.ts`

## Build Phases v2 (gate = verification table; never proceed on red)

| Phase | Work | Gate |
|---|---|---|
| **A** | This doc: §0 recorded, §2 reuse map, real inventory, phase table | doc matches audit |
| **B** | Shared snapshot builder + `fetchedAtIso` + production wiring of `runFullPipeline` + §28 fetch-count test | fetch count == 1; freshness from single ts |
| **C** | Jarvis-reuse refactors for agents 02/07/09/10/11/14/19/25 (+26/28 news wiring) | existing agent tests still green; no duplicate Greeks/OI math |
| **D** | Grok numeric backstop: pure fn, discard + deterministic fallback, fire-count log, §28 fabricated-response test | backstop discards fabricated Grok |
| **E** | Kill switch (§10): `Hermes, stop all trading` → blocks registration, monitoring keeps running, no confirm to stop, `CONFIRM RESUME TRADING` to resume | tests: blocked registration + monitoring continues |
| **F** | Learning guardrails (§19): ≥30 samples/regime gate, confidence-only, before/after log | tests: no adjust below 30; log written |
| **G** | §28 test suite: fabricated-evidence spot-check, fetch-count, Grok backstop, paper-trade E2E TP/SL (§11) | all green + tsc baseline + build |
| **H** | Final report (§33): §0 answer, reuse list, fetch-count result, backstop fire count, checklist 48–51 | report complete |

## §32 checklist additions (tracked in final report)

48. Exactly one component calls the Telegram sender.
49. All 30 agents read from a single shared snapshot per cycle.
50. §0 alert-only scope confirmed in writing before Phase 9/10 (this section).
51. Self-learning weight changes logged + sample-size gated.
