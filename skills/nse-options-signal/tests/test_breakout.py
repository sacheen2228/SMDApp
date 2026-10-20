#!/usr/bin/env python3
"""Offline tests for the breakout / fakeout validator (step 5).

No network, no new dependencies — same convention as the rest of the skill's tests.
"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SKILL, "scripts"))

import breakout  # noqa: E402

THRESHOLDS = json.load(open(os.path.join(SKILL, "references", "breakout-thresholds.json")))


def bar(t, o, h, l, c, v=1000):
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}


def chain(spot=1000, rows=None, iv=14.0):
    rows = rows or []
    return {"option_chain": {"records": {"underlyingValue": spot, "expiryDates": ["2026-10-29"],
                                         "data": rows}}}


def row(strike, ce_oi=0, pe_oi=0, ce_ltp=0, pe_ltp=0, ce_chg=None, pe_chg=None, iv=14.0):
    r = {"strikePrice": strike, "expiryDate": "2026-10-29"}
    r["CE"] = {"openInterest": ce_oi, "lastPrice": ce_ltp, "impliedVolatility": iv}
    r["PE"] = {"openInterest": pe_oi, "lastPrice": pe_ltp, "impliedVolatility": iv}
    if ce_chg is not None:
        r["CE"]["changeinOpenInterest"] = ce_chg
    if pe_chg is not None:
        r["PE"]["changeinOpenInterest"] = pe_chg
    return r


def bars_15m(closes, vols=None, t0=1_700_000_000_000, step=900_000):
    vols = vols or []
    res = []
    for i, c in enumerate(closes):
        o = c - 2
        res.append(bar(t0 + i * step, o, c + 3, o - 3, c, vols[i] if i < len(vols) else 0))
    return res


def snapshot(spot=1000, rows=None, bars=None, fut=None, hm=None, symbol="NIFTY"):
    snap = {
        "symbol": symbol,
        "option_chain": chain(spot, rows)["option_chain"],
        "candles_15m": bars or [],
        "candles_5m": [],
    }
    if fut is not None:
        snap["futures"] = fut
    if hm is not None:
        snap["groups"] = {"heatmap": {"stocks": hm}}
    return snap


class TestCloseConfirmation(unittest.TestCase):
    def test_close_beyond_level_passes_with_enough_distance(self):
        bars = bars_15m([100, 101, 1002.0])  # 0.2% above the 1000 level
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        cc = out["mandatory"]["close_confirm"]
        self.assertTrue(cc["pass"], cc)
        self.assertIn("close 1002.00", cc["value"])

    def test_wick_only_is_not_a_break(self):
        bars = [bar(1, 999, 1001, 998, 999.5)]  # wicked above, closed below
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        self.assertFalse(out["mandatory"]["close_confirm"]["pass"])

    def test_missing_candles_report_unknown_not_pass(self):
        # a breakout strategy must be validated even when the candles are missing
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], [])
        out = breakout.validate(snap, 1000, "up", THRESHOLDS, strategy="S2")
        self.assertEqual(out["mandatory"]["close_confirm"]["value"], "UNKNOWN")
        self.assertEqual(out["verdict"], "FAKEOUT")


class TestVolume(unittest.TestCase):
    def test_low_volume_breakout_fails(self):
        bars = bars_15m([100, 101, 1002.0], vols=[5000] * 2 + [1000])
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        self.assertFalse(out["mandatory"]["volume"]["pass"])

    def test_high_volume_breakout_passes(self):
        vols = [1000] * 21 + [9000]
        bars = bars_15m([100] * 21 + [1002.0], vols=vols)
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        self.assertTrue(out["mandatory"]["volume"]["pass"], out["mandatory"]["volume"])

    def test_futures_volume_is_the_index_proxy(self):
        bars = bars_15m([100, 101, 1002.0])
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars,
                        fut={"volume": 50000, "oi": 1000})
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        self.assertIn("futures volume", out["mandatory"]["volume"]["value"])


class TestOiConfirmation(unittest.TestCase):
    def _snapshot_pair(self, prev_rows, now_rows, fut_prev, fut_now, bars):
        import tempfile
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "a.json"), "w") as fh:
            json.dump(snapshot(1000, prev_rows, bars, fut_prev), fh)
        with open(os.path.join(d, "b.json"), "w") as fh:
            json.dump(snapshot(1000, now_rows, bars, fut_now), fh)
        return d

    def test_rising_wall_oi_is_a_fakeout_flag(self):
        bars = bars_15m([100, 101, 1002.0])
        prev_rows = [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100),
                     row(900, ce_oi=100, pe_oi=800, ce_ltp=20, pe_ltp=40)]
        now_rows = [row(1000, ce_oi=1500, pe_oi=2000, ce_ltp=102, pe_ltp=100),
                    row(900, ce_oi=100, pe_oi=1400, ce_ltp=20, pe_ltp=45)]
        d = self._snapshot_pair(prev_rows, now_rows, {"oi": 1000, "volume": 100}, {"oi": 1200, "volume": 9000}, bars)
        out = breakout.validate(snapshot(1000, now_rows, bars, {"oi": 1200, "volume": 9000}),
                                1000, "up", THRESHOLDS, history_dir=d)
        self.assertFalse(out["mandatory"]["oi_confirm"]["pass"])
        self.assertTrue(any("wall_oi_defended" in f for f in out["fakeout_flags"]))
        self.assertEqual(out["verdict"], "FAKEOUT")

    def test_falling_wall_oi_with_rising_futures_oi_confirms(self):
        bars = bars_15m([100, 101, 1002.0])
        prev_rows = [row(1000, ce_oi=1500, pe_oi=1000, ce_ltp=100, pe_ltp=100),
                     row(900, ce_oi=100, pe_oi=800, ce_ltp=20, pe_ltp=40)]
        now_rows = [row(1000, ce_oi=1000, pe_oi=1400, ce_ltp=104, pe_ltp=100),
                    row(900, ce_oi=100, pe_oi=1400, ce_ltp=20, pe_ltp=45)]
        d = self._snapshot_pair(prev_rows, now_rows, {"oi": 1000, "volume": 100}, {"oi": 1400, "volume": 9000}, bars)
        out = breakout.validate(snapshot(1000, now_rows, bars, {"oi": 1400, "volume": 9000}),
                                1000, "up", THRESHOLDS, history_dir=d)
        self.assertTrue(out["mandatory"]["oi_confirm"]["pass"], out["mandatory"]["oi_confirm"])


class TestThresholdsAndFlags(unittest.TestCase):
    def test_thresholds_file_has_the_documented_values(self):
        self.assertEqual(THRESHOLDS["volume_mult"], 1.5)
        self.assertEqual(THRESHOLDS["close_confirm_pct"], 0.1)
        self.assertEqual(THRESHOLDS["body_pct_min"], 0.6)
        self.assertEqual(THRESHOLDS["exhaustion_atr_mult"], 2.0)
        self.assertEqual(THRESHOLDS["min_total_passes"], 5)
        self.assertIn("HDFCBANK", THRESHOLDS["heavyweights"]["NIFTY"])
        self.assertIn("SBIN", THRESHOLDS["heavyweights"]["BANKNIFTY"])

    def test_not_applicable_when_price_is_not_breaking(self):
        bars = bars_15m([1000, 1001, 1002])
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1100, "up", THRESHOLDS)   # level is ABOVE price → no break
        self.assertFalse(out["applicable"])
        self.assertEqual(out["verdict"], "NOT_APPLICABLE")

    def test_break_before_session_open_is_flagged(self):
        bars = bars_15m([100, 101, 1002.0])
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS, now_str="2026-10-20 09:20:00")
        self.assertTrue(any("before 09:30" in f for f in out["fakeout_flags"]))

    def test_breadth_uses_the_heatmap_heavyweights(self):
        bars = bars_15m([100, 101, 1002.0])
        hm = [{"symbol": "HDFCBANK", "pct": 1.2}, {"symbol": "ICICIBANK", "pct": 0.8},
              {"symbol": "RELIANCE", "pct": 0.4}, {"symbol": "TCS", "pct": -0.5}]
        snap = snapshot(1000, [row(1000, ce_oi=1000, pe_oi=1000, ce_ltp=100, pe_ltp=100)], bars, hm=hm)
        out = breakout.validate(snap, 1000, "up", THRESHOLDS)
        self.assertIn("heavyweights 3/3", out["supporting"]["htf_breadth"]["value"])


if __name__ == "__main__":
    unittest.main()
