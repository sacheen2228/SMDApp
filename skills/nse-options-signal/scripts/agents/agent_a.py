#!/usr/bin/env python3
"""Agent A - the parent reads data/context.json (market bias, breadth, movers, freshness).

Agent A is CONTEXT, not a vote.  It never contributes to the directional
consensus; the orchestrator only uses it to detect a CONFLICT with the trade
direction, and a conflict forces an objectively-measured A+ setup + half size
(otherwise NO TRADE).

A missing / stale / corrupt context is reported (never silently used) but does
NOT veto on its own: a context that is absent cannot oppose anything.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents import protocol  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_MAX_AGE_HOURS = 12.0


def _parse_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), IST)
    text = str(value).strip().replace(" ", "T")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(str(value).strip(), fmt)
                break
            except ValueError:
                continue
        else:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=IST)


def load_context(path, now=None, max_age_hours=DEFAULT_MAX_AGE_HOURS):
    """Read + validate data/context.json. Never raises."""
    now = now or datetime.now(IST)
    if not path or not os.path.exists(path):
        return {"status": "MISSING", "path": path, "reason": "context file not found",
                "pre_market_bias": "TWO_WAY", "generated_at": None, "age_minutes": None,
                "inputs": [], "stale": True, "conflicts": []}
    try:
        with open(path) as fh:
            data = json.load(fh)
    except Exception as exc:
        return {"status": "CORRUPT", "path": path, "reason": "context file is not valid JSON: %s" % exc,
                "pre_market_bias": "TWO_WAY", "generated_at": None, "age_minutes": None,
                "inputs": [], "stale": True, "conflicts": []}
    if not isinstance(data, dict):
        return {"status": "CORRUPT", "path": path, "reason": "context file must contain a JSON object",
                "pre_market_bias": "TWO_WAY", "generated_at": None, "age_minutes": None,
                "inputs": [], "stale": True, "conflicts": []}

    bias = str(data.get("pre_market_bias") or "TWO_WAY").upper()
    if bias not in ("BULLISH", "BEARISH", "TWO_WAY"):
        bias = "TWO_WAY"
    gen = _parse_ts(data.get("generated_at"))
    if gen is None:
        return {"status": "MISSING", "path": path, "reason": "context has no generated_at timestamp",
                "pre_market_bias": bias, "generated_at": None, "age_minutes": None,
                "inputs": data.get("inputs") or [], "stale": True, "conflicts": []}
    age_min = (now - gen).total_seconds() / 60.0
    if age_min < -5:
        return {"status": "FUTURE", "path": path, "reason": "context generated_at is in the future",
                "pre_market_bias": bias, "generated_at": gen.isoformat(), "age_minutes": round(age_min, 1),
                "inputs": data.get("inputs") or [], "stale": True, "conflicts": []}
    stale = age_min > max_age_hours * 60
    conflicts = []
    bull = data.get("bull_count")
    bear = data.get("bear_count")
    if isinstance(bull, int) and isinstance(bear, int) and bull > 0 and bear > 0 and bias == "TWO_WAY":
        conflicts.append("context is two-way: %d bullish vs %d bearish inputs" % (bull, bear))
    return {
        "status": "STALE" if stale else "OK",
        "path": path,
        "reason": ("context is %.1f h old (limit %.0f h)" % (age_min / 60.0, max_age_hours)) if stale else "",
        "pre_market_bias": bias,
        "generated_at": gen.isoformat(),
        "age_minutes": round(age_min, 1),
        "bull_count": bull,
        "bear_count": bear,
        "usable_inputs": data.get("usable_inputs"),
        "inputs": data.get("inputs") or [],
        "breadth": data.get("breadth"),
        "movers": data.get("movers"),
        "stale": stale,
        "conflicts": conflicts,
    }


def run(task):
    """Agent A: read the context and report it (never a directional vote)."""
    now = _parse_ts(task.get("now")) or datetime.now(IST)
    path = task.get("context_path") or task.get("context")
    ctx = load_context(path, now=now, max_age_hours=float(task.get("max_age_hours", DEFAULT_MAX_AGE_HOURS)))
    data = {
        "context_status": ctx["status"],
        "context_path": ctx.get("path"),
        "pre_market_bias": ctx["pre_market_bias"],
        "generated_at": ctx.get("generated_at"),
        "age_minutes": ctx.get("age_minutes"),
        "bull_count": ctx.get("bull_count"),
        "bear_count": ctx.get("bear_count"),
        "usable_inputs": ctx.get("usable_inputs"),
        "stale": ctx.get("stale", True),
        "conflicts": ctx.get("conflicts", []),
        "inputs": [{"name": i.get("name"), "score": i.get("score"), "value": i.get("value"),
                    "stale": i.get("stale")} for i in (ctx.get("inputs") or [])
                   if isinstance(i, dict)],
    }
    notes = ["context %s: bias %s" % (ctx["status"], ctx["pre_market_bias"])]
    if ctx.get("reason"):
        notes.append(ctx["reason"])
    for c in ctx.get("conflicts", []):
        notes.append(c)
    res = protocol.result("A", direction="NEUTRAL", checks={
        "context_status": protocol.check(ctx["status"] in ("OK", "STALE"),
                                         ctx["status"], "OK",
                                         ctx.get("reason", "")),
    }, data=data, notes=notes)
    return res


if __name__ == "__main__":
    protocol.main_wrapper("A", run)
