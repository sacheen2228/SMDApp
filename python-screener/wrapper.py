"""
wrapper.py — JSON stdin/stdout bridge for Next.js API route.

Gets data from SMDApp's internal HTTP APIs, runs Python indicator math,
checklist with LIVE OI/Greeks, returns trade recommendation.

Usage:
  echo '{"action":"signal","symbol":"NIFTY"}' | python wrapper.py
"""

import sys, json
from datetime import datetime

import pandas as pd
import numpy as np
from indicators import detect_trend, compute_vwap, detect_breakout, near_support_resistance
from checklist import run_checklist


def ohlc_to_df(data: list) -> pd.DataFrame:
    if not data:
        return pd.DataFrame()
    df = pd.DataFrame(data)
    if "datetime" in df.columns:
        df["datetime"] = pd.to_datetime(df["datetime"])
    elif "time" in df.columns:
        df["datetime"] = pd.to_datetime(df["time"])
    df = df.sort_values("datetime").reset_index(drop=True)
    for col in ["open", "high", "low", "close", "volume"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def compute_atr(df: pd.DataFrame, period: int = 14) -> float:
    if len(df) < period + 1:
        return 0
    high, low, close = df["high"].values, df["low"].values, df["close"].values
    tr = np.maximum(high[1:] - low[1:], np.maximum(
        np.abs(high[1:] - close[:-1]),
        np.abs(low[1:] - close[:-1])
    ))
    return float(np.mean(tr[-period:]))


def get_option_data(chain_rows: list, strike: float, direction: str) -> dict:
    """Get LTP, OI, oiChg, Greeks for a strike."""
    key = "ce" if direction == "CE" else "pe"
    for row in chain_rows:
        if row.get("strike") == strike:
            opt = row.get(key, {})
            return {
                "ltp": float(opt.get("ltp", 0)),
                "oi": float(opt.get("oi", 0)),
                "oiChg": float(opt.get("oiChg", 0)),
                "iv": float(opt.get("iv", 0)),
                "delta": float(opt.get("delta", 0)),
                "gamma": float(opt.get("gamma", 0)),
                "theta": float(opt.get("theta", 0)),
                "vega": float(opt.get("vega", 0)),
                "strike": strike,
            }
    return {"ltp": 0, "oi": 0, "oiChg": 0, "iv": 0, "delta": 0, "gamma": 0, "theta": 0, "vega": 0, "strike": strike}


def pick_best_strike(chain_rows: list, spot: float, step: float, direction: str, trend: str) -> dict:
    """Pick the best strike using LIVE delta + OI data. Prefer delta 0.50-0.60."""
    atm = round(spot / step) * step
    key = "ce" if direction == "CE" else "pe"

    candidates = []
    # Scan ATM, ±1, ±2 strikes
    for offset in [-2, -1, 0, 1, 2]:
        strike = atm + offset * step
        data = get_option_data(chain_rows, strike, direction)
        if data["ltp"] == 0:
            continue
        delta = data["delta"]
        oi = data["oi"]
        oi_chg = data["oiChg"]

        # Score candidate: prefer delta in sweet spot + OI buildup
        if direction == "CE":
            delta_ideal = 0.50 <= delta <= 0.65
            delta_score = abs(delta - 0.57)  # lower = better
        else:
            delta_ideal = -0.65 <= delta <= -0.40
            delta_score = abs(delta + 0.50)

        oi_bonus = 1 if oi_chg > 0 else 0
        label = "ATM" if strike == atm else ("+1 OTM" if strike > atm else "-1 ITM") if direction == "CE" else ("-1 OTM" if strike < atm else "+1 ITM")

        candidates.append({
            "strike": strike,
            "ltp": data["ltp"],
            "delta": delta,
            "oi": oi,
            "oiChg": oi_chg,
            "delta_ideal": delta_ideal,
            "delta_score": delta_score,
            "oi_bonus": oi_bonus,
            "label": label,
        })

    if not candidates:
        return {"strike": atm, "ltp": 0, "label": "ATM", "delta": 0, "oiChg": 0}

    # Sort: prefer delta_ideal first, then lowest delta_score, then oi_bonus
    candidates.sort(key=lambda c: (not c["delta_ideal"], c["delta_score"], -c["oi_bonus"]))
    best = candidates[0]
    return best


def grade_score(score: float) -> str:
    if score >= 95: return "A+"
    if score >= 85: return "A"
    if score >= 75: return "B+"
    if score >= 65: return "B"
    if score >= 55: return "C+"
    if score >= 45: return "C"
    if score >= 35: return "D+"
    return "D"


def reason_bullets(confirmed: list, direction: str, greeks: dict = None) -> list:
    mapping = {
        "trend_15m_aligned": ("HTF Trend", "Bullish on 15m EMA" if direction == "CE" else "Bearish on 15m EMA"),
        "trend_5m_aligned": ("Trend Confirmed", "5m aligns with directional bias"),
        "price_vs_vwap": ("VWAP Support", f"Price {'above' if direction == 'CE' else 'below'} VWAP"),
        "fresh_breakout": ("BOS Confirmed", "Breakout of consolidation with volume surge"),
        "no_sr_blocking": ("No Resistance", f"No {'resistance' if direction == 'CE' else 'support'} blocking near price"),
        "oi_buildup": ("OI Buildup", f"Fresh {'call' if direction == 'CE' else 'put'} writing detected (+OI)"),
        "oi_put_call_ratio": ("OI Ratio Favors", "Put OI dominates" if direction == "CE" else "Call OI dominates"),
        "delta_confirm": ("Delta > 0.50", f"ATM delta {greeks.get('delta', 0):.2f} — good directional exposure" if greeks else ""),
        "gamma_rising": ("Gamma Rising", f"ATM gamma {greeks.get('gamma', 5):.4f} — acceleration potential" if greeks else ""),
        "theta_favorable": ("Theta Manageable", f"ATM theta {greeks.get('theta', 0):.1f} — decay within range" if greeks else ""),
        "volume_rising": ("Volume Surge", "Volume spike on latest candle"),
        "no_reversal_candle": ("No Reversal", "No engulfing/reversal candle on 15m"),
    }
    bullets = []
    for c in confirmed:
        item = mapping.get(c)
        if item:
            label, desc = item
            bullets.append(f"✓ {label} — {desc}")
        else:
            bullets.append(f"✓ {c.replace('_', ' ').title()}")
    if not bullets:
        bullets.append("— Mixed signals, no strong conviction")
    return bullets


def compute_trade_score(checklist_result) -> dict:
    weights = {
        "trend_15m_aligned": 15,
        "trend_5m_aligned": 10,
        "price_vs_vwap": 5,
        "fresh_breakout": 10,
        "no_sr_blocking": 5,
        "oi_buildup": 15,
        "oi_put_call_ratio": 5,
        "delta_confirm": 15,
        "gamma_rising": 10,
        "theta_favorable": 5,
        "volume_rising": 5,
        "no_reversal_candle": 5,
    }
    total_weight = 0
    earned_weight = 0
    for name, weight in weights.items():
        val = checklist_result.results.get(name)
        if val is True:
            earned_weight += weight
            total_weight += weight
        elif val is False:
            total_weight += weight
    score = round(earned_weight / total_weight * 100) if total_weight > 0 else 0
    grade = grade_score(score)
    return {"score": score, "grade": grade, "earned": earned_weight, "total": total_weight}


def screen(symbol: str, direction: str, chain_data: dict = None) -> dict:
    """Run the checklist with LIVE OI/Greeks for a symbol + direction."""

    if not chain_data or not chain_data.get("success"):
        return {"success": False, "error": "No option chain data provided"}

    source = chain_data.get("source", "unknown")
    root = chain_data.get("data", {})
    spot_price = root.get("spotPrice") or root.get("summary", {}).get("spotPrice") or 0
    candles = root.get("candles", [])

    if not candles or len(candles) < 30:
        return {"success": False, "error": f"Insufficient candle data ({len(candles or [])} bars)"}

    df = ohlc_to_df(candles)
    df_5m = df.copy()
    df_15m = df.iloc[::3].copy()
    if len(df_15m) < 10:
        df_15m = df_5m.copy()

    chain_rows = root.get("data", [])

    step = 50 if symbol in ("NIFTY", "FINNIFTY") else 100 if symbol in ("BANKNIFTY", "SENSEX") else 25
    atm_strike = round(spot_price / step) * step if spot_price > 0 else 0

    trend = detect_trend(df_5m)

    # Pick best strike using LIVE delta + OI
    chosen = pick_best_strike(chain_rows, spot_price, step, direction, trend)
    strike = chosen["strike"]
    entry = chosen["ltp"]
    delta = chosen["delta"]
    oi_chg = chosen["oiChg"]
    label = chosen["label"]

    # Get full Greeks dict for the chosen strike
    opt_data = get_option_data(chain_rows, strike, direction)
    greeks = {k: opt_data.get(k, 0) for k in ("delta", "gamma", "theta", "vega", "iv")}

    # Build chain DataFrame (needed by checklist for PCR)
    chain_df = None
    if chain_rows:
        rows = []
        for row in chain_rows:
            s = row.get("strike", 0)
            ce = row.get("ce") or {}
            pe = row.get("pe") or {}
            rows.append({"strike": s, "right": "call", "open_interest": ce.get("oi", 0), "ltp": ce.get("ltp", 0), "iv": ce.get("iv", 0)})
            rows.append({"strike": s, "right": "put", "open_interest": pe.get("oi", 0), "ltp": pe.get("ltp", 0), "iv": pe.get("iv", 0)})
        chain_df = pd.DataFrame(rows)

    # Run checklist with LIVE OI + Greeks
    result = run_checklist(
        df_15m=df_15m, df_5m=df_5m, df_1m=None,
        chain_now=chain_df, chain_prev=None,
        india_vix_series=None, direction=direction,
        target_strike=strike, iv_series=None,
        oi_chg=oi_chg, greeks=greeks,
        chain_rows=chain_rows, step=step,
    )

    summary = result.summary()
    score_info = compute_trade_score(result)

    # SL/TP based on option premium
    if entry > 0:
        sl = round(entry * 0.73, 2)
        tp1 = round(entry * 1.68, 2)
        tp2 = round(entry * 2.55, 2)
    else:
        sl, tp1, tp2 = 0, 0, 0

    direction_label = "BUY" if direction == "CE" else "SELL"
    action = f"{direction_label} {direction}"

    return {
        "success": True,
        "symbol": symbol,
        "direction": action,
        "strike": strike,
        "strike_label": label,
        "entry": entry,
        "sl": sl,
        "tp1": tp1,
        "tp2": tp2,
        "runner": "Trail by swing low" if direction == "CE" else "Trail by swing high",
        "score": score_info["score"],
        "grade": score_info["grade"],
        "confidence": score_info["score"],
        "reasons": reason_bullets(result.confirmed(), direction, greeks),
        "greeks": {k: round(v, 4) if isinstance(v, float) else v for k, v in greeks.items()},
        "spot_price": round(float(spot_price), 2),
        "atm_strike": int(atm_strike),
        "data_source": source,
        "confirmed": result.confirmed(),
        "failed": result.failed(),
        "unavailable": result.unavailable(),
        "summary": summary,
        "score_info": score_info,
        "timestamp": datetime.now().isoformat(),
    }


def signal(symbol: str, direction: str = None, chain_data: dict = None) -> dict:
    """Screen both CE and PE, return the better signal."""
    if direction and direction.upper() in ("CE", "PE"):
        dirs = [direction.upper()]
    else:
        dirs = ["CE", "PE"]

    results = {}
    for d in dirs:
        r = screen(symbol, d, chain_data)
        results[d] = r

    best_dir = "CE"
    best_score = 0
    for d, r in results.items():
        s = r.get("score", 0) if r.get("success") else 0
        if s > best_score:
            best_score = s
            best_dir = d

    best = results.get(best_dir, {})

    lines = [
        f"Trade Score: {best.get('score', 0)}/100 ({best.get('grade', 'N/A')})",
        "",
        f"Direction: {best.get('direction', 'N/A')}",
        f"Strike: {best.get('strike_label', 'ATM')} ({best.get('strike', 0)})",
        f"Entry: ₹{best.get('entry', 0):.2f}",
        f"SL: ₹{best.get('sl', 0):.2f}",
        f"TP1: ₹{best.get('tp1', 0):.2f}",
        f"TP2: ₹{best.get('tp2', 0):.2f}",
        f"Runner: {best.get('runner', 'N/A')}",
        "",
        f"Confidence: {best.get('confidence', 0)}%",
        "",
        "Reason:",
    ]
    for bullet in best.get("reasons", []):
        lines.append(bullet)
    lines.append("")
    g = best.get("greeks", {})
    lines.append(f"Greeks: Δ={g.get('delta', '?')}  Γ={g.get('gamma', '?')}  Θ={g.get('theta', '?')}  V={g.get('vega', '?')}  IV={g.get('iv', '?')}%")
    lines.append(f"Spot: ₹{best.get('spot_price', 0):,.2f}  |  Data: {best.get('data_source', '?')}")
    lines.append(f"🕐 {best.get('timestamp', datetime.now().isoformat())}")

    return {
        "success": best.get("success", False),
        "symbol": symbol,
        "direction": best_dir,
        "trade": {
            "action": best.get("direction"),
            "strike": best.get("strike"),
            "strike_label": best.get("strike_label"),
            "entry": best.get("entry"),
            "sl": best.get("sl"),
            "tp1": best.get("tp1"),
            "tp2": best.get("tp2"),
            "runner": best.get("runner"),
        },
        "score": best.get("score", 0),
        "grade": best.get("grade", "N/A"),
        "confidence": best.get("confidence", 0),
        "reasons": best.get("reasons", []),
        "greeks": best.get("greeks", {}),
        "spot_price": best.get("spot_price"),
        "atm_strike": best.get("atm_strike"),
        "confirmed": best.get("confirmed", []),
        "failed": best.get("failed", []),
        "unavailable": best.get("unavailable", []),
        "summary": best.get("summary", {}),
        "data_source": best.get("data_source", "unknown"),
        "lines": lines,
        "timestamp": datetime.now().isoformat(),
    }


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}))
        return

    action = req.get("action", "screen")
    symbol = req.get("symbol", "NIFTY").upper()
    direction = req.get("direction", "").upper() or None
    chain_data = req.get("chain_data")

    try:
        if action == "signal":
            result = signal(symbol, direction, chain_data)
        else:
            result = screen(symbol, direction or "CE", chain_data)
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
