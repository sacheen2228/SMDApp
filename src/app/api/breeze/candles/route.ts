// Breeze historical candles API for the India market chart.
// GET /api/breeze/candles?symbol=NIFTY&interval=1m&limit=300
// Returns intraday candles aggregated from Breeze real data.
// Falls back to the option-chain spot when Breeze is unavailable.

import { initSession, getBreezeClient } from "@/lib/icici-breeze/auth";
import { NextResponse } from "next/server";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EXCHANGE_CODE: Record<string, string> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  FINNIFTY: "NSE",
  MIDCPNIFTY: "NSE",
  SENSEX: "BSE",
  BANKEX: "BSE",
};

// Breeze internal stock codes — the public symbols differ from Breeze's codes.
const STOCK_CODE: Record<string, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "CNXBAN",
  FINNIFTY: "NIFFIN",
  MIDCPNIFTY: "NIFMID",
  SENSEX: "BSESEN",
  BANKEX: "BSESEN",
};

// Breeze intraday works for 1minute and 5minute. 15minute returns 0 rows for
// indices, so everything ≥15m is aggregated from 5minute bars instead.
const BREEZE_INTERVAL: Record<string, string> = {
  '1m': '1minute',
  '5m': '5minute',
};

const YAHOO_SYMBOL: Record<string, string> = {
  NIFTY: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  FINNIFTY: "^CNXFIN",
  MIDCPNIFTY: "^NSEMDCP50",
  SENSEX: "^BSESN",
  BANKEX: "^BSESN",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function istDateStr(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
    const interval = searchParams.get('interval') || '1m';
    const limit = Math.min(parseInt(searchParams.get('limit') || '300'), 1000);
    const exchange = EXCHANGE_CODE[symbol] || 'NSE';
    const breezeInterval = BREEZE_INTERVAL[interval] || '5minute';

    // Breeze only gives 1minute/5minute/15minute intraday. Map each requested
    // TradingView timeframe to a Breeze source interval + an aggregation bucket.
    const AGG_MIN: Record<string, number> = {
      '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
      '1h': 60, '2h': 120, '4h': 240, '6h': 360,
    };
    const dailyLike = ['1d', '1w', '1M'].includes(interval);
    // 3m aggregates from 1m; everything else (15m+) aggregates from 5m
    // because Breeze's 15minute interval returns 0 rows for indices.
    const needsAgg = !dailyLike && AGG_MIN[interval] && !BREEZE_INTERVAL[interval];
    const aggMin = AGG_MIN[interval];
    const sourceInterval = interval === '3m' ? '1minute' : (needsAgg ? '5minute' : (BREEZE_INTERVAL[interval] || '5minute'));

    const candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    let source: 'breeze' | 'unavailable' = 'unavailable';

    try {
      await initSession();
      const breeze = getBreezeClient();

      const fmt = (d: Date) => {
        const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
      };

      const now = new Date();
      // For daily/weekly/monthly fetch a longer lookback of 5m bars.
      const lookbackDays = dailyLike ? (interval === '1M' ? 400 : interval === '1w' ? 180 : 30) : (needsAgg || interval === '3m' ? 3 : 2);
      const from = new Date(now.getTime() - lookbackDays * DAY_MS);
      const fromStr = fmt(from);
      const toStr = fmt(now);

      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(symbol);
      const productType = isIndex ? 'cash' : 'options';
      const cashExchange = isIndex ? (exchange === 'BSE' ? 'BSE' : 'NSE') : exchange;

      const requestObj: any = {
        interval: sourceInterval,
        fromDate: fromStr,
        toDate: toStr,
        stockCode: STOCK_CODE[symbol] || symbol,
        exchangeCode: cashExchange,
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
        for (const c of raw) {
          const timeStr = c.time || c.datetime || c.timestamp;
          if (!timeStr) continue;
          const open = Number(c.open ?? c.o);
          const high = Number(c.high ?? c.h);
          const low = Number(c.low ?? c.l);
          const close = Number(c.close ?? c.c);
          if (!open && !high && !low && !close) continue;
          const t = new Date(timeStr).getTime();
          if (!isNaN(t)) {
            candles.push({ time: t, open, high, low, close, volume: Number(c.volume ?? c.v ?? 0) });
          }
        }
        source = 'breeze';
      }
    } catch (e: any) {
      console.error('[Breeze Candles] error:', e.message);
    }

    // Aggregate to requested interval if needed.
    let out = candles.sort((a, b) => a.time - b.time);
    if (dailyLike) {
      // Daily/weekly/monthly: bucket 5m bars by day, then 7-days, then calendar month.
      const dayBuckets = new Map<number, any>();
      for (const c of out) {
        const dayStart = Math.floor(c.time / 86400000) * 86400000;
        const ex = dayBuckets.get(dayStart);
        if (!ex) dayBuckets.set(dayStart, { time: dayStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
        else {
          ex.high = Math.max(ex.high, c.high);
          ex.low = Math.min(ex.low, c.low);
          ex.close = c.close;
          ex.volume += c.volume || 0;
        }
      }
      let daily = Array.from(dayBuckets.values()).sort((a, b) => a.time - b.time);
      if (interval === '1w') {
        const weekBuckets = new Map<number, any>();
        for (const c of daily) {
          const weekStart = Math.floor(c.time / (7 * 86400000)) * 7 * 86400000;
          const ex = weekBuckets.get(weekStart);
          if (!ex) weekBuckets.set(weekStart, { time: weekStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
          else {
            ex.high = Math.max(ex.high, c.high);
            ex.low = Math.min(ex.low, c.low);
            ex.close = c.close;
            ex.volume += c.volume || 0;
          }
        }
        daily = Array.from(weekBuckets.values()).sort((a, b) => a.time - b.time);
      } else if (interval === '1M') {
        const monthBuckets = new Map<string, any>();
        for (const c of daily) {
          const d = new Date(c.time);
          const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
          const ex = monthBuckets.get(key);
          if (!ex) monthBuckets.set(key, { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
          else {
            ex.high = Math.max(ex.high, c.high);
            ex.low = Math.min(ex.low, c.low);
            ex.close = c.close;
            ex.volume += c.volume || 0;
          }
        }
        daily = Array.from(monthBuckets.values()).sort((a, b) => a.time - b.time);
      }
      out = daily.slice(-limit);
    } else if (needsAgg || interval === '3m') {
      const bucketMs = (aggMin || 5) * 60000;
      const buckets = new Map<number, any>();
      for (const c of out) {
        const start = Math.floor(c.time / bucketMs) * bucketMs;
        const ex = buckets.get(start);
        if (!ex) buckets.set(start, { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
        else {
          ex.high = Math.max(ex.high, c.high);
          ex.low = Math.min(ex.low, c.low);
          ex.close = c.close;
          ex.volume += c.volume || 0;
        }
      }
      out = Array.from(buckets.values()).sort((a, b) => a.time - b.time).slice(-limit);
    } else {
      out = out.slice(-limit);
    }

    // Fallback: Yahoo daily candles when Breeze returns nothing
    // (BANKNIFTY/FINNIFTY/MIDCPNIFTY often have no Breeze intraday index data).
    if (out.length === 0) {
      try {
        const yahooSym = YAHOO_SYMBOL[symbol] || '^NSEI';
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${interval === '1M' ? '5y' : interval === '1w' ? '2y' : '6mo'}&interval=1d`, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.ok) {
          const json = await res.json();
          const result = json?.chart?.result?.[0];
          if (result?.timestamp && result?.indicators?.quote?.[0]) {
            const ts = result.timestamp;
            const q = result.indicators.quote[0];
            const daily: any[] = [];
            for (let i = 0; i < ts.length; i++) {
              const close = q.close?.[i];
              if (close == null) continue;
              daily.push({
                time: ts[i] * 1000,
                open: q.open?.[i] ?? close,
                high: q.high?.[i] ?? close,
                low: q.low?.[i] ?? close,
                close,
                volume: q.volume?.[i] || 0,
              });
            }
            if (dailyLike || interval === '15m' || interval === '30m' || interval === '1h' || interval === '2h' || interval === '4h' || interval === '6h') {
              // Daily/weekly/monthly pass daily through; weekly/monthly bucketed.
              // For aggregated intraday timeframes (15m+) we return the real daily
              // bars rather than fabricating flat synthetic candles — the chart
              // renders them truthfully when Breeze has no intraday data.
              let bucket = daily.sort((a, b) => a.time - b.time);
              if (interval === '1w' || interval === '1M') {
                const grouped = new Map<string, any>();
                const isWeek = interval === '1w';
                for (const c of bucket) {
                  const d = new Date(c.time);
                  const key = isWeek ? `${Math.floor(c.time / (7 * 86400000))}` : `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
                  const ex = grouped.get(key);
                  if (!ex) grouped.set(key, { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
                  else {
                    ex.high = Math.max(ex.high, c.high);
                    ex.low = Math.min(ex.low, c.low);
                    ex.close = c.close;
                    ex.volume += c.volume || 0;
                  }
                }
                bucket = Array.from(grouped.values()).sort((a, b) => a.time - b.time);
              }
              out = bucket.slice(-limit);
            } else {
              // Raw intraday (1m/3m/5m) with no Breeze data: also return the real
              // daily bars — no fabricated flat candles.
              out = daily.sort((a, b) => a.time - b.time).slice(-limit);
            }
            source = 'unavailable';
          }
        }
      } catch {}
    }

    return NextResponse.json({ success: true, data: out, source, symbol, interval, count: out.length });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}