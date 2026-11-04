"""Service configuration — env-driven, secrets never logged.

The service reads the SAME env var names the TypeScript client already uses
(`MOTILAL_API_KEY`, `MOTILAL_SECRET_KEY`, `MOTILAL_TOTP_KEY`,
`MOTILAL_VENDOR_ID`, `MOTILAL_USERID`, `MOTILAL_PASSWORD`, `MOTILAL_DOB`,
`MOTILAL_PRIMARY_IP`, `MOTILAL_SECONDARY_IP`) so there is exactly ONE set of
credentials in the repo. No new secrets are introduced.
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(SERVICE_DIR)

DEFAULT_BASE_URL = "https://openapi.motilaloswal.com"
DEFAULT_SERVICE_URL = "http://127.0.0.1:8781"

# The exchanges the instrument master is loaded from.
#   NSEFO  — NSE F&O (options + futures): the authoritative OPTION lot sizes
#   BSEFO  — BSE F&O (SENSEX / BANKEX options)
#   NSE    — NSE cash (equity spot; NOTE its marketlot is 1 for stocks, so it
#            is never used for option lot sizes)
DEFAULT_EXCHANGES = ("NSEFO", "BSEFO")

# Symbols the websocket broadcast feed subscribes to. The MO broadcast limit
# is per-connection (the SDK asks the server for it via
# `getbroadcastmaxlimit`); the default cap used by the SDK is 200.
DEFAULT_SUBSCRIBE = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SBIN", "RELIANCE")


def load_env_file(path=None):
    """Load a .env file into os.environ WITHOUT overriding existing values.

    Values are never printed. Missing file → no-op.
    """
    path = path or os.environ.get("MOAPI_ENV_FILE") or os.path.join(REPO_ROOT, ".env")
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        return None
    return path


def _int(env, name, default):
    try:
        return int(str(env.get(name, "")).strip())
    except (TypeError, ValueError):
        return default


def _bool(env, name, default):
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


class Config(object):
    """Resolved service configuration (secrets are held but never printed)."""

    def __init__(self, env=None):
        env = env or os.environ
        self.base_url = env.get("MOAPI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        self.api_key = env.get("MOTILAL_API_KEY", "")
        self.secret_key = env.get("MOTILAL_SECRET_KEY", "")
        self.totp_key = env.get("MOTILAL_TOTP_KEY", "")
        self.vendor_id = env.get("MOTILAL_VENDOR_ID", "")
        self.userid = env.get("MOTILAL_USERID", "")
        self.password = env.get("MOTILAL_PASSWORD", "")
        self.dob = env.get("MOTILAL_DOB", "")
        self.primary_ip = env.get("MOTILAL_PRIMARY_IP", "")
        self.secondary_ip = env.get("MOTILAL_SECONDARY_IP", "")

        self.host = env.get("MOAPI_SERVICE_HOST", "127.0.0.1")
        self.port = _int(env, "MOAPI_SERVICE_PORT", 8781)
        self.cache_dir = env.get("MOAPI_CACHE_DIR", os.path.join(SERVICE_DIR, "cache"))
        self.instrument_ttl = _int(env, "MOAPI_INSTRUMENT_TTL_SECONDS",
                                   _int(env, "MOAPI_INSTRUMENT_TTL", 6 * 3600))
        self.request_timeout = _int(env, "MOAPI_REQUEST_TIMEOUT", 25)
        # NSEFO's GetInstrumentFile is ~83k rows and takes ~28s on a good
        # connection — the 25s request timeout used to abandon it mid-flight
        # and the loader then cached a BSEFO-only master (NIFTY never found).
        self.instrument_timeout = _int(env, "MOAPI_INSTRUMENT_TIMEOUT", 90)
        self.login_timeout = _int(env, "MOAPI_LOGIN_TIMEOUT", 30)
        # The websocket broadcast feed is OPTIONAL and OFF by default: the
        # service must work with the REST endpoints alone. `MOAPI_WEBSOCKET=1`
        # turns it on; `MOAPI_WS_ENABLED` is the older name and still works.
        if "MOAPI_WEBSOCKET" in env and str(env.get("MOAPI_WEBSOCKET") or "").strip() != "":
            self.ws_enabled = _bool(env, "MOAPI_WEBSOCKET", False)
        else:
            self.ws_enabled = _bool(env, "MOAPI_WS_ENABLED", False)
        self.ws_max_scrips = _int(env, "MOAPI_WS_MAX_SCRIPS", 200)
        self.ws_strikes_per_symbol = _int(env, "MOAPI_WS_STRIKES_PER_SYMBOL", 10)
        self.dry_run = _bool(env, "MOAPI_DRY_RUN", False)
        self.log_level = env.get("MOAPI_LOG_LEVEL", "info").lower()
        # TTL of the on-disk LTP cache (cache/ltp-cache.json).
        self.ltp_cache_ttl = _int(env, "MOAPI_LTP_CACHE_TTL_SECONDS", 15)

        exchanges = env.get("MOAPI_EXCHANGES", "")
        self.exchanges = tuple(
            e.strip().upper() for e in exchanges.split(",") if e.strip()
        ) or DEFAULT_EXCHANGES

        subscribe = env.get("MOAPI_SUBSCRIBE", "")
        self.subscribe = tuple(
            s.strip().upper() for s in subscribe.split(",") if s.strip()
        ) if subscribe else DEFAULT_SUBSCRIBE

    @property
    def has_credentials(self):
        return bool(self.api_key and self.secret_key and self.userid and self.password and self.dob)

    def public_summary(self):
        """A log-safe view of the configuration — no secret values, ever."""
        return {
            "base_url": self.base_url,
            "host": self.host,
            "port": self.port,
            "exchanges": list(self.exchanges),
            "subscribe": list(self.subscribe),
            "ws_enabled": self.ws_enabled,
            "dry_run": self.dry_run,
            "instrument_ttl_s": self.instrument_ttl,
            "request_timeout_s": self.request_timeout,
            "instrument_timeout_s": self.instrument_timeout,
            "credentials_present": self.has_credentials,
            "totp_key_present": bool(self.totp_key),
            "vendor_id_present": bool(self.vendor_id),
        }
