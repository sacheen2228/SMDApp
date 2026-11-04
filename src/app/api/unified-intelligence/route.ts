// Unified Intelligence API — Phase F
//
// Runs the full 5-module pipeline through the central decision coordinator
// and returns a CoordinatorResult for the dashboard.
//
// Reuses existing providers:
//   • NSE historical candles (daily) — for indicators, SMC, mechanism
//   • fetchLiveOptionChain — for derivatives (option chain, futures OI)
//   • getNSEIndiaVIX — for India VIX
//   • fetchFiiDiiData — for FII/DII
//
// No new calculations — composes Phases A–E. Missing data → null, never fabricated.
// BUY CE / BUY PE only. Never option selling.

import { NextRequest, NextResponse } from "next/server";
import {
  computeIndicatorBundle,
  indicatorsSufficientForTrade,
} from "@/lib/unified-engine/indicators";
import { readSMC } from "@/lib/unified-engine/smc";
import { detectMarketMechanism } from "@/lib/unified-engine/mechanism";
import { buildDerivativesContext } from "@/lib/unified-engine/derivatives";
import { buildMarketContextAsync } from "@/lib/unified-engine/market-context";
import { coordinateDecision } from "@/lib/unified-engine/coordinator";
import { computeSectorBreadth } from "@/lib/universe/sector-breadth";
import { buildCashUniverse } from "@/lib/universe/cash-universe";
import { getNSEHistoricalData } from "@/lib/nse-api";
import type { Candle } from "@/types/engine";

// Map NSE historical bar shape to Candle
function mapNseBar(b: any): Candle | null {
  const t = Date.parse(String(b.mtimestamp || b.timestamp || ""));
  const o = Number(b.chOpeningPrice ?? b.open);
  const h = Number(b.chTradeHighPrice ?? b.high);
  const l = Number(b.chTradeLowPrice ?? b.low);
  const c = Number(b.chClosingPrice ?? b.close);
  const v = Number(b.chTotTradedQty ?? b.volume ?? 0);
  if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c)) return null;
  return { time: t, open: o, high: Number.isFinite(h) ? h : c, low: Number.isFinite(l) ? l : c, close: c, volume: Number.isFinite(v) ? v : 0 };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();
    const exchange = (searchParams.get("exchange") || "NSE") as "NSE" | "BSE";
    const capital = Number(searchParams.get("capital")) || 100_000;

    // ── Fetch historical candles (last 100 days) ──
    const to = new Date();
    const from = new Date(to.getTime() - 120 * 86_400_000);
    const bars = await getNSEHistoricalData(symbol, from, to);
    if (!Array.isArray(bars) || bars.length < 30) {
      return NextResponse.json(
        { success: false, error: `Insufficient historical data for ${symbol}` },
        { status: 503 },
      );
    }

    const candles = bars.map(mapNseBar).filter((b): b is Candle => b != null);
    candles.sort((a, b) => a.time - b.time); // oldest → newest

    // Split: last candle = "today" (DTR session), rest = historical
    const todayCandles = candles.slice(-1); // single daily candle as today's session
    const historicalCandles = candles.slice(0, -1);

    const lastCandleTs = candles[candles.length - 1].time;

    // ── Phase B: Indicator bundle ──
    const indicatorBundle = computeIndicatorBundle(
      symbol,
      todayCandles,
      historicalCandles,
      undefined, // currentPrice — no live override
      lastCandleTs,
    );

    // ── Phase C: SMC read ──
    const smcRead = readSMC(symbol, historicalCandles, indicatorBundle);

    // ── Phase C: Mechanism detection ──
    const mechanismRead = detectMarketMechanism(symbol, indicatorBundle, smcRead, {
      indiaVix: null,
      sectorBreadth: undefined,
      lastCandleTs,
    });

    // ── Phase D: Derivatives context ──
    const derivatives = await buildDerivativesContext(symbol, undefined, capital);

    // ── Phase D: Market context (async, fetches VIX + FII/DII) ──
    // Build sector breadth from the verified universe
    const universe = await buildCashUniverse({ verifyExchanges: false });
    const sectorBreadth = computeSectorBreadth(universe.entries);

    const marketContext = await buildMarketContextAsync(
      symbol,
      indicatorBundle,
      smcRead,
      mechanismRead,
      { advancing: sectorBreadth.advances, declining: sectorBreadth.declines, unchanged: sectorBreadth.unchanged },
    );

    // ── Phase E: Coordinator decision ──
    const result = coordinateDecision(
      symbol,
      exchange,
      indicatorBundle,
      smcRead,
      mechanismRead,
      derivatives,
      marketContext,
      sectorBreadth,
      capital,
    );

    return NextResponse.json({
      success: true,
      symbol,
      exchange,
      timestamp: result.timestamp,
      decision: result.decision,
      confidence: result.confidence,
      evidenceStrength: result.evidenceStrength,
      moduleEvidence: result.moduleEvidence,
      conflicts: result.conflicts,
      supportingEvidence: result.supportingEvidence,
      conflictingEvidence: result.conflictingEvidence,
      missingInputs: result.missingInputs,
      tradePlan: result.tradePlan,
      mechanism: result.mechanism,
      marketContext: result.marketContext,
      derivatives: result.derivatives,
      dataQuality: {
        indicatorsSufficient: indicatorsSufficientForTrade(indicatorBundle),
        smcSufficient: smcRead.sufficientData,
        derivativesAvailable: derivatives.optionChain.available && derivatives.futuresOI.available,
        contextQuality: marketContext.contextQuality,
      },
    });
  } catch (error: any) {
    console.error("[Unified Intelligence API] Error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Unified intelligence failed" },
      { status: 500 },
    );
  }
}
