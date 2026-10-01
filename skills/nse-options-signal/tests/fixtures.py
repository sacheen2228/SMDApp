#!/usr/bin/env python3
"""Deterministic offline fixtures for the NSE Options Signal skill tests.
No network. No randomness. Synthetic but structurally realistic NSE payloads."""
import datetime as dt

EXPIRY = "08-Oct-2026"          # next Thursday (SEBI rule)
NOW = dt.datetime(2026, 9, 25, 10, 0, 0)   # Friday 10:00 IST, market open


def _strike_rows(spot=25000):
    rows = []
    for strike in range(24400, 25700, 100):
        distance = strike - spot
        # OI walls: max CE at 25100, max PE at 24900; ATM 25000 liquid but below walls
        ce_oi = 1_000_000 + (9_000_000 if strike == 25000 else 0) + \
            (11_000_000 if strike == 25100 else 0) + max(0, 500_000 - distance * 10)
        pe_oi = 1_000_000 + (9_000_000 if strike == 25000 else 0) + \
            (14_000_000 if strike == 24900 else 0) + max(0, 500_000 + distance * 10)
        if strike >= spot:
            pe_oi += 2_500_000  # put writing at/above spot -> PCR > 1.3
        # LTP: rough straddle falling with moneyness
        ce_ltp = max(5.0, 150 - distance * 0.45)
        pe_ltp = max(5.0, 150 + distance * -0.45)
        row = {
            "strikePrice": strike,
            "expiryDate": EXPIRY,
            "CE": {
                "openInterest": int(ce_oi),
                "changeinOpenInterest": 250_000 if strike <= 25100 else -50_000,
                "lastPrice": round(ce_ltp, 2),
                "totalTradedVolume": 5000 if strike in (25000, 25100) else 2500,
                "impliedVolatility": 13.5 if strike == 25000 else 12.0,
                "bidprice": round(ce_ltp - 1, 2),
                "askPrice": round(ce_ltp + 1, 2),
            },
            "PE": {
                "openInterest": int(pe_oi),
                "changeinOpenInterest": 400_000 if strike >= 24900 else -30_000,
                "lastPrice": round(pe_ltp, 2),
                "totalTradedVolume": 4800 if strike in (24900, 25000) else 2500,
                "impliedVolatility": 14.5 if strike == 25000 else 13.0,
                "bidprice": round(pe_ltp - 1, 2),
                "askPrice": round(pe_ltp + 1, 2),
            },
        }
        rows.append(row)
    return rows


def base_snapshot():
    ts = NOW.strftime("%Y-%m-%d %H:%M:%S")
    prov = {
        "option_chain": {"source": "NSE India", "data_timestamp": ts,
                         "fetch_timestamp": ts, "status": "LIVE"},
        "vix": {"source": "NSE India", "data_timestamp": ts,
                "fetch_timestamp": ts, "status": "LIVE"},
        "fii_dii": {"source": "NSE India", "data_timestamp": ts,
                    "fetch_timestamp": ts, "status": "LIVE"},
        "gainers": {"source": "NSE India", "data_timestamp": ts,
                    "fetch_timestamp": ts, "status": "LIVE"},
        "losers": {"source": "NSE India", "data_timestamp": ts,
                   "fetch_timestamp": ts, "status": "LIVE"},
    }
    gainers = [
        {"symbol": s, "chgPercent": 3.1, "volume_spurt": True}
        for s in ("RELIANCE", "INFY", "TCS", "SBIN", "ITC", "LT",
                  "AXISBANK", "WIPRO", "ADANIENT", "TATASTEEL")
    ]
    losers = [{"symbol": s, "chgPercent": -2.4} for s in ("HDFCLIFE", "BAJAJ-AUTO", "NESTLEIND")]
    return {
        "symbol": "NIFTY",
        "fetched_at_ist": ts,
        "meta": {"source": "fixture", "fetched_at": ts, "provenance": prov},
        "option_chain": {
            "records": {
                "expiryDates": [EXPIRY, "15-Oct-2026"],
                "underlyingValue": 25000,
                "data": _strike_rows(),
                "timestamp": ts,
            }
        },
        "all_indices": {"data": [{"index": "INDIA VIX", "last": 13.2},
                                 {"index": "NIFTY 50", "last": 25000}]},
        "fii_dii": [{"category": "FII", "netValue": 2500.0},
                    {"category": "DII", "netValue": -800.0}],
        "gainers": {"NIFTY": {"data": gainers}},
        "losers": {"NIFTY": {"data": losers}},
        "groups": {
            "heatmap": {"weighted_return_pct": 0.6, "pct_weight_green": 70,
                        "sensex_weighted_pct": 0.5,
                        "sector_rotation_aligned": False},
            "oi_spurts": {"bullish_weight": 60, "bearish_weight": 30,
                          "total_weight": 90, "most_active_bias": 1},
            "preopen": {"gap_pct": 0.5, "ad_ratio": 2.5,
                        "close_auction_bias": 2},
            "week52": {"high_count": 18, "low_count": 1,
                       "heavyweights_at_high": 3},
            "fii_bse": {"agrees": True},
        },
        "strategy": "S1 OI wall rejection",
        "event_risk": {"level": "none"},
        "news": [
            {"event_id": "evt_policy", "source": "RBI",
             "headline": "RBI holds rates, dovish commentary",
             "published_at": "2026-09-25 09:00:00",
             "received_at": "2026-09-25 09:02:00",
             "event_type": "RBI_POLICY", "sentiment": 1, "impact": 70,
             "confidence": 85, "market_wide": True, "verified": True,
             "source_reliability": 0.9, "time_horizon": "short_term"},
            {"event_id": "evt_lookahead", "source": "Reuters",
             "headline": "Fed rate cut surprise (published after decision time)",
             "published_at": "2026-09-25 15:00:00",
             "received_at": "2026-09-25 15:01:00",
             "event_type": "US_FED", "sentiment": 1, "impact": 80,
             "confidence": 90, "market_wide": True, "verified": True,
             "source_reliability": 0.9},
            {"event_id": "evt_social", "source": "twitter:fininfluencer_x",
             "channel": "social",
             "headline": "Whisper: big foreign buying coming (unverified)",
             "published_at": "2026-09-25 09:40:00",
             "received_at": "2026-09-25 09:41:00",
             "event_type": "MOOD", "sentiment": 1, "impact": 40,
             "confidence": 30, "market_wide": True},
            {"event_id": "evt_policy", "source": "EconomicTimes",
             "headline": "RBI holds rates; policy verdict LIVE",
             "published_at": "2026-09-25 09:01:00",
             "received_at": "2026-09-25 09:03:00",
             "event_type": "RBI_POLICY", "sentiment": 1, "impact": 65,
             "confidence": 75, "market_wide": True, "verified": True,
             "source_reliability": 0.8},
        ],
    }


def bearish_snapshot():
    """Mirror of base_snapshot: PE-heavy, risk-off, bearish across groups."""
    snap = base_snapshot()

    # option chain: heavy call writing, PCR < 0.8, CE OI addition > PE
    for row in snap["option_chain"]["records"]["data"]:
        strike = row["strikePrice"]
        row["CE"]["openInterest"] = int(row["CE"]["openInterest"] * 3)
        row["PE"]["openInterest"] = int(row["PE"]["openInterest"] * 0.4)
        row["CE"]["changeinOpenInterest"] = 600_000 if strike >= 25000 else 100_000
        row["PE"]["changeinOpenInterest"] = -100_000
    # bearish IV skew: OTM put IV much higher than OTM call IV
    for row in snap["option_chain"]["records"]["data"]:
        if row["strikePrice"] == 24800:
            row["PE"]["impliedVolatility"] = 25.0
        if row["strikePrice"] == 25200:
            row["CE"]["impliedVolatility"] = 10.0

    # breadth inverted
    snap["gainers"] = {"NIFTY": {"data": [
        {"symbol": s, "chgPercent": -2.0} for s in ("WIPRO", "ADANIENT", "TATASTEEL")]}}
    snap["losers"] = {"NIFTY": {"data": [
        {"symbol": s, "chgPercent": -4.1, "volume_spurt": True}
        for s in ("RELIANCE", "INFY", "TCS", "SBIN", "ITC", "LT",
                  "AXISBANK", "HDFCBANK", "KOTAKBANK", "BHARTIARTL", "ICICIBANK")]}}

    # groups inverted
    snap["groups"] = {
        "heatmap": {"weighted_return_pct": -0.6, "pct_weight_green": 25,
                    "sensex_weighted_pct": -0.5, "sector_rotation_aligned": False},
        "oi_spurts": {"bullish_weight": 30, "bearish_weight": 60,
                      "total_weight": 90, "most_active_bias": -1},
        "preopen": {"gap_pct": -0.5, "ad_ratio": 0.3, "close_auction_bias": -2},
        "week52": {"high_count": 1, "low_count": 16},
        "fii_bse": {"agrees": True},
    }
    snap["fii_dii"] = [{"category": "FII", "netValue": -3000.0},
                       {"category": "DII", "netValue": 900.0}]

    # bearish news (impact 80, verified) - must still never decide anything
    snap["news"] = [
        {"event_id": "evt_geopolitics", "source": "Reuters",
         "headline": "Escalation risks spike, global risk-off",
         "published_at": "2026-09-25 08:30:00",
         "received_at": "2026-09-25 08:31:00",
         "event_type": "GEOPOLITICS", "sentiment": -1, "impact": 80,
         "confidence": 90, "market_wide": True, "verified": True,
         "source_reliability": 0.9, "time_horizon": "short_term"},
    ]
    return snap
