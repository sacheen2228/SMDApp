// Historical Data Provider — REAL candles only.
//
//   1. Breeze  — the broker's own history (any interval, needs a session)
//   2. The exchange's own DAILY history (free NSE) — a DAILY request only
//   3. Nothing → an EMPTY series (never a fabricated one)
//
// Yahoo used to be the fallback. It is banned by the data policy (AGENTS.md):
// it was a third-party, delayed, adjusted series pushed into the app as if it
// were the exchange's own — and for an INTRADAY request it was a DAILY series
// dressed up as 5-minute candles.
//
// A daily source is never served for an intraday request (no timeframe
// substitution): an intraday request with no intraday source returns [] and
// the caller reports "no data" instead of a plausible-looking series.

import { initSession, getBreezeClient } from '@/lib/icici-breeze/auth';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1minute',
  '3m': '5minute',
  '5m': '5minute',
  '15m': '15minute',
  '30m': '30minute',
  '1h': '60minute',
  '4h': '60minute',
  '1d': '1day',
  '1w': '1week',
  '1M': '1month',
};

/** The intervals the exchange's free daily history can answer. */
const DAILY_INTERVALS = new Set(['1d', '1day', 'day', 'daily', '1w', '1week', 'week', '1M', '1month', 'month']);

function fmtDate(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

function isIndexSymbol(symbol: string): boolean {
  const indices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
  return indices.includes(symbol.toUpperCase());
}

function getBreezeStockCode(symbol: string): string {
  const map: Record<string, string> = {
    NIFTY: 'NIFTY',
    BANKNIFTY: 'CNXBAN',
    FINNIFTY: 'NIFFIN',
    MIDCPNIFTY: 'NIFMID',
    SENSEX: 'BSESEN',
    BANKEX: 'BSESEN',
  };
  return map[symbol.toUpperCase()] || symbol.toUpperCase();
}

function getBreezeExchange(symbol: string): string {
  const bse = ['SENSEX', 'BANKEX'];
  return bse.includes(symbol.toUpperCase()) ? 'BSE' : 'NSE';
}

/**
 * The broker's own history. Returns [] when the session is dead, the request
 * fails, or the range holds no rows — never a synthetic candle.
 */
async function fetchBreezeCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  try {
    await initSession();
    const breeze = getBreezeClient();
    const breezeInterval = INTERVAL_MAP[interval] || '5minute';

    const now = new Date();
    const lookbackDays = interval === '1d' ? 200 : interval === '1w' ? 500 : interval === '1M' ? 1000 : 7;
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const fromStr = fmtDate(from);
    const toStr = fmtDate(now);

    const isIndex = isIndexSymbol(symbol);
    const stockCode = getBreezeStockCode(symbol);
    const exchangeCode = getBreezeExchange(symbol);
    const productType = isIndex ? 'cash' : 'futures';

    const requestObj: any = {
      interval: breezeInterval,
      fromDate: fromStr,
      toDate: toStr,
      stockCode,
      exchangeCode,
      productType,
    };

    if (!isIndex) {
      requestObj.expiryDate = '';
      requestObj.right = '';
      requestObj.strikePrice = '';
    }

    const result = await breeze.getHistoricalDatav2(requestObj);

    if (result && !result.Error && result.Status !== 401) {
      const raw = result.Success || result.data || result || [];
      const candles: Candle[] = [];

      for (const c of raw) {
        const timeStr = c.time || c.datetime || c.timestamp;
        if (!timeStr) continue;
        const t = new Date(timeStr).getTime();
        if (isNaN(t)) continue;

        const open = Number(c.open ?? c.o);
        const high = Number(c.high ?? c.h);
        const low = Number(c.low ?? c.l);
        const close = Number(c.close ?? c.c);
        const volume = Number(c.volume ?? c.v ?? 0);

        if (!open || !high || !low || !close) continue;
        candles.push({ time: t, open, high, low, close, volume });
      }

      if (candles.length > 0) {
        return candles.sort((a, b) => a.time - b.time).slice(-limit);
      }
    }
  } catch (e) {
    console.warn('[Historical Data] Breeze failed:', e);
  }
  return [];
}

/**
 * The exchange's own DAILY history (free NSE) — the NSE F&O/equity history
 * endpoint. Real daily OHLCV straight from the exchange.
 *
 * This is a DAILY series: it is only ever served for a daily request. An
 * intraday request is never answered with daily bars.
 */
async function fetchNSEDailyCandles(symbol: string, limit: number): Promise<Candle[]> {
  try {
    const { getNSEHistoricalData } = await import('@/lib/nse-api');
    const to = new Date();
    const from = new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000);
    const bars = await getNSEHistoricalData(symbol, from, to);
    if (!Array.isArray(bars) || bars.length === 0) return [];

    const out: Candle[] = [];
    for (const b of bars as any[]) {
      const open = Number(b?.chOpeningPrice);
      const high = Number(b?.chTradeHighPrice);
      const low = Number(b?.chTradeLowPrice);
      const close = Number(b?.chClosingPrice);
      if (!open || !high || !low || !close) continue;
      const ts = new Date(b?.mtimestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      out.push({
        time: ts,
        open,
        high,
        low,
        close,
        volume: Number(b?.chTotTradedQty || 0),
      });
    }
    if (out.length === 0) return [];
    return out.sort((a, b) => a.time - b.time).slice(-limit);
  } catch (e) {
    console.warn('[Historical Data] NSE daily history failed:', e);
    return [];
  }
}

/**
 * Breeze getHistoricalDatav2 accepts only 1second/1minute/5minute/30minute/1day.
 * For any other intraday interval (15m, 1h, …) we fetch real 5m bars and
 * aggregate them into session-aligned buckets — real data only, never a
 * different timeframe dressed up as the requested one.
 */
const AGGREGATE_FROM_5M: Record<string, number> = {
  '3m': 3,
  '15m': 15,
  '1h': 60,
  '4h': 240,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SESSION_OPEN_MS = 9 * 60 * 60 * 1000 + 15 * 60 * 1000; // 09:15 IST

function aggregate5m(candles: Candle[], targetMinutes: number): Candle[] {
  const bucketMs = targetMinutes * 60_000;
  const groups = new Map<number, Candle>();
  for (const c of candles) {
    const ist = c.time + IST_OFFSET_MS;
    const istDay = Math.floor(ist / 86_400_000) * 86_400_000;
    const sessionOpen = istDay + SESSION_OPEN_MS - IST_OFFSET_MS;
    const key = istDay + Math.floor((c.time - sessionOpen) / bucketMs);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...c });
    } else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
      if (c.time > g.time) g.time = c.time;
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

/**
 * The candle series for `symbol`.
 *
 * Returns [] when no real source has the data — the caller then reports
 * "no data" (an honest empty result), never a plausible-looking series.
 */
export async function getHistoricalCandles(
  symbol: string,
  interval: string = '5m',
  limit: number = 300
): Promise<Candle[]> {
  const iv = String(interval || '').toLowerCase();
  const aggMinutes = AGGREGATE_FROM_5M[iv];

  if (aggMinutes) {
    // 3 bars of 5m per 15m bar (2 per 30m…): over-fetch then bucket.
    const raw = await fetchBreezeCandles(symbol, '5m', limit * Math.ceil(aggMinutes / 5) + 10);
    if (raw.length > 0) {
      return aggregate5m(raw, aggMinutes).slice(-limit);
    }
    console.warn(
      `[Historical Data] No real 5m source to aggregate ${symbol} @ ${interval} — returning an empty series`
    );
    return [];
  }

  const breeze = await fetchBreezeCandles(symbol, interval, limit);
  if (breeze.length > 0) return breeze;

  // The exchange's free daily history — a DAILY request only.
  if (DAILY_INTERVALS.has(iv)) {
    const nse = await fetchNSEDailyCandles(symbol, limit);
    if (nse.length > 0) return nse;
  }

  console.warn(
    `[Historical Data] No real source for ${symbol} @ ${interval} — returning an empty series`
  );
  return [];
}
