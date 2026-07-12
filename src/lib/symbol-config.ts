// Symbol Configuration — lot sizes, tick sizes, and market-specific settings
//
// SINGLE SOURCE OF TRUTH for lot sizes. Do not redefine LOT_SIZES /
// lotSizes / a hardcoded lot-size map anywhere else in the codebase —
// import getLotSize()/SYMBOL_CONFIGS from here instead. (This file
// replaced 4+ independently-drifting copies found across
// trades/today, backtest-audit, BacktestPanel, agent-engine,
// backtest-engine, SDMAIDashboard, and useTerminalStore — see
// AGENTS.md changelog.)

export interface SymbolConfig {
  symbol: string;
  label: string;
  lotSize: number;
  tickSize: number;
  maxLots: number;
  typicalPremium: number; // avg ATM premium for position sizing
}

export const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  NIFTY: {
    symbol: "NIFTY",
    label: "NIFTY 50",
    lotSize: 65,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 120,
  },
  BANKNIFTY: {
    symbol: "BANKNIFTY",
    label: "BANK NIFTY",
    lotSize: 30,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 200,
  },
  FINNIFTY: {
    symbol: "FINNIFTY",
    label: "FIN NIFTY",
    lotSize: 60,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 100,
  },
  MIDCPNIFTY: {
    symbol: "MIDCPNIFTY",
    label: "MIDCAP NIFTY",
    lotSize: 120,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 80,
  },
  SENSEX: {
    symbol: "SENSEX",
    label: "SENSEX",
    lotSize: 20,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 150,
  },
  BANKEX: {
    symbol: "BANKEX",
    label: "BANKEX (BSE)",
    lotSize: 30,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 150,
  },
  NIFTYNXT50: {
    symbol: "NIFTYNXT50",
    label: "NIFTY NEXT 50",
    lotSize: 25,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 100,
  },
};

export function getSymbolConfig(symbol: string): SymbolConfig {
  return SYMBOL_CONFIGS[symbol] || SYMBOL_CONFIGS.NIFTY;
}

export function getLotSize(symbol: string): number {
  return getSymbolConfig(symbol).lotSize;
}
