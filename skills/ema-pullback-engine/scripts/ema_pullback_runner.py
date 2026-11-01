#!/usr/bin/env python3
"""JSON adapter for ema_pullback_engine.py.

Reads a JSON payload on stdin and writes the engine result as JSON on stdout:

    stdin  = {"candles": [{"datetime": "2026-10-26 09:15:00", "open": ..,
                            "high": .., "low": .., "close": .., "volume": ..},
                           ...],
              "vix": 17.15,                 # optional
              "call_wall": 23000,           # optional
              "put_wall": 22500,            # optional
              "delta": [..],                # optional, one value per candle
              "config": {"min_score": 70}}  # optional Config overrides

    stdout = {"ok": true, "signals": [...], "last_bar": {...},
              "bars": 300, "first": "...", "last": "...", "config": {...}}

The `datetime` values must be IST wall-clock (naive) so the engine's time
filter and the 5m→15m resample line up with the exchange clock.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pandas as pd  # noqa: E402

from ema_pullback_engine import Config, asdict, diagnose, scan  # noqa: E402

BASE_COLS = ["open", "high", "low", "close", "volume"]


def build_frame(payload: dict) -> pd.DataFrame:
    rows = payload.get("candles") or []
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["datetime"] = pd.to_datetime(df["datetime"])
    df = df.set_index("datetime").sort_index()
    for col in BASE_COLS:
        if col not in df.columns:
            df[col] = 0.0
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0)
    for col in ("open", "high", "low", "close"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Optional columns — only attached when the caller KNOWS them at bar close.
    vix = payload.get("vix")
    if vix is not None:
        df["vix"] = float(vix)
    call_wall = payload.get("call_wall")
    if call_wall is not None:
        df["call_wall"] = float(call_wall)
    put_wall = payload.get("put_wall")
    if put_wall is not None:
        df["put_wall"] = float(put_wall)
    delta = payload.get("delta")
    if isinstance(delta, list) and len(delta) == len(df):
        df["delta"] = pd.to_numeric(pd.Series(delta, index=df.index), errors="coerce")
    return df


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"bad payload: {exc}"}))
        return

    df = build_frame(payload)
    if df.empty or len(df) < 70:
        print(json.dumps({
            "ok": False,
            "error": f"need at least 70 closed 5m bars, got {len(df)}",
        }))
        return

    cfg = Config()
    for key, value in (payload.get("config") or {}).items():
        if hasattr(cfg, key):
            setattr(cfg, key, value)

    try:
        signals = scan(df, cfg)
        last_bar = diagnose(df, cfg)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"engine error: {exc}"}))
        return

    print(json.dumps({
        "ok": True,
        "signals": signals,
        "last_bar": last_bar,
        "bars": int(len(df)),
        "first": str(df.index[0]),
        "last": str(df.index[-1]),
        "config": asdict(cfg),
    }, default=str))


if __name__ == "__main__":
    main()
