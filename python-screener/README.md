# Nifty/Sensex Zero-to-Hero Screener + Backtester

## What this is
A checklist-based screener for Nifty/Sensex option-buying setups, using
ICICI Breeze Connect for data, plus a backtester so you can measure your
checklist's **real historical hit rate** instead of assuming one.

## What this is NOT
Not a guaranteed-accuracy signal generator. No combination of these
indicators produces reliably >90% accurate option-buying signals — if
anything claims that, distrust it. This tool tells you the truth about
your checklist's performance so you can decide if it's actually worth
trading, and size risk accordingly.

## Setup
```bash
pip install breeze-connect pandas numpy scipy --break-system-packages
export BREEZE_API_KEY=your_key
export BREEZE_API_SECRET=your_secret
export BREEZE_SESSION_TOKEN=your_daily_session_token
python main.py
```

## Files
- `data_feed.py` — Breeze API wrapper (OHLC, option chain, VIX)
- `indicators.py` — VWAP, trend, breakout, OI change, PCR, max pain, Black-Scholes Greeks, IV expansion
- `checklist.py` — scores your checklist honestly: True / False / "N/A" (never fakes an unavailable input)
- `backtester.py` — walks historical bars with no lookahead, simulates trades, reports real win rate
- `main.py` — example usage for both live screening and backtesting

## Honesty rules baked into the code
1. **No fabricated confidence scores.** The score is always "X confirmed / Y checkable", with unavailable items shown separately, not silently assumed true.
2. **No lookahead in the backtest.** At each historical bar, only data up to that point is used.
3. **Discretionary concepts are labeled.** Institutional order flow, liquidity sweep, BOS/CHOCH, FVG, and order block don't have standardized formulas. They're marked `N/A` in the checklist until you build and *backtest* your own proxy definition — don't wire in a guess and trust it blind.
4. **Option premium backtesting needs real option OHLC.** The default backtest measures underlying % move as a stand-in; wire in `get_historical_data_v2(product_type='options')` from Breeze for true premium-based P&L before trusting the numbers for position sizing.

## Suggested next steps
1. Run `backtest_example()` over at least 6–12 months of 5-min data before risking capital.
2. Look at `win_rate` and `avg_win` vs `avg_loss` together — a 40% win rate can still be profitable if avg wins are 2–3x avg losses (this is standard for option-buying strategies, unlike what "94/100 A+" style scores imply).
3. Only after the backtest shows a real, positive expectancy, connect this to live order placement (not included here on purpose — get the edge validated first).
4. Position size at 1–2% risk per trade as you already planned, based on the *actual* SL distance in premium terms, not the underlying move.
