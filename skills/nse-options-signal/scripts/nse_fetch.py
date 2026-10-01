#!/usr/bin/env python3
"""Fetch NSE public data into one JSON snapshot.
Usage: python nse_fetch.py --symbol NIFTY --out snapshot.json [--news news.json]
Needs: pip install requests
NSE blocks bots: we warm up a session with browser headers to get cookies.
Poll no faster than every 60s. Update ENDPOINTS if NSE changes them (see references/data-sources.md).
Every fetched input is stamped with provenance (source / data_timestamp /
fetch_timestamp / status LIVE|FALLBACK|MISSING|UNAVAILABLE) under snap.meta.
--news only reads a provided JSON file - this script never invents news.
"""
import argparse, json, time, datetime, sys, os
import requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import provenance as _prov

BASE = "https://www.nseindia.com"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE + "/",
}
ENDPOINTS = {
    "option_chain": "/api/option-chain-indices?symbol={symbol}",
    "oi_spurts_underlyings": "/api/live-analysis-oi-spurts-underlyings",
    "oi_spurts_contracts": "/api/live-analysis-oi-spurts-contracts",
    "gainers": "/api/live-analysis-variations?index=gainers",
    "losers": "/api/live-analysis-variations?index=loosers",
    "volume_gainers": "/api/live-analysis-volume-gainers",
    "week52_high": "/api/live-analysis-data-52weekhighstock",
    "most_active_contracts": "/api/snapshot-derivatives-equity?index=contracts&limit=20",
    "preopen": "/api/market-data-pre-open?key=NIFTY",
    "fii_dii": "/api/fiidiiTradeReact",
    # Closing Auction Session (CAS) - verified 200 JSON (page: /market-data/closing-auction-session)
    "closing_auction": "/api/NextApi/apiClient/casApi?functionName=getCASData",
    # India VIX + all index levels/% change (VIX is inside this payload)
    "all_indices": "/api/allIndices",
    # intraday index candles for VWAP / opening range / swing levels - verify URL in DevTools (NIFTY 50 chart)
    "chart_nifty": "/api/chart-databyindex?index=NIFTY%2050&indices=true",
    "chart_banknifty": "/api/chart-databyindex?index=NIFTY%20BANK&indices=true",
    # NSE Index Heatmap (constituents with market-cap weight and % change) - verify in DevTools
    "heatmap_nifty50": "/api/heatmap-symbols?type=Broad%20Market%20Indices&indices=NIFTY%2050",
    "heatmap_banknifty": "/api/heatmap-symbols?type=Sectoral%20Indices&indices=NIFTY%20BANK",
    "heatmap_sectoral_indices": "/api/heatmap-index?type=Sectoral%20Indices",
}

# ---- BSE (bseindia.com). BSE uses api.bseindia.com; endpoints change, so YOU must confirm them once: ----
# Open the page, DevTools -> Network -> Fetch/XHR, reload, copy the request URL that returns JSON, paste below.
BSE_HEADERS = {
    "User-Agent": HEADERS["User-Agent"], "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.bseindia.com", "Referer": "https://www.bseindia.com/",
}
BSE_ENDPOINTS = {
    # https://www.bseindia.com/markets/derivatives/derireports/fiisummary  (FII derivatives summary)
    "bse_fii_summary": "TODO_PASTE_XHR_URL_FROM_FIISUMMARY_PAGE",
    # BSE Sensex / index heatmap (markets/equity/... heatmap page)
    "bse_heatmap_sensex": "TODO_PASTE_XHR_URL_FROM_BSE_HEATMAP_PAGE",
    # optional: Sensex option chain / live derivatives reports
    "bse_live_deri_report": "TODO_PASTE_XHR_URL",
}

def bse_get(path):
    if path.startswith("TODO"):
        return {"_error": "BSE endpoint not configured"}
    try:
        r = requests.get(path, headers=BSE_HEADERS, timeout=20)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {"_error": f"failed {path}"}

def session():
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get(BASE, timeout=15)                       # cookie warm-up
    s.get(BASE + "/option-chain", timeout=15)
    return s

def get(s, path, retries=3, with_attempts=False):
    attempts = 0
    payload = None
    for i in range(retries):
        attempts = i + 1
        try:
            r = s.get(BASE + path, timeout=20)
            if r.status_code == 200:
                payload = r.json()
                break
        except Exception:
            pass
        time.sleep(2 * (i + 1))
        try:
            s.get(BASE, timeout=15)               # refresh cookies
        except Exception:
            pass
    if payload is None:
        payload = {"_error": f"failed {path}"}
    if with_attempts:
        return payload, attempts
    return payload


def _payload_timestamp(payload):
    """Best-effort data timestamp from an NSE payload (never invented)."""
    if not isinstance(payload, dict):
        return None
    for key in ("timestamp", "time", "last_update", "lastUpdate",
                "last_updated", "as_of", "updateTime"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    records = payload.get("records")
    if isinstance(records, dict):
        for key in ("timestamp", "time", "last_update", "lastUpdate"):
            value = records.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


_STATUS_RANK = {"LIVE": 4, "FALLBACK": 3, "STALE": 2, "MISSING": 1, "UNAVAILABLE": 0}


def _record_fetch(input_name, endpoint_key, path, payload, attempts, fetch_ts):
    """Build one provenance record for a fetched endpoint."""
    if isinstance(payload, dict) and "_error" in payload:
        return _prov.record_input(
            input_name, "NSE India", None, fetch_ts,
            status=_prov.UNAVAILABLE, attempts=attempts, url=path,
            detail="fetch failed %s" % path, now=fetch_ts)
    data_ts = _payload_timestamp(payload)
    detail = None
    is_fallback = attempts > 1
    if data_ts is None:
        data_ts = fetch_ts
        detail = "payload has no timestamp - data_timestamp=fetch_time"
    return _prov.record_input(
        input_name, "NSE India", data_ts, fetch_ts,
        is_fallback=is_fallback, attempts=attempts, url=path,
        detail=detail, now=fetch_ts)

def fao_participant_oi(s, d=None):
    """Latest participant-wise OI CSV from archives (end-of-day)."""
    d = d or datetime.date.today()
    for back in range(0, 6):
        day = d - datetime.timedelta(days=back)
        url = f"https://archives.nseindia.com/content/nsccl/fao_participant_oi_{day.strftime('%d%m%Y')}.csv"
        try:
            r = s.get(url, timeout=20)
            if r.status_code == 200 and len(r.text) > 100:
                return {"date": str(day), "csv": r.text}
        except Exception:
            pass
    return {"_error": "participant OI not found"}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="NIFTY")
    ap.add_argument("--out", default="snapshot.json")
    ap.add_argument("--news", default=None,
                    help="JSON file of news events to attach as context (never fabricated)")
    a = ap.parse_args()
    s = session()
    fetched_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    snap = {"fetched_at_ist": fetched_at, "symbol": a.symbol}
    provenance = {}

    def stamp(input_name, endpoint_key, path, payload, attempts):
        record = _record_fetch(input_name, endpoint_key, path, payload,
                               attempts, fetched_at)
        existing = provenance.get(input_name)
        if existing is None or _STATUS_RANK.get(record.get("status"), 0) > \
                _STATUS_RANK.get(existing.get("status"), 0):
            provenance[input_name] = record

    for k, p in ENDPOINTS.items():
        payload, attempts = get(s, p.format(symbol=a.symbol), with_attempts=True)
        snap[k] = payload
        input_name = _prov.SECTION_INPUT_MAP.get(k, k)
        if k.startswith("heatmap"):
            input_name = "heatmap"
        stamp(input_name, k, p.format(symbol=a.symbol), payload, attempts)
        time.sleep(1.2)
    snap["participant_oi"] = fao_participant_oi(s)
    stamp("participant_oi", "participant_oi",
          "archives.nseindia.com/content/nsccl/fao_participant_oi_*.csv",
          snap["participant_oi"], 1)
    for k, p in BSE_ENDPOINTS.items():
        payload = bse_get(p)
        snap[k] = payload
        stamp(k, k, p, payload, 1)

    if a.news:
        try:
            snap["news"] = json.load(open(a.news))
            provenance["news"] = _prov.record_input(
                "news", "file:%s" % a.news, fetched_at, fetched_at,
                now=fetched_at, detail="news attached from file, never fabricated")
        except Exception as exc:
            print("NOTE: could not read --news file:", exc)

    snap["meta"] = {
        "source": "NSE India (+ BSE placeholders)",
        "fetched_at": fetched_at,
        "provenance": provenance,
    }
    json.dump(snap, open(a.out, "w"))
    bad = [k for k, v in snap.items() if isinstance(v, dict) and "_error" in v]
    if any(k.startswith("bse_") for k in bad):
        print("NOTE: BSE items missing -> agents must treat BSE inputs as unavailable (not bullish/bearish).")
    print("saved", a.out, "| failed:", bad or "none")
    sys.exit(1 if "option_chain" in bad or "fii_dii" in bad else 0)
