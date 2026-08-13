/**
 * API Route — Institutional Greeks Engine (Acceleration-powered)
 *
 * Fetches live option chain data, runs the 10-engine Option Acceleration
 * scoring system, and returns ranked strikes with dashboard data.
 *
 * GET /api/institutional-greeks?symbol=NIFTY&expiry=...
 */

import { NextRequest, NextResponse } from "next/server";
import {
  runAccelerationEngine,
  type StrikeInput,
  type MarketContext,
} from "@/lib/option-acceleration-engine";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const expiry = searchParams.get("expiry") || undefined;

    const params = new URLSearchParams({ symbol });
    if (expiry) params.set("expiry", expiry);

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const chainRes = await fetch(`${baseUrl}/api/option-chain?${params.toString()}`, {
      cache: "no-store",
    });

    if (!chainRes.ok) {
      return NextResponse.json(
        { success: false, error: "Failed to fetch option chain data" },
        { status: 502 }
      );
    }

    const chainJson = await chainRes.json();
    if (!chainJson.success || !chainJson.data) {
      return NextResponse.json(
        { success: false, error: chainJson.error || "No option chain data" },
        { status: 502 }
      );
    }

    const data = chainJson.data;
    const rawStrikes = data.data || [];
    const summary = data.summary || {};

    const strikes: StrikeInput[] = rawStrikes.map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? {
            ltp: row.ce.ltp || 0,
            bid: row.ce.bid || 0,
            ask: row.ce.ask || 0,
            oi: row.ce.oi || 0,
            oiChg: row.ce.oiChg || 0,
            volume: row.ce.volume || 0,
            iv: row.ce.iv || 0,
            delta: row.ce.delta || 0,
            gamma: row.ce.gamma || 0,
            theta: row.ce.theta || 0,
            vega: row.ce.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
      pe: row.pe
        ? {
            ltp: row.pe.ltp || 0,
            bid: row.pe.bid || 0,
            ask: row.pe.ask || 0,
            oi: row.pe.oi || 0,
            oiChg: row.pe.oiChg || 0,
            volume: row.pe.volume || 0,
            iv: row.pe.iv || 0,
            delta: row.pe.delta || 0,
            gamma: row.pe.gamma || 0,
            theta: row.pe.theta || 0,
            vega: row.pe.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
    }));

    const spot = summary.spotPrice || 0;
    const vix = summary.indiaVIX || 0;
    const pcr = summary.pcr || 0;
    const maxPain = summary.maxPain || 0;
    const atmStrike = summary.atmStrike || 0;

    const callOI = strikes.reduce((s: number, x: StrikeInput) => s + (x.ce?.oi || 0), 0);
    const putOI = strikes.reduce((s: number, x: StrikeInput) => s + (x.pe?.oi || 0), 0);

    const callOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.ce?.oiChg || 0), 0);
    const putOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.pe?.oiChg || 0), 0);

    const expectedMove = spot * (vix / 100) * Math.sqrt(1 / 365);

    const now = new Date();
    const marketOpen = new Date(now);
    marketOpen.setHours(9, 15, 0, 0);
    const totalSession = 375;
    const elapsed = Math.max(0, Math.min(totalSession, (now.getTime() - marketOpen.getTime()) / 60000));
    const sessionMinutes = Math.max(0, totalSession - elapsed);

    const Thursday = 4;
    const daysToThu = (Thursday - now.getDay() + 7) % 7 || 7;
    const minutesToExpiry = daysToThu * totalSession + sessionMinutes;
    const isExpiryDay = now.getDay() === Thursday;

    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    if (pcr < 0.85 && spot >= atmStrike) trend = "bullish";
    else if (pcr > 1.2 && spot <= atmStrike) trend = "bearish";

    // ATR: realistic intraday range — fraction of VIX expected move
    const sessionPct = elapsed / totalSession;
    const intradayRange = expectedMove * (0.4 + sessionPct * 0.2);

    const ctx: MarketContext = {
      spot,
      vix,
      pcr,
      maxPain,
      atmStrike,
      totalOICE: callOI,
      totalOIPE: putOI,
      callOiChg,
      putOiChg,
      expectedMove: Math.round(expectedMove * 100) / 100,
      sessionMinutes: Math.round(sessionMinutes),
      minutesToExpiry,
      isExpiryDay,
      atr: Math.round(intradayRange * 100) / 100,
      trend,
    };

    const result = runAccelerationEngine(strikes, ctx);
    result.symbol = symbol;

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error("[Institutional Greeks API] Error:", error?.message || error);
    return NextResponse.json(
      { success: false, error: error?.message || "Engine error" },
      { status: 500 }
    );
  }
}
