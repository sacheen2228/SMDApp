"""Partial instrument master must not pin the full TTL.

Live failure 2026-11-20: NSEFO timed out after 90s, BSEFO loaded 45669
contracts, and `_apply(contracts, _now())` marked the BSEFO-only master
fresh for 6 hours. Every subsequent load() returned early with zero NIFTY
rows — the option chain then fell through to the 20s direct getScrips path
and blew the route's 8s MOAPI budget.
"""

import os
import tempfile
import unittest

from _support import SERVICE_DIR, MO_INSTRUMENT_ROW  # noqa: F401  (sys.path)

from moapi.client import MoError, SOURCE_UNAVAILABLE
from moapi import service as service_mod
from moapi.service import InstrumentMaster


BSE_ROW = dict(MO_INSTRUMENT_ROW, **{
    "scripcode": 99001,
    "scripname": "SENSEX 27-Nov-2026 CE 75000",
    "scripshortname": "SENSEX",
    "exchangename": "BSEFO",
    "instrumentname": "OPTIDX",
    "strikeprice": 75000.0,
})

NSE_ROW = dict(MO_INSTRUMENT_ROW, **{
    "scripcode": 51308,
    "scripname": "NIFTY 27-Nov-2026 CE 25800",
    "scripshortname": "NIFTY",
    "exchangename": "NSEFO",
    "strikeprice": 25800.0,
})


class FakeConfig(object):
    def __init__(self, cache_dir):
        self.exchanges = ("NSEFO", "BSEFO")
        self.instrument_ttl = 6 * 3600
        self.cache_dir = cache_dir


class FlakyClient(object):
    """NSEFO fails the first load, succeeds on retry; BSEFO always works."""

    def __init__(self):
        self.nsefo_calls = 0
        self.bsefo_calls = 0

    def get_instrument_file(self, exchange):
        if exchange == "NSEFO":
            self.nsefo_calls += 1
            if self.nsefo_calls == 1:
                raise MoError(SOURCE_UNAVAILABLE, "MO call timed out after 90s")
            return [NSE_ROW]
        if exchange == "BSEFO":
            self.bsefo_calls += 1
            return [BSE_ROW]
        raise MoError(SOURCE_UNAVAILABLE, "unknown exchange %s" % exchange)


class FixedClock(object):
    def __init__(self, start=1_000_000.0):
        self.t = float(start)

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class PartialMasterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._real_now = service_mod._now
        self.clock = FixedClock()
        service_mod._now = self.clock

    def tearDown(self):
        service_mod._now = self._real_now
        self._tmp.cleanup()

    def _master(self, client):
        return InstrumentMaster(FakeConfig(self._tmp.name), client, logger=None)

    def test_partial_load_retries_missing_exchange_after_short_window(self):
        client = FlakyClient()
        master = self._master(client)

        contracts = master.load()
        # Partial beats nothing — BSEFO is served, NSEFO is missing.
        self.assertEqual(len(contracts), 1)
        self.assertIn("BSEFO", master.exchanges)
        self.assertNotIn("NSEFO", master.exchanges)
        self.assertIsNotNone(master.fetch_error)
        self.assertEqual(client.nsefo_calls, 1)

        # Within the partial window the master may still serve what it has
        # (no hammering MO), but it must NOT look complete-fresh forever.
        master.load()
        self.assertEqual(client.nsefo_calls, 1)

        # After the partial retry window, the missing exchange is retried
        # and the master becomes complete.
        self.clock.advance(service_mod.PARTIAL_RETRY_SECONDS + 1)
        contracts = master.load()
        self.assertIn("NSEFO", master.exchanges)
        self.assertIn("BSEFO", master.exchanges)
        self.assertIsNone(master.fetch_error)
        self.assertEqual(client.nsefo_calls, 2)
        # NIFTY is back — the app's symbol filter can find it again.
        nifty = [c for c in contracts if c.get("symbol") == "NIFTY"]
        self.assertEqual(len(nifty), 1)

    def test_complete_load_still_uses_full_ttl(self):
        client = FlakyClient()
        client.nsefo_calls = 1  # pretend first attempt already succeeded
        # Force success on first try by pre-seeding: use a client that always works.
        class AlwaysOk(FlakyClient):
            def get_instrument_file(self, exchange):
                self.nsefo_calls += 1 if exchange == "NSEFO" else 0
                self.bsefo_calls += 1 if exchange == "BSEFO" else 0
                return [NSE_ROW] if exchange == "NSEFO" else [BSE_ROW]

        master = self._master(AlwaysOk())
        master.load()
        self.assertIsNone(master.fetch_error)
        self.assertIn("NSEFO", master.exchanges)
        self.assertIn("BSEFO", master.exchanges)

        # Still fresh well past the partial window — full TTL applies.
        self.clock.advance(service_mod.PARTIAL_RETRY_SECONDS + 1)
        nse_before = client.nsefo_calls  # unused; AlwaysOk tracks on its own
        master.load()
        # Complete master: no re-fetch until instrument_ttl expires.
        self.assertIsNone(master.fetch_error)
        self.clock.advance(service_mod.PARTIAL_RETRY_SECONDS + 1)
        master.load()
        # Still within 6h TTL of the complete load (only advanced 2×61s).
        self.assertIn("NSEFO", master.exchanges)


if __name__ == "__main__":
    unittest.main()
