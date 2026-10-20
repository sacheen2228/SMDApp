"""HTTP surface of the MOAPI service — stdlib `http.server` only.

The routes (all GET, all JSON, all with the same envelope):

  /health                 {"ok","authed","source","ts","error"?}
  /instrument             {"ok","ts","instruments":[{...}]}
  /ltp?tradingsymbol=X    {"ok","ts","tradingsymbol","ltp","source"}
  /oi?tradingsymbol=X     {"ok","ts","tradingsymbol","oi","oiChange","source"}
  /depth?tradingsymbol=X  {"ok","ts","tradingsymbol","bids","asks"}

Every failure returns the same shape with `ok: false` and an `error` string;
the status is 503 when MO is unreachable or unauthenticated (404 when the
contract is simply unknown to the MO master).

There is NO order endpoint. The SDK's trading methods (PlaceOrder,
ModifyOrder, CancelOrder, PositionConversion) are never called by this
service — it is read-only by construction. `tests/test_no_order_endpoint.py`
enforces that.
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import contract
from .client import MoError, NO_DATA, SESSION_EXPIRED, SOURCE_UNAVAILABLE

# HTTP status per error kind. Everything MO-related that we cannot serve is
# a 503 (the upstream is not available) — never a 200 with a fake value.
STATUS_BY_KIND = {
    NO_DATA: 404,
    SESSION_EXPIRED: 503,
    SOURCE_UNAVAILABLE: 503,
}

DRY_RUN_ERROR = "dry-run: authentication is disabled — no MO data can be served"


def _first(params, name, default=None):
    values = params.get(name)
    if not values:
        return default
    value = values[0]
    return value if value != "" else default


def _float_or_none(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class MoapiHandler(BaseHTTPRequestHandler):
    server_version = "moapi-service/1.0"
    protocol_version = "HTTP/1.1"

    # The service instance is attached to the server object.
    @property
    def service(self):
        return self.server.moapi_service  # type: ignore[attr-defined]

    @property
    def logger(self):
        return self.server.moapi_logger  # type: ignore[attr-defined]

    # ── plumbing ──
    def log_message(self, fmt, *args):  # noqa: A003 - stdlib hook
        # The stdlib access log is noisy and unstructured — the service logs
        # requests itself (structured, one line per request).
        return

    def _send_bytes(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send(self, status, payload):
        self._send_bytes(status, json.dumps(payload, default=str).encode("utf-8"))

    def _error(self, status, reason, kind=None):
        self._send(status, contract.error_payload(reason, kind=kind))

    def do_GET(self):  # noqa: N802 - stdlib hook
        started = time.time()
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        params = parse_qs(parsed.query)
        status = 200
        try:
            status = self._route(route, params)
        except MoError as exc:
            status = STATUS_BY_KIND.get(exc.kind, 503)
            self._error(status, exc.message, kind=exc.kind)
        except Exception as exc:  # noqa: BLE001
            status = 500
            self._error(status, "internal error: %s" % exc)
        finally:
            if self.logger:
                self.logger.debug("http.request", route=route, status=status,
                                  ms=int((time.time() - started) * 1000))

    # ── routing ──
    def _route(self, route, params):
        if route == "/health":
            self._send(200, contract.health(self.service))
            return 200
        if route == "/instrument":
            self._send_instrument(params)
            return 200
        if route in ("/ltp", "/oi", "/depth"):
            if self._dry_run():
                self._error(503, DRY_RUN_ERROR)
                return 503
        if route == "/ltp":
            self._send(200, contract.ltp(self.service, **self._query(params)))
            return 200
        if route == "/oi":
            self._send(200, contract.oi(self.service, **self._query(params)))
            return 200
        if route == "/depth":
            self._send(200, contract.depth(self.service, **self._query(params)))
            return 200
        self._error(404, "unknown endpoint %s" % route)
        return 404

    def _send_instrument(self, params):
        """The instrument master — served pre-serialized (it is ~30 MB)."""
        if self._dry_run():
            self._error(503, DRY_RUN_ERROR)
            return
        force = _first(params, "refresh") == "1"
        body = self.service.instrument_response_bytes(force=force)
        self._send_bytes(200, body)

    def _dry_run(self):
        return bool(getattr(self.service.config, "dry_run", False))

    def _query(self, params):
        query = {
            "tradingsymbol": _first(params, "tradingsymbol"),
            "scripcode": _first(params, "scripcode"),
            "symbol": _first(params, "symbol"),
            "expiry": _first(params, "expiry"),
            "strike": _float_or_none(_first(params, "strike")),
            "option_type": _first(params, "type") or _first(params, "optionType"),
        }
        if not any([query["tradingsymbol"], query["scripcode"], query["symbol"]]):
            raise MoError(NO_DATA, "a tradingsymbol (or symbol+expiry+strike+type) is required")
        return query


class MoapiServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, service, logger):
        super(MoapiServer, self).__init__(address, MoapiHandler)
        self.moapi_service = service
        self.moapi_logger = logger
