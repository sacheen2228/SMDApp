#!/usr/bin/env python3
"""
Strike selector for option BUYING (calls or puts). Pure Python, no dependencies.

What it does
  1. Expected move from India VIX / IV (1-sigma) over the holding window.
  2. Black-Scholes price and Greeks for each candidate strike.
  3. Re-prices every strike at your TARGET and STOP (with time decay and an
     optional IV shift), so reward:risk is computed on the actual option,
     not guessed from delta alone.
  4. Applies pass/fail gates, sizes lots by rupee risk, and ranks strikes.

Usage examples
  python strike_selector.py --spot 25100 --vix 14 --days 3 --direction call \
      --target 25200 --stop 25070 --capital 200000 --risk-pct 1 --lot-size 75 \
      --step 50 --hold-days 0.25

  # With live premiums from the option chain (calibrates IV per strike):
  python strike_selector.py --spot 25100 --vix 14 --days 3 --direction call \
      --target 25200 --stop 25070 --capital 200000 --lot-size 75 \
      --chain "25000:190,25050:150,25100:120,25150:90,25200:60"

  python strike_selector.py ... --json     # machine-readable output for bots

Model notes (be honest about limits)
  - Black-Scholes with flat IV per strike; real chains have skew.
  - Time to expiry uses calendar days/365; expected move uses trading days (252).
  - Probability numbers are rough (lognormal, zero drift, touch ~ 2x terminal).
  - Premium estimates are only as good as the IV input. Prefer --chain premiums.
  - Educational tool, not financial advice. Verify lot size, expiry and margins.
"""
import argparse, json, math, sys

SQRT_2PI = math.sqrt(2 * math.pi)


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def npdf(x):
    return math.exp(-0.5 * x * x) / SQRT_2PI


def bs(spot, strike, t, iv, is_call, r=0.065, q=0.0):
    """Black-Scholes price + Greeks. t in years, iv as decimal.
    Returns dict: price, delta, gamma, theta_day (per calendar day), vega_1pct."""
    t = max(t, 1e-6)
    iv = max(iv, 1e-4)
    srt = iv * math.sqrt(t)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * iv * iv) * t) / srt
    d2 = d1 - srt
    disc_r, disc_q = math.exp(-r * t), math.exp(-q * t)
    if is_call:
        price = spot * disc_q * ncdf(d1) - strike * disc_r * ncdf(d2)
        delta = disc_q * ncdf(d1)
        theta = (-spot * disc_q * npdf(d1) * iv / (2 * math.sqrt(t))
                 - r * strike * disc_r * ncdf(d2) + q * spot * disc_q * ncdf(d1))
    else:
        price = strike * disc_r * ncdf(-d2) - spot * disc_q * ncdf(-d1)
        delta = -disc_q * ncdf(-d1)
        theta = (-spot * disc_q * npdf(d1) * iv / (2 * math.sqrt(t))
                 + r * strike * disc_r * ncdf(-d2) - q * spot * disc_q * ncdf(-d1))
    gamma = disc_q * npdf(d1) / (spot * srt)
    vega = spot * disc_q * npdf(d1) * math.sqrt(t) / 100.0  # per 1 vol point
    return {"price": price, "delta": delta, "gamma": gamma,
            "theta_day": theta / 365.0, "vega_1pct": vega, "d2": d2}


def implied_vol(price, spot, strike, t, is_call, r=0.065):
    """Bisection IV solver. Returns decimal IV or None if price is out of bounds."""
    lo, hi = 0.01, 3.0
    if price < bs(spot, strike, t, lo, is_call, r)["price"] - 1e-9:
        return None
    if price > bs(spot, strike, t, hi, is_call, r)["price"]:
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if bs(spot, strike, t, mid, is_call, r)["price"] > price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def hold_breakeven(entry, strike, t_exit, iv, is_call, spot):
    """Underlying price at which the option is worth `entry` again at exit time
    (after time decay). Distance from spot = the move needed just to break even."""
    lo, hi = (spot, spot * 1.25) if is_call else (spot * 0.75, spot)
    f = lambda x: bs(x, strike, t_exit, iv, is_call)["price"] - entry
    if is_call:
        if f(hi) < 0: return hi
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    else:
        if f(lo) < 0: return lo
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (lo, mid) if f(mid) < 0 else (mid, hi)
    return (lo + hi) / 2


def expected_move(spot, iv, trading_days):
    """1-sigma move in points: spot * IV * sqrt(days/252)."""
    return spot * iv * math.sqrt(trading_days / 252.0)


def analyse(a):
    is_call = a.direction == "call"
    sign = 1 if is_call else -1
    iv_atm = a.vix / 100.0
    t_now = a.days / 365.0
    t_exit = max(a.days - a.hold_days, 0.02) / 365.0
    em = expected_move(a.spot, iv_atm, a.hold_days)
    target_pts = (a.target - a.spot) * sign
    stop_pts = (a.spot - a.stop) * sign
    if target_pts <= 0 or stop_pts <= 0:
        sys.exit("For a call: target > spot > stop. For a put: target < spot < stop.")
    underlying_rr = target_pts / stop_pts

    # candidate strikes
    chain = {}
    if a.chain:
        for part in a.chain.split(","):
            k, p = part.split(":")
            chain[float(k)] = float(p)
        strikes = sorted(chain)
    else:
        atm = round(a.spot / a.step) * a.step
        strikes = [atm + i * a.step for i in range(-a.itm_range, a.otm_range + 1)]
        if not is_call:
            strikes = [atm - i * a.step for i in range(-a.itm_range, a.otm_range + 1)]
            strikes = sorted(strikes)

    risk_budget = a.capital * a.risk_pct / 100.0
    rows = []
    for k in strikes:
        iv = iv_atm
        if k in chain:
            solved = implied_vol(chain[k], a.spot, k, t_now, is_call)
            if solved:
                iv = solved
        g = bs(a.spot, k, t_now, iv, is_call)
        entry = chain.get(k, g["price"])
        # scenario repricing (time passes, IV shifts by --iv-shift vol points)
        iv_exit = max(iv + a.iv_shift / 100.0, 0.01)
        p_tgt = bs(a.target, k, t_exit, iv_exit, is_call)["price"]
        p_stp = bs(a.stop, k, t_exit, iv_exit, is_call)["price"]
        gain, loss = p_tgt - entry, entry - p_stp
        rr = gain / loss if loss > 0 else float("inf")
        # break-even at expiry and required move
        be = k + entry if is_call else k - entry
        be_dist = (be - a.spot) * sign
        be_pct_em = be_dist / em * 100 if em else float("inf")
        # rough probabilities (lognormal, zero drift)
        sig_h = iv * math.sqrt(a.hold_days / 365.0)
        p_touch_tgt = min(1.0, 2 * ncdf(-abs(math.log(a.target / a.spot)) / sig_h)) if sig_h else 0
        p_touch_stp = min(1.0, 2 * ncdf(-abs(math.log(a.stop / a.spot)) / sig_h)) if sig_h else 0
        theta_hold = abs(g["theta_day"]) * a.hold_days          # rupees lost to decay over the hold
        theta_pct = theta_hold / entry * 100 if entry else 0     # as % of premium
        hbe = hold_breakeven(entry, k, t_exit, iv, is_call, a.spot)
        hbe_dist = (hbe - a.spot) * sign
        hbe_pct_em = hbe_dist / em * 100 if em else float("inf")
        risk_lot = loss * a.lot_size
        lots = int(risk_budget // risk_lot) if risk_lot > 0 else 0
        mny = (a.spot - k) / a.spot * 100 * sign  # + = ITM
        label = "ATM" if abs(a.spot - k) < a.step / 2 else ("ITM" if mny > 0 else "OTM")
        d = abs(g["delta"])
        gates = {
            "delta_ok": 0.40 <= d <= 0.75,
            "theta_ok": theta_pct <= a.max_theta_pct,
            "be_ok": hbe_pct_em <= a.max_be_em,
            "rr_ok": rr >= a.min_rr,
            "size_ok": lots >= 1,
        }
        rows.append({
            "strike": k, "type": label, "iv_pct": round(iv * 100, 2),
            "entry": round(entry, 2), "delta": round(g["delta"], 3),
            "gamma": round(g["gamma"], 5), "theta_day": round(g["theta_day"], 2),
            "theta_hold_cost": round(theta_hold, 2),
            "theta_pct_of_premium": round(theta_pct, 2),
            "vega_per_1pct_iv": round(g["vega_1pct"], 2),
            "breakeven_at_expiry": round(be, 1),
            "breakeven_at_exit_time": round(hbe, 1), "hold_be_points": round(hbe_dist, 1),
            "be_pct_of_exp_move": round(hbe_pct_em, 1),
            "price_at_target": round(p_tgt, 2), "price_at_stop": round(p_stp, 2),
            "gain_per_unit": round(gain, 2), "loss_per_unit": round(loss, 2),
            "reward_risk": round(rr, 2), "return_on_premium_pct": round(gain / entry * 100, 1) if entry else 0,
            "p_touch_target": round(p_touch_tgt, 2), "p_touch_stop": round(p_touch_stp, 2),
            "risk_per_lot": round(risk_lot, 0), "lots": lots,
            "capital_per_lot_premium": round(entry * a.lot_size, 0),
            "gates": gates, "passes": all(gates.values()),
        })

    passing = [r for r in rows if r["passes"]]
    if passing:
        best_rr = max(r["reward_risk"] for r in passing)
        # strikes within 10% of the best R:R are treated as equivalent; among them
        # prefer delta closest to 0.55 (liquid, responsive, moderate theta)
        near = [r for r in passing if r["reward_risk"] >= 0.9 * best_rr]
        near.sort(key=lambda r: (abs(abs(r["delta"]) - 0.55), -r["reward_risk"]))
        rest = sorted([r for r in passing if r not in near],
                      key=lambda r: (-r["reward_risk"], r["theta_pct_of_premium"]))
        ranked = near + rest
    else:
        ranked = []
    return {
        "inputs": {k: v for k, v in vars(a).items() if k != "chain"},
        "expected_move_points": round(em, 1),
        "expected_move_pct": round(em / a.spot * 100, 2),
        "daily_expected_move_points": round(expected_move(a.spot, iv_atm, 1), 1),
        "target_points": round(target_pts, 1), "stop_points": round(stop_pts, 1),
        "underlying_reward_risk": round(underlying_rr, 2),
        "target_vs_expected_move_pct": round(target_pts / em * 100, 1) if em else None,
        "risk_budget_rupees": round(risk_budget, 0),
        "recommendation": ranked[0] if ranked else None,
        "ranked_passing": ranked,
        "all_candidates": rows,
        "warnings": ([f"Target needs {round(target_pts/em*100)}% of the 1-sigma expected move over the hold; "
                      "treat as a stretch (roughly a coin-flip or worse)."] if em and target_pts / em > 0.8 else []),
        "note": ("No strike passes all gates. Likely answer: SKIP, tighten the stop, "
                 "wait for a better level, or consider a debit spread.") if not ranked else "",
    }


def print_report(res):
    i = res["inputs"]
    print(f"\n{i['direction'].upper()} strike selection | spot {i['spot']} | VIX {i['vix']} | "
          f"{i['days']}d to expiry | hold {i['hold_days']}d")
    print(f"Expected 1-sigma move over hold: {res['expected_move_points']} pts "
          f"({res['expected_move_pct']}%) | per day: {res['daily_expected_move_points']} pts")
    print(f"Target {res['target_points']} pts ({res['target_vs_expected_move_pct']}% of expected move) | "
          f"Stop {res['stop_points']} pts | underlying R:R {res['underlying_reward_risk']}")
    print(f"Risk budget: Rs {res['risk_budget_rupees']:.0f}\n")
    hdr = f"{'Strike':>8} {'Type':<4} {'Prem':>7} {'Delta':>6} {'Th/d':>6} {'Th%':>5} {'BE%EM':>6} {'@Tgt':>7} {'@Stp':>7} {'R:R':>5} {'Lots':>4}  Pass"
    print(hdr)
    print("-" * len(hdr))
    for r in res["all_candidates"]:
        fails = [k.replace("_ok", "") for k, v in r["gates"].items() if not v]
        print(f"{r['strike']:>8.0f} {r['type']:<4} {r['entry']:>7.2f} {r['delta']:>6.2f} "
              f"{r['theta_day']:>6.2f} {r['theta_pct_of_premium']:>5.1f} {r['be_pct_of_exp_move']:>6.0f} "
              f"{r['price_at_target']:>7.2f} {r['price_at_stop']:>7.2f} {r['reward_risk']:>5.2f} "
              f"{r['lots']:>4}  {'YES' if r['passes'] else 'no: ' + ','.join(fails)}")
    for w in res["warnings"]:
        print("WARNING:", w)
    rec = res["recommendation"]
    print()
    if rec:
        print(f"RECOMMENDED: {rec['strike']:.0f} {rec['type']} | entry ~{rec['entry']} | "
              f"premium stop ~{rec['price_at_stop']} | target ~{rec['price_at_target']} | "
              f"R:R {rec['reward_risk']} | lots {rec['lots']}")
    else:
        print(res["note"])
    print("\nEducational model output (flat-IV Black-Scholes). Verify with live chain; not financial advice.")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--spot", type=float, required=True)
    p.add_argument("--vix", type=float, required=True, help="India VIX or the ATM IV in percent")
    p.add_argument("--days", type=float, required=True, help="calendar days to expiry")
    p.add_argument("--direction", choices=["call", "put"], required=True)
    p.add_argument("--target", type=float, required=True, help="underlying target price")
    p.add_argument("--stop", type=float, required=True, help="underlying stop price")
    p.add_argument("--capital", type=float, default=200000)
    p.add_argument("--risk-pct", type=float, default=1.0)
    p.add_argument("--lot-size", type=int, default=75, help="VERIFY current lot size with exchange/broker")
    p.add_argument("--step", type=float, default=50, help="strike interval")
    p.add_argument("--hold-days", type=float, default=0.25, help="expected holding time in days (0.25 ~ 1.5-2 hrs of session)")
    p.add_argument("--iv-shift", type=float, default=0.0, help="assumed IV change at exit, vol points (e.g. -2 for crush)")
    p.add_argument("--itm-range", type=int, default=3)
    p.add_argument("--otm-range", type=int, default=3)
    p.add_argument("--chain", type=str, default="", help='live premiums "strike:premium,..." to calibrate IV')
    p.add_argument("--min-rr", type=float, default=1.5, help="min option reward:risk after repricing")
    p.add_argument("--max-theta-pct", type=float, default=6.0, help="max theta cost over the hold as %% of premium")
    p.add_argument("--max-be-em", type=float, default=50.0, help="max hold-time break-even distance as %% of expected move")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    res = analyse(a)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        print_report(res)


if __name__ == "__main__":
    main()
