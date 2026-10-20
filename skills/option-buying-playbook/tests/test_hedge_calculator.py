#!/usr/bin/env python3
"""Offline tests for hedge_calculator.py — it must use the SAME per-trade
capital model as strike_selector.py (capital_model.py):

    deployed_budget = min(trade_budget, capital)
    risk_budget     = deployed_budget * risk_pct_of_trade / 100
    lots            = min(risk-limited, affordability, strategy cap)

Run:
    cd skills/option-buying-playbook && python3 -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import unittest

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(SKILL_DIR, "scripts", "hedge_calculator.py")
sys.path.insert(0, os.path.join(SKILL_DIR, "scripts"))

SPREAD = ["spread", "--spot", "25100", "--vix", "22", "--days", "4", "--direction", "call",
          "--long-strike", "25100", "--target", "25250", "--stop", "25040", "--hold-days", "1"]


def run(*extra):
    proc = subprocess.run([sys.executable, SCRIPT, *SPREAD, *extra, "--json"],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(f"hedge_calculator failed: {proc.stderr}")
    return json.loads(proc.stdout)


class TestSameModelAsStrikeSelector(unittest.TestCase):
    def test_defaults_are_the_real_per_trade_model(self):
        out = run("--lot-size", "75")
        m = out["capital_model"]
        self.assertEqual(m["capital"], 25000)
        self.assertEqual(m["trade_budget"], 20000)
        self.assertEqual(m["risk_pct_of_trade"], 20)
        self.assertEqual(out["deployed_budget"], 20000)
        self.assertEqual(out["risk_budget"], 4000)
        self.assertEqual(out["budget"], 4000)

    def test_output_carries_the_formula_fields(self):
        out = run("--lot-size", "75")
        m = out["capital_model"]
        for key in ("deployed_budget", "risk_budget", "risk_pct_of_trade", "deployed", "risk", "formula"):
            self.assertIn(key, m, f"capital_model is missing {key}")
        for key in ("deployed_budget", "risk_budget", "risk_pct_of_trade"):
            self.assertIn(key, out, f"output is missing {key}")
        self.assertIn("lots = min(", m["formula"])

    def test_the_affordability_cap_binds(self):
        out = run("--lot-size", "75")
        for row in out["spreads"]:
            self.assertLessEqual(row["lots_by_stop_risk"], row["lots_by_risk"])
            self.assertLessEqual(row["lots_by_stop_risk"], row["lots_by_affordability"])
            self.assertLessEqual(row["total_deployed"], 20000)
            self.assertLessEqual(row["total_risk"], 4000)
        # the debit spread is affordable but the naked long is not (Rs 4,694 risk/lot)
        self.assertEqual(out["naked"]["lots_by_risk"], 0)
        self.assertEqual(out["naked"]["lots_by_affordability"], 1)
        self.assertEqual(out["naked"]["lots_by_stop_risk"], 0)
        self.assertIn("risk budget", out["naked"]["reject_reason"])

    def test_lots_are_never_rounded_up(self):
        out = run("--lot-size", "75")
        for row in out["spreads"]:
            self.assertEqual(row["lots_by_stop_risk"],
                             min(row["lots_by_risk"], row["lots_by_affordability"]))

    def test_strategy_cap_limits_the_lots(self):
        out = run("--lot-size", "75", "--max-lots", "1")
        for row in out["spreads"]:
            self.assertLessEqual(row["lots_by_stop_risk"], 1)

    def test_unaffordable_structure_gets_zero_lots(self):
        # lot 900 => the cheapest spread costs Rs 22,057 per lot, past the
        # Rs 20,000 deployment cap -> 0 lots, no suggestion.
        out = run("--lot-size", "900")
        for row in out["spreads"]:
            self.assertEqual(row["lots_by_stop_risk"], 0)
            self.assertEqual(row["lots_by_affordability"], 0)
        self.assertIsNone(out["suggested"])

    def test_the_affordability_cap_binds_alone(self):
        # 25150 spread with lot 900: risk 1,025/lot is inside the Rs 4,000 risk
        # budget, but the Rs 22,057 premium per lot does not fit the deployment cap.
        out = run("--lot-size", "900")
        row = next(r for r in out["spreads"] if r["short_strike"] == 25150)
        self.assertEqual(row["lots_by_risk"], 1)
        self.assertEqual(row["lots_by_affordability"], 0)
        self.assertEqual(row["lots_by_stop_risk"], 0)
        self.assertIn("does not fit", row["reject_reason"])

    def test_old_capital_risk_combo_is_capped_by_the_deployment_budget(self):
        out = run("--lot-size", "75", "--capital", "300000", "--risk-pct", "20")
        self.assertEqual(out["deployed_budget"], 20000)
        self.assertEqual(out["risk_budget"], 4000)


class TestPortfolioMode(unittest.TestCase):
    def test_portfolio_hedge_is_unaffected(self):
        proc = subprocess.run(
            [sys.executable, SCRIPT, "portfolio", "--value", "2500000", "--beta", "1.1",
             "--index", "25100", "--lot-size", "75", "--hedge-ratio", "0.5", "--vix", "14",
             "--days", "25", "--put-premium", "210", "--json"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["lots"], 1)
        self.assertEqual(out["est_cost"], 15750)


if __name__ == "__main__":
    unittest.main()
