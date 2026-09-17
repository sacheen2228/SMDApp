// ═══════════════════════════════════════════════════════════════════════════
// Agent Tasks — Task creation, execution, completion
// ═══════════════════════════════════════════════════════════════════════════

import { createTask, startTask, completeTask, failTask, getTask, getTasksByAgent, getActiveTasks } from './registry';
import type { AgentTask, TaskType } from './types';

export function createMarketScanTask(
  agentId: string,
  underlying: string,
  strategy: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'MARKET_SCAN',
    underlying,
    strategy,
    priority: 'MEDIUM',
    input,
  });
}

export function createOptionScanTask(
  agentId: string,
  underlying: string,
  strategy: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'OPTION_SCAN',
    underlying,
    strategy,
    priority: 'HIGH',
    input,
  });
}

export function createCEPEComparisonTask(
  agentId: string,
  underlying: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'CE_PE_COMPARISON',
    underlying,
    strategy: 'INTRADAY_CE_PE',
    priority: 'HIGH',
    input,
  });
}

export function createExpiryResearchTask(
  agentId: string,
  underlying: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'EXPIRY_RESEARCH',
    underlying,
    strategy: 'EXPIRY_LIQUIDITY',
    priority: 'MEDIUM',
    input,
  });
}

export function createChartAnalysisTask(
  agentId: string,
  underlying: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'CHART_ANALYSIS',
    underlying,
    strategy: 'CHART_VISION',
    priority: 'MEDIUM',
    input,
  });
}

export function createActiveTradeMonitorTask(
  agentId: string,
  underlying: string,
  strategy: string,
  input: Record<string, any>
): AgentTask {
  return createTask({
    agentId,
    taskType: 'ACTIVE_TRADE_MONITOR',
    underlying,
    strategy,
    priority: 'HIGH',
    input,
  });
}

export function executeTask<T>(
  taskId: string,
  executor: () => Promise<T>
): Promise<{ ok: boolean; result?: T; error?: string }> {
  const task = startTask(taskId);
  if (!task) return Promise.resolve({ ok: false, error: `Task ${taskId} not found` });

  return executor()
    .then(result => {
      completeTask(taskId, { result } as any);
      return { ok: true, result };
    })
    .catch(error => {
      failTask(taskId, error.message);
      return { ok: false, error: error.message };
    });
}

export function getTaskStatus(taskId: string): AgentTask | null {
  return getTask(taskId);
}

export function getAgentTaskHistory(agentId: string): AgentTask[] {
  return getTasksByAgent(agentId);
}

export function getRunningTasks(): AgentTask[] {
  return getActiveTasks();
}

export function cancelTask(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || task.status !== 'QUEUED') return false;
  task.status = 'CANCELLED';
  return true;
}
