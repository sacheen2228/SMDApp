# SOP — Market Data, Session & Pre-Market Readiness

Single source of truth for **where market data comes from, how freshness is
decided, which circuit breaker/session clock is authoritative, and what must be
green before 09:15 IST**. `AGENTS.md` documents the repo layout; this document
documents the *data contract*.

> Every endpoint below marked **[live-verified]** was probed from this machine
> during the Oct 2026 data-layer fix. When NSE/BSE change an endpoint, update
> this file in the same commit that changes the code.

---

## 1. Provider hierarchy (authoritative)

```
Option chain (indices + equities)
  NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY  →  NSE primary
  SENSEX / BANKEX                            →  BSE primary  (NSE has no contract)
  NSE equities (RELIANCE, …)                 →  NSE primary
  Fallback: MOAPI  →  Breeze (opt-in, last resort)  →  NO_DATA
  Yahoo             →  NEVER enters the option-chain path
                       (VIX-via-Yahoo in /api/option-chain is a separate datum)

  Canonical evaluation order in every chain path:
    1. NSE (if not a BSE index)   2. BSE (if a BSE index)
    3. MOAPI                       4. Breeze
```

| Data | Primary | Fallback | Terminal state |
|---|---|---|---|
| Option chain | NSE / BSE (exchange-aware) | MOAPI → Breeze (last resort) | `NO_DATA` |
| Candles (live) | Breeze (broker feed — NSE has no candle API) | MO → Yahoo | `NO_DATA` |
| Spot quotes | NSE | MOAPI → Breeze → Yahoo | `null` |
| VIX | NSE `indiaVIX` | Yahoo `^INDIAVIX` | `null` |
| FII/DII | NSE India | MrChartist history | `null` |
| Gain/losers | NSE `live-analysis-variations` | — | `null` |

**Rules that never change**

- A successful HTTP response is **not** proof of freshness.
- A cache hit is **not** `FRESH` — cache reads re-classify freshness from the
  provider's own timestamp.
- Missing fields stay `null`. Never fabricate `0`, `"LIVE"`, or an expiry.
- `publishedAt` = the provider's timestamp (never rewritten).
  `collectedAt` = when we collected it.
- Provenance must surface `STALE`, not collapse it to `DELAYED`.

---

## 2. Live endpoint reference

### NSE — **`api.nseindia.com` is dead (404 for every path)**

Use `https://www.nseindia.com/api/*` **[live-verified]**:

1. Prime a cookie with `GET https://www.nseindia.com` (HTML page), keep
   `set-cookie` — cached 5 minutes (`getNseCookie()` in
   `src/lib/data-layer/providers/nse.ts`).
2. Send every API request with `Cookie` **and** a matching `Referer`.

| Call | Path | Referer |
|---|---|---|
| Expiries **[live-verified]** | `/option-chain-contract-info?type=Indices&symbol=X` → `expiryDates` (`DD-Mon-YYYY`) | `/option-chain` |
| Chain **[live-verified]** | `/option-chain-v3?type=Indices&symbol=X&expiry=13-Oct-2026` → `{records:{data:[…]}}` | `/option-chain` |
| Gainers **[live-verified]** | `/live-analysis-variations?index=gainers` → `{NIFTY:{data:[…],timestamp:"09-Oct-2026 16:00:00"},…}` | `/market-data/live-equity-market` |

Gotchas (all verified live):

- Empty/unknown expiry returns `{}`, not an error → treat as *no contract*.
- SENSEX/BANKEX return `{}` from NSE — **never** second-guess a missing
  exchange contract; route to BSE.
- `quote-equity` is **WAF-blocked (403)** even with a cookie — do not use it.
- `equity-stockIndices`, `list/equities`, `most-active` → 404.

### BSE

Bare requests return **404**. Required headers **[live-verified]**:

```
Origin:   https://www.bseindia.com
Referer:  https://www.bseindia.com/markets/Derivatives/DeriReports/DeriOptionchain
```

| Call | Endpoint | Notes |
|---|---|---|
| Expiries **[live-verified]** | `/Mkt_Archive_SerachDeriDropDown_beta/w?Product_Type=IO&scrip_cd=1&Flag=1` | `table1[].EXPIRYDT` = `"15 Oct 2026"` (guessed `"OCT 2026"` returns `{Table:[]}`) |
| Chain **[live-verified]** | `/DerivOptionChain_IV/w?Expiry=<enc>&scrip_cd=<cd>&strprice=0` | `Table[]` rows; empty `Table` = invalid expiry |
| Scrip codes | SENSEX = `1`, BANKEX = `12` | Unknown symbol → `null`, **never** default to `1` |

**Row shape (one row = both sides):** PE fields are unprefixed
(`Open_Interest`, `Absolute_Change_OI`, `Vol_Traded`, `IV`, `BidPrice`,
`OfferPrice`, `Last_Trd_Price`); **CE fields carry a `C_` prefix**
(`C_Open_Interest`, `C_Vol_Traded`, `C_IV`, `C_BidPrice`, `C_OfferPrice`,
`C_Last_Trd_Price`). Mixing these up silently duplicates PE into CE — it was a
real bug in both `providers/bse.ts` and `chains/option-chain.ts`.

Spot = `Table[0].UlaValue` (top-level `UlaValue` does not exist).

### MOAPI

Report endpoints exist **only under `/rest/report/v3/*`**. Every
`/rest/report/v1/*` path returns `MO8001 "Invalid Token"` *even on a valid
session* — that auth-shaped error would fake a session-expiry alert, so v1 must
never be called. No option chain; candles are daily-only (no intraday on the
platform).

### Breeze

Opt-in fallback only. Token exchange times out until a fresh browser OTP login
at `api.icicidirect.com/apiuser/login?api_key=…`, then `set breeze session <token>`.

---

## 3. Freshness

**Canonical classifier:** `src/lib/api-freshness.ts`
— `classifyFreshness(ageMs, dataType)`, `providerAgeMs(raw)`,
`collectedFreshness(raw, dataType)`, `buildFreshnessMeta(...)`.

- `providerAgeMs(raw)` reads `records.timestamp` / `records.TimeVal` /
  `lastUpdate` / `tradeDate` / `ASON.DT_TM` (BSE normalises ` | `).
  No timestamp → `null`.
- `collectedFreshness()` returns `null` age → `"FRESH"`, **never `"LIVE"`**
  (we collected it; we cannot claim the provider is live).
- `providerTimestamp(raw)` returns the exchange's publication time or `null`.
  Null is meaningful: it means *we collected this, but cannot verify how
  current it is* — the payload must be capped at `FRESH`, never `LIVE`.
- Age-less payloads must not become `LIVE`. This is why `classifyFreshness(0,…)`
  was removed from the option-chain normalizers.

### Session-aware freshness

`sessionAwareFreshness(level, session)` / `withSessionAwareFreshness(meta,
session)` encode one rule: **LIVE is only truthful while the exchange is open
and printing.**

| session | LIVE survives? |
|---|---|
| `OPEN`, `REGULAR` | yes |
| `PRE_OPEN`, `POST_MARKET`, `CLOSED` | no → `STALE` |

A fetch on a weekend, holiday, pre-open or after-hours returns the **last known
state** — it must never report `LIVE`, even though the HTTP call succeeded.
Applied in `market/regime` and `option-chain`; apply it to any route that builds
freshness from a collection-time timestamp. Never promote a weaker level
(`FRESH`/`DELAYED`/`STALE`) up to `LIVE`, and never demote `UNAVAILABLE`.

**Live-verified (Sat 2026-10-10):** `/api/market/regime` reported `freshness: LIVE`
with `session: CLOSED` before this rule; after it, `STALE`/`delayed: true`.
`/api/option-chain` similarly went `LIVE` → `STALE`, and NIFTY's real exchange
timestamp (`2026-10-09T10:10:00Z`, ~23h old) now drives `ageMs` instead of a
fabricated `new Date()`.

### Fallback vs primary

`fallbackUsed` must reflect the **provider hierarchy in §1**, not an obsolete
Breeze-first worldview. NSE is primary for NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY
and NSE equities; BSE is primary for SENSEX/BANKEX. Serving from either is
**not** a fallback. Labeling BSE `fallbackReason: "BSE primary for
SENSEX/BANKEX"` was self-contradictory and has been removed.

Two production paths were still racing or sequencing against Breeze as if it
were a primary provider. Both are corrected:

| Path | Was | Now |
|---|---|---|
| `/api/option-chain` | **MOAPI → Breeze → NSE → BSE** (MOAPI labelled "preferred primary") | **NSE → BSE → MOAPI → Breeze** |
| `breeze-fno-data.fetchOptionChainSnapshot` | raced Breeze ∥ NSE — a doomed Breeze call on **every** fetch | NSE first; Breeze only if NSE fails **and** it is not in cooldown |
| `sdm-signal` | MOAPI → Breeze → NSE → BSE | BSE (if BSE index) → NSE → MOAPI → Breeze (opt-in, last) |
| `data-layer/chains/option-chain` | already correct | BSE → NSE → MO (unchanged) |
| `market-data-manager.PROVIDER_PRIORITY` | already correct | `nse → moapi → breeze → website → yahoo` |

Verified live across all seven instruments — every one routes to its
designated primary, with `fallbackUsed: false`:

```
NIFTY BANKNIFTY FINNIFTY MIDCPNIFTY  → nse-api
SENSEX BANKEX                        → bse-api
RELIANCE                             → nse-api
```

With all primaries healthy, the log shows **zero MOAPI and zero Breeze
option-chain calls**. The silent `catch {}` around the BSE block was also a
defect — a transient BSE failure was indistinguishable from "no contract". It
now logs, and the `NO_DATA` error message names the providers that were tried
in order instead of the obsolete "Breeze, Motilal, NSE, and Yahoo Finance".

Breeze SDK calls per full scanner run dropped **78 → 24**, and the survivors
are the legitimate last-resort path for symbols NSE has no F&O contract for.

### Closed-market short-circuit

When `isTradingDay()` is false, no new prices are published. A scan that runs
anyway re-reads the previous close and presents it as a fresh setup. Gate the
expensive scanners at the top and return an explicit `reason`:

| Path | Before (Sat) | After |
|---|---|---|
| `/api/dom-analysis` (default + `?all=true`) | **45s**, leaked ~150 NSE calls into the background | **~20ms**, `reason: "Non-trading day…"` |
| `/api/market/opportunities` | **18.5s** | **~20ms**, empty list + `reason` |

`runDOMAnalysis(signal?)` also takes an AbortSignal and stops scheduling
batches the moment it fires — a `Promise.race` timeout must **abort** the work,
not merely abandon it. (`NSEClient` has no abort support, so the in-flight batch
still completes; nothing after it starts.)

Secondary classifiers that **delegate to** (or must agree with) the canonical one:

| Module | Role |
|---|---|
| `hermes/freshness.ts` | Hermes context — `classifyFreshness(string\|Date, type)` **and** `classifyFreshnessMs(ageMs, type)`. Signature mismatch is a known trap: passing a number to the first function is wrong. |
| `nse-oi-spurts.ts` | Per-row freshness from the row's own timestamp |
| `web-intel/sync.ts` | Sync-time freshness |

---

## 4. Circuit breaker — **one, not two**

**`src/lib/provider-health.ts` is the single source of truth** for failure
counting, cooldown, and `CLOSED/OPEN/HALF_OPEN` state across every external
provider (`nse`, `bse`, `moapi`, `breeze`, `yahoo`, `website`, plus the LLM
SDKs).

- Thresholds: default 5 consecutive failures; per-provider base/max cooldowns
  (`nse`/`bse` 5s→60s, `moapi` 15s→5min, `yahoo`/`website` 30s→10min,
  `breeze` 1min→1hr).
- `recordSuccess()` closes the circuit from **any** state and clears cooldown,
  so a manually applied fresh Breeze token is usable immediately.
- `market-data-manager.ts` **delegates** — it keeps a legacy-shaped
  `ProviderState` view for `/api/health` and the Hermes paper worker, but every
  decision comes from `providerHealth`. Do not re-add local failure counting.
- `session-health.ts` classifies *session* failures only (`breeze|mo|nse`) and
  is the sole sender of `[SYSTEM][SESSION_EXPIRED]`. BSE is deliberately absent
  (no token auth).

---

## 5. Session clocks — one calendar, two views

**Calendar + IST clock:** `src/lib/expiry-liquidity/market-session-config.ts`
(no imports, so anything may import it without cycles).

- `getISTDate()` / `getISTMinutes()` — IST wall clock (UTC shift + 5:30, then
  read `getUTC*`).
- `isHoliday()` / `isWeekend()` / `isTradingDay()` — **must** read the IST date.
  Reading `Date.toISOString()` or the server's local weekday gives the wrong
  answer after 18:30 IST / before 05:30 IST (this was a real bug).
- `getTradingSession()` → coarse enum `PRE_OPEN | OPEN | REGULAR | POST_MARKET |
  CLOSED` (the vocabulary `technical-analysis.ts` and `/api/market/regime`
  consume). The regime route no longer inlines its own holiday list or ladder.

**Confidence/actions view:** `src/lib/market-session.ts` — fine-grained phases
(`trend_form`, `primary`, `cas_*`, …) with `confidenceMultiplier`,
`allowedActions`, `isMarketOpen`. It now:

- imports the shared calendar (adds weekend/holiday awareness — previously
  Saturday 10:00 IST reported `primary` at confidence 1.0), and
- derives `getISTMinutes()` from the shared clock.

**Expiry weekdays (SEBI staggered), canonical `expiry-calculator.ts`:**
NIFTY/FINNIFTY = Tuesday, MIDCPNIFTY = Wednesday, BANKNIFTY/SENSEX/BANKEX =
Thursday. NSE's own `option-chain-contract-info` expiry list is authoritative
when fetched live — do not override it.

---

## 6. Pre-market readiness (09:10 IST)

`src/lib/premarket-readiness.ts` aggregates everything above into one verdict:

| Check | Source | FAIL means |
|---|---|---|
| `trading_day` | `isTradingDay()` | weekend / exchange holiday |
| `session_clock` | IST clock | — (informational) |
| `feed_gate` | Live Option Data Service `:8765/health` | unreachable or `all_live=false` |
| `data_health` | canonical `getOptionChain('NIFTY')` scored by `data-health.ts` | chain unavailable / CRITICAL / OFFLINE |
| `session_health` | `buildSessionStatusReport()` | any `SESSION_EXPIRED`, or a source down |
| `provider_circuits` | `providerHealth` | (WARN) circuit OPEN |
| `morning_brief` | `getLastMorningBrief()` | (WARN) missing or not today's IST date |
| `telegram` | `TELEGRAM_DIGEST_CHAT_IDS` | (WARN) not configured |

Gate ladder (FAIL always outranks WARN):

```
NON_TRADING_DAY  >  NOT_READY  >  DEGRADED  >  READY
ready === true  ⇔  no check FAILed     (DEGRADED is still tradeable)
```

A thrown probe becomes an honest `FAIL`, never a crash and never a silent PASS.
Dependent checks are `SKIP` on a non-trading day — never reported as `PASS`.

**Surfaces**

- HTTP: `GET /api/premarket-readiness` (`?fresh=1` busts the 60s cache,
  `?notify=1` sends on problems, `?notify=always` always sends;
  `CRON_SECRET` protected when set).
- Dashboard: readiness badge in `ConnectionStatusBar.tsx` (polls every 5 min).
- Cron: `scripts/dailyScanCron.ts` at `10 9 * * 1-5` (09:10 IST) — logs the
  verdict and Telegram-alerts anything other than `READY`.

**Full cron schedule** (`Asia/Kolkata`, Mon–Fri unless noted):

| Time | Job |
|---|---|
| 09:10 | premarket readiness pre-flight |
| 09:10 | morning digest |
| every 15 min, 09:00–15:59 | intraday alerts (self-gates to 09:15–15:30) |
| 15:15 | BTST scan |
| 15:25 | square off prior-day BTST |
| 15:31 | EOD square-off of intraday journal trades |
| every 20 min, 16:00–18:40 | NSE participant OI |
| 19:00 | participant-OI staleness watchdog |

---

## 7. Trading rules — **unchanged**

| Parameter | Value |
|---|---|
| Direction | CE BUY / PE BUY only — no option selling |
| Capital | ₹15,000 (75% = ₹11,250 deployable) |
| Lot sizes | NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120, SENSEX 20, BANKEX 30 — **`src/lib/symbol-config.ts` is the only place they may be defined** |
| Min premium | ₹5 |
| Min OI / volume | 50,000 / 10,000 |
| Max spread | 5% |
| Confidence | CE ≥ 55, PE ≥ 65 |
| Min R:R | 1:2 |
| Risk | ≤ 1% per trade, max 2 trades/day |
| Exit | square off by 15:15; SL = 30–50% of premium |

Preserved: Telegram format, trade registration, Hermes trade generation,
supervisor deterministic math (no LLM), and the Zero Hero production path
(`ZeroHeroTerminal.tsx` → `zhCandidates` → `FullZeroHero` → Trade Audit).

---

## 8. Verification

```bash
bun test                     # expected: 1261 pass / 1 fail
                             #   the 1 fail is the known baseline:
                             #   tests/web-intel.test.ts:214 "incremental cursor"
bunx tsc --noEmit            # expected: ≤676 errors, all pre-existing
                             #   (count only lines matching ^(src|tests)/)
                             #   HEAD baseline was 714 → net -38, zero regressed files
bun run build                # ignoreBuildErrors is on — must still complete
```

Per-file error counts are the reliable comparison; TS error *text* changes run
to run because union member ordering is nondeterministic.

### Live endpoint sweep (Sat 2026-10-10, market CLOSED)

24/24 dashboard API endpoints returned 200:

```
option-chain NIFTY   200   369ms  fresh=STALE   src=nse-api   108 strikes CE/PE distinct + greeks
option-chain SENSEX  200         fresh=STALE   src=bse-api   187 strikes CE/PE distinct + greeks
option-chain BANKEX  200         fresh=STALE   src=bse-api   172 strikes
premarket-readiness  200    21ms  gate=NON_TRADING_DAY (dependent checks SKIP)
market/regime        200    16ms  fresh=STALE  session=CLOSED
market/heatmap       200    15ms
market/breadth       200    16ms
market/opportunities 200    18ms  closed-market short-circuit
fii-dii              200   240ms  fresh=DELAYED (real 2-day age, not collapsed)
health               200    40ms  providers include `website`
atm-straddle         200   398ms
options-edge         200    96ms  src=NSE
institutional-greeks 200   367ms  src=NSE
greek-flow           200    93ms  src=NSE
participant-oi       200  1300ms  src=nse
expiry-liquidity     200   241ms  src=nse-api
scanner              200  9554ms  (warm; 24 Breeze calls, down from 78)
scanner/fno          200  3152ms
btst                 200  1453ms
sdm-signal           200  6928ms  (was 18.7s — hierarchy reordered)
watchlist / alerts / trade-journal / news / agent-memory  200
dom-analysis         200     8ms  (was 45s — closed-market short-circuit)
```

Cron registration verified live in `smdapp-cron.service`:
`[dailyScanCron] premarket readiness scheduled for "10 9 * * 1-5" (Asia/Kolkata)`.

Known-broken and out of scope: **Breeze session** (needs a fresh browser OTP
login at `api.icicidirect.com/apiuser/login?api_key=…`, then Hermes
`set breeze session <token>`), and 676 pre-existing TS errors in unrelated files
(no file exceeds its HEAD baseline; HEAD was 714).

Also observed and not acted on: `MCX Scraper` receives HTTP 403 from the MCX
website, and `smdapp-web` reports the homepage font load as transiently
unreachable when `fonts.gstatic.com` cannot be resolved from this host.
