// API Route — ORCA Live Signal Engine
// Runs all 15 modules of the institutional trading AI

import { NextRequest, NextResponse } from "next/server";
import { runSdmSignalEngine, type SdmSignal } from "@/lib/sdm-signal-engine";
import { calculateGreeks } from "@/lib/greeks";
import { getSymbolConfig } from "@/lib/symbol-config";
import { sendTradeAlert } from "@/lib/telegram";
import { getOptionChain, getOptionChainExpiries } from "@/lib/icici-breeze/option-chain";
import { initSession } from "@/lib/icici-breeze/auth";
import { getNSEOptionChain } from "@/lib/nse-api";
import type { SDMOptionStrike } from "@/types/sdm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const expiry = searchParams.get("expiry") || undefined;
    const isExpiryDay = searchParams.get("expiryDay") === "true";

    const config = getSymbolConfig(symbol);
    const today = new Date().toISOString().split("T")[0];

    // Initialize Breeze session once
    if (!globalThis.__breezeSessionInited) {
      globalThis.__breezeSessionInited = true;
      await initSession().catch(() => {});
    }

    // Fetch real option chain data: Breeze → NSE → Simulation fallback
    let chainData: any = null;
    let source = "simulation";

    // Try Breeze first
    try {
      const expiries = expiry ? [expiry] : await getOptionChainExpiries(symbol);
      for (const exp of expiries.slice(0, 3)) {
        const chain = await getOptionChain(symbol, exp);
        if (chain) {
          chainData = {
            spotPrice: chain.spotPrice,
            data: chain.strikes.map((strike) => ({
              strike,
              ce: chain.calls.find((c) => c.strikePrice === strike) || null,
              pe: chain.puts.find((p) => p.strikePrice === strike) || null,
            })),
            expiries: expiries.map((e) => ({ date: e })),
            selectedExpiry: exp,
          };
          source = "icici-breeze";
          break;
        }
      }
    } catch (e) {
      console.warn("[SDM Signal] Breeze failed:", e);
    }

    // Try NSE if Breeze failed
    if (!chainData) {
      try {
        const nseData = await getNSEOptionChain(symbol);
        if (nseData?.records?.data) {
          chainData = {
            spotPrice: nseData.records?.underlyingValue || 0,
            data: nseData.records.data.map((row: any) => ({
              strike: row.strikePrice,
              ce: row.CE ? {
                ltp: row.CE.lastPrice || 0, oi: row.CE.openInterest || 0,
                oiChg: row.CE.changeinOpenInterest || 0, volume: row.CE.totalTradedVolume || 0,
                iv: row.CE.impliedVolatility || 0,
              } : null,
              pe: row.PE ? {
                ltp: row.PE.lastPrice || 0, oi: row.PE.openInterest || 0,
                oiChg: row.PE.changeinOpenInterest || 0, volume: row.PE.totalTradedVolume || 0,
                iv: row.PE.impliedVolatility || 0,
              } : null,
            })),
            expiries: (nseData.records?.expiryDates || []).map((d: string) => ({ date: d })),
            selectedExpiry: nseData.records?.expiryDates?.[0] || "",
          };
          source = "nse-api";
        }
      } catch (e) {
        console.warn("[SDM Signal] NSE failed:", e);
      }
    }

    // If no real data available, return error
    if (!chainData) {
      return NextResponse.json({
        success: false,
        error: "No real option chain data available. Breeze and NSE both failed.",
      }, { status: 503 });
    }

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

    // Generate candles — try Breeze historical, fall back to simulation
    let candles: any[] = [];
    try {
      const { getIntradayCandles } = await import("@/lib/breeze-historical");
      const expDate = selectedExpiry || chainData.selectedExpiry || "";
      candles = await getIntradayCandles(symbol, "5minute", expDate);
    } catch {
      // simulation fallback removed — candles will be empty
    }

    // Previous day OHLC — use real Breeze data or derive from chain
    const prevDay = {
      high: spotPrice * 1.003,
      low: spotPrice * 0.997,
      close: spotPrice,
    };

    // Check if today is expiry day
    const todayDate = new Date(today);
    const isExpiry = isExpiryDay || expiryDate.toDateString() === todayDate.toDateString();

    // Run ORCA engine
    const signal = runSdmSignalEngine({
      spot: spotPrice,
      chain,
      candles,
      symbol,
      expiry: selectedExpiry,
      isExpiryDay: isExpiry,
      prevDay,
    });

    // Note: Alerts from this route suppressed — sdm-signal always uses simulation data.
    // Real-data alerts fire from option-chain route instead.
    const signalConf = typeof signal.confidence === "object" ? signal.confidence?.total ?? 0 : signal.confidence;

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
