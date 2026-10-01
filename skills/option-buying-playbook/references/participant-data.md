# FII / DII / Pro / Client Data

Gives **bias**, not entry timing. Published after close, so it is next-day context.

## Participants
| Group | Who | Behaviour |
|---|---|---|
| FII/FPI | Foreign funds | Largest in index F&O; futures shorts are often hedges against cash holdings |
| DII | Mutual funds, insurers, banks | Mostly cash market; steady dip buyers (SIP flows) |
| Pro | Prop desks, broker own-account, market makers | Short-term, arbitrage, often counterparty to retail; follow price action |
| Client | Retail + HNI | Mostly option buyers; SEBI studies show roughly 9 in 10 individual F&O traders lose money, so extreme retail positioning is a contrarian hint |

## Where to find it
NSE website (Market Data: FII/DII trading activity, participant-wise OI, participant-wise volume, FII derivatives statistics). Trendlyne, Sensibull, Opstra, Quantsapp chart it. Confirm report names/layout on NSE; they change.

## Metrics
- FII/DII cash flow (Rs crore): overall pressure. Use multi-day/monthly cumulative, not one day.
- FII index futures long %: Long / (Long + Short). Rough guide: >60-65% bullish, <30-35% bearish, ~50% neutral/hedged. **Trend matters more than level** (25% -> 40% over a week = short covering, bullish fuel).
- Net futures = Long - Short.
- FII index options: long calls + short puts lean bullish; long puts + short calls lean bearish. Confirms or contradicts the futures view.
- Participant-wise OI and volume: who is on which side, who was aggressive.

## FII vs DII cash
| FII | DII | Read |
|---|---|---|
| Buy | Buy | Strong uptrend support |
| Sell | Buy heavily | Cushioned; slower declines or range |
| Sell | Sell | Weak, bearish |
| Buy | Sell | Foreign-led rally; DII profit booking |

## Scenarios
| Scenario | Read | Idea |
|---|---|---|
| FII long % rising, cash buying, price above support | Accumulation | Calls on pullbacks/breakouts |
| FII short % rising, cash selling, price breaking support | Distribution | Puts on failed retests |
| FII heavily short, price stops falling | Short-squeeze potential | Calls on structure break above resistance |
| FII heavily long, price stalls at resistance | Crowded long | Watch rejection -> puts |
| Client heavily long, FII net short | Retail crowded | Lean to FII side, only with price confirmation |
| Client heavily short, FII net long | Retail squeezable | Bullish bias |
| Pro long, Client short, price rising | Smart short-term money aligned | Supports continuation |
| FII and DII both selling near resistance | Big money exiting | Bearish, avoid calls |

## Pain points and stops
- FII heavily short: stops above swing highs; break of resistance can trigger covering and gamma pressure on call writers (best breakout-call conditions).
- Retail heavily long: stops below obvious supports; expect sweeps below support, so buffer stops.
- Retail heavily short: squeeze above resistance adds to the rally.
- Put writers under pressure: a fall through a high Put OI strike accelerates via their futures hedging.
- If you entered on flow and the next release reverses sharply, exit even if the price stop is not hit.

## Limitations
End-of-day only; hedging distorts; options may be spreads; expiry/rollover distorts ratios; flows often follow price; crowded trades can persist for weeks; global factors (US yields, dollar, crude, geopolitics) can override.

## Mistakes
One day of FII flow treated as a trend; shorts read as bearish without hedging context; end-of-day data used as intraday trigger; ignoring rollover; flow without structure/OI; assuming retail is always wrong.
