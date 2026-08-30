/**
 * @deprecated Use /api/institutional-greeks instead.
 * Both routes call the same `runAccelerationEngine` from
 * src/lib/option-acceleration-engine.ts. Kept on disk until
 * callers confirm the migration.
 */
import { NextResponse } from "next/server";
import {
  runAccelerationEngine,
  StrikeInput,
  MarketContext,
} from "@/lib/option-acceleration-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();

    const origin = new URL(request.url).origin;
    const chainRes = await fetch(`${origin}/api/option-chain?symbol=${symbol}`, {
      cache: "no-store",
    });

    if (!chainRes.ok) {
      return NextResponse.json({ error: "Option chain unavailable" }, { status: 503 });
    }

    const chainJson = await chainRes.json();
    if (!chainJson.success || !chainJson.data?.data) {
      return NextResponse.json({ error: "No chain data" }, { status: 503 });
    }

    const rawStrikes = chainJson.data.data;
    const rawSummary = chainJson.data.summary || chainJson.summary || {};

    const strikes: StrikeInput[] = rawStrikes.map((s: any) => ({
      strike: s.strike,
      ce: s.ce
        ? {
            ltp: s.ce.ltp || 0,
            bid: s.ce.bid || 0,
            ask: s.ce.ask || 0,
            oi: s.ce.oi || 0,
            oiChg: s.ce.oiChg || 0,
            volume: s.ce.volume || 0,
            iv: s.ce.iv || 0,
            delta: s.ce.delta || 0,
            gamma: s.ce.gamma || 0,
            theta: s.ce.theta || 0,
            vega: s.ce.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
      pe: s.pe
        ? {
            ltp: s.pe.ltp || 0,
            bid: s.pe.bid || 0,
            ask: s.pe.ask || 0,
            oi: s.pe.oi || 0,
            oiChg: s.pe.oiChg || 0,
            volume: s.pe.volume || 0,
            iv: s.pe.iv || 0,
            delta: s.pe.delta || 0,
            gamma: s.pe.gamma || 0,
            theta: s.pe.theta || 0,
            vega: s.pe.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
    }));

    const spot = rawSummary.spotPrice || 0;
    const atmStrike = rawSummary.atmStrike || 0;
    const vix = rawSummary.indiaVIX || 0;
    const pcr = rawSummary.pcr || 0;
    const maxPain = rawSummary.maxPain || 0;
    const totalCallOI = rawSummary.totalCallOI || rawSummary.callOiChange || 0;
    const totalPutOI = rawSummary.totalPutOI || rawSummary.putOiChange || 0;

    const expectedMove = spot * (vix / 100) * Math.sqrt(1 / 365);

    const now = new Date();
    const marketOpen = new Date(now);
    marketOpen.setHours(9, 15, 0, 0);
    const marketClose = new Date(now);
    marketClose.setHours(15, 30, 0, 0);
    const totalSession = 375;
    const elapsed = Math.max(0, Math.min(totalSession, (now.getTime() - marketOpen.getTime()) / 60000));
    const sessionMinutes = Math.max(0, totalSession - elapsed);

    const Thursday = 4;
    const daysToThu = (Thursday - now.getDay() + 7) % 7 || 7;
    const minutesToExpiry = daysToThu * totalSession + sessionMinutes;
    const isExpiryDay = now.getDay() === Thursday;

    const callOI = strikes.reduce((s, x) => s + (x.ce?.oi || 0), 0);
    const putOI = strikes.reduce((s, x) => s + (x.pe?.oi || 0), 0);

    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    if (pcr < 0.85 && spot >= atmStrike) trend = "bullish";
    else if (pcr > 1.2 && spot <= atmStrike) trend = "bearish";

    // ATR: realistic intraday range — fraction of VIX expected move
    // VIX gives 1-sigma annualized → daily. Actual intraday range is 40-60% of that.
    const sessionPct = elapsed / totalSession;
    const intradayRange = expectedMove * (0.4 + sessionPct * 0.2);

    const callOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.ce?.oiChg || 0), 0);
    const putOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.pe?.oiChg || 0), 0);

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

    return NextResponse.json({
      success: true,
      source: chainJson.source || "unknown",
      result,
    });
  } catch (err: any) {
    console.error("[greek-flow] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
