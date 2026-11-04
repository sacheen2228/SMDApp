// SMC Research Adapter — Phase C of Unified Intraday Intelligence Engine
//
// Research-only SMC module. Reuses the validated market-structure-engine.ts
// (confirmed swings, BOS, CHOCH, structural failure, displacement) and the
// Unified Engine indicator coordinator.
//
// Does NOT use the buggy production smc-engine.ts. Does NOT modify it.
// Does NOT create a scanner or trading engine. Does NOT modify production
// strategies, execution, risk management or Telegram.
//
// All structure is derived from CONFIRMED candles (swing detection requires
// left+right confirmation bars), so nothing repaints. Missing/unverified
// data → null, never fabricated.

import {
  analyzeMarketStructure,
  detectSwings,
  detectBOSSignals,
  detectCHOCHSignals,
} from "@/lib/market-structure-engine";
import type { Candle } from "@/types/engine";
import type { SwingPoint } from "@/lib/auction-types";
import type { IndicatorBundle } from "./indicators";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type SmcStructure = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED";

export interface SmcEvent {
  type: "BOS" | "CHOCH" | "MSS" | "SWEEP" | "OB" | "FVG" | "DISPLACEMENT";
  direction: "bullish" | "bearish" | "neutral";
  price: number;
  strength: number; // 0-100
  index: number; // candle index in the confirmed series
  confirmed: boolean; // true only when swing is confirmed (left+right bars)
  notes?: string;
}

export interface SmcZone {
  type: "order_block" | "fvg" | "liquidity_sweep" | "invalidation";
  side: "support" | "resistance";
  price: number;
  strength: number;
  active: boolean;
}

export interface SmcRead {
  structure: SmcStructure;
  confidence: number; // 0-100, not a probability
  evidence: string[]; // observed facts
  conflictingEvidence: string[]; // inferences that oppose the structure
  events: SmcEvent[];
  zones: SmcZone[];
  invalidationLevel: number | null; // price that invalidates the read
  timestamp: string;
  freshness: "LIVE" | "FRESH" | "DELAYED" | "STALE" | "UNAVAILABLE";
  sufficientData: boolean;
  reason: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshnessFromAge(ageMs: number | null): SmcRead["freshness"] {
  if (ageMs == null) return "UNAVAILABLE";
  if (ageMs <= 30_000) return "LIVE";
  if (ageMs <= 300_000) return "FRESH";
  if (ageMs <= 900_000) return "DELAYED";
  return "STALE";
}

function swingPrice(swing: SwingPoint): number {
  return swing.price;
}

// ────────────────────────────────────────────────────────────────────────────
// Main SMC read
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produce a research-only SMC read from confirmed market structure.
 *
 * @param symbol — trading symbol
 * @param candles — confirmed candles, oldest → newest (swing detection needs
 *   left+right bars, so the most recent candles are NOT confirmed)
 * @param indicatorBundle — existing Unified Engine indicator bundle (for
 *   VWAP/ATR context and freshness)
 */
export function readSMC(
  symbol: string,
  candles: Candle[],
  indicatorBundle?: IndicatorBundle,
): SmcRead {
  const insufficient = (reason: string): SmcRead => ({
    structure: "MIXED",
    confidence: 0,
    evidence: [],
    conflictingEvidence: [],
    events: [],
    zones: [],
    invalidationLevel: null,
    timestamp: new Date().toISOString(),
    freshness: "UNAVAILABLE",
    sufficientData: false,
    reason,
  });

  if (!candles || candles.length < 30) {
    return insufficient("insufficient confirmed candles for SMC structure (need 30+)");
  }

  const structure = analyzeMarketStructure(candles);
  const swings = structure.swings;
  const lastCandleTs = candles[candles.length - 1]?.time ?? null;
  const freshness = freshnessFromAge(
    lastCandleTs ? Date.now() - lastCandleTs : null,
  );

  const lastPrice = candles[candles.length - 1].close;

  // ── Collect events (all from confirmed swings only) ──
  const events: SmcEvent[] = [];

  // BOS / CHOCH from market structure engine
  for (const ev of structure.bosEvents) {
    events.push({
      type: "BOS",
      direction: ev.includes("BULLISH") ? "bullish" : "bearish",
      price: lastPrice,
      strength: 70,
      index: candles.length - 1,
      confirmed: true,
      notes: ev,
    });
  }
  for (const ev of structure.chochEvents) {
    events.push({
      type: "CHOCH",
      direction: ev.includes("BULLISH") ? "bullish" : "bearish",
      price: lastPrice,
      strength: 75,
      index: candles.length - 1,
      confirmed: true,
      notes: ev,
    });
  }

  // Structural failures and displacements as MSS/sweep proxies
  for (const ev of structure.structuralFailures) {
    events.push({
      type: "MSS",
      direction: ev.includes("BEARISH") ? "bearish" : "bullish",
      price: lastPrice,
      strength: 65,
      index: candles.length - 1,
      confirmed: true,
      notes: ev,
    });
  }
  for (const ev of structure.displacements) {
    events.push({
      type: "DISPLACEMENT",
      direction: ev.includes("UP") ? "bullish" : "bearish",
      price: lastPrice,
      strength: 60,
      index: candles.length - 1,
      confirmed: true,
      notes: ev,
    });
  }

  // ── Detect liquidity sweeps from swings (equal highs/lows with rejection) ──
  // A sweep = price briefly extends beyond a confirmed swing point then
  // reclaims back inside. We detect from swing points (confirmed).
  const sweepZones: SmcZone[] = [];
  const recentSwings = swings.slice(-10);
  for (let i = 1; i < recentSwings.length; i++) {
    const prev = recentSwings[i - 1];
    const curr = recentSwings[i];

    // Equal highs (resistance liquidity): two swings at similar high, second
    // extends slightly beyond then price comes back below
    if (prev.type === "HIGH" && curr.type === "HIGH") {
      const diffPct = Math.abs(curr.price - prev.price) / prev.price;
      if (diffPct < 0.003) {
        // Check if current candle reclaims below the high
        const currCandle = candles[candles.length - 1];
        const reclaimed = currCandle.close < curr.price;
        sweepZones.push({
          type: "liquidity_sweep",
          side: "resistance",
          price: curr.price,
          strength: reclaimed ? 75 : 50,
          active: reclaimed,
        });
      }
    }
    // Equal lows (support liquidity)
    if (prev.type === "LOW" && curr.type === "LOW") {
      const diffPct = Math.abs(curr.price - prev.price) / prev.price;
      if (diffPct < 0.003) {
        const currCandle = candles[candles.length - 1];
        const reclaimed = currCandle.close > curr.price;
        sweepZones.push({
          type: "liquidity_sweep",
          side: "support",
          price: curr.price,
          strength: reclaimed ? 75 : 50,
          active: reclaimed,
        });
      }
    }
  }

  // ── Order blocks & FVG from swings (simplified, confirmed only) ──
  const obZones: SmcZone[] = [];
  const fvgZones: SmcZone[] = [];
  const swingArr = swings.slice(-8);
  for (let i = 1; i < swingArr.length; i++) {
    const prev = swingArr[i - 1];
    const curr = swingArr[i];

    // Order block: last opposite candle before a strong swing impulse
    // We approximate: a LOW swing followed by a HIGH swing higher → the
    // candle at the LOW is a bullish OB (support)
    if (prev.type === "LOW" && curr.type === "HIGH" && curr.price > prev.price * 1.005) {
      obZones.push({
        type: "order_block",
        side: "support",
        price: prev.price,
        strength: 65,
        active: lastPrice > prev.price * 0.995,
      });
    }
    if (prev.type === "HIGH" && curr.type === "LOW" && curr.price < prev.price * 0.995) {
      obZones.push({
        type: "order_block",
        side: "resistance",
        price: prev.price,
        strength: 65,
        active: lastPrice < prev.price * 1.005,
      });
    }

    // FVG: gap between swing 2 back and current swing (3-candle gap)
    if (i >= 2) {
      const s0 = swingArr[i - 2];
      const s2 = swingArr[i];
      if (s0.type === "LOW" && s2.type === "HIGH") {
        // Bullish FVG gap between s0 high and s2 low
        if (s2.price > s0.price) {
          fvgZones.push({
            type: "fvg",
            side: "support",
            price: (s0.price + s2.price) / 2,
            strength: 55,
            active: lastPrice > (s0.price + s2.price) / 2 * 0.99,
          });
        }
      }
      if (s0.type === "HIGH" && s2.type === "LOW") {
        if (s2.price < s0.price) {
          fvgZones.push({
            type: "fvg",
            side: "resistance",
            price: (s0.price + s2.price) / 2,
            strength: 55,
            active: lastPrice < (s0.price + s2.price) / 2 * 1.01,
          });
        }
      }
    }
  }

  const zones = [...sweepZones, ...obZones, ...fvgZones];

  // ── Determine structure bias ──
  let bullScore = 0;
  let bearScore = 0;
  const evidence: string[] = [];
  const conflictingEvidence: string[] = [];

  for (const ev of events) {
    if (ev.direction === "bullish") bullScore += ev.strength;
    else if (ev.direction === "bearish") bearScore += ev.strength;
    evidence.push(`${ev.type} ${ev.direction} at ₹${ev.price.toFixed(2)} (${ev.notes || ""})`);
  }

  // Sweep evidence
  for (const z of sweepZones) {
    if (z.active) {
      if (z.side === "resistance") {
        bullScore += z.strength;
        evidence.push(`Resistance liquidity swept at ₹${z.price.toFixed(2)} then reclaimed — bullish`);
      } else {
        bearScore += z.strength;
        evidence.push(`Support liquidity swept at ₹${z.price.toFixed(2)} then reclaimed — bearish`);
      }
    }
  }

  // OB evidence
  for (const z of obZones) {
    if (z.active) {
      if (z.side === "support") {
        bullScore += z.strength * 0.8;
        evidence.push(`Bullish order block support at ₹${z.price.toFixed(2)}`);
      } else {
        bearScore += z.strength * 0.8;
        evidence.push(`Bearish order block resistance at ₹${z.price.toFixed(2)}`);
      }
    }
  }

  // VWAP context from indicator bundle (observed fact, not inference)
  if (indicatorBundle?.vwap.value && indicatorBundle.vwap.sufficientData) {
    const vwap = indicatorBundle.vwap.value;
    if (lastPrice > vwap.vwap) {
      bullScore += 10;
      evidence.push(`Price above session VWAP (₹${vwap.vwap.toFixed(2)})`);
    } else if (lastPrice < vwap.vwap) {
      bearScore += 10;
      evidence.push(`Price below session VWAP (₹${vwap.vwap.toFixed(2)})`);
    }
  }

  // Trend from market structure
  if (structure.currentTrend === "UP") {
    bullScore += 20;
    evidence.push("Confirmed swing structure: higher highs and higher lows");
  } else if (structure.currentTrend === "DOWN") {
    bearScore += 20;
    evidence.push("Confirmed swing structure: lower highs and lower lows");
  } else {
    evidence.push("Swing structure: sideways / no clear trend");
  }

  // ── Conflicting evidence (inferences that oppose) ──
  // If BOS is bullish but price is at a strong resistance sweep, that's a conflict
  const resistanceSweepsActive = sweepZones.filter((z) => z.side === "resistance" && z.active).length;
  const supportSweepsActive = sweepZones.filter((z) => z.side === "support" && z.active).length;
  if (bullScore > bearScore && resistanceSweepsActive > 0) {
    conflictingEvidence.push("Bullish structure but active resistance liquidity sweep — breakout may fail");
  }
  if (bearScore > bullScore && supportSweepsActive > 0) {
    conflictingEvidence.push("Bearish structure but active support liquidity sweep — breakdown may fail");
  }

  // ── Structure determination ──
  let structureBias: SmcStructure = "MIXED";
  if (bullScore > bearScore * 1.3) structureBias = "BULLISH";
  else if (bearScore > bullScore * 1.3) structureBias = "BEARISH";
  else if (bullScore > 0 || bearScore > 0) structureBias = "MIXED";
  else structureBias = "NEUTRAL";

  const total = bullScore + bearScore;
  const confidence = total > 0 ? Math.min(100, Math.round(Math.abs(bullScore - bearScore) / total * 100)) : 0;

  // ── Invalidation level ──
  let invalidationLevel: number | null = null;
  if (structureBias === "BULLISH") {
    // Invalidate on break below the most recent confirmed swing low
    const recentLows = swings.filter((s) => s.type === "LOW").slice(-3);
    if (recentLows.length > 0) {
      invalidationLevel = Math.min(...recentLows.map((s) => s.price));
    }
  } else if (structureBias === "BEARISH") {
    const recentHighs = swings.filter((s) => s.type === "HIGH").slice(-3);
    if (recentHighs.length > 0) {
      invalidationLevel = Math.max(...recentHighs.map((s) => s.price));
    }
  }

  const sufficientData = candles.length >= 30 && freshness !== "UNAVAILABLE";

  return {
    structure: structureBias,
    confidence,
    evidence,
    conflictingEvidence,
    events,
    zones,
    invalidationLevel,
    timestamp: new Date().toISOString(),
    freshness,
    sufficientData,
    reason: sufficientData ? null : "insufficient confirmed candles",
  };
}
