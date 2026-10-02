---
name: option-buying-playbook
description: Structured playbook for buying index and stock options (Nifty, Bank Nifty, FinNifty, stocks; NSE/Indian market) using support/resistance, option-chain OI and change in OI, PCR, Greeks (delta, gamma, theta, vega, IV), India VIX and ATM/ITM/OTM strike selection with option math (expected move, Black-Scholes repricing, break-even, lot sizing), market structure (HH/HL, BOS, CHoCH), stop-loss placement, and FII/DII/Pro/Client participant data. Use this skill whenever the user asks how to trade or buy calls/puts, read an option chain or OI, interpret Greeks or IV, find support and resistance, place stop losses, size positions, understand who the buyers and sellers/writers are, choose which strike or expiry to buy, calculate expected move, break-even, premium stop or lot size, read FII/DII data or participant-wise OI, build a trade plan or journal, or review/score a trade setup, even if they do not say "playbook". Also use when the user pastes option chain or participant data and wants it analysed.
---

# Option Buying Playbook (NSE / India)

Educational framework, not financial advice. Always say so briefly, and remind the user that most retail option buyers lose money (theta, IV crush, poor stops). Never promise returns or present any signal as certain. The goal is disciplined, rule-based decision making, so that every recommendation comes with a defined stop, size and a reason to skip.

## Core philosophy

Option buyers pay time decay, so they only win when price moves **fast and soon**. Therefore:
- Trade only at marked levels with confirmation, never in the middle of a range.
- Require several independent layers to agree (flow, structure, OI, Greeks, trigger). One layer alone is not a trade.
- The stop always lives on the **underlying** (Nifty/stock chart), then gets converted to premium via delta.
- "No trade" is a valid and frequent output.

## The five-layer workflow

Follow these in order. Layers 1 to 3 give direction and location; 4 to 5 decide whether and how to execute.

1. **Flow bias (prior evening):** FII/DII cash flow, FII index futures long %, FII index options stance, Pro/Client positioning. Gives a *bias only*; data is end-of-day. -> `references/participant-data.md`
2. **Market structure:** daily/1-hr trend, 15-min setup, 5-min entry. HH/HL vs LH/LL, BOS, CHoCH. -> `references/market-structure.md`
3. **Levels + OI:** previous day H/L/C, weekly levels, swing points, pivots, VWAP, round numbers, plus highest Call/Put OI and fresh change in OI. -> `references/oi-and-levels.md`
4. **Greeks, VIX and strike math:** classify the VIX regime, compute expected move, then pick the strike by calculation (not feel): delta ~0.45-0.65, option R:R >= 1.5-2 after repricing, theta cost and hold-time break-even within limits, lots >= 1 inside the risk budget. -> `references/greeks.md`, `references/vix-and-strike-selection.md`, `references/math-and-formulas.md`, `scripts/strike_selector.py`
5. **Trigger, stop, size:** candle confirmation at the level, underlying-based stop, reward:risk >= 1:2, risk <= 1% of capital. -> `references/trade-setups-and-risk.md`

Trade only when **at least 3 to 4 layers agree**. If they conflict (for example flow bullish, structure bearish, heavy call writing overhead), output "skip".

## Strike selection: always calculate

When the user wants a strike (or asks "ATM, ITM or OTM?"), run `python scripts/strike_selector.py` with spot, VIX (or ATM IV), days to expiry, direction, target, stop, expected hold time, capital, risk %, lot size (verify it), and live chain premiums if available (`--chain "strike:premium,..."`; use `--json` for machine-readable output). It re-prices every strike at the target and stop (with theta and IV shift), applies gates, sizes lots and ranks strikes. Report the recommended strike with entry, premium stop, target, option R:R, lots and the gate failures of rejected strikes. If no strike passes, the answer is skip / tighten stop / spread, never loosen the gates. If code cannot run, use the formulas in `references/math-and-formulas.md` by hand and say the numbers are approximate. Never fabricate live premiums or VIX; ask for them or search a current source.

## How to respond to common requests

**"Give me a trade plan / what should I trade today?"**
Ask (or infer) instrument, intraday vs swing, capital, and what data the user has. Then build the map: bias -> structure -> levels/OI walls -> candidate setup(s) with entry, stop (underlying and premium), targets, size, and the explicit invalidation. Offer both the bullish and bearish scenario, because price decides, not the plan.

**"Analyse this option chain / participant data" (user pastes data)**
Extract: highest Put OI and Call OI strikes, the largest *change in OI* strikes, PCR and its direction, whether OI is building above/below price. For participant data: long % trend, net futures, options stance. Summarise as a bias, a level map, and what would confirm or invalidate. State clearly what the data cannot tell you (who is buyer vs writer, hedged vs directional).

**"Which strike / ATM or ITM or OTM / how many lots?"**
Run the strike selector as above, then explain the result using the VIX regime and the ITM/ATM/OTM trade-off table.

**"Explain X" (OI, delta, theta, FII data, structure...)**
Explain concisely with the practical trading use and the main caveat, using the relevant reference file.

**"Score this setup"**
Use `references/scoring-and-checklists.md`. Show each factor's score, the total, and the conclusion (look for calls / puts / stay out).

**"Journal / track my trades"**
Use the columns in `assets/trade-journal-template.csv` and help compute win rate, average R, and max drawdown.

## Non-negotiable rules to state or enforce

- Judge every option trade on option R:R after repricing (underlying R:R overstates it), and check target points against the VIX-based expected move.
- Stop loss is on the underlying structure, converted to premium by `premium risk ~ points risked x delta`. Never widen a stop after entry.
- Do not place stops exactly at obvious levels; allow a buffer or use a candle close, because stop-hunts/sweeps are common.
- Position size = (capital x risk %) / (premium stop per lot). If one lot exceeds the risk budget, the answer is "choose a tighter setup or cheaper instrument", never "risk more".
- Risk 1% per trade (2% maximum); stop trading after 2-3 consecutive losses or 2-3% daily loss. Never average down a losing option.
- Avoid first 10-15 minutes, avoid buying into major events (IV inflated), be wary of expiry-day lottery buying.
- Time stop: exit if no move within 20-30 minutes (intraday).
- If a flow-based thesis reverses sharply in the next data release, treat it as an exit signal.

## Honesty about data limits

- OI does not reveal who is long or short; rising Put OI can be put buying, not writing. Infer from price behaviour.
- Many positions are hedged spreads; FII futures shorts are often hedges against cash holdings.
- Participant data is published after close: use it as next-day bias, not an intraday trigger.
- PCR and long:short thresholds are rules of thumb; the *trend* matters more than the level.
- Rollover/expiry days distort numbers. Max pain has weak predictive value.
- Verify NSE report names/layouts and current lot sizes, expiry days and margin rules from the exchange or broker, because these change. Do not quote them from memory as fact.

## Output style

Lead with the bottom line (bias + plan or "skip"), then the supporting layers. Use tables for level maps and scoring. Always include: entry trigger, stop (underlying + premium), target(s), reward:risk, position size, and what invalidates the idea. Keep the disclaimer to one line.
