/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// v2 §3 / §21 / §28 — Shared snapshot tests:
//  - one fetch cycle per 30-agent run (deliberate per-type count, never 30)
//  - agents themselves perform ZERO outbound fetches
//  - every agent's dataFreshness derives from the single fetchedAtIso
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from 'bun:test';
import {
  buildAgentSnapshot, mapHermesToAgentContext,
} from '../src/lib/agents/snapshot';
import { freshnessFromIso } from '../src/lib/agents/agent-contract';
import { runAllAgents } from '../src/lib/agents/registry-30';
import type { HermesContext } from '../src/lib/hermes/types';

const realFetch = globalThis.fetch;

function installFetchCounter(): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(typeof input === 'string' ? input : input?.url || input));
    return { ok: false, status: 504, json: async () => ({}), text: async () => '' } as any;
  }) as any;
  return { urls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Shared Snapshot (v2 §3/§21)', () => {
  it('one full 30-agent cycle performs one snapshot fetch set, agents fetch nothing', async () => {
    const spy = installFetchCounter();

    const { ctx, fetchedAtIso } = await buildAgentSnapshot('NIFTY', {
      apiBase: 'http://snapshot.test',
    });
    const snapshotFetches = spy.urls.length;
    spy.urls.length = 0; // reset — measure the agent phase separately

    const outputs = await runAllAgents(ctx);

    // Fast-tier agents re-read the SAME cycle's snapshot — zero new fetches.
    expect(spy.urls.length).toBe(0);

    // Deliberate per-type set for one cycle (option chain, FII/DII, news,
    // regime, structure, gamma, …) — never one-per-agent (30).
    expect(snapshotFetches).toBeGreaterThan(0);
    expect(snapshotFetches).toBeLessThanOrEqual(12);

    // Full-cycle total equals the snapshot set alone.
    expect(spy.urls.length + snapshotFetches).toBe(snapshotFetches);
    expect(outputs.length).toBe(30);
    expect(fetchedAtIso).toBeTruthy();
  });

  it('every agent freshness derives from the ONE snapshot timestamp', async () => {
    const spy = installFetchCounter();
    const { ctx, fetchedAtIso } = await buildAgentSnapshot('NIFTY', {
      apiBase: 'http://snapshot.test',
    });
    expect(spy.urls.length).toBeGreaterThan(0);
    expect(freshnessFromIso(fetchedAtIso)).toBe('FRESH');

    const outputs = await runAllAgents(ctx);
    // A FRESH snapshot may only be reported as FRESH, or escalated to
    // MISSING/ERROR when that agent's data is absent — never STALE,
    // and never a per-agent freshness opinion.
    const allowed = new Set(['FRESH', 'MISSING', 'ERROR']);
    const offenders = outputs.filter(o => !allowed.has(o.dataFreshness));
    expect(offenders.map(o => `${o.agentId}:${o.dataFreshness}`)).toEqual([]);
    expect(outputs.some(o => o.dataFreshness === 'FRESH')).toBe(true);
  });

  it('stale single timestamp downgrades ALL agents — no lone FRESH agents', async () => {
    const oldIso = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min → STALE
    const base = fakeHermes(oldIso);
    const ctx = mapHermesToAgentContext(base, oldIso, '15m');

    expect(freshnessFromIso(oldIso)).toBe('STALE');
    const outputs = await runAllAgents(ctx);
    // Nobody may report FRESH (or STALE→FRESH drift) off a stale snapshot;
    // explicit MISSING/ERROR for absent agent data is still allowed.
    const offenders = outputs.filter(o => o.dataFreshness === 'FRESH');
    expect(offenders.map(o => o.agentId)).toEqual([]);
    expect(outputs.some(o => o.dataFreshness === 'STALE')).toBe(true);
  });
});

describe('freshnessFromIso thresholds (v2 §21)', () => {
  it('FRESH under 90s, STALE under 10min, MISSING when old/absent/bad', () => {
    expect(freshnessFromIso(new Date().toISOString())).toBe('FRESH');
    expect(freshnessFromIso(new Date(Date.now() - 89_000).toISOString())).toBe('FRESH');
    expect(freshnessFromIso(new Date(Date.now() - 91_000).toISOString())).toBe('STALE');
    expect(freshnessFromIso(new Date(Date.now() - 599_000).toISOString())).toBe('STALE');
    expect(freshnessFromIso(new Date(Date.now() - 601_000).toISOString())).toBe('MISSING');
    expect(freshnessFromIso(undefined)).toBe('MISSING');
    expect(freshnessFromIso('not-a-date')).toBe('MISSING');
  });

  it('dataTimestamp and spot/chain freshness align with the single ts', () => {
    const iso = new Date().toISOString();
    const ctx = mapHermesToAgentContext(fakeHermes(iso), iso, '15m');
    expect(ctx.dataTimestamp).toBe(iso);
    expect(ctx.fetchedAtIso).toBe(iso);
    expect(ctx.spotFreshness).toBe('FRESH');
    expect(ctx.chainFreshness).toBe('FRESH');
  });
});

// ─── Fixture: minimal HermesContext for the mapper ─────────────────────

function fakeHermes(timestamp: string): HermesContext {
  return {
    timestamp,
    symbol: 'NIFTY',
    mode: 'RESEARCH',
    marketStatus: 'OPEN',
    exchange: 'NSE',
    instrument: 'index',
    spot: { value: { price: 24500, change: 100, changePct: 0.41, prevClose: 24400, open: 24420, high: 24550, low: 24380, volume: 50000000 }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    optionChain: { value: { symbol: 'NIFTY', spot: 24500, atmStrike: 24500, expiry: '2026-09-25', daysToExpiry: 0, strikes: [], totalCallOI: 1e7, totalPutOI: 1.2e7, callOiChange: 5e5, putOiChange: 8e5, pcrOI: 1.2, pcrVolume: 1.1, maxPain: 24500, callWall: 24600, putWall: 24400, gammaWall: 24550, gammaFlip: 24480, expectedMove: 180, vix: 14, futuresPrice: 24520 }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    vix: { value: 14, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    fiiDII: { value: { fiiNet: 300, diiNet: 200, fiiBias: 'BULLISH_FLOW', dataDate: '2026-09-24', publishedAt: timestamp }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    news: { value: { sentiment: 'BULLISH', score: 0.4, headlines: ['Test headline'], highImpactEvents: [] }, source: 'newsapi', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    regime: { value: { type: 'TRENDING_UP', bias: 'BULLISH', confidence: 70, factors: {} }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    marketStructure: { value: { trend: 'UP', swingHigh: 24550, swingLow: 24380, supportLevels: [24400], resistanceLevels: [24600], lastEvent: 'BOS_UP', pdh: 24480, pdl: 24350 }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    greeks: { value: { delta: 0.52, gamma: 0.0008, theta: -3.5, vega: 0.45, iv: 16 }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    gamma: { value: { detected: true, confidence: 75, dealerBias: 'POSITIVE', squeezePotential: 0.3, gammaWallStrike: 24550, gammaWallType: 'PUT', estimatedGEX: 1200, regime: 'POSITIVE' }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    volume: { value: { poc: 24490, vah: 24560, val: 24420, cumulativeDelta: 1500, totalVolume: 1.2e8, avgVolume: 1e8, absorptionLevels: [], exhaustionSignals: [] }, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    expiryLiquidity: { value: {} as any, source: 'nse', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
    backtestResults: { value: {} as any, source: 'yahoo', timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false },
  } as unknown as HermesContext;
}
