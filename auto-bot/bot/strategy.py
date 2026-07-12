"""
Rules 2, 3, 4 of the Breakout Strategy (long only):

Rule 2 — 1-Hour Confirmation:
  A FULL 1-hour candle must CLOSE beyond the daily level. The candle's LOW
  must also be above the level (a wick poking through and closing back
  under does not count — no wicks allowed through the level).

Rule 3 — Volume Confirmation:
  The breakout candle's volume must be >= 1.5x its 20-bar average volume
  (computed on the 1H series). Below that, it's a "drift", not a breakout.

Rule 4 — Defined Exit:
  stop-loss = just beyond the broken level (small buffer below it)
  target    = entry + at least 2x the risk (2:1 reward:risk minimum)

Sizing: 1% account risk per trade, capped at 10% of account value in
notional exposure.
"""
import pandas as pd
from dataclasses import dataclass
from typing import Optional
from bot.levels import Level

VOLUME_MULTIPLIER = 1.5       # Rule 3
VOLUME_LOOKBACK = 20          # bars for average volume
STOP_BUFFER_PCT = 0.001       # 0.1% buffer past the level for the stop
REWARD_RISK_RATIO = 2.0       # Rule 4 minimum
RISK_PCT_PER_TRADE = 0.01     # 1% of account equity risked per trade
MAX_POSITION_PCT = 0.10       # 10% of account equity cap


@dataclass
class BreakoutSignal:
    ticker: str
    market: str
    level: float
    stop_loss: float
    target: float
    volume_ratio: float
    touches: int
    qty: int


def check_breakout(hourly_df: pd.DataFrame, level: Level) -> Optional[dict]:
    """
    Applies Rule 2 + Rule 3 to the most recently CLOSED 1H candle against a
    single resistance level. Returns breakout details dict or None.

    hourly_df: 1H OHLCV DataFrame, index ascending by time. The LAST row
    must be a fully closed candle (caller is responsible for not passing
    an in-progress bar).
    """
    if hourly_df is None or len(hourly_df) < VOLUME_LOOKBACK + 1:
        return None
    if level.kind != "resistance":
        return None

    candle = hourly_df.iloc[-1]
    prev_candle = hourly_df.iloc[-2]

    # Rule 2: previous candle was still below/at the level, current candle's
    # full body AND low closed/sit above the level (no wick-only breaks).
    broke_out = (
        prev_candle["Close"] <= level.price and
        candle["Close"] > level.price and
        candle["Low"] > level.price * (1 - 0.0005)  # low essentially clear of the level
    )
    if not broke_out:
        return None

    # Rule 3: volume >= 1.5x the 20-bar average (excluding current bar)
    avg_volume = hourly_df["Volume"].iloc[-(VOLUME_LOOKBACK + 1):-1].mean()
    if avg_volume <= 0:
        return None
    volume_ratio = candle["Volume"] / avg_volume
    if volume_ratio < VOLUME_MULTIPLIER:
        return None

    return {
        "close": float(candle["Close"]),
        "level": float(level.price),
        "touches": level.touches,
        "volume_ratio": round(float(volume_ratio), 2),
    }


def build_signal(ticker: str, market: str, breakout: dict, account_value: float) -> BreakoutSignal:
    """Rule 4: defined stop/target, plus 1% risk / 10% cap position sizing."""
    level = breakout["level"]
    entry = breakout["close"]

    stop_loss = round(level * (1 - STOP_BUFFER_PCT), 4)  # just beyond the broken level
    risk_per_share = entry - stop_loss
    if risk_per_share <= 0:
        risk_per_share = entry * STOP_BUFFER_PCT  # safety fallback

    target = round(entry + REWARD_RISK_RATIO * risk_per_share, 4)  # >= 2:1 reward:risk

    # Position sizing
    risk_dollars = account_value * RISK_PCT_PER_TRADE
    qty_by_risk = int(risk_dollars / risk_per_share) if risk_per_share > 0 else 0

    max_notional = account_value * MAX_POSITION_PCT
    qty_by_cap = int(max_notional / entry) if entry > 0 else 0

    qty = max(0, min(qty_by_risk, qty_by_cap))

    return BreakoutSignal(
        ticker=ticker,
        market=market,
        level=level,
        stop_loss=stop_loss,
        target=target,
        volume_ratio=breakout["volume_ratio"],
        touches=breakout["touches"],
        qty=qty,
    )
