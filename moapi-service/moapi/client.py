"""Thin, fail-closed wrapper around the vendored Motilal OpenAPI SDK.

The SDK (`vendor/MOFSLOPENAPI.py`) is used UNMODIFIED. This module only adds
the things the SDK lacks and the service needs:

  * a request TIMEOUT (the SDK's `requests.post` has none — a hung MO call
    would block a worker thread forever),
  * error CLASSIFICATION (session expired / no data / source unavailable),
  * TOTP login (the SDK takes the code as a parameter; we generate it with
    the standard library — see `moapi-service/totp.py`),
  * re-login on session expiry.

TRADING IS NOT EXPOSED. The SDK also contains PlaceOrder / ModifyOrder /
CancelOrder / PositionConversion; this wrapper never calls them and the HTTP
surface of the service has no order endpoint at all.
"""

import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR_DIR = os.path.join(os.path.dirname(HERE), "vendor")
# APPEND (not insert) the vendor dir: the installed `websocket-client` must
# win over the older copy that ships inside the SDK repo.
if VENDOR_DIR not in sys.path:
    sys.path.append(VENDOR_DIR)

from MOFSLOPENAPI import MOFSLOPENAPI  # noqa: E402  (needs the path above)

from . import totp  # noqa: E402

# Error classes the service reports to the app.
SESSION_EXPIRED = "SESSION_EXPIRED"
NO_DATA = "NO_DATA"
SOURCE_UNAVAILABLE = "SOURCE_UNAVAILABLE"
OK = "OK"

_SESSION_MARKERS = (
    "invalid token",
    "not verified",
    "auth token is not verified",
    "mo1097",
    "unauthorised",
    "unauthorized",
    "session expired",
    "please login",
    "invalid auth",
)


class MoError(Exception):
    """An MO API failure, classified so the caller can fail closed."""

    def __init__(self, kind, message, detail=None):
        super(MoError, self).__init__(message)
        self.kind = kind
        self.message = message
        self.detail = detail or {}


def classify_message(message):
    """Classify a raw MO message into an error kind."""
    text = str(message or "").lower()
    for marker in _SESSION_MARKERS:
        if marker in text:
            return SESSION_EXPIRED
    if "no records found" in text or "no data" in text or "no record" in text:
        return NO_DATA
    return SOURCE_UNAVAILABLE


class _Timeout(object):
    """Result of a call that may or may not have finished in time."""

    def __init__(self, value=None, error=None, timed_out=False):
        self.value = value
        self.error = error
        self.timed_out = timed_out


def call_with_timeout(func, timeout_s, *args, **kwargs):
    """Run `func` in a worker thread and give up after `timeout_s`.

    The SDK's own `requests.post` has no timeout, so this is the ONLY way to
    bound a call to MO. A timed-out call is abandoned (the thread may finish
    later) — the caller gets a SOURCE_UNAVAILABLE error instead of hanging.
    """
    box = _Timeout()

    def runner():
        try:
            box.value = func(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 - reported to the caller
            box.error = exc

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join(timeout_s)
    if thread.is_alive():
        raise MoError(SOURCE_UNAVAILABLE, "MO call timed out after %ss" % timeout_s)
    if box.error is not None:
        raise box.error
    return box.value


class MoClient(object):
    """Authenticated Motilal OpenAPI client (read-only)."""

    def __init__(self, config, logger=None):
        self.config = config
        self.log = logger
        self._sdk = None
        self._lock = threading.RLock()
        self._session_state = "not_logged_in"
        self._last_error = None
        self._last_login_at = None
        self._login_count = 0
        self._max_broadcast_limit = 200

    # ── logging helper (never logs secrets) ──
    def _log(self, level, event, **fields):
        if self.log:
            self.log.log(level, event, **fields)

    # ── session state ──
    @property
    def session_state(self):
        return self._session_state

    @property
    def last_error(self):
        """The last authentication error (never a secret)."""
        return self._last_error

    def auth_state(self):
        return {
            "state": self._session_state,
            "lastLoginAt": self._last_login_at,
            "loginCount": self._login_count,
            "lastError": self._last_error,
            "verified": self._session_state == "authenticated",
        }

    def _ensure_sdk(self):
        if self._sdk is None:
            self._sdk = MOFSLOPENAPI(
                self.config.api_key,
                self.config.base_url,
                None,          # clientcode — retail only
                "WEB",
                "Chrome",
                "120.0",
                self.config.secret_key,
            )
        return self._sdk

    # ── login ──
    def login(self):
        """Log in with a freshly generated TOTP. Raises MoError on failure."""
        with self._lock:
            if self.config.dry_run:
                self._session_state = "dry_run"
                self._last_error = None
                raise MoError(SOURCE_UNAVAILABLE, "dry-run mode: authentication is disabled")
            if not self.config.has_credentials:
                self._session_state = "unauthenticated"
                self._last_error = "missing MOTILAL credentials in the environment"
                raise MoError(SOURCE_UNAVAILABLE, self._last_error)

            code = totp.generate_totp(self.config.totp_key)
            sdk = self._ensure_sdk()
            try:
                response = call_with_timeout(
                    sdk.login,
                    self.config.login_timeout,
                    self.config.userid,
                    self.config.password,
                    self.config.dob,
                    code,
                    self.config.vendor_id,
                )
            except MoError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._session_state = "unauthenticated"
                self._last_error = str(exc)
                raise MoError(SOURCE_UNAVAILABLE, "MO login request failed: %s" % exc)

            status = str(response.get("status", "")).upper()
            if status != "SUCCESS" or not response.get("AuthToken"):
                message = response.get("message") or "login rejected"
                self._session_state = "unauthenticated"
                self._last_error = message
                self._log("warn", "mo.login.failed", reason=message, errorcode=response.get("errorcode"))
                raise MoError(classify_message(message), "MO login failed: %s" % message)

            verified = str(response.get("isAuthTokenVerified", "")).upper() == "TRUE"
            if not verified:
                self._session_state = "unverified"
                self._last_error = "auth token returned but not verified"
                self._log("warn", "mo.login.unverified")
                raise MoError(SESSION_EXPIRED, "MO login returned an unverified token")

            # The access token is required by the report endpoints.
            try:
                access = call_with_timeout(sdk.GetAccessToken, self.config.login_timeout)
            except Exception as exc:  # noqa: BLE001
                self._session_state = "unauthenticated"
                self._last_error = "access token failed: %s" % exc
                raise MoError(SOURCE_UNAVAILABLE, self._last_error)
            if str(access.get("status", "")).upper() != "SUCCESS":
                message = access.get("message") or "access token rejected"
                self._session_state = "unauthenticated"
                self._last_error = message
                raise MoError(classify_message(message), "MO access token failed: %s" % message)

            self._session_state = "authenticated"
            self._last_error = None
            self._login_count += 1
            self._last_login_at = time.time()
            self._log("info", "mo.login.ok", loginCount=self._login_count, verified=True)
            return {"status": "SUCCESS", "verified": True}

    def relogin(self, reason="session expired"):
        """Force a fresh login (used when MO reports an expired session)."""
        with self._lock:
            self._session_state = "reauthenticating"
            self._log("info", "mo.relogin", reason=reason)
            self._sdk = None
            return self.login()

    def ensure_authenticated(self):
        if self._session_state == "authenticated":
            return
        self.login()

    # ── report endpoints ──
    def _call(self, name, *args, **kwargs):
        """Call an SDK method with a timeout + error classification."""
        self.ensure_authenticated()
        sdk = self._ensure_sdk()
        method = getattr(sdk, name)
        try:
            return call_with_timeout(method, self.config.request_timeout, *args, **kwargs)
        except MoError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise MoError(SOURCE_UNAVAILABLE, "MO %s failed: %s" % (name, exc))

    def get_ltp(self, exchange, scripcode):
        """Raw MO LTP record. Raises MoError(NO_DATA) when MO has no record."""
        response = self._call("GetLtp", {"exchange": exchange, "scripcode": int(scripcode)})
        status = str(response.get("status", "")).upper()
        if status != "SUCCESS":
            message = response.get("message") or "MO LTP failed"
            kind = NO_DATA if "no records found" in str(message).lower() else classify_message(message)
            raise MoError(kind, "MO LTP unavailable: %s" % message, {"exchange": exchange, "scripcode": scripcode})
        data = response.get("data") or {}
        if not data or not data.get("ltp"):
            raise MoError(NO_DATA, "MO LTP record empty", {"exchange": exchange, "scripcode": scripcode})
        return data

    def get_instrument_file(self, exchange):
        """Raw MO instrument master for one exchange."""
        response = self._call("GetInstrumentFile", exchange)
        status = str(response.get("status", "")).upper()
        if status != "SUCCESS":
            message = response.get("message") or "MO instrument file failed"
            raise MoError(classify_message(message), "MO instrument file failed: %s" % message,
                          {"exchange": exchange})
        return response.get("data") or []

    def get_broadcast_max_limit(self):
        try:
            response = self._call("getbroadcastmaxlimit")
            limit = (response.get("data") or {}).get("MaxBroadcastLimit")
            if limit:
                self._max_broadcast_limit = int(limit)
        except Exception:  # noqa: BLE001
            pass
        return self._max_broadcast_limit

    @property
    def sdk(self):
        return self._sdk
