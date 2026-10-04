#!/usr/bin/env python3
"""
Live Option Data Service (pure Python 3.8+, no installs).

Runs in the background while your PC is on. Keeps these feeds fresh and writes them to
live_data.json every 2 s and serves them on http://127.0.0.1:8765 :
  spot_vix      Nifty / Bank Nifty spot + India VIX        (every ~10 s)
  chain_<SYM>   option chain, OI, change in OI, PCR, walls  (every ~60 s)
  fii_dii       FII/DII cash flow                           (end of day only)
  participant   FII/DII/Pro/Client F&O OI                   (end of day only)

HOW "LIVE" IS PROVEN: every feed carries the EXCHANGE timestamp inside the payload. Status is
computed at READ time from (now - exchange timestamp), so if a fetch hangs, the network drops,
NSE blocks you, or the PC wakes from sleep, the feed turns STALE by itself. Nothing is called
LIVE unless the market is open and the data is fresh.

Status values: LIVE | STALE | CLOSED | UNVERIFIED | NO_DATA | ERROR | EOD_OK | EOD_OLD | DEMO

Usage
  python live_service.py            run the service (dashboard: http://127.0.0.1:8765)
  python live_service.py --check    test connectivity once and print per-feed results
  python live_service.py --demo     synthetic data (always labelled DEMO, never LIVE)
Free NSE endpoints are unofficial and can change or block. A broker API is more reliable:
implement BrokerProvider below. Educational tool, not financial advice.
"""
import argparse, csv, gzip, http.cookiejar, io, json, logging, logging.handlers, math, os, random
import sys, threading, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
IST = timezone(timedelta(hours=5, minutes=30))
DEFAULTS = {
    "provider": "nse", "symbols": ["NIFTY", "BANKNIFTY"], "port": 8765,
    "output_file": "live_data.json",
    "intervals": {"spot_vix": 10, "chain": 60, "eod_check": 1800, "closed_multiplier": 10},
    "max_age_sec": {"spot_vix": 45, "chain": 180},
    "market_open": "09:15", "market_close": "15:30", "holidays": [],
    "chain_strikes_each_side": 8, "force_market_open": False,
    "nse_base": "https://www.nseindia.com", "nse_archive_base": "https://nsearchives.nseindia.com",
}
INDEX_NAME = {"NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK", "FINNIFTY": "NIFTY FINANCIAL SERVICES"}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0 Safari/537.36")
log = logging.getLogger("live")


# ----------------------------------------------------------------- time helpers
def now_ist():
    return datetime.now(IST)


def iso(dt):
    return dt.isoformat(timespec="seconds") if dt else None


def parse_ts(s):
    if not s:
        return None
    for f in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y"):
        try:
            return datetime.strptime(str(s).strip(), f).replace(tzinfo=IST)
        except ValueError:
            pass
    return None


def num(x, default=0.0):
    try:
        return float(str(x).replace(",", "").strip())
    except (ValueError, TypeError):
        return default


def market_open(cfg, now):
    if cfg.get("force_market_open"):
        return True
    if now.weekday() >= 5 or now.strftime("%Y-%m-%d") in cfg["holidays"]:
        return False
    return cfg["market_open"] <= now.strftime("%H:%M") < cfg["market_close"]


def expected_eod_date(now):
    d = now.date()
    if d.weekday() >= 5 or now.hour < 19:
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


# ----------------------------------------------------------------- parsers (pure)
def parse_indices(p):
    rows = {(r.get("index") or r.get("indexSymbol")): r for r in p.get("data", [])}
    return rows, parse_ts(p.get("timestamp"))


def parse_chain(p, n_side=8):
    rec = p["records"]
    ts = parse_ts(rec.get("timestamp"))
    und = num(rec.get("underlyingValue"))
    exps = rec.get("expiryDates", [])
    exp = exps[0]
    by = {}
    for r in rec["data"]:
        # v3 rows have no top-level expiryDate (chain is already single-expiry);
        # old API rows keep filtering by their top-level expiryDate.
        if r.get("expiryDate") not in (None, exp):
            continue
        k = num(r["strikePrice"])
        leg = lambda x: {"oi": num(x.get("openInterest")), "chg": num(x.get("changeinOpenInterest")),
                         "ltp": num(x.get("lastPrice")), "iv": num(x.get("impliedVolatility")),
                         "vol": num(x.get("totalTradedVolume"))} if x else None
        by[k] = {"strike": k, "ce": leg(r.get("CE")), "pe": leg(r.get("PE"))}
    strikes = sorted(by)
    if not strikes:
        raise ValueError("empty option chain")
    z = {"oi": 0, "chg": 0, "ltp": 0, "iv": 0, "vol": 0}
    ce = lambda k: by[k]["ce"] or z
    pe = lambda k: by[k]["pe"] or z
    tc, tp = sum(ce(k)["oi"] for k in strikes), sum(pe(k)["oi"] for k in strikes)
    atm = min(strikes, key=lambda k: abs(k - und))
    ivs = [x for x in (ce(atm)["iv"], pe(atm)["iv"]) if x > 0]
    pain = min(strikes, key=lambda K: sum(ce(s)["oi"] * max(K - s, 0) + pe(s)["oi"] * max(s - K, 0)
                                          for s in strikes))
    top = lambda f, key: [[k, f(k)[key]] for k in sorted(strikes, key=lambda k: -f(k)[key])[:3]]
    i = strikes.index(atm)
    window = [by[k] for k in strikes[max(0, i - n_side): i + n_side + 1]]
    step = min((b - a for a, b in zip(strikes, strikes[1:])), default=50)
    return ({"expiry": datetime.strptime(exp, "%d-%b-%Y").strftime("%Y-%m-%d"), "expiries": exps[:4],
             "underlying": und, "atm_strike": atm, "atm_iv": round(sum(ivs) / len(ivs), 2) if ivs else None,
             "strike_step": step, "pcr": round(tp / tc, 3) if tc else None,
             "total_call_oi": tc, "total_put_oi": tp, "max_pain": pain,
             "top_call_oi": top(ce, "oi"), "top_put_oi": top(pe, "oi"),
             "top_call_oi_change": top(ce, "chg"), "top_put_oi_change": top(pe, "chg"),
             "rows": window}, ts)


def parse_fii_dii(p):
    out, d = {}, None
    for r in p:
        cat = (r.get("category") or "").upper()
        key = "fii" if ("FII" in cat or "FPI" in cat) else "dii" if "DII" in cat else None
        if key:
            out[key] = {"buy": num(r.get("buyValue")), "sell": num(r.get("sellValue")),
                        "net": num(r.get("netValue"))}
            d = d or parse_ts(r.get("date"))
    if not out:
        raise ValueError("no FII/DII rows")
    return out, d


def parse_participant(text, d):
    rows = list(csv.reader(io.StringIO(text)))
    hi = next(i for i, r in enumerate(rows) if r and r[0].strip().lower().startswith("client type"))
    hdr = [c.strip() for c in rows[hi]]
    out = {}
    for r in rows[hi + 1:]:
        if r and r[0].strip():
            out[r[0].strip()] = {hdr[i]: num(r[i]) for i in range(1, min(len(hdr), len(r)))}
    f = out.get("FII", {})
    L, S = f.get("Future Index Long"), f.get("Future Index Short")
    summ = {"fii_index_fut_long_pct": round(L / (L + S) * 100, 1) if L is not None and S is not None and L + S > 0 else None,
            "fii_index_fut_net": (L - S) if L is not None and S is not None else None}
    return {"participants": out, "summary": summ}, datetime(d.year, d.month, d.day, tzinfo=IST)


# ----------------------------------------------------------------- providers
class NSEProvider:
    """Free, unofficial NSE endpoints. Needs a browser-like cookie warm-up; polite polling only."""
    def __init__(self, cfg):
        self.cfg = cfg
        self.base, self.arch = cfg["nse_base"], cfg["nse_archive_base"]
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.warm_at = 0.0
        self.lock = threading.Lock()

    def _open(self, url, accept="application/json, text/plain, */*", timeout=15):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip", "Referer": self.base + "/option-chain", "Connection": "keep-alive"})
        with self.opener.open(req, timeout=timeout) as r:
            raw = r.read()
            return gzip.decompress(raw) if r.headers.get("Content-Encoding") == "gzip" else raw

    def _warm(self):
        self._open(self.base + "/option-chain", accept="text/html,application/xhtml+xml,*/*")
        self.warm_at = time.time()

    def _get(self, url):
        with self.lock:
            if time.time() - self.warm_at > 240:
                self._warm()
            try:
                return self._open(url)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):          # cookie expired or blocked: re-warm once
                    self._warm()
                    return self._open(url)
                raise

    def fetch_indices(self):
        return json.loads(self._get(self.base + "/api/allIndices"))

    def fetch_chain(self, sym):
        # NSE retired /api/option-chain-indices (404); v3 is the live endpoint.
        info = json.loads(self._get(
            f"{self.base}/api/option-chain-contract-info?symbol={sym}&type=Indices"))
        exps = info.get("expiryDates") or []
        if not exps:
            raise RuntimeError(f"no expiry dates for {sym}")
        return json.loads(self._get(
            f"{self.base}/api/option-chain-v3?symbol={sym}&type=Indices&expiry={quote(exps[0])}"))

    def fetch_fii_dii(self):
        return json.loads(self._get(self.base + "/api/fiidiiTradeReact"))

    def fetch_participant(self, now):
        d = expected_eod_date(now)
        for _ in range(6):                          # walk back over holidays/weekends
            url = f"{self.arch}/content/nsccl/fao_participant_oi_{d:%d%m%Y}.csv"
            try:
                return self._get(url).decode("utf-8", "replace"), d
            except urllib.error.HTTPError as e:
                if e.code not in (403, 404):
                    raise
            d -= timedelta(days=1)
            while d.weekday() >= 5:
                d -= timedelta(days=1)
        raise RuntimeError("participant OI file not found for recent dates")


class BrokerProvider:
    """Template for a broker API (Upstox, Dhan, Kite Connect, Fyers, Angel One). Implement the same five
    methods returning NSE-shaped payloads, or add your own mapping to the parse_* functions. Keep API keys
    in environment variables, never in code or in chat."""
    def __init__(self, cfg):
        raise NotImplementedError("Implement BrokerProvider for your broker, then set provider to 'broker'.")


class DemoProvider:
    """Synthetic NSE-shaped data for testing the pipeline. Statuses are always DEMO."""
    def __init__(self, cfg):
        self.spot = {"NIFTY": 25100.0, "BANKNIFTY": 56000.0}
        self.vix = 14.0

    @staticmethod
    def _stamp():
        return now_ist().strftime("%d-%b-%Y %H:%M:%S")

    def fetch_indices(self):
        for k in self.spot:
            self.spot[k] *= 1 + random.uniform(-0.0004, 0.0004)
        self.vix = max(9, self.vix + random.uniform(-0.05, 0.05))
        d = [{"index": "NIFTY 50", "last": round(self.spot["NIFTY"], 2), "percentChange": 0.1, "previousClose": 25050},
             {"index": "NIFTY BANK", "last": round(self.spot["BANKNIFTY"], 2), "percentChange": 0.1, "previousClose": 55900},
             {"index": "INDIA VIX", "last": round(self.vix, 2), "percentChange": -0.2, "previousClose": 14.1}]
        return {"data": d, "timestamp": self._stamp()}

    def fetch_chain(self, sym):
        s, step = self.spot.get(sym, 25100.0), 50 if sym == "NIFTY" else 100
        exp = (now_ist() + timedelta(days=3)).strftime("%d-%b-%Y")
        data = []
        for i in range(-20, 21):
            k = round(s / step) * step + i * step
            w = lambda c: int(2e6 * math.exp(-((k - c) / (step * 5)) ** 2) + random.randint(0, 90000))
            data.append({"strikePrice": k, "expiryDate": exp,
                         "CE": {"openInterest": w(s + 5 * step), "changeinOpenInterest": random.randint(-90000, 200000),
                                "lastPrice": round(max(s - k, 0) + 130 * math.exp(-abs(k - s) / (step * 3.6)), 2),
                                "impliedVolatility": 14 + random.random(), "totalTradedVolume": 1000},
                         "PE": {"openInterest": w(s - 5 * step), "changeinOpenInterest": random.randint(-90000, 200000),
                                "lastPrice": round(max(k - s, 0) + 130 * math.exp(-abs(k - s) / (step * 3.6)), 2),
                                "impliedVolatility": 14 + random.random(), "totalTradedVolume": 1000}})
        return {"records": {"timestamp": self._stamp(), "underlyingValue": s, "expiryDates": [exp], "data": data}}

    def fetch_fii_dii(self):
        d = expected_eod_date(now_ist()).strftime("%d-%b-%Y")
        return [{"category": "DII", "date": d, "buyValue": "9000", "sellValue": "6200", "netValue": "2800"},
                {"category": "FII/FPI", "date": d, "buyValue": "7000", "sellValue": "9500", "netValue": "-2500"}]

    def fetch_participant(self, now):
        d = expected_eod_date(now)
        t = "Client Type,Future Index Long,Future Index Short\nFII,38000,62000\nClient,90000,70000\nPro,50000,48000\nDII,9000,12000\n"
        return "FAO - Participant wise OI\n" + t, d


# ----------------------------------------------------------------- state
class Feed:
    def __init__(self, name, max_age=0, eod=False):
        self.name, self.max_age, self.eod = name, max_age, eod
        self.value = self.data_ts = self.fetched_at = self.last_ok = self.err = None
        self.fail = 0
        self.lock = threading.Lock()

    def ok(self, value, data_ts):
        with self.lock:
            self.value, self.data_ts, self.fetched_at = value, data_ts, now_ist()
            self.last_ok, self.fail, self.err = now_ist(), 0, None

    def bad(self, err):
        with self.lock:
            self.fail += 1
            self.err = str(err)[:200]

    def status(self, now, open_, demo):
        if demo:
            return "DEMO"
        if self.value is None:
            return "ERROR" if self.fail else "NO_DATA"
        if self.eod:
            return "EOD_OK" if self.data_ts and self.data_ts.date() == expected_eod_date(now) else "EOD_OLD"
        if not open_:
            return "CLOSED"
        if self.data_ts is None:
            return "UNVERIFIED"
        return "LIVE" if (now - self.data_ts).total_seconds() <= self.max_age else "STALE"

    def describe(self, now, open_, demo, source):
        with self.lock:
            return {"status": self.status(now, open_, demo), "source": source,
                    "age_sec": round((now - self.data_ts).total_seconds()) if self.data_ts and not self.eod else None,
                    "data_ts": iso(self.data_ts), "fetched_at": iso(self.fetched_at), "last_ok": iso(self.last_ok),
                    "fail_count": self.fail, "error": self.err, "max_age_sec": self.max_age or None}


class Service:
    def __init__(self, cfg, provider, demo=False):
        self.cfg, self.p, self.demo, self.stop = cfg, provider, demo, threading.Event()
        ma = cfg["max_age_sec"]
        self.feeds = {"spot_vix": Feed("spot_vix", ma["spot_vix"])}
        for s in cfg["symbols"]:
            self.feeds["chain_" + s] = Feed("chain_" + s, ma["chain"])
        self.feeds["fii_dii"] = Feed("fii_dii", eod=True)
        self.feeds["participant"] = Feed("participant", eod=True)

    # jobs
    def job_spot_vix(self):
        rows, ts = parse_indices(self.p.fetch_indices())
        v = rows["INDIA VIX"]
        spot = {s: {"last": num(rows[INDEX_NAME[s]]["last"]), "pct_change": num(rows[INDEX_NAME[s]].get("percentChange")),
                    "prev_close": num(rows[INDEX_NAME[s]].get("previousClose"))}
                for s in self.cfg["symbols"] if INDEX_NAME.get(s) in rows}
        self.feeds["spot_vix"].ok({"spot": spot, "vix": {"last": num(v["last"]), "pct_change": num(v.get("percentChange"))}}, ts)

    def job_chain(self, sym):
        val, ts = parse_chain(self.p.fetch_chain(sym), self.cfg["chain_strikes_each_side"])
        self.feeds["chain_" + sym].ok(val, ts)

    def job_fii_dii(self):
        val, ts = parse_fii_dii(self.p.fetch_fii_dii())
        self.feeds["fii_dii"].ok(val, ts)

    def job_participant(self):
        text, d = self.p.fetch_participant(now_ist())
        val, ts = parse_participant(text, d)
        self.feeds["participant"].ok(val, ts)

    def run_once(self, name, fn, *a):
        feed = self.feeds[name]
        try:
            fn(*a)
            return True
        except Exception as e:
            feed.bad(f"{type(e).__name__}: {e}")
            log.warning("%s failed (%d): %s", name, feed.fail, feed.err)
            return False

    # snapshot
    def snapshot(self):
        now = now_ist()
        op = market_open(self.cfg, now)
        src = "demo" if self.demo else self.cfg["provider"]
        feeds = {n: f.describe(now, op, self.demo, src) for n, f in self.feeds.items()}
        req = ["spot_vix"] + ["chain_" + s for s in self.cfg["symbols"]]
        all_live = (not self.demo) and op and all(feeds[n]["status"] == "LIVE" for n in req)
        overall = "DEMO" if self.demo else "LIVE" if all_live else ("CLOSED" if not op else "DEGRADED")
        sv = self.feeds["spot_vix"].value or {}
        return {"meta": {"generated_at": iso(now), "market_open": op, "overall": overall, "all_live": all_live,
                         "provider": src, "force_market_open": bool(self.cfg.get("force_market_open")),
                         "rule": "Use for trading analysis only when all_live is true. Check your PC clock is synced."},
                "feeds": feeds, "spot": sv.get("spot", {}), "vix": sv.get("vix", {}),
                "chains": {s: self.feeds["chain_" + s].value for s in self.cfg["symbols"]},
                "fii_dii": self.feeds["fii_dii"].value, "participant": self.feeds["participant"].value}

    def selector(self, q):
        sym = (q.get("symbol", ["NIFTY"])[0]).upper()
        direction = q.get("direction", ["call"])[0].lower()
        allow_closed = q.get("allow_closed", ["0"])[0] == "1"
        snap = self.snapshot()
        f1, f2 = snap["feeds"].get("spot_vix"), snap["feeds"].get("chain_" + sym)
        if not f2:
            return {"ok": False, "reason": f"symbol {sym} not configured"}
        sts = {f1["status"], f2["status"]}
        good = sts == {"LIVE"} or (allow_closed and sts == {"CLOSED"})
        out = {"ok": good, "symbol": sym, "feed_status": {"spot_vix": f1["status"], "chain": f2["status"]},
               "data_age_sec": {"spot_vix": f1["age_sec"], "chain": f2["age_sec"]}}
        if not good:
            out["reason"] = f"Data not live ({', '.join(sorted(sts))}). Do not produce trade levels from it."
            return out
        ch, vix = snap["chains"][sym], snap["vix"]["last"]
        spot = snap["spot"][sym]["last"]
        exp = datetime.strptime(ch["expiry"], "%Y-%m-%d").replace(hour=15, minute=30, tzinfo=IST)
        days = round(max((exp - now_ist()).total_seconds() / 86400, 0.02), 3)
        rows = ch["rows"]
        ia = min(range(len(rows)), key=lambda i: abs(rows[i]["strike"] - ch["atm_strike"]))
        win = rows[max(0, ia - 3): ia + 4]
        mk = lambda leg: ",".join(f"{r['strike']:.0f}:{r[leg]['ltp']}" for r in win if r[leg] and r[leg]["ltp"] > 0)
        lot = q.get("lot_size", ["75"])[0]
        cmd = (f"python strike_selector.py --spot {spot} --vix {vix} --days {days} --direction {direction} "
               f"--target {q.get('target', ['TARGET'])[0]} --stop {q.get('stop', ['STOP'])[0]} "
               f"--hold-days {q.get('hold_days', ['0.25'])[0]} --capital {q.get('capital', ['300000'])[0]} "
               f"--lot-size {lot} --step {ch['strike_step']:.0f} "
               f"--chain \"{mk('ce' if direction == 'call' else 'pe')}\"")
        out.update({"spot": spot, "vix": vix, "days_to_expiry": days, "expiry": ch["expiry"], "atm_strike": ch["atm_strike"],
                    "atm_iv": ch["atm_iv"], "strike_step": ch["strike_step"], "pcr": ch["pcr"],
                    "chain_call": mk("ce"), "chain_put": mk("pe"), "command": cmd,
                    "note": "Verify lot size with your broker (default 75 is an assumption)."})
        return out

    # threads
    def loop(self, name, base_interval, jobs):
        while not self.stop.is_set():
            t0 = time.time()
            for j in jobs():
                self.run_once(*j)
                time.sleep(1.5)
            fails = max(self.feeds[j[0]].fail for j in jobs())
            mult = 1 if market_open(self.cfg, now_ist()) or name == "eod" else self.cfg["intervals"]["closed_multiplier"]
            wait = base_interval * mult * min(2 ** min(fails, 3), 8) - (time.time() - t0)
            self.stop.wait(max(2, wait) + random.uniform(0, 1.5))

    def writer(self):
        path = os.path.join(HERE, self.cfg["output_file"])
        while not self.stop.is_set():
            try:
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(self.snapshot(), f, indent=1)
                os.replace(tmp, path)
            except Exception as e:
                log.warning("write failed: %s", e)
            self.stop.wait(2)

    def start(self):
        iv = self.cfg["intervals"]
        specs = [("spot", iv["spot_vix"], lambda: [("spot_vix", self.job_spot_vix)]),
                 ("chain", iv["chain"], lambda: [("chain_" + s, self.job_chain, s) for s in self.cfg["symbols"]]),
                 ("eod", iv["eod_check"], lambda: [("fii_dii", self.job_fii_dii), ("participant", self.job_participant)])]
        for n, i, j in specs:
            threading.Thread(target=self.loop, args=(n, i, j), daemon=True).start()
        threading.Thread(target=self.writer, daemon=True).start()


# ----------------------------------------------------------------- HTTP + dashboard
DASH = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Live Option Data</title><style>
:root{color-scheme:light dark;font-family:system-ui,Segoe UI,sans-serif}body{margin:0;padding:16px;max-width:980px;margin:auto}
.b{padding:2px 8px;border-radius:10px;font-weight:600;font-size:12px;color:#fff}
.LIVE,.EOD_OK{background:#1a8a3c}.CLOSED{background:#666}.DEMO{background:#7b3fe4}.STALE,.EOD_OLD,.UNVERIFIED,.NO_DATA{background:#c77700}.ERROR,.DEGRADED{background:#c0261c}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{padding:6px 8px;border-bottom:1px solid #8884;text-align:left;font-size:14px}
h1{font-size:20px}#top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.k{font-size:22px;font-weight:700}.c{border:1px solid #8884;border-radius:10px;padding:10px 14px}
</style><h1>Live Option Data</h1><div id=top></div><div id=warn></div><h3>Feeds</h3><table id=f></table><h3>Levels</h3><table id=l></table>
<script>
const B=s=>`<span class="b ${s}">${s}</span>`;
async function go(){try{const d=await (await fetch('/snapshot')).json(),m=d.meta;let h=`<div class=c>Overall ${B(m.overall)}<br>all_live: <b>${m.all_live}</b></div>`;
for(const s in d.spot)h+=`<div class=c>${s}<div class=k>${d.spot[s].last}</div>${d.spot[s].pct_change}%</div>`;
if(d.vix.last)h+=`<div class=c>India VIX<div class=k>${d.vix.last}</div></div>`;top.innerHTML=h;
warn.innerHTML=(m.force_market_open?'<p style=color:#c0261c><b>force_market_open is ON (testing only)</b></p>':'')+(m.provider=='demo'?'<p style=color:#7b3fe4><b>DEMO data: not real.</b></p>':'');
f.innerHTML='<tr><th>Feed<th>Status<th>Age (s)<th>Exchange time<th>Fails<th>Last error</tr>'+Object.entries(d.feeds).map(([n,x])=>`<tr><td>${n}<td>${B(x.status)}<td>${x.age_sec??'-'}<td>${x.data_ts??'-'}<td>${x.fail_count}<td>${x.error??''}</tr>`).join('');
let r='<tr><th>Symbol<th>Expiry<th>PCR<th>Max Call OI<th>Max Put OI<th>Max pain<th>ATM IV</tr>';
for(const s in d.chains){const c=d.chains[s];if(c)r+=`<tr><td>${s}<td>${c.expiry}<td>${c.pcr}<td>${c.top_call_oi[0][0]}<td>${c.top_put_oi[0][0]}<td>${c.max_pain}<td>${c.atm_iv}</tr>`}
if(d.fii_dii)r+=`<tr><td>FII/DII net (Cr)<td colspan=6>FII ${d.fii_dii.fii?.net} | DII ${d.fii_dii.dii?.net}</tr>`;
if(d.participant)r+=`<tr><td>FII idx fut long %<td colspan=6>${d.participant.summary.fii_index_fut_long_pct}</tr>`;l.innerHTML=r}catch(e){top.innerHTML='<b>Service not reachable</b>'}}
go();setInterval(go,2000)</script>"""


def make_handler(svc):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json"):
            b = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/":
                self._send(200, DASH, "text/html")
            elif u.path == "/snapshot":
                self._send(200, json.dumps(svc.snapshot()))
            elif u.path == "/health":
                m = svc.snapshot()["meta"]
                self._send(200, json.dumps({"overall": m["overall"], "all_live": m["all_live"]}))
            elif u.path == "/selector":
                self._send(200, json.dumps(svc.selector(parse_qs(u.query))))
            else:
                self._send(404, '{"error":"not found"}')
    return H


# ----------------------------------------------------------------- main
def load_cfg(path):
    cfg = json.loads(json.dumps(DEFAULTS))
    if os.path.exists(path):
        user = json.load(open(path, encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


def build(cfg, demo):
    prov = DemoProvider(cfg) if demo else {"nse": NSEProvider, "broker": BrokerProvider}[cfg["provider"]](cfg)
    return Service(cfg, prov, demo)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--check", action="store_true", help="fetch every feed once and print results")
    ap.add_argument("--port", type=int)
    a = ap.parse_args()
    cfg = load_cfg(a.config)
    if a.port:
        cfg["port"] = a.port
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.handlers.RotatingFileHandler(os.path.join(HERE, "live_service.log"), maxBytes=500000, backupCount=2),
                                  logging.StreamHandler(sys.stdout) if sys.stdout else logging.NullHandler()])
    svc = build(cfg, a.demo)
    if a.check:
        jobs = [("spot_vix", svc.job_spot_vix)] + [("chain_" + s, svc.job_chain, s) for s in cfg["symbols"]] + \
               [("fii_dii", svc.job_fii_dii), ("participant", svc.job_participant)]
        for j in jobs:
            ok = svc.run_once(*j)
            f = svc.feeds[j[0]]
            print(f"{j[0]:<16} {'OK ' if ok else 'FAIL'}  exchange_ts={iso(f.data_ts)}  {f.err or ''}")
        print("\nmarket_open:", market_open(cfg, now_ist()), "| overall:", svc.snapshot()["meta"]["overall"])
        return
    svc.start()
    srv = ThreadingHTTPServer(("127.0.0.1", cfg["port"]), make_handler(svc))
    log.info("Live service running: http://127.0.0.1:%d  provider=%s demo=%s", cfg["port"], cfg["provider"], a.demo)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        svc.stop.set()


if __name__ == "__main__":
    main()
