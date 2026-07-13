// DEPRECATED: duplicate of /api/option-chain + /api/dom-analysis data.
// Kept on disk until production consolidation is verified.

// Zero Hero AI Engine API
// POST /api/zero-hero
// Runs the full Zero Hero pipeline for an instrument

import { NextRequest, NextResponse } from 'next/server';
import { runZeroHeroEngine } from '@/lib/zero-hero-ai';
import { runZeroHeroScan } from '@/lib/zero-hero-ai/scan-engine';
import { getExpiryData, getExpiryCalendar, getAllExpiriesForInstrument } from '@/lib/expiry-engine';
import { ALL_INSTRUMENTS } from '@/stores/useTerminalStore';
import { getSingleStockDOM } from '@/lib/dom-analysis';
import { fetchIndiaVIX } from '@/lib/yahoo-finance-api';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      instrument,
      spot,
      strikes,
      candles,
      vix,
      atr,
      iv,
      hv,
      capital,
      riskPercent,
    } = body;

    if (!instrument || spot == null || !strikes || !candles) {
      return NextResponse.json(
        { error: 'Missing required fields: instrument, spot, strikes, candles' },
        { status: 400 }
      );
    }

    const result = runZeroHeroEngine({
      instrument,
      spot,
      strikes,
      candles,
      vix: vix ?? 14,
      atr: atr ?? 100,
      iv: iv ?? 15,
      hv: hv ?? 15,
      capital,
      riskPercent,
    });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Zero Hero engine failed' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'expiry';

  if (action === 'expiry') {
    const symbol = searchParams.get('symbol');
    if (symbol) {
      const data = getExpiryData(symbol);
      return NextResponse.json(data);
    }
    const calendar = getExpiryCalendar(ALL_INSTRUMENTS.map(i => i.symbol));
    return NextResponse.json(calendar);
  }

  if (action === 'expiries') {
    const symbol = searchParams.get('symbol');
    if (!symbol) {
      return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    }
    const expiries = getAllExpiriesForInstrument(symbol);
    return NextResponse.json(expiries);
  }

  if (action === 'analyze' || action === 'scan') {
    const symbol = searchParams.get('symbol') || 'NIFTY';
    const capital = Number(searchParams.get('capital') || 100000);
    const riskPercent = Number(searchParams.get('risk') || 2);
    const topN = Number(searchParams.get('topn') || 12);
    const bandwidth = Number(searchParams.get('bw') || 4);

    try {
      const live = await buildLiveInput(symbol, capital, riskPercent);

      if (action === 'analyze') {
        const result = runZeroHeroEngine({
          instrument: symbol,
          spot: live.spot,
          strikes: live.strikes,
          candles: live.candles,
          vix: live.vix,
          atr: live.atr,
          iv: live.iv,
          hv: live.hv,
          capital,
          riskPercent,
        });
      return NextResponse.json({ source: 'live', ...result });
      }

      // scan — full per-strike scan
      const result = runZeroHeroScan({
        instrument: symbol,
        spot: live.spot,
        strikes: live.strikes,
        candles: live.candles,
        vix: live.vix,
        atr: live.atr,
        iv: live.iv,
        hv: live.hv,
        capital,
        riskPercent,
        topN,
        bandwidthPct: bandwidth,
      });
      return NextResponse.json({ source: 'live', ...result });
    } catch (err: any) {
      return NextResponse.json(
        { error: err.message || `Zero Hero ${action} failed` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

interface LiveInput {
  spot: number;
  strikes: any[];
  candles: any[];
  vix: number;
  atr: number;
  iv: number;
  hv: number;
}

async function buildLiveInput(symbol: string, _capital: number, _riskPercent: number): Promise<LiveInput> {
  // 1. Live option chain (DOM analysis) — single symbol only
  const dom = await getSingleStockDOM(symbol);
  if (!dom) {
    throw new Error(`No live option chain for ${symbol}`);
  }

  // 2. Candles (underlying) — only if Breeze session has data
  let candles: any[] = [];
  try {
    const { getIntradayCandles } = await import('@/lib/breeze-historical');
    const today = new Date().toISOString().split('T')[0];
    const res = await getIntradayCandles(symbol, today, '5minute');
    candles = res.candles || [];
  } catch (e) {
    candles = [];
  }

  // 3. India VIX
  let vix = 14;
  try {
    const v = await fetchIndiaVIX();
    if (v) vix = v.value;
  } catch (e) { /* default */ }

  // 4. Derive IV (avg ATM IV) and HV
  const iv = deriveAvgIV(dom.strikes);
  const hv = iv * 0.95;
  const atr = deriveATR(candles, dom.spot);

  return {
    spot: dom.spot,
    strikes: dom.strikes,
    candles,
    vix,
    atr,
    iv,
    hv,
  };
}

function deriveAvgIV(strikes: any[]): number {
  const ivs = strikes
    .map(s => Math.max(s.ce?.iv || 0, s.pe?.iv || 0))
    .filter(v => v > 0);
  if (ivs.length === 0) return 15;
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

function deriveATR(candles: any[], spot: number): number {
  if (!candles || candles.length < 2) return spot * 0.004;
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trSum += tr;
  }
  return trSum / (candles.length - 1);
}
