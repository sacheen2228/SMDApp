// ═══════════════════════════════════════════════════════════════════════════
// Agent System — Main exports
// ═══════════════════════════════════════════════════════════════════════════

// Types
export * from './types';

// Registry (registration, lookup, heartbeat, health, tasks, signals, events)
export {
  registerAgent,
  getAgent,
  getAgentByName,
  getAllAgents,
  getAgentsByType,
  updateHeartbeat,
  getHeartbeat,
  getAllHeartbeats,
  checkStaleHeartbeats,
  getSystemHealth,
  createTask,
  startTask,
  completeTask,
  failTask,
  getTask,
  getTasksByAgent,
  getActiveTasks,
  createSignal,
  validateSignal,
  getSignal,
  getSignalsByAgent,
  getSignalFeed,
  emitEvent,
  getEvents,
  updatePerformance,
  getPerformance,
  forceAgentOffline,
  isFeatureEnabled,
} from './registry';

// Heartbeat monitoring
export {
  startHeartbeatMonitoring,
  stopHeartbeatMonitoring,
  recordHeartbeat,
  getAgentHealthSummary,
} from './heartbeat';

// Signal lifecycle
export {
  canTransition,
  transitionSignal,
  getSignalLifecycle,
  VALID_TRANSITIONS,
} from './signal-lifecycle';

// Tasks
export {
  createMarketScanTask,
  createOptionScanTask,
  createCEPEComparisonTask,
  createExpiryResearchTask,
  createChartAnalysisTask,
  createActiveTradeMonitorTask,
  executeTask,
  getTaskStatus,
  getAgentTaskHistory,
  getRunningTasks,
  cancelTask,
} from './tasks';

// Reputation
export {
  recordSignalOutcome,
  getAgentReputation,
  getLeaderboard,
} from './reputation';
