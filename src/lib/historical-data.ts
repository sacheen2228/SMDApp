// Historical Data Provider - Fetches candles from Breeze (real) or Yahoo (fallback)

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

function fmtDate(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

function roundToTick(price: number, tick: number = 0.05): number {
  return Math.round(price / tick) * tick;
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

export async function getHistoricalCandles(
  symbol: string,
  interval: string = '5m',
  limit: number = 300
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
    console.warn('[Historical Data] Breeze failed, falling back to Yahoo:', e);
  }

  // Fallback: Yahoo Finance
  return getYahooCandles(symbol, interval, limit);
}

async function getYahooCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  const yahooSymbol = getYahooSymbol(symbol);
  const yahooInterval = mapIntervalToYahoo(interval);
  const range = mapIntervalToRange(interval);

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${yahooInterval}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result?.timestamp || !result?.indicators?.quote?.[0]) return [];

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: Candle[] = [];

    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null) continue;
      candles.push({
        time: ts[i] * 1000,
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] || 0,
      });
    }

    return candles.slice(-limit);
  } catch (e) {
    console.error('[Historical Data] Yahoo failed:', e);
    return [];
  }
}

function getYahooSymbol(symbol: string): string {
  const map: Record<string, string> = {
    NIFTY: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    FINNIFTY: '^CNXFIN',
    MIDCPNIFTY: '^NSEMDCP50',
    SENSEX: '^BSESN',
    BANKEX: '^BSESN',
  };
  return map[symbol.toUpperCase()] || `${symbol.toUpperCase()}.NS`;
}

function mapIntervalToYahoo(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '60m',
    '1d': '1d',
    '1w': '1wk',
    '1M': '1mo',
  };
  return map[interval] || '5m';
}

function mapIntervalToRange(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1d',
    '5m': '5d',
    '15m': '5d',
    '30m': '1mo',
    '1h': '3mo',
    '1d': '2y',
    '1w': '5y',
    '1M': '10y',
  };
  return map[interval] || '1mo';
}