#!/usr/bin/env python3
"""GEX exit monitor - the invalidation close watcher for GEX trades.

The GEX rule: once a GEX trade is on, a 15-minute CLOSE back through the
underlying invalidation means "exit at market".  This module never places an
order (the skill has no sending logic); it raises an OPERATIONAL ALERT that
the production path can act on.

Two rules it must never break:
  * it never claims a close it cannot verify - without a closed 15-minute
    candle the exit stays UNCONFIRMED and an operational alert says so
  * it never re-alerts the same exit (idempotent per trade_id)

Usage:
    python3 gex_exit_monitor.py --records data/gex_trades.jsonl \
        --snapshot snapshot.json [--out data/gex_alerts.jsonl] [--state data/gex_exit_state.json]
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gex_snapshot  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
MAX_SNAPSHOT_AGE_MIN = 15.0


def load_records(path):
    """The GEX records (the engine's JSONL out file), oldest first."""
    out = []
    if not path or not os.path.exists(path):
        return out
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def open_gex_trades(records, now):
    """GEX trades that are still open (a trade, not older than the session)."""
    out = []
    for rec in records:
        if rec.get("action") not in ("BUY_CE", "BUY_PE"):
            continue
        trade = rec.get("trade") or {}
        if not trade.get("underlying_invalidation"):
            continue
        ts = gex_snapshot.parse_ts(rec.get("timestamp"))
        if ts is None:
            continue
        age_min = (now - ts).total_seconds() / 60.0
        if age_min < 0 or age_min > 6 * 60:      # a GEX trade lives one session
            continue
        out.append(rec)
    return out


def check_exit(record, snapshot, now):
    """The exit state of one GEX trade. Never invents a close."""
    trade = record.get("trade") or {}
    invalidation = float(trade.get("underlying_invalidation"))
    action = record.get("action")
    base = {"engine": "GEX", "trade_id": record.get("trade_id"), "symbol": record.get("symbol"),
            "action": action, "underlying_invalidation": invalidation,
            "channel": "GEX", "target_chat_id_env": "GEX_TELEGRAM_CHAT_ID",
            "checked_at": now.isoformat()}

    ts = gex_snapshot.parse_ts(record.get("timestamp"))
    if ts is None:
        base.update(status="UNCONFIRMED", severity="operational",
                    message="GEX trade %s has no timestamp - the exit cannot be confirmed" % record.get("trade_id"))
        return base

    snap_ts = gex_snapshot.parse_ts(((snapshot or {}).get("option_chain") or {}).get("records", {}).get("timestamp"))
    if snap_ts is None:
        snap_ts = gex_snapshot.parse_ts((snapshot or {}).get("fetched_at_ist"))
    if snap_ts is None:
        base.update(status="UNCONFIRMED", severity="operational",
                    message="no snapshot timestamp - the exit cannot be confirmed")
        return base
    age = (now - snap_ts).total_seconds() / 60.0
    if age > MAX_SNAPSHOT_AGE_MIN:
        base.update(status="UNCONFIRMED", severity="operational",
                    message="snapshot is %.0f min old - the exit cannot be confirmed" % age,
                    snapshot_age_minutes=round(age, 1))
        return base

    bars = gex_snapshot.closed_bars(gex_snapshot.bars(snapshot, "15m"), now, 15)
    if not bars:
        base.update(status="UNCONFIRMED", severity="operational",
                    message="no closed 15-minute candle - the exit cannot be confirmed")
        return base
    last = bars[-1]
    closed_through = (last["c"] < invalidation) if action == "BUY_CE" else (last["c"] > invalidation)
    base.update(candle={"t": last["t"], "close": last["c"]},
                invalidation=invalidation)
    if closed_through:
        base.update(status="EXIT", severity="operational",
                    message="15-minute close %.2f is back through the invalidation %.2f - EXIT AT MARKET (the "
                            "skill never places orders; the production path must act)" % (last["c"], invalidation))
    else:
        base.update(status="HOLD", severity="info",
                    message="15-minute close %.2f has not closed back through %.2f" % (last["c"], invalidation))
    return base


def load_state(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def run(records, snapshot, now, state=None):
    """Check every open GEX trade. Returns (alerts, new_state)."""
    state = dict(state or {})
    alerts = []
    for rec in open_gex_trades(records, now):
        alert = check_exit(rec, snapshot, now)
        tid = rec.get("trade_id")
        if alert.get("status") == "EXIT":
            if state.get(tid) == "EXIT":
                continue                      # already alerted - never alert twice
            state[tid] = "EXIT"
        elif alert.get("status") == "UNCONFIRMED":
            if state.get(tid) == "UNCONFIRMED":
                continue
            state[tid] = "UNCONFIRMED"
        else:
            state.pop(tid, None)
        alerts.append(alert)
    return alerts, state


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", required=True)
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--state", default=None)
    ap.add_argument("--now", default=None)
    a = ap.parse_args(argv)
    now = gex_snapshot.parse_ts(a.now) if a.now else datetime.now(IST)
    with open(a.snapshot) as fh:
        snapshot = json.load(fh)
    records = load_records(a.records)
    state_path = a.state or os.path.join(os.path.dirname(a.records) or ".", "gex_exit_state.json")
    alerts, new_state = run(records, snapshot, now, load_state(state_path))
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "a") as fh:
            for alert in alerts:
                fh.write(json.dumps(alert) + "\n")
    with open(state_path, "w") as fh:
        json.dump(new_state, fh, indent=1)
    for alert in alerts:
        print("%s %s %s" % (alert.get("status"), alert.get("trade_id"), alert.get("message")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
