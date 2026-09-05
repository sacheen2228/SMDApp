// MCX Commodity Module — Type Definitions
// Only 10 approved contracts: CRUDEOIL, CRUDEOILM, NATURALGAS, NATGASMINI,
// GOLD, GOLDM, GOLDGUINEA, SILVER, SILVERM, SILVERMIC

export type MCXCommodity =
  | 'CRUDEOIL' | 'CRUDEOILM' | 'NATURALGAS' | 'NATGASMINI'
  | 'GOLD' | 'GOLDM' | 'GOLDGUINEA'
  | 'SILVER' | 'SILVERM' | 'SILVERMIC';

export type MCXCategory = 'ENERGY' | 'PRECIOUS_METALS';

export type MCXInstrumentType = 'FUTURES' | 'OPTIONS';

export type MCXDataStatus = 'LIVE' | 'DELAYED' | 'STALE' | 'DATA_UNAVAILABLE';

export type MCXSessionState =
  | 'MCX_SESSION_CLOSED'
  | 'MCX_SESSION_PRE_OPEN'
  | 'MCX_SESSION_OPENING'
  | 'MCX_SESSION_DAY_ACTIVE'
  | 'MCX_SESSION_EVENING_ACTIVE'
  | 'MCX_SESSION_CLOSING'
  | 'MCX_SESSION_POST_CLOSE';

export interface MCXContractSpec {
  symbol: MCXCommodity;
  category: MCXCategory;
  label: string;
  lotSize: number;
  tickSize: number;
  maxLots: number;
  typicalPremium: number;
  deliveryUnit: string;
  deliveryType: string;
  activeMonths: string[];
  lastTradingDay: number; // day of month (e.g., 19th for CRUDEOIL)
  tradingStartTime: string; // HH:MM IST
  tradingEndTime: string; // HH:MM IST
  eveningSession: boolean;
  higherRiskFilter: boolean; // NATURALGAS, NATGASMINI
  lowerLiquidityFilter: boolean; // GOLDGUINEA, SILVERMIC, NATGASMINI
}

export interface MCXInstrument {
  symbol: MCXCommodity;
  exchange: 'MCX';
  token: number;
  contractName: string;
  expiry: string; // YYYY-MM-DD
  instrumentType: MCXInstrumentType;
  lotSize: number;
  tickSize: number;
  tradingStatus: string;
  strikePrice?: number;
  optionType?: string;
}

export interface MCXQuote {
  symbol: MCXCommodity;
  exchange: 'MCX';
  assetClass: 'COMMODITY';
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  openInterest: number | null;
  changeInOI: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  timestamp: string;
  dataStatus: MCXDataStatus;
  dataSource: 'MOAPI' | 'BREEZE' | 'YAHOO' | 'NONE';
  lotSize: number;
  tickSize: number;
  expiry: string;
}

export interface MCXTick {
  symbol: MCXCommodity;
  ltp: number;
  volume: number;
  openInterest: number;
  bid: number;
  ask: number;
  timestamp: string;
}

export interface MCXScannerResult {
  symbol: MCXCommodity;
  category: MCXCategory;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  score: number;
  grade: 'A+' | 'A' | 'B' | 'WATCH' | 'NO_TRADE';
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  maxLoss: number;
  lotSize: number;
  quantity: number;
  capitalRequired: number;
  liquidityStatus: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  dataStatus: MCXDataStatus;
  priceStructure: string[];
  volumeSignal: string[];
  oiSignal: string[];
  reasons: string[];
  riskFlags: string[];
  timestamp: string;
}

export interface MCXMarketData {
  quotes: Map<MCXCommodity, MCXQuote>;
  instruments: Map<MCXCommodity, MCXInstrument>;
  session: MCXSessionState;
  lastUpdate: string;
  dataHealth: {
    moapi: 'CONNECTED' | 'DISCONNECTED';
    breeze: 'CONNECTED' | 'DISCONNECTED';
    websocket: 'CONNECTED' | 'DISCONNECTED';
    lastTickAge: number; // seconds
    status: MCXDataStatus;
  };
}

// Approved 10 contracts — hardcoded list
export const MCX_APPROVED_CONTRACTS: MCXCommodity[] = [
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'GOLD', 'GOLDM', 'GOLDGUINEA',
  'SILVER', 'SILVERM', 'SILVERMIC',
];

export const MCX_ENERGY: MCXCommodity[] = ['CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI'];
export const MCX_PRECIOUS_METALS: MCXCommodity[] = ['GOLD', 'GOLDM', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC'];

// Yahoo Finance US futures tickers for MCX backtest fallback
export const MCX_YAHOO_SYMBOLS: Record<MCXCommodity, string> = {
  CRUDEOIL: 'CL=F',
  CRUDEOILM: 'CL=F',
  NATURALGAS: 'NG=F',
  NATGASMINI: 'NG=F',
  GOLD: 'GC=F',
  GOLDM: 'GC=F',
  GOLDGUINEA: 'GC=F',
  SILVER: 'SI=F',
  SILVERM: 'SI=F',
  SILVERMIC: 'SI=F',
};
