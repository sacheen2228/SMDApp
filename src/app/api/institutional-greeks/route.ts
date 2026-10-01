/**
 * API Route — Institutional Greeks Engine (Acceleration-powered)
 * Uses the shared option chain fetcher (no HTTP self-fetch).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  runAccelerationEngine,
  type StrikeInput,
  type MarketContext,
} from "@/lib/option-acceleration-engine";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { getNearestExpiry, isExpiryDay } from "@/lib/expiry-calculator";
import { getRealATR14 } from "@/lib/yahoo-finance-api";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();
    const expiry = searchParams.get("expiry") || undefined;

    const result = await fetchLiveOptionChain(symbol, expiry, request.signal);
    if (!result.success || !result.data) {
      return NextResponse.json(
        { success: false, error: result.error || "No option chain data" },
        { status: 502 }
      );
    }

    const data = result.data;
    const rawStrikes = data.data;
    const summary = data.summary;

    const strikes: StrikeInput[] = rawStrikes.map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? {
            ltp: row.ce.ltp || 0, bid: row.ce.bid || 0, ask: row.ce.ask || 0,
            oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0,
            iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0,
            theta: row.ce.theta || 0, vega: row.ce.vega || 0,
            priceChg: row.ce.priceChg,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
      pe: row.pe
        ? {
            ltp: row.pe.ltp || 0, bid: row.pe.bid || 0, ask: row.pe.ask || 0,
            oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0,
            iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0,
            theta: row.pe.theta || 0, vega: row.pe.vega || 0,
            priceChg: row.pe.priceChg,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
    }));

    const spot = summary.spotPrice;
    const vix = summary.indiaVIX || 0;
    const pcr = summary.pcr;
    const maxPain = summary.maxPain;
    const atmStrike = summary.atmStrike;

    const callOI = summary.totalCallOI;
    const putOI = summary.totalPutOI;
    const callOiChg = summary.callOiChange;
    const putOiChg = summary.putOiChange;

    const expectedMove = spot * (vix / 100) * Math.sqrt(1 / 365);

    const now = new Date();
    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const istWeekday = ist.getUTCDay(); // 0 = Sunday
    const isMarketOpen = istWeekday >= 1 && istWeekday <= 5 && istMinutes >= 555 && istMinutes <= 930;

    const marketOpenDate = new Date(now);
    marketOpenDate.setHours(9, 15, 0, 0);
    const totalSession = 375;
    const elapsed = Math.max(0, Math.min(totalSession, (now.getTime() - marketOpenDate.getTime()) / 60000));
    const sessionMinutes = Math.max(0, totalSession - elapsed);

    // Canonical expiry calculator — NOT hardcoded Thursday
    const nearestExpiry = getNearestExpiry(symbol);
    const daysToExpiry = nearestExpiry?.daysToExpiry ?? 7;
    const minutesToExpiry = daysToExpiry * totalSession + sessionMinutes;
    const isExpiryDayCalc = isExpiryDay(symbol, now);

    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    if (pcr < 0.85 && spot >= atmStrike) trend = "bullish";
    else if (pcr > 1.2 && spot <= atmStrike) trend = "bearish";

    const sessionPct = elapsed / totalSession;
    const vixEstimatedRange = expectedMove * (0.4 + sessionPct * 0.2);

    // Real ATR from daily candles (Yahoo, cached 1h) — fallback to VIX-derived estimate
    const atrResult = await getRealATR14(symbol, Math.round(vixEstimatedRange * 100) / 100);
    const atr = atrResult.atr;
    const atrSource = atrResult.source;

    const ctx: MarketContext = {
      spot, vix, pcr, maxPain, atmStrike,
      totalOICE: callOI, totalOIPE: putOI,
      callOiChg, putOiChg,
      expectedMove: Math.round(expectedMove * 100) / 100,
      sessionMinutes: Math.round(sessionMinutes),
      minutesToExpiry, isExpiryDay: isExpiryDayCalc,
      atr,
      atrSource,
      trend,
      dataAgeMs: result.ageMs || 0,
      isMarketOpen,
      strikeStep: symbol === "SENSEX" ? 100 : 50,
    };

    const engineResult = runAccelerationEngine(strikes, ctx);
    engineResult.symbol = symbol;

    return NextResponse.json({
      success: true,
      source: result.source,
      data: engineResult,
    });
  } catch (error: any) {
    console.error("[Institutional Greeks API] Error:", error?.message || error);
    return NextResponse.json(
      { success: false, error: error?.message || "Engine error" },
      { status: 500 }
    );
  }
}
