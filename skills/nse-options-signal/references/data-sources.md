# Data sources (NSE India)

NSE pages are JS-rendered and protected: requests need browser-like headers + a cookie obtained by first visiting the home page. Endpoints below are the JSON APIs the pages call. NSE changes them occasionally; if one 404s, open the page, DevTools -> Network -> XHR, copy the new URL and update `ENDPOINTS` in `scripts/nse_fetch.py`.
Respect NSE terms of use; poll no faster than once per 60-180 seconds; cache results and share one snapshot across all agents.

| # | Page | API (verify in DevTools) | Use |
|---|---|---|---|
| 1 | /option-chain | /api/option-chain-indices?symbol=NIFTY (also BANKNIFTY, FINNIFTY); /api/option-chain-equities?symbol=RELIANCE | PCR, max pain, OI walls, OI change, IV, LTP per strike |
| 2 | /market-data/oi-spurts | /api/live-analysis-oi-spurts-underlyings and /api/live-analysis-oi-spurts-contracts | Fresh OI build in underlyings/contracts |
| 3 | /market-data/top-gainers-losers | /api/live-analysis-variations?index=gainers and =loosers | Breadth, heavyweight movers |
| 4 | /market-data/volume-gainers-spurts | /api/live-analysis-volume-gainers | Unusual volume confirmation |
| 5 | /market-data/52-week-high-equity-market | /api/live-analysis-data-52weekhighstock | Momentum leaders count |
| 6 | /market-data/most-active-contracts | /api/snapshot-derivatives-equity?index=contracts&limit=20 (or the page's XHR) | Liquid strikes, where traders are active |
| 7 | /market-data/pre-open-market-cm-and-emerge-market | /api/market-data-pre-open?key=NIFTY | Indicative open, gap %, A/D pre-open |
| 8 | https://www.nseindia.com/market-data/closing-auction-session | /api/NextApi/apiClient/casApi?functionName=getCASData (verified 200 JSON) | Closing pressure; carry-forward bias for next day |
| 9 | /reports/fii-dii | /api/fiidiiTradeReact | FII/DII net cash buy/sell |
| 10 | /all-reports-derivatives | Participant-wise OI CSV: https://archives.nseindia.com/content/nsccl/fao_participant_oi_DDMMYYYY.csv | FII index futures long/short, client/pro positioning (end of day, previous session) |

Timing guide (IST): pre-open 09:00-09:08 -> first read 09:30 -> refresh every 5-15 min -> last fresh entry 14:45 -> closing auction 15:40-16:00 (bias for next day).

## Added sources
| # | Source | Endpoint | Use |
|---|---|---|---|
| 11 | Greeks (computed) | derived from #1 via `scripts/greeks.py` (Black-Scholes using NSE's per-strike IV, India VIX from /api/allIndices) | Delta for strike choice, theta cost, IV skew, gamma exposure, expected move |
| 12 | NSE Index Heatmap | /api/heatmap-symbols?type=Broad%20Market%20Indices&indices=NIFTY%2050 (also NIFTY BANK, sectoral) | Market-cap weighted breadth, which sectors/heavyweights drive the index |
| 13 | BSE Index Heatmap (Sensex) | confirm XHR on BSE heatmap page -> BSE_ENDPOINTS['bse_heatmap_sensex'] | Cross-check Sensex vs Nifty leadership |
| 14 | BSE FII derivatives summary | https://www.bseindia.com/markets/derivatives/derireports/fiisummary -> BSE_ENDPOINTS['bse_fii_summary'] | FII buy/sell/OI in BSE derivatives (Sensex/Bankex); confirms or contradicts NSE FII view |
| 15 | India VIX | /api/allIndices (entry "INDIA VIX") | Volatility regime, sizing |

BSE endpoints are not stable/public-documented, so they are left as configurable placeholders. If a BSE source is missing, the agent must treat it as UNAVAILABLE (score 0) and never guess values.

## Provenance (v2.1) - every fetch is stamped

`scripts/nse_fetch.py` writes `snap.meta.provenance` with one record per input:

```json
{"option_chain": {"source": "NSE India", "data_timestamp": "2026-09-25 10:00:00",
                  "fetch_timestamp": "2026-09-25 10:00:00", "status": "LIVE",
                  "attempts": 1, "url": "/api/option-chain-indices?symbol=NIFTY"}}
```

- `status`: **LIVE** (fresh primary), **FALLBACK** (retried/secondary path),
  **STALE** (older than the per-input TTL), **MISSING** (no data/no provable
  timestamp), **UNAVAILABLE** (fetch failed).
- `data_timestamp` comes from the payload when the payload carries one
  (`timestamp`/`time`/`records.timestamp`), otherwise it is explicitly
  marked `data_timestamp=fetch_time` in `detail` - never guessed.
- Section-to-input mapping (`provenance.SECTION_INPUT_MAP`):
  `option_chain -> option_chain`, `all_indices -> vix`,
  `fii_dii -> fii_dii`, `gainers -> gainers`, `losers -> losers`.
- Derived inputs **inherit** option-chain freshness:
  `greeks -> option_chain`, `spot -> option_chain`.
- TTLs: intraday feeds 900s (15 min); closing auction 22h; FII/DII and
  participant OI 36h; news 6h. Core = `option_chain`, `vix`, `greeks` -
  any core input not provably fresh triggers the `DATA_FRESHNESS` gate.

## Normalized `snapshot["groups"]` contract (feeds the 5 optional groups)

`score_signal.py` scores groups 4-6-7-8 from a normalized `groups` object.
Build it from the raw endpoints below (same-session data only) or supply it
from your own tooling; if a key is absent the group scores 0 and counts as
**unavailable** (it never counts toward the 4-of-8 agreement).

```json
{
  "heatmap":  {"weighted_return_pct": 0.0, "pct_weight_green": 0.0,
               "sensex_weighted_pct": 0.0, "top3_share_pct": 0.0,
               "sector_rotation_aligned": false},
  "oi_spurts": {"bullish_weight": 0, "bearish_weight": 0, "total_weight": 0,
                "most_active_bias": -3 | 0 | 3},
  "preopen":  {"gap_pct": 0.0, "ad_ratio": 0.0, "close_auction_bias": -2 | 0 | 2},
  "week52":   {"high_count": 0, "low_count": 0, "heavyweights_at_high": 0,
               "sector_cluster_matching_index": false},
  "heavyweights": [{"symbol": "RELIANCE", "side": "gainer|loser",
                    "volume_spurt": true}],
  "fii_bse":  {"agrees": true}
}
```

Raw sources for these: heatmap endpoints #12-13, OI spurts #2, pre-open #7,
closing auction #8, 52-week highs #5, most-active contracts #6, BSE FII #14.
Never invent a group value: if it cannot be derived from fetched data this
session, leave the key out.

## News input (context layer)

`python scripts/nse_fetch.py --news news.json` attaches an externally
gathered news file to `snap["news"]` (and stamps provenance with
`source: file:<path>`). The skill never fetches or fabricates news itself;
schema and rules: `references/news-schema.md`.

## Source pages (all covered by ENDPOINTS in `scripts/nse_fetch.py`)
- https://www.nseindia.com/option-chain
- https://www.nseindia.com/market-data/oi-spurts
- https://www.nseindia.com/market-data/top-gainers-losers
- https://www.nseindia.com/market-data/volume-gainers-spurts
- https://www.nseindia.com/market-data/52-week-high-equity-market
- https://www.nseindia.com/market-data/most-active-contracts
- https://www.nseindia.com/market-data/pre-open-market-cm-and-emerge-market
- https://www.nseindia.com/market-data/closing-auction-session
- https://www.nseindia.com/reports/fii-dii
- https://www.nseindia.com/all-reports-derivatives
