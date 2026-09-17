// Option Buyer API — live CE/PE BUY recommendations with SL + TP1/2/3
// Fetches live option chain, scores strikes via buyer confluence, returns top setups

import { NextResponse } from 'next/server';
import { fetchLiveOptionChain } from '@/lib/live-option-chain';
import { scoreBuyerConfluence, type ConfluenceInput, type ConfluenceResult } from '@/lib/buyer-confluence-engine';
import { getCurrentSession } from '@/lib/market-session';

// Try fetching cached option chain from market-history sidecar (port 4002)
async function fetchCachedOptionChain(symbol: string): Promise<any | null> {
  try {
    const res = await fetch(`http://localhost:4002/snapshots/latest?symbol=${symbol}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.payload || null;
  } catch { return null; }
}

interface OptionBuyerTrade {
  symbol: string;
  direction: 'CE' | 'PE';
  action: 'BUY';
  strike: number;
  spotPrice: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  riskReward: number;
  confidence: number;
  score: number;
  expiry: string;
  daysToExpiry: number;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  iv: number;
  oi: number;
  volume: number;
  confluence: {
    vixRegime: string;
    timeWindow: string;
    gapTrap: boolean;
    correlation: string;
    ivRank: string;
    eventRisk: string;
  };
  reasons: string[];
  timestamp: string;
}

function computeSLTP(entry: number, spotPrice: number, strike: number, direction: 'CE' | 'PE', daysToExpiry: number): { sl: number; tp1: number; tp2: number; tp3: number } {
  const moneyness = Math.abs(strike - spotPrice) / spotPrice;
  const isATM = moneyness < 0.01;
  const isITM = direction === 'CE' ? strike < spotPrice : strike > spotPrice;

  // Risk = premium * multiplier based on type
  const riskPct = isATM ? 0.20 : isITM ? 0.15 : 0.25;
  const rewardPct1 = isATM ? 0.30 : 0.40;
  const rewardPct2 = isATM ? 0.60 : 0.80;
  const rewardPct3 = isATM ? 1.00 : 1.50;

  // Reduce targets if close to expiry (gamma explosion risk)
  const expiryFactor = daysToExpiry <= 1 ? 0.6 : daysToExpiry <= 3 ? 0.8 : 1.0;

  const sl = Math.round((entry * (1 - riskPct)) * 100) / 100;
  const tp1 = Math.round((entry * (1 + rewardPct1 * expiryFactor)) * 100) / 100;
  const tp2 = Math.round((entry * (1 + rewardPct2 * expiryFactor)) * 100) / 100;
  const tp3 = Math.round((entry * (1 + rewardPct3 * expiryFactor)) * 100) / 100;

  return { sl, tp1, tp2, tp3 };
}

async function analyzeSymbol(symbol: string): Promise<{ trades: OptionBuyerTrade[]; source: string }> {
  // 1) Try live option chain (with timeout — NSE hangs from server)
  let result;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    result = await fetchLiveOptionChain(symbol, undefined, controller.signal);
    clearTimeout(timer);
  } catch { result = { success: false, data: null, source: 'timeout' }; }
  let data = result.data;
  let source = result.source || 'live';

  // 2) Fallback: cached data from market-history sidecar
  if (!data) {
    const cached = await fetchCachedOptionChain(symbol);
    if (cached) {
      data = {
        data: cached.data || cached.strikes || [],
        spotPrice: cached.spotPrice || cached.summary?.spotPrice || 0,
        summary: cached.summary || { spotPrice: cached.spotPrice || 0, indiaVIX: null, maxPain: 0, pcr: null, totalCallOI: 0, totalPutOI: 0, callOiChange: 0, putOiChange: 0, atmStrike: 0 },
        expiries: cached.expiries || [],
        selectedExpiry: cached.selectedExpiry || '',
      };
      source = 'cached-market-history';
    }
  }

  if (!data) return { trades: [], source: 'none' };

  const { data: strikes, spotPrice, summary, selectedExpiry } = data;
  const session = getCurrentSession();
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const isMarketOpen = session?.isMarketOpen ?? false;

  const trades: OptionBuyerTrade[] = [];
  const expiryDate = new Date(data.selectedExpiry);
  const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

  // Score each strike near ATM (±5 strikes)
  const atmStrike = summary.atmStrike;
  const nearbyStrikes = strikes.filter((s: any) =>
    Math.abs(s.strike - atmStrike) <= atmStrike * 0.05 && s.ce && s.pe
  );

  for (const strike of nearbyStrikes) {
    // Score CE
    if (strike.ce && strike.ce.ltp > 1) {
      const confluenceInput: ConfluenceInput = {
        fiiNet: 0, diiNet: 0, fiiFutLongRatio: 0.5, fiiNet5dAvg: 0,
        pcr: summary.pcr || 1, maxPain: summary.maxPain, spotPrice,
        ceOIBuildup: (strike.ce.oiChg || 0) > 0, peOIBuildup: false,
        oiPattern: 'NEUTRAL',
        ivRank: 50, atmIV: summary.indiaVIX || 15, ivTrend: 'STABLE',
        atmStraddlePrice: 0, expectedMove: 0,
        gammaFlipLevel: 0, dealerGexRegime: 'LONG_GAMMA',
        indiaVix: summary.indiaVIX || 15, adx: 25, niftyTrend: 'NEUTRAL', bankNiftyTrend: 'NEUTRAL',
        currentHour: ist.getHours(), currentMinute: ist.getMinutes(),
        isExpiryDay: session?.isExpiryDay || false,
        daysToExpiry,
        dayOfWeek: ist.getDay(),
        rsi: 50, adxTechnical: 25, ema20Above50: true, higherHighs: true,
        gapPercent: 0,
        direction: 'CE',
      };
      const score: ConfluenceResult = scoreBuyerConfluence(confluenceInput);
      // When market is closed, lower threshold to show planning setups
      const minScore = isMarketOpen ? 50 : 40;
      if (score.totalScore >= minScore) {
        const { sl, tp1, tp2, tp3 } = computeSLTP(strike.ce.ltp, spotPrice, strike.strike, 'CE', daysToExpiry);
        const rr = (tp2 - strike.ce.ltp) / (strike.ce.ltp - sl);
        trades.push({
          symbol, direction: 'CE', action: 'BUY', strike: strike.strike, spotPrice,
          entry: strike.ce.ltp, stopLoss: sl, tp1, tp2, tp3,
          riskReward: Math.round(rr * 10) / 10,
          confidence: score.totalScore, score: score.totalScore, expiry: data.selectedExpiry,
          daysToExpiry,
          greeks: { delta: strike.ce.delta || 0, gamma: strike.ce.gamma || 0, theta: strike.ce.theta || 0, vega: strike.ce.vega || 0 },
          iv: strike.ce.iv || 0, oi: strike.ce.oi || 0, volume: strike.ce.volume || 0,
          confluence: { vixRegime: score.vixRegime, timeWindow: score.sessionWindow, gapTrap: score.gapTrap, correlation: score.correlationCheck, ivRank: score.ivRankLabel, eventRisk: score.eventRiskLabel },
          reasons: score.reasons, timestamp: ist.toISOString(),
        });
      }
    }

    // Score PE
    if (strike.pe && strike.pe.ltp > 1) {
      const confluenceInput: ConfluenceInput = {
        fiiNet: 0, diiNet: 0, fiiFutLongRatio: 0.5, fiiNet5dAvg: 0,
        pcr: summary.pcr || 1, maxPain: summary.maxPain, spotPrice,
        ceOIBuildup: false, peOIBuildup: (strike.pe.oiChg || 0) > 0,
        oiPattern: 'NEUTRAL',
        ivRank: 50, atmIV: summary.indiaVIX || 15, ivTrend: 'STABLE',
        atmStraddlePrice: 0, expectedMove: 0,
        gammaFlipLevel: 0, dealerGexRegime: 'LONG_GAMMA',
        indiaVix: summary.indiaVIX || 15, adx: 25, niftyTrend: 'NEUTRAL', bankNiftyTrend: 'NEUTRAL',
        currentHour: ist.getHours(), currentMinute: ist.getMinutes(),
        isExpiryDay: session?.isExpiryDay || false,
        daysToExpiry,
        dayOfWeek: ist.getDay(),
        rsi: 50, adxTechnical: 25, ema20Above50: true, higherHighs: true,
        gapPercent: 0,
        direction: 'PE',
      };
      const score: ConfluenceResult = scoreBuyerConfluence(confluenceInput);
      // When market is closed, lower threshold to show planning setups
      const peMinScore = isMarketOpen ? 50 : 40;
      if (score.totalScore >= peMinScore) {
        const { sl, tp1, tp2, tp3 } = computeSLTP(strike.pe.ltp, spotPrice, strike.strike, 'PE', daysToExpiry);
        const rr = (tp2 - strike.pe.ltp) / (strike.pe.ltp - sl);
        trades.push({
          symbol, direction: 'PE', action: 'BUY', strike: strike.strike, spotPrice,
          entry: strike.pe.ltp, stopLoss: sl, tp1, tp2, tp3,
          riskReward: Math.round(rr * 10) / 10,
          confidence: score.totalScore, score: score.totalScore, expiry: data.selectedExpiry,
          daysToExpiry,
          greeks: { delta: strike.pe.delta || 0, gamma: strike.pe.gamma || 0, theta: strike.pe.theta || 0, vega: strike.pe.vega || 0 },
          iv: strike.pe.iv || 0, oi: strike.pe.oi || 0, volume: strike.pe.volume || 0,
          confluence: { vixRegime: score.vixRegime, timeWindow: score.sessionWindow, gapTrap: score.gapTrap, correlation: score.correlationCheck, ivRank: score.ivRankLabel, eventRisk: score.eventRiskLabel },
          reasons: score.reasons, timestamp: ist.toISOString(),
        });
      }
    }
  }

  // Sort by score descending, take top 2 per symbol
  trades.sort((a, b) => b.score - a.score);
  return { trades: trades.slice(0, 2), source };
}

export async function GET() {
  try {
    const symbols = ['NIFTY', 'BANKNIFTY'];
    const allTrades: OptionBuyerTrade[] = [];
    const sources: string[] = [];

    const results = await Promise.allSettled(symbols.map(s => analyzeSymbol(s)));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        allTrades.push(...r.value.trades);
        sources.push(r.value.source);
      }
    }

    // Sort all trades by score
    allTrades.sort((a, b) => b.score - a.score);

    const session = getCurrentSession();
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

    return NextResponse.json({
      success: true,
      trades: allTrades,
      total: allTrades.length,
      session: session?.session || 'UNKNOWN',
      isMarketOpen: session?.isMarketOpen ?? false,
      timestamp: ist.toISOString(),
      source: sources.join(' + ') || 'none',
    });
  } catch (err: any) {
    console.error('[OptionBuyer] Error:', err);
    return NextResponse.json({ success: false, error: err.message, trades: [] }, { status: 500 });
  }
}
