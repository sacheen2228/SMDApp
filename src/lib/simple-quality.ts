// simple-quality.ts — build a QualityScoreInput from what the Simple Tab
// already has (live chain, OI analysis, tech structure, plan levels) and run
// the existing 14-factor computeQualityScore. Missing slices are honest
// DEGRADED stubs — never fabricated numbers.

import type {
  ConsensusResult,
  GEXResult,
  MarketStructure,
  OIAnalysis,
  QualityScore,
  QualityScoreInput,
  SDMOptionStrike,
  VolumeAnalysis,
} from "@/types/sdm";
import { computeQualityScore } from "./sdm-scores";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** API legs may publish null IV/greeks — normalize to 0 without inventing values. */
export function normalizeChain(raw: unknown): SDMOptionStrike[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r: any) => r && typeof r.strike === "number")
    .map((r: any) => ({
      strike: r.strike,
      ce: r.ce
        ? {
            ltp: num(r.ce.ltp),
            oi: num(r.ce.oi),
            oiChg: num(r.ce.oiChg),
            volume: num(r.ce.volume),
            iv: num(r.ce.iv),
            delta: num(r.ce.delta),
            theta: num(r.ce.theta),
            gamma: num(r.ce.gamma),
            vega: num(r.ce.vega),
          }
        : null,
      pe: r.pe
        ? {
            ltp: num(r.pe.ltp),
            oi: num(r.pe.oi),
            oiChg: num(r.pe.oiChg),
            volume: num(r.pe.volume),
            iv: num(r.pe.iv),
            delta: num(r.pe.delta),
            theta: num(r.pe.theta),
            gamma: num(r.pe.gamma),
            vega: num(r.pe.vega),
          }
        : null,
    }));
}

export function degradedGEX(): GEXResult {
  return {
    gexProfile: [],
    totalGEX: 0,
    gammaFlip: 0,
    gammaWalls: [],
    dealerRegime: "LONG_GAMMA",
    dealerBias: "NEUTRAL",
    status: "DEGRADED",
  };
}

export function degradedVolume(): VolumeAnalysis {
  return {
    poc: 0,
    vah: 0,
    val: 0,
    cumulativeDelta: 0,
    volumeProfile: [],
    absorptionLevels: [],
    exhaustionSignals: [],
    totalVolume: 0,
    avgVolume: 0,
    status: "DEGRADED",
  };
}

export function degradedConsensus(): ConsensusResult {
  return {
    timeframes: [],
    consensus: 0,
    overallBias: "NEUTRAL",
    bullishCount: 0,
    bearishCount: 0,
    neutralCount: 1,
    status: "DEGRADED",
  };
}

export function degradedOI(): OIAnalysis {
  return {
    classifications: [],
    freshWriting: [],
    traps: [],
    supportResistance: { resistance: [], support: [] },
    migration: [],
    pcrOI: 0,
    pcrVolume: 0,
    maxPain: 0,
    status: "DEGRADED",
  };
}

/**
 * Map the tech-cache 15m trend read onto MarketStructure.
 * Missing/stale structure → DEGRADED (factor neutral, never a fake BOS).
 */
export function marketStructureFromTrend(
  trendRead: {
    structureTrend?: string;
    structureEvent?: string | null;
    structureEventBarsAgo?: number | null;
    lastHigh?: number;
    lastLow?: number;
  } | null
): MarketStructure {
  const base: MarketStructure = {
    trend: "RANGING",
    swingPoints: [],
    lastSwingHigh: 0,
    lastSwingLow: 0,
    structureEvent: null,
    supportLevels: [],
    resistanceLevels: [],
    status: "DEGRADED",
  };
  if (!trendRead?.structureTrend) return base;

  const t = String(trendRead.structureTrend).toUpperCase();
  const trend =
    t === "UP" || t === "UPTREND"
      ? "UPTREND"
      : t === "DOWN" || t === "DOWNTREND"
        ? "DOWNTREND"
        : "RANGING";

  let structureEvent: MarketStructure["structureEvent"] = null;
  const ev = trendRead.structureEvent;
  if (ev === "BOS_UP" || ev === "BOS_DOWN") {
    structureEvent = {
      type: "BOS",
      direction: ev === "BOS_UP" ? "BULLISH" : "BEARISH",
      price: trendRead.structureEventBarsAgo != null ? 0 : 0,
      time: 0,
    };
  } else if (ev === "CHOCH_UP" || ev === "CHOCH_DOWN") {
    structureEvent = {
      type: "CHoCH",
      direction: ev === "CHOCH_UP" ? "BULLISH" : "BEARISH",
      price: 0,
      time: 0,
    };
  }

  return {
    ...base,
    trend,
    structureEvent,
    lastSwingHigh: num(trendRead.lastHigh),
    lastSwingLow: num(trendRead.lastLow),
    status: "OK",
  };
}

export interface SimpleQualityArgs {
  chain: SDMOptionStrike[];
  spot: number;
  oiAnalysis?: OIAnalysis | null;
  trendRead?: Parameters<typeof marketStructureFromTrend>[0];
  vix: number;
  tradeDirection: "CALL" | "PUT";
  entryPrice: number;
  stopLoss: number;
  target1: number;
  /** Optional real cumulative-delta / profile slice when the caller has one. */
  volumeAnalysis?: VolumeAnalysis | null;
  gexResult?: GEXResult | null;
  consensus?: ConsensusResult | null;
}

/**
 * Run the existing 14-factor quality engine on Simple Tab inputs.
 * Never blocks on missing engines — DEGRADED factors report neutral.
 */
export function computeSimpleQuality(args: SimpleQualityArgs): QualityScore {
  const input: QualityScoreInput = {
    spot: args.spot,
    candles: {},
    optionChain: args.chain,
    gexResult: args.gexResult ?? degradedGEX(),
    marketStructure: marketStructureFromTrend(args.trendRead ?? null),
    consensus: args.consensus ?? degradedConsensus(),
    volumeAnalysis: args.volumeAnalysis ?? degradedVolume(),
    oiAnalysis: args.oiAnalysis ?? degradedOI(),
    // 0 = unknown VIX → volatility factor reads conservative, never a fake 15.
    vix: Number.isFinite(args.vix) && args.vix > 0 ? args.vix : 0,
    currentWindow: "normal",
    tradeDirection: args.tradeDirection,
    entryPrice: args.entryPrice,
    stopLoss: args.stopLoss,
    target1: args.target1,
  };
  return computeQualityScore(input);
}
