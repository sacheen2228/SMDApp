// ═══════════════════════════════════════════════════════════════════════════
// Agent Registry — Registration, lookup, heartbeat, health
// ═══════════════════════════════════════════════════════════════════════════

import type {
  Agent, AgentType, AgentStatus, AgentCapabilities,
  AgentHeartbeat, AgentTask, AgentSignal, AgentEvent,
  AgentPerformance, EventType,
} from './types';
import { INTERNAL_CAPABILITIES, EXTERNAL_CAPABILITIES } from './types';
import { randomBytes } from 'crypto';

// ─── In-Memory Registry ───────────────────────────────────────────
const agents = new Map<string, Agent>();
const heartbeats = new Map<string, AgentHeartbeat>();
const tasks = new Map<string, AgentTask>();
const signals = new Map<string, AgentSignal>();
const events: AgentEvent[] = [];
const performances = new Map<string, AgentPerformance>();

// ─── Feature Flags ────────────────────────────────────────────────
const FEATURE_FLAGS = {
  AGENT_SYSTEM_ENABLED: true,
  EXTERNAL_AGENT_ENABLED: true,
  AI_TRADER_ENABLED: false,
  AGENT_WEBSOCKET_ENABLED: true,
  AGENT_SIGNAL_FEED_ENABLED: true,
  AGENT_PERFORMANCE_ENABLED: true,
};

export function isFeatureEnabled(flag: keyof typeof FEATURE_FLAGS): boolean {
  return FEATURE_FLAGS[flag];
}

// ─── Agent Registration ───────────────────────────────────────────
export function registerAgent(params: {
  name: string;
  type: AgentType;
  version: string;
  description: string;
  capabilities?: Partial<AgentCapabilities>;
  metadata?: Record<string, any>;
}): Agent {
  const existing = Array.from(agents.values()).find(a => a.name === params.name);
  if (existing) {
    existing.version = params.version;
    existing.status = 'ACTIVE';
    existing.lastHeartbeatAt = new Date().toISOString();
    return existing;
  }

  const isExternal = params.type === 'EXTERNAL_AGENT';
  const defaultCaps = isExternal ? EXTERNAL_CAPABILITIES : INTERNAL_CAPABILITIES;

  const agent: Agent = {
    id: `agent-${params.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${randomBytes(4).toString('hex')}`,
    name: params.name,
    type: params.type,
    version: params.version,
    status: 'ACTIVE',
    capabilities: { ...defaultCaps, ...params.capabilities },
    description: params.description,
    createdAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    lastTaskAt: null,
    lastSignalAt: null,
    healthStatus: 'HEALTHY',
    metadata: params.metadata || {},
  };

  agents.set(agent.id, agent);
  emitEvent('AGENT_REGISTERED', agent.id, { name: agent.name, type: agent.type });
  return agent;
}

export function getAgent(agentId: string): Agent | null {
  return agents.get(agentId) || null;
}

export function getAgentByName(name: string): Agent | null {
  return Array.from(agents.values()).find(a => a.name === name) || null;
}

export function getAllAgents(): Agent[] {
  return Array.from(agents.values());
}

export function getAgentsByType(type: AgentType): Agent[] {
  return Array.from(agents.values()).filter(a => a.type === type);
}

// ─── Heartbeat ────────────────────────────────────────────────────
export function updateHeartbeat(agentId: string, heartbeat: Omit<AgentHeartbeat, 'agentId' | 'timestamp'>): AgentHeartbeat {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not registered`);

  const hb: AgentHeartbeat = {
    agentId,
    timestamp: new Date().toISOString(),
    ...heartbeat,
  };

  heartbeats.set(agentId, hb);
  agent.lastHeartbeatAt = hb.timestamp;
  agent.status = heartbeat.status;

  // Update health based on heartbeat
  if (heartbeat.lastError) {
    agent.healthStatus = 'UNHEALTHY';
  } else if (heartbeat.latencyMs > 5000) {
    agent.healthStatus = 'DEGRADED';
  } else {
    agent.healthStatus = 'HEALTHY';
  }

  emitEvent('AGENT_HEARTBEAT', agentId, { status: heartbeat.status, latencyMs: heartbeat.latencyMs });
  return hb;
}

export function getHeartbeat(agentId: string): AgentHeartbeat | null {
  return heartbeats.get(agentId) || null;
}

export function getAllHeartbeats(): AgentHeartbeat[] {
  return Array.from(heartbeats.values());
}

export function checkStaleHeartbeats(maxAgeMs: number = 60000): Agent[] {
  const now = Date.now();
  const stale: Agent[] = [];
  for (const agent of agents.values()) {
    if (!agent.lastHeartbeatAt) continue;
    const age = now - new Date(agent.lastHeartbeatAt).getTime();
    if (age > maxAgeMs && agent.status !== 'OFFLINE') {
      agent.status = 'OFFLINE';
      agent.healthStatus = 'UNHEALTHY';
      stale.push(agent);
    }
  }
  return stale;
}

// ─── Health ───────────────────────────────────────────────────────
export function getSystemHealth(): {
  totalAgents: number;
  activeAgents: number;
  degradedAgents: number;
  offlineAgents: number;
  lastHeartbeat: string | null;
  currentTasks: number;
  failedTasks: number;
  averageLatency: number;
} {
  const allAgents = Array.from(agents.values());
  const allHeartbeats = Array.from(heartbeats.values());
  const allTasks = Array.from(tasks.values());

  const activeAgents = allAgents.filter(a => a.status === 'ACTIVE').length;
  const degradedAgents = allAgents.filter(a => a.healthStatus === 'DEGRADED').length;
  const offlineAgents = allAgents.filter(a => a.status === 'OFFLINE').length;

  const currentTasks = allTasks.filter(t => t.status === 'RUNNING').length;
  const failedTasks = allTasks.filter(t => t.status === 'FAILED').length;

  const latencies = allHeartbeats.map(h => h.latencyMs).filter(l => l > 0);
  const averageLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  const lastHeartbeat = allHeartbeats
    .map(h => h.timestamp)
    .sort()
    .reverse()[0] || null;

  return {
    totalAgents: allAgents.length,
    activeAgents,
    degradedAgents,
    offlineAgents,
    lastHeartbeat,
    currentTasks,
    failedTasks,
    averageLatency: Math.round(averageLatency),
  };
}

// ─── Tasks ────────────────────────────────────────────────────────
export function createTask(params: {
  agentId: string;
  taskType: AgentTask['taskType'];
  underlying: string;
  strategy: string;
  priority: AgentTask['priority'];
  input: Record<string, any>;
}): AgentTask {
  const agent = agents.get(params.agentId);
  if (!agent) throw new Error(`Agent ${params.agentId} not registered`);

  const task: AgentTask = {
    id: `task-${randomBytes(6).toString('hex')}`,
    agentId: params.agentId,
    taskType: params.taskType,
    underlying: params.underlying,
    strategy: params.strategy,
    priority: params.priority,
    status: 'QUEUED',
    input: params.input,
    output: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };

  tasks.set(task.id, task);
  agent.lastTaskAt = new Date().toISOString();
  emitEvent('TASK_CREATED', params.agentId, { taskId: task.id, taskType: params.taskType });
  return task;
}

export function startTask(taskId: string): AgentTask | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  task.status = 'RUNNING';
  task.startedAt = new Date().toISOString();
  emitEvent('TASK_STARTED', task.agentId, { taskId });
  return task;
}

export function completeTask(taskId: string, output: Record<string, any>): AgentTask | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  task.status = 'COMPLETED';
  task.output = output;
  task.completedAt = new Date().toISOString();
  emitEvent('TASK_COMPLETED', task.agentId, { taskId });
  return task;
}

export function failTask(taskId: string, error: string): AgentTask | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  task.status = 'FAILED';
  task.error = error;
  task.completedAt = new Date().toISOString();
  emitEvent('TASK_FAILED', task.agentId, { taskId, error });
  return task;
}

export function getTask(taskId: string): AgentTask | null {
  return tasks.get(taskId) || null;
}

export function getTasksByAgent(agentId: string): AgentTask[] {
  return Array.from(tasks.values()).filter(t => t.agentId === agentId);
}

export function getActiveTasks(): AgentTask[] {
  return Array.from(tasks.values()).filter(t => t.status === 'RUNNING' || t.status === 'QUEUED');
}

// ─── Signals ──────────────────────────────────────────────────────
export function createSignal(params: {
  agentId: string;
  market: string;
  exchange: string;
  underlying: string;
  signalType: AgentSignal['signalType'];
  direction: AgentSignal['direction'];
  optionType?: 'CE' | 'PE';
  strike?: number;
  expiry?: string;
  entryPrice?: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  confidence: number;
  thesis: string;
  evidence: Partial<AgentSignal['evidence']>;
  dataSource: string;
  dataFreshness: string;
  marketSnapshotId?: string;
  canonicalSnapshotTimestamp?: string;
}): AgentSignal {
  const agent = agents.get(params.agentId);
  if (!agent) throw new Error(`Agent ${params.agentId} not registered`);

  const signal: AgentSignal = {
    id: `sig-${randomBytes(6).toString('hex')}`,
    agentId: params.agentId,
    timestamp: new Date().toISOString(),
    market: params.market,
    exchange: params.exchange,
    underlying: params.underlying,
    signalType: params.signalType,
    direction: params.direction,
    optionType: params.optionType || null,
    strike: params.strike || null,
    expiry: params.expiry || null,
    entryPrice: params.entryPrice || null,
    stopLoss: params.stopLoss || null,
    target1: params.target1 || null,
    target2: params.target2 || null,
    confidence: params.confidence,
    thesis: params.thesis,
    evidence: {
      priceStructure: null, vwap: null, volume: null, callOI: null, putOI: null,
      oiMigration: null, sellerMap: null, delta: null, gamma: null, iv: null,
      vix: null, frvp: null, poc: null, vah: null, val: null, liquidity: null,
      absorption: null, cas: null, breadth: null, fiiDii: null, global: null, news: null,
      ...params.evidence,
    },
    marketSnapshotId: params.marketSnapshotId || null,
    canonicalSnapshotTimestamp: params.canonicalSnapshotTimestamp || null,
    dataSource: params.dataSource,
    dataFreshness: params.dataFreshness,
    validationStatus: 'PENDING',
    executionStatus: 'NONE',
    lifecycle: 'RESEARCH',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min default
  };

  signals.set(signal.id, signal);
  agent.lastSignalAt = signal.timestamp;
  emitEvent('SIGNAL_CREATED', params.agentId, { signalId: signal.id, direction: params.direction });
  return signal;
}

export function validateSignal(signalId: string, valid: boolean, reason?: string): AgentSignal | null {
  const signal = signals.get(signalId);
  if (!signal) return null;
  signal.validationStatus = valid ? 'VALIDATED' : 'REJECTED';
  if (!valid && reason) signal.thesis += ` [REJECTED: ${reason}]`;
  emitEvent(valid ? 'SIGNAL_VALIDATED' : 'SIGNAL_REJECTED', signal.agentId, { signalId, reason });
  return signal;
}

export function getSignal(signalId: string): AgentSignal | null {
  return signals.get(signalId) || null;
}

export function getSignalsByAgent(agentId: string): AgentSignal[] {
  return Array.from(signals.values()).filter(s => s.agentId === agentId);
}

export function getSignalFeed(filters?: {
  underlying?: string;
  exchange?: string;
  signalType?: AgentSignal['signalType'];
  agentId?: string;
  direction?: SignalDirection;
}): AgentSignal[] {
  let result = Array.from(signals.values());
  if (filters?.underlying) result = result.filter(s => s.underlying === filters.underlying);
  if (filters?.exchange) result = result.filter(s => s.exchange === filters.exchange);
  if (filters?.signalType) result = result.filter(s => s.signalType === filters.signalType);
  if (filters?.agentId) result = result.filter(s => s.agentId === filters.agentId);
  if (filters?.direction) result = result.filter(s => s.direction === filters.direction);
  return result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

type SignalDirection = AgentSignal['direction'];

// ─── Events ───────────────────────────────────────────────────────
export function emitEvent(eventType: EventType, agentId: string, data: Record<string, any>): AgentEvent {
  const idempotencyKey = `${agentId}-${eventType}-${Math.floor(Date.now() / 5000)}`;

  // Check for duplicate within 5s window
  const existing = events.find(e => e.idempotencyKey === idempotencyKey);
  if (existing) return existing;

  const event: AgentEvent = {
    eventId: `evt-${randomBytes(6).toString('hex')}`,
    eventType,
    agentId,
    timestamp: new Date().toISOString(),
    data,
    idempotencyKey,
  };

  events.push(event);
  // Keep last 1000 events
  if (events.length > 1000) events.splice(0, events.length - 1000);
  return event;
}

export function getEvents(filters?: {
  agentId?: string;
  eventType?: EventType;
  since?: string;
  limit?: number;
}): AgentEvent[] {
  let result = [...events];
  if (filters?.agentId) result = result.filter(e => e.agentId === filters.agentId);
  if (filters?.eventType) result = result.filter(e => e.eventType === filters.eventType);
  if (filters?.since) result = result.filter(e => e.timestamp >= filters.since!);
  result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  if (filters?.limit) result = result.slice(0, filters.limit);
  return result;
}

// ─── Performance ──────────────────────────────────────────────────
export function updatePerformance(agentId: string, update: Partial<AgentPerformance>): void {
  const existing = performances.get(agentId);
  if (existing) {
    Object.assign(existing, update);
  } else {
    performances.set(agentId, {
      agentId,
      period: new Date().toISOString().split('T')[0],
      totalSignals: 0, validSignals: 0, closedTrades: 0, winners: 0, losers: 0,
      totalR: 0, averageR: 0, maxDrawdown: 0, staleSignals: 0, invalidSignals: 0, conflicts: 0,
      ...update,
    });
  }
}

export function getPerformance(agentId: string): AgentPerformance | null {
  return performances.get(agentId) || null;
}

// ─── Force Offline ────────────────────────────────────────────────
export function forceAgentOffline(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.status = 'OFFLINE';
  agent.healthStatus = 'UNHEALTHY';
  return true;
}
