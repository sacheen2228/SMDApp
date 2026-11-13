// MCX Integration Bridge — offline tests
// Locks in the producer→consumer field mapping that was historically broken.

import { describe, test, expect } from 'bun:test';
import {
  resolveMCXRouteMode,
  isApprovedMCXSymbol,
  mapMCXScannerResultToMorningSignal,
  formatMCXQuoteToolResponse,
  extractMCXIntelligence,
} from '@/lib/mcx/bridge';
import { MCX_TRADE_EXCLUDED, isMCXTradeEligible } from '@/lib/mcx/types';
import type { MCXQuote } from '@/lib/mcx/types';

describe('MCX bridge — route mode', () => {
  test('approved symbol → quote', () => {
    expect(resolveMCXRouteMode({ symbol: 'CRUDEOIL' })).toBe('quote');
    expect(resolveMCXRouteMode({ symbol: 'crudeoil' })).toBe('quote');
  });

  test('unapproved symbol falls through to market', () => {
    expect(resolveMCXRouteMode({ symbol: 'NIFTY' })).toBe('market');
  });

  test('mode switch', () => {
    expect(resolveMCXRouteMode({ mode: 'best' })).toBe('best');
    expect(resolveMCXRouteMode({ mode: 'summary' })).toBe('summary');
    expect(resolveMCXRouteMode({ mode: 'scanner' })).toBe('market');
    expect(resolveMCXRouteMode({ mode: 'full' })).toBe('market');
    expect(resolveMCXRouteMode({})).toBe('market');
  });

  test('symbol matches the approved list', () => {
    expect(isApprovedMCXSymbol('SILVERMIC')).toBe(true);
    expect(isApprovedMCXSymbol('BTCUSD')).toBe(false);
  });
});

describe('MCX bridge — trade exclusion', () => {
  test('all silver variants are excluded from trade origination', () => {
    expect(isMCXTradeEligible('SILVER')).toBe(false);
    expect(isMCXTradeEligible('SILVERM')).toBe(false);
    expect(isMCXTradeEligible('SILVERMIC')).toBe(false);
  });

  test('non-silver contracts remain eligible', () => {
    for (const s of ['CRUDEOIL','CRUDEOILM','NATURALGAS','NATGASMINI','GOLD','GOLDM','GOLDGUINEA']) {
      expect(isMCXTradeEligible(s)).toBe(true);
    }
  });

  test('MCX_TRADE_EXCLUDED contains all silver family', () => {
    expect(MCX_TRADE_EXCLUDED).toEqual(['SILVER','SILVERM','SILVERMIC']);
  });
});

describe('MCX bridge — scanner → morning signal', () => {
  test('maps target/score/reasons onto tp1/confidence/reasoning', () => {
    const out = mapMCXScannerResultToMorningSignal({
      symbol: 'CRUDEOIL',
      direction: 'SHORT',
      entry: 5000,
      stopLoss: 5100,
      score: 82,
      reasons: ['OI wall above', 'bearish BOS'],
      target: 4800,
      riskReward: 2.5,
    });
    expect(out.side).toBe('SELL');
    expect(out.type).toBe('FUT');
    expect(out.tp1).toBe(4800);
    expect(out.tp2).toBe(4800);
    expect(out.confidence).toBe(82);
    expect(out.rr).toBe(2.5);
    expect(out.reasoning).toBe('OI wall above; bearish BOS');
    expect(out.instrument).toBe('MCX CRUDEOIL Futures');
    expect(out.source).toBe('mcx-scanner');
  });

  test('LONG defaults to BUY and missing fields do not crash', () => {
    const out = mapMCXScannerResultToMorningSignal({
      symbol: 'GOLD',
      direction: 'LONG',
      entry: 70000,
      stopLoss: 69000,
      score: 0,
      reasons: [],
    } as any);
    expect(out.side).toBe('BUY');
    expect(out.tp1).toBe(0);
    expect(out.rr).toBe(1);
    expect(out.reasoning).toBe('MCX commodity scan');
  });
});

describe('MCX bridge — quote → tool text', () => {
  const base: MCXQuote = {
    symbol: 'CRUDEOIL',
    exchange: 'MCX',
    assetClass: 'COMMODITY',
    ltp: 5000,
    open: 4950,
    high: 5050,
    low: 4900,
    previousClose: 4980,
    change: 20,
    changePercent: 0.4,
    volume: 12345,
    openInterest: 5000,
    changeInOI: 100,
    bid: 4999,
    ask: 5001,
    bidQty: 10,
    askQty: 10,
    timestamp: new Date().toISOString(),
    dataStatus: 'LIVE',
    dataSource: 'MOAPI',
    lotSize: 100,
    tickSize: 1,
    expiry: '2026-07-19',
  };

  test('formats real fields (LTP/high/low/changePercent/source)', () => {
    const text = formatMCXQuoteToolResponse('CRUDEOIL', base);
    expect(text).toContain('LTP: ₹5000.00');
    expect(text).toContain('Day High: ₹5050.00 | Day Low: ₹4900.00');
    expect(text).toContain('Source: MOAPI (LIVE)');
    expect(text).toContain('Volume: 12,345');
  });

  test('unavailable quote is reported as DATA_UNAVAILABLE, not faked', () => {
    const text = formatMCXQuoteToolResponse('CRUDEOIL', { ...base, ltp: null, dataStatus: 'DATA_UNAVAILABLE' });
    expect(text).toContain('DATA_UNAVAILABLE');
    expect(text).not.toContain('LTP: ₹');
  });

  test('null quote is handled', () => {
    expect(formatMCXQuoteToolResponse('GOLD', null)).toContain('DATA_UNAVAILABLE');
  });
});

describe('MCX bridge — intelligence flatten', () => {
  const nested = {
    success: true,
    intelligence: {
      symbol: 'CRUDEOIL',
      regime: { regime: 'TRENDING_UP', confidence: 0.72 },
      structure: { bias: 'BULLISH', event: 'BOS_BULLISH' },
      volumeOI: { oiClassification: 'LONG_BUILDUP', oiDivergence: false, relativeVolume: 1.8, volumeState: 'EXPANDING' },
      volatility: { atr: 95, atrPercent: 1.9, volatilityRegime: 'HIGH_VOL', ivClassification: 'ELEVATED', expectedMove: 140 },
      optionIntel: { chainQuality: 'GOOD' },
      longScore: { total: 68 },
      shortScore: { total: 41 },
      bestCandidate: { direction: 'LONG', score: { total: 68 }, actualRR: 2.4 },
      dataFreshness: { candlesAvailable: true, candleCount: 60, optionChainAvailable: true, quoteAvailable: true },
    },
    timestamp: '2026-06-15T13:00:00.000Z',
  };

  test('flattens the nested intelligence payload', () => {
    const out = extractMCXIntelligence(nested)!;
    expect(out.regime).toBe('TRENDING_UP');
    expect(out.regimeConfidence).toBe(0.72);
    expect(out.structureBias).toBe('BULLISH');
    expect(out.structureEvent).toBe('BOS_BULLISH');
    expect(out.oiClassification).toBe('LONG_BUILDUP');
    expect(out.relativeVolume).toBe(1.8);
    expect(out.atr).toBe(95);
    expect(out.volatilityRegime).toBe('HIGH_VOL');
    expect(out.chainQuality).toBe('GOOD');
    expect(out.longScore).toBe(68);
    expect(out.shortScore).toBe(41);
    expect(out.bestCandidateDirection).toBe('LONG');
    expect(out.bestCandidateScore).toBe(68);
    expect(out.bestCandidateRR).toBe(2.4);
    expect(out.dataFreshness.candlesAvailable).toBe(true);
  });

  test('tolerates a numeric longScore (scan shape)', () => {
    const out = extractMCXIntelligence({ regime: { regime: 'RANGE' }, longScore: 55, shortScore: 60 })!;
    expect(out.longScore).toBe(55);
    expect(out.shortScore).toBe(60);
    expect(out.regime).toBe('RANGE');
  });

  test('returns null for junk input', () => {
    expect(extractMCXIntelligence(null)).toBeNull();
    expect(extractMCXIntelligence('nope')).toBeNull();
  });
});
