#!/usr/bin/env python3
"""Tests: 4-of-8 agreement, score-ceiling reporting, decide(), trade builder,
clock/theta/expiry gates, backward compatibility, frozen scorer parity,
nse_fetch provenance helpers. Offline + deterministic."""
import datetime as dt
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixtures
import agreement
import nse_fetch
from score_signal import (
    score_snapshot, decide, option_chain_score, fii_score, breadth_score,
    THETA_GATE_PCT,
)

NOW = fixtures.NOW


def _gate(out, needle):
    return any(needle in str(g) for g in out.get("gates_failed", []))


class TestAgreement(unittest.TestCase):
    def test_tally_eight_available_all_bullish(self):
        scores = {g["key"]: 5 for g in agreement.GROUPS}
        avail = {g["key"]: True for g in agreement.GROUPS}
        tally = agreement.tally_groups(scores, avail)
        self.assertEqual(tally["groups_total"], 8)
        self.assertEqual(tally["groups_available"], 8)
        self.assertEqual(tally["groups_bullish"], 8)
        self.assertEqual(tally["groups_agreeing"], 8)
        self.assertTrue(tally["gate_passed"])

    def test_missing_group_never_counts_as_agreement(self):
        scores = {g["key"]: 6 for g in agreement.GROUPS}
        avail = {g["key"]: True for g in agreement.GROUPS}
        avail["heatmap"] = False          # score value exists but data unavailable
        tally = agreement.tally_groups(scores, avail)
        self.assertEqual(tally["groups_available"], 7)
        self.assertIn("heatmap", tally["groups_missing"])
        self.assertNotIn("heatmap", [g for g in tally["groups_missing"] if g != "heatmap"])
        self.assertEqual(tally["groups_bullish"], 7)  # heatmap NOT counted

    def test_available_below_four_fails_gate(self):
        scores = {"option_chain": 20, "fii": 9, "greeks": 6}
        avail = {"option_chain": True, "fii": True, "greeks": True}
        tally = agreement.tally_groups(scores, avail)
        self.assertEqual(tally["groups_available"], 3)
        self.assertFalse(tally["gate_passed"])
        self.assertIn("FAIL", tally["gate"])

    def test_agreeing_below_four_fails_even_if_available(self):
        scores = {"option_chain": 10, "fii": 5, "greeks": -8, "heatmap": 6}
        avail = {k: True for k in scores}
        tally = agreement.tally_groups(scores, avail)
        self.assertEqual(tally["groups_available"], 4)
        self.assertEqual(tally["direction"], "BULLISH")
        self.assertEqual(tally["groups_agreeing"], 3)
        self.assertFalse(tally["gate_passed"])

    def test_neutral_groups_do_not_agree(self):
        scores = {"option_chain": 10, "fii": 0, "greeks": 0, "heatmap": 6}
        avail = {k: True for k in scores}
        tally = agreement.tally_groups(scores, avail)
        self.assertEqual(tally["groups_neutral"], 2)
        self.assertEqual(tally["groups_agreeing"], 2)
        self.assertFalse(tally["gate_passed"])

    def test_gate_reports_4_of_8(self):
        tally = agreement.tally_groups({}, {})
        passed, text = agreement.agreement_gate(tally)
        self.assertFalse(passed)
        self.assertIn("need >=4", text)
        self.assertIn("/8 available", text)
        # score_snapshot prefixes the spec wording "4/8"
        weak = fixtures.base_snapshot()
        weak.pop("groups", None)
        weak["gainers"] = {}
        weak["losers"] = {}
        out = score_snapshot(weak, now=NOW)
        self.assertTrue(any("4/8 group agreement not met" in str(g)
                            for g in out["gates_failed"]))


class TestDecideThresholds(unittest.TestCase):
    def test_thresholds_unchanged(self):
        self.assertEqual(agreement.THRESHOLD_BUY_CE, 40)
        self.assertEqual(agreement.THRESHOLD_BUY_PE, -40)
        self.assertEqual(len(agreement.GROUPS), 8)
        self.assertEqual(sum(g["spec_weight"] for g in agreement.GROUPS), 100)

    def test_decide_bounds(self):
        passing = {"gate_passed": True}
        self.assertEqual(decide(40, [], passing), "BUY_CE")
        self.assertEqual(decide(39, [], passing), "NO_TRADE")
        self.assertEqual(decide(-40, [], passing), "BUY_PE")
        self.assertEqual(decide(-39, [], passing), "NO_TRADE")
        self.assertEqual(decide(0, [], passing), "NO_TRADE")

    def test_decide_respects_gates_and_agreement(self):
        self.assertEqual(decide(60, ["some gate"], {"gate_passed": True}), "NO_TRADE")
        self.assertEqual(decide(60, [], {"gate_passed": False}), "NO_TRADE")
        self.assertEqual(decide(60, [], None), "BUY_CE")

    def test_ceiling_never_lowers_threshold(self):
        scores = {"option_chain": 10, "fii": 3, "greeks": 3}
        avail = {k: True for k in scores}
        report = agreement.ceiling_report(scores, avail)
        self.assertTrue(report["detected"])
        message = agreement.ceiling_message(report)
        self.assertIn("SCORE_CEILING_DETECTED", message)
        self.assertIn("thresholds unchanged", message)
        # +39 remains below the mandated +40 even when the ceiling is detected
        self.assertEqual(decide(39, [], {"gate_passed": True}), "NO_TRADE")


class TestScoreCeiling(unittest.TestCase):
    def test_all_groups_available_not_detected(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        report = out["score_ceiling"]
        self.assertFalse(report["detected"])
        self.assertGreaterEqual(report["achievable_max"], 40)
        self.assertIsNone(out["score_ceiling_message"])

    def test_partial_groups_detected_and_reported(self):
        snap = fixtures.base_snapshot()
        snap.pop("groups", None)
        snap["gainers"] = {}
        snap["losers"] = {}
        out = score_snapshot(snap, now=NOW)
        report = out["score_ceiling"]
        self.assertTrue(report["detected"])
        # implemented bound: option_chain 24 + fii 9 + greeks 6 = 39 < 40
        self.assertEqual(report["achievable_max"], 39)
        self.assertIn("SCORE_CEILING_DETECTED", out["score_ceiling_message"])
        self.assertEqual(report["threshold_up"], 40)
        self.assertEqual(report["threshold_down"], -40)

    def test_ceiling_is_report_only_never_a_gate(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        self.assertFalse(_gate(out, "SCORE_CEILING"))  # not used as a gate string
        self.assertEqual(out["action"], "BUY_CE")


class TestTradeBuilder(unittest.TestCase):
    def test_buy_ce_trade_shape(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        self.assertEqual(out["action"], "BUY_CE")
        trade = out["trade"]
        self.assertIsNotNone(trade)
        self.assertEqual(trade["option_type"], "CE")
        self.assertEqual(trade["expiry"], "2026-10-08")
        self.assertEqual(trade["entry"], 150.0)          # real LTP from chain
        self.assertAlmostEqual(trade["sl"], 112.5)       # -25% premium
        self.assertAlmostEqual(trade["tp1"], 210.0)      # +40%
        self.assertAlmostEqual(trade["tp2"], 270.0)      # +80%
        self.assertGreaterEqual(trade["risk_reward_tp1"], 1.5)
        self.assertGreaterEqual(trade["risk_reward_tp2"], 2.0)
        self.assertEqual(trade["invalidation"], 24900)   # put-OI support
        self.assertEqual(trade["underlying_invalidation"], 24900)
        self.assertEqual(trade["order_type"], "limit")
        self.assertEqual(trade["strategy"], out["strategy"])
        # delta target 0.50-0.60 from greeks.strikes
        greeks_block = out["greeks"]
        strike_row = next(s for s in greeks_block["strikes"]
                          if s["strike"] == trade["strike"])
        delta = strike_row["CE"]["delta"]
        self.assertGreaterEqual(delta, 0.50)
        self.assertLessEqual(delta, 0.60)

    def test_buy_pe_trade_shape(self):
        out = score_snapshot(fixtures.bearish_snapshot(), now=NOW)
        self.assertEqual(out["action"], "BUY_PE")
        trade = out["trade"]
        self.assertEqual(trade["option_type"], "PE")
        self.assertEqual(trade["invalidation"], 25100)   # call-OI resistance
        self.assertAlmostEqual(trade["sl"], round(trade["entry"] * 0.75, 2))
        self.assertAlmostEqual(trade["tp1"], round(trade["entry"] * 1.40, 2))
        self.assertAlmostEqual(trade["tp2"], round(trade["entry"] * 1.80, 2))

    def test_wide_spread_gates_trade(self):
        snap = fixtures.base_snapshot()
        for row in snap["option_chain"]["records"]["data"]:
            for side in ("CE", "PE"):
                ltp = row[side]["lastPrice"]
                row[side]["bidprice"] = round(ltp * 0.5, 2)
                row[side]["askPrice"] = round(ltp * 2.0, 2)
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "SPREAD"))
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertIsNone(out["trade"])

    def test_missing_ltp_never_invents_entry_price(self):
        snap = fixtures.base_snapshot()
        for row in snap["option_chain"]["records"]["data"]:
            row["CE"]["lastPrice"] = 0
            row["PE"]["lastPrice"] = 0
        out = score_snapshot(snap, now=NOW)
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertTrue(_gate(out, "ENTRY_PRICE_UNAVAILABLE"))
        self.assertIsNone(out["trade"])

    def test_no_named_strategy_blocks_trade(self):
        snap = fixtures.base_snapshot()
        snap["strategy"] = None
        out = score_snapshot(snap, now=NOW)
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertTrue(_gate(out, "NO_NAMED_STRATEGY"))

    def test_strike_not_in_top5_oi_gates(self):
        snap = fixtures.base_snapshot()
        rows = snap["option_chain"]["records"]["data"]
        for row in rows:
            strike = row["strikePrice"]
            if strike == 25000:
                row["CE"]["openInterest"] = 1_000
                row["PE"]["openInterest"] = 1_000
            elif 24500 <= strike <= 24900:
                row["PE"]["openInterest"] += 8_000_000
            elif 25100 <= strike <= 25500:
                row["CE"]["openInterest"] += 8_000_000
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "top-5 OI"))
        self.assertEqual(out["action"], "NO_TRADE")

    def test_actions_only_buy_or_no_trade_never_sell(self):
        for snap in (fixtures.base_snapshot(), fixtures.bearish_snapshot()):
            out = score_snapshot(snap, now=NOW)
            self.assertIn(out["action"], ("BUY_CE", "BUY_PE", "NO_TRADE"))
            self.assertIn(out["decision"], ("BUY_CE", "BUY_PE", "NO_TRADE"))
            if out["trade"]:
                self.assertIn(out["trade"]["option_type"], ("CE", "PE"))


class TestClockThetaExpiryGates(unittest.TestCase):
    def test_before_0930_gates(self):
        out = score_snapshot(fixtures.base_snapshot(),
                             now=dt.datetime(2026, 9, 25, 9, 15, 0))
        self.assertTrue(_gate(out, "before 09:30 IST"))
        self.assertEqual(out["action"], "NO_TRADE")

    def test_after_1445_gates(self):
        out = score_snapshot(fixtures.base_snapshot(),
                             now=dt.datetime(2026, 9, 25, 14, 50, 0))
        self.assertTrue(_gate(out, "after 14:45 IST"))
        self.assertEqual(out["action"], "NO_TRADE")

    def test_expiry_day_after_1330_gates(self):
        snap = fixtures.base_snapshot()
        snap["option_chain"]["records"]["expiryDates"][0] = "25-Sep-2026"
        for row in snap["option_chain"]["records"]["data"]:
            row["expiryDate"] = "25-Sep-2026"
        out = score_snapshot(snap, now=dt.datetime(2026, 9, 25, 14, 0, 0))
        self.assertTrue(any("13:30" in str(g) for g in out["gates_failed"]))
        self.assertEqual(out["action"], "NO_TRADE")

    def test_theta_above_10_percent_gates(self):
        snap = fixtures.base_snapshot()
        snap["option_chain"]["records"]["expiryDates"][0] = "28-Sep-2026"
        for row in snap["option_chain"]["records"]["data"]:
            row["expiryDate"] = "28-Sep-2026"
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "theta"))
        self.assertEqual(THETA_GATE_PCT, 10.0)
        self.assertEqual(out["action"], "NO_TRADE")


class TestBackwardCompatibility(unittest.TestCase):
    def test_legacy_output_keys_preserved(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        for key in ("bias_score", "components", "greeks", "levels", "action",
                    "gates_failed", "note"):
            self.assertIn(key, out)
        self.assertEqual(
            set(out["components"].keys()),
            {"option_chain", "fii", "breadth", "greeks"})
        greeks_keys = {"atm_iv", "skew_put_minus_call", "gamma_flip", "regime",
                       "expected_move_1sigma", "hours_to_expiry"}
        self.assertTrue(greeks_keys.issubset(set(out["greeks"].keys())))
        self.assertIsInstance(out["gates_failed"], list)
        self.assertIsInstance(out["note"], str)
        self.assertIsInstance(out["levels"], dict)

    def test_extended_section20_keys_present(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        for key in ("source", "role", "timestamp_ist", "bias", "agreement",
                    "data_quality", "news_context", "sentiment_context",
                    "strategy", "trade", "supporting_evidence",
                    "conflicting_evidence", "missing_inputs", "gates",
                    "reason", "score_ceiling", "component_scores"):
            self.assertIn(key, out)
        self.assertEqual(out["source"], "NSE_OPTIONS_SIGNAL")
        self.assertEqual(out["role"], "OPTIONS_RESEARCH_SECOND_OPINION")

    def test_frozen_scorer_signatures_and_values(self):
        snap = fixtures.base_snapshot()
        score, info = option_chain_score(snap["option_chain"])
        self.assertIsInstance(score, int)
        self.assertEqual(set(info.keys()), {"spot", "pcr", "support", "resistance"})
        self.assertEqual(score, 16)
        self.assertEqual(fii_score(snap["fii_dii"]), 6)
        self.assertEqual(breadth_score(snap["gainers"], snap["losers"]), 5)
        self.assertEqual(fii_score("not a list"), 0)

    def test_backtest_history_still_imports_frozen_functions(self):
        import backtest_history
        self.assertTrue(callable(backtest_history.score_mod.option_chain_score))
        self.assertTrue(callable(backtest_history.score_mod.fii_score))
        self.assertTrue(callable(backtest_history.score_mod.breadth_score))

    def test_legacy_snapshot_without_meta_runs_and_gates(self):
        snap = fixtures.base_snapshot()
        snap.pop("meta")
        snap.pop("groups", None)
        snap.pop("news", None)
        snap.pop("strategy", None)
        out = score_snapshot(snap, now=NOW)
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertTrue(_gate(out, "DATA_FRESHNESS"))
        self.assertTrue(any("option_chain" in m for m in out["missing_inputs"]))

    def test_score_snapshot_returns_dict_and_json_safe(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        json.dumps(out)  # must not raise


class TestNseFetchHelpers(unittest.TestCase):
    def test_payload_timestamp_extraction(self):
        self.assertEqual(
            nse_fetch._payload_timestamp({"timestamp": "25-Sep-2026 15:30:00"}),
            "25-Sep-2026 15:30:00")
        self.assertEqual(
            nse_fetch._payload_timestamp({"records": {"timestamp": "x"}}), "x")
        self.assertIsNone(nse_fetch._payload_timestamp({}))
        self.assertIsNone(nse_fetch._payload_timestamp("not a dict"))

    def test_record_fetch_unavailable_on_error(self):
        rec = nse_fetch._record_fetch(
            "option_chain", "option_chain", "/api/x",
            {"_error": "failed /api/x"}, 3, "2026-09-25 10:00:00")
        self.assertEqual(rec["status"], "UNAVAILABLE")
        self.assertIn("fetch failed", rec["detail"])

    def test_record_fetch_live_and_fallback(self):
        payload = {"timestamp": "2026-09-25 09:58:00"}
        rec = nse_fetch._record_fetch(
            "option_chain", "option_chain", "/api/x", payload, 1,
            "2026-09-25 10:00:00")
        self.assertEqual(rec["status"], "LIVE")
        rec = nse_fetch._record_fetch(
            "option_chain", "option_chain", "/api/x", payload, 3,
            "2026-09-25 10:00:00")
        self.assertEqual(rec["status"], "FALLBACK")

    def test_section_map_maps_all_indices_to_vix(self):
        self.assertEqual(nse_fetch._prov.SECTION_INPUT_MAP["all_indices"], "vix")
        self.assertEqual(nse_fetch._prov.SECTION_INPUT_MAP["option_chain"],
                         "option_chain")


if __name__ == "__main__":
    unittest.main(verbosity=2)
