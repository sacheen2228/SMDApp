"""
EMA PULLBACK ENGINE v2  (non-repainting, min 1:2 RR, chop-filtered + SMC)
================================================================
Educational framework - NOT financial advice. Thresholds are starting values,
NOT backtested. Optimise on your own data with walk-forward testing.

Design (from our discussion)
  * 15m = bias + chop filter (uses last FULLY CLOSED 15m bar only -> no lookahead)
  * 5m  = trigger. Signals are evaluated on closed bars only and never change.
  * EMA cross is a regime flag. Entry = first pullback to EMA zone + candle trigger.
  * Volume imbalance: RVOL + CLV (close-location) on FUTURES volume.
  * Hard gates: chop, volume, RR >= 2, level-block, time filter. Else SKIP + reason.

v2 adds (each switchable in Config):
  * Non-repainting SMC: confirmed swings (BOS, higher-low), FVG retest, liquidity sweep+reclaim
  * Variance-ratio regime gate (skip mean-reverting markets)
  * OPTIONAL columns, used only if present and must be KNOWN AT BAR CLOSE:
      vix (India VIX)           -> VIX cap + expected-move gate
      call_wall / put_wall      -> OI strike walls act as targets-blocking levels
      delta (buy vol - sell vol)-> order-flow confirmation bonus
  * MetaModel: numpy logistic regression -> p(win), with walk-forward report

Input : CSV/DataFrame with datetime index (5m, IST) and open,high,low,close,volume
Output: list of signal dicts (JSON-ready) for your dashboard.

Usage : python ema_pullback_engine.py data.csv --out signals.json
        python ema_pullback_engine.py --demo
"""
from __future__ import annotations
import json, math, sys
from dataclasses import dataclass, asdict
import numpy as np
import pandas as pd


# ----------------------------------------------------------------- config
@dataclass
class Config:
    fast: int = 9
    mid: int = 21
    slow: int = 50
    atr_n: int = 14
    adx_n: int = 14
    er_n: int = 10
    htf: str = "15min"
    # chop filter (15m)
    adx_min: float = 20.0
    er_min: float = 0.35
    sep_atr: float = 0.3
    slope_atr: float = 0.1
    max_cross: int = 1
    max_vwap_cross: int = 1
    atr_ratio_min: float = 0.8
    chop_pass: int = 5            # of 7 (ADX + ER are always mandatory)
    # setup (5m)
    impulse_atr: float = 1.5
    zone_atr: float = 0.25
    pb_max: int = 4
    rvol_min: float = 1.2
    clv_min: float = 0.4
    min_candle_atr: float = 0.5
    stop_buf_atr: float = 0.25
    max_stop_atr: float = 3.0
    rr_min: float = 2.0
    min_score: int = 70
    tick: float = 0.05
    # time filter (bar OPEN time, IST)
    start: str = "09:30"
    end_entry: str = "14:45"
    lull: tuple = ("11:45", "13:30")
    lull_adx: float = 25.0
    # ---- v2 (all switchable)
    use_smc: bool = True
    require_smc: bool = False     # True = need >=1 of FVG / sweep / BOS
    swing_k: int = 3              # swing confirmed k bars AFTER it forms (built-in delay, never repaints)
    fvg_min_atr: float = 0.3
    fvg_lookback: int = 30
    bos_lookback: int = 20
    use_regime: bool = True
    vr_q: int = 4
    vr_win: int = 60
    vr_min: float = 1.0           # >1 trending, <1 mean-reverting
    vix_max: float = 25.0
    move_frac: float = 0.75       # target must be <= 75% of VIX-implied daily move


# ------------------------------------------------------------- indicators
def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def atr(df, n):
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def adx(df, n):
    up, dn = df["high"].diff(), -df["low"].diff()
    plus = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    a = atr(df, n).replace(0, np.nan)
    pdi = 100 * plus.ewm(alpha=1 / n, adjust=False).mean() / a
    mdi = 100 * minus.ewm(alpha=1 / n, adjust=False).mean() / a
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


def efficiency_ratio(c, n):
    return (c - c.shift(n)).abs() / c.diff().abs().rolling(n).sum().replace(0, np.nan)


def vwap(df):
    day = df.index.date
    tp = (df["high"] + df["low"] + df["close"]) / 3
    v = df["volume"].replace(0, np.nan)
    num = (tp * v).groupby(day).cumsum()
    den = v.groupby(day).cumsum()
    fallback = tp.groupby(day).expanding().mean().reset_index(level=0, drop=True)
    return (num / den).fillna(fallback)


def clv(df):
    r = (df["high"] - df["low"]).replace(0, np.nan)
    return (((df["close"] - df["low"]) - (df["high"] - df["close"])) / r).fillna(0)


def variance_ratio(c, q=4, win=60):
    """Lo-MacKinlay style rolling variance ratio. >1 trending, <1 mean-reverting."""
    r1, rq = c.diff(), c.diff(q)
    return rq.rolling(win).var() / (q * r1.rolling(win).var()).replace(0, np.nan)


def cross_price(ema_f, ema_s, nf, ns):
    """Price that the NEXT close must reach for EMA_fast to equal EMA_slow.
    Computed from closed data only -> usable as a pending-order / invalidation level."""
    a, b = 2 / (nf + 1), 2 / (ns + 1)
    return ((1 - b) * ema_s - (1 - a) * ema_f) / (a - b)


# --------------------------------------------------------- higher timeframe
def htf_features(d, cfg):
    o = d.resample(cfg.htf, label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna(subset=["close"])
    e1, e2, e3 = ema(o.close, cfg.fast), ema(o.close, cfg.mid), ema(o.close, cfg.slow)
    a, a50 = atr(o, cfg.atr_n), atr(o, 50)
    ad, er, vw = adx(o, cfg.adx_n), efficiency_ratio(o.close, cfg.er_n), vwap(o)
    sgn = np.sign(e1 - e2)
    crosses = (sgn.diff().abs() > 0).rolling(20).sum()
    vsgn = np.sign(o.close - vw)
    vcross = (vsgn.diff().abs() > 0).rolling(12).sum()
    checks = pd.DataFrame({
        "adx": ad >= cfg.adx_min, "er": er >= cfg.er_min,
        "sep": (e1 - e2).abs() >= cfg.sep_atr * a,
        "slope": e2.diff(5).abs() >= cfg.slope_atr * a,
        "cross": crosses <= cfg.max_cross, "vwapx": vcross <= cfg.max_vwap_cross,
        "atrr": (a / a50) >= cfg.atr_ratio_min})
    f = pd.DataFrame(index=o.index)
    f["h_bull"] = ((e1 > e2) & (e2 > e3) & (e2.diff() > 0)).astype(float)
    f["h_bear"] = ((e1 < e2) & (e2 < e3) & (e2.diff() < 0)).astype(float)
    f["h_adx"] = ad
    f["h_chop"] = checks.sum(axis=1).astype(float)
    f["h_ok"] = (checks["adx"] & checks["er"] & (f["h_chop"] >= cfg.chop_pass)).astype(float)
    # NON-REPAINT: only the last fully closed HTF bar is visible to a 5m bar
    return f.shift(1).reindex(d.index, method="ffill")


def prepare(df, cfg=Config()):
    d = df.copy().sort_index()
    d["atr"] = atr(d, cfg.atr_n)
    d["rvol"] = d["volume"] / d["volume"].rolling(20).mean().shift(1)
    d["clv"] = clv(d)
    d["vwap"] = vwap(d)
    d["vr"] = variance_ratio(d.close, cfg.vr_q, cfg.vr_win)
    d["e1"], d["e2"], d["e3"] = ema(d.close, cfg.fast), ema(d.close, cfg.mid), ema(d.close, cfg.slow)
    daily = d.groupby(d.index.date).agg(dh=("high", "max"), dl=("low", "min"))
    daily = daily.shift(1)
    d["pdh"] = pd.Series(d.index.date, index=d.index).map(daily["dh"])
    d["pdl"] = pd.Series(d.index.date, index=d.index).map(daily["dl"])
    return d.join(htf_features(d, cfg))


# --------------------------------------------------------------- candles
def patterns(o, h, l, c):
    rng, body = h - l, np.abs(c - o)
    up, lo = h - np.maximum(o, c), np.minimum(o, c) - l
    po, pc, ph, pl = (np.roll(x, 1) for x in (o, c, h, l))
    hammer = (rng > 0) & (lo >= 2 * body) & (up <= 0.3 * rng) & (c >= l + 0.6667 * rng)
    engulf = (po > pc) & (c > o) & (c >= po) & (o <= pc) & (c > ph)
    inside = (ph < np.roll(h, 2)) & (pl > np.roll(l, 2)) & (c > ph) & (c > o)
    return hammer, engulf, inside


def smc_features(h, l, c, atr_, lo_level, cfg):
    """Non-repainting SMC on (side-mirrored) arrays. Value at bar i uses bars <= i ONLY.
    hl     : last confirmed swing low is higher than the one before (structure intact)
    bos    : close broke the last confirmed swing high within bos_lookback bars
    ftouch : bar i trades back into an unmitigated bullish FVG formed >=3 bars earlier
    sweep  : bar i wicked below a confirmed swing low / prev-day low and closed back above it"""
    n, k = len(c), cfg.swing_k
    hl, bos, ft, sw = (np.zeros(n, bool) for _ in range(4))
    last_sh = last_sl = prev_sl = np.nan
    bos_at, fvgs = -10 ** 9, []
    for i in range(2, n):
        j = i - k
        if j >= k:                                   # swing at j is only KNOWN k bars later
            if h[j] >= h[j - k:i + 1].max():
                last_sh = h[j]
            if l[j] <= l[j - k:i + 1].min():
                prev_sl, last_sl = last_sl, l[j]
        if last_sh == last_sh and c[i] > last_sh and c[i - 1] <= last_sh:
            bos_at = i
        hl[i] = bool(last_sl == last_sl and prev_sl == prev_sl and last_sl > prev_sl)
        bos[i] = i - bos_at <= cfg.bos_lookback
        a = atr_[i]
        if a == a and l[i] > h[i - 2] and (l[i] - h[i - 2]) >= cfg.fvg_min_atr * a:
            fvgs.append([h[i - 2], l[i], i])        # bottom, top, born
        ft[i] = any(z[2] <= i - 3 and l[i] <= z[1] for z in fvgs)
        fvgs = [z for z in fvgs if c[i] > z[0] and i - z[2] <= cfg.fvg_lookback]
        s1 = last_sl == last_sl and l[i] < last_sl and c[i] > last_sl
        s2 = lo_level[i] == lo_level[i] and l[i] < lo_level[i] and c[i] > lo_level[i]
        sw[i] = bool(s1 or s2)
    return dict(hl=hl, bos=bos, ftouch=ft, sweep=sw)


def _hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _sided(d, s, cfg):
    """Mirror data for shorts so ONE rule set serves both sides."""
    has = lambda k: k in d.columns
    if s == 1:
        o, h, l, c = (d[k].values for k in ("open", "high", "low", "close"))
        trend, lo_level = d["h_bull"].values, d["pdl"].values
        lvls = [d["pdh"].values] + ([d["call_wall"].values] if has("call_wall") else [])
    else:
        o, h, l, c = -d["open"].values, -d["low"].values, -d["high"].values, -d["close"].values
        trend, lo_level = d["h_bear"].values, -d["pdh"].values
        lvls = [-d["pdl"].values] + ([-d["put_wall"].values] if has("put_wall") else [])
    return dict(o=o, h=h, l=l, c=c, e1=s * d["e1"].values, e2=s * d["e2"].values, e3=s * d["e3"].values,
                vw=s * d["vwap"].values, clv=s * d["clv"].values, lvls=lvls, trend=trend,
                delta=(s * d["delta"].values) if has("delta") else None,
                pat=patterns(o, h, l, c), smc=smc_features(h, l, c, d["atr"].values, lo_level, cfg))


def _eval(d, A, i, s, cfg, bar_td):
    """Return (reasons, signal_or_None) for the CLOSED bar i."""
    why = []
    row = d.iloc[i]
    if not A["trend"][i] == 1.0:
        why.append("no_15m_trend")
    if row["h_ok"] != 1.0:
        why.append(f"chop_filter({int(row['h_chop']) if row['h_chop'] == row['h_chop'] else 0}/7)")
    if cfg.use_regime and row["vr"] == row["vr"] and row["vr"] < cfg.vr_min:
        why.append(f"mean_reverting_vr{row['vr']:.2f}")
    has_vix = "vix" in d.columns and row["vix"] == row["vix"]
    if has_vix and row["vix"] > cfg.vix_max:
        why.append("vix_too_high")
    t = d.index[i].hour * 60 + d.index[i].minute
    if t < _hm(cfg.start) or t > _hm(cfg.end_entry):
        why.append("time_window")
    if _hm(cfg.lull[0]) <= t <= _hm(cfg.lull[1]) and not row["h_adx"] > cfg.lull_adx:
        why.append("lunch_lull")
    if why:
        return why, None
    a = row["atr"]
    n0 = i - cfg.pb_max
    if n0 < 8 or a != a:
        return ["warmup"], None
    w = slice(n0, i)
    zone_ok = np.any(A["l"][w] <= A["e1"][w])
    deep = np.min(A["l"][w]) >= A["e2"][i - 1] - 1.0 * a  # not collapsing through the EMA21 zone
    held = np.all(A["c"][w] > A["e3"][w])
    imp = np.max(A["h"][n0 - 6:i]) - np.min(A["l"][w]) >= cfg.impulse_atr * a
    v = d["volume"].values
    vol_ok = True
    if v[n0 - 6:i].sum() > 0:
        vol_ok = v[w].mean() <= v[n0 - 6:n0].mean()
    if not (zone_ok and deep and held):
        why.append("no_pullback_to_ema_zone")
    if not imp:
        why.append("no_impulse")
    if not vol_ok:
        why.append("pullback_volume_heavy")
    hm, en, ins = (x[i] for x in A["pat"])
    big = (A["h"][i] - A["l"][i]) >= cfg.min_candle_atr * a
    if not ((hm or en or ins) and big and A["c"][i] > A["e1"][i]):
        why.append("no_trigger_candle")
    rv = row["rvol"]
    if row["volume"] > 0 and not (rv >= cfg.rvol_min and A["clv"][i] >= cfg.clv_min):
        why.append("volume_imbalance_weak")
    if not A["c"][i] > A["vw"][i]:
        why.append("wrong_side_of_vwap")
    if why:
        return why, None
    sm = A["smc"]
    f_fvg, f_sweep = bool(sm["ftouch"][n0:i + 1].any()), bool(sm["sweep"][n0:i + 1].any())
    f_bos, f_hl = bool(sm["bos"][i]), bool(sm["hl"][i])
    if cfg.require_smc and not (f_fvg or f_sweep or f_bos):
        return ["no_smc_confluence"], None
    f_delta = False
    if A["delta"] is not None:
        f_delta = bool(A["delta"][i] > 0 and A["delta"][i - 2:i + 1].sum() > 0)
    entry = A["h"][i] + cfg.tick
    stop = min(np.min(A["l"][w]), A["l"][i]) - cfg.stop_buf_atr * a
    risk = entry - stop
    if risk <= 0 or risk > cfg.max_stop_atr * a:
        return ["stop_too_wide_or_invalid"], None
    target = entry + cfg.rr_min * risk
    if has_vix:
        em = row["close"] * row["vix"] / 100 / math.sqrt(252)      # VIX-implied 1-day move
        if cfg.rr_min * risk > cfg.move_frac * em:
            return ["target_exceeds_expected_move"], None
    cands = [x[i] for x in A["lvls"] if x[i] == x[i] and x[i] > entry]   # nearest PDH / OI wall
    lvl = min(cands) if cands else np.nan
    lvl_r = None
    if lvl == lvl and lvl > entry:
        lvl_r = (lvl - entry) / risk
        if lvl_r < cfg.rr_min:
            return [f"level_blocks_{lvl_r:.1f}R"], None
    chop = int(row["h_chop"])
    loc = 30 if np.any(A["l"][w] <= A["e2"][w] + cfg.zone_atr * a) else 20
    score = (loc + 5 * (chop - 2) + 15 * min((rv if rv == rv else 1.0) / 2, 1.0)
             + (15 if en else 12 if hm else 8) + (15 if lvl_r is None or lvl_r >= 3 else 10))
    bonus = (7 * f_fvg + 8 * f_sweep + 5 * f_bos + 5 * f_hl) if cfg.use_smc else 0
    score += min(25, bonus + 5 * f_delta)
    if score < cfg.min_score:
        return [f"score_{score:.0f}<{cfg.min_score}"], None
    flip = cross_price(d["e1"].iloc[i], d["e2"].iloc[i], cfg.fast, cfg.mid)
    sign = s
    sig = {
        "time": str(d.index[i] + bar_td), "side": "CE" if s == 1 else "PE", "status": "VALID",
        "pattern": "engulfing" if en else "hammer/pin" if hm else "inside_break",
        "entry": round(sign * entry, 2), "stop": round(sign * stop, 2),
        "t1": round(sign * (entry + 1.5 * risk), 2), "t2": round(sign * target, 2),
        "risk_pts": round(risk, 2), "rr": cfg.rr_min, "score": round(float(score), 1),
        "chop_score": f"{chop}/7", "rvol": None if rv != rv else round(float(rv), 2),
        "clv": round(float(sign * A["clv"][i]), 2), "atr": round(float(a), 2),
        "regime_flip_price": round(float(flip), 2), "valid_bars": 2,
        "smc": {"fvg_retest": f_fvg, "sweep_reclaim": f_sweep, "bos": f_bos, "hl_intact": f_hl},
        "order_flow_delta_ok": f_delta, "vr": None if row["vr"] != row["vr"] else round(float(row["vr"]), 2),
        "feat": {"score": float(score), "chop": float(chop), "rvol": 1.0 if rv != rv else float(rv),
                 "clv": float(sign * A["clv"][i]), "risk_atr": float(risk / a),
                 "vr": 1.0 if row["vr"] != row["vr"] else float(row["vr"]), "hour": float(d.index[i].hour),
                 "fvg": float(f_fvg), "sweep": float(f_sweep), "bos": float(f_bos), "hl": float(f_hl)},
        "note": "Buy-stop at entry; cancel if not filled in 2 bars. Book 50% at t1, stop->breakeven, trail rest.",
    }
    return [], sig


def scan(df, cfg=Config()):
    d = prepare(df, cfg)
    bar_td = d.index.to_series().diff().median()
    out = []
    for s in (1, -1):
        A = _sided(d, s, cfg)
        for i in range(60, len(d)):
            _, sig = _eval(d, A, i, s, cfg, bar_td)
            if sig:
                out.append(sig)
    return sorted(out, key=lambda x: x["time"])


def diagnose(df, cfg=Config()):
    """Dashboard 'gate checklist' for the LAST closed bar, both sides."""
    d = prepare(df, cfg)
    td = d.index.to_series().diff().median()
    res = {}
    for s, name in ((1, "CE"), (-1, "PE")):
        why, sig = _eval(d, _sided(d, s, cfg), len(d) - 1, s, cfg, td)
        res[name] = {"status": "VALID" if sig else "SKIP", "skip_reasons": why, "signal": sig}
    return res


# ----------------------------------------------------------- option layer
def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(spot, k, t, iv, call=True, r=0.065):
    t = max(t, 1e-6)
    d1 = (math.log(spot / k) + (r + iv * iv / 2) * t) / (iv * math.sqrt(t))
    d2 = d1 - iv * math.sqrt(t)
    if call:
        return spot * _ncdf(d1) - k * math.exp(-r * t) * _ncdf(d2), _ncdf(d1)
    return k * math.exp(-r * t) * _ncdf(-d2) - spot * _ncdf(-d1), _ncdf(d1) - 1


def touch_probability(spot, level, iv, t_years):
    """~P(price touches level before expiry horizon). Rule of thumb; skip trade if < ~30%."""
    d = abs(level - spot) / spot / (iv * math.sqrt(max(t_years, 1e-6)))
    return 2 * (1 - _ncdf(d))


def option_plan(sig, spot, strike, dte, iv, lot_size, capital, risk_pct=1.0, hold_min=30):
    """Re-price option at stop/target (theta included). Option R:R must be >= 2 to pass."""
    call = sig["side"] == "CE"
    t0, t1 = dte / 365, max(dte / 365 - hold_min / (365 * 375), 1e-6)
    p0, delta = bs(spot, strike, t0, iv, call)
    ps, _ = bs(sig["stop"], strike, t1, iv, call)
    pt, _ = bs(sig["t2"], strike, t1, iv, call)
    loss, gain = p0 - ps, pt - p0
    lots = int((capital * risk_pct / 100) // (loss * lot_size)) if loss > 0 else 0
    horizon = dte / 365
    return {"strike": strike, "est_premium": round(p0, 2), "delta": round(abs(delta), 2),
            "premium_stop": round(ps, 2), "premium_target": round(pt, 2),
            "option_rr": round(gain / loss, 2) if loss > 0 else None, "lots": lots,
            "touch_prob_t2": round(touch_probability(spot, sig["t2"], iv, horizon), 2),
            "pass": bool(loss > 0 and gain / loss >= 2 and lots >= 1),
            "warning": "Model estimate. Use live premium/VIX; verify lot size & margin with broker."}


# --------------------------------------------- validation / meta-labelling
def label_signals(df, signals, max_bars=12):
    """Triple-barrier outcome in R for each signal (fill within 2 bars, then stop/target/timeout)."""
    rows = []
    for sg in signals:
        t = pd.Timestamp(sg["time"])
        pos = df.index.searchsorted(t)
        e, st, tg = sg["entry"], sg["stop"], sg["t2"]
        long = sg["side"] == "CE"
        filled, r = False, None
        for j in range(pos, min(pos + 2 + max_bars, len(df))):
            h, l = df["high"].iat[j], df["low"].iat[j]
            if not filled:
                if j >= pos + 2:
                    break
                filled = (h >= e) if long else (l <= e)
                if not filled:
                    continue
            hit_s, hit_t = (l <= st, h >= tg) if long else (h >= st, l <= tg)
            if hit_s:
                r = -1.0
                break
            if hit_t:
                r = sg["rr"]
                break
        if filled and r is None:
            c = df["close"].iat[min(pos + 1 + max_bars, len(df) - 1)]
            r = ((c - e) if long else (e - c)) / sg["risk_pts"]
        rows.append({**sg, "filled": filled, "R": r})
    return pd.DataFrame(rows)


def stats(lab, cost_r=0.05):
    x = lab[lab["filled"]].copy()
    if x.empty:
        return {"trades": 0}
    r = x["R"] - cost_r
    gp, gl = r[r > 0].sum(), -r[r < 0].sum()
    return {"trades": len(x), "win_rate": round(float((x["R"] > 0).mean()), 3), "avg_R": round(float(r.mean()), 3),
            "profit_factor": round(float(gp / gl), 2) if gl > 0 else None,
            "max_losing_streak": int((x["R"] <= 0).astype(int).groupby((x["R"] > 0).cumsum()).sum().max())}


FEATS = ["score", "chop", "rvol", "clv", "risk_atr", "vr", "hour", "fvg", "sweep", "bos", "hl"]


class MetaModel:
    """Numpy logistic regression -> p(win) per signal. Needs hundreds of labelled signals;
    judge it ONLY on out-of-sample data (see walk_forward_report)."""

    def _X(self, df):
        return np.nan_to_num(np.array([[float(f.get(k) or 0) for k in FEATS] for f in df["feat"]], float))

    def fit(self, lab, l2=1.0, lr=0.1, iters=3000):
        x = lab[lab["filled"]]
        X, y = self._X(x), (x["R"] > 0).astype(float).values
        self.mu, self.sd = X.mean(0), X.std(0) + 1e-9
        Z = (X - self.mu) / self.sd
        self.w, self.b = np.zeros(Z.shape[1]), 0.0
        for _ in range(iters):
            p = 1 / (1 + np.exp(-(Z @ self.w + self.b)))
            self.w -= lr * (Z.T @ (p - y) / len(y) + l2 * self.w / len(y))
            self.b -= lr * (p - y).mean()
        return self

    def predict(self, df):
        return 1 / (1 + np.exp(-(((self._X(df) - self.mu) / self.sd) @ self.w + self.b)))


def walk_forward_report(lab, split=0.6, threshold=0.0, cost_r=0.05):
    """Train on the first `split` of trades (time order), test on the rest.
    Keeps only signals with EV = p*RR - (1-p) - cost > threshold."""
    if lab.empty or lab["filled"].sum() < 60:
        return {"warning": "need >=60 filled signals (ideally 300+) for a meaningful meta-model"}
    x = lab[lab["filled"]].sort_values("time").reset_index(drop=True)
    cut = int(len(x) * split)
    m = MetaModel().fit(x.iloc[:cut])
    test = x.iloc[cut:].copy()
    p = m.predict(test)
    keep = (p * test["rr"].values - (1 - p) - cost_r) > threshold
    return {"train_trades": cut, "test_trades": len(test), "baseline_test": stats(test),
            "meta_filtered_test": stats(test[keep]) if keep.any() else {"trades": 0}}


# ------------------------------------------------------------------- demo
def demo_data(days=40, seed=7):
    rng = np.random.default_rng(seed)
    idx = pd.concat([pd.Series(pd.date_range(f"2025-01-01 09:15", periods=75, freq="5min") + pd.Timedelta(days=k))
                     for k in range(days) if (pd.Timestamp("2025-01-01") + pd.Timedelta(days=k)).weekday() < 5])
    n, p, drift, rows = len(idx), 22000.0, 0.0, []
    for i in range(n):
        if i % 150 == 0:
            drift = rng.normal(0, 1.2)
        ret = drift + rng.normal(0, 7)
        o, c = p, p + ret
        h, l = max(o, c) + abs(rng.normal(0, 3)), min(o, c) - abs(rng.normal(0, 3))
        rows.append((o, h, l, c, max(1000, rng.normal(100000, 25000) * (1 + abs(ret) / 15))))
        p = c
    return pd.DataFrame(rows, index=pd.DatetimeIndex(idx), columns=["open", "high", "low", "close", "volume"])


def main(argv):
    if "--demo" in argv:
        df = demo_data()
    else:
        df = pd.read_csv(argv[1], index_col=0, parse_dates=True)
    sigs = scan(df)
    lab = label_signals(df, sigs)
    result = {"config": asdict(Config()), "signals": sigs, "stats": stats(lab) if len(lab) else {"trades": 0},
              "meta_model": walk_forward_report(lab), "last_bar": diagnose(df)}
    out = argv[argv.index("--out") + 1] if "--out" in argv else None
    txt = json.dumps(result, indent=2, default=str)
    if out:
        open(out, "w").write(txt)
    print(f"signals: {len(sigs)} | stats: {result['stats']}")
    print("last bar:", {k: (v['status'], v['skip_reasons']) for k, v in result['last_bar'].items()})


if __name__ == "__main__":
    main(sys.argv)
