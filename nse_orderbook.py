#!/usr/bin/env python3
"""
Stage 5b — NSE India Order Book (Level 2 market depth) scraper.

Fetches live market depth (top 5 bid/ask) for NSE-listed symbols from NSE
India's public website. Free, no login — but NSE enforces anti-bot gating:
requests need browser-like headers plus a session cookie established by
first visiting the homepage. Heavy/commercial scraping violates NSE Terms
of Use; keep this to reasonable personal-research rates (1-2s between
requests, no sub-second polling).

If NSE blocks us (403/429), we back off with exponential wait and report
"data unavailable" — we do NOT try to defeat CAPTCHAs or rotate IPs.

Usage:
    python3 nse_orderbook.py RELIANCE HDFCBANK SBIN
    python3 nse_orderbook.py --symbols RELIANCE,HDFCBANK --out /tmp/depth.json

Output: JSON array of {symbol, bid_levels, ask_levels, total_buy_qty,
total_sell_qty, last_price, timestamp}.
"""

import argparse
import json
import sys
import time

import requests

NSE_HOME = "https://www.nseindia.com"
QUOTE_URL = "https://www.nseindia.com/api/quote-equity?symbol={sym}&section=all"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/market-data/equity-stock-quotes",
}


def establish_session() -> requests.Session:
    """Two-step flow: hit homepage to get cookies, then reuse them."""
    session = requests.Session()
    session.headers.update(HEADERS)
    resp = session.get(NSE_HOME, timeout=12)
    resp.raise_for_status()
    return session


def fetch_depth(session: requests.Session, symbol: str, attempt: int = 0) -> dict | None:
    """Fetch order book for one symbol. Returns None when blocked/unavailable."""
    url = QUOTE_URL.format(sym=symbol.upper())
    try:
        resp = session.get(url, timeout=12)
    except requests.RequestException as exc:
        print(f"[{symbol}] network error: {exc}", file=sys.stderr)
        return None

    if resp.status_code == 403 or resp.status_code == 429:
        wait = 2 ** (attempt + 2)  # exponential backoff 4s, 8s, 16s...
        print(f"[{symbol}] blocked ({resp.status_code}) — backing off {wait}s", file=sys.stderr)
        if attempt < 3:
            time.sleep(wait)
            return fetch_depth(session, symbol, attempt + 1)
        return None
    if resp.status_code == 404:
        print(f"[{symbol}] 404 — symbol not found on NSE", file=sys.stderr)
        return None
    if not resp.ok:
        print(f"[{symbol}] HTTP {resp.status_code}", file=sys.stderr)
        return None

    data = resp.json()
    depth = data.get("marketDeptOrderBook")
    if not depth:
        print(f"[{symbol}] no depth data in response", file=sys.stderr)
        return None

    def levels(entries):
        out = []
        for e in entries or []:
            price = e.get("price")
            qty = e.get("quantity")
            if price is not None:
                out.append({"price": float(price), "qty": int(qty or 0)})
        return out

    bid_levels = levels(depth.get("bid"))
    ask_levels = levels(depth.get("ask"))

    def total(entries):
        return sum(e["qty"] for e in levels(entries))

    total_buy = total(depth.get("bid"))
    total_sell = total(depth.get("ask"))

    return {
        "symbol": symbol.upper(),
        "bid_levels": bid_levels[:5],
        "ask_levels": ask_levels[:5],
        "total_buy_qty": total_buy,
        "total_sell_qty": total_sell,
        "last_price": float(data.get("lastPrice") or 0),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="NSE India order book scraper (Stage 5b)")
    parser.add_argument("symbols", nargs="*", help="NSE symbols to fetch (space separated)")
    parser.add_argument("--symbols", dest="symbols_csv", help="Comma-separated symbols")
    parser.add_argument("--out", help="Write results to JSON file")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between symbols (s)")
    args = parser.parse_args()

    syms = args.symbols
    if args.symbols_csv:
        syms = [s.strip().upper() for s in args.symbols_csv.split(",") if s.strip()]
    if not syms:
        parser.error("Provide symbols: python3 nse_orderbook.py RELIANCE HDFCBANK")
    syms = [s.upper() for s in syms]

    try:
        session = establish_session()
    except requests.RequestException as exc:
        print(f"NSE unreachable: {exc}", file=sys.stderr)
        return 1

    results = []
    for i, sym in enumerate(syms):
        if i > 0:
            time.sleep(args.delay)
        depth = fetch_depth(session, sym)
        if depth:
            results.append(depth)
            print(f"[{sym}] bid={depth['total_buy_qty']} ask={depth['total_sell_qty']} "
                  f"last={depth['last_price']}")
        else:
            print(f"[{sym}] DATA UNAVAILABLE (blocked or no feed)")

    if args.out:
        with open(args.out, "w") as fh:
            json.dump(results, fh, indent=2)
        print(f"Wrote {len(results)} records to {args.out}")

    if not results:
        print("No depth data fetched — NSE is rate-limiting/blocking this IP.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())