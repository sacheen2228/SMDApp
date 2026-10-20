#!/usr/bin/env python3
"""Validate a breakout / fakeout at a level (agent step 5).

Usage:
  python3 breakout.py snapshot.json --level 24600 --direction up \
      [--history snapshot_history] [--thresholds references/breakout-thresholds.json] \
      [--stop-points 40] [--strategy S2] [--now "2026-10-20 10:35:00"]

Prints {"breakout_validation": {...}} — every check reported as pass/fail with its number.
Missing data yields UNKNOWN (never a fabricated pass): the agent cannot validate a
breakout it cannot measure.
"""
import argparse, datetime, json, os, sys

DEFAULT_THRESHOLDS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "..", "references", "breakout-thresholds.json")


# ---------------------------------------------------------------- helpers
def _num(x):
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x)
    try:
        return float(str(x).replace(",", "").strip())
    except Exception:
        return None


def _first(d, *keys):
    if not isinstance(d, dict):
        return None
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def chain_rows(snapshot):
    """(spot, rows) from the NSE option-chain record."""
    oc = (snapshot or {}).get("option_chain") or {}
    records = oc.get("records") if isinstance(oc, dict) else None
    if not isinstance(records, dict):
        return None, []
    spot = _num(_first(records, "underlyingValue", "underlying"))
    rows = records.get("data") or []
    return spot, [r for r in rows if isinstance(r, dict) and _num(r.get("strikePrice")) is not None]


def leg(row, side):
    if not isinstance(row, dict):
        return {}
    v = row.get(side)
    return v if isinstance(v, dict) else {}


def candles(snapshot, tf):
    """Bars for a timeframe: [{t,o,h,l,c,v}] — tolerant about the key names."""
    c = (snapshot or {}).get("candles_%s" % tf)
    if c is None:
        c = (snapshot or {}).get(tf)
    out = []
    for b in (c or []):
        if not isinstance(b, dict):
            continue
        o, h, l, cl = _num(_first(b, "o", "open")), _num(_first(b, "h", "high")), \
                          _num(_first(b, "l", "low")), _num(_first(b, "c", "close"))
        if None in (o, h, l, cl):
            continue
        out.append({"t": _first(b, "t", "time", "timestamp"), "o": o, "h": h, "l": l, "c": cl,
                    "v": _num(_first(b, "v", "volume")) or 0.0})
    out.sort(key=lambda b: (b["t"] is None, b["t"]))
    return out


def atr(bars, period=14):
    if len(bars) < period + 1:
        return None
    trs = []
    for i in range(len(bars) - period, len(bars)):
        b, p = bars[i], bars[i - 1]
        trs.append(max(b["h"] - b["l"], abs(b["h"] - p["c"]), abs(b["l"] - p["c"])))
    return sum(trs) / len(trs) if trs else None


def futures(snapshot):
    f = (snapshot or {}).get("futures")
    if isinstance(f, dict):
        return f
    return {}


def prev_snapshot(history_dir):
    """The most recent snapshot before the current one (by file name / mtime)."""
    if not history_dir or not os.path.isdir(history_dir):
        return None
    files = sorted((os.path.join(history_dir, f) for f in os.listdir(history_dir)
                    if f.endswith(".json")), key=os.path.getmtime)
    if len(files) < 2:
        return None
    try:
        with open(files[-2]) as fh:
            return json.load(fh)
    except Exception:
        return None


def heatmap_rows(snapshot):
    """[{symbol, pct}] from the normalized heatmap group or the raw NSE payload."""
    groups = (snapshot or {}).get("groups")
    hm = groups.get("heatmap") if isinstance(groups, dict) else None
    rows = []
    if isinstance(hm, dict):
        for key in ("stocks", "data", "constituents"):
            if isinstance(hm.get(key), list):
                rows = hm[key]
                break
    if not rows:
        raw = (snapshot or {}).get("heatmap_nifty50") or (snapshot or {}).get("heatmap_banknifty")
        if isinstance(raw, dict):
            rows = raw.get("data") or []
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        sym = str(_first(r, "symbol", "ticker", "name") or "").upper()
        pct = _num(_first(r, "pct_change", "changePct", "pChange", "changePercent", "change_pct", "pct"))
        if pct is None:
            last = _num(_first(r, "ltp", "lastPrice", "last"))
            prev = _num(_first(r, "prevClose", "previousClose"))
            if last is not None and prev:
                pct = (last - prev) / prev * 100.0
        if sym and pct is not None:
            out.append({"symbol": sym, "pct": pct})
    return out


def oi_at(rows, strike, side):
    best = None
    for r in rows:
        if abs(_num(r.get("strikePrice")) - strike) < 0.5:
            v = _num(_first(leg(r, side), "openInterest", "oi"))
            if v is not None:
                best = v
    return best


def oi_change_at(rows, strike, side):
    for r in rows:
        if abs(_num(r.get("strikePrice")) - strike) < 0.5:
            return _num(_first(leg(r, side), "changeinOpenInterest", "changeInOpenInterest", "oiChange"))
    return None


def premium_at(rows, strike, side):
    for r in rows:
        if abs(_num(r.get("strikePrice")) - strike) < 0.5:
            return _num(_first(leg(r, side), "lastPrice", "ltp", "price"))
    return None


def iv_at(rows, strike):
    for r in rows:
        if abs(_num(r.get("strikePrice")) - strike) < 0.5:
            return _num(_first(leg(r, "CE"), "impliedVolatility", "iv"))
    return None


def _hhmm(now_str, default):
    if not now_str:
        return default
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%H:%M"):
        try:
            dt = datetime.datetime.strptime(now_str, fmt)
            return dt.strftime("%H:%M")
        except Exception:
            continue
    return default


# ---------------------------------------------------------------- checks
def _check(passed, value, detail=""):
    return {"pass": bool(passed), "value": value, "detail": detail}


def validate(snapshot, level, direction, thresholds, history_dir=None, now_str=None,
             stop_points=None, strategy=None):
    thr = thresholds
    direction = (direction or "up").lower()
    up = direction == "up"
    spot, rows = chain_rows(snapshot)
    bars15 = candles(snapshot, "15m")
    bars5 = candles(snapshot, "5m")
    fut = futures(snapshot)
    prev = prev_snapshot(history_dir)
    prev_spot, prev_rows = chain_rows(prev) if prev else (None, [])
    now_hhmm = _hhmm(now_str, "10:30")

    checks = {"mandatory": {}, "supporting": {}}
    flags = []

    # ---- applicable?
    close_now = bars15[-1]["c"] if bars15 else None
    last_bar = bars15[-1] if bars15 else None
    breaking = close_now is not None and ((close_now > level) if up else (close_now < level))
    # the level is "in play" when the last bar traded through it (wick included) —
    # a wick through a level is exactly the fakeout case we must report
    touching = last_bar is not None and last_bar["l"] <= level <= last_bar["h"]
    strategies_needing = ("S2", "S4", "S6")
    if strategy and strategy.upper() in strategies_needing:
        applicable = True
    elif strategy and strategy.upper() in ("S1", "S5"):
        applicable = bool(breaking)
    else:
        applicable = bool(breaking or touching)
    if not applicable:
        return {"applicable": False, "level": level, "direction": direction,
                "mandatory": {}, "supporting": {}, "fakeout_flags": [],
                "verdict": "NOT_APPLICABLE",
                "note": "no breakout at this level for the chosen strategy"}

    # ---- a. close confirmation
    a_atr = atr(bars15) if bars15 else None
    buf_pct = thr["close_confirm_pct"] / 100.0
    need_pct = max(buf_pct, (thr["close_confirm_atr_mult"] * a_atr / level) if a_atr else 0.0)
    need = level * need_pct
    if close_now is None:
        checks["mandatory"]["close_confirm"] = {"pass": False, "value": "UNKNOWN",
                                                "detail": "no closed 15m candle in the snapshot"}
    else:
        dist = (close_now - level) if up else (level - close_now)
        ok = dist >= need and ((close_now > level) if up else (close_now < level))
        checks["mandatory"]["close_confirm"] = _check(
            ok, "close %.2f vs level %.2f (need %.2f = max(%.2f%%, %.2fx ATR))" % (
                close_now, level, need, thr["close_confirm_pct"], thr["close_confirm_atr_mult"]),
            "" if ok else "no close beyond the level (a wick is a fakeout)")

    # ---- b. volume
    vol = None
    vol_src = None
    if bars15:
        vol = bars15[-1]["v"] or None
        vol_src = "15m candle"
    if vol is None or vol <= 0:
        fv = _num(_first(fut, "volume", "futures_volume", "totalTradedVolume"))
        if fv is not None:
            vol, vol_src = fv, "futures volume (snapshot)"
    avg = None
    if vol_src == "15m candle" and len(bars15) >= 2:
        seq = [b["v"] for b in bars15[-thr["volume_avg_bars"] - 1:-1] if b["v"]]
        if seq:
            avg = sum(seq) / len(seq)
    if vol is None:
        checks["mandatory"]["volume"] = {"pass": False, "value": "UNKNOWN",
                                         "detail": "no volume in the snapshot (futures volume missing)"}
    else:
        if avg is None:
            checks["mandatory"]["volume"] = {"pass": False, "value": "%.0f (%s), avg UNKNOWN" % (vol, vol_src),
                                             "detail": "not enough candles for the %d-bar average" % thr["volume_avg_bars"]}
        else:
            ratio = vol / avg if avg else 0.0
            ok = ratio >= thr["volume_mult"]
            checks["mandatory"]["volume"] = _check(
                ok, "%.0f vs avg %.0f = %.2fx (need %.1fx, %s)" % (vol, avg, ratio, thr["volume_mult"], vol_src),
                "" if ok else "low-volume breakout")

    # ---- c. OI confirmation
    wall_side = "CE" if up else "PE"          # the wall being broken
    opp_side = "PE" if up else "CE"
    wall_oi_now = oi_at(rows, level, wall_side)
    wall_oi_prev = oi_at(prev_rows, level, wall_side) if prev_rows else None
    wall_chg = None
    if wall_oi_now is not None and wall_oi_prev is not None:
        wall_chg = wall_oi_now - wall_oi_prev
    fut_oi_now = _num(_first(fut, "oi", "openInterest", "futures_oi"))
    fut_oi_prev = None
    if prev:
        fut_oi_prev = _num(_first(futures(prev), "oi", "openInterest", "futures_oi"))
    fut_oi_chg = (fut_oi_now - fut_oi_prev) if (fut_oi_now is not None and fut_oi_prev is not None) else None
    # put OI at nearby lower strikes (up) / call OI at nearby higher strikes (down)
    near = [r for r in rows if ((_num(r.get("strikePrice")) < level) if up else (_num(r.get("strikePrice")) > level))]
    near = sorted(near, key=lambda r: abs(_num(r.get("strikePrice")) - level))[:3]
    near_side = "PE" if up else "CE"
    near_oi_now = sum(oi_at([r], r["strikePrice"], near_side) or 0 for r in near)
    near_oi_prev = 0.0
    for r in near:
        near_oi_prev += oi_at(prev_rows, r["strikePrice"], near_side) or 0 if prev_rows else 0
    near_chg = (near_oi_now - near_oi_prev) if prev_rows else None
    c_bits, c_pass = [], True
    if wall_chg is None:
        c_bits.append("wall OI change UNKNOWN (needs the previous snapshot)")
        c_pass = False
    else:
        falling = wall_chg < 0
        c_bits.append("%s OI %.0f → %.0f (%+.0f)%s" % (
            wall_side, wall_oi_prev, wall_oi_now, wall_chg, " falling" if falling else " RISING"))
        if not falling:
            c_pass = False
            flags.append("wall_oi_defended: %s OI at %.0f is still rising while price pushes through it" % (wall_side, level))
        elif fut_oi_chg is not None:
            c_bits.append("futures OI %+.0f%s" % (fut_oi_chg, " (rising)" if fut_oi_chg > 0 else " (falling)"))
            if fut_oi_chg <= 0:
                c_pass = False
        else:
            c_bits.append("futures OI change UNKNOWN")
    if near_chg is None:
        c_bits.append("nearby %s OI change UNKNOWN" % near_side)
        c_pass = False
    else:
        c_bits.append("nearby %s OI %+.0f" % (near_side, near_chg))
        if near_chg <= 0:
            c_pass = False
    checks["mandatory"]["oi_confirm"] = _check(c_pass, "; ".join(c_bits), "" if c_pass else "OI does not confirm the break")

    # ---- d. hold / retest
    d_pass, d_val = False, "UNKNOWN"
    if len(bars15) >= 2:
        closes = [b["c"] for b in bars15[-2:]]
        last2 = bars15[-1]
        broke = bars15[-2]
        if (broke["c"] > level) if up else (broke["c"] < level):
            inside = (last2["c"] < level) if up else (last2["c"] > level)
            d_pass = not inside
            d_val = "retest close %.2f (level %.2f) %s" % (
                last2["c"], level, "held beyond" if d_pass else "closed back inside")
        else:
            d_val = "no prior break candle to retest"
    checks["supporting"]["hold_retest"] = _check(d_pass, d_val)

    # ---- e. candle quality
    e_pass, e_val = False, "UNKNOWN"
    exhaustion = False
    if bars15:
        b = bars15[-1]
        rng = b["h"] - b["l"]
        body = abs(b["c"] - b["o"])
        if rng > 0:
            body_pct = body / rng
            pos = (b["c"] - b["l"]) / rng
            good_pos = pos >= (1 - thr["close_position_min"]) if up else pos <= thr["close_position_min"]
            e_pass = body_pct >= thr["body_pct_min"] and good_pos
            e_val = "body %.0f%% of range, close at %.0f%% of range" % (body_pct * 100, pos * 100)
            if a_atr and (b["h"] - b["l"]) > thr["exhaustion_atr_mult"] * a_atr:
                exhaustion = True
                e_val += " | range %.0f > %.1fx ATR — exhaustion, do not chase" % (
                    b["h"] - b["l"], thr["exhaustion_atr_mult"])
    checks["supporting"]["candle_quality"] = _check(e_pass, e_val)

    # ---- f. room
    stop_pts = stop_points if stop_points else (a_atr if a_atr else level * 0.01)
    if up:
        opp_rows = [r for r in rows if _num(r.get("strikePrice")) > level]
    else:
        opp_rows = [r for r in rows if _num(r.get("strikePrice")) < level]
    next_level = None
    if opp_rows:
        best = max(opp_rows, key=lambda r: oi_at([r], r["strikePrice"], opp_side) or 0)
        next_level = _num(best.get("strikePrice"))
    if next_level is None:
        checks["supporting"]["room"] = {"pass": False, "value": "UNKNOWN",
                                        "detail": "no opposing level in the chain"}
    else:
        dist = (next_level - level) if up else (level - next_level)
        need = thr["room_stop_mult"] * stop_pts
        checks["supporting"]["room"] = _check(dist >= need, "next level %.2f, distance %.2f (need %.2f = %.1fx stop %.2f)" % (
            next_level, dist, need, thr["room_stop_mult"], stop_pts))

    # ---- g. HTF + breadth alignment
    hm = heatmap_rows(snapshot)
    weights = thr["heavyweights"].get(str(snapshot.get("symbol", "")).upper(), [])
    g_bits, g_pass = [], True
    if len(bars15) >= 6:
        older = bars15[-6]["c"]
        htf_agrees = (bars15[-1]["c"] > older) if up else (bars15[-1]["c"] < older)
        g_bits.append("15m trend %s" % ("agrees" if htf_agrees else "DIVERGES"))
        if not htf_agrees:
            g_pass = False
    else:
        g_bits.append("15m trend UNKNOWN")
        g_pass = False
    if weights and hm:
        idx = {r["symbol"]: r["pct"] for r in hm}
        seen = [w for w in weights if w in idx]
        if seen:
            aligned = sum(1 for w in seen if ((idx[w] > 0) if up else (idx[w] < 0)))
            share = aligned / len(seen)
            g_bits.append("heavyweights %d/%d (%.0f%%) in direction" % (aligned, len(seen), share * 100))
            if share < thr["htf_breadth_min"]:
                g_pass = False
        else:
            g_bits.append("heavyweight %s not in the heatmap" % ",".join(weights))
            g_pass = False
    else:
        g_bits.append("heatmap heavyweights UNKNOWN")
        g_pass = False
    checks["supporting"]["htf_breadth"] = _check(g_pass, "; ".join(g_bits))

    # ---- h. premium response
    prem_now = premium_at(rows, level, "CE" if up else "PE")
    prem_prev = premium_at(prev_rows, level, "CE" if up else "PE") if prev_rows else None
    iv_now = iv_at(rows, level)
    iv_prev = iv_at(prev_rows, level) if prev_rows else None
    h_bits, h_pass = [], True
    if prem_now is None or prem_prev is None:
        h_bits.append("premium change UNKNOWN")
        h_pass = False
    else:
        rising = prem_now > prem_prev
        h_bits.append("%s premium %.2f → %.2f" % ("CE" if up else "PE", prem_prev, prem_now))
        if not rising:
            h_pass = False
    if iv_now is None or iv_prev is None:
        h_bits.append("ATM IV change UNKNOWN")
        h_pass = False
    else:
        iv_fall = (iv_prev - iv_now) / iv_prev * 100 if iv_prev else 0.0
        h_bits.append("IV %.2f → %.2f (%.1f%%)" % (iv_prev, iv_now, -iv_fall))
        if iv_fall > thr["iv_fall_max_pct"]:
            h_pass = False
    checks["supporting"]["premium_response"] = _check(h_pass, "; ".join(h_bits))

    # ---- fakeout red flags
    if len(bars15) >= 3:
        recent = bars15[-3:]
        inside = [b for b in recent if ((b["c"] < level) if up else (b["c"] > level))]
        if len(bars15) >= 2 and inside and breaking:
            flags.append("closed back inside the level within 2 candles")
    if bars15:
        b = bars15[-1]
        rng = b["h"] - b["l"]
        body = abs(b["c"] - b["o"])
        wick = (b["h"] - max(b["c"], b["o"])) if up else (min(b["c"], b["o"]) - b["l"])
        if rng > 0 and wick >= thr["reversal_wick_body_mult"] * max(body, 0.01) and \
                ((b["l"] <= level <= b["h"]) if up else (b["l"] <= level <= b["h"])):
            flags.append("rejection wick %.2f >= %.1fx the body at the level" % (wick, thr["reversal_wick_body_mult"]))
    if fut_oi_chg is not None and fut_oi_chg < 0:
        flags.append("index broke but futures OI is falling (%.0f)" % fut_oi_chg)
    if now_hhmm < thr["session_open"] and (strategy or "").upper() != "S4":
        flags.append("break before %s IST" % thr["session_open"])
    if now_hhmm >= "15:10":
        flags.append("break in the last %d minutes of the session" % thr["last_minutes_no_entry"])
    if history_dir and os.path.isdir(history_dir):
        pokes = 0
        for fn in sorted(os.listdir(history_dir)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(history_dir, fn)) as fh:
                    s2 = json.load(fh)
            except Exception:
                continue
            sp2, _ = chain_rows(s2)
            if sp2 is None:
                continue
            if ((sp2 <= level) if up else (sp2 >= level)):
                pokes += 1
        if pokes >= thr["pokes_max"]:
            flags.append("level poked %d times in the last %d minutes with no close beyond it" % (
                pokes, thr["pokes_window_min"]))

    # ---- verdict
    mand = checks["mandatory"]
    supp = checks["supporting"]
    mand_pass = all(c.get("pass") for c in mand.values()) if mand else False
    total_pass = sum(1 for c in list(mand.values()) + list(supp.values()) if c.get("pass"))
    total_n = len(mand) + len(supp)
    if not mand_pass or flags:
        verdict = "FAKEOUT"
    elif exhaustion:
        verdict = "WAIT_FOR_RETEST"
    elif total_pass >= thr["min_total_passes"]:
        verdict = "VALID_BREAKOUT"
    else:
        verdict = "WAIT_FOR_RETEST"

    return {
        "applicable": True,
        "level": level,
        "direction": direction,
        "mandatory": mand,
        "supporting": supp,
        "fakeout_flags": flags,
        "verdict": verdict,
        "checks_passed": "%d/%d" % (total_pass, total_n),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("snapshot")
    ap.add_argument("--level", type=float, default=None)
    ap.add_argument("--direction", default="up", choices=["up", "down"])
    ap.add_argument("--history", default=None)
    ap.add_argument("--thresholds", default=DEFAULT_THRESHOLDS)
    ap.add_argument("--stop-points", type=float, default=None)
    ap.add_argument("--strategy", default=None)
    ap.add_argument("--now", default=None)
    a = ap.parse_args(argv)

    if a.level is None:
        print("ERROR: --level is required (the validated level to break)", file=sys.stderr)
        return 2
    with open(a.snapshot) as fh:
        snapshot = json.load(fh)
    try:
        with open(a.thresholds) as fh:
            thresholds = json.load(fh)
    except Exception:
        thresholds = json.loads(json.dumps(DEFAULT_THRESHOLDS))

    out = validate(snapshot, a.level, a.direction, thresholds, history_dir=a.history,
                   now_str=a.now, stop_points=a.stop_points, strategy=a.strategy)
    print(json.dumps({"breakout_validation": out}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
