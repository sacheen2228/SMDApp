// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader External Types — What we expect from external AI-Trader systems
// ═══════════════════════════════════════════════════════════════════════════

export interface AITraderSignal {
  id: string;
  agent_name: string;
  timestamp: string;
  symbol: string;
  exchange?: string;
  action: 'BUY_CE' | 'BUY_PE' | 'SELL_CE' | 'SELL_PE' | 'WAIT' | 'EXIT';
  strike?: number;
  expiry?: string;
  entry_price?: number;
  stop_loss?: number;
  target1?: number;
  target2?: number;
  confidence: number;
  thesis: string;
  evidence?: Record<string, any>;
  source: string;
  version?: string;
}

export interface AITraderHeartbeat {
  agent_name: string;
  status: 'ACTIVE' | 'IDLE' | 'BUSY' | 'DEGRADED' | 'OFFLINE';
  timestamp: string;
  current_task?: string;
  current_market?: string;
  current_underlying?: string;
  current_strategy?: string;
  latency_ms?: number;
  last_error?: string;
  data_freshness?: string;
}

export interface AITraderTask {
  id: string;
  agent_name: string;
  task_type: string;
  underlying: string;
  strategy: string;
  priority: string;
  status: string;
  input: Record<string, any>;
  output?: Record<string, any>;
}

export interface AITraderEvent {
  event_id: string;
  event_type: string;
  agent_name: string;
  timestamp: string;
  data: Record<string, any>;
}

export interface AITraderConfig {
  baseUrl: string;
  apiKey?: string;
  timeout: number;
  maxRetries: number;
  enabled: boolean;
}

export const DEFAULT_AITRADER_CONFIG: AITraderConfig = {
  baseUrl: 'http://localhost:8001',
  timeout: 5000,
  maxRetries: 2,
  enabled: false,
};
