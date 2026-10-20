#!/usr/bin/env python3
"""Agent C - market structure + breakout / fakeout validation.

Structure comes from the skill's scripts/structure.py (swings, BOS, CHoCH,
sweeps - closed candles only).  Breakout / fakeout validation comes from the
skill's EXISTING scripts/breakout.py (close confirmation, OI confirmation,
fakeout red flags, verdict) - it is not re-implemented here.

Mandatory vetoes:
  STRUCTURE_INSUFFICIENT_CANDLES, STRUCTURE_UNKNOWN, STRUCTURE_NO_EVENT,
  STRUCTURE_SWEEP_ONLY, STRUCTURE_OPPOSING_CHOCH, STRUCTURE_SWEEP_AGAINST,
  BREAKOUT_NOT_APPLICABLE, BREAKOUT_FAKEOUT, BREAKOUT_FAKE_OUT_FLAG,
  BREAKOUT_MANDATORY_FAILED, BREAKOUT_VOLUME_UNMEASURABLE

Volume note: the NSE index chart carries NO volume, so breakout.py falls back
to the snapshot's index-futures volume - but a single snapshot has no 20-bar
baseline.  When the candles have no volume, Agent C measures the ratio itself
from the REAL futures volume in the snapshot history (cumulative volume delta
per interval vs the average interval delta).  A ratio that cannot be measured
is UNKNOWN and can never pass.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents import protocol, snapshots  # noqa: E402

import breakout as breakout_mod  # noqa: E402
import structure  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
THRESHOLDS_PATH = os.path.join(os.path.dirname(os.path.dirname(HERE)), "references", "breakout-thresholds.json")
MIN_BARS = 6
MAX_EVENT_BARS_AGO = 3


DEFAULT_THRESHOLDS = {
    "close_confirm_pct": 0.1, "close_confirm_atr_mult": 0.25, "volume_mult": 1.5,
    "volume_avg_bars": 20, "body_pct_min": 0.6, "close_position_min": 0.25,
    "exhaustion_atr_mult": 2.0, "room_stop_mult": 2.0, "retest_buffer_atr_mult": 0.5,
    "htf_breadth_min": 0.6, "iv_fall_max_pct": 5.0, "pokes_max": 3,
    "pokes_window_min": 60, "reversal_wick_body_mult": 2.0, "session_open": "09:30",
    "session_close": "15:30", "last_minutes_no_entry": 20, "pre_open_minutes": 15,
    "heavyweights": {}, "min_supporting_passes": 2, "min_total_passes": 5,
}


def _thresholds():
    try:
        with open(THRESHOLDS_PATH) as fh:
            return json.load(fh)
    except Exception:
        return dict(DEFAULT_THRESHOLDS)


def _futures_volume(snapshot):
    fut = (snapshot or {}).get("futures")
    if not isinstance(fut, dict):
        return None
    for key in ("volume", "totalTradedVolume", "futures_volume"):
        v = fut.get(key)
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            continue
    return None


def measure_volume(snapshot, history, bars, thresholds):
    """Real volume ratio + its source. None when it cannot be measured."""
    if bars and bars[-1].get("v"):
        seq = [b["v"] for b in bars[-thresholds["volume_avg_bars"] - 1:-1] if b.get("v")]
        if seq:
            avg = sum(seq) / len(seq)
            if avg > 0:
                return {"value": bars[-1]["v"], "avg": avg, "ratio": bars[-1]["v"] / avg,
                        "source": "15m candle"}
    cur = _futures_volume(snapshot)
    if cur is None:
        return None
    points = []
    for ts, s in history:
        v = _futures_volume(s)
        if v is not None:
            points.append((ts, v))
    if cur is not None:
        points.append((None, cur))
    points.sort(key=lambda x: (x[0] is None, x[0]))
    if len(points) < 3:
        return None
    deltas = []
    for i in range(1, len(points)):
        d = points[i][1] - points[i - 1][1]
        if d > 0:
            deltas.append(d)
    if len(deltas) < 2:
        return None
    latest = deltas[-1]
    avg = sum(deltas) / len(deltas)
    if avg <= 0:
        return None
    return {"value": latest, "avg": avg, "ratio": latest / avg,
            "source": "index futures volume delta (snapshot history)"}


def _verdict(validation, thresholds, volume_measured, flags=None):
    """Re-derive the verdict with the measured volume (breakout.py is not modified)."""
    mand = dict(validation.get("mandatory") or {})
    supp = dict(validation.get("supporting") or {})
    flags = list(validation.get("fakeout_flags") or []) if flags is None else list(flags)
    if "volume" in mand:
        if volume_measured is None:
            mand["volume"] = {"pass": False, "value": "UNKNOWN",
                              "detail": "no measurable volume baseline"}
        else:
            mand["volume"] = {
                "pass": volume_measured["ratio"] >= thresholds["volume_mult"],
                "value": "%.2fx vs avg %.0f (need %.1fx, %s)" % (
                    volume_measured["ratio"], volume_measured["avg"],
                    thresholds["volume_mult"], volume_measured["source"]),
                "detail": ""}
    mand_pass = all(c.get("pass") for c in mand.values()) if mand else False
    total_pass = sum(1 for c in list(mand.values()) + list(supp.values()) if c.get("pass"))
    total_n = len(mand) + len(supp)
    exhaustion = False
    if validation.get("supporting", {}).get("candle_quality", {}).get("pass") is False:
        exhaustion = "exhaustion" in str(validation["supporting"]["candle_quality"].get("value", ""))
    if not mand_pass or flags:
        return "FAKEOUT", mand, supp, flags, total_pass, total_n
    if exhaustion:
        return "WAIT_FOR_RETEST", mand, supp, flags, total_pass, total_n
    if total_pass >= thresholds["min_total_passes"]:
        return "VALID_BREAKOUT", mand, supp, flags, total_pass, total_n
    return "WAIT_FOR_RETEST", mand, supp, flags, total_pass, total_n


def _verified_pokes(history, level, up, now, window_min=60):
    """Count the snapshots that actually TESTED the level without closing beyond it.

    breakout.py counts every snapshot on the wrong side of the level, which is a
    false positive for a level the price just broke through from below.  The
    flag only survives when the real poke count reaches the threshold.
    """
    count = 0
    for ts, s in history:
        age = (now - ts).total_seconds() / 60.0
        if age <= 0 or age > window_min:
            continue
        bars = snapshots.closed_bars(s, now, "15m")
        if not bars:
            continue
        b = bars[-1]
        touched = (b["h"] >= level) if up else (b["l"] <= level)
        beyond = (b["c"] > level) if up else (b["c"] < level)
        if touched and not beyond:
            count += 1
    return count


def run(task):
    now = snapshots.gex_snapshot.parse_ts(task.get("now")) or datetime.now(IST)
    snapshot = snapshots.load_snapshot(task)
    history = snapshots.load_history(task, now)
    thresholds = _thresholds()
    vetoes, checks, notes = [], {}, []

    bars = snapshots.closed_bars(snapshot, now, "15m")
    checks["candles"] = protocol.check(len(bars) >= MIN_BARS, "%d closed 15m bars" % len(bars),
                                       ">= %d" % MIN_BARS)
    if len(bars) < MIN_BARS:
        vetoes.append(protocol.veto("STRUCTURE_INSUFFICIENT_CANDLES", "%d closed 15m bars" % len(bars),
                                    ">= %d" % MIN_BARS))
        return protocol.result("C", vetoes=vetoes, checks=checks, notes=notes)

    st = structure.analyze(bars)
    checks["structure_trend"] = protocol.check(st.get("trend") != "UNKNOWN", st.get("trend"),
                                               "a resolved structure trend")
    if st.get("trend") == "UNKNOWN":
        vetoes.append(protocol.veto("STRUCTURE_UNKNOWN", "trend UNKNOWN", "a resolved structure trend"))
        return protocol.result("C", vetoes=vetoes, checks=checks, notes=notes)

    last = st.get("last_event")
    if not last:
        vetoes.append(protocol.veto("STRUCTURE_NO_EVENT", "no BOS/CHoCH/sweep event",
                                    "a structure event"))
        return protocol.result("C", vetoes=vetoes, checks=checks, notes=notes)

    bars_ago = last.get("bars_ago")
    if bars_ago is not None and bars_ago > MAX_EVENT_BARS_AGO:
        vetoes.append(protocol.veto("STRUCTURE_STALE_EVENT", "%s %s %d bars ago" % (
            last.get("type"), last.get("direction"), bars_ago),
            "an event within %d bars" % MAX_EVENT_BARS_AGO))
        return protocol.result("C", vetoes=vetoes, checks=checks, notes=notes)

    if last.get("type") == "SWEEP":
        vetoes.append(protocol.veto("STRUCTURE_SWEEP_ONLY", "sweep %s at %.2f" % (
            last.get("direction"), last.get("level")),
            "a close beyond a level (a sweep is not a break)"))
        return protocol.result("C", vetoes=vetoes, checks=checks, notes=notes)

    direction = "CE" if last.get("direction") == "UP" else "PE"
    level = float(last.get("level"))
    checks["structure_event"] = protocol.check(True, "%s %s at %.2f (%d bars ago)" % (
        last.get("type"), last.get("direction"), level, bars_ago if bars_ago is not None else -1),
        "a recent BOS/CHoCH")

    # -- an opposing CHoCH (a flip against the trade direction) is a veto
    for ev in st.get("events") or []:
        if ev.get("type") == "CHOCH" and ev.get("direction") != last.get("direction"):
            vetoes.append(protocol.veto("STRUCTURE_OPPOSING_CHOCH", "CHoCH %s at %.2f" % (
                ev.get("direction"), ev.get("level")), "no opposing CHoCH"))
            break
    # -- a sweep on the opposite side kills the setup
    for ev in st.get("events") or []:
        if ev.get("type") == "SWEEP" and ev.get("direction") != last.get("direction"):
            vetoes.append(protocol.veto("STRUCTURE_SWEEP_AGAINST", "sweep %s at %.2f" % (
                ev.get("direction"), ev.get("level")), "no opposing liquidity sweep"))
            break

    # -- breakout / fakeout validation (the skill's existing validator)
    closed_snapshot = dict(snapshot)
    closed_snapshot["candles_15m"] = bars
    validation = breakout_mod.validate(
        closed_snapshot, level, "up" if direction == "CE" else "down", thresholds,
        history_dir=task.get("history_dir") or task.get("history_path"),
        now_str=now.strftime("%Y-%m-%d %H:%M:%S"),
        stop_points=task.get("stop_points"), strategy=task.get("strategy"))
    volume = measure_volume(snapshot, history, bars, thresholds)

    # -- re-verify the "poked N times" red flag against the real level touches
    pokes = _verified_pokes(history, level, direction == "CE", now,
                             window_min=int(thresholds.get("pokes_window_min", 60)))
    kept_flags = []
    for f in (validation.get("fakeout_flags") or []):
        if "poked" in f and pokes < thresholds.get("pokes_max", 3):
            notes.append("breakout.py pokes flag not confirmed: %d real level touches in %d min" % (
                pokes, int(thresholds.get("pokes_window_min", 60))))
            continue
        kept_flags.append(f)
    flags = kept_flags
    verdict, mand, supp, flags, passed, total = _verdict(validation, thresholds, volume, flags)

    checks["breakout_applicable"] = protocol.check(
        validation.get("applicable") is not False, validation.get("verdict", "n/a"),
        "an applicable breakout check")
    if validation.get("applicable") is False:
        vetoes.append(protocol.veto("BREAKOUT_NOT_APPLICABLE", validation.get("note", "not applicable"),
                                    "a breakout at the structure level"))
    else:
        for name, c in mand.items():
            checks["mandatory_%s" % name] = protocol.check(
                bool(c.get("pass")), c.get("value", ""), "pass")
            if not c.get("pass"):
                vetoes.append(protocol.veto("BREAKOUT_MANDATORY_FAILED", "%s: %s" % (name, c.get("value")),
                                            "the %s check must pass" % name))
        for f in flags:
            vetoes.append(protocol.veto("BREAKOUT_FAKE_OUT_FLAG", f, "no fakeout red flag"))
        if verdict == "FAKEOUT":
            vetoes.append(protocol.veto("BREAKOUT_FAKEOUT", verdict, "VALID_BREAKOUT"))
        elif verdict == "WAIT_FOR_RETEST":
            vetoes.append(protocol.veto("BREAKOUT_NOT_CONFIRMED", "%s (%d/%d checks)" % (
                verdict, passed, total), "VALID_BREAKOUT"))
        if volume is None:
            vetoes.append(protocol.veto("BREAKOUT_VOLUME_UNMEASURABLE", "no volume baseline",
                                        "a measurable volume ratio"))

    data = {
        "structure": {"trend": st.get("trend"), "last_event": last,
                      "last_swing_high": st.get("last_swing_high"),
                      "last_swing_low": st.get("last_swing_low"),
                      "events": st.get("events")},
        "breakout": {"verdict": verdict, "level": level, "direction": "up" if direction == "CE" else "down",
                     "mandatory": mand, "supporting": supp, "fakeout_flags": flags,
                     "checks_passed": "%d/%d" % (passed, total)},
        "volume": volume,
    }
    return protocol.result("C", direction=direction, vetoes=vetoes, checks=checks, data=data, notes=notes)


if __name__ == "__main__":
    protocol.main_wrapper("C", run)
