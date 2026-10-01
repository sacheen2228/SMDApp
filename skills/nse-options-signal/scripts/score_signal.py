#!/usr/bin/env python3
"""Score a snapshot from nse_fetch.py -> bias score + trade skeleton.
Usage: python score_signal.py snapshot.json

Contract:
  - option_chain_score / fii_score / breadth_score signatures are FROZEN
    (backtest_history.py imports them; their math must not change).
  - score_snapshot(snapshot, now=None) is the testable, deterministic core.
  - Thresholds stay +40/-40, weights stay per references/scoring-rules.md.
  - SCORE_CEILING_DETECTED and 4-of-8 agreement are reported, never used
    to lower thresholds.
"""
import json, sys, datetime, os
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(__file__))
from greeks import analyse as greeks_analyse
import greeks as _greeks_mod
import levels as _levels_mod
import provenance as _prov
import agreement as _agree
import news_context as _news

SOURCE = "NSE_OPTIONS_SIGNAL"
ROLE = "OPTIONS_RESEARCH_SECOND_OPINION"
DISCLAIMER = "Educational analysis, not investment advice."
BUY_ACTIONS = ("BUY_CE", "BUY_PE")
THETA_GATE_PCT = 10.0
VIX_RISK_LEVEL = 25.0
HEAVYWEIGHT_SYMBOLS = {
    "HDFCBANK", "ICICIBANK", "RELIANCE", "INFY", "TCS", "ITC", "LT",
    "BHARTIARTL", "SBIN", "AXISBANK", "KOTAKBANK",
}


# ---------------------------------------------------------------- frozen ---
def option_chain_score(oc):
    recs = oc["records"]; spot = recs["underlyingValue"]
    rows = [r for r in recs["data"] if r["expiryDate"] == recs["expiryDates"][0]]
    ce_oi = sum(r.get("CE", {}).get("openInterest", 0) for r in rows)
    pe_oi = sum(r.get("PE", {}).get("openInterest", 0) for r in rows)
    pcr = pe_oi / ce_oi if ce_oi else 1
    below = [r for r in rows if r["strikePrice"] <= spot and "PE" in r]
    above = [r for r in rows if r["strikePrice"] >= spot and "CE" in r]
    support = max(below, key=lambda r: r["PE"]["openInterest"])["strikePrice"] if below else spot
    resist = max(above, key=lambda r: r["CE"]["openInterest"])["strikePrice"] if above else spot
    s = 8 if pcr > 1.3 else 3 if pcr > 1 else -3 if pcr > 0.8 else -8
    if pcr > 1.7: s = min(s, 4)
    if abs(spot - resist) / spot < 0.003: s -= 6
    if abs(spot - support) / spot < 0.003: s += 6
    near = [r for r in rows if abs(r["strikePrice"] - spot) / spot < 0.02]
    d_pe = sum(r.get("PE", {}).get("changeinOpenInterest", 0) for r in near)
    d_ce = sum(r.get("CE", {}).get("changeinOpenInterest", 0) for r in near)
    s += 8 if d_pe > d_ce else -8
    return max(-30, min(30, s)), dict(spot=spot, pcr=round(pcr, 2), support=support, resistance=resist)

def fii_score(f):
    try:
        fii = next(x for x in f if "FII" in x["category"] or "FPI" in x["category"])
        net = float(fii["netValue"])
    except Exception:
        return 0
    return 6 if net > 2000 else 3 if net > 500 else -6 if net < -2000 else -3 if net < -500 else 0

def breadth_score(g, l):
    def n(x):
        if isinstance(x, dict):
            return len(x.get("NIFTY", {}).get("data", x.get("data", [])))
        return 0
    ng, nl = n(g), n(l)
    if ng + nl == 0: return 0
    r = ng / (ng + nl)
    return 5 if r > .65 else -5 if r < .35 else 0


# ------------------------------------------------------------- utilities ---
def _num(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clip(value, lo, hi):
    return max(lo, min(hi, value))


def _groups(snapshot):
    groups = (snapshot or {}).get("groups")
    return groups if isinstance(groups, dict) else {}


def _list_len(x):
    if isinstance(x, dict):
        return len(x.get("NIFTY", {}).get("data", x.get("data", [])))
    return 0


def _parse_now(now):
    if now is None:
        return datetime.datetime.now()
    if isinstance(now, datetime.datetime):
        return now
    if isinstance(now, str):
        text = now.strip().replace("Z", "")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.datetime.strptime(text, fmt)
            except ValueError:
                continue
        try:
            return datetime.datetime.fromisoformat(text)
        except ValueError:
            pass
    return datetime.datetime.now()


# --------------------------------------------------- new group scorers ----
# Each returns (score:int, available:bool, detail:str). Unavailable -> score 0
# and NEVER counts toward the 4-of-8 agreement.

def heatmap_group_score(snapshot):
    h = _groups(snapshot).get("heatmap")
    if not isinstance(h, dict):
        return 0, False, "heatmap normalized group input missing"
    wr = _num(h.get("weighted_return_pct"))
    if wr is None:
        return 0, False, "heatmap weighted_return_pct missing"
    green = _num(h.get("pct_weight_green"))
    if green is not None and 0 <= green <= 1:
        green *= 100
    notes = []
    score = _clip(wr / 0.4 * 5, -5, 5)
    top3 = _num(h.get("top3_share_pct"))
    if wr > 0:
        if top3 is not None and top3 > 70:
            score = -2
            notes.append("narrow rally: top-3 explain %.0f%% of gain" % top3)
        elif top3 is None and green is not None and wr > 0.4 and green < 60:
            score = -2
            notes.append("narrow rally: only %.0f%% weight green" % green)
    if h.get("sector_rotation_aligned"):
        score += 3 if wr >= 0 else -3
        notes.append("sector rotation: banks+financials+IT same colour")
    sx = _num(h.get("sensex_weighted_pct"))
    if sx is not None and wr != 0 and (sx > 0) == (wr > 0) and abs(wr) >= 0.1 and abs(sx) >= 0.1:
        score += 2
        notes.append("Sensex weighted return same sign")
    elif sx is not None and wr != 0 and (sx > 0) != (wr > 0):
        notes.append("Sensex divergence: confidence one notch lower")
    score = int(_clip(round(score), -10, 10))
    return score, True, "; ".join(notes) or "weighted return %+0.2f%%" % wr


def oi_spurts_group_score(snapshot):
    s = _groups(snapshot).get("oi_spurts")
    if not isinstance(s, dict):
        return 0, False, "oi_spurts normalized group input missing"
    bull = _num(s.get("bullish_weight"))
    bear = _num(s.get("bearish_weight"))
    if bull is None and bear is None:
        return 0, False, "oi_spurts weights missing"
    bull = bull or 0.0
    bear = bear or 0.0
    total = _num(s.get("total_weight"))
    if total is None or total <= 0:
        total = bull + bear
    score = 15 * (bull - bear) / total if total > 0 else 0
    active = _num(s.get("most_active_bias")) or 0
    if active > 0:
        score += 3
    elif active < 0:
        score -= 3
    return int(_clip(round(score), -12, 12)), True, \
        "weighted bull %s vs bear %s" % (round(bull, 2), round(bear, 2))


def preopen_group_score(snapshot):
    p = _groups(snapshot).get("preopen")
    if not isinstance(p, dict):
        return 0, False, "preopen normalized group input missing"
    gap = _num(p.get("gap_pct"))
    ad = _num(p.get("ad_ratio"))
    ca = _num(p.get("close_auction_bias"))
    if gap is None and ad is None and ca is None:
        return 0, False, "preopen inputs missing"
    score = 0
    if gap is not None:
        score += 5 if gap > 0.4 else -5 if gap < -0.4 else gap / 0.4 * 5
    if ad is not None:
        score += 3 if ad > 2 else -3 if ad < 0.5 else 0
    if ca is not None:
        score += _clip(ca, -2, 2)
    return int(_clip(round(score), -8, 8)), True, \
        "gap %s A/D %s" % (gap if gap is not None else "-", ad if ad is not None else "-")


def _heavyweight_entries(snapshot):
    """Heavyweights with volume-spurt confirmation (spec group 5).
    Prefers normalized groups.heavyweights [{symbol, side, volume_spurt}];
    falls back to raw gainers/losers lists when they expose symbol+pct."""
    out = []
    raw = _groups(snapshot).get("heavyweights")
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            symbol = str(entry.get("symbol") or "").upper()
            if symbol not in HEAVYWEIGHT_SYMBOLS:
                continue
            side = str(entry.get("side") or "").lower()
            if side not in ("gainer", "loser"):
                continue
            spurt = entry.get("volume_spurt")
            if spurt is True:
                out.append({"symbol": symbol, "side": side, "volume_spurt": True})
        if out:
            return out, True
    for key, side in (("gainers", "gainer"), ("losers", "loser")):
        payload = snapshot.get(key) or {}
        items = []
        if isinstance(payload, dict):
            items = payload.get("NIFTY", {}).get("data") or payload.get("data") or []
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("symbol") or "").upper()
            if symbol not in HEAVYWEIGHT_SYMBOLS:
                continue
            spurt = item.get("volume_spurt", item.get("spurt"))
            if spurt is True:
                out.append({"symbol": symbol, "side": side, "volume_spurt": True})
    return out, bool(out)


def breadth_group_score(snapshot):
    """Group 5: frozen breadth_score (+/-5) + heavyweights +/-1.5 each
    (clipped to +/-10). Available when gainers/losers counts OR
    heavyweights data exist."""
    g, l = snapshot.get("gainers", {}), snapshot.get("losers", {})
    base = breadth_score(g, l)
    ng, nl = _list_len(g), _list_len(l)
    heavyweights, hw_av = _heavyweight_entries(snapshot)
    hw_score = 0.0
    for entry in heavyweights:
        hw_score += 1.5 if entry["side"] == "gainer" else -1.5
    available = (ng + nl) > 0 or hw_av
    if not available:
        return 0, False, "gainers/losers data missing"
    score = int(_clip(round(base + hw_score), -10, 10))
    return score, True, "breadth %d up / %d down; heavyweights %+d" % (
        ng, nl, len(heavyweights))


def fii_bse_addon(snapshot, base_score=0):
    """Optional BSE FII addon within FII group (spec 63-66): agrees with the
    NSE direction -> +3 in that direction (sign of base); contradicts -> 0
    (futures component cancel noted by caller). Unavailable -> (0, False)."""
    b = _groups(snapshot).get("fii_bse")
    if not isinstance(b, dict):
        return 0, False
    agrees = b.get("agrees")
    if agrees is None and isinstance(b.get("direction"), str):
        direction = b["direction"].lower()
        agrees = direction in ("same", "agrees", "agree")
    if agrees is None:
        return 0, False
    if not agrees:
        return 0, True
    if base_score > 0:
        return 3, True
    if base_score < 0:
        return -3, True
    return 0, True


def week52_group_score(snapshot):
    w = _groups(snapshot).get("week52")
    if not isinstance(w, dict):
        return 0, False, "week52 normalized group input missing"
    high = _num(w.get("high_count"))
    low = _num(w.get("low_count"))
    if high is None and low is None:
        return 0, False, "week52 counts missing"
    score = 0
    notes = []
    if high is not None and high > 15:
        hw_high = _num(w.get("heavyweights_at_high")) or 0
        if hw_high >= 2:
            score += 6
            notes.append("broad 52wk highs with heavyweights")
        else:
            score += 4
            notes.append("52wk highs >15 but few heavyweights")
    if w.get("sector_cluster_matching_index"):
        score += 4
        notes.append("sector cluster matches index")
    if low is not None and low >= 10 and (high is None or high < 5):
        score = -5
        notes.append("many 52wk lows, few highs")
    return int(_clip(round(score), -10, 10)), True, "; ".join(notes) or "counts H=%s L=%s" % (high, low)


# ------------------------------------------------------ fixed clock --------
class _FixedDT(datetime.datetime):
    _fixed_now = None

    @classmethod
    def now(cls, tz=None):
        if cls._fixed_now is not None:
            return cls._fixed_now
        return datetime.datetime.now(tz)

    @classmethod
    def today(cls):
        return cls.now()


def _greeks_with_clock(now_dt, oc, vix):
    """Call greeks.analyse with a deterministic clock when now_dt is given
    (same harness technique as backtest_history.py)."""
    if now_dt is None:
        return greeks_analyse(oc, vix=vix)
    _FixedDT._fixed_now = now_dt
    original = _greeks_mod.datetime
    _greeks_mod.datetime = SimpleNamespace(
        datetime=_FixedDT, strptime=datetime.datetime.strptime,
        timedelta=datetime.timedelta)
    try:
        return greeks_analyse(oc, vix=vix)
    finally:
        _greeks_mod.datetime = original
        _FixedDT._fixed_now = None


# ------------------------------------------------------- trade builder -----
def build_trade(snapshot, gk, lv, side, strategy):
    """BUY-only trade from real prices. Returns (trade|None, gates, risk_flags).
    Never invents LTP, never emits option selling."""
    gates, risks = [], []
    records = snapshot["option_chain"]["records"]
    spot = records["underlyingValue"]
    expiry_raw = records["expiryDates"][0]
    rows = [r for r in records["data"] if r["expiryDate"] == expiry_raw]
    if not rows:
        return None, ["OPTION_ROWS_UNAVAILABLE"], risks
    levels_map = (lv or {}).get("levels") or {}

    liquid = set((lv or {}).get("liquid_strikes_top5_oi") or [])
    atm = min(rows, key=lambda r: abs(r["strikePrice"] - spot))
    candidates = []
    for entry in (gk or {}).get("strikes") or []:
        strike = entry.get("strike")
        greek = entry.get(side) or {}
        delta = _num(greek.get("delta"))
        if strike is None or delta is None:
            continue
        if side == "CE" and 0.50 <= delta <= 0.60:
            candidates.append((abs(delta - 0.55), strike))
        elif side == "PE" and -0.60 <= delta <= -0.50:
            candidates.append((abs(delta + 0.55), strike))
    if candidates:
        candidates.sort()
        strike = candidates[0][1]
    else:
        strike = atm["strikePrice"]
        risks.append("STRIKE_DELTA_TARGET_UNAVAILABLE: ATM used (never far OTM)")

    row = next((r for r in rows if r["strikePrice"] == strike), atm)
    side_data = row.get(side) or {}

    if liquid:
        if strike not in liquid:
            gates.append("LIQUIDITY: strike %s not in top-5 OI" % strike)
    else:
        gates.append("LIQUIDITY: cannot verify top-5 OI (levels unavailable)")

    volume = _num(side_data.get("totalTradedVolume"))
    if volume is None:
        risks.append("VOLUME_UNVERIFIED: strike volume not in snapshot")
    elif volume < 1000:
        gates.append("LIQUIDITY: strike volume %.0f < 1000 lots" % volume)

    spreads = (lv or {}).get("spread_pct_near_atm") or {}
    spread = None
    if isinstance(spreads.get(strike), dict):
        spread = _num(spreads[strike].get(side))
    if spread is None:
        risks.append("SPREAD_UNVERIFIABLE: bid/ask not in snapshot")
    elif spread > 2:
        gates.append("SPREAD: %.2f%% > 2%% at strike %s" % (spread, strike))

    entry = _num(side_data.get("lastPrice"))
    if entry is None or entry <= 0:
        gates.append("ENTRY_PRICE_UNAVAILABLE: no real LTP for %s %s" % (strike, side))
        return None, gates, risks

    sl = round(entry * 0.75, 2)
    tp1 = round(entry * 1.40, 2)
    tp2 = round(entry * 1.80, 2)
    risk = entry - sl
    rr1 = round((tp1 - entry) / risk, 2) if risk > 0 else 0
    rr2 = round((tp2 - entry) / risk, 2) if risk > 0 else 0
    if rr1 < 1.5:
        gates.append("RR_INVALID: TP1 R:R %.2f < 1.5" % rr1)
    if rr2 < 2.0:
        gates.append("RR_INVALID: TP2 R:R %.2f < 2" % rr2)

    if side == "CE":
        invalidation = levels_map.get("oi_support", levels_map.get("support"))
        targets = [levels_map.get("oi_resistance", levels_map.get("resistance")),
                   (gk or {}).get("expected_move_1sigma") and round(spot + (gk or {}).get("expected_move_1sigma", 0))]
    else:
        invalidation = levels_map.get("oi_resistance", levels_map.get("resistance"))
        targets = [levels_map.get("oi_support", levels_map.get("support")),
                   (gk or {}).get("expected_move_1sigma") and round(spot - (gk or {}).get("expected_move_1sigma", 0))]
    targets = [t for t in targets if isinstance(t, (int, float))]

    # greeks rule: TP1 underlying target must sit inside 50% of expected move
    expected_move = _num((gk or {}).get("expected_move_1sigma"))
    if expected_move and targets:
        if abs(targets[0] - spot) > 0.5 * expected_move:
            gates.append("EXPECTED_MOVE: TP1 target beyond 50%% of 1-sigma move (%.1f)" % expected_move)

    try:
        expiry_iso = datetime.datetime.strptime(expiry_raw, "%d-%b-%Y").date().isoformat()
    except ValueError:
        expiry_iso = expiry_raw

    trade = {
        "strike": strike,
        "option_type": side,
        "expiry": expiry_iso,
        "expiry_raw": expiry_raw,
        "entry": entry,
        "entry_zone": [round(entry * 0.97, 2), round(entry * 1.03, 2)],
        "sl": sl,
        "stop_loss_premium": sl,
        "tp1": tp1,
        "tp1_premium": tp1,
        "tp2": tp2,
        "tp2_premium": tp2,
        "risk_reward_tp1": rr1,
        "risk_reward_tp2": rr2,
        "invalidation": invalidation,
        "underlying_invalidation": invalidation,
        "underlying_targets": targets,
        "time_stop": "14:45",
        "order_type": "limit",
        "suggested_lots": 1,
        "strategy": strategy,
        "option_type_note": "BUY only - option selling is BLOCKED by this skill",
    }
    return trade, gates, risks


def decide(score, gates_failed, tally=None):
    """Pure decision core. Thresholds +40/-40 are fixed and never derived
    from news, ceiling reports, or trade count."""
    if gates_failed:
        return "NO_TRADE"
    if score >= _agree.THRESHOLD_BUY_CE:
        action = "BUY_CE"
    elif score <= _agree.THRESHOLD_BUY_PE:
        action = "BUY_PE"
    else:
        return "NO_TRADE"
    if tally is not None and not tally.get("gate_passed", False):
        return "NO_TRADE"
    if action not in BUY_ACTIONS:
        return "NO_TRADE"
    return action


def _confidence(score, tally):
    absolute = abs(score)
    if absolute >= 80:
        level = "Very high"
    elif absolute >= 60:
        level = "High"
    elif absolute >= 40:
        level = "Moderate"
    else:
        return "NA"
    # drop one notch when fewer than 4 groups agree
    if tally is not None and tally.get("groups_available", 0) >= 4 and tally.get("groups_agreeing", 0) < 4:
        level = "Moderate" if level in ("Very high", "High") else level
    return level


def _event_risk(snapshot):
    er = snapshot.get("event_risk")
    if isinstance(er, dict):
        return str(er.get("level") or "").lower(), er
    if isinstance(er, str):
        return er.lower(), {"level": er}
    return None, None


def score_snapshot(snapshot, now=None):
    """Deterministic scoring + gating core. Returns the full signal dict."""
    now_dt = _parse_now(now)
    gates = []
    missing = []
    notes = []
    risks = []

    records, dq = _prov.records_from_snapshot(snapshot, now=now_dt)
    if not dq.get("core_fresh"):
        gates.append("DATA_FRESHNESS: core inputs not provably fresh (overall %s)" % dq.get("overall"))

    current_time = now_dt.time()
    if current_time < datetime.time(9, 30):
        gates.append("before 09:30 IST")
    if current_time > datetime.time(14, 45):
        gates.append("after 14:45 IST")

    # option chain (frozen) -- hard requirement
    try:
        oc, lv = option_chain_score(snapshot["option_chain"])
    except Exception:
        gates.append("option chain unavailable")
        tally = _agree.tally_groups({}, {})
        ceiling = _agree.ceiling_report({}, {})
        news_ctx = _news.build_news_context(
            snapshot.get("news") or [], now_dt,
            symbol=snapshot.get("symbol") or snapshot.get("instrument"),
            market_direction="NEUTRAL", market_obs=snapshot.get("news_market_obs"))
        return {
            "bias_score": 0,
            "components": {"option_chain": 0, "fii": 0, "breadth": 0, "greeks": 0},
            "component_scores": {}, "group_scores": {}, "availability": {},
            "greeks": None, "levels": None,
            "action": "NO_TRADE", "decision": "NO_TRADE",
            "gates_failed": gates, "gates": gates,
            "source": SOURCE, "role": ROLE,
            "symbol": snapshot.get("symbol") or snapshot.get("instrument"),
            "timestamp_ist": now_dt.strftime("%Y-%m-%d %H:%M"),
            "bias": "NEUTRAL", "confidence": "NA",
            "agreement": tally, "score_ceiling": ceiling,
            "score_ceiling_message": _agree.ceiling_message(ceiling),
            "data_quality": dq,
            "news_context": news_ctx,
            "sentiment_context": news_ctx.get("sentiment"),
            "strategy": snapshot.get("strategy"),
            "trade": None, "trade_attempt": None,
            "supporting_evidence": [], "conflicting_evidence": [],
            "missing_inputs": missing + ["option_chain"],
            "reason": "NO_TRADE: option chain unavailable - no invented inputs",
            "risk_flags": risks, "notes": notes,
            "disclaimer": DISCLAIMER,
        }

    # FII group (frozen base + optional BSE addon)
    fii_list = snapshot.get("fii_dii")
    f_base = fii_score(fii_list) if isinstance(fii_list, list) else 0
    f_available = False
    if isinstance(fii_list, list):
        f_available = any(
            ("FII" in str(x.get("category") or "")) or ("FPI" in str(x.get("category") or ""))
            for x in fii_list if isinstance(x, dict))
    f_addon, f_addon_available = fii_bse_addon(snapshot, f_base)
    if f_addon_available and f_base != 0 and f_addon == 0:
        notes.append("BSE FII contradicts NSE FII - futures component cancelled to 0")
    if not f_available and not f_addon_available:
        missing.append("fii_dii")
    f_group = int(_clip(f_base + f_addon, -9, 9))

    # breadth group (frozen breadth + heavyweights)
    b_group, b_available, b_detail = breadth_group_score(snapshot)
    if not b_available:
        missing.append("gainers/losers")

    # greeks group (fixed clock when now given)
    vix = None
    try:
        vix = next((x["last"] for x in snapshot.get("all_indices", {}).get("data", [])
                    if x.get("index") == "INDIA VIX"), None)
    except Exception:
        vix = None
    if vix is None:
        missing.append("india_vix")
    gk, g_available = None, False
    try:
        gk = _greeks_with_clock(now_dt, snapshot["option_chain"], vix)
        g_available = True
        gates = gates + list(gk.get("gates_failed") or [])
        theta_pct = _num(gk.get("atm_theta_per_day_pct_of_premium"))
        if theta_pct is not None and theta_pct > THETA_GATE_PCT:
            gates.append("ATM theta %.1f%%/day > %.0f%%: no fresh buys" % (theta_pct, THETA_GATE_PCT))
        # expiry-day after 13:30 (SEBI Thursday rule enforced upstream)
        try:
            expiry_date = datetime.datetime.strptime(gk.get("expiry"), "%d-%b-%Y").date()
            if expiry_date == now_dt.date() and current_time > datetime.time(13, 30):
                gates.append("expiry day after 13:30 IST: no fresh entries")
        except (ValueError, TypeError):
            pass
        if _num(vix) is not None and _num(vix) > VIX_RISK_LEVEL:
            risks.append("VIX_HIGH: >%.0f - half size, ITM only" % VIX_RISK_LEVEL)
    except Exception:
        missing.append("greeks")
    g_group = int(gk.get("greek_score", 0)) if gk else 0

    # optional groups (normalized snapshot["groups"] contract)
    h_group, h_available, h_detail = heatmap_group_score(snapshot)
    if not h_available:
        missing.append("heatmap group")
    o_group, o_available, o_detail = oi_spurts_group_score(snapshot)
    if not o_available:
        missing.append("oi_spurts group")
    p_group, p_available, p_detail = preopen_group_score(snapshot)
    if not p_available:
        missing.append("preopen group")
    w_group, w_available, w_detail = week52_group_score(snapshot)
    if not w_available:
        missing.append("week52 group")

    group_scores = {
        "option_chain": oc,
        "fii": f_group,
        "greeks": g_group,
        "heatmap": h_group,
        "oi_spurts": o_group,
        "breadth": b_group,
        "preopen": p_group,
        "week52": w_group,
    }
    availability = {
        "option_chain": True,
        "fii": f_available or f_addon_available,
        "greeks": g_available,
        "heatmap": h_available,
        "oi_spurts": o_available,
        "breadth": b_available,
        "preopen": p_available,
        "week52": w_available,
    }

    score = int(_clip(round(sum(
        group_scores[k] for k in group_scores if availability[k])), -100, 100))

    tally = _agree.tally_groups(group_scores, availability)
    ceiling = _agree.ceiling_report(group_scores, availability)
    ceiling_msg = _agree.ceiling_message(ceiling)
    if not tally.get("gate_passed"):
        gates.append("4/8 group agreement not met: " + tally.get("gate", ""))

    # event risk + daily loss (only when provided; absence is reported)
    level, _ = _event_risk(snapshot)
    if level in ("major", "high", "critical"):
        gates.append("EVENT_RISK: major scheduled event pending")
    elif level is None:
        missing.append("event_risk (not provided - cannot verify)")
    daily_loss = _num(snapshot.get("daily_loss_pct"))
    if daily_loss is not None and daily_loss >= 3:
        gates.append("DAILY_LOSS_LIMIT: %.1f%% >= 3%% daily cap" % daily_loss)

    # news context (never touches score or decision)
    direction = "BULLISH" if score > 0 else "BEARISH" if score < 0 else "NEUTRAL"
    news_ctx = _news.build_news_context(
        snapshot.get("news") or [], now_dt,
        symbol=snapshot.get("symbol") or snapshot.get("instrument"),
        market_direction=direction, market_obs=snapshot.get("news_market_obs"))
    sentiment = news_ctx.get("sentiment")
    if news_ctx.get("excluded_lookahead"):
        notes.append("%d news item(s) excluded as look-ahead" % len(news_ctx["excluded_lookahead"]))
    if not (snapshot.get("news") or []):
        missing.append("news (optional context, not provided)")

    action = decide(score, gates, tally)
    strategy = snapshot.get("strategy")

    trade = None
    trade_attempt = None
    if action in BUY_ACTIONS:
        if not strategy:
            gates.append("NO_NAMED_STRATEGY: every trade must name its strategy (S1-S8)")
            action = decide(score, gates, tally)
        try:
            full_levels = _levels_mod.build(snapshot)
        except Exception:
            full_levels = None
            gates.append("LIQUIDITY: cannot verify (levels unavailable)")
            action = decide(score, gates, tally)
        if action in BUY_ACTIONS and full_levels is not None:
            side = "CE" if action == "BUY_CE" else "PE"
            trade, trade_gates, trade_risks = build_trade(
                snapshot, gk, full_levels, side, strategy)
            gates = gates + trade_gates
            risks = risks + trade_risks
            action = decide(score, gates, tally)
            if action not in BUY_ACTIONS and trade is not None:
                trade_attempt = trade
                trade = None
            elif action not in BUY_ACTIONS:
                trade_attempt = {"blocked_by": trade_gates or gates[-3:]}

    if action not in BUY_ACTIONS:
        trade = None

    # evidence + reason
    supporting, conflicting = [], []
    direction_final = "BULLISH" if score > 0 else ("BEARISH" if score < 0 else "NEUTRAL")
    for group in _agree.GROUPS:
        key = group["key"]
        if not availability.get(key):
            continue
        value = group_scores[key]
        label = group["label"]
        if value == 0:
            supporting.append("%s: neutral (0)" % label)
        elif (value > 0 and direction_final == "BULLISH") or (value < 0 and direction_final == "BEARISH"):
            supporting.append("%s: %+d agrees" % (label, value))
        else:
            conflicting.append("%s: %+d opposes %s" % (label, value, direction_final))
    for conflict in news_ctx.get("conflicts") or []:
        conflicting.append("%s (%s)" % (conflict.get("code"), conflict.get("headline")))
    if gk:
        for gnote in gk.get("notes") or []:
            notes.append("greeks: " + str(gnote))

    if action in BUY_ACTIONS:
        reason = ("%s: score %+d meets %+d/%+d; %d/8 groups available, %d agree %s; "
                  "strategy %s; all gates passed" % (
                      action, score, _agree.THRESHOLD_BUY_CE, _agree.THRESHOLD_BUY_PE,
                      tally["groups_available"], tally["groups_agreeing"],
                      tally["direction"], strategy))
    else:
        blocking = gates[-3:] if gates else ["score %+d within +/-40" % score]
        reason = "NO_TRADE: " + "; ".join(str(x) for x in blocking)

    missing_inputs = missing + [r["name"] + " (" + str(r.get("status")) + ")"
                                for r in dq.get("inputs", [])
                                if r.get("status") in (_prov.MISSING, _prov.UNAVAILABLE, _prov.STALE)
                                and r["name"] not in missing]
    missing_inputs = list(dict.fromkeys(missing_inputs))

    old_components = {"option_chain": oc, "fii": f_group, "breadth": b_group, "greeks": g_group}
    greeks_out = None
    if gk:
        greeks_out = {k: gk[k] for k in (
            "atm_iv", "skew_put_minus_call", "gamma_flip", "regime",
            "expected_move_1sigma", "hours_to_expiry", "expiry", "atm_strike",
            "net_gex", "atm_theta_per_day_pct_of_premium", "strikes") if k in gk}

    output = {
        # ---- pre-existing keys (backward compatible) ----
        "bias_score": score,
        "components": old_components,
        "greeks": greeks_out,
        "levels": lv,
        "action": action,
        "gates_failed": gates,
        "note": ("Scored 8 groups per scoring-rules.md; %s" % (
            "trade candidate ready for supervisor review" if action in BUY_ACTIONS
            else "no trade - see gates/reason")),
        # ---- section 20 extensions ----
        "decision": action,
        "source": SOURCE,
        "role": ROLE,
        "symbol": snapshot.get("symbol") or snapshot.get("instrument"),
        "timestamp_ist": now_dt.strftime("%Y-%m-%d %H:%M"),
        "bias": direction_final,
        "confidence": _confidence(score, tally),
        "component_scores": dict(group_scores),
        "group_scores": dict(group_scores),
        "availability": dict(availability),
        "agreement": tally,
        "data_quality": dq,
        "news_context": news_ctx,
        "sentiment_context": sentiment,
        "strategy": strategy,
        "trade": trade,
        "trade_attempt": trade_attempt,
        "supporting_evidence": supporting,
        "conflicting_evidence": conflicting,
        "missing_inputs": missing_inputs,
        "gates": gates,
        "reason": reason,
        "score_ceiling": ceiling,
        "score_ceiling_message": ceiling_msg,
        "risk_flags": risks,
        "notes": notes,
        "disclaimer": DISCLAIMER,
    }
    if action not in BUY_ACTIONS and action != "NO_TRADE":
        # belt & braces: this skill never emits option selling
        output["action"] = "NO_TRADE"
        output["decision"] = "NO_TRADE"
        output["gates_failed"] = gates + ["OPTION_SELLING_BLOCKED"]
        output["gates"] = output["gates_failed"]
        output["trade"] = None
    return output


def main(path):
    snap = json.load(open(path))
    print(json.dumps(score_snapshot(snap), indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
