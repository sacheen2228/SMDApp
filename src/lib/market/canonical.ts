// Canonical Market Snapshot — the single contract every module consumes.
// Feature math is computed HERE exactly once, reusing existing analytics libs.
// No other module should independently recompute market features.
import { analyzeOptionChain } from "@/lib/sdm-oianalysis";
import { detectSwingPoints, detectStructureEvents } from "@/lib/market-structure";
import { calculateVWAP } from "@/lib/ml-engine";
import { calculateATR } from "@/lib/orca-strategy";
import { computeVolumeProfile, findPOC, findValueArea } from "@/lib/volume-analysis";
import type { SDMOptionStrike } from "@/types/sdm";

// ─── Versioning ────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;
export const FEATURE_VERSION = 1;
export const ENGINE_VERSION = "1.0.0";

// ─── Types (mirror CONTRACTS.md) ───────────────────────────────
export interface OptionLeg {
  strike: number;
  type: "CE" | "PE";
  ltp: number;
  oi: number;
  oiChg: number;
  iv: number | null;
  greeks: { delta: number; theta: number; gamma: number; vega: number };
  volume: number;
}

export type SmcEventType = "BOS" | "CHoCH" | "FVG" | "ORDER_BLOCK" | "LIQUIDITY_SWEEP";
export interface SmcEvent {
  type: SmcEventType;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  price: number | null;
  details: Record<string, unknown>;
}

export interface VolumeProfile {
  poc: number;
  vah: number;
  val: number;
  bins: { price: number; volume: number }[];
}

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CanonicalMarketSnapshot {
  schema_version: number;
  feature_version: number;
  engine_version: string;
  snapshotId: string; // stable: `${symbol}-${timestamp}`
  symbol: string;
  timestamp: string;
  spot: number;
  futures: number | null;
  indiaVix: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  maxPain: number | null;
  iv: number | null;
  atr: number | null;
  vwap: number | null;
  volume: number | null;
  breadth: { advancers: number; decliners: number } | null;
  optionChain: OptionLeg[];
  smcEvents: SmcEvent[];
  volumeProfile: VolumeProfile | null;
  aiScores: Record<string, number>;
  features: Record<string, number>;
}

export interface BuildInput {
  symbol: string;
  timestamp: string;
  spot: number;
  futures?: number | null;
  indiaVix?: number | null;
  breadthAdv?: number;
  breadthDec?: number;
  optionChain: OptionLeg[];
  candles: Candle[];
  aiScores?: Record<string, number>;
}

// ─── Raw chain → SDMOptionStrike (group CE/PE per strike) ──────
function toSDMOptionStrike(chain: OptionLeg[]): SDMOptionStrike[] {
  const byStrike = new Map<number, Partial<SDMOptionStrike>>();
  for (const leg of chain) {
    const entry = byStrike.get(leg.strike) ?? { strike: leg.strike };
    const legData = {
      ltp: leg.ltp,
      oi: leg.oi,
      oiChg: leg.oiChg,
      volume: leg.volume,
      iv: leg.iv ?? 0,
      delta: leg.greeks.delta,
      theta: leg.greeks.theta,
      gamma: leg.greeks.gamma,
      vega: leg.greeks.vega,
    };
    if (leg.type === "CE") entry.ce = legData;
    else entry.pe = legData;
    byStrike.set(leg.strike, entry);
  }
  return Array.from(byStrike.values()) as SDMOptionStrike[];
}

// ─── SMC: FVG + Order Block ─────────────────────────────────────
// Algorithm PORTED from src/lib/zero-hero-ai/smart-money-engine.ts (DEPRECATED).
// Reused here as the production implementation per the Architecture Guardian
// (no import of the deprecated module) and validation requirement #2 — it is
// the only FVG/Order-Block logic in the repository.
export function detectFVG(candles: Candle[]): SmcEvent[] {
  const out: SmcEvent[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (prev.high < next.low) {
      out.push({ type: "FVG", direction: "BULLISH", price: (next.low + prev.high) / 2, details: { top: next.low, bottom: prev.high, direction: "UP" } });
    }
    if (prev.low > next.high) {
      out.push({ type: "FVG", direction: "BEARISH", price: (prev.low + next.high) / 2, details: { top: prev.low, bottom: next.high, direction: "DOWN" } });
    }
  }
  return out;
}

export function detectOrderBlocks(candles: Candle[]): SmcEvent[] {
  const out: SmcEvent[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];
    if (curr.close < curr.open && curr.close < prev.close && next.close > curr.open) {
      out.push({ type: "ORDER_BLOCK", direction: "BULLISH", price: (curr.open + curr.low) / 2, details: { top: curr.open, bottom: curr.low, direction: "BULLISH" } });
    }
    if (curr.close > curr.open && curr.close > prev.close && next.close < curr.open) {
      out.push({ type: "ORDER_BLOCK", direction: "BEARISH", price: (curr.high + curr.open) / 2, details: { top: curr.high, bottom: curr.open, direction: "BEARISH" } });
    }
  }
  return out;
}

function buildSmc(candles: Candle[]): SmcEvent[] {
  if (candles.length < 3) return [];
  const swings = detectSwingPoints(candles as any);
  const structure = detectStructureEvents(candles as any, swings);
  const events: SmcEvent[] = structure.map((e: any) => ({
    type: e.type === "LIQUIDITY_GRAB" ? "LIQUIDITY_SWEEP" : (e.type as SmcEventType),
    direction: e.direction,
    price: e.price ?? null,
    details: { ...e },
  }));
  events.push(...detectFVG(candles));
  events.push(...detectOrderBlocks(candles));
  return events;
}

function buildVolumeProfile(candles: Candle[]): VolumeProfile | null {
  if (candles.length === 0) return null;
  const profile = computeVolumeProfile(candles as any, 20);
  const poc = findPOC(profile);
  const { vah, val } = findValueArea(profile);
  return { poc, vah, val, bins: profile.map((b: any) => ({ price: b.price, volume: b.volume })) };
}

// ─── Main builder ──────────────────────────────────────────────
export function buildCanonicalSnapshot(input: BuildInput): CanonicalMarketSnapshot {
  const { symbol, timestamp, spot, futures = null, indiaVix = null, breadthAdv, breadthDec, optionChain, candles, aiScores = {} } = input;

  const sdm = toSDMOptionStrike(optionChain);
  const oi = analyzeOptionChain(sdm, spot);

  const atr = candles.length >= 2 ? calculateATR(candles as any, 14) : null;
  const vwap = candles.length ? calculateVWAP(candles as any) : null;
  const volumeProfile = buildVolumeProfile(candles);
  const smcEvents = buildSmc(candles);

  const avgIv = optionChain.length
    ? optionChain.reduce((s, l) => s + (l.iv ?? 0), 0) / optionChain.length
    : null;
  const totalVol = optionChain.reduce((s, l) => s + l.volume, 0);
  const breadthRatio = breadthAdv && breadthDec ? breadthAdv / (breadthAdv + breadthDec) : null;

  const features: Record<string, number> = {
    pcrOi: oi.pcrOI,
    pcrVol: oi.pcrVolume,
    maxPain: oi.maxPain ?? 0,
    spot,
    atr: atr ?? 0,
    vwap: vwap ?? 0,
    avgIv: avgIv ?? 0,
    totalVolume: totalVol,
    smcEventCount: smcEvents.length,
    breadthRatio: breadthRatio ?? 0,
  };

  return {
    schema_version: SCHEMA_VERSION,
    feature_version: FEATURE_VERSION,
    engine_version: ENGINE_VERSION,
    snapshotId: `${symbol}-${timestamp}`,
    symbol,
    timestamp,
    spot,
    futures,
    indiaVix,
    pcrOi: oi.pcrOI,
    pcrVol: oi.pcrVolume,
    maxPain: oi.maxPain,
    iv: avgIv,
    atr,
    vwap,
    volume: totalVol,
    breadth: breadthAdv != null && breadthDec != null ? { advancers: breadthAdv, decliners: breadthDec } : null,
    optionChain,
    smcEvents,
    volumeProfile,
    aiScores,
    features,
  };
}

// ─── Backward compatibility ────────────────────────────────────
// Historical sessions must replay correctly even as the schema evolves.
// Schema changes are ADDITIVE; this hook upgrades an older raw snapshot to the
// current CanonicalMarketSnapshot shape. v1 is a pass-through; future versions
// transform older rows and fill any newly-added fields with safe defaults so
// Replay Engine / Backtest never break on legacy recordings.
export function migrateSnapshot(raw: CanonicalMarketSnapshot, version: number): CanonicalMarketSnapshot {
  if (version === SCHEMA_VERSION) return raw;
  // Future: switch (version) { case 1: return upgradeV1ToV2(raw); }
  return { ...raw, schema_version: SCHEMA_VERSION };
}
