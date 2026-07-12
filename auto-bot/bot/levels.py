"""
Rule 1 — Significant Levels:
Support/resistance must be drawn on the DAILY chart and must have been
tested and respected at least THREE times.

Approach:
1. Find swing pivots (local highs / local lows) on daily candles.
2. Cluster pivots that sit within 0.5 * ATR(14) of each other -> a "level".
3. A level is only valid if it has 3+ pivot touches.
"""
import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import List


@dataclass
class Level:
    price: float
    kind: str          # "resistance" or "support"
    touches: int


def _atr(df: pd.DataFrame, period: int = 14) -> float:
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    atr = tr.rolling(period).mean().iloc[-1]
    return float(atr) if not np.isnan(atr) else float(tr.mean())


def _find_swing_pivots(df: pd.DataFrame, lookback: int = 3):
    """Local max/min over a `lookback`-bar window on each side."""
    highs, lows = [], []
    h, l = df["High"].values, df["Low"].values
    n = len(df)
    for i in range(lookback, n - lookback):
        window_h = h[i - lookback:i + lookback + 1]
        window_l = l[i - lookback:i + lookback + 1]
        if h[i] == window_h.max():
            highs.append(h[i])
        if l[i] == window_l.min():
            lows.append(l[i])
    return highs, lows


def _cluster_levels(prices: List[float], atr: float, kind: str, min_touches: int = 3) -> List[Level]:
    """Group nearby pivot prices within 0.5*ATR and keep clusters with 3+ touches."""
    if not prices:
        return []
    tol = 0.5 * atr
    prices_sorted = sorted(prices)
    clusters: List[List[float]] = []
    current = [prices_sorted[0]]

    for p in prices_sorted[1:]:
        if abs(p - np.mean(current)) <= tol:
            current.append(p)
        else:
            clusters.append(current)
            current = [p]
    clusters.append(current)

    levels = []
    for c in clusters:
        if len(c) >= min_touches:
            levels.append(Level(price=round(float(np.mean(c)), 4), kind=kind, touches=len(c)))
    return levels


def find_daily_levels(daily_df: pd.DataFrame, min_touches: int = 3) -> List[Level]:
    """
    Rule 1 entry point. `daily_df` must be a daily OHLCV DataFrame
    (index = date, columns = Open/High/Low/Close/Volume), at least ~90 bars.
    Returns resistance + support levels that have 3+ respected touches.
    """
    if daily_df is None or len(daily_df) < 30:
        return []

    atr = _atr(daily_df)
    if atr <= 0:
        return []

    swing_highs, swing_lows = _find_swing_pivots(daily_df)

    resistance = _cluster_levels(swing_highs, atr, "resistance", min_touches)
    support = _cluster_levels(swing_lows, atr, "support", min_touches)

    return resistance + support


def nearest_resistance_above(levels: List[Level], price: float) -> Level | None:
    """Closest valid resistance level currently above price (candidate to break out through)."""
    candidates = [lv for lv in levels if lv.kind == "resistance" and lv.price > price]
    if not candidates:
        return None
    return min(candidates, key=lambda lv: lv.price - price)
