#!/usr/bin/env python3
"""Adapter: the skill's NSE snapshot -> the GEX engine's canonical snapshot.

The GEX engine (scripts/gex_engine.py) has its own compact snapshot shape.
The skill's live snapshot (scripts/nse_fetch.py) carries the raw NSE option
chain. This module is the ONLY bridge between the two, so the GEX engine never
has to know about NSE payload shapes and the skill never re-implements gamma
math.

Also enforces the "closed candles only" rule: the newest 15-minute bar is
dropped while it is still forming (a forming bar repaints and must never feed
structure / breakout logic).

Usage:
    python3 gex_snapshot.py snapshot.json --now 2026-10-20T11:00:00+05:30 \
        --out gex_snapshot.json [--history-dir snapshot_history --gex-history-dir ...]
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import contract_master  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
           "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
NSE_TS_FORMATS = ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y",
                  "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")


def parse_ts(value, default_tz=IST):
    """Parse a timestamp into an aware datetime (IST). None when unparseable."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value) / 1000.0, default_tz)
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace(" ", "T"))
        return dt if dt.tzinfo else dt.replace(tzinfo=default_tz)
    except ValueError:
        pass
    for fmt in NSE_TS_FORMATS:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=default_tz)
        except ValueError:
            continue
    return None


def iso(dt):
    return dt.astimezone(IST).isoformat() if dt else None


def normalize_expiry(text):
    """'08-Oct-2026' / '2026-10-08' -> '2026-10-08'."""
    if not text:
        return None
    s = str(text).strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%B-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def chain_records(snapshot):
    """(spot, rows, expiry_dates, chain_timestamp) from the skill snapshot."""
    oc = (snapshot or {}).get("option_chain") or {}
    records = oc.get("records") if isinstance(oc, dict) else None
    if not isinstance(records, dict):
        return None, [], [], None
    spot = _num(records.get("underlyingValue"))
    rows = [r for r in (records.get("data") or []) if isinstance(r, dict)]
    expiries = records.get("expiryDates") or []
    return spot, rows, expiries, records.get("timestamp")


def vix_of(snapshot):
    """India VIX from the snapshot (all_indices). None when unknown."""
    idx = (snapshot or {}).get("all_indices")
    rows = (idx or {}).get("data") if isinstance(idx, dict) else idx
    if isinstance(rows, list):
        for r in rows:
            if isinstance(r, dict) and str(r.get("index", "")).strip().upper() in ("INDIA VIX", "INDIA VIX "):
                v = _num(r.get("last"))
                if v:
                    return v
    return None


def _leg(row, side):
    leg = row.get(side)
    return leg if isinstance(leg, dict) else {}


def _normalise_row(row):
    ce, pe = _leg(row, "CE"), _leg(row, "PE")
    strike = _num(row.get("strikePrice"))
    if strike is None:
        return None
    out = {"strike": strike}
    for side, leg in (("call", ce), ("put", pe)):
        out["%s_oi" % side] = int(_num(leg.get("openInterest")) or 0)
        out["%s_iv" % side] = _num(leg.get("impliedVolatility")) or 0.0
        out["%s_ltp" % side] = _num(leg.get("lastPrice")) or 0.0
        out["%s_bid" % side] = _num(leg.get("bidprice"))
        out["%s_ask" % side] = _num(leg.get("askPrice"))
        out["%s_volume" % side] = int(_num(leg.get("totalTradedVolume")) or 0)
    return out


def bars(snapshot, tf="15m"):
    """Bars of a timeframe as [{t,o,h,l,c,v}] (t = ISO string)."""
    src = (snapshot or {}).get("candles_%s" % tf) or (snapshot or {}).get(tf) or []
    out = []
    for b in src:
        if not isinstance(b, dict):
            continue
        o, h, l, c = (_num(b.get(k)) for k in ("o", "h", "l", "c"))
        if None in (o, h, l, c):
            continue
        out.append({"t": iso(parse_ts(b.get("t") if b.get("t") is not None else b.get("time"))),
                    "o": o, "h": h, "l": l, "c": c, "v": _num(b.get("v") if b.get("v") is not None
                                                             else b.get("volume")) or 0.0})
    out = [b for b in out if b["t"]]
    out.sort(key=lambda b: b["t"])
    return out


def closed_bars(bars_list, now, tf_minutes=15):
    """Drop the still-forming bar: a bar is closed once its bucket has ended."""
    out = []
    for b in bars_list:
        start = parse_ts(b["t"])
        if start is None:
            continue
        if start + timedelta(minutes=tf_minutes) > now:
            continue
        out.append(b)
    return out


def convert(snapshot, now=None, symbol=None, lot_size=None):
    """NSE snapshot -> GEX canonical snapshot. Returns (gex_snapshot, warnings)."""
    now = now or datetime.now(IST)
    warnings = []
    spot, rows, expiries, chain_ts = chain_records(snapshot)
    if not spot or spot <= 0:
        raise ValueError("snapshot has no usable underlying value")
    if not rows:
        raise ValueError("snapshot has no option-chain rows")

    symbol = symbol or (snapshot.get("symbol") or "UNKNOWN")
    ts = parse_ts(chain_ts) or parse_ts((snapshot.get("meta") or {}).get("fetched_at_ist")) \
        or parse_ts(snapshot.get("fetched_at_ist"))
    if ts is None:
        raise ValueError("snapshot has no parseable timestamp (freshness unprovable)")

    if lot_size is None:
        lot_size = contract_master.lot_size(symbol)
    if not lot_size:
        warnings.append("lot size unknown for %s - the contract master has no lot" % symbol)

    exp_dates = [d for d in (normalize_expiry(e) for e in expiries) if d]
    chain_by_expiry = {}
    for r in rows:
        exp = normalize_expiry(r.get("expiryDate"))
        n = _normalise_row(r)
        if not exp or not n:
            continue
        chain_by_expiry.setdefault(exp, []).append(n)
    if not exp_dates:
        exp_dates = sorted(chain_by_expiry.keys())
    exp_out = []
    for d in exp_dates:
        chain = chain_by_expiry.get(d) or []
        if not chain:
            continue
        exp_dt = datetime.fromisoformat(d + "T15:30:00").replace(tzinfo=IST)
        hours = (exp_dt - now).total_seconds() / 3600.0
        exp_out.append({"date": d, "days_to_expiry": round(max(hours, 0.0) / 24.0, 4),
                        "chain": sorted(chain, key=lambda x: x["strike"])})
    if not exp_out:
        raise ValueError("snapshot has no usable expiry with chain rows")

    gex = {
        "symbol": symbol,
        "timestamp": iso(ts),
        "spot": float(spot),
        "vix": vix_of(snapshot),
        "lot_size": int(lot_size or 0),
        "expiries": exp_out,
        "candles_15m": closed_bars(bars(snapshot, "15m"), now, 15),
    }
    return gex, warnings


def is_gex_snapshot(obj):
    """True when the object already is in the GEX engine's canonical shape."""
    if not isinstance(obj, dict):
        return False
    exp = obj.get("expiries")
    if not isinstance(exp, list) or not exp:
        return False
    chain = exp[0].get("chain")
    return isinstance(chain, list) and bool(chain) and "call_oi" in chain[0]


def convert_file(path, now=None, symbol=None, lot_size=None):
    with open(path) as fh:
        snap = json.load(fh)
    if is_gex_snapshot(snap):
        return snap, ["already in GEX format: %s" % path]
    return convert(snap, now=now, symbol=symbol, lot_size=lot_size)


def convert_dir(src_dir, dst_dir, now=None, exclude_ts=None):
    """Convert every NSE snapshot in src_dir into the GEX format in dst_dir.

    exclude_ts: an ISO timestamp to skip - the CURRENT snapshot must not be
    part of the history, otherwise the GEX engine sees it as a frozen feed.
    """
    os.makedirs(dst_dir, exist_ok=True)
    written, skipped = [], []
    for path in sorted(glob.glob(os.path.join(src_dir, "*.json"))):
        try:
            gex, _ = convert_file(path, now=now)
        except Exception as exc:
            skipped.append({"file": os.path.basename(path), "error": str(exc)})
            continue
        if exclude_ts and gex.get("timestamp") == exclude_ts:
            skipped.append({"file": os.path.basename(path), "error": "current snapshot - not history"})
            continue
        stamp = (gex.get("timestamp") or "").replace(":", "").replace("+", "_")
        out = os.path.join(dst_dir, "gex_%s.json" % stamp)
        with open(out, "w") as fh:
            json.dump(gex, fh)
        written.append(os.path.basename(out))
    return {"written": written, "skipped": skipped}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("snapshot")
    ap.add_argument("--out", default=None)
    ap.add_argument("--now", default=None)
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--lot-size", type=int, default=None)
    ap.add_argument("--history-dir", default=None)
    ap.add_argument("--gex-history-dir", default=None)
    a = ap.parse_args()
    now = parse_ts(a.now) if a.now else datetime.now(IST)
    gex, warns = convert_file(a.snapshot, now=now, symbol=a.symbol, lot_size=a.lot_size)
    for w in warns:
        print("WARN:", w, file=sys.stderr)
    if a.gex_history_dir and a.history_dir:
        res = convert_dir(a.history_dir, a.gex_history_dir, now=now)
        print(json.dumps(res))
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(gex, fh, indent=1)
        print("wrote", a.out)
    else:
        print(json.dumps(gex, indent=1))
