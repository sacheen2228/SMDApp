---
name: nse-options-signal
description: Reads NSE India market data (option chain, computed Greeks, India VIX, NSE and BSE index heatmaps, BSE FII derivatives summary, OI spurts, top gainers/losers, volume spurts, 52-week highs, most active contracts, pre-open, closing auction, FII/DII, participant-wise F&O OI) and converts it into a scored directional bias for NIFTY/BANKNIFTY/FINNIFTY or stock options. Outputs a structured trade idea - BUY CE or BUY PE, strike, entry, stop-loss, targets, confidence, invalidation - or NO TRADE. Use whenever an agent is asked for an intraday/positional options view, "market prediction", "CE or PE", "trade setup", or a market-open/close briefing for Indian markets.
---

# NSE Options Signal Skill

Turns public NSE data into a **rule-based, auditable** options trade idea.
This is a decision-support framework, NOT guaranteed prediction or licensed investment advice. Options buying loses money often; the skill is built to prefer NO TRADE over a weak trade.

## Role & supervisor hierarchy (v2.1)

- **This skill is a RESEARCH / SECOND-OPINION provider.** Its output carries
  `source: "NSE_OPTIONS_SIGNAL"` and `role: "OPTIONS_RESEARCH_SECOND_OPINION"`
  with `authority: "RESEARCH_INPUT_ONLY"`.
- **Grok remains the main supervisor** (SMDApp `src/lib/agents/supervisor.ts`).
  This skill never overrides Grok's decision, never issues Telegram/production
  orders by itself, and `can_force_trade` is always `false`.
- The skill is **not** a second supervisor, **not** a second news agent, and
  contains **no sending logic** (Telegram stays with production paths).
- Wrap any output for supervisor consumption with `scripts/grok_handoff.py`
  (see `references/grok-handoff.md`).

## Workflow (every agent follows this order)

1. **Fetch data** - run `scripts/nse_fetch.py` (or read the same sources via your own tool). See `references/data-sources.md` for the 11 sources and what each is used for. The fetch stamps **provenance** (source / timestamps / status) under `meta.provenance`.
2. **Score** - run `scripts/score_signal.py` on the fetched JSON, or apply `references/scoring-rules.md` by hand. Produces a bias score from -100 (strong bearish) to +100 (strong bullish), plus `agreement`, `data_quality`, `news_context` and `score_ceiling` blocks.
2b. **Levels + strategy** - run `scripts/levels.py` (OI walls, max pain, expected-move bands, confluence zones, liquid strikes), pick the regime (trend vs range vs event) and ONE named strategy from `references/strategies.md` (S1-S8). No named strategy at a level = NO TRADE.
3. **Gate** - apply the no-trade filters (below). Any failed gate => `NO TRADE`.
4. **Build trade** - if score >= +40 => BUY CE; if score <= -40 => BUY PE; otherwise NO TRADE. Pick strike, SL, TP using `references/scoring-rules.md` section "Trade construction".
5. **Respond** using the exact JSON schema in `references/output-schema.md`, then a 3-5 line human summary. For supervisor handoff, also emit `scripts/grok_handoff.py` JSON.

## Data provenance & data quality (new in v2.1)

Every scored input is tracked by `scripts/provenance.py` with:
`name, source, data_timestamp, fetch_timestamp, status` where status is one of
**LIVE / FALLBACK / STALE / MISSING / UNAVAILABLE**, plus `freshness_seconds`
against a per-input TTL (900s intraday feeds, 22-36h for EOD inputs).

- **Core inputs** (option chain, India VIX, and derived Greeks) must be fresh
  and provably timestamped, else `DATA_FRESHNESS` gate => NO TRADE.
- Derived inputs (Greeks, spot) **inherit** the option chain's freshness.
- Missing timestamp = freshness unprovable = treated as missing (never trusted
  silently). FALLBACK sources are allowed but reported in `data_quality`.
- The full per-input table is emitted under `data_quality.inputs`; absent
  inputs are listed in `missing_inputs`.

## News & sentiment context (new in v2.1)

News is a **context layer only** (`scripts/news_context.py`), documented in
`references/news-schema.md`. Hard rules:

- News **never enters the score**, never maps directly to CE/PE, and **can
  never force a trade** (a +100 impact bullish headline still cannot lift a
  sub-40 score into a trade).
- Deduplicate by `event_id`: consolidated impact = **max** (never summed);
  confidence may rise only via independent non-social corroboration (cap 100).
- X/Twitter/social sources are **UNVERIFIED** until corroborated by a
  non-social source; unverified items are reported but contribute **0** to
  sentiment.
- **Look-ahead protection**: events with `published_at`/`received_at` after
  the decision time are excluded and listed under `excluded_lookahead`.
- **Price confirmation** per event: CONFIRMED / PARTIALLY_CONFIRMED /
  NOT_CONFIRMED / UNKNOWN (UNKNOWN when no post-event observations exist -
  never fabricated).
- Conflicts are surfaced, not resolved by news (e.g.
  `NEWS_BULLISH_vs_MARKET_BEARISH` in `conflicting_evidence`).

## Score ceiling detection (new in v2.1)

`score_ceiling` reports the maximum/minimum score **achievable from the
currently available groups** (implemented bounds: option_chain +/-24,
fii +/-9, greeks +/-6, heatmap +/-10, oi_spurts +/-12, breadth +/-10,
preopen +/-8, week52 +/-10). When `achievable_max < +40` (or
`achievable_min > -40`) the output carries
`SCORE_CEILING_DETECTED` with the suppressing groups.

**This is report-only information.** Never lower the +/-40 thresholds, never
change weights to "fix" a ceiling, and never treat a detected ceiling as a
gate that permits trading.

## Data -> signal map (short)

| Source | What it tells you | Weight |
|---|---|---|
| Option chain | PCR, max pain, OI walls (support/resistance), OI change/buildup | 25 |
| FII/DII + participant OI + BSE FII summary | Institutional cash flow; FII index-futures long/short; NSE vs BSE agreement | 15 |
| Greeks (scripts/greeks.py) + India VIX | Delta for strike, theta cost, IV skew, gamma flip, expected move | 10 |
| Index heatmap (NSE + BSE Sensex) | Market-cap weighted breadth, sector leadership, narrow-rally check | 10 |
| OI spurts + most active contracts | Fresh money, long vs short buildup | 12 |
| Top gainers/losers + volume spurts | Breadth and heavyweight movers | 10 |
| Pre-open / closing auction | Gap direction, opening/closing pressure | 8 |
| 52-week highs | Trend strength | 10 |

Trade only if >= 4 of these 8 groups agree on direction.

## Mandatory no-trade gates

- Data older than 15 minutes during market hours, or any core source (option chain, FII/DII) missing -> NO TRADE.
- 09:15-09:30 IST: observe only, no fresh entry.
- After 14:45 IST: no fresh intraday entry (theta + closing volatility).
- Expiry day after 13:30 IST: no fresh entry for the expiring contract.
- |score| < 40, or fewer than 4 of 8 source groups agree on direction -> NO TRADE.
- Major event today (RBI policy, Union Budget, US Fed night, results of index heavyweight) -> reduce size 50% or NO TRADE.
- Option bid-ask spread > 2% of premium or low OI/volume strike -> pick another strike or NO TRADE.
- Greeks gates: < 3 hours to expiry, ATM theta > 10% of premium/day, or VIX > 25 -> NO TRADE or half size + ITM only. TP2 must fit inside the 1-sigma expected move.
- BSE sources unavailable -> treat as 0 and say so; never fabricate values.
- Daily loss limit hit (default 3% of capital) -> NO TRADE for the day.

## Risk rules (hard-coded, agents must not override)

- Risk per trade <= 1% of capital (max 2%). Quantity = risk amount / (entry - SL) / lot size, rounded down.
- Only BUY options (CE or PE), or defined-risk debit spreads (S8) where the short leg is fully covered. Never suggest naked selling.
- SL is mandatory. Every idea must include SL, TP1, TP2, and an invalidation level on the underlying.
- Minimum reward:risk = 1:1.5 at TP1, 1:2+ at TP2. If not achievable, NO TRADE.
- Max 2 open trades per index; do not average losing positions.

## Strategy & liquidity rules
- Every idea must name its strategy (S1-S8) and the exact levels used.
- Trade only at/beyond a confluence zone (3+ levels within 0.15%).
- Confluence checklist: >= 4 of 6 (level, liquidity event, OI behaviour, volume/OI spurt, Greeks, heatmap+FII) AND bias score agrees.
- Option liquidity: strike in top-5 OI, spread <= 2% of premium, use limit orders, size < 20% of visible depth.
- Liquidity-sweep logic: stops cluster at PDH/PDL, equal highs/lows, opening-range extremes and round numbers; a wick through the level that closes back inside with opposite-side OI addition is a reversal candidate (S3); a close and hold beyond the level with OI unwinding is a breakout (S2).

## Multi-agent conventions

- Each agent labels its output with `agent_id` and `timestamp_ist`.
- An **aggregator agent** collects all agent outputs: trade only when >= 60% of agents agree on direction and none flags a gate failure. Disagreement => NO TRADE.
- Agents share raw fetched JSON via a common file/DB so all score the same snapshot (avoids NSE rate-limit blocks).

## Disclaimer to append to every user-facing message

"Educational analysis based on NSE public data, not investment advice. Options carry high risk; use your own judgment and position sizing."

## Tests (v2.1)

Offline, deterministic, stdlib-only (no network, no new dependencies):

```bash
python3 -m unittest discover -s tests        # from the skill root
```

Covers provenance/freshness gates, news dedup + look-ahead + unverified
handling, 4-of-8 agreement, score-ceiling reporting, decide() thresholds,
trade construction (real LTP, spread/liquidity/RR gates), clock/theta/expiry
gates, backward-compatible output keys, and frozen scorer parity used by
`scripts/backtest_history.py`.

## What must NOT change

- Thresholds **+40 / -40**, component weights, and gate semantics
  (`references/scoring-rules.md`, `references/strategies.md` are frozen).
- `scripts/greeks.py`, `scripts/levels.py`, `scripts/backtest_history.py`
  and the existing `backtest_report.*` / `score_ceiling_audit.*` reports.
- `option_chain_score` / `fii_score` / `breadth_score` signatures and math
  (imported by the backtest).
- Any SMDApp production file: this skill is consumed by Grok only as an
  external research input (`/home/sachin/Desktop/agent_system_prompt.md`).
