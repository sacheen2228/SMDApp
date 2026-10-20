#!/usr/bin/env python3
"""Agent B - chain / OI / PCR / level validation.

Mandatory vetoes (all of them are hard NO-TRADE gates):
  SNAPSHOT_TIMESTAMP_MISSING / _FUTURE / SNAPSHOT_STALE   (freshness, 15 min)
  LIVE_SPOT_UNAVAILABLE / SPOT_MISMATCH                   (chain vs live spot)
  FROZEN_FEED                                            (identical chain twice)
  LEVEL_TWO_SOURCE, WALL_RATIO, LEVEL_CLOSED_BEYOND, LEVEL_UNSTABLE
  PCR_HISTORY_INSUFFICIENT, PCR_TREND_NOT_ALIGNED

Level rules (references/agent-system-prompt.md step 3):
  * two independent sources within +-0.15% of the wall
  * wall OI >= 1.5x the next-strongest strike on the same side
  * no 15-minute close beyond the level
  * the wall strike has not migrated by more than one strike
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents import protocol, snapshots  # noqa: E402

import levels as levels_mod  # noqa: E402  (skill module: OI walls / max pain)
import structure  # noqa: E402  (skill module: swings / BOS / CHoCH / sweeps)

IST = timezone(timedelta(hours=5, minutes=30))

MAX_SNAPSHOT_AGE_MIN = 15.0
TWO_SOURCE_TOL_PCT = 0.15
WALL_RATIO_MIN = 1.5
SPOT_MISMATCH_MAX_PCT = 0.1
PCR_SNAPSHOTS = 3
STABILITY_WINDOW_MIN = 60.0


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _side_rows(rows, spot, side):
    """Strikes on one side of spot with the OI that matters there."""
    out = []
    for r in rows:
        k = _num(r.get("strikePrice"))
        if k is None:
            continue
        if side == "support" and k <= spot:
            oi = _num((r.get("PE") or {}).get("openInterest")) or 0
            out.append((k, oi))
        elif side == "resistance" and k >= spot:
            oi = _num((r.get("CE") or {}).get("openInterest")) or 0
            out.append((k, oi))
    return out


def _vwap(bars):
    num = den = 0.0
    for b in bars:
        v = b.get("v") or 0
        if not v:
            return None
        typical = (b["h"] + b["l"] + b["c"]) / 3.0
        num += typical * v
        den += v
    if den <= 0:
        return None
    return num / den


def _swing_levels(bars, side, limit=3):
    """Recent swing levels on one side (reuses the skill's structure module)."""
    if not bars:
        return []
    try:
        swings = structure.find_swings(bars, 2)
    except Exception:
        return []
    kind = "L" if side == "support" else "H"
    levels = [float(price) for _, _, k, price in swings if k == kind]
    return levels[-limit:]


def _candidate_sources(side, wall, bars, ohlc):
    srcs = [("oi_wall", float(wall))]
    for i, swing in enumerate(_swing_levels(bars, side)):
        srcs.append(("swing_%d" % (i + 1), swing))
    vw = _vwap(bars)
    if vw:
        srcs.append(("vwap", float(vw)))
    if isinstance(ohlc, dict):
        key = "pdl" if side == "support" else "pdh"
        if _num(ohlc.get(key)):
            srcs.append(("prior_day", float(ohlc[key])))
        h, l, c = _num(ohlc.get("pdh")), _num(ohlc.get("pdl")), _num(ohlc.get("pdc"))
        if h and l and c:
            srcs.append(("pivot", (h + l + c) / 3.0))
    return srcs


def _strike_step(rows):
    """The chain's strike interval (the "one strike" of the stability rule)."""
    strikes = sorted({_num(r.get("strikePrice")) for r in rows if _num(r.get("strikePrice"))})
    gaps = [b - a for a, b in zip(strikes, strikes[1:]) if b > a]
    return min(gaps) if gaps else 50.0


def _wall_of(lv, side):
    levels = (lv or {}).get("levels") or {}
    return levels.get("oi_support") if side == "support" else levels.get("oi_resistance")


def validate_side(side, snapshot, bars, lv, history, now, ohlc):
    """Validate one side. Returns (ok, vetoes, checks, info)."""
    vetoes, checks, info = [], {}, {}
    spot = _num(((snapshot.get("option_chain") or {}).get("records") or {}).get("underlyingValue"))
    _, rows = snapshots.chain_rows(snapshot)
    wall = _wall_of(lv, side)
    if not wall:
        vetoes.append(protocol.veto("LEVEL_MISSING", "no %s wall in the chain" % side,
                                    "an OI wall on the %s side" % side))
        return False, vetoes, checks, info
    wall = float(wall)
    info["level"] = wall

    # -- wall strength
    side_rows = _side_rows(rows, spot, side)
    side_rows.sort(key=lambda x: -x[1])
    if not side_rows:
        vetoes.append(protocol.veto("WALL_RATIO", "no %s strike in the chain" % side,
                                    "a %s strike with OI" % side))
        return False, vetoes, checks, info
    top_oi = side_rows[0][1]
    second_oi = side_rows[1][1] if len(side_rows) > 1 else 0.0
    ratio = (top_oi / second_oi) if second_oi > 0 else 99.0
    checks["wall_ratio"] = protocol.check(
        ratio >= WALL_RATIO_MIN, "%.2fx (%s OI %.0f vs next %.0f)" % (ratio, side, top_oi, second_oi),
        ">= %.1fx" % WALL_RATIO_MIN)
    if ratio < WALL_RATIO_MIN:
        vetoes.append(protocol.veto("WALL_RATIO", "%.2fx" % ratio, ">= %.1fx" % WALL_RATIO_MIN,
                                    "OI at %.0f is %.0f, next strongest is %.0f" % (wall, top_oi, second_oi)))

    # -- two independent sources within +-0.15%
    srcs = _candidate_sources(side, wall, bars, ohlc)
    agreeing = [(name, val) for name, val in srcs
                if abs(val - wall) / wall * 100.0 <= TWO_SOURCE_TOL_PCT]
    info["sources"] = [{"name": n, "value": round(v, 2),
                        "within_tolerance": (n, v) in agreeing} for n, v in srcs]
    checks["two_source"] = protocol.check(
        len(agreeing) >= 2, "%d sources within +-%.2f%% (%s)" % (
            len(agreeing), TWO_SOURCE_TOL_PCT,
            ", ".join("%s %.2f" % (n, v) for n, v in agreeing) or "none"),
        ">= 2 sources")
    if len(agreeing) < 2:
        vetoes.append(protocol.veto("LEVEL_TWO_SOURCE", "%d source(s) within +-%.2f%% of %.0f" % (
            len(agreeing), TWO_SOURCE_TOL_PCT, wall), ">= 2 independent sources",
            "candidates: %s" % ", ".join("%s %.2f" % (n, v) for n, v in srcs)))

    # -- no 15-minute close beyond the level
    broken = None
    for b in bars:
        if side == "support" and b["c"] < wall:
            broken = b
        elif side == "resistance" and b["c"] > wall:
            broken = b
    checks["not_closed_beyond"] = protocol.check(
        broken is None,
        ("close %.2f beyond %.2f at %s" % (broken["c"], wall, broken["t"])) if broken else "no close beyond %.2f" % wall,
        "no 15m close beyond the level")
    if broken is not None:
        vetoes.append(protocol.veto("LEVEL_CLOSED_BEYOND",
                                    "close %.2f beyond %.2f" % (broken["c"], wall),
                                    "no 15m close beyond the level",
                                    "a broken level is invalid"))

    # -- level stability over the last hour
    others = [(ts, s) for ts, s in history
              if timedelta(0) < (now - ts) <= timedelta(minutes=STABILITY_WINDOW_MIN)]
    if not others:
        checks["level_stability"] = protocol.check(False, "no history snapshot in the last %d min" %
                                                   STABILITY_WINDOW_MIN, "a history snapshot to compare")
        vetoes.append(protocol.veto("LEVEL_UNSTABLE", "no comparable history snapshot",
                                    "a history snapshot within %d min" % STABILITY_WINDOW_MIN))
    else:
        ts_old, snap_old = others[0]
        try:
            lv_old = levels_mod.build(snap_old, ohlc)
            wall_old = _wall_of(lv_old, side)
        except Exception:
            wall_old = None
        if wall_old is None:
            checks["level_stability"] = protocol.check(False, "no %s wall in the %d-min-old snapshot" % (
                side, round((now - ts_old).total_seconds() / 60)), "a comparable wall")
            vetoes.append(protocol.veto("LEVEL_UNSTABLE", "no comparable wall %d min ago" % round(
                (now - ts_old).total_seconds() / 60), "a comparable wall in the older snapshot"))
        else:
            step = _strike_step(rows)
            drift = abs(float(wall_old) - wall)
            checks["level_stability"] = protocol.check(
                drift <= step + 1e-9, "wall %.0f vs %.0f %d min ago (drift %.0f)" % (
                    wall, float(wall_old), round((now - ts_old).total_seconds() / 60), drift),
                "<= 1 strike")
            if drift > step:
                vetoes.append(protocol.veto("LEVEL_UNSTABLE", "wall moved %.0f points (%.0f -> %.0f)" % (
                    drift, float(wall_old), wall), "<= 1 strike", "a migrating wall is unstable"))
    return not vetoes, vetoes, checks, info


def _pcr_series(history, current, now, current_ts=None):
    series = []
    for ts, s in history:
        if current_ts is not None and ts >= current_ts:
            continue                      # the current snapshot is not history
        if timedelta(0) < (now - ts) <= timedelta(minutes=STABILITY_WINDOW_MIN):
            p = snapshots.pcr(s)
            if p is not None:
                series.append((ts, p))
    p_now = snapshots.pcr(current)
    if p_now is not None:
        series.append((now, p_now))
    series.sort(key=lambda x: x[0])
    return series[-PCR_SNAPSHOTS:]


def run(task):
    now = snapshots.gex_snapshot.parse_ts(task.get("now")) or datetime.now(IST)
    snapshot = snapshots.load_snapshot(task)
    history = snapshots.load_history(task, now)
    vetoes, checks, notes = [], {}, []

    # ---------------------------------------------------------------- freshness
    ts = snapshots.chain_timestamp(snapshot)
    if ts is None:
        checks["snapshot_freshness"] = protocol.check(False, "no timestamp", "a data timestamp")
        vetoes.append(protocol.veto("SNAPSHOT_TIMESTAMP_MISSING", "no data timestamp",
                                    "a parseable snapshot timestamp"))
    else:
        age = (now - ts).total_seconds() / 60.0
        if age < -1.0:
            checks["snapshot_freshness"] = protocol.check(False, "%.0f min in the future" % (-age),
                                                           "<= 0 min")
            vetoes.append(protocol.veto("SNAPSHOT_TIMESTAMP_FUTURE", "%.0f min in the future" % (-age),
                                        "a timestamp not in the future"))
        else:
            checks["snapshot_freshness"] = protocol.check(
                age <= MAX_SNAPSHOT_AGE_MIN, "%.1f min old" % age, "<= %.0f min" % MAX_SNAPSHOT_AGE_MIN)
            if age > MAX_SNAPSHOT_AGE_MIN:
                vetoes.append(protocol.veto("SNAPSHOT_STALE", "%.1f min old" % age,
                                            "<= %.0f min" % MAX_SNAPSHOT_AGE_MIN))

    chain_spot, rows = snapshots.chain_rows(snapshot)
    if not chain_spot or not rows:
        vetoes.append(protocol.veto("CHAIN_UNUSABLE", "no chain rows", "an option chain with rows"))
        return protocol.result("B", vetoes=vetoes, checks=checks, notes=notes)

    # ---------------------------------------------------------------- spot mismatch
    live = snapshots.live_spot(snapshot)
    if live is None:
        checks["spot_match"] = protocol.check(False, "live spot unavailable", "a live spot to compare")
        vetoes.append(protocol.veto("LIVE_SPOT_UNAVAILABLE", "no live spot in the snapshot",
                                    "a live index spot"))
    else:
        drift = abs(chain_spot - live) / live * 100.0
        checks["spot_match"] = protocol.check(
            drift <= SPOT_MISMATCH_MAX_PCT, "chain %.2f vs live %.2f (%.3f%%)" % (chain_spot, live, drift),
            "<= %.1f%%" % SPOT_MISMATCH_MAX_PCT)
        if drift > SPOT_MISMATCH_MAX_PCT:
            vetoes.append(protocol.veto("SPOT_MISMATCH", "chain %.2f vs live %.2f (%.3f%%)" % (
                chain_spot, live, drift), "<= %.1f%%" % SPOT_MISMATCH_MAX_PCT))

    # ---------------------------------------------------------------- frozen feed
    prev = [(t, s) for t, s in history
            if (now - t).total_seconds() > 0 and (ts is None or t < ts)]
    if prev:
        ts_prev, snap_prev = prev[-1]
        c_now, p_now = snapshots.total_oi(snapshot)
        c_prev, p_prev = snapshots.total_oi(snap_prev)
        spot_prev, _ = snapshots.chain_rows(snap_prev)
        frozen = (c_now == c_prev and p_now == p_prev and spot_prev == chain_spot)
        checks["frozen_feed"] = protocol.check(
            not frozen, "call OI %d / put OI %d vs previous %d / %d" % (c_now, p_now, c_prev, p_prev),
            "the chain must change between snapshots")
        if frozen:
            vetoes.append(protocol.veto("FROZEN_FEED", "identical OI and spot vs the %d-min-old snapshot" % (
                round((now - ts_prev).total_seconds() / 60)), "a changing chain"))
    else:
        checks["frozen_feed"] = protocol.check(False, "no previous snapshot", "a previous snapshot")

    # ---------------------------------------------------------------- levels
    bars = snapshots.closed_bars(snapshot, now, "15m")
    ohlc = task.get("ohlc") or snapshot.get("ohlc")
    try:
        lv = levels_mod.build(snapshot, ohlc)
    except Exception as exc:
        vetoes.append(protocol.veto("CHAIN_UNUSABLE", "levels could not be built: %s" % exc,
                                    "a buildable option chain"))
        return protocol.result("B", vetoes=vetoes, checks=checks, notes=notes)

    sides = {}
    for side in ("support", "resistance"):
        ok, sv, sc, info = validate_side(side, snapshot, bars, lv, history, now, ohlc)
        sides[side] = {"ok": ok, "vetoes": sv, "checks": sc, "info": info}
        checks["level_%s" % side] = sc
        checks["level_%s_ok" % side] = protocol.check(ok, "valid" if ok else "invalid",
                                                      "a valid %s level" % side)
    # ---------------------------------------------------------------- PCR trend
    series = _pcr_series(history, snapshot, now, current_ts=ts)
    pcr_values = [p for _, p in series]
    checks["pcr_history"] = protocol.check(
        len(pcr_values) >= PCR_SNAPSHOTS, "%d snapshots" % len(pcr_values), ">= %d snapshots" % PCR_SNAPSHOTS)
    if len(pcr_values) < PCR_SNAPSHOTS:
        vetoes.append(protocol.veto("PCR_HISTORY_INSUFFICIENT", "%d snapshots" % len(pcr_values),
                                    ">= %d snapshots" % PCR_SNAPSHOTS))
        pcr_ok = {"CE": False, "PE": False}
    else:
        rising = all(b >= a for a, b in zip(pcr_values, pcr_values[1:])) and pcr_values[-1] > pcr_values[0]
        falling = all(b <= a for a, b in zip(pcr_values, pcr_values[1:])) and pcr_values[-1] < pcr_values[0]
        pcr_ok = {"CE": rising, "PE": falling}
        checks["pcr_trend"] = protocol.check(
            rising or falling, " -> ".join("%.3f" % p for p in pcr_values),
            "a monotonic PCR trend in the trade direction")
        if not (rising or falling):
            vetoes.append(protocol.veto("PCR_TREND_NOT_ALIGNED", " -> ".join("%.3f" % p for p in pcr_values),
                                        "a monotonic PCR trend over %d snapshots" % PCR_SNAPSHOTS))

    # ---------------------------------------------------------------- direction
    # A side is usable only when it has NO veto of its own.  The vetoes of the
    # side that was NOT chosen are NOT global failures (a CE trade only needs
    # valid support; a broken resistance is normal).
    support_ok = sides["support"]["ok"] and pcr_ok.get("CE", False)
    resistance_ok = sides["resistance"]["ok"] and pcr_ok.get("PE", False)
    if support_ok and resistance_ok:
        direction = "NEUTRAL"
        notes.append("both sides validate - no directional edge")
    elif support_ok:
        direction = "CE"
    elif resistance_ok:
        direction = "PE"
    else:
        direction = "NEUTRAL"

    if direction == "CE":
        vetoes += sides["support"]["vetoes"]
        if not pcr_ok.get("CE", False):
            vetoes.append(protocol.veto("PCR_TREND_NOT_ALIGNED",
                                        " -> ".join("%.3f" % p for p in pcr_values),
                                        "a rising PCR over %d snapshots (CE)" % PCR_SNAPSHOTS))
    elif direction == "PE":
        vetoes += sides["resistance"]["vetoes"]
        if not pcr_ok.get("PE", False):
            vetoes.append(protocol.veto("PCR_TREND_NOT_ALIGNED",
                                        " -> ".join("%.3f" % p for p in pcr_values),
                                        "a falling PCR over %d snapshots (PE)" % PCR_SNAPSHOTS))
    else:
        # no side is usable: name every failed check so the NO TRADE is explicit
        vetoes += sides["support"]["vetoes"] + sides["resistance"]["vetoes"]
        if not pcr_ok.get("CE", False) and not pcr_ok.get("PE", False):
            vetoes.append(protocol.veto("PCR_TREND_NOT_ALIGNED",
                                        " -> ".join("%.3f" % p for p in pcr_values),
                                        "a monotonic PCR trend over %d snapshots" % PCR_SNAPSHOTS))

    data = {
        "spot": chain_spot,
        "live_spot": live,
        "levels": lv.get("levels"),
        "support": sides["support"]["info"],
        "resistance": sides["resistance"]["info"],
        "pcr_series": pcr_values,
        "pcr_ce_ok": pcr_ok.get("CE", False),
        "pcr_pe_ok": pcr_ok.get("PE", False),
        "history_snapshots": len(history),
    }
    return protocol.result("B", direction=direction, vetoes=vetoes, checks=checks, data=data, notes=notes)


if __name__ == "__main__":
    protocol.main_wrapper("B", run)
