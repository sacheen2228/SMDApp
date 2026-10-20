#!/usr/bin/env python3
"""
Market structure detector: swings, BOS, CHoCH, liquidity sweeps. CLOSED candles only.

Definitions (starting values, tune per instrument):
- Swing high/low: candle whose high/low is the extreme of `n` candles on each side.
  Confirmed only `n` candles after it forms (no repainting).
- BOS  : candle CLOSE beyond the last swing in the direction of the current trend.
- CHoCH: first CLOSE beyond the last opposite swing, against the current trend.
- Sweep: wick beyond a swing but the CLOSE stays back inside (liquidity grab, not a break).
- Each swing level can be broken once.

Usage:
    from structure import analyze
    out = analyze(candles_15m, n=2)      # candles: [{"t","o","h","l","c","v"}, ...] oldest -> newest
    snapshot["structure"] = {"15m": out}
"""


def find_swings(c, n=2):
    """Return list of (confirm_index, swing_index, 'H'|'L', price)."""
    sw = []
    for i in range(n, len(c) - n):
        hi, lo = c[i]["h"], c[i]["l"]
        if all(hi > c[i - k]["h"] for k in range(1, n + 1)) and all(hi >= c[i + k]["h"] for k in range(1, n + 1)):
            sw.append((i + n, i, "H", hi))
        if all(lo < c[i - k]["l"] for k in range(1, n + 1)) and all(lo <= c[i + k]["l"] for k in range(1, n + 1)):
            sw.append((i + n, i, "L", lo))
    sw.sort(key=lambda x: x[0])
    return sw


def analyze(c, n=2, max_events=8, min_break_pct=0.0003):
    if len(c) < 2 * n + 3:
        return {"trend": "UNKNOWN", "events": [], "last_swing_high": None, "last_swing_low": None,
                "last_event": None, "note": "not enough candles"}
    swings = find_swings(c, n)
    si = 0
    last_h = last_l = None          # {"price","idx"} not yet broken
    trend = "UNKNOWN"
    events = []
    for i in range(len(c)):
        while si < len(swings) and swings[si][0] <= i:   # swing becomes known at confirm index
            _, idx, kind, price = swings[si]
            if kind == "H": last_h = {"price": price, "idx": idx}
            else: last_l = {"price": price, "idx": idx}
            si += 1
        cl, hi, lo = c[i]["c"], c[i]["h"], c[i]["l"]
        if last_h:
            lvl = last_h["price"]
            if cl > lvl * (1 + min_break_pct):
                kind = "CHOCH" if trend == "DOWN" else "BOS"
                events.append({"type": kind, "direction": "UP", "level": lvl, "index": i, "t": c[i]["t"],
                               "close": cl, "swing_t": c[last_h["idx"]]["t"]})
                trend, last_h = "UP", None
            elif hi > lvl and cl <= lvl:
                events.append({"type": "SWEEP", "direction": "UP", "level": lvl, "index": i, "t": c[i]["t"],
                               "close": cl, "swing_t": c[last_h["idx"]]["t"]})
                last_h["swept"] = True
        if last_l:
            lvl = last_l["price"]
            if cl < lvl * (1 - min_break_pct):
                kind = "CHOCH" if trend == "UP" else "BOS"
                events.append({"type": kind, "direction": "DOWN", "level": lvl, "index": i, "t": c[i]["t"],
                               "close": cl, "swing_t": c[last_l["idx"]]["t"]})
                trend, last_l = "DOWN", None
            elif lo < lvl and cl >= lvl:
                events.append({"type": "SWEEP", "direction": "DOWN", "level": lvl, "index": i, "t": c[i]["t"],
                               "close": cl, "swing_t": c[last_l["idx"]]["t"]})
                last_l["swept"] = True
    # de-duplicate repeated sweeps of the same level
    seen, uniq = set(), []
    for e in events:
        key = (e["type"], e["direction"], e["level"])
        if key in seen and e["type"] == "SWEEP": continue
        seen.add(key); uniq.append(e)
    last = uniq[-1] if uniq else None
    bars_since = (len(c) - 1 - last["index"]) if last else None
    return {
        "trend": trend,
        "last_swing_high": last_h["price"] if last_h else None,
        "last_swing_low": last_l["price"] if last_l else None,
        "last_event": ({k: last[k] for k in ("type", "direction", "level", "t")} | {"bars_ago": bars_since}) if last else None,
        "events": [{k: e[k] for k in ("type", "direction", "level", "t", "close")} for e in uniq[-max_events:]],
    }


def confirms(structure, direction, max_bars_ago=3):
    """Helper for strategies: True if a recent BOS in `direction` ('UP'/'DOWN') exists and no opposite CHoCH after it."""
    e = structure.get("last_event")
    return bool(e and e["type"] == "BOS" and e["direction"] == direction and e["bars_ago"] <= max_bars_ago)
