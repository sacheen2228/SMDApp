#!/usr/bin/env python3
"""Validated account-equity source for position sizing.

Position sizing must never use a hardcoded number. This module resolves the
account equity from a VALIDATED source and fails closed when it cannot:

  file mode (default)
      <data>/account_equity.json  ->  {"equity": 250000, "source": "...",
                                       "as_of": "2026-10-20T09:15:00+05:30",
                                       "max_deployment_per_trade": 20000}
      `source` and `as_of` are REQUIRED. A missing/!positive equity, a missing
      as_of, a future as_of or an as_of older than --max-age-hours is a hard
      failure (NO TRADE), never a silent default.

  api mode (--from-api)
      GET <INTERNAL_API_BASE>/api/positions -> data.funds.allocated_equity
      (src/lib/icici-breeze/positions.ts -> ICICI Breeze getFunds). This is the
      broker's own allocation - the only trustworthy equity figure in this repo.

Usage:
    python3 account_equity.py --file data/account_equity.json
    python3 account_equity.py --from-api
"""
import argparse
import json
import math
import os
import urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
DEFAULT_DATA_DIR = os.environ.get("GEX_DATA_DIR", os.path.join(SKILL, "data"))
DEFAULT_FILE = os.path.join(DEFAULT_DATA_DIR, "account_equity.json")
DEFAULT_API = os.environ.get("INTERNAL_API_BASE", "http://localhost:3000") + "/api/positions"
MAX_AGE_HOURS = 24.0
FUTURE_SKEW_MIN = 5.0


def parse_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), IST)
    text = str(value).strip().replace(" ", "T")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(str(value).strip(), fmt)
                break
            except ValueError:
                continue
        else:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=IST)


def _validate(equity, source, as_of, now, max_age_hours=MAX_AGE_HOURS, deployment_cap=None):
    """Return (ok, payload_dict). Every failure names what was wrong."""
    if equity is None:
        return False, {"ok": False, "reason": "no account-equity value supplied"}
    try:
        equity = float(equity)
    except (TypeError, ValueError):
        return False, {"ok": False, "reason": "account equity is not a number: %r" % (equity,)}
    if not math.isfinite(equity) or equity <= 0:
        return False, {"ok": False, "reason": "account equity is not positive: %r" % (equity,)}
    if not source:
        return False, {"ok": False, "reason": "account equity has no source attribution"}
    ts = parse_ts(as_of)
    if ts is None:
        return False, {"ok": False, "reason": "account equity has no parseable as_of timestamp"}
    age_min = (now - ts).total_seconds() / 60.0
    if age_min < -FUTURE_SKEW_MIN:
        return False, {"ok": False, "reason": "account equity as_of is %.0f min in the future" % (-age_min,)}
    if age_min > max_age_hours * 60:
        return False, {"ok": False, "reason": "account equity is stale (%.1f h old, limit %.0f h)" % (
            age_min / 60.0, max_age_hours)}
    payload = {"ok": True, "equity": equity, "source": source, "as_of": ts.isoformat(),
               "age_minutes": round(age_min, 1)}
    if deployment_cap:
        try:
            cap = float(deployment_cap)
            if cap > 0:
                payload["max_deployment_per_trade"] = cap
        except (TypeError, ValueError):
            pass
    return True, payload


def load(path=DEFAULT_FILE, now=None, max_age_hours=MAX_AGE_HOURS):
    """Load + validate the account equity from a JSON file."""
    now = now or datetime.now(IST)
    try:
        with open(path) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {"ok": False, "reason": "account-equity file not found: %s" % path}
    except Exception as exc:
        return {"ok": False, "reason": "account-equity file unreadable: %s: %s" % (path, exc)}
    if not isinstance(data, dict):
        return {"ok": False, "reason": "account-equity file must contain a JSON object"}
    equity = data.get("equity")
    if equity is None:
        equity = data.get("allocated_equity")
    ok, payload = _validate(equity, data.get("source"), data.get("as_of"), now,
                            max_age_hours, data.get("max_deployment_per_trade"))
    if not ok:
        payload["path"] = path
    return payload


def load_from_api(url=DEFAULT_API, now=None, max_age_hours=MAX_AGE_HOURS, timeout=10):
    """Load + validate the account equity from the app's Breeze funds endpoint."""
    now = now or datetime.now(IST)
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"ok": False, "reason": "account-equity API unreachable: %s: %s" % (url, exc)}
    funds = ((body or {}).get("data") or {}).get("funds") or {}
    equity = funds.get("allocated_equity")
    ok, payload = _validate(equity, "ICICI Breeze getFunds (allocated_equity) via %s" % url,
                            now.isoformat(), now, max_age_hours)
    if not ok:
        payload["url"] = url
    return payload


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=DEFAULT_FILE)
    ap.add_argument("--from-api", action="store_true")
    ap.add_argument("--url", default=DEFAULT_API)
    ap.add_argument("--max-age-hours", type=float, default=MAX_AGE_HOURS)
    a = ap.parse_args()
    res = load_from_api(a.url, max_age_hours=a.max_age_hours) if a.from_api else \
        load(a.file, max_age_hours=a.max_age_hours)
    print(json.dumps(res, indent=1))
    raise SystemExit(0 if res.get("ok") else 1)
