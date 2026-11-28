# Daily Derivatives — Phase 1 Read-Only Audit

**Date:** 2026-11-27 · **Scope:** the existing Daily Derivatives dashboard (NIFTY + SENSEX)
**Method:** read-only inspection (no source file modified) + live verification of both endpoints.
**Verified live at 2026-11-27 12:58 IST** (market open, lunch `low_liq` session).

---

## 1. Existing architecture and data flow

### 1.1 Files

| File | Role | Lines |
|---|---|---|
| `src/app/page.tsx` | Mounts the tab (`viewMode === 'daily'`) — import L46, state L358, mount L1344–1348 | 1,429 |
| `src/components/daily/DailyDerivativesPanel.tsx` | **The entire tab UI** (the only file in `src/components/daily/`) | 1,992 |
| `src/app/api/daily-derivatives/route.ts` | Thin GET wrapper → `DailyDerivativesService` | 46 |
| `src/lib/DailyDerivatives.ts` | **The engine**: types, indicators, bias, confluence, liquidity, reversal role, hold-time, plan builder, service | 4,721 |
| `src/app/api/dd-liquidity-probe/route.ts` | Diagnostic route; only other importer of the engine | 92 |

No cron, agent tool, Hermes tool or Python skill imports `DailyDerivatives.ts`. The feature is
**display-only**: it produces no alert, no ledger row, no `candidate_log` entry.

### 1.2 Data flow

```
GET /api/daily-derivatives?symbol=NIFTY|SENSEX&expiry=&refresh=
  route.ts:27-32  (interval hardcoded "5minute" — route.ts:30)
  └─ DailyDerivativesService.getDailyDerivativesReport  (DailyDerivatives.ts:3774)
       ├─ canonicalGetOptionChain(underlying, expiryISO)      :3792  (2 retries, 1.5s/3s backoff :3793-95)
       │   └─ data-layer/chains/option-chain.ts:578 getOptionChain
       │        └─ market-data-service.fetchMarketData        option-chain.ts:601-609
       │             └─ doFetchOptionChainRace → runOptionChainRace   market-data-race.ts:201
       ├─ fetchCandlesWithFallback(underlying, day, "5minute")  :3828
       ├─ readFuturesFlow(symbol, date)                         :4361
       ├─ getFuturesSnapshot (MO degraded fallback)             :4363
       ├─ getNSEIndiaVIX / resolveVix                           :3975-4005
       └─ buildSellerIntel(chain.strikes)                       :4378-4393
```

No chain data ⇒ `err.status = 503` (`:3798-3803`) ⇒ the route returns **503** (`route.ts:38-44`).
`NO_DATA` is a real, surfaced state. **No Yahoo anywhere** (`api-freshness.ts:19-20`).

### 1.3 Engine pipeline (23 steps, `DailyDerivatives.ts:3774-4673`)

| Step | Lines | What |
|---|---|---|
| 1 | 3782-3786 | single `nowMs` clock |
| 2 | 3788-3803 | option-chain fetch (2 retries); no bhavcopy fallback while the market is open |
| 3 | 3805-3810 | expiry parse + DTE |
| 4 | 3812-3849 | 5-minute candles; walks back up to **4 prior sessions** until ≥30 warm-up bars |
| 5 | 3851-3863 | `candleAgeMs` |
| 6 | 3865-3896 | spot reconciliation: chain spot vs candle close; drift >0.1 % ⇒ candle wins (`spotSource: "candle-close"`) |
| 7 | 3898-3907 | `emaCrossAdxAtr(candles, {adxMin:20})` → last 5 signals (**not day-filtered**) |
| 8 | 3909-3917 | `mapChainStrikes` → per-leg OI/ΔOI/volume/bid/ask/greeks |
| 9 | 3919 | `pcr = totalPutOI / totalCallOI` (all strikes) |
| 10 | 3921-3935 | Max Pain, exhaustive O(n²) |
| 11 | 3937-3942 | call/put walls = **global OI argmax** |
| 12 | 3944-3947 | ATM strike = nearest listed strike to spot |
| 13 | 3949-3956 | `T = max(dte/365, 0.002)`; ATM IV + ATM greeks (`resolveAtmIv`) |
| 14 | 3958-3969 | top-5 call/put OI |
| 15 | 3971-4006 | India VIX: NSE → chain ATM IV → **hardcoded 15.70** (`:4005`, labelled `indiaVixSource:"estimate"`) |
| 16 | 4008 | `getSentiment(vix, pcr)` → label + score |
| 17 | 4010-4052 | chop regime, futures rel-vol, candle-signed CVD |
| 18 | 4054-4078 | `computeDirectionBias` (`:3521`) + `resolvePreferredSide` hysteresis lock |
| 19 | 4080-4349 | **trade plans** (see §5) |
| 20 | 4351-4393 | seller intelligence (DEX/GEX, writer/covering boards, zones) |
| 21 | 4398-4416 | session snapshot, CVD verdict, `recordPcr` (PCR trend, in-memory) |
| 22 | 4418-4439 | OI wall rows + reversal-role candidate band (`max(500, spot×0.01)`) |
| 23 | 4441-4611 | per-card verdict loop: `evaluatePlanTrade` (`:4528`) + `resolvePlanDecision` lock |

### 1.4 UI sections rendered (`DailyDerivativesPanel.tsx`)

header (662) · error banner (686) · **live provenance strip** (688-742: source, freshness badge,
fallback flag, chain timestamp, tape age, greeks source, VIX source+age) · 7 top metric cards
(747-802: spot, VIX, PCR, Max Pain, call wall, put wall, ATM IV) · 4 OI cards (805-830) ·
sentiment + expiry selector (833-881) · **direction-bias card** (884-939: chop/trend badge, RVOL,
vote tiles) · 3 live side feeds (944-1078: FII/DII, institutional, greek-flow — all labelled
"context only · not a call input") · most-active strikes (1084-1118, **NIFTY only**) ·
CVD card (1121-1265) · **trade-plan cards** (1268-1620: entry/SL/TP1-3, badges, reversal-role panel)
· seller intelligence (1623-1802) · top-5 call OI (1805) · top-5 put OI (1824) ·
latest technical signals (1843-1888) · live chain Greeks table (1891-1950) · ATM Greeks detail (1953).

Poll: `/api/daily-derivatives` every **300 s** (L577-580); side feeds once per symbol + on Refresh.
`loadFeeds()` uses `Promise.allSettled` (L507) so a dead side feed never blocks the card.

---

## 2. Available fields — NIFTY vs SENSEX

### 2.1 Live-verified report values (2026-11-27 12:58 IST)

| Field | NIFTY | SENSEX |
|---|---|---|
| `spot` / `spotSource` / `spotDriftPct` | 25693.45 / `chain` / 0.011 % | 83618.20 / `chain` / 0.022 % |
| `dataSource` / `freshness` | **BREEZE / LIVE** | **BSE / FRESH** |
| `chainTimestamp` | 2026-11-27T07:28:24.917Z (12:58 IST) | 2026-11-27T07:28:44.229Z |
| `indiaVix` / source / age | 16.5 / `nse` / 163 s | 16.5 / `nse` / 164 s (same NSE VIX — no BSE VIX) |
| `pcr` / `maxPain` | 0.716 / 25750 | 0.770 / 83900 |
| `callWall` / `putWall` | 26000 / 25700 | 84000 / 80000 |
| `atmStrike` / `atmIV` / `atmGreeksSource` | 25700 / 12.51 % / **`bs`** | 83600 / 15.03 % / **`bs`** |
| `candleSource` / interval / count / age | breeze / 5minute / 44 / 523 s | breeze / 5minute / 44 / 524 s |
| `directionBias.side` / conf | **PUT / 80** | **NEUTRAL / 0** |
| `chopRegime.chop` | true | true |
| trade plans | PE 25700 + CE 25700, both **WAIT**, 2 lots | CE 83600 + PE 83600, both **WAIT**, 2 lots |
| `cvd.mode` / delta% | `FUTURES_CANDLE_SIGN` / −2.84 % | `FUTURES_CANDLE_SIGN` / −40.96 % |
| `futuresRelVol.ratio` | 0.559 | 0.299 |
| `marketSession` | `low_liq` (lunch), open | `low_liq` (lunch), open |

### 2.2 Structural NIFTY vs SENSEX differences

| Aspect | NIFTY | SENSEX | Source |
|---|---|---|---|
| Chain provider | NSE primary | **BSE primary** | `data-layer/chains/option-chain.ts:30-37` |
| Chain fallback order | Breeze → MO → NSE → BSE | Breeze → MO → **BSE** → NSE | `option-chain.ts:597-609` |
| Greeks | provider **dropped**, BS-derived | BSE publishes IV only → BS delta | `option-chain.ts:472` |
| Candles | Breeze → MO (daily-only skip) → NSE index chart | Breeze → MO (skip) → **NSE chart unsupported** (BSE index) | `market/candle-chain.ts:48-60, 265-273` |
| Candle depth | up to 4 prior sessions | fewer sources ⇒ thinner history ⇒ longer "warming up" | `DailyDerivatives.ts:3825-3845` |
| Futures ΔOI | real (`FUT-NIFTY-*`) | **BFO futures OI = 0 ⇒ ΔOI stays UNKNOWN** | `market/futures-flow.ts:19` |
| Lot size | **65** | **20** | `symbol-config.ts:119, 155` |
| Most-active table | shown | **hidden** (NSE feed is NIFTY-only) | `DailyDerivativesPanel.tsx:1104-1107` |
| India VIX | NSE INDIA VIX | **same NSE VIX** (NIFTY's) | `DailyDerivatives.ts:3975` |

---

## 3. Data-provider and field-availability matrix

### 3.1 Option chain — provider order

Race order is fixed in `market-data-race.ts:93-99`; timeouts `:101-111`; exchange filter `:221-225`.
Off-hours, broker feeds are dropped entirely (`market-data-service.ts:573-582`).

| # | Provider | Endpoint | NIFTY | SENSEX | Timestamp | Failure behaviour |
|---|---|---|---|---|---|---|
| 1 | **ICICI Breeze** | `GET /breezeapi/api/v1/optionchain` (`icici-breeze/option-chain.ts:35-192`) | ltp, OI, ΔOI, volume, IV, BS greeks | same | ⚠️ **our collection time** (`icici-breeze/option-chain.ts:180`) — passed as `providerTimestamp` (`market-data-providers.ts:518`) ⇒ a stalled response still reads LIVE | retry ×2, then next provider |
| 2 | **MOAPI** | REST v3 (`motilal-option-chain.ts:142`) | ltp only; OI/volume/IV/greeks **hard-zero** (`:360-373`) | same | `undefined` ⇒ capped FRESH | next provider |
| 3 | **NSE** | `option-chain-v3` via `nse-api.ts` | ltp, OI, ΔOI, volume, IV, **published greeks** | ✗ (filtered out) | `records.timestamp` — **real exchange stamp** | next provider |
| 3b | nse-mcp | MCP probe | fail-closed by default (`market-data-providers.ts:676-678`) | — | — | — |
| 4 | **BSE** | `DerivOptionChain_IV/w` (`bse-api.ts:181`; SENSEX scrip 1, BANKEX 12) | ✗ (filtered out) | ltp, OI, ΔOI, volume, IV | `undefined` ⇒ capped FRESH | next provider |
| 5 | **Moneycontrol** | — | **never in the race** (`market-data-race.ts:93-99`); supplementary only | — | — | — |
| — | bhavcopy EOD | NSE/BSE archives | EOD — **only when the market is closed** | — | EOD | blocked while open (`option-chain.ts:656-698`) |
| — | MO websocket | `feed.py:86-117` (LTP + OI + 5-level depth) | **available but not wired** into the chain adapter | — | feed ts | — |

Reliability weights: `api-freshness.ts:21-30` (breeze 0.95, mo 0.90, nse 0.85, bse 0.80).

### 3.2 Per-leg field availability

| Field | Breeze | MOAPI | NSE | BSE | In DD report? |
|---|---|---|---|---|---|
| LTP | ✓ | ✓ | ✓ | ✓ | ✓ |
| OI | ✓ (÷lot to contracts) | ✗ zero | ✓ | ✓ | ✓ |
| Change in OI | ✓ `chnge_oi` | ✗ | ✓ `changeinOpenInterest` | ✓ `C_Absolute_Change_OI` | ✓ |
| Volume | ✓ | ✗ zero | ✓ | ✓ | ✓ (0 for MO) |
| IV | ✓ | ✗ (premium-inverted) | ✓ | ✓ (2 dp) | ✓ — but **no `ivSource` field**, so an inverted IV is indistinguishable from a published one |
| **Bid / ask price** | published (`best_bid_price`) | depth available | published (`buyPrice1/sellPrice1`, **never read**) | published (`BidPrice/OfferPrice`) | **❌ always null** — every adapter drops it |
| **Bid / ask qty** | published (`best_bid_qty`) | depth available | published (`buyQuantity1/…`, **never read**) | ✗ | **❌ never captured anywhere** |
| Greeks ΔΓΘV | BS only | ✗ | **published but dropped** by `ChainLeg` | BS from IV | ⚠️ always `deltaSource:"bs"` |
| rho | ✗ | ✗ | ✓ only | ✗ | ✓ |
| Per-leg IV change | ✗ | ✗ | ✗ | ✗ | **❌ unavailable from every provider** |

**Verified:** the adapters omit bid/ask entirely — Breeze `leg()` (`market-data-providers.ts:36-46`),
NSE (`:103-127`), BSE (`:350-351`), MO (`:441-442`). `ChainLeg` *has* optional `bid?/ask?`
(`market-data-race.ts:35-43`) but nothing populates them.

DD then converts a missing book to a **zero price**: `bid: Number(raw.bid) || 0`
(`DailyDerivatives.ts:195-196`) — "no book" reads as a zero-price book.

### 3.3 Chain-level fields

`spot`, `expiry`, `expiries[]` (the exchange's real contract list, `option-chain.ts:625-627`),
`providerTimestamp`, `fetchedAt`, `source`, `freshness` (`option-chain.ts:617-634`).
**No chain-level aggregate ΔOI** — every consumer re-sums per-strike values.

### 3.4 Futures

| Provider | Instrument | OHLCV | Per-bar OI | ΔOI | Source |
|---|---|---|---|---|---|
| **Breeze** | nearest index future (NFO/BFO) | ✓ real (1m/5m/15m) | ✓ real | ✓ real | `market/futures-flow.ts:181-256` |
| Breeze | index **spot** | ✓ OHLC, **volume = 0** | ✗ | ✗ | `index-futures-candles.ts:4-8` |
| MOAPI | index future | ⚠️ day volume only | ✗ (`openInterest` = 0 → null) | ✗ | `motilal/market.ts:29-38, 119-134` |
| MOAPI | intraday futures series | ✗ none (EOD only) | ✗ | ✗ | `futures-flow.ts:17-18` |
| NSE | index chart | ⚠️ close-only → flat bars, vol 0, degraded | ✗ | ✗ | `market/candle-chain.ts:156-171, 265-289` |
| BSE/BFO | SENSEX future | ✓ (via Breeze) | ⚠️ **OI = 0 ⇒ ΔOI UNKNOWN** | ✗ | `futures-flow.ts:19` |

**No futures VWAP and no futures basis are computed anywhere**; the DD's only futures VWAP is the
spot-candle VWAP (which is a close-average — see §5).

### 3.5 Candles

| Provider | Instruments | Intervals | OHLC | Volume | Notes |
|---|---|---|---|---|---|
| Breeze | NSE + BSE indices, F&O stocks | 1m / 5m / 15m | ✓ | ✓ stocks/futures, **0 for index spot** | `candle-chain.ts:88-89` |
| MOAPI | indices + stocks | **EOD daily only** | daily | ✓ | intraday ⇒ capability skip (`candle-chain.ts:216-221`) |
| NSE chart | NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY only | derived from point spacing | ⚠️ close-only flat bars | 0 | current session only, `degraded` |
| BSE | SENSEX/BANKEX spot | — | spot derived from the live chain `UlaValue` | 0 | `GetSensexDatanew` dead since ~2026-09 |

DD uses **5-minute only** (route hardcodes it). **1-minute candles are never used.**

---

## 4. Source timestamps and actual data freshness

### 4.1 Freshness classification

`api-freshness.ts:33-51` — `optionChain`: **LIVE ≤ 30 s · FRESH ≤ 180 s · DELAYED ≤ 600 s ·
else STALE.** Timestamp extraction `:64-81` reads `records.timestamp`, `records.TimeVal`,
`timestamp`, `lastUpdate`, `lastUpdateTime`, `TimeVal`, `tradeDate`, `ASON.DT_TM`.
An **undated payload is never "now"** — it is capped at FRESH (`:94-98`).

DD gates: `LIVE_CHAIN_QUALITIES = {LIVE, FRESH}` (`DailyDerivatives.ts:1598`); DELAYED/STALE ⇒
`qualityWait` (`:2837`). `CANDLE_STALE_MS = 15 min` (`:1605`) ⇒ quality wait (`:2845`).
`VIX_STALE_MS = 10 min` (`:1613`) ⇒ VIX falls back to the chain ATM IV.

### 4.2 Live-observed freshness (2026-11-27 12:58 IST)

| Item | NIFTY | SENSEX | Verdict |
|---|---|---|---|
| Chain | BREEZE, LIVE, stamp 12:58:24 IST | BSE, FRESH, stamp 12:58:44 IST | NIFTY's LIVE is a **self-generated clock** (see below) |
| Candles | breeze 5m, 44 bars, 523 s old | breeze 5m, 44 bars, 524 s old | OK (5m bars) |
| VIX | nse, 163 s old | nse, 164 s old | OK (same index for both) |
| Futures rel-vol | bar 12:50, ratio 0.559 | bar 12:50, ratio 0.299 | OK |
| Spot reconciliation | drift 0.011 % | drift 0.022 % | below the 0.1 % threshold → chain spot retained |

### 4.3 Freshness defects

1. **Breeze chains are stamped LIVE on our own clock** (`icici-breeze/option-chain.ts:180` →
   `market-data-providers.ts:518`), violating the service's own rule
   (`market-data-service.ts:12`: "Never claim LIVE without a verifiable provider timestamp").
2. **BSE/MO chains are undated ⇒ capped FRESH** — indistinguishable from a 179-s-old chain
   (`market-data-service.ts:373`). SENSEX can never be LIVE.
3. **`candleAgeMs` measures the newest bar across the stitched history**, not whether the current
   session is still feeding (`DailyDerivatives.ts:3856-3863`). A feed that stops after the prior
   session's last bar can look fresh.
4. **The seller-intel freshness check is a no-op**: `current.timestamp` is set to `nowMs` at build
   time (`seller-intelligence.ts:602`), so the 15 s check at `:229-231` can never fire.
5. **No CVD age on the card** — the panel shows the contract + source + bars but no timestamp.
6. `report.timestamp` is **collection time, not market time** (`DailyDerivatives.ts:4615`); the panel
   renders it under "Spot" as the IST clock (`panel:753`) — misleading.
7. `computeDirectionBias` and `resolvePreferredSide` re-read `Date.now()` (`:4058`, `:4067`) —
   two later clock reads despite the stated one-clock rule (`:3783-3786`).

---

## 5. Existing calculation methods and their reliability

### 5.1 The trade-plan ladder — **fixed %, not market-derived** (highest-severity finding)

DD builds its card ladder through one call, `DailyDerivatives.ts:4095-4100`:

```ts
const plan = buildOptionPlan({ symbol: underlying, optionType: sel.optionType,
                               entryPremium: sel.entry, lotSize });
```

It passes **no `deployedAmount`, no `lots`, no `riskAmount`**. Inside `option-plan.ts:245-293`:

- `wantedRisk = actualDeployed × 0.20` and `actualDeployed = entry × units`
  ⇒ `riskPoints = 0.20 × entry` — a **constant 20 % stop on the premium**, for every strike and symbol.
- `targets = entry + {2R, 3R, 4R}` ⇒ **+40 % / +60 % / +80 % of premium**.
- `rr ≈ 2.00` by construction.

**Live confirmation** (NIFTY, 12:58 IST):

| Leg | Entry | Stop | % | TP1 | % | TP2 | % | TP3 | % |
|---|---|---|---|---|---|---|---|---|---|
| PE 25700 | 172.00 | 137.60 | −20.0 | 240.80 | +40.0 | 275.20 | +60.0 | 309.60 | +80.0 |
| CE 25700 | 142.90 | 114.30 | −20.0 | 200.05 | +40.0 | 228.65 | +60.0 | 257.20 | +80.0 |

Exactly as derived. Consequences:
- A ₹40 premium and a ₹400 premium get identical *percentage* stops with wildly different ₹-risk
  and very different probability-of-touch.
- **No ATR, no IV, no delta, no structure is used to set the card's SL/TP.**
- `buildStructureOptionPlan` (`option-plan.ts:406-541` — the delta-mapped, underlying-structure
  stop) **exists and is used by `intraday-scanner.ts`, but not by DD.**

### 5.2 The reversal role — a *second, different* geometry on the same card

`evaluateReversalRole` (`:2149`) computes a structure/BS-based ladder: underlying stop/target from
the candle signal, premium re-priced by Black-Scholes, its own `optionRR`, and its own sizing
(`:2466-2474`: `lots = min(2, max(0, min(lotsByRisk, lotsByAffordability)))`).

It renders **beside** the card's fixed-% ladder (`panel:1420-1450` vs `1557-1559`) → **two
different R:R numbers and two lot counts on one card**. The role's numbers never overwrite the
card's, and the role's recommended strike is not the card's strike.

The role applies **only to REVERSAL / FAKEOUT** setups (`:2112`, `:4524-4526`); BREAKOUT /
PULLBACK / RETEST cards bypass it entirely and keep the legacy trend-buyer verdict.

### 5.3 Direction and positioning

| Calculation | Method | Reliability |
|---|---|---|
| **Side decision** | `computeDeskSide` (`:1236`) — the newest *fresh* candle setup + EMA9/15 corroboration only | sound, but narrow: **two** inputs |
| **Directional bias votes** | PCR / Max Pain / OI shift / Sentiment are all marked `counted: false` (`:3545-3552`) | ⇒ `callVotes`/`putVotes` are **structurally 0/0**; the panel's "tape X CE vs Y PE" tally counts nothing |
| **PCR** | `totalPutOI / totalCallOI` over **every** strike (`:3919`); 0 (not null) when call OI = 0 | no ATM band, no OI-band scoping |
| **PCR trend** | in-memory ring of 12 readings, ±2 % band vs a reading ≥3 min old (`:1130-1153`) | **lost on restart**; process-local |
| **Max Pain** | exhaustive O(n²) (`:3921-3935`); ties → lowest strike | correct method; O(n²) runs every poll |
| **Call/put walls** | **global OI argmax** over all strikes (`:3937-3942`) | ⚠️ **materially weaker** than the agent path's windowed, liquidity-filtered, trend-aware walls (`option-chain-reader.ts:185-194`) — no ±% spot window, no share-of-side test, no ΔOI trend |
| **OI build-up classification** | `seller-intelligence.ts:155-165`: ΔOI% vs premium% at ±2 % | inference, not fact; first fetch of the day has **no premium baseline** (`NO_PREMIUM_BASELINE`) |
| **Writing vs buying (per strike)** | `option-chain-reader.ts:121-127` (OI↑+prem↑ = BUYING, OI↑+prem↓ = WRITING …) | **the canonical classifier — agent path only; DD does not use it** |
| **DEX / GEX** | `seller-intelligence.ts:186-192`, `gex-engine.ts:6-29` | ⚠️ DEX uses `oi × lotSize` (double-counts if OI is contracts); GEX has an unexplained `0.01` scale factor |
| **TP achievability vs walls** | `option-plan.ts:754-841`: premium→spot via \|Δ\|; wall = OI ≥ 2.5× median of the opposing ladder; Δ fallback 0.50 (labelled) | reasonable; the wall definition is the naive one above |
| **Sentiment score** | base 50 ± VIX band ± PCR band (`:3492-3514`) | uses the same two inputs the (uncounted) votes use |

### 5.4 Technical indicators

| Indicator | Where | In DD? |
|---|---|---|
| EMA **9/15** | `DailyDerivatives.ts:469-471`, `:523-534` | ✅ **the DD trend — 9/15, not 9/20/50** |
| ATR 14 (session-aware) | `:555-574` | ✅ |
| ADX 14 + DI+/DI− | `:576-620` | ✅ (`adxMin:20`, `adxMinCross:15` — tuned on real 5m NIFTY, 0/3 raw crosses cleared ADX ≥ 20) |
| VWAP | `:4364-4375` | ⚠️ **index spot candles have volume = 0 ⇒ falls back to a simple close-average** (`:4374`), unlabelled. The seller-intel "CE above VWAP / PE below VWAP" gate therefore runs on a non-VWAP |
| Classic pivots (P, R1, S1) | `tech-read.ts:500-503` | ✅ (reversal role only) |
| Structure HH/HL, BOS, CHoCH | `tech-read.ts:261-281` | ✅ (reversal role only) |
| Liquidity pools + sweeps | `tech-read.ts:292-359` | ✅ (reversal role only) |
| RSI | — | ❌ **absent from DD** (`ml-engine.ts:30` simple-average; `indicators.ts:71` Wilder) |
| EMA 20 / 50 / 200 | — | ❌ absent from DD |
| SuperTrend | `tech-read.ts:168-190` | ❌ absent from DD (agent path only) |
| Bollinger / MACD | `ml-engine.ts` | ❌ absent from DD |
| FVG | `tech-read.ts:361-378` | ❌ **computed but never imported by DD** |
| Volume profile POC/VAH/VAL | `auction-engine.ts`, `imie/auction.ts` | ❌ absent from DD |
| Realised volatility | `volatility-engine.ts`, `quant-features.ts` | ❌ absent from DD (only implied 1σ is used) |
| Breadth | `/api/market/breadth` | ❌ absent from DD (panel side-feed only) |
| FII/DII | `fii-dii.ts` | ❌ panel side-feed only, labelled "context only" |
| IV percentile / rank | — | ❌ **not present anywhere in DD**; the expiry-liquidity engine returns hardcoded `0`, `sdm-engine.ts:1509` returns fabricated `50` |
| 1-minute timeframe | — | ❌ never used |

### 5.5 CVD — an approximation, and correctly labelled

`computeCandleCvdProxy` (`engines/orderflow/orderflow-engine.ts:138-149`) signs the **entire bar's**
volume by its candle direction. The futures path is the same
(`mode: "FUTURES_CANDLE_SIGN"`, `market/futures-flow.ts:227-243`).

A **genuine** aggressor-side implementation exists (`computeOrderFlow`,
`orderflow-engine.ts:219-315`, using `Trade.isBuyerMaker`) but **has no caller** — no index has a
tick-level tape.

CVD is **locked out of every vote** (`:1168-1170`, `:1565-1569`, `:1788-1790`, `:2902-2903`,
`:3111-3119`) and the panel labels it "Display only — it never votes on direction". The honest
breakout detector is **futures relative volume + ΔOI** (`futures-flow.ts:11-19`).

### 5.6 Greeks and IV

| Item | Value | Source |
|---|---|---|
| Risk-free rate | **7 %** (`greeks.ts:19`), env-overridable via `RISK_FREE_RATE` | not market-linked |
| Dividend yield | **not modelled** (`greeks.ts:68`) | systematic BS bias for dividend-paying underlyings |
| Theta | per day; vega per 1 % IV | `greeks.ts:175, 180-184` |
| Provider Greeks | **always dropped** ⇒ every DD Greek is BS-derived | `market-data-race.ts:35-43` |
| ATM IV | the **call leg only** (`resolveAtmIv`, `:236-242`) | no put-call parity check |
| IV units | chain IV is **percent**, `impliedVolFromPremium` returns **decimal** — a documented double-scale hazard | `DailyDerivatives.ts:217-227` |
| `T` floor | **two different floors**: `greeks.ts:239` (0.5 d) vs `option-chain.ts:164` (0.002 yr) vs DD `:3955` (0.002 yr) | |

### 5.7 Confidence

- The headline "% conf" is a **3-value band**: `DESK_AGREE_CONFIDENCE = 80`,
  `DESK_SINGLE_CONFIDENCE = 70`, `DESK_COUNTER_TREND_CONFIDENCE = 55`, `0` for no side
  (`:1215-1219`) — derived from **one fresh candle setup + EMA cross**.
- `TradePlanCard` has **no confidence field at all** (`:76-118`).
- No win probability is claimed anywhere (0 hits for probability/win-rate). ✅ consistent with the
  spec's Phase 5 requirement — but it also means the confidence is not evidence-weighted.

---

## 6. Historical snapshot availability and limitations

### 6.1 The `market-history` sidecar — **rich but not consumed by DD**

| Table | Content | Note |
|---|---|---|
| `market_snapshots` | per-symbol snapshot; full JSON payload + spot/futures/india_vix/pcr_oi/pcr_vol/max_pain/iv/atr/vwap/volume/breadth/features/ai_scores | `market-history/src/db/index.ts:18-31` |
| `chain_ticks` | **one row per strike per side**: ltp, oi, oi_chg, iv, delta, theta, gamma, vega, volume, expiry | `:34-44` — **no bid/ask columns**, so the book can never be reconstructed retrospectively |
| `candles`, `smc_events`, `evaluation_results` | — | `:48-76` |
| provenance columns | provider_timestamp, collected_at, source, freshness, is_estimated | `:103-113` (additive) |

- **Recorder:** systemd timer, every market minute 09:15–15:30 IST; NORMAL 60 s, WEEKLY_EXPIRY
  60 s, MONTHLY_EXPIRY 30 s; symbols NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX
  (`market/recorder-config.ts`, `market-recorder/tick.sh`).
- **Retention:** 30-day rolling, monthly reset, archive-first (`VACUUM INTO` + gzip), rollup into
  `chain_5m` before delete, integrity check (`market-history/src/db/retention.ts:49, 130-228`).
- **DD does not read it** — no import in `DailyDerivatives.ts`. The archive is consumed by
  OIChangePanel / OIFlowView / option-buyer / the :4002 sidecar.

### 6.2 What DD uses as "history" instead

- **PCR trend:** a 12-entry in-memory ring (`:1130-1153`) — **lost on restart**.
- **Seller-intel baseline:** an in-process `baselineRing` keyed (symbol, strike, type, day)
  (`seller-intelligence.ts:571-581`) — the first observation of the day is the baseline, so
  **premium % change and IV % change read 0 until the next fetch of the same day**
  (`:250-251, 611-615`). `previousOI` is derived from the exchange ΔOI, not a second snapshot (`:567`).
- **Plan snapshot:** a module-level Map keyed `underlying|expiry` (`:4187`, TTL 10 min, drift 0.15 %)
  — unbounded, per-process, and **not invalidated by a change in the chain's strike set**.
- **Hysteresis locks** (★ side, decision lock): module-level, process-local (`:1128`, `:1322`, `:3161`).

### 6.3 Consequences for the spec's snapshot requirements (Phase 2C)

| Required | Available today? |
|---|---|
| 1/3/5/15/30-min interval changes in strike-wise OI | ✅ **in `chain_ticks`** — but DD doesn't query it, and the recorder runs at 60 s/30 s |
| Premium / volume / IV changes over intervals | ✅ in `chain_ticks` (except bid/ask) |
| IV **change** per interval | ⚠️ derivable from two `chain_ticks` rows |
| PCR / Max Pain over intervals | ✅ `market_snapshots.pcr_oi`, `.pcr_vol`, `.max_pain` |
| Futures price + OI over intervals | ⚠️ `market_snapshots.futures` — but **BFO OI = 0 for SENSEX** |
| Expiry/reference-price alignment | ✅ `chain_ticks.expiry` exists; **reference price is not stored per tick** |
| Bid/ask history | ❌ **no columns** — permanently unavailable even after the adapters are fixed |

---

## 7. Missing data required for better analysis

### P0 — data that **exists** but is discarded before DD sees it

| # | Field | Where it exists | Where it is lost |
|---|---|---|---|
| 1 | **Bid / ask price** | Breeze `best_bid_price`/`best_offer_price` (`icici-breeze/option-chain.ts:123-124`); BSE `BidPrice`/`OfferPrice` (`bse-api.ts:225-226`); MO 5-level depth (`feed.py:106-117`); NSE v3 `buyPrice1/sellPrice1` | all four adapters (`market-data-providers.ts:36-46, 103-127, 350-351, 441-442`) |
| 2 | **Bid / ask quantity** | Breeze `best_bid_qty`/`best_offer_qty` (read only by `/api/orderbook`); MO depth; NSE v3 `buyQuantity1/sellQuantity1/totalBuyQuantity` | never read by the chain path |
| 3 | **NSE published Greeks** | `row.CE.greeks.*` | `ChainLeg` (`market-data-race.ts:35-43, 121-131`) |
| 4 | **MO websocket OI + depth** | `motilal/service.ts:300-318, 341-370` | chain adapter never calls it |
| 5 | **MO OI/volume/IV/greeks** | the MO payload shape | zeroed by `motilal-option-chain.ts:360-373` |

**Consequence:** DD's own comment "NO provider in the chain exposes a book"
(`DailyDerivatives.ts:1715-1717`) is now **factually wrong** — the providers expose it, the adapters
discard it. Because of this, `evaluateLegLiquidity` (`:1732-1749`) always returns `UNVERIFIED`,
the `MAX_SPREAD_PCT = 8` gate (`:1694`, `:3030`) is **dead code**, and every card's liquidity badge
is "?".

### P1 — not obtainable from any provider (needs derivation or honest absence)

| # | Field | Status |
|---|---|---|
| 6 | **Aggressor-side CVD / genuine delta** | ✗ no tick-level tape for any index. The real implementation (`orderflow-engine.ts:219-315`) has no caller |
| 7 | **Per-leg IV change** | ✗ no provider publishes it; derivable from `chain_ticks` over time only |
| 8 | **IV percentile / rank** | ✗ real implementation exists only on the FNO path (`breeze-fno-data.ts:160`); DD has none |
| 9 | **Index spot volume** | ✗ 0 for index spot on every provider ⇒ spot VWAP is a close-average |
| 10 | **Futures VWAP / futures basis** | ✗ not computed anywhere (derivable from Breeze futures candles) |
| 11 | **SENSEX futures ΔOI** | ✗ BFO OI = 0 ⇒ permanently UNKNOWN (`futures-flow.ts:19`) |
| 12 | **1-minute option chain** | ✗ no provider serves a 1m chain; 1m *candles* exist (Breeze) |
| 13 | **Realised volatility / volume profile / breadth** | ⚠️ computable in-repo (`volatility-engine.ts`, `auction-engine.ts`, `/api/market/breadth`) but not wired into DD |
| 14 | **Live dividend yield / risk-free rate** | ✗ 7 % hardcoded, no dividend term (`greeks.ts:19, 68`) |

### P2 — correctness / provenance defects

| # | Issue |
|---|---|
| 15 | Breeze chains stamped LIVE on our own clock (`icici-breeze/option-chain.ts:180`) |
| 16 | No `ivSource` field ⇒ an inverted IV is indistinguishable from a published one |
| 17 | `bid: Number(raw.bid) \|\| 0` turns "no book" into a zero-price book (`DailyDerivatives.ts:195-196`) |
| 18 | Two R:R floors in force — DD hard-codes 1.5 (`:2814`) while the house gate is 2 (`GATE_CONFIG.minOptionRR`), and the plan builder only *notes* it (`option-plan.ts:301-303`); DD even strips that note (`:4104-4106`) |
| 19 | The 13:00 late-option-buy gate is **not enforced** in DD — `allowedActions` appears **0** times in `DailyDerivatives.ts`; `BRAIN_FLAGS.noOptionBuysAfter13` is `false` and **dead** (`brain-flags.ts:23`, no readers). **DD can print TAKE at 13:30 IST** |
| 20 | **No account-level risk envelope in DD** — no daily/weekly/monthly loss cap, no loss-streak rule, no concurrent-exposure check. DD imports neither `risk-management.ts` nor any veto module |
| 21 | `signal-veto.ts` **no longer exists** (removed at the user's direction; pinned by `tests/discipline-wiring.test.ts:7`) — so there is no central veto to hook into; DD remains display-only |
| 22 | `latestSignals` can carry prior-day setups (`signals.slice(-5)` is not day-filtered, `:3905`); the UI shows them raw (`panel:1867`) |
| 23 | `trading-knowledge.ts:492-497, 511-522` still teaches the replaced model ("capped at ₹2,000", "account is ₹25,000", "₹4,000 daily loss cap") and `tests/knowledge-risk-rules.test.ts:38-49` **asserts** those stale strings |
| 24 | Stale module header: `data-layer/chains/option-chain.ts:6-10` still describes an NSE/BSE-first order; the implementation is the Breeze-first race |
| 25 | The route's error classification is regex-based (`/unavailable\|NO_DATA\|failed/i`) — any message containing "failed" becomes a **503**, masking genuine 500s |
| 26 | **No request timeout on the route** — chain retries (~4.5 s) plus up to 5 session candle fetches, with no overall budget |
| 27 | The panel does not surface `spotSource` / `spotDriftPct` (computed at `:3886-3896`, never rendered) |
| 28 | No `AbortController` on the primary report fetch (`panel:539`) — only the side feeds are abortable |
| 29 | The DD **signal engine consumes the still-forming candle** (`:3903`, no `closedOnly`) while the reversal role does not (`tech-read.ts:51`) |
| 30 | Two parallel sizing formulas: `option-plan.ts:185` (floor 1) vs `DailyDerivatives.ts:2473` (floor 0) — a second, undocumented 0-lot path |
| 31 | `selectStrike`'s `budget` parameter is dead (`option-plan.ts:666`) while the file comment still claims a budget skip (`:554-555`) |
| 32 | The panel hard-codes "2 lots default" (`:1275`) and "θ ≤6 %" (`:1506`) in prose instead of deriving them from `PLAN_CONFIG` / `REVERSAL_ROLE_GATES` |

---

## 8. Files that would need modification

### 8.1 Data collection (Phase 2) — carrier files only, no new modules

| File | Change | Risk |
|---|---|---|
| `src/lib/market-data-race.ts` | carry `bid/ask` + provider greeks through `ChainLeg` (`:35-43`) | low — additive optional fields |
| `src/lib/market-data-providers.ts` | populate bid/ask in all four adapters; read NSE v3 `buyPrice1/sellPrice1` + quantities; pass NSE greeks through | **medium** — the race winner changes shape; the spread gate would start firing |
| `src/lib/data-layer/types.ts` | add `ivSource` + `bidQty`/`askQty` to the leg schema (`:32-49`) | low — additive |
| `src/lib/data-layer/chains/option-chain.ts` | propagate the new fields; fix the stale header (`:6-10`); carry `bid/ask` into the memo path (`:557, 667-698`) | low-medium |
| `src/lib/icici-breeze/option-chain.ts` | stop stamping our collection time as the provider timestamp (`:180`) | **medium** — Breeze chains would stop being "LIVE", which changes the DD freshness gate outcome |
| `src/lib/motilal-option-chain.ts` / `src/lib/motilal/market.ts` | stop zeroing MO OI/volume/IV/greeks (`:360-373`) where the payload actually carries them | medium — changes MO from "price-only" to "real" |
| `src/lib/market-history/src/db/index.ts` | add `bid`/`ask` columns to `chain_ticks` (additive `ALTER TABLE`, per the existing `:103-120` pattern) | low — additive migration |
| `src/lib/market-history/src/db/retention.ts` | no change (rollup already handles `chain_5m`) | none |

### 8.2 Analysis engine (Phase 3)

| File | Change | Risk |
|---|---|---|
| `src/lib/DailyDerivatives.ts` | the whole pipeline: structure/ATR/IV-based ladder, IV/realised-vol inputs, independent CE/PE evaluation, data-quality gate, invalidation level | **high** — the core file; must keep every existing export and test |
| `src/lib/option-plan.ts` | add a structure/ATR-based plan builder for DD (or extend `buildStructureOptionPlan`, already present at `:406-541`) | medium-high — shared by the scanner |
| `src/lib/tech-read.ts` | expose RSI / EMA 20-50 / ATR / SuperTrend for the DD path (already present for the agent path) | low — additive exports |
| `src/lib/indicators.ts` | re-export only (it already re-exports `tech-read`) | low |
| `src/lib/greeks.ts` | optional: live risk-free rate / dividend yield | medium — changes every Greek |
| `src/lib/seller-intelligence.ts` | use a real book; wire the canonical `option-chain-reader` classifier; fix the `dataFresh` no-op (`:602`) | medium |
| `src/lib/option-chain-reader.ts` | make the windowed/trend-aware walls reusable by DD (it is currently agent-only) | low-medium — agent path must not regress |
| `src/lib/risk-management.ts` | expose a DD-consumable risk envelope (daily/weekly caps, streak, concurrency) | low — additive |
| `src/lib/market-session.ts` | apply `allowedActions` / the 13:00 rule inside DD | low |
| `src/lib/api-freshness.ts` | per-provider timestamp trust (Breeze collection-stamp ≠ provider stamp) | medium |
| `src/lib/market/futures-flow.ts` | compute futures VWAP + basis; surface the SENSEX ΔOI-unknown state explicitly | medium |

### 8.3 Presentation (Phase 4)

| File | Change | Risk |
|---|---|---|
| `src/components/daily/DailyDerivativesPanel.tsx` | new sections: market overview, CE-vs-PE comparison, evidence table, data-quality/missing-data warnings, plain-language WHY/WHY-NOT/invalidation | medium — the file is 1,992 lines; the panel's local type mirrors must be updated |
| `src/app/api/daily-derivatives/route.ts` | expose the new report fields; add a request budget/timeout | low |
| `src/lib/trading-knowledge.ts` | refresh the stale risk strings (`:492-497, 511-522`) — *only if the knowledge base is in scope* | low-medium |
| `tests/knowledge-risk-rules.test.ts` | update the assertions that pin the stale strings (`:38-49`) | low |

### 8.4 Tests (Phase 6)

Existing DD test files (**235 tests, all passing**):
`daily-derivatives-atm-iv` · `-bias-hold` (1,032 L) · `-core-logic` · `-greeks` · `-session` ·
`-setups` · `dd-desk-side` · `dd-direction-chop` · `dd-freshness-gate` · `dd-reversal-role` ·
`dd-wall-geometry` · `option-plan-reach` · `option-plan-reanchor`.

Note: several are **source-text regex** assertions rather than behavioural tests
(e.g. `daily-derivatives-session.test.ts` greps the `.tsx`). The DD `buildOptionPlan` call at
`:4095` is **never executed by a test with DD's exact arguments** ⇒ the degenerate
"always 2 lots, always −20 %/+40 %/+60 %/+80 %" ladder is **not pinned by any test**.

---

## 9. Proposed minimal implementation plan

The governing constraint from the repo's architecture guardian: **extend the existing path; do not
fork a parallel one.** Every proposal below reuses the modules already in place.

### Wave 0 — correctness & provenance (no new fields; makes the data honest)
1. Stop stamping our collection time as the Breeze provider timestamp; keep Breeze at FRESH
   unless the exchange stamps it (`icici-breeze/option-chain.ts:180`).
2. Add `ivSource` (`"provider" | "inverted" | "bs"`) and keep `bid/ask` as `null` when absent
   (never `0`) (`data-layer/types.ts`, `DailyDerivatives.ts:195-196`).
3. Surface `spotSource` / `spotDriftPct` / `indiaVixEstimated` in the panel's provenance strip.
4. Replace the regex error classifier with explicit status codes; add a request budget.
5. Fix the stale headers/prose (chain header, "2 lots default", "θ ≤6 %", knowledge-base strings).

### Wave 1 — the book and the real Greeks (unlocks liquidity + spread + executable entry)
6. Carry `bid/ask/bidQty/askQty` through `ChainLeg` and all four adapters; read NSE v3's
   `buyPrice1/sellPrice1` + quantities; read Breeze's `best_bid_qty`/`best_offer_qty`.
7. Carry NSE's published greeks through the race (so `deltaSource` can be `"provider"`).
8. Make `evaluateLegLiquidity` real: spread % of mid, depth, and a `MISSING_BOOK` state that
   blocks the *executable* claim but not the analysis.
9. Add `bid/ask` columns to `chain_ticks` (additive migration).

### Wave 2 — market structure & momentum on real inputs
10. Extend the DD engine to consume **RSI, EMA 20/50, ATR, SuperTrend, VWAP (from futures candles
    where spot volume is 0)**, and `tech-read.structure` (BOS/CHoCH) + FVG — all already in the repo.
11. Compute **futures VWAP + basis** and a **realised-vol** series from the Breeze futures candles.
12. Fix the VWAP fallback: label the close-average explicitly or compute VWAP from futures.

### Wave 3 — options positioning done properly
13. Adopt the canonical windowed, liquidity-filtered, trend-aware walls from
    `option-chain-reader.ts` (reuse the module — do not write a third implementation).
14. Adopt the canonical BUYING/WRITING/COVERING/UNWINDING classifier (`option-chain-reader.ts:121-127`).
15. Read the `market-history` sidecar for multi-snapshot ΔOI / IV-change / PCR / Max-Pain trends
    (1/3/5/15/30 min), with expiry + reference-price alignment checks; keep the in-memory ring as
    the live fallback.
16. Add **IV percentile/rank** from the `chain_ticks` IV history (real, not the hardcoded 0/50).

### Wave 4 — the professional trade plan
17. Replace the fixed-% ladder with a **structure/ATR/IV-based** plan for DD: underlying
    invalidation (structure) → premium stop via delta + theta + IV → targets mapped from the
    underlying path; keep the house rupee-risk model (20 % of deployed, 2R/3R/4R, 2-lot default)
    as the *risk envelope* rather than as the target generator.
    `buildStructureOptionPlan` (`option-plan.ts:406-541`) already implements most of this — extend
    it rather than writing a new builder.
18. Add: entry zone, underlying entry trigger, setup invalidation price, expected reward per target,
    estimated-vs-executable premium labelling, and a per-leg Greeks summary on the card.
19. Remove the second geometry: make the reversal role's BS-repriced ladder **the** card ladder
    (one R:R, one lot count).

### Wave 5 — risk & execution restrictions
20. Apply `GATE_CONFIG` / `RISK_LIMITS` inside DD: daily/weekly/monthly loss caps, loss-streak
    rule, concurrent-exposure check, `allowedActions` + the 13:00 rule, expiry-day rule.
21. Keep DD **display-only** (no order execution, no alerts) unless you explicitly want a
    machine-readable output; if you do, route it through the existing audit/candidate path — never
    a new parallel funnel.

### Wave 6 — presentation
22. Add the Phase 4 sections to the panel: market overview, CE-vs-PE side-by-side comparison,
    evidence table, data-quality warnings, plain-language WHY / WHY-NOT / invalidation.
23. Derive all prose labels from config (`PLAN_CONFIG.defaultLots`, `REVERSAL_ROLE_GATES`).

### Wave 7 — validation (Phase 5)
24. A **completed-candle, no-look-ahead** replay harness over `chain_ticks` + `candles`, with
    realistic entry/exit, slippage and costs, split by symbol and by CE/PE; report win rate,
    expectancy, drawdown, **sample size**, and **no accuracy claim below a meaningful n**.

### Deliberately NOT proposed
- A new standalone scanner, dashboard, tab or engine.
- A new option-chain provider, or any Yahoo usage.
- A new position-sizing model — the 2-lot default and the 20 %-of-deployed rupee risk stay.
- Option selling, or any automatic execution.
- A duplicate max-pain / PCR / OI-classifier implementation (four already exist — the plan is to
  **adopt the canonical ones**, and to mark the others deprecated after verification).

### Sequencing note
Waves 0-2 are strictly additive to existing modules and can be shipped independently.
Wave 4 is the high-risk change (it alters the numbers on every card) and should be behind the
data-quality gate so that a missing field degrades to WAIT/NO TRADE rather than to a wrong plan.
Wave 7 should run **before** any accuracy claim is made.

---

## 10. Open questions for approval

1. **Scope of the plan ladder:** should DD's targets become underlying-structure/ATR-derived
   (Wave 4), keeping 2R/3R/4R only as the *minimum* R:R envelope? This changes every number on
   every card.
2. **The 13:00 rule:** enable it inside DD (it currently prints TAKE after 13:00)?
3. **The risk envelope:** should DD surface the ₹50,000-account loss caps (daily ₹20,000) and the
   2-loss streak rule as hard WAIT conditions, given the ₹ caps were removed at your direction?
4. **`market-history`:** is reading the :4002 sidecar in scope for Phase 2C (it would give genuine
   1/3/5/15/30-min snapshots), or should DD stay self-contained with the in-memory ring?
5. **Panel layout:** the panel is already 1,992 lines and 17 sections. May I add the new sections
   as a compact evidence table, or do you want a restructured layout?
6. **The stale knowledge-base strings** (`trading-knowledge.ts`) — refresh them, or leave them to
   the agent path?
