# Gate Tuning Report — 542 verified closed trades

**Date**: 2026-10-01
**Source**: Trade Audit sidecar (`localhost:4001/api/stats` + `/api/trades?status=closed`) —
same 542-trade book previously summarized in `/tmp/bt-full2.json` (file since lost),
**recomputed after the B2/B3/907 exit repairs** (real closes, no phantom profits).
**Method**: win-rate / net P&L binned by `signalConfidence` and `marketSession` per strategy.

## Headline (post-repair, real numbers)

| Metric | Value |
|---|---|
| Closed trades | 542 |
| Win rate | 50.9% (276W / 266L) |
| Net P&L | **+172.84** (was +11,470 pre-repair — phantoms removed) |
| Profit factor | 1.012 |
| Avg R | −0.101 · Expectancy 0.32 |
| Max drawdown | 8,482 (269.74%) |

## Per-strategy (all confidence buckets)

| Strategy | Trades | WR% | Net | PF | Verdict |
|---|---|---|---|---|---|
| SMART_MONEY | 43 | 67.4 | **+2,059** | 5.21 | **Keep — best book** |
| BTST | 324 | 59.3 | **+3,559** | 1.85 | **Keep** |
| stock-scanner | 4 | 0.0 | 0 | — | n/a (pnl-0 legacy rows) |
| ZERO_HERO_AI | 118 | 39.0 | −725 | 0.87 | Fix gates below |
| SMC | 18 | 22.2 | −294 | 0.30 | Pause / raise floor |
| option-chain-api | 35 | 14.3 | **−4,427** | 0.02 | Historical damage — gates now block it |

## Confidence bins — where confidence actually discriminates

| Strategy | conf<60 | 60–70 | 70–80 | 80+ |
|---|---|---|---|---|
| BTST | 56.5% (138) | 61.4% (127) | 60.0% (50) | 66.7% (9) |
| SMART_MONEY | 38.1% (21) | **94.7% (19)** | **100% (3)** | — |
| ZERO_HERO_AI | 38.1% (97) | 35.7% (14) | 57.1% (7) | — |
| SMC | 14.3% (14) | 50.0% (4) | — | — |
| option-chain-api | 14.3% (35, all conf=0) | — | — | — |

- **SMART_MONEY**: conf ≥ 60 is a genuine discriminator (94.7% vs 38.1%).
- **ZERO_HERO_AI**: confidence barely discriminates — **session does** (below).
- **BTST**: profitable in every bucket; no confidence gate needed.

## Session bins — the real signal

| Strategy | PRE_OPEN | MORNING | MIDDAY | AFTERNOON | CLOSING | POST_CLOSE |
|---|---|---|---|---|---|---|
| ZERO_HERO_AI | **60.5% (+2,494)** | 37.1% (−835) | 0% (−205) | 26.9% (−1,399) | 0% (−25) | 21.4% (−755) |
| option-chain-api | 25% (−181) | 30% (+54) | — | — | — | **0% (17, −4,299)** |
| SMART_MONEY | **74.2% (+2,106)** | 62.5% (−10) | 0% (−18) | — | 33.3% (−19) | — |
| SMC | — | 0% (8) | — | — | — | 40% (−139) |
| BTST | — | — | — | — | — | 59.3% (+3,559)* |

\* BTST `POST_CLOSE` = created after close by design; exited next session — not comparable.

## Gates implemented in this pass

1. **option-chain auto-signal session gate** — `isTradeAllowed()` (market-session
   `allowedActions`) now gates `addTrade` in `src/app/api/option-chain/route.ts`.
   Kills the POST_CLOSE class (0/17, −4,299).
2. **Confidence-0 hole closed** — `/api/trade/register` now rejects option rows
   with confidence 0/missing (`meetsConfidenceFloor`, trade-validator-gate).
   Old check was `conf > 0 && conf < floor`, which admitted every conf=0 row
   (the entire option-chain-api loser set).
3. **Strike-scale guard** — `/api/trade/register` rejects strikes off the
   symbol's scale (`isStrikeOnSymbolScale`): SENSEX-24200-style records now 422.
4. Existing gates confirmed still in place: conf floors 60/70 at the option-chain
   auto-signal, entry ≥ ₹5, SL<entry<TP levels, one-trade-per-underlying lock,
   buy-only rejection (`rejectOptionSelling`), ZH expiry-day eligibility.

## Recommendations (not yet implemented)

1. **ZERO_HERO_AI: session-restrict candidates** — only PRE_OPEN (+2,494) is
   net-positive; AFTERNOON/POST_CLOSE/MIDDAY together are −2,359. Suggest
   surfacing a session badge (or hiding non-PRE_OPEN candidates) in
   `ZeroHeroTerminal.tsx` rather than a hard block — candidates there are
   user-confirmed, not auto-registered.
2. **SMC: pause or floor 60 + drop MORNING** — 18 trades, 22% WR, PF 0.30;
   MORNING sub-book is 0/8. Sample is small; re-evaluate at 50 trades.
3. **SMART_MONEY: keep floor at 60** — conf<60 sub-book is 38% WR despite a
   positive net (lucky tail); conf≥60 is the edge (94.7%).
4. **BTST: no gate changes** — every bin is profitable; the exit-repair work
   (next-trading-day closes, day-2 historical pricing in `closeYesterdayBTST`)
   protects the verification book.
5. **Duplicate `api-` rows** — the option-chain-api set contains repeated
   identical entries (same symbol/strike/expiry ×7). The `alreadyActive` check
   prevents concurrent duplicates; historical ones are one-time damage only.
6. **Re-run this report at n≈1,000 closed** before raising any floor above 65
   (SMC/ZERO_HERO samples are still thin outside their dominant sessions).
