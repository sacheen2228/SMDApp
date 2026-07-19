/**
 * API Route — Institutional Greeks Engine
 *
 * Fetches live option chain data, runs the institutional scoring engine,
 * and returns ranked strikes with Top 5 Calls/Puts.
 *
 * GET /api/institutional-greeks?symbol=NIFTY&expiry=...
 */

import { NextRequest, NextResponse } from "next/server";
import {
  runInstitutionalEngine,
  type StrikeData,
  type ChainSummary,
} from "@/lib/institutional-greeks-engine";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol") || "NIFTY";
    const expiry = searchParams.get("expiry") || undefined;

    // Fetch option chain from existing route (server-side call)
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

    // Parse into engine format
    const strikes: StrikeData[] = rawStrikes.map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? {
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
          }
        : null,
      pe: row.pe
        ? {
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
          }
        : null,
    }));

    // Compute summary fields if missing
    const spotPrice =
      summary.spotPrice || data.spotPrice || data.summary?.spotPrice || 0;
    const totalCallOI = strikes.reduce(
      (sum: number, s: StrikeData) => sum + (s.ce?.oi || 0),
      0
    );
    const totalPutOI = strikes.reduce(
      (sum: number, s: StrikeData) => sum + (s.pe?.oi || 0),
      0
    );
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    // Max pain
    let maxPain = spotPrice;
    let maxTotalOI = 0;
    for (const s of strikes) {
      const total = (s.ce?.oi || 0) + (s.pe?.oi || 0);
      if (total > maxTotalOI) {
        maxTotalOI = total;
        maxPain = s.strike;
      }
    }

    // ATM strike (closest to spot)
    let atmStrike = spotPrice;
    let minDiff = Infinity;
    for (const s of strikes) {
      const diff = Math.abs(s.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = s.strike;
      }
    }

    // Days to expiry
    const selectedExpiry =
      data.selectedExpiry ||
      data.expiries?.[0]?.date ||
      data.expiries?.[0] ||
      "";
    let daysToExpiry = 1;
    if (selectedExpiry) {
      const expDate = new Date(selectedExpiry);
      const now = new Date();
      daysToExpiry = Math.max(
        1,
        Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    const chainSummary: ChainSummary = {
      spotPrice,
      indiaVIX: summary.indiaVIX ?? null,
      pcr,
      maxPain: summary.maxPain || maxPain,
      atmStrike: summary.atmStrike || atmStrike,
      selectedExpiry,
      totalCallOI,
      totalPutOI,
    };

    // Run engine
    const result = runInstitutionalEngine(
      strikes,
      chainSummary,
      symbol,
      daysToExpiry
    );

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
