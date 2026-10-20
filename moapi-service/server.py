#!/usr/bin/env python3
"""MOAPI service — a read-only Motilal OpenAPI side-car for SMDApp.

    python3 server.py                  run the service (default 127.0.0.1:8781)
    python3 server.py --dry-run        never authenticate (503 on every data call)
    python3 server.py --port 9000      a different port
    python3 server.py --no-feed        REST only (the websocket feed is off by default)

The HTTP contract (all GET, all JSON, same envelope — see `moapi/contract.py`):

    /health                  {"ok","authed","source","ts","error"?}
    /instrument              {"ok","ts","instruments":[{tradingsymbol, exchange,
                              expiry, lotSize, instrumentType, symbol, strike,
                              optionType}]}
    /ltp?tradingsymbol=X     {"ok","ts","tradingsymbol","ltp","source"}
    /oi?tradingsymbol=X      {"ok","ts","tradingsymbol","oi","oiChange","source"}
    /depth?tradingsymbol=X   {"ok","ts","tradingsymbol","bids","asks"}

Every failure returns the same shape with `ok: false` and an `error` string;
the status is 503 when MO is unreachable or unauthenticated (404 when the
contract is unknown to the MO master).

Environment (the SAME names the TypeScript client uses — no new secrets):
    MOTILAL_API_KEY, MOTILAL_SECRET_KEY, MOTILAL_TOTP_KEY, MOTILAL_VENDOR_ID,
    MOTILAL_USERID, MOTILAL_PASSWORD, MOTILAL_DOB,
    MOTILAL_PRIMARY_IP, MOTILAL_SECONDARY_IP
    MOAPI_SERVICE_PORT (default 8781), MOAPI_SERVICE_HOST, MOAPI_BASE_URL,
    MOAPI_WEBSOCKET=1 (broadcast feed; OFF by default), MOAPI_DRY_RUN,
    MOAPI_CACHE_DIR, MOAPI_INSTRUMENT_TTL_SECONDS, MOAPI_LTP_CACHE_TTL_SECONDS

There is NO order endpoint. The SDK's trading methods are never called —
`tests/test_no_order_endpoint.py` enforces that.
"""

import argparse
import os
import signal
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
# The SDK creates a `Logs/` directory in the CWD and writes there — keep that
# inside the service directory instead of the caller's directory.
os.chdir(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from moapi.config import Config, load_env_file  # noqa: E402
from moapi.logging_util import JsonLogger  # noqa: E402
from moapi.service import MoapiService  # noqa: E402
from moapi.http_api import MoapiServer  # noqa: E402


def build_parser():
    parser = argparse.ArgumentParser(description="MOAPI read-only service")
    parser.add_argument("--host", default=None, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="listen port (default 8781)")
    parser.add_argument("--dry-run", action="store_true",
                        help="never authenticate; every data endpoint answers 503")
    parser.add_argument("--no-feed", action="store_true",
                        help="do not open the websocket broadcast feed")
    parser.add_argument("--env-file", default=None, help="path to the .env file")
    parser.add_argument("--log-level", default=None, choices=["debug", "info", "warn", "error"])
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    load_env_file(args.env_file)

    config = Config()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    if args.dry_run:
        config.dry_run = True
    if args.no_feed:
        config.ws_enabled = False
    if args.log_level:
        config.log_level = args.log_level

    try:
        os.makedirs(config.cache_dir, exist_ok=True)
    except OSError:
        pass

    logger = JsonLogger(config.log_level, file_path=os.path.join(config.cache_dir, "moapi-service.log"))
    logger.info("moapi.start", **config.public_summary())

    service = MoapiService(config, logger)
    service.start()
    if config.ws_enabled:
        service.start_feed()

    server = MoapiServer((config.host, config.port), service, logger)
    logger.info("moapi.listening", host=config.host, port=config.port)

    stop = threading.Event()

    def shutdown(signum, frame):  # noqa: ARG001
        logger.info("moapi.shutdown", signal=signum)
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        try:
            server.server_close()
        except Exception:  # noqa: BLE001
            pass
        if service.feed is not None:
            service.feed.disconnect()
        logger.info("moapi.stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
