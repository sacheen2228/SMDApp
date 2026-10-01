# Greeks and IV for Option Buyers

| Greek | Measures | Use |
|---|---|---|
| Delta | Premium change per 1-point underlying move | Strike choice; convert underlying stop to premium stop |
| Gamma | Rate of change of delta | Highest ATM near expiry; explosive gains and losses |
| Theta | Daily time decay | The "rent" for holding; steepest in last 2-3 days |
| Vega | Sensitivity to IV | Matters around events |

## Delta
- ATM ~0.5, ITM higher, OTM lower. Prefer ATM or 1 strike ITM (0.45-0.65).
- **Premium risk ~ points risked x delta.** 40 points x 0.5 = ~20 premium.
- Far OTM is cheap because it needs a huge move; avoid as a default.

## Gamma
- ATM near expiry: delta can jump 0.3 -> 0.7 in a few points. Fast wins, equally fast losses.
- Beginners: prefer contracts with more time so gamma/theta are manageable.

## Theta
- Non-linear decay. With 1-2 days left you need the move immediately.
- Use a time stop (20-30 minutes intraday if nothing happens).

## Vega / IV
- Check IV Percentile or IV Rank (Sensibull, Opstra, Quantsapp, Streak, broker platforms).
- High IV: buying is expensive; IV fall can cancel directional gains; prefer spreads.
- Low IV: buying is cheaper and more favourable.
- India VIX: rising VIX with rising market = nervousness; falling VIX in a rally = comfort.
- **IV crush** after results/RBI policy/Budget: right direction can still lose money. Avoid buying into events.

## Expiry choice
- Weekly: intraday or 1-2 day moves, fast decay.
- Monthly: swing trades over a few days.
- Expiry-day buying: gamma-heavy, most lottery-style buyers lose. Avoid until a tested edge exists.

## Pre-buy Greek checklist
1. Delta ~0.45-0.65
2. IV not at an extreme percentile
3. Enough days to expiry (or a very fast expected move)
4. Tight bid-ask, liquid strike
