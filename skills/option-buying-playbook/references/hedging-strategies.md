# Hedging a CE/PE Buy: Reduce Loss, Theta and Vega

## Contents
1. What hedging really means for a buyer
2. Strategy toolbox
3. Debit spread (the main hedge): math and strike choice
4. Locking in profit: convert to a spread
5. Event hedges (straddle/strangle)
6. Portfolio hedge with index puts
7. Execution, margin and cost rules
8. Decision table
9. Use the calculator

## 1. What hedging really means for a buyer
A long CE/PE already has a maximum loss equal to the premium. There is no free hedge. Every hedge trades something away:
- A short leg **cuts premium, theta, vega and break-even distance**, but **caps profit**.
- A second long leg (straddle) **hedges direction**, but doubles the premium and exposes you to IV crush.
- "Minimal loss" is achieved by (a) a **hard-capped debit** and (b) disciplined stops, sizing and time exits. A hedge does not replace the stop.
Be honest with the user: hedging improves odds of survival and smooths losses; it does not create an edge.

## 2. Toolbox
| Strategy | Structure | Max loss | Max profit | Best when | Trade-off |
|---|---|---|---|---|---|
| **Bull call / bear put debit spread** | Buy ATM/ITM, sell further OTM same expiry | Net debit | Width - debit | High or elevated VIX, target near a known level or OI wall, weekly expiry | Profit capped at the short strike |
| **Lock-in (convert to spread)** | After a profit, sell OTM option against the long | Can be near zero or a locked profit | Capped | Trade is up 1R+ and nearing resistance/support | Gives up further upside |
| **Call/put butterfly** | Buy 1 lower, sell 2 middle, buy 1 upper | Net debit (small) | At the middle strike | You expect price to pin at a level (e.g. OI wall, expiry) | Narrow profit zone |
| **Calendar / diagonal** | Sell near expiry, buy far expiry same/similar strike | Net debit | Limited | Low VIX, slow grind, want less theta | Complex; needs liquid far expiry; vega risk |
| **Long straddle / strangle** | Buy CE and PE | Total premium | Unlimited | Big binary event, direction unknown | Expensive; IV crush kills it even on a big move |
| **Futures delta hedge** | Long option + opposite futures | Reduced | Reduced | Larger accounts managing a position | Margin, costs, constant rebalancing; not for beginners |
| **Protective index put** | Own stocks/ETFs, buy index put | Premium + gap below strike | Portfolio upside minus premium | Portfolio protection into events | Ongoing cost (about 0.5-1% per month in many conditions; check live) |
| **No-leg risk controls** | Smaller size, split entry, stop on underlying, time stop, scale out | Defined by stop | Uncapped | Always | Needs discipline only |

Not hedges: averaging down, buying the opposite option "to recover", or selling naked options to finance a buy.

## 3. Debit spread math (vertical)
Call spread: buy K1, sell K2 > K1. Put spread: buy K1, sell K2 < K1. Width W = |K2 - K1| (points).
- **Net debit D = premium(K1) - premium(K2)**
- **Max loss = D x lot size** (hard floor if both legs held to expiry; real stop usually hits earlier)
- **Max profit = (W - D) x lot size**, reached when price is beyond K2 at expiry
- **Break-even at expiry**: call K1 + D; put K1 - D
- **R:R at expiry = (W - D) / D.** Aim for 1.0 or better; below 0.7 means the short leg is too close or the long leg too expensive.
- Net delta = delta(K1) - delta(K2); net theta and vega are the differences, so they shrink sharply as the short leg gets closer to the long strike.
- Premium saved (%) = premium(K2) / premium(K1).

### Choosing the short strike
1. **At or just beyond your target** so the target is not capped. This is the default rule (the calculator uses it).
2. **At the nearest strong OI wall** (highest Call OI for a call spread, highest Put OI for a put spread), because price tends to stall there anyway; you give up little.
3. **At about 1 sigma expected move** over the hold if no clear target exists.
4. Avoid a short leg so close that the capped profit is under about 1R.
5. Prefer liquid strikes; far strikes may have wide bid-ask and slippage.

### When a spread beats a naked buy
- VIX high or event-adjacent: the short leg offsets vega, reducing IV-crush damage.
- Weekly options with 1 to 4 days left: the short leg offsets a large part of theta.
- Risk budget too small for a naked lot: a spread shrinks the loss per lot (in the calculator example at VIX 22, a naked ATM call fit 0 lots in a 1% budget while the spread fit 4).
- When a naked buy is better: low VIX, very fast expected move beyond the short strike, or a strong trend where you want uncapped upside.

## 4. Locking in profit ("free trade")
When a long option is up about 1R or more:
1. Sell half (or all) at 1R as usual; this is the first choice.
2. Alternatively **sell an OTM option at your next target against the remaining long**. The credit reduces net cost to near zero or locks a profit; the position is now a debit spread with a defined maximum loss.
3. Raise the underlying-based stop to cost and trail by structure.
Never close the long leg while leaving the short leg open; that creates a naked short with unlimited risk. Exit both together, or buy back the short first.

## 5. Event hedges (results, RBI policy, Budget)
- Long straddle/strangle break-evens: upper = call strike + total premium; lower = put strike - total premium. The move needed is the total premium. Compare it with the expected move (S x IV x sqrt(days/252)); if the implied move already prices it in, the trade has no edge.
- IV is usually inflated before the event and collapses after; a correct big move can still lose.
- Prefer defined-risk spreads over naked straddles, or skip the event.

## 6. Portfolio hedge with index puts
- **Hedge lots = (portfolio value x beta x hedge ratio) / (index level x lot size)**
- Example: Rs 25,00,000 portfolio, beta 1.1, Nifty 25,100, lot 75, hedge ratio 50% gives about 0.73 lots, so use 1 lot (verify lot size). Cost = lots x lot size x put premium (e.g. 1 x 75 x Rs 210 = Rs 15,750, about 0.63% of the portfolio).
- Choose a slightly OTM put for cheaper protection (protects only below the strike), ATM for tighter protection. Collar: sell an OTM call to fund the put (caps upside).
- Index puts hedge market risk only; stock-specific risk remains. Roll before expiry; protection decays like any option.

## 7. Execution, margin and cost rules
- **Place the buy leg first, then the sell leg**, so the sell leg qualifies for hedged-margin benefit. Verify the broker's margin treatment; do not assume.
- Use basket or spread orders where available to avoid legging risk. Check bid-ask on both legs; skip if spread cost is a large share of the debit.
- Costs: brokerage per leg, STT on option sell premium, exchange charges, GST, and exercise STT on in-the-money long options held to expiry (index options are cash-settled; confirm current rules with your broker). Two legs mean double the transaction cost.
- Same expiry for both legs in a vertical; do not leave a leg behind.
- Check the lot size, expiry day and freeze quantity with the exchange before trading.
- Hedging does not remove the stop: define an underlying-based stop and a time stop for the spread too.

## 8. Decision table
| Situation | Preferred structure |
|---|---|
| Normal VIX, clean intraday breakout, target far | Naked ATM/1-ITM (uncapped) |
| Elevated or high VIX | Debit spread |
| Weekly expiry, 1-4 days left, modest target | Debit spread, short strike at target |
| Trade up 1R, near next OI wall | Book half or sell the wall strike to lock |
| Expect pin at a level into expiry | Butterfly (small debit) |
| Big event, direction unknown | Skip, or a defined-risk spread; avoid paying inflated straddle |
| Holding stocks into an event | Index put hedge, sized by beta |
| Risk budget cannot fit one naked lot | Debit spread or skip |

## 9. Use the calculator
`python scripts/hedge_calculator.py spread --spot S --vix V --days D --direction call|put --long-strike K --target T --stop X --hold-days H --capital C --lot-size L` compares the naked option with spreads of increasing width (net debit, hard max loss, R:R at expiry and at exit, net theta/vega, lots) and suggests the cheapest spread whose short strike is at or beyond the target. Pass `--long-premium` and `--short-chain "strike:premium,..."` for live premiums. `python scripts/hedge_calculator.py portfolio --value V --beta B --index S --hedge-ratio R --put-premium P` sizes an index put hedge. Report the naked baseline alongside the spread so the user sees what is given up. Educational, not financial advice.
