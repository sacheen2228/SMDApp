#!/usr/bin/env python3
"""Grok handoff builder for the NSE Options Signal skill.

Wraps the full signal output with explicit role labels so the Grok
supervisor (src/lib/agents/supervisor.ts) can consume it as a
SECOND OPINION / research input:

  source: NSE_OPTIONS_SIGNAL
  role:   OPTIONS_RESEARCH_SECOND_OPINION
  authority: RESEARCH_INPUT_ONLY - never overrides the supervisor decision

This module only WRAPS output. It never sends anything (Telegram/API
sending stays with existing production paths), and it never becomes a
second supervisor or a second news agent.
"""
import json

SOURCE = "NSE_OPTIONS_SIGNAL"
ROLE = "OPTIONS_RESEARCH_SECOND_OPINION"
AUTHORITY = "RESEARCH_INPUT_ONLY"
SKILL_VERSION = "2.1.0"


def build_handoff(signal_output, symbol=None, session_id=None):
    """Return a machine-readable handoff object (JSON-serializable)."""
    output = dict(signal_output or {})
    decision = output.get("decision") or output.get("action") or "NO_TRADE"
    bias = output.get("bias_score", 0)
    try:
        bias = int(bias)
    except (TypeError, ValueError):
        bias = 0

    risk_flags = []
    for gate in output.get("gates_failed") or []:
        risk_flags.append(str(gate))
    ceiling = output.get("score_ceiling") or {}
    if ceiling.get("detected"):
        risk_flags.append("SCORE_CEILING_DETECTED")
    news = output.get("news_context") or {}
    if news.get("conflicts"):
        for conflict in news["conflicts"]:
            risk_flags.append(conflict.get("code", "NEWS_CONFLICT"))
    unverified = (news.get("sentiment_context") or output.get("sentiment_context") or {}).get("n_unverified", 0)
    if unverified:
        risk_flags.append("UNVERIFIED_NEWS_PRESENT")

    dq = output.get("data_quality") or {}
    if not dq.get("core_fresh", False):
        risk_flags.append("DATA_NOT_FRESH")

    handoff = {
        "source": SOURCE,
        "role": ROLE,
        "authority": AUTHORITY,
        "skill_version": SKILL_VERSION,
        "symbol": symbol or output.get("symbol") or output.get("instrument"),
        "session_id": session_id,
        "timestamp_ist": output.get("timestamp_ist"),
        "decision": decision,
        "bias_score": bias,
        "bias": "BULLISH" if bias >= 40 else "BEARISH" if bias <= -40 else
                ("MILD_BULLISH" if bias > 0 else "MILD_BEARISH" if bias < 0 else "NEUTRAL"),
        "can_force_trade": False,
        "supersedes_supervisor": False,
        "risk_flags": risk_flags,
        "signal": output,
    }
    return handoff


def handoff_json(signal_output, symbol=None, session_id=None):
    return json.dumps(build_handoff(signal_output, symbol, session_id), indent=2)


if __name__ == "__main__":
    import sys
    payload = json.load(open(sys.argv[1]))
    symbol = sys.argv[2] if len(sys.argv) > 2 else None
    print(handoff_json(payload, symbol=symbol))
