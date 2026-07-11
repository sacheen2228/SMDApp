"""
indicators.py
All indicator math. Every function here computes something real from
real data. Nothing in this file invents a number.
"""

import numpy as np
import pandas as pd
from scipy.stats import norm


# ---------------- Price-based ----------------

def compute_vwap(df: pd.DataFrame) -> pd.Series:
    """df needs columns: high, low, close, volume. Returns cumulative VWAP series."""
    typical_price = (df["high"] + df["low"] + df["close"]) / 3
    cum_vol = df["volume"].cumsum()
    cum_vol_price = (typical_price * df["volume"]).cumsum()
    return cum_vol_price / cum_vol.replace(0, np.nan)


def detect_trend(df: pd.DataFrame, fast: int = 9, slow: int = 21) -> str:
    """Simple EMA-crossover trend read. 'bullish' / 'bearish' / 'sideways'."""
    if len(df) < slow + 1:
        return "insufficient_data"
    ema_fast = df["close"].ewm(span=fast, adjust=False).mean()
    ema_slow = df["close"].ewm(span=slow, adjust=False).mean()
    if ema_fast.iloc[-1] > ema_slow.iloc[-1] and ema_fast.iloc[-2] <= ema_slow.iloc[-2]:
        return "bullish_cross"
    if ema_fast.iloc[-1] > ema_slow.iloc[-1]:
        return "bullish"
    if ema_fast.iloc[-1] < ema_slow.iloc[-1] and ema_fast.iloc[-2] >= ema_slow.iloc[-2]:
        return "bearish_cross"
    if ema_fast.iloc[-1] < ema_slow.iloc[-1]:
        return "bearish"
    return "sideways"


def detect_breakout(df: pd.DataFrame, lookback: int = 20, consolidation_pct: float = 0.4) -> dict:
    """
    Flags a breakout only if price was consolidating (tight range) over `lookback` bars
    and the latest close breaks outside that range with above-average volume.
    consolidation_pct = max allowed (high-low)/close range, in % over the lookback window,
    to call it "consolidation" rather than a trending move.
    """
    if len(df) < lookback + 2:
        return {"breakout": False, "reason": "insufficient_data"}

    window = df.iloc[-(lookback + 1):-1]  # exclude current bar
    range_pct = (window["high"].max() - window["low"].min()) / window["close"].iloc[-1] * 100
    was_consolidating = range_pct <= consolidation_pct * 100 / 10  # tight range check, tune per instrument

    latest = df.iloc[-1]
    avg_vol = window["volume"].mean()
    vol_surge = latest["volume"] > 1.5 * avg_vol if avg_vol > 0 else False

    broke_up = latest["close"] > window["high"].max()
    broke_down = latest["close"] < window["low"].min()

    return {
        "breakout": bool(was_consolidating and (broke_up or broke_down) and vol_surge),
        "direction": "up" if broke_up else ("down" if broke_down else "none"),
        "was_consolidating": bool(was_consolidating),
        "volume_surge": bool(vol_surge),
        "range_pct": round(range_pct, 3),
    }


def near_support_resistance(df: pd.DataFrame, current_price: float, lookback: int = 100,
                             proximity_pct: float = 0.3) -> dict:
    """Flags whether current price is within proximity_pct% of a recent swing high/low."""
    if len(df) < lookback:
        lookback = len(df)
    window = df.iloc[-lookback:]
    swing_high = window["high"].max()
    swing_low = window["low"].min()
    near_res = abs(current_price - swing_high) / current_price * 100 <= proximity_pct
    near_sup = abs(current_price - swing_low) / current_price * 100 <= proximity_pct
    return {"near_resistance": bool(near_res), "near_support": bool(near_sup),
            "swing_high": swing_high, "swing_low": swing_low}


# ---------------- Options / OI based ----------------

def compute_pcr(chain_df: pd.DataFrame, oi_col: str = "open_interest", right_col: str = "right") -> float:
    """Put-Call Ratio by OI. right_col values expected 'call'/'put' — adjust to Breeze's actual labels."""
    calls = chain_df[chain_df[right_col].str.lower() == "call"][oi_col].sum()
    puts = chain_df[chain_df[right_col].str.lower() == "put"][oi_col].sum()
    return round(puts / calls, 3) if calls else float("nan")


def compute_max_pain(chain_df: pd.DataFrame, strike_col: str = "strike_price",
                      oi_col: str = "open_interest", right_col: str = "right") -> float:
    """Classic max-pain calc: strike where total option-writer payout is minimized."""
    strikes = sorted(chain_df[strike_col].unique())
    pain = {}
    for s in strikes:
        total_loss = 0
        for _, row in chain_df.iterrows():
            k = row[strike_col]
            oi = row[oi_col]
            if row[right_col].lower() == "call" and s > k:
                total_loss += (s - k) * oi
            elif row[right_col].lower() == "put" and s < k:
                total_loss += (k - s) * oi
        pain[s] = total_loss
    return min(pain, key=pain.get)


def oi_change_signal(chain_now: pd.DataFrame, chain_prev: pd.DataFrame,
                      strike: float, right: str,
                      strike_col: str = "strike_price", oi_col: str = "open_interest",
                      right_col: str = "right") -> dict:
    """
    Compares OI at a specific strike between two chain snapshots to infer
    writer covering vs fresh writing. You must supply chain_prev yourself
    (e.g. chain from N minutes ago, stored by your polling loop).
    """
    def _get_oi(df):
        row = df[(df[strike_col] == strike) & (df[right_col].str.lower() == right.lower())]
        return float(row[oi_col].iloc[0]) if not row.empty else np.nan

    oi_now, oi_prev = _get_oi(chain_now), _get_oi(chain_prev)
    if np.isnan(oi_now) or np.isnan(oi_prev):
        return {"signal": "no_data"}
    delta = oi_now - oi_prev
    if delta < 0:
        return {"signal": "writer_covering", "delta_oi": delta}
    elif delta > 0:
        return {"signal": "fresh_writing", "delta_oi": delta}
    return {"signal": "flat", "delta_oi": 0}


# ---------------- Greeks (Black-Scholes) ----------------

def black_scholes_greeks(spot: float, strike: float, days_to_expiry: float,
                          iv: float, rate: float = 0.065, option_type: str = "call") -> dict:
    """
    iv as decimal (e.g. 0.18 for 18%). days_to_expiry in calendar days.
    Returns delta, gamma, theta (per day), vega (per 1% IV move).
    """
    if days_to_expiry <= 0 or iv <= 0:
        return {"delta": None, "gamma": None, "theta": None, "vega": None}

    T = days_to_expiry / 365
    d1 = (np.log(spot / strike) + (rate + 0.5 * iv ** 2) * T) / (iv * np.sqrt(T))
    d2 = d1 - iv * np.sqrt(T)

    gamma = norm.pdf(d1) / (spot * iv * np.sqrt(T))
    vega = spot * norm.pdf(d1) * np.sqrt(T) / 100  # per 1% IV

    if option_type.lower() == "call":
        delta = norm.cdf(d1)
        theta = (-(spot * norm.pdf(d1) * iv) / (2 * np.sqrt(T))
                 - rate * strike * np.exp(-rate * T) * norm.cdf(d2)) / 365
    else:
        delta = norm.cdf(d1) - 1
        theta = (-(spot * norm.pdf(d1) * iv) / (2 * np.sqrt(T))
                 + rate * strike * np.exp(-rate * T) * norm.cdf(-d2)) / 365

    return {"delta": round(delta, 4), "gamma": round(gamma, 5),
            "theta": round(theta, 4), "vega": round(vega, 4)}


def iv_expanding(iv_series: pd.Series, lookback: int = 5) -> bool:
    """True if IV has been rising over the last `lookback` readings."""
    if len(iv_series) < lookback + 1:
        return False
    return iv_series.iloc[-1] > iv_series.iloc[-lookback]


def volume_delta(df: pd.DataFrame) -> pd.Series:
    """
    Approximation of buy vs sell volume using close vs open of each bar
    (tick-level bid/ask data isn't available from Breeze historical endpoint;
    this is a proxy, not true volume delta — treat it as directional pressure only).
    """
    direction = np.where(df["close"] > df["open"], 1, np.where(df["close"] < df["open"], -1, 0))
    return pd.Series(direction * df["volume"], index=df.index).cumsum()
