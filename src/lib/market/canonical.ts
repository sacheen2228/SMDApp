// Canonical Market Snapshot — the single contract every module consumes.
// Feature math is computed HERE exactly once, reusing existing analytics libs.
// No other module should independently recompute market features.
import { analyzeOptionChain } from "@/lib/sdm-oianalysis";
import { detectSwingPoints, detectStructureEvents } from "@/lib/market-structure";
import { calculateVWAP } from "@/lib/ml-engine";
import { calculateATR } from "@/lib/signal-engine";
import { computeVolumeProfile, findPOC, findValueArea } from "@/lib/volume-analysis";
import type { SDMOptionStrike } from "@/types/sdm";

// ─── Versioning ────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;
export const FEATURE_VERSION = 1;
export const ENGINE_VERSION = "1.0.0";

// ─── Types (mirror CONTRACTS.md) ───────────────────────────────
// A recorded option leg. Every market field is NULLABLE on purpose: a field
// the provider did not publish is recorded as MISSING, never as an invented
// zero. `estimated` marks values we computed locally (Black-Scholes greeks
// from a published IV) so downstream consumers can tell a published delta
// from a derived one.
export interface OptionLeg {
  strike: number;
  type: "CE" | "PE";
  ltp: number | null;
  oi: number | null;
  oiChg: number | null;
  iv: number | null;
  greeks: {
    delta: number | null;
    theta: number | null;
    gamma: number | null;
    vega: number | null;
  };
  volume: number | null;
  bid?: number | null;
  ask?: number | null;
  estimated?: boolean;
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
  /**
   * The PROVIDER's own quote/chain time (ISO). NULL when the provider does
   * not publish one (ICICI Breeze does not) — recorded as missing, never
   * faked with the local clock. `collectedAt` is the local capture time.
   */
  providerTimestamp: string | null;
  collectedAt: string;
  /** Which source produced this snapshot ('breeze' | 'nse' | 'bse' | null). */
  source: string | null;
  /**
   * Freshness of the payload, derived from the PROVIDER's own timestamp
   * (LIVE | FRESH | DELAYED | STALE | UNAVAILABLE). NULL when the provider
   * publishes no timestamp — an undated payload is undated, never LIVE.
   */
  freshness: string | null;
  /** Contract expiry the chain belongs to (null when unknown). */
  expiry: string | null;
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
  providerTimestamp?: string | null;
  collectedAt?: string;
  source?: string | null;
  freshness?: string | null;
  expiry?: string | null;
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
      ltp: leg.ltp ?? 0,
      oi: leg.oi ?? 0,
      oiChg: leg.oiChg ?? 0,
      volume: leg.volume ?? 0,
      iv: leg.iv ?? 0,
      delta: leg.greeks.delta ?? 0,
      theta: leg.greeks.theta ?? 0,
      gamma: leg.greeks.gamma ?? 0,
      vega: leg.greeks.vega ?? 0,
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
// Epoch ms for a candle that may be either CandleData (time: number) or
// canonical Candle (timestamp: string) — callers cast both shapes.
function eventTime(c: any): number {
  return Number(c?.time) || Date.parse(String(c?.timestamp ?? '')) || 0;
}

export function detectFVG(candles: Candle[]): SmcEvent[] {
  const out: SmcEvent[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (prev.high < next.low) {
      out.push({ type: "FVG", direction: "BULLISH", price: (next.low + prev.high) / 2, details: { top: next.low, bottom: prev.high, direction: "UP", time: eventTime(next) } });
    }
    if (prev.low > next.high) {
      out.push({ type: "FVG", direction: "BEARISH", price: (prev.low + next.high) / 2, details: { top: prev.low, bottom: next.high, direction: "DOWN", time: eventTime(next) } });
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
      out.push({ type: "ORDER_BLOCK", direction: "BULLISH", price: (curr.open + curr.low) / 2, details: { top: curr.open, bottom: curr.low, direction: "BULLISH", time: eventTime(curr) } });
    }
    if (curr.close > curr.open && curr.close > prev.close && next.close < curr.open) {
      out.push({ type: "ORDER_BLOCK", direction: "BEARISH", price: (curr.high + curr.open) / 2, details: { top: curr.high, bottom: curr.open, direction: "BEARISH", time: eventTime(curr) } });
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
  const providerTimestamp = input.providerTimestamp ?? null;
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const source = input.source ?? null;
  const expiry = input.expiry ?? null;
  const freshness = input.freshness ?? null;

  const sdm = toSDMOptionStrike(optionChain);
  const oi = analyzeOptionChain(sdm, spot);

  const atr = candles.length >= 2 ? calculateATR(candles as any, 14) : null;
  const vwap = candles.length ? calculateVWAP(candles as any) : null;
  const volumeProfile = buildVolumeProfile(candles);
  const smcEvents = buildSmc(candles);

  const avgIv = optionChain.length
    ? optionChain.reduce((s, l) => s + (l.iv ?? 0), 0) / optionChain.length
    : null;
  const totalVol = optionChain.reduce((s, l) => s + (l.volume ?? 0), 0);
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
    providerTimestamp,
    collectedAt,
    source,
    freshness,
    expiry,
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
  // Provenance fields were added after v1 recordings existed. Fill them with
  // MISSING (null) — never with the local clock pretending to be a provider
  // timestamp. `collectedAt` falls back to the snapshot's own capture bucket.
  const normalized: CanonicalMarketSnapshot = {
    ...raw,
    providerTimestamp: raw.providerTimestamp ?? null,
    collectedAt: raw.collectedAt ?? raw.timestamp,
    source: raw.source ?? null,
    freshness: raw.freshness ?? null,
    expiry: raw.expiry ?? null,
  };
  if (version === SCHEMA_VERSION) return normalized;
  // Future: switch (version) { case 1: return upgradeV1ToV2(raw); }
  return { ...normalized, schema_version: SCHEMA_VERSION };
}
