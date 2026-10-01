# SMDApp — Persistent Project Rules & State

This file is read automatically at the start of every session. Re-read it
before writing any code, and re-verify every "status" claim in it against
the actual current repo — this file describes what was TRUE AS OF ITS LAST
UPDATE, not necessarily what's true right now. Sessions forget; the repo
doesn't lie. When in doubt, check the code, don't trust the summary below.

**Keep this file alive**: when you close an open item, add real code, or
discover a new failure pattern, update this file in the same session —
move items between sections, add to the changelog, add a new anti-pattern
if you find one. A stale memory file is worse than no memory file, because
it's trusted.

---

## 0. The one habit that matters most: verify, don't remember

Every real bug found this build had the same root cause — a claim made
without actually checking:
- A backtest was reported as real, was actually run on mock/synthetic data
  ("2-Day Mock Results" — the word "mock" was in the output the whole time).
- A UI tab showed `Data: REAL` in the footer while every card was tagged
  `STALE` two lines above it — nobody had checked the two labels agreed.
- A "build passes / tests pass" claim was made without actually running
  `bun run build` — it later turned out the entire API layer was returning
  500s.
- 536 backtest trades were initially summarized without checking whether
  any of them silently used live current-day data for a historical date.

**Rule: before stating any status as fact (LIVE, PASSING, VERIFIED,
CONNECTED, REAL), actually run the check right now and show the real
output.** "Should be working" / "was working last session" / "the plan
says this is done" are not verification. If you didn't just run it, say
"not verified this session" instead of asserting it's true.

---

## 1. Glossary — use these terms precisely, don't blur them

| Term | Means | Does NOT mean |
|---|---|---|
| `NO_TRADE` | A trade decision output — the engine evaluated real evidence and declined | "we don't have data" (that's `NO_DATA`) |
| `NO_DATA` | An agent/source has no evidence for this query, genuinely | An error occurred while fetching (that's `SESSION_EXPIRED` or `SOURCE_UNAVAILABLE`) |
| `SESSION_EXPIRED` | A source that HAS auth failed AUTH specifically (token/session invalid) | Any generic fetch failure |
| `SOURCE_UNAVAILABLE` | A source with no real auth (e.g. NSE chart endpoint) failed/blocked | Auth expiry — don't conflate these two failure causes |
| `PRICE_ONLY` | A backtest trade has real price/premium evidence but no historical OI/Greeks/news evidence (because none existed for that date) | A live trade lacking evidence at signal time — live trades should have full evidence once the recorder has history |
| `STALE` vs `LIVE` (data freshness) | Whether the shown value's timestamp is within the expected refresh window | Never mix with the `REAL`-vs-`MOCK` distinction (freshness ≠ authenticity — data can be real AND stale, or fake AND fresh-looking) |
| `MOCK` / `SYNTHETIC` | Generated test data, however realistic-looking | Never call this a "backtest" — call it a "synthetic smoke test" |
| Confidence tiers | `Moderate` (40-59 score) / `High` (60-79) / `Very high` (≥80) — drives risk sizing tier | Not the same as "gates passed" — a signal can pass every gate and still only be Moderate confidence |
| Capital tiers | `SMALL` (<₹2L, options-only) / `MEDIUM` (<₹10L) / `LARGE` — re-evaluated daily against CURRENT capital | Not fixed at account creation — a growing paper account can cross tiers mid-simulation |
| Instrument classes | `INDEX` / `LIQUID_STOCK` (routes to Option Engine) / `ILLIQUID_STOCK` (Cash/Futures only, feeds breadth) | — |

---

## 2. Non-negotiable trading rules (never relax these, regardless of framing)

- **Options: `BUY_CE` / `BUY_PE` / `NO_TRADE` only.** Any code path that
  would produce a SELL on an option (short call, short put, short
  straddle/strangle, premium selling) must reject to `NO_TRADE`. This
  includes CAS and Zero Hero logic, which historically lean toward
  premium-selling setups — discard those outputs, don't convert them.
- **Equity/futures/MCX: `BUY`/`SELL`/`NO_TRADE`** — SELL is fine here,
  this restriction is options-only.
- **No agent, engine, or LLM may invent a number** (price, OI, Greek, VIX,
  FII/DII, strike, entry, SL, TP) that isn't present in real fetched data.
  Grok's diff-backstop and the evidence-verifier exist specifically to
  catch this — don't bypass or weaken them.
- **No target-chasing, ever.** Nothing may read progress-to-target,
  days-remaining, or current streak as an input to position sizing, gate
  thresholds, or which signals are eligible. Risk tier is a function of
  SIGNAL CONFIDENCE only. Grep for target/progress/daysLeft near any
  sizing code as a standing check whenever sizing logic changes.
- **Real broker order execution is a separate, explicitly-confirmed scope
  decision — never assumed.** Confirm explicitly, every time this comes
  up, whether the Challenge/paper account is simulated or whether any
  path can reach `/api/orders` / a real broker endpoint automatically.

---

## 3. Anti-pattern museum — specific mistakes already caught, don't repeat them

Each of these actually happened this build. If you catch yourself about to
do one of these, stop:

1. **Padding a ranked list to a fixed count.** "Top Setups" showing 10
   futures trades the account couldn't afford, ranked-then-blocked instead
   of never ranked. Fix: show as many real, gate-passing setups as exist —
   2 is a valid answer, don't backfill with weaker candidates to hit 10.
2. **Collapsing a specific error into a generic one.** A Breeze auth
   exception (`"session expired"`) was caught and converted to a bare
   `return null`, which downstream looked identical to "no historical data
   exists." Fix: preserve the real error category all the way through;
   never let `catch { return null }` erase *why* something failed.
3. **Live data leaking into historical evaluation.** Always check whether
   a "backtest" signal-generation path could reach a live/current-data
   endpoint instead of a historical snapshot. If a historical trade's
   evidence could only exist by querying today's data, that's a temporal-
   mismatch bug, not a valid trade.
4. **Reporting a synthetic run as a real backtest.** Watch for suspiciously
   clean results (100% confirmation rates, zero edge cases, a generator
   that structurally can't produce one of two possible outcomes) — these
   are signs of synthetic data, not a good strategy.
5. **Averaging flagged/implausible data into headline results.** An
   implausible premium, a corrupted Greek, a post-entry news headline —
   these get excluded and reported separately, never blended into the win
   rate so the number "looks complete."
6. **Claiming verification without running it.** See section 0. This is
   the root cause of most of the above.
7. **Two independent paths deciding to alert on the same event.** Always
   check "is there already a single owner for this alert category" before
   adding a new Telegram send call anywhere.
8. **Assuming an untested file is "pre-existing" via git stash.** Untracked
   files aren't stashed — a "pre-existing errors" proof that relies on
   stashing doesn't actually test untracked code. Check `git status` for
   untracked (`??`) files before trusting a baseline comparison.

---

## 4. Architecture patterns already established — don't reinvent

- **`src/lib/jarvis/` is FROZEN.** Never modify it. Wrap it. If a new
  requirement doesn't fit what it exposes, build alongside it, don't edit
  the frozen files, and say so explicitly rather than working around this
  rule silently.
- **One shared data fetch per cycle, not N independent fetches.** True for
  the 30 agents (one snapshot, not 30 NSE calls) and for the frontend
  (one live-data layer per tier, cards subscribe to it, they don't each
  poll independently).
- **Single alert owner per alert category.** Trade Monitor is the sole
  sender of TP/SL Telegram alerts. `session-health.ts` is the sole sender
  of session-expiry/system-health alerts. Hermes tools are read-only —
  they never send alerts themselves, they read state others already wrote.
- **Cache-then-compute, alerting lives in exactly one place.** A worker/
  recorder does scheduled fetching + alerting; API routes and chat paths
  read the cache the worker already wrote, they don't independently
  recompute or re-alert.
- **Instrument Router decides eligibility, not a second engine.**
  `INDEX`/`LIQUID_STOCK` → Option Engine (different gate sets per class —
  index gets S1-S8, stocks get earnings-gate + event-driven +
  liquidity-sweep, NOT the index wall-rejection logic). `ILLIQUID_STOCK` →
  Cash/Futures Engine only, feeds breadth to Agent 05/06.
- **Capital tiers change which instruments are eligible, never loosen a
  gate.** Confidence-tiered risk sizing (Very High/High/Moderate
  confidence → different %, hard ceiling regardless of tier) — never a
  flat risk % applied uniformly regardless of signal quality.
- **No new strategy inherits another instrument class's validated status.**
  Each new strategy set needs its own 30-trade expectancy review before
  being trusted, tracked separately.

---

## 5. Data source map (confirmed by audit — re-verify if it's been a while)

| Data type | Source chain (first success wins) |
|---|---|
| OI / IV / Spot | Breeze → NSE → BSE |
| Greeks | Computed from IV (Black-Scholes), not fetched directly |
| Candles | Breeze (primary) → MO (if wired) → NSE (index-only, best-effort) — see open items |
| India VIX | Yahoo (`fetchIndiaVIX`) |
| Breadth | NSE gainers/losers |
| News evidence | Read from recorded `marketContext` at signal time, not re-fetched |

**`broker/icici-client.ts` and `broker/mo-client.ts` are DEAD CODE** — zero
imports anywhere, confirmed by grep. The live clients are
`src/lib/icici-breeze/*` and `src/lib/motilal/*`. Don't resurrect or edit
the dead files without a specific reason; flag, don't delete, per the
existing rollback posture.

---

## 6. Secrets & session tokens — reference, handle carefully

| Item | Where | Notes |
|---|---|---|
| `BREEZE_SESSION_TOKEN` | `.env` | ~24h lifetime, requires OTP login via `api.icicidirect.com/apiuser/login`; manual refresh unless session-health automation confirmed live |
| `MOTILAL_TOTP_KEY` | `.env` | Enables `generateTOTP()` + `loginWithTOTP()` — confirm these are actually wired into the auth-failure path, not just present-but-unused |
| MO session cache | `/tmp/motilal-session.json` | ~24h |
| NSE session | in-process cookie jar (`nse-bse-api` package) | Re-primed once per process; no auto re-prime on 401 as of last audit — check current state |
| BSE | none | No auth mechanism exists for BSE endpoints |

**Never print a full token/secret value in logs, console output, or a
status report** — reference that it exists / is valid / expired, not its
contents. When asking the user for a fresh token (per the session-health
resume flow), the request goes through Telegram/Hermes, and the token
itself should not be echoed back in any confirmation message beyond what's
needed to confirm receipt.

---

## 7. Verification discipline — exact commands, not descriptions

Run these for real, every time, before any "done" claim:

```bash
bun run tsc --noEmit          # type-check; compare error count to baseline, zero NEW errors in touched files
bun test                       # full suite; report actual N/N, not "should pass"
bun run build                  # must exit 0
git status                     # check for untracked (??) files before trusting any "pre-existing" baseline claim

# Target-chasing regression check (run after touching any sizing/gate code)
grep -rn "progress\|daysLeft\|target" src/lib/ --include="*.ts" | grep -i "risk\|size\|gate\|threshold"
# expect: no results near sizing/gating logic

# Cache-not-recompute check (run after touching any cached API route)
curl -s localhost:3000/api/jarvis?symbol=NIFTY | grep timestampIso
sleep 5
curl -s localhost:3000/api/jarvis?symbol=NIFTY | grep timestampIso
# expect: identical timestampIso if within TTL, source: "worker-cache"

# Dead-file check (confirm nothing accidentally imports the flagged dead broker clients)
grep -rn "icici-client\|mo-client" src/ tests/ scripts/ --include="*.ts"
# expect: zero real imports (comments/docs mentioning them are fine)
```

---

## 8. Definition of done — reusable closing checklist for any new prompt/feature

Before reporting a feature complete:
- [ ] `tsc`, `bun test`, `bun run build` all actually run this session, real output shown
- [ ] No new errors in touched files vs. baseline
- [ ] Target-chasing grep (section 7) clean if sizing/gates were touched
- [ ] If a backtest was involved: real data or synthetic, stated explicitly; sample trades printed with real evidence per section on evidence integrity
- [ ] Flagged/implausible data reported separately, not averaged in
- [ ] Any new alert path checked against the single-owner rule (section 4)
- [ ] `src/lib/jarvis/` untouched (or explicitly justified if it had to be)
- [ ] This file (`CLAUDE.md`) updated: open items moved to changelog if resolved, new anti-patterns added if discovered

---

## 9. Stop and ask — don't proceed on these without explicit confirmation

- Any change that would let a decision path reach real broker order
  execution (`/api/orders` or equivalent) automatically, where it
  currently doesn't.
- Deleting (not just flagging) any file already marked dead/deprecated.
- Any change to `src/lib/jarvis/`, Trade Monitor, or `telegram-alerts.ts`
  outside of what was explicitly scoped.
- Introducing a new LLM/model provider or fine-tuning anything on trading
  data to directly generate predictions (see the earlier "training Jarvis"
  discussion — statistical validation of existing rules is fine and
  encouraged; training a model to predict trades directly is not).
- Raising any risk-per-trade or capital-allocation constant beyond what's
  currently documented in this file, without it being a deliberate,
  explicitly stated decision (not an inferred one).
- Adding a second alert/notification path for a category that already has
  a single owner.

---

## 10. Known open items (update as things close — don't let this go stale)

As of last update, these were asked but not yet confirmed resolved:
- [ ] OI-temporal question: did `option-chain-api`/SMC backtest signals
      ever consume live (not historical) OI data against a historical
      price date? (Investigation prompt issued, answer not yet received.)
- [ ] Evidence sample size: recorder started capturing from a specific
      Monday 09:15 IST — check actual current snapshot count against
      "5-10 trading days" before trusting any S1/S2/Greeks-scored
      backtest result as more than PRICE_ONLY.
- [ ] Full mixed-universe (index+stock) backtest with real equity curve,
      drawdown, per-strategy breakdown: not yet confirmed as actually run.
- [ ] `STRATEGY_REGISTRY.md` (live vs. stubbed status of all 30 agents):
      not yet confirmed produced.
- [ ] Shared live-data layer: only the audit (Phase 1) was confirmed;
      Phases 2/3 (actually wiring cards to a shared subscription layer)
      not yet confirmed built.

---

## 11. Changelog — resolved items (dated, with evidence)

Move items here from section 10 when genuinely closed. Keep the evidence,
don't just mark done:

- *(example format — replace with real entries as they close)*
  `2026-09-27` — API 500 root-caused (`supervisor.ts:332` const-reassignment
  + truncated `learning-db.ts`, both from an uncommitted/untracked file).
  Fixed. `bun test`: 610/610. `bun run build`: exit 0.
- `2026-09-27` — Recorder timer installed (`smdapp-recorder.timer`,
  Mon-Fri 09:15/09:30), `mapNSEChain`/`mapBSEChain` zero-Greeks bug fixed
  (now computes Black-Scholes from IV via `yearsToExpiry()`), verified by
  force-recapture across 5 symbols with real non-zero Greeks.
- `2026-09-27` — Session-health + candle-chain feature COMPLETED and
  live-verified: `session-health.ts` sole alert owner (globalThis store
  `__SMD_SESSION_HEALTH__` shared across route bundles), candle chain
  Breeze→MO→NSE wired into capture, cross-route recorderState isolation
  fixed (`__SMD_RECORDER_STATE__`, totalCaptures:5 live-checked), Hermes
  tools `check_session_tokens`/`set_breeze_session`. Evidence: tests
  650/650, tsc 734 = baseline, build exit 0.
- `2026-09-27` — MO EOD verified against live API: only `/rest/report/v3/*`
  works (all v1 = MO8001 even on valid session), NSE EOD v3 = equity spot
  daily only, NSEFO = derivatives-only, no index spot OHLC anywhere →
  `motilal/candles.ts` rewritten (v3, index capability-skip
  `INDEX_SPOT_UNSUPPORTED`), TOTP key re-registered in `.env`, TOTP
  auto-login green.
- `2026-09-27` — BSE alternate hardened (user directive: NSE/BSE when
  Breeze down): `GetSensexDatanew` spot endpoint dead (403/302 loop) →
  `getBSEIndexData` now derives spot from live chain `UlaValue`
  (`bse-api.ts`), BSE route race 3s→5s. New `tests/bse-api.test.ts`
  (3 tests, red→green). Evidence: 653/653, tsc 734, build exit 0.
- `2026-09-27` — LLM chain fixed + reordered per user directive ("always
  use free OpenRouter model"): new OpenRouter key verified (auth 200 +
  chat 200), chain now `openrouter(:free) → groq → ollama → tokenra`
  (`llm-client.ts`), fallback path live-tested (Groq fail → OpenRouter
  `nvidia/nemotron-3-ultra-550b-a55b:free` → OK 1.7s). All 5 configured
  OpenRouter models verified `:free`.
- `2026-09-27` — `/api/orders` reachability CONFIRMED (was open item):
  automatic real-broker path EXISTS but is mode-gated. Default mode =
  `PAPER` everywhere (`auto-executor.ts` `autoExecuteMode="PAPER"`,
  `executeTrade` default `"PAPER"`). LIVE requires explicit switch:
  POST `/api/challenge` body `mode:"LIVE"` or
  `copyConfig.mode === "LIVE_COPY"`. LIVE orders pass
  `validateCandidateTrade` first and fall back to paper on any failure.
  Automatic triggers (`morning-scan.ts` GET `/api/challenge`,
  copy-trading loop) run in the current mode — so LIVE is reachable
  automatically once explicitly switched, manual-only before that.

---

## 12. Before claiming "ready to go live"

Live has two very different meanings — confirm which one is being discussed
every time, don't let it stay ambiguous:
- **Paper/simulated capital continuing forward** — lower stakes, still
  needs the open items in section 10 resolved for the numbers to mean
  anything.
- **Real broker capital** — requires, in addition to everything above: a
  kill switch reachable from Telegram with no confirmation delay, a
  minimum paper-trading period with tracked real outcomes (not just code
  review), and explicit written confirmation that order-execution scope
  was a deliberate decision, not an assumption.
