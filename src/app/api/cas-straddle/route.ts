// app/api/cas-straddle/route.ts
//
// CAS Straddle / Strangle API endpoint.
// GET: live signal | POST: run backtest

import { NextRequest, NextResponse } from "next/server";
import { generateStrategySignal, type MarketSnapshot, type StrategyConfig } from "@/lib/cas-straddle-strategy";
import { runBacktest } from "@/lib/cas-straddle-backtest";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";

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
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0 } : null,
      }));

      let atm = chain[0];
      let best = Infinity;
      for (const s of chain) { const dd = Math.abs(s.strike - spot); if (dd < best) { best = dd; atm = s; } }

      const snap: MarketSnapshot = {
        timestamp: new Date().toISOString(),
        spot, symbol,
        casReferencePrice: spot,
        casDislocationPct: 0,
        casDislocationStrength: "NONE",
        casVelocity: 0,
        casAboveReference: true,
        atmStrike: atm.strike || atmStrike,
        atmCE: atm.ce?.ltp || 0,
        atmPE: atm.pe?.ltp || 0,
        combinedPremium: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
        expectedMove: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
        pcr, maxPain: d.summary.maxPain || 0, iv, chain,
        regime: "RANGING", vix: iv,
      };

      const config: StrategyConfig = {
        strategy: strategy as any, strikeSelection: strikeSelection as any, expiryType,
        initialCapital: 100000, maxRiskPct: 2, entryTime: "09:20", exitTime: "15:20",
        targetPct: 20, stopLossPct: 50, chargesMode: "realistic", slippageMode: "realistic",
      };

      const signal = generateStrategySignal(snap, config);
      return NextResponse.json({
        success: true, symbol, signal,
        snapshot: { spot, atmStrike: atm.strike || atmStrike, cePremium: atm.ce?.ltp || 0, pePremium: atm.pe?.ltp || 0, combinedPremium: snap.combinedPremium, pcr, iv, maxPain: d.summary.maxPain || 0 },
        source: chainResult.source || "unknown",
      });
    }

    // Fallback: trade intelligence engine
    const ctx = await buildMarketIntelligenceContext();
    const signals = await analyzeIndexFO(ctx);
    const matched = signals.find(s => s.symbol === symbol) || signals[0];

    if (matched && matched.direction !== "NO_TRADE") {
      const spot = matched.entry || ctx.nifty?.spot || 0;
      const strategyType = matched.direction === "CALL" || matched.direction === "LONG" ? "CALL"
        : matched.direction === "PUT" || matched.direction === "SHORT" ? "PUT"
        : matched.direction.includes("STRADDLE") ? "STRADDLE"
        : matched.direction.includes("STRANGLE") ? "STRANGLE" : "NO_TRADE";

      const snap: MarketSnapshot = {
        timestamp: new Date().toISOString(), spot, symbol,
        casReferencePrice: spot, casDislocationPct: 0, casDislocationStrength: "NONE",
        casVelocity: 0, casAboveReference: true,
        atmStrike: matched.strike || spot, atmCE: 0, atmPE: 0,
        combinedPremium: 0, expectedMove: matched.target1 ? matched.target1 - spot : 0,
        pcr: ctx.nifty?.pcr || 1, maxPain: ctx.nifty?.maxPain || 0, iv: 15, chain: [],
        regime: ctx.regime?.trend === "BULLISH" ? "TRENDING_UP" : ctx.regime?.trend === "BEARISH" ? "TRENDING_DOWN" : "RANGING",
        vix: 15,
      };

      const config: StrategyConfig = {
        strategy: strategyType as any, strikeSelection: strikeSelection as any, expiryType,
        initialCapital: 100000, maxRiskPct: 2, entryTime: "09:20", exitTime: "15:20",
        targetPct: 20, stopLossPct: 50, chargesMode: "realistic", slippageMode: "realistic",
      };

      const signal = generateStrategySignal(snap, config);
      return NextResponse.json({
        success: true, symbol, signal,
        snapshot: { spot, atmStrike: matched.strike || spot, cePremium: 0, pePremium: 0, combinedPremium: 0, pcr: ctx.nifty?.pcr || 1, iv: 15, maxPain: ctx.nifty?.maxPain || 0 },
        source: "trade-intelligence-fallback",
        fallbackNote: "Live option chain unavailable — using trade intelligence engine",
      });
    }

    // No data at all
    return NextResponse.json({
      success: true, symbol,
      signal: {
        strategy: "NO_TRADE", confidence: 0,
        reasoning: ["No live option chain data", "No high-conviction trade from intelligence engine", `Market regime: ${ctx.regime?.regime || "unknown"}`],
        ceStrike: 0, peStrike: 0, cePremium: 0, pePremium: 0, combinedPremium: 0,
        maxRisk: 0, maxReward: 0, breakevenUpper: 0, breakevenLower: 0, riskReward: 0,
        casScore: 0, expectedMove: 0, expectedMovePct: 0,
        entryTime: "09:20", exitTime: "15:20", targetPct: 20, stopLossPct: 50,
      },
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
      maxRiskPct = 2,
      entryTime = "09:20",
      exitTime = "15:20",
      targetPct = 20,
      stopLossPct = 50,
      chargesMode = "realistic",
      slippageMode = "realistic",
    } = body;

    const config: StrategyConfig = {
      strategy,
      strikeSelection,
      expiryType,
      initialCapital,
      maxRiskPct,
      entryTime,
      exitTime,
      targetPct,
      stopLossPct,
      chargesMode,
      slippageMode,
    };

    const result = await runBacktest(config, symbol.toUpperCase());
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Backtest failed" }, { status: 500 });
  }
}
