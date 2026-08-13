"""
Zero Hero Live Terminal — standalone backend
---------------------------------------------
Pulls REAL option chain data from the SMDApp Next.js backend
(localhost:3000/api/option-chain), which itself sources from
ICICI Breeze → NSE API → BSE API (three-tier fallback).

Computes Δ/Γ Taylor projection scanner locally.
No trade recommendations — pure math projections.

SETUP
-----
pip install flask requests

USAGE
-----
Ensure the SMDApp dev server is running on :3000, then:

    python app.py
    # Open http://localhost:5000

ENV
---
SMDAPP_BASE = http://localhost:3000     (default)
FLASK_PORT  = 5000                       (default)
"""

import os
import math
import datetime
from flask import Flask, jsonify, render_template, request
import requests

app = Flask(__name__)

SMDAPP_BASE = os.environ.get("SMDAPP_BASE", "http://localhost:3000")
FLASK_PORT = int(os.environ.get("FLASK_PORT", "5000"))

INSTRUMENTS = {
    "NIFTY": {"strike_step": 50, "num_strikes_each_side": 5, "lot_size": 75},
    "BANKNIFTY": {"strike_step": 100, "num_strikes_each_side": 5, "lot_size": 25},
    "FINNIFTY": {"strike_step": 50, "num_strikes_each_side": 5, "lot_size": 40},
    "MIDCPNIFTY": {"strike_step": 25, "num_strikes_each_side": 5, "lot_size": 75},
    "SENSEX": {"strike_step": 100, "num_strikes_each_side": 5, "lot_size": 20},
}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "ZeroHeroTerminal/1.0"})

# Simple cache so scanner can reuse chain data fetched moments ago
_cache = {"data": None, "ts": 0.0}


def _cached_chain(symbol: str) -> dict:
    import time
    now = time.time()
    if _cache["data"] and _cache["data"].get("symbol") == symbol and (now - _cache["ts"]) < 10:
        return _cache["data"]
    data = build_chain_data(symbol)
    _cache["data"] = data
    _cache["ts"] = now
    return data


def fetch_option_chain(symbol: str) -> dict:
    url = f"{SMDAPP_BASE}/api/option-chain?symbol={symbol}"
    resp = SESSION.get(url, timeout=30)
    resp.raise_for_status()
    body = resp.json()
    data = body.get("data", body)
    return data


def build_chain_data(symbol: str) -> dict:
    raw = fetch_option_chain(symbol)
    strikes = raw.get("data") or raw.get("chain") or raw.get("strikes") or []
    summary = raw.get("summary") or {}
    spot = float(summary.get("spotPrice") or raw.get("spotPrice") or 0)
    vix = float(summary.get("indiaVIX") or raw.get("vix") or 0)
    pcr = float(summary.get("pcr") or 0)
    max_pain = float(summary.get("maxPain") or raw.get("maxPain") or 0)
    atm = float(summary.get("atmStrike") or raw.get("atmStrike") or 0)
    expiry = str(raw.get("selectedExpiry") or raw.get("expiryDate") or "")
    data_source = str(raw.get("dataSource") or "nse-api")

    cfg = INSTRUMENTS.get(symbol, INSTRUMENTS["NIFTY"])
    step = cfg["strike_step"]

    if not atm:
        atm = round(spot / step) * step

    # Full-chain OI walls
    oi_by_strike = {}
    for s in strikes:
        k = float(s["strike"])
        ce_oi = float((s.get("ce") or {}).get("oi", 0))
        pe_oi = float((s.get("pe") or {}).get("oi", 0))
        oi_by_strike[k] = (ce_oi, pe_oi)

    total_ce_oi = sum(v[0] for v in oi_by_strike.values())
    total_pe_oi = sum(v[1] for v in oi_by_strike.values())
    if not pcr:
        pcr = round(total_pe_oi / total_ce_oi, 2) if total_ce_oi else 0

    # Max pain from full chain
    if not max_pain and oi_by_strike:
        def pain_at(t):
            return sum(max(0, t - k) * ce + max(0, k - t) * pe for k, (ce, pe) in oi_by_strike.items())
        max_pain = min(oi_by_strike.keys(), key=pain_at)

    # OI walls
    all_strikes = sorted(oi_by_strike.keys())
    resistance = max(all_strikes, key=lambda k: oi_by_strike[k][0]) if all_strikes else atm
    support = max(all_strikes, key=lambda k: oi_by_strike[k][1]) if all_strikes else atm

    # Display window (ATM ± num_strikes_each_side)
    window = [k for k in all_strikes if abs(k - atm) <= step * cfg["num_strikes_each_side"]]
    if not window:
        window = sorted(sorted(all_strikes, key=lambda k: abs(k - atm))[: cfg["num_strikes_each_side"] * 2 + 1])

    rows = []
    for k in window:
        row_data = next((s for s in strikes if float(s["strike"]) == k), None)
        if not row_data:
            continue
        ce = row_data.get("ce") or {}
        pe = row_data.get("pe") or {}
        row = {"strike": k, "atm": k == atm}

        for side, key in (("call", "ce"), ("put", "pe")):
            leg = row_data.get(key) or {}
            ltp = float(leg.get("ltp", 0))
            if ltp > 0:
                oi = float(leg.get("oi", 0))
                oi_chg = float(leg.get("oiChg") or leg.get("oi_chg", 0))
                iv = float(leg.get("iv", 0))
                delta = float(leg.get("delta", 0))
                gamma = float(leg.get("gamma", 0))
                theta = float(leg.get("theta", 0))

                # OI buildup classification
                price_chg_pct = float(leg.get("price_chg_pct", 0))
                oi_chg_pct = (oi_chg / oi * 100) if oi else 0
                if price_chg_pct >= 0 and oi_chg_pct >= 0:
                    buildup = "Long Buildup"
                elif price_chg_pct < 0 and oi_chg_pct >= 0:
                    buildup = "Short Buildup"
                elif price_chg_pct >= 0 and oi_chg_pct < 0:
                    buildup = "Short Covering"
                else:
                    buildup = "Long Unwinding"

                row[key] = {
                    "ltp": round(ltp, 2),
                    "oi": round(oi),
                    "oi_chg": round(oi_chg),
                    "iv": round(iv, 2),
                    "delta": round(delta, 3),
                    "gamma": round(gamma, 6),
                    "theta": round(theta, 2),
                    "buildup": buildup,
                }
            else:
                row[key] = {"ltp": 0, "oi": 0, "oi_chg": 0, "iv": 0, "delta": 0, "gamma": 0, "theta": 0, "buildup": "—"}
        rows.append(row)

    # Expected move (ATM straddle)
    atm_row = next((r for r in rows if r.get("atm")), None)
    if atm_row:
        straddle = round(atm_row["ce"]["ltp"] + atm_row["pe"]["ltp"], 2)
        expected_move = {
            "range": straddle,
            "upper": round(spot + straddle, 2),
            "lower": round(spot - straddle, 2),
        }
    else:
        expected_move = {"range": 0, "upper": spot, "lower": spot}

    return {
        "symbol": symbol,
        "spot": spot,
        "vix": vix,
        "atm": atm,
        "pcr": round(pcr, 2),
        "max_pain": round(max_pain) if max_pain else 0,
        "resistance": round(resistance),
        "support": round(support),
        "expected_move": expected_move,
        "expiry": expiry,
        "data_source": data_source,
        "lot_size": cfg["lot_size"],
        "chain_strike_count": len(all_strikes),
        "fetched_at": datetime.datetime.utcnow().isoformat() + "Z",
        "chain": rows,
        "scanner": build_scanner_local(rows, resistance, support),
    }


def build_scanner_local(chain_rows: list, resistance: float, support: float) -> list:
    out = []

    for row in chain_rows:
        k = row["strike"]
        for right, key in (("call", "ce"), ("put", "pe")):
            leg = row[key]
            ltp = leg["ltp"]
            delta = leg["delta"]
            gamma = leg["gamma"]
            theta = leg["theta"]

            if ltp <= 0:
                continue

            wall = resistance if right == "call" else support
            move = wall - k

            projected_chg = delta * move + 0.5 * gamma * (move ** 2)
            target = max(0.05, round(ltp + projected_chg, 2))

            sl = max(0.05, round(ltp - 2 * abs(theta), 2))

            reward = target - ltp
            risk = ltp - sl
            if risk <= 0 or reward <= 0:
                continue

            rr = round(reward / risk, 2)

            oi_rank = leg.get("oi", 0)

            out.append({
                "strike": k,
                "type": "CE" if right == "call" else "PE",
                "entry": ltp,
                "delta": delta,
                "gamma": gamma,
                "theta": theta,
                "target": target,
                "sl": sl,
                "rr": rr,
                "oi_rank": oi_rank,
                "basis": (
                    f"Δ/Γ-projected to {'resistance' if right=='call' else 'support'} "
                    f"wall {int(wall):,} ({int(move):+d} pts) "
                    f"· SL = 2x theta decay (-₹{abs(theta):.1f}/day)"
                ),
                "buildup": leg.get("buildup", "—"),
            })

    out.sort(key=lambda r: r["oi_rank"], reverse=True)
    return out[:12]


# ─── Routes ────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chain/<symbol>")
def api_chain(symbol):
    symbol = symbol.upper()
    if symbol not in INSTRUMENTS:
        return jsonify({"error": f"symbol must be one of {list(INSTRUMENTS.keys())}"}), 400
    try:
        return jsonify(build_chain_data(symbol))
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/scanner/<symbol>")
def api_scanner(symbol):
    symbol = symbol.upper()
    if symbol not in INSTRUMENTS:
        return jsonify({"error": f"symbol must be one of {list(INSTRUMENTS.keys())}"}), 400
    try:
        chain_data = _cached_chain(symbol)
        return jsonify({
            "symbol": symbol,
            "fetched_at": chain_data["fetched_at"],
            "resistance": chain_data["resistance"],
            "support": chain_data["support"],
            "spot": chain_data["spot"],
            "rows": build_scanner_local(chain_data["chain"], chain_data["resistance"], chain_data["support"]),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/health")
def api_health():
    try:
        data = _cached_chain("NIFTY")
        return jsonify({
            "status": "ok",
            "source": data["data_source"],
            "spot": data["spot"],
            "chain_strikes": data["chain_strike_count"],
        })
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500


if __name__ == "__main__":
    print(f"[zero-hero-terminal] proxying SMDApp at {SMDAPP_BASE}")
    print(f"[zero-hero-terminal] listening on http://localhost:{FLASK_PORT}")
    app.run(debug=False, port=FLASK_PORT, threaded=True)
