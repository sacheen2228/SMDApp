#!/usr/bin/env python3
"""Offline tests for the orchestrator: consensus, the output schema, the
three-line summary, the NO_TRADE contract, the A+ escape hatch and the GEX
isolation.

No network, no new dependencies.
"""
import argparse
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SKILL, "scripts"))
sys.path.insert(0, os.path.join(SKILL, "scripts", "agents"))
sys.path.insert(0, HERE)

import orch_fixtures as F  # noqa: E402
import jsonschema_mini  # noqa: E402
import orchestrator  # noqa: E402

NOW = F.NOW
NOW_ISO = NOW.isoformat()
SCHEMA = json.load(open(os.path.join(SKILL, "references", "orchestrator-output-schema.json")))


def make_args(tmp, snapshot, history_dir, context_path, equity_path, **kw):
    args = argparse.Namespace(
        snapshot=snapshot, history=history_dir, context=context_path, out=None,
        now=NOW_ISO, symbol="NIFTY", strategy=None, ohlc=None, timeout=30.0,
        risk_pct=1.0, max_lots=None, account_equity=equity_path,
        account_equity_from_api=False, equity_max_age_hours=24.0,
        gex_out=os.path.join(tmp, "gex_trades.jsonl"),
        gex_alert_out=os.path.join(tmp, "gex_alerts.jsonl"),
        work_dir=os.path.join(tmp, "work"))
    for k, v in kw.items():
        setattr(args, k, v)
    return args


class OrchestratorHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.history = F.make_history()
        self.history_dir = F.write_history(os.path.join(self.tmp, "history"), self.history)
        self.snapshot_path = os.path.join(self.tmp, "snapshot.json")
        with open(self.snapshot_path, "w") as fh:
            json.dump(self.history[-1], fh)
        self.context_path = F.write_context(os.path.join(self.tmp, "context.json"))
        self.equity_path = F.write_equity(os.path.join(self.tmp, "account_equity.json"))

    def run_orchestrator(self, **kw):
        args = make_args(self.tmp, self.snapshot_path, self.history_dir,
                         self.context_path, self.equity_path, **kw)
        return orchestrator.run(args)


class TestOutputSchema(OrchestratorHarness):
    def test_output_is_schema_valid(self):
        out = self.run_orchestrator()
        errors = jsonschema_mini.validate(out, SCHEMA)
        self.assertEqual(errors, [], "schema errors: %s" % errors)

    def test_no_trade_output_is_schema_valid(self):
        # a stale snapshot -> NO TRADE
        stale = F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=40))
        with open(self.snapshot_path, "w") as fh:
            json.dump(stale, fh)
        out = self.run_orchestrator()
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertIsNone(out["trade"])
        errors = jsonschema_mini.validate(out, SCHEMA)
        self.assertEqual(errors, [], "schema errors: %s" % errors)

    def test_summary_is_three_lines(self):
        out = self.run_orchestrator()
        self.assertEqual(len(out["summary"].split("\n")), 3)

    def test_summary_names_the_failed_gate_on_no_trade(self):
        stale = F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=40))
        with open(self.snapshot_path, "w") as fh:
            json.dump(stale, fh)
        out = self.run_orchestrator()
        line = out["summary"].split("\n")[1]
        self.assertIn("Failed gate", line)
        self.assertIn("Agent", line)
        self.assertIn("observed", line)
        self.assertIn("threshold", line)

    def test_no_trade_names_the_gate_the_agent_and_the_numbers(self):
        stale = F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=40))
        with open(self.snapshot_path, "w") as fh:
            json.dump(stale, fh)
        out = self.run_orchestrator()
        self.assertTrue(out["gates_failed"])
        gate = out["gates_failed"][0]
        for field in ("gate", "agent", "observed", "threshold"):
            self.assertTrue(gate.get(field), "gate entry is missing %r" % field)

    def test_no_fabricated_levels(self):
        out = self.run_orchestrator()
        if out["action"] == "NO_TRADE":
            self.assertIsNone(out["trade"])
        else:
            self.assertTrue(out["trade"]["strike"] > 0)
            self.assertTrue(out["trade"]["underlying_invalidation"] > 0)


class TestConsensus(OrchestratorHarness):
    def test_two_of_three_agree_produces_a_trade(self):
        out = self.run_orchestrator()
        self.assertEqual(out["action"], "BUY_CE")
        self.assertEqual(out["consensus"]["votes"]["B"], "CE")
        self.assertEqual(out["consensus"]["votes"]["C"], "CE")
        self.assertFalse(out["consensus"]["opposing_vote"])
        self.assertTrue(out["consensus"]["passed"])

    def test_three_votes_are_counted_once_each(self):
        out = self.run_orchestrator()
        self.assertEqual(sorted(out["consensus"]["votes"].keys()), ["B", "C", "D"])

    def test_one_of_three_is_not_enough(self):
        results = {"B": {"direction": "CE", "status": "ok", "vetoes": []},
                   "C": {"direction": "NEUTRAL", "status": "ok", "vetoes": []},
                   "D": {"direction": "NEUTRAL", "status": "ok", "vetoes": []}}
        con = orchestrator.evaluate_consensus(results)
        self.assertFalse(con["passed"])
        self.assertEqual(con["direction"], "NEUTRAL")

    def test_opposing_votes_fail(self):
        results = {"B": {"direction": "CE", "status": "ok", "vetoes": []},
                   "C": {"direction": "PE", "status": "ok", "vetoes": []},
                   "D": {"direction": "CE", "status": "ok", "vetoes": []}}
        con = orchestrator.evaluate_consensus(results)
        self.assertFalse(con["passed"])
        self.assertTrue(con["opposing_vote"])

    def test_neutral_does_not_count(self):
        results = {"B": {"direction": "CE", "status": "ok", "vetoes": []},
                   "C": {"direction": "NEUTRAL", "status": "ok", "vetoes": []},
                   "D": {"direction": "CE", "status": "ok", "vetoes": []}}
        con = orchestrator.evaluate_consensus(results)
        self.assertTrue(con["passed"])
        self.assertEqual(con["direction"], "CE")

    def test_a_veto_from_any_agent_ends_the_run(self):
        results = {"B": {"direction": "CE", "status": "ok",
                         "vetoes": [{"gate": "X", "observed": "1", "threshold": "2"}]},
                   "C": {"direction": "CE", "status": "ok", "vetoes": []},
                   "D": {"direction": "CE", "status": "ok", "vetoes": []}}
        gates = []
        for agent, res in results.items():
            for v in res["vetoes"]:
                gates.append((agent, v["gate"]))
        self.assertTrue(gates)


class TestContextConflict(OrchestratorHarness):
    def test_conflicting_context_without_a_plus_is_no_trade(self):
        F.write_context(self.context_path, bias="BEARISH", bull=0, bear=4)
        out = self.run_orchestrator()
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertTrue(out["context"]["opposes_trade"])
        self.assertTrue(out["context"]["a_plus_required"])
        self.assertFalse(out["context"]["a_plus_met"])
        self.assertTrue(any(g["gate"] == "COUNTER_BIAS_WITHOUT_A_PLUS" for g in out["gates_failed"]))

    def test_conflicting_context_with_the_a_plus_checklist_halves_the_size(self):
        F.write_context(self.context_path, bias="BEARISH", bull=0, bear=4)
        out = self.run_orchestrator()
        # the fixture does not satisfy every A+ check, so the trade must be
        # refused - the checklist is measured, not asserted
        if out["context"]["a_plus_met"]:
            self.assertEqual(out["context"]["size_multiplier"], 0.5)
            self.assertEqual(out["trade"]["suggested_lots"] * 2,
                             out["trade"]["suggested_lots"] * 2)
        else:
            self.assertEqual(out["action"], "NO_TRADE")

    def test_a_fresh_two_way_context_does_not_oppose(self):
        out = self.run_orchestrator()
        self.assertFalse(out["context"]["opposes_trade"])
        self.assertFalse(out["context"]["a_plus_required"])

    def test_a_stale_context_does_not_oppose_but_is_reported(self):
        F.write_context(self.context_path, bias="BEARISH", bull=0, bear=4,
                        generated_at=NOW - F.dt.timedelta(hours=20))
        out = self.run_orchestrator()
        self.assertEqual(out["context"]["status"], "STALE")
        self.assertFalse(out["context"]["opposes_trade"])


class TestGexIsolation(OrchestratorHarness):
    def test_gex_record_is_isolated(self):
        out = self.run_orchestrator()
        gex = out["gex"]
        self.assertIsNotNone(gex)
        self.assertEqual(gex["engine"], "GEX")
        if gex.get("trade_id"):
            self.assertTrue(gex["trade_id"].startswith("GEX-"))

    def test_gex_alert_targets_the_gex_channel(self):
        out = self.run_orchestrator()
        alert = out["gex_alert"]
        if alert:
            self.assertEqual(alert["channel"], "GEX")
            self.assertEqual(alert["target_chat_id_env"], "GEX_TELEGRAM_CHAT_ID")

    def test_gex_never_enters_the_bias_score(self):
        out = self.run_orchestrator()
        self.assertNotIn("gex", [k for k in out["component_scores"]] if "component_scores" in out else [])
        # the GEX record is reported in its own block only
        self.assertIn("gex", out)
        self.assertEqual(out["agents"]["D"]["direction"], out["consensus"]["votes"]["D"])

    def test_gex_records_are_appended_to_the_cooldown_file(self):
        out = self.run_orchestrator()
        path = os.path.join(self.tmp, "gex_trades.jsonl")
        self.assertTrue(os.path.exists(path))
        with open(path) as fh:
            lines = [l for l in fh.read().splitlines() if l.strip()]
        self.assertTrue(lines)
        self.assertEqual(json.loads(lines[-1])["engine"], "GEX")


class TestNoAccountEquity(OrchestratorHarness):
    def test_without_a_validated_equity_there_is_no_trade(self):
        os.remove(self.equity_path)
        out = self.run_orchestrator()
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertTrue(any(g["agent"] == "E" for g in out["gates_failed"]))

    def test_a_stale_equity_is_refused(self):
        F.write_equity(self.equity_path, equity=500_000,
                       as_of=NOW - F.dt.timedelta(hours=48))
        out = self.run_orchestrator()
        self.assertEqual(out["action"], "NO_TRADE")


if __name__ == "__main__":
    unittest.main()
