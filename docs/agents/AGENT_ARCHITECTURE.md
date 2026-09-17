# SMDApp Agent Architecture

## Overview

SMDApp implements a multi-agent system where:
- **SMDApp is the source of truth** — all market data, validation, risk, and trade execution
- **Hermes Pro** is the primary AI agent with 41 tools
- **External agents** (AI-Trader etc.) can publish signals but NEVER execute trades
- **TradeMonitor** is deterministic — no LLM can override trade lifecycle

## Agent Registry

All agents are registered in `src/lib/agents/registry.ts`:

```
┌─────────────────────────────────────────────────────┐
│                    AGENT REGISTRY                    │
├─────────────────────────────────────────────────────┤
│  HERMES          (Internal, full capabilities)      │
│  SMDAPP_ENGINE   (Internal, market data)            │
│  MARKET_RESEARCH (Internal, research only)          │
│  OPTION_ENGINE   (Internal, option analysis)        │
│  CHART_ENGINE    (Internal, chart vision)           │
│  EXTERNAL_AGENT  (External, limited capabilities)   │
│  HUMAN           (Human, manual input)              │
│  SYSTEM          (System, automated tasks)          │
└─────────────────────────────────────────────────────┘
```

## Agent Capabilities

### Internal Agents (Full Access)
- marketSnapshot, optionChain, oiAnalysis, sellerMap, greeks, gamma, frvp, liquidity
- chartVision, fiiDii, breadth, cas, globalMarkets, news
- tradeResearch, signalPublishing, tradeExecution

### External Agents (Limited)
- tradeResearch, signalPublishing ONLY
- tradeExecution = false (NEVER)
- No direct market data access — must use SMDApp's canonical pipeline

## Signal Lifecycle

```
RESEARCH → CANDIDATE → VALIDATING → VALIDATED → FINAL → ACTIVE → TP1/TP2/EXIT/SL → CLOSED
    ↓           ↓           ↓
  (cancel)   (reject)    (reject)
```

### State Transitions
- **RESEARCH** → CANDIDATE: Research complete
- **CANDIDATE** → VALIDATING: Sent to validation
- **VALIDATING** → VALIDATED: Passed all checks
- **VALIDATING** → REJECTED: Failed validation
- **VALIDATED** → FINAL: Signal finalized
- **FINAL** → ACTIVE: Trade entered
- **ACTIVE** → TP1/TP2/EXIT/SL: Trade outcomes
- **TP1/TP2/EXIT/SL** → CLOSED: Trade closed

## Heartbeat System

Each agent sends heartbeats with:
- Status (ACTIVE, IDLE, BUSY, DEGRADED, OFFLINE)
- Current task, market, underlying
- Latency, last error, data freshness

Stale heartbeats (>60s) trigger OFFLINE status.

## Task System

Tasks are created and tracked:
- MARKET_SCAN, OPTION_SCAN, CE_PE_COMPARISON
- EXPIRY_RESEARCH, OI_RESEARCH, SELLER_RESEARCH
- CHART_ANALYSIS, GLOBAL_RESEARCH, NEWS_RESEARCH
- TRADE_REVIEW, ACTIVE_TRADE_MONITOR, POST_TRADE_REVIEW

Tasks flow: QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED

## Event System

Events are emitted with idempotency keys:
- Agent lifecycle (REGISTERED, HEARTBEAT)
- Task lifecycle (CREATED, STARTED, COMPLETED, FAILED)
- Signal lifecycle (CREATED, VALIDATED, REJECTED, ACTIVATED)
- Trade lifecycle (ENTRY, T1_HIT, T2_HIT, SL_HIT, EXIT)

Events are stored in DB and streamed via SSE.

## External Signal Ingestion

External agents submit signals via:
1. POST `/api/agents/external-signals` — direct submission
2. GET `/api/agents/external-signals?action=sync` — pull from external system
3. GET `/api/agents/external-signals?action=ingest` — batch ingestion

### Validation
- SELL signals are BLOCKED
- Confidence must be ≥0.5
- Strike and expiry required for BUY signals
- Must go through SMDApp's canonical pipeline

### Normalization
External signals are normalized to SMDApp's `AgentSignal` format:
- Evidence is mapped to standard fields
- CE/PE labels are enforced
- Direction is normalized to BUY_CE/BUY_PE/WAIT/EXIT

## Reputation System

Agents earn reputation based on:
- Signal validity (valid signals increase score)
- Trade outcomes (wins, losses, R-multiple)
- Data freshness (stale signals decrease score)
- Conflict detection (conflicts decrease score)

Ranks: ROOKIE → NOVICE → INTERMEDIATE → EXPERT → MASTER

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/agents/health` | GET | System health status |
| `/api/hermes/health` | GET | Hermes agent health |
| `/api/signals/feed` | GET | Real-time signal feed |
| `/api/agents/external-signals` | GET/POST | External signal ingestion |
| `/api/events/stream` | GET | SSE event stream |
| `/api/agents/leaderboard` | GET | Agent performance ranking |

## Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| AGENT_SYSTEM_ENABLED | true | Master switch |
| EXTERNAL_AGENT_ENABLED | true | External agent support |
| AI_TRADER_ENABLED | false | AI-Trader integration |
| AGENT_WEBSOCKET_ENABLED | true | SSE event stream |
| AGENT_SIGNAL_FEED_ENABLED | true | Signal feed |
| AGENT_PERFORMANCE_ENABLED | true | Performance tracking |

## Security

### Data Sanitization (Point 54)
- Evidence is sanitized before external delivery
- Only non-sensitive fields are exposed:
  - priceStructure, volume, callOI, putOI, vix
- Strike, expiry, entryPrice are NOT exposed in feed

### Validation (Point 55)
- All signals go through `validateExternalSignal()`
- SELL signals are rejected
- Confidence thresholds enforced
- Data freshness checked
- Canonical pipeline required before execution

## Files

### Core
- `src/lib/agents/types.ts` — All agent types
- `src/lib/agents/registry.ts` — Registration, lookup, health, tasks, signals, events
- `src/lib/agents/heartbeat.ts` — Heartbeat monitoring
- `src/lib/agents/signal-lifecycle.ts` — Signal state machine
- `src/lib/agents/tasks.ts` — Task creation and execution
- `src/lib/agents/reputation.ts` — Performance tracking

### External Integration
- `src/lib/external/ai-trader/types.ts` — AI-Trader types
- `src/lib/external/ai-trader/client.ts` — HTTP client
- `src/lib/external/ai-trader/normalizer.ts` — Signal normalization
- `src/lib/external/ai-trader/validator.ts` — Signal validation
- `src/lib/external/ai-trader/adapter.ts` — Main orchestrator
- `src/lib/external/ai-trader/cache.ts` — Signal deduplication

### API Routes
- `src/app/api/agents/health/route.ts`
- `src/app/api/hermes/health/route.ts`
- `src/app/api/signals/feed/route.ts`
- `src/app/api/agents/external-signals/route.ts`
- `src/app/api/events/stream/route.ts`
- `src/app/api/agents/leaderboard/route.ts`

### UI
- `src/components/agent-intelligence/AgentIntelligence.tsx`

### Prisma
- `prisma/schema.prisma` — Agent, AgentHeartbeat, AgentTask, AgentSignal, AgentEvent, AgentPerformance, ExternalSignal, NotificationDelivery models
