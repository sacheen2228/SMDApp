# SMDApp — Session Notes (save for tomorrow)

## Context
Single Institutional Trading Engine consolidation is DONE (Phase 5 collapse). All trade
generation routes through `src/lib/institutional-tpsl/`. User is reviewing terminal/tab
values for correctness before go-live.

## This session: fixed 3 bugs

### Bug 1 — Zero Hero showed only CE, no PE
File: `src/lib/ProTradeEngine.ts` (`evaluateZeroHeroCandidate`)
- Root cause: gated on `strat.best` / `strat.engine.best` (these fields DON'T exist on
  `StrategyEvaluation`); used `evaluateWithStrategy` (auto-picks ONE global best → same
  SL/TP for every strike) → fell through to legacy hardcoded math.
- Fix: use `evaluateStrategyForStrike(req, STRATEGY_CONFIGS.ZERO_HERO, strike, type)` and
  gate on `strat.type` (set whenever engine evaluated the strike). Imports swapped
  `evaluateWithStrategy` → `evaluateStrategyForStrike`.

File: `src/components/terminal/ZeroHeroTerminal.tsx` (`zhCandidates` useMemo ~L443)
- Root cause: `.slice(0,10)` by confidence crowded out all PE (conf 39-42 vs CE 60+).
- Fix: take top-5 CE + top-5 PE, then re-rank. PE now visible.

### Bug 2a — SMC "no candidate passed engine gates" (empty)
File: `src/lib/smc-strategy.ts` (`runSMCWithEngine` + `SMC_STRATEGY_CONFIG`)
- Root causes:
  1. Filtered on `se.eligible` (SMC strict 70-conf + liquidity/volume/session/structure
     gates) → empty on NSE fallback.
  2. `toSMCCandidate` read `e.engine.best.strike` (always engine auto-pick 25500CE) →
     every row showed 25500.
  3. `engine.all` has duplicate (strike,type) rows per expiry mode.
- Fixes:
  - Relaxed `SMC_STRATEGY_CONFIG`: `requireLiquidity/Volume/Session/Structure/failedBreakout/
    exhausted:false`, `maxSpreadPct:0.5`, `maxSLPct:0.5`, `requirePremiumRealistic:false`.
  - Evaluate EVERY leg in `req.chain` through SMC config; keep engine SL/TP/RR regardless
    of `eligible`. Dedupe `req.chain` to unique strikes first.
  - `toSMCCandidate` now uses `e.strike`/`e.type`.
  - Added `strike: number` field to `StrategyEvaluation` interface in
    `src/lib/institutional-tpsl/strategy.ts` (set in `scoreCandidate`).
- Result: SMC returns 15 near-ATM candidates (24050-25000 CE, conf 65-71%).

### Bug 2b — FII/DII Flow not reflecting engine
File: `src/components/terminal/ZeroHeroTerminal.tsx`
- Root cause: bias from raw OI-change ratio only; "Selling/Buying" was a static legend.
- Fixes:
  - New state `marketSentiment` populated from `json.analysis.sentiment` +
    `json.analysis.moneyFlow` in fetchChain.
  - `flowData` useMemo blends engine sentiment (overrides on BULLISH/BEARISH).
  - `FIIFlowPanel` now shows engine-driven Buying (CALLS/PUTS) + Writing (PUTS/CALLS)
    instead of static legend.

## Verification done
- `bun test` → 65 pass / 2 fail (the 2 failures are PRE-EXISTING in
  `tests/smc-engine.test.ts`, unrelated to this work — confirmed earlier).
- Server (`smdapp.service`, systemd-run, next dev -p 3000) returns 200 for
  `/api/option-chain` and `/`. No compile errors (only Breeze SDK fallback warnings,
  expected — NSE fallback active, no Breeze session).
- Live check: `/api/option-chain?symbol=NIFTY` → rec BUY CALL CE 24000, sl 144.11,
  conf 35; sentiment "bearish", moneyFlow.smartMoneyDirection "bearish".

## TODO for tomorrow (user to verify in browser)
1. Reload terminal: confirm Zero Hero Full lists PE strikes + CE.
2. Confirm SMC tab shows candidates (no longer "No SMC Candidates").
3. Confirm FII/DII bias reflects engine (should show BEARISH / Selling CALLS etc based on
   live sentiment).
4. If needed: PE engine SL/TP semantics — engine uses `sl < entry < tp1` for puts
   (long-premium "buy low" convention), shared with option-chain/SDM. Consistent across
   app but NOT true `sl>entry>tp` payoff for puts. Flagged as possible separate change.

## Key files touched this session
- `src/lib/ProTradeEngine.ts` — ZH engine path fix
- `src/lib/smc-strategy.ts` — SMC engine path + config relax + toSMCCandidate strike fix
- `src/lib/institutional-tpsl/strategy.ts` — added `strike` to StrategyEvaluation
- `src/components/terminal/ZeroHeroTerminal.tsx` — zhCandidates PE slice + marketSentiment
  + FIIFlowPanel engine-driven bias

## Server restart recipe (if needed)
```
cd /home/sachin/Desktop/SMDApp
systemctl --user reset-failed smdapp.service 2>/dev/null
systemctl --user stop smdapp.service 2>/dev/null
rm -rf .next
systemd-run --user --unit=smdapp --property=WorkingDirectory=/home/sachin/Desktop/SMDApp \
  --property=StandardOutput=append:/tmp/smdapp.log \
  --property=StandardError=append:/tmp/smdapp.log npx next dev -p 3000
# poll: curl -s "http://localhost:3000/api/option-chain?symbol=NIFTY" | grep recommendation
```
Note: launching with trailing `&` in bash tool kills the process when the tool returns.
Use systemd-run WITHOUT `&`.
