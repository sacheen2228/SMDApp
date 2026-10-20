"""The service is READ-ONLY — it must never expose or call an order method.

The vendored SDK ships PlaceOrder / ModifyOrder / CancelOrder /
PositionConversion. This service must not route them and must not call them.
"""

import os
import re
import unittest

from _support import SERVICE_DIR

# The SDK's trading methods — none of them may be called or routed.
ORDER_METHODS = (
    "PlaceOrder",
    "ModifyOrder",
    "CancelOrder",
    "PositionConversion",
    "OrderSubscribe",
    "OrderUnsubscribe",
)

# The routes the service is allowed to expose.
ALLOWED_ROUTES = ("/health", "/instrument", "/ltp", "/oi", "/depth")

# `<something>.PlaceOrder(` — a CALL, not a mention in a docstring.
CALL_RE = re.compile(r"\.\s*(%s)\s*\(" % "|".join(ORDER_METHODS), re.IGNORECASE)

# `route == "/something"` — the route table of the HTTP layer.
ROUTE_RE = re.compile(r"route\s*==\s*[\"']([^\"']+)[\"']")


def service_sources():
    """Every Python file of the service EXCEPT the vendored third-party SDK
    and the tests themselves (the tests name the order methods on purpose)."""
    out = []
    for root, dirs, files in os.walk(SERVICE_DIR):
        dirs[:] = [d for d in dirs if d not in ("vendor", "__pycache__", "cache", "Logs", "tests")]
        for name in files:
            if name.endswith(".py"):
                out.append(os.path.join(root, name))
    return sorted(out)


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


class TestNoOrderEndpoint(unittest.TestCase):
    def test_no_route_string_contains_an_order_method(self):
        """The route table must not contain PlaceOrder / CancelOrder / …"""
        source = read(os.path.join(SERVICE_DIR, "moapi", "http_api.py"))
        for route in ROUTE_RE.findall(source):
            for method in ORDER_METHODS:
                self.assertNotIn(
                    method.lower(), route.lower(),
                    "the route %s exposes the order method %s" % (route, method),
                )

    def test_the_route_table_is_exactly_the_contract(self):
        source = read(os.path.join(SERVICE_DIR, "moapi", "http_api.py"))
        routes = set(ROUTE_RE.findall(source))
        self.assertEqual(routes, set(ALLOWED_ROUTES),
                         "the service must expose exactly the contract routes")

    def test_no_order_method_is_ever_called(self):
        for path in service_sources():
            source = read(path)
            match = CALL_RE.search(source)
            self.assertIsNone(
                match,
                "%s calls the order method %s" % (path, match.group(0) if match else ""),
            )

    def test_the_client_wrapper_exposes_no_trading_method(self):
        from moapi.client import MoClient

        for method in ORDER_METHODS:
            self.assertFalse(hasattr(MoClient, method),
                             "MoClient exposes %s" % method)

    def test_the_service_exposes_no_trading_method(self):
        from moapi.service import MoapiService

        for method in ORDER_METHODS:
            self.assertFalse(hasattr(MoapiService, method),
                             "MoapiService exposes %s" % method)

    def test_the_sdk_itself_does_have_them(self):
        # Sanity check: the guard above is meaningful because the vendored SDK
        # really does ship the trading methods.
        import sys

        vendor = os.path.join(SERVICE_DIR, "vendor")
        if vendor not in sys.path:
            sys.path.append(vendor)
        from MOFSLOPENAPI import MOFSLOPENAPI

        for method in ORDER_METHODS:
            self.assertTrue(hasattr(MOFSLOPENAPI, method),
                            "the SDK no longer has %s — re-check the guard" % method)


if __name__ == "__main__":
    unittest.main()
