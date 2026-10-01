/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// v2 §2 — Jarvis reuse tests: bridge wrappers degrade safely, agents wrap
// jarvis scoring/greeks/levels (no parallel OI/Greeks math), and the whole
// agent phase still performs ZERO outbound fetches.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from 'bun:test';
import { mapHermesToAgentContext, toJarvisChain } from '../src/lib/agents/snapshot';
import {
  validJarvisChain, bridgeChainScore, bridgeGreeks, bridgeLevels,
  bridgeFiiScore, bridgeNewsSigned,
} from '../src/lib/agents/jarvis-bridge';
import { runAllAgents } from '../src/lib/agents/registry-30';
import type { AgentContext } from '../src/lib/agents/agent-contract';
import type { HermesContext } from '../src/lib/hermes/types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Fixture: hermes context with a real-shaped strike ladder ───────────

function strike(strikePrice: number, ceOi: number, peOi: number) {
  return {
    strike: strikePrice,
    ce: { ltp: 150, bid: 149, ask: 151, volume: 10000, oi: ceOi, oiChange: 1000, iv: 15.5 },
    pe: { ltp: 140, bid: 139, ask: 141, volume: 12000, oi: peOi, oiChange: 2000, iv: 16.2 },
  };
}

function hermesFixture(expiry = '30-Sep-2026'): HermesContext {
  const timestamp = new Date().toISOString();
  const fresh = { source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false };
  return {
    timestamp,
    symbol: 'NIFTY',
    mode: 'RESEARCH',
    marketStatus: 'OPEN',
    exchange: 'NSE',
    instrument: 'index',
    spot: { value: { price: 24500, change: 100, changePct: 0.41, prevClose: 24400, open: 24420, high: 24550, low: 24380, volume: 50000000 }, ...fresh },
    optionChain: {
      value: {
        symbol: 'NIFTY', spot: 24500, atmStrike: 24500, expiry, daysToExpiry: 5,
        strikes: [
          strike(24300, 10000, 50000),
          strike(24400, 50000, 90000),
          strike(24500, 70000, 70000),
          strike(24600, 90000, 50000),
          strike(24700, 60000, 20000),
        ],
        totalCallOI: 210000, totalPutOI: 210000, callOiChange: 3000, putOiChange: 5000,
        pcrOI: 1.0, pcrVolume: 1.1, maxPain: 24500, callWall: 24600, putWall: 24400,
        gammaWall: 24550, gammaFlip: 24480, expectedMove: 180, vix: 14, futuresPrice: 24520,
      },
      ...fresh,
    },
    vix: { value: 14, ...fresh },
    fiiDII: { value: { fiiNet: 600, diiNet: 200, fiiBias: 'BULLISH_FLOW', dataDate: '2026-09-24', publishedAt: timestamp }, ...fresh },
    news: { value: { sentiment: 'BULLISH', score: 70, headlines: ['Push rate decision positive'], highImpactEvents: [] }, source: 'newsapi', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    regime: { value: { type: 'TRENDING_UP', bias: 'BULLISH', confidence: 70, factors: {} }, ...fresh },
    marketStructure: { value: { trend: 'UP', swingHigh: 24550, swingLow: 24380, supportLevels: [24400], resistanceLevels: [24600], lastEvent: 'BOS_UP', pdh: 24480, pdl: 24350 }, ...fresh },
    greeks: { value: { delta: 0.52, gamma: 0.0008, theta: -3.5, vega: 0.45, iv: 16 }, ...fresh },
    gamma: { value: { detected: true, confidence: 75, dealerBias: 'POSITIVE', squeezePotential: 0.3, gammaWallStrike: 24550, gammaWallType: 'PUT', estimatedGEX: 1200, regime: 'POSITIVE' }, ...fresh },
    volume: { value: { poc: 24490, vah: 24560, val: 24420, cumulativeDelta: 1500, totalVolume: 1.2e8, avgVolume: 1e8, absorptionLevels: [], exhaustionSignals: [] }, ...fresh },
    expiryLiquidity: { value: {} as any, ...fresh },
    backtestResults: { value: {} as any, ...fresh },
  } as unknown as HermesContext;
}

function ctxFixture(expiry = '30-Sep-2026'): AgentContext {
  return mapHermesToAgentContext(hermesFixture(expiry), new Date().toISOString(), '15m');
}

// ─── toJarvisChain pure mapping ────────────────────────────────────────

describe('toJarvisChain (snapshot → jarvis format, zero fetch)', () => {
  it('maps spot, expiry and CE/PE legs from the SAME snapshot chain', () => {
    const ctx = ctxFixture();
    const oc = ctx.jarvisChain!;
    expect(oc).toBeTruthy();
    expect(oc.underlyingValue).toBe(24500);
    expect(oc.expiryDates).toEqual(['30-Sep-2026']);
    expect(oc.data.length).toBe(5);
    expect(oc.data[0].expiryDate).toBe('30-Sep-2026');
    expect(oc.data[2].CE?.openInterest).toBe(70000);
    expect(oc.data[2].PE?.openInterest).toBe(70000);
    expect(oc.data[2].CE?.impliedVolatility).toBe(15.5);
    expect(oc.data[2].CE?.lastPrice).toBe(150);
  });

  it('returns null when chain data is absent or empty', () => {
    expect(toJarvisChain(null)).toBeNull();
    expect(toJarvisChain({})).toBeNull();
    expect(toJarvisChain({ spot: 24500, expiry: '30-Sep-2026', strikes: [] })).toBeNull();
    expect(toJarvisChain({ spot: 0, expiry: '30-Sep-2026', strikes: [strike(24500, 1, 1)] })).toBeNull();
  });
});

// ─── Bridge wrappers ───────────────────────────────────────────────────

describe('Jarvis bridge wrappers', () => {
  it('rejects non-NSE expiry formats instead of feeding NaN to jarvis', () => {
    const ctx = ctxFixture('2026-09-30'); // ISO, not "30-Sep-2026"
    expect(validJarvisChain(ctx)).toBeNull();
    expect(bridgeGreeks(ctx)).toBeNull();
    expect(bridgeLevels(ctx)).toBeNull();
    expect(bridgeChainScore(ctx)).toBeNull();
  });

  it('returns null when there is no jarvis chain (graceful degradation)', () => {
    const ctx = ctxFixture();
    (ctx as any).jarvisChain = undefined;
    expect(validJarvisChain(ctx)).toBeNull();
    expect(bridgeChainScore(ctx)).toBeNull();
    expect(bridgeGreeks(ctx)).toBeNull();
    expect(bridgeLevels(ctx)).toBeNull();
    // FII score reads ctx flow, not the chain — must still work
    expect(bridgeFiiScore(ctx)).toBe(3);
  });

  it('bridgeChainScore gives jarvis PCR and OI-wall support/resistance', () => {
    const s = bridgeChainScore(ctxFixture())!;
    expect(s).toBeTruthy();
    expect(s.pcr).toBeCloseTo(1, 2);
    expect(s.support).toBe(24400);   // top PE OI at/below spot
    expect(s.resistance).toBe(24600); // top CE OI at/above spot
    expect(Number.isFinite(s.score)).toBe(true);
  });

  it('bridgeGreeks runs the full jarvis pass with finite outputs', () => {
    const g = bridgeGreeks(ctxFixture(), 14)!;
    expect(g).toBeTruthy();
    expect(g.atmStrike).toBe(24500);
    expect(g.atmIv).toBeGreaterThan(0);
    expect(Number.isFinite(g.netGex)).toBe(true);
    expect(g.perStrike.length).toBe(5);
    expect(typeof g.regime).toBe('string');
    expect(Number.isFinite(g.expectedMove1Sigma)).toBe(true);
  });

  it('bridgeLevels gives OI walls and max pain', () => {
    const lv = bridgeLevels(ctxFixture())!;
    expect(lv).toBeTruthy();
    expect(lv.levels.oiSupport).toBe(24400);
    expect(lv.levels.oiResistance).toBe(24600);
    expect(lv.levels.maxPain).toBe(24500);
  });

  it('bridgeFiiScore applies jarvis thresholds', () => {
    const up = ctxFixture();
    expect(bridgeFiiScore(up)).toBe(3); // +600 → >500 → +3
    up.fiiNet = -2500;
    expect(bridgeFiiScore(up)).toBe(-6); // < -2000 → -6
  });

  it('bridgeNewsSigned null when feed absent, signed scale when present', () => {
    const ctx = ctxFixture();
    expect(bridgeNewsSigned(ctx)).toBe(40); // raw 70 → (70-50)*2
    ctx.headlines = [];
    ctx.newsSentiment = 'NEUTRAL';
    expect(bridgeNewsSigned(ctx)).toBeNull(); // hermes 0-score must not read as -100
  });
});

// ─── Agents actually wrap jarvis (evidence-level assertions) ───────────

describe('Agents wrap jarvis outputs (v2 §2)', () => {
  it('agents 07/09/10/11/14/19/25/02/26/28 surface jarvis-derived evidence', async () => {
    const ctx = ctxFixture();
    const outputs = await runAllAgents(ctx);
    const by = (id: string) => outputs.find(o => o.agentId === id)!;

    expect(by('OI_PCR').evidence.join('|')).toContain('OI wall resistance: 24600');
    expect(by('OI_PCR').evidence.join('|')).toContain('OI wall support: 24400');
    expect(by('GREEKS').evidence.join('|')).toContain('Jarvis greek score');
    expect(by('GAMMA').evidence.join('|')).toContain('Net GEX');
    expect(by('GAMMA').evidence.join('|')).toContain('Gamma flip');
    expect(by('IV_HV').evidence.join('|')).toContain('IV skew put-call');
    expect(by('STRIKE_SELECTION').observation).toContain('0.50Δ strike');
    expect(by('SUPPORT_RESISTANCE').evidence.join('|')).toContain('OI support: 24400');
    expect(by('ATR').evidence.join('|')).toContain('1σ expected move');
    expect(by('FII_DII').evidence.join('|')).toContain('Jarvis FII score: +3');
    expect(by('NEWS').evidence.join('|')).toContain('Signed news score');
    expect(by('SENTIMENT').evidence.join('|')).toContain('Sentiment score (jarvis signed)');

    const errored = outputs.filter(o => o.dataFreshness === 'ERROR');
    expect(errored.map(o => o.agentId)).toEqual([]);
  });

  it('agent phase still performs zero outbound fetches', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return { ok: false, status: 504, json: async () => ({}) } as any;
    }) as any;

    await runAllAgents(ctxFixture());
    expect(urls.length).toBe(0);
  });
});
