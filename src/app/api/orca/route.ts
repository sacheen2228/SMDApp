// API Route — ORCA Live Signal Engine
// Runs all 15 modules of the institutional trading AI

import { NextRequest, NextResponse } from "next/server";
import { runOrcaEngine, type OrcaSignal } from "@/lib/orca-engine";
import { generateOptionChain } from "@/lib/option-chain-data";
import { generateDayCandles } from "@/lib/historical-data";
import { calculateGreeks } from "@/lib/greeks";
import { getSymbolConfig } from "@/lib/symbol-config";
import { sendTradeAlert } from "@/lib/telegram";
import type { SDMOptionStrike } from "@/types/sdm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const expiry = searchParams.get("expiry") || undefined;
    const isExpiryDay = searchParams.get("expiryDay") === "true";

    const config = getSymbolConfig(symbol);
    const today = new Date().toISOString().split("T")[0];

    // Fetch option chain data
    let chainData = generateOptionChain(symbol, expiry);
    const spotPrice = chainData.spotPrice || 0;

    // Convert to SDMOptionStrike format
    const chain: SDMOptionStrike[] = (chainData.data || []).map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? {
        ltp: row.ce.ltp || 0,
        oi: row.ce.oi || 0,
        oiChg: row.ce.oiChg || 0,
        volume: row.ce.volume || 0,
        iv: row.ce.iv || 0,
        delta: row.ce.delta || 0,
        gamma: row.ce.gamma || 0,
        theta: row.ce.theta || 0,
        vega: row.ce.vega || 0,
        bid: row.ce.bid || 0,
        ask: row.ce.ask || 0,
      } : null,
      pe: row.pe ? {
        ltp: row.pe.ltp || 0,
        oi: row.pe.oi || 0,
        oiChg: row.pe.oiChg || 0,
        volume: row.pe.volume || 0,
        iv: row.pe.iv || 0,
        delta: row.pe.delta || 0,
        gamma: row.pe.gamma || 0,
        theta: row.pe.theta || 0,
        vega: row.pe.vega || 0,
        bid: row.pe.bid || 0,
        ask: row.pe.ask || 0,
      } : null,
    }));

    // Calculate Greeks if missing
    const selectedExpiry = expiry || chainData.selectedExpiry || chainData.expiries?.[0]?.date || "";
    const expiryDate = new Date(selectedExpiry);
    const now = new Date();
    const daysToExpiry = Math.max(1, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const tte = daysToExpiry / 365;

    for (const strike of chain) {
      const moneyness = Math.abs(strike.strike - spotPrice) / spotPrice;
      const baseIV = 0.15 + moneyness * 2 + (daysToExpiry < 7 ? 0.05 : 0);
      if (strike.ce) {
        const iv = strike.ce.iv > 0 ? strike.ce.iv / 100 : baseIV;
        const g = calculateGreeks(spotPrice, strike.strike, tte, iv, true);
        strike.ce.delta = g.delta;
        strike.ce.gamma = g.gamma;
        strike.ce.theta = g.theta;
        strike.ce.vega = g.vega;
        if (strike.ce.iv === 0) strike.ce.iv = Math.round(iv * 10000) / 100;
      }
      if (strike.pe) {
        const iv = strike.pe.iv > 0 ? strike.pe.iv / 100 : baseIV;
        const g = calculateGreeks(spotPrice, strike.strike, tte, iv, false);
        strike.pe.delta = g.delta;
        strike.pe.gamma = g.gamma;
        strike.pe.theta = g.theta;
        strike.pe.vega = g.vega;
        if (strike.pe.iv === 0) strike.pe.iv = Math.round(iv * 10000) / 100;
      }
    }

    // Generate candles for market structure
    const candles = generateDayCandles(symbol, today);

    // Previous day OHLC
    const prevDayCandles = generateDayCandles(symbol, (() => {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })());
    const prevDay = {
      high: Math.max(...prevDayCandles.map(c => c.high)),
      low: Math.min(...prevDayCandles.map(c => c.low)),
      close: prevDayCandles[prevDayCandles.length - 1]?.close || spotPrice,
    };

    // Check if today is expiry day
    const todayDate = new Date(today);
    const isExpiry = isExpiryDay || expiryDate.toDateString() === todayDate.toDateString();

    // Run ORCA engine
    const signal = runOrcaEngine({
      spot: spotPrice,
      chain,
      candles,
      symbol,
      expiry: selectedExpiry,
      isExpiryDay: isExpiry,
      prevDay,
    });

    // Send Telegram alert for strong signals (confidence >= 60)
    if (signal.confidence >= 60) {
      sendTradeAlert({
        symbol,
        action: signal.action,
        strike: signal.strike || spotPrice,
        type: signal.optionType,
        confidence: signal.confidence,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        target1: signal.target1,
        target2: signal.target2,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      signal,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[API] ORCA error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "ORCA engine failed" },
      { status: 500 }
    );
  }
}
