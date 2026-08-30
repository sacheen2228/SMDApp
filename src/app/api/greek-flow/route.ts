/**
 * @deprecated Use /api/institutional-greeks instead.
 * Uses the shared option chain fetcher (no HTTP self-fetch).
 */
import { NextResponse } from "next/server";
import {
  runAccelerationEngine,
  StrikeInput,
  MarketContext,
} from "@/lib/option-acceleration-engine";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();

    const result = await fetchLiveOptionChain(symbol);
    if (!result.success || !result.data) {
      return NextResponse.json({ error: result.error || "No chain data" }, { status: 503 });
    }

    const data = result.data;
    const rawStrikes = data.data;

    const strikes: StrikeInput[] = rawStrikes.map((s: any) => ({
      strike: s.strike,
      ce: s.ce
        ? {
            ltp: s.ce.ltp || 0, bid: s.ce.bid || 0, ask: s.ce.ask || 0,
            oi: s.ce.oi || 0, oiChg: s.ce.oiChg || 0, volume: s.ce.volume || 0,
            iv: s.ce.iv || 0, delta: s.ce.delta || 0, gamma: s.ce.gamma || 0,
            theta: s.ce.theta || 0, vega: s.ce.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
      pe: s.pe
        ? {
            ltp: s.pe.ltp || 0, bid: s.pe.bid || 0, ask: s.pe.ask || 0,
            oi: s.pe.oi || 0, oiChg: s.pe.oiChg || 0, volume: s.pe.volume || 0,
            iv: s.pe.iv || 0, delta: s.pe.delta || 0, gamma: s.pe.gamma || 0,
            theta: s.pe.theta || 0, vega: s.pe.vega || 0,
          }
        : { ltp: 0, bid: 0, ask: 0, oi: 0, oiChg: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 },
    }));

    const spot = data.summary.spotPrice;
    const vix = data.summary.indiaVIX || 0;
    const pcr = data.summary.pcr;
    const maxPain = data.summary.maxPain;
    const atmStrike = data.summary.atmStrike;

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

    const sessionPct = elapsed / totalSession;
    const intradayRange = expectedMove * (0.4 + sessionPct * 0.2);

    const callOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.ce?.oiChg || 0), 0);
    const putOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.pe?.oiChg || 0), 0);

    const ctx: MarketContext = {
      spot, vix, pcr, maxPain, atmStrike,
      totalOICE: callOI, totalOIPE: putOI,
      callOiChg, putOiChg,
      expectedMove: Math.round(expectedMove * 100) / 100,
      sessionMinutes: Math.round(sessionMinutes),
      minutesToExpiry, isExpiryDay,
      atr: Math.round(intradayRange * 100) / 100,
      trend,
    };

    const engineResult = runAccelerationEngine(strikes, ctx);

    return NextResponse.json({
      success: true,
      source: result.source,
      result: engineResult,
    });
  } catch (err: any) {
    console.error("[greek-flow] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
