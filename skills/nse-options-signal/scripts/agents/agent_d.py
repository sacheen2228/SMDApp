#!/usr/bin/env python3
"""Agent D - GEX validation.

The GEX engine (scripts/gex_engine.py) is the ONLY place gamma exposure is
computed.  Agent D never re-derives GEX: it runs the engine, validates the
record against references/gex-output-schema.json and checks the
regime -> strategy mapping:

    POSITIVE_GEX -> GEX-1 PIN_FADE
    NEGATIVE_GEX -> GEX-3 NEG_TREND (GEX-4 WALL_BREAK while net GEX is falling)
    TRANSITION   -> GEX-2 FLIP_BREAK (only after a confirmed 15-min close
                    beyond the gamma flip)

GEX gates (all of them are hard NO-TRADE gates):
    snapshot age < 15 min, >= 3 history snapshots, session window,
    expiry distance, frozen feed, 30-minute cooldown.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents import protocol, snapshots  # noqa: E402

import gex_engine  # noqa: E402
import jsonschema_mini  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.dirname(HERE)), "references", "gex-output-schema.json")

REGIME_STRATEGIES = {
    "POSITIVE_GEX": ("GEX-1 PIN_FADE",),
    "NEGATIVE_GEX": ("GEX-3 NEG_TREND", "GEX-4 WALL_BREAK"),
    "TRANSITION": ("GEX-2 FLIP_BREAK",),
}

GATE_RULES = (
    ("stale data", "GEX_SNAPSHOT_STALE", "<= 15 min old"),
    ("snapshot timestamp is in the future", "GEX_SNAPSHOT_FUTURE", "not in the future"),
    ("snapshot has no timestamp", "GEX_SNAPSHOT_TIMESTAMP_MISSING", "a data timestamp"),
    ("snapshot timestamp is not a valid", "GEX_SNAPSHOT_TIMESTAMP_INVALID", "a valid ISO timestamp"),
    ("lot size unknown", "GEX_LOT_SIZE_UNKNOWN", "a lot size from the contract master"),
    ("history snapshots", "GEX_HISTORY_INSUFFICIENT", ">= 3 history snapshots"),
    ("15-min candles", "GEX_CANDLES_INSUFFICIENT", ">= 22 closed 15m candles"),
    ("spot differs from last candle close", "GEX_SPOT_MISMATCH", "spot within 0.3% of the last close"),
    ("frozen feed", "GEX_FROZEN_FEED", "a changing feed"),
    ("before 09:30", "GEX_SESSION_NOT_OPEN", ">= 09:30 IST"),
    ("after 15:00", "GEX_SESSION_CLOSED", "< 15:00 IST"),
    ("to expiry", "GEX_EXPIRY_TOO_CLOSE", ">= 3h to expiry"),
    ("no valid GEX walls", "GEX_NO_WALLS", "a call or put wall"),
    ("cooldown", "GEX_COOLDOWN", "30 min between GEX trades"),
)


def classify_gate(message):
    """Map an engine gate message to (gate, observed, threshold)."""
    text = str(message)
    for needle, gate, threshold in GATE_RULES:
        if needle in text:
            return gate, text, threshold
    return "GEX_GATE", text, "all GEX gates must pass"


def _schema():
    try:
        with open(SCHEMA_PATH) as fh:
            return json.load(fh)
    except Exception as exc:
        raise RuntimeError("GEX output schema unavailable: %s" % exc)


def run(task):
    now = snapshots.gex_snapshot.parse_ts(task.get("now")) or datetime.now(IST)
    vetoes, checks, notes = [], {}, []

    gex_snap = task.get("gex_snapshot")
    if not isinstance(gex_snap, dict):
        path = task.get("gex_snapshot_path")
        if not path:
            vetoes.append(protocol.veto("GEX_SNAPSHOT_MISSING", "no GEX snapshot in the task",
                                        "a GEX-format snapshot"))
            return protocol.result("D", vetoes=vetoes, checks=checks, notes=notes)
        try:
            with open(path) as fh:
                gex_snap = json.load(fh)
        except Exception as exc:
            vetoes.append(protocol.veto("GEX_SNAPSHOT_CORRUPT", str(exc), "a readable GEX snapshot"))
            return protocol.result("D", vetoes=vetoes, checks=checks, notes=notes)

    try:
        history = gex_engine.load_history(task.get("gex_history_dir"), now)
    except Exception:
        history = []

    equity = task.get("account_equity")
    record = gex_engine.run(gex_snap, history, now, task.get("gex_out_path"),
                            account_equity=equity, risk_pct=task.get("risk_pct"),
                            max_lots=task.get("max_lots"),
                            trade_budget=task.get("trade_budget"))

    # ---- schema validation (fail closed)
    schema = _schema()
    errors = jsonschema_mini.validate(record, schema)
    checks["gex_schema"] = protocol.check(not errors, "%d schema error(s)" % len(errors),
                                          "a record that matches gex-output-schema.json",
                                          "; ".join(errors[:4]))
    if errors:
        vetoes.append(protocol.veto("GEX_SCHEMA_INVALID", "%d error(s): %s" % (
            len(errors), "; ".join(errors[:3])), "a schema-valid GEX record"))

    # ---- engine gates
    for message in record.get("failed_gates") or []:
        gate, observed, threshold = classify_gate(message)
        vetoes.append(protocol.veto(gate, observed, threshold))

    # ---- regime -> strategy mapping
    gex = record.get("gex") or {}
    regime = gex.get("regime")
    strategy = record.get("strategy")
    allowed = REGIME_STRATEGIES.get(regime, ())
    if strategy:
        checks["gex_regime_mapping"] = protocol.check(
            strategy in allowed, "%s in %s" % (strategy, regime),
            "one of %s" % (", ".join(allowed) or "n/a"))
        if strategy not in allowed:
            vetoes.append(protocol.veto("GEX_STRATEGY_MAPPING", "%s in regime %s" % (strategy, regime),
                                        "one of %s" % (", ".join(allowed) or "n/a")))
    else:
        checks["gex_regime_mapping"] = protocol.check(True, "no strategy (%s)" % regime,
                                                      "mapping checked when a strategy exists")

    action = record.get("action")
    direction = "CE" if action == "BUY_CE" else ("PE" if action == "BUY_PE" else "NEUTRAL")
    checks["gex_action"] = protocol.check(action in ("BUY_CE", "BUY_PE", "NO_TRADE"), action or "NO_TRADE",
                                          "BUY_CE | BUY_PE | NO_TRADE")

    data = {"gex_record": record, "regime": regime, "strategy": strategy,
            "action": action, "trade_id": record.get("trade_id"),
            "net_cr": gex.get("net_cr"), "flip": gex.get("flip"),
            "call_wall": gex.get("call_wall"), "put_wall": gex.get("put_wall"),
            "history_snapshots": len(history)}
    if record.get("reasons"):
        notes.extend(str(r) for r in record["reasons"][:4])
    return protocol.result("D", direction=direction, vetoes=vetoes, checks=checks, data=data, notes=notes)


if __name__ == "__main__":
    protocol.main_wrapper("D", run)
