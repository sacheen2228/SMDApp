#!/usr/bin/env python3
"""News + sentiment context layer for the NSE Options Signal skill.

Context only: news NEVER enters bias_score, NEVER maps directly to CE/PE,
and can NEVER force a trade. It only appends supporting/conflicting evidence
to the signal Grok already decides on.

Event schema (see references/news-schema.md):
  event_id, source, headline, published_at, received_at, event_type,
  sentiment (-1|0|1), impact (0-100), confidence (0-100), affected_symbol,
  affected_sector, market_wide, verified (bool), source_reliability (0-1),
  time_horizon, unverified (bool, social), corroborated_by [sources]

No historical news source exists for backtests -> backtest_history.py is
untouched and never fabricates news.
"""
import datetime as _dt

SOCIAL_HINTS = ("twitter", "x.com", "telegram", "whatsapp", "reddit",
                "youtube", "social", "unverified_handle", "fininfluencer")
NON_SOCIAL_SOURCES_HINTS = ("reuters", "bloomberg", "mint", "economictimes",
                            "business_standard", "cnbctv18", "moneycontrol",
                            "nse", "bse", "rbi", "sebi", "exchange")

LOOKAHEAD_EXCLUDED = "LOOKAHEAD_EXCLUDED"
VALID_EVENT_TYPES = {
    "RBI_POLICY", "US_FED", "BUDGET", "ELECTION", "GEOPOLITICS",
    "EARNINGS", "MOOD", "RATING", "INFLATION", "OTHER",
}


def _parse(value):
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = _dt.datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone().replace(tzinfo=None)
        return parsed
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d-%b-%Y %H:%M:%S",
                "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def is_social(event):
    if event.get("unverified"):
        return True
    src = str(event.get("source", "")).lower()
    channel = str(event.get("channel", "")).lower()
    return any(h in src or h in channel for h in SOCIAL_HINTS)


def looks_non_social(source):
    src = str(source or "").lower()
    return any(h in src for h in NON_SOCIAL_SOURCES_HINTS)


def normalize_events(raw_events, decision_time, symbol=None):
    """Validate + look-ahead filter. Events with published_at/received_at
    AFTER decision_time are excluded (recorded, never counted).
    Returns (events, excluded)."""
    decision_dt = _parse(decision_time) if decision_time is not None else None
    events, excluded = [], []
    for i, raw in enumerate(raw_events or []):
        if not isinstance(raw, dict):
            excluded.append({"index": i, "reason": "not_an_object"})
            continue
        event = dict(raw)
        event.setdefault("event_id", "evt_%d" % i)
        event.setdefault("source", None)
        event.setdefault("headline", None)
        event.setdefault("event_type", "OTHER")
        event["sentiment"] = 1 if (raw.get("sentiment") or 0) > 0 else (
            -1 if (raw.get("sentiment") or 0) < 0 else 0)
        try:
            event["impact"] = max(0, min(100, int(raw.get("impact", 0) or 0)))
        except (TypeError, ValueError):
            event["impact"] = 0
        try:
            event["confidence"] = max(0, min(100, int(raw.get("confidence", 0) or 0)))
        except (TypeError, ValueError):
            event["confidence"] = 0
        event.setdefault("market_wide", False)
        event.setdefault("verified", not is_social(event))
        event.setdefault("source_reliability", 0.5 if is_social(event) else 0.7)
        event.setdefault("time_horizon", "short_term")
        event["unverified"] = bool(is_social(event) and not event.get("corroborated_by"))

        pub = _parse(raw.get("published_at"))
        rec = _parse(raw.get("received_at"))
        if decision_dt is not None and ((pub and pub > decision_dt) or
                                        (rec and rec > decision_dt)):
            excluded.append({
                "event_id": event["event_id"],
                "headline": event.get("headline"),
                "published_at": raw.get("published_at"),
                "reason": LOOKAHEAD_EXCLUDED,
            })
            continue
        if event["event_type"] not in VALID_EVENT_TYPES:
            event["event_type"] = "OTHER"
        events.append(event)
    return events, excluded


def dedupe_events(events):
    """Group by event_id. Impact is NEVER multiplied: consolidated impact =
    max(impact); confidence may rise slightly for independent corroboration
    (capped 100). Sources merged into sources[]."""
    groups = {}
    order = []
    for event in events:
        key = event.get("event_id")
        if key not in groups:
            groups[key] = dict(event)
            groups[key]["sources"] = [event.get("source")] if event.get("source") else []
            order.append(key)
        else:
            base = groups[key]
            if event.get("source") and event["source"] not in base["sources"]:
                base["sources"].append(event["source"])
            base["impact"] = max(base.get("impact", 0), event.get("impact", 0))
            base["confidence"] = max(base.get("confidence", 0), event.get("confidence", 0))
            base["sentiment"] = event.get("sentiment", base.get("sentiment"))
            if event.get("headline") and not base.get("headline"):
                base["headline"] = event["headline"]
            for key2 in ("verified", "unverified", "corroborated_by"):
                if event.get(key2) and not base.get(key2):
                    base[key2] = event[key2]
    out = []
    for key in order:
        base = groups[key]
        distinct = [s for s in dict.fromkeys(base.get("sources", [])) if s]
        verified_distinct = [s for s in distinct if looks_non_social(s)]
        if len(verified_distinct) > 1:
            bump = 5 * (len(verified_distinct) - 1)
            base["confidence"] = min(100, base.get("confidence", 0) + bump)
        base["deduped_count"] = len([e for e in events if e.get("event_id") == key])
        # unverified stays until a non-social corroboration exists
        if base.get("unverified") and verified_distinct:
            base["unverified"] = False
            base["verified"] = True
        out.append(base)
    return out


def relevant_to_symbol(event, symbol):
    if event.get("market_wide"):
        return True
    affected = event.get("affected_symbol")
    if not affected:
        return True  # sector/market news with no symbol pinned still shows in context
    if symbol and str(affected).upper() == str(symbol).upper():
        return True
    return False


def aggregate_sentiment(events, symbol=None):
    """Weighted mean sentiment in [-1, 1] over verified, relevant events.
    Unverified events are reported but contribute 0."""
    relevant = [e for e in events if relevant_to_symbol(e, symbol)]
    verified = [e for e in relevant if not e.get("unverified")]
    unverified = [e for e in relevant if e.get("unverified")]
    total_w, weighted = 0.0, 0.0
    for event in verified:
        w = max(1.0, float(event.get("confidence", 0)) * max(0.1, float(event.get("source_reliability", 0.5))))
        weighted += event.get("sentiment", 0) * w
        total_w += w
    score = round(weighted / total_w, 3) if total_w else 0.0
    n_pos = sum(1 for e in verified if e.get("sentiment") == 1)
    n_neg = sum(1 for e in verified if e.get("sentiment") == -1)
    dominant = "BULLISH" if score > 0.1 else "BEARISH" if score < -0.1 else "NEUTRAL"
    return {
        "score": score,
        "n_events": len(relevant),
        "n_verified": len(verified),
        "n_unverified": len(unverified),
        "dominant": dominant,
        "unverified_headlines": [
            {"headline": e.get("headline"), "source": e.get("source"),
             "status": "UNVERIFIED"} for e in unverified
        ],
    }


def classify_confirmation(event, market_obs=None):
    """CONFIRMED | PARTIALLY_CONFIRMED | NOT_CONFIRMED | UNKNOWN.
    Only uses values the caller actually observed - never fabricates
    post-event price/volume/OI/IV data. UNKNOWN when nothing observed."""
    obs = market_obs or {}
    sign = 1 if event.get("sentiment", 0) > 0 else (-1 if event.get("sentiment", 0) < 0 else 0)
    checks = []
    for key in ("price_change_after_event", "volume_change", "oi_change",
                "iv_change", "vix_change", "breadth_change"):
        value = obs.get(key)
        if value is None:
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        if value == 0:
            checks.append(0)
        else:
            aligned = (value > 0 and sign > 0) or (value < 0 and sign < 0)
            checks.append(1 if aligned else -1)
    if not checks:
        return "UNKNOWN"
    positive = sum(1 for c in checks if c > 0)
    negative = sum(1 for c in checks if c < 0)
    if sign == 0:
        return "PARTIALLY_CONFIRMED"
    if positive and not negative:
        return "CONFIRMED"
    if negative and not positive:
        return "NOT_CONFIRMED"
    return "PARTIALLY_CONFIRMED"


def news_bias_direction(aggregate):
    if aggregate["score"] > 0.1:
        return "BULLISH"
    if aggregate["score"] < -0.1:
        return "BEARISH"
    return "NEUTRAL"


def conflicting_news(events, market_direction, min_impact=40):
    """Return conflict entries, e.g. NEWS_BULLISH vs MARKET_BEARISH.
    News never overrides price: it is surfaced as conflicting evidence."""
    conflicts = []
    market = str(market_direction or "NEUTRAL").upper()
    if market == "NEUTRAL":
        return conflicts
    for event in events:
        if event.get("unverified") or event.get("impact", 0) < min_impact:
            continue
        news_dir = "BULLISH" if event.get("sentiment", 0) > 0 else (
            "BEARISH" if event.get("sentiment", 0) < 0 else "NEUTRAL")
        if news_dir == "NEUTRAL":
            continue
        if news_dir != market:
            conflicts.append({
                "code": "NEWS_%s_vs_MARKET_%s" % (news_dir, market),
                "event_id": event.get("event_id"),
                "headline": event.get("headline"),
                "impact": event.get("impact"),
            })
    return conflicts


def build_news_context(raw_events, decision_time, symbol=None, market_direction=None,
                       market_obs=None):
    """Full news_context block for the signal output. Side-effect free."""
    events, excluded = normalize_events(raw_events, decision_time, symbol)
    deduped = dedupe_events(events)
    aggregate = aggregate_sentiment(deduped, symbol)
    confirmations = []
    for event in deduped:
        if event.get("unverified"):
            continue
        confirmations.append({
            "event_id": event.get("event_id"),
            "price_confirmation": classify_confirmation(event, market_obs),
        })
    conflicts = conflicting_news(deduped, market_direction)
    present = bool(deduped) or bool(excluded)
    return {
        "present": present,
        "events": deduped,
        "deduped_count": len(deduped),
        "raw_count": len(raw_events or []),
        "excluded_lookahead": excluded,
        "sentiment": aggregate,
        "price_confirmations": confirmations,
        "conflicts": conflicts,
        "role": "CONTEXT_ONLY_NEVER_DECIDES",
        "note": ("News is context: it cannot raise the score, cannot map "
                 "directly to CE/PE, and can never force a trade. Conflicts "
                 "with price direction are surfaced, not resolved by news."),
    }


if __name__ == "__main__":
    import json, sys
    events = json.load(open(sys.argv[1]))
    decision_time = sys.argv[2] if len(sys.argv) > 2 else None
    print(json.dumps(build_news_context(events, decision_time), indent=2))
