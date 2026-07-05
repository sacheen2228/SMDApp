// COMPLETE OPTIONS TRADING KNOWLEDGE BASE
// Every strategy, every Greek, every chart pattern, every rule
// Written so a 5-year-old can understand, deep enough for professionals

export const TRADING_KNOWLEDGE = `
## ═══════════════════════════════════════════════════════════════
## PART 1: OPTIONS BASICS (Explain Like I'm 5)
## ═══════════════════════════════════════════════════════════════

### What is an Option?
An option is a BET on where the price will go. You pay a small amount (premium) for the RIGHT to buy or sell something at a specific price. If you're right, you make money. If you're wrong, you only lose the premium.

### Call Option (CE) = Bet price goes UP
- You think Nifty will go UP → Buy Call
- Example: Nifty at 24000, you buy 24100 CE for ₹50
- If Nifty goes to 24200, your option is worth ₹100 = profit ₹50
- If Nifty stays below 24100, your option expires worthless = lose ₹50

### Put Option (PE) = Bet price goes DOWN
- You think Nifty will go DOWN → Buy Put
- Example: Nifty at 24000, you buy 23900 PE for ₹50
- If Nifty goes to 23800, your option is worth ₹100 = profit ₹50
- If Nifty stays above 23900, your option expires worthless = lose ₹50

### Premium = Price of the Option
- Made of: Intrinsic Value + Time Value
- Intrinsic = How much the option is "in the money" right now
- Time Value = How much time is left until expiry (more time = more expensive)

### Strike Price = The price you agreed on
- ATM (At The Money) = Strike ≈ Current price
- ITM (In The Money) = Already profitable
- OTM (Out of The Money) = Not profitable yet (cheaper)

### Expiry = When the bet ends
- Weekly expiry: Every Thursday (Nifty, Banknifty)
- Monthly expiry: Last Thursday of month
- 0DTE = Same day expiry (very risky, very rewarding)

### Lot Size = Minimum quantity you must trade
- NIFTY: 65 units per lot
- BANKNIFTY: 30 units per lot
- FINNIFTY: 60 units per lot
- MIDCPNIFTY: 120 units per lot
- SENSEX: 20 units per lot

### Buying vs Selling
- BUYING: Risk = premium paid. Reward = unlimited. Safer.
- SELLING: Risk = unlimited. Reward = premium received. Risky. Needs margin.
- Beginners: ALWAYS BUY. Never sell naked options.

## ═══════════════════════════════════════════════════════════════
## PART 2: THE GREEKS (Explain Like I'm 5)
## ═══════════════════════════════════════════════════════════════

### DELTA (Δ) = How much option price changes when stock moves ₹1
- Call Delta: 0 to +1 (positive = moves with stock)
- Put Delta: 0 to -1 (negative = moves against stock)
- ATM Delta ≈ 0.50 (moves ₹0.50 for every ₹1 in stock)
- Deep ITM Delta ≈ 1.0 (moves almost ₹1 for ₹1 in stock)
- Far OTM Delta ≈ 0.01 (barely moves at all)
- **SIMPLE**: Delta tells you "how much money you make if stock moves ₹1"
- High delta = more responsive. Low delta = less responsive.

### GAMMA (Γ) = How fast Delta changes
- Highest for ATM options near expiry
- Gamma tells you "how quickly your delta will change"
- High gamma = big swings in profits/losses
- Low gamma = steady, predictable moves
- **DANGER**: High gamma near expiry = explosive moves (good or bad)
- Gamma is like acceleration in a car. Delta is speed. Gamma is how fast you're speeding up.

### THETA (Θ) = Time decay (your ENEMY when buying)
- Theta tells you how much value your option LOSES each day
- Example: Theta = -5 means your option loses ₹5 per day
- Theta accelerates as expiry approaches
- **SIMPLE**: Time is melting your option like ice in the sun
- Buy options with MORE days to expiry (less theta decay)
- Sell options with FEWER days to expiry (collect theta)

### VEGA (ν) = Sensitivity to volatility
- Vega tells you how much option price changes when volatility changes
- High Vega = option price swings wildly with IV changes
- Before events (budget, elections, RBI): IV spikes → Vega makes options expensive
- After events: IV crashes → Vega makes options cheap (IV crush)
- **SIMPLE**: Vega tells you "how much fear is priced into this option"

### RHO (ρ) = Sensitivity to interest rates
- Barely matters for short-term trades
- Only important for LEAPS (long-term options, 6+ months)
- Ignore Rho for day trading

### IV (Implied Volatility) = How much the market EXPECTS the stock to move
- High IV = market expects big moves = expensive options
- Low IV = market expects small moves = cheap options
- IV Percentile: Where current IV is vs last 1 year
  - 0-25%: Very cheap (good time to buy)
  - 25-50%: Normal
  - 50-75%: Getting expensive
  - 75-100%: Very expensive (good time to sell)
- **SIMPLE**: IV is the "fear gauge" of options. High fear = high prices.

### IV Rank vs IV Percentile
- IV Rank: (Current IV - 52-week low) / (52-week high - 52-week low)
- IV Percentile: % of days in last year when IV was LOWER than today
- IV Percentile is more useful because it shows "how often is it this cheap/expensive"

## ═══════════════════════════════════════════════════════════════
## PART 3: ALL OPTIONS STRATEGIES (Complete Guide)
## ═══════════════════════════════════════════════════════════════

### STRATEGY 1: LONG CALL (Buy CE)
- When: You think market will go UP
- How: Buy a Call option
- Risk: Limited (premium paid)
- Reward: Unlimited
- Example: Buy NIFTY 24000 CE @ ₹100
- Max Loss: ₹100 per unit × 65 lot = ₹6,500
- Breakeven: 24000 + 100 = 24100
- When to use: Bullish trend, low IV, good support nearby

### STRATEGY 2: LONG PUT (Buy PE)
- When: You think market will go DOWN
- How: Buy a Put option
- Risk: Limited (premium paid)
- Reward: Substantial (until stock hits 0)
- Example: Buy NIFTY 24000 PE @ ₹100
- Max Loss: ₹6,500
- Breakeven: 24000 - 100 = 23900
- When to use: Bearish trend, high IV (expecting drop), good resistance nearby

### STRATEGY 3: BULL CALL SPREAD
- When: Moderately bullish
- How: Buy lower strike CE + Sell higher strike CE (same expiry)
- Risk: Limited (net premium paid)
- Reward: Limited (strike difference - premium)
- Example: Buy 24000 CE @ ₹100 + Sell 24200 CE @ ₹30
- Net cost: ₹70
- Max Profit: (24200-24000) - 70 = ₹130 per unit
- When to use: Bullish but don't expect huge move. Want to reduce cost.

### STRATEGY 4: BEAR PUT SPREAD
- When: Moderately bearish
- How: Buy higher strike PE + Sell lower strike PE (same expiry)
- Risk: Limited (net premium paid)
- Reward: Limited (strike difference - premium)
- Example: Buy 24000 PE @ ₹100 + Sell 23800 PE @ ₹30
- Net cost: ₹70
- Max Profit: (24000-23800) - 70 = ₹130 per unit
- When to use: Bearish but don't expect crash. Want to reduce cost.

### STRATEGY 5: STRADDLE (Long)
- When: Expecting BIG move but don't know direction
- How: Buy ATM Call + Buy ATM Put (same strike, same expiry)
- Risk: Limited (both premiums)
- Reward: Unlimited (if move is big enough)
- Example: Buy 24000 CE @ ₹100 + Buy 24000 PE @ ₹100
- Total cost: ₹200
- Breakeven: 24000 ± 200 (needs to move 200+ points)
- When to use: Before major events (budget, election results, RBI policy)

### STRATEGY 6: STRANGLE (Long)
- When: Expecting BIG move but want cheaper entry
- How: Buy OTM Call + Buy OTM Put (different strikes)
- Risk: Limited (both premiums, cheaper than straddle)
- Reward: Unlimited (if move is big enough)
- Example: Buy 24200 CE @ ₹50 + Buy 23800 PE @ ₹50
- Total cost: ₹100
- Breakeven: 24300 or 23700
- When to use: Same as straddle but cheaper. Needs bigger move to profit.

### STRATEGY 7: IRON CONDOR
- When: Expecting NO BIG MOVE (range-bound)
- How: Bull Put Spread + Bear Call Spread combined
- Risk: Limited
- Reward: Limited (net premium received)
- Example:
  - Sell 24200 CE @ ₹30
  - Buy 24300 CE @ ₹15
  - Sell 23800 PE @ ₹30
  - Buy 23700 PE @ ₹15
- Net credit: ₹30
- Max Profit: ₹30 per unit
- Breakeven: 23770 to 24230
- When to use: Market is stuck in a range. Low volatility expected.

### STRATEGY 8: IRON BUTTERFLY
- When: Expecting market to stay near a specific level
- How: Sell ATM Straddle + Buy OTM Strangle
- Risk: Limited
- Reward: Limited (highest reward-to-risk of range strategies)
- Example:
  - Sell 24000 CE @ ₹100 + Sell 24000 PE @ ₹100
  - Buy 24200 CE @ ₹30 + Buy 23800 PE @ ₹30
- Net credit: ₹140
- Max Profit: ₹140 per unit
- When to use: Very confident market won't move much

### STRATEGY 9: COVERED CALL
- When: Own the stock and want extra income
- How: Own stock + Sell OTM Call
- Risk: Reduced (stock cushions losses)
- Reward: Limited (premium + limited upside)
- When to use: Holding stock, expect flat/slightly bullish

### STRATEGY 10: PROTECTIVE PUT
- When: Own stock and want insurance
- How: Own stock + Buy Put
- Risk: Limited to premium cost
- Reward: Unlimited upside protected
- When to use: Holding stock, worried about crash

### STRATEGY 11: CALENDAR SPREAD (Time Spread)
- When: Expecting low near-term move, big move later
- How: Sell near-term option + Buy same strike longer-term option
- Risk: Limited
- Reward: Limited
- When to use: Low IV now, expect IV to rise later

### STRATEGY 12: DIAGONAL SPREAD
- When: Directional + time decay play
- How: Different strikes AND different expiries
- Risk: Limited
- Reward: Limited
- When to use: Mildly directional, want to collect theta

### STRATEGY 13: JADE LIZARD
- When: Bullish + neutral
- How: Short Put + Short Call Spread (no upside risk)
- Risk: Unlimited on downside (if put assigned)
- Reward: Net premium received
- When to use: Very bullish, want to collect premium

### STRATEGY 14: REVERSE IRON CONDOR
- When: Expecting BIG move (direction uncertain)
- How: Buy OTM Call Spread + Buy OTM Put Spread
- Risk: Limited (net premium paid)
- Reward: Limited (max when price at one of the short strikes)
- When to use: Low IV, expecting breakout in either direction

## ═══════════════════════════════════════════════════════════════
## PART 4: CHART PATTERNS (Complete Guide)
## ═══════════════════════════════════════════════════════════════

### REVERSAL PATTERNS (Change direction)

#### HEAD AND SHOULDERS
- 3 peaks: Left shoulder, Head (tallest), Right shoulder
- Neckline connects the lows between peaks
- Sell when price breaks BELOW neckline
- Target: Height of head from neckline, projected down
- Reliability: Very high (85%+)
- **SIMPLE**: Looks like a person with head and 2 shoulders. Means "top is in."

#### INVERSE HEAD AND SHOULDERS
- 3 troughs: Left shoulder, Head (lowest), Right shoulder
- Buy when price breaks ABOVE neckline
- Target: Height of head from neckline, projected up
- Reliability: Very high
- **SIMPLE**: Upside down head and shoulders. Means "bottom is in."

#### DOUBLE TOP (M Pattern)
- 2 peaks at roughly same level
- Sell when price breaks below the trough between peaks
- Target: Height from peaks to trough, projected down
- Reliability: High (75%+)
- **SIMPLE**: Price tried to go up twice and failed. Means "up is done."

#### DOUBLE BOTTOM (W Pattern)
- 2 troughs at roughly same level
- Buy when price breaks above the peak between troughs
- Target: Height from troughs to peak, projected up
- Reliability: High
- **SIMPLE**: Price tried to go down twice and failed. Means "down is done."

#### TRIPLE TOP / TRIPLE BOTTOM
- Same as double but with 3 attempts
- Even more reliable than double top/bottom
- **SIMPLE**: Three strikes and you're out. Stronger reversal signal.

#### ROUNDING BOTTOM (Saucer)
- Gradual shift from bearish to bullish
- Takes weeks or months to form
- Buy when price breaks above resistance
- Reliability: High for long-term trades

#### V REVERSAL (Spike)
- Sharp reversal with no consolidation
- Very hard to trade (happens fast)
- Usually caused by news events
- **SIMPLE**: Price crashes then immediately bounces. Catch it or miss it.

### CONTINUATION PATTERNS (Same direction continues)

#### BULL FLAG
- Strong up move (flagpole) + slight downward drift (flag)
- Buy when price breaks above flag resistance
- Target: Height of flagpole from breakout
- Reliability: High (80%+)
- **SIMPLE**: Price ran up, took a breather, about to run again.

#### BEAR FLAG
- Strong down move + slight upward drift
- Sell when price breaks below flag support
- Target: Height of flagpole from breakdown
- Reliability: High

#### ASCENDING TRIANGLE
- Flat resistance + rising support (higher lows)
- Buy when price breaks above resistance
- Target: Height of triangle from breakout
- Reliability: High (70%+)
- **SIMPLE**: Price keeps bouncing higher. Like a compressed spring. About to pop up.

#### DESCENDING TRIANGLE
- Flat support + falling resistance (lower highs)
- Sell when price breaks below support
- Target: Height of triangle from breakdown
- Reliability: High

#### SYMMETRICAL TRIANGLE
- Converging trendlines (higher lows + lower highs)
- Direction uncertain until breakout
- Wait for breakout, then trade in that direction
- **SIMPLE**: Price is squeezing tighter and tighter. About to explode one way.

#### WEDGE (Rising / Falling)
- Rising wedge: Bearish (even in uptrend)
- Falling wedge: Bullish (even in downtrend)
- Breakout opposite to wedge direction
- Reliability: High

#### PENNANT
- Small symmetrical triangle after strong move
- Continuation pattern
- Trade in direction of the prior move

#### CUP AND HANDLE
- U-shaped bottom (cup) + small pullback (handle)
- Buy when price breaks above handle resistance
- Very reliable for long-term trades
- **SIMPLE**: Looks like a cup of coffee with handle. Bullish.

#### CUP AND HANDLE (Inverse)
- Inverted cup shape
- Bearish continuation

### CANDLESTICK PATTERNS

#### SINGLE CANDLE PATTERNS
- **Doji**: Open ≈ Close. Indecision. Big deal at tops/bottoms.
- **Hammer**: Small body, long lower wick. Bullish at bottom.
- **Inverted Hammer**: Small body, long upper wick. Bullish at bottom.
- **Hanging Man**: Small body, long lower wick. Bearish at top.
- **Shooting Star**: Small body, long upper wick. Bearish at top.
- **Marubozu**: Full body, no wicks. Strong conviction.
- **Spinning Top**: Small body, both wicks long. Indecision.

#### DOUBLE CANDLE PATTERNS
- **Bullish Engulfing**: Green candle fully covers red. Bullish reversal.
- **Bearish Engulfing**: Red candle fully covers green. Bearish reversal.
- **Tweezer Top**: Two candles with same high. Bearish reversal.
- **Tweezer Bottom**: Two candles with same low. Bullish reversal.
- **Harami**: Small candle inside large candle. Reversal coming.

#### TRIPLE CANDLE PATTERNS
- **Morning Star**: Red → Small → Green. Bullish reversal.
- **Evening Star**: Green → Small → Red. Bearish reversal.
- **Three White Soldiers**: 3 consecutive green. Strong bullish.
- **Three Black Crows**: 3 consecutive red. Strong bearish.
- **Three Inside Up**: Red → Green inside → Green above. Bullish.
- **Three Inside Down**: Green → Red inside → Red below. Bearish.

## ═══════════════════════════════════════════════════════════════
## PART 5: TECHNICAL INDICATORS (Complete Guide)
## ═══════════════════════════════════════════════════════════════

### MOVING AVERAGES
- **EMA 9**: Fast, reacts quickly. Short-term trend.
- **EMA 21**: Medium, smooth. Medium-term trend.
- **EMA 50**: Slow, reliable. Long-term trend.
- **EMA 200**: Very slow, very reliable. Major trend.
- **Rule**: Price above EMA = Bullish. Below = Bearish.
- **Golden Cross**: 50 EMA crosses above 200 EMA = Bullish
- **Death Cross**: 50 EMA crosses below 200 EMA = Bearish
- **SIMPLE**: EMAs are like lanes on a highway. Price in fast lane = fast. Price in slow lane = slow.

### RSI (Relative Strength Index)
- Measures momentum (0-100)
- Above 70: Overbought (might drop)
- Below 30: Oversold (might rise)
- Divergence: Price making new high but RSI not = bearish
- **SIMPLE**: RSI tells you "is the stock tired?" Above 70 = very tired. Below 30 = very fresh.

### MACD (Moving Average Convergence Divergence)
- MACD Line = 12 EMA - 26 EMA
- Signal Line = 9 EMA of MACD Line
- Histogram = MACD - Signal
- Buy when MACD crosses above Signal
- Sell when MACD crosses below Signal
- **SIMPLE**: MACD tells you "which way is momentum moving?"

### BOLLINGER BANDS
- Middle Band = 20 SMA
- Upper Band = Middle + 2 Standard Deviations
- Lower Band = Middle - 2 Standard Deviations
- Price touching upper band = Overbought
- Price touching lower band = Oversold
- Squeeze (bands narrow) = Big move coming
- **SIMPLE**: Bollinger Bands are like rubber bands. Price tries to stay inside. When it stretches too far, it snaps back.

### VWAP (Volume Weighted Average Price)
- Average price weighted by volume
- Institutions use this as "fair value"
- Price above VWAP = Bullish (buyers in control)
- Price below VWAP = Bearish (sellers in control)
- **SIMPLE**: VWAP is the "average price everyone paid today." Above = paying more = bullish. Below = paying less = bearish.

### SUPERTREND
- Based on ATR (Average True Range)
- Green line above price = Bearish (sell)
- Red line below price = Bullish (buy)
- Very reliable for trend following
- **SIMPLE**: Supertrend is a traffic light. Green = go short. Red = go long.

### ADX (Average Directional Index)
- Measures trend strength (0-100)
- Above 25: Strong trend
- Below 20: Weak trend / ranging
- +DI above -DI: Bullish trend
- -DI above +DI: Bearish trend
- **SIMPLE**: ADX tells you "is there a trend or is the market sleeping?" Above 25 = market is moving.

### ATR (Average True Range)
- Measures volatility (how much price moves per day)
- Used to set stop losses
- SL = Entry ± (1.5 × ATR)
- **SIMPLE**: ATR tells you "how much does this stock normally move in a day?"

### VOLUME ANALYSIS
- Rising price + Rising volume = Strong move
- Rising price + Falling volume = Weak move (might reverse)
- Falling price + Rising volume = Strong sell-off
- Volume spike = Something big happening
- **SIMPLE**: Volume is like fuel. Big moves need big fuel.

### SUPPORT AND RESISTANCE
- Support = Price level where buyers step in (floor)
- Resistance = Price level where sellers step in (ceiling)
- Once broken, support becomes resistance and vice versa
- Stronger if: more touches, higher volume at that level, longer time spent
- **SIMPLE**: Support = floor. Resistance = ceiling. Price bounces between them like a ball.

## ═══════════════════════════════════════════════════════════════
## PART 6: OPEN INTEREST (OI) ANALYSIS
## ═══════════════════════════════════════════════════════════════

### What is Open Interest?
- Number of outstanding contracts (not yet settled)
- OI increases = New positions being created
- OI decreases = Positions being closed
- **SIMPLE**: OI tells you "how many bets are still open."

### PCR (Put-Call Ratio)
- PCR = Total Put OI / Total Call OI
- PCR > 1.2: More puts = Bullish (people buying protection)
- PCR < 0.8: More calls = Bearish (people betting down)
- PCR 0.8-1.2: Neutral
- **SIMPLE**: PCR tells you "are people more scared (buying puts) or greedy (buying calls)?"

### OI Build-up Types
1. **Long Build-up**: Price ↑ + OI ↑ = Bullish (new buyers entering)
2. **Short Build-up**: Price ↓ + OI ↑ = Bearish (new sellers entering)
3. **Long Unwinding**: Price ↓ + OI ↓ = Bearish (buyers exiting)
4. **Short Covering**: Price ↑ + OI ↓ = Bullish (sellers exiting)

### Max Pain
- Strike where most options expire worthless
- Market tends to move towards max pain near expiry
- **SIMPLE**: Max pain is where the option sellers make the most money. Market tends to go there.

### OI Migration
- When OI shifts from one strike to another
- Shows where big players are moving their positions
- Track OI changes over time to spot trends

## ═══════════════════════════════════════════════════════════════
## PART 7: RISK MANAGEMENT (Non-Negotiable Rules)
## ═══════════════════════════════════════════════════════════════

### THE 2% RULE
- NEVER risk more than 2% of capital on a single trade
- Capital ₹1,00,000 → Max risk ₹2,000 per trade
- Capital ₹5,00,000 → Max risk ₹10,000 per trade
- This is how professionals survive

### STOP LOSS FORMULA
- SL Premium = Entry Premium × 0.65 (lose 35% max)
- Or: SL = Entry - (1.5 × ATR)
- ALWAYS set SL before entering. NEVER remove it.

### TAKE PROFIT FORMULA
- TP = Entry + (Risk × 2) → Minimum 1:2 Risk:Reward
- Example: Buy @ ₹100, SL @ ₹65 (risk ₹35)
- TP = ₹100 + (35 × 2) = ₹170
- If R:R is less than 1:2, DON'T take the trade

### POSITION SIZING FORMULA
- Lots = (Capital × Risk%) ÷ (Risk per lot)
- Risk per lot = (Entry - SL) × Lot Size
- Example: Capital ₹1,00,000, Risk 2%, Entry ₹100, SL ₹65, Lot 25
- Risk per lot = (100 - 65) × 25 = ₹875
- Lots = (1,00,000 × 0.02) ÷ 875 = 2.28 → 2 lots

### DAILY RULES
1. MAX 2 trades per day. No exceptions.
2. Risk only 2% of capital per trade.
3. Set SL and TP BEFORE entering. Use GTT orders.
4. If SL hits on Trade #1, NO Trade #2 today.
5. Close all positions by 3:15 PM (avoid expiry chaos).
6. If no setup matches, DO NOT FORCE a trade.
7. Keep a journal. Review every weekend.

### WHEN NOT TO TRADE
- Market is choppy / no clear trend
- Major event coming (budget, elections, RBI)
- You're emotional (angry, revenge trading, FOMO)
- You didn't sleep well
- You already took a loss today
- The setup doesn't match your rules
- VIX is extremely high (>30)
- It's lunch time (12:00-1:30 PM) - low volume, fake moves
- Last 15 minutes - too close to close

## ═══════════════════════════════════════════════════════════════
## PART 8: STRATEGY SELECTION GUIDE
## ═══════════════════════════════════════════════════════════════

### IF MARKET IS BULLISH (Uptrend)
- Best: Long Call, Bull Call Spread, Bull Put Spread
- Avoid: Long Put, Bear strategies
- Entry: Buy ATM or slightly ITM Call
- When to enter: After pullback to support or EMA

### IF MARKET IS BEARISH (Downtrend)
- Best: Long Put, Bear Put Spread, Bear Call Spread
- Avoid: Long Call, Bull strategies
- Entry: Buy ATM or slightly ITM Put
- When to enter: After pullback to resistance or EMA

### IF MARKET IS SIDEWAYS (Range-bound)
- Best: Iron Condor, Iron Butterfly, Short Straddle/Strangle
- Avoid: Long straddle/strangle (theta kills you)
- Entry: When price is at range extremes
- When to enter: When IV is high (collect premium)

### IF BIG MOVE EXPECTED (but direction unknown)
- Best: Long Straddle, Long Strangle, Strangle (cheaper)
- Avoid: Iron Condor (you'll get destroyed)
- Entry: Before event, when IV is still low
- When to enter: 1-2 days before event

### IF VOLATILITY IS HIGH (IV > 50th percentile)
- Best: Short strategies (Iron Condor, credit spreads)
- Avoid: Long options (too expensive)
- When to enter: After event (IV crush = profits)

### IF VOLATILITY IS LOW (IV < 25th percentile)
- Best: Long options (Straddle, Strangle, directional)
- Avoid: Short strategies (small premium, big risk)
- When to enter: Before event (IV expansion = profits)

### IF MARKET IS TRENDING (ADX > 25)
- Best: Directional strategies (Call/Put, Spreads)
- Avoid: Range strategies (Iron Condor)
- When to enter: On pullbacks in trend direction

### IF MARKET IS RANGING (ADX < 20)
- Best: Range strategies (Iron Condor, Short Strangle)
- Avoid: Directional strategies (whipsawed)
- When to enter: At range extremes

## ═══════════════════════════════════════════════════════════════
## PART 9: INDIA-SPECIFIC KNOWLEDGE
## ═══════════════════════════════════════════════════════════════

### MARKET TIMINGS
- Pre-market: 9:00 AM - 9:15 AM
- Market open: 9:15 AM
- Lunch time: 12:00 PM - 1:30 PM (avoid trading)
- Market close: 3:30 PM
- Post-market: 3:30 PM - 4:00 PM

### EXPIRY DAY RULES
- Nifty expiry: Every Thursday
- Banknifty expiry: Every Wednesday
- 0DTE trades: ONLY with confidence > 92%
- Close all positions by 3:15 PM on expiry
- Gamma risk is extreme on expiry day

### LOT SIZES (Current as of 2024)
- NIFTY: 65
- BANKNIFTY: 30
- FINNIFTY: 60
- MIDCPNIFTY: 120
- SENSEX: 20
- RELIANCE: 250
- TCS: 175
- INFY: 400

### KEY EVENTS THAT MOVE MARKETS
- RBI Policy (every 2 months)
- Union Budget (February)
- Monthly expiry (last Thursday)
- US Fed meetings
- Election results
- Q3/Q4 results season
- Geo-political events

### TRANSACTION COSTS
- STT (Securities Transaction Tax): 0.05% on sell side
- Exchange transaction charges
- SEBI turnover fees
- GST on brokerage
- Stamp duty
- **Always factor these into your P&L calculations**

## ═══════════════════════════════════════════════════════════════
## PART 10: COMMON MISTAKES TO AVOID
## ═══════════════════════════════════════════════════════════════

1. **Overtrading**: Taking too many trades. Quality > Quantity.
2. **No Stop Loss**: Hoping it will come back. It often doesn't.
3. **Revenge Trading**: Lost money → trying to "get it back" → lose more.
4. **FOMO**: "Everyone is making money, I must enter NOW!" → Trap.
5. **Averaging Down**: Buying more of a losing position. Makes losses bigger.
6. **Ignoring IV**: Buying expensive options that need huge move to profit.
7. **Trading Expiry**: 0DTE is gambling unless you're experienced.
8. **Selling Naked**: Unlimited risk. One bad trade can wipe you out.
9. **Ignoring News**: Major events can destroy your position in seconds.
10. **Overconfidence**: One good week doesn't mean you're a genius.
11. **Ignoring Position Sizing**: Betting too much on one trade.
12. **Trading Lunch Time**: Low volume, fake moves, theta decay.
13. **Changing Strategy Mid-Trade**: Stick to your plan.
14. **Not Journaling**: If you don't track, you can't improve.
15. **Trading When Emotional**: Stop. Breathe. Walk away.

## ═══════════════════════════════════════════════════════════════
## PART 11: HOW TO EXPLAIN TO A 5-YEAR-OLD
## ═══════════════════════════════════════════════════════════════

### When asked "What is an option?"
"Imagine you want to buy a toy that costs ₹100 next week. But you're not sure if the price will go up. So you pay ₹5 to a shopkeeper to RESERVE the toy at ₹100. If the toy price goes to ₹120, you still buy at ₹100 = you save ₹20 minus ₹5 fee = ₹15 profit! If toy price stays ₹100 or goes down, you just don't buy it = you lose only ₹5."

### When asked "What is a Call option?"
"It's like a reservation slip to BUY something at a fixed price. If the price goes UP, your reservation becomes more valuable. If price goes DOWN, your reservation is worthless."

### When asked "What is a Put option?"
"It's like insurance for your house. If your house (stock) gets damaged (price drops), the insurance (Put option) pays you. If nothing happens, you just paid the premium."

### When asked "What is Delta?"
"If Nifty moves ₹1, how much does your option move? If Delta is 0.5, your option moves ₹0.50. Higher Delta = more sensitive."

### When asked "What is Theta?"
"Theta is like an ice cream melting in the sun. Every day, your option loses a little value because time is passing. The closer to expiry, the faster it melts."

### When asked "What is IV?"
"IV is like a fear gauge. When people are scared, they pay more for protection (options become expensive). When people are calm, options are cheap."

### When asked "What is a Straddle?"
"You're betting that SOMETHING big will happen, but you don't know if it's good or bad news. You buy both a Call AND a Put. If the price moves a LOT in either direction, you make money."

### When asked "What is an Iron Condor?"
"You're betting that NOTHING big will happen. The price stays in a range. You sell options on both sides and collect the premium. If price stays still, you keep the money."

### When asked "How do I pick a strategy?"
"First, ask yourself: Where do I think the market is going? UP → Buy Call. DOWN → Buy Put. NOWHERE → Sell options. BIG MOVE but don't know direction → Straddle. Then check: Is IV high or low? High → Sell. Low → Buy. Then check: How much time till expiry? More time = less theta. Always use stop loss."

### When asked "What is the best strategy for beginners?"
"Buy ATM Call or Put. That's it. Don't do spreads, don't do iron condors, don't sell options. Just buy one option with a stop loss. Master this first. Then learn spreads. Then learn selling."

## ═══════════════════════════════════════════════════════════════
## PART 12: PROFESSIONAL TIPS
## ═══════════════════════════════════════════════════════════════

### ENTRY TIMING
- Best entry: 9:30 AM - 11:30 AM (morning momentum)
- Second best: 2:00 PM - 3:00 PM (afternoon trend)
- Avoid: 12:00 PM - 1:30 PM (lunch time chop)
- Avoid: Last 15 minutes (too close to close)

### PREMIUM BUYING TIPS
- Buy options when IV is LOW (< 30th percentile)
- Buy ATM or slightly ITM (Delta 0.4-0.6)
- Avoid far OTM (Delta < 0.2) - needs huge move to profit
- Hold for 1-3 days for swing trades
- On 0DTE: Only ATM, only with 90%+ confidence

### PREMIUM SELLING TIPS (Advanced)
- Sell options when IV is HIGH (> 70th percentile)
- Sell OTM (Delta < 0.3)
- Width of spread should be 2-3x the premium received
- Close at 50% profit
- Never hold till expiry (gamma risk)

### SCALPING TIPS (Intraday)
- Use 5-minute chart
- Enter on VWAP cross
- Exit at 0.3-0.5% profit
- SL at 0.2% loss
- Only during high volume hours
- Max 5-10 trades per day

### SWING TRADING TIPS
- Use daily chart
- Enter on support/resistance bounce
- Hold 2-5 days
- SL below support / above resistance
- Target previous high/low
- Best during trending markets

## ═══════════════════════════════════════════════════════════════
## PART 13: EMERGENCY RESPONSES
## ═══════════════════════════════════════════════════════════════

### If user says "I'm losing money"
1. STOP trading immediately
2. Don't revenge trade
3. Check if SL was hit (it should have been)
4. Review what went wrong
5. Take a break. Come back tomorrow.
6. Risk only 1% tomorrow, not 2%.

### If user says "Should I hold or exit?"
1. Check if original thesis is still valid
2. Check time to expiry
3. Check if SL has been hit
4. If SL hit → EXIT immediately
5. If thesis invalid → EXIT
6. If thesis valid and SL not hit → HOLD

### If user says "What's the best trade right now?"
1. Don't give random calls
2. Explain current market condition
3. Suggest strategy that fits condition
4. Give specific entry/SL/TP
5. Remind about position sizing
6. Add disclaimer: "This is analysis, not financial advice"

### If user asks "Is this gambling?"
1. No, if you have a SYSTEM with edge
2. Yes, if you're gambling without analysis
3. Options trading = calculated risk with analysis
4. Gambling = random bets with no edge
5. Key difference: Do you have a strategy that works more than 50% of the time with good R:R?

## ═══════════════════════════════════════════════════════════════
## PART 14: RESPONSE FORMAT RULES
## ═══════════════════════════════════════════════════════════════

When responding:
1. Be DIRECT. Use bullet points. No fluff.
2. Always include: Strike, Entry, SL, TP, Confidence, R:R if giving a trade.
3. Use Indian market terms: CE/PE, lot size, premium, OI, PCR, max pain.
4. Risk warning: "Risk 1-2% of capital per trade."
5. If confidence < 85%, say NO TRADE. Never force a trade.
6. Format: **bold** for key values, bullet points for lists.
7. Keep responses under 250 words unless asked for detail.
8. When asked for explanation, use the "5-year-old" analogies from Part 11.
9. Capital preservation is ALWAYS the first priority.
10. If you don't know something, say "I don't have enough data" instead of guessing.
`;

export default TRADING_KNOWLEDGE;
