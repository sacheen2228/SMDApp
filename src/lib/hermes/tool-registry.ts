// Hermes Tool Registry — centralized tool definitions with schemas, freshness, reliability
// Each tool maps to an existing SMDApp engine or API endpoint.

import type { ToolDefinition } from "./types";

// ── Tool Definitions ───────────────────────────────────────────────────

export const HERMES_TOOLS: ToolDefinition[] = [
  // ── Market Data ──────────────────────────────────────────────────────
  {
    name: "get_spot",
    description: "Get current spot price for an instrument",
    category: "MARKET_DATA",
    inputSchema: {
      symbol: { type: "string", required: true, description: "Instrument symbol (NIFTY, BANKNIFTY, etc.)" },
    },
    source: "/api/option-chain",
    freshnessMaxAge: 15_000,
    reliability: 0.95,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 5_000,
    tags: ["spot", "price", "market data"],
  },
  {
    name: "get_option_chain",
    description: "Get full option chain with OI, volume, Greeks, IV",
    category: "OPTIONS",
    inputSchema: {
      symbol: { type: "string", required: true, description: "Index symbol" },
    },
    source: "/api/option-chain",
    freshnessMaxAge: 30_000,
    reliability: 0.90,
    timeout: 12_000,
    cacheable: true,
    cacheTTL: 10_000,
    tags: ["option chain", "OI", "greeks", "IV", "premium"],
  },
  {
    name: "get_vix",
    description: "Get India VIX value and regime",
    category: "VOLATILITY",
    inputSchema: {},
    source: "/api/option-chain (summary.indiaVIX)",
    freshnessMaxAge: 60_000,
    reliability: 0.90,
    timeout: 8_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["VIX", "volatility", "fear"],
  },
  {
    name: "get_historical_data",
    description: "Get historical OHLCV candles",
    category: "MARKET_DATA",
    inputSchema: {
      symbol: { type: "string", required: true },
      days: { type: "number", required: false, default: 30 },
    },
    source: "/api/nse (historical)",
    freshnessMaxAge: 86_400_000,
    reliability: 0.85,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 300_000,
    tags: ["historical", "candles", "OHLCV"],
  },

  // ── OI & Greeks ──────────────────────────────────────────────────────
  {
    name: "get_oi_analysis",
    description: "Get OI classification, PCR, max pain, fresh writing, traps",
    category: "OPTIONS",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "sdm-oianalysis.ts (analyzeOptionChain)",
    freshnessMaxAge: 30_000,
    reliability: 0.90,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 10_000,
    tags: ["OI", "PCR", "max pain", "fresh writing", "OI traps"],
  },
  {
    name: "get_greeks",
    description: "Get Greeks for a specific strike (Delta, Gamma, Theta, Vega)",
    category: "OPTIONS",
    inputSchema: {
      symbol: { type: "string", required: true },
      strike: { type: "number", required: true },
      side: { type: "string", required: true, description: "CE or PE" },
    },
    source: "greeks.ts (calculateGreeks)",
    freshnessMaxAge: 60_000,
    reliability: 0.95,
    timeout: 5_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["greeks", "delta", "gamma", "theta", "vega"],
  },

  // ── Gamma ────────────────────────────────────────────────────────────
  {
    name: "get_gamma",
    description: "Get gamma analysis: gamma wall, flip, blast, dealer bias",
    category: "GAMMA",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "gamma-blast.ts (detectGammaBlast)",
    freshnessMaxAge: 60_000,
    reliability: 0.85,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["gamma", "gamma wall", "gamma flip", "dealer bias", "squeeze"],
  },

  // ── Volume ───────────────────────────────────────────────────────────
  {
    name: "get_volume_profile",
    description: "Get volume profile: POC, VAH, VAL, absorption, exhaustion",
    category: "VOLUME",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "volume-analysis.ts (analyzeVolume)",
    freshnessMaxAge: 300_000,
    reliability: 0.85,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 60_000,
    tags: ["volume profile", "POC", "VAH", "VAL", "absorption"],
  },

  // ── Structure ────────────────────────────────────────────────────────
  {
    name: "get_market_structure",
    description: "Get market structure: trend, S/R, BOS, CHoCH, swing points",
    category: "STRUCTURE",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "market-structure.ts (analyzeMarketStructure) + /api/sdm-signal",
    freshnessMaxAge: 60_000,
    reliability: 0.90,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["structure", "trend", "support", "resistance", "BOS", "CHoCH"],
  },

  // ── Flow ─────────────────────────────────────────────────────────────
  {
    name: "get_fii_dii",
    description: "Get FII/DII flows and participant OI",
    category: "FLOW",
    inputSchema: {},
    source: "/api/fii-dii (fii-dii.ts)",
    freshnessMaxAge: 3_600_000,
    reliability: 0.90,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 300_000,
    tags: ["FII", "DII", "institutional", "fund flow", "participant OI"],
  },

  // ── Regime ───────────────────────────────────────────────────────────
  {
    name: "get_regime",
    description: "Get market regime: trending, range, breakout, volatility",
    category: "MARKET_DATA",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "/api/market/regime",
    freshnessMaxAge: 60_000,
    reliability: 0.85,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 60_000,
    tags: ["regime", "trend", "range", "breakout", "volatility"],
  },

  // ── News ─────────────────────────────────────────────────────────────
  {
    name: "get_news",
    description: "Get market news with sentiment analysis",
    category: "NEWS",
    inputSchema: {
      symbol: { type: "string", required: false },
    },
    source: "/api/news (news-engine.ts + sentiment-analyzer.ts)",
    freshnessMaxAge: 1_800_000,
    reliability: 0.80,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 300_000,
    tags: ["news", "sentiment", "headlines"],
  },

  // ── Risk ─────────────────────────────────────────────────────────────
  {
    name: "get_risk_status",
    description: "Get current risk status and position limits",
    category: "RISK",
    inputSchema: {},
    source: "risk-management.ts (checkRiskLimits)",
    freshnessMaxAge: 60_000,
    reliability: 0.95,
    timeout: 5_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["risk", "position size", "limits"],
  },
  {
    name: "calculate_position_size",
    description: "Calculate position size based on risk parameters",
    category: "RISK",
    inputSchema: {
      entry: { type: "number", required: true },
      sl: { type: "number", required: true },
      lotSize: { type: "number", required: true },
      capital: { type: "number", required: false, default: 100000 },
      riskPct: { type: "number", required: false, default: 1 },
    },
    source: "risk-management.ts (calculatePositionSize)",
    freshnessMaxAge: 0,
    reliability: 0.95,
    timeout: 5_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["position size", "risk", "quantity"],
  },

  // ── CAS ──────────────────────────────────────────────────────────────
  {
    name: "get_cas_analysis",
    description: "Get CAS (Close Auction Session) analysis",
    category: "CAS",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "/api/market/regime (CAS factors)",
    freshnessMaxAge: 300_000,
    reliability: 0.85,
    timeout: 10_000,
    cacheable: true,
    cacheTTL: 60_000,
    tags: ["CAS", "auction", "close"],
  },

  // ── Expiry ───────────────────────────────────────────────────────────
  {
    name: "get_expiry_liquidity",
    description: "Get expiry liquidity shift analysis",
    category: "OPTIONS",
    inputSchema: {
      symbol: { type: "string", required: true },
    },
    source: "/api/expiry-liquidity",
    freshnessMaxAge: 300_000,
    reliability: 0.85,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 60_000,
    tags: ["expiry", "liquidity", "CAS", "gamma"],
  },

  // ── Backtest ─────────────────────────────────────────────────────────
  {
    name: "get_backtest_results",
    description: "Get backtest results for a strategy",
    category: "HISTORY",
    inputSchema: {
      symbol: { type: "string", required: false },
      days: { type: "number", required: false, default: 30 },
    },
    source: "/api/backtest/trades",
    freshnessMaxAge: 86_400_000,
    reliability: 0.90,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 300_000,
    tags: ["backtest", "historical", "performance"],
  },

  // ── Trade History ────────────────────────────────────────────────────
  {
    name: "get_trade_history",
    description: "Get recent trade journal entries",
    category: "HISTORY",
    inputSchema: {
      symbol: { type: "string", required: false },
      limit: { type: "number", required: false, default: 20 },
    },
    source: "/api/trade-journal",
    freshnessMaxAge: 60_000,
    reliability: 0.95,
    timeout: 8_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["journal", "trades", "history"],
  },

  // ── MCX ──────────────────────────────────────────────────────────────
  {
    name: "get_mcx_data",
    description: "Get MCX commodity data (CRUDEOIL, GOLD, SILVER, NATURALGAS)",
    category: "MARKET_DATA",
    inputSchema: {
      symbol: { type: "string", required: false, description: "MCX commodity symbol" },
    },
    source: "mcx/market-data.ts (fetchAllMCXQuotes)",
    freshnessMaxAge: 30_000,
    reliability: 0.80,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 10_000,
    tags: ["MCX", "commodity", "crude", "gold", "silver", "natural gas"],
  },

  // ── Market Session ───────────────────────────────────────────────────
  {
    name: "get_market_session",
    description: "Get current market session status (pre-open, open, closing, closed)",
    category: "MARKET_DATA",
    inputSchema: {
      instrument: { type: "string", required: false, default: "index" },
    },
    source: "market-session.ts (getCurrentSession)",
    freshnessMaxAge: 0,
    reliability: 0.99,
    timeout: 1_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["session", "market hours", "timing"],
  },

  // ── Educational ──────────────────────────────────────────────────────
  {
    name: "answer_trading_question",
    description: "Answer educational trading questions",
    category: "EDUCATIONAL",
    inputSchema: {
      question: { type: "string", required: true },
    },
    source: "trading-knowledge.ts (system prompt)",
    freshnessMaxAge: 0,
    reliability: 0.90,
    timeout: 30_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["education", "learn", "explain"],
  },

  // ── Memory ───────────────────────────────────────────────────────────
  {
    name: "search_memory",
    description: "Search trade patterns and setup memory",
    category: "HISTORY",
    inputSchema: {
      query: { type: "string", required: true },
    },
    source: "agent-memory.ts",
    freshnessMaxAge: 0,
    reliability: 0.90,
    timeout: 5_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["memory", "patterns", "setup"],
  },
  // ── MTF Indicator Confirmation ────────────────────────────────────────
  {
    name: "get_mtf_signal",
    description: "Multi-timeframe indicator confirmation — 15M trend → 5M signal → 3M entry. Computes SuperTrend, RSI, EMA, Bollinger, VWAP, ATR, ADX, Pivots across timeframes. Returns composite score and BUY_CE/BUY_PE/WAIT.",
    category: "SIGNALS",
    inputSchema: {
      symbol: { type: "string", required: true, description: "Index symbol (NIFTY, BANKNIFTY, etc.)" },
    },
    source: "mtf-indicator-engine.ts + mtf-signal-engine.ts",
    freshnessMaxAge: 30_000,
    reliability: 0.90,
    timeout: 15_000,
    cacheable: true,
    cacheTTL: 30_000,
    tags: ["MTF", "multi-timeframe", "SuperTrend", "RSI", "signal", "confirmation"],
  },
  // ── Session Health (single-owner session-expiry system) ──────────────
  {
    name: "check_session_tokens",
    description: "LIVE validity check of Breeze / Motilal / NSE sessions (real probes, never cached) plus recorded session-health episodes and remedies",
    category: "RISK",
    inputSchema: {
      source: { type: "string", required: false, description: "breeze | mo | nse | all (default all)" },
    },
    source: "session-health.ts (probeSessionSource)",
    freshnessMaxAge: 0,
    reliability: 0.95,
    timeout: 15_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["session", "token", "auth", "expiry", "breeze", "motilal", "NSE"],
  },
  {
    name: "set_breeze_session",
    description: "Set/refresh the ICICI Breeze apiSession token supplied by the user (browser OTP), validates live and clears the expired episode",
    category: "RISK",
    inputSchema: {
      token: { type: "string", required: true, description: "Breeze apiSession token" },
    },
    source: "session-health.ts (applyBreezeSession → icici-breeze/auth.generateSession)",
    freshnessMaxAge: 0,
    reliability: 0.95,
    timeout: 15_000,
    cacheable: false,
    cacheTTL: 0,
    tags: ["session", "token", "breeze", "set", "re-auth"],
  },
];

// ── Registry Functions ─────────────────────────────────────────────────

const TOOL_MAP = new Map<string, ToolDefinition>();
for (const tool of HERMES_TOOLS) {
  TOOL_MAP.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_MAP.get(name);
}

export function getToolsByCategory(category: string): ToolDefinition[] {
  return HERMES_TOOLS.filter(t => t.category === category);
}

export function getToolsByTag(tag: string): ToolDefinition[] {
  return HERMES_TOOLS.filter(t => t.tags.some(tg => tg.toLowerCase().includes(tag.toLowerCase())));
}

export function getRequiredTools(intent: string): string[] {
  const intentToolMap: Record<string, string[]> = {
    LIVE_TRADE: ["get_spot", "get_option_chain", "get_vix", "get_market_structure", "get_oi_analysis", "get_greeks", "get_gamma", "get_fii_dii", "get_news", "get_regime", "get_risk_status", "get_market_session", "get_mtf_signal"],
    OPTION_ANALYSIS: ["get_option_chain", "get_oi_analysis", "get_greeks", "get_gamma", "get_volume_profile"],
    MCX_ANALYSIS: ["get_mcx_data", "get_market_session"],
    RESEARCH: ["get_spot", "get_option_chain", "get_vix", "get_market_structure", "get_fii_dii", "get_news", "get_regime"],
    MARKET_SUMMARY: ["get_spot", "get_vix", "get_fii_dii", "get_regime", "get_news"],
    NEWS: ["get_news", "get_regime"],
    RISK: ["get_risk_status", "get_trade_history"],
    TRADE_JOURNAL: ["get_trade_history"],
    BACKTEST: ["get_backtest_results"],
    ZERO_HERO: ["get_spot", "get_option_chain", "get_vix", "get_gamma", "get_market_session", "get_mtf_signal"],
    CAS: ["get_cas_analysis", "get_expiry_liquidity"],
  };
  return intentToolMap[intent] || ["get_spot", "get_option_chain"];
}

export function getAllToolNames(): string[] {
  return HERMES_TOOLS.map(t => t.name);
}

export function getToolCount(): number {
  return HERMES_TOOLS.length;
}
