#!/usr/bin/env python3
"""Option math shared by the GEX engine and Agent E (single source of truth).

The GEX *engine* owns the gamma math (net GEX, flip, walls, regime) - nothing
else may recompute it.  The *option* math (delta, strike selection, premium
stop, targets, R:R, 1-sigma expected move, theta, sizing) is NOT gamma math,
so it lives here once and is imported by:
  - scripts/gex_engine.py  (the GEX engine's own trade proposal)
  - scripts/agents/agent_e.py (the orchestrator's authoritative plan)

Reuses the skill's existing Black-Scholes implementation (scripts/greeks.py).

Hard rules encoded here (references/agent-rules.md):
  * delta 0.50-0.60 preferred, never below 0.35
  * strike must be in the top-5 OI on the traded side
  * bid-ask spread <= 2% of the mid
  * premium stop 25%-30% of the premium
  * TP1 reward:risk >= 1:2, TP2 inside the 1-sigma expected move
  * < 3 hours to expiry  -> NO TRADE
  * theta > 10% of premium per day -> NO TRADE
  * VIX > 20 -> halve the size
  * lots = min(risk-limited, affordable, strategy cap), always rounded DOWN
  * no hardcoded capital: the account equity MUST come from a validated source
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from greeks import bs_greeks  # noqa: E402  (skill-local Black-Scholes)

RISK_FREE = 0.065

CFG = {
    "delta_preferred": 0.55,
    "delta_preferred_high_vix": 0.60,
    "delta_band": (0.50, 0.60),
    "delta_min": 0.35,
    "delta_max": 0.70,
    "delta_acceptable": (0.45, 0.70),
    "max_spread_pct": 2.0,
    "max_strike_distance_pct": 0.02,
    "stop_pct_min": 0.25,
    "stop_pct_max": 0.30,
    "rr_tp1": 2.0,
    "rr_tp2": 3.0,
    "min_hours_to_expiry": 3.0,
    "max_theta_pct_per_day": 10.0,
    "vix_high": 20.0,
    "risk_pct": 1.0,
    "max_risk_pct": 2.0,
    "max_lots_per_trade": 10,
    "gex_max_lots": 2,
}


def bs_delta(spot, strike, T, sigma, is_call):
    """Absolute Black-Scholes delta (greeks.bs_greeks is the underlying model)."""
    if T <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return 0.0
    g = bs_greeks(spot, strike, T, sigma, RISK_FREE, "CE" if is_call else "PE")
    return abs(float(g.get("delta", 0.0)))


def theta_per_day(spot, strike, T, sigma, is_call):
    """Theta in premium points per day (negative number for a long option)."""
    if T <= 0 or sigma <= 0:
        return 0.0
    g = bs_greeks(spot, strike, T, sigma, RISK_FREE, "CE" if is_call else "PE")
    return abs(float(g.get("theta", 0.0)))


def iv_of(row, side, vix):
    """IV of one chain row (decimal). Falls back to the VIX, never to 0."""
    v = row.get("%s_iv" % side)
    if not v or v <= 0:
        v = vix
    return max(float(v or 0), 1.0) / 100.0


def expected_move_1sigma(spot, atm_iv):
    """One-day 1-sigma move in points from the ATM IV (the GEX record's number)."""
    return float(spot) * float(atm_iv) * math.sqrt(1.0 / 365.0)


def expected_move_expiry(rows, spot):
    """The skill's expected move to expiry: 0.85 x the ATM straddle.

    references/scoring-rules.md: "Expected move (0.85 x ATM straddle to expiry):
    TP2 underlying target must be inside 1x expected move".  The one-day
    ATM-IV move above is the number the GEX output schema asks for; the
    containment gate uses the skill's expiry measure.
    """
    if not rows:
        return 0.0
    atm = min(rows, key=lambda r: abs(float(r["strike"]) - float(spot)))
    call_ltp = float(atm.get("call_ltp", 0) or 0)
    put_ltp = float(atm.get("put_ltp", 0) or 0)
    return 0.85 * (call_ltp + put_ltp)


def _ceil2(x):
    return math.ceil(round(float(x), 6) * 100.0) / 100.0


def pick_strike(rows, side, spot, T, vix, cfg=None):
    """Pick the option strike. Returns (best, rejected_reasons).

    best = {"strike","delta","premium","bid","ask","row"} or None.
    `rows` are engine-normalised chain rows: strike, <side>_oi, <side>_iv,
    <side>_bid, <side>_ask, <side>_ltp, <side>_volume.
    """
    cfg = dict(CFG, **(cfg or {}))
    vix = float(vix or 0)
    is_call = side == "call"
    top5 = {r["strike"] for r in sorted(rows, key=lambda r: -float(r.get("%s_oi" % side, 0) or 0))[:5]}
    target_delta = cfg["delta_preferred_high_vix"] if vix > cfg["vix_high"] else cfg["delta_preferred"]
    best, rejected = None, []
    for r in rows:
        K = float(r["strike"])
        if abs(K - spot) / spot > cfg["max_strike_distance_pct"]:
            continue
        d = bs_delta(spot, K, T, iv_of(r, side, vix), is_call)
        if not (cfg["delta_min"] <= d <= cfg["delta_max"]):
            continue
        bid, ask = r.get("%s_bid" % side), r.get("%s_ask" % side)
        if not bid or not ask:
            rejected.append({"strike": K, "why": ["no bid/ask"]})
            continue
        bid, ask = float(bid), float(ask)
        if ask <= 0 or bid <= 0:
            rejected.append({"strike": K, "why": ["invalid bid/ask"]})
            continue
        mid = (bid + ask) / 2.0
        spread_pct = (ask - bid) / mid * 100.0
        why = []
        if K not in top5:
            why.append("not top-5 OI")
        if spread_pct > cfg["max_spread_pct"]:
            why.append("spread %.2f%% > %.1f%%" % (spread_pct, cfg["max_spread_pct"]))
        if float(r.get("%s_volume" % side, 0) or 0) <= 0:
            why.append("zero volume")
        if why:
            rejected.append({"strike": K, "why": why, "delta": round(d, 3)})
            continue
        score = abs(d - target_delta)
        if best is None or score < best["score"]:
            best = {"score": score, "strike": K, "delta": d, "premium": mid,
                    "bid": bid, "ask": ask, "row": r, "spread_pct": spread_pct}
    return best, rejected


def size_position(risk_per_unit, lot_size, entry, account_equity, risk_pct,
                  max_lots=None, deployment_cap=None, vix=None, cfg=None):
    """lots = min(risk-limited, affordable, strategy cap). Never rounds UP.

    account_equity MUST be a validated number (see scripts/account_equity.py).
    """
    cfg = dict(CFG, **(cfg or {}))
    if not account_equity or float(account_equity) <= 0:
        return {"lots": 0, "risk_amount": 0.0, "risk_lots": 0, "affordable_lots": 0,
                "cap_lots": 0, "reason": "no validated account equity"}
    risk_pct = min(float(risk_pct or cfg["risk_pct"]), cfg["max_risk_pct"])
    risk_amount = float(account_equity) * risk_pct / 100.0
    risk_per_lot = float(risk_per_unit) * float(lot_size)
    if risk_per_lot <= 0:
        return {"lots": 0, "risk_amount": risk_amount, "risk_lots": 0, "affordable_lots": 0,
                "cap_lots": 0, "reason": "risk per lot is zero"}
    risk_lots = int(risk_amount // risk_per_lot)
    capital_per_lot = float(entry) * float(lot_size)
    deployable = float(account_equity)
    if deployment_cap:
        deployable = min(deployable, float(deployment_cap))
    affordable_lots = int(deployable // capital_per_lot) if capital_per_lot > 0 else 0
    cap_lots = int(max_lots if max_lots is not None else cfg["max_lots_per_trade"])
    lots = min(risk_lots, affordable_lots, cap_lots)
    halved = False
    if vix and vix > cfg["vix_high"]:
        lots = lots // 2
        halved = True
    return {"lots": max(0, lots), "risk_amount": risk_amount, "risk_lots": risk_lots,
            "affordable_lots": affordable_lots, "cap_lots": cap_lots,
            "risk_per_lot": risk_per_lot, "capital_per_lot": capital_per_lot,
            "halved": halved,
            "reason": "" if lots >= 1 else
                      "1 lot needs Rs %.0f of risk / Rs %.0f of capital, budget Rs %.0f" % (
                          risk_per_lot, capital_per_lot, risk_amount)}


def build_plan(rows, side, spot, vix, T, expiry_date, lot_size, account_equity,
               risk_pct=None, underlying_invalidation=None, blocking_level=None,
               hours_to_expiry=None, cfg=None, max_lots=None, deployment_cap=None,
               strategy=None, r=RISK_FREE):
    """Build the option plan. Returns (plan_dict_or_None, reasons_list).

    `plan_dict` uses the GEX trade shape (references/gex-output-schema.json),
    so the GEX engine and Agent E produce the same structure.
    """
    cfg = dict(CFG, **(cfg or {}))
    vix = float(vix or 0)
    reasons = []
    is_call = side == "call"
    opt_type = "CE" if is_call else "PE"
    if account_equity is None or float(account_equity) <= 0:
        return None, ["NO validated account-equity source - sizing is not possible"]

    best, rejected = pick_strike(rows, side, spot, T, vix, cfg)
    if not best:
        return None, ["no liquid strike with delta %.2f-%.2f in the top-5 OI (rejected: %s)" % (
            cfg["delta_min"], cfg["delta_max"],
            "; ".join("K%s:%s" % (x["strike"], ",".join(x["why"])) for x in rejected[:4]) or "none")]

    strike = best["strike"]
    delta = best["delta"]
    entry = best["premium"]
    if delta < cfg["delta_min"]:
        return None, ["delta %.3f below the %.2f floor" % (delta, cfg["delta_min"])]

    if hours_to_expiry is not None and hours_to_expiry < cfg["min_hours_to_expiry"]:
        return None, ["%.1fh to expiry (<%.0fh - no fresh option buys)" % (
            hours_to_expiry, cfg["min_hours_to_expiry"])]

    theta_pts = theta_per_day(spot, strike, T, best["row"].get("%s_iv" % side) and
                              iv_of(best["row"], side, vix), is_call)
    theta_pct = (theta_pts / entry * 100.0) if entry else None
    if theta_pct is not None and theta_pct > cfg["max_theta_pct_per_day"]:
        return None, ["theta %.1f%% of premium/day (>%.0f%%) - no fresh buys" % (
            theta_pct, cfg["max_theta_pct_per_day"])]

    # ---- stop: 25-30% of the premium, and it must sit on the underlying
    # invalidation that Agent B validated (never beyond it).
    if underlying_invalidation is None:
        return None, ["no validated underlying invalidation level"]
    sl_points = abs(float(spot) - float(underlying_invalidation))
    if sl_points <= 0:
        return None, ["invalid underlying invalidation (same as spot)"]
    implied_stop_pts = delta * sl_points
    implied_stop_pct = implied_stop_pts / entry if entry else 0.0
    if implied_stop_pct > cfg["stop_pct_max"]:
        return None, ["underlying invalidation needs a %.1f%% premium stop (>%.0f%% max)" % (
            implied_stop_pct * 100, cfg["stop_pct_max"] * 100)]
    stop_pct = max(cfg["stop_pct_min"], implied_stop_pct)
    stop_pct = min(stop_pct, cfg["stop_pct_max"])
    premium_sl = round(entry * (1.0 - stop_pct), 2)
    risk_per_unit = entry - premium_sl
    if risk_per_unit <= 0:
        return None, ["premium stop is not below the entry"]

    # ---- targets: TP1 at 2R, TP2 at 3R (rounded UP so the R:R never shrinks)
    tp1 = _ceil2(entry + cfg["rr_tp1"] * risk_per_unit)
    tp2 = _ceil2(entry + cfg["rr_tp2"] * risk_per_unit)
    rr_tp1 = round((tp1 - entry) / risk_per_unit, 6)
    rr_tp2 = round((tp2 - entry) / risk_per_unit, 6)

    # ---- expected moves: the one-day ATM-IV move (the record's number) and the
    # skill's 0.85 x ATM straddle measure (the containment gate).
    atm = min(rows, key=lambda r: abs(float(r["strike"]) - float(spot)))
    atm_iv = (iv_of(atm, "call", vix) + iv_of(atm, "put", vix)) / 2.0
    exp_move = expected_move_1sigma(spot, atm_iv)
    exp_move_exp = expected_move_expiry(rows, spot)
    tp1_points = (tp1 - entry) / delta if delta else 0.0
    tp2_points = (tp2 - entry) / delta if delta else 0.0

    checks = {
        "rr_tp1": {"pass": rr_tp1 >= cfg["rr_tp1"] - 1e-9,
                   "value": "%.2f (need >= %.1f)" % (rr_tp1, cfg["rr_tp1"])},
        "tp2_in_1sigma": {"pass": tp2_points <= exp_move_exp + 1e-9,
                          "value": "%.0f pts vs expiry 1-sigma %.0f pts (one-day 1-sigma %.0f pts)" % (
                              tp2_points, exp_move_exp, exp_move)},
    }
    if blocking_level:
        room = (float(spot) - float(blocking_level)) if not is_call else (float(blocking_level) - float(spot))
        checks["room_to_next_level"] = {"pass": room >= tp1_points - 1e-9,
                                        "value": "%.0f pts vs TP1 %.0f pts" % (room, tp1_points)}
    failed = [k for k, v in checks.items() if not v["pass"]]
    if failed:
        return None, ["failed option-math checks: " + ", ".join(
            "%s (%s)" % (k, checks[k]["value"]) for k in failed)]

    # ---- sizing
    sizing = size_position(risk_per_unit, lot_size, entry, account_equity,
                           risk_pct if risk_pct is not None else cfg["risk_pct"],
                           max_lots=max_lots, deployment_cap=deployment_cap, vix=vix, cfg=cfg)
    if sizing["lots"] < 1:
        return None, ["zero lots: %s" % sizing.get("reason", "risk budget too small")]

    plan = {
        "strike": strike,
        "type": opt_type,
        "expiry": expiry_date,
        "delta": round(delta, 2),
        "entry": round(entry, 2),
        "entry_range": [round(best["bid"], 2), round(best["ask"], 2)],
        "premium_sl": premium_sl,
        "underlying_invalidation": round(float(underlying_invalidation), 1),
        "tp1": tp1,
        "tp1_action": "book half, move SL to cost",
        "tp2": tp2,
        "tp2_action": "book rest or trail",
        "lots": sizing["lots"],
        "risk_inr": round(sizing["lots"] * risk_per_unit * float(lot_size), 0),
        "time_stop": "exit if no move in 30 min or by 15:10 IST",
        "order_type": "limit",
        "option_checks": checks,
        "expected_move_1sigma": round(exp_move, 0),
        "size_note": "halved (VIX > 20)" if sizing.get("halved") else "full",
    }
    reasons.append("delta %.2f strike %s, spread %.2f%%, stop %.1f%% of premium, TP1 %.1fR" % (
        delta, strike, best["spread_pct"], stop_pct * 100, rr_tp1))
    if strategy:
        reasons.append("strategy %s" % strategy)
    return plan, reasons
