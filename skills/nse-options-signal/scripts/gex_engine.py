#!/usr/bin/env python3
"""
GEX ENGINE - standalone gamma-exposure engine for NSE index / stock options.

Reads snapshot.json (+ snapshot_history/*.json), computes net GEX, gamma flip,
call/put walls and regime, then emits SEPARATE trades tagged engine="GEX"
with strategy names GEX-1..GEX-4. It never mixes with the main agents' score.

This is the ONLY place gamma exposure is computed. The orchestrator (Agent D)
validates the record this engine produces - it never re-derives GEX.

ADAPTATIONS to the original package (documented in references/agent-rules.md):
  * account equity is NEVER hardcoded: the engine takes a validated equity
    value (scripts/account_equity.py). Without it the engine returns NO_TRADE.
  * option math (strike/stop/targets/sizing) moved to scripts/option_math.py
    so the GEX engine and Agent E cannot drift apart.
  * extra gates: >= 3 history snapshots, unknown lot size, missing / invalid /
    future snapshot timestamp.
  * GEX-2 FLIP_BREAK is restricted to the TRANSITION regime and still needs a
    confirmed 15-minute close beyond the gamma flip.

Usage:
  python gex_engine.py --snapshot snapshot.json --history snapshot_history/ \
         --out gex_trades.jsonl [--now 2026-10-20T10:45:00+05:30] \
         [--account-equity data/account_equity.json] [--json]

Educational tool, not financial advice. Stdlib only.
"""
import argparse, glob, json, math, os, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import option_math  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
RISK_FREE = 0.065

# ---- tunables (starting values, backtest before live use) -------------------
CFG = {
    "max_data_age_min": 15,
    "flip_zone_pct": 0.003,        # |spot-flip|/spot below this = TRANSITION
    "level_buffer_pct": 0.001,     # 0.1% close-beyond / buffer
    "wall_strength_min": 1.5,
    "vol_mult_break": 1.5,
    "vol_mult_trend": 1.0,
    "wick_body_mult": 2.0,
    "min_candles": 22,
    "max_spot_drift_pct": 0.003,
    "no_trade_before": (9, 30),
    "no_trade_after": (15, 0),
    "cooldown_min": 30,
    "next_expiry_weight": 0.3,
    "min_history": 3,
    "risk_pct": 1.0,
}


# ---- Black-Scholes helpers ---------------------------------------------------
def npdf(x): return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)

def _d1(S, K, T, sig):
    return (math.log(S / K) + (RISK_FREE + 0.5 * sig * sig) * T) / (sig * math.sqrt(T))

def bs_gamma(S, K, T, sig):
    if S <= 0 or K <= 0 or T <= 0 or sig <= 0: return 0.0
    return npdf(_d1(S, K, T, sig)) / (S * sig * math.sqrt(T))


# ---- snapshot parsing --------------------------------------------------------
def parse_ts(s):
    t = datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=IST)

def iv_of(row, side, vix):
    v = row.get("%s_iv" % side)
    if not v or v <= 0: v = vix
    return max(float(v or 0), 1.0) / 100.0

def active_expiries(snap):
    ex = snap.get("expiries", [])[:2]
    out = []
    for i, e in enumerate(ex):
        w = 1.0 if i == 0 else CFG["next_expiry_weight"]
        T = max(float(e.get("days_to_expiry", 0.01)), 0.01) / 365.0
        out.append((e, w, T))
    return out

def net_gex_at(snap, s_hyp):
    """Net GEX (INR) per 1% move if spot were s_hyp. Calls +, puts -."""
    lot, vix = snap["lot_size"], snap.get("vix", 15)
    total = 0.0
    for e, w, T in active_expiries(snap):
        for r in e["chain"]:
            K = r["strike"]
            gc = bs_gamma(s_hyp, K, T, iv_of(r, "call", vix))
            gp = bs_gamma(s_hyp, K, T, iv_of(r, "put", vix))
            total += w * (gc * r.get("call_oi", 0) - gp * r.get("put_oi", 0)) * lot * s_hyp ** 2 * 0.01
    return total

def strike_gex(snap):
    """Per-strike call GEX (+) and put GEX (-) at current spot, expiry-weighted."""
    S, lot, vix = snap["spot"], snap["lot_size"], snap.get("vix", 15)
    calls, puts = {}, {}
    for e, w, T in active_expiries(snap):
        for r in e["chain"]:
            K = r["strike"]
            gc = bs_gamma(S, K, T, iv_of(r, "call", vix)) * r.get("call_oi", 0) * lot * S * S * 0.01 * w
            gp = bs_gamma(S, K, T, iv_of(r, "put", vix)) * r.get("put_oi", 0) * lot * S * S * 0.01 * w
            calls[K] = calls.get(K, 0) + gc
            puts[K] = puts.get(K, 0) - gp
    return calls, puts

def gex_profile(snap):
    S = snap["spot"]
    grid = [S * (1 + k * 0.0025) for k in range(-12, 13)]
    return [(s, net_gex_at(snap, s)) for s in grid]

def find_flip(profile, spot):
    best = None
    for (s1, g1), (s2, g2) in zip(profile, profile[1:]):
        if g1 == 0: cand = s1
        elif g1 * g2 < 0: cand = s1 + (s2 - s1) * (0 - g1) / (g2 - g1)
        else: continue
        if best is None or abs(cand - spot) < abs(best - spot): best = cand
    return best

def wall_pick(d, spot, above):
    items = [(k, abs(v)) for k, v in d.items() if (k >= spot if above else k <= spot) and v != 0]
    items.sort(key=lambda x: -x[1])
    if not items: return None, 0.0
    strength = items[0][1] / items[1][1] if len(items) > 1 and items[1][1] > 0 else 99.0
    return items[0][0], strength

def compute_gex(snap):
    S = snap["spot"]
    prof = gex_profile(snap)
    net = net_gex_at(snap, S)
    flip = find_flip(prof, S)
    calls, puts = strike_gex(snap)
    cw, cw_str = wall_pick(calls, S, True)
    pw, pw_str = wall_pick(puts, S, False)
    net_by_strike = {k: calls.get(k, 0) + puts.get(k, 0) for k in set(calls) | set(puts)}
    near = [(k, abs(v)) for k, v in net_by_strike.items() if abs(k - S) / S <= 0.01]
    pin = max(near, key=lambda x: x[1])[0] if near else None
    if flip and abs(S - flip) / S <= CFG["flip_zone_pct"]: regime = "TRANSITION"
    elif flip: regime = "POSITIVE_GEX" if S > flip else "NEGATIVE_GEX"
    else: regime = "POSITIVE_GEX" if net > 0 else "NEGATIVE_GEX"
    return {"net": net, "flip": flip, "call_wall": cw, "call_wall_strength": cw_str,
            "put_wall": pw, "put_wall_strength": pw_str, "pin": pin, "regime": regime}


# ---- history / dynamics ------------------------------------------------------
def load_history(path, now):
    snaps = []
    for f in sorted(glob.glob(os.path.join(path, "*.json"))) if path and os.path.isdir(path) else []:
        try:
            s = json.load(open(f))
            t = parse_ts(s["timestamp"])
            if timedelta(0) < now - t <= timedelta(minutes=65): snaps.append((t, s))
        except Exception:
            continue
    snaps.sort(key=lambda x: x[0])
    return snaps

def gex_trend(hist, current_net):
    vals = [net_gex_at(s, s["spot"]) for _, s in hist][-3:] + [current_net]
    if len(vals) < CFG["min_history"] + 1: return "UNKNOWN", vals
    if all(b < a for a, b in zip(vals, vals[1:])): return "FALLING", vals
    if all(b > a for a, b in zip(vals, vals[1:])): return "RISING", vals
    return "MIXED", vals

def oi_change_pct(hist, now, strike, side, minutes=30):
    """% change of OI at strike (nearest expiry) vs ~minutes ago. None if unavailable."""
    key = "%s_oi" % side
    target = now - timedelta(minutes=minutes)
    if not hist: return None
    t, s = min(hist, key=lambda x: abs((x[0] - target).total_seconds()))
    if abs((t - target).total_seconds()) > 600: return None
    return s, key

def oi_delta(cur_snap, hist, now, strike, side):
    r = oi_change_pct(hist, now, strike, side)
    if r is None: return None
    old_snap, key = r
    def oi(sn):
        for row in sn["expiries"][0]["chain"]:
            if row["strike"] == strike: return row.get(key, 0)
        return None
    a, b = oi(old_snap), oi(cur_snap)
    if not a or b is None: return None
    return (b - a) / a * 100.0

def frozen_feed(cur, hist):
    if not hist: return False
    prev = hist[-1][1]
    tot = lambda s: sum(r.get("call_oi", 0) + r.get("put_oi", 0) for r in s["expiries"][0]["chain"])
    return tot(prev) == tot(cur) and prev.get("spot") == cur.get("spot")


# ---- candles -----------------------------------------------------------------
def vol_ratio(c):
    prev = [x["v"] for x in c[-21:-1]]
    return c[-1]["v"] / (sum(prev) / len(prev)) if prev and sum(prev) > 0 else 0.0


# ---- strategies --------------------------------------------------------------
def gex1_pin_fade(g, c, spot, ctx):
    """POSITIVE_GEX only. Fade a validated call/put wall on a rejection candle."""
    if g["regime"] != "POSITIVE_GEX": return None
    last, buf = c[-1], CFG["level_buffer_pct"]
    body = max(abs(last["c"] - last["o"]), spot * 0.0002)
    cw, pw = g["call_wall"], g["put_wall"]
    mid = (cw + pw) / 2 if cw and pw else None
    if cw and g["call_wall_strength"] >= CFG["wall_strength_min"] and last["h"] >= cw * (1 - buf) \
            and last["c"] < cw and (last["h"] - max(last["o"], last["c"])) >= CFG["wick_body_mult"] * body:
        sl = max(last["h"], cw) * (1 + 0.0015)
        tgt = mid if mid and mid < spot else g["pin"]
        return dict(strategy="GEX-1 PIN_FADE", direction="BUY_PE", level=cw, sl_underlying=sl,
                    target_underlying=tgt, blocking_level=tgt,
                    reasons=["Positive GEX, call wall %s (strength %.1fx) rejected, upper wick >= 2x body" % (
                        cw, g["call_wall_strength"])])
    if pw and g["put_wall_strength"] >= CFG["wall_strength_min"] and last["l"] <= pw * (1 + buf) \
            and last["c"] > pw and (min(last["o"], last["c"]) - last["l"]) >= CFG["wick_body_mult"] * body:
        sl = min(last["l"], pw) * (1 - 0.0015)
        tgt = mid if mid and mid > spot else g["pin"]
        return dict(strategy="GEX-1 PIN_FADE", direction="BUY_CE", level=pw, sl_underlying=sl,
                    target_underlying=tgt, blocking_level=tgt,
                    reasons=["Positive GEX, put wall %s (strength %.1fx) held, lower wick >= 2x body" % (
                        pw, g["put_wall_strength"])])
    return None

def gex2_flip_break(g, c, spot, ctx):
    """TRANSITION only. Fresh 15-min close beyond the gamma flip on volume."""
    if g["regime"] != "TRANSITION": return None
    flip = g["flip"]
    if not flip or len(c) < 22: return None
    buf = CFG["level_buffer_pct"]
    last, prev = c[-1], c[-2]
    vr = vol_ratio(c)
    if vr < CFG["vol_mult_break"]: return None
    if last["c"] < flip * (1 - buf) and prev["c"] >= flip:
        return dict(strategy="GEX-2 FLIP_BREAK", direction="BUY_PE", level=flip,
                    sl_underlying=flip * (1 + buf), target_underlying=g["put_wall"],
                    blocking_level=g["put_wall"],
                    reasons=["15m close %.0f below gamma flip %.0f, volume %.1fx, entering negative gamma" % (
                        last["c"], flip, vr)])
    if last["c"] > flip * (1 + buf) and prev["c"] <= flip:
        return dict(strategy="GEX-2 FLIP_BREAK", direction="BUY_CE", level=flip,
                    sl_underlying=flip * (1 - buf), target_underlying=g["call_wall"],
                    blocking_level=g["call_wall"],
                    reasons=["15m close %.0f above gamma flip %.0f, volume %.1fx" % (last["c"], flip, vr)])
    return None

def gex3_neg_trend(g, c, spot, ctx):
    """NEGATIVE_GEX only. Momentum continuation (dealers amplify moves)."""
    if g["regime"] != "NEGATIVE_GEX" or len(c) < 22: return None
    if ctx["trend"] == "RISING": return None
    mean20 = sum(x["c"] for x in c[-20:]) / 20
    a, b = c[-2]["c"], c[-1]["c"]
    vr = vol_ratio(c)
    if vr < CFG["vol_mult_trend"]: return None
    if b < a < c[-3]["c"] and b < mean20:
        sl = max(x["h"] for x in c[-3:])
        return dict(strategy="GEX-3 NEG_TREND", direction="BUY_PE", level=g["flip"], sl_underlying=sl,
                    target_underlying=g["put_wall"], blocking_level=g["put_wall"],
                    reasons=["Negative GEX %.0f Cr, spot below flip %s, 3 lower closes, volume %.1fx" % (
                        g["net"] / 1e7, g["flip"], vr)])
    if b > a > c[-3]["c"] and b > mean20:
        sl = min(x["l"] for x in c[-3:])
        return dict(strategy="GEX-3 NEG_TREND", direction="BUY_CE", level=g["flip"], sl_underlying=sl,
                    target_underlying=g["call_wall"], blocking_level=g["call_wall"],
                    reasons=["Negative GEX %.0f Cr, 3 higher closes, volume %.1fx (dealer buying amplifies rally)" % (
                        g["net"] / 1e7, vr)])
    return None

def gex4_wall_break(g, c, spot, ctx):
    """15-min close through a validated wall while net GEX is falling and wall OI is unwinding."""
    if len(c) < 22 or ctx["trend"] != "FALLING": return None
    if g["regime"] != "NEGATIVE_GEX": return None
    buf, last = CFG["level_buffer_pct"], c[-1]
    vr = vol_ratio(c)
    if vr < CFG["vol_mult_break"]: return None
    cw, pw = g["call_wall"], g["put_wall"]
    if cw and last["c"] > cw * (1 + buf):
        d = oi_delta(ctx["snap"], ctx["hist"], ctx["now"], cw, "call")
        if d is not None and d <= -5:
            return dict(strategy="GEX-4 WALL_BREAK", direction="BUY_CE", level=cw,
                        sl_underlying=cw * (1 - buf), target_underlying=None, blocking_level=None,
                        reasons=["15m close %.0f above call wall %s, Call OI %.1f%% in 30m, net GEX falling, volume %.1fx" % (
                            last["c"], cw, d, vr)])
    if pw and last["c"] < pw * (1 - buf):
        d = oi_delta(ctx["snap"], ctx["hist"], ctx["now"], pw, "put")
        if d is not None and d <= -5:
            return dict(strategy="GEX-4 WALL_BREAK", direction="BUY_PE", level=pw,
                        sl_underlying=pw * (1 + buf), target_underlying=None, blocking_level=None,
                        reasons=["15m close %.0f below put wall %s, Put OI %.1f%% in 30m, net GEX falling, volume %.1fx" % (
                            last["c"], pw, d, vr)])
    return None

STRATEGIES = [gex1_pin_fade, gex2_flip_break, gex3_neg_trend, gex4_wall_break]

REGIME_STRATEGY = {
    "POSITIVE_GEX": ("GEX-1 PIN_FADE",),
    "NEGATIVE_GEX": ("GEX-3 NEG_TREND", "GEX-4 WALL_BREAK"),
    "TRANSITION": ("GEX-2 FLIP_BREAK",),
}


# ---- gates -------------------------------------------------------------------
def global_gates(snap, g, hist, now, out_path):
    fails = []
    raw_ts = snap.get("timestamp")
    if not raw_ts:
        fails.append("snapshot has no timestamp - freshness unprovable")
    else:
        try:
            ts = parse_ts(raw_ts)
        except Exception:
            fails.append("snapshot timestamp is not a valid ISO timestamp")
            ts = None
        if ts is not None:
            age = (now - ts).total_seconds() / 60
            if age < 0:
                fails.append("snapshot timestamp is in the future (%.0f min ahead)" % (-age))
            elif age > CFG["max_data_age_min"]:
                fails.append("stale data (%.0f min old, limit %d min)" % (age, CFG["max_data_age_min"]))
    if not snap.get("lot_size"):
        fails.append("lot size unknown - contract master has no lot for %s" % snap.get("symbol"))
    if len(hist) < CFG["min_history"]:
        fails.append("only %d history snapshots (need %d)" % (len(hist), CFG["min_history"]))
    c = snap.get("candles_15m", [])
    if len(c) < CFG["min_candles"]:
        fails.append("fewer than %d 15-min candles" % CFG["min_candles"])
    elif abs(c[-1]["c"] - snap["spot"]) / snap["spot"] > CFG["max_spot_drift_pct"]:
        fails.append("spot differs from last candle close by >%.1f%%" % (CFG["max_spot_drift_pct"] * 100))
    if frozen_feed(snap, hist): fails.append("frozen feed (identical OI and spot vs last snapshot)")
    h, m = now.astimezone(IST).hour, now.astimezone(IST).minute
    if (h, m) < CFG["no_trade_before"]: fails.append("before 09:30 IST")
    if (h, m) >= CFG["no_trade_after"]: fails.append("after 15:00 IST")
    e0 = snap["expiries"][0]
    exp_dt = datetime.fromisoformat(e0["date"] + "T15:30:00").replace(tzinfo=IST)
    hrs = (exp_dt - now).total_seconds() / 3600
    if hrs < option_math.CFG["min_hours_to_expiry"]:
        fails.append("%.1fh to expiry (<%.0fh, no fresh buys)" % (hrs, option_math.CFG["min_hours_to_expiry"]))
    if g["call_wall"] is None and g["put_wall"] is None: fails.append("no valid GEX walls")
    if out_path and os.path.exists(out_path):
        try:
            last = [json.loads(l) for l in open(out_path).read().splitlines() if l.strip()][-1]
            if (now - parse_ts(last["timestamp"])).total_seconds() / 60 < CFG["cooldown_min"] \
                    and last.get("symbol") == snap["symbol"] and last.get("action") != "NO_TRADE":
                fails.append("cooldown: GEX trade issued %s" % last["timestamp"])
        except Exception:
            pass
    return fails, hrs


# ---- strike selection & trade building --------------------------------------
def build_trade(snap, g, cand, hrs, now, account_equity=None, risk_pct=None, max_lots=None):
    """Build the GEX engine's own trade proposal (Agent E owns the final plan)."""
    S, vix = snap["spot"], float(snap.get("vix") or 0)
    e0 = snap["expiries"][0]
    T = max(float(e0.get("days_to_expiry", 0.01)), 0.01) / 365.0
    side = "call" if cand["direction"] == "BUY_CE" else "put"
    if cand.get("sl_underlying") is None:
        return None, "no underlying invalidation level"
    plan, reasons = option_math.build_plan(
        rows=e0["chain"], side=side, spot=S, vix=vix, T=T,
        expiry_date=e0["date"], lot_size=snap["lot_size"],
        account_equity=account_equity, risk_pct=risk_pct,
        underlying_invalidation=cand["sl_underlying"],
        blocking_level=cand.get("blocking_level"),
        hours_to_expiry=hrs,
        max_lots=max_lots if max_lots is not None else option_math.CFG["gex_max_lots"],
        strategy=cand["strategy"])
    if not plan:
        return None, "; ".join(reasons)
    return plan, "; ".join(reasons + cand.get("reasons", []))


# ---- main --------------------------------------------------------------------
def run(snap, hist, now, out_path, account_equity=None, risk_pct=None, max_lots=None):
    g = compute_gex(snap)
    trend, vals = gex_trend(hist, g["net"])
    gates, hrs = global_gates(snap, g, hist, now, out_path)
    result = {
        "engine": "GEX", "symbol": snap["symbol"], "timestamp": now.isoformat(),
        "spot": snap["spot"], "vix": snap.get("vix"),
        "gex": {"net_cr": round(g["net"] / 1e7, 2), "flip": round(g["flip"], 1) if g["flip"] else None,
                "call_wall": g["call_wall"], "call_wall_strength": round(g["call_wall_strength"], 2),
                "put_wall": g["put_wall"], "put_wall_strength": round(g["put_wall_strength"], 2),
                "pin": g["pin"], "regime": g["regime"], "net_trend": trend,
                "net_history_cr": [round(v / 1e7, 2) for v in vals], "data_quality": "ok" if not gates else "degraded"},
        "failed_gates": gates, "action": "NO_TRADE", "trade_id": None, "strategy": None,
        "reasons": [], "trade": None,
    }
    if gates:
        result["reasons"] = ["Global gate failed: " + "; ".join(gates)]
        return result
    c = snap["candles_15m"]
    ctx = {"trend": trend, "snap": snap, "hist": hist, "now": now}
    near_misses = []
    for fn in STRATEGIES:
        cand = fn(g, c, snap["spot"], ctx)
        if not cand: continue
        if cand["strategy"] not in REGIME_STRATEGY.get(g["regime"], ()):
            near_misses.append("%s %s skipped: not allowed in regime %s" % (
                cand["strategy"], cand["direction"], g["regime"]))
            continue
        trade, why = build_trade(snap, g, cand, hrs, now, account_equity=account_equity,
                                 risk_pct=risk_pct, max_lots=max_lots)
        if trade:
            tid = "GEX-%s-%s-%s" % (snap["symbol"], now.astimezone(IST).strftime("%Y%m%d-%H%M"),
                                    cand["strategy"].split()[0][-1])
            result.update(action=cand["direction"], strategy=cand["strategy"], trade_id=tid,
                          reasons=cand["reasons"], trade=trade)
            return result
        near_misses.append("%s %s rejected: %s" % (cand["strategy"], cand["direction"], why))
    result["reasons"] = near_misses or ["No GEX setup. Regime %s, spot %s, flip %s" % (
        g["regime"], snap["spot"], g["flip"])]
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--history", default="snapshot_history")
    ap.add_argument("--out", default="gex_trades.jsonl")
    ap.add_argument("--now", default=None)
    ap.add_argument("--account-equity", default=None,
                    help="JSON file with the validated account equity (see scripts/account_equity.py)")
    ap.add_argument("--risk-pct", type=float, default=None)
    ap.add_argument("--max-lots", type=int, default=None)
    ap.add_argument("--json", action="store_true", help="print JSON only")
    a = ap.parse_args()
    snap = json.load(open(a.snapshot))
    now = parse_ts(a.now) if a.now else datetime.now(IST)
    hist = load_history(a.history, now)
    equity = None
    if a.account_equity:
        import account_equity
        eq = account_equity.load(a.account_equity, now=now)
        equity = eq.get("equity") if eq.get("ok") else None
    res = run(snap, hist, now, a.out, account_equity=equity, risk_pct=a.risk_pct, max_lots=a.max_lots)
    with open(a.out, "a") as f: f.write(json.dumps(res) + "\n")
    if a.json:
        print(json.dumps(res, indent=2)); return
    gx = res["gex"]
    print("%s | GEX %s Cr | %s | flip %s | call wall %s | put wall %s | trend %s" % (
        res["symbol"], gx["net_cr"], gx["regime"], gx["flip"], gx["call_wall"], gx["put_wall"], gx["net_trend"]))
    if res["action"] == "NO_TRADE":
        print("NO_TRADE:", " | ".join(res["reasons"]))
    else:
        t = res["trade"]
        print("%s %s -> %s %s %s (%s) entry %s SL %s TP1 %s TP2 %s inval %s lots %s" % (
            res["trade_id"], res["strategy"], res["action"], t["strike"], t["type"], t["expiry"],
            t["entry"], t["premium_sl"], t["tp1"], t["tp2"], t["underlying_invalidation"], t["lots"]))
        print("Why:", "; ".join(res["reasons"]))

if __name__ == "__main__":
    main()
