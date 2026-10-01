# Scoring rules

Score = sum of components, clipped to [-100, +100]. Positive = bullish (CE), negative = bearish (PE).

## 1. Option chain (max +/-25)  [new weights below total 100]
- PCR (total put OI / total call OI): >1.3 => +8 ; 1.0-1.3 => +3 ; 0.8-1.0 => -3 ; <0.8 => -8. (PCR > 1.7 is extreme/overbought, cap at +4.)
- Spot vs OI walls: resistance = strike with max Call OI above spot; support = max Put OI below spot. Spot within 0.3% of resistance => -6; within 0.3% of support => +6. Break above resistance with call OI unwinding => +8; break below support with put OI unwinding => -8.
- OI change (today): Put OI addition near ATM > Call OI addition => +8; reverse => -8. Call writing shifting to lower strikes => -4; put writing shifting to higher strikes => +4.
- Max pain vs spot: spot >0.7% above max pain => -2; >0.7% below => +2 (weak, mainly expiry week).

## 2. FII / institutional (max +/-15)  (NSE FII/DII + participant OI + BSE FII summary)
- FII cash net (crore): > +2000 => +6; +500..2000 => +3; -500..-2000 => -3; < -2000 => -6. If DII is large and opposite, halve this score.
- FII index futures long % of (long+short): >60% => +8; 45-60% => 0; <35% => -8; rising vs previous day => +3, falling => -3.
- FII index options: net long calls/short puts => +3, opposite => -3.

## 3. OI spurts + most active contracts (max +/-12)
- Price up + OI up = long buildup (+); price down + OI up = short buildup (-); price up + OI down = short covering (weak +); price down + OI down = long unwinding (weak -).
- Index/heavyweight contracts count 2x. Score = 15 * (weighted bull - weighted bear) / total weight.
- Most active: PE-heavy with rising price = bullish, CE-heavy with falling price = bearish (+/-3).

## 4. Pre-open / closing auction (max +/-8)
- Pre-open Nifty indicative gap > +0.4% => +5; < -0.4% => -5. Pre-open A/D > 2 => +3; < 0.5 => -3.
- Previous closing auction: buying imbalance / close near day high => +2; opposite => -2.

## 5. Gainers/losers + volume spurts (max +/-10)
- F&O breadth: >65% advancing => +5; <35% => -5.
- Heavyweights (HDFCBANK, ICICIBANK, RELIANCE, INFY, TCS, ITC, LT, BHARTIARTL, SBIN, AXISBANK, KOTAKBANK): in top gainers with volume spurt => +1.5 each; top losers with volume spurt => -1.5 each (max +/-10). For BANKNIFTY use banks only.

## 6. 52-week highs (max +/-10)
- Broad and rising count (>15 F&O stocks, several heavyweights) => +6; sector cluster matching the index => +4; many 52-week lows and few highs => -5.

## Confidence
|score| 40-59 Moderate (0.5x size), 60-79 High (1x), >=80 Very high (1x, never exceed risk limit). Drop one notch if fewer than 4 of 6 groups agree.

## Trade construction
- Instrument: weekly option of the index; use next expiry if expiry is today after 13:30.
- Strike: ATM or 1 ITM (delta ~0.5-0.6). No far-OTM lottery strikes. Need high OI/volume and spread < 2%.
- Entry: market only if premium is not already >25% above the day's low; otherwise wait for pullback (+/-3% band).
- Stop-loss (whichever hits first): premium -25% (-30% if Very high); underlying invalidation: CE -> close below nearest put-OI support / last 15-min swing low; PE -> close above nearest call-OI resistance / last 15-min swing high.
- Targets: TP1 = +40% premium or next OI wall, book 50%, SL to cost. TP2 = +80% or 2x risk, trail rest with 15-min swing / 20% premium trail.
- Time stop: exit if < +10% after 45 minutes; exit all intraday by 15:15.
- Size: lots = floor(capital * risk% / ((entry - SL) * lot_size)).
- Convert premium levels to approximate underlying levels using delta.


## 7. Greeks (max +/-10) - from scripts/greeks.py
- IV skew (25-delta-ish put IV minus call IV): > +2 vol pts => -3 (hedging/fear); < -1 => +3.
- Gamma flip level: spot above => +3; spot below => -3.
- Net GEX regime (modifier, not direction): negative GEX = trending market, keep full conviction; positive GEX = pinned/mean-reverting: multiply |score| by 0.8 when spot is within 0.4% of a max-OI wall.
- Rising ATM IV with rising price (CE) or falling price (PE) confirms the move; IV falling while price rises = weak rally, -2 for CE ideas.
- India VIX > 20: halve size, prefer ITM; VIX jumping > 8% intraday with falling price supports PE; VIX < 12: expect small moves, lower TP.
- Expected move (0.85 x ATM straddle to expiry): TP2 underlying target must be inside 1x expected move; if TP1 already needs > 50% of it, NO TRADE.
- Theta gate: if ATM theta > 10% of premium per day or < 3 hours to expiry, no fresh buys (unless the move is already underway with score >= 60).
- Strike selection by delta: target 0.50-0.60 delta; never below 0.35. Use `strikes[]` from greeks.py.

## 8. Index heatmap - NSE + BSE (max +/-10)
- Build market-cap weighted return: sum(weight_i x %chg_i) over NIFTY 50 constituents (NSE heatmap). For BANKNIFTY use the NIFTY BANK heatmap.
- Weighted return > +0.4% with > 60% of index weight green => +5; < -0.4% with > 60% weight red => -5; in between scale linearly.
- Concentration check: if the index is up but 3 or fewer stocks explain > 70% of the gain (narrow rally) => -2.
- Sector rotation: banks + financials + IT (top 3 weights) all same colour => +/-3.
- BSE Sensex heatmap cross-check: Sensex and Nifty weighted returns same sign => +2; opposite/divergent => 0 and lower confidence one notch.

## BSE FII derivatives summary (within component 2)
- Use FII net index futures / options positions and OI change from the BSE fiisummary report.
- Same direction as NSE participant OI => +3 extra (max stays +/-15); contradicts => cancel the FII futures component to 0.
- Not available => 0, note "BSE unavailable".

## Confidence (updated)
Count agreeing groups out of 8 (option chain, FII, OI spurts, pre-open/close, breadth, 52-wk, Greeks, heatmap). Trade only if >= 4 agree.
