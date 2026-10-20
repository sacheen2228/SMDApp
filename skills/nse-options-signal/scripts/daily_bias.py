#!/usr/bin/env python3
"""
Pre-market bias from saved EOD data (table 3.6-A in your notes). Stdlib only.

  python daily_bias.py                  # reads <data>/eod/*, writes <data>/context.json, prints a summary
  python daily_bias.py --asof 2026-10-21T08:30:00+05:30

Six inputs, each scored +1 (bullish) / 0 / -1 (bearish):
  1 FII cash net          2 DII cash net        3 FII index-futures net change
  4 FII index-options tilt change (long calls & short puts = bullish)
  5 PCR at previous close (from your own EOD option chain)     6 Advance/Decline ratio (Nifty 50)

Rule: bias is set only if >= 3 inputs agree AND they outnumber the opposite side. Otherwise TWO_WAY
(demand higher confluence). A stale or missing input scores 0 and is flagged. It never guesses.

Thresholds are untested starting values (CFG). Tune them against your own history.
"""
import argparse, glob, json, os
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
DATA = os.environ.get("GEX_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"))
CFG = {
    "cash_flat_band_cr": 500,        # |net| below this = flat
    "fut_delta_contracts": 5000,     # FII index futures net change needed to count
    "opt_tilt_delta": 20000,         # FII options tilt change needed to count
    "pcr_bull": 1.1, "pcr_bear": 0.9,
    "ad_bull": 1.5, "ad_bear": 0.67,
    "min_agree": 3,
}


def load(path):
    try: return json.load(open(path))
    except Exception: return None

def trading_days(holidays):
    hs = set()
    for lst in _lists(holidays):
        for r in lst:
            v = r.get("tradingDate") or r.get("date")
            try: hs.add(datetime.strptime(v, "%d-%b-%Y").date())
            except Exception: pass
    return hs

def _lists(o):
    if isinstance(o, list):
        if o and all(isinstance(i, dict) for i in o): yield o
        for i in o: yield from _lists(i)
    elif isinstance(o, dict):
        for v in o.values(): yield from _lists(v)

def expected_data_date(asof, hol):
    """Date the newest EOD data should belong to: today if after 19:00 on a trading day, else previous trading day."""
    d = asof.date()
    is_td = lambda x: x.weekday() < 5 and x not in hol
    if is_td(d) and asof.hour >= 19: return d
    d -= timedelta(days=1)
    while not is_td(d): d -= timedelta(days=1)
    return d

def day_dirs(asof):
    ds = []
    for p in glob.glob(os.path.join(DATA, "eod", "*")):
        try: ds.append((datetime.strptime(os.path.basename(p), "%Y-%m-%d").date(), p))
        except Exception: pass
    return sorted(d for d in ds if d[0] <= asof.date())

def find(days, name):
    """Latest two saved copies of a source (newest first) from distinct run dirs, regardless of day gaps."""
    out = []
    for d, p in reversed(days):
        j = load(os.path.join(p, f"{name}.json"))
        if j: out.append((d, j))
        if len(out) == 2: break
    return out

def item(name, score, value, note, data_date, expected):
    stale = bool(data_date) and data_date < expected.isoformat()
    if stale: score, note = 0, f"STALE (data {data_date}, expected {expected}); " + note
    return {"name": name, "score": score, "value": value, "note": note, "data_date": data_date, "stale": stale}

def missing(name, why): return {"name": name, "score": 0, "value": None, "note": f"MISSING: {why}", "data_date": None, "stale": True}

def sign(x, band=0): return 1 if x > band else -1 if x < -band else 0


def compute(asof):
    hol = trading_days(load(os.path.join(DATA, "holidays.json")) or [])
    exp = expected_data_date(asof, hol)
    days = day_dirs(asof)
    items = []

    fd = find(days, "fii_dii")
    if fd:
        j = fd[0][1]
        for key, label in (("FII", "FII cash net"), ("DII", "DII cash net")):
            row = j.get(key)
            if row and row.get("net") is not None:
                s = sign(row["net"], CFG["cash_flat_band_cr"])
                items.append(item(label, s, f"{row['net']:+.0f} Cr", "net buyer" if s > 0 else "net seller" if s < 0 else "flat", j.get("data_date"), exp))
            else: items.append(missing(label, "row not in fii_dii.json"))
    else:
        items += [missing("FII cash net", "no fii_dii data"), missing("DII cash net", "no fii_dii data")]

    po = find(days, "participant_oi")
    if len(po) == 2:
        (_, cur), (_, prev) = po
        def fut_net(j): p = j["participants"]["FII"]; return p["future index long"] - p["future index short"]
        def tilt(j):
            p = j["participants"]["FII"]
            return (p["option index call long"] - p["option index call short"]) - (p["option index put long"] - p["option index put short"])
        try:
            dn = fut_net(cur) - fut_net(prev); s = sign(dn, CFG["fut_delta_contracts"])
            items.append(item("FII index futures net change", s, f"{dn:+,.0f} contracts (net {fut_net(cur):+,.0f})",
                              "adding longs / cutting shorts" if s > 0 else "adding shorts / cutting longs" if s < 0 else "little change", cur["data_date"], exp))
            dt = tilt(cur) - tilt(prev); s = sign(dt, CFG["opt_tilt_delta"])
            items.append(item("FII index options tilt change", s, f"{dt:+,.0f} contracts (tilt {tilt(cur):+,.0f})",
                              "more long calls / short puts" if s > 0 else "more short calls / long puts" if s < 0 else "little change", cur["data_date"], exp))
        except Exception as e:
            items += [missing("FII index futures net change", f"column error {e}"), missing("FII index options tilt change", f"column error {e}")]
    else:
        why = "need 2 days of participant OI" if po else "no participant OI data"
        items += [missing("FII index futures net change", why), missing("FII index options tilt change", why)]

    pm = find(days, "pcr_maxpain")
    if pm:
        j = pm[0][1]; p = j.get("pcr_oi")
        if p is not None:
            s = 1 if p > CFG["pcr_bull"] else -1 if p < CFG["pcr_bear"] else 0
            items.append(item("PCR (prev close)", s, f"PCR {p}, max pain {j.get('max_pain')}",
                              "more puts written" if s > 0 else "more calls written" if s < 0 else "neutral zone", j.get("data_date"), exp))
        else: items.append(missing("PCR (prev close)", "pcr_oi null"))
    else: items.append(missing("PCR (prev close)", "run eod_fetch.py --from-snapshot at 15:30"))

    ix = find(days, "indices")
    if ix and ix[0][1].get("ad_ratio") is not None:
        j = ix[0][1]; r = j["ad_ratio"]
        s = 1 if r > CFG["ad_bull"] else -1 if r < CFG["ad_bear"] else 0
        items.append(item("Advance/Decline (Nifty 50)", s, f"A/D {r} ({j['nifty50']['advances']:.0f} up / {j['nifty50']['declines']:.0f} down)",
                          "strong advance" if s > 0 else "strong decline" if s < 0 else "mixed", j.get("data_date"), exp))
    else: items.append(missing("Advance/Decline (Nifty 50)", "no indices data"))

    bull = sum(1 for i in items if i["score"] > 0); bear = sum(1 for i in items if i["score"] < 0)
    usable = sum(1 for i in items if not i["stale"])
    if bull >= CFG["min_agree"] and bull > bear: bias = "BULLISH"
    elif bear >= CFG["min_agree"] and bear > bull: bias = "BEARISH"
    else: bias = "TWO_WAY"
    if usable < 4: bias = "TWO_WAY"   # too little fresh data to call a direction
    ctx = {
        "generated_at": asof.isoformat(timespec="seconds"), "expected_data_date": exp.isoformat(),
        "pre_market_bias": bias, "bull_count": bull, "bear_count": bear, "usable_inputs": usable, "inputs": items,
        "agent_rules": {
            "min_confluence_of_6": 4 if bias != "TWO_WAY" else 5,
            "counter_bias_trade": "allowed only with A+ setup and half size" if bias != "TWO_WAY" else "n/a",
            "note": "Soft input. Never overrides gates, stops or the structure/OI checks."},
        "sectors": (ix[0][1].get("sectors") if ix else None),
    }
    return ctx


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--asof"); a = ap.parse_args()
    asof = datetime.fromisoformat(a.asof) if a.asof else datetime.now(IST)
    if asof.tzinfo is None: asof = asof.replace(tzinfo=IST)
    ctx = compute(asof)
    os.makedirs(DATA, exist_ok=True)
    json.dump(ctx, open(os.path.join(DATA, "context.json"), "w"), indent=1)
    print(f"Pre-market bias: {ctx['pre_market_bias']} (bull {ctx['bull_count']} / bear {ctx['bear_count']}, usable {ctx['usable_inputs']}/6)")
    for i in ctx["inputs"]:
        print(f"  {i['score']:+d}  {i['name']}: {i['value']} - {i['note']}")

if __name__ == "__main__":
    main()
