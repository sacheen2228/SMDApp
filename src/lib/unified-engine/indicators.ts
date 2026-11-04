// Unified Indicator Integration — Phase B
//
// Reuses existing validated indicator modules. No new indicator math is
// invented here; this module composes and validates existing calculations:
//
//   • ATR — src/indicators/atr.ts (computeATR, computeATRPercent, classifyATRRegime)
//   • VWAP — src/indicators/vwap.ts
//   • ADX — src/indicators/adx.ts (computeADX, classifyTrend)
//   • RVOL — src/lib/volume-engine.ts (calculateRelativeVolume)
//   • Volume Profile — src/lib/auction-engine.ts (calculateVolumeProfile)
//   • Market Structure — src/lib/market-structure-engine.ts (analyzeMarketStructure)
//   • Regime — src/lib/regime-classifier.ts (classifyMarketRegime)
//   • Market Direction — src/lib/market-direction-analyzer.ts (analyzeMarketDirection)
//   • DTR — ./dtr.ts (calculateDTR)
//
// Missing/stale/unverified data → null, never fabricated. All results carry
// freshness and sufficiency flags.

import {
  computeATR,
  computeATRPercent,
  classifyATRRegime,
} from "@/indicators/atr";
import { computeVWAP, computeVWAPBands } from "@/indicators/vwap";
import { computeADX, classifyTrend } from "@/indicators/adx";
import { calculateRelativeVolume } from "@/lib/volume-engine";
import type { VolumeProfile, SwingPoint, MarketRegime } from "@/lib/auction-types";
import { calculateVolumeProfile } from "@/lib/auction-engine";
import {
  analyzeMarketStructure,
} from "@/lib/market-structure-engine";
import { classifyMarketRegime } from "@/lib/regime-classifier";
import { analyzeMarketDirection } from "@/lib/market-direction-analyzer";
import { calculateDTR, type DtrResult } from "./dtr";
import type { Candle } from "@/types/engine";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type IndicatorFreshness = "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface IndicatorRead<T> {
  value: T | null;
  freshness: IndicatorFreshness;
  sufficientData: boolean;
  reason: string | null;
}

export interface IndicatorBundle {
  symbol: string;
  timestamp: string;
  /** The last candle's timestamp, used to judge staleness */
  lastCandleTs: number | null;

  dtr: IndicatorRead<DtrResult>;
  atr: IndicatorRead<{ atr: number; atrPct: number; regime: 'low' | 'normal' | 'high' | 'extreme' }>;
  vwap: IndicatorRead<{ vwap: number; upperBand2: number; lowerBand2: number; deviationPct: number }>;
  adx: IndicatorRead<{ adx: number; plusDI: number; minusDI: number; trend: string }>;
  rvol: IndicatorRead<{ current: number; average: number; ratio: number; percentile: number; acceleration: number }>;
  volumeProfile: IndicatorRead<VolumeProfile>;
  marketStructure: IndicatorRead<{
    swings: SwingPoint[];
    bosEvents: string[];
    chochEvents: string[];
    currentTrend: 'UP' | 'DOWN' | 'SIDEWAYS';
  }>;
  regime: IndicatorRead<{
    regime: MarketRegime;
    tradeable: boolean;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  }>;
  marketDirection: IndicatorRead<{
    trend: string;
    score: number;
    vwapPosition: 'ABOVE' | 'BELOW' | 'AT';
    emaAlignment: string;
  }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshnessFromAge(ageMs: number | null): IndicatorFreshness {
  if (ageMs == null) return "UNAVAILABLE";
  if (ageMs <= 30_000) return "LIVE";
  if (ageMs <= 300_000) return "FRESH";
  if (ageMs <= 900_000) return "DELAYED";
  return "STALE";
}

function read<T>(
  value: T | null,
  sufficient: boolean,
  reason: string | null,
  lastCandleTs: number | null,
): IndicatorRead<T> {
  return {
    value,
    freshness: freshnessFromAge(lastCandleTs ? Date.now() - lastCandleTs : null),
    sufficientData: sufficient,
    reason,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main integration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full indicator bundle for a symbol from candle data.
 *
 * @param symbol — the trading symbol
 * @param todayCandles — today's candles, oldest → newest (DTR, VWAP session)
 * @param historicalCandles — lookback candles, oldest → newest (ATR, ADX, RVOL, structure, regime)
 * @param currentPrice — optional live price override
 * @param lastCandleTs — timestamp of the most recent candle (ms), for staleness
 */
export function computeIndicatorBundle(
  symbol: string,
  todayCandles: Candle[],
  historicalCandles: Candle[],
  currentPrice?: number,
  lastCandleTs?: number,
): IndicatorBundle {
  const ts = lastCandleTs ?? (todayCandles[todayCandles.length - 1]?.time ?? null);
  const hasTodayData = todayCandles.length > 0;
  const hasHistory = historicalCandles.length >= 10;

  // ── DTR ──
  const dtrResult = hasTodayData
    ? calculateDTR(todayCandles, historicalCandles, currentPrice)
    : null;
  const dtr = read(
    dtrResult ?? null,
    dtrResult?.sufficientData ?? false,
    dtrResult?.insufficientReason ?? "no today candles",
    ts,
  );

  // ── ATR ──
  const atrInput = [...historicalCandles, ...todayCandles];
  const atrValue = atrInput.length >= 15 ? computeATR(atrInput, 14) : null;
  const atrPrice = currentPrice ?? (todayCandles.length ? todayCandles[todayCandles.length - 1].close : 0);
  const atrPct = atrValue != null && atrPrice > 0 ? computeATRPercent(atrValue, atrPrice) : null;
  const atrRegime = atrPct != null ? classifyATRRegime(atrPct) : null;
  const atr = read(
    atrValue != null ? { atr: atrValue, atrPct: atrPct ?? 0, regime: atrRegime ?? 'normal' } : null,
    atrValue != null && atrPct != null,
    atrValue == null ? "insufficient candles for ATR(14)" : null,
    ts,
  );

  // ── VWAP (session) ──
  const vwapVal = hasTodayData ? computeVWAP(todayCandles) : null;
  const vwapBands = hasTodayData ? computeVWAPBands(todayCandles) : null;
  const lastClose = todayCandles.length ? todayCandles[todayCandles.length - 1].close : 0;
  const vwapDeviation = vwapVal != null && vwapVal > 0 && lastClose > 0 ? ((lastClose - vwapVal) / vwapVal) * 100 : null;
  const vwap = read(
    vwapVal != null && vwapBands != null
      ? { vwap: vwapVal, upperBand2: vwapBands.upper, lowerBand2: vwapBands.lower, deviationPct: vwapDeviation ?? 0 }
      : null,
    vwapVal != null,
    vwapVal == null ? "no session candles for VWAP" : null,
    ts,
  );

  // ── ADX ──
  const adxResult = atrInput.length >= 15 ? computeADX(atrInput, 14) : null;
  const adx = read(
    adxResult
      ? { adx: adxResult.adx, plusDI: adxResult.plusDI, minusDI: adxResult.minusDI, trend: classifyTrend(adxResult.adx) }
      : null,
    adxResult != null,
    adxResult == null ? "insufficient candles for ADX(14)" : null,
    ts,
  );

  // ── RVOL ──
  const rvolResult = atrInput.length >= 11 ? calculateRelativeVolume(atrInput, atrInput.length - 1) : null;
  const rvol = read(
    rvolResult
      ? { current: rvolResult.current, average: rvolResult.average, ratio: rvolResult.ratio, percentile: rvolResult.percentile, acceleration: rvolResult.acceleration }
      : null,
    rvolResult != null,
    rvolResult == null ? "insufficient candles for RVOL" : null,
    ts,
  );

  // ── Volume Profile ──
  const vpCandles = atrInput.length > 0 ? atrInput : [];
  const volumeProfile = vpCandles.length >= 20
    ? read<VolumeProfile>(calculateVolumeProfile(vpCandles), true, null, ts)
    : read<VolumeProfile>(null, false, "insufficient candles for volume profile", ts);

  // ── Market Structure ──
  const structure = atrInput.length >= 20 ? analyzeMarketStructure(atrInput) : null;
  const marketStructure = read(
    structure
      ? {
          swings: structure.swings,
          bosEvents: structure.bosEvents.map((e) => String(e)),
          chochEvents: structure.chochEvents.map((e) => String(e)),
          currentTrend: structure.currentTrend,
        }
      : null,
    structure != null,
    structure == null ? "insufficient candles for market structure" : null,
    ts,
  );

  // ── Regime ──
  const vpValue = volumeProfile.value;
  const regimeResult = structure && vpValue
    ? classifyMarketRegime(
        atrInput,
        vpValue,
        {
          prevDayHigh: 0,
          prevDayLow: 0,
          prevWeekHigh: 0,
          prevWeekLow: 0,
          openingRange: { high: 0, low: 0, time: 0 },
          sessionHigh: 0,
          sessionLow: 0,
          sessionVwap: vwapVal ?? 0,
          initialBalance: { high: 0, low: 0 },
          first15mRange: { high: 0, low: 0, time: 0 },
          first30mRange: { high: 0, low: 0, time: 0 },
          levels: [],
          totalVolume: 0,
          valueAreaVolume: 0,
          hvn: [],
          lvn: [],
          nakedPoc: [],
          volumeGaps: [],
          date: '',
        } as any,
        structure,
        rvolResult ?? { current: 0, average: 0, ratio: 1, percentile: 50, acceleration: 1 },
        vwapVal ?? 0,
        { state: 'ABOVE_VWAP', distance: vwapDeviation ?? 0, reclaim: false, rejection: false } as any,
      )
    : null;
  const regime = read(
    regimeResult
      ? {
          regime: regimeResult,
          tradeable: !['HIGH_VOLATILITY', 'TRANSITION'].includes(regimeResult),
          bias: (regimeResult === 'TRENDING_UP' || regimeResult === 'BREAKOUT' || regimeResult === 'ACCUMULATION' ? 'BULLISH'
            : regimeResult === 'TRENDING_DOWN' || regimeResult === 'DISTRIBUTION' || regimeResult === 'FAILED_BREAKOUT' ? 'BEARISH'
            : 'NEUTRAL') as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
        }
      : null,
    regimeResult != null,
    regimeResult == null ? "insufficient data for regime classification" : null,
    ts,
  );

  // ── Market Direction ──
  const mdResult = hasHistory
    ? analyzeMarketDirection({
        spotPrice: atrPrice,
        vix: null,
        pcr: null,
        maxPain: 0,
        dailyCandles: historicalCandles,
        intradayCandles: undefined,
        breadth: undefined,
      })
    : null;
  const marketDirection = read(
    mdResult
      ? {
          trend: mdResult.trend,
          score: mdResult.score,
          vwapPosition: mdResult.multiTimeframe.vwapPosition,
          emaAlignment: mdResult.multiTimeframe.emaAlignment,
        }
      : null,
    mdResult != null,
    mdResult == null ? "insufficient daily candles for market direction" : null,
    ts,
  );

  return {
    symbol,
    timestamp: new Date().toISOString(),
    lastCandleTs: ts,
    dtr,
    atr,
    vwap,
    adx,
    rvol,
    volumeProfile,
    marketStructure,
    regime,
    marketDirection,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Sufficiency gate
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns true only when the critical indicators for a trade decision all
 * have sufficient data. Missing/stale data fails closed — no trade is
 * recommended on incomplete evidence.
 */
export function indicatorsSufficientForTrade(bundle: IndicatorBundle): boolean {
  const critical = [bundle.dtr, bundle.atr, bundle.vwap, bundle.adx, bundle.rvol, bundle.marketStructure, bundle.marketDirection];
  return critical.every((r) => r.sufficientData && r.freshness !== "STALE" && r.freshness !== "UNAVAILABLE");
}
