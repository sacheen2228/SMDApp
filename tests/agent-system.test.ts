// ═══════════════════════════════════════════════════════════════════════════
// Agent System Tests — Registry, Heartbeat, Tasks, Signals, Events, Reputation
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerAgent,
  getAgent,
  getAgentByName,
  getAllAgents,
  updateHeartbeat,
  getHeartbeat,
  getSystemHealth,
  createTask,
  startTask,
  completeTask,
  failTask,
  getTask,
  createSignal,
  validateSignal,
  getSignal,
  getSignalFeed,
  emitEvent,
  getEvents,
  isFeatureEnabled,
  forceAgentOffline,
  checkStaleHeartbeats,
  updatePerformance,
  getPerformance,
} from '@/lib/agents/registry';
import {
  canTransition,
  transitionSignal,
  getSignalLifecycle,
} from '@/lib/agents/signal-lifecycle';
import {
  recordSignalOutcome,
  getAgentReputation,
  getLeaderboard,
} from '@/lib/agents/reputation';
import {
  validateExternalSignal,
} from '@/lib/external/ai-trader/validator';
import {
  normalizeSignal,
} from '@/lib/external/ai-trader/normalizer';
import {
  isDuplicateSignal,
  cacheSignal,
  clearSignalCache,
} from '@/lib/external/ai-trader/cache';
import type { AgentSignal, AgentCapabilities } from '@/lib/agents/types';
import type { AITraderSignal } from '@/lib/external/ai-trader/types';

describe('Agent Registry', () => {
  beforeEach(() => {
    // Reset by clearing all agents
    // (In-memory store, tests will create fresh agents)
  });

  it('should register internal agent', () => {
    const agent = registerAgent({
      name: 'HERMES-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Test Hermes agent',
    });

    expect(agent.id).toContain('hermes-test');
    expect(agent.name).toBe('HERMES-TEST');
    expect(agent.type).toBe('HERMES');
    expect(agent.version).toBe('2.0');
    expect(agent.status).toBe('ACTIVE');
    expect(agent.healthStatus).toBe('HEALTHY');
    expect(agent.capabilities.tradeExecution).toBe(true);
  });

  it('should register external agent with limited capabilities', () => {
    const agent = registerAgent({
      name: 'EXTERNAL-TEST',
      type: 'EXTERNAL_AGENT',
      version: '0.1',
      description: 'Test external agent',
    });

    expect(agent.type).toBe('EXTERNAL_AGENT');
    expect(agent.capabilities.tradeExecution).toBe(false);
    expect(agent.capabilities.marketSnapshot).toBe(false);
    expect(agent.capabilities.tradeResearch).toBe(true);
  });

  it('should find agent by name', () => {
    registerAgent({
      name: 'FIND-ME',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Findable agent',
    });

    const found = getAgentByName('FIND-ME');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('FIND-ME');
  });

  it('should return null for non-existent agent', () => {
    const found = getAgentByName('DOES-NOT-EXIST');
    expect(found).toBeNull();
  });

  it('should update agent status on re-registration', () => {
    const agent1 = registerAgent({
      name: 'RE-REGISTER',
      type: 'SYSTEM',
      version: '1.0',
      description: 'First registration',
    });

    const agent2 = registerAgent({
      name: 'RE-REGISTER',
      type: 'SYSTEM',
      version: '2.0',
      description: 'Second registration',
    });

    expect(agent1.id).toBe(agent2.id);
    expect(agent2.version).toBe('2.0');
  });
});

describe('Agent Heartbeat', () => {
  it('should record heartbeat', () => {
    const agent = registerAgent({
      name: 'HEARTBEAT-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Heartbeat test',
    });

    const hb = updateHeartbeat(agent.id, {
      status: 'ACTIVE',
      latencyMs: 150,
      currentMarket: 'NIFTY',
    });

    expect(hb.agentId).toBe(agent.id);
    expect(hb.status).toBe('ACTIVE');
    expect(hb.latencyMs).toBe(150);
    expect(hb.currentMarket).toBe('NIFTY');

    const stored = getHeartbeat(agent.id);
    expect(stored).not.toBeNull();
    expect(stored!.latencyMs).toBe(150);
  });

  it('should update health based on heartbeat', () => {
    const agent = registerAgent({
      name: 'HEALTH-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Health test',
    });

    // Normal heartbeat
    updateHeartbeat(agent.id, {
      status: 'ACTIVE',
      latencyMs: 100,
    });
    expect(agent.healthStatus).toBe('HEALTHY');

    // High latency
    updateHeartbeat(agent.id, {
      status: 'ACTIVE',
      latencyMs: 10000,
    });
    expect(agent.healthStatus).toBe('DEGRADED');

    // Error
    updateHeartbeat(agent.id, {
      status: 'ERROR',
      latencyMs: 100,
      lastError: 'Connection failed',
    });
    expect(agent.healthStatus).toBe('UNHEALTHY');
  });
});

describe('System Health', () => {
  it('should return health summary', () => {
    const health = getSystemHealth();
    expect(health).toHaveProperty('totalAgents');
    expect(health).toHaveProperty('activeAgents');
    expect(health).toHaveProperty('averageLatency');
  });
});

describe('Agent Tasks', () => {
  it('should create and complete task', () => {
    const agent = registerAgent({
      name: 'TASK-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Task test',
    });

    const task = createTask({
      agentId: agent.id,
      taskType: 'MARKET_SCAN',
      underlying: 'NIFTY',
      strategy: 'INTRADAY',
      priority: 'HIGH',
      input: { scanType: 'full' },
    });

    expect(task.id).toContain('task-');
    expect(task.status).toBe('QUEUED');
    expect(task.underlying).toBe('NIFTY');

    // Start
    const started = startTask(task.id);
    expect(started!.status).toBe('RUNNING');
    expect(started!.startedAt).not.toBeNull();

    // Complete
    const completed = completeTask(task.id, { result: 'success' });
    expect(completed!.status).toBe('COMPLETED');
    expect(completed!.output).toEqual({ result: 'success' });
  });

  it('should fail task', () => {
    const agent = registerAgent({
      name: 'FAIL-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Fail test',
    });

    const task = createTask({
      agentId: agent.id,
      taskType: 'OPTION_SCAN',
      underlying: 'BANKNIFTY',
      strategy: 'INTRADAY',
      priority: 'MEDIUM',
      input: {},
    });

    const failed = failTask(task.id, 'API timeout');
    expect(failed!.status).toBe('FAILED');
    expect(failed!.error).toBe('API timeout');
  });
});

describe('Agent Signals', () => {
  it('should create signal', () => {
    const agent = registerAgent({
      name: 'SIGNAL-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Signal test',
    });

    const signal = createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_CE',
      optionType: 'CE',
      strike: 25000,
      expiry: '18-09-2026',
      entryPrice: 150,
      stopLoss: 120,
      target1: 200,
      target2: 250,
      confidence: 0.75,
      thesis: 'Bullish momentum with OI support',
      evidence: {
        priceStructure: 'Above VWAP',
        volume: 'Above average',
        callOI: 'Building',
      },
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    expect(signal.id).toContain('sig-');
    expect(signal.direction).toBe('BUY_CE');
    expect(signal.confidence).toBe(0.75);
    expect(signal.lifecycle).toBe('RESEARCH');
    expect(signal.validationStatus).toBe('PENDING');
  });

  it('should validate signal', () => {
    const agent = registerAgent({
      name: 'VALIDATE-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Validate test',
    });

    const signal = createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_PE',
      optionType: 'PE',
      strike: 24500,
      expiry: '18-09-2026',
      entryPrice: 100,
      confidence: 0.8,
      thesis: 'Bearish setup',
      evidence: {},
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    const validated = validateSignal(signal.id, true);
    expect(validated!.validationStatus).toBe('VALIDATED');

    const rejected = validateSignal(signal.id, false, 'Low confidence');
    expect(rejected!.validationStatus).toBe('REJECTED');
  });

  it('should filter signal feed', () => {
    const agent = registerAgent({
      name: 'FEED-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Feed test',
    });

    createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_CE',
      confidence: 0.7,
      thesis: 'Test',
      evidence: {},
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'BANKNIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_PE',
      confidence: 0.8,
      thesis: 'Test',
      evidence: {},
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    const allSignals = getSignalFeed();
    expect(allSignals.length).toBeGreaterThanOrEqual(2);

    const niftyOnly = getSignalFeed({ underlying: 'NIFTY' });
    expect(niftyOnly.every(s => s.underlying === 'NIFTY')).toBe(true);
  });
});

describe('Agent Events', () => {
  it('should emit and retrieve events', () => {
    const agent = registerAgent({
      name: 'EVENT-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Event test',
    });

    emitEvent('AGENT_REGISTERED', agent.id, { name: agent.name });
    emitEvent('AGENT_HEARTBEAT', agent.id, { status: 'ACTIVE' });

    const events = getEvents({ agentId: agent.id });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].eventType).toMatch(/AGENT_/);
  });

  it('should deduplicate events within 5s window', () => {
    const agent = registerAgent({
      name: 'DEDUP-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Dedup test',
    });

    const e1 = emitEvent('AGENT_HEARTBEAT', agent.id, { status: 'ACTIVE' });
    const e2 = emitEvent('AGENT_HEARTBEAT', agent.id, { status: 'ACTIVE' });

    expect(e1.eventId).toBe(e2.eventId);
  });
});

describe('Agent Performance', () => {
  it('should update performance', () => {
    const agent = registerAgent({
      name: 'PERF-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Performance test',
    });

    updatePerformance(agent.id, {
      totalSignals: 10,
      validSignals: 8,
      closedTrades: 5,
      winners: 3,
      losers: 2,
      totalR: 4.5,
      averageR: 0.9,
    });

    const perf = getPerformance(agent.id);
    expect(perf).not.toBeNull();
    expect(perf!.totalSignals).toBe(10);
    expect(perf!.winners).toBe(3);
  });
});

describe('Signal Lifecycle', () => {
  it('should allow valid transitions', () => {
    expect(canTransition('RESEARCH', 'CANDIDATE')).toBe(true);
    expect(canTransition('CANDIDATE', 'VALIDATING')).toBe(true);
    expect(canTransition('VALIDATING', 'VALIDATED')).toBe(true);
    expect(canTransition('VALIDATED', 'FINAL')).toBe(true);
    expect(canTransition('FINAL', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'TP1')).toBe(true);
    expect(canTransition('ACTIVE', 'TP2')).toBe(true);
    expect(canTransition('ACTIVE', 'EXIT')).toBe(true);
    expect(canTransition('ACTIVE', 'SL')).toBe(true);
    expect(canTransition('TP1', 'TP2')).toBe(true);
    expect(canTransition('TP2', 'EXIT')).toBe(true);
    expect(canTransition('EXIT', 'POST_TRADE_REVIEW')).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(canTransition('RESEARCH', 'ACTIVE')).toBe(false);
    expect(canTransition('RESEARCH', 'TP1')).toBe(false);
    expect(canTransition('ACTIVE', 'CANDIDATE')).toBe(false);
    expect(canTransition('FINAL', 'RESEARCH')).toBe(false);
  });

  it('should transition signal', () => {
    const agent = registerAgent({
      name: 'LIFECYCLE-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Lifecycle test',
    });

    const signal = createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_CE',
      confidence: 0.8,
      thesis: 'Test',
      evidence: {},
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    expect(signal.lifecycle).toBe('RESEARCH');

    const t1 = transitionSignal(signal.id, 'CANDIDATE');
    expect(t1.ok).toBe(true);
    expect(t1.signal!.lifecycle).toBe('CANDIDATE');

    const t2 = transitionSignal(signal.id, 'VALIDATING');
    expect(t2.ok).toBe(true);
    expect(t2.signal!.lifecycle).toBe('VALIDATING');

    const t3 = transitionSignal(signal.id, 'VALIDATED');
    expect(t3.ok).toBe(true);
    expect(t3.signal!.lifecycle).toBe('VALIDATED');
  });

  it('should reject invalid transition', () => {
    const agent = registerAgent({
      name: 'INVALID-TRANSITION',
      type: 'HERMES',
      version: '2.0',
      description: 'Invalid transition test',
    });

    const signal = createSignal({
      agentId: agent.id,
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'CANDIDATE',
      direction: 'BUY_CE',
      confidence: 0.8,
      thesis: 'Test',
      evidence: {},
      dataSource: 'MOAPI',
      dataFreshness: 'LIVE',
    });

    const result = transitionSignal(signal.id, 'ACTIVE');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid transition');
  });
});

describe('External Signal Validation', () => {
  it('should reject SELL signals', () => {
    const signal: AgentSignal = {
      id: 'test',
      agentId: 'test',
      timestamp: new Date().toISOString(),
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'EXTERNAL',
      direction: 'SELL_CE',
      optionType: 'CE',
      strike: 25000,
      expiry: '18-09-2026',
      entryPrice: 150,
      stopLoss: 180,
      target1: 120,
      target2: 100,
      confidence: 0.9,
      thesis: 'Test',
      evidence: {
        priceStructure: null, vwap: null, volume: null, callOI: null, putOI: null,
        oiMigration: null, sellerMap: null, delta: null, gamma: null, iv: null,
        vix: null, frvp: null, poc: null, vah: null, val: null, liquidity: null,
        absorption: null, cas: null, breadth: null, fiiDii: null, global: null, news: null,
      },
      dataSource: 'EXTERNAL_AGENT',
      dataFreshness: 'SNAPSHOT',
      validationStatus: 'PENDING',
      executionStatus: 'NONE',
      lifecycle: 'CANDIDATE',
      expiresAt: null,
    };

    const result = validateExternalSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('SELL'))).toBe(true);
  });

  it('should reject low confidence signals', () => {
    const signal: AgentSignal = {
      id: 'test',
      agentId: 'test',
      timestamp: new Date().toISOString(),
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'EXTERNAL',
      direction: 'BUY_CE',
      optionType: 'CE',
      strike: 25000,
      expiry: '18-09-2026',
      entryPrice: 150,
      stopLoss: 120,
      target1: 200,
      target2: 250,
      confidence: 0.3,
      thesis: 'Test',
      evidence: {
        priceStructure: null, vwap: null, volume: null, callOI: null, putOI: null,
        oiMigration: null, sellerMap: null, delta: null, gamma: null, iv: null,
        vix: null, frvp: null, poc: null, vah: null, val: null, liquidity: null,
        absorption: null, cas: null, breadth: null, fiiDii: null, global: null, news: null,
      },
      dataSource: 'EXTERNAL_AGENT',
      dataFreshness: 'SNAPSHOT',
      validationStatus: 'PENDING',
      executionStatus: 'NONE',
      lifecycle: 'CANDIDATE',
      expiresAt: null,
    };

    const result = validateExternalSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.reasons.some(r => r.includes('Confidence'))).toBe(true);
  });

  it('should accept valid BUY_CE signal', () => {
    const signal: AgentSignal = {
      id: 'test',
      agentId: 'test',
      timestamp: new Date().toISOString(),
      market: 'INDIA',
      exchange: 'NSE',
      underlying: 'NIFTY',
      signalType: 'EXTERNAL',
      direction: 'BUY_CE',
      optionType: 'CE',
      strike: 25000,
      expiry: '18-09-2026',
      entryPrice: 150,
      stopLoss: 120,
      target1: 200,
      target2: 250,
      confidence: 0.8,
      thesis: 'Bullish momentum',
      evidence: {
        priceStructure: 'Above VWAP', vwap: null, volume: 'High', callOI: null, putOI: null,
        oiMigration: null, sellerMap: null, delta: null, gamma: null, iv: null,
        vix: null, frvp: null, poc: null, vah: null, val: null, liquidity: null,
        absorption: null, cas: null, breadth: null, fiiDii: null, global: null, news: null,
      },
      dataSource: 'EXTERNAL_AGENT',
      dataFreshness: 'SNAPSHOT',
      validationStatus: 'PENDING',
      executionStatus: 'NONE',
      lifecycle: 'CANDIDATE',
      expiresAt: null,
    };

    const result = validateExternalSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.reasons.length).toBe(0);
  });
});

describe('External Signal Normalization', () => {
  it('should normalize BUY_CE signal', () => {
    const ext: AITraderSignal = {
      id: 'ext-123',
      agent_name: 'AI-Trader',
      timestamp: new Date().toISOString(),
      symbol: 'NIFTY',
      action: 'BUY_CE',
      strike: 25000,
      expiry: '18-09-2026',
      entry_price: 150,
      stop_loss: 120,
      target1: 200,
      target2: 250,
      confidence: 0.8,
      thesis: 'Bullish momentum',
      source: 'AI_TRADER',
    };

    const normalized = normalizeSignal(ext, 'agent-123');
    expect(normalized.direction).toBe('BUY_CE');
    expect(normalized.optionType).toBe('CE');
    expect(normalized.underlying).toBe('NIFTY');
    expect(normalized.strike).toBe(25000);
  });

  it('should reject SELL signals', () => {
    const ext: AITraderSignal = {
      id: 'ext-456',
      agent_name: 'AI-Trader',
      timestamp: new Date().toISOString(),
      symbol: 'NIFTY',
      action: 'SELL_CE',
      confidence: 0.8,
      thesis: 'Bearish',
      source: 'AI_TRADER',
    };

    expect(() => normalizeSignal(ext, 'agent-123')).toThrow('SELL signals not allowed');
  });
});

describe('Signal Cache', () => {
  beforeEach(() => {
    clearSignalCache();
  });

  it('should detect duplicate signals', () => {
    const signal: AITraderSignal = {
      id: 'cache-1',
      agent_name: 'TEST',
      timestamp: new Date().toISOString(),
      symbol: 'NIFTY',
      action: 'BUY_CE',
      confidence: 0.8,
      thesis: 'Test',
      source: 'TEST',
    };

    expect(isDuplicateSignal(signal)).toBe(false);
    cacheSignal(signal);
    expect(isDuplicateSignal(signal)).toBe(true);
  });
});

describe('Agent Reputation', () => {
  it('should calculate reputation', () => {
    const agent = registerAgent({
      name: 'REP-TEST',
      type: 'HERMES',
      version: '2.0',
      description: 'Reputation test',
    });

    recordSignalOutcome(agent.id, { valid: true, tradeResult: 'WIN', rMultiple: 2.0 });
    recordSignalOutcome(agent.id, { valid: true, tradeResult: 'LOSS', rMultiple: -1.0 });
    recordSignalOutcome(agent.id, { valid: true, tradeResult: 'WIN', rMultiple: 1.5 });

    const rep = getAgentReputation(agent.id);
    expect(rep.totalSignals).toBe(3);
    expect(rep.totalTrades).toBe(3);
    expect(rep.winRate).toBeCloseTo(66.67, 0);
    expect(rep.rank).toMatch(/ROOKIE|NOVICE|INTERMEDIATE|EXPERT|MASTER/);
  });
});

describe('Feature Flags', () => {
  it('should have correct defaults', () => {
    expect(isFeatureEnabled('AGENT_SYSTEM_ENABLED')).toBe(true);
    expect(isFeatureEnabled('EXTERNAL_AGENT_ENABLED')).toBe(true);
    expect(isFeatureEnabled('AI_TRADER_ENABLED')).toBe(false);
    expect(isFeatureEnabled('AGENT_WEBSOCKET_ENABLED')).toBe(true);
    expect(isFeatureEnabled('AGENT_SIGNAL_FEED_ENABLED')).toBe(true);
    expect(isFeatureEnabled('AGENT_PERFORMANCE_ENABLED')).toBe(true);
  });
});

describe('Force Agent Offline', () => {
  it('should force agent offline', () => {
    const agent = registerAgent({
      name: 'OFFLINE-TEST',
      type: 'SYSTEM',
      version: '1.0',
      description: 'Offline test',
    });

    expect(agent.status).toBe('ACTIVE');
    const result = forceAgentOffline(agent.id);
    expect(result).toBe(true);
    expect(agent.status).toBe('OFFLINE');
  });

  it('should return false for non-existent agent', () => {
    const result = forceAgentOffline('non-existent');
    expect(result).toBe(false);
  });
});
