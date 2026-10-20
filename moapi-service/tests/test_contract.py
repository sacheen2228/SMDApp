"""The HTTP contract — the exact response shapes the app codes against.

Offline: a stub service stands in for the real one, so no MO call is made.
The real HTTP server (stdlib `http.server`) is started on an ephemeral port.
"""

import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

from _support import SERVICE_DIR  # noqa: F401  (sets sys.path)

from moapi import contract
from moapi.client import MoError, NO_DATA, SESSION_EXPIRED, SOURCE_UNAVAILABLE
from moapi.http_api import MoapiServer


class FakeConfig(object):
    def __init__(self, dry_run=False):
        self.dry_run = dry_run


class FakeClient(object):
    def __init__(self, verified=True, error=None):
        self._verified = verified
        self._error = error

    def auth_state(self):
        return {"state": "authenticated" if self._verified else "unauthenticated",
                "verified": self._verified}

    @property
    def last_error(self):
        return self._error


class FakeService(object):
    """A stand-in for `MoapiService` — same methods, no network."""

    def __init__(self, dry_run=False, verified=True, error=None, fails=None):
        self.config = FakeConfig(dry_run=dry_run)
        self.client = FakeClient(verified=verified, error=error)
        self.fails = fails or {}

    def health(self):
        payload = {
            "ok": True,
            "authed": self.client.auth_state()["verified"],
            "source": "motilal",
            "ts": contract.iso_now(),
        }
        if self.config.dry_run:
            payload["ok"] = False
            payload["error"] = "dry-run: authentication is disabled"
        elif not payload["authed"]:
            payload["error"] = self.client.last_error or "not authenticated"
        return payload

    def _maybe_fail(self, name):
        if name in self.fails:
            raise self.fails[name]

    def instrument(self, force=False):
        self._maybe_fail("instrument")
        return {"contracts": [
            {
                "tradingsymbol": "NIFTY26OCT202622000CE",
                "exchange": "NSEFO",
                "expiry": "2026-10-27",
                "lotSize": 65,
                "instrumentType": "OPTIDX",
                "symbol": "NIFTY",
                "strike": 22000.0,
                "optionType": "CE",
                # extra keys must be dropped by the contract
                "scripcode": 51308,
                "tickSize": 0.05,
            },
        ]}

    def instrument_response_bytes(self, force=False):
        self._maybe_fail("instrument")
        payload = contract.instrument_array_bytes(self.instrument(force=force)["contracts"])
        return contract.instrument_envelope_bytes(payload)

    def ltp(self, **query):
        self._maybe_fail("ltp")
        return {"tradingsymbol": query.get("tradingsymbol"), "ltp": 898.9,
                "source": "moapi-rest"}

    def open_interest(self, **query):
        self._maybe_fail("oi")
        return {"tradingsymbol": query.get("tradingsymbol"), "oi": 154320,
                "oiChange": 580, "source": "websocket"}

    def depth(self, **query):
        self._maybe_fail("depth")
        return {"tradingsymbol": query.get("tradingsymbol"),
                "bids": [[898.85, 250], [898.8, 120]],
                "asks": [[899.1, 180], [899.15, 90]]}


class ContractTestCase(unittest.TestCase):
    """Starts the real HTTP server on an ephemeral port."""

    def setUp(self):
        self.service = FakeService()
        self.server = MoapiServer(("127.0.0.1", 0), self.service, None)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def get(self, path):
        """Return (status, payload)."""
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        try:
            with urlopen(url, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))


class TestHealth(ContractTestCase):
    def test_health_shape(self):
        status, payload = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"ok", "authed", "source", "ts"})
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["authed"])
        self.assertEqual(payload["source"], "motilal")
        self.assertRegex(payload["ts"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_health_when_unauthenticated(self):
        self.service.client = FakeClient(verified=False, error="MO login failed: bad TOTP")
        status, payload = self.get("/health")
        self.assertEqual(status, 200)
        self.assertFalse(payload["authed"])
        self.assertIn("MO login failed", payload["error"])


class TestInstrument(ContractTestCase):
    def test_instrument_shape(self):
        status, payload = self.get("/instrument")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"ok", "ts", "instruments"})
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["instruments"]), 1)
        entry = payload["instruments"][0]
        self.assertEqual(
            set(entry),
            {"tradingsymbol", "exchange", "expiry", "lotSize", "instrumentType",
             "symbol", "strike", "optionType"},
        )
        self.assertEqual(entry["lotSize"], 65)
        self.assertEqual(entry["tradingsymbol"], "NIFTY26OCT202622000CE")

    def test_instrument_bytes_match_the_dict_form(self):
        from_bytes = json.loads(self.service.instrument_response_bytes().decode("utf-8"))
        from_dict = contract.instrument(self.service)
        self.assertEqual(set(from_bytes), set(from_dict))
        self.assertEqual(from_bytes["instruments"], from_dict["instruments"])


class TestLtp(ContractTestCase):
    def test_ltp_shape(self):
        status, payload = self.get("/ltp?tradingsymbol=NIFTY26OCT202622000CE")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"ok", "ts", "tradingsymbol", "ltp", "source"})
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["tradingsymbol"], "NIFTY26OCT202622000CE")
        self.assertEqual(payload["ltp"], 898.9)
        self.assertEqual(payload["source"], "motilal")

    def test_ltp_requires_a_symbol(self):
        status, payload = self.get("/ltp")
        self.assertEqual(status, 404)
        self.assertFalse(payload["ok"])
        self.assertIn("tradingsymbol", payload["error"])


class TestOi(ContractTestCase):
    def test_oi_shape(self):
        status, payload = self.get("/oi?tradingsymbol=NIFTY26OCT202622000CE")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"ok", "ts", "tradingsymbol", "oi", "oiChange", "source"})
        self.assertEqual(payload["oi"], 154320)
        self.assertEqual(payload["oiChange"], 580)
        self.assertIn(payload["source"], ("motilal", "websocket"))


class TestDepth(ContractTestCase):
    def test_depth_shape(self):
        status, payload = self.get("/depth?tradingsymbol=NIFTY26OCT202622000CE")
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"ok", "ts", "tradingsymbol", "bids", "asks"})
        self.assertEqual(payload["bids"][0], [898.85, 250])
        self.assertEqual(payload["asks"][0], [899.1, 180])
        for level in payload["bids"] + payload["asks"]:
            self.assertEqual(len(level), 2)
            self.assertIsInstance(level[0], (int, float))
            self.assertIsInstance(level[1], (int, float))


class TestErrorShape(ContractTestCase):
    def test_unreachable_mo_is_503_with_the_error_shape(self):
        self.service.fails["ltp"] = MoError(SOURCE_UNAVAILABLE, "MO is unreachable")
        status, payload = self.get("/ltp?tradingsymbol=NIFTY26OCT202622000CE")
        self.assertEqual(status, 503)
        self.assertFalse(payload["ok"])
        self.assertIn("error", payload)
        self.assertIn("MO is unreachable", payload["error"])

    def test_expired_session_is_503(self):
        self.service.fails["oi"] = MoError(SESSION_EXPIRED, "MO session expired")
        status, payload = self.get("/oi?tradingsymbol=NIFTY26OCT202622000CE")
        self.assertEqual(status, 503)
        self.assertFalse(payload["ok"])

    def test_unknown_contract_is_404(self):
        self.service.fails["ltp"] = MoError(NO_DATA, "tradingsymbol X not in the MO instrument master")
        status, payload = self.get("/ltp?tradingsymbol=X")
        self.assertEqual(status, 404)
        self.assertFalse(payload["ok"])
        self.assertIn("error", payload)

    def test_unknown_route_is_404_with_the_same_shape(self):
        status, payload = self.get("/orders")
        self.assertEqual(status, 404)
        self.assertFalse(payload["ok"])
        self.assertIn("error", payload)

    def test_every_error_carries_ok_false_and_a_reason(self):
        for path, status_code in (("/ltp?tradingsymbol=X", 503),
                                  ("/oi?tradingsymbol=X", 503),
                                  ("/depth?tradingsymbol=X", 503)):
            self.service.fails[path.split("?")[0][1:]] = MoError(
                SOURCE_UNAVAILABLE, "MO is unreachable")
            status, payload = self.get(path)
            self.assertEqual(status, status_code)
            self.assertFalse(payload["ok"])
            self.assertIsInstance(payload["error"], str)
            self.assertTrue(payload["error"])


class TestDryRun(ContractTestCase):
    def setUp(self):
        self.service = FakeService(dry_run=True)
        self.server = MoapiServer(("127.0.0.1", 0), self.service, None)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def test_dry_run_health_reports_dry_run(self):
        status, payload = self.get("/health")
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["authed"])
        self.assertIn("dry-run", payload["error"])

    def test_dry_run_data_endpoints_are_503_with_dry_run(self):
        for path in ("/ltp?tradingsymbol=X", "/oi?tradingsymbol=X",
                     "/depth?tradingsymbol=X", "/instrument"):
            status, payload = self.get(path)
            self.assertEqual(status, 503, path)
            self.assertFalse(payload["ok"])
            self.assertIn("dry-run", payload["error"])


if __name__ == "__main__":
    unittest.main()
