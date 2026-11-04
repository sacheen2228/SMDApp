"""The HTTP contract of the MOAPI service — the EXACT shapes the app codes against.

Every endpoint returns the same envelope: a boolean `ok`, an ISO-8601 `ts`
(UTC, second precision) and the provider name `source` ("motilal"). On
success the payload carries the data; on failure `ok` is False and `error`
holds a human-readable reason (the HTTP status is 503 when MO is unreachable
or unauthenticated).

    GET /health      -> {"ok", "authed", "source", "ts", "error"?}
    GET /instrument  -> {"ok", "ts", "instruments":[{tradingsymbol, exchange, expiry,
                        lotSize, instrumentType, symbol, strike, optionType}]}
    GET /ltp?tradingsymbol=X -> {"ok", "ts", "tradingsymbol", "ltp", "source"}
    GET /oi?tradingsymbol=X  -> {"ok", "ts", "tradingsymbol", "oi", "oiChange", "source"}
    GET /depth?tradingsymbol=X-> {"ok", "ts", "tradingsymbol", "bids", "asks"}

`source` is the PROVIDER ("motilal"), except on /oi where it also says HOW
the value was obtained: "websocket" for the broadcast feed, "motilal" for the
REST API (MO's REST endpoint does not carry OI today, so /oi is a
websocket-only value — see `MoapiService.open_interest`).

This module is deliberately pure: it only shapes what the service layer
returns, so the contract can be unit-tested offline with a stub service.
"""

from datetime import datetime, timezone

PROVIDER = "motilal"

# The keys of one entry of the /instrument array — in this exact order.
INSTRUMENT_KEYS = (
    "tradingsymbol",
    "exchange",
    "expiry",
    "lotSize",
    "instrumentType",
    "symbol",
    "strike",
    "optionType",
)


def iso_now():
    """The current UTC time as an ISO-8601 string (second precision)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def error_payload(reason, kind=None):
    """The one and only error shape."""
    payload = {
        "ok": False,
        "error": str(reason),
        "source": PROVIDER,
        "ts": iso_now(),
    }
    if kind:
        payload["kind"] = kind
    return payload


def _instrument_entry(contract):
    """One /instrument entry — exactly the eight contract keys."""
    return {
        "tradingsymbol": contract.get("tradingsymbol"),
        "exchange": contract.get("exchange"),
        "expiry": contract.get("expiry"),
        "lotSize": contract.get("lotSize"),
        "instrumentType": contract.get("instrumentType"),
        "symbol": contract.get("symbol"),
        "strike": contract.get("strike"),
        "optionType": contract.get("optionType"),
    }


# Public alias — the service layer uses it to pre-serialize the array.
instrument_entry = _instrument_entry


def instrument_array_bytes(contracts):
    """The JSON bytes of the `instruments` array (without the envelope).

    The MO master is ~126k contracts; re-serialising it on every request
    costs seconds, so the bytes are built once and cached by the caller.
    """
    import json

    return json.dumps([_instrument_entry(c) for c in contracts], default=str).encode("utf-8")


def instrument_envelope_bytes(array_bytes, ts=None):
    """The full /instrument body: the envelope around a pre-built array."""
    return (
        b'{"ok":true,"ts":"' + (ts or iso_now()).encode("utf-8") +
        b'","instruments":' + array_bytes + b'}'
    )


def health(service):
    """GET /health — the auth state of the MO session."""
    state = service.health()
    dry_run = bool(getattr(getattr(service, "config", None), "dry_run", False))
    payload = {
        "ok": bool(state.get("ok", True)),
        "authed": bool(state.get("authed")) and not dry_run,
        "source": PROVIDER,
        "ts": state.get("ts") or iso_now(),
    }
    if state.get("error"):
        payload["error"] = state["error"]
    return payload


def instrument(service, force=False):
    """GET /instrument — the MO instrument master, served as-is."""
    contracts = service.instrument(force=force)["contracts"]
    return {
        "ok": True,
        "ts": iso_now(),
        "instruments": [_instrument_entry(c) for c in contracts],
    }


def ltp(service, **query):
    """GET /ltp — the live price of one contract, in RUPEES."""
    quote = service.ltp(**query)
    return {
        "ok": True,
        "ts": iso_now(),
        "tradingsymbol": quote.get("tradingsymbol"),
        "ltp": quote.get("ltp"),
        "source": PROVIDER,
    }


def ltps(service, tradingsymbols):
    """GET /ltps — bulk live prices (one entry per requested tradingsymbol).

    `results[TS]` is `{ok, ltp, source}` on success or `{ok:false, error}`
    when that one contract could not be priced. The envelope stays `ok:true`
    as long as the batch itself ran — partial data is the normal case.
    """
    results = service.ltps(tradingsymbols)
    shaped = {}
    for ts, entry in results.items():
        if entry.get("ok") and entry.get("ltp") is not None:
            quote = entry.get("ltp") or {}
            shaped[ts] = {
                "ok": True,
                "tradingsymbol": quote.get("tradingsymbol") or ts,
                "ltp": quote.get("ltp"),
                "source": quote.get("source") or PROVIDER,
            }
        else:
            shaped[ts] = {
                "ok": False,
                "tradingsymbol": ts,
                "error": entry.get("error") or "unavailable",
                "kind": entry.get("kind"),
            }
    return {
        "ok": True,
        "ts": iso_now(),
        "results": shaped,
    }


def oi(service, **query):
    """GET /oi — the open interest of one contract."""
    result = service.open_interest(**query)
    return {
        "ok": True,
        "ts": iso_now(),
        "tradingsymbol": result.get("tradingsymbol"),
        "oi": result.get("oi"),
        "oiChange": result.get("oiChange"),
        "source": result.get("source") or PROVIDER,
    }


def depth(service, **query):
    """GET /depth — the market depth of one contract.

    `bids` and `asks` are lists of [price, quantity] pairs, best level first.
    """
    result = service.depth(**query)
    return {
        "ok": True,
        "ts": iso_now(),
        "tradingsymbol": result.get("tradingsymbol"),
        "bids": result.get("bids") or [],
        "asks": result.get("asks") or [],
    }
