"""The service core: instrument master, LTP, OI and depth.

Everything the HTTP layer exposes is computed here, and everything fails
CLOSED: when MO is unreachable, unauthenticated or simply has no record for a
contract, the service says so explicitly (503 + reason) instead of inventing a
price.

PRICE UNITS (verified live 2026-10-20) — the single most important detail:

  * `GetLtp` (REST) returns prices in PAISE   (210635 paise = ₹2106.35)
  * the broadcast websocket returns prices in RUPEES (LTP_Rate 22894.0)

The REST scale is therefore verified per contract against the circuit limits
that ship with the instrument master (those are in RUPEES): a raw value fits
`[lower*100, upper*100]` when it is paise, and `[lower, upper]` when it is
rupees. The scale is only "verified" when exactly one of the two fits.
"""

import json
import os
import threading
import time

from . import instruments
from . import contract
from .client import MoClient, MoError, NO_DATA, SESSION_EXPIRED, SOURCE_UNAVAILABLE, OK

# MO exchanges whose REST prices are in paise (x100). Verified live on NSE,
# NSEFO (options and futures) and BSE cash.
PAISE_EXCHANGES = ("NSE", "NSEFO", "BSE", "BSEFO", "NSECD")

# The websocket exchange-type byte per exchange.
FEED_EXCHANGE_TYPE = {
    "NSE": "CASH",
    "NSEFO": "FNO",
    "BSE": "CASH",
    "BSEFO": "FNO",
    "MCX": "COMMODITY",
    "NCDEX": "COMMODITY",
}


def _now():
    return time.time()


class InstrumentMaster(object):
    """The MO instrument master, cached in memory and on disk."""

    def __init__(self, config, client, logger):
        self.config = config
        self.client = client
        self.log = logger
        self._lock = threading.RLock()
        self.contracts = []
        self.lot_sizes = {}
        self.by_tradingsymbol = {}
        self.by_key = {}
        self.fetched_at = 0.0
        self.fetch_error = None
        self.exchanges = {}
        self._array_bytes = None

    # ── cache file ──
    def _cache_path(self):
        return os.path.join(self.config.cache_dir, "instrument-master.json")

    def _read_cache(self):
        path = self._cache_path()
        if not os.path.isfile(path):
            return None
        try:
            if _now() - os.path.getmtime(path) > self.config.instrument_ttl:
                return None
            with open(path, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError):
            return None
        if not payload.get("contracts"):
            return None
        # The cache stores PARSED contracts — a parser change invalidates it.
        if payload.get("parserVersion") != instruments.PARSER_VERSION:
            if self.log:
                self.log.info("mo.master.cache_stale",
                              cachedVersion=payload.get("parserVersion"),
                              parserVersion=instruments.PARSER_VERSION)
            return None
        return payload

    def _write_cache(self):
        path = self._cache_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({
                    "fetchedAt": _now(),
                    "parserVersion": instruments.PARSER_VERSION,
                    "exchanges": dict(self.exchanges),
                    "contracts": self.contracts,
                }, fh)
            os.replace(tmp, path)
        except OSError as exc:
            if self.log:
                self.log.warn("mo.master.cache_write_failed", error=str(exc))

    # ── loading ──
    def load(self, force=False):
        """Load the master (memory → disk cache → MO). Returns the contracts."""
        with self._lock:
            fresh = self.fetched_at and (_now() - self.fetched_at) < self.config.instrument_ttl
            if fresh and not force:
                return self.contracts
            if not force:
                cached = self._read_cache()
                if cached:
                    self.exchanges = dict(cached.get("exchanges") or {})
                    self._apply(cached["contracts"], cached.get("fetchedAt"))
                    if self.log:
                        self.log.info("mo.master.cache_hit", contracts=len(self.contracts),
                                      ageS=int(_now() - self.fetched_at))
                    return self.contracts

            contracts = []
            errors = {}
            for exchange in self.config.exchanges:
                try:
                    rows = self.client.get_instrument_file(exchange)
                    parsed = instruments.parse_master(rows, exchange)
                    contracts.extend(parsed)
                    self.exchanges[exchange] = len(parsed)
                    if self.log:
                        self.log.info("mo.master.exchange_loaded", exchange=exchange, contracts=len(parsed))
                except MoError as exc:
                    errors[exchange] = exc.message
                    if self.log:
                        self.log.warn("mo.master.exchange_failed", exchange=exchange, kind=exc.kind,
                                      reason=exc.message)
            if not contracts:
                self.fetch_error = errors or "no contracts"
                raise MoError(SOURCE_UNAVAILABLE,
                              "MO instrument master unavailable: %s" % json.dumps(errors),
                              {"errors": errors})
            self._apply(contracts, _now())
            self.fetch_error = None
            self._write_cache()
            return self.contracts

    def _apply(self, contracts, fetched_at):
        self.contracts = contracts
        self.fetched_at = fetched_at or _now()
        self.lot_sizes = instruments.lot_sizes_from_contracts(contracts)
        self.by_tradingsymbol = instruments.index_by_tradingsymbol(contracts)
        self.by_key = instruments.index_by_contract_key(contracts)
        self._array_bytes = None

    def array_bytes(self):
        """The pre-serialized `instruments` array (built once per master load)."""
        with self._lock:
            if self._array_bytes is None:
                self._array_bytes = contract.instrument_array_bytes(self.contracts)
            return self._array_bytes

    # ── lookups ──
    def resolve(self, tradingsymbol=None, scripcode=None, symbol=None, expiry=None,
                strike=None, option_type=None):
        """Find a contract. Returns (contract, reason) — reason is set when
        the contract is unknown."""
        with self._lock:
            if scripcode:
                try:
                    wanted = int(scripcode)
                except (TypeError, ValueError):
                    return None, "invalid scripcode"
                for contract in self.contracts:
                    if contract.get("scripcode") == wanted:
                        return contract, None
                return None, "scripcode %s not in the MO instrument master" % wanted
            if tradingsymbol:
                ts = str(tradingsymbol).strip().upper()
                contract = self.by_tradingsymbol.get(ts)
                if contract:
                    return contract, None
                parsed = instruments.parse_tradingsymbol(ts)
                if parsed:
                    key = (parsed["symbol"], parsed["expiry"], float(parsed["strike"]), parsed["optionType"])
                    contract = self.by_key.get(key)
                    if contract:
                        return contract, None
                return None, "tradingsymbol %s not in the MO instrument master" % ts
            if symbol and expiry and strike is not None and option_type:
                key = (str(symbol).strip().upper(), expiry, float(strike), str(option_type).upper())
                contract = self.by_key.get(key)
                if contract:
                    return contract, None
                return None, "no %s %s %s %s contract in the MO instrument master" % (
                    symbol, expiry, strike, option_type)
            return None, "a tradingsymbol, or symbol+expiry+strike+type, is required"

    def lot_size(self, symbol):
        with self._lock:
            return self.lot_sizes.get(str(symbol or "").strip().upper())

    def stats(self):
        with self._lock:
            return {
                "contracts": len(self.contracts),
                "symbols": len(self.lot_sizes),
                "fetchedAt": self.fetched_at,
                "ageS": int(_now() - self.fetched_at) if self.fetched_at else None,
                "ttlS": self.config.instrument_ttl,
                "exchanges": dict(self.exchanges),
                "error": self.fetch_error,
            }


class LtpCache(object):
    """A tiny on-disk LTP cache (`cache/ltp-cache.json`) with a TTL.

    Only the volatile part of a quote is cached (the price, when it was seen
    and where it came from) — everything else is re-derived from the
    instrument master on every request, so a cache hit can never serve a
    stale contract identity.
    """

    def __init__(self, config, logger=None):
        self.config = config
        self.log = logger
        self._lock = threading.RLock()
        self._entries = {}
        self._loaded = False

    def _path(self):
        return os.path.join(self.config.cache_dir, "ltp-cache.json")

    def _load(self):
        if self._loaded:
            return
        self._loaded = True
        path = self._path()
        if not os.path.isfile(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                payload = json.load(fh)
            entries = payload.get("entries") or {}
            if isinstance(entries, dict):
                self._entries = entries
        except (OSError, ValueError):
            self._entries = {}

    def get(self, key):
        """The cached entry for `key` when it is still fresh, else None."""
        if not key:
            return None
        with self._lock:
            self._load()
            entry = self._entries.get(key)
            if not entry:
                return None
            try:
                age = _now() - float(entry.get("ts") or 0)
            except (TypeError, ValueError):
                return None
            if age > self.config.ltp_cache_ttl:
                return None
            return dict(entry)

    def set(self, key, entry):
        if not key:
            return
        with self._lock:
            self._load()
            self._entries[key] = entry
            path = self._path()
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump({"updatedAt": _now(), "entries": self._entries}, fh)
                os.replace(tmp, path)
            except OSError as exc:
                if self.log:
                    self.log.warn("mo.ltp.cache_write_failed", error=str(exc))


def scale_for_price(raw, contract):
    """Return (price_in_rupees, scale, verified).

    `scale` is 100 when the raw REST value is paise, 1 when it is rupees.
    `verified` is True when the circuit limits (in rupees) prove the scale.
    """
    if raw is None:
        return None, None, False
    value = float(raw)
    lower = (contract or {}).get("lowerCircuit")
    upper = (contract or {}).get("upperCircuit")
    exchange = ((contract or {}).get("exchange") or "").upper()
    if lower and upper and lower > 0 and upper > lower:
        paise_ok = (lower * 100) <= value <= (upper * 100)
        rupee_ok = lower <= value <= upper
        if paise_ok and not rupee_ok:
            return value / 100.0, 100, True
        if rupee_ok and not paise_ok:
            return value, 1, True
        if paise_ok and rupee_ok:
            # Both fit: prefer the exchange's native unit.
            scale = 100 if exchange in PAISE_EXCHANGES else 1
            return value / scale, scale, True
    scale = 100 if exchange in PAISE_EXCHANGES else 1
    return value / scale, scale, False


class MoapiService(object):
    """The stateful core behind the HTTP endpoints."""

    def __init__(self, config, logger, client=None):
        self.config = config
        self.log = logger
        self.client = client or MoClient(config, logger)
        self.master = InstrumentMaster(config, self.client, logger)
        self.feed = None
        self.feed_cache = None
        self.started_at = _now()
        self._ltp_cache = LtpCache(config, logger)

    # ── lifecycle ──
    def start(self):
        if self.config.dry_run:
            self.log.info("moapi.start.dry_run")
            return
        try:
            self.client.login()
        except MoError as exc:
            self.log.error("moapi.start.login_failed", kind=exc.kind, reason=exc.message)
        # The master is loaded lazily (it is 45 MB on the wire); the disk
        # cache means a restart is instant.
        threading.Thread(target=self._warm_master, name="mo-master-warm", daemon=True).start()

    def _warm_master(self):
        try:
            self.master.load()
        except MoError as exc:
            self.log.warn("moapi.master.warm_failed", kind=exc.kind, reason=exc.message)

    def start_feed(self):
        """Start the websocket broadcast subscriber (optional)."""
        if not self.config.ws_enabled:
            self.log.info("moapi.feed.disabled")
            return
        if self.config.dry_run:
            return
        try:
            from .feed import BroadcastFeed, FeedCache
            self.feed_cache = FeedCache()
            self.feed = BroadcastFeed(
                self.config.api_key, self.config.base_url, self.config.secret_key,
                self.feed_cache, self.log,
            )
            # The feed is a separate SDK instance — it needs the auth token
            # of the REST client, otherwise every Register packet is rejected.
            self.feed.sync_auth(self.client.sdk)
            self.feed.connect()
            threading.Thread(target=self._subscribe_defaults, name="mo-feed-sub", daemon=True).start()
        except Exception as exc:  # noqa: BLE001
            self.log.error("moapi.feed.start_failed", error=str(exc))

    def _subscribe_defaults(self):
        """Register the default symbol list on the broadcast feed.

        The subscription is deliberately SMALL: MO caps a connection at
        `getbroadcastmaxlimit` scripts (200 by default) and the feed is a
        push stream, so we register the nearest expiry of each symbol and
        only the strikes around the money.

        The ATM strike is found from the FUTURE's price (the same expiry),
        not from the middle of the listed ladder — the ladder is not
        symmetric and the middle is often far from the money.
        """
        try:
            self.master.load()
        except MoError:
            return
        limit = min(self.config.ws_max_scrips, self.client.get_broadcast_max_limit() or 200)
        strikes_per_symbol = max(1, int(self.config.ws_strikes_per_symbol))
        registered = 0
        today = self._today_ist()
        for symbol in self.config.subscribe:
            expiries = instruments.expiries_for(self.master.contracts, symbol, min_expiry=today)
            if not expiries:
                continue
            nearest = expiries[0]
            contracts = instruments.find_option_contracts(
                self.master.contracts, symbol, expiry=nearest)
            if not contracts:
                continue
            strikes = sorted({float(c.get("strike") or 0) for c in contracts})
            if not strikes:
                continue
            atm = self._atm_strike(symbol, nearest, strikes)
            keep = set(sorted(strikes, key=lambda s: abs(s - atm))[:strikes_per_symbol])
            for contract in contracts:
                if float(contract.get("strike") or 0) not in keep:
                    continue
                if registered >= limit:
                    break
                exchange = contract.get("exchange") or "NSEFO"
                self.feed.register(exchange, FEED_EXCHANGE_TYPE.get(exchange, "FNO"),
                                   contract["scripcode"])
                registered += 1
        try:
            self.feed.register_index("NSE")
        except Exception:  # noqa: BLE001
            pass
        self.log.info("moapi.feed.subscribed", contracts=registered, limit=limit)

    @staticmethod
    def _today_ist():
        import datetime
        ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
        return datetime.datetime.now(ist).strftime("%Y-%m-%d")

    def _atm_strike(self, symbol, expiry, strikes):
        """The strike closest to the underlying's price (the future's LTP)."""
        future = instruments.future_for(self.master.contracts, symbol, expiry)
        price = None
        if future:
            try:
                data = self.client.get_ltp(future.get("exchange") or "NSEFO", future.get("scripcode"))
                price, _scale, _verified = scale_for_price(data.get("ltp"), future)
            except MoError:
                price = None
        if not price:
            return strikes[len(strikes) // 2]
        return min(strikes, key=lambda s: abs(s - price))

    # ── health ──
    def health(self):
        """The service state. The `ok`/`authed`/`source`/`ts`/`error` keys are
        the contract shape (see `moapi/contract.py`); the rest is diagnostics."""
        feed_stats = self.feed_cache.stats() if self.feed_cache else {}
        auth = self.client.auth_state()
        authed = bool(auth.get("verified"))
        payload = {
            "ok": True,
            "authed": authed,
            "source": "motilal",
            "ts": contract.iso_now(),
            "service": "moapi-service",
            "dryRun": self.config.dry_run,
            "uptimeS": int(_now() - self.started_at),
            "auth": auth,
            "instrument": self.master.stats(),
            "feed": {
                "enabled": self.config.ws_enabled,
                "connected": bool(self.feed and self.feed.connected),
                "registered": len(self.feed.registered) if self.feed else 0,
                "registeredIndexes": sorted(self.feed.registered_indexes) if self.feed else [],
                "maxBroadcastLimit": self.config.ws_max_scrips,
                "lastMessageAt": feed_stats.get("lastMessageAt"),
                "messageCount": feed_stats.get("messageCount"),
                "byType": feed_stats.get("byType"),
            },
            "config": self.config.public_summary(),
        }
        if self.config.dry_run:
            payload["ok"] = False
            payload["error"] = "dry-run: authentication is disabled"
        elif not authed:
            payload["error"] = self.client.last_error or "not authenticated"
        return payload

    # ── LTP ──
    def ltp(self, tradingsymbol=None, scripcode=None, symbol=None, expiry=None,
            strike=None, option_type=None, use_feed=True):
        """Resolve a live price. Returns a dict; raises MoError on failure.

        Order of preference: the on-disk LTP cache (TTL) → the broadcast feed
        (live, rupees) → the REST endpoint (paise, works outside market hours).
        """
        contract, reason = self.master.resolve(
            tradingsymbol=tradingsymbol, scripcode=scripcode, symbol=symbol,
            expiry=expiry, strike=strike, option_type=option_type,
        )
        if not contract:
            raise MoError(NO_DATA, reason or "contract not found")

        exchange = contract.get("exchange") or "NSEFO"
        code = contract.get("scripcode")
        result = {
            "tradingsymbol": contract.get("tradingsymbol"),
            "symbol": contract.get("symbol"),
            "exchange": exchange,
            "scripcode": code,
            "expiry": contract.get("expiry"),
            "strike": contract.get("strike"),
            "optionType": contract.get("optionType"),
            "instrumentType": contract.get("instrumentType"),
            "lotSize": contract.get("lotSize"),
            "tickSize": contract.get("tickSize"),
        }

        cache_key = contract.get("tradingsymbol") or ("scrip:%s" % code)
        cached = self._ltp_cache.get(cache_key)
        if cached and cached.get("ltp"):
            result.update({
                "ltp": cached.get("ltp"),
                "source": cached.get("source") or "moapi-rest",
                "ts": cached.get("ts"),
                "cached": True,
            })
            return result

        # 1) The broadcast feed (live, rupees, carries OI).
        feed_quote = None
        if use_feed and self.feed_cache:
            feed_quote = self.feed_cache.quote(code)
        if feed_quote and feed_quote.get("ltp"):
            result.update({
                "ltp": feed_quote.get("ltp"),
                "source": "moapi-websocket",
                "priceVerified": True,
                "feedTime": feed_quote.get("exchangeTime"),
                "ts": feed_quote.get("ts"),
            })
            if feed_quote.get("oi") is not None:
                result["openInterest"] = feed_quote.get("oi")
            self._ltp_cache.set(cache_key, {
                "ltp": feed_quote.get("ltp"),
                "source": "moapi-websocket",
                "ts": feed_quote.get("ts"),
            })
            return result

        # 2) The REST endpoint (paise, works outside market hours).
        try:
            data = self.client.get_ltp(exchange, code)
        except MoError as exc:
            if exc.kind == SESSION_EXPIRED:
                try:
                    self.client.relogin("ltp: %s" % exc.message)
                    if self.feed is not None:
                        self.feed.sync_auth(self.client.sdk)
                    data = self.client.get_ltp(exchange, code)
                except MoError:
                    raise
            else:
                raise
        raw = data.get("ltp")
        price, scale, verified = scale_for_price(raw, contract)
        if price is None or price <= 0:
            raise MoError(NO_DATA, "MO LTP record has no price for %s" % (contract.get("tradingsymbol") or code))
        result.update({
            "ltp": round(price, 2),
            "source": "moapi-rest",
            "priceScale": scale,
            "priceVerified": verified,
            "open": self._scaled(data.get("open"), scale),
            "high": self._scaled(data.get("high"), scale),
            "low": self._scaled(data.get("low"), scale),
            "close": self._scaled(data.get("close"), scale),
            "prevClose": self._scaled(data.get("close"), scale),
            "volume": data.get("volume"),
            "ts": _now(),
        })
        self._ltp_cache.set(cache_key, {
            "ltp": result["ltp"],
            "source": "moapi-rest",
            "ts": result["ts"],
        })
        return result

    def _scaled(self, raw, scale):
        if raw is None or not scale:
            return None
        try:
            return round(float(raw) / scale, 2)
        except (TypeError, ValueError):
            return None

    # ── OI ──
    def open_interest(self, tradingsymbol=None, scripcode=None, symbol=None, expiry=None,
                      strike=None, option_type=None):
        """The open interest of one contract.

        MO's REST API does not carry OI (verified live 2026-10-20: the
        `GetLtp` payload has no OI field), so the value comes from the
        broadcast feed. `oiChange` is the change since the previous OI the
        feed reported for this contract.
        """
        contract, reason = self.master.resolve(
            tradingsymbol=tradingsymbol, scripcode=scripcode, symbol=symbol,
            expiry=expiry, strike=strike, option_type=option_type,
        )
        if not contract:
            raise MoError(NO_DATA, reason or "contract not found")
        if not self.feed_cache:
            raise MoError(SOURCE_UNAVAILABLE,
                          "websocket feed is not running — MO has no REST open-interest endpoint "
                          "(set MOAPI_WEBSOCKET=1 to enable the broadcast feed)")
        quote = self.feed_cache.quote(contract.get("scripcode"))
        oi_value = quote.get("oi") if quote else None
        previous = quote.get("prevOi") if quote else None
        change = None
        if oi_value is not None and previous is not None:
            try:
                change = int(oi_value) - int(previous)
            except (TypeError, ValueError):
                change = None
        return {
            "tradingsymbol": contract.get("tradingsymbol"),
            "scripcode": contract.get("scripcode"),
            "exchange": contract.get("exchange"),
            "oi": oi_value,
            "oiChange": change,
            "oiHigh": quote.get("oiHigh") if quote else None,
            "oiLow": quote.get("oiLow") if quote else None,
            "exchangeTime": quote.get("exchangeTime") if quote else None,
            "ts": quote.get("ts") if quote else None,
            "source": "websocket",
        }

    # ── depth ──
    def depth(self, tradingsymbol=None, scripcode=None, symbol=None, expiry=None,
              strike=None, option_type=None):
        """The 5-level market depth of one contract.

        `bids` / `asks` are [[price, quantity], ...] — best level first.
        """
        contract, reason = self.master.resolve(
            tradingsymbol=tradingsymbol, scripcode=scripcode, symbol=symbol,
            expiry=expiry, strike=strike, option_type=option_type,
        )
        if not contract:
            raise MoError(NO_DATA, reason or "contract not found")
        if not self.feed_cache:
            raise MoError(SOURCE_UNAVAILABLE,
                          "websocket feed is not running — MO has no REST market-depth endpoint "
                          "(set MOAPI_WEBSOCKET=1 to enable the broadcast feed)")
        levels = self.feed_cache.depth(contract.get("scripcode"))
        if not levels:
            raise MoError(NO_DATA, "no market depth received for %s yet" %
                          (contract.get("tradingsymbol") or contract.get("scripcode")))
        bids = []
        asks = []
        for level in sorted(levels.keys(), key=lambda k: int(k)):
            entry = levels[level]
            bid, bid_qty = entry.get("bid"), entry.get("bidQty")
            ask, ask_qty = entry.get("ask"), entry.get("askQty")
            if bid is not None and bid > 0:
                bids.append([bid, bid_qty])
            if ask is not None and ask > 0:
                asks.append([ask, ask_qty])
        return {
            "tradingsymbol": contract.get("tradingsymbol"),
            "scripcode": contract.get("scripcode"),
            "exchange": contract.get("exchange"),
            "bids": bids,
            "asks": asks,
            "ts": _now(),
            "source": "websocket",
        }

    # ── instrument master ──
    def instrument(self, force=False):
        """The instrument master, in full (the service-level view)."""
        contracts = self.master.load(force=force)
        return {
            "fetchedAt": self.master.fetched_at,
            "ttlS": self.config.instrument_ttl,
            "count": len(contracts),
            "exchanges": dict(self.master.exchanges),
            "lotSizes": self.master.lot_sizes,
            "contracts": contracts,
        }

    def instrument_response_bytes(self, force=False):
        """The /instrument body, pre-serialized.

        The MO master is ~126k contracts (~30 MB of JSON). The heavy array is
        serialized once and cached; only the envelope's `ts` is fresh per
        request. The body is byte-for-byte the same shape as
        `contract.instrument()`.
        """
        self.master.load(force=force)
        return contract.instrument_envelope_bytes(self.master.array_bytes())
