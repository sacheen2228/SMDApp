#!/usr/bin/env python3
"""Offline tests for the GEX engine, its gates and the invalidation-close
monitor.

The engine is the only place gamma exposure is computed; these tests lock its
regimes, its strategy mapping, its gates and its schema conformance.
"""
import copy
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
import gex_engine  # noqa: E402
import gex_exit_monitor  # noqa: E402
import gex_snapshot  # noqa: E402
import jsonschema_mini  # noqa: E402

NOW = F.NOW
SCHEMA = json.load(open(os.path.join(SKILL, "references", "gex-output-schema.json")))


def build_snapshot(regime="POSITIVE_GEX", now=NOW, oi_scale=1.0, spot=25000.0, lot=65,
                   vix=14.0, days_to_expiry=7.0, expiry="2026-10-27", candles=None):
    rows = []
    for strike in range(24000, 26001, 100):
        call_oi, put_oi = 1_000_000, 1_000_000
        if regime == "POSITIVE_GEX":
            call_oi = 6_000_000 if strike >= spot else 500_000
            put_oi = 400_000
        elif regime == "NEGATIVE_GEX":
            put_oi = 6_000_000 if strike <= spot else 400_000
            call_oi = 500_000
        else:
            call_oi = 3_000_000 if strike >= spot + 200 else 400_000
            put_oi = 3_000_000 if strike <= spot - 200 else 400_000
        rows.append({"strike": strike, "call_oi": int(call_oi * oi_scale),
                     "put_oi": int(put_oi * oi_scale), "call_iv": 13.0, "put_iv": 13.0,
                     "call_ltp": 180.0, "put_ltp": 175.0, "call_bid": 179.0, "call_ask": 181.0,
                     "put_bid": 174.0, "put_ask": 176.0, "call_volume": 5000, "put_volume": 5000})
    if candles is None:
        candles = [{"t": (now - F.dt.timedelta(minutes=15 * (30 - i))).isoformat(),
                    "o": spot, "h": spot + 10, "l": spot - 10, "c": spot, "v": 100_000}
                   for i in range(30)]
    return {"symbol": "NIFTY", "timestamp": now.isoformat(), "spot": spot, "vix": vix,
            "lot_size": lot,
            "expiries": [{"date": expiry, "days_to_expiry": days_to_expiry, "chain": rows}],
            "candles_15m": candles}


class TestGexRegimes(unittest.TestCase):
    def test_positive_gamma_regime(self):
        snap = build_snapshot("POSITIVE_GEX")
        g = gex_engine.compute_gex(snap)
        self.assertEqual(g["regime"], "POSITIVE_GEX")
        self.assertGreater(g["net"], 0)

    def test_negative_gamma_regime(self):
        snap = build_snapshot("NEGATIVE_GEX")
        g = gex_engine.compute_gex(snap)
        self.assertEqual(g["regime"], "NEGATIVE_GEX")
        self.assertLess(g["net"], 0)

    def test_transition_regime(self):
        snap = build_snapshot("TRANSITION")
        g = gex_engine.compute_gex(snap)
        self.assertEqual(g["regime"], "TRANSITION")

    def test_the_strategy_mapping_is_enforced(self):
        ctx = {"trend": "MIXED", "snap": build_snapshot(), "hist": [], "now": NOW}
        candles = build_snapshot()["candles_15m"]
        g = gex_engine.compute_gex(build_snapshot("POSITIVE_GEX"))
        # GEX-2 (flip break) only belongs to the TRANSITION regime
        self.assertIsNone(gex_engine.gex2_flip_break(g, candles, 25000.0, ctx))
        # GEX-3 (negative-gamma trend) only to NEGATIVE_GEX
        self.assertIsNone(gex_engine.gex3_neg_trend(g, candles, 25000.0, ctx))
        # GEX-1 (pin fade) only to POSITIVE_GEX
        gneg = gex_engine.compute_gex(build_snapshot("NEGATIVE_GEX"))
        self.assertIsNone(gex_engine.gex1_pin_fade(gneg, candles, 25000.0, ctx))
        # GEX-4 only to NEGATIVE_GEX with falling net GEX
        self.assertIsNone(gex_engine.gex4_wall_break(g, candles, 25000.0, ctx))

    def test_the_record_is_schema_valid(self):
        snap = build_snapshot("POSITIVE_GEX")
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        self.assertEqual(jsonschema_mini.validate(rec, SCHEMA), [])

    def test_the_trade_id_is_a_gex_id(self):
        snap = build_snapshot("POSITIVE_GEX")
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        if rec["action"] != "NO_TRADE":
            self.assertTrue(rec["trade_id"].startswith("GEX-"))
            self.assertEqual(rec["engine"], "GEX")


class TestGexGates(unittest.TestCase):
    def test_a_stale_snapshot_is_gated(self):
        snap = build_snapshot("POSITIVE_GEX", now=NOW - F.dt.timedelta(minutes=30))
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        self.assertEqual(rec["action"], "NO_TRADE")
        self.assertTrue(any("stale" in g for g in rec["failed_gates"]))

    def test_a_future_snapshot_is_gated(self):
        snap = build_snapshot("POSITIVE_GEX", now=NOW + F.dt.timedelta(minutes=10))
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        self.assertTrue(any("future" in g for g in rec["failed_gates"]))

    def test_an_unknown_lot_size_is_gated(self):
        snap = build_snapshot("POSITIVE_GEX", lot=0)
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        self.assertTrue(any("lot size" in g for g in rec["failed_gates"]))

    def test_the_session_window_is_enforced(self):
        before = NOW.replace(hour=9, minute=0)
        rec = gex_engine.run(build_snapshot("POSITIVE_GEX", now=before), [], before, None,
                             account_equity=500_000)
        self.assertTrue(any("09:30" in g for g in rec["failed_gates"]))
        after = NOW.replace(hour=15, minute=30)
        rec = gex_engine.run(build_snapshot("POSITIVE_GEX", now=after), [], after, None,
                             account_equity=500_000)
        self.assertTrue(any("15:00" in g for g in rec["failed_gates"]))

    def test_less_than_three_hours_to_expiry_is_gated(self):
        now = NOW.replace(hour=13, minute=0)
        snap = build_snapshot("POSITIVE_GEX", now=now, expiry="2026-10-20", days_to_expiry=0.1)
        rec = gex_engine.run(snap, [], now, None, account_equity=500_000)
        self.assertTrue(any("to expiry" in g for g in rec["failed_gates"]))

    def test_history_below_three_snapshots_is_gated(self):
        snap = build_snapshot("POSITIVE_GEX")
        rec = gex_engine.run(snap, [], NOW, None, account_equity=500_000)
        self.assertTrue(any("history snapshots" in g for g in rec["failed_gates"]))

    def test_a_frozen_feed_is_gated(self):
        snap = build_snapshot("POSITIVE_GEX")
        hist = [(NOW - F.dt.timedelta(minutes=15), copy.deepcopy(snap))]
        rec = gex_engine.run(snap, hist, NOW, None, account_equity=500_000)
        self.assertTrue(any("frozen feed" in g for g in rec["failed_gates"]))

    def test_the_cooldown_blocks_a_second_gex_trade(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "gex.jsonl")
            with open(out, "w") as fh:
                fh.write(json.dumps({"engine": "GEX", "symbol": "NIFTY", "action": "BUY_CE",
                                     "timestamp": (NOW - F.dt.timedelta(minutes=5)).isoformat()}) + "\n")
            snap = build_snapshot("POSITIVE_GEX")
            rec = gex_engine.run(snap, [], NOW, out, account_equity=500_000)
            self.assertTrue(any("cooldown" in g for g in rec["failed_gates"]))


class TestGexSizing(unittest.TestCase):
    def test_vix_above_20_halves_the_size(self):
        import option_math
        full = option_math.size_position(50.0, 65, 180.0, 1_000_000, 1.0, vix=14.0)
        high = option_math.size_position(50.0, 65, 180.0, 1_000_000, 1.0, vix=25.0)
        self.assertEqual(high["lots"], full["lots"] // 2)

    def test_without_a_validated_equity_there_is_no_size(self):
        import option_math
        sizing = option_math.size_position(50.0, 65, 180.0, None, 1.0, vix=14.0)
        self.assertEqual(sizing["lots"], 0)
        self.assertIn("equity", sizing["reason"])


class TestGexExitMonitor(unittest.TestCase):
    def record(self, invalidation=24_950.0, action="BUY_CE", ts=None):
        return {"engine": "GEX", "symbol": "NIFTY", "action": action, "trade_id": "GEX-NIFTY-20261020-1100-1",
                "strategy": "GEX-1 PIN_FADE", "timestamp": (ts or NOW).isoformat(),
                "trade": {"underlying_invalidation": invalidation, "strike": 25000.0, "type": "CE"}}

    def snapshot_with_close(self, close, ts=None):
        ts = ts or NOW
        closes = [25000.0] * 29 + [close]
        bars = F.bars(closes, [100_000] * 30, start=ts - F.dt.timedelta(minutes=15 * 30))
        return {"symbol": "NIFTY", "fetched_at_ist": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "option_chain": {"records": {"underlyingValue": close,
                                             "timestamp": ts.strftime("%d-%b-%Y %H:%M:%S"),
                                             "data": []}},
                "candles_15m": bars}

    def test_a_close_back_through_the_invalidation_raises_an_exit_alert(self):
        snap = self.snapshot_with_close(24_900.0)
        alert = gex_exit_monitor.check_exit(self.record(), snap, NOW)
        self.assertEqual(alert["status"], "EXIT")
        self.assertIn("EXIT AT MARKET", alert["message"])

    def test_a_close_that_holds_keeps_the_position(self):
        snap = self.snapshot_with_close(25_100.0)
        alert = gex_exit_monitor.check_exit(self.record(), snap, NOW)
        self.assertEqual(alert["status"], "HOLD")

    def test_without_a_closed_candle_the_exit_cannot_be_confirmed(self):
        snap = self.snapshot_with_close(24_900.0)
        snap["candles_15m"] = []
        alert = gex_exit_monitor.check_exit(self.record(), snap, NOW)
        self.assertEqual(alert["status"], "UNCONFIRMED")
        self.assertIn("cannot be confirmed", alert["message"])

    def test_a_stale_snapshot_cannot_confirm_the_exit(self):
        snap = self.snapshot_with_close(24_900.0, ts=NOW - F.dt.timedelta(minutes=40))
        alert = gex_exit_monitor.check_exit(self.record(), snap, NOW)
        self.assertEqual(alert["status"], "UNCONFIRMED")

    def test_the_exit_alert_is_never_repeated(self):
        snap = self.snapshot_with_close(24_900.0)
        alerts, state = gex_exit_monitor.run([self.record()], snap, NOW, {})
        self.assertEqual(len(alerts), 1)
        again, state2 = gex_exit_monitor.run([self.record()], snap, NOW, state)
        self.assertEqual(again, [])

    def test_the_alert_targets_the_gex_channel(self):
        snap = self.snapshot_with_close(24_900.0)
        alert = gex_exit_monitor.check_exit(self.record(), snap, NOW)
        self.assertEqual(alert["channel"], "GEX")
        self.assertEqual(alert["target_chat_id_env"], "GEX_TELEGRAM_CHAT_ID")


if __name__ == "__main__":
    unittest.main()
