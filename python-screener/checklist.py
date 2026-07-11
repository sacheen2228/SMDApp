"""
checklist.py
Scores your original checklist against real computed values.

Design rule: every condition is one of TRUE / FALSE / "N/A".
N/A means the data or a reliable formula isn't available — it is
NEVER counted as a pass.

Now uses LIVE OI change (oiChg) and Greeks from the option chain data,
no longer requires chain_prev snapshot.
"""

from dataclasses import dataclass, field
import pandas as pd


@dataclass
class ChecklistResult:
    results: dict = field(default_factory=dict)
    heuristic_flags: set = field(default_factory=set)

    def confirmed(self):
        return [k for k, v in self.results.items() if v is True]

    def failed(self):
        return [k for k, v in self.results.items() if v is False]

    def unavailable(self):
        return [k for k, v in self.results.items() if v == "N/A"]

    def summary(self):
        c, f, n = len(self.confirmed()), len(self.failed()), len(self.unavailable())
        total_scoreable = c + f
        pct = round(100 * c / total_scoreable, 1) if total_scoreable else 0.0
        return {
            "confirmed": c, "failed": f, "unavailable": n,
            "score_pct_of_scoreable": pct,
            "note": "Score is % of CHECKABLE conditions only. Unavailable items are excluded, not assumed true.",
        }


def run_checklist(df_15m, df_5m, df_1m,
                   chain_now, chain_prev,
                   india_vix_series, direction: str,
                   target_strike: float, iv_series=None,
                   oi_chg: float = None, greeks: dict = None,
                   chain_rows: list = None, step: float = None) -> ChecklistResult:
    """
    direction: 'CE' or 'PE'
    oi_chg: OI change for the target strike (from live chain data)
    greeks: dict with delta/gamma/theta/vega for target strike
    chain_rows: raw chain data (list of dicts with ce/pe)
    """
    r = ChecklistResult()

    # --- Trend, 15m and 5m ---
    if df_15m is not None and df_15m is not False and len(df_15m) >= 25:
        import indicators as ind
        t15 = ind.detect_trend(df_15m)
        r.results["trend_15m_aligned"] = t15 in (["bullish", "bullish_cross"] if direction == "CE" else ["bearish", "bearish_cross"])
    else:
        r.results["trend_15m_aligned"] = "N/A"

    if df_5m is not None and df_5m is not False and len(df_5m) > 25:
        import indicators as ind
        t5 = ind.detect_trend(df_5m)
        r.results["trend_5m_aligned"] = t5 in (["bullish", "bullish_cross"] if direction == "CE" else ["bearish", "bearish_cross"])
    else:
        r.results["trend_5m_aligned"] = "N/A"

    # --- VWAP ---
    if df_5m is not None and df_5m is not False and len(df_5m) > 5:
        import indicators as ind
        vwap = ind.compute_vwap(df_5m)
        last_close = df_5m["close"].iloc[-1]
        r.results["price_vs_vwap"] = (last_close > vwap.iloc[-1]) if direction == "CE" else (last_close < vwap.iloc[-1])
    else:
        r.results["price_vs_vwap"] = "N/A"

    # --- Breakout ---
    if df_5m is not None and df_5m is not False and len(df_5m) > 22:
        import indicators as ind
        bo = ind.detect_breakout(df_5m)
        r.results["fresh_breakout"] = bo["breakout"]
    else:
        r.results["fresh_breakout"] = "N/A"

    # --- Support/Resistance blocking ---
    if df_15m is not None and df_15m is not False and len(df_15m) > 20:
        import indicators as ind
        sr = ind.near_support_resistance(df_15m, df_15m["close"].iloc[-1])
        blocking = sr["near_resistance"] if direction == "CE" else sr["near_support"]
        r.results["no_sr_blocking"] = not blocking
    else:
        r.results["no_sr_blocking"] = "N/A"

    # --- LIVE OI confirmation (uses oiChg from chain) ---
    if oi_chg is not None:
        key = "ce" if direction == "CE" else "pe"
        # Positive oiChg = fresh buying in our direction = confirm move
        r.results["oi_buildup"] = oi_chg > 0
    else:
        r.results["oi_buildup"] = "N/A"

    # --- OI concentration check: compare CE vs PE OI at ATM ---
    if chain_rows and step:
        key_ce, key_pe = "ce", "pe"
        total_ce_oi = 0
        total_pe_oi = 0
        for row in chain_rows:
            s = row.get("strike", 0)
            if abs(s - target_strike) <= step * 2:
                total_ce_oi += (row.get(key_ce) or {}).get("oi", 0)
                total_pe_oi += (row.get(key_pe) or {}).get("oi", 0)
        if total_ce_oi + total_pe_oi > 0:
            oi_ratio = total_pe_oi / total_ce_oi if total_ce_oi > 0 else 99
            if direction == "CE":
                # High put OI relative to calls = strong floor = bullish for calls
                r.results["oi_put_call_ratio"] = oi_ratio >= 0.8
            else:
                # High call OI relative to puts = strong ceiling = bearish for puts
                r.results["oi_put_call_ratio"] = oi_ratio <= 1.2
        else:
            r.results["oi_put_call_ratio"] = "N/A"
    else:
        r.results["oi_put_call_ratio"] = "N/A"

    # --- LIVE Greeks checks ---
    if greeks is not None:
        delta = greeks.get("delta", 0)
        gamma = greeks.get("gamma", 0)
        theta = greeks.get("theta", 0)
        if direction == "CE":
            r.results["delta_confirm"] = delta > 0.50
            r.results["gamma_rising"] = gamma > 0.0008
            r.results["theta_favorable"] = abs(theta) < 20
        else:
            r.results["delta_confirm"] = delta < -0.40
            r.results["gamma_rising"] = gamma > 0.0008
            r.results["theta_favorable"] = abs(theta) < 20
    else:
        r.results["delta_confirm"] = "N/A"
        r.results["gamma_rising"] = "N/A"
        r.results["theta_favorable"] = "N/A"

    # --- PCR context (informational) ---
    if chain_now is not None:
        import indicators as ind
        r.results["pcr"] = ind.compute_pcr(chain_now)
    else:
        r.results["pcr"] = "N/A"

    # --- Volume / large orders proxy ---
    if df_5m is not None and df_5m is not False and len(df_5m) > 20:
        avg_vol = df_5m["volume"].iloc[-21:-1].mean()
        r.results["volume_rising"] = df_5m["volume"].iloc[-1] > 1.3 * avg_vol if avg_vol > 0 else "N/A"
    else:
        r.results["volume_rising"] = "N/A"

    # --- Reversal candle on higher TF ---
    if df_15m is not None and df_15m is not False and len(df_15m) > 2:
        prev, last = df_15m.iloc[-2], df_15m.iloc[-1]
        bearish_engulf = last["close"] < last["open"] and last["open"] > prev["close"] and last["close"] < prev["open"]
        bullish_engulf = last["close"] > last["open"] and last["open"] < prev["close"] and last["close"] > prev["open"]
        reversal_against = bearish_engulf if direction == "CE" else bullish_engulf
        r.results["no_reversal_candle"] = not reversal_against
    else:
        r.results["no_reversal_candle"] = "N/A"

    return r
