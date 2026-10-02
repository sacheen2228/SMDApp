# Setups, Stops, Sizing, Management

## Setups (underlying-based; buy ATM/1-ITM option)
1. **Breakout + retest (call):** 15-min candle closes above resistance with strong body/volume; wait for pullback to broken level; enter on bullish candle holding it. Stop below retest low (or close back below level). Target next resistance/OI wall.
2. **Breakdown + retest (put):** mirror. Support becomes resistance.
3. **Support bounce (call):** rejection candle (hammer, bullish engulfing) at strong support with Put OI rising/holding. Enter on break of candle high. Stop below support close.
4. **Resistance rejection (put):** shooting star/bearish engulfing at resistance with Call OI rising and premiums not rising. Enter on break of candle low. Stop above resistance close.
5. **Failed breakout / trap reversal:** breaks a level, closes back inside; trade opposite. Often fastest-moving.

### OI-confirmed scenarios (hypothetical Nifty map: resistance 25,200 = highest Call OI; support 24,950 = highest Put OI; mid 25,075 = VWAP/pivot)
- **A, bullish breakout:** 15-min close above 25,200; Call OI there *falling*, Put OI rising at higher strikes; retest holds -> buy ATM call; stop close below retest low / back under 25,200; target next OI wall (~25,400).
- **B, rejection:** rejection candle at 25,200, Call OI *rising*, premiums not rising -> buy put on break of candle low; stop above rejection high; target VWAP/support.
- **C, support bounce:** hammer/engulfing at 24,950, Put OI rising -> call on break of candle high; stop below support close.
- **D, support breakdown:** close below 24,950, Put OI *falling*, failed retest from below -> put; stop back above 24,950.

## Stop-loss rules
1. Base on underlying structure (level close, swing low/high), not flat % of premium.
2. Premium stop ~ points x delta.
3. Candle-close stops avoid wicks but cost more per hit; size down.
4. Time stop: no move in 20-30 min -> exit.
5. Event stop: exit before major announcements unless planned.
6. Never move a stop further away.
7. Exit early if OI structure flips against the trade (aggressive opposite-side writing) or flow thesis reverses.

## Minimum reward:risk 1:2. Skip if the next level is too close.

## Sizing
Position size (lots) = (Capital x risk%) / (premium stop per lot).
Example: capital Rs 2,00,000, risk 1% = Rs 2,000. Stop of Rs 40/unit on a 75-unit lot = Rs 3,000/lot -> cannot take even one lot at 1%. Tighten the setup or use a cheaper instrument; do not over-risk. (Always verify the current lot size with the exchange/broker.)

## Hedge option
When VIX is elevated, expiry is near, or one naked lot exceeds the risk budget, convert the buy into a debit spread (see `references/hedging-strategies.md`).

## Management
- Book 50% at 1R-1.5R, move stop to cost, trail rest by structure (higher lows for calls, lower highs for puts).
- Daily loss limit: stop after 2-3 losses or 2-3% of capital.
- Never average down.

## Worked example (hypothetical)
Nifty resistance 25,100, support 24,950. A 15-min close at 25,125, pullback to 25,105 holds. Buy ATM call Rs 120 (delta ~0.5). Stop: close below 25,080 (~25 pts, ~Rs 12-13 premium). Target 1: 25,180 (+75 pts, ~Rs 37, about 3R). Sell half at T1, trail the rest.

## Common mistakes
Buying mid-range; chasing after a big candle; far-OTM jackpots; moving/removing stops; revenge trading; trading OI or flow alone; no journal.

## Getting started
Paper trade or minimum lots for 50+ trades. Track win rate, average R, max drawdown. Scale only when results are consistent.
