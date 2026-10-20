#!/usr/bin/env python3
"""
Tick -> candle builder (1m / 5m / 15m), NSE session aligned (buckets start 09:15 IST).

Feed it ticks from any broker websocket (e.g. Motilal Oswal Broadcast):
    cb = CandleBuilder("NIFTY", tfs=(1, 5, 15), volume_is_cumulative=True)
    cb.on_close = lambda sym, tf, candle: print(sym, tf, candle)
    cb.on_tick(ts_datetime_ist, ltp, day_volume)

Only CLOSED candles are returned by closed(tf). The forming candle is available
via forming(tf) for display, but structure logic must never use it (it repaints).
"""
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
SESSION_OPEN = (9, 15)
SESSION_CLOSE = (15, 30)


class CandleBuilder:
    def __init__(self, symbol, tfs=(1, 5, 15), volume_is_cumulative=True, max_candles=500):
        self.symbol, self.tfs = symbol, tuple(tfs)
        self.cum = volume_is_cumulative
        self.max = max_candles
        self._closed = {tf: [] for tf in self.tfs}
        self._forming = {tf: None for tf in self.tfs}
        self._last_cum = None
        self.on_close = None  # callback(symbol, tf, candle_dict)

    def _bucket_start(self, ts, tf):
        ts = ts.astimezone(IST)
        open_dt = ts.replace(hour=SESSION_OPEN[0], minute=SESSION_OPEN[1], second=0, microsecond=0)
        if ts < open_dt: return None
        k = int((ts - open_dt).total_seconds() // (tf * 60))
        return open_dt + timedelta(minutes=k * tf)

    def _qty(self, volume):
        """Convert broker volume to per-tick quantity."""
        if volume is None: return 0
        if not self.cum: return volume
        if self._last_cum is None or volume < self._last_cum:  # first tick or new day reset
            self._last_cum = volume
            return 0
        q = volume - self._last_cum
        self._last_cum = volume
        return q

    def on_tick(self, ts, price, volume=None):
        if price is None or price <= 0: return
        ts = ts.astimezone(IST) if ts.tzinfo else ts.replace(tzinfo=IST)
        close_dt = ts.replace(hour=SESSION_CLOSE[0], minute=SESSION_CLOSE[1], second=0, microsecond=0)
        if ts > close_dt: return
        q = self._qty(volume)
        for tf in self.tfs:
            start = self._bucket_start(ts, tf)
            if start is None: continue
            f = self._forming[tf]
            if f is not None and f["t"] != start.isoformat():
                self._closed[tf].append(f)
                self._closed[tf] = self._closed[tf][-self.max:]
                if self.on_close: self.on_close(self.symbol, tf, f)
                f = None
            if f is None:
                self._forming[tf] = {"t": start.isoformat(), "o": price, "h": price, "l": price, "c": price, "v": q}
            else:
                f["h"] = max(f["h"], price); f["l"] = min(f["l"], price)
                f["c"] = price; f["v"] += q

    def flush(self, ts=None):
        """Close forming candles whose bucket has ended (call on a timer or at 15:30)."""
        ts = (ts or datetime.now(IST)).astimezone(IST)
        for tf in self.tfs:
            f = self._forming[tf]
            if f and datetime.fromisoformat(f["t"]) + timedelta(minutes=tf) <= ts:
                self._closed[tf].append(f); self._forming[tf] = None
                if self.on_close: self.on_close(self.symbol, tf, f)

    def closed(self, tf): return list(self._closed[tf])
    def forming(self, tf): return dict(self._forming[tf]) if self._forming[tf] else None
