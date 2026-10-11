---
name: option-buying-playbook
description: "Playbook for buying index and stock options (Nifty, Bank Nifty, stocks; NSE/India): support/resistance, option-chain OI and change in OI, PCR, Greeks, India VIX, ATM/ITM/OTM strike selection with option math (expected move, Black-Scholes repricing, break-even, lot sizing), hedging a CE/PE buy (debit spreads, profit lock-in, portfolio hedges), market structure (BOS, CHoCH), stop-loss placement, and FII/DII/Pro/Client data. Use whenever the user asks how to trade or buy calls/puts, read an option chain or OI, interpret Greeks or IV, pick a strike or expiry, calculate expected move, break-even, premium stop or lots, hedge or reduce loss on an option position, find support/resistance, see who the buyers and writers are, read FII/DII or participant OI, build a trade plan or journal, or score a setup, even without the word playbook. Also use when the user pastes option chain or participant data, or has a live data feed to verify."
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

## Hedging: reduce loss with defined risk

A long CE/PE already has capped loss, so hedging means lowering theta, vega and break-even distance at the cost of capped profit. Say this plainly; never present a hedge as free or as a substitute for a stop. When VIX is elevated, an event is near, expiry is within about 1-4 days, or the risk budget cannot fit one naked lot, run `python scripts/hedge_calculator.py spread ...` to compare the naked option with debit spreads (default: short strike at or beyond the target) and report net debit, hard max loss, R:R, lots and what upside is given up. For profit protection, for portfolio hedges (`hedge_calculator.py portfolio`), butterflies, calendars and event structures, read `references/hedging-strategies.md`. Always warn: buy leg first then sell leg, exit both legs together, never leave a short leg naked, and verify margin, costs and lot size with the broker.

## Live data: verify before analysing

If the user runs the Live Option Data Service (http://127.0.0.1:8765, or the file live_data.json), read it instead of asking for numbers: `GET /selector?symbol=NIFTY&direction=call&target=T&stop=S` returns spot, VIX, days to expiry, live premiums and a ready `strike_selector.py` command; `GET /snapshot` returns everything (spot, VIX, chains with OI/change in OI/PCR/walls/max pain, FII/DII, participant OI).
Freshness rules (strict):
- Give trade levels only when `meta.all_live` is true (or `/selector` returns `ok: true`). Always state the data's exchange timestamp and age in the answer.
- `CLOSED`: say the market is closed; offer last-close analysis only (`allow_closed=1`) and label it as such.
- `STALE`, `UNVERIFIED`, `NO_DATA`, `ERROR`: say the data is not live, name the feed, its age and error, and do not produce entries, stops or targets from it; ask the user to check the dashboard.
- `DEMO`: never use for decisions.
- FII/DII and participant OI are end-of-day bias only; use them when status is `EOD_OK`, and say so if `EOD_OLD`.
- Never invent or reuse remembered prices; if no service is running, ask for current spot, VIX and chain premiums.

## How to respond to common requests

**"Give me a trade plan / what should I trade today?"**
Ask (or infer) instrument, intraday vs swing, capital, and what data the user has. Then build the map: bias -> structure -> levels/OI walls -> candidate setup(s) with entry, stop (underlying and premium), targets, size, and the explicit invalidation. Offer both the bullish and bearish scenario, because price decides, not the plan.

**"Analyse this option chain / participant data" (user pastes data)**
Extract: highest Put OI and Call OI strikes, the largest *change in OI* strikes, PCR and its direction, whether OI is building above/below price. For participant data: long % trend, net futures, options stance. Summarise as a bias, a level map, and what would confirm or invalidate. State clearly what the data cannot tell you (who is buyer vs writer, hedged vs directional).

**"Which strike / ATM or ITM or OTM / how many lots?"**
Run the strike selector as above, then explain the result using the VIX regime and the ITM/ATM/OTM trade-off table.

**"How do I hedge / reduce loss on a CE/PE?"**
Explain the trade-off, run the hedge calculator, recommend naked vs spread vs lock-in using the decision table in `references/hedging-strategies.md`.

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

## SMDApp validated strategy rules (audit-derived, Oct 2026)

Computed from the Trade Audit ledger (543+ closed trades, P&L at real ₹20k budget sizing). These override generic playbook instincts on this book:

| Rule | Evidence | Where enforced |
|---|---|---|
| **SMART_MONEY: CE always; PE only with OI-flow BEARISH confirmation + market hours (09:15–15:30) + score ≥65.** Not a ban — a regime gate. | CE 29/29 wins (+₹4.46L, avgR 3.29) vs PE 0/51 in a bull run (−₹78K, 0% in EVERY session, PRE_OPEN alone −₹64K). PE loses when bears aren't in control; the flow gate blocks PE exactly then. | `ZeroHeroTerminal.tsx` scoredCandidates (PE block with `flowBias === "BEARISH" && peSessionOk`) |
| **ZERO_HERO: no trades 12:00–13:00 or after 15:00 IST** (MIDDAY/CLOSING/POST_CLOSE). Expiry-day morning/afternoon only. | Toxic sessions 15.8% WR / −₹184K vs other sessions 43.4% WR / +₹34K | `ZeroHeroTerminal.tsx` zhCandidates session gate; POST_CLOSE also gated in `/api/option-chain` via `isTradeAllowed` |
| **PE requires the market to be DEMONSTRABLY falling** — OI flow BEARISH (who's winning positioning) AND `isFallingMarket()` (price actually falling: spot<VWAP + DOWN structure + sustained momentum, ≥2 of 3 layers; one-bar spikes don't count). PE strikes: ATM/ITM + OTM ≤3 strikes. | PE 0/51 in bull run; OI flow alone is positioning, not price action. Detector TDD'd: `tests/falling-market.test.ts` 8/8 (clean fall ✓, bull run ✗, distribution ✗, one-spike chop ✗, SENSEX-scale ✓) | `isFallingMarket()` in `technical-analysis.ts`; wired in `ZeroHeroTerminal.tsx` scoredCandidates PE block + `/api/option-chain` PE alert gate |
| **Minimum premium ₹5** — never touch sub-₹5 options (stale/lottery stubs). | option-chain-api book: 41 entry<₹5 PE stubs, 0 wins; PE entry≥5 alone flips to +₹4.6K | `trade-validator-gate.ts` MIN_PREMIUM; `/api/trade/register`; `/api/option-chain` |
| **Strike style: ATM or ITM only; OTM = max 2–3 strikes from ATM; never deep OTM.** Target delta 0.45–0.65; a 2–3-strike OTM entry sits ~0.35–0.45 and needs the underlying to actually travel, so check TP2 against the VIX expected move before taking it. | Desk rule. Ledger proof it's already followed: 95/118 July ZH trades were ATM/ITM (₹60+ premium) and still lost −₹77K at 39% WR — strike *quality* was never the problem, direction/regime was (deep-OTM was only 2 trades). So the live gates that matter are session + regime, not a delta filter. | Hermes `strike_selector` (delta 0.45–0.65 band, expected-move ceiling); `agent-brain.ts` strike guidance |
| **PE confidence floors** — PE needs stronger signal than CE (register floor PE 65 / CE 55; SDM alert floor PE 70 / CE 60). | PE has historically near-0 win rate on auto-generated books | `/api/trade/register`, `/api/option-chain` alert gate |
| **Position sizing = max ₹20k per trade**, lots = floor(20000 / (premium × lot)) — works for NIFTY/SENSEX index options and stock F&O alike. Min 1 lot even if it exceeds budget (SENSEX-size premiums). | User's live sizing; audit engine now records quantity so ₹ stats are real | `trade-audit/src/utils/sizing.ts` (`AUDIT_TRADE_BUDGET`) |
| **Costs are real** — ≈₹40 round-trip + 1.5bps. Trades whose expected profit is under ~₹50 cannot pay costs; don't microlot expensive underlyings. | BTST 1-share trades: sub-₹40 winners flip negative after fees | audit `estimateFees` |
| **Retired recorders — ignore their ledger history**: `option-chain-api` (−₹3.3L: ₹0.05 PE stubs + POST_CLOSE conf=0 rows), `SMC` (−₹1.9L, July only). No longer record; losses are pre-gate history. | 470 + 18 stale rows Jul–Sep 2026 | gates in `/api/option-chain`, no active recorder |
| **SMART_MONEY and BTST are the only ledger-proven edges.** ZERO_HERO stays paper/terminal until post-gate data accumulates ≥100 closed trades. | SMART_MONEY +₹3.67L (67% WR, PF 5.71); BTST ~breakeven; all else negative | audit `/api/stats` |

### 5-day backtest replay lessons (Oct 5–9, 2026, sent to Telegram)

Replayed 51 ATM CE/PE trades across NIFTY/SENSEX/BANKNIFTY + RELIANCE/TCS/HDFCBANK/SBIN/INFY
(BS premium proxy at live IV, 20% SL / +50% TP1, ₹20k budget sizing, SL-first on same-day touch):

- **CE 1W/1L/24 TIME-exit · PE 0W/3L/22 TIME-exit** — a low-IV week (NIFTY IV≈11%) bleeds option
  buyers through *time*, not through stops. 46/51 trades neither hit TP nor SL.
- **Lesson: skip buying options when IV < ~12 and the expected move (VIX-based) is smaller than
  the distance to TP1** — the trade can be right on direction and still exit flat/negative on decay.
- **Lesson: TIME-exit is the hidden loss column.** Even flat premium pays ₹40+ costs per trade;
  in quiet weeks the playbook's edge comes from staying out, not from tighter stops.
- Bull-week replay also confirms the PE regime gate: PE was net-negative across every symbol
  while OI flow stayed bullish — the new `flowBias === "BEARISH"` gate would have blocked all of them.
