// Hermes ↔ Unified Scoring Bridge
// Converts HermesContext to MarketDataInput for the unified scoring engine.
// This ensures Hermes uses HERMES profile weights from the unified engine.

import type { HermesContext, Direction, OptionSide } from "./types";
import {
  scoreTrade,
  type MarketDataInput,
  type TradeDecision,
  type StrategyProfile,
} from "@/lib/unified-scoring-engine";

// ── Convert HermesContext → MarketDataInput ─────────────────────────

export function hermesContextToMarketInput(
  ctx: HermesContext,
  direction: Direction,
  side: OptionSide,
  strategy: StrategyProfile = "HERMES"
): MarketDataInput {
  const chain = ctx.optionChain.value;
  const spot = chain?.spot || ctx.spot.value?.price || 0;
  const vix = ctx.vix.value || 15;

  // Map Hermes strikes to unified format
  const optionChain = chain?.strikes?.map((s: any) => ({
    strike: s.strike,
    ce: s.ce ? {
      ltp: s.ce.ltp || 0,
      oi: s.ce.oi || 0,
      oiChg: s.ce.oiChange || 0,
      volume: s.ce.volume || 0,
      iv: s.ce.iv || 0,
      delta: s.ce.delta || 0,
      theta: s.ce.theta || 0,
      gamma: s.ce.gamma || 0,
      vega: s.ce.vega || 0,
      bid: s.ce.bid ?? undefined,
      ask: s.ce.ask ?? undefined,
    } : undefined,
    pe: s.pe ? {
      ltp: s.pe.ltp || 0,
      oi: s.pe.oi || 0,
      oiChg: s.pe.oiChange || 0,
      volume: s.pe.volume || 0,
      iv: s.pe.iv || 0,
      delta: s.pe.delta || 0,
      theta: s.pe.theta || 0,
      gamma: s.pe.gamma || 0,
      vega: s.pe.vega || 0,
      bid: s.pe.bid ?? undefined,
      ask: s.pe.ask ?? undefined,
    } : undefined,
  })) || [];

  // Structure mapping
  const structure = ctx.marketStructure.value;
  const marketStructure = structure?.trend === "UP" ? "BULLISH" as const
    : structure?.trend === "DOWN" ? "BEARISH" as const
    : "NEUTRAL" as const;

  // FII/DII
  const fiiData = ctx.fiiDII.value;

  // News
  const newsData = ctx.news.value;

  return {
    symbol: ctx.symbol,
    strategy,
    direction: direction === "BULLISH" ? "BULLISH" : "BEARISH",
    spot,
    optionChain,
    pcr: chain?.pcrOI || 0,
    maxPain: chain?.maxPain || 0,
    vix,
    marketStructure,
    swingHigh: structure?.swingHigh,
    swingLow: structure?.swingLow,
    support: structure?.supportLevels,
    resistance: structure?.resistanceLevels,
    fiiNet: fiiData?.fiiNet,
    diiNet: fiiData?.diiNet,
    newsScore: newsData?.score,
    daysToExpiry: chain?.daysToExpiry,
    isMarketOpen: ctx.marketStatus === "OPEN" || ctx.marketStatus === "MARKET_OPEN",
  };
}

// ── Score using unified engine with HERMES profile ─────────────────

export function scoreWithUnifiedEngine(
  ctx: HermesContext,
  direction: Direction,
  side: OptionSide
): {
  decision: TradeDecision;
  scoringEngine: "unified";
  strategyProfile: "HERMES";
  weightsUsed: Record<string, number>;
} {
  const input = hermesContextToMarketInput(ctx, direction, side);
  const decision = scoreTrade(input);

  return {
    decision,
    scoringEngine: "unified",
    strategyProfile: "HERMES",
    weightsUsed: decision.weightsUsed as unknown as Record<string, number>,
  };
}
