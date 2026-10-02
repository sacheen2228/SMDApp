# Scoring Sheet and Checklists

## Scoring sheet (discipline tool; backtest and adjust, not a proven system)
| Factor | Bullish +1 | Neutral 0 | Bearish -1 |
|---|---|---|---|
| FII futures trend | Long % rising | Flat | Long % falling |
| FII/DII cash flow | Net buying | Mixed | Net selling |
| Client positioning | Crowded short (contrarian) | Balanced | Crowded long (contrarian) |
| Structure | HH/HL | Range | LH/LL |
| OI change | Put writing up, call unwinding | Mixed | Call writing up, put unwinding |
| Price vs VWAP/levels | Above | At | Below |
| VIX (for calls: falling/low = +1; for puts: rising = +1) | Supportive | Flat | Against |

- (Seven factors: range -7 to +7.) Total >= +4: look for call setups.
- Total <= -4: look for put setups.
- In between: smaller size or stay out.

## Final pre-trade checklist (any "no" = skip)
1. Flow bias (FII futures trend, FII/DII cash) aligned?
2. Client/Pro positioning not crowded against me?
3. Higher-timeframe structure agrees?
4. Price at a level with OI support (writing or unwinding)?
5. Candle confirmation present?
6. Strike selector passes (option R:R, theta cost, break-even, lots >= 1) and VIX regime acceptable?
7. Stop on the underlying, reward:risk >= 1:2, risk <= 1%?
8. No major event or expiry distortion nearby?

## Worked flow example (hypothetical)
Evening: FII cash -2,500 cr, DII +2,800 cr; FII futures long % 28% -> 38% over three days; Client net long reduced; Pro net long.
Morning: Nifty above 15-min structure low near 25,200 (highest Call OI); Call OI there falling, Put OI rising at 25,000/25,100.
Read: flow shifting bullish, structure supports, writers retreating.
Plan: wait for 15-min close above 25,200, buy ATM call on retest, stop on close below 25,180, target 25,400, book half at 1R, trail.
Counter-case: if FII long % fell back to 25%, FII selling continued and Call OI grew at 25,200, ignore the breakout or look for a rejection put.
