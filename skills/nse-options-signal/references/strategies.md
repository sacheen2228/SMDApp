# Strategy playbook (levels + liquidity + OI)

No setup wins every time. Each strategy is a filter that must ALSO pass the bias score (|score| >= 40), the gates in SKILL.md, and the Greeks checks. Every trade idea must name its strategy and list the level(s) used.

## Step 1 - Build the level map (run `scripts/levels.py`)
Levels, strongest first: (a) OI walls (max Call OI = resistance, max Put OI = support), (b) previous day high/low/close (PDH/PDL/PDC), (c) opening range high/low (09:15-09:30 or 09:45), (d) VWAP, (e) max pain, (f) gamma-flip strike, (g) expected-move bands (open +/- 0.85 x ATM straddle), (h) round numbers (Nifty every 100, BankNifty every 500/1000), (i) weekly high/low, (j) pre-open gap edge, (k) 52-week high/low.
**Confluence zone** = 3+ levels within 0.15% of each other. Trade only AT or just beyond a zone, never in the middle of nowhere.

## Step 2 - Pick the regime
| Regime | Clues | Use |
|---|---|---|
| Trend day | net GEX negative, VIX rising, gap > 0.4% holding, FII bias strong, price above/below VWAP all morning | S4, S5, S6 |
| Range day | net GEX positive, price between OI walls, PCR 0.9-1.2, low VIX | S1, S3 |
| Event/unclear | RBI, budget, big results, US Fed night | S8 (spreads) or NO TRADE |

## Strategies

**S1 - OI wall rejection (range fade)**
Setup: price touches max-Call-OI strike (resistance) or max-Put-OI strike (support) inside a range regime.
Trigger: 5-min candle rejects the wall (long wick, close back inside) + OI at that wall is still rising (writers defending) + volume spike.
Trade: resistance -> BUY PE; support -> BUY CE. SL: 5-min close beyond the wall +0.1%. TP1: VWAP/mid-range, TP2: opposite wall (minus 10%).
Skip if the wall's OI is falling (writers leaving = breakout coming).

**S2 - OI wall breakout with unwinding (momentum)**
Setup: spot closes 2x5-min candles beyond the wall, and OI at that wall FALLS (writers covering) while OI builds at the next strike, volume > 1.5x average, VIX flat/up.
Trade: above resistance -> BUY CE; below support -> BUY PE. Entry on first pullback that holds the broken wall. SL: back inside the wall (5-min close). TP1: next OI wall or +40% premium, TP2: trail.

**S3 - Liquidity sweep reversal (stop-hunt)**
Liquidity pools = equal highs/lows, PDH/PDL, opening-range extremes, round numbers - where stop-losses cluster.
Setup: price spikes through the pool (wick >= 0.1% beyond; ~25 pts Nifty / 60 pts BankNifty) then closes back inside within 1-3 five-min candles.
Confirmation (need 2): OI addition on the opposite side at the sweep extreme (writers selling into the spike), volume spike then fade, IV spike then drop, heatmap/heavyweights not confirming the move, pre-open/closing-auction bias opposite to the sweep.
Trade: swept highs -> BUY PE; swept lows -> BUY CE. SL: beyond the sweep extreme +0.05%. TP1: VWAP or range midpoint, TP2: opposite liquidity pool. RR is usually 1:2+, which is the appeal.
Skip if the candle CLOSES beyond the level and holds (that is a breakout, use S2).

**S4 - Opening range breakout with gap context**
Setup: after 09:30 (or 09:45 for BankNifty), price breaks the opening-range high/low; pre-open gap and FII/PCR bias in the same direction; net GEX not strongly positive.
Trade: BUY CE on OR-high break, PE on OR-low break. Entry: 5-min close beyond OR + retest. SL: opposite side of OR midpoint. TP1: 1x OR height, TP2: 2x or next wall.
Skip: gap > 1% (exhaustion risk, wait for S3), or OR height > 0.7% (no room).

**S5 - VWAP trend pullback**
Setup: trend regime, price on one side of VWAP for 45+ minutes, higher-lows (or lower-highs) forming, OI building on the side of the trend (put writing in uptrend).
Trade: buy the pullback that touches VWAP / 20-EMA(5m) and reclaims. SL: 5-min close through VWAP. TP: previous swing extreme then trail behind VWAP. Best win-rate of the set because it trades with the flow, and it can be repeated 1-2x/day.

**S6 - Short-covering / writers' panic**
Setup: price rises while Call OI at/above spot drops sharply and India VIX rises (or price falls while Put OI unwinds). Volume spurts and OI-spurts pages show the same index/heavyweights.
Trade: same direction as price, ATM or 1 ITM. SL: 25% premium. Fast trade; book TP1 at +40% quickly, trail the rest. Never chase after premium is up > 40% from the day's low.

**S7 - Overnight / next-day gap bias**
Inputs after 15:30: closing auction imbalance, FII cash + futures OI change, participant OI, GIFT Nifty/US close, max pain move.
Use it to set a bias for the next session's S3/S4, NOT to buy options overnight (theta/gap risk). Confirm with the 09:00 pre-open indicative price.

**S8 - Defined-risk debit spreads (when premiums are rich)**
If VIX > 18, ATM theta > 8% of premium/day, or a known event is pending: use a bull call spread (buy ATM CE, sell OTM CE at the next wall) or bear put spread instead of a naked buy. Max loss = net debit, so SL = 50-60% of the debit; TP = 70-80% of the max width. This is the only permitted short leg: it must be covered by the long leg (never naked).

**Expiry-day rules**
Morning: price tends to gravitate to max pain/heavy-OI strike; only S1/S3 with small size. Gamma is explosive: moves of 0.5% can move ATM premium 2-3x, in both directions. No fresh entries after 13:30; if the setup is not obvious, skip the day.

## Option liquidity checklist (before ANY order)
- Strike OI in top 5 of the chain and volume > 1,000 lots in the last 30 min.
- Bid-ask spread <= 1-2% of premium (or <= Rs 0.5 on premiums under Rs 50).
- Prefer strikes listed in the "most active contracts" page; avoid deep OTM.
- Use limit orders at/near the bid-ask mid; never market orders in illiquid strikes.
- Check order-size vs depth: quantity should be < 20% of displayed top-5 depth.

## Confluence checklist (need >= 4 of 6, and the bias score must agree)
1. Price at/beyond a confluence zone  2. Liquidity event (sweep or clean break+retest)  3. OI behaviour supports (writers defending or covering)  4. Volume/OI spurt confirms  5. Greeks OK (delta 0.5-0.6, theta fine, TP inside expected move)  6. Heatmap/heavyweights + FII agree.

## Trade management (all strategies)
- SL is placed on the UNDERLYING level that invalidates the idea, converted to a premium value; if that SL is > 30% of premium, reduce size or skip.
- TP1 book 50% + SL to cost; trail the rest. Time stop 45 minutes if < +10%.
- No limit on the number of losing trades per day; each new trade must still pass all gates and confluence checks. Daily loss cap (3% of capital) still applies.
- Log every trade: strategy, levels, score, entry, SL, TP, exit reason, slippage. Review weekly; disable any strategy with negative expectancy over 30+ trades.
