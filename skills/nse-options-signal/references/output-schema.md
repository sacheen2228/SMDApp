# Output schema (all agents must use exactly this)

The core schema below is **unchanged and backward compatible** (v2.1 adds
new keys only - existing consumers keep working):

```json
{
  "agent_id": "agent_07",
  "timestamp_ist": "YYYY-MM-DD HH:MM",
  "instrument": "NIFTY | BANKNIFTY | FINNIFTY | STOCK:XYZ",
  "spot": 0,
  "bias_score": 0,
  "component_scores": {"option_chain": 0, "fii": 0, "greeks": 0, "heatmap": 0, "oi_spurts": 0, "preopen": 0, "breadth": 0, "week52": 0},
  "greeks": {"delta_of_strike": 0, "theta_per_day": 0, "atm_iv": 0, "india_vix": 0, "skew": 0, "gamma_flip": 0, "net_gex_regime": "trending|pinned", "expected_move_1sigma": 0},
  "cross_check": {"nse_heatmap_weighted_pct": 0, "bse_sensex_weighted_pct": 0, "bse_fii_agrees_with_nse": true, "bse_available": true},
  "strategy": "S1..S8 name, e.g. S3 Liquidity sweep reversal",
  "levels_used": {"zone": [0, 0], "levels": ["oi_resistance", "pdh"], "liquidity_event": "sweep of PDH | none"},
  "liquidity_check": {"strike_oi_rank": 0, "spread_pct": 0, "order_type": "limit"},
  "action": "BUY_CE | BUY_PE | NO_TRADE",
  "confidence": "Moderate | High | Very high | NA",
  "trade": {
    "expiry": "YYYY-MM-DD",
    "strike": 0,
    "option_type": "CE | PE",
    "entry_zone": [0, 0],
    "stop_loss_premium": 0,
    "tp1_premium": 0,
    "tp2_premium": 0,
    "underlying_invalidation": 0,
    "underlying_targets": [0, 0],
    "risk_reward_tp1": 0,
    "suggested_lots": 0,
    "time_stop": "HH:MM"
  },
  "key_levels": {"support": 0, "resistance": 0, "max_pain": 0, "pcr": 0},
  "reasons": ["3-6 short data-backed bullets"],
  "gates_failed": [],
  "data_freshness_minutes": 0,
  "disclaimer": "Educational analysis, not investment advice."
}
```
If action is NO_TRADE set `trade` to null and explain in `reasons` / `gates_failed`.

## v2.1 extensions (`scripts/score_signal.py` output)

Additive keys - never removed, never renamed:

```json
{
  "decision": "BUY_CE | BUY_PE | NO_TRADE",
  "source": "NSE_OPTIONS_SIGNAL",
  "role": "OPTIONS_RESEARCH_SECOND_OPINION",
  "symbol": "NIFTY",
  "bias": "BULLISH | BEARISH | NEUTRAL",
  "gates": ["...same list as gates_failed..."],
  "agreement": {
    "groups_total": 8, "groups_available": 0,
    "groups_bullish": 0, "groups_bearish": 0, "groups_neutral": 0,
    "groups_missing": ["..."],
    "direction": "BULLISH | BEARISH | NEUTRAL",
    "groups_agreeing": 0, "gate_passed": false,
    "gate": "PASS/FAIL 4-of-8 wording"
  },
  "data_quality": {
    "overall": "LIVE | FALLBACK | STALE | MISSING | UNAVAILABLE",
    "core_fresh": true,
    "core_inputs": ["option_chain", "vix", "greeks"],
    "inputs": [{"name": "...", "source": "...", "data_timestamp": "...",
                "fetch_timestamp": "...", "freshness_seconds": 0,
                "ttl_seconds": 900, "status": "LIVE"}]
  },
  "news_context": {
    "present": false, "events": [], "raw_count": 0, "deduped_count": 0,
    "excluded_lookahead": [], "price_confirmations": [],
    "conflicts": [], "role": "CONTEXT_ONLY_NEVER_DECIDES"
  },
  "sentiment_context": {"score": 0.0, "n_events": 0, "n_verified": 0,
                        "n_unverified": 0, "dominant": "NEUTRAL",
                        "unverified_headlines": []},
  "component_scores": {"option_chain": 0, "fii": 0, "greeks": 0, "heatmap": 0,
                       "oi_spurts": 0, "breadth": 0, "preopen": 0, "week52": 0},
  "availability": {"option_chain": true, "fii": true, "...": false},
  "trade_attempt": null,
  "supporting_evidence": ["Group: +n agrees", "..."],
  "conflicting_evidence": ["Group: +n opposes BULLISH", "..."],
  "missing_inputs": ["heatmap group", "event_risk (not provided - cannot verify)"],
  "reason": "BUY_CE: score +67 meets +40/-40; 8/8 groups available, ...",
  "score_ceiling": {"detected": false, "threshold_up": 40, "threshold_down": -40,
                    "achievable_max": 0, "achievable_min": 0,
                    "unavailable_groups": [], "partial_implementations": {}},
  "score_ceiling_message": null,
  "breakout_validation": {
    "applicable": true,
    "level": 24600,
    "direction": "up",
    "mandatory": {
      "close_confirm": {"pass": true, "value": "close 24650.00 vs level 24600 (need 24.60)"},
      "volume": {"pass": true, "value": "18400 vs avg 9200 = 2.00x (need 1.5x, futures volume (snapshot))"},
      "oi_confirm": {"pass": true, "value": "CE OI 24600: 2.40M -> 1.90M (-500000) falling; futures OI +12000 rising; nearby PE OI +34000"}
    },
    "supporting": {
      "hold_retest": {"pass": true, "value": "retest close 24680.00 (level 24600) held beyond"},
      "candle_quality": {"pass": true, "value": "body 71% of range, close at 88% of range"},
      "room": {"pass": true, "value": "next level 25100, distance 500.00 (need 160.00 = 2.0x stop 80.00)"},
      "htf_breadth": {"pass": true, "value": "15m trend agrees; heavyweights 3/3 (100%) in direction"},
      "premium_response": {"pass": true, "value": "CE premium 210.00 -> 236.00; IV 13.4 -> 13.1 (0.3%)"}
    },
    "fakeout_flags": [],
    "verdict": "VALID_BREAKOUT"
  },
  "risk_flags": ["VIX_HIGH: ..."],
  "notes": ["..."],
  "confidence": "Moderate | High | Very high | NA"
}
```

Notes:
- `breakout_validation` is required whenever the strategy is S2/S4/S6 or the entry
  is near a level (see `references/breakout-rules.md`). `verdict` is one of
  `VALID_BREAKOUT` / `FAKEOUT` / `WAIT_FOR_RETEST` / `NOT_APPLICABLE`.
  A `FAKEOUT` verdict or any `fakeout_flags` entry is a NO-TRADE gate.
  Every check reports pass/fail **with its number** (e.g. "Volume 2.1x avg",
  "Call OI 24,600: 2.4M -> 1.9M"); a check that cannot be computed reports
  `UNKNOWN` (never a silent pass).
- `action` (legacy) and `decision` (v2.1) always carry the same value;
  the only legal values are `BUY_CE`, `BUY_PE`, `NO_TRADE` - **never SELL**.
- `components` (legacy, 4 keys) keeps its original semantics;
  `component_scores` is the full 8-group view that feeds `agreement`.
- For NO_TRADE: `trade` is null; a trade blocked by a trade-time gate may
  appear under `trade_attempt` for auditability.
- Wrap with `scripts/grok_handoff.py` for supervisor consumption
  (see `grok-handoff.md`).
