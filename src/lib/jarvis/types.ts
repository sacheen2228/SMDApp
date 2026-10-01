// Shared types for the Jarvis live trading agent.
// This module is standalone: it has no dependency on your existing
// agent-engine.ts / smd-context.ts. You wire it in via the three adapter
// interfaces at the bottom (DataSource, MemorySink, AlertSink) — implement
// each with a thin wrapper around what you already have (your MOAPI feed,
// agent-memory.ts, telegram.ts) and pass them into `runJarvisCycle`.

export type Instrument = "NIFTY" | "BANKNIFTY" | "FINNIFTY" | string;

export interface OptionLeg {
  openInterest: number;
  changeinOpenInterest: number;
  impliedVolatility: number; // e.g. 14.2 meaning 14.2%
  lastPrice: number;
  bidPrice?: number;
  askPrice?: number;
  totalTradedVolume?: number;
}

export interface OptionRow {
  strikePrice: number;
  expiryDate: string; // "25-Sep-2026"
  CE?: OptionLeg;
  PE?: OptionLeg;
}

export interface OptionChain {
  underlyingValue: number;
  expiryDates: string[];
  data: OptionRow[];
}

export interface Ohlc {
  pdh?: number; // previous day high
  pdl?: number; // previous day low
  pdc?: number; // previous day close
  orHigh?: number; // opening range high
  orLow?: number; // opening range low
  vwap?: number;
  weekHigh?: number;
  weekLow?: number;
}

export interface FiiDiiRow {
  category: string; // "FII/FPI" | "DII"
  netValue: number; // crore, +ve = net buy
  date?: string;
}

export interface HeatmapConstituent {
  symbol: string;
  weightPct: number; // index weight
  pctChange: number;
}

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string; // ISO
  summary?: string;
}

export interface MarketSnapshot {
  instrument: Instrument;
  fetchedAtIso: string;
  optionChain: OptionChain;
  ohlc?: Ohlc;
  indiaVix?: number;
  fiiDii?: FiiDiiRow[];
  heatmap?: HeatmapConstituent[];
  bseHeatmap?: HeatmapConstituent[];
  bseFiiAgrees?: boolean | null; // null = unavailable
  news?: NewsItem[];
}

export type OptionType = "CE" | "PE";

export interface GreeksResult {
  spot: number;
  expiry: string;
  hoursToExpiry: number;
  atmStrike: number;
  atmIv: number;
  atmStraddle: number;
  expectedMove1Sigma: number;
  skewPutMinusCall: number | null;
  netGex: number;
  gammaFlip: number | null;
  regime: "trending" | "pinned";
  atmThetaPerDayPctOfPremium: number | null;
  greekScore: number;
  gatesFailed: string[];
  notes: string[];
  perStrike: Array<{
    strike: number;
    CE?: { delta: number; gamma: number; theta: number; vega: number };
    PE?: { delta: number; gamma: number; theta: number; vega: number };
  }>;
}

export interface LevelMap {
  oiResistance?: number;
  oiResistance2?: number;
  oiSupport?: number;
  oiSupport2?: number;
  maxPain?: number;
  expMoveUp?: number;
  expMoveDown?: number;
  roundAbove?: number;
  roundBelow?: number;
  pdh?: number;
  pdl?: number;
  vwap?: number;
  orHigh?: number;
  orLow?: number;
  weekHigh?: number;
  weekLow?: number;
}

export interface ConfluenceZone {
  priceRange: [number, number];
  levels: string[];
  strength: number;
}

export interface LevelsResult {
  spot: number;
  levels: LevelMap;
  confluenceZones: ConfluenceZone[];
  levelsNearSpot: string[];
  liquidStrikesTop5Oi: number[];
  spreadPctNearAtm: Record<number, { CE: number | null; PE: number | null }>;
}

export type StrategyId = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";

export interface ComponentScores {
  optionChain: number;
  fii: number;
  greeks: number;
  heatmap: number;
  oiSpurts: number;
  preopenClose: number;
  breadth: number;
  week52: number;
  newsSentiment: number;
}

export type Action = "BUY_CE" | "BUY_PE" | "NO_TRADE";

export interface TradeIdea {
  expiry: string;
  strike: number;
  optionType: OptionType;
  entryZone: [number, number];
  stopLossPremium: number;
  tp1Premium: number;
  tp2Premium: number;
  underlyingInvalidation: number;
  underlyingTargets: [number, number];
  riskRewardTp1: number;
  timeStopIso: string;
}

export interface JarvisSignal {
  agentId: string;
  timestampIso: string;
  instrument: Instrument;
  spot: number;
  biasScore: number; // -100..100
  componentScores: ComponentScores;
  groupsAgreeing: number; // out of 9 (added newsSentiment)
  strategy: StrategyId | null;
  strategyName: string | null;
  levelsUsed: string[];
  confluenceZone: [number, number] | null;
  action: Action;
  confidence: "Low" | "Moderate" | "High" | "Very high" | "NA";
  trade: TradeIdea | null;
  keyLevels: { support?: number; resistance?: number; maxPain?: number; pcr?: number };
  greeks: Pick<
    GreeksResult,
    "atmIv" | "skewPutMinusCall" | "gammaFlip" | "regime" | "expectedMove1Sigma" | "hoursToExpiry"
  > | null;
  newsHeadlinesUsed: string[];
  reasons: string[];
  gatesFailed: string[];
  dataFreshnessMinutes: number;
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Adapter interfaces — implement these against YOUR existing code.
// ---------------------------------------------------------------------------

/** Wrap your existing MOAPI / NSE fetch code (smd-context.ts) behind this. */
export interface DataSource {
  getSnapshot(instrument: Instrument): Promise<MarketSnapshot>;
}

/** Wrap agent-memory.ts behind this so Jarvis can read/write its own history. */
export interface MemorySink {
  saveSignal(signal: JarvisSignal): Promise<void>;
  getRecentSignals(instrument: Instrument, limit: number): Promise<JarvisSignal[]>;
  getLastAlertTimestamp(instrument: Instrument): Promise<string | null>;
}

/** Wrap telegram.ts's sendTradeAlert behind this. */
export interface AlertSink {
  send(signal: JarvisSignal, message: string): Promise<void>;
}

/** Wrap whatever LLM/news client you already have (Groq/OpenRouter/etc). */
export interface NewsSentimentProvider {
  /** Return recent headlines relevant to `instrument` plus a -100..100 sentiment score. */
  getSentiment(instrument: Instrument): Promise<{ score: number; headlines: NewsItem[]; notes: string[] }>;
}
