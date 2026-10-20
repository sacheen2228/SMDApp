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
  const breeze = await fetchBreezeCandles(symbol, interval, limit);
  if (breeze.length > 0) return breeze;

  // The exchange's free daily history — a DAILY request only.
  if (DAILY_INTERVALS.has(String(interval || '').toLowerCase())) {
    const nse = await fetchNSEDailyCandles(symbol, limit);
    if (nse.length > 0) return nse;
  }

  console.warn(
    `[Historical Data] No real source for ${symbol} @ ${interval} — returning an empty series`
  );
  return [];
}
