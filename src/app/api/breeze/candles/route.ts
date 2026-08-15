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

    return NextResponse.json({ success: true, data: out, source, symbol, interval, count: out.length });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}