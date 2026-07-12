"""Screens the S&P 500 and Nifty 100 for valid breakout candidates."""
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from urllib.request import urlopen

import pandas as pd
import yfinance as yf

from bot.database import Database, Alert
from bot.levels import find_daily_levels, nearest_resistance_above
from bot.strategy import check_breakout, build_signal, BreakoutSignal

DATA_DIR = Path(__file__).parent.parent / "data"
NIFTY_JSON = DATA_DIR / "nifty100.json"

SMDAPP_API = "http://localhost:3000"

SP500_SOURCE_URL = (
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/"
    "master/data/constituents.csv"
)


class Screener:
    def __init__(self, db: Database, account_value: float = 100000.0):
        self.db = db
        self.account_value = account_value
        self._sp500_cache: List[str] = []
        self._sp500_cache_time: float = 0

    # ---------- Ticker universes ----------
    def get_sp500_tickers(self) -> List[str]:
        """Cached weekly refresh of the S&P 500 list from a maintained GitHub CSV."""
        now = time.time()
        if self._sp500_cache and (now - self._sp500_cache_time) < 7 * 24 * 3600:
            return self._sp500_cache
        try:
            df = pd.read_csv(SP500_SOURCE_URL)
            tickers = df["Symbol"].str.replace(".", "-", regex=False).tolist()
            self._sp500_cache = tickers
            self._sp500_cache_time = now
        except Exception as e:
            print(f"[screener] Failed to refresh S&P 500 list: {e}")
            if not self._sp500_cache:
                # Small built-in fallback so the bot still runs
                self._sp500_cache = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"]
        return self._sp500_cache

    def get_nifty100_tickers(self) -> List[str]:
        if not NIFTY_JSON.exists():
            return []
        with open(NIFTY_JSON) as f:
            data = json.load(f)
        return data.get("tickers", [])

    def _fetch_from_smdapp(self, ticker: str) -> Optional[dict]:
        """Fetch stock data from SMDApp's Breeze-connected API."""
        try:
            url = f"{SMDAPP_API}/api/auto-bot/stock?ticker={ticker}"
            with urlopen(url, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            print(f"[screener] SMDApp fetch failed for {ticker}: {e}")
            return None

    def _json_to_dataframe(self, candles: list) -> Optional[pd.DataFrame]:
        """Convert API candle JSON to a yfinance-compatible DataFrame."""
        if not candles:
            return None
        df = pd.DataFrame(candles)
        df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
        df = df.drop(columns=[c for c in df.columns if c not in ("Open","High","Low","Close","Volume","t")], errors="ignore")
        df["t"] = pd.to_datetime(df["t"])
        df = df.set_index("t")
        df = df.sort_index()
        df = df[["Open","High","Low","Close","Volume"]].astype(float)
        return df

    # ---------- Core scan ----------
    def scan_ticker(self, ticker: str, market: str) -> BreakoutSignal | None:
        """Runs Rules 1-4 against a single ticker. Returns a signal or None."""
        try:
            if market == "INDIA":
                api_data = self._fetch_from_smdapp(ticker)
                price = None
                if api_data:
                    daily = self._json_to_dataframe(api_data.get("daily"))
                    price = api_data.get("price")
                if daily is None or len(daily) < 30:
                    daily = yf.download(ticker, period="9mo", interval="1d",
                                         progress=False, auto_adjust=True)
                    if daily is None or daily.empty or len(daily) < 30:
                        return None
                    if isinstance(daily.columns, pd.MultiIndex):
                        daily.columns = daily.columns.get_level_values(0)
                if not price:
                    price = float(daily["Close"].iloc[-1])
            else:
                daily = yf.download(ticker, period="9mo", interval="1d",
                                     progress=False, auto_adjust=True)
                if daily is None or daily.empty or len(daily) < 30:
                    return None
                if isinstance(daily.columns, pd.MultiIndex):
                    daily.columns = daily.columns.get_level_values(0)
                price = float(daily["Close"].iloc[-1])

            levels = find_daily_levels(daily, min_touches=3)  # Rule 1
            if not levels:
                return None

            hourly = yf.download(ticker, period="30d", interval="1h",
                                  progress=False, auto_adjust=True)
            if hourly is None or hourly.empty or len(hourly) < 25:
                return None
            if isinstance(hourly.columns, pd.MultiIndex):
                hourly.columns = hourly.columns.get_level_values(0)

            # Drop a possibly still-forming last bar for safety
            hourly = hourly.iloc[:-1] if len(hourly) > 21 else hourly

            last_close = float(hourly["Close"].iloc[-1])
            level = nearest_resistance_above(levels, last_close * 0.995)
            if level is None:
                return None

            breakout = check_breakout(hourly, level)  # Rules 2 + 3
            if breakout is None:
                return None

            signal = build_signal(ticker, market, breakout, self.account_value)  # Rule 4
            if signal.qty <= 0:
                return None
            return signal
        except Exception as e:
            print(f"[screener] Error scanning {ticker}: {e}")
            return None

    def scan_all(self) -> Dict[str, List[BreakoutSignal]]:
        """Scans both markets, skipping tickers already alerted or already held."""
        results: Dict[str, List[BreakoutSignal]] = {"US": [], "INDIA": []}

        universes = [
            ("US", self.get_sp500_tickers()),
            ("INDIA", self.get_nifty100_tickers()),
        ]

        for market, tickers in universes:
            for ticker in tickers:
                if self.db.already_alerted(ticker) or self.db.has_open_position(ticker):
                    continue
                signal = self.scan_ticker(ticker, market)
                if signal is None:
                    continue

                alert = Alert(
                    id=ticker,
                    ticker=ticker,
                    market=market,
                    level=signal.level,
                    stop=signal.stop_loss,
                    target=signal.target,
                    volume_ratio=signal.volume_ratio,
                    touches=signal.touches,
                    alert_time=datetime.now().isoformat(timespec="minutes"),
                    qty=signal.qty,
                )
                self.db.add_alert(alert)
                results[market].append(signal)

        return results
