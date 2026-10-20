#!/usr/bin/env python3
"""Offline tests for the orchestrator's agent panel (A-E).

No network, no new dependencies - the same convention as the rest of the
skill's tests.  Every case in the spec's acceptance list has a test here:
snapshot age, timestamps, corrupt snapshots, stale context, context conflicts,
the agent failure modes, each agent's vetoes, the two-source / wall-ratio /
PCR rules, the breakout confirmations, the GEX regimes + gates, the consensus
rules and Agent E's sizing rules.
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
from agents import agent_a, agent_b, agent_c, agent_d, agent_e, protocol  # noqa: E402
import gex_engine  # noqa: E402
import gex_snapshot  # noqa: E402
import option_math  # noqa: E402

NOW = F.NOW
NOW_ISO = NOW.isoformat()


def gates_of(result):
    return {v["gate"] for v in result.get("vetoes") or []}


def build_task(snapshot=None, history=None, history_dir=None, **extra):
    task = {"now": NOW_ISO}
    if snapshot is not None:
        task["snapshot"] = snapshot
    if history_dir:
        task["history_dir"] = history_dir
    if history is not None:
        task["history"] = history
    task.update(extra)
    return task


class Harness(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.history = F.make_history()
        self.history_dir = F.write_history(os.path.join(self.dir, "history"), self.history)
        self.snapshot = self.history[-1]

    def write(self, name, obj):
        path = os.path.join(self.dir, name)
        with open(path, "w") as fh:
            json.dump(obj, fh)
        return path


# --------------------------------------------------------------------- agent A
class TestAgentA(unittest.TestCase):
    def test_missing_context_is_reported_not_vetoed(self):
        res = agent_a.run({"now": NOW_ISO, "context_path": "/nonexistent/context.json"})
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["direction"], "NEUTRAL")          # context never votes
        self.assertEqual(res["vetoes"], [])
        self.assertEqual(res["data"]["context_status"], "MISSING")

    def test_corrupt_context_is_reported(self):
        path = os.path.join(tempfile.mkdtemp(), "context.json")
        with open(path, "w") as fh:
            fh.write("{not json")
        res = agent_a.run({"now": NOW_ISO, "context_path": path})
        self.assertEqual(res["data"]["context_status"], "CORRUPT")
        self.assertEqual(res["vetoes"], [])

    def test_stale_context(self):
        path = F.write_context(os.path.join(tempfile.mkdtemp(), "context.json"),
                               generated_at=NOW - F.dt.timedelta(hours=20))
        res = agent_a.run({"now": NOW_ISO, "context_path": path})
        self.assertEqual(res["data"]["context_status"], "STALE")
        self.assertTrue(res["data"]["stale"])

    def test_fresh_context(self):
        path = F.write_context(os.path.join(tempfile.mkdtemp(), "context.json"))
        res = agent_a.run({"now": NOW_ISO, "context_path": path})
        self.assertEqual(res["data"]["context_status"], "OK")
        self.assertEqual(res["data"]["pre_market_bias"], "TWO_WAY")


# --------------------------------------------------------------------- agent B
class TestAgentB(Harness):
    def test_valid_snapshot_passes_and_votes_ce(self):
        res = agent_b.run(build_task(self.snapshot, history_dir=self.history_dir))
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["direction"], "CE")
        self.assertEqual(res["vetoes"], [])

    def test_snapshot_under_15_minutes_is_fresh(self):
        fresh = F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=14))
        res = agent_b.run(build_task(fresh, history_dir=self.history_dir))
        self.assertNotIn("SNAPSHOT_STALE", gates_of(res))

    def test_snapshot_15_minutes_or_older_is_stale(self):
        old = F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=16))
        res = agent_b.run(build_task(old, history_dir=self.history_dir))
        self.assertIn("SNAPSHOT_STALE", gates_of(res))
        self.assertEqual(res["direction"], "NEUTRAL")

    def test_missing_timestamp_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        snap["option_chain"]["records"].pop("timestamp")
        snap.pop("fetched_at_ist")
        snap["meta"] = {}
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("SNAPSHOT_TIMESTAMP_MISSING", gates_of(res))

    def test_invalid_timestamp_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        snap["option_chain"]["records"]["timestamp"] = "not-a-timestamp"
        snap.pop("fetched_at_ist")
        snap["meta"] = {}
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("SNAPSHOT_TIMESTAMP_MISSING", gates_of(res))

    def test_future_timestamp_is_a_veto(self):
        snap = F.make_snapshot(ts=NOW + F.dt.timedelta(minutes=5))
        snap["option_chain"]["records"]["timestamp"] = \
            (NOW + F.dt.timedelta(minutes=5)).strftime("%d-%b-%Y %H:%M:%S")
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("SNAPSHOT_TIMESTAMP_FUTURE", gates_of(res))

    def test_corrupt_snapshot_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        snap["option_chain"]["records"]["data"] = []
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("CHAIN_UNUSABLE", gates_of(res))

    def test_spot_mismatch_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        snap["all_indices"]["data"][0]["last"] = snap["option_chain"]["records"]["underlyingValue"] * 1.02
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("SPOT_MISMATCH", gates_of(res))

    def test_frozen_feed_is_a_veto(self):
        frozen = copy.deepcopy(self.snapshot)
        prev = self.history[-2]
        for row in frozen["option_chain"]["records"]["data"]:
            match = [r for r in prev["option_chain"]["records"]["data"]
                     if r["strikePrice"] == row["strikePrice"]][0]
            row["CE"]["openInterest"] = match["CE"]["openInterest"]
            row["PE"]["openInterest"] = match["PE"]["openInterest"]
        res = agent_b.run(build_task(frozen, history_dir=self.history_dir))
        self.assertIn("FROZEN_FEED", gates_of(res))

    def test_wall_ratio_below_1_5_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        for row in snap["option_chain"]["records"]["data"]:
            if row["strikePrice"] == F.SUPPORT:
                row["PE"]["openInterest"] = 1_200_000      # the next strike has ~1.5M
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("WALL_RATIO", gates_of(res))

    def test_wall_ratio_at_1_5_passes(self):
        snap = copy.deepcopy(self.snapshot)
        rows = {r["strikePrice"]: r for r in snap["option_chain"]["records"]["data"]}
        below = [r for r in rows.values() if r["strikePrice"] < F.SUPPORT]
        second = max(r["PE"]["openInterest"] for r in below)
        rows[F.SUPPORT]["PE"]["openInterest"] = int(second * 1.6)
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertNotIn("WALL_RATIO", gates_of(res))

    def test_level_closed_beyond_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        # a closed 15m bar below the support -> the support is broken
        snap["candles_15m"][-1]["c"] = F.SUPPORT - 100
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("LEVEL_CLOSED_BEYOND", gates_of(res))

    def test_unstable_level_is_a_veto(self):
        # in the oldest comparison snapshot the wall sat two strikes lower
        older = self.history[0]
        for row in older["option_chain"]["records"]["data"]:
            if row["strikePrice"] == F.SUPPORT - 100:
                row["PE"]["openInterest"] = 40_000_000
            elif row["strikePrice"] == F.SUPPORT:
                row["PE"]["openInterest"] = 1_000_000
        F.write_history(self.history_dir, self.history)
        res = agent_b.run(build_task(self.snapshot, history_dir=self.history_dir))
        self.assertIn("LEVEL_UNSTABLE", gates_of(res))

    def test_two_source_needs_two_sources(self):
        snap = copy.deepcopy(self.snapshot)
        # remove every confirming swing: the candles never touch the wall
        for bar in snap["candles_15m"]:
            bar["l"] = bar["c"] = bar["o"] = F.SPOT + 400
        res = agent_b.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("LEVEL_TWO_SOURCE", gates_of(res))

    def test_pcr_needs_three_snapshots(self):
        res = agent_b.run(build_task(self.snapshot, history=self.history[:1]))
        self.assertIn("PCR_HISTORY_INSUFFICIENT", gates_of(res))

    def test_pcr_trend_must_follow_the_direction(self):
        # a PCR that goes down and then up is no trend at all
        scales = [(1.0, 1.0), (0.98, 1.0), (1.0, 1.0)]
        hist = [F.make_snapshot(ts=NOW - F.dt.timedelta(minutes=15 * (3 - i)),
                                put_scale=p, call_scale=c) for i, (p, c) in enumerate(scales)]
        res = agent_b.run(build_task(hist[-1], history=hist))
        self.assertIn("PCR_TREND_NOT_ALIGNED", gates_of(res))
        self.assertEqual(res["direction"], "NEUTRAL")


# --------------------------------------------------------------------- agent C
class TestAgentC(Harness):
    def test_valid_breakout_votes_ce(self):
        res = agent_c.run(build_task(self.snapshot, history_dir=self.history_dir))
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["direction"], "CE")
        self.assertEqual(res["vetoes"], [])
        self.assertEqual(res["data"]["breakout"]["verdict"], "VALID_BREAKOUT")

    def test_intrabar_touch_without_a_close_is_a_fakeout(self):
        snap = copy.deepcopy(self.snapshot)
        bar = snap["candles_15m"][-1]
        bar["h"] = 25_200          # wick through the level
        bar["c"] = 25_000          # but no close beyond it
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("BREAKOUT_MANDATORY_FAILED", gates_of(res))
        self.assertIn("BREAKOUT_FAKEOUT", gates_of(res))

    def test_low_volume_breakout_is_rejected(self):
        snap = copy.deepcopy(self.snapshot)
        for bar in snap["candles_15m"]:
            bar["v"] = 100_000
        snap["candles_15m"][-1]["v"] = 105_000
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("BREAKOUT_MANDATORY_FAILED", gates_of(res))

    def test_oi_not_confirming_the_break_is_rejected(self):
        snap = copy.deepcopy(self.snapshot)
        # the wall's call OI rises instead of falling -> the wall is defended
        for row in snap["option_chain"]["records"]["data"]:
            if row["strikePrice"] == 25_050:
                row["CE"]["openInterest"] = int(row["CE"]["openInterest"] * 3)
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("BREAKOUT_MANDATORY_FAILED", gates_of(res))

    def test_fakeout_red_flag_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        # the wall's call OI is RISING while the price pushes through it:
        # breakout.py raises the "wall_oi_defended" red flag
        for row in snap["option_chain"]["records"]["data"]:
            if row["strikePrice"] == 25_050:
                row["CE"]["openInterest"] = int(row["CE"]["openInterest"] * 3)
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("BREAKOUT_FAKE_OUT_FLAG", gates_of(res))

    def test_opposing_choch_is_a_veto(self):
        # break up, then break down (CHoCH), then break up again (CHoCH):
        # the structure flip-flops -> the opposing CHoCH veto
        closes = [25_050, 25_030, 25_010, 24_990, 24_960, 24_900, 24_930, 24_960,
                  25_092, 25_080, 25_070, 25_120, 25_080, 25_030, 24_880, 24_930,
                  24_980, 25_042, 25_030, 25_020, 25_070]
        snap = copy.deepcopy(self.snapshot)
        snap["candles_15m"] = F.bars(closes, [100_000] * len(closes),
                                     start=NOW - F.dt.timedelta(minutes=15 * len(closes)))
        snap["candles_15m"][-1]["v"] = 180_000
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertIn("STRUCTURE_OPPOSING_CHOCH", gates_of(res))

    def test_sweep_only_is_a_veto(self):
        snap = copy.deepcopy(self.snapshot)
        closes = F.candle_path()
        closes[-1] = 25_000        # no close beyond the level -> only a sweep
        snap["candles_15m"] = F.bars(closes, [100_000] * len(closes),
                                     start=NOW - F.dt.timedelta(minutes=15 * len(closes)))
        res = agent_c.run(build_task(snap, history_dir=self.history_dir))
        self.assertTrue(gates_of(res) & {"STRUCTURE_SWEEP_ONLY", "BREAKOUT_MANDATORY_FAILED"})


# --------------------------------------------------------------------- agent D
def gex_snapshot_with(regime, now=NOW, symbol="NIFTY", oi_scale=1.0):
    """A GEX-format snapshot whose regime is POSITIVE_GEX / NEGATIVE_GEX / TRANSITION."""
    spot = 25000.0
    rows = []
    for strike in range(24000, 26001, 100):
        call_oi = 1_000_000
        put_oi = 1_000_000
        if regime == "POSITIVE_GEX":
            call_oi = 6_000_000 if strike >= spot else 500_000
            put_oi = 400_000
        elif regime == "NEGATIVE_GEX":
            put_oi = 6_000_000 if strike <= spot else 400_000
            call_oi = 500_000
        else:                                   # TRANSITION: the walls straddle spot
            call_oi = 3_000_000 if strike >= spot + 200 else 400_000
            put_oi = 3_000_000 if strike <= spot - 200 else 400_000
        rows.append({"strike": strike, "call_oi": int(call_oi * oi_scale),
                     "put_oi": int(put_oi * oi_scale),
                     "call_iv": 13.0, "put_iv": 13.0, "call_ltp": 100.0, "put_ltp": 100.0,
                     "call_bid": 99.0, "call_ask": 101.0, "put_bid": 99.0, "put_ask": 101.0,
                     "call_volume": 1000, "put_volume": 1000})
    candles = [{"t": (now - F.dt.timedelta(minutes=15 * (30 - i))).isoformat(),
                "o": spot, "h": spot + 10, "l": spot - 10, "c": spot, "v": 100_000}
               for i in range(30)]
    return {"symbol": symbol, "timestamp": now.isoformat(), "spot": spot, "vix": 14.0,
            "lot_size": 65,
            "expiries": [{"date": "2026-10-27", "days_to_expiry": 7.0, "chain": rows}],
            "candles_15m": candles}


class TestAgentD(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def gex_task(self, snap, history=None, **extra):
        hist_dir = os.path.join(self.dir, "gex_history")
        os.makedirs(hist_dir, exist_ok=True)
        for i, h in enumerate(history or []):
            with open(os.path.join(hist_dir, "h%02d.json" % i), "w") as fh:
                json.dump(h, fh)
        task = {"now": NOW_ISO, "gex_snapshot": snap, "gex_history_dir": hist_dir,
                "account_equity": 500_000, "gex_out_path": os.path.join(self.dir, "gex.jsonl")}
        task.update(extra)
        return task

    def test_regime_strategy_mapping(self):
        self.assertEqual(agent_d.REGIME_STRATEGIES["POSITIVE_GEX"], ("GEX-1 PIN_FADE",))
        self.assertEqual(agent_d.REGIME_STRATEGIES["TRANSITION"], ("GEX-2 FLIP_BREAK",))
        self.assertEqual(set(agent_d.REGIME_STRATEGIES["NEGATIVE_GEX"]),
                         {"GEX-3 NEG_TREND", "GEX-4 WALL_BREAK"})

    def test_gex_record_is_schema_valid(self):
        import jsonschema_mini
        schema = json.load(open(os.path.join(SKILL, "references", "gex-output-schema.json")))
        snap = gex_snapshot_with("POSITIVE_GEX")
        hist = [gex_snapshot_with("POSITIVE_GEX", now=NOW - F.dt.timedelta(minutes=15 * i),
                                  oi_scale=1.0 - 0.05 * i) for i in (3, 2, 1)]
        res = agent_d.run(self.gex_task(snap, hist))
        self.assertEqual(jsonschema_mini.validate(res["data"]["gex_record"], schema), [])

    def test_strategy_outside_the_regime_is_a_veto(self):
        original = gex_engine.run
        try:
            def fake(snap, hist, now, out_path, **kw):
                rec = original(snap, hist, now, out_path, **kw)
                rec["action"] = "BUY_CE"
                rec["strategy"] = "GEX-3 NEG_TREND"      # not allowed in POSITIVE_GEX
                rec["trade_id"] = "GEX-NIFTY-20261020-1100-3"
                return rec
            gex_engine.run = fake
            snap = gex_snapshot_with("POSITIVE_GEX")
            res = agent_d.run(self.gex_task(snap, [gex_snapshot_with("POSITIVE_GEX", oi_scale=0.9)]))
            self.assertIn("GEX_STRATEGY_MAPPING", gates_of(res))
        finally:
            gex_engine.run = original

    def test_stale_snapshot_is_a_gate(self):
        snap = gex_snapshot_with("POSITIVE_GEX", now=NOW - F.dt.timedelta(minutes=30))
        res = agent_d.run(self.gex_task(snap, [gex_snapshot_with("POSITIVE_GEX", oi_scale=0.9)]))
        self.assertIn("GEX_SNAPSHOT_STALE", gates_of(res))

    def test_future_snapshot_is_a_gate(self):
        snap = gex_snapshot_with("POSITIVE_GEX", now=NOW + F.dt.timedelta(minutes=5))
        res = agent_d.run(self.gex_task(snap, [gex_snapshot_with("POSITIVE_GEX")]))
        self.assertIn("GEX_SNAPSHOT_FUTURE", gates_of(res))

    def test_history_below_three_snapshots_is_a_gate(self):
        snap = gex_snapshot_with("POSITIVE_GEX")
        res = agent_d.run(self.gex_task(snap, [gex_snapshot_with("POSITIVE_GEX", oi_scale=0.9)]))
        self.assertIn("GEX_HISTORY_INSUFFICIENT", gates_of(res))

    def test_session_gate_before_0930(self):
        now = NOW.replace(hour=9, minute=15)
        snap = gex_snapshot_with("POSITIVE_GEX", now=now)
        hist = [gex_snapshot_with("POSITIVE_GEX", now=now - F.dt.timedelta(minutes=15 * i))
                for i in (3, 2, 1)]
        task = self.gex_task(snap, hist)
        task["now"] = now.isoformat()
        res = agent_d.run(task)
        self.assertIn("GEX_SESSION_NOT_OPEN", gates_of(res))

    def test_session_gate_after_1500(self):
        now = NOW.replace(hour=15, minute=30)
        snap = gex_snapshot_with("POSITIVE_GEX", now=now)
        hist = [gex_snapshot_with("POSITIVE_GEX", now=now - F.dt.timedelta(minutes=15 * i),
                                  oi_scale=1.0 - 0.05 * i) for i in (3, 2, 1)]
        task = self.gex_task(snap, hist)
        task["now"] = now.isoformat()
        res = agent_d.run(task)
        self.assertIn("GEX_SESSION_CLOSED", gates_of(res))

    def test_expiry_gate(self):
        now = NOW.replace(hour=13, minute=0)      # 2.5 h before the 15:30 expiry
        snap = gex_snapshot_with("POSITIVE_GEX", now=now)
        snap["expiries"][0]["date"] = now.date().isoformat()      # expires today
        snap["expiries"][0]["days_to_expiry"] = 0.1
        hist = [gex_snapshot_with("POSITIVE_GEX", now=now - F.dt.timedelta(minutes=15 * i),
                                  oi_scale=1.0 - 0.05 * i) for i in (3, 2, 1)]
        task = self.gex_task(snap, hist)
        task["now"] = now.isoformat()
        res = agent_d.run(task)
        self.assertIn("GEX_EXPIRY_TOO_CLOSE", gates_of(res))

    def test_cooldown_gate(self):
        out = os.path.join(self.dir, "gex.jsonl")
        with open(out, "w") as fh:
            fh.write(json.dumps({"engine": "GEX", "symbol": "NIFTY", "action": "BUY_CE",
                                 "timestamp": (NOW - F.dt.timedelta(minutes=5)).isoformat()}) + "\n")
        snap = gex_snapshot_with("POSITIVE_GEX")
        hist = [gex_snapshot_with("POSITIVE_GEX", now=NOW - F.dt.timedelta(minutes=15 * i),
                                  oi_scale=1.0 - 0.05 * i) for i in (3, 2, 1)]
        task = self.gex_task(snap, hist)
        task["gex_out_path"] = out
        res = agent_d.run(task)
        self.assertIn("GEX_COOLDOWN", gates_of(res))

    def test_frozen_feed_gate(self):
        snap = gex_snapshot_with("POSITIVE_GEX")
        hist = [copy.deepcopy(snap) for _ in range(3)]
        for h in hist:
            h["timestamp"] = (NOW - F.dt.timedelta(minutes=15)).isoformat()
        res = agent_d.run(self.gex_task(snap, hist))
        self.assertIn("GEX_FROZEN_FEED", gates_of(res))

    def test_gex_votes_neutral_without_a_setup(self):
        snap = gex_snapshot_with("POSITIVE_GEX")
        hist = [gex_snapshot_with("POSITIVE_GEX", now=NOW - F.dt.timedelta(minutes=15 * i),
                                  oi_scale=1.0 - 0.05 * i) for i in (3, 2, 1)]
        res = agent_d.run(self.gex_task(snap, hist))
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["direction"], "NEUTRAL")
        self.assertEqual(res["vetoes"], [])


# --------------------------------------------------------------------- agent E
class TestAgentE(Harness):
    def gex_snapshot(self):
        snap, _ = gex_snapshot.convert(self.snapshot, now=NOW, symbol="NIFTY")
        return snap

    def task(self, **extra):
        task = {"now": NOW_ISO, "gex_snapshot": self.gex_snapshot(), "direction": "CE",
                "valid_level": F.SUPPORT,
                "underlying_invalidation": F.SUPPORT * (1 - 0.001),
                "blocking_level": F.RESISTANCE,
                "account_equity": 500_000,
                "account_equity_source": "test fixture",
                "risk_pct": 1.0}
        task.update(extra)
        return task

    def test_valid_plan(self):
        res = agent_e.run(self.task())
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["vetoes"], [])
        self.assertEqual(res["trade"]["option_type"], "CE")
        self.assertEqual(res["trade"]["lot_size"], 65)
        self.assertGreaterEqual(res["trade"]["risk_reward_tp1"], 2.0)

    def test_delta_below_the_floor_is_never_selected(self):
        snap = self.gex_snapshot()
        for row in snap["expiries"][0]["chain"]:
            row["call_iv"] = 60.0            # a huge IV pushes the delta down
        res = agent_e.run(self.task(gex_snapshot=snap))
        if res.get("trade"):
            self.assertGreaterEqual(res["trade"]["delta"], option_math.CFG["delta_min"])
        else:
            self.assertTrue(gates_of(res))

    def test_delta_floor_is_enforced_by_the_strike_selection(self):
        rows = [{"strike": 25_000.0, "call_oi": 5_000_000, "put_oi": 1_000_000,
                 "call_iv": 13.0, "put_iv": 13.0, "call_ltp": 180.0, "put_ltp": 170.0,
                 "call_bid": 179.0, "call_ask": 181.0, "put_bid": 169.0, "put_ask": 171.0,
                 "call_volume": 5000, "put_volume": 5000}]
        best, rejected = option_math.pick_strike(rows, "call", 25_060.0, 7 / 365.0, 14.0)
        self.assertIsNotNone(best)
        self.assertGreaterEqual(best["delta"], option_math.CFG["delta_min"])

    def test_spread_above_2_percent_is_rejected(self):
        snap = self.gex_snapshot()
        for row in snap["expiries"][0]["chain"]:
            row["call_bid"] = 100.0
            row["call_ask"] = 110.0          # 9.5% spread
        res = agent_e.run(self.task(gex_snapshot=snap))
        self.assertIn("NO_LIQUID_STRIKE", gates_of(res))

    def test_spread_of_2_percent_is_accepted(self):
        snap = self.gex_snapshot()
        for row in snap["expiries"][0]["chain"]:
            mid = (row["call_bid"] + row["call_ask"]) / 2.0
            row["call_bid"] = mid * 0.99
            row["call_ask"] = mid * 1.0099   # 1.99% spread
        res = agent_e.run(self.task(gex_snapshot=snap))
        self.assertNotIn("NO_LIQUID_STRIKE", gates_of(res))

    def test_spread_above_2_percent_is_rejected(self):
        snap = self.gex_snapshot()
        for row in snap["expiries"][0]["chain"]:
            mid = (row["call_bid"] + row["call_ask"]) / 2.0
            row["call_bid"] = mid * 0.99
            row["call_ask"] = mid * 1.011    # 2.1% spread
        res = agent_e.run(self.task(gex_snapshot=snap))
        self.assertIn("NO_LIQUID_STRIKE", gates_of(res))

    def test_premium_stop_is_between_25_and_30_percent(self):
        res = agent_e.run(self.task())
        stop_pct = (res["trade"]["entry_zone"][0] - res["trade"]["stop_loss_premium"]) / \
            res["trade"]["entry_zone"][0] * 100
        self.assertGreaterEqual(stop_pct, 24.0)
        self.assertLessEqual(stop_pct, 30.5)

    def test_rr_tp1_is_at_least_two(self):
        res = agent_e.run(self.task())
        self.assertGreaterEqual(res["trade"]["risk_reward_tp1"], 2.0)

    def test_tp2_outside_the_expected_move_is_rejected(self):
        snap = self.gex_snapshot()
        # a small ATM straddle -> a small expected move; the 3R target then
        # lands outside it while the premium stop still fits 25-30%
        for row in snap["expiries"][0]["chain"]:
            if row["strike"] == 25_050.0:
                row["put_ltp"] = 100.0
                row["put_bid"] = 99.0
                row["put_ask"] = 101.0
        res = agent_e.run(self.task(gex_snapshot=snap, underlying_invalidation=24_960.0))
        self.assertIn("TP2_OUTSIDE_1SIGMA", gates_of(res))

    def test_less_than_three_hours_to_expiry_is_a_veto(self):
        snap = self.gex_snapshot()
        snap["expiries"][0]["date"] = "2026-10-20"        # expires today at 15:30
        now = F.NOW.replace(hour=13, minute=0)            # 2.5 h before the expiry
        res = agent_e.run(self.task(gex_snapshot=snap, now=now.isoformat()))
        self.assertIn("EXPIRY_TOO_CLOSE", gates_of(res))

    def test_theta_above_ten_percent_is_a_veto(self):
        snap = self.gex_snapshot()
        snap["expiries"][0]["days_to_expiry"] = 0.5
        for row in snap["expiries"][0]["chain"]:
            row["call_iv"] = row["put_iv"] = 30.0
        res = agent_e.run(self.task(gex_snapshot=snap))
        self.assertTrue(gates_of(res) & {"THETA_TOO_HIGH", "EXPIRY_TOO_CLOSE"})

    def test_zero_lots_is_a_veto(self):
        res = agent_e.run(self.task(account_equity=1_000))
        self.assertIn("ZERO_LOTS", gates_of(res))

    def test_no_account_equity_is_a_veto(self):
        res = agent_e.run(self.task(account_equity=None, account_equity_source=None))
        self.assertIn("ACCOUNT_EQUITY_UNAVAILABLE", gates_of(res))

    def test_lots_are_never_rounded_up(self):
        res = agent_e.run(self.task())
        risk = res["trade"]["risk_inr"]
        equity = 500_000
        self.assertLessEqual(risk, equity * 0.01 + 1e-6)

    def test_size_position_halves_above_vix_20(self):
        full = option_math.size_position(50.0, 65, 210.0, 1_000_000, 1.0, vix=14.0)
        high = option_math.size_position(50.0, 65, 210.0, 1_000_000, 1.0, vix=25.0)
        self.assertFalse(full["halved"])
        self.assertTrue(high["halved"])
        self.assertEqual(high["lots"], full["lots"] // 2)

    def test_vix_above_20_halves_the_size(self):
        snap = self.gex_snapshot()
        # one eligible strike only, so the VIX cannot change the selection
        for row in snap["expiries"][0]["chain"]:
            if row["strike"] not in (25_000.0, 25_300.0):
                row["call_oi"] = 1
        full = agent_e.run(self.task(gex_snapshot=snap, account_equity=2_000_000))
        self.assertIsNotNone(full["trade"])
        snap["vix"] = 25.0
        halved = agent_e.run(self.task(gex_snapshot=snap, account_equity=2_000_000))
        self.assertIsNotNone(halved["trade"])
        self.assertEqual(halved["trade"]["suggested_lots"], full["trade"]["suggested_lots"] // 2)
        self.assertEqual(halved["trade"]["size_note"], "halved (VIX > 20)")

    def test_delta_outside_the_preferred_band_is_a_note_not_a_veto(self):
        # a delta of 0.45 is acceptable (>= 0.35) but outside 0.50-0.60
        snap = self.gex_snapshot()
        for row in snap["expiries"][0]["chain"]:
            row["call_iv"] = 22.0        # a higher IV -> a lower delta
        res = agent_e.run(self.task(gex_snapshot=snap))
        if res.get("trade"):
            self.assertGreaterEqual(res["trade"]["delta"], 0.35)
            self.assertTrue(any("preferred" in n for n in res["notes"]) or
                            res["trade"]["delta"] >= 0.50)
        else:
            self.assertTrue(gates_of(res))

    def test_lot_size_comes_from_the_contract_master(self):
        res = agent_e.run(self.task())
        self.assertIn("symbol-config", res["trade"]["lot_size_source"])

    def test_stock_never_inherits_the_nifty_lot(self):
        import contract_master
        self.assertNotEqual(contract_master.lot_size("RELIANCE"), contract_master.lot_size("NIFTY"))
        self.assertEqual(contract_master.lot_size("NOSUCHSYMBOL"), 0)

    def test_invalidation_must_be_beyond_the_level(self):
        res = agent_e.run(self.task(underlying_invalidation=F.SUPPORT * 1.0001))
        self.assertIn("INVALIDATION_GEOMETRY", gates_of(res))


# ----------------------------------------------------------------- delegation
class TestDelegation(unittest.TestCase):
    """The parent's fail-closed handling of a broken agent."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def agent_script(self, body):
        path = os.path.join(self.dir, "agent_b.py")
        with open(path, "w") as fh:
            fh.write(body)
        return path

    def test_invalid_json_is_a_veto(self):
        import orchestrator
        broken = os.path.join(self.dir, "agent_b.py")
        with open(broken, "w") as fh:
            fh.write("import sys\nsys.stdout.write('not json')\n")
        original = orchestrator.os.path.join
        orchestrator.os.path.join = lambda *a: broken if a[-1] == "agent_b.py" else original(*a)
        try:
            res = orchestrator.run_agent("B", {}, timeout=5)
        finally:
            orchestrator.os.path.join = original
        self.assertEqual(res["status"], "failed")
        self.assertIn("AGENT_INVALID_JSON", gates_of(res))

    def test_missing_field_is_a_veto(self):
        res = protocol.failed("B", "result is missing 'direction'")
        self.assertEqual(res["status"], "failed")
        self.assertTrue(res["vetoes"])

    def test_agent_timeout_is_a_veto(self):
        import orchestrator
        slow = os.path.join(self.dir, "agent_b.py")
        with open(slow, "w") as fh:
            fh.write("import time\ntime.sleep(30)\n")
        original = orchestrator.os.path.join
        orchestrator.os.path.join = lambda *a: slow if a[-1] == "agent_b.py" else original(*a)
        try:
            res = orchestrator.run_agent("B", {}, timeout=1)
        finally:
            orchestrator.os.path.join = original
        self.assertEqual(res["status"], "failed")
        self.assertIn("AGENT_TIMEOUT", gates_of(res))

    def test_agent_exception_is_a_veto(self):
        import orchestrator
        broken = os.path.join(self.dir, "agent_b.py")
        with open(broken, "w") as fh:
            fh.write("raise RuntimeError('boom')\n")
        original = orchestrator.os.path.join
        orchestrator.os.path.join = lambda *a: broken if a[-1] == "agent_b.py" else original(*a)
        try:
            res = orchestrator.run_agent("B", {}, timeout=5)
        finally:
            orchestrator.os.path.join = original
        self.assertEqual(res["status"], "failed")
        self.assertIn("AGENT_FAILED", gates_of(res))

    def test_agent_non_zero_exit_is_a_veto(self):
        import orchestrator
        broken = os.path.join(self.dir, "agent_b.py")
        with open(broken, "w") as fh:
            fh.write("import sys\nsys.exit(3)\n")
        original = orchestrator.os.path.join
        orchestrator.os.path.join = lambda *a: broken if a[-1] == "agent_b.py" else original(*a)
        try:
            res = orchestrator.run_agent("B", {}, timeout=5)
        finally:
            orchestrator.os.path.join = original
        self.assertEqual(res["status"], "failed")
        self.assertIn("AGENT_FAILED", gates_of(res))


if __name__ == "__main__":
    unittest.main()
