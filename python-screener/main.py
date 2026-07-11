"""
main.py — example usage

1) LIVE SCREENING EXAMPLE
2) BACKTEST EXAMPLE

Fill in your Breeze credentials via env vars before running:
  export BREEZE_API_KEY=...
  export BREEZE_API_SECRET=...
  export BREEZE_SESSION_TOKEN=...   # regenerate daily per Breeze's login flow
"""

import os
from data_feed import BreezeDataFeed
from checklist import run_checklist
from backtester import run_backtest


def get_feed():
    return BreezeDataFeed(
        api_key=os.environ["BREEZE_API_KEY"],
        api_secret=os.environ["BREEZE_API_SECRET"],
        session_token=os.environ["BREEZE_SESSION_TOKEN"],
    )


def live_screen_example():
    feed = get_feed()

    df_15m = feed.get_ohlc("NIFTY", "30minute", "2026-07-01T00:00:00.000Z", "2026-07-09T00:00:00.000Z")
    df_5m = feed.get_ohlc("NIFTY", "5minute", "2026-07-08T00:00:00.000Z", "2026-07-09T00:00:00.000Z")

    chain = feed.get_option_chain("NIFTY", expiry_date="2026-07-16")
    spot = df_5m["close"].iloc[-1]
    atm_strike = round(spot / 50) * 50

    result = run_checklist(
        df_15m=df_15m, df_5m=df_5m, df_1m=None,
        chain_now=chain, chain_prev=None,  # need a stored earlier snapshot for OI-change signal
        india_vix_series=None, direction="CE",
        target_strike=atm_strike, iv_series=None,
    )

    print("Confirmed:", result.confirmed())
    print("Failed:", result.failed())
    print("Unavailable (not counted either way):", result.unavailable())
    print("Summary:", result.summary())
    print("\nNote: unavailable items (institutional order flow, liquidity sweep, BOS/CHOCH,")
    print("FVG, order block) are discretionary concepts without a standard formula — build and")
    print("VALIDATE your own proxy detector against historical data before trusting it live.")


def backtest_example():
    feed = get_feed()
    df_15m = feed.get_ohlc("NIFTY", "30minute", "2026-01-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
    df_5m = feed.get_ohlc("NIFTY", "5minute", "2026-01-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")

    run_backtest(
        df_15m=df_15m, df_5m=df_5m, chain_snapshots=[],  # add historical OI snapshots if you log them daily
        min_confirmed_ratio=0.8, sl_pct=0.25, tp1_pct=0.7, direction="CE",
    )


if __name__ == "__main__":
    # live_screen_example()
    backtest_example()
