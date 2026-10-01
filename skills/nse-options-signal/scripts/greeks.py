#!/usr/bin/env python3
"""Compute option Greeks + derived signals from an NSE option-chain JSON (snapshot['option_chain']).
NSE gives IV, not Greeks, so we compute Black-Scholes Greeks per strike.
Usage: python greeks.py snapshot.json [--vix 14.2] [--r 0.07] [--lot 75]
Outputs JSON: ATM IV, skew, expected move, per-strike delta/gamma/theta/vega, net GEX, gamma-flip level, greek score.
"""
import json, sys, math, argparse, datetime

def _n(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def _pdf(x): return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

def bs_greeks(S, K, T, sigma, r, opt):
    """sigma as decimal (0.14). Returns delta, gamma, theta(per day), vega(per 1 vol pt)."""
    if T <= 0 or sigma <= 0 or S <= 0:
        return dict(delta=0, gamma=0, theta=0, vega=0)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    gamma = _pdf(d1) / (S * sigma * math.sqrt(T))
    vega = S * _pdf(d1) * math.sqrt(T) / 100
    if opt == "CE":
        delta = _n(d1)
        theta = (-S * _pdf(d1) * sigma / (2 * math.sqrt(T)) - r * K * math.exp(-r * T) * _n(d2)) / 365
    else:
        delta = _n(d1) - 1
        theta = (-S * _pdf(d1) * sigma / (2 * math.sqrt(T)) + r * K * math.exp(-r * T) * _n(-d2)) / 365
    return dict(delta=round(delta, 4), gamma=round(gamma, 6), theta=round(theta, 2), vega=round(vega, 2))

def analyse(oc, r=0.07, lot=75, vix=None):
    recs = oc["records"]; S = recs["underlyingValue"]
    exp = recs["expiryDates"][0]
    exp_dt = datetime.datetime.strptime(exp, "%d-%b-%Y").replace(hour=15, minute=30)
    T = max((exp_dt - datetime.datetime.now()).total_seconds() / (365 * 24 * 3600), 1e-6)
    hours_left = round(T * 365 * 24, 1)
    rows = [x for x in recs["data"] if x["expiryDate"] == exp]
    atm = min(rows, key=lambda x: abs(x["strikePrice"] - S))
    step = sorted({x["strikePrice"] for x in rows})
    step = min(b - a for a, b in zip(step, step[1:]))
    iv_ce = atm.get("CE", {}).get("impliedVolatility", 0); iv_pe = atm.get("PE", {}).get("impliedVolatility", 0)
    atm_iv = (iv_ce + iv_pe) / 2 if iv_ce and iv_pe else max(iv_ce, iv_pe)
    ltp_ce = atm.get("CE", {}).get("lastPrice", 0); ltp_pe = atm.get("PE", {}).get("lastPrice", 0)
    straddle = ltp_ce + ltp_pe
    # skew: OTM put IV (2 steps below) minus OTM call IV (2 steps above)
    def iv_at(k, side):
        for x in rows:
            if x["strikePrice"] == k: return x.get(side, {}).get("impliedVolatility", 0)
        return 0
    put_iv = iv_at(atm["strikePrice"] - 2 * step, "PE"); call_iv = iv_at(atm["strikePrice"] + 2 * step, "CE")
    skew = round(put_iv - call_iv, 2) if put_iv and call_iv else None
    # per-strike greeks within +/-5 steps and GEX (dealer-neutral convention: calls +, puts -)
    per, gex_by_strike = [], {}
    for x in rows:
        K = x["strikePrice"]
        g_ce = g_pe = None
        gex = 0
        for side in ("CE", "PE"):
            d = x.get(side)
            if not d or not d.get("impliedVolatility"): continue
            g = bs_greeks(S, K, T, d["impliedVolatility"] / 100, r, side)
            if side == "CE": g_ce = g
            else: g_pe = g
            sign = 1 if side == "CE" else -1
            gex += sign * g["gamma"] * d.get("openInterest", 0) * lot * S * S * 0.01
        gex_by_strike[K] = gex
        if abs(K - atm["strikePrice"]) <= 5 * step:
            per.append({"strike": K, "CE": g_ce, "PE": g_pe})
    net_gex = sum(gex_by_strike.values())
    # gamma flip: strike where cumulative GEX (low->high) crosses zero
    cum, flip = 0, None
    for K in sorted(gex_by_strike):
        prev = cum; cum += gex_by_strike[K]
        if prev < 0 <= cum or prev > 0 >= cum: flip = K
    exp_move = round(straddle * 0.85, 1)     # ~1 sigma move to expiry
    # ---- greek score (max +/-10) and modifiers ----
    score, notes = 0, []
    if skew is not None:
        if skew > 2: score -= 3; notes.append(f"put skew {skew} vol pts (fear)")
        elif skew < -1: score += 3; notes.append(f"call skew {skew} (upside demand)")
    if flip:
        if S > flip: score += 3; notes.append(f"spot above gamma flip {flip}")
        else: score -= 3; notes.append(f"spot below gamma flip {flip}")
    if vix is not None:
        if vix > 20: notes.append(f"VIX {vix} high: premiums rich, prefer ITM, cut size 50%")
        elif vix < 12: notes.append(f"VIX {vix} low: cheap premiums but small moves")
    regime = "trending (negative net GEX) - directional buys favoured" if net_gex < 0 else "range/mean-reverting (positive net GEX) - reduce conviction near walls"
    theta_atm = bs_greeks(S, atm["strikePrice"], T, (atm_iv or 15) / 100, r, "CE")["theta"]
    theta_pct_per_day = round(abs(theta_atm) / ltp_ce * 100, 1) if ltp_ce else None
    gates = []
    if hours_left < 3: gates.append("<3 hours to expiry: extreme theta, no fresh buys")
    return {"spot": S, "expiry": exp, "hours_to_expiry": hours_left, "atm_strike": atm["strikePrice"],
            "atm_iv": atm_iv, "atm_straddle": straddle, "expected_move_1sigma": exp_move,
            "skew_put_minus_call": skew, "net_gex": round(net_gex), "gamma_flip": flip, "regime": regime,
            "atm_theta_per_day_pct_of_premium": theta_pct_per_day, "greek_score": max(-10, min(10, score)),
            "gates_failed": gates, "notes": notes, "strikes": per}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("snapshot"); ap.add_argument("--vix", type=float)
    ap.add_argument("--r", type=float, default=0.07); ap.add_argument("--lot", type=int, default=75)
    a = ap.parse_args()
    snap = json.load(open(a.snapshot))
    print(json.dumps(analyse(snap["option_chain"], a.r, a.lot, a.vix), indent=2))
