# Levels and Option-Chain OI

## Contents
1. Who is on the other side (buyers vs writers)
2. Marking levels
3. Reading the option chain
4. PCR
5. Caveats

## 1. Buyers vs writers
- Buyers pay premium, limited risk, need a move (mostly retail).
- Writers collect premium, large risk, profit from decay and ranges (mostly institutions, prop desks, usually hedged).
- Writers defend their strikes. Heavy **Put writing** at a strike = likely support. Heavy **Call writing** = likely resistance.
- While price stays on the right side of the strike, writers are comfortable. When price **breaks and holds**, writers must cover/hedge, and that flow fuels the move. Most big option-buying wins come from here.

## 2. Marking levels (use the underlying chart, pre-market)
| Level | Source |
|---|---|
| Previous day high/low/close | Daily chart |
| Weekly high/low | Weekly chart |
| Swing highs/lows | 15-min and 1-hr turning points |
| Round numbers | e.g. 25,000 / 25,500 |
| Pivots | P=(H+L+C)/3; R1=2P-L; S1=2P-H; R2=P+(H-L); S2=P-(H-L) |
| VWAP | Intraday dynamic S/R |
| 20/50 EMA on 15-min | Dynamic S/R in trends |
| Option chain OI | Highest Put OI = support zone, highest Call OI = resistance zone |

Keep it to 2 supports + 2 resistances near price. More lines means confusion.

## 3. Reading the chain
**Step 1, OI and Change in OI.** Total OI shows major zones; change in OI shows *current* positioning. Fresh writing matters more than old positions.

**Step 2, price + OI (futures for bias, strikes for levels):**
| Price | OI | Meaning | Bias |
|---|---|---|---|
| Up | Up | Long buildup | Bullish |
| Down | Up | Short buildup | Bearish |
| Up | Down | Short covering | Bullish but may fade |
| Down | Down | Long unwinding | Bearish but may fade |

**Step 3, strike-level changes:**
| Observation | Read |
|---|---|
| Put OI rising at strike, price above | Support strengthening |
| Call OI rising at strike, price below | Resistance strengthening |
| Put OI falling at support | Support weakening, break likely |
| Call OI falling at resistance | Resistance weakening, breakout likely |
| Call OI falling + price rising | Call writers covering, strong bullish |
| Put OI falling + price falling | Put writers covering, strong bearish |
| Put OI rising below price, Call OI falling | Bullish shift |
| Call OI rising above price, Put OI falling | Bearish shift |

**Step 4, premium behaviour.** If price nears a Call-writer strike and Call premiums do not fall while OI holds, writers are under pressure. If premiums drop as price approaches, writers are comfortable.

Compare snapshots every 15-30 minutes, not every minute.

## 4. PCR = total Put OI / total Call OI
- Above ~1.3: put-writer heavy, bullish/oversold lean.
- Below ~0.7: call-writer heavy, bearish/overbought lean.
- ~0.8-1.2: neutral.
Rules of thumb only. The intraday *trend* of PCR matters more than the number.

## 5. Caveats
- OI cannot say buyer vs seller; use price behaviour to infer.
- Big positions are often hedged spreads.
- Max pain has weak predictive value; minor reference near expiry only.
- The highest-OI strike is not an unbreakable wall. Breaks are where the best trades are.
- OI walls shift as expiry approaches; do not reuse yesterday's OI as if nothing changed.
- Never buy just because PCR is high/low, and never trade OI without price confirmation.
