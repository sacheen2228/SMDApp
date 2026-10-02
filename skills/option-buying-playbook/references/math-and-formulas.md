# Math for Strike Selection (for agents and bots)

Do not guess a strike. Compute it. Run `scripts/strike_selector.py` (pure Python, no installs) whenever the user gives spot, VIX/IV, days to expiry, direction, target and stop. Use the formulas below to explain results or to compute by hand when code cannot run.

## Contents
1. Inputs required
2. Expected move from VIX
3. Black-Scholes price and Greeks
4. Scenario repricing (the core method)
5. Break-even math
6. Probabilities
7. Position sizing
8. Strike gates and ranking algorithm
9. Worked example with real script output
10. Model limits

## 1. Inputs required
spot S, direction (call/put), India VIX (or ATM IV) in %, calendar days to expiry, target price, stop price (both on the **underlying**), expected holding time in days, capital, risk %, lot size (verify with broker), strike step. Optional: live premiums from the chain, assumed IV change at exit.
If an input is missing, ask for it, or state the assumption explicitly. Never invent live premiums.

## 2. Expected move from VIX
- IV = VIX / 100.
- **1-sigma move (points) = S x IV x sqrt(trading_days / 252)**
  - 1 day: S x IV / 15.87
  - 1 week (5 trading days): S x IV x 0.1409 (about S x IV / 7.1)
- Roughly 68% of outcomes stay within 1 sigma, 95% within 2 sigma, on this model.
- **Target realism = target points / expected move over the hold.**
  - Under 50%: realistic. 50-80%: fair. Over 80%: stretch, likely needs a catalyst or trend day. Over 100%: usually skip or choose a longer hold.

## 3. Black-Scholes (flat IV)
With t = calendar days/365, sigma = IV, r about 6.5% (India short rate; minor effect), q = 0:
- d1 = [ln(S/K) + (r + sigma^2/2) t] / (sigma sqrt(t)),  d2 = d1 - sigma sqrt(t)
- Call = S N(d1) - K e^(-rt) N(d2);  Put = K e^(-rt) N(-d2) - S N(-d1)
- Delta: call N(d1), put N(d1) - 1
- Gamma = n(d1) / (S sigma sqrt(t))   (n = normal density)
- Vega (per 1 vol point) = S n(d1) sqrt(t) / 100
- Theta (per day) = [-S n(d1) sigma / (2 sqrt(t)) - r K e^(-rt) N(d2)] / 365   (call)
Implied volatility from a live premium: solve BS(sigma) = premium by bisection (script does this per strike when `--chain` is given). Using each strike's own implied vol captures skew; flat VIX does not.

## 4. Scenario repricing (core method)
Delta x points is only a first guess. The correct estimate re-prices the option at the target and at the stop **after time has passed**:
- Option at target = BS(S = target, t = days_left - hold_days, IV = IV + iv_shift)
- Option at stop = BS(S = stop, same time and IV)
- **Gain = option_at_target - entry; Loss = entry - option_at_stop; Option R:R = Gain / Loss**
Quick approximation: dP = delta dS + 0.5 gamma dS^2 + theta dt + vega dIV. Gamma helps on big fast moves; theta and falling IV hurt on slow ones. Note the option R:R is usually *lower* than the underlying R:R (e.g. 3.3 underlying becomes about 2.5 on the option), because of theta and convexity. Always judge the trade on option R:R.
IV shift: use 0 for a normal directional trade; use -2 to -5 vol points for post-event IV crush; remember puts in a selloff often see IV rise, so do not apply crush blindly to puts.

## 5. Break-even math
- At expiry: call BE = K + premium; put BE = K - premium.
- **At your exit time** (what matters for intraday/swing): the underlying price S* where BS(S*, K, t_exit) = entry premium. The distance |S* - S| is the move needed just to avoid a loss after decay.
- **Break-even % of expected move = hold-time BE distance / expected move.** Gate: at most about 50%.
- Rule of thumb: hold-time BE distance is about theta cost over the hold / delta.

## 6. Probabilities (rough, lognormal, zero drift)
- Probability the underlying **touches** a level L within the hold: about 2 x N(-|ln(L/S)| / (IV sqrt(hold_days/365))).
- Terminal probability (finishing beyond L) is about half of touch probability.
- Use these only to compare ideas. They ignore trends, OI walls and event jumps.
- Expected-value sanity check: P(target) x Gain - P(stop) x Loss should be positive. With touch probabilities, require P(target) x R:R > P(stop) as a minimum.

## 7. Position sizing
- Risk budget = capital x risk% (1% default, 2% max).
- Risk per lot = (entry - option_at_stop) x lot_size (use the repriced stop premium, not a flat guess).
- **Lots = floor(risk budget / risk per lot).** If lots < 1: do not take it. Tighten the stop to a nearer structure level, choose a cheaper strike, use a debit spread, or skip.
- Premium outlay per lot = entry x lot_size; check it against available margin and a sensible share of capital.
- Daily loss cap: sum of risk across open trades must stay under 2-3% of capital.

## 8. Gates and ranking algorithm
A strike must pass **all** of these defaults (adjustable):
| Gate | Default | Why |
|---|---|---|
| Delta | 0.40 - 0.75 in absolute value | Responsive but not a lottery ticket |
| Theta cost over the hold | at most 6% of premium (relax to about 12-14% for 2+ day swings) | Time decay must not eat the edge |
| Hold-time break-even | at most 50% of expected move | Needs only a modest move to be profitable |
| Option reward:risk | at least 1.5 (aim for 2) | After theta, convexity and IV shift |
| Lots | at least 1 within risk budget | Respects 1% rule |
Ranking: among passing strikes, strikes within 10% of the best option R:R are treated as equal, and the one with delta nearest 0.55 wins. If none pass, the answer is **SKIP / tighten stop / spread**, never "relax the rules".

Pseudocode:
```
em = S*IV*sqrt(hold/252)
if target_pts/em > 1.0: warn or skip
for K in strikes:
    entry = chain premium or BS price; iv_K = implied vol if premium given
    p_t = BS(target, t-hold, iv_K+shift); p_s = BS(stop, t-hold, iv_K+shift)
    RR = (p_t-entry)/(entry-p_s); lots = floor(budget/((entry-p_s)*lot))
    pass = delta_ok and theta_ok and be_ok and RR>=min_rr and lots>=1
choose per ranking above, else SKIP
```

## 9. Worked example (real script output)
Command: spot 25,100; VIX 14; 3 days to expiry; call; target 25,200; stop 25,070; capital Rs 3,00,000; 1% risk (Rs 3,000); lot 75; hold 0.25 day.
- Expected 1-sigma move over the hold: 110.7 points (daily: 221.4). Target = 100 points = 90% of that, so the script warns it is a stretch.
- Underlying R:R = 100/30 = 3.33.
| Strike | Entry | Delta | Premium at target | Premium at stop | Option R:R | Result |
|---|---|---|---|---|---|---|
| 24,950 ITM | 224.7 | 0.70 | 295.1 | 198.6 | 2.69 | pass |
| 25,050 ITM | 161.1 | 0.58 | 219.7 | 138.3 | 2.56 | **recommended** (delta nearest 0.55) |
| 25,100 ATM | 133.9 | 0.52 | 186.2 | 112.9 | 2.50 | pass |
| 25,200 OTM | 88.7 | 0.40 | 128.4 | 71.9 | 2.37 | fails theta/delta gates |
Notice the underlying R:R of 3.33 shrank to about 2.5 on the option, and OTM options lose their edge because theta takes a larger share of a small premium.
A 10-day swing example (target 25,350, stop 25,000, 2-day hold) fails the sizing gate at Rs 2,00,000-3,00,000 capital because a 100-point stop costs more than the 1% budget per lot. That is the correct output: tighten the stop, use a spread, or skip.

## 10. Model limits (state these when relevant)
Flat-IV Black-Scholes ignores skew, intraday IV changes and gap risk. Probabilities are approximations. VIX describes Nifty only; use the stock's or Bank Nifty's own IV for those. Index options are European-style; stock options in India are physically settled, so check rules near expiry. Results are only as good as the inputs; prefer live chain premiums, and re-run when spot or VIX moves materially. Educational output, not financial advice.
