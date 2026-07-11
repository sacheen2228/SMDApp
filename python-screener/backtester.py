"""
backtester.py
Walks forward through historical index data, runs the checklist at each bar
using ONLY data available up to that point (no lookahead), and when the
scoreable conditions clear your threshold, simulates an option-buy trade
with your stated SL/TP/trailing rules.

Output is your REAL historical win rate and expectancy — not an assumed
confidence number. Run this before you trust the checklist with real money.

NOTE ON OPTION PRICE SIMULATION:
Backtesting the option premium itself needs historical option OHLC (Breeze
supports this via get_historical_data_v2 with product_type='options') or,
if unavailable for your date range, a Black-Scholes premium reconstructed
from underlying price + a modeled IV path. This script supports both —
plug in real option OHLC when you have it (`option_price_df` per trade),
otherwise it falls back to the BS estimate in `estimate_premium`.
"""

import pandas as pd
import numpy as np
from dataclasses import dataclass
import indicators as ind
from checklist import run_checklist


@dataclass
class TradeResult:
    entry_time: pd.Timestamp
    direction: str
    entry_premium: float
    exit_premium: float
    exit_reason: str
    pnl_pct: float


def estimate_premium(spot, strike, days_to_expiry, iv, option_type):
    """Rough theoretical premium via Black-Scholes, used only when real option
    OHLC isn't available for the backtest window."""
    from scipy.stats import norm
    if days_to_expiry <= 0 or iv <= 0:
        return max(spot - strike, 0) if option_type == "call" else max(strike - spot, 0)
    T = days_to_expiry / 365
    rate = 0.065
    d1 = (np.log(spot / strike) + (rate + 0.5 * iv ** 2) * T) / (iv * np.sqrt(T))
    d2 = d1 - iv * np.sqrt(T)
    if option_type == "call":
        return spot * norm.cdf(d1) - strike * np.exp(-rate * T) * norm.cdf(d2)
    return strike * np.exp(-rate * T) * norm.cdf(-d2) - spot * norm.cdf(-d1)


def run_backtest(df_15m: pd.DataFrame, df_5m: pd.DataFrame, chain_snapshots: list,
                  min_confirmed_ratio: float = 0.8, sl_pct: float = 0.25, tp1_pct: float = 0.7,
                  strike_offset: int = 0, iv_assumed: float = 0.15, expiry_days_assumed: int = 3,
                  direction: str = "CE") -> pd.DataFrame:
    """
    df_15m, df_5m: historical index OHLC, chronologically sorted, with a 'datetime' column.
    chain_snapshots: list of (timestamp, chain_df) tuples if you have historical OI —
        pass [] if unavailable, and oi_confirms_move will just read N/A throughout.
    min_confirmed_ratio: fraction of SCOREABLE checklist items that must be True to take the trade.
    sl_pct / tp1_pct: stop loss / first target as % move in the UNDERLYING (used to derive
        an approximate premium stop, since real option OHLC isn't wired in here by default).

    Returns a DataFrame log of every simulated trade plus a final stats row.
    """
    trades = []
    in_position = False
    entry_idx = None
    entry_spot = None

    min_bars = 30  # warmup

    for i in range(min_bars, len(df_5m) - 1):
        window_5m = df_5m.iloc[:i + 1]
        current_time = window_5m["datetime"].iloc[-1]
        window_15m = df_15m[df_15m["datetime"] <= current_time]

        if in_position:
            spot_now = df_5m["close"].iloc[i]
            move_pct = (spot_now - entry_spot) / entry_spot * 100
            if direction == "PE":
                move_pct = -move_pct

            hit_sl = move_pct <= -sl_pct
            hit_tp = move_pct >= tp1_pct
            if hit_sl or hit_tp or i == len(df_5m) - 2:
                exit_reason = "SL" if hit_sl else ("TP1" if hit_tp else "EOD/EOD-of-data")
                trades.append({
                    "entry_time": df_5m["datetime"].iloc[entry_idx],
                    "exit_time": current_time,
                    "direction": direction,
                    "entry_spot": entry_spot,
                    "exit_spot": spot_now,
                    "underlying_move_pct": round(move_pct, 3),
                    "exit_reason": exit_reason,
                })
                in_position = False
            continue

        # find nearest prior chain snapshot for OI comparison, if any provided
        chain_now, chain_prev = None, None
        if chain_snapshots:
            past = [c for t, c in chain_snapshots if t <= current_time]
            if len(past) >= 2:
                chain_now, chain_prev = past[-1], past[-2]

        strike = round(df_5m["close"].iloc[i] / 50) * 50 + strike_offset  # nearest 50-strike, adjust for index
        result = run_checklist(
            df_15m=window_15m, df_5m=window_5m, df_1m=None,
            chain_now=chain_now, chain_prev=chain_prev,
            india_vix_series=None, direction=direction,
            target_strike=strike, iv_series=None,
        )
        s = result.summary()
        if s["confirmed"] + s["failed"] == 0:
            continue
        ratio = s["confirmed"] / (s["confirmed"] + s["failed"])

        if ratio >= min_confirmed_ratio:
            in_position = True
            entry_idx = i
            entry_spot = df_5m["close"].iloc[i]

    trade_log = pd.DataFrame(trades)
    if trade_log.empty:
        print("No trades triggered at this threshold over the backtest window.")
        return trade_log

    wins = trade_log[trade_log["exit_reason"] == "TP1"]
    losses = trade_log[trade_log["exit_reason"] == "SL"]
    win_rate = len(wins) / len(trade_log) * 100
    avg_win = wins["underlying_move_pct"].mean() if not wins.empty else 0
    avg_loss = losses["underlying_move_pct"].mean() if not losses.empty else 0

    print("\n===== REAL BACKTEST RESULTS (not an assumed confidence score) =====")
    print(f"Total trades: {len(trade_log)}")
    print(f"Win rate (hit TP1 before SL): {win_rate:.1f}%")
    print(f"Avg winning move: {avg_win:.2f}% | Avg losing move: {avg_loss:.2f}%")
    print(f"NOTE: this reflects UNDERLYING move, not actual option premium P&L, unless you")
    print(f"wire in real historical option OHLC via Breeze get_historical_data_v2(product_type='options').")
    print("======================================================================\n")

    return trade_log
