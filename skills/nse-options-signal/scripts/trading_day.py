#!/usr/bin/env python3
"""Is a given date an NSE trading day?

Weekends are closed; the NSE trading-holiday list (data/holidays.json, the
payload of /api/holiday-master?type=trading) closes the rest.  The holiday
list is refreshed weekly by scripts/eod_fetch.py --holidays.

Usage:
    python3 trading_day.py [--date YYYY-MM-DD] [--quiet]
    -> prints "TRADING" or "CLOSED" (exit 0 / 1)
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("GEX_DATA_DIR", os.path.join(os.path.dirname(HERE), "data"))
HOLIDAYS = os.path.join(DATA, "holidays.json")


def _lists(obj):
    if isinstance(obj, list):
        if obj and all(isinstance(i, dict) for i in obj):
            yield obj
        for i in obj:
            yield from _lists(i)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _lists(v)


def holiday_dates(path=HOLIDAYS):
    """Every trading holiday in the NSE holiday-master payload."""
    out = set()
    try:
        with open(path) as fh:
            payload = json.load(fh)
    except Exception:
        return out
    for lst in _lists(payload):
        for row in lst:
            value = row.get("tradingDate") or row.get("date") or row.get("holidayDate")
            if not value:
                continue
            for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y"):
                try:
                    out.add(datetime.strptime(str(value).strip(), fmt).date())
                    break
                except ValueError:
                    continue
    return out


def is_trading_day(day=None, holidays=None):
    day = day or datetime.now(IST).date()
    if day.weekday() >= 5:
        return False
    hol = holiday_dates() if holidays is None else holidays
    return day not in hol


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None)
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    if a.date:
        day = datetime.strptime(a.date, "%Y-%m-%d").date()
    else:
        day = datetime.now(IST).date()
    trading = is_trading_day(day)
    if not a.quiet:
        print("TRADING" if trading else "CLOSED")
    return 0 if trading else 1


if __name__ == "__main__":
    sys.exit(main())
