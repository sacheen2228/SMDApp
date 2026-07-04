// Symbol Configuration — lot sizes, tick sizes, and market-specific settings

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
    lotSize: 75,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 120,
  },
  BANKNIFTY: {
    symbol: "BANKNIFTY",
    label: "BANK NIFTY",
    lotSize: 35,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 200,
  },
  FINNIFTY: {
    symbol: "FINNIFTY",
    label: "FIN NIFTY",
    lotSize: 40,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 100,
  },
  MIDCPNIFTY: {
    symbol: "MIDCPNIFTY",
    label: "MIDCAP NIFTY",
    lotSize: 100,
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
};

export function getSymbolConfig(symbol: string): SymbolConfig {
  return SYMBOL_CONFIGS[symbol] || SYMBOL_CONFIGS.NIFTY;
}

export function getLotSize(symbol: string): number {
  return getSymbolConfig(symbol).lotSize;
}
