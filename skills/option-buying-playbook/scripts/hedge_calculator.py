#!/usr/bin/env python3
"""
Hedge calculator for option BUYERS: compares a naked long CE/PE with a vertical
debit spread (long ATM/ITM + short further-OTM leg) at several widths, using the
same Black-Scholes repricing as strike_selector.py. Also sizes an index-put
hedge for a stock portfolio. Pure Python, no installs.

Examples
  python hedge_calculator.py spread --spot 25100 --vix 22 --days 4 --direction call \
      --long-strike 25100 --target 25250 --stop 25040 --hold-days 1 --lot-size 75

  python hedge_calculator.py spread ... --long-premium 221 --short-chain "25200:160,25250:130,25300:105"

  python hedge_calculator.py portfolio --value 2500000 --beta 1.1 --index 25100 --lot-size 75 \
      --hedge-ratio 0.5 --vix 14 --days 25 --put-premium 210

Capital model (per trade, mirrors GATE_CONFIG in src/lib/agent-brain-gate.ts)
  deployed_budget = min(trade_budget, capital)      # default: min(20000, 25000) = 20000
  risk_budget     = deployed_budget * risk_pct / 100  # default: 20% of 20000 = 4000
  lots            = min(floor(risk_budget / (risk_per_lot + cost_per_lot)),
                         floor(deployed_budget / (premium_per_lot + cost_per_lot)),
                         max_lots)
  Defaults: --capital 25000 --risk-pct 20 --trade-budget 20000 --cost-per-lot 0 --max-lots 0

Notes: flat-IV Black-Scholes unless premiums are supplied; spread margin benefit
and brokerage/STT must be verified with your broker; educational, not advice.
"""
import argparse, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strike_selector import bs, implied_vol  # noqa: E402
from capital_model import (  # noqa: E402
    DEFAULT_CAPITAL, DEFAULT_COST_PER_LOT, DEFAULT_MAX_LOTS, DEFAULT_RISK_PCT_OF_TRADE,
    DEFAULT_TRADE_BUDGET, build_model, size_lots,
)


def spread_report(a):
    is_call = a.direction == "call"
    sign = 1 if is_call else -1
    iv = a.vix / 100.0
    t_now = a.days / 365.0
    t_exit = max(a.days - a.hold_days, 0.02) / 365.0
    k1 = a.long_strike
    shorts = {}
    if a.short_chain:
        for part in a.short_chain.split(","):
            k, p = part.split(":")
            shorts[float(k)] = float(p)

    g1 = bs(a.spot, k1, t_now, iv, is_call)
    entry1 = a.long_premium if a.long_premium else g1["price"]
    iv1 = implied_vol(entry1, a.spot, k1, t_now, is_call) or iv

    # Per-trade capital model (capital_model.py): risk = % of the amount DEPLOYED,
    # and the position must also be AFFORDABLE.
    model = build_model(a.capital, a.risk_pct, a.trade_budget, a.cost_per_lot, a.max_lots)
    budget = model["risk_budget"]

    def leg_value(k, spot, t, ivk):
        return bs(spot, k, t, ivk, is_call)["price"]

    # naked baseline
    n_tgt = leg_value(k1, a.target, t_exit, iv1) - entry1
    n_stp = entry1 - leg_value(k1, a.stop, t_exit, iv1)
    naked_size = size_lots(model, max(n_stp, 0.0001) * a.lot_size, entry1 * a.lot_size)
    naked = {"entry": round(entry1, 2), "gain": round(n_tgt, 2), "loss": round(n_stp, 2),
             "rr": round(n_tgt / n_stp, 2) if n_stp > 0 else None,
             "theta_day": round(g1["theta_day"], 2), "vega_1pct": round(g1["vega_1pct"], 2),
             "delta": round(g1["delta"], 3),
             "breakeven_expiry": round(k1 + sign * entry1, 1),
             "max_loss_per_lot": round(entry1 * a.lot_size, 0), "max_profit": "unlimited",
             "lots_by_stop_risk": naked_size["lots"],
             "lots_by_risk": naked_size["lots_by_risk"],
             "lots_by_affordability": naked_size["lots_by_affordability"],
             "deployed_per_lot": round(entry1 * a.lot_size, 0),
             "total_deployed": round(naked_size["total_deployed"], 0),
             "total_risk": round(naked_size["total_risk"], 0),
             "reject_reason": naked_size["reason"]}

    rows = []
    for w in range(1, a.max_width + 1):
        k2 = k1 + sign * w * a.step
        g2 = bs(a.spot, k2, t_now, iv, is_call)
        entry2 = shorts.get(k2, g2["price"])
        iv2 = implied_vol(entry2, a.spot, k2, t_now, is_call) or iv
        debit = entry1 - entry2
        if debit <= 0:
            continue
        width_pts = w * a.step
        v_tgt = leg_value(k1, a.target, t_exit, iv1) - leg_value(k2, a.target, t_exit, iv2)
        v_stp = leg_value(k1, a.stop, t_exit, iv1) - leg_value(k2, a.stop, t_exit, iv2)
        gain, loss = v_tgt - debit, debit - v_stp
        rr = gain / loss if loss > 0 else float("inf")
        max_profit = width_pts - debit
        rr_expiry = max_profit / debit
        loss_lot = max(loss, 0.0001) * a.lot_size
        size = size_lots(model, loss_lot, debit * a.lot_size)
        rows.append({
            "short_strike": k2, "width_pts": width_pts,
            "net_debit": round(debit, 2), "premium_saved_pct": round(entry2 / entry1 * 100, 1),
            "max_loss_per_lot": round(debit * a.lot_size, 0),
            "max_profit_per_unit": round(max_profit, 2), "rr_at_expiry": round(rr_expiry, 2),
            "breakeven_expiry": round(k1 + sign * debit, 1),
            "value_at_target": round(v_tgt, 2), "value_at_stop": round(v_stp, 2),
            "gain": round(gain, 2), "loss": round(loss, 2), "rr_at_exit": round(rr, 2),
            "net_theta_day": round(g1["theta_day"] - g2["theta_day"], 2),
            "net_vega_1pct": round(g1["vega_1pct"] - g2["vega_1pct"], 2),
            "net_delta": round(g1["delta"] - g2["delta"], 3),
            "lots_by_stop_risk": size["lots"],
            "lots_by_risk": size["lots_by_risk"],
            "lots_by_affordability": size["lots_by_affordability"],
            "deployed_per_lot": round(debit * a.lot_size, 0),
            "total_deployed": round(size["total_deployed"], 0),
            "total_risk": round(size["total_risk"], 0),
            "reject_reason": size["reason"],
            "target_beyond_short_strike": (a.target - k2) * sign > 0,
        })
    viable = [r for r in rows if r["rr_at_exit"] >= a.min_rr and r["lots_by_stop_risk"] >= 1]
    # Prefer spreads whose short strike is at/beyond the target (target not capped),
    # then the best R:R at exit; otherwise fall back to best gain per rupee of debit.
    uncapped = [r for r in viable if not r["target_beyond_short_strike"]]
    if uncapped:
        best = max(uncapped, key=lambda r: (r["rr_at_exit"], -r["net_debit"]))
    elif viable:
        best = max(viable, key=lambda r: r["gain"] / r["net_debit"])
    else:
        best = None
    capital_model = dict(model)
    capital_model["deployed"] = best["deployed_per_lot"] if best else (naked["deployed_per_lot"] if naked["lots_by_stop_risk"] else 0)
    capital_model["risk"] = best["total_risk"] / best["lots_by_stop_risk"] if best and best["lots_by_stop_risk"] else (
        naked["total_risk"] / naked["lots_by_stop_risk"] if naked["lots_by_stop_risk"] else 0)
    return {"naked": naked, "spreads": rows, "suggested": best,
            "budget": round(budget, 0),
            "risk_budget": round(budget, 0),
            "deployed_budget": round(model["deployed_budget"], 0),
            "risk_pct_of_trade": model["risk_pct_of_trade"],
            "capital_model": capital_model,
            "note": ("No spread meets min R:R and sizing. Skip, move the stop nearer, or revisit the setup."
                     if not best else ""),
            "target_pts": round((a.target - a.spot) * sign, 1)}


def portfolio_report(a):
    notional = a.value * a.beta * a.hedge_ratio
    lots_exact = notional / (a.index * a.lot_size)
    lots = round(lots_exact)
    cost = lots * a.lot_size * a.put_premium if a.put_premium else None
    return {"hedge_notional": round(notional, 0), "lots_exact": round(lots_exact, 2), "lots": lots,
            "est_cost": round(cost, 0) if cost else None,
            "est_cost_pct_of_portfolio": round(cost / a.value * 100, 2) if cost else None}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    s = sub.add_parser("spread")
    s.add_argument("--spot", type=float, required=True)
    s.add_argument("--vix", type=float, required=True)
    s.add_argument("--days", type=float, required=True)
    s.add_argument("--direction", choices=["call", "put"], required=True)
    s.add_argument("--long-strike", type=float, required=True)
    s.add_argument("--long-premium", type=float, default=0)
    s.add_argument("--short-chain", type=str, default="", help='"strike:premium,..." for the short-leg candidates')
    s.add_argument("--target", type=float, required=True)
    s.add_argument("--stop", type=float, required=True)
    s.add_argument("--hold-days", type=float, default=1.0)
    s.add_argument("--capital", type=float, default=DEFAULT_CAPITAL,
                   help="trading capital in Rs (default 25000 — the real account capital, NOT Rs 3L)")
    s.add_argument("--risk-pct", type=float, default=DEFAULT_RISK_PCT_OF_TRADE,
                   help="risk as a %% of the amount DEPLOYED in the trade (default 20 => Rs 20000 deployed => Rs 4000 at risk)")
    s.add_argument("--trade-budget", type=float, default=DEFAULT_TRADE_BUDGET,
                   help="max Rs DEPLOYED per trade (default 20000)")
    s.add_argument("--cost-per-lot", type=float, default=DEFAULT_COST_PER_LOT,
                   help="round-trip costs per lot in Rs (brokerage/STT/charges); 0 = not modelled")
    s.add_argument("--max-lots", type=int, default=DEFAULT_MAX_LOTS,
                   help="strategy lot cap (0 = no cap)")
    s.add_argument("--lot-size", type=int, default=75)
    s.add_argument("--step", type=float, default=50)
    s.add_argument("--max-width", type=int, default=6)
    s.add_argument("--min-rr", type=float, default=1.5)
    s.add_argument("--json", action="store_true")
    q = sub.add_parser("portfolio")
    q.add_argument("--value", type=float, required=True)
    q.add_argument("--beta", type=float, default=1.0)
    q.add_argument("--index", type=float, required=True)
    q.add_argument("--lot-size", type=int, default=75)
    q.add_argument("--hedge-ratio", type=float, default=1.0)
    q.add_argument("--put-premium", type=float, default=0)
    q.add_argument("--vix", type=float, default=0)
    q.add_argument("--days", type=float, default=0)
    q.add_argument("--json", action="store_true")
    a = p.parse_args()

    if a.mode == "portfolio":
        r = portfolio_report(a)
        print(json.dumps(r, indent=2)) if a.json else print(
            f"Hedge notional Rs {r['hedge_notional']:.0f} -> {r['lots_exact']} lots (use {r['lots']}); "
            f"est. cost {r['est_cost']} ({r['est_cost_pct_of_portfolio']}% of portfolio)")
        return
    r = spread_report(a)
    if a.json:
        print(json.dumps(r, indent=2)); return
    n = r["naked"]
    print(f"\n{a.direction.upper()} | spot {a.spot} | VIX {a.vix} | {a.days}d | hold {a.hold_days}d | target {a.target} stop {a.stop}")
    print(f"NAKED long {a.long_strike:.0f}: entry {n['entry']} | gain {n['gain']} | loss {n['loss']} | R:R {n['rr']} | "
          f"theta/d {n['theta_day']} | vega {n['vega_1pct']} | max loss/lot Rs {n['max_loss_per_lot']:.0f} | lots in budget {n['lots_by_stop_risk']}\n")
    hdr = f"{'Short':>7} {'Debit':>7} {'Saved%':>6} {'MaxLoss/lot':>11} {'MaxProfit':>9} {'R:R@exp':>7} {'Gain':>7} {'Loss':>7} {'R:R@exit':>8} {'NetTh/d':>7} {'NetVega':>7} {'Lots':>4}"
    print(hdr); print("-" * len(hdr))
    for x in r["spreads"]:
        flag = " *capped" if x["target_beyond_short_strike"] else ""
        print(f"{x['short_strike']:>7.0f} {x['net_debit']:>7.2f} {x['premium_saved_pct']:>6.1f} {x['max_loss_per_lot']:>11.0f} "
              f"{x['max_profit_per_unit']:>9.2f} {x['rr_at_expiry']:>7.2f} {x['gain']:>7.2f} {x['loss']:>7.2f} "
              f"{x['rr_at_exit']:>8.2f} {x['net_theta_day']:>7.2f} {x['net_vega_1pct']:>7.2f} {x['lots_by_stop_risk']:>4}{flag}")
    b = r["suggested"]
    print()
    if b:
        print(f"SUGGESTED SPREAD: buy {a.long_strike:.0f}, sell {b['short_strike']:.0f} | net debit {b['net_debit']} "
              f"(hard max loss Rs {b['max_loss_per_lot']:.0f}/lot) | R:R at exit {b['rr_at_exit']} | lots {b['lots_by_stop_risk']}")
    else:
        print("No spread meets min R:R and sizing. Skip, move the stop nearer, or revisit the setup.")
    print("\n'*capped' = target is beyond the short strike, so profit is limited by the spread width.")
    print("Educational model output; verify margin benefit, brokerage and STT with your broker; not financial advice.")


if __name__ == "__main__":
    main()
