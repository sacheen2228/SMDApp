#!/usr/bin/env python3
"""Backtest the nse-options-signal skill on historical NSE data (extended, ~6 months).

Real data, no simulation:
- Option chain (per-strike OI, OI change, option OHLC): NSE daily FO bhavcopy
- India VIX + spot closes: Yahoo Finance (^INDIAVIX, ^NSEI)
- FII positioning: NSE participant-wise OI CSV (index futures net, scaled /100)
- Implied volatility: derived from EOD option prices via Black-Scholes inversion
  (bhavcopy has no IV column; this is real inversion, not a fabricated value)

Method (same as validated 20-session test): for each session D, build the skill's
snapshot as of D 14:00 IST, run the UNMODIFIED skill (score_signal + greeks +
levels, with a clock time-travel patch only), enter at D's close, manage on D+1
option OHLC (SL -30%, TP1 +40% half, remainder at next close; SL checked before
TP within the same bar). Breadth/heatmap/pre-open/OI-spurts/52wk are
EOD-unavailable -> score 0 per the skill's missing-data rule.

Modes run independently: |score| >= 40 (SPEC), >= 20, >= 15.
No parameter optimization. No look-ahead: signals use only data from session D.

Usage: python backtest_history.py [--sessions 125] [--out-json PATH] [--out-md PATH]
"""
import argparse, csv, datetime as real_dt, hashlib, io, json, math, os, random
import statistics as st, sys, types, zipfile, urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import greeks as greeks_mod
import score_signal as score_mod
import levels as levels_mod

CACHE = "/tmp/opencode/skill-bt"
ARCH = "https://nsearchives.nseindia.com"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
     "Referer": "https://www.nseindia.com/"}
WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def fetch(url, path, timeout=40):
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return open(path, "rb").read()
    req = urllib.request.Request(url, headers=H)
    data = urllib.request.urlopen(req, timeout=timeout).read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)
    return data


def yahoo(sym, rng="1y"):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range={rng}&interval=1d"
    j = json.loads(fetch(url.replace("^", "%5E"), os.path.join(CACHE, f"yahoo_{sym.strip('^')}_{rng}.json")))
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        if q["close"][i] is None:
            continue
        d = real_dt.datetime.fromtimestamp(t, real_dt.timezone(real_dt.timedelta(hours=5, minutes=30))).date()
        out.append({"date": d, "close": q["close"][i], "high": q["high"][i], "low": q["low"][i],
                    "open": q["open"][i]})
    return out


def fo_bhavcopy(d):
    ds = d.strftime("%Y%m%d")
    zp = os.path.join(CACHE, f"fo_{ds}.zip")
    raw = fetch(f"{ARCH}/content/fo/BhavCopy_NSE_FO_0_0_0_{ds}_F_0000.csv.zip", zp)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = z.namelist()[0]
        rows = list(csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8")))
    return rows


def participant_oi(d):
    ds = d.strftime("%d%m%Y")
    try:
        txt = fetch(f"{ARCH}/content/nsccl/fao_participant_oi_{ds}.csv",
                    os.path.join(CACHE, f"poi_{ds}.csv")).decode("utf-8", "replace")
    except Exception:
        return None
    rdr = csv.reader(io.StringIO(txt))
    rows = list(rdr)
    header = next((i for i, r in enumerate(rows) if r and r[0] == "Client Type"), None)
    if header is None:
        return None
    cols = [c.strip() for c in rows[header]]
    out = []
    for r in rows[header + 1:]:
        if not r or r[0] not in ("Client", "DII", "FII", "Pro"):
            continue
        rec = dict(zip(cols, [x.strip() for x in r]))
        try:
            li = int(rec["Future Index Long"]); sh = int(rec["Future Index Short"])
        except Exception:
            continue
        out.append({"category": r[0], "netValue": round((li - sh) / 100, 1),
                    "contracts_long": li, "contracts_short": sh})
    return out or None


# ---------- IV inversion (real BS math on real option closes) ----------
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_px(S, K, T, sig, r, cp):
    if T <= 0 or sig <= 0:
        return max(0.0, (S - K) if cp == "CE" else (K - S))
    d1 = (math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * math.sqrt(T))
    d2 = d1 - sig * math.sqrt(T)
    if cp == "CE":
        return S * N(d1) - K * math.exp(-r * T) * N(d2)
    return K * math.exp(-r * T) * N(-d2) - S * N(-d1)


def implied_vol(px, S, K, T, r, cp):
    intr = max(0.0, (S - K) if cp == "CE" else (K - S))
    if px <= intr + 0.05 or T <= 0:
        return None
    lo, hi = 0.01, 5.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if bs_px(S, K, T, mid, r, cp) > px:
            hi = mid
        else:
            lo = mid
    return round((lo + hi) / 2 * 100, 2)


def iso_to_ddmmyyyy(iso):
    d = real_dt.date.fromisoformat(iso)
    return d.strftime("%d-%b-%Y")


def build_chain(nifty_rows, sim_dt, spot, r=0.07):
    """NIFTY index options -> skill option_chain shape with IV inverted per strike."""
    exps = sorted({x["XpryDt"] for x in nifty_rows if x.get("XpryDt")})
    by_exp = {}
    for x in nifty_rows:
        try:
            k = float(x["StrkPric"])
        except Exception:
            continue
        if x.get("OptnTp") not in ("CE", "PE"):
            continue
        by_exp.setdefault(x["XpryDt"], {}).setdefault(k, {})[x["OptnTp"]] = x
    data = []
    for iso, strikes in by_exp.items():
        exp_dt = real_dt.datetime.combine(real_dt.date.fromisoformat(iso), real_dt.time(15, 30))
        T = max((exp_dt - sim_dt).total_seconds() / (365 * 24 * 3600), 1e-6)
        for k, sides in strikes.items():
            row = {"strikePrice": int(k) if k == int(k) else k, "expiryDate": iso_to_ddmmyyyy(iso)}
            for side in ("CE", "PE"):
                x = sides.get(side)
                if not x:
                    continue
                try:
                    px = float(x["ClsPric"]); oi = int(float(x["OpnIntrst"] or 0))
                    oi_chg = int(float(x["ChngInOpnIntrst"] or 0)); vol = int(float(x["TtlTradgVol"] or 0))
                except Exception:
                    continue
                iv = implied_vol(px, spot, k, T, r, side)
                row[side] = {"openInterest": oi, "changeinOpenInterest": oi_chg, "lastPrice": px,
                             "totalTradedVolume": vol, "impliedVolatility": iv or 0,
                             "bidprice": 0, "askPrice": 0}
            if "CE" in row or "PE" in row:
                data.append(row)
    return {"records": {"underlyingValue": round(spot, 2),
                        "expiryDates": [iso_to_ddmmyyyy(e) for e in exps],
                        "data": data}}


# ---------- clock time-travel (harness only; skill files untouched) ----------
class _TT:
    _now = None
    @classmethod
    def now(cls):
        return cls._now
    @classmethod
    def strptime(cls, s, f):
        return real_dt.datetime.strptime(s, f)


def run_skill(snapshot, sim_dt):
    """Mirror of score_signal.main() logic (same functions, same order),
    with the clock pinned to sim_dt. Missing-option-chain handled as main() does."""
    _TT._now = sim_dt
    ns = types.SimpleNamespace(datetime=_TT, time=real_dt.time, timedelta=real_dt.timedelta)
    score_mod.datetime = ns
    greeks_mod.datetime = ns
    snap = snapshot
    gates = []
    now = _TT.now().time()
    if now < real_dt.time(9, 30):
        gates.append("before 09:30 IST")
    if now > real_dt.time(14, 45):
        gates.append("after 14:45 IST")
    try:
        oc, lv = score_mod.option_chain_score(snap["option_chain"])
    except Exception:
        return {"bias_score": None, "components": None, "greeks": None, "levels": None,
                "action": "NO_TRADE", "gates_failed": gates + ["option chain unavailable"]}, None
    f = score_mod.fii_score(snap["fii_dii"]) if isinstance(snap.get("fii_dii"), list) else 0
    b = score_mod.breadth_score(snap.get("gainers", {}), snap.get("losers", {}))
    gk, gscore = None, 0
    try:
        vix = next((x["last"] for x in snap.get("all_indices", {}).get("data", []) if x.get("index") == "INDIA VIX"), None)
        gk = greeks_mod.analyse(snap["option_chain"], vix=vix)
        gscore, gates = gk["greek_score"], gates + gk["gates_failed"]
    except Exception:
        gk, gscore = gk, 0
    score = oc + f + b + gscore
    action = "BUY_CE" if score >= 40 else "BUY_PE" if score <= -40 else "NO_TRADE"
    if gates:
        action = "NO_TRADE"
    result = {"bias_score": score,
              "components": {"option_chain": oc, "fii": f, "breadth": b, "greeks": gscore},
              "greeks": gk and {k: gk[k] for k in ("atm_iv", "skew_put_minus_call", "gamma_flip", "regime",
                                                   "expected_move_1sigma", "hours_to_expiry")},
              "levels": lv, "action": action, "gates_failed": gates}
    return result, gk


def sim_from_ohlc(entry, h, l, c):
    """Same trade model as validated 20-session test: SL -30%, TP1 +40% on half,
    rest at next close; conservative same-bar ordering (SL checked before TP)."""
    if entry is None or entry <= 0 or h is None or l is None or c is None:
        return None
    sl = entry * 0.70
    tp1 = entry * 1.40
    if l <= sl:
        return {"exit": "SL", "exit_px": round(sl, 2), "pnl_pct": round((sl / entry - 1) * 100, 2)}
    if h >= tp1:
        pnl = 0.5 * ((tp1 / entry - 1) * 100) + 0.5 * ((c / entry - 1) * 100)
        return {"exit": "TP1+CLOSE", "exit_px": round(0.5 * tp1 + 0.5 * c, 2), "pnl_pct": round(pnl, 2)}
    return {"exit": "TIME_CLOSE", "exit_px": round(c, 2), "pnl_pct": round((c / entry - 1) * 100, 2)}


def index_rows(day_rows):
    m = {}
    for x in day_rows:
        if x.get("TckrSymb") != "NIFTY" or x.get("OptnTp") not in ("CE", "PE"):
            continue
        try:
            m[(x["XpryDt"], float(x["StrkPric"]), x["OptnTp"])] = x
        except Exception:
            pass
    return m


def contract_ohlc(row):
    if not row:
        return None
    try:
        return {"entry": float(row["ClsPric"]), "d1h": float(row["HghPric"]),
                "d1l": float(row["LwPric"]), "d1c": float(row["ClsPric"])}
    except Exception:
        return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()


def skill_hashes():
    out = {}
    for rel in ["SKILL.md", "references/data-sources.md", "references/output-schema.md",
                "references/scoring-rules.md", "references/strategies.md",
                "scripts/score_signal.py", "scripts/greeks.py", "scripts/levels.py",
                "scripts/nse_fetch.py"]:
        out[rel] = sha256(os.path.join(SKILL_ROOT, rel))
    return out


def pct_rank(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    i = (len(s) - 1) * p
    lo = int(i); hi = min(lo + 1, len(s) - 1); fr = i - lo
    return round(s[lo] * (1 - fr) + s[hi] * fr, 2)


def bootstrap_ci(vals, seed=42, n_boot=10000):
    if len(vals) < 2:
        return None
    rng = random.Random(seed)
    n = len(vals)
    means = sorted(sum(rng.choices(vals, k=n)) / n for _ in range(n_boot))
    return [round(pct_rank(means, 0.025), 2), round(pct_rank(means, 0.975), 2)]


def pf(trades):
    g = sum(t["pnl_pct"] for t in trades if t["pnl_pct"] > 0)
    l = sum(t["pnl_pct"] for t in trades if t["pnl_pct"] < 0)
    if l == 0:
        return "inf (no losers)" if g > 0 else None
    return round(g / abs(l), 2)


def max_dd(trades):
    eq, peak, dd = 1.0, 1.0, 0.0
    for t in trades:
        eq *= 1 + t["pnl_pct"] / 100
        peak = max(peak, eq)
        dd = max(dd, (peak - eq) / peak)
    return round(dd * 100, 2)


def max_consec_loss(trades):
    best = cur = 0
    for t in trades:
        if t["pnl_pct"] <= 0:
            cur += 1; best = max(best, cur)
        else:
            cur = 0
    return best


def mode_stats(trades, sessions, score_vals, months):
    n = len(trades)
    returns = [t["pnl_pct"] for t in trades]
    wins = [x for x in returns if x > 0]
    losses = [x for x in returns if x <= 0]
    eq = 1.0
    for x in returns:
        eq *= 1 + x / 100
    avg = round(sum(returns) / n, 2) if n else None
    out = {
        "total_sessions": sessions,
        "signals": n,
        "signals_per_month": round(n / months, 2) if months else None,
        "ce_signals": sum(1 for t in trades if t["side"] == "CE"),
        "pe_signals": sum(1 for t in trades if t["side"] == "PE"),
        "win_rate_pct": round(100 * len(wins) / n, 1) if n else None,
        "loss_rate_pct": round(100 * len(losses) / n, 1) if n else None,
        "avg_return_pct": avg,
        "median_return_pct": pct_rank(returns, 0.5),
        "total_return_pct": round(sum(returns), 1),
        "compounded_return_pct": round((eq - 1) * 100, 1),
        "profit_factor": pf(trades),
        "max_drawdown_pct": max_dd(trades),
        "max_consecutive_losses": max_consec_loss(trades),
        "tp1_count": sum(1 for t in trades if t["exit"] == "TP1+CLOSE"),
        "tp1_rate_pct": round(100 * sum(1 for t in trades if t["exit"] == "TP1+CLOSE") / n, 1) if n else None,
        "sl_count": sum(1 for t in trades if t["exit"] == "SL"),
        "sl_rate_pct": round(100 * sum(1 for t in trades if t["exit"] == "SL") / n, 1) if n else None,
        "exit_close_count": sum(1 for t in trades if t["exit"] == "TIME_CLOSE"),
        "exit_close_rate_pct": round(100 * sum(1 for t in trades if t["exit"] == "TIME_CLOSE") / n, 1) if n else None,
        "avg_score_on_signals": round(sum(t["score"] for t in trades) / n, 1) if n else None,
        "min_score_overall": min(score_vals) if score_vals else None,
        "max_score_overall": max(score_vals) if score_vals else None,
        "avg_score_overall": round(sum(score_vals) / len(score_vals), 1) if score_vals else None,
        "no_trade_pct": round(100 * (sessions - n) / sessions, 1) if sessions else None,
        "trades": trades,
    }
    if n >= 2:
        out["avg_win"] = round(sum(wins) / len(wins), 2) if wins else None
        out["avg_loss"] = round(sum(losses) / len(losses), 2) if losses else None
        out["largest_win"] = round(max(returns), 2)
        out["largest_loss"] = round(min(returns), 2)
        wr = (len(wins) / len(losses)) if losses else None
        out["win_loss_ratio"] = round(wr, 2) if wr else ("inf" if wins else None)
        out["expectancy_pct"] = avg
        out["stdev_pct"] = round(st.stdev(returns), 2)
        out["p25_pct"] = pct_rank(returns, 0.25)
        out["p75_pct"] = pct_rank(returns, 0.75)
        out["bootstrap95_ci_avg_pct"] = bootstrap_ci(returns)
        out["sample_warning"] = None if n >= 30 else f"n={n} < 30: statistics not reliable"
    elif n == 1:
        out["sample_warning"] = "n=1: no statistical conclusion possible"
    else:
        out["sample_warning"] = "n=0: no trades at this threshold"
    return out


def side_stats(trades):
    n = len(trades)
    if not n:
        return {"count": 0, "win_rate_pct": None, "avg_return_pct": None,
                "total_return_pct": 0, "profit_factor": None}
    return {"count": n,
            "win_rate_pct": round(100 * sum(1 for t in trades if t["pnl_pct"] > 0) / n, 1),
            "avg_return_pct": round(sum(t["pnl_pct"] for t in trades) / n, 2),
            "total_return_pct": round(sum(t["pnl_pct"] for t in trades), 1),
            "profit_factor": pf(trades)}


def regime_split(trades, keyfn, buckets):
    out = {}
    for label, pred in buckets.items():
        sel = [t for t in trades if pred(t)]
        out[label] = side_stats(sel)
        out[label]["share_pct"] = round(100 * len(sel) / len(trades), 1) if trades else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=125, help="trading sessions (pairs) to test")
    ap.add_argument("--thresholds", default="40,20,15")
    ap.add_argument("--out-json", default=os.path.join(SKILL_ROOT, "backtest_report.json"))
    ap.add_argument("--out-md", default=os.path.join(SKILL_ROOT, "backtest_report.md"))
    a = ap.parse_args()
    thresholds = [int(x) for x in a.thresholds.split(",")]

    hash_before = skill_hashes()

    # ---- data ----
    spot_px = yahoo("^NSEI", "1y")
    vix_px = yahoo("^INDIAVIX", "1y")
    vix_by = {p["date"]: p["close"] for p in vix_px}
    dates = [p["date"] for p in spot_px]
    spot_by = {p["date"]: p["close"] for p in spot_px}
    pairs = [(dates[i], dates[i + 1]) for i in range(max(0, len(dates) - a.sessions - 1), len(dates) - 1)]
    pairs = pairs[-a.sessions:]
    print(f"yahoo bars={len(dates)}  pairs={len(pairs)}  span {pairs[0][0]} .. {pairs[-1][1]}", flush=True)

    # prefetch downloads (parallel; caches to disk)
    def pre(d):
        try:
            fo_bhavcopy(d)
        except Exception as e:
            print(f"  prefetch FO {d}: {e}", flush=True)
        try:
            participant_oi(d)
        except Exception:
            pass
    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(pre, [d for p in pairs for d in p]))

    # ---- sessions ----
    sessions, missing = [], []
    for D, D1 in pairs:
        rec0 = {"date": str(D), "next": str(D1), "weekday": WD[D.weekday()]}
        try:
            rows = fo_bhavcopy(D)
        except Exception as e:
            missing.append({**rec0, "reason": f"FO bhavcopy unavailable: {e}"})
            continue
        # data integrity: bhavcopy TradDt must equal session date
        traddt_ok = bool(rows) and all(x.get("TradDt") == D.isoformat() for x in rows[:50])
        nifty = [x for x in rows if x.get("TckrSymb") == "NIFTY"]
        spot = spot_by.get(D)
        if not nifty or not spot:
            missing.append({**rec0, "reason": "no NIFTY rows or no Yahoo spot"})
            continue
        prev_dates = [d for d in dates if d < D]
        prev_close = spot_by[prev_dates[-1]] if prev_dates else None
        day_move = round((spot / prev_close - 1) * 100, 3) if prev_close else None
        sim_dt = real_dt.datetime.combine(D, real_dt.time(14, 0))
        chain = build_chain(nifty, sim_dt, spot)
        poi = participant_oi(D)
        snap = {"option_chain": chain,
                "fii_dii": poi,
                "all_indices": {"data": [{"index": "INDIA VIX", "last": vix_by.get(D)}] if vix_by.get(D) else []},
                "gainers": {}, "losers": {}}
        try:
            res, gk = run_skill(snap, sim_dt)
        except Exception as e:
            missing.append({**rec0, "reason": f"skill error {type(e).__name__}: {e}"})
            continue
        exps = sorted({x["XpryDt"] for x in nifty if x.get("XpryDt") and x.get("OptnTp") in ("CE", "PE")})
        nearest = exps[0] if exps else None
        d_map = index_rows(nifty)
        try:
            d1_map = index_rows(fo_bhavcopy(D1))
        except Exception as e:
            missing.append({**rec0, "reason": f"D+1 bhavcopy unavailable: {e}"})
            continue
        atm = gk["atm_strike"] if gk else spot
        cands = [k for k in d_map if k[0] == nearest]
        if cands:
            atm = min(cands, key=lambda k: abs(k[1] - spot))[1]
        def side_data(side):
            e = contract_ohlc(d_map.get((nearest, atm, side)))
            if not e:
                return None
            n1 = d1_map.get((nearest, atm, side))
            if not n1:
                e["d1h"] = e["d1l"] = e["d1c"] = None
            else:
                try:
                    e["d1h"] = float(n1["HghPric"]); e["d1l"] = float(n1["LwPric"]); e["d1c"] = float(n1["ClsPric"])
                except Exception:
                    e["d1h"] = e["d1l"] = e["d1c"] = None
            return e
        score = res["bias_score"]
        sessions.append({
            **rec0,
            "spot": spot, "day_move_pct": day_move,
            "score": score, "components": res["components"],
            "gates": res["gates_failed"], "action": res["action"],
            "vix": vix_by.get(D),
            "expiry": nearest,
            "expiry_weekday": WD[real_dt.date.fromisoformat(nearest).weekday()] if nearest else None,
            "is_expiry_session": nearest == D.isoformat(),
            "atm": atm,
            "ce": side_data("CE"), "pe": side_data("PE"),
            "fii_missing": not isinstance(poi, list),
            "traddt_ok": traddt_ok,
            "next_ret_pct": round((spot_by[D1] / spot - 1) * 100, 3),
        })
        print(f"  {D} score={score if score is not None else 'ERR':>4} act={res['action']:<7} "
              f"gates={res['gates_failed'] or '-'}", flush=True)

    # ---- integrity ----
    hash_after = skill_hashes()
    integrity = {
        "hashes_before": hash_before,
        "hashes_after": hash_after,
        "skill_scripts_byte_identical": hash_before == hash_after,
        "sessions_with_bad_traddt": [s["date"] for s in sessions if not s["traddt_ok"]],
        "expiry_weekdays_observed": dict(Counter(s["expiry_weekday"] for s in sessions if s["expiry_weekday"])),
        "missing_sessions": missing,
        "look_ahead": "signals computed from session-D data only (bhavcopy D, spot D 14:00, VIX D, FII D); "
                      "D+1 OHLC used only for post-entry trade management",
        "synthetic_data": "none - all prices/OI from NSE bhavcopy archives and Yahoo Finance; "
                          "IV back-derived from real option closes via Black-Scholes inversion",
    }

    n_sess = len(sessions)
    score_vals = [s["score"] for s in sessions if s["score"] is not None]

    # ---- direction analysis ----
    dir_acc = {"score_sign": None, "ce_next_dir": None, "pe_next_dir": None}
    hits = tot = 0
    for s in sessions:
        if s["score"]:
            tot += 1
            if (s["score"] > 0) == (s["next_ret_pct"] > 0):
                hits += 1
    if tot:
        dir_acc["score_sign"] = {"hits": hits, "total": tot, "pct": round(100 * hits / tot, 1),
                                 "note": "score sign = regime/bias indicator, not necessarily a next-session predictor"}

    # ---- gates ----
    gate_counter = Counter()
    for s in sessions:
        for g in (s["gates"] or []):
            gate_counter[g] += 1
    missing_groups = {
        "breadth (gainers/losers)": {"implemented_in_score_signal": True, "available_eod": False,
                                     "sessions_scored_0": n_sess},
        "heatmap (NSE+BSE)": {"implemented_in_score_signal": False, "available_eod": False,
                              "sessions_scored_0": n_sess},
        "OI spurts": {"implemented_in_score_signal": False, "available_eod": False,
                      "sessions_scored_0": n_sess},
        "pre-open": {"implemented_in_score_signal": False, "available_eod": False,
                     "sessions_scored_0": n_sess},
        "52-week": {"implemented_in_score_signal": False, "available_eod": False,
                    "sessions_scored_0": n_sess},
        "BSE FII": {"implemented_in_score_signal": False, "available_eod": False,
                    "sessions_scored_0": n_sess},
        "participant-OI FII": {"implemented_in_score_signal": True, "available_eod": True,
                               "sessions_scored_0": sum(1 for s in sessions if s["fii_missing"])},
    }

    # ---- buy-and-hold ----
    bh_start, bh_end = pairs[0][0], pairs[-1][1]
    buyhold_pct = round((spot_by[bh_end] / spot_by[bh_start] - 1) * 100, 2)

    # ---- modes ----
    modes = {}
    for th in thresholds:
        trades = []
        for s in sessions:
            if s["gates"]:
                continue
            sc = s["score"]
            if sc is None:
                continue
            if sc >= th:
                side, data = "CE", s["ce"]
            elif sc <= -th:
                side, data = "PE", s["pe"]
            else:
                continue
            if not data or data.get("d1h") is None:
                continue
            sim = sim_from_ohlc(data["entry"], data["d1h"], data["d1l"], data["d1c"])
            if not sim:
                continue
            trades.append({
                "date": s["date"], "next": s["next"], "signal": f"BUY_{side}",
                "score": sc, "side": side, "option": f"NIFTY {int(s['atm'])}{side}",
                "strike": s["atm"], "expiry": s["expiry"],
                "entry": round(data["entry"], 2),
                "sl": round(data["entry"] * 0.7, 2), "tp1": round(data["entry"] * 1.4, 2),
                "exit": sim["exit"], "exit_px": sim["exit_px"],
                "pnl_pct": sim["pnl_pct"],
                "result": "WIN" if sim["pnl_pct"] > 0 else "LOSS",
                "next_spot_ret": s["next_ret_pct"],
                "vix": s["vix"], "weekday": s["weekday"],
                "is_expiry_session": s["is_expiry_session"],
                "day_move_pct": s["day_move_pct"],
            })
        ms = mode_stats(trades, n_sess, score_vals, max(n_sess / 21.0, 0.1))
        # direction per mode
        ce_t = [t for t in trades if t["side"] == "CE"]
        pe_t = [t for t in trades if t["side"] == "PE"]
        # CE/PE next-session direction accuracy within mode
        ce_hit = sum(1 for t in ce_t if t["next_spot_ret"] > 0)
        pe_hit = sum(1 for t in pe_t if t["next_spot_ret"] < 0)
        # benchmarks (strawman long-CE / long-PE on every session with entry data, no gates)
        base_ce = [sim_from_ohlc(s["ce"]["entry"], s["ce"]["d1h"], s["ce"]["d1l"], s["ce"]["d1c"])
                   for s in sessions if s.get("ce") and s["ce"].get("d1h") is not None]
        base_ce = [x for x in base_ce if x]
        base_pe = [sim_from_ohlc(s["pe"]["entry"], s["pe"]["d1h"], s["pe"]["d1l"], s["pe"]["d1c"])
                   for s in sessions if s.get("pe") and s["pe"].get("d1h") is not None]
        base_pe = [x for x in base_pe if x]
        def bench(xs):
            return {"signals": len(xs),
                    "win_rate_pct": round(100 * sum(1 for x in xs if x["pnl_pct"] > 0) / len(xs), 1) if xs else None,
                    "avg_return_pct": round(sum(x["pnl_pct"] for x in xs) / len(xs), 2) if xs else None,
                    "total_return_pct": round(sum(x["pnl_pct"] for x in xs), 1) if xs else 0,
                    "profit_factor": pf([{"pnl_pct": x["pnl_pct"]} for x in xs])}
        # regimes (documented, analysis-only, NOT strategy inputs)
        def bull(t):
            return t["day_move_pct"] is not None and t["day_move_pct"] > 0.25
        def bear(t):
            return t["day_move_pct"] is not None and t["day_move_pct"] < -0.25
        def flat(t):
            return t["day_move_pct"] is not None and abs(t["day_move_pct"]) <= 0.25
        mode_regimes = {
            "by_session_direction": regime_split(trades, None, {
                "bullish_day(> +0.25%)": bull, "bearish_day(< -0.25%)": bear, "sideways(±0.25%)": flat}),
            "by_vix_skill_thresholds": regime_split(trades, None, {
                "higher_vix(>20, greeks.py)": lambda t: t["vix"] and t["vix"] > 20,
                "mid_vix(12-20)": lambda t: t["vix"] and 12 <= t["vix"] <= 20,
                "lower_vix(<12, greeks.py)": lambda t: t["vix"] and t["vix"] < 12,
                "vix_unknown": lambda t: not t["vix"]}),
            "by_expiry": regime_split(trades, None, {
                "expiry_day_session": lambda t: t["is_expiry_session"],
                "non_expiry_session": lambda t: not t["is_expiry_session"]}),
            "by_weekday": regime_split(trades, None, {w: (lambda t, w=w: t["weekday"] == w) for w in WD[:5]}),
        }
        modes[f"±{th}"] = {"stats": ms,
                           "ce_side": side_stats(ce_t),
                           "pe_side": side_stats(pe_t),
                           "direction": {"ce_next_session_up_pct": round(100 * ce_hit / len(ce_t), 1) if ce_t else None,
                                         "pe_next_session_down_pct": round(100 * pe_hit / len(pe_t), 1) if pe_t else None},
                           "benchmarks": {"strawman_always_long_CE": bench(base_ce),
                                          "strawman_always_long_PE": bench(base_pe),
                                          "buy_and_hold_nifty_pct": buyhold_pct},
                           "regimes": mode_regimes,
                           "trade_list": trades}

    # gates as % contribution to NO_TRADE (sessions)
    gate_pct = {g: {"sessions": c, "pct_of_sessions": round(100 * c / n_sess, 1)}
                for g, c in gate_counter.most_common()}
    band_no_trade = sum(1 for s in sessions if not s["gates"] and
                        not (s["score"] is not None and abs(s["score"]) >= 40))
    gate_summary = {
        "gates_fired": gate_pct,
        "missing_data_groups": missing_groups,
        "score_band_below_threshold_sessions": {
            "count_at_spec40": band_no_trade,
            "pct": round(100 * band_no_trade / n_sess, 1)},
        "note": "heatmap/OI-spurts/pre-open/52wk/breadth are not implemented in score_signal.py (score 0 by "
                "absence) - they suppress the achievable score ceiling rather than appearing as explicit gates",
    }

    report = {
        "generated": str(real_dt.datetime.now()),
        "period": {"first_session": str(pairs[0][0]), "last_session": str(pairs[-1][1]),
                   "sessions_tested": n_sess, "months": round(n_sess / 21.0, 1)},
        "methodology": {
            "entry": "session-D close premium (EOD bhavcopy)",
            "management": "next session D+1 option OHLC; SL -30%; TP1 +40% half; remainder at D+1 close; "
                          "SL checked before TP within the same bar (conservative)",
            "evaluation_clock": "14:00 IST on session D (inside skill's 09:30-14:45 window)",
            "expiry_gate": "skill's <3h-to-expiry theta gate preserved (fires on expiry-day sessions at 14:00)",
            "missing_data": "skill rules preserved (unavailable groups score 0; option chain missing -> NO_TRADE)",
            "no_optimization": "thresholds fixed a priori: 40 (spec), 20, 15 - no parameter tuning",
        },
        "integrity": integrity,
        "score_stats": {"min": min(score_vals) if score_vals else None,
                        "max": max(score_vals) if score_vals else None,
                        "mean": round(sum(score_vals) / len(score_vals), 1) if score_vals else None,
                        "achievable_ceiling_note": "score_signal groups: option_chain ±22, greeks ±10 (IV-inverted), "
                                                   "fii ±6, breadth 0 (EOD-unavailable); heatmap/OI-spurts/pre-open/52wk "
                                                   "not implemented -> max |score| observed bounded by ~±40"},
        "direction_analysis": dir_acc,
        "gate_summary": gate_summary,
        "modes": modes,
        "missing_sessions_reported": missing,
    }
    json.dump(report, open(a.out_json, "w"), indent=1, default=str)

    # ---------- markdown ----------
    def fmt(x):
        return "—" if x is None else str(x)

    L = []
    L.append("# nse-options-signal — 6-month backtest report\n")
    L.append(f"Generated: {report['generated']}  ")
    L.append(f"Period: **{pairs[0][0]} → {pairs[-1][1]}** · **{n_sess} sessions** "
             f"({report['period']['months']} months) · modes: ±40 (spec), ±20, ±15\n")
    L.append("## Executive Summary\n")
    m40, m20, m15 = modes["±40"]["stats"], modes["±20"]["stats"], modes["±15"]["stats"]
    L.append(f"- **SPEC ±40**: {m40['signals']} signals over {n_sess} sessions "
             f"({m40['no_trade_pct']}% NO_TRADE).")
    L.append(f"- **RELAXED ±20**: {m20['signals']} signals · {fmt(m20['win_rate_pct'])}% WR · "
             f"avg {fmt(m20['avg_return_pct'])}%/trade · total {m20['total_return_pct']}% · "
             f"maxDD {m20['max_drawdown_pct']}% · PF {fmt(m20['profit_factor'])}.")
    L.append(f"- **RELAXED ±15**: {m15['signals']} signals · {fmt(m15['win_rate_pct'])}% WR · "
             f"avg {fmt(m15['avg_return_pct'])}%/trade · total {m15['total_return_pct']}% · "
             f"maxDD {m15['max_drawdown_pct']}% · PF {fmt(m15['profit_factor'])}.")
    L.append(f"- Score sign direction accuracy: **{fmt(dir_acc['score_sign']['pct'])}%** "
             f"({dir_acc['score_sign']['hits']}/{dir_acc['score_sign']['total']}) — "
             "*score sign = regime/bias indicator, not necessarily a next-session predictor*."
             if dir_acc["score_sign"] else "- score sign accuracy: n/a")
    L.append(f"- Buy-and-hold NIFTY over period: **{buyhold_pct}%** (context only).")
    small = [f"±{th}" for th in thresholds if modes[f"±{th}"]["stats"].get("sample_warning")]
    if small:
        L.append(f"- ⚠ Sample-size warnings: {', '.join(small)} — see Statistical Summary.")
    L.append("")
    L.append("## Comparison\n")
    L.append("| Mode | Signals | CE | PE | Win% | Avg/Trade | Total | Max DD | PF |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for th in thresholds:
        s = modes[f"±{th}"]["stats"]
        L.append(f"| ±{th} | {s['signals']} | {s['ce_signals']} | {s['pe_signals']} | "
                 f"{fmt(s['win_rate_pct'])} | {fmt(s['avg_return_pct'])}% | {s['total_return_pct']}% | "
                 f"{s['max_drawdown_pct']}% | {fmt(s['profit_factor'])} |")
    L.append("")
    for th in thresholds:
        mode = modes[f"±{th}"]
        s = mode["stats"]
        L.append(f"## Trade List — mode ±{th}\n")
        if not mode["trade_list"]:
            L.append("_No trades._\n")
            continue
        L.append("| date | signal | score | option | strike | entry | SL | TP1 | exit | return | result | "
                 "next NIFTY |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for t in mode["trade_list"]:
            L.append(f"| {t['date']} | {t['signal']} | {t['score']:+d} | {t['option']} | {int(t['strike'])} | "
                     f"{t['entry']} | {t['sl']} | {t['tp1']} | {t['exit']} {t['exit_px']} | "
                     f"{t['pnl_pct']:+.1f}% | {t['result']} | {t['next_spot_ret']:+.2f}% |")
        L.append("")
    L.append("## Gate Summary\n")
    L.append("| Gate | Sessions | % of sessions |")
    L.append("|---|---|---|")
    for g, v in gate_pct.items():
        L.append(f"| {g} | {v['sessions']} | {v['pct_of_sessions']}% |")
    L.append("")
    L.append(f"Score-band (|score| below ±40) NO_TRADE sessions: {band_no_trade} "
             f"({round(100 * band_no_trade / n_sess, 1)}%).\n")
    L.append("Missing-data groups (score 0, not explicit gates):\n")
    L.append("| Group | In score_signal.py? | EOD available? | Sessions scored 0 |")
    L.append("|---|---|---|---|")
    for g, v in missing_groups.items():
        L.append(f"| {g} | {'yes' if v['implemented_in_score_signal'] else 'no'} | "
                 f"{'yes' if v['available_eod'] else 'no'} | {v['sessions_scored_0']} |")
    L.append("")
    L.append("## CE vs PE\n")
    L.append("| Mode | Side | Count | Win% | Avg | Total | PF |")
    L.append("|---|---|---|---|---|---|---|")
    for th in thresholds:
        for side, key in (("CE", "ce_side"), ("PE", "pe_side")):
            v = modes[f"±{th}"][key]
            L.append(f"| ±{th} | {side} | {v['count']} | {fmt(v['win_rate_pct'])} | "
                     f"{fmt(v['avg_return_pct'])}% | {fmt(v['total_return_pct'])}% | {fmt(v['profit_factor'])} |")
    L.append("\nRegime caveat: do not read PE superiority from a sample drawn inside one market regime.\n")
    L.append("## Direction Analysis\n")
    da = report["direction_analysis"]
    L.append(f"- Score-sign vs next-session NIFTY direction: **{fmt(da['score_sign']['pct'])}%** "
             f"({da['score_sign']['hits']}/{da['score_sign']['total']})" if da.get("score_sign") else "- n/a")
    L.append(f"  - *score sign = regime/bias indicator, not necessarily a next-session predictor*")
    for th in thresholds:
        d = modes[f"±{th}"]["direction"]
        L.append(f"- ±{th} CE signal → next session up: {fmt(d['ce_next_session_up_pct'])}% | "
                 f"PE signal → next session down: {fmt(d['pe_next_session_down_pct'])}%")
    L.append("")
    L.append("## Regime Analysis (analysis-only buckets; not strategy inputs)\n")
    L.append("Definitions: bullish/bearish/sideways = session-D move vs D-1 close (> +0.25% / < -0.25% / ±0.25%); "
             "VIX buckets use greeks.py thresholds (>20 high, <12 low); expiry = NIFTY weekly expiry session.\n")
    for th in thresholds:
        L.append(f"### Mode ±{th}\n")
        for rname, rb in modes[f"±{th}"]["regimes"].items():
            L.append(f"**{rname}**\n")
            L.append("| bucket | n | WR% | avg% | total% | PF |")
            L.append("|---|---|---|---|---|---|")
            for b, v in rb.items():
                L.append(f"| {b} | {v['count']} | {fmt(v['win_rate_pct'])} | {fmt(v['avg_return_pct'])} | "
                         f"{fmt(v['total_return_pct'])} | {fmt(v['profit_factor'])} |")
            L.append("")
    L.append("## Statistical Summary\n")
    L.append("| Metric | ±40 | ±20 | ±15 |")
    L.append("|---|---|---|---|")
    keys = ["signals", "win_rate_pct", "avg_return_pct", "median_return_pct", "p25_pct", "p75_pct",
            "avg_win", "avg_loss", "largest_win", "largest_loss", "win_loss_ratio", "expectancy_pct",
            "stdev_pct", "profit_factor", "max_drawdown_pct", "max_consecutive_losses",
            "bootstrap95_ci_avg_pct", "sample_warning"]
    for k in keys:
        L.append(f"| {k} | {fmt(modes['±40']['stats'].get(k))} | {fmt(modes['±20']['stats'].get(k))} | "
                 f"{fmt(modes['±15']['stats'].get(k))} |")
    L.append("")
    L.append("## Benchmarks\n")
    L.append("| Mode | strawman always-CE | strawman always-PE | buy&hold NIFTY |")
    L.append("|---|---|---|---|")
    for th in thresholds:
        b = modes[f"±{th}"]["benchmarks"]
        bce, bpe = b["strawman_always_long_CE"], b["strawman_always_long_PE"]
        L.append(f"| ±{th} | n={bce['signals']} WR {fmt(bce['win_rate_pct'])}% tot {bce['total_return_pct']}% | "
                 f"n={bpe['signals']} WR {fmt(bpe['win_rate_pct'])}% tot {bpe['total_return_pct']}% | "
                 f"{b['buy_and_hold_nifty_pct']}% |")
    L.append("\nAlways-long-CE/PE are **strawman benchmarks** (no filter), not realistic strategies. "
             "Benchmarks are context only — not proof of superiority.\n")
    L.append("## Data Validation\n")
    L.append(f"- Real historical data: NSE FO bhavcopy archives + Yahoo (^NSEI, ^INDIAVIX) + NSE participant-OI CSVs. "
             f"Synthetic prices: **none**.")
    L.append(f"- No look-ahead: {integrity['look_ahead']}")
    L.append(f"- TradDt == session date mismatches: {integrity['sessions_with_bad_traddt'] or 'none'}")
    L.append(f"- Expiry weekdays observed: {integrity['expiry_weekdays_observed']} (NIFTY weekly = Tuesday)")
    L.append(f"- Skill scripts byte-identical before/after run: **{integrity['skill_scripts_byte_identical']}**")
    L.append(f"- Missing sessions (reported, not fabricated): {len(missing)}")
    if missing:
        for mm in missing:
            L.append(f"  - {mm['date']}: {mm['reason']}")
    L.append("- Missing-data behavior unchanged (score 0 / NO_TRADE per skill rules).")
    L.append("")
    L.append("## Files\n")
    L.append("- `skills/nse-options-signal/scripts/backtest_history.py` (harness only)")
    L.append("- `skills/nse-options-signal/backtest_report.json`")
    L.append("- `skills/nse-options-signal/backtest_report.md`")
    L.append("\n*Research/backtest only — production strategy unchanged.*\n")
    open(a.out_md, "w").write("\n".join(L))

    print("\n===== SUMMARY =====")
    print(json.dumps({k: {kk: modes[f"±{k.strip('±')}"]["stats"][kk] for kk in
                          ("signals", "ce_signals", "pe_signals", "win_rate_pct", "avg_return_pct",
                           "total_return_pct", "compounded_return_pct", "max_drawdown_pct", "profit_factor")}
                      for k in [f"±{t}" for t in thresholds]}, indent=1))
    print("gates:", json.dumps(gate_pct, indent=1))
    print("integrity ok:", integrity["skill_scripts_byte_identical"],
          "| missing sessions:", len(missing))
    print("json:", a.out_json)
    print("md:", a.out_md)


if __name__ == "__main__":
    main()
