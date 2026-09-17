// Instrument Configuration — lot sizes, tick sizes, contract metadata
// Configurable per exchange and instrument.

export interface InstrumentMeta {
  symbol: string;
  exchange: "NSE" | "MCX" | "BSE";
  type: "index" | "fno-stock" | "cash-stock" | "commodity";
  lotSize: number;
  tickSize: number;
  hasOptions: boolean;
  expiryDay: string;
  session: { open: string; close: string };
  maxPositionSize: number;
}

export const INSTRUMENT_CONFIG: Record<string, InstrumentMeta> = {
  // ── NSE Indices ──────────────────────────────────────────────────────
  NIFTY: {
    symbol: "NIFTY",
    exchange: "NSE",
    type: "index",
    lotSize: 65,
    tickSize: 0.05,
    hasOptions: true,
    expiryDay: "thursday",
    session: { open: "09:15", close: "15:30" },
    maxPositionSize: 10,
  },
  BANKNIFTY: {
    symbol: "BANKNIFTY",
    exchange: "NSE",
    type: "index",
    lotSize: 30,
    tickSize: 0.05,
    hasOptions: true,
    expiryDay: "thursday",
    session: { open: "09:15", close: "15:30" },
    maxPositionSize: 10,
  },
  FINNIFTY: {
    symbol: "FINNIFTY",
    exchange: "NSE",
    type: "index",
    lotSize: 60,
    tickSize: 0.05,
    hasOptions: true,
    expiryDay: "tuesday",
    session: { open: "09:15", close: "15:30" },
    maxPositionSize: 10,
  },
  MIDCPNIFTY: {
    symbol: "MIDCPNIFTY",
    exchange: "NSE",
    type: "index",
    lotSize: 120,
    tickSize: 0.05,
    hasOptions: true,
    expiryDay: "thursday",
    session: { open: "09:15", close: "15:30" },
    maxPositionSize: 10,
  },
  SENSEX: {
    symbol: "SENSEX",
    exchange: "BSE",
    type: "index",
    lotSize: 20,
    tickSize: 0.05,
    hasOptions: true,
    expiryDay: "thursday",
    session: { open: "09:15", close: "15:30" },
    maxPositionSize: 10,
  },

  // ── MCX Commodities ─────────────────────────────────────────────────
  CRUDEOIL: {
    symbol: "CRUDEOIL",
    exchange: "MCX",
    type: "commodity",
    lotSize: 100,
    tickSize: 1,
    hasOptions: true,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  CRUDEOILM: {
    symbol: "CRUDEOILM",
    exchange: "MCX",
    type: "commodity",
    lotSize: 10,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  NATURALGAS: {
    symbol: "NATURALGAS",
    exchange: "MCX",
    type: "commodity",
    lotSize: 1250,
    tickSize: 0.1,
    hasOptions: true,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  NATGASMINI: {
    symbol: "NATGASMINI",
    exchange: "MCX",
    type: "commodity",
    lotSize: 250,
    tickSize: 0.1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  GOLD: {
    symbol: "GOLD",
    exchange: "MCX",
    type: "commodity",
    lotSize: 1,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 10,
  },
  GOLDM: {
    symbol: "GOLDM",
    exchange: "MCX",
    type: "commodity",
    lotSize: 10,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 10,
  },
  GOLDGUINEA: {
    symbol: "GOLDGUINEA",
    exchange: "MCX",
    type: "commodity",
    lotSize: 1,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 10,
  },
  SILVER: {
    symbol: "SILVER",
    exchange: "MCX",
    type: "commodity",
    lotSize: 30,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  SILVERM: {
    symbol: "SILVERM",
    exchange: "MCX",
    type: "commodity",
    lotSize: 5,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
  SILVERMIC: {
    symbol: "SILVERMIC",
    exchange: "MCX",
    type: "commodity",
    lotSize: 1,
    tickSize: 1,
    hasOptions: false,
    expiryDay: "varies",
    session: { open: "09:00", close: "23:30" },
    maxPositionSize: 5,
  },
};

// ── Helper Functions ───────────────────────────────────────────────────

export function getInstrumentConfig(symbol: string): InstrumentMeta | undefined {
  return INSTRUMENT_CONFIG[symbol.toUpperCase()];
}

export function getLotSize(symbol: string): number {
  return INSTRUMENT_CONFIG[symbol.toUpperCase()]?.lotSize ?? 1;
}

export function hasOptions(symbol: string): boolean {
  return INSTRUMENT_CONFIG[symbol.toUpperCase()]?.hasOptions ?? false;
}

export function isMCXInstrument(symbol: string): boolean {
  return INSTRUMENT_CONFIG[symbol.toUpperCase()]?.exchange === "MCX";
}

export function isNSEIndex(symbol: string): boolean {
  const cfg = INSTRUMENT_CONFIG[symbol.toUpperCase()];
  return cfg?.exchange === "NSE" && cfg?.type === "index";
}

export function getSupportedSymbols(): string[] {
  return Object.keys(INSTRUMENT_CONFIG);
}

export function getMCXSymbols(): string[] {
  return Object.entries(INSTRUMENT_CONFIG)
    .filter(([, cfg]) => cfg.exchange === "MCX")
    .map(([sym]) => sym);
}

export function getNSESymbols(): string[] {
  return Object.entries(INSTRUMENT_CONFIG)
    .filter(([, cfg]) => cfg.exchange === "NSE" || cfg.exchange === "BSE")
    .map(([sym]) => sym);
}
