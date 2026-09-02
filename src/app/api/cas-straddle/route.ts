// app/api/cas-straddle/route.ts
//
// CAS Straddle / Strangle API endpoint.
// GET: live signal | POST: run backtest

import { NextRequest, NextResponse } from "next/server";
import { generateStrategySignal, type MarketSnapshot, type StrategyConfig } from "@/lib/cas-straddle-strategy";
import { runBacktest } from "@/lib/cas-straddle-backtest";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";

// ─── GET: Live Signal ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  const strategy = req.nextUrl.searchParams.get("strategy") || "AUTO";
  const strikeSelection = req.nextUrl.searchParams.get("strike") || "AUTO";
  const expiryType = (req.nextUrl.searchParams.get("expiry") || "weekly") as "weekly" | "monthly";

  try {
    const chainResult = await fetchLiveOptionChain(symbol, undefined, req.signal);

    if (!chainResult.success || !chainResult.data || chainResult.data.data.length === 0) {
      return NextResponse.json({
        success: false,
        error: "Option chain data unavailable",
        source: chainResult.source || "none",
      }, { status: 502 });
    }

    const d = chainResult.data;
    const spot = d.summary.spotPrice;
    const atmStrike = d.summary.atmStrike;
    const pcr = d.summary.pcr;
    const iv = d.summary.indiaVIX ?? 15;

    // Build chain
    const chain = d.data.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0 } : null,
      pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0 } : null,
    }));

    // Find ATM
    let atm = chain[0];
    let best = Infinity;
    for (const s of chain) { const dd = Math.abs(s.strike - spot); if (dd < best) { best = dd; atm = s; } }

    const casRef = spot; // live: use current spot as CAS reference proxy

    const snap: MarketSnapshot = {
      timestamp: new Date().toISOString(),
      spot,
      symbol,
      casReferencePrice: casRef,
      casDislocationPct: 0, // live: calculated from indicative price
      casDislocationStrength: "NONE",
      casVelocity: 0,
      casAboveReference: true,
      atmStrike: atm.strike || atmStrike,
      atmCE: atm.ce?.ltp || 0,
      atmPE: atm.pe?.ltp || 0,
      combinedPremium: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
      expectedMove: (atm.ce?.ltp || 0) + (atm.pe?.ltp || 0),
      pcr,
      maxPain: d.summary.maxPain || 0,
      iv,
      chain,
      regime: "RANGING", // live: would come from regime engine
      vix: iv,
    };

    const config: StrategyConfig = {
      strategy: strategy as any,
      strikeSelection: strikeSelection as any,
      expiryType,
      initialCapital: 100000,
      maxRiskPct: 2,
      entryTime: "09:20",
      exitTime: "15:20",
      targetPct: 20,
      stopLossPct: 50,
      chargesMode: "realistic",
      slippageMode: "realistic",
    };

    const signal = generateStrategySignal(snap, config);

    return NextResponse.json({
      success: true,
      symbol,
      signal,
      snapshot: {
        spot,
        atmStrike: atm.strike || atmStrike,
        cePremium: atm.ce?.ltp || 0,
        pePremium: atm.pe?.ltp || 0,
        combinedPremium: snap.combinedPremium,
        pcr,
        iv,
        maxPain: d.summary.maxPain || 0,
      },
      source: chainResult.source || "unknown",
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
