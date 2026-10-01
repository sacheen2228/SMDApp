// ═══════════════════════════════════════════════════════════════════════════
// Agent System Index — clean exports for the 30-agent system
// ═══════════════════════════════════════════════════════════════════════════

// Types
export type {
  AgentId, AgentCategory, AgentBias, AgentRecommendation,
  AgentResearchOutput, AgentDefinition, AgentContext,
  CrossConfluenceInput, CrossConfluenceOutput,
  GrokDecision, TradeMonitorState, TPSLAlert, TPSLAlertType,
  TradeDecisionRecord,
} from './agent-contract';

// Registry
export {
  REGISTRY, getAgentDef, getAgentsByCategory, getAgentsForInstrument,
  getAllAgentIds, getAgentCount, runAllAgents,
} from './registry-30';

// Cross-Confluence
export { analyzeCrossConfluence } from './cross-confluence';

// Grok Supervisor
export { runGrokSupervisor, grokBackstop, getGrokBackstopFireCount, resetGrokBackstopFireCount } from './supervisor';

// Engines
export { runOptionEngine } from './option-engine';
export { runCashFuturesEngine } from './cash-futures-engine';

// Trade Monitor
export {
  registerTradeForMonitoring, updateAndDetect, getMonitoredTrade,
  getAllMonitoredTrades, getActiveMonitoredTrades, closeTrade,
  isAlertAlreadySent, getMonitorSummary,
} from './trade-monitor';

// Telegram Alerts
export { sendTPSLAlert, retryFailedAlerts, getDeliveryStatus, getGlobalDeliveryStats } from './telegram-alerts';

// Learning DB
export { storeDecisionRecord, updateOutcome, getAgentPerformance, getWinRateByRegime } from './learning-db';

// Pipeline
export { runFullPipeline, monitorAllTrades, getSystemStatus } from './pipeline';
export type { PipelineResult } from './pipeline';
