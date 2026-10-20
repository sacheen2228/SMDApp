#!/usr/bin/env python3
"""
Canonical PER-TRADE capital model — the single source of truth for how many
lots a trade may carry. Shared by strike_selector.py and hedge_calculator.py
(mirrors GATE_CONFIG in src/lib/agent-brain-gate.ts — keep the two in sync).

THE MODEL (user-defined 2026-10-20):
    "the trading capital is Rs 20,000-30,000 PER TRADE and the risk rule is
     risk = 20% of the amount DEPLOYED in the trade, with a Rs 20,000
     per-trade deployment cap"

    deployed_budget = min(trade_budget, capital)           # Rs put into THIS trade
    risk_budget     = deployed_budget * risk_pct / 100       # risk is a RUPEE amount
    lots            = min(
        floor(risk_budget / (risk_per_lot + cost_per_lot)),       # the RISK side
        floor(deployed_budget / (premium_per_lot + cost_per_lot)), # the AFFORDABILITY side
        max_lots,                                                # strategy cap (0 = none)
    )

WHY THE OLD MODEL WAS WRONG (the P0 bug):
    risk_budget = capital * risk_pct/100  with capital = Rs 2,00,000 and risk_pct = 1
    -> a Rs 2,000 risk budget against a NIFTY lot that risks Rs 3,000+ per lot
    -> 0 lots on EVERY strike -> "no strike passes the gates" for every setup,
       even though one lot was perfectly affordable at Rs 13,000 of premium.
    The old model also had NO affordability cap at all: the risk side alone
    decided the size, so a ₹20,000 premium could be "sized" at 1 lot even
    when it was never payable.

RULES:
  - lots are never rounded up (floor only).
  - 0 lots means the strike does NOT pass: the caller must report the reason
    (tighten the stop, pick a cheaper strike, or use a spread) — never risk more.
  - the affordability cap is the mirror image of the gate's positionSize():
    deployed_budget / premium_per_lot.
"""
import math

# Defaults (mirror GATE_CONFIG in src/lib/agent-brain-gate.ts)
DEFAULT_CAPITAL = 25_000.0          # the real trading capital (Rs 20-30k), NOT Rs 2L
DEFAULT_RISK_PCT_OF_TRADE = 20.0    # risk = 20% of the amount DEPLOYED
DEFAULT_TRADE_BUDGET = 20_000.0     # Rs DEPLOYED per trade (hard cap)
DEFAULT_COST_PER_LOT = 0.0          # round-trip costs per lot (Rs) — 0 = not modelled
DEFAULT_MAX_LOTS = 0                # strategy lot cap; 0 = no cap

FORMULA = (
    "deployed_budget = min(trade_budget, capital); "
    "risk_budget = deployed_budget * risk_pct_of_trade / 100; "
    "lots = min(floor(risk_budget / (risk_per_lot + cost_per_lot)), "
    "floor(deployed_budget / (premium_per_lot + cost_per_lot)), max_lots)"
)


def _positive(value, fallback):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if not math.isfinite(v) or v <= 0:
        return float(fallback)
    return v


def build_model(capital=DEFAULT_CAPITAL, risk_pct=DEFAULT_RISK_PCT_OF_TRADE,
                trade_budget=DEFAULT_TRADE_BUDGET, cost_per_lot=DEFAULT_COST_PER_LOT,
                max_lots=DEFAULT_MAX_LOTS):
    """Build the per-trade budget model. Returns a plain dict (JSON friendly)."""
    capital = _positive(capital, DEFAULT_CAPITAL)
    # a trade budget of 0/None means "no cap" (use the whole capital)
    try:
        tb = float(trade_budget)
    except (TypeError, ValueError):
        tb = float(DEFAULT_TRADE_BUDGET)
    if not math.isfinite(tb) or tb <= 0:
        tb = float("inf")
    risk_pct = _positive(risk_pct, DEFAULT_RISK_PCT_OF_TRADE)
    try:
        cost = float(cost_per_lot or 0.0)
    except (TypeError, ValueError):
        cost = 0.0
    if not math.isfinite(cost) or cost < 0:
        cost = 0.0
    try:
        cap = int(max_lots or 0)
    except (TypeError, ValueError):
        cap = 0
    if cap < 0:
        cap = 0

    deployed_budget = min(tb, capital)
    risk_budget = deployed_budget * risk_pct / 100.0
    return {
        "capital": capital,
        "trade_budget": tb,
        "risk_pct_of_trade": risk_pct,
        "deployed_budget": deployed_budget,
        "risk_budget": risk_budget,
        "cost_per_lot": cost,
        "max_lots": cap,
        "formula": FORMULA,
    }


def _floor_ratio(budget, per_lot):
    """floor(budget / per_lot) with a 1e-9 tolerance so 4000/3350 is not 0."""
    if per_lot <= 0:
        return 0
    return int(math.floor((budget + 1e-9) / per_lot))


def size_lots(model, risk_per_lot, premium_per_lot):
    """Size a position with the per-trade model.

    risk_per_lot     : Rs at risk per lot (stop distance x lot size)
    premium_per_lot  : Rs of premium committed per lot (entry x lot size)

    Returns a dict with the lots, both caps and a human reason when 0 lots.
    """
    cost = float(model.get("cost_per_lot") or 0.0)
    try:
        risk_per_lot = float(risk_per_lot or 0.0)
    except (TypeError, ValueError):
        risk_per_lot = 0.0
    try:
        premium_per_lot = float(premium_per_lot or 0.0)
    except (TypeError, ValueError):
        premium_per_lot = 0.0
    if risk_per_lot < 0:
        risk_per_lot = 0.0
    if premium_per_lot < 0:
        premium_per_lot = 0.0

    risk_budget = float(model["risk_budget"])
    deployed_budget = float(model["deployed_budget"])
    lots_by_risk = _floor_ratio(risk_budget, risk_per_lot + cost)
    lots_by_affordability = _floor_ratio(deployed_budget, premium_per_lot + cost)
    lots = max(0, min(lots_by_risk, lots_by_affordability))
    capped_by_strategy = False
    max_lots = int(model.get("max_lots") or 0)
    if max_lots and lots > max_lots:
        lots = max_lots
        capped_by_strategy = True

    reason = ""
    if lots < 1:
        bits = []
        if lots_by_risk < 1:
            bits.append(
                f"Rs {risk_per_lot:,.0f} risk/lot exceeds the Rs {risk_budget:,.0f} risk budget "
                f"({model['risk_pct_of_trade']:g}% of the Rs {deployed_budget:,.0f} deployed)")
        if lots_by_affordability < 1:
            bits.append(
                f"Rs {premium_per_lot:,.0f} premium/lot does not fit the Rs {deployed_budget:,.0f} "
                f"deployed budget")
        if not bits:
            bits.append("the strike is not sizeable at the current budget")
        reason = "0 lots: " + "; ".join(bits) + \
            " — tighten the stop, pick a cheaper strike or use a spread, NEVER risk more."

    return {
        "lots": lots,
        "lots_by_risk": lots_by_risk,
        "lots_by_affordability": lots_by_affordability,
        "capped_by_strategy": capped_by_strategy,
        "risk_per_lot": risk_per_lot,
        "premium_per_lot": premium_per_lot,
        "total_deployed": premium_per_lot * lots,
        "total_risk": risk_per_lot * lots,
        "reason": reason,
    }
