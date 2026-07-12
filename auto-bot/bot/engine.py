"""
Core trading engine: orchestrates scans, alerting, paper trade tracking,
exit monitoring, and daily summary — all self-contained (no external broker).

Data stays in the local SQLite DB. The FastAPI dashboard server exposes it
for the SMDApp frontend to consume.
"""
import asyncio
import json
from datetime import datetime, timedelta
from typing import Optional
from urllib.request import urlopen

import pytz
import yfinance as yf

from bot.database import Database
from bot.screener import Screener

US_TZ = pytz.timezone("America/New_York")
IN_TZ = pytz.timezone("Asia/Kolkata")
SMDAPP_API = "http://localhost:3000"

US_TZ = pytz.timezone("America/New_York")
IN_TZ = pytz.timezone("Asia/Kolkata")

US_SCAN_MINUTE = 5
IN_SCAN_MINUTE = 20

US_MARKET_OPEN = (9, 30)
US_MARKET_CLOSE = (16, 0)
IN_MARKET_OPEN = (9, 15)
IN_MARKET_CLOSE = (15, 30)

POSITION_CHECK_INTERVAL_SEC = 5 * 60
DAILY_SUMMARY_HOUR_ET = 16


class TradingEngine:
    def __init__(self, account_value: float = 100000.0):
        self.db = Database()
        self.screener = Screener(self.db, account_value=account_value)
        self.running = False

        self._last_us_scan_slot: Optional[str] = None
        self._last_in_scan_slot: Optional[str] = None
        self._last_position_check = datetime.min
        self._last_summary_date: Optional[str] = None

    async def run(self):
        self.running = True
        print("[engine] Trading engine starting (paper mode, no broker)...")

        await self._run_scan("US")
        await self._run_scan("INDIA")

        while self.running:
            await self._tick()
            await asyncio.sleep(30)

    async def _tick(self):
        now_us = datetime.now(US_TZ)
        now_in = datetime.now(IN_TZ)

        if self._within_session(now_us, US_MARKET_OPEN, US_MARKET_CLOSE) and now_us.minute == US_SCAN_MINUTE:
            slot = now_us.strftime("%Y-%m-%d %H")
            if slot != self._last_us_scan_slot:
                self._last_us_scan_slot = slot
                await self._run_scan("US")

        if self._within_session(now_in, IN_MARKET_OPEN, IN_MARKET_CLOSE) and now_in.minute == IN_SCAN_MINUTE:
            slot = now_in.strftime("%Y-%m-%d %H")
            if slot != self._last_in_scan_slot:
                self._last_in_scan_slot = slot
                await self._run_scan("INDIA")

        if (datetime.now() - self._last_position_check).total_seconds() >= POSITION_CHECK_INTERVAL_SEC:
            self._last_position_check = datetime.now()
            await self._check_positions()

        if now_us.hour == DAILY_SUMMARY_HOUR_ET and now_us.minute == 5:
            today = now_us.strftime("%Y-%m-%d")
            if today != self._last_summary_date:
                self._last_summary_date = today
                self._send_daily_summary()

    @staticmethod
    def _within_session(now, open_hm, close_hm) -> bool:
        open_t = now.replace(hour=open_hm[0], minute=open_hm[1], second=0, microsecond=0)
        close_t = now.replace(hour=close_hm[0], minute=close_hm[1], second=0, microsecond=0)
        return open_t <= now <= close_t and now.weekday() < 5

    async def _run_scan(self, market_filter: str):
        print(f"[engine] Running {market_filter} scan at {datetime.now().isoformat()}")
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, self.screener.scan_all)

        signals = results.get(market_filter, [])
        for signal in signals:
            print(f"[engine] Breakout candidate: {signal.ticker} ({signal.market}) broke {signal.level}")
            alert = self.db.get_alert(signal.ticker)
            if not alert:
                continue

            self.db.update_alert_status(signal.ticker, "accepted")
            self.db.add_trade(
                ticker=alert.ticker,
                market=alert.market,
                qty=alert.qty,
                entry_price=alert.level,
                stop_loss=alert.stop,
                target=alert.target,
            )
            print(f"[engine] Paper trade opened: {alert.ticker} qty={alert.qty} entry={alert.level}")

    def _fetch_price(self, ticker: str, market: str) -> Optional[float]:
        """Get live price from SMDApp API for Indian stocks, yfinance fallback."""
        if market == "INDIA":
            try:
                url = f"{SMDAPP_API}/api/auto-bot/stock?ticker={ticker}"
                with urlopen(url, timeout=10) as resp:
                    data = json.loads(resp.read().decode())
                if data.get("price"):
                    return float(data["price"])
            except Exception as e:
                print(f"[engine] SMDApp price fetch failed for {ticker}: {e}")
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="1d", interval="1m", progress=False)
            if not hist.empty:
                return float(hist["Close"].iloc[-1])
        except Exception as e:
            print(f"[engine] yfinance price fetch failed for {ticker}: {e}")
        return None

    async def _check_positions(self):
        """Poll prices for open positions and close on stop/target."""
        open_trades = self.db.get_open_trades()
        for trade in open_trades:
            price = self._fetch_price(trade.ticker, trade.market)
            if price is None:
                continue

            if price <= trade.stop_loss:
                result = self.db.close_trade(trade.id, price, "stop_loss")
                if result:
                    print(f"[engine] Paper trade closed: {trade.ticker} stop-loss hit, P&L={result['pnl']:.2f}")
            elif price >= trade.target:
                result = self.db.close_trade(trade.id, price, "target")
                if result:
                    print(f"[engine] Paper trade closed: {trade.ticker} target hit, P&L={result['pnl']:.2f}")

    def _send_daily_summary(self):
        stats = self.db.get_today_stats()
        print(f"[engine] Daily summary: {stats}")

    async def shutdown(self):
        print("[engine] Shutting down...")
        self.running = False
