"""Websocket broadcast subscriber — the LIVE per-contract feed.

What the feed gives us (all verified live on 2026-10-20):

  LTP          the last traded price of a registered contract, IN RUPEES
               (the REST `GetLtp` endpoint returns the same number in PAISE)
  OpenInterest the contract's open interest, delivered inside the LTP
               packet as `LTP_Open Interest` (and in its own `OpenInterest`
               message during market hours)
  MarketDepth  5 levels of bid/ask (message types B..F)
  Index        the index feed (NIFTY 50, NIFTY BANK, ...) — `IndexRegister`

The SDK is used UNMODIFIED: `MOFSLOPENAPI` dispatches every decoded packet
to `self._Broadcast_on_message(ws, message_type, message)`, which is the hook
this subclass overrides to fill the cache.

SUBSCRIPTION COST
-----------------
* MO caps the number of scripts per broadcast connection
  (`getbroadcastmaxlimit`, default 200). We register at most
  `MOAPI_WS_MAX_SCRIPS` contracts and never more.
* The feed is a push stream: one connection, one packet per change. There is
  NO polling cost per symbol.
* Registration is per CONTRACT, so the list is normally the near-the-money
  strikes of the symbols we trade, not the whole F&O master (86k rows).
* To enable the feed: `MOAPI_WEBSOCKET=1` (it is OFF by default). The REST
  endpoints (LTP + instrument master) work without it; `/oi` and `/depth` then
  answer 503 with the reason "websocket feed is not running". The older name
  `MOAPI_WS_ENABLED=1` still works.
"""

import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR_DIR = os.path.join(os.path.dirname(HERE), "vendor")
if VENDOR_DIR not in sys.path:
    sys.path.append(VENDOR_DIR)

from MOFSLOPENAPI import MOFSLOPENAPI  # noqa: E402

# MO exchange codes used by the broadcast Register packet.
EXCHANGE_CODES = {
    "NSE": "N",
    "NSEFO": "N",
    "BSE": "B",
    "BSEFO": "G",
    "MCX": "M",
    "NSECD": "C",
    "NCDEX": "D",
}

# The exchange-type byte tells the feed whether the contract is cash or F&O.
EXCHANGE_TYPE_CODES = {
    "CASH": "C",
    "FNO": "F",
    "COMMODITY": "C",
    "C": "C",
    "F": "F",
}


class FeedCache(object):
    """Thread-safe cache of the last broadcast packet per contract."""

    def __init__(self):
        self._lock = threading.RLock()
        self._quotes = {}          # scripcode -> {ltp, oi, ts, ...}
        self._depth = {}           # scripcode -> {level -> {bid, qty, ...}}
        self._index = {}           # scripcode -> {rate, ts}
        self._last_message_at = 0.0
        self._message_count = 0
        self._by_type = {}

    def record(self, message_type, message):
        if not isinstance(message, dict):
            return
        now = time.time()
        scrip = message.get("Scrip Code")
        with self._lock:
            self._last_message_at = now
            self._message_count += 1
            self._by_type[message_type] = self._by_type.get(message_type, 0) + 1
            if message_type == "LTP":
                entry = self._quotes.setdefault(scrip, {})
                entry["ltp"] = message.get("LTP_Rate")
                entry["qty"] = message.get("LTP_Qty")
                entry["cumulativeQty"] = message.get("LTP_Cumulative Qty")
                entry["avgTradePrice"] = message.get("LTP_AvgTradePrice")
                if message.get("LTP_Open Interest") is not None:
                    entry["prevOi"] = entry.get("oi")
                    entry["oi"] = message.get("LTP_Open Interest")
                entry["ts"] = now
                entry["exchangeTime"] = message.get("Time")
                entry["exchange"] = message.get("Exchange")
            elif message_type == "OpenInterest":
                entry = self._quotes.setdefault(scrip, {})
                entry["prevOi"] = entry.get("oi")
                entry["oi"] = message.get("Open Interest")
                entry["oiHigh"] = message.get("Open Interest High")
                entry["oiLow"] = message.get("Open Interest Low")
                entry["ts"] = now
                entry["exchangeTime"] = message.get("Time")
            elif message_type == "MarketDepth":
                level = message.get("Level")
                per_scrip = self._depth.setdefault(scrip, {})
                per_scrip[str(level)] = {
                    "bid": message.get("BidRate"),
                    "bidQty": message.get("BidQty"),
                    "bidOrders": message.get("BidOrder"),
                    "ask": message.get("OfferRate"),
                    "askQty": message.get("OfferQty"),
                    "askOrders": message.get("OfferOrder"),
                    "ts": now,
                }
            elif message_type == "Index":
                self._index[scrip] = {
                    "rate": message.get("Rate"),
                    "ts": now,
                    "exchangeTime": message.get("Time"),
                    "exchange": message.get("Exchange"),
                }
            elif message_type == "DayOHLC":
                entry = self._quotes.setdefault(scrip, {})
                entry["prevDayClose"] = message.get("PrevDayClose")
                entry["ts"] = now

    def quote(self, scripcode):
        with self._lock:
            entry = self._quotes.get(scripcode)
            return dict(entry) if entry else None

    def depth(self, scripcode):
        with self._lock:
            per_scrip = self._depth.get(scripcode)
            return dict(per_scrip) if per_scrip else None

    def index_quote(self, scripcode):
        with self._lock:
            entry = self._index.get(scripcode)
            return dict(entry) if entry else None

    def stats(self):
        with self._lock:
            return {
                "quotes": len(self._quotes),
                "depth": len(self._depth),
                "indices": len(self._index),
                "messageCount": self._message_count,
                "lastMessageAt": self._last_message_at,
                "byType": dict(self._by_type),
            }


class BroadcastFeed(MOFSLOPENAPI):
    """The SDK with the message hook overridden to fill the cache."""

    def __init__(self, api_key, base_url, secret_key, cache, logger=None):
        super(BroadcastFeed, self).__init__(
            api_key, base_url, None, "WEB", "Chrome", "120.0", secret_key
        )
        self.cache = cache
        self.log = logger
        self.registered = set()
        self._registered_args = {}
        self._lock = threading.RLock()
        self.connected = False
        self.registered_indexes = set()

    # The SDK routes EVERY decoded packet here.
    def _Broadcast_on_message(self, ws, message_type, message):
        self.cache.record(message_type, message)

    def _Broadcast_on_open(self, ws):
        self.connected = True
        if self.log:
            self.log.info("mo.feed.connected")
        # The SDK's own on_open already sent the login packet; re-register the
        # scripts we care about (a reconnect starts with an empty list).
        try:
            for scrip in list(self.registered):
                self.Register(*self._registered_args.get(scrip, ("NSEFO", "FNO", scrip)))
            for exch in list(self.registered_indexes):
                self.IndexRegister(exch)
        except Exception as exc:  # noqa: BLE001
            if self.log:
                self.log.warn("mo.feed.reregister.failed", error=str(exc))

    def _Broadcast_on_close(self, ws, close_status_code, close_msg):
        self.connected = False
        if self.log:
            self.log.info("mo.feed.closed", code=close_status_code)

    def register(self, exchange, exchange_type, scripcode):
        """Subscribe to one contract."""
        with self._lock:
            self._registered_args[int(scripcode)] = (exchange, exchange_type, int(scripcode))
            self.Register(exchange, exchange_type, int(scripcode))
            self.registered.add(int(scripcode))
            return True

    def register_index(self, exchange):
        with self._lock:
            self.IndexRegister(exchange)
            self.registered_indexes.add(exchange)
            return True

    def unregister(self, exchange, exchange_type, scripcode):
        with self._lock:
            try:
                self.UnRegister(exchange, exchange_type, int(scripcode))
            except Exception:  # noqa: BLE001
                pass
            self.registered.discard(int(scripcode))
            self._registered_args.pop(int(scripcode), None)

    def connect(self):
        self.Broadcast_connect()

    def sync_auth(self, sdk):
        """Copy the authenticated session from the REST client.

        The feed is a SEPARATE SDK instance: without the auth token the
        broker rejects every Register packet ("Authorization is InVaild In
        Header Parameter"), and the login packet carries the client code.
        """
        if sdk is None:
            return
        self.m_strMOFSLToken = getattr(sdk, "m_strMOFSLToken", "")
        self.m_strAccessToken = getattr(sdk, "m_strAccessToken", "")
        self.m_clientcode = getattr(sdk, "m_clientcode", "")
        self.m_vendorinfo = getattr(sdk, "m_vendorinfo", "")

    def disconnect(self):
        try:
            self.Broadcast_Logout()
        except Exception:  # noqa: BLE001
            pass
