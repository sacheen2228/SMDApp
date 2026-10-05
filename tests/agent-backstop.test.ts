/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// v2 §6 / §28 — Grok numeric backstop:
//  - deterministic supervisor output passes (fire count 0)
//  - a deliberately fabricated Grok response is DISCARDED → deterministic
//    fallback + violation log + fire count
//  - confidence out of 0..100 is a violation
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  deterministicDecision, grokBackstop,
  getGrokBackstopFireCount, resetGrokBackstopFireCount,
} from '../src/lib/agents/supervisor';
import { analyzeCrossConfluence } from '../src/lib/agents/cross-confluence';
import { runAllAgents } from '../src/lib/agents/registry-30';
import { getSystemStatus } from '../src/lib/agents/pipeline';
import type { GrokDecision } from '../src/lib/agents/agent-contract';
import { mapHermesToAgentContext } from '../src/lib/agents/snapshot';
import type { HermesContext } from '../src/lib/hermes/types';

function ctxFixture() {
  const timestamp = new Date().toISOString();
  const fresh = { source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false };
  const strike = (k: number, ceOi: number, peOi: number) => ({
    strike: k,
    ce: { ltp: 150, bid: 149, ask: 151, volume: 10000, oi: ceOi, oiChange: 1000, iv: 15.5 },
    pe: { ltp: 140, bid: 139, ask: 141, volume: 12000, oi: peOi, oiChange: 2000, iv: 16.2 },
  });
  const h = {
    timestamp, symbol: 'NIFTY', mode: 'RESEARCH', marketStatus: 'OPEN', exchange: 'NSE', instrument: 'index',
    spot: { value: { price: 24500, change: 100, changePct: 0.41, prevClose: 24400, open: 24420, high: 24550, low: 24380, volume: 50000000 }, ...fresh },
    optionChain: {
      value: {
        symbol: 'NIFTY', spot: 24500, atmStrike: 24500, expiry: '30-Sep-2026', daysToExpiry: 5,
        strikes: [strike(24400, 50000, 90000), strike(24500, 70000, 70000), strike(24600, 90000, 50000)],
        totalCallOI: 210000, totalPutOI: 210000, callOiChange: 3000, putOiChange: 5000,
        pcrOI: 1.0, pcrVolume: 1.1, maxPain: 24500, callWall: 24600, putWall: 24400,
        gammaWall: 24550, gammaFlip: 24480, expectedMove: 180, vix: 14, futuresPrice: 24520,
      }, ...fresh,
    },
    vix: { value: 14, ...fresh },
    fiiDII: { value: { fiiNet: 600, diiNet: 200, fiiBias: 'BULLISH_FLOW', dataDate: '2026-09-24', publishedAt: timestamp }, ...fresh },
    news: { value: { sentiment: 'BULLISH', score: 70, headlines: ['Positive macro print'], highImpactEvents: [] }, ...fresh, source: 'newsapi' },
    regime: { value: { type: 'TRENDING_UP', bias: 'BULLISH', confidence: 70, factors: {} }, ...fresh },
    marketStructure: { value: { trend: 'UP', swingHigh: 24550, swingLow: 24380, supportLevels: [24400], resistanceLevels: [24600], lastEvent: 'BOS_UP', pdh: 24480, pdl: 24350 }, ...fresh },
    greeks: { value: { delta: 0.52, gamma: 0.0008, theta: -3.5, vega: 0.45, iv: 16 }, ...fresh },
    gamma: { value: { detected: true, confidence: 75, dealerBias: 'POSITIVE', squeezePotential: 0.3, gammaWallStrike: 24550, gammaWallType: 'PUT', estimatedGEX: 1200, regime: 'POSITIVE' }, ...fresh },
    volume: { value: { poc: 24490, vah: 24560, val: 24420, cumulativeDelta: 1500, totalVolume: 1.2e8, avgVolume: 1e8, absorptionLevels: [], exhaustionSignals: [] }, ...fresh },
    expiryLiquidity: { value: {} as any, ...fresh },
    backtestResults: { value: {} as any, ...fresh },
  } as unknown as HermesContext;
  return mapHermesToAgentContext(h, timestamp, '15m');
}

async function fixtureDecision() {
  const ctx = ctxFixture();
  const outputs = await runAllAgents(ctx);
  const cc = analyzeCrossConfluence('NIFTY', outputs);
  return { outputs, cc, decision: deterministicDecision('NIFTY', outputs, cc) };
}

beforeEach(() => {
  resetGrokBackstopFireCount();
});

describe('Grok numeric backstop (v2 §6)', () => {
  it('deterministic supervisor output passes with fire count 0', async () => {
    const { decision } = await fixtureDecision();
    expect(decision.direction).toBeTruthy();
    expect(getGrokBackstopFireCount()).toBe(0);
    // directionReason produced after backstop — no BACKSTOP prefix
    expect(decision.directionReason).not.toContain('BACKSTOP_DISCARDED');
  });

  it('discards a deliberately fabricated Grok response (untraceable numbers)', async () => {
    const { outputs, cc, decision } = await fixtureDecision();

    const fabricated: GrokDecision = {
      ...decision,
      consensusConfidence: 150, // out of range
      bullishEvidence: [
        ...decision.bullishEvidence,
        'Spot will hit 99999 by Friday with 88% certainty', // 99999 / 88 appear nowhere
      ],
      directionReason: 'Buy now, target 77777',
    };

    const result = grokBackstop(fabricated, outputs, cc);

    expect(getGrokBackstopFireCount()).toBe(1);
    expect(result.directionReason).toContain('BACKSTOP_DISCARDED');
    const backstopFailures = result.validation.failures.filter(f => f.startsWith('BACKSTOP:'));
    expect(backstopFailures.some(f => f.includes('99999'))).toBe(true);
    expect(backstopFailures.some(f => f.includes('CONFIDENCE_OUT_OF_RANGE'))).toBe(true);
    // Fallback is a recomputed deterministic decision (valid direction set)
    expect(['BUY_CE', 'BUY_PE', 'BUY', 'SELL', 'NO_TRADE']).toContain(result.direction);
  });

  it('allows numbers that trace to agent outputs', async () => {
    const { outputs, cc, decision } = await fixtureDecision();
    const agentNum = outputs.find(o => o.evidence.some(e => /\d/.test(e)))!
      .evidence.find(e => /\d/.test(e))!;

    const withTraceable: GrokDecision = {
      ...decision,
      bullishEvidence: [...decision.bullishEvidence, `Reconfirms: ${agentNum}`],
    };
    const result = grokBackstop(withTraceable, outputs, cc);
    expect(getGrokBackstopFireCount()).toBe(0);
    expect(result.directionReason).not.toContain('BACKSTOP_DISCARDED');
  });

  it('exposes fire count via getSystemStatus (§33 report field)', async () => {
    await fixtureDecision();
    const { outputs, cc, decision } = await fixtureDecision();
    grokBackstop({ ...decision, directionReason: 'Target 123456' }, outputs, cc);
    expect(getSystemStatus().grokBackstopFires).toBe(1);
  });
});
