/// <reference types="bun-types" />
// ═══════════════════════════════════════════════════════════════════════════
// Grok MAIN SUPERVISOR pipeline — safe wiring validation (observation phase)
//  1  pipeline executes end-to-end (dry-run) with an observation record
//  2  agent outputs reach the Grok supervisor
//  3  cross-confluence output reaches the Grok supervisor
//  4  the canonical snapshot context reaches the agents (single timestamp)
//  5  missing chain data → honest NO_TRADE, never fabricated fields
//  6  NO_TRADE never registers a trade
//  7  an invalid candidate never becomes a trade
//  8  a BUY CE trade passes the canonical validator
//  9  a BUY PE trade passes the canonical validator
// 10  option SELL CE is rejected
// 11  option SELL PE is rejected
// 12  equity/futures SELL remains permitted
// 13  duplicate execution is blocked by the active-trade lock
// 14  telegram alert fires only for approved, registered, non-dry-run trades
// 15  dry-run never sends a live alert
// 16  sendTradeAlert full-day dedup still works
// 17  stale snapshot data blocks a trade
// 18  market-closed blocks a trade
// 19  existing-engine (SDM) comparison is recorded when requested
// 20  existing-engine comparison degrades to null when unavailable
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach } from 'bun:test';
import {
  runFullPipeline,
  resolveEntryAlert,
  type PipelineObservation,
} from '@/lib/agents/pipeline';
import {
  runOptionEngine,
  buildOptionCandidate,
} from '@/lib/agents/option-engine';
import {
  runCashFuturesEngine,
  buildCashCandidate,
} from '@/lib/agents/cash-futures-engine';
import { mapHermesToAgentContext } from '@/lib/agents/snapshot';
import { runAllAgents } from '@/lib/agents/registry-30';
import { analyzeCrossConfluence } from '@/lib/agents/cross-confluence';
import { deterministicDecision } from '@/lib/agents/supervisor';
import { validateCandidateTrade } from '@/lib/trade-validator-gate';
import { acquireTradeLock, releaseTradeLock } from '@/lib/active-trade-lock';
import { sendTradeAlert } from '@/lib/telegram';
import type { AgentContext, GrokDecision, AgentResearchOutput } from '@/lib/agents/agent-contract';
import type { HermesContext } from '@/lib/hermes/types';

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

// ─── Fixture: future expiry (3 days out) ────────────────────────────────
function futureExpiry(): string {
  return new Date(Date.now() + 3 * 86_400_000).toISOString().split('T')[0];
}
const EXPIRY = futureExpiry();

// ─── Fixture: hermes context with a real-shaped chain ───────────────────
function fakeHermes(timestamp: string): HermesContext {
  const ce = {
    ltp: 140, bid: 139, ask: 141, spread: 2, quoteQuality: 'COMPLETE',
    volume: 250000, oi: 1200000, oiChange: 15000, iv: 16,
    delta: 0.5, gamma: 0.001, theta: -8, vega: 12, rho: 0.4,
  };
  const pe = {
    ltp: 150, bid: 149, ask: 151, spread: 2, quoteQuality: 'COMPLETE',
    volume: 300000, oi: 1500000, oiChange: 20000, iv: 17,
    delta: -0.5, gamma: 0.001, theta: -9, vega: 13, rho: -0.3,
  };
  const otmCe = { ...ce, ltp: 80, bid: 79, ask: 81, volume: 120000, oi: 800000 };
  const otmPe = { ...pe, ltp: 210, bid: 209, ask: 211, volume: 90000, oi: 700000 };
  const fresh = { timestamp, ageMs: 0, freshness: 'FRESH', status: 'OK', delayed: false, fallbackUsed: false };
  return {
    timestamp,
    symbol: 'NIFTY',
    mode: 'RESEARCH',
    marketStatus: 'OPEN',
    exchange: 'NSE',
    instrument: 'index',
    spot: { value: { price: 24500, change: 100, changePct: 0.41, prevClose: 24400, open: 24420, high: 24550, low: 24380, volume: 50000000 }, source: 'nse', ...fresh },
    optionChain: {
      value: {
        symbol: 'NIFTY', spot: 24500, atmStrike: 24500, expiry: EXPIRY, daysToExpiry: 3,
        strikes: [
          { strike: 24500, ce, pe },
          { strike: 24600, ce: otmCe, pe: otmPe },
        ],
        totalCallOI: 1e7, totalPutOI: 1.2e7, callOiChange: 5e5, putOiChange: 8e5,
        pcrOI: 1.2, pcrVolume: 1.1, maxPain: 24500, callWall: 24600, putWall: 24400,
        gammaWall: 24550, gammaFlip: 24480, expectedMove: 180, vix: 14, futuresPrice: 24520,
      },
      source: 'nse', ...fresh,
    },
    vix: { value: 14, source: 'nse', ...fresh },
    fiiDII: { value: { fiiNet: 300, diiNet: 200, fiiBias: 'BULLISH_FLOW', dataDate: '2026-09-24', publishedAt: timestamp }, source: 'nse', ...fresh },
    news: { value: { sentiment: 'BULLISH', score: 0.4, headlines: ['Test headline'], highImpactEvents: [] }, source: 'newsapi', ...fresh },
    regime: { value: { type: 'TRENDING_UP', bias: 'BULLISH', confidence: 70, factors: {} }, source: 'nse', ...fresh },
    marketStructure: {
      value: { trend: 'UP', swingHigh: 24550, swingLow: 24380, supportLevels: [24400, 24300], resistanceLevels: [24600, 24700], lastEvent: 'BOS_UP', pdh: 24480, pdl: 24350 },
      source: 'nse', ...fresh,
    },
    greeks: { value: { delta: 0.52, gamma: 0.0008, theta: -3.5, vega: 0.45, iv: 16 }, source: 'nse', ...fresh },
    gamma: { value: { detected: true, confidence: 75, dealerBias: 'POSITIVE', squeezePotential: 0.3, gammaWall: 24550, gammaWallType: 'PUT', estimatedGEX: 1200, regime: 'POSITIVE' }, source: 'nse', ...fresh },
    volume: { value: { poc: 24490, vah: 24560, val: 24420, cumulativeDelta: 1500, totalVolume: 1.2e8, avgVolume: 1e8, absorptionLevels: [], exhaustionSignals: [] }, source: 'nse', ...fresh },
    expiryLiquidity: { value: {} as any, source: 'nse', ...fresh },
    backtestResults: { value: {} as any, source: 'yahoo', ...fresh },
  } as unknown as HermesContext;
}

function makeCtx(iso = new Date().toISOString()): { ctx: AgentContext; iso: string } {
  return { ctx: mapHermesToAgentContext(fakeHermes(iso), iso, '15m'), iso };
}

function grok(direction: GrokDecision['direction'], engine: GrokDecision['selectedEngine']): GrokDecision {
  return {
    symbol: 'NIFTY',
    timestamp: new Date().toISOString(),
    marketRegime: 'TRENDING_UP',
    bullishEvidence: [],
    bearishEvidence: [],
    neutralEvidence: [],
    conflicts: [],
    consensus: 'BULLISH',
    consensusConfidence: 70,
    selectedEngine: engine,
    engineReason: 'test fixture',
    direction,
    directionReason: 'test fixture',
    candidate: undefined,
    validation: { passed: true, failures: [], warnings: [] },
    evidenceQuality: { totalAgents: 4, activeAgents: 4, freshData: 4, staleData: 0, missingData: 0 },
  } as GrokDecision;
}

function out(id: string, bias: AgentResearchOutput['bias'], confidence: number, observation: string, category = 'MARKET'): AgentResearchOutput {
  return {
    agentId: id,
    agentName: id.replace(/_/g, ' '),
    category,
    timestamp: new Date().toISOString(),
    symbol: 'NIFTY',
    timeframe: '15m',
    dataFreshness: 'FRESH',
    observation,
    bias,
    confidence,
    evidence: [],
    riskFlags: [],
    conflicts: [],
    recommendationContext: 'RESEARCH_ONLY',
    recommendationReason: 'test fixture',
  } as AgentResearchOutput;
}

const BULLISH_OUTPUTS = () => [
  out('MARKET_REGIME', 'BULLISH', 70, 'Regime trending up'),
  out('OI_PCR', 'BULLISH', 70, 'Put writing supports upside'),
  out('VWAP', 'BULLISH', 65, 'Price above VWAP'),
  out('FII_DII', 'BULLISH', 60, 'FII net buying'),
];

function deadCtx(ctx: AgentContext): AgentContext {
  return {
    ...ctx,
    spot: 0,
    strikes: [],
    supportLevels: [],
    resistanceLevels: [],
    swingHigh: 0,
    swingLow: 0,
    pdh: 0,
    pdl: 0,
    optionChain: {},
    expiry: '',
    vix: 0,
  } as AgentContext;
}

// ─── 1. Pipeline executes end-to-end (dry-run) ──────────────────────────

describe('1 — pipeline executes end-to-end (dry-run)', () => {
  it('runs agents → confluence → grok → gates → engine and returns a full observation', async () => {
    const { ctx } = makeCtx();
    const res = await runFullPipeline('NIFTY', ctx, { dryRun: true });

    expect(res.symbol).toBe('NIFTY');
    expect(res.agentOutputs.length).toBeGreaterThan(0);
    expect(res.grokDecision.symbol).toBe('NIFTY');
    expect(res.crossConfluence.symbol).toBe('NIFTY');
    expect(res.tradeRegistered).toBe(false);
    expect(res.telegramAlert).toBe(false);

    const obs = res.observation as PipelineObservation;
    expect(obs).toBeDefined();
    expect(obs.dryRun).toBe(true);
    expect(obs.finalAction).toBe(res.engineDecision.action);
    expect(obs.engine).toBe(res.engine);
    expect(obs.grokDirection).toBe(res.grokDecision.direction);
    expect(Array.isArray(obs.supportingAgents)).toBe(true);
    expect(Array.isArray(obs.rejectingAgents)).toBe(true);
    expect(Array.isArray(obs.missingData)).toBe(true);
    expect(obs.feedGate).toBeDefined();
    expect(obs.playbook).toBeDefined();
    expect(obs.existingEngine).toBeNull();
  });
});

// ─── 2–3. Research reaches the Grok supervisor ──────────────────────────

describe('2–3 — research reaches the Grok supervisor', () => {
  it('agent outputs reach Grok as evidence and drive the direction', () => {
    const outputs = BULLISH_OUTPUTS();
    const cc = analyzeCrossConfluence('NIFTY', outputs);
    const d = deterministicDecision('NIFTY', outputs, cc);

    expect(d.bullishEvidence.length).toBeGreaterThan(0);
    expect(d.bullishEvidence.some(e => e.includes('Regime trending up'))).toBe(true);
    expect(d.consensus).toBe('BULLISH');
    expect(d.selectedEngine).toBe('OPTION');
    expect(d.direction).toBe('BUY_CE');
  });

  it('cross-confluence output reaches Grok verbatim (evidence, conflicts, confidence)', () => {
    const outputs = BULLISH_OUTPUTS();
    const cc = analyzeCrossConfluence('NIFTY', outputs);
    const d = deterministicDecision('NIFTY', outputs, cc);

    expect(d.bullishEvidence).toEqual(cc.bullishEvidence);
    expect(d.conflicts).toEqual(cc.conflicts);
    expect(d.consensusConfidence).toBe(Math.min(85, cc.totalConfidence + 10));
  });
});

// ─── 4. Canonical context reaches the agents ────────────────────────────

describe('4 — canonical snapshot context reaches the agents', () => {
  it('maps ONE snapshot timestamp into ctx and runs all agents with zero fetches', async () => {
    const iso = new Date().toISOString();
    const { ctx } = makeCtx(iso);

    expect(ctx.spot).toBe(24500);
    expect(ctx.strikes.length).toBe(2);
    expect(ctx.expiry).toBe(EXPIRY);
    expect(ctx.fetchedAtIso).toBe(iso);
    expect(ctx.dataTimestamp).toBe(iso);

    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return { ok: false, status: 504, json: async () => ({}) } as any;
    }) as any;

    const outputs = await runAllAgents(ctx);
    expect(urls.length).toBe(0);
    expect(outputs.length).toBe(30);

    const strikeSel = outputs.find(o => o.agentId === 'STRIKE_SELECTION');
    expect(strikeSel?.data?.atmStrike).toBe(24500);
  });
});

// ─── 5. Missing data → honest NO_TRADE, never fabricated fields ─────────

describe('5 — missing chain data and fabrication guard', () => {
  it('missing strike/chain data → NO_TRADE with an honest reason', async () => {
    const iso = new Date().toISOString();
    const h = fakeHermes(iso);
    (h.optionChain.value as any).strikes = [];
    (h.optionChain.value as any).atmStrike = 0;
    const ctx = mapHermesToAgentContext(h, iso, '15m');

    // unique symbol → immune to leftover active-locks from other suites
    const r = await runOptionEngine('GROKDATA1', grok('BUY_CE', 'OPTION'), [], ctx);
    expect(r.action).toBe('NO_TRADE');
    expect(r.reasons.join(' ')).toMatch(/strike|chain/i);
  });

  it('a built candidate carries ONLY real snapshot fields — no invented values', () => {
    const { ctx, iso } = makeCtx();
    const built = buildOptionCandidate('NIFTY', grok('BUY_CE', 'OPTION'), [], ctx);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const c = built.candidate;

    expect(c.volume).toBe(250000);      // real leg volume — was hardcoded 50000
    expect(c.oi).toBe(1200000);         // real leg OI — was hardcoded 100000
    expect(c.vix).toBe(14);             // real ctx VIX — was `|| 15`
    expect(c.spot).toBe(24500);
    expect(c.strike).toBe(24500);
    expect(c.entry).toBe(140);          // real CE ltp
    expect(c.premium).toBe(140);
    expect(c.bid).toBe(139);
    expect(c.ask).toBe(141);
    expect(c.iv).toBe(16);
    expect(c.expiry).toBe(EXPIRY);      // chain expiry — was computed next Thursday
    expect(c.snapshotTimestamp).toBe(iso); // snapshot time — was `new Date()`
    expect(c.dataTimestamp).toBe(iso);
    expect(c.dataSource).toBe('NSE');   // real hermes source — was 'AGENT_SYSTEM'
    expect(c.optionChainSource).toBe('NSE');
    expect(c.signalSource).toBe('GROK_SUPERVISOR');
    expect(c.stopLoss).toBeLessThan(c.entry);
    expect(c.target1).toBeGreaterThan(c.entry);
    expect(c.volume).not.toBe(50000);
    expect(c.oi).not.toBe(100000);
    expect(c.vix).not.toBe(15);
    // session clock is owned by the pipeline registration gate, not the engine
    expect(c.marketOpen).toBeUndefined();
  });
});

// ─── 6. NO_TRADE never registers ────────────────────────────────────────

describe('6 — NO_TRADE never registers', () => {
  it('a dead snapshot (no spot, no chain, no structure) registers nothing', async () => {
    const { ctx } = makeCtx();
    const res = await runFullPipeline('NIFTY', deadCtx(ctx), { dryRun: false });

    expect(res.engineDecision.action).toBe('NO_TRADE');
    expect(res.tradeRegistered).toBe(false);
    expect(res.tradeId).toBeUndefined();
    expect(res.telegramAlert).toBe(false);
  });
});

// ─── 7. Invalid candidate never trades ──────────────────────────────────

describe('7 — invalid candidate never trades', () => {
  it('engine returns NO_TRADE when the premium is untradeable', async () => {
    const iso = new Date().toISOString();
    const h = fakeHermes(iso);
    const strikes = (h.optionChain.value as any).strikes;
    strikes[0].ce = { ...strikes[0].ce, ltp: 2, bid: 1, ask: 3, volume: 100, oi: 500 };
    const ctx = mapHermesToAgentContext(h, iso, '15m');

    const r = await runOptionEngine('GROKCHEAP1', grok('BUY_CE', 'OPTION'), [], ctx);
    expect(r.action).toBe('NO_TRADE');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.candidate).toBeUndefined();
  });

  it('the canonical validator blocks a sub-minimum premium', () => {
    const v = validateCandidateTrade(validOptionCandidate({ premium: 2, entry: 2, stopLoss: 1.8, target1: 4 }));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/PREMIUM/);
  });
});

// ─── 8–9. BUY CE / BUY PE pass the validator ────────────────────────────

function validOptionCandidate(over: Record<string, unknown> = {}) {
  const iso = new Date().toISOString();
  return {
    symbol: 'GROKTEST',
    exchange: 'NFO',
    instrument: 'CALL',
    optionType: 'CE',
    strike: 24500,
    entry: 140,
    stopLoss: 126,
    target1: 180,
    target2: 195,
    direction: 'BUY_CE',
    strategy: 'AGENT_SYSTEM',
    score: 70,
    spot: 24500,
    vix: 14,
    premium: 140,
    bid: 139,
    ask: 141,
    volume: 250000,
    oi: 1200000,
    iv: 16,
    expiry: EXPIRY,
    expiryValid: true,
    daysToExpiry: 3,
    dataTimestamp: iso,
    snapshotTimestamp: iso,
    dataSource: 'NSE',
    optionChainSource: 'NSE',
    signalSource: 'GROK_SUPERVISOR',
    riskReward: 2.5,
    marketOpen: true,
    marketStatus: 'OPEN',
    ...over,
  } as any;
}

describe('8–9 — approved option BUY trades pass the validator', () => {
  it('a BUY CE trade passes', () => {
    const v = validateCandidateTrade(validOptionCandidate());
    expect(v.valid).toBe(true);
    expect(v.status).toBe('VALID');
    expect(v.action).toBe('BUY_CE');
    expect(v.reasons).toEqual([]);
  });

  it('a BUY PE trade passes', () => {
    const v = validateCandidateTrade(validOptionCandidate({
      instrument: 'PUT',
      optionType: 'PE',
      direction: 'BUY_PE',
      premium: 150,
      entry: 150,
      stopLoss: 135,
      target1: 195,
      target2: 210,
      bid: 149,
      ask: 151,
      volume: 300000,
      oi: 1500000,
    }));
    expect(v.valid).toBe(true);
    expect(v.status).toBe('VALID');
    expect(v.action).toBe('BUY_PE');
  });
});

// ─── 10–11. Option selling rejected ─────────────────────────────────────

describe('10–11 — option selling rejected', () => {
  it('engine rejects a SELL direction on the option engine', async () => {
    const { ctx } = makeCtx();
    const r = await runOptionEngine('NIFTY', grok('SELL', 'OPTION'), [], ctx);
    expect(r.action).toBe('NO_TRADE');
    expect(r.reasons.join(' ')).toMatch(/OPTION_SELLING_NOT_ALLOWED|Option selling/);
    expect(r.candidate).toBeUndefined();
  });

  it('validator blocks SELL CE', () => {
    const v = validateCandidateTrade(validOptionCandidate({ direction: 'SELL_CE' }));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/OPTION_BUYING_ONLY|Option selling/);
  });

  it('validator blocks SELL PE', () => {
    const v = validateCandidateTrade(validOptionCandidate({
      direction: 'SELL_PE', instrument: 'PUT', optionType: 'PE',
    }));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/OPTION_BUYING_ONLY|Option selling/);
  });
});

// ─── 12. Equity/futures SELL permitted ──────────────────────────────────

describe('12 — equity/futures SELL remains permitted', () => {
  it('builds a real SELL candidate from structure and the validator accepts it in market hours', () => {
    const { ctx } = makeCtx();
    const built = buildCashCandidate('RELIANCE', grok('SELL', 'CASH_FUTURES'), [], ctx);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const c = built.candidate;

    expect(c.direction).toBe('SELL');
    expect(c.instrument).toBe('EQUITY');
    expect(c.exchange).toBe('NSE');
    expect(c.entry).toBe(24500);   // real spot — was grokCandidate.entry || 0
    expect(c.stopLoss).toBe(24600); // real resistance above spot
    expect(c.target1).toBe(24400);  // real support below spot
    expect(c.snapshotTimestamp).toBeTruthy();

    // The session clock is owned by the pipeline registration gate — the
    // candidate itself is clock-agnostic, so validate it as built.
    const v = validateCandidateTrade(c);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('cash engine still refuses when Grok did not route to it', async () => {
    const { ctx } = makeCtx();
    const r = await runCashFuturesEngine('RELIANCE', grok('SELL', 'OPTION'), [], ctx);
    expect(r.action).toBe('NO_TRADE');
  });
});

// ─── 13. Duplicate execution blocked ────────────────────────────────────

describe('13 — duplicate execution blocked', () => {
  it('the engine refuses while an active trade lock exists', async () => {
    const { ctx } = makeCtx();
    const lock = await acquireTradeLock({
      tradeId: 'dup-test-1',
      strategy: 'GROK_TEST',
      underlying: 'DUPTEST',
      exchange: 'NFO',
      optionType: 'CE',
      strike: 24500,
      expiry: EXPIRY,
      entry: 140,
      stopLoss: 126,
      target1: 180,
    });
    expect('tradeId' in lock && lock.tradeId).toBe('dup-test-1');

    try {
      const r = await runOptionEngine('DUPTEST', grok('BUY_CE', 'OPTION'), [], ctx);
      expect(r.action).toBe('NO_TRADE');
      expect(r.reasons.join(' ')).toMatch(/Active trade exists/);
    } finally {
      releaseTradeLock('DUPTEST', 'NFO');
    }
  });
});

// ─── 14–15. Telegram alert gating ───────────────────────────────────────

describe('14 — telegram alert only for approved, registered, non-dry-run trades', () => {
  it('resolveEntryAlert gate matrix', () => {
    expect(resolveEntryAlert({ dryRun: true, tradeRegistered: true, action: 'BUY_CE' })).toBe(false);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: false, action: 'BUY_CE' })).toBe(false);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: true, action: 'NO_TRADE' })).toBe(false);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: true, action: 'BUY_CE' })).toBe(true);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: true, action: 'BUY_PE' })).toBe(true);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: true, action: 'BUY' })).toBe(true);
    expect(resolveEntryAlert({ dryRun: false, tradeRegistered: true, action: 'SELL' })).toBe(true);
  });
});

describe('15 — dry-run never sends a live alert', () => {
  it('a dry-run pipeline never invokes the alert sender', async () => {
    const { ctx } = makeCtx();
    const sent: any[] = [];
    const res = await runFullPipeline('NIFTY', deadCtx(ctx), {
      dryRun: true,
      deps: {
        sendTradeAlert: async (p: any) => {
          sent.push(p);
          return true;
        },
      },
    });
    expect(sent).toHaveLength(0);
    expect(res.telegramAlert).toBe(false);
  });
});

// ─── 16. sendTradeAlert dedup intact ────────────────────────────────────

describe('16 — sendTradeAlert full-day dedup', () => {
  it('sends once, dedups the identical second signal', async () => {
    process.env.TELEGRAM_ALLOW_OFFHOURS = '1';
    process.env.TELEGRAM_BOT_TOKEN = '123:TESTTOKEN';
    process.env.TELEGRAM_CHAT_ID = '999';
    process.env.VOICE_ENABLED = '0';

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) } as any;
    }) as any;

    const p = {
      symbol: 'DEDUPTEST',
      action: 'BUY_CE',
      strike: 42424,
      type: 'CE',
      confidence: 71,
      entry: 100,
      stopLoss: 90,
      target1: 130,
      source: 'Grok Supervisor',
    };
    const first = await sendTradeAlert(p);
    const second = await sendTradeAlert(p);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(calls).toBe(1);
  });
});

// ─── 17–18. Freshness and market-hours gates ────────────────────────────

describe('17 — stale snapshot data blocks a trade', () => {
  it('a two-minute-old snapshot fails the canonical freshness checks', () => {
    const staleIso = new Date(Date.now() - 120_000).toISOString();
    const ctx = mapHermesToAgentContext(fakeHermes(staleIso), staleIso, '15m');
    const built = buildOptionCandidate('NIFTY', grok('BUY_CE', 'OPTION'), [], ctx);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const v = validateCandidateTrade(built.candidate);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/SNAPSHOT_FRESHNESS|OPTION_CHAIN_FRESHNESS/);
  });
});

describe('18 — market-closed blocks a trade', () => {
  it('MARKET_STATUS fails when the candidate carries a closed session', () => {
    const v = validateCandidateTrade(validOptionCandidate({ marketOpen: false, marketStatus: 'CLOSED' }));
    expect(v.valid).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/MARKET_STATUS|Market closed/);
  });

  it('the registration gate refuses to CREATE a trade when the session clock says closed', async () => {
    const { resolveRegistration } = await import('@/lib/agents/pipeline');
    // market-closed cannot create — even with an approved action
    expect(resolveRegistration({ dryRun: false, action: 'BUY_CE', marketOpen: false, halted: false }))
      .toEqual({ register: false, reason: 'market-closed' });
    expect(resolveRegistration({ dryRun: false, action: 'BUY', marketOpen: false, halted: false }))
      .toEqual({ register: false, reason: 'market-closed' });
    // open session + approved action → register
    expect(resolveRegistration({ dryRun: false, action: 'BUY_CE', marketOpen: true, halted: false }))
      .toEqual({ register: true });
    // dry-run and no-trade never register regardless of clock
    expect(resolveRegistration({ dryRun: true, action: 'BUY_CE', marketOpen: true, halted: false }).register).toBe(false);
    expect(resolveRegistration({ dryRun: false, action: 'NO_TRADE', marketOpen: true, halted: false }).register).toBe(false);
    // kill switch outranks the clock
    expect(resolveRegistration({ dryRun: false, action: 'BUY_CE', marketOpen: false, halted: true }))
      .toEqual({ register: false, reason: 'kill-switch' });
  });
});

// ─── 19–20. Existing-engine comparison (observation mode) ───────────────

describe('19–20 — existing-engine comparison record', () => {
  it('records the SDM signal direction + agreement when compare is requested', async () => {
    const { ctx } = makeCtx();
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/api/sdm-signal')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ signal: { direction: 'CALL', confidence: 72, strike: 24500 } }),
        } as any;
      }
      return { ok: false, status: 404, json: async () => ({}) } as any;
    }) as any;

    const res = await runFullPipeline('NIFTY', deadCtx(ctx), { dryRun: true, compare: true });
    const obs = res.observation;
    expect(obs.existingEngine).not.toBeNull();
    expect(obs.existingEngine?.engine).toBe('SDM_SIGNAL');
    expect(obs.existingEngine?.direction).toBe('CALL');
    expect(obs.existingEngine?.confidence).toBe(72);
    expect(typeof obs.existingEngine?.agreement).toBe('boolean');
  });

  it('degrades to null when the existing engine is unreachable', async () => {
    const { ctx } = makeCtx();
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as any;

    const res = await runFullPipeline('NIFTY', deadCtx(ctx), { dryRun: true, compare: true });
    expect(res.observation.existingEngine).toBeNull();
  });
});
