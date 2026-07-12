# Breakout/Desk — Automated Trading Bot

Long-only breakout screener + auto-trader for the S&P 500 and Nifty 100,
with Telegram approval and a live React dashboard.

## The Strategy (4 strict rules)

1. **Daily levels**: support/resistance drawn on the daily chart, valid only
   with 3+ respected touches (swing pivots clustered within 0.5×ATR).
2. **1H confirmation**: a full 1-hour candle must CLOSE beyond the level —
   wicks and 15-min closes don't count.
3. **Volume confirmation**: the breakout candle's volume must be ≥1.5× its
   20-bar average, or it's treated as a low-conviction drift.
4. **Defined exit**: stop just past the broken level, target at least 2×
   the risk (2:1 reward:risk). Position sized at 1% account risk, capped at
   10% notional exposure.

A candidate that clears all four rules is sent to you on Telegram; nothing
is traded until you reply **YES**.

## Prerequisites
- Python 3.10+
- Node.js 18+ (only needed if you want to build the dashboard's static React bundle — the FastAPI server also works standalone via its JSON API)
- Interactive Brokers TWS or IB Gateway, paper trading account, API enabled on port 7497
- A Telegram bot token from @BotFather

## Installation

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. (Optional) Build the React dashboard as static files served by FastAPI
cd dashboard
npm install
npm run build
cd ..

# 3. Configure environment
cp .env.example .env
# edit .env and set TELEGRAM_BOT_TOKEN (from @BotFather) and ACCOUNT_VALUE

# 4. Start TWS / IB Gateway with paper trading, API enabled on port 7497

# 5. Run the bot
python run.py
```

Then open Telegram, find your bot, and send `/start` once so it knows
your chat ID and can message you first.

## Access
- Dashboard: http://localhost:8000 (if you built the React app), or hit
  the JSON API directly: `/api/stats`, `/api/alerts`, `/api/positions`,
  `/api/closed`, and the live feed at `ws://localhost:8000/ws`.
- If you skip `npm run build`, run `npm start` inside `dashboard/` during
  development (React dev server on :3000, proxying API calls to :8000).

## Scheduling
- US scan: 5 minutes after each 1H NYSE candle close (America/New_York).
- India scan: 5 minutes after each 1H NSE candle close (Asia/Kolkata).
- Both run only during that market's own trading session.
- Open positions are checked every 5 minutes for stop/target hits.
- A daily summary is sent shortly after the US close.

## Notes & things to double check before going live
- `bot/broker.py` uses `ib_insync` against IB's **paper trading** API
  (port 7497 by default). Confirm you're pointed at paper, not live,
  before testing.
- Live price polling in `get_last_price` requires an active IB market data
  subscription for each symbol; without one it will return `None` and the
  engine will simply skip that check until data is available.
- The S&P 500 list is refreshed weekly from a maintained GitHub CSV to
  avoid scraping Wikipedia (helpful on networks that block it). Edit
  `data/nifty100.json` any time to adjust the Nifty 100 universe.
- If your network intercepts TLS and you see SSL certificate errors,
  uncomment the `apply_ssl_fix()` lines at the top of `run.py`.
- A ticker is only ever alerted once (tracked in the `alerted_tickers`
  table) and is skipped while you hold an open position in it.

## File Structure
```
Automated-Trading-Bot/
├── run.py
├── requirements.txt
├── .env.example
├── bot/
│   ├── levels.py             # Rule 1: daily S/R, 3+ touches
│   ├── strategy.py           # Rules 2-4: confirmation, volume, exits, sizing
│   ├── screener.py           # S&P 500 + Nifty 100 scanner
│   ├── engine.py             # Scheduling & orchestration
│   ├── broker.py             # IB paper trading bracket orders
│   ├── telegram_bot.py       # Alerts & YES/NO confirmation
│   ├── dashboard_server.py   # FastAPI + WebSocket
│   ├── database.py           # SQLite persistence
│   └── ssl_fix.py            # Optional TLS workaround
├── data/
│   ├── nifty100.json         # Editable Nifty 100 list
│   └── trades.db             # Auto-created SQLite DB
└── dashboard/                # React + Tailwind dark-theme UI
    ├── package.json
    ├── public/
    └── src/
        ├── App.js, index.js, index.css
        └── components/
            ├── Header.js, StatsBand.js, AlertPanel.js
            └── PositionPanel.js, WinLossChart.js, ClosedTrades.js
```
