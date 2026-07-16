# SMDApp — Session Notes (2026-07-17)

## Fixes applied today

### Bug: Zero Hero SL = ₹0.00 for all entries
Root cause: `evaluateZeroHeroCandidate` override code used bare `atr` (not `input.atr`), causing
`ReferenceError: atr is not defined` → silent catch → legacy fallback → SL=0 for index options.
Fix: changed `atr` to `input.atr` at line 391 of `src/lib/ProTradeEngine.ts`.

### Bug: SMC tab — SL = ₹0.00, only CE shown, no PE, ATR = ₹0.00
Root causes:
1. **SL=0**: `scoreCandidate` used engine's `slPremium` which clamps to 0 for index options
   (delta × indexDistance exceeds ltp → negative → clamped).
2. **No PE**: CEs systematically scored higher (72-73) than PEs (49-55), so naive `slice(0,15)`
   picked only CE.
3. **ATR=0**: `toSMCAnalysis` read from `engine.best?.vol.atr` but engine.best was null.
Fixes:
- `strategy.ts:scoreCandidate`: ATR-based % SL/TP override when `slPremium <= 0 || slPremium >= entry`.
- `smc-strategy.ts:runSMCWithEngine`: Balanced 8 CE + 7 PE selection.
- `strategy.ts:StrategyEvaluation`: Added `atr?` field.

### Bug: API recommendation picks far-OTM strike 80000 CE (₹0.90)
Root cause: `entryPremium > spot * 0.002` filter (= ₹154 for SENSEX) filtered out ALL near-ATM
CEs. Fallback `all.filter(e => e.passed)` picked 80000 CE (highest volume/OI).
Fix: `institutionalScan` fallback pool now also requires `entryPremium > 5` and `|strike-spot|/spot < 5%`.

### Bug: PE SL/TP formulas inverted (SL above entry, TP below entry)
Root cause: PE buyers profit when premium rises (same as CE), but code had PE formulas
reversed: `sl = entry*(1+slPct)`, `tp = entry*(1-tpPct)`. Fixed to uniform `sl = entry*(1-slPct)`,
`tp = entry*(1+tpPct)` for both CE and PE.
Fixed in: `strategy.ts:scoreCandidate`, `sdm-strategy.ts:runFullAnalysis`, `ProTradeEngine.ts:evaluateZeroHeroCandidate`.

### Bug: Max Pain calculated wrong
Root cause: `runFullAnalysis` used `Math.abs(ceOI - peOI)` (CE/PE OI balance), not standard
max pain (strike with highest total OI).
Fix: Changed to `totalOI = ceOI + peOI; if (totalOI > maxTotalOI) maxPain = strike`.

### Rename: "Zero Hero Scanner — Full" → "Today's Trade"
Changed all 3 occurrences in `src/components/terminal/ZeroHeroTerminal.tsx` (sidebar + full panel).

## Verification
- `bun test` → 65 pass / 2 fail (pre-existing in smc-engine.test.ts)
- Server running on `:3000`
- SENSEX API rec: strike 77000 PE, entry ₹17.95, SL ₹14.36, TP1 ₹23.34, conf 37%, maxPain 77500
- NIFTY API rec: strike 24150 PE, entry ₹122.70, SL ₹83.10, TP1 ₹207.74, conf 36%, maxPain 24200
- SMC: CE=8, PE=7 (balanced), SL=0 count: 0, ATR=771
- Zero Hero: CE sl=80.96 (non-zero), PE sl=20.88 (non-zero)

## Files modified
- `src/lib/institutional-tpsl/strategy.ts` — scoreCandidate SL override, atr field, uniform CE/PE SL formula
- `src/lib/institutional-tpsl/index.ts` — tradeable filter entryPremium > 5, fallback pool filter
- `src/lib/smc-strategy.ts` — balanced CE+PE, ATR in analysis, max pain fix, SL override for API rec
- `src/lib/ProTradeEngine.ts` — uniform CE/PE SL formula in Zero Hero override

## Server restart recipe
```bash
cd /home/sachin/Desktop/SMDApp
systemctl --user stop smdapp.service 2>/dev/null
systemctl --user reset-failed smdapp.service 2>/dev/null
rm -rf .next
systemd-run --user --unit=smdapp --property=WorkingDirectory=/home/sachin/Desktop/SMDApp \
  --property=StandardOutput=append:/tmp/smdapp.log \
  --property=StandardError=append:/tmp/smdapp.log npx next dev -p 3000
```
