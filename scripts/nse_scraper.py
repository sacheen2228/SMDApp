#!/usr/bin/env python3
"""
NSE Option Chain Scraper — runs on LOCAL machine (not server)
Scrapes NSE India option chain with full OI, Greeks, IV data.
Pushes to SMDApp server every hour during market hours.

Usage:
  python3 nse_scraper.py                    # run once
  python3 nse_scraper.py --loop             # hourly loop (market hours only)
  python3 nse_scraper.py --server URL       # custom server URL
  python3 nse_scraper.py --symbols NIFTY BANKNIFTY SENSEX

Requirements:
  pip install requests beautifulsoup4

Setup:
  1. pip install requests beautifulsoup4
  2. python3 nse_scraper.py --server https://YOUR-SERVER.ngrok-free.dev
  3. Or add to crontab: 0 9-15 * * 1-5 python3 /path/to/nse_scraper.py --loop
"""

import requests
import json
import time
import sys
import os
import signal
from datetime import datetime, timezone, timedelta
from typing import Optional
import argparse

# ── Config ──
IST = timezone(timedelta(hours=5, minutes=30))
MARKET_OPEN = (9, 15)   # 09:15 IST
MARKET_CLOSE = (15, 30)  # 15:30 IST
LOOP_INTERVAL = 3600     # 1 hour
DEFAULT_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"]

# NSE API endpoints
NSE_OPTION_CHAIN_URL = "https://www.nseindia.com/api/option-chain-indices"
NSE_OPTION_CHAIN_STOCK_URL = "https://www.nseindia.com/api/option-chain-equities"
NSE_INDICES_URL = "https://www.nseindia.com/api/allIndices"
NSE_QUOTE_URL = "https://www.nseindia.com/api/marketStatus"

# NSE session headers (mimics browser)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json,text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": "https://www.nseindia.com/market-data/live-equity-market",
    "X-Requested-With": "XMLHttpRequest",
}

# Index symbols that use the indices endpoint
INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "NIFTY BANK", "NIFTY 50"}

running = True

def signal_handler(sig, frame):
    global running
    print("\n[Scraper] Stopping...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


class NSEScraper:
    def __init__(self, server_url: str):
        self.server_url = server_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._init_session()

    def _init_session(self):
        """Initialize NSE session by visiting the main page first"""
        try:
            print("[Scraper] Initializing NSE session...")
            resp = self.session.get("https://www.nseindia.com/market-data/live-equity-market", timeout=10)
            print(f"[Scraper] Session init: {resp.status_code}")
            time.sleep(1)
        except Exception as e:
            print(f"[Scraper] Session init failed: {e}")

    def fetch_option_chain(self, symbol: str) -> Optional[dict]:
        """Fetch option chain from NSE India API"""
        # Clean symbol for NSE API
        api_symbol = symbol.upper().replace(" ", "%20")
        is_index = symbol.upper() in INDEX_SYMBOLS

        if is_index:
            url = f"https://www.nseindia.com/api/option-chain-indices?symbol={api_symbol}"
        else:
            url = f"https://www.nseindia.com/api/option-chain-equities?symbol={api_symbol}"

        try:
            resp = self.session.get(url, timeout=15)
            if resp.status_code == 200:
                return resp.json()
            elif resp.status_code == 403:
                print(f"[Scraper] 403 Forbidden for {symbol} — reinitializing session")
                self._init_session()
                time.sleep(2)
                resp = self.session.get(url, timeout=15)
                if resp.status_code == 200:
                    return resp.json()
            print(f"[Scraper] {symbol}: HTTP {resp.status_code}")
        except Exception as e:
            print(f"[Scraper] {symbol} fetch error: {e}")
        return None

    def fetch_spot_price(self, symbol: str) -> Optional[float]:
        """Fetch live spot price from NSE indices API"""
        try:
            resp = self.session.get(NSE_INDICES_URL, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                for idx in data.get("data", []):
                    if idx.get("name", "").upper().replace(" ", "") == symbol.upper().replace(" ", ""):
                        return idx.get("last")
        except:
            pass
        return None

    def parse_option_chain(self, data: dict, symbol: str) -> dict:
        """Parse raw NSE option chain into structured format"""
        records = data.get("records", {})
        underlying_value = records.get("underlyingValue", 0)
        expiry_dates = records.get("expiryDates", [])
        selected_expiry = expiry_dates[0] if expiry_dates else ""

        strikes_data = records.get("data", [])
        strikes = []
        total_call_oi = 0
        total_put_oi = 0
        call_oi_change = 0
        put_oi_change = 0
        max_pain = underlying_value
        max_total_oi = 0

        for row in strikes_data:
            strike_price = row.get("strikePrice", 0)
            ce = row.get("CE")
            pe = row.get("PE")

            ce_data = None
            pe_data = None

            if ce:
                ce_oi = ce.get("openInterest", 0) or 0
                ce_oi_chg = ce.get("changeinOpenInterest", 0) or 0
                total_call_oi += ce_oi
                call_oi_change += ce_oi_chg

                ce_data = {
                    "ltp": ce.get("lastPrice", 0) or 0,
                    "oi": ce_oi,
                    "oiChg": ce_oi_chg,
                    "volume": ce.get("totalTradedVolume", 0) or 0,
                    "iv": ce.get("impliedVolatility", 0) or 0,
                    "delta": ce.get("greeks", {}).get("delta", 0) or 0,
                    "gamma": ce.get("greeks", {}).get("gamma", 0) or 0,
                    "theta": ce.get("greeks", {}).get("theta", 0) or 0,
                    "vega": ce.get("greeks", {}).get("vega", 0) or 0,
                }

            if pe:
                pe_oi = pe.get("openInterest", 0) or 0
                pe_oi_chg = pe.get("changeinOpenInterest", 0) or 0
                total_put_oi += pe_oi
                put_oi_change += pe_oi_chg

                pe_data = {
                    "ltp": pe.get("lastPrice", 0) or 0,
                    "oi": pe_oi,
                    "oiChg": pe_oi_chg,
                    "volume": pe.get("totalTradedVolume", 0) or 0,
                    "iv": pe.get("impliedVolatility", 0) or 0,
                    "delta": pe.get("greeks", {}).get("delta", 0) or 0,
                    "gamma": pe.get("greeks", {}).get("gamma", 0) or 0,
                    "theta": pe.get("greeks", {}).get("theta", 0) or 0,
                    "vega": pe.get("greeks", {}).get("vega", 0) or 0,
                }

            total_oi = (ce_data["oi"] if ce_data else 0) + (pe_data["oi"] if pe_data else 0)
            if total_oi > max_total_oi:
                max_total_oi = total_oi
                max_pain = strike_price

            strikes.append({
                "strike": strike_price,
                "ce": ce_data,
                "pe": pe_data,
            })

        pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0

        # Find ATM strike
        atm_strike = underlying_value
        best_dist = float("inf")
        for s in strikes:
            dist = abs(s["strike"] - underlying_value)
            if dist < best_dist:
                best_dist = dist
                atm_strike = s["strike"]

        return {
            "symbol": symbol.upper(),
            "spotPrice": underlying_value,
            "indiaVIX": None,  # NSE option chain doesn't include VIX directly
            "maxPain": max_pain,
            "pcr": pcr,
            "totalCallOI": total_call_oi,
            "totalPutOI": total_put_oi,
            "callOiChange": call_oi_change,
            "putOiChange": put_oi_change,
            "atmStrike": atm_strike,
            "expiries": expiry_dates,
            "selectedExpiry": selected_expiry,
            "strikes": strikes,
        }

    def push_to_server(self, snapshot: dict) -> bool:
        """Push snapshot to SMDApp server"""
        try:
            url = f"{self.server_url}/api/nse-data"
            resp = requests.post(url, json=snapshot, timeout=10,
                                headers={"Content-Type": "application/json"})
            if resp.status_code == 200:
                result = resp.json()
                print(f"[Scraper] ✅ Pushed {snapshot['symbol']}: {len(snapshot['strikes'])} strikes → {result.get('snapshotsStored', '?')} stored")
                return True
            else:
                print(f"[Scraper] ❌ Push failed: HTTP {resp.status_code} — {resp.text[:100]}")
        except Exception as e:
            print(f"[Scraper] ❌ Push error: {e}")
        return False

    def scrape_symbol(self, symbol: str) -> bool:
        """Scrape one symbol and push to server"""
        print(f"\n[Scraper] Scraping {symbol}...")

        raw = self.fetch_option_chain(symbol)
        if not raw:
            print(f"[Scraper] Failed to fetch {symbol}")
            return False

        snapshot = self.parse_option_chain(raw, symbol)

        # Try to get VIX separately
        try:
            spot = self.fetch_spot_price("INDIAVIX")
            if spot and spot > 0:
                snapshot["indiaVIX"] = spot
        except:
            pass

        return self.push_to_server(snapshot)

    def run_once(self, symbols: list[str]):
        """Scrape all symbols once"""
        now = datetime.now(IST)
        print(f"\n{'='*60}")
        print(f"[Scraper] Run at {now.strftime('%Y-%m-%d %H:%M:%S IST')}")
        print(f"[Scraper] Server: {self.server_url}")
        print(f"[Scraper] Symbols: {', '.join(symbols)}")
        print(f"{'='*60}")

        success = 0
        for symbol in symbols:
            try:
                if self.scrape_symbol(symbol):
                    success += 1
                time.sleep(2)  # rate limit between symbols
            except Exception as e:
                print(f"[Scraper] Error scraping {symbol}: {e}")

        print(f"\n[Scraper] Done: {success}/{len(symbols)} symbols pushed")
        return success

    def run_loop(self, symbols: list[str]):
        """Hourly loop during market hours"""
        print(f"[Scraper] Starting hourly loop (market hours {MARKET_OPEN[0]}:{MARKET_OPEN[1]:02d}-{MARKET_CLOSE[0]}:{MARKET_CLOSE[1]:02d} IST)")
        print(f"[Scraper] Interval: {LOOP_INTERVAL}s, Symbols: {', '.join(symbols)}")
        print(f"[Scraper] Press Ctrl+C to stop\n")

        while running:
            now = datetime.now(IST)
            hour_min = (now.hour, now.minute)
            dow = now.weekday()  # 0=Mon, 6=Sun

            # Only scrape during market hours on weekdays
            if dow < 5 and MARKET_OPEN <= hour_min <= MARKET_CLOSE:
                self.run_once(symbols)
            elif dow < 5:
                print(f"[Scraper] {now.strftime('%H:%M')} — outside market hours, skipping")
            else:
                print(f"[Scraper] {now.strftime('%A')} — weekend, skipping")

            # Sleep until next hour
            next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            sleep_seconds = max(10, (next_hour - now).total_seconds())
            print(f"[Scraper] Next run at {next_hour.strftime('%H:%M')} (sleep {int(sleep_seconds)}s)")

            # Sleep in small chunks so we can respond to Ctrl+C
            elapsed = 0
            while running and elapsed < sleep_seconds:
                time.sleep(min(5, sleep_seconds - elapsed))
                elapsed += 5


def main():
    parser = argparse.ArgumentParser(description="NSE Option Chain Scraper for SMDApp")
    parser.add_argument("--server", default="http://localhost:3000", help="SMDApp server URL")
    parser.add_argument("--loop", action="store_true", help="Run in hourly loop mode")
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS, help="Symbols to scrape")
    parser.add_argument("--once", action="store_true", help="Run once (default)")
    args = parser.parse_args()

    scraper = NSEScraper(args.server)

    if args.loop:
        scraper.run_loop(args.symbols)
    else:
        scraper.run_once(args.symbols)


if __name__ == "__main__":
    main()
