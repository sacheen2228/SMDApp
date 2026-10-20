#!/usr/bin/env python3
"""The GEX engine job (isolated: engine="GEX", the GEX channel only).

This is the scheduled counterpart of the orchestrator's Agent D:
  * the latest live snapshot is converted to the GEX engine's format
  * the snapshot history is converted as well (the engine needs >= 3 snapshots)
  * the GEX engine runs and its record is appended to the cooldown file
  * a GEX alert is written to the GEX channel outbox (never the main channel)
  * the invalidation-close monitor raises the operational exit alert

It never touches the main bias score and never places an order.

Usage:
    python3 run_gex.py [--symbol NIFTY] [--snapshot <file>] [--history <dir>]
                       [--out data/gex_trades.jsonl] [--alerts data/gex_alerts.jsonl]
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import account_equity as equity_mod  # noqa: E402
import gex_engine  # noqa: E402
import gex_exit_monitor  # noqa: E402
import gex_snapshot  # noqa: E402
import option_math  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
DATA = os.environ.get("GEX_DATA_DIR", os.path.join(os.path.dirname(HERE), "data"))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="NIFTY")
    ap.add_argument("--snapshot", default=os.path.join(DATA, "live", "snapshot.json"))
    ap.add_argument("--history", default=os.path.join(DATA, "live", "history"))
    ap.add_argument("--out", default=os.path.join(DATA, "gex_trades.jsonl"))
    ap.add_argument("--alerts", default=os.path.join(DATA, "gex_alerts.jsonl"))
    ap.add_argument("--account-equity", default=os.path.join(DATA, "account_equity.json"))
    ap.add_argument("--risk-pct", type=float, default=None,
                    help="the rupee risk as a %% of the amount DEPLOYED in the trade "
                         "(default: %s)" % option_math.CFG["risk_pct_of_trade"])
    ap.add_argument("--trade-budget", type=float, default=None,
                    help="the Rs that may be DEPLOYED in one trade (default: %s); it is itself "
                         "capped by the validated account equity" % option_math.CFG["trade_budget"])
    ap.add_argument("--now", default=None)
    a = ap.parse_args(argv)
    now = gex_snapshot.parse_ts(a.now) if a.now else datetime.now(IST)

    if not os.path.exists(a.snapshot):
        print("NO SNAPSHOT: %s" % a.snapshot)
        return 1
    with open(a.snapshot) as fh:
        snapshot = json.load(fh)
    try:
        gex_snap, warns = gex_snapshot.convert(snapshot, now=now, symbol=a.symbol)
    except Exception as exc:
        print("SNAPSHOT UNUSABLE: %s" % exc)
        return 1
    for w in warns:
        print("WARN: %s" % w)

    gex_hist_dir = os.path.join(DATA, "live", "gex_history")
    if os.path.isdir(a.history):
        gex_snapshot.convert_dir(a.history, gex_hist_dir, now=now,
                                 exclude_ts=gex_snap.get("timestamp"))

    equity_payload = equity_mod.load(a.account_equity, now=now)
    equity = equity_payload.get("equity") if equity_payload.get("ok") else None

    history = gex_engine.load_history(gex_hist_dir, now)
    record = gex_engine.run(gex_snap, history, now, a.out, account_equity=equity,
                             risk_pct=a.risk_pct, trade_budget=a.trade_budget)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "a") as fh:
        fh.write(json.dumps(record) + "\n")

    if record.get("action") in ("BUY_CE", "BUY_PE"):
        alert = {"channel": "GEX", "engine": "GEX", "trade_id": record.get("trade_id"),
                 "symbol": record.get("symbol"), "action": record.get("action"),
                 "strategy": record.get("strategy"), "timestamp": record.get("timestamp"),
                 "target_chat_id_env": "GEX_TELEGRAM_CHAT_ID",
                 "note": "GEX alerts go to the GEX channel only"}
        with open(a.alerts, "a") as fh:
            fh.write(json.dumps(alert) + "\n")

    # ---- the invalidation-close monitor on the open GEX trades
    records = gex_exit_monitor.load_records(a.out)
    state_path = os.path.join(DATA, "gex_exit_state.json")
    alerts, new_state = gex_exit_monitor.run(records, snapshot, now,
                                             gex_exit_monitor.load_state(state_path))
    if alerts:
        with open(a.alerts, "a") as fh:
            for alert in alerts:
                fh.write(json.dumps(alert) + "\n")
    with open(state_path, "w") as fh:
        json.dump(new_state, fh, indent=1)

    gx = record.get("gex") or {}
    print("%s | GEX %s Cr | %s | flip %s | call wall %s | put wall %s | action %s" % (
        record.get("symbol"), gx.get("net_cr"), gx.get("regime"), gx.get("flip"),
        gx.get("call_wall"), gx.get("put_wall"), record.get("action")))
    if record.get("failed_gates"):
        print("GATES:", "; ".join(record["failed_gates"]))
    for alert in alerts:
        print("ALERT %s %s %s" % (alert.get("status"), alert.get("trade_id"), alert.get("message")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
