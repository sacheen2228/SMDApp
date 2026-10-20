#!/usr/bin/env python3
"""Snapshot / history helpers shared by the orchestrator's agents."""
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import gex_snapshot  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))


def load_snapshot(task, key="snapshot"):
    """The current snapshot: inline in the task or from snapshot_path."""
    if isinstance(task.get(key), dict):
        return task[key]
    path = task.get("%s_path" % key)
    if not path:
        raise ValueError("no snapshot in the task (need %r or %r_path)" % (key, key))
    with open(path) as fh:
        return json.load(fh)


def load_history(task, now=None, key="history"):
    """History snapshots as a list of (datetime, snapshot) - oldest first."""
    now = now or datetime.now(IST)
    out = []
    inline = task.get(key)
    if isinstance(inline, list):
        for s in inline:
            if not isinstance(s, dict):
                continue
            ts = chain_timestamp(s)
            if ts is not None:
                out.append((ts, s))
    else:
        path = task.get("%s_dir" % key) or task.get("%s_path" % key)
        if path and os.path.isdir(path):
            for f in sorted(glob.glob(os.path.join(path, "*.json"))):
                try:
                    with open(f) as fh:
                        s = json.load(fh)
                except Exception:
                    continue
                if not isinstance(s, dict):
                    continue
                ts = chain_timestamp(s)
                if ts is not None:
                    out.append((ts, s))
    out.sort(key=lambda x: x[0])
    return out


def chain_timestamp(snapshot):
    """The snapshot's data timestamp (chain first, then the fetch time)."""
    if not isinstance(snapshot, dict):
        return None
    rec = ((snapshot.get("option_chain") or {}).get("records") or {})
    ts = gex_snapshot.parse_ts(rec.get("timestamp"))
    if ts:
        return ts
    ts = gex_snapshot.parse_ts((snapshot.get("meta") or {}).get("fetched_at_ist"))
    if ts:
        return ts
    return gex_snapshot.parse_ts(snapshot.get("fetched_at_ist"))


def chain_rows(snapshot):
    rec = ((snapshot.get("option_chain") or {}).get("records") or {})
    rows = [r for r in (rec.get("data") or []) if isinstance(r, dict)]
    spot = rec.get("underlyingValue")
    try:
        spot = float(spot)
    except (TypeError, ValueError):
        spot = None
    return spot, rows


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def total_oi(snapshot):
    """(call_oi, put_oi) of the nearest expiry."""
    _, rows = chain_rows(snapshot)
    rec = ((snapshot.get("option_chain") or {}).get("records") or {})
    exp = (rec.get("expiryDates") or [None])[0]
    sel = [r for r in rows if exp is None or r.get("expiryDate") == exp] or rows
    c = sum(int(_num((r.get("CE") or {}).get("openInterest")) or 0) for r in sel)
    p = sum(int(_num((r.get("PE") or {}).get("openInterest")) or 0) for r in sel)
    return c, p


def pcr(snapshot):
    """Put OI / call OI (None when there is no call OI)."""
    c, p = total_oi(snapshot)
    if not c:
        return None
    return p / c


def live_spot(snapshot):
    """The live index spot from the snapshot (all_indices), None when unknown."""
    idx = (snapshot or {}).get("all_indices")
    rows = (idx or {}).get("data") if isinstance(idx, dict) else idx
    if not isinstance(rows, list):
        return None
    symbol = str((snapshot or {}).get("symbol") or "NIFTY").upper()
    wanted = {"NIFTY": ("NIFTY 50",), "BANKNIFTY": ("NIFTY BANK",), "FINNIFTY": ("NIFTY IT",),
              "MIDCPNIFTY": ("NIFTY MIDCAP 100",)}.get(symbol, (symbol,))
    for r in rows:
        if not isinstance(r, dict):
            continue
        name = str(r.get("index", "")).strip().upper()
        if name in wanted or name == symbol:
            v = _num(r.get("last"))
            if v:
                return v
    return None


def vix(snapshot):
    return gex_snapshot.vix_of(snapshot)


def closed_bars(snapshot, now, tf="15m"):
    tf_minutes = int(tf.rstrip("m"))
    return gex_snapshot.closed_bars(gex_snapshot.bars(snapshot, tf), now, tf_minutes)
