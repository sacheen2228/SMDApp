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
  // ── MCX Commodity (10 approved contracts) ──
  CRUDEOIL: {
    symbol: "CRUDEOIL",
    label: "CRUDE OIL",
    lotSize: 100,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 500,
  },
  CRUDEOILM: {
    symbol: "CRUDEOILM",
    label: "CRUDE OIL MINI",
    lotSize: 10,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 50,
  },
  NATURALGAS: {
    symbol: "NATURALGAS",
    label: "NATURAL GAS",
    lotSize: 1250,
    tickSize: 0.1,
    maxLots: 10,
    typicalPremium: 200,
  },
  NATGASMINI: {
    symbol: "NATGASMINI",
    label: "NATURAL GAS MINI",
    lotSize: 250,
    tickSize: 0.1,
    maxLots: 25,
    typicalPremium: 40,
  },
  GOLD: {
    symbol: "GOLD",
    label: "GOLD",
    lotSize: 1,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 1000,
  },
  GOLDM: {
    symbol: "GOLDM",
    label: "GOLD MINI",
    lotSize: 100,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 100,
  },
  GOLDGUINEA: {
    symbol: "GOLDGUINEA",
    label: "GOLD GUINEA",
    lotSize: 1,
    tickSize: 10,
    maxLots: 10,
    typicalPremium: 5000,
  },
  SILVER: {
    symbol: "SILVER",
    label: "SILVER",
    lotSize: 30,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 800,
  },
  SILVERM: {
    symbol: "SILVERM",
    label: "SILVER MINI",
    lotSize: 5,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 150,
  },
  SILVERMIC: {
    symbol: "SILVERMIC",
    label: "SILVER MICRO",
    lotSize: 1,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 30,
  },
};

export function getSymbolConfig(symbol: string): SymbolConfig {
  return SYMBOL_CONFIGS[symbol] || SYMBOL_CONFIGS.NIFTY;
}

export function getLotSize(symbol: string): number {
  return getSymbolConfig(symbol).lotSize;
}
