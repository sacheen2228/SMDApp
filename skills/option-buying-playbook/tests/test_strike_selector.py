#!/usr/bin/env python3
"""Offline tests for strike_selector.py under the per-trade capital model.

THE P0 BUG: the selector used `risk_budget = capital * risk_pct/100` with
capital = Rs 2,00,000 and risk_pct = 1 -> a Rs 2,000 risk budget against a
NIFTY lot that risks Rs 3,000+ -> 0 lots on EVERY strike -> "no strike passes
the gates" for every setup. The model is now
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
SCRIPT = os.path.join(SKILL_DIR, "scripts", "strike_selector.py")
sys.path.insert(0, os.path.join(SKILL_DIR, "scripts"))

# A realistic NIFTY setup (spot 25100, VIX 14, 5 days to expiry).
NIFTY = ["--spot", "25100", "--vix", "14", "--days", "5", "--direction", "call",
         "--target", "25300", "--stop", "25000"]


def run(*extra):
    """Run the selector with --json and return the parsed output."""
    proc = subprocess.run([sys.executable, SCRIPT, *NIFTY, *extra, "--json"],
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(f"strike_selector failed: {proc.stderr}")
    return json.loads(proc.stdout)


class TestNewDefaults(unittest.TestCase):
    def test_defaults_are_the_real_per_trade_model(self):
        out = run("--lot-size", "65")
        self.assertEqual(out["capital_model"]["capital"], 25000)
        self.assertEqual(out["capital_model"]["trade_budget"], 20000)
        self.assertEqual(out["capital_model"]["risk_pct_of_trade"], 20)
        self.assertEqual(out["deployed_budget"], 20000)
        self.assertEqual(out["risk_budget"], 4000)

    def test_output_carries_the_formula_fields(self):
        out = run("--lot-size", "65")
        m = out["capital_model"]
        for key in ("deployed_budget", "risk_budget", "risk_pct_of_trade", "deployed", "risk", "formula"):
            self.assertIn(key, m, f"capital_model is missing {key}")
        for key in ("deployed_budget", "risk_budget", "risk_pct_of_trade", "deployed", "risk"):
            self.assertIn(key, out, f"output is missing {key}")
        self.assertIn("deployed_budget = min(trade_budget, capital)", m["formula"])
        self.assertIn("lots = min(", m["formula"])

    def test_a_realistic_setup_produces_a_strike(self):
        # THE P0 REGRESSION: this used to return recommendation = None and 0 lots.
        out = run("--lot-size", "65")
        rec = out["recommendation"]
        self.assertIsNotNone(rec, "no strike passes the gates — the P0 bug is back")
        self.assertGreaterEqual(rec["lots"], 1)
        self.assertEqual(rec["strike"], 25050)
        self.assertAlmostEqual(rec["entry"], 202.52, places=2)
        self.assertAlmostEqual(rec["reward_risk"], 2.25, places=2)
        self.assertTrue(rec["passes"])
        # the recommended strike is inside the deployment cap
        self.assertLessEqual(rec["total_deployed"], 20000)

    def test_the_old_capital_risk_combo_no_longer_breaks_the_selector(self):
        # capital 200000 / risk 1% was the old (broken) call from the agent.
        # The deployment cap keeps it sane only if the risk % is the new one.
        out = run("--lot-size", "65", "--capital", "200000", "--risk-pct", "20")
        self.assertIsNotNone(out["recommendation"])
        self.assertEqual(out["deployed_budget"], 20000)   # capped by the trade budget
        self.assertEqual(out["risk_budget"], 4000)


class TestAffordability(unittest.TestCase):
    def test_unaffordable_strike_gets_zero_lots_and_no_recommendation(self):
        # lot 200 => Rs 40,504 premium per lot >> the Rs 20,000 deployment cap
        out = run("--lot-size", "200")
        self.assertIsNone(out["recommendation"])
        for row in out["all_candidates"]:
            self.assertEqual(row["lots"], 0)
            self.assertFalse(row["passes"])
            self.assertFalse(row["gates"]["size_ok"])
            self.assertTrue(row["reject_reason"])
        self.assertIn("0 lots", out["all_candidates"][0]["reject_reason"])

    def test_the_affordability_cap_binds_when_the_risk_side_would_allow_a_lot(self):
        # strike 24500 with lot 32: risk 3036/lot is inside the Rs 4,000 budget,
        # but the premium (Rs 20,253/lot) does not fit the Rs 20,000 deployment cap.
        out = run("--lot-size", "32", "--itm-range", "12")
        row = next(r for r in out["all_candidates"] if r["strike"] == 24500)
        self.assertEqual(row["lots_by_risk"], 1)
        self.assertEqual(row["lots_by_affordability"], 0)
        self.assertEqual(row["lots"], 0)
        self.assertIn("does not fit", row["reject_reason"])
        self.assertFalse(row["gates"]["size_ok"])

    def test_lots_are_never_rounded_up(self):
        out = run("--lot-size", "65")
        for row in out["all_candidates"]:
            self.assertLessEqual(row["lots"], row["lots_by_risk"])
            self.assertLessEqual(row["lots"], row["lots_by_affordability"])
            self.assertLessEqual(row["total_deployed"], 20000)
            self.assertLessEqual(row["total_risk"], 4000)

    def test_strategy_cap_limits_the_lots(self):
        out = run("--lot-size", "65", "--max-lots", "1")
        for row in out["all_candidates"]:
            self.assertLessEqual(row["lots"], 1)


class TestReport(unittest.TestCase):
    def test_text_report_shows_the_model(self):
        proc = subprocess.run([sys.executable, SCRIPT, *NIFTY, "--lot-size", "65"],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Capital model", proc.stdout)
        self.assertIn("Rs 20,000", proc.stdout)
        self.assertIn("RECOMMENDED", proc.stdout)


if __name__ == "__main__":
    unittest.main()
