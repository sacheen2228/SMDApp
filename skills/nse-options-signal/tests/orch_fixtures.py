#!/usr/bin/env python3
"""Deterministic offline fixtures for the orchestrator (agents A-E) tests.

No network, no randomness.  The chain shape mirrors the NSE option-chain
payload the skill already consumes (scripts/levels.py, scripts/breakout.py):
a 50-point strike ladder, an OI bell around spot plus one OI wall per side.
"""
import datetime as dt
import json
import math
import os

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NOW = dt.datetime(2026, 10, 20, 11, 0, 0, tzinfo=IST)
EXPIRY = "2026-10-27"
SPOT = 25060.0
SUPPORT = 25000.0     # max put OI strike below spot
RESISTANCE = 25300.0  # max call OI strike above spot
SYMBOL = "NIFTY"
STEP = 50
IV = 13.0
WALL_OI = 8_000_000


def _leg(oi, ltp, iv, chg, vol):
    return {"openInterest": oi, "changeinOpenInterest": chg, "lastPrice": ltp,
            "totalTradedVolume": vol, "impliedVolatility": iv,
            "bidprice": round(ltp - 1.0, 2), "askPrice": round(ltp + 1.0, 2)}


def _oi_base(strike, spot):
    """A bell of open interest around spot (real chains peak at the ATM)."""
    return 800_000 + 2_500_000 * math.exp(-((strike - spot) / 500.0) ** 2)


def chain_rows(spot=SPOT, support=SUPPORT, resistance=RESISTANCE, put_scale=1.0, call_scale=1.0):
    rows = []
    straddle = 0.8 * spot * (IV / 100.0) * (7 / 365.0) ** 0.5
    for strike in range(24400, 25701, STEP):
        distance = strike - spot
        ce_oi = int((_oi_base(strike, spot) + (WALL_OI if strike == resistance else 0)) * call_scale)
        pe_oi = int((_oi_base(strike, spot) + (WALL_OI if strike == support else 0)) * put_scale)
        # a call is worth more when its strike is lower (and a put the opposite)
        ce_ltp = max(2.0, straddle / 2 - 0.5 * distance)
        pe_ltp = max(2.0, straddle / 2 + 0.5 * distance)
        rows.append({
            "strikePrice": strike,
            "expiryDate": EXPIRY,
            "CE": _leg(ce_oi, round(ce_ltp, 2), IV,
                       250_000 if strike <= resistance else -50_000,
                       5000 if strike in (25000, 25300) else 2500),
            "PE": _leg(pe_oi, round(pe_ltp, 2), IV + 1.0,
                       400_000 if strike >= support else -30_000,
                       4800 if strike in (25000, 25050) else 2500),
        })
    return rows


def candle_path():
    """30 closed 15-minute bars: a dip onto the support, then a break above it.

    Bar 8 makes the swing low 24997 (within 0.15% of the 25000 put wall),
    bar 18 makes the swing high 25050 (a strike in the chain) and bar 27 closes
    beyond it -> a confirmed BOS UP two bars ago.
    """
    return [25130, 25110, 25090, 25070, 25050, 25030, 25015, 25008, 25005, 25012,
            25025, 25040, 25050, 25045, 25035, 25025, 25030, 25038, 25042, 25040,
            25035, 25030, 25035, 25042, 25035, 25040, 25045, 25060, 25060, 25090]


def bars(closes=None, volumes=None, start=None):
    closes = closes if closes is not None else candle_path()
    volumes = volumes or [100000] * len(closes)
    start = start or (NOW - dt.timedelta(minutes=15 * len(closes)))
    out = []
    for i, c in enumerate(closes):
        o = closes[i - 1] if i else c
        out.append({"t": (start + dt.timedelta(minutes=15 * i)).isoformat(),
                    "o": o, "h": max(o, c) + 8, "l": min(o, c) - 8, "c": c, "v": volumes[i]})
    return out


def make_snapshot(ts=None, spot=SPOT, rows=None, closes=None, volumes=None,
                  vix=14.2, put_scale=1.0, call_scale=1.0, symbol=SYMBOL,
                  futures_volume=1_000_000, futures_oi=500_000, with_candles=True):
    ts = ts or NOW
    closes = closes if closes is not None else candle_path()
    snap = {
        "symbol": symbol,
        "fetched_at_ist": ts.strftime("%Y-%m-%d %H:%M:%S"),
        "option_chain": {"records": {
            "expiryDates": [EXPIRY, "2026-11-03"],
            "underlyingValue": spot,
            "data": rows if rows is not None else chain_rows(spot=spot, put_scale=put_scale,
                                                            call_scale=call_scale),
            "timestamp": ts.strftime("%d-%b-%Y %H:%M:%S"),
        }},
        "all_indices": {"data": [{"index": "NIFTY 50", "last": spot},
                                 {"index": "INDIA VIX", "last": vix}]},
        "futures": {"volume": futures_volume, "oi": futures_oi},
        "candles_5m": [],
    }
    if with_candles:
        vols = list(volumes) if volumes else [100000] * len(closes)
        vols[-1] = 180000          # the break bar carries 1.8x the baseline volume
        snap["candles_15m"] = bars(closes, vols, start=ts - dt.timedelta(minutes=15 * len(closes)))
    return snap


def make_history(count=4, step_minutes=15, **kw):
    """count snapshots, oldest first: put OI rising (PCR up), call OI falling,
    futures OI and volume rising (the breakout validator compares them)."""
    out = []
    for i in range(count):
        ts = NOW - dt.timedelta(minutes=step_minutes * (count - 1 - i))
        out.append(make_snapshot(ts=ts, put_scale=1.0 + 0.02 * i, call_scale=1.0 - 0.01 * i,
                                 futures_oi=480_000 + 10_000 * i,
                                 futures_volume=900_000 + 50_000 * i, **kw))
    return out


def write_history(directory, snapshots):
    os.makedirs(directory, exist_ok=True)
    for i, s in enumerate(snapshots):
        path = os.path.join(directory, "snap_%02d.json" % i)
        with open(path, "w") as fh:
            json.dump(s, fh)
        # distinct mtimes: breakout.py picks the previous snapshot by mtime
        os.utime(path, (1_700_000_000 + i * 60, 1_700_000_000 + i * 60))
    return directory


def context(bias="TWO_WAY", generated_at=None, bull=0, bear=0, usable=6):
    generated_at = generated_at or (NOW - dt.timedelta(minutes=30))
    return {
        "generated_at": generated_at.isoformat(),
        "expected_data_date": (NOW - dt.timedelta(days=1)).date().isoformat(),
        "pre_market_bias": bias,
        "bull_count": bull,
        "bear_count": bear,
        "usable_inputs": usable,
        "inputs": [
            {"name": "FII cash net", "score": 1, "value": "+1450 Cr", "note": "net buyer",
             "data_date": None, "stale": False},
            {"name": "PCR (prev close)", "score": 1, "value": "PCR 1.18", "note": "more puts written",
             "data_date": None, "stale": False},
            {"name": "Advance/Decline (Nifty 50)", "score": 0, "value": "A/D 2.5",
             "note": "strong advance", "data_date": None, "stale": False},
        ],
        "agent_rules": {"min_confluence_of_6": 4,
                        "counter_bias_trade": "allowed only with A+ setup and half size"},
        "sectors": {"Nifty Bank": {"pct": 0.8}},
    }


def write_context(path, **kw):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(context(**kw), fh)
    return path


def write_equity(path, equity=500000, as_of=None, source="ICICI Breeze getFunds (test fixture)"):
    as_of = as_of or NOW
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as fh:
        json.dump({"equity": equity, "source": source, "as_of": as_of.isoformat()}, fh)
    return path
