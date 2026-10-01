#!/usr/bin/env python3
"""Build the level map + confluence zones + option-liquidity check.
Usage: python levels.py snapshot.json [--ohlc ohlc.json]
ohlc.json (optional, from your data feed): {"pdh":..,"pdl":..,"pdc":..,"or_high":..,"or_low":..,"vwap":..,"week_high":..,"week_low":..}
"""
import json, sys, argparse

def max_pain(rows):
    best, best_loss = None, None
    ks = [r["strikePrice"] for r in rows]
    for k in ks:
        loss = 0
        for r in rows:
            loss += r.get("CE", {}).get("openInterest", 0) * max(0, k - r["strikePrice"])
            loss += r.get("PE", {}).get("openInterest", 0) * max(0, r["strikePrice"] - k)
        if best_loss is None or loss < best_loss: best, best_loss = k, loss
    return best

def build(snap, ohlc=None, round_step=100):
    oc = snap["option_chain"]["records"]; S = oc["underlyingValue"]
    exp = oc["expiryDates"][0]; rows = [r for r in oc["data"] if r["expiryDate"] == exp]
    lv = {}
    above = [r for r in rows if r["strikePrice"] >= S and "CE" in r]
    below = [r for r in rows if r["strikePrice"] <= S and "PE" in r]
    if above: lv["oi_resistance"] = max(above, key=lambda r: r["CE"]["openInterest"])["strikePrice"]
    if below: lv["oi_support"] = max(below, key=lambda r: r["PE"]["openInterest"])["strikePrice"]
    # second walls
    if above: lv["oi_resistance_2"] = sorted(above, key=lambda r: -r["CE"]["openInterest"])[1]["strikePrice"] if len(above) > 1 else None
    if below: lv["oi_support_2"] = sorted(below, key=lambda r: -r["PE"]["openInterest"])[1]["strikePrice"] if len(below) > 1 else None
    lv["max_pain"] = max_pain(rows)
    atm = min(rows, key=lambda r: abs(r["strikePrice"] - S))
    st = atm.get("CE", {}).get("lastPrice", 0) + atm.get("PE", {}).get("lastPrice", 0)
    lv["exp_move_up"], lv["exp_move_down"] = round(S + 0.85 * st), round(S - 0.85 * st)
    lv["round_above"] = (int(S // round_step) + 1) * round_step
    lv["round_below"] = int(S // round_step) * round_step
    if ohlc: lv.update({k: v for k, v in ohlc.items() if v})
    vals = sorted((v, k) for k, v in lv.items() if isinstance(v, (int, float)))
    zones, cur = [], [vals[0]] if vals else []
    for v, k in vals[1:]:
        if cur and (v - cur[0][0]) / S <= 0.0015: cur.append((v, k))
        else:
            if len(cur) >= 3: zones.append(cur)
            cur = [(v, k)]
    if len(cur) >= 3: zones.append(cur)
    zones = [{"price_range": [z[0][0], z[-1][0]], "levels": [k for _, k in z], "strength": len(z)} for z in zones]
    # liquidity: top-5 OI strikes and spread proxy
    top = sorted(rows, key=lambda r: -(r.get("CE", {}).get("openInterest", 0) + r.get("PE", {}).get("openInterest", 0)))[:5]
    liquid = [r["strikePrice"] for r in top]
    def spread(d):
        b, a = d.get("bidprice", 0), d.get("askPrice", 0)
        return round((a - b) / a * 100, 2) if a else None
    spreads = {r["strikePrice"]: {"CE": spread(r.get("CE", {})), "PE": spread(r.get("PE", {}))} for r in rows if abs(r["strikePrice"] - S) / S < 0.01}
    near = [k for k, v in lv.items() if isinstance(v, (int, float)) and abs(v - S) / S <= 0.002]
    return {"spot": S, "levels": lv, "confluence_zones": zones, "levels_near_spot": near,
            "liquid_strikes_top5_oi": liquid, "spread_pct_near_atm": spreads,
            "hint": "Trade only at/beyond a confluence zone; wide spread (>2%) = choose another strike."}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("snapshot"); ap.add_argument("--ohlc"); ap.add_argument("--round", type=int, default=100)
    a = ap.parse_args()
    print(json.dumps(build(json.load(open(a.snapshot)), json.load(open(a.ohlc)) if a.ohlc else None, a.round), indent=2))
