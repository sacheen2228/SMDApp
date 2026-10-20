#!/usr/bin/env python3
"""Agent E - the SOLE owner of strike, stop, targets and sizing.

Agent E never places an order: it produces a plan.  Rules:

  * delta 0.50-0.60 preferred, never below 0.35
  * the strike must be in the top-5 OI on the traded side
  * bid-ask spread <= 2% of the mid
  * lot size from the AUTHORITATIVE contract master (scripts/contract_master.py,
    which mirrors src/lib/symbol-config.ts / the NSE bhavcopy NewBrdLotQty).
    A stock never inherits NIFTY's lot; an unknown lot fails closed.
  * premium stop 25%-30% of the premium, sitting on the underlying invalidation
    that Agent B validated (never beyond it)
  * TP1 reward:risk >= 1:2, TP2 inside the 1-sigma expected move
  * < 3 hours to expiry -> NO TRADE
  * theta > 10% of the premium per day -> NO TRADE
  * VIX > 20 -> halve the size
  * lots = min(risk-limited (1% of a VALIDATED account equity), affordable,
    strategy cap), always rounded DOWN; zero lots -> NO TRADE
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents import protocol, snapshots  # noqa: E402

import contract_master  # noqa: E402
import option_math  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
INVALIDATION_BUFFER_PCT = 0.05


def run(task):
    now = snapshots.gex_snapshot.parse_ts(task.get("now")) or datetime.now(IST)
    vetoes, checks, notes = [], {}, []
    direction = str(task.get("direction") or "NEUTRAL").upper()
    if direction not in ("CE", "PE"):
        vetoes.append(protocol.veto("NO_DIRECTION", direction, "CE or PE"))
        res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res

    gex_snap = task.get("gex_snapshot")
    if not isinstance(gex_snap, dict):
        path = task.get("gex_snapshot_path")
        if not path:
            vetoes.append(protocol.veto("NO_CHAIN", "no GEX snapshot in the task", "an option chain"))
            res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res
        try:
            import json
            with open(path) as fh:
                gex_snap = json.load(fh)
        except Exception as exc:
            vetoes.append(protocol.veto("NO_CHAIN", str(exc), "a readable chain"))
            res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res

    symbol = gex_snap.get("symbol") or task.get("symbol") or "UNKNOWN"
    spot = float(gex_snap.get("spot") or 0)
    vix = float(gex_snap.get("vix") or 0)
    expiries = gex_snap.get("expiries") or []
    if not expiries:
        vetoes.append(protocol.veto("NO_CHAIN", "no expiry in the chain", "at least one expiry"))
        res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res
    exp = expiries[0]
    expiry_date = exp.get("date")
    chain = exp.get("chain") or []
    T = max(float(exp.get("days_to_expiry", 0.01)), 0.01) / 365.0
    exp_dt = datetime.fromisoformat(expiry_date + "T15:30:00").replace(tzinfo=IST)
    hours_to_expiry = (exp_dt - now).total_seconds() / 3600.0

    # ---------------------------------------------------------------- lot size
    lot_size = int(gex_snap.get("lot_size") or 0)
    lot_source = contract_master.provenance(symbol)
    if lot_size <= 0:
        lot_size = contract_master.lot_size(symbol)
    checks["lot_size"] = protocol.check(lot_size > 0, "%s lot=%s (%s)" % (symbol, lot_size, lot_source),
                                        "a lot size from the contract master")
    if lot_size <= 0:
        vetoes.append(protocol.veto("LOT_SIZE_UNKNOWN", "no lot size for %s" % symbol,
                                    "the contract master's lot for %s" % symbol))

    # ---------------------------------------------------------------- equity
    equity = task.get("account_equity")
    equity_source = task.get("account_equity_source")
    checks["account_equity"] = protocol.check(
        equity is not None and float(equity or 0) > 0,
        "%s (%s)" % (equity, equity_source or "no source"), "a validated account equity")
    if not equity or float(equity) <= 0:
        vetoes.append(protocol.veto("ACCOUNT_EQUITY_UNAVAILABLE", equity_source or "no validated equity",
                                    "a validated account-equity source"))

    # ---------------------------------------------------------------- invalidation geometry
    level = task.get("valid_level")
    invalidation = task.get("underlying_invalidation")
    if level is None or invalidation is None:
        vetoes.append(protocol.veto("NO_VALIDATED_LEVEL", "no validated level from Agent B",
                                    "Agent B's validated support/resistance level"))
        res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res
    level = float(level)
    invalidation = float(invalidation)
    is_call = direction == "CE"
    wrong_side = (invalidation >= level) if is_call else (invalidation <= level)
    buffer_ok = abs(invalidation - level) / level * 100.0 >= INVALIDATION_BUFFER_PCT
    checks["invalidation"] = protocol.check(
        not wrong_side and buffer_ok,
        "level %.2f -> invalidation %.2f (%.2f%% beyond)" % (level, invalidation, abs(invalidation - level) / level * 100),
        "the invalidation must sit beyond the level on the trade side (>= %.1f%%)" % INVALIDATION_BUFFER_PCT)
    if wrong_side:
        vetoes.append(protocol.veto("INVALIDATION_GEOMETRY", "invalidation %.2f is not beyond level %.2f for %s" % (
            invalidation, level, direction), "an invalidation beyond the validated level"))
    elif not buffer_ok:
        vetoes.append(protocol.veto("INVALIDATION_GEOMETRY", "invalidation %.2f is only %.2f%% beyond level %.2f" % (
            invalidation, abs(invalidation - level) / level * 100, level), ">= %.1f%% beyond the level" % INVALIDATION_BUFFER_PCT))

    # ---------------------------------------------------------------- the plan
    side = "call" if is_call else "put"
    plan, reasons = option_math.build_plan(
        rows=chain, side=side, spot=spot, vix=vix, T=T, expiry_date=expiry_date,
        lot_size=lot_size, account_equity=equity, risk_pct=task.get("risk_pct"),
        underlying_invalidation=invalidation, blocking_level=task.get("blocking_level"),
        hours_to_expiry=hours_to_expiry, max_lots=task.get("max_lots"),
        deployment_cap=task.get("max_deployment_per_trade"),
        strategy=task.get("strategy"))
    if not plan:
        for reason in reasons:
            vetoes.append(protocol.veto(_classify(reason), reason, "a valid option plan"))
        res = protocol.result("E", direction="NEUTRAL", vetoes=vetoes, checks=checks, notes=notes)
        res["trade"] = None
        return res

    delta = plan["delta"]
    band_lo, band_hi = option_math.CFG["delta_band"]
    checks["delta"] = protocol.check(delta >= option_math.CFG["delta_min"],
                                     "delta %.2f" % delta, ">= %.2f (preferred %.2f-%.2f)" % (
                                         option_math.CFG["delta_min"], band_lo, band_hi))
    if delta < option_math.CFG["delta_min"]:
        vetoes.append(protocol.veto("DELTA_BELOW_MIN", "delta %.2f" % delta, ">= %.2f" % option_math.CFG["delta_min"]))
    elif not (band_lo <= delta <= band_hi):
        notes.append("delta %.2f is outside the preferred %.2f-%.2f band" % (delta, band_lo, band_hi))
    stop_pct = (plan["entry"] - plan["premium_sl"]) / plan["entry"] * 100.0
    checks["premium_stop"] = protocol.check(
        option_math.CFG["stop_pct_min"] * 100 - 0.51 <= stop_pct <= option_math.CFG["stop_pct_max"] * 100 + 0.51,
        "%.1f%% of the premium" % stop_pct, "%.0f%%-%.0f%%" % (
            option_math.CFG["stop_pct_min"] * 100, option_math.CFG["stop_pct_max"] * 100))
    rr = plan["option_checks"]["rr_tp1"]
    checks["rr_tp1"] = protocol.check(rr["pass"], rr["value"], ">= 1:2")
    tp2 = plan["option_checks"]["tp2_in_1sigma"]
    checks["tp2_1sigma"] = protocol.check(tp2["pass"], tp2["value"], "TP2 inside the 1-sigma move")
    checks["expiry_distance"] = protocol.check(
        hours_to_expiry >= option_math.CFG["min_hours_to_expiry"],
        "%.1f h to expiry" % hours_to_expiry, ">= %.0f h" % option_math.CFG["min_hours_to_expiry"])
    checks["vix"] = protocol.check(vix <= option_math.CFG["vix_high"],
                                   "VIX %.1f" % vix, "<= %.0f (above it: half size)" % option_math.CFG["vix_high"])
    checks["lots"] = protocol.check(plan["lots"] >= 1, "%d lot(s)" % plan["lots"], ">= 1")

    risk_points = abs(spot - invalidation)
    targets = [round(spot + (2 * risk_points if is_call else -2 * risk_points), 1),
               round(spot + (3 * risk_points if is_call else -3 * risk_points), 1)]
    trade = {
        "expiry": plan["expiry"],
        "strike": plan["strike"],
        "option_type": plan["type"],
        "entry_zone": plan["entry_range"],
        "stop_loss_premium": plan["premium_sl"],
        "tp1_premium": plan["tp1"],
        "tp2_premium": plan["tp2"],
        "underlying_invalidation": plan["underlying_invalidation"],
        "underlying_targets": targets,
        "risk_reward_tp1": round((plan["tp1"] - plan["entry"]) / max(plan["entry"] - plan["premium_sl"], 1e-9), 2),
        "suggested_lots": plan["lots"],
        "time_stop": plan["time_stop"],
        "delta": plan["delta"],
        "lot_size": lot_size,
        "lot_size_source": lot_source,
        "risk_inr": plan["risk_inr"],
        "size_note": plan["size_note"],
        "expected_move_1sigma": plan["expected_move_1sigma"],
        "option_checks": plan["option_checks"],
        "hours_to_expiry": round(hours_to_expiry, 1),
        "vix": vix or None,
        "order_type": plan["order_type"],
    }
    data = {"trade": trade, "plan": plan, "reasons": reasons,
            "account_equity": equity, "account_equity_source": equity_source,
            "risk_pct": task.get("risk_pct") or option_math.CFG["risk_pct"]}
    res = protocol.result("E", direction=direction, vetoes=vetoes, checks=checks, data=data, notes=notes)
    res["trade"] = trade
    return res


def _classify(reason):
    text = str(reason)
    if "tp2_in_1sigma" in text:
        return "TP2_OUTSIDE_1SIGMA"
    if "rr_tp1" in text:
        return "RR_TP1_BELOW_2"
    if "room_to_next_level" in text:
        return "NO_ROOM_TO_TARGET"
    if "no liquid strike" in text:
        return "NO_LIQUID_STRIKE"
    if "delta" in text and "below" in text:
        return "DELTA_BELOW_MIN"
    if "theta" in text:
        return "THETA_TOO_HIGH"
    if "to expiry" in text:
        return "EXPIRY_TOO_CLOSE"
    if "premium stop" in text:
        return "STOP_TOO_WIDE"
    if "zero lots" in text:
        return "ZERO_LOTS"
    if "account-equity" in text or "account equity" in text:
        return "ACCOUNT_EQUITY_UNAVAILABLE"
    return "OPTION_PLAN_REJECTED"


if __name__ == "__main__":
    protocol.main_wrapper("E", run)
