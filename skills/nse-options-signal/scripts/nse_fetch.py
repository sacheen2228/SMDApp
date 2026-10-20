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
import argparse, json, time, datetime, sys, os, re
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
    # Index FUTURES chain — futures OI + traded volume per snapshot (breakout checks b & c)
    "futures_chain": "/api/quote-derivative?symbol={symbol}",
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


def _bars_from_chart(payload, tf_minutes):
    """Aggregate the NSE 1-minute chart points into tf_minutes bars.

    chart-databyindex returns {"grapthData":[{"timestamp","open","high","low","close","volume"}]}.
    Index points carry no volume -> 0 (never invented).
    """
    if not isinstance(payload, dict):
        return []
    pts = payload.get("grapthData") or []
    if not isinstance(pts, list):
        return []
    step = tf_minutes * 60
    buckets = {}
    for p in pts:
        if not isinstance(p, dict):
            continue
        try:
            ts = int(p.get("timestamp"))
        except Exception:
            continue
        o = float(p.get("open") or 0); h = float(p.get("high") or 0)
        l = float(p.get("low") or 0); c = float(p.get("close") or 0)
        v = float(p.get("volume") or 0)
        key = (ts // step) * step
        b = buckets.get(key)
        if b is None:
            buckets[key] = {"t": key, "o": o, "h": h, "l": l, "c": c, "v": v}
        else:
            b["h"] = max(b["h"], h); b["l"] = min(b["l"], l); b["c"] = c; b["v"] += v
    return [buckets[k] for k in sorted(buckets)]


_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
           "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}


def _expiry_key(text):
    """Sortable key for an NSE expiry date ('29-Oct-2026', '2026-10-29', '29-OCT-2026')."""
    s = str(text or "").strip()
    if not s:
        return (9999, 12, 31)
    m = re.match(r"^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$", s)
    if m:
        d, mon, y = int(m.group(1)), _MONTHS.get(m.group(2).upper()), int(m.group(3))
        if mon:
            return (y + 2000 if y < 100 else y, mon, d)
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return (9999, 12, 31)


def futures_summary(payload, symbol):
    """Near-month futures OI + traded volume from the derivative chain.

    Only the nearest expiry is used (the front month is what price/OI behaviour
    is read from). Missing fields stay None — never fabricated.
    """
    if not isinstance(payload, dict):
        return {"_error": "futures chain unavailable"}
    rows = payload.get("stocks") or payload.get("data") or []
    if not isinstance(rows, list) or not rows:
        return {"_error": "futures chain empty"}
    futs = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        if str(r.get("instrumentType") or "").upper() != "FUTIDX" and \
           "FUT" not in str(r.get("symbol") or "").upper():
            continue
        exp = r.get("expiryDate") or ""
        oi = r.get("openInterest") or r.get("oi") or 0
        vol = r.get("totalTradedVolume") or r.get("volume") or 0
        chg = r.get("changeinOpenInterest")
        futs.append({"expiry": exp, "oi": float(oi or 0), "volume": float(vol or 0),
                     "oi_change": (float(chg) if chg is not None else None),
                     "ltp": r.get("lastPrice"), "symbol": r.get("symbol")})
    if not futs:
        return {"_error": "no index futures rows in the chain"}
    futs.sort(key=lambda f: _expiry_key(f["expiry"]))
    near = futs[0]
    near["_error"] = None
    near["total_futures"] = len(futs)
    return near


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
    # Index futures (OI + volume) — breakout checks b & c
    if isinstance(snap.get("futures_chain"), dict):
        snap["futures"] = futures_summary(snap["futures_chain"], a.symbol)
        stamp("futures", "futures_chain",
              ENDPOINTS["futures_chain"].format(symbol=a.symbol), snap["futures"], 1)

    # 5m / 15m candles from the index chart — breakout checks a, d, e, f
    chart = snap.get("chart_nifty") if a.symbol.upper() in ("NIFTY", "NIFTYNXT50") else \
            (snap.get("chart_banknifty") if a.symbol.upper() == "BANKNIFTY" else None)
    if chart is None:
        chart = snap.get("chart_nifty") or snap.get("chart_banknifty")
    if isinstance(chart, dict) and chart.get("grapthData"):
        snap["candles_5m"] = _bars_from_chart(chart, 5)
        snap["candles_15m"] = _bars_from_chart(chart, 15)
        stamp("candles_5m", "chart", "chart-databyindex (5m aggregation)", snap["candles_5m"], 1)
        stamp("candles_15m", "chart", "chart-databyindex (15m aggregation)", snap["candles_15m"], 1)

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
