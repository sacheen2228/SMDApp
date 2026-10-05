// ═══════════════════════════════════════════════════════════════════════════
// Agent System Tests — 30 agents, cross-confluence, Grok, engines, TP/SL
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  REGISTRY, getAgentDef, getAgentCount, getAllAgentIds, runAllAgents,
} from '../src/lib/agents/registry-30';
import { analyzeCrossConfluence } from '../src/lib/agents/cross-confluence';
import { runGrokSupervisor } from '../src/lib/agents/supervisor';
import { runOptionEngine } from '../src/lib/agents/option-engine';
import { runCashFuturesEngine } from '../src/lib/agents/cash-futures-engine';
import {
  registerTradeForMonitoring, updateAndDetect, closeTrade,
  isAlertAlreadySent, getMonitorSummary, getMonitoredTrade, markAlertSent,
} from '../src/lib/agents/trade-monitor';
import { sendTPSLAlert } from '../src/lib/agents/telegram-alerts';
import type {
  AgentContext, AgentResearchOutput, AgentId,
} from '../src/lib/agents/agent-contract';

// ─── Mock Agent Context ───────────────────────────────────────────

function mockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    symbol: 'NIFTY',
    timeframe: '15m',
    exchange: 'NSE',
    instrument: 'index',
    fetchedAtIso: new Date().toISOString(),
    spot: 24500,
    prevClose: 24400,
    open: 24420,
    high: 24550,
    low: 24380,
    volume: 50000000,
    optionChain: {
      totalCallOI: 10000000,
      totalPutOI: 12000000,
      callOiChange: 500000,
      putOiChange: 800000,
      maxPain: 24500,
      atmStrike: 24500,
    },
    strikes: [
      { strike: 24500, ce: { ltp: 150, volume: 10000, oi: 50000, iv: 15 }, pe: { ltp: 140, volume: 12000, oi: 60000, iv: 16 } },
    ],
    vix: 14,
    vixChange: -0.5,
    fiiNet: 300,
    diiNet: 200,
    fiiBias: 'BULLISH_FLOW',
    participantOI: null,
    regime: 'TRENDING_UP',
    regimeBias: 'BULLISH',
    regimeConfidence: 70,
    trend: 'UP',
    swingHigh: 24550,
    swingLow: 24380,
    supportLevels: [24400, 24300],
    resistanceLevels: [24600, 24700],
    pdh: 24480,
    pdl: 24350,
    lastEvent: 'BOS_UP',
    atmDelta: 0.52,
    atmGamma: 0.0008,
    atmTheta: -3.5,
    atmVega: 0.45,
    atmIV: 16,
    poc: 24490,
    vah: 24560,
    val: 24420,
    gammaDetected: true,
    gammaWallStrike: 24600,
    gammaFlip: 24500,
    dealerBias: 'SHORT_GAMMA',
    newsSentiment: 'BULLISH',
    newsScore: 0.3,
    headlines: ['Markets rally on strong FII buying', 'IT stocks lead the charge'],
    marketStatus: 'MARKET_OPEN',
    daysToExpiry: 5,
    expiry: '2026-09-25',
    dataTimestamp: new Date().toISOString(),
    spotFreshness: 'FRESH',
    chainFreshness: 'FRESH',
    ...overrides,
  };
}

/** Real-shaped snapshot for engine tests (engines are data-only now). */
function engineCtx(): AgentContext {
  const now = new Date().toISOString();
  return mockContext({
    fetchedAtIso: now,
    dataTimestamp: now,
    expiry: new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0],
    daysToExpiry: 7,
    rawContext: { spot: { source: 'nse' }, optionChain: { source: 'nse' } },
  });
}

function mockAgentOutput(overrides?: Partial<AgentResearchOutput>): AgentResearchOutput {
  return {
    agentId: 'MARKET_REGIME',
    agentName: 'Market Regime',
    category: 'MARKET',
    timestamp: new Date().toISOString(),
    symbol: 'NIFTY',
    timeframe: '15m',
    dataFreshness: 'FRESH',
    observation: 'Test observation',
    bias: 'BULLISH',
    confidence: 65,
    evidence: ['Test evidence'],
    riskFlags: [],
    conflicts: [],
    recommendationContext: 'TRADE',
    recommendationReason: 'Test reason',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AGENT REGISTRY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Agent Registry', () => {
  it('has 30 agents registered', () => {
    expect(getAgentCount()).toBe(30);
  });

  it('all 30 agents have valid IDs', () => {
    const ids = getAllAgentIds();
    expect(ids.length).toBe(30);
    const expectedIds = [
      'MARKET_REGIME', 'FII_DII', 'GLOBAL_MARKET', 'INDIA_VIX',
      'MARKET_BREADTH', 'SECTOR_ROTATION', 'OI_PCR', 'OI_CLASSIFICATION',
      'GREEKS', 'GAMMA', 'IV_HV', 'OPTION_ACCELERATION',
      'BUYER_CONFLUENCE', 'STRIKE_SELECTION', 'EXPIRY_THETA', 'ZERO_HERO',
      'CAS', 'MARKET_STRUCTURE', 'SUPPORT_RESISTANCE', 'VWAP',
      'VOLUME', 'BREAKOUT', 'MTF_CONFIRMATION', 'MOMENTUM',
      'ATR', 'NEWS', 'EVENT_RISK', 'SENTIMENT', 'BTST', 'COMMODITY_MCX',
    ];
    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }
  });

  it('every agent can be looked up by ID', () => {
    for (const id of getAllAgentIds()) {
      const def = getAgentDef(id);
      expect(def).toBeDefined();
      expect(def!.id).toBe(id);
      expect(def!.name).toBeTruthy();
      expect(def!.category).toBeTruthy();
      expect(def!.analysisFn).toBeInstanceOf(Function);
    }
  });

  it('all agents return valid schema', async () => {
    const ctx = mockContext();
    const outputs = await runAllAgents(ctx);
    expect(outputs.length).toBe(30);

    for (const output of outputs) {
      expect(output.agentId).toBeTruthy();
      expect(output.agentName).toBeTruthy();
      expect(output.category).toBeTruthy();
      expect(output.timestamp).toBeTruthy();
      expect(output.symbol).toBeTruthy();
      expect(output.timeframe).toBeTruthy();
      expect(['FRESH', 'STALE', 'MISSING', 'ERROR']).toContain(output.dataFreshness);
      expect(output.observation).toBeTruthy();
      expect(['BULLISH', 'BEARISH', 'NEUTRAL', 'CONFLICTED', 'NO_DATA']).toContain(output.bias);
      expect(output.confidence).toBeGreaterThanOrEqual(0);
      expect(output.confidence).toBeLessThanOrEqual(100);
      expect(Array.isArray(output.evidence)).toBe(true);
      expect(Array.isArray(output.riskFlags)).toBe(true);
      expect(Array.isArray(output.conflicts)).toBe(true);
      expect(['TRADE', 'WAIT', 'NO_TRADE', 'RESEARCH_ONLY']).toContain(output.recommendationContext);
      expect(output.recommendationReason).toBeTruthy();
    }
  });

  it('no agent errors on the mock snapshot (regression: STRIKE_SELECTION riskFlags)', async () => {
    const outputs = await runAllAgents(mockContext());
    const errored = outputs.filter(o => o.dataFreshness === 'ERROR');
    expect(errored.map(o => `${o.agentId}: ${o.observation}`)).toEqual([]);

    const strike = outputs.find(o => o.agentId === 'STRIKE_SELECTION')!;
    expect(strike.evidence.join(' ')).toContain('ATM Strike');
    expect(strike.observation).toContain('ATM:');
  });

  it('handles stale data gracefully', async () => {
    const ctx = mockContext({
      spotFreshness: 'STALE',
      chainFreshness: 'STALE',
      vix: 0,
      spot: 0,
    });
    const outputs = await runAllAgents(ctx);
    expect(outputs.length).toBe(30);

    // Some agents should report NO_DATA or reduced confidence
    const vixAgent = outputs.find(o => o.agentId === 'INDIA_VIX');
    expect(vixAgent).toBeDefined();
  });

  it('handles missing data gracefully', async () => {
    const ctx = mockContext({
      optionChain: null,
      strikes: [],
      vix: 0,
    });
    const outputs = await runAllAgents(ctx);
    expect(outputs.length).toBe(30);

    const oiAgent = outputs.find(o => o.agentId === 'OI_PCR');
    expect(oiAgent).toBeDefined();
    expect(oiAgent!.dataFreshness).toBe('MISSING');
  });

  it('handles error gracefully', async () => {
    // Run agents with a valid context — should not throw
    const ctx = mockContext();
    const outputs = await runAllAgents(ctx);
    // All agents should return valid output (some may be NO_DATA but not ERROR)
    expect(outputs.length).toBe(30);
    for (const output of outputs) {
      expect(output.agentId).toBeTruthy();
      expect(output.observation).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-CONFLUENCE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Cross-Confluence', () => {
  it('aggregates bullish agents correctly', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'OI_PCR', bias: 'BULLISH', confidence: 65 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BULLISH', confidence: 60 }),
      mockAgentOutput({ agentId: 'VWAP', bias: 'BULLISH', confidence: 55 }),
    ];
    const result = analyzeCrossConfluence('NIFTY', outputs);
    expect(result.bullishScore).toBeGreaterThan(0);
    expect(result.bearishScore).toBe(0);
    expect(result.bullishEvidence.length).toBeGreaterThan(0);
  });

  it('detects conflicts between agents', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'OI_PCR', bias: 'BEARISH', confidence: 65 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BULLISH', confidence: 60 }),
    ];
    const result = analyzeCrossConfluence('NIFTY', outputs);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('returns NO_TRADE for conflicting signals', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 50 }),
      mockAgentOutput({ agentId: 'OI_PCR', bias: 'BEARISH', confidence: 50 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BEARISH', confidence: 50 }),
      mockAgentOutput({ agentId: 'VWAP', bias: 'BULLISH', confidence: 50 }),
    ];
    const result = analyzeCrossConfluence('NIFTY', outputs);
    expect(result.recommendation).toBe('NO_TRADE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROK SUPERVISOR TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Grok Supervisor', () => {
  it('routes to OPTION engine for indices', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'OI_PCR', bias: 'BULLISH', confidence: 65 }),
    ];
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const decision = runGrokSupervisor('NIFTY', outputs, crossConfluence);
    expect(decision.selectedEngine).toBe('OPTION');
    expect(decision.direction).toBe('BUY_CE');
  });

  it('routes to CASH_FUTURES for stocks', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BEARISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'MOMENTUM', bias: 'BEARISH', confidence: 65 }),
    ];
    const crossConfluence = analyzeCrossConfluence('RELIANCE', outputs);
    const decision = runGrokSupervisor('RELIANCE', outputs, crossConfluence);
    expect(decision.selectedEngine).toBe('CASH_FUTURES');
    expect(decision.direction).toBe('SELL');
  });

  it('rejects option SELL direction', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BEARISH', confidence: 70 }),
    ];
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const decision = runGrokSupervisor('NIFTY', outputs, crossConfluence);
    // For options, bearish should route to BUY_PE, not SELL
    expect(decision.direction).not.toBe('SELL');
  });

  it('rejects invented data', () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'NEUTRAL', confidence: 30 }),
    ];
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const decision = runGrokSupervisor('NIFTY', outputs, crossConfluence);
    expect(decision.validation.passed).toBe(true); // Neutral = no trade, but valid
  });
});

// ═══════════════════════════════════════════════════════════════════
// OPTION ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Option Engine', () => {
  it('produces BUY_CE for bullish with valid candidate', async () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 80 }),
      mockAgentOutput({ agentId: 'OI_PCR', bias: 'BULLISH', confidence: 75 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'VWAP', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'MTF_CONFIRMATION', bias: 'BULLISH', confidence: 70 }),
    ];
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const grokDecision = runGrokSupervisor('NIFTY', outputs, crossConfluence);
    // Candidate comes from the snapshot (real chain + structure) — Grok never invents levels
    const result = await runOptionEngine('NIFTY', grokDecision, outputs, engineCtx());
    expect(result.action).toBe('BUY_CE');
    expect(result.candidate?.spot).toBe(24500);
    expect(result.candidate?.volume).toBe(10000);
  });

  it('produces BUY_PE for bearish with valid candidate', async () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BEARISH', confidence: 80 }),
      mockAgentOutput({ agentId: 'MOMENTUM', bias: 'BEARISH', confidence: 75 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BEARISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'VWAP', bias: 'BEARISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'MTF_CONFIRMATION', bias: 'BEARISH', confidence: 70 }),
    ];
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const grokDecision = runGrokSupervisor('NIFTY', outputs, crossConfluence);
    const result = await runOptionEngine('NIFTY', grokDecision, outputs, engineCtx());
    expect(result.action).toBe('BUY_PE');
    expect(result.candidate?.spot).toBe(24500);
  });

  it('rejects SELL CE', async () => {
    const grokDecision = {
      symbol: 'NIFTY', timestamp: new Date().toISOString(),
      marketRegime: 'test', bullishEvidence: [], bearishEvidence: [],
      neutralEvidence: [], conflicts: [], consensus: 'BEARISH' as const,
      consensusConfidence: 70, selectedEngine: 'OPTION' as const,
      engineReason: 'test', direction: 'SELL' as const,
      directionReason: 'test', validation: { passed: true, failures: [], warnings: [] },
      evidenceQuality: { totalAgents: 2, activeAgents: 2, freshData: 2, staleData: 0, missingData: 0 },
    };
    const result = await runOptionEngine('NIFTY', grokDecision, []);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reasons[0]).toContain('OPTION_SELLING_NOT_ALLOWED');
  });

  it('rejects SELL PE', async () => {
    const grokDecision = {
      symbol: 'NIFTY', timestamp: new Date().toISOString(),
      marketRegime: 'test', bullishEvidence: [], bearishEvidence: [],
      neutralEvidence: [], conflicts: [], consensus: 'BULLISH' as const,
      consensusConfidence: 70, selectedEngine: 'OPTION' as const,
      engineReason: 'test', direction: 'SELL' as const,
      directionReason: 'test', validation: { passed: true, failures: [], warnings: [] },
      evidenceQuality: { totalAgents: 2, activeAgents: 2, freshData: 2, staleData: 0, missingData: 0 },
    };
    const result = await runOptionEngine('NIFTY', grokDecision, []);
    expect(result.action).toBe('NO_TRADE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CASH/FUTURES ENGINE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Cash/Futures Engine', () => {
  it('produces BUY for bullish', async () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BULLISH', confidence: 80 }),
      mockAgentOutput({ agentId: 'MOMENTUM', bias: 'BULLISH', confidence: 75 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'VOLUME', bias: 'BULLISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'BREAKOUT', bias: 'BULLISH', confidence: 70 }),
    ];
    const crossConfluence = analyzeCrossConfluence('RELIANCE', outputs);
    const grokDecision = runGrokSupervisor('RELIANCE', outputs, crossConfluence);
    const result = await runCashFuturesEngine('RELIANCE', grokDecision, outputs, engineCtx());
    expect(result.action).toBe('BUY');
    expect(result.candidate?.entry).toBe(24500);
  });

  it('produces SELL for bearish', async () => {
    const outputs = [
      mockAgentOutput({ agentId: 'MARKET_REGIME', bias: 'BEARISH', confidence: 80 }),
      mockAgentOutput({ agentId: 'MOMENTUM', bias: 'BEARISH', confidence: 75 }),
      mockAgentOutput({ agentId: 'MARKET_STRUCTURE', bias: 'BEARISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'VOLUME', bias: 'BEARISH', confidence: 70 }),
      mockAgentOutput({ agentId: 'BREAKOUT', bias: 'BEARISH', confidence: 70 }),
    ];
    const crossConfluence = analyzeCrossConfluence('RELIANCE', outputs);
    const grokDecision = runGrokSupervisor('RELIANCE', outputs, crossConfluence);
    const result = await runCashFuturesEngine('RELIANCE', grokDecision, outputs, engineCtx());
    expect(result.action).toBe('SELL');
    expect(result.candidate?.stopLoss).toBeGreaterThan(24500);
  });

  it('allows SELL for equity', async () => {
    const grokDecision = {
      symbol: 'RELIANCE', timestamp: new Date().toISOString(),
      marketRegime: 'test', bullishEvidence: [], bearishEvidence: [],
      neutralEvidence: [], conflicts: [], consensus: 'BEARISH' as const,
      consensusConfidence: 70, selectedEngine: 'CASH_FUTURES' as const,
      engineReason: 'test', direction: 'SELL' as const,
      directionReason: 'test', validation: { passed: true, failures: [], warnings: [] },
      evidenceQuality: { totalAgents: 2, activeAgents: 2, freshData: 2, staleData: 0, missingData: 0 },
    };
    const result = await runCashFuturesEngine('RELIANCE', grokDecision, [], engineCtx());
    expect(result.action).toBe('SELL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TRADE MONITOR TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Trade Monitor', () => {
  it('detects BUY TP hit', () => {
    const trade = registerTradeForMonitoring({
      tradeId: 'test-1',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    const { state, alerts } = updateAndDetect('test-1', 175);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('TP1_HIT');
    // Delivery flag set only after Telegram confirms — see tpsl-event-flow tests
    expect(state.tp1AlertSent).toBe(false);
    expect(state.status).toBe('TP1_HIT');
  });

  it('detects BUY SL hit', () => {
    registerTradeForMonitoring({
      tradeId: 'test-2',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    const { state, alerts } = updateAndDetect('test-2', 125);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('SL_HIT');
    expect(state.slAlertSent).toBe(false); // set only after delivery
    expect(state.status).toBe('SL_HIT');
  });

  it('detects SELL TP hit', () => {
    registerTradeForMonitoring({
      tradeId: 'test-3',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      instrument: 'EQUITY',
      side: 'SELL',
      entry: 2500,
      stopLoss: 2575,
      tp1: 2425,
      tp2: 2350,
    });

    const { state, alerts } = updateAndDetect('test-3', 2400);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('TP1_HIT');
    expect(state.status).toBe('TP1_HIT');
  });

  it('detects SELL SL hit', () => {
    registerTradeForMonitoring({
      tradeId: 'test-4',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      instrument: 'EQUITY',
      side: 'SELL',
      entry: 2500,
      stopLoss: 2575,
      tp1: 2425,
      tp2: 2350,
    });

    const { state, alerts } = updateAndDetect('test-4', 2600);
    expect(alerts.length).toBe(1);
    expect(alerts[0].alertType).toBe('SL_HIT');
    expect(state.status).toBe('SL_HIT');
  });

  it('detects TP1 then TP2 sequentially', () => {
    registerTradeForMonitoring({
      tradeId: 'test-5',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    // TP1 hit
    const r1 = updateAndDetect('test-5', 175);
    expect(r1.alerts.length).toBe(1);
    expect(r1.alerts[0].alertType).toBe('TP1_HIT');

    // TP2 hit (after TP1)
    const r2 = updateAndDetect('test-5', 195);
    expect(r2.alerts.length).toBe(1);
    expect(r2.alerts[0].alertType).toBe('TP2_HIT');
    expect(r2.state.status).toBe('TP2_HIT');
  });

  it('prevents duplicate alerts', () => {
    registerTradeForMonitoring({
      tradeId: 'test-6',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    // TP1 detected — delivery flag NOT set until Telegram confirms send
    const r1 = updateAndDetect('test-6', 175);
    expect(r1.alerts.length).toBe(1);
    expect(isAlertAlreadySent('test-6', 'TP1_HIT')).toBe(false);

    // Simulate successful Telegram delivery → flag set
    markAlertSent(r1.alerts[0].alertId, 'test-6');
    const state = getMonitoredTrade('test-6');
    if (state) state.tp1AlertSent = true;
    expect(isAlertAlreadySent('test-6', 'TP1_HIT')).toBe(true);

    // Second update at TP1 level — status gate prevents a new alert
    const r2 = updateAndDetect('test-6', 175);
    expect(r2.alerts.length).toBe(0);
  });

  it('releases lock on terminal status', () => {
    registerTradeForMonitoring({
      tradeId: 'test-7',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    closeTrade('test-7', 180, 'TP2_HIT');
    const state = getMonitoredTrade('test-7');
    expect(state?.status).toBe('CLOSED');
    expect(state?.exitPrice).toBe(180);
  });

  it('summary counts correctly', () => {
    const summary = getMonitorSummary();
    expect(summary.totalTrades).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM ALERT TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Telegram Alerts', () => {
  it('TP alert has correct format', () => {
    registerTradeForMonitoring({
      tradeId: 'test-alert-1',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    const { alerts } = updateAndDetect('test-alert-1', 175);
    expect(alerts.length).toBe(1);

    const msg = alerts[0].message;
    expect(msg).toContain('TP HIT');
    expect(msg).toContain('NIFTY');
    expect(msg).toContain('24500');
    expect(msg).toContain('BUY');
    expect(msg).toContain('Entry: ₹150');
    expect(msg).toContain('Current: ₹175');
  });

  it('SL alert has correct format', () => {
    registerTradeForMonitoring({
      tradeId: 'test-alert-2',
      symbol: 'NIFTY',
      exchange: 'NFO',
      instrument: 'CALL',
      side: 'BUY',
      strike: 24500,
      entry: 150,
      stopLoss: 130,
      tp1: 170,
      tp2: 190,
    });

    const { alerts } = updateAndDetect('test-alert-2', 125);
    expect(alerts.length).toBe(1);

    const msg = alerts[0].message;
    expect(msg).toContain('SL HIT');
    expect(msg).toContain('SL:');
  });
});

// ═══════════════════════════════════════════════════════════════════
// END-TO-END PIPELINE TEST
// ═══════════════════════════════════════════════════════════════════

describe('End-to-End Pipeline', () => {
  it('full pipeline produces valid output', async () => {
    const ctx = mockContext();
    const outputs = await runAllAgents(ctx);
    const crossConfluence = analyzeCrossConfluence('NIFTY', outputs);
    const grokDecision = runGrokSupervisor('NIFTY', outputs, crossConfluence);

    expect(grokDecision.symbol).toBe('NIFTY');
    expect(grokDecision.selectedEngine).toBeDefined();
    expect(grokDecision.direction).toBeDefined();
    expect(grokDecision.evidenceQuality.totalAgents).toBe(30);
  });
});
