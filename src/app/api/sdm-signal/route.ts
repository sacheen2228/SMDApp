// API Route — SDM V2 Recommendation Engine (canonical)
// Runs the V2 engine (sdm-recommendation.ts) that also powers the
// SDMBot terminal UI, so chat/Telegram and the UI never diverge.

import { NextRequest, NextResponse } from "next/server";
import { generateTradeRecommendation } from "@/lib/sdm-recommendation";
import { calculateGreeks } from "@/lib/greeks";
import { getSymbolConfig } from "@/lib/symbol-config";
import { sendTradeAlert } from "@/lib/telegram";
import { getOptionChain, getOptionChainExpiries } from "@/lib/icici-breeze/option-chain";
import { initSession } from "@/lib/icici-breeze/auth";
import { getNSEOptionChain } from "@/lib/nse-api";
import { isBSEIndex } from "@/lib/bse-api";
import type { SDMOptionStrike } from "@/types/sdm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const expiry = searchParams.get("expiry") || undefined;
    const isExpiryDay = searchParams.get("expiryDay") === "true";
    const dirRaw = searchParams.get("dir");
    const dir: 'CALL' | 'PUT' | null = dirRaw === 'CALL' || dirRaw === 'PUT' ? dirRaw : null;

    const config = getSymbolConfig(symbol);
    const today = new Date().toISOString().split("T")[0];

    // Initialize Breeze session once
    if (!globalThis.__breezeSessionInited) {
      globalThis.__breezeSessionInited = true;
      await initSession().catch(() => {});
    }

    // Fetch real option chain data: MOAPI → Breeze → NSE → BSE
    let chainData: any = null;
    let source = "simulation";

    // 1. Try MOAPI first (preferred primary provider)
    try {
      const { getMotilalOptionChain } = await import('@/lib/motilal-option-chain');
      const motilalChain = await Promise.race([
        getMotilalOptionChain(symbol, expiry),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('MOAPI_TIMEOUT')), 8000))
      ]);
      if (motilalChain?.data?.length) {
        chainData = {
          spotPrice: motilalChain.spotPrice,
          data: motilalChain.data.map((row: any) => ({
            strike: row.strike,
            ce: row.ce ? {
              ltp: row.ce.ltp || 0, oi: row.ce.oi || 0,
              oiChg: 0, volume: row.ce.volume || 0,
              iv: row.ce.iv || 0,
            } : null,
            pe: row.pe ? {
              ltp: row.pe.ltp || 0, oi: row.pe.oi || 0,
              oiChg: 0, volume: row.pe.volume || 0,
              iv: row.pe.iv || 0,
            } : null,
          })),
          expiries: motilalChain.expiries.map((e: string) => ({ date: e })),
          selectedExpiry: motilalChain.selectedExpiry,
        };
        source = "moapi";
      }
    } catch (e) {
      console.warn("[SDM Signal] MOAPI failed:", e);
    }

    // 2. Try Breeze if MOAPI failed
    if (!chainData) {
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

    // BSE indices (SENSEX, BANKEX) — use BSE public API for option chain
    if (!chainData && isBSEIndex(symbol)) {
      try {
        const { getBSEOptionChain, getBSEExpiryDates: getBSEExpiries } = await import('@/lib/bse-api');
        const bseExpiries = await getBSEExpiries(symbol);
        const selectedExpiry = expiry || bseExpiries[0] || "";
        if (selectedExpiry) {
          const bseChain = await getBSEOptionChain(symbol, selectedExpiry);
          if (bseChain?.data?.length) {
            chainData = {
              spotPrice: bseChain.spotPrice,
              data: bseChain.data.map((row) => ({
                strike: row.strike,
                ce: row.ce ? {
                  ltp: row.ce.ltp || 0, oi: row.ce.oi || 0,
                  oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0,
                  iv: row.ce.iv || 0, chg: row.ce.chg || 0,
                  bid: row.ce.bid || 0, ask: row.ce.ask || 0,
                } : null,
                pe: row.pe ? {
                  ltp: row.pe.ltp || 0, oi: row.pe.oi || 0,
                  oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0,
                  iv: row.pe.iv || 0, chg: row.pe.chg || 0,
                  bid: row.pe.bid || 0, ask: row.pe.ask || 0,
                } : null,
              })),
              expiries: bseExpiries.map((e: string) => ({ date: e })),
              selectedExpiry,
            };
            source = "bse-api";
          }
        }
      } catch (bseErr) {
        console.warn("[SDM Signal] BSE API failed:", bseErr);
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

    // Generate candles — try Breeze historical, fall back to Yahoo
    let candles5m: any[] = [];
    let candles15m: any[] = [];
    try {
      const { getHistoricalCandles } = await import("@/lib/historical-data");
      const candle5mResult = await getHistoricalCandles(symbol, "5m", 50);
      candles5m = candle5mResult.candles || [];
    } catch {}
    try {
      const { getHistoricalCandles } = await import("@/lib/historical-data");
      const candle15mResult = await getHistoricalCandles(symbol, "15m", 50);
      candles15m = candle15mResult.candles || [];
    } catch {}

    // Previous day OHLC — use real Breeze data or derive from chain
    const prevDay = {
      high: spotPrice * 1.003,
      low: spotPrice * 0.997,
      close: spotPrice,
    };

    // Run SDM V2 engine — same function SDMBot.tsx calls client-side,
    // so chat/Telegram and the terminal UI always agree.
    // VIX: fetch live from NSE, fallback to 15 if unavailable
    let vix = 15;
    try {
      const nseVix = await fetch('https://www.nseindia.com/api/allIndices', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).then(d => {
        const vixIdx = d?.data?.find((i: any) => i.index === 'INDIA VIX');
        return vixIdx?.last ? parseFloat(vixIdx.last) : null;
      }).catch(() => null);
      if (nseVix && nseVix > 0) vix = nseVix;
    } catch {}
    const signal = await generateTradeRecommendation(
      chain,
      spotPrice,
      symbol,
      selectedExpiry,
      { "5m": candles5m },
      vix,
      source,
      new Date().toISOString(),
      dir || undefined
    );

    // Attach Greeks for the selected strike to the signal
    const selectedStrike = signal.strike || spotPrice;
    const strikeRow = chain.find((s: any) => s.strike === selectedStrike);
    const isCall = signal.direction === "CALL";
    const optionLeg = isCall ? strikeRow?.ce : strikeRow?.pe;
    if (optionLeg) {
      (signal as any).greeks = {
        delta: optionLeg.delta || 0,
        gamma: optionLeg.gamma || 0,
        theta: optionLeg.theta || 0,
        vega: optionLeg.vega || 0,
        iv: optionLeg.iv || 0,
      };
    }

    // ─── MTF Indicator Confirmation Layer (before Telegram) ──────────
    let mtf = null;
    try {
      const { computeMTFIndicators } = await import("@/lib/mtf-indicator-engine");
      const { generateMTFSignal } = await import("@/lib/mtf-signal-engine");
      const { DEFAULT_INDICATOR_PARAMS } = await import("@/lib/mtf-config");

      const candlesByTF: Record<string, any[]> = {};
      if (candles15m.length > 0) candlesByTF["15m"] = candles15m;
      if (candles5m.length > 0) candlesByTF["5m"] = candles5m;
      if (candles5m.length > 0) candlesByTF["3m"] = candles5m;

      if (Object.keys(candlesByTF).length > 0) {
        const indicators = computeMTFIndicators(candlesByTF, DEFAULT_INDICATOR_PARAMS, 20);
        const mtfSignal = generateMTFSignal(indicators.timeframes);
        mtf = {
          action: mtfSignal.action,
          compositeScore: mtfSignal.compositeScore,
          confidence: mtfSignal.confidence,
          direction: mtfSignal.direction,
          entry: mtfSignal.entry,
          trend: mtfSignal.trend,
          dataQuality: mtfSignal.dataQuality,
          reasons: mtfSignal.reasons,
          factors: mtfSignal.factors,
          indicators: indicators.timeframes,
          dataAvailability: indicators.dataAvailability,
        };
      }
    } catch (mtfErr) {
      console.warn("[SDM Signal] MTF engine failed:", mtfErr);
    }

    // Send Telegram alert when data is real (not simulation) and confidence is high
    const rec = signal.recommendation || signal;
    const alertAction = rec.action || signal.action;
    const isTradeAction = alertAction && !["HOLD", "NEUTRAL", "WAIT", "NO_TRADE"].includes(alertAction);
    const conf = typeof signal.confidence === "object" ? signal.confidence?.total ?? 0 : signal.confidence ?? 0;
    const hasConfidence = conf >= 60;
    if (isTradeAction && hasConfidence && source !== "simulation") {
      const strike = rec.strike || signal.strike || spotPrice;
      const optionType = rec.strikeType || rec.optionType || "OPTION";
      sendTradeAlert({
        symbol,
        action: alertAction,
        strike,
        type: optionType,
        confidence: conf,
        entry: rec.entry || signal.entry,
        stopLoss: rec.stopLoss || signal.stopLoss,
        target1: rec.target1 || signal.target1,
        target2: rec.target2 || signal.target2,
        source: `SDM Engine (${source})`,
        mtf: mtf ? {
          direction: mtf.direction,
          compositeScore: mtf.compositeScore,
          confidence: mtf.confidence,
          trendDirection: mtf.trend.trendDirection,
          reasons: mtf.reasons,
        } : null,
      }).catch(() => {});
    }

    return NextResponse.json({
      success: true,
      signal,
      mtf,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[API] SDM V2 engine error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "SDM V2 engine failed" },
      { status: 500 }
    );
  }
}
