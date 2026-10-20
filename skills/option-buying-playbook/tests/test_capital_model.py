#!/usr/bin/env python3
"""Unit tests for the per-trade capital model (capital_model.py).

Offline, deterministic. Run:
    cd skills/option-buying-playbook && python3 -m unittest discover -s tests
"""
import os
import sys
import unittest

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
sys.path.insert(0, SCRIPTS)

from capital_model import (  # noqa: E402
    DEFAULT_CAPITAL, DEFAULT_RISK_PCT_OF_TRADE, DEFAULT_TRADE_BUDGET, FORMULA,
    build_model, size_lots,
)


class TestDefaults(unittest.TestCase):
    def test_defaults_match_the_user_rule(self):
        self.assertEqual(DEFAULT_CAPITAL, 25000)
        self.assertEqual(DEFAULT_RISK_PCT_OF_TRADE, 20)
        self.assertEqual(DEFAULT_TRADE_BUDGET, 20000)

    def test_default_model_deploys_20000_and_risks_4000(self):
        m = build_model()
        self.assertEqual(m["deployed_budget"], 20000)
        self.assertEqual(m["risk_budget"], 4000)
        self.assertEqual(m["risk_pct_of_trade"], 20)


class TestBuildModel(unittest.TestCase):
    def test_deployed_budget_is_the_min_of_trade_budget_and_capital(self):
        self.assertEqual(build_model(capital=25000, trade_budget=20000)["deployed_budget"], 20000)
        self.assertEqual(build_model(capital=15000, trade_budget=20000)["deployed_budget"], 15000)
        self.assertEqual(build_model(capital=200000, trade_budget=20000)["deployed_budget"], 20000)

    def test_risk_is_a_rupee_amount_of_the_deployed_budget(self):
        m = build_model(capital=25000, trade_budget=20000, risk_pct=20)
        self.assertAlmostEqual(m["risk_budget"], m["deployed_budget"] * 0.20)

    def test_risk_pct_is_a_percentage_not_a_fraction(self):
        m = build_model(capital=25000, trade_budget=20000, risk_pct=20)
        self.assertAlmostEqual(m["risk_budget"], 4000.0)

    def test_formula_is_published(self):
        self.assertIn("deployed_budget = min(trade_budget, capital)", FORMULA)
        self.assertIn("risk_budget = deployed_budget * risk_pct_of_trade / 100", FORMULA)
        self.assertIn("lots = min(", FORMULA)
        self.assertEqual(build_model()["formula"], FORMULA)


class TestSizeLots(unittest.TestCase):
    def setUp(self):
        self.model = build_model()  # deployed 20000, risk 4000

    def test_both_caps_apply_and_the_tighter_one_wins(self):
        # risk allows 3 lots (4000 / 1000), affordability allows 2 (20000 / 9000)
        s = size_lots(self.model, risk_per_lot=1000, premium_per_lot=9000)
        self.assertEqual(s["lots_by_risk"], 4)
        self.assertEqual(s["lots_by_affordability"], 2)
        self.assertEqual(s["lots"], 2)

    def test_affordability_cap_binds_alone(self):
        # the risk side allows 1 lot, but the premium does not fit the deployment cap
        s = size_lots(self.model, risk_per_lot=3000, premium_per_lot=25000)
        self.assertEqual(s["lots_by_risk"], 1)
        self.assertEqual(s["lots_by_affordability"], 0)
        self.assertEqual(s["lots"], 0)
        self.assertIn("does not fit", s["reason"])

    def test_risk_cap_binds_alone(self):
        s = size_lots(self.model, risk_per_lot=5000, premium_per_lot=1000)
        self.assertEqual(s["lots_by_risk"], 0)
        self.assertEqual(s["lots_by_affordability"], 20)
        self.assertEqual(s["lots"], 0)
        self.assertIn("risk budget", s["reason"])

    def test_lots_are_never_rounded_up(self):
        s = size_lots(self.model, risk_per_lot=1500, premium_per_lot=1500)
        self.assertEqual(s["lots"], 2)  # 4000 // 1500 = 2 (not 3)

    def test_zero_lots_reports_a_reason_and_never_suggests_risking_more(self):
        s = size_lots(self.model, risk_per_lot=99999, premium_per_lot=99999)
        self.assertEqual(s["lots"], 0)
        self.assertTrue(s["reason"])
        self.assertIn("NEVER risk more", s["reason"])

    def test_strategy_cap_is_applied(self):
        model = build_model(capital=250000, trade_budget=200000, risk_pct=20, max_lots=3)
        s = size_lots(model, risk_per_lot=100, premium_per_lot=100)
        self.assertEqual(s["lots"], 3)
        self.assertTrue(s["capped_by_strategy"])

    def test_costs_are_added_to_both_sides(self):
        model = build_model(cost_per_lot=100)
        s = size_lots(model, risk_per_lot=1900, premium_per_lot=1900)
        # 4000 // 2000 = 2 and 20000 // 2000 = 10
        self.assertEqual(s["lots_by_risk"], 2)
        self.assertEqual(s["lots_by_affordability"], 10)
        self.assertEqual(s["lots"], 2)

    def test_totals_are_reported(self):
        s = size_lots(self.model, risk_per_lot=1000, premium_per_lot=5000)
        self.assertEqual(s["lots"], 4)
        self.assertEqual(s["total_deployed"], 20000)
        self.assertEqual(s["total_risk"], 4000)


if __name__ == "__main__":
    unittest.main()
