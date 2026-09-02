// app/api/cas-straddle/route.ts
//
// CAS Straddle / Strangle API endpoint V2.
// GET: live signal | POST: run backtest

import { NextRequest, NextResponse } from "next/server";
import { generateStrategySignalV2, type MarketSnapshot, type StrategyConfig, DEFAULT_CONFIG } from "@/lib/cas-straddle-strategy-v2";
import { runBacktestV2 } from "@/lib/cas-straddle-backtest-v2";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";
import { detectEntryWindow, getPhaseLabel, TIME_WINDOWS } from "@/lib/cas-time-engine";

// ─── GET: Live Signal ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  const strategy = req.nextUrl.searchParams.get("strategy") || "AUTO";
  const strikeSelection = req.nextUrl.searchParams.get("strike") || "AUTO";
  const expiryType = (req.nextUrl.searchParams.get("expiry") || "weekly") as "weekly" | "monthly";

  try {
    const chainResult = await fetchLiveOptionChain(symbol, undefined, req.signal);

    // Live option chain available
    if (chainResult.success && chainResult.data && chainResult.data.data.length > 0) {
      const d = chainResult.data;
      const spot = d.summary.spotPrice;
      const atmStrike = d.summary.atmStrike;
      const pcr = d.summary.pcr;
      const iv = d.summary.indiaVIX ?? 15;

      const chain = d.data.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, spread: row.ce.spread || 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, spread: row.pe.spread || 0 } : null,
      }));

      let atm = chain[0];
      let best = Infinity;
      for (const s of chain) { const dd = Math.abs(s.strike - spot); if (dd < best) { best = dd; atm = s; } }

      const snap: MarketSnapshot = {
        timestamp: new Date().toISOString(), spot, symbol,
        casReferencePrice: spot, casDislocationPct: 0, casDislocationStrength: "NONE",
        casVelocity: 0, casAboveReference: true, casBuyQty: 0, casSellQty: 0, casImbalance: 0.5,
        atmStrike: atm.strike || atmStrike, atmCE: atm.ce?.ltp || 0, atmPE: atm.pe?.ltp || 0,
        combinedPremium: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
        expectedMove: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
        pcr, maxPain: d.summary.maxPain || 0, iv, chain,
        regime: "NORMAL_VOL", vix: iv, realizedVol: iv,
        futuresPrice: spot, futuresBasis: 0,
        currentVolume: 0, avgVolume: 0, volumeRatio: 1,
        atr: 0, atrPct: 0,
        candles: [], prevClose: spot, prevPCR: pcr, prevIV: iv,
      };

      const config: StrategyConfig = { ...DEFAULT_CONFIG, strategy: strategy as any, strikeSelection: strikeSelection as any, expiryType };
      const signal = generateStrategySignalV2(snap, config);

      // Time engine status
      const now = new Date();
      const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
      const ist = new Date(istMs);
      const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      const currentWindow = detectEntryWindow(istMinutes);

      return NextResponse.json({
        success: true, symbol, signal,
        snapshot: { spot, atmStrike: atm.strike || atmStrike, cePremium: atm.ce?.ltp || 0, pePremium: atm.pe?.ltp || 0, combinedPremium: snap.combinedPremium, pcr, iv, maxPain: d.summary.maxPain || 0 },
        source: chainResult.source || "unknown",
        timeEngine: {
          currentWindow: currentWindow.window,
          currentPhase: getPhaseLabel(currentWindow.window),
          entryAllowed: currentWindow.entryAllowed,
          minTradeQuality: currentWindow.minTradeQuality,
          minEMCoverage: currentWindow.minEMCoverage,
          description: currentWindow.description,
          istTime: `${ist.getUTCHours().toString().padStart(2, "0")}:${ist.getUTCMinutes().toString().padStart(2, "0")}:${ist.getUTCSeconds().toString().padStart(2, "0")}`,
          windows: TIME_WINDOWS.map(w => ({
            window: w.window,
            startMin: w.startMin,
            endMin: w.endMin,
            entryAllowed: w.entryAllowed,
            label: getPhaseLabel(w.window),
          })),
        },
      });
    }

    // Fallback: trade intelligence
    const ctx = await buildMarketIntelligenceContext();
    const signals = await analyzeIndexFO(ctx);
    const matched = signals.find(s => s.symbol === symbol) || signals[0];

    if (matched && matched.direction !== "NO_TRADE") {
      const spot = matched.entry || ctx.nifty?.spot || 0;
      const strategyType = matched.direction === "CALL" || matched.direction === "LONG" ? "CALL"
        : matched.direction === "PUT" || matched.direction === "SHORT" ? "PUT" : "NO_TRADE";

      const snap: MarketSnapshot = {
        timestamp: new Date().toISOString(), spot, symbol,
        casReferencePrice: spot, casDislocationPct: 0, casDislocationStrength: "NONE",
        casVelocity: 0, casAboveReference: true, casBuyQty: 0, casSellQty: 0, casImbalance: 0.5,
        atmStrike: matched.strike || spot, atmCE: 0, atmPE: 0,
        combinedPremium: 0, expectedMove: matched.target1 ? matched.target1 - spot : 0,
        pcr: ctx.nifty?.pcr || 1, maxPain: ctx.nifty?.maxPain || 0, iv: 15, chain: [],
        regime: "NORMAL_VOL", vix: 15, realizedVol: 15,
        futuresPrice: spot, futuresBasis: 0,
        currentVolume: 0, avgVolume: 0, volumeRatio: 1,
        atr: 0, atrPct: 0,
        candles: [], prevClose: spot, prevPCR: 1, prevIV: 15,
      };

      const config: StrategyConfig = { ...DEFAULT_CONFIG, strategy: strategyType as any, strikeSelection: strikeSelection as any, expiryType };
      const signal = generateStrategySignalV2(snap, config);
      return NextResponse.json({
        success: true, symbol, signal,
        snapshot: { spot, atmStrike: matched.strike || spot, cePremium: 0, pePremium: 0, combinedPremium: 0, pcr: ctx.nifty?.pcr || 1, iv: 15, maxPain: ctx.nifty?.maxPain || 0 },
        source: "trade-intelligence-fallback",
        fallbackNote: "Live option chain unavailable",
      });
    }

    // No data
    return NextResponse.json({
      success: true, symbol,
      signal: { ...DEFAULT_CONFIG, strategy: "NO_TRADE" as const, confidence: 0, tradeQuality: 0, reasoning: ["No data available"], rejectionReasons: [], ceStrike: 0, peStrike: 0, cePremium: 0, pePremium: 0, combinedPremium: 0, maxRisk: 0, maxReward: 0, breakevenUpper: 0, breakevenLower: 0, riskReward: 0, expectedMove: 0, expectedMovePct: 0, expectedUpper: 0, expectedLower: 0, expectedMoveConfidence: 0, casScore: 0, casConfirmationPhase: "NONE" as const, premiumCostRatio: 0, requiredMove: 0, moveCoveragePassed: false, regime: "NORMAL_VOL" as const, regimeConfidence: 0, entryTime: "09:20", exitTime: "15:20", targetPct: 30, stopLossPct: 40, maxHoldingTime: "5 bars", payoffProfile: [], profitZonePct: 0, passesAllGates: false, gateResults: {} },
      snapshot: { spot: 0, atmStrike: 0, cePremium: 0, pePremium: 0, combinedPremium: 0, pcr: 0, iv: 0, maxPain: 0 },
      source: "no-data",
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Failed" }, { status: 500 });
  }
}

// ─── POST: Run Backtest ───────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbol = "NIFTY",
      strategy = "AUTO",
      strikeSelection = "AUTO",
      expiryType = "weekly",
      initialCapital = 100000,
      maxRiskPct = 1.5,
      entryTime = "09:20",
      exitTime = "15:20",
      targetPct = 20,
      stopLossPct = 100,
      chargesMode = "realistic",
      slippageMode = "realistic",
      minTradeQuality = 40,
      minExpectedMovePct = 0.3,
      maxPremiumCostRatio = 1.2,
      maxHoldingBars = 5,
    } = body;

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      strategy, strikeSelection, expiryType,
      initialCapital, maxRiskPct, entryTime, exitTime,
      targetPct, stopLossPct, chargesMode, slippageMode,
      minTradeQuality, minExpectedMovePct, maxPremiumCostRatio, maxHoldingBars,
    };

    const result = await runBacktestV2(config, symbol.toUpperCase());

    // Add time engine live status
    const now = new Date();
    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const { detectEntryWindow, getPhaseLabel } = await import("@/lib/cas-time-engine");
    const currentWindow = detectEntryWindow(istMinutes);

    return NextResponse.json({
      ...result,
      timeEngine: {
        currentWindow: currentWindow.window,
        currentPhase: getPhaseLabel(currentWindow.window),
        entryAllowed: currentWindow.entryAllowed,
        istTime: `${ist.getUTCHours().toString().padStart(2, "0")}:${ist.getUTCMinutes().toString().padStart(2, "0")}:${ist.getUTCSeconds().toString().padStart(2, "0")}`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Backtest failed" }, { status: 500 });
  }
}
