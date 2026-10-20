#!/usr/bin/env python3
"""Daily NSE context fetcher for the skill (EOD + live + holidays + PCR).

PATH MAPPING (see references/agent-rules.md):
    the vendored package shipped its own stdlib NSE client (eod_fetch.py).  That
    client is NOT duplicated here: this module reuses the skill's existing
    scripts/nse_fetch.py (session, endpoints, participant-OI CSV download) so
    there is exactly one NSE client in the skill.

Output: <data>/eod/<run date>/<source>.json plus _status.json (ok/error per
source).  Every source is independent: one failure never blocks the others.

Usage:
    python3 eod_fetch.py --eod                       # participant OI, FII/DII, indices, ...
    python3 eod_fetch.py --eod --retry-until 22:00   # keep retrying what NSE has not published
    python3 eod_fetch.py --live                      # intraday breadth / movers
    python3 eod_fetch.py --holidays                  # the trading-holiday list
    python3 eod_fetch.py --from-snapshot snapshot.json  # PCR + max pain from our own chain

The nseindia.com JSON endpoints are unofficial and change without notice.
Run --eod once by hand and check _status.json before trusting it.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nse_fetch  # noqa: E402  (the skill's existing NSE client)

IST = timezone(timedelta(hours=5, minutes=30))
DATA = os.environ.get("GEX_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
RETRY_INTERVAL_S = 600


# ---------------------------------------------------------------- helpers
def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except Exception:
        return None


def norm(s):
    return " ".join(str(s).strip().lower().split())


def find_lists(obj):
    """Yield every list of dicts found anywhere in obj (endpoints change shape)."""
    if isinstance(obj, list):
        if obj and all(isinstance(i, dict) for i in obj):
            yield obj
        for i in obj:
            yield from find_lists(i)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from find_lists(v)


def save(day_dir, name, obj):
    os.makedirs(day_dir, exist_ok=True)
    with open(os.path.join(day_dir, "%s.json" % name), "w") as fh:
        json.dump(obj, fh, indent=1)


# ---------------------------------------------------------------- sources
def parse_participant_csv(text, day):
    """Parse the NSE participant-wise OI CSV (the official published file)."""
    rows = list(csv.reader(io.StringIO(text)))
    hi = next((i for i, r in enumerate(rows) if r and norm(r[0]) == "client type"), None)
    if hi is None:
        raise ValueError("header row 'Client Type' not found")
    cols = [norm(c) for c in rows[hi]]
    out = {}
    for r in rows[hi + 1:]:
        if not r or not r[0].strip():
            continue
        key = r[0].strip().upper()
        out[key] = {cols[i]: num(r[i]) for i in range(1, min(len(cols), len(r)))}
    if not {"FII", "DII", "PRO", "CLIENT"} <= set(out):
        raise ValueError("missing participants, got %s" % list(out))
    return {"data_date": day.isoformat(), "participants": out}


def src_participant_oi(session, d):
    """The official participant OI CSV (reuses nse_fetch's downloader)."""
    payload = nse_fetch.fao_participant_oi(session, d)
    if not isinstance(payload, dict) or payload.get("_error") or not payload.get("csv"):
        raise RuntimeError("participant OI not found: %s" % (payload or {}).get("_error", "empty"))
    day = datetime.strptime(str(payload["date"]), "%Y-%m-%d").date()
    return parse_participant_csv(payload["csv"], day)


def src_fii_dii(session, d):
    payload = nse_fetch.get(session, nse_fetch.ENDPOINTS["fii_dii"])
    res = {"FII": None, "DII": None, "data_date": None}
    for lst in find_lists(payload):
        for row in lst:
            cat = norm(row.get("category", ""))
            if not cat:
                continue
            key = "FII" if ("fii" in cat or "fpi" in cat) else "DII" if "dii" in cat else None
            if key:
                res[key] = {"buy": num(row.get("buyValue")), "sell": num(row.get("sellValue")),
                            "net": num(row.get("netValue"))}
                res["data_date"] = row.get("date")
    if res["FII"] is None and res["DII"] is None:
        raise ValueError("no FII/DII rows found")
    try:
        res["data_date"] = datetime.strptime(res["data_date"], "%d-%b-%Y").date().isoformat()
    except Exception:
        pass
    return res


SECTOR_KEYS = ("NIFTY BANK", "NIFTY IT", "NIFTY AUTO", "NIFTY FMCG", "NIFTY PHARMA", "NIFTY METAL",
               "NIFTY ENERGY", "NIFTY FINANCIAL SERVICES", "NIFTY REALTY", "NIFTY MEDIA",
               "NIFTY PSU BANK", "NIFTY PRIVATE BANK", "NIFTY OIL & GAS", "NIFTY HEALTHCARE INDEX",
               "NIFTY CONSUMER DURABLES")


def src_indices(session, d):
    payload = nse_fetch.get(session, nse_fetch.ENDPOINTS["all_indices"])
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    by = {norm(r.get("index", "")): r for r in rows}
    n50 = by.get("nifty 50")
    if not n50:
        raise ValueError("NIFTY 50 row missing")
    out = {"data_date": (payload.get("timestamp") or "")[:11].strip(),
           "nifty50": {"last": num(n50.get("last")), "pct": num(n50.get("percentChange")),
                       "advances": num(n50.get("advances")), "declines": num(n50.get("declines")),
                       "unchanged": num(n50.get("unchanged"))},
           "india_vix": {"last": num(by.get("india vix", {}).get("last")),
                         "pct": num(by.get("india vix", {}).get("percentChange"))},
           "sectors": {k.title(): {"pct": num(by[norm(k)].get("percentChange")),
                                   "last": num(by[norm(k)].get("last"))}
                       for k in SECTOR_KEYS if norm(k) in by}}
    try:
        out["data_date"] = datetime.strptime(out["data_date"], "%d-%b-%Y").date().isoformat()
    except Exception:
        out["data_date"] = d.isoformat()
    a, dn = out["nifty50"]["advances"], out["nifty50"]["declines"]
    out["ad_ratio"] = round(a / dn, 2) if a is not None and dn else None
    return out


def src_gainers_losers(session, d):
    return {"gainers": nse_fetch.get(session, nse_fetch.ENDPOINTS["gainers"]),
            "losers": nse_fetch.get(session, nse_fetch.ENDPOINTS["losers"])}


def src_most_active(session, d):
    return {"by_value": nse_fetch.get(session, nse_fetch.ENDPOINTS["most_active_contracts"])}


def src_holidays(session, d):
    return nse_fetch.get(session, "/api/holiday-master?type=trading")


EOD_SOURCES = {"participant_oi": src_participant_oi, "fii_dii": src_fii_dii, "indices": src_indices,
               "gainers_losers": src_gainers_losers, "most_active": src_most_active}
LIVE_SOURCES = {"indices": src_indices, "gainers_losers": src_gainers_losers, "most_active": src_most_active}


# ---------------------------------------------------------------- from our own chain
def pcr_and_max_pain(snap):
    """PCR + max pain from our own option-chain snapshot (GEX format)."""
    chain = snap["expiries"][0]["chain"]
    call_oi = sum(r.get("call_oi", 0) for r in chain)
    put_oi = sum(r.get("put_oi", 0) for r in chain)
    strikes = sorted(r["strike"] for r in chain)

    def pain(k):
        return sum(r.get("call_oi", 0) * max(k - r["strike"], 0) +
                   r.get("put_oi", 0) * max(r["strike"] - k, 0) for r in chain)

    mp = min(strikes, key=pain) if strikes else None
    return {"data_date": str(snap.get("timestamp", ""))[:10], "symbol": snap.get("symbol"),
            "expiry": snap["expiries"][0]["date"],
            "pcr_oi": round(put_oi / call_oi, 3) if call_oi else None, "max_pain": mp,
            "call_oi": call_oi, "put_oi": put_oi, "spot": snap.get("spot")}


# ---------------------------------------------------------------- runner
def run_sources(sources, day_dir, d, only_missing=False, session=None):
    status_path = os.path.join(day_dir, "_status.json")
    status = {}
    if os.path.exists(status_path):
        try:
            with open(status_path) as fh:
                status = json.load(fh)
        except Exception:
            status = {}
    own_session = session is None
    if own_session:
        session = nse_fetch.session()
    for name, fn in sources.items():
        if only_missing and status.get(name, {}).get("ok"):
            continue
        try:
            data = fn(session, d)
            save(day_dir, name, data)
            status[name] = {"ok": True, "fetched_at": datetime.now(IST).isoformat(timespec="seconds")}
        except Exception as e:
            status[name] = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)[:300],
                            "fetched_at": datetime.now(IST).isoformat(timespec="seconds")}
        time.sleep(1.0)
    save(day_dir, "_status", status)
    return status


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--eod", action="store_true")
    g.add_argument("--live", action="store_true")
    g.add_argument("--holidays", action="store_true")
    g.add_argument("--from-snapshot")
    ap.add_argument("--date", help="YYYY-MM-DD run date (default today IST)")
    ap.add_argument("--retry-until", help="HH:MM IST; keep retrying failed sources every 10 min (eod only)")
    a = ap.parse_args()
    now = datetime.now(IST)
    d = datetime.strptime(a.date, "%Y-%m-%d").date() if a.date else now.date()
    day_dir = os.path.join(DATA, "eod", d.isoformat())

    if a.holidays:
        st = run_sources({"holidays": src_holidays}, DATA, d)
        print(json.dumps(st))
        return
    if a.from_snapshot:
        with open(a.from_snapshot) as fh:
            snap = json.load(fh)
        save(day_dir, "pcr_maxpain", pcr_and_max_pain(snap))
        print("saved pcr_maxpain")
        return
    if a.live:
        st = run_sources(LIVE_SOURCES, os.path.join(DATA, "live", d.isoformat()), d)
        print(json.dumps(st, indent=1))
        return

    st = run_sources(EOD_SOURCES, day_dir, d)
    if a.retry_until:
        hh, mm = map(int, a.retry_until.split(":"))
        deadline = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        while datetime.now(IST) < deadline and not all(v.get("ok") for v in st.values()):
            time.sleep(RETRY_INTERVAL_S)
            st = run_sources(EOD_SOURCES, day_dir, d, only_missing=True)
    bad = {k: v["error"] for k, v in st.items() if not v.get("ok")}
    print("OK:", [k for k, v in st.items() if v.get("ok")])
    if bad:
        print("FAILED:", json.dumps(bad, indent=1))
        sys.exit(1)


if __name__ == "__main__":
    main()
