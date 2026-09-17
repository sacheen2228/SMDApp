# SMDApp Agent System Skill

## Overview
SMDApp implements a multi-agent system for Indian stock/futures/options trading. The system is designed for **option buying only** (CE BUY / PE BUY). Selling is strictly forbidden.

## Agent Architecture
- **Hermes Pro**: Primary AI agent with 41 tools, market data, and trade execution
- **External Agents**: Can publish signals but NEVER execute trades
- **TradeMonitor**: Deterministic — no LLM can override trade lifecycle
- **Active Trade Lock**: Prevents new trades while existing trades are active

## Signal Lifecycle
```
RESEARCH → CANDIDATE → VALIDATING → VALIDATED → FINAL → ACTIVE → TP1/TP2/EXIT/SL → CLOSED
```

## Key Files
- `src/lib/agents/types.ts` — All agent types
- `src/lib/agents/registry.ts` — Registration, lookup, health, tasks, signals, events
- `src/lib/agents/heartbeat.ts` — Heartbeat monitoring
- `src/lib/agents/signal-lifecycle.ts` — Signal state machine
- `src/lib/agents/tasks.ts` — Task creation and execution
- `src/lib/agents/reputation.ts` — Performance tracking
- `src/lib/external/ai-trader/` — External AI-Trader integration

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

## Security Rules
1. SELL signals are BLOCKED
2. External agents cannot execute trades
3. All signals go through validation
4. Data is sanitized before external delivery
5. Canonical pipeline required before execution

## Commands
- `bun test tests/agent-system.test.ts` — Run agent system tests (30 tests)
- `bun run build` — Build with agent system
