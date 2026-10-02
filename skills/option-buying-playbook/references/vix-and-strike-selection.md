# VIX and Strike Selection (ATM / ITM / OTM)

VIX is expected volatility, not direction. It answers (1) how expensive are premiums and (2) how big a move is realistic. Compute numbers with `scripts/strike_selector.py`; see `references/math-and-formulas.md`.

## VIX regimes (approximate; judge against the last 1 year of VIX, not fixed numbers)
| VIX | Regime | Premiums | Buyer's view |
|---|---|---|---|
| Below ~12 | Low | Cheap | Good for buying but moves may be small; compression can precede expansion |
| ~12-16 | Normal | Fair | ATM or 1 ITM |
| ~16-20 | Elevated | Rich | Selective; prefer ITM or spreads |
| Above ~20 | High | Expensive | IV crush risk; ITM, spreads, or smaller size |

## VIX direction
| Market | VIX | Read |
|---|---|---|
| Falling | Rising | Fear; puts gain from delta and vega |
| Rising | Falling | Comfortable rally; calls gain delta but get no vega help |
| Rising | Rising | Nervous or short-covering rally; can reverse sharply |
| Falling | Falling | Orderly decline or complacency; puts lose some to vega |
| Flat | Rising sharply | Event risk building; do not overpay |

## ITM vs ATM vs OTM
| | ITM (delta ~0.65-0.80) | ATM (~0.50) | OTM (~0.20-0.40) |
|---|---|---|---|
| Premium | Highest | Medium | Cheapest |
| Theta per unit of delta | Lowest | Medium | Highest |
| Gamma | Low | Highest | Medium |
| Chance to finish ITM | High | ~50% | Low |
| Break-even distance | Short | Medium | Long |
| Best for | Swings, high VIX, trend days | Intraday momentum, breakouts | Strong catalyst, fast move, small size |
You are buying delta. The question is how much theta and vega you pay for it. A cheap OTM is not "less risky"; it is a lower-probability bet. Size by rupee risk, not by how cheap the premium looks.

## Selection by condition
| Condition | Preferred strike |
|---|---|
| Intraday breakout, normal VIX | ATM (or 1 ITM) |
| Low VIX, strong setup, fast expected move | ATM, or 1 OTM with small size |
| Swing 2-5 days, normal VIX | 1-2 ITM, monthly expiry |
| High VIX | ITM or debit spread |
| Before results/policy/Budget | Avoid or use spreads (IV inflated) |
| Puts while VIX is spiking | ATM or slightly ITM |
| Expiry day | Avoid until a tested edge exists |

## Process (what the agent should do)
1. Get VIX and its 1-year percentile; classify the regime.
2. Compute expected move for the holding time; compare with the target (target should be under about 80% of 1 sigma).
3. Run the strike selector; read option R:R, theta cost, hold-time break-even, lots.
4. Check OI: do not buy a strike whose target lies beyond a heavy Call OI wall (for calls) or Put OI wall (for puts).
5. If VIX is high or an event is near, set `--iv-shift` negative to see whether the trade survives IV crush; if not, switch to ITM/spread or skip.
6. Tell the user the chosen strike, entry, premium stop, targets, lots and invalidation.

## VIX effect on stops and exits
- Premium stop is `points x delta` as a first estimate; the script reprices properly including theta and IV.
- A VIX drop on a call trade can bleed a winner; a VIX spike helps puts.
- A multi-percent intraday VIX move is a reason to reassess, not a signal by itself.
- If you bought before an event and IV collapses, exit on structure or time, not hope.

## Mistakes
Buying far OTM because it is cheap; ATM at very high VIX without checking crush; using VIX to pick direction; applying India VIX to Bank Nifty or stocks without their own IV; buying ATM on expiry day without a time stop; ignoring bid-ask on far strikes; sizing by premium instead of rupee risk.
