# News schema & sentiment rules (context layer)

`scripts/news_context.py` - context ONLY. News never enters `bias_score`,
never maps directly to CE/PE, and can never force a trade.

## Event object

```json
{
  "event_id": "evt_rbi_20260925",
  "source": "RBI | Reuters | twitter:handle | ...",
  "headline": "short factual headline",
  "published_at": "YYYY-MM-DD HH:MM:SS",
  "received_at": "YYYY-MM-DD HH:MM:SS",
  "event_type": "RBI_POLICY | US_FED | BUDGET | ELECTION | GEOPOLITICS | EARNINGS | MOOD | RATING | INFLATION | OTHER",
  "sentiment": -1 | 0 | 1,
  "impact": 0-100,
  "confidence": 0-100,
  "affected_symbol": "NIFTY | BANKNIFTY | RELIANCE | null",
  "affected_sector": "BANKS | IT | null",
  "market_wide": true | false,
  "verified": true | false,
  "source_reliability": 0.0-1.0,
  "time_horizon": "intraday | short_term | long_term",
  "unverified": true | false,
  "corroborated_by": ["non-social sources"]
}
```

- `verified` defaults to `false` for social sources, `true` otherwise.
- `unverified` = social source without a non-social `corroborated_by` entry.
  Unverified events are **reported but contribute 0** to the sentiment score.
- Unknown `event_type` values normalize to `OTHER`.
- Out-of-range `impact`/`confidence` clamp to 0-100.

## Deduplication (by `event_id`)

- One event per `event_id`; `sources[]` merged.
- **Impact is never multiplied**: consolidated `impact = max(inputs)`.
- `confidence = max(inputs) + 5 * (independent non-social sources - 1)`,
  capped at 100.
- A social event that gains a non-social corroboration becomes `verified`.

## Look-ahead protection (no future data)

Events with `published_at` **or** `received_at` after the decision time are
excluded and returned under `excluded_lookahead` with
`reason: "LOOKAHEAD_EXCLUDED"` (never counted, never silently dropped).

## Aggregated sentiment (`sentiment_context`)

```json
{
  "score": -1.0 .. 1.0,
  "n_events": 0, "n_verified": 0, "n_unverified": 0,
  "dominant": "BULLISH | BEARISH | NEUTRAL",
  "unverified_headlines": [{"headline": "...", "source": "...", "status": "UNVERIFIED"}]
}
```

Weighted mean over **verified, symbol-relevant** events
(weight = confidence x source_reliability). Bounds are inclusive -1..1.

## Price confirmation (per event)

`price_confirmation = CONFIRMED | PARTIALLY_CONFIRMED | NOT_CONFIRMED | UNKNOWN`

Computed only from observations the caller actually provides
(`news_market_obs`: `price_change_after_event`, `volume_change`, `oi_change`,
`iv_change`, `vix_change`, `breadth_change`). **No observations => UNKNOWN.**
No value is ever fabricated for missing post-event data.

## Conflicts

Verified events with `impact >= 40` whose sentiment opposes the market
direction are listed as:

```
NEWS_BULLISH_vs_MARKET_BEARISH   (or the mirror case)
```

Conflicts appear in `news_context.conflicts` and in the signal's
`conflicting_evidence`. News never wins a conflict - price direction decides.

## Backtests

No historical news source exists for past sessions, so
`scripts/backtest_history.py` is intentionally unchanged and never
fabricates news for historical dates.
