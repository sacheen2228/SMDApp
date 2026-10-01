# Grok handoff (supervisor consumption)

`scripts/grok_handoff.py` wraps any signal output with explicit role labels
so the **Grok main supervisor** can consume it as a research input.

```bash
python scripts/grok_handoff.py signal_output.json [SYMBOL]
```

## Wrapper object

```json
{
  "source": "NSE_OPTIONS_SIGNAL",
  "role": "OPTIONS_RESEARCH_SECOND_OPINION",
  "authority": "RESEARCH_INPUT_ONLY",
  "skill_version": "2.1.0",
  "symbol": "NIFTY",
  "session_id": null,
  "timestamp_ist": "YYYY-MM-DD HH:MM",
  "decision": "BUY_CE | BUY_PE | NO_TRADE",
  "bias_score": 0,
  "bias": "BULLISH | BEARISH | MILD_BULLISH | MILD_BEARISH | NEUTRAL",
  "can_force_trade": false,
  "supersedes_supervisor": false,
  "risk_flags": ["..."],
  "signal": { "...full signal output..." }
}
```

## Semantics

- `authority: RESEARCH_INPUT_ONLY` - Grok (SMDApp
  `src/lib/agents/supervisor.ts`) stays the decision-maker. This wrapper
  **never** claims to override, replace, or outvote the supervisor.
- `can_force_trade` is always `false`; `supersedes_supervisor` always `false`.
- The full original signal (score, agreement, data_quality, news_context,
  trade, gates, reason) is embedded under `signal` so Grok needs one lookup.

## risk_flags (auto-populated)

| Flag | Meaning |
|---|---|
| any gate string | mirror of `gates_failed` (freshness, clock, theta, agreement, spread, ...) |
| `SCORE_CEILING_DETECTED` | achievable max < +40 / min > -40 from available groups (report-only) |
| `NEWS_<x>_vs_MARKET_<y>` | verified news opposes price direction |
| `UNVERIFIED_NEWS_PRESENT` | social/unverified items exist in context |
| `DATA_NOT_FRESH` | a core input is not provably fresh |

Flags inform the supervisor; they never substitute for its own validation,
risk checks, or Telegram/production action paths (which remain in SMDApp).
