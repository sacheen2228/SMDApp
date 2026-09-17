// Hermes Task Router — intent detection and execution planning
// Maps user requests to intents and determines which tools/data are needed.

import type { HermesMode, ExecutionPlan, PlanStep } from "./types";

// ── Intent Patterns ────────────────────────────────────────────────────

interface IntentPattern {
  intent: string;
  mode: HermesMode;
  patterns: RegExp[];
  requiredTools: string[];
  optionalTools: string[];
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: "LIVE_TRADE",
    mode: "TRADE",
    patterns: [
      /(?:give|find|get|suggest|show|recommend).*(?:trade|option|buy|call|put|CE|PE)/i,
      /(?:best|top|good).*(?:option|trade|setup|signal)/i,
      /(?:NIFTY|BANKNIFTY|SENSEX|FINNIFTY|MIDCPNIFTY).*(?:CE|PE|call|put|buy)/i,
      /(?:CE|PE)\s*(?:buy|trade|setup)/i,
      /(?:buy|go)\s*(?:call|put|CE|PE)/i,
      /mujhe.*(?:trade|option)/i,
      /(?:live|real).*trade/i,
    ],
    requiredTools: ["get_spot", "get_option_chain", "get_vix", "get_market_structure", "get_oi_analysis", "get_greeks", "get_gamma", "get_fii_dii", "get_news", "get_regime", "get_risk_status", "get_market_session"],
    optionalTools: ["get_volume_profile", "get_expiry_liquidity", "get_cas_analysis"],
  },
  {
    intent: "OPTION_ANALYSIS",
    mode: "RESEARCH",
    patterns: [
      /(?:analyze|analysis|check|review).*(?:option|chain|strike|premium)/i,
      /(?:what|how).*(?:option|chain|strike|premium|greeks|IV)/i,
      /option\s*(?:chain|analysis|review)/i,
      /(?:ATM|ITM|OTM|strike)/i,
    ],
    requiredTools: ["get_option_chain", "get_oi_analysis", "get_greeks"],
    optionalTools: ["get_gamma", "get_volume_profile", "get_vix"],
  },
  {
    intent: "MCX_ANALYSIS",
    mode: "RESEARCH",
    patterns: [
      /(?:MCX|crude|gold|silver|natural\s*gas|commodity)/i,
      /(?:CRUDEOIL|GOLD|SILVER|NATURALGAS)/i,
    ],
    requiredTools: ["get_mcx_data", "get_market_session"],
    optionalTools: ["get_news", "get_regime"],
  },
  {
    intent: "ZERO_HERO",
    mode: "TRADE",
    patterns: [
      /(?:zero|0).?(?:hero|DTE|day)/i,
      /(?:today|current).*(?:expiry|expir)/i,
      /expiry.*(?:trade|option|buy)/i,
    ],
    requiredTools: ["get_spot", "get_option_chain", "get_vix", "get_gamma", "get_market_session"],
    optionalTools: ["get_oi_analysis", "get_volume_profile"],
  },
  {
    intent: "CAS",
    mode: "RESEARCH",
    patterns: [
      /CAS|close\s*auction|auction\s*session/i,
    ],
    requiredTools: ["get_cas_analysis", "get_expiry_liquidity", "get_market_session"],
    optionalTools: ["get_spot", "get_vix"],
  },
  {
    intent: "NEWS",
    mode: "QUICK",
    patterns: [
      /(?:news|headline|sentiment|what.*happening)/i,
    ],
    requiredTools: ["get_news"],
    optionalTools: ["get_regime", "get_fii_dii"],
  },
  {
    intent: "RISK",
    mode: "RISK",
    patterns: [
      /(?:risk|position|capital|drawdown|loss.*limit)/i,
      /(?:how much|can i).*(?:risk|lose|trade)/i,
    ],
    requiredTools: ["get_risk_status"],
    optionalTools: ["get_trade_history"],
  },
  {
    intent: "TRADE_JOURNAL",
    mode: "QUICK",
    patterns: [
      /(?:trade.*history|journal|my.*trade|past.*trade|open.*position)/i,
    ],
    requiredTools: ["get_trade_history"],
    optionalTools: [],
  },
  {
    intent: "BACKTEST",
    mode: "BACKTEST",
    patterns: [
      /(?:backtest|historical|past.*performance|win.*rate)/i,
      /(?:strategy|setup).*(?:perform|result|history)/i,
    ],
    requiredTools: ["get_backtest_results"],
    optionalTools: ["get_trade_history"],
  },
  {
    intent: "MARKET_SUMMARY",
    mode: "QUICK",
    patterns: [
      /(?:market|nifty|sensex).*(?:doing|status|summary|overview)/i,
      /(?:how.*market|market.*status|market.*today)/i,
      /(?:gap|trend|direction)/i,
    ],
    requiredTools: ["get_spot", "get_vix", "get_fii_dii", "get_regime"],
    optionalTools: ["get_news", "get_market_structure"],
  },
  {
    intent: "VIX",
    mode: "QUICK",
    patterns: [
      /VIX|volatil/i,
    ],
    requiredTools: ["get_vix"],
    optionalTools: ["get_regime"],
  },
  {
    intent: "FII_DII",
    mode: "QUICK",
    patterns: [
      /FII|DII|institution|fund.?flow|foreign|domestic/i,
    ],
    requiredTools: ["get_fii_dii"],
    optionalTools: [],
  },
  {
    intent: "REGIME",
    mode: "QUICK",
    patterns: [
      /regime|breadth|trend|range|market.?health|advance.?decline/i,
    ],
    requiredTools: ["get_regime"],
    optionalTools: ["get_spot", "get_vix"],
  },
  {
    intent: "EDUCATIONAL",
    mode: "EXPLAIN",
    patterns: [
      /(?:what|how|why|explain|tell me about|define)/i,
      /(?:is|are).*(?:option|stock|future|future)/i,
    ],
    requiredTools: ["answer_trading_question"],
    optionalTools: [],
  },
];

// ── Symbol Detection ───────────────────────────────────────────────────

const SYMBOL_PATTERNS: Array<{ pattern: RegExp; symbol: string; exchange: string; instrument: string }> = [
  { pattern: /SENSEX|BSE/i, symbol: "SENSEX", exchange: "BSE", instrument: "index" },
  { pattern: /BANK.?NIFTY|BANKNIFTY/i, symbol: "BANKNIFTY", exchange: "NSE", instrument: "index" },
  { pattern: /FIN.?NIFTY|FINNIFTY/i, symbol: "FINNIFTY", exchange: "NSE", instrument: "index" },
  { pattern: /MID.?CAP|Midcap|MidCap/i, symbol: "MIDCPNIFTY", exchange: "NSE", instrument: "index" },
  { pattern: /CRUDEOIL|crude/i, symbol: "CRUDEOIL", exchange: "MCX", instrument: "commodity" },
  { pattern: /NATURAL.?GAS|NATGAS/i, symbol: "NATURALGAS", exchange: "MCX", instrument: "commodity" },
  { pattern: /GOLD/i, symbol: "GOLD", exchange: "MCX", instrument: "commodity" },
  { pattern: /SILVER/i, symbol: "SILVER", exchange: "MCX", instrument: "commodity" },
  { pattern: /NIFTY/i, symbol: "NIFTY", exchange: "NSE", instrument: "index" },
];

export function detectSymbol(query: string): { symbol: string; exchange: string; instrument: string } {
  for (const { pattern, symbol, exchange, instrument } of SYMBOL_PATTERNS) {
    if (pattern.test(query)) return { symbol, exchange, instrument };
  }
  return { symbol: "NIFTY", exchange: "NSE", instrument: "index" };
}

// ── Direction Detection ────────────────────────────────────────────────

export function detectDirection(query: string): "CE" | "PE" | "UNKNOWN" {
  if (/\b(?:CE|call|buy\s*call|bullish|up|long)\b/i.test(query)) return "CE";
  if (/\b(?:PE|put|buy\s*put|bearish|down|short)\b/i.test(query)) return "PE";
  return "UNKNOWN";
}

// ── Intent Detection ───────────────────────────────────────────────────

export function detectIntent(query: string): { intent: string; mode: HermesMode } {
  for (const { intent, mode, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        return { intent, mode };
      }
    }
  }
  return { intent: "RESEARCH", mode: "RESEARCH" };
}

// ── Execution Plan ─────────────────────────────────────────────────────

export function createExecutionPlan(query: string): ExecutionPlan {
  const { intent, mode } = detectIntent(query);
  const { symbol } = detectSymbol(query);

  const requiredTools = getRequiredToolsForIntent(intent);

  const steps: PlanStep[] = requiredTools.map((tool, i) => ({
    tool,
    purpose: `Fetch ${tool.replace("get_", "").replace(/_/g, " ")}`,
    required: true,
    parallel: i < 6, // First 6 tools can run in parallel
    dependsOn: i >= 6 ? [requiredTools[i - 1]] : undefined,
  }));

  return {
    intent,
    mode,
    steps,
    estimatedTime: mode === "TRADE" ? 8000 : mode === "QUICK" ? 2000 : 5000,
    requiredData: requiredTools,
  };
}

function getRequiredToolsForIntent(intent: string): string[] {
  const pattern = INTENT_PATTERNS.find(p => p.intent === intent);
  return pattern?.requiredTools || ["get_spot", "get_option_chain"];
}

// ── Parallel Batching ──────────────────────────────────────────────────

export function getParallelBatches(steps: PlanStep[]): PlanStep[][] {
  const batches: PlanStep[][] = [];
  let currentBatch: PlanStep[] = [];

  for (const step of steps) {
    if (step.parallel) {
      currentBatch.push(step);
    } else {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      batches.push([step]);
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
