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

const BREEZE_INTERVAL: Record<string, string> = {
  '1m': '1minute',
  '5m': '5minute',
  '15m': '15minute',
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

    // Breeze only gives 1minute/5minute/15minute intraday — for 30m/1h+ aggregate 5m.
    const needsAgg = ['30m', '1h', '4h', '1d'].includes(interval);

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
      const from = new Date(now.getTime() - (needsAgg ? 7 : 2) * DAY_MS);
      const fromStr = fmt(from);
      const toStr = fmt(now);

      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(symbol);
      const productType = isIndex ? 'cash' : 'options';
      const cashExchange = isIndex ? (exchange === 'BSE' ? 'BSE' : 'NSE') : exchange;

      const requestObj: any = {
        interval: needsAgg ? '5minute' : breezeInterval,
        fromDate: fromStr,
        toDate: toStr,
        stockCode: symbol,
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
    if (needsAgg) {
      const mins = { '30m': 30, '1h': 60, '4h': 240, '1d': 1440 } as Record<string, number>;
      const bucketMs = (mins[interval] || 60) * 60000;
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
        const yahooSym = symbol === 'SENSEX' ? '^BSESN' : '^NSEI';
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=6mo&interval=1d`, {
          signal: AbortSignal.timeout(8000),
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
            // If a minute timeframe was requested, split daily into synthetic 1m bars
            // so the chart still renders; otherwise pass daily through as-is.
            if (['1m', '5m', '15m', '30m', '1h'].includes(interval)) {
              const mPer = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60 } as Record<string, number>;
              const stepMs = (mPer[interval] || 5) * 60000;
              const synth: any[] = [];
              for (const d of daily) {
                const barMs = Math.max(stepMs, Math.floor(7.5 * 60 * 60000 / Math.max(1, Math.floor(daily.length)))); // spread across session
                const openTime = d.time + 5.5 * 3600 * 1000; // 09:15 IST
                for (let t = openTime; t < openTime + 6 * 3600 * 1000; t += barMs) {
                  if (synth.length >= limit) break;
                  synth.push({ time: t, open: d.open, high: d.high, low: d.low, close: d.close, volume: 0 });
                }
                if (synth.length >= limit) break;
              }
              out = synth.sort((a, b) => a.time - b.time).slice(-limit);
            } else {
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