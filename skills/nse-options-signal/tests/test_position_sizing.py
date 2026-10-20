#!/usr/bin/env python3
"""The per-trade capital model (2026-10-20).

The user's rule: "if I spend Rs 10,000 I take Rs 2,000 of risk" -> the rupee
risk is a PERCENTAGE OF THE AMOUNT DEPLOYED IN THAT TRADE, not a percentage of
a large validated equity.  The old model (1% of the equity) made every NIFTY
lot unaffordable -> 0 lots -> NO TRADE forever.

These tests pin the authoritative formula (mirrored from
src/lib/agent-brain-gate.ts, the app-side authority):

    deployed budget = min(tradeBudget, validated equity, deployment cap)
    risk budget     = riskPctOfTrade% x the deployed amount
    lots            = min(floor(risk budget / (stop x lot + costs)),
                          floor(deployed budget / (entry x lot + costs)),
                          strategy cap)          <- NEVER rounded UP
    deployed        = lots x entry x lot
    risk            = lots x stop x lot
    zero lots       -> NO TRADE

No network, no new dependencies.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SKILL, "scripts"))
sys.path.insert(0, os.path.join(SKILL, "scripts", "agents"))
sys.path.insert(0, HERE)

import orch_fixtures as F  # noqa: E402
import option_math  # noqa: E402

NOW = F.NOW
NOW_ISO = NOW.isoformat()
EQUITY = 25_000.0          # the real trading capital (Rs 20-30k), never Rs 2L

# ---- the acceptance case from the brief -------------------------------------
ACC_STRIKE = 25_500.0      # the NIFTY 25,500 CE
ACC_PREMIUM = 300.0        # a Rs 300 premium
ACC_LOT = 65               # the NIFTY lot size
ACC_SPOT = 25_530.0
ACC_SUPPORT = 25_400.0     # the put OI wall (the CE trade's level)
ACC_RESISTANCE = 25_800.0  # the call OI wall (the blocking level)
ACC_CLOSES = [c + 400.0 for c in F.candle_path()]


def acceptance_rows(put_scale=1.0, call_scale=1.0):
    """The NSE-format chain for the acceptance case."""
    rows = []
    for strike in range(24900, 26101, 50):
        bell = 800_000 + 2_500_000 * math.exp(-((strike - ACC_SPOT) / 500.0) ** 2)
        ce_oi = int((bell + (8_000_000 if strike == ACC_RESISTANCE else 0)) * call_scale)
        pe_oi = int((bell + (8_000_000 if strike == ACC_SUPPORT else 0)) * put_scale)
        ce_ltp = max(2.0, ACC_PREMIUM - 0.5 * (strike - ACC_STRIKE))
        pe_ltp = max(2.0, 180.0 - 0.5 * (strike - ACC_STRIKE))
        rows.append({
            "strikePrice": strike,
            "expiryDate": "2026-10-27",
            "CE": F._leg(ce_oi, round(ce_ltp, 2), 13.0,
                         250_000 if strike <= ACC_RESISTANCE else -50_000,
                         5000 if strike in (ACC_STRIKE, ACC_RESISTANCE) else 2500),
            "PE": F._leg(pe_oi, round(pe_ltp, 2), 14.0,
                         400_000 if strike >= ACC_SUPPORT else -30_000,
                         4800 if strike in (ACC_SUPPORT, ACC_SUPPORT + 50) else 2500),
        })
    return rows


def acceptance_snapshot(ts=None, put_scale=1.0, call_scale=1.0,
                       futures_oi=500_000, futures_volume=1_000_000):
    return F.make_snapshot(ts=ts or NOW, spot=ACC_SPOT, rows=acceptance_rows(put_scale, call_scale),
                           closes=ACC_CLOSES, vix=14.2,
                           futures_oi=futures_oi, futures_volume=futures_volume)


def acceptance_history(count=4, step_minutes=15):
    """count snapshots, oldest first: the put OI rises (the PCR rises for a CE),
    the call OI falls and the index futures OI/volume rise (the breakout's OI
    confirmation needs all three)."""
    out = []
    for i in range(count):
        ts = NOW - F.dt.timedelta(minutes=step_minutes * (count - 1 - i))
        out.append(acceptance_snapshot(ts=ts, put_scale=1.0 + 0.02 * i,
                                       call_scale=1.0 - 0.01 * i,
                                       futures_oi=480_000 + 10_000 * i,
                                       futures_volume=900_000 + 50_000 * i))
    return out


class TestDeploymentBudget(unittest.TestCase):
    """The deployment ceiling: min(tradeBudget, validated equity, cap)."""

    def test_the_trade_budget_is_the_default_ceiling(self):
        budget = option_math.deployment_budget(EQUITY)
        self.assertTrue(budget["ok"])
        self.assertEqual(budget["deployed_budget"], option_math.CFG["trade_budget"])

    def test_a_smaller_equity_caps_the_deployment(self):
        budget = option_math.deployment_budget(12_000.0)
        self.assertEqual(budget["deployed_budget"], 12_000.0)

    def test_the_deployment_cap_binds(self):
        # the equity file may lower the per-trade deployment: it wins over the
        # trade budget and over the equity
        budget = option_math.deployment_budget(EQUITY, None, 9_000.0)
        self.assertEqual(budget["deployed_budget"], 9_000.0)
        self.assertEqual(budget["deployment_cap"], 9_000.0)

    def test_the_deployment_budget_is_configurable(self):
        budget = option_math.deployment_budget(EQUITY, trade_budget=15_000.0)
        self.assertEqual(budget["deployed_budget"], 15_000.0)

    def test_without_a_validated_equity_there_is_no_deployment(self):
        budget = option_math.deployment_budget(None)
        self.assertFalse(budget["ok"])
        self.assertEqual(budget["deployed_budget"], 0.0)

    def test_the_equity_is_the_ceiling_never_the_risk_base(self):
        # a 4x bigger account must NOT quadruple the risk: the risk is a % of
        # the DEPLOYED amount, and the deployment is capped by the trade budget
        small = option_math.size_position(60.0, ACC_LOT, ACC_PREMIUM, EQUITY)
        big = option_math.size_position(60.0, ACC_LOT, ACC_PREMIUM, EQUITY * 4)
        self.assertEqual(small["risk_amount"], big["risk_amount"])
        self.assertEqual(small["lots"], big["lots"])


class TestRiskBudget(unittest.TestCase):
    """The rupee risk = riskPctOfTrade% of the amount deployed in the trade."""

    def test_the_risk_budget_is_twenty_percent_of_the_deployed_amount(self):
        budget = option_math.deployment_budget(EQUITY)
        risk = option_math.risk_budget(budget["deployed_budget"])
        self.assertEqual(risk["risk_pct_of_trade"], 20.0)
        self.assertEqual(risk["risk_budget"], budget["deployed_budget"] * 0.20)

    def test_the_risk_budget_is_configurable(self):
        risk = option_math.risk_budget(10_000.0, risk_pct=10.0)
        self.assertEqual(risk["risk_budget"], 1_000.0)

    def test_the_risk_percentage_is_capped(self):
        self.assertEqual(option_math.clamp_risk_pct(95.0),
                         option_math.CFG["max_risk_pct_of_trade"])

    def test_the_actual_risk_is_twenty_percent_of_the_deployed_amount(self):
        sizing = option_math.size_position(60.0, ACC_LOT, ACC_PREMIUM, EQUITY)
        self.assertEqual(sizing["lots"], 1)
        self.assertAlmostEqual(sizing["deployed"], 19_500.0, places=6)
        self.assertAlmostEqual(sizing["lots"] * 60.0 * ACC_LOT,
                               sizing["deployed"] * 0.20, places=6)


class TestLotSizing(unittest.TestCase):
    """lots = min(risk-limited, affordable, strategy cap) - never rounded UP."""

    def test_zero_lots_is_a_no_trade(self):
        sizing = option_math.size_position(60.0, ACC_LOT, ACC_PREMIUM, 5_000.0)
        self.assertEqual(sizing["lots"], 0)
        self.assertTrue(sizing["reason"])

    def test_the_affordable_count_wins_when_it_is_smaller(self):
        # the premium is cheap enough for many lots, but the rupee risk budget
        # (20% of Rs 20,000 = Rs 4,000) is the binding constraint
        sizing = option_math.size_position(30.0, ACC_LOT, 60.0, EQUITY)
        self.assertGreater(sizing["affordable_lots"], sizing["risk_lots"])
        self.assertEqual(sizing["lots"], sizing["risk_lots"])

    def test_the_risk_limited_count_wins_when_it_is_smaller(self):
        # a very wide stop: the rupee risk budget binds before the budget does
        sizing = option_math.size_position(500.0, ACC_LOT, 300.0, EQUITY)
        self.assertLess(sizing["risk_lots"], sizing["affordable_lots"])
        self.assertEqual(sizing["lots"], sizing["risk_lots"])

    def test_the_strategy_cap_wins_when_it_is_smaller(self):
        sizing = option_math.size_position(10.0, ACC_LOT, 20.0, EQUITY, max_lots=1)
        self.assertEqual(sizing["lots"], 1)
        self.assertEqual(sizing["cap_lots"], 1)

    def test_the_lot_count_is_never_rounded_up(self):
        # Rs 4,000 of risk at Rs 1,950 a lot -> 2 lots, never 3
        sizing = option_math.size_position(30.0, ACC_LOT, 150.0, EQUITY)
        self.assertEqual(sizing["lots"], 2)
        self.assertLessEqual(sizing["lots"] * sizing["risk_per_lot"], sizing["risk_amount"] + 1e-9)
        self.assertLessEqual(sizing["lots"] * sizing["capital_per_lot"],
                             sizing["deployed_budget"] + 1e-9)

    def test_an_unknown_lot_size_fails_closed(self):
        sizing = option_math.size_position(60.0, 0, ACC_PREMIUM, EQUITY)
        self.assertEqual(sizing["lots"], 0)
        self.assertIn("lot size", sizing["reason"])

    def test_costs_are_charged_against_both_budgets(self):
        sizing = option_math.size_position(60.0, ACC_LOT, ACC_PREMIUM, EQUITY,
                                           cfg=dict(option_math.CFG, costs_per_lot=200.0))
        self.assertEqual(sizing["lots"], 0)
        self.assertEqual(sizing["costs_per_lot"], 200.0)


class TestAcceptanceCase(unittest.TestCase):
    """NIFTY 25,500 CE, a Rs 300 premium, lot 65, a 25% premium stop."""

    def test_the_case_is_tradeable_with_one_lot(self):
        # the rupee-risk stop on a Rs 300 premium at 20% of the deployed amount
        # is 60 points (a 20% premium stop); 1 lot risks Rs 3,900 and
        # deploys Rs 19,500 - the trade is possible, not always NO_TRADE
        stop_points = option_math.rupee_stop_points(ACC_PREMIUM)
        self.assertEqual(stop_points, 60.0)
        sizing = option_math.size_position(stop_points, ACC_LOT, ACC_PREMIUM, EQUITY)
        self.assertEqual(sizing["lots"], 1)
        self.assertEqual(sizing["deployed"], 19_500.0)
        self.assertEqual(sizing["lots"] * stop_points * ACC_LOT, 3_900.0)

    def test_the_plan_of_the_acceptance_case(self):
        rows = [{"strike": 25_500.0, "call_oi": 3_000_000, "put_oi": 1_000_000,
                 "call_iv": 13.0, "put_iv": 14.0, "call_ltp": 300.0, "put_ltp": 180.0,
                 "call_bid": 298.0, "call_ask": 302.0, "put_bid": 179.0, "put_ask": 181.0,
                 "call_volume": 5000, "put_volume": 5000}]
        plan, reasons = option_math.build_plan(
            rows=rows, side="call", spot=ACC_SPOT, vix=14.2, T=7 / 365.0,
            expiry_date="2026-10-27", lot_size=ACC_LOT, account_equity=EQUITY,
            underlying_invalidation=ACC_SUPPORT * (1 - 0.0005))
        self.assertIsNotNone(plan, reasons)
        self.assertEqual(plan["strike"], ACC_STRIKE)
        self.assertEqual(plan["lots"], 1)
        self.assertEqual(plan["deployed_inr"], 19_500.0)
        self.assertEqual(plan["risk_inr"], 3_900.0)
        self.assertEqual(plan["deployed_budget_inr"], 20_000.0)
        self.assertEqual(plan["risk_budget_inr"], 4_000.0)
        self.assertEqual(plan["stop_points"], 60.0)
        self.assertLessEqual(plan["risk_inr"], plan["risk_budget_inr"] + 1e-6)

    def test_the_acceptance_case_is_rejected_when_the_equity_is_too_small(self):
        rows = [{"strike": 25_500.0, "call_oi": 3_000_000, "put_oi": 1_000_000,
                 "call_iv": 13.0, "put_iv": 14.0, "call_ltp": 300.0, "put_ltp": 180.0,
                 "call_bid": 298.0, "call_ask": 302.0, "put_bid": 179.0, "put_ask": 181.0,
                 "call_volume": 5000, "put_volume": 5000}]
        plan, reasons = option_math.build_plan(
            rows=rows, side="call", spot=ACC_SPOT, vix=14.2, T=7 / 365.0,
            expiry_date="2026-10-27", lot_size=ACC_LOT, account_equity=15_000.0,
            underlying_invalidation=ACC_SUPPORT * (1 - 0.0005))
        self.assertIsNone(plan)
        self.assertTrue(any("zero lots" in r for r in reasons), reasons)


class TestStopRule(unittest.TestCase):
    """The stop is the rupee-risk stop; the invalidation may only tighten it."""

    def chain(self, premium=ACC_PREMIUM):
        return [{"strike": 25_500.0, "call_oi": 3_000_000, "put_oi": 1_000_000,
                 "call_iv": 13.0, "put_iv": 14.0, "call_ltp": premium, "put_ltp": 180.0,
                 "call_bid": premium - 2.0, "call_ask": premium + 2.0,
                 "put_bid": 179.0, "put_ask": 181.0,
                 "call_volume": 5000, "put_volume": 5000}]

    def plan(self, invalidation, equity=EQUITY):
        return option_math.build_plan(
            rows=self.chain(), side="call", spot=ACC_SPOT, vix=14.2, T=7 / 365.0,
            expiry_date="2026-10-27", lot_size=ACC_LOT, account_equity=equity,
            underlying_invalidation=invalidation)

    def test_the_stop_is_the_rupee_risk_stop(self):
        plan, reasons = self.plan(ACC_SUPPORT * (1 - 0.0005))
        self.assertIsNotNone(plan, reasons)
        self.assertEqual(plan["stop_points"], 60.0)
        self.assertEqual(plan["premium_sl"], 240.0)

    def test_the_invalidation_may_only_tighten_the_stop(self):
        # a very close invalidation -> a tighter stop, a SMALLER risk
        plan, reasons = self.plan(ACC_SPOT - 40.0)
        self.assertIsNotNone(plan, reasons)
        self.assertLess(plan["stop_points"], 60.0)
        self.assertLess(plan["risk_inr"], 3_900.0)

    def test_an_invalidation_that_is_too_far_is_refused(self):
        # the invalidation would need more than 30% of the premium
        plan, reasons = self.plan(ACC_SPOT - 600.0)
        self.assertIsNone(plan)
        self.assertTrue(any("premium stop" in r for r in reasons), reasons)

    def test_a_stop_wider_than_the_risk_budget_is_refused(self):
        # the 8-tick noise floor is a FLOOR on the stop distance: if it forces
        # a stop that the rupee risk budget cannot carry, the trade is refused
        self.assertEqual(option_math.CFG["min_stop_ticks"], 8)
        self.assertEqual(option_math.CFG["tick_size"], 0.05)
        cfg = dict(option_math.CFG, min_stop_ticks=1300, max_theta_pct_per_day=1000.0)
        plan, reasons = option_math.build_plan(
            rows=self.chain(), side="call", spot=ACC_SPOT, vix=14.2, T=7 / 365.0,
            expiry_date="2026-10-27", lot_size=ACC_LOT, account_equity=EQUITY,
            underlying_invalidation=ACC_SUPPORT * (1 - 0.0005), cfg=cfg)
        self.assertIsNone(plan)
        self.assertTrue(any("zero lots" in r for r in reasons), reasons)


class TestAgentEAcceptance(unittest.TestCase):
    """Agent E (the sole owner of the plan) on the acceptance case."""

    def gex_snapshot(self):
        import gex_snapshot
        snap, _ = gex_snapshot.convert(acceptance_snapshot(), now=NOW, symbol="NIFTY")
        return snap

    def test_agent_e_produces_the_acceptance_trade(self):
        import agent_e
        task = {"now": NOW_ISO, "gex_snapshot": self.gex_snapshot(), "direction": "CE",
                "valid_level": ACC_SUPPORT,
                "underlying_invalidation": ACC_SUPPORT * (1 - 0.0005),
                "blocking_level": ACC_RESISTANCE,
                "account_equity": EQUITY,
                "account_equity_source": "test fixture",
                "risk_pct": option_math.CFG["risk_pct_of_trade"],
                "trade_budget": option_math.CFG["trade_budget"]}
        res = agent_e.run(task)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["vetoes"], [])
        trade = res["trade"]
        self.assertEqual(trade["strike"], ACC_STRIKE)
        self.assertEqual(trade["suggested_lots"], 1)
        self.assertEqual(trade["deployed_inr"], 19_500.0)
        self.assertEqual(trade["risk_inr"], 3_900.0)
        self.assertEqual(trade["lot_size"], ACC_LOT)
        self.assertEqual(trade["deployed_budget_inr"], 20_000.0)
        self.assertEqual(trade["risk_budget_inr"], 4_000.0)

    def test_agent_e_refuses_the_acceptance_trade_when_the_equity_is_too_small(self):
        import agent_e
        task = {"now": NOW_ISO, "gex_snapshot": self.gex_snapshot(), "direction": "CE",
                "valid_level": ACC_SUPPORT,
                "underlying_invalidation": ACC_SUPPORT * (1 - 0.0005),
                "blocking_level": ACC_RESISTANCE,
                "account_equity": 15_000.0,
                "account_equity_source": "test fixture",
                "risk_pct": option_math.CFG["risk_pct_of_trade"],
                "trade_budget": option_math.CFG["trade_budget"]}
        res = agent_e.run(task)
        self.assertIsNone(res.get("trade"))
        gates = {v.get("gate") for v in res.get("vetoes") or []}
        self.assertIn("ZERO_LOTS", gates)


class TestGexLotValidation(unittest.TestCase):
    """The GEX engine's lot count is validated against the SAME rule."""

    def test_the_gex_lot_count_can_only_be_reduced(self):
        lots, sizing = option_math.cap_lots_to_budget(5, 60.0, ACC_LOT, ACC_PREMIUM, EQUITY)
        self.assertEqual(lots, 1)
        self.assertEqual(sizing["lots_before_cap"], 5)

    def test_a_smaller_lot_count_is_kept(self):
        lots, _ = option_math.cap_lots_to_budget(1, 60.0, ACC_LOT, ACC_PREMIUM, EQUITY)
        self.assertEqual(lots, 1)

    def gex_snapshot(self):
        rows = []
        for strike in range(24400, 25701, 50):
            ce_ltp = max(2.0, ACC_PREMIUM - 0.5 * (strike - ACC_STRIKE))
            pe_ltp = max(2.0, 180.0 - 0.5 * (strike - ACC_STRIKE))
            rows.append({"strike": float(strike),
                         "call_oi": 9_000_000 if strike == 25_500 else 500_000,
                         "put_oi": 500_000,
                         "call_iv": 13.0, "put_iv": 13.0,
                         "call_ltp": ce_ltp, "put_ltp": pe_ltp,
                         "call_bid": ce_ltp - 1.0, "call_ask": ce_ltp + 1.0,
                         "put_bid": pe_ltp - 1.0, "put_ask": pe_ltp + 1.0,
                         "call_volume": 5000, "put_volume": 5000})
        return {"symbol": "NIFTY", "timestamp": NOW_ISO, "spot": ACC_SPOT, "vix": 14.0,
                "lot_size": ACC_LOT,
                "expiries": [{"date": "2026-10-27", "days_to_expiry": 7.0, "chain": rows}],
                "candles_15m": []}

    def candidate(self):
        return {"strategy": "GEX-1 PIN_FADE", "direction": "BUY_CE",
                "sl_underlying": ACC_SUPPORT * (1 - 0.0005),
                "blocking_level": ACC_RESISTANCE, "reasons": ["test setup"]}

    def test_the_gex_trade_uses_the_same_sizing_rule(self):
        import gex_engine
        snap = self.gex_snapshot()
        plan, why = gex_engine.build_trade(snap, {}, self.candidate(), 100.0, NOW,
                                           account_equity=EQUITY)
        self.assertIsNotNone(plan, why)
        self.assertEqual(plan["lots"], 1)
        self.assertEqual(plan["deployed_inr"], 19_500.0)
        self.assertEqual(plan["risk_inr"], 3_900.0)
        self.assertLessEqual(plan["lots"], option_math.CFG["gex_max_lots"])

    def test_the_gex_trade_is_schema_valid(self):
        import gex_engine
        import jsonschema_mini
        schema = json.load(open(os.path.join(SKILL, "references", "gex-output-schema.json")))
        snap = self.gex_snapshot()
        plan, why = gex_engine.build_trade(snap, {}, self.candidate(), 100.0, NOW,
                                           account_equity=EQUITY)
        self.assertIsNotNone(plan, why)
        record = {"engine": "GEX", "symbol": "NIFTY", "timestamp": NOW_ISO,
                  "spot": ACC_SPOT, "vix": 14.0,
                  "gex": {"net_cr": 0.0, "flip": None, "call_wall": None,
                          "call_wall_strength": 0.0, "put_wall": None,
                          "put_wall_strength": 0.0, "pin": None, "regime": "POSITIVE_GEX",
                          "net_trend": "UNKNOWN", "net_history_cr": [], "data_quality": "ok"},
                  "failed_gates": [], "action": "BUY_CE",
                  "trade_id": "GEX-NIFTY-20261020-1100-1", "strategy": "GEX-1 PIN_FADE",
                  "reasons": ["test"], "trade": plan}
        errors = jsonschema_mini.validate(record, schema)
        self.assertEqual(errors, [], "schema errors: %s" % errors)

    def test_the_gex_trade_is_refused_without_a_validated_equity(self):
        import gex_engine
        snap = self.gex_snapshot()
        plan, why = gex_engine.build_trade(snap, {}, self.candidate(), 100.0, NOW,
                                           account_equity=None)
        self.assertIsNone(plan)
        self.assertIn("account-equity", why)


class TestOrchestratorEndToEnd(unittest.TestCase):
    """The orchestrator CLI, end to end, on the acceptance snapshot."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.snapshot_path = os.path.join(self.tmp, "snapshot.json")
        history = acceptance_history()
        with open(self.snapshot_path, "w") as fh:
            json.dump(history[-1], fh)
        self.history_dir = F.write_history(os.path.join(self.tmp, "history"), history)
        self.context_path = F.write_context(os.path.join(self.tmp, "context.json"))
        self.equity_path = F.write_equity(os.path.join(self.tmp, "account_equity.json"),
                                          equity=EQUITY)
        self.out_path = os.path.join(self.tmp, "out.json")

    def run_cli(self):
        cmd = [sys.executable, os.path.join(SKILL, "scripts", "orchestrator.py"),
               "--snapshot", self.snapshot_path,
               "--history", self.history_dir,
               "--context", self.context_path,
               "--account-equity", self.equity_path,
               "--now", NOW_ISO,
               "--out", self.out_path,
               "--gex-out", os.path.join(self.tmp, "gex.jsonl"),
               "--gex-alert-out", os.path.join(self.tmp, "gex_alerts.jsonl")]
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=SKILL)
        out = {}
        if os.path.exists(self.out_path):
            with open(self.out_path) as fh:
                out = json.load(fh)
        return proc, out

    def test_the_cli_produces_a_trade_and_not_a_no_trade(self):
        proc, out = self.run_cli()
        self.assertEqual(out.get("action"), "BUY_CE", proc.stdout + proc.stderr)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["trade"]["strike"], ACC_STRIKE)
        self.assertEqual(out["trade"]["option_type"], "CE")

    def test_the_cli_reports_the_sizing(self):
        proc, out = self.run_cli()
        trade = out["trade"]
        self.assertEqual(trade["suggested_lots"], 1)
        self.assertEqual(trade["deployed_inr"], 19_500.0)
        self.assertEqual(trade["risk_inr"], 3_900.0)
        sizing = out["sizing"]
        self.assertEqual(sizing["deployed_budget"], 20_000.0)
        self.assertEqual(sizing["risk_pct_of_trade"], 20.0)
        self.assertEqual(sizing["risk_budget"], 4_000.0)
        self.assertEqual(sizing["deployed"], 19_500.0)
        self.assertEqual(sizing["risk_inr"], 3_900.0)
        self.assertIn("1 lot(s)", out["summary"])
        self.assertIn("19,500", out["summary"])

    def test_the_cli_summary_names_the_risk(self):
        proc, out = self.run_cli()
        self.assertIn("3,900 at risk", out["summary"])


if __name__ == "__main__":
    unittest.main()
