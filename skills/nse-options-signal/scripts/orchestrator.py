#!/usr/bin/env python3
"""Orchestrator - the parent that runs the A-E agent panel.

Delegation mechanism (real, not simulated): agents B, C and D run as CHILD
PROCESSES (`python3 scripts/agents/agent_*.py`), concurrently, each with a hard
20-second budget.  The task travels as JSON on stdin, the result comes back as
JSON on stdout.  Everything is fail-closed:

    timeout / non-zero exit / unparseable stdout / missing field
        -> that agent becomes a MANDATORY VETO (never a silent pass)

Agent A (the context) is read by the parent itself - context is not a vote.
Agent E runs only after the consensus and is the sole owner of strike, stop,
targets and sizing.

Usage:
    python3 orchestrator.py --snapshot snapshot.json --history snapshot_history \
        --context data/context.json --out out.json [--now 2026-10-20T11:00:00+05:30]
"""
import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "agents"))

import account_equity as equity_mod  # noqa: E402
import gex_snapshot  # noqa: E402
import option_math  # noqa: E402
from agents import agent_a, protocol  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
AGENT_TIMEOUT_S = 20.0
CONSENSUS_REQUIRED = 2
INVALIDATION_BUFFER_PCT = 0.0005      # 0.05% beyond the validated level
A_PLUS = {
    "level_sources_min": 3,
    "wall_ratio_min": 2.0,
    "breakout_total_passes_min": 6,
    "consensus_votes_min": 3,
}


# --------------------------------------------------------------------- helpers
def _now(value):
    if not value:
        return datetime.now(IST)
    dt = gex_snapshot.parse_ts(value)
    return dt or datetime.now(IST)


def run_agent(agent, task, timeout=AGENT_TIMEOUT_S):
    """Run one agent as a child process. Never raises - always returns a result."""
    script = os.path.join(HERE, "agents", "agent_%s.py" % agent.lower())
    payload = json.dumps(task).encode("utf-8")
    try:
        proc = subprocess.run([sys.executable, script], input=payload, timeout=timeout,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.TimeoutExpired:
        return protocol.failed(agent, "agent timed out after %.0fs" % timeout,
                               [protocol.veto("AGENT_TIMEOUT", "no result after %.0fs" % timeout,
                                              "a result within %.0fs" % timeout)])
    except Exception as exc:
        return protocol.failed(agent, "agent could not be started: %s" % exc,
                               [protocol.veto("AGENT_FAILED", str(exc), "a running agent process")])
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "ignore")[-400:]
        res = protocol.failed(agent, "agent exited with code %d: %s" % (proc.returncode, err),
                              [protocol.veto("AGENT_FAILED", "exit code %d" % proc.returncode,
                                             "exit code 0 with a JSON result")])
        return res
    try:
        res = json.loads((proc.stdout or b"").decode("utf-8"))
    except Exception as exc:
        return protocol.failed(agent, "agent returned invalid JSON: %s" % exc,
                               [protocol.veto("AGENT_INVALID_JSON", str(exc),
                                              "a JSON object on stdout")])
    if not isinstance(res, dict):
        return protocol.failed(agent, "agent returned a non-object result",
                               [protocol.veto("AGENT_INVALID_JSON", "not an object", "a JSON object")])
    for field in protocol.REQUIRED.get(agent, ()):
        if field not in res:
            return protocol.failed(agent, "result is missing %r" % field,
                                   [protocol.veto("AGENT_MISSING_FIELD", field,
                                                  "a result with %r" % field)])
    if res.get("status") != "ok" and not res.get("vetoes"):
        res.setdefault("vetoes", []).append(
            protocol.veto("AGENT_FAILED", res.get("error") or "agent reported a failure",
                          "a successful agent result"))
    return res


def run_panel(tasks, timeout=AGENT_TIMEOUT_S):
    """Run B, C and D CONCURRENTLY."""
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        futures = {pool.submit(run_agent, agent, task, timeout): agent for agent, task in tasks.items()}
        for fut in concurrent.futures.as_completed(futures):
            agent = futures[fut]
            try:
                out[agent] = fut.result()
            except Exception as exc:  # pragma: no cover - defensive
                out[agent] = protocol.failed(agent, str(exc),
                                            [protocol.veto("AGENT_FAILED", str(exc), "a result")])
    return out


# ------------------------------------------------------------------- consensus
def evaluate_consensus(results, direction_hint=None):
    """Directional consensus over B, C and D."""
    votes = {a: (results.get(a) or {}).get("direction", "NEUTRAL") for a in ("B", "C", "D")}
    ce = sum(1 for v in votes.values() if v == "CE")
    pe = sum(1 for v in votes.values() if v == "PE")
    opposing = ce > 0 and pe > 0
    passed = (not opposing) and (ce >= CONSENSUS_REQUIRED or pe >= CONSENSUS_REQUIRED)
    direction = "CE" if (passed and ce >= CONSENSUS_REQUIRED) else ("PE" if passed else "NEUTRAL")
    return {"votes": votes, "bullish_votes": ce, "bearish_votes": pe,
            "required": CONSENSUS_REQUIRED, "direction": direction, "opposing_vote": opposing,
            "passed": passed,
            "agreeing": max(ce, pe),
            "reason": ("%d of 3 agents agree on %s, no opposing vote" % (max(ce, pe), direction)
                       if passed else
                       ("opposing votes (%s)" % ", ".join("%s=%s" % (k, v) for k, v in votes.items())
                        if opposing else
                        "only %d of 3 agents agree (need %d)" % (max(ce, pe), CONSENSUS_REQUIRED)))}


def measure_a_plus(results, context, consensus):
    """The objective A+ checklist (references/agent-rules.md)."""
    b = results.get("B") or {}
    c = results.get("C") or {}
    d = results.get("D") or {}
    support = (b.get("data") or {}).get("support") or {}
    resistance = (b.get("data") or {}).get("resistance") or {}
    side = support if consensus.get("direction") == "CE" else resistance
    sources = side.get("sources") or []
    agreed = len([s for s in sources if s.get("within_tolerance")])
    ratio_check = (b.get("checks") or {}).get("wall_ratio") or {}
    ratio_value = 0.0
    try:
        ratio_value = float(str(ratio_check.get("observed", "0x")).split("x")[0])
    except Exception:
        ratio_value = 0.0
    breakout = (c.get("data") or {}).get("breakout") or {}
    passes = 0
    try:
        passes = int(str(breakout.get("checks_passed", "0/0")).split("/")[0])
    except Exception:
        passes = 0
    checks = {
        "context_fresh": (context.get("status") == "OK"),
        "level_sources_3": (agreed >= A_PLUS["level_sources_min"]),
        "wall_ratio_2x": (ratio_value >= A_PLUS["wall_ratio_min"]),
        "breakout_valid": (breakout.get("verdict") == "VALID_BREAKOUT"),
        "breakout_passes_6": (passes >= A_PLUS["breakout_total_passes_min"]),
        "consensus_3of3": (sum(1 for v in (consensus.get("votes") or {}).values()
                                if v == consensus.get("direction")) >= A_PLUS["consensus_votes_min"]),
        "gex_clean": (not (d.get("vetoes") or [])),
    }
    return {"met": all(checks.values()), "checks": checks,
            "level_sources": agreed, "wall_ratio": ratio_value, "breakout_passes": passes}


# --------------------------------------------------------------------- summary
def three_line_summary(out):
    """Exactly three plain-language lines."""
    instrument = out.get("instrument") or "NIFTY"
    stamp = out.get("timestamp_ist") or ""
    action = out.get("action")
    if action == "NO_TRADE":
        gates = out.get("gates_failed") or []
        if gates:
            g = gates[0]
            line2 = ("Failed gate: %s (Agent %s) - observed: %s; threshold: %s" % (
                g.get("gate"), g.get("agent"), g.get("observed"), g.get("threshold")))
        else:
            line2 = "No gate failed - the directional consensus was not reached."
        line1 = "%s %s - NO TRADE." % (instrument, stamp)
        line3 = out.get("consensus", {}).get("reason") or "no trade"
        return "\n".join([line1, line2, line3])
    trade = out.get("trade") or {}
    line1 = "%s %s - %s %s %s (%s) entry %.2f-%.2f, %s lot(s)." % (
        instrument, stamp, action, trade.get("strike"), trade.get("option_type"),
        trade.get("expiry"), (trade.get("entry_zone") or [0, 0])[0], (trade.get("entry_zone") or [0, 0])[1],
        trade.get("suggested_lots"))
    line2 = ("Stop %.2f (premium), TP1 %.2f (1:%.1f), TP2 %.2f; underlying invalidation %.2f." % (
        trade.get("stop_loss_premium", 0), trade.get("tp1_premium", 0),
        trade.get("risk_reward_tp1", 0), trade.get("tp2_premium", 0),
        trade.get("underlying_invalidation", 0)))
    con = out.get("consensus") or {}
    line3 = ("Consensus: %s; %s. Data %s min old, VIX %s." % (
        ", ".join("%s %s" % (k, v) for k, v in (con.get("votes") or {}).items()),
        con.get("reason", ""), out.get("data_freshness_minutes"), (out.get("trade") or {}).get("vix")))
    return "\n".join([line1, line2, line3])


# ------------------------------------------------------------------------ main
def run(args):
    now = _now(args.now)
    with open(args.snapshot) as fh:
        snapshot = json.load(fh)
    symbol = args.symbol or snapshot.get("symbol") or "NIFTY"

    # ---- the GEX-format view of the same data (one conversion, used by D and E)
    work = args.work_dir or tempfile.mkdtemp(prefix="gex-orch-")
    os.makedirs(work, exist_ok=True)
    gex_hist_dir = os.path.join(work, "gex_history")
    gex_path = os.path.join(work, "gex_snapshot.json")
    conversion_warnings = []
    try:
        gex_snap, conversion_warnings = gex_snapshot.convert(snapshot, now=now, symbol=symbol)
        with open(gex_path, "w") as fh:
            json.dump(gex_snap, fh)
        if args.history and os.path.isdir(args.history):
            gex_snapshot.convert_dir(args.history, gex_hist_dir, now=now,
                                     exclude_ts=gex_snap.get("timestamp"))
    except Exception as exc:
        gex_snap = None
        conversion_warnings.append("GEX snapshot conversion failed: %s" % exc)

    # ---- account equity (validated, never hardcoded)
    equity = None
    equity_source = None
    equity_payload = {}
    if args.account_equity_from_api:
        equity_payload = equity_mod.load_from_api(max_age_hours=args.equity_max_age_hours)
    else:
        equity_payload = equity_mod.load(args.account_equity, max_age_hours=args.equity_max_age_hours)
    if equity_payload.get("ok"):
        equity = equity_payload["equity"]
        equity_source = equity_payload.get("source")

    # ---- agent A (parent reads the context)
    ctx = agent_a.load_context(args.context, now=now)
    result_a = agent_a.run({"now": now.isoformat(), "context_path": args.context})

    # ---- agents B, C, D (concurrent child processes)
    history_inline = None
    tasks = {
        "B": {"now": now.isoformat(), "snapshot": snapshot, "history_dir": args.history,
              "ohlc": args.ohlc},
        "C": {"now": now.isoformat(), "snapshot": snapshot, "history_dir": args.history,
              "strategy": args.strategy},
    }
    tasks["D"] = {"now": now.isoformat(), "gex_snapshot": gex_snap, "gex_snapshot_path": gex_path,
                  "gex_history_dir": gex_hist_dir, "gex_out_path": args.gex_out,
                  "account_equity": equity, "risk_pct": args.risk_pct,
                  "max_lots": args.max_lots}
    results = run_panel(tasks, timeout=args.timeout)
    results["A"] = result_a

    # ---- consensus
    consensus = evaluate_consensus(results)

    # ---- gates (a veto from any agent is a hard NO TRADE)
    gates = []
    for agent in ("B", "C", "D", "E"):
        for v in (results.get(agent) or {}).get("vetoes") or []:
            gates.append({"gate": v.get("gate"), "agent": agent,
                          "observed": v.get("observed"), "threshold": v.get("threshold"),
                          "detail": v.get("detail", "")})

    action = "NO_TRADE"
    reasons = []
    if not consensus["passed"]:
        reasons.append("consensus not reached: %s" % consensus["reason"])
    if gates:
        reasons.append("%d mandatory gate(s) failed" % len(gates))

    # ---- agent E (only when the consensus passed and no gate failed)
    trade = None
    size_multiplier = 1.0
    if consensus["passed"] and not gates:
        b_data = (results.get("B") or {}).get("data") or {}
        support = b_data.get("support") or {}
        resistance = b_data.get("resistance") or {}
        if consensus["direction"] == "CE":
            level = support.get("level")
            blocking = resistance.get("level")
            invalidation = level * (1 - INVALIDATION_BUFFER_PCT) if level else None
        else:
            level = resistance.get("level")
            blocking = support.get("level")
            invalidation = level * (1 + INVALIDATION_BUFFER_PCT) if level else None
        if level is None:
            gates.append({"gate": "NO_VALIDATED_LEVEL", "agent": "B",
                          "observed": "no validated %s level" % (
                              "support" if consensus["direction"] == "CE" else "resistance"),
                          "threshold": "a validated level from Agent B", "detail": ""})
            reasons.append("Agent B returned no validated level for the trade direction")
        else:
            task_e = {
                "now": now.isoformat(),
                "gex_snapshot": gex_snap,
                "gex_snapshot_path": gex_path,
                "direction": consensus["direction"],
                "valid_level": level,
                "underlying_invalidation": invalidation,
                "blocking_level": blocking,
                "account_equity": equity,
                "account_equity_source": equity_source,
                "max_deployment_per_trade": equity_payload.get("max_deployment_per_trade"),
                "risk_pct": args.risk_pct,
                "max_lots": args.max_lots,
                "strategy": args.strategy,
            }
            res_e = run_agent("E", task_e, timeout=args.timeout)
            results["E"] = res_e
            for v in res_e.get("vetoes") or []:
                gates.append({"gate": v.get("gate"), "agent": "E", "observed": v.get("observed"),
                              "threshold": v.get("threshold"), "detail": v.get("detail", "")})
            if res_e.get("status") == "ok" and not res_e.get("vetoes"):
                trade = (res_e.get("data") or {}).get("trade")
                action = "BUY_CE" if consensus["direction"] == "CE" else "BUY_PE"
                reasons.extend((res_e.get("data") or {}).get("reasons") or [])
            else:
                reasons.append("Agent E could not build a valid plan")

    # ---- agent A conflict (context only, never a vote)
    context_block = {
        "status": ctx.get("status"),
        "pre_market_bias": ctx.get("pre_market_bias"),
        "age_minutes": ctx.get("age_minutes"),
        "conflicts": ctx.get("conflicts") or [],
        "opposes_trade": False,
        "a_plus_required": False,
        "a_plus_met": False,
        "size_multiplier": 1.0,
    }
    if action != "NO_TRADE":
        bias = ctx.get("pre_market_bias")
        # only a FRESH context can oppose: a stale / missing context is
        # reported, never used (and it disables the A+ escape hatch)
        fresh = ctx.get("status") == "OK"
        opposes = fresh and ((bias == "BULLISH" and action == "BUY_PE") or
                              (bias == "BEARISH" and action == "BUY_CE"))
        context_block["opposes_trade"] = bool(opposes)
        if opposes:
            context_block["a_plus_required"] = True
            a_plus = measure_a_plus(results, ctx, consensus)
            context_block["a_plus_met"] = a_plus["met"]
            context_block["a_plus_checks"] = a_plus["checks"]
            if not a_plus["met"]:
                action = "NO_TRADE"
                trade = None
                failed = [k for k, v in a_plus["checks"].items() if not v]
                gates.append({"gate": "COUNTER_BIAS_WITHOUT_A_PLUS", "agent": "A",
                              "observed": "context %s opposes the trade; A+ checks failed: %s" % (
                                  bias, ", ".join(failed)),
                              "threshold": "an objectively measured A+ setup",
                              "detail": "A+ = %s" % json.dumps(a_plus["checks"], sort_keys=True)})
                reasons.append("the context opposes the trade and the A+ checklist is not met")
            else:
                size_multiplier = 0.5
                if trade:
                    trade["suggested_lots"] = int(trade.get("suggested_lots", 0) * 0.5)
                    trade["size_note"] = "halved (counter-bias A+ setup)"
                consensus["size_multiplier"] = 0.5
                reasons.append("context opposes the trade but the A+ checklist passed - size halved")

    # ---- GEX record (isolated: engine=GEX, never merged into the bias score)
    gex_record = ((results.get("D") or {}).get("data") or {}).get("gex_record")
    if gex_record and args.gex_out:
        try:
            os.makedirs(os.path.dirname(args.gex_out), exist_ok=True)
            with open(args.gex_out, "a") as fh:
                fh.write(json.dumps(gex_record) + "\n")
        except Exception as exc:
            reasons.append("GEX record could not be written to %s: %s" % (args.gex_out, exc))
    gex_alert = None
    if gex_record and gex_record.get("action") in ("BUY_CE", "BUY_PE"):
        gex_alert = {"channel": "GEX", "engine": "GEX", "trade_id": gex_record.get("trade_id"),
                     "symbol": gex_record.get("symbol"), "action": gex_record.get("action"),
                     "strategy": gex_record.get("strategy"), "timestamp": gex_record.get("timestamp"),
                     "target_chat_id_env": "GEX_TELEGRAM_CHAT_ID",
                     "note": "GEX alerts go to the GEX channel only - never merged into the main bias score"}
        if args.gex_alert_out:
            try:
                os.makedirs(os.path.dirname(args.gex_alert_out), exist_ok=True)
                with open(args.gex_alert_out, "a") as fh:
                    fh.write(json.dumps(gex_alert) + "\n")
            except Exception as exc:
                reasons.append("GEX alert could not be written: %s" % exc)

    # ---- output
    chain_ts = None
    try:
        from agents import snapshots as snap_mod
        chain_ts = snap_mod.chain_timestamp(snapshot)
    except Exception:
        chain_ts = None
    age_min = round((now - chain_ts).total_seconds() / 60.0, 1) if chain_ts else None
    b_data = (results.get("B") or {}).get("data") or {}
    levels = b_data.get("levels") or {}
    out = {
        "agent_id": "orchestrator",
        "engine": "ORCHESTRATOR",
        "source": "NSE_OPTIONS_SIGNAL",
        "role": "OPTIONS_RESEARCH_SECOND_OPINION",
        "authority": "RESEARCH_INPUT_ONLY",
        "can_force_trade": False,
        "timestamp_ist": now.strftime("%Y-%m-%d %H:%M"),
        "timestamp_iso": now.isoformat(),
        "instrument": symbol,
        "symbol": symbol,
        "spot": b_data.get("spot") or (gex_snap or {}).get("spot"),
        "action": action,
        "decision": action,
        "bias": "BULLISH" if action == "BUY_CE" else ("BEARISH" if action == "BUY_PE" else "NEUTRAL"),
        "confidence": ("NA" if action == "NO_TRADE"
                       else ("High" if consensus.get("agreeing", 0) >= 3 else "Moderate")),
        "consensus": consensus,
        "context": context_block,
        "agents": {a: {"status": (results.get(a) or {}).get("status") or "skipped",
                       "direction": (results.get(a) or {}).get("direction") or "NEUTRAL",
                       "vetoes": (results.get(a) or {}).get("vetoes") or [],
                       "notes": (results.get(a) or {}).get("notes") or []}
                   for a in ("A", "B", "C", "D", "E")},
        "gates_failed": gates,
        "reasons": reasons,
        "trade": trade,
        "key_levels": {"support": (b_data.get("support") or {}).get("level"),
                       "resistance": (b_data.get("resistance") or {}).get("level"),
                       "max_pain": levels.get("max_pain"),
                       "pcr": (b_data.get("pcr_series") or [None])[-1]},
        "gex": gex_record,
        "gex_alert": gex_alert,
        "data_quality": {"snapshot_age_minutes": age_min,
                         "history_snapshots": b_data.get("history_snapshots", 0),
                         "context_status": ctx.get("status"),
                         "conversion_warnings": conversion_warnings,
                         "account_equity": equity,
                         "account_equity_source": equity_source},
        "data_freshness_minutes": age_min,
        "disclaimer": "Educational analysis based on NSE public data, not investment advice. "
                      "Options carry high risk; use your own judgment and position sizing.",
    }
    out["summary"] = three_line_summary(out)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--history", default=None)
    ap.add_argument("--context", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--now", default=None)
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--strategy", default=None)
    ap.add_argument("--ohlc", default=None, help="JSON file with pdh/pdl/pdc levels")
    ap.add_argument("--timeout", type=float, default=AGENT_TIMEOUT_S)
    ap.add_argument("--risk-pct", type=float, default=option_math.CFG["risk_pct"])
    ap.add_argument("--max-lots", type=int, default=None)
    ap.add_argument("--account-equity", default=os.path.join(HERE, "data", "account_equity.json"))
    ap.add_argument("--account-equity-from-api", action="store_true")
    ap.add_argument("--equity-max-age-hours", type=float, default=24.0)
    ap.add_argument("--gex-out", default=os.path.join(HERE, "data", "gex_trades.jsonl"))
    ap.add_argument("--gex-alert-out", default=os.path.join(HERE, "data", "gex_alerts.jsonl"))
    ap.add_argument("--work-dir", default=None)
    a = ap.parse_args(argv)
    if a.ohlc:
        with open(a.ohlc) as fh:
            a.ohlc = json.load(fh)
    out = run(a)
    if a.out:
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, "w") as fh:
            json.dump(out, fh, indent=1)
    print(out["summary"])
    print(json.dumps({"action": out["action"], "gates_failed": out["gates_failed"],
                      "consensus": out["consensus"]["votes"]}, indent=1))
    return 0 if out["action"] != "NO_TRADE" else 1


if __name__ == "__main__":
    sys.exit(main())
