// Canonical Market Types — single source of truth for all engines
//
// Every option engine, scoring system, and Hermes tool MUST consume these types.
// No engine may define its own parallel option/market data structures.

import type { DataFreshness, DataStatus } from '@/lib/data-health';

// ─── Data Provenance ──────────────────────────────────────────────

export interface DataProvenance {
  source: string;
  retrievedAt: string;
  freshness: DataFreshness;
  isLive: boolean;
  status: DataStatus;
}

// ─── Canonical Option Contract ─────────────────────────────────────

export interface OptionContract {
  underlying: string;
  exchange: 'NSE' | 'BFO' | 'MCX';

  optionType: 'CE' | 'PE';
  strike: number;
  expiry: string;

  premium: number;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  quoteQuality: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

  volume: number;
  oi: number;
  oiChange: number;

  iv: number;

  delta: number;
  gamma: number;
  theta: number;
  vega: number;

  timestamp: string;
  dataSource: string;
  freshness: DataFreshness;
  dataStatus: DataStatus;
}

// ─── Canonical Strike Level ────────────────────────────────────────

export interface OptionStrike {
  strike: number;
  ce: OptionContract | null;
  pe: OptionContract | null;
}

// ─── Canonical Option Chain ────────────────────────────────────────

export interface OptionChain {
  underlying: string;
  exchange: 'NSE' | 'BFO' | 'MCX';
  spot: number;
  expiry: string;
  daysToExpiry: number;
  isExpiryDay: boolean;

  strikes: OptionStrike[];
  atmStrike: number;

  pcr: number;
  pcrChange: number;

  maxPain: number;
  maxPainDistance: number;

  totalCallOI: number;
  totalPutOI: number;
  totalCallVolume: number;
  totalPutVolume: number;
  callOiChange: number;
  putOiChange: number;

  timestamp: string;
  dataSource: string;
  freshness: DataFreshness;
}

// ─── Canonical Market Snapshot ─────────────────────────────────────

export interface MarketSnapshot {
  underlying: string;
  exchange: 'NSE' | 'BFO' | 'MCX';

  spot: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;

  timestamp: string;
  marketStatus: string;
  dataStatus: DataStatus;
  dataSource: string;
  freshness: DataFreshness;

  expiry: string;
  daysToExpiry: number;
  isExpiryDay: boolean;

  atmStrike: number;
  optionChain: OptionChain;

  vix: number;
  iv: number;
  expectedMove: number;

  supportLevels: number[];
  resistanceLevels: number[];

  features: Record<string, number>;
}

// ─── Canonical Trade ───────────────────────────────────────────────

export interface Trade {
  tradeId: string;
  strategy: string;

  underlying: string;
  exchange: 'NSE' | 'BFO' | 'MCX';

  optionType: 'CE' | 'PE';
  strike: number;
  expiry: string;

  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;

  quantity: number;
  lotSize: number;

  status: 'PENDING' | 'ACTIVE' | 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'EXITED' | 'CANCELLED' | 'EXPIRED';

  createdAt: string;
  lastPrice: number;
  lastCheckedAt: string;
  pnl: number;
  rMultiple: number;
}

// ─── Trade Events ──────────────────────────────────────────────────

export type TradeEventType =
  | 'ENTRY'
  | 'T1_HIT'
  | 'T2_HIT'
  | 'SL_HIT'
  | 'EXIT'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PRICE_UPDATE';

export interface TradeEvent {
  eventId: string;
  tradeId: string;
  type: TradeEventType;
  price: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ─── Seller Positioning ────────────────────────────────────────────

export interface SellerZone {
  strike: number;
  optionType: 'CE' | 'PE';
  oi: number;
  oiChange: number;
  premium: number;
  volume: number;
  classification: 'CALL_WRITING' | 'PUT_WRITING' | 'CALL_UNWINDING' | 'PUT_UNWINDING' | 'CALL_SHORT_COVERING' | 'PUT_SHORT_COVERING' | 'CALL_BUYING' | 'PUT_BUYING';
  confidence: number;
}

export interface SellerMap {
  callWriterZones: SellerZone[];
  putWriterZones: SellerZone[];
  callResistance: number;
  putSupport: number;
  timestamp: string;
}

// ─── OI Migration ──────────────────────────────────────────────────

export interface OIMigration {
  type: 'CALL_RESISTANCE_UP' | 'CALL_RESISTANCE_DOWN' | 'PUT_SUPPORT_UP' | 'PUT_SUPPORT_DOWN' | 'NONE';
  fromStrike: number;
  toStrike: number;
  oiChange: number;
  confidence: number;
}

// ─── FRVP (Fixed Range Volume Profile) ─────────────────────────────

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

export interface FRVPResult {
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  valueAreaVolume: number;
  totalVolume: number;
  pricePosition: 'ABOVE_VALUE' | 'INSIDE_VALUE' | 'BELOW_VALUE';
}

// ─── Liquidity Map ─────────────────────────────────────────────────

export interface LiquidityZone {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE' | 'BUY_SIDE' | 'SELL_SIDE';
  strength: number;
  source: 'OI' | 'GAMMA' | 'POC' | 'VAH' | 'VAL' | 'HVN' | 'LVN' | 'PDH' | 'PDL' | 'VWAP' | 'SWING';
}

// ─── CE vs PE Score ────────────────────────────────────────────────

export interface DirectionScore {
  ceScore: number;
  peScore: number;
  recommendedDirection: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE';
  confidence: number;
  reasoning: string[];
}
