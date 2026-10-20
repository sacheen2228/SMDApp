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
import { getNearestExpiry, isExpiryDay } from "@/lib/expiry-calculator";
import { getNSEATR14 } from "@/lib/nse-api";
import { getGreeksAssumptions } from "@/lib/greeks";

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

    // ── A chain with no strikes is an UNAVAILABLE state, not an empty result ──
    // The engine would otherwise return rows full of zero greeks that look
    // like a real (flat) market.
    if (!rawStrikes.length) {
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: `No option chain strikes for ${symbol}`,
        source: result.source,
      }, { status: 503 });
    }

    // ── Legs ─────────────────────────────────────────────────────────
    // A leg the chain does not carry is NOT an all-zero leg. The engine's
    // StrikeInput needs both sides, so a strike with a missing leg is left
    // out of the analysis and REPORTED as unavailable — a fabricated
    // {ltp:0, oi:0, iv:0, delta:0} leg reads as a real, flat option.
    let legsUnavailable = 0;
    const toLeg = (leg: any) => {
      if (!leg) { legsUnavailable++; return null; }
      return {
        ltp: leg.ltp ?? 0, bid: leg.bid ?? 0, ask: leg.ask ?? 0,
        oi: leg.oi ?? 0, oiChg: leg.oiChg ?? 0, volume: leg.volume ?? 0,
        iv: leg.iv ?? 0, delta: leg.delta ?? 0, gamma: leg.gamma ?? 0,
        theta: leg.theta ?? 0, vega: leg.vega ?? 0,
        priceChg: leg.priceChg,
      };
    };
    const strikes: StrikeInput[] = [];
    for (const s of rawStrikes) {
      const ce = toLeg(s.ce);
      const pe = toLeg(s.pe);
      if (!ce || !pe) continue; // a half-leg strike cannot be scored
      strikes.push({ strike: s.strike, ce, pe });
    }

    const spot = data.summary.spotPrice;
    // The VIX is either the live India VIX or UNKNOWN. The old `|| 0` made a
    // missing VIX read as a 0-volatility market (and the expected move 0).
    const indiaVIX = data.summary.indiaVIX ?? null;
    const vix = indiaVIX ?? 0;
    const pcr = data.summary.pcr;
    const maxPain = data.summary.maxPain;
    const atmStrike = data.summary.atmStrike;

    const expectedMove = vix > 0 ? spot * (vix / 100) * Math.sqrt(1 / 365) : 0;
    const expectedMoveAvailable = vix > 0;

    const now = new Date();
    const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
    const ist = new Date(istMs);
    const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const istWeekday = ist.getUTCDay(); // 0 = Sunday
    const isMarketOpen = istWeekday >= 1 && istWeekday <= 5 && istMinutes >= 555 && istMinutes <= 930;

    const marketOpenDate = new Date(now);
    marketOpenDate.setHours(9, 15, 0, 0);
    const marketClose = new Date(now);
    marketClose.setHours(15, 30, 0, 0);
    const totalSession = 375;
    const elapsed = Math.max(0, Math.min(totalSession, (now.getTime() - marketOpenDate.getTime()) / 60000));
    const sessionMinutes = Math.max(0, totalSession - elapsed);

    // Use canonical expiry calculator — NOT hardcoded Thursday
    const nearestExpiry = getNearestExpiry(symbol);
    const daysToExpiry = nearestExpiry?.daysToExpiry ?? 7;
    const minutesToExpiry = daysToExpiry * totalSession + sessionMinutes;
    const isExpiryDayCalc = isExpiryDay(symbol, now);

    const callOI = strikes.reduce((s, x) => s + (x.ce?.oi || 0), 0);
    const putOI = strikes.reduce((s, x) => s + (x.pe?.oi || 0), 0);

    let trend: "bullish" | "bearish" | "neutral" = "neutral";
    if (pcr < 0.85 && spot >= atmStrike) trend = "bullish";
    else if (pcr > 1.2 && spot <= atmStrike) trend = "bearish";

    const sessionPct = elapsed / totalSession;
    const vixEstimatedRange = expectedMove * (0.4 + sessionPct * 0.2);

    // Real ATR from the exchange's own daily history (free NSE, cached 15m)
    // — the fallback is a VIX-derived estimate, and with no VIX there is no
    // estimate either (the ATR is then simply unavailable).
    const atrResult = await getNSEATR14(symbol, Math.round(vixEstimatedRange * 100) / 100);
    const atr = atrResult.atr;
    const atrSource = atrResult.source;
    const atrAvailable = atr > 0;

    const callOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.ce?.oiChg || 0), 0);
    const putOiChg = strikes.reduce((s: number, x: StrikeInput) => s + (x.pe?.oiChg || 0), 0);

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

    return NextResponse.json({
      success: true,
      source: result.source,
      result: engineResult,
      // What is REAL and what is UNAVAILABLE in this payload. A row of
      // zero greeks means "the chain had no data", never "the market is flat".
      availability: {
        chain: strikes.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
        strikesAnalysed: strikes.length,
        legsUnavailable,
        vix: { value: indiaVIX, available: indiaVIX != null },
        expectedMove: { value: expectedMoveAvailable ? Math.round(expectedMove * 100) / 100 : null, available: expectedMoveAvailable },
        atr: { value: atrAvailable ? atr : null, available: atrAvailable, source: atrSource },
      },
      assumptions: getGreeksAssumptions(),
    });
  } catch (err: any) {
    console.error("[greek-flow] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
