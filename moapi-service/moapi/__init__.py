"""MOAPI service package (read-only Motilal OpenAPI side-car).

Modules:
  config      env-driven configuration (no secrets logged)
  totp        RFC 6238 TOTP with the standard library only
              (the implementation lives in `moapi-service/totp.py`)
  client      the vendored SDK behind a timeout + error classification
  instruments the instrument-master parser (lot sizes, expiries, tradingsymbols)
  feed        the websocket broadcast subscriber (LTP / OI / depth)
  service     the stateful core
  contract    the HTTP contract — the exact response shapes
  http_api    the stdlib HTTP surface
"""

__all__ = ["config", "totp", "client", "instruments", "feed", "service",
           "contract", "http_api"]
