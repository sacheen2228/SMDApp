import { NextResponse } from "next/server";
import { runGreekFlowEngine, FlowStrike, FlowSummary } from "@/lib/greek-flow-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();

    const origin = request.headers.get("origin") || "http://localhost:3000";
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

    const strikes: FlowStrike[] = rawStrikes.map((s: any) => ({
      strike: s.strike,
      ce: s.ce
        ? {
            ltp: s.ce.ltp || 0,
            bid: s.ce.bid || 0,
            ask: s.ce.ask || 0,
            bidQty: (s.ce as any).bidQty || 0,
            askQty: (s.ce as any).askQty || 0,
            oi: s.ce.oi || 0,
            oiChg: s.ce.oiChg || 0,
            volume: s.ce.volume || 0,
            iv: s.ce.iv || 0,
            delta: s.ce.delta || 0,
            gamma: s.ce.gamma || 0,
            theta: s.ce.theta || 0,
            vega: s.ce.vega || 0,
          }
        : {
            ltp: 0,
            bid: 0,
            ask: 0,
            bidQty: 0,
            askQty: 0,
            oi: 0,
            oiChg: 0,
            volume: 0,
            iv: 0,
            delta: 0,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
      pe: s.pe
        ? {
            ltp: s.pe.ltp || 0,
            bid: s.pe.bid || 0,
            ask: s.pe.ask || 0,
            bidQty: (s.pe as any).bidQty || 0,
            askQty: (s.pe as any).askQty || 0,
            oi: s.pe.oi || 0,
            oiChg: s.pe.oiChg || 0,
            volume: s.pe.volume || 0,
            iv: s.pe.iv || 0,
            delta: s.pe.delta || 0,
            gamma: s.pe.gamma || 0,
            theta: s.pe.theta || 0,
            vega: s.pe.vega || 0,
          }
        : {
            ltp: 0,
            bid: 0,
            ask: 0,
            bidQty: 0,
            askQty: 0,
            oi: 0,
            oiChg: 0,
            volume: 0,
            iv: 0,
            delta: 0,
            gamma: 0,
            theta: 0,
            vega: 0,
          },
      pcr: 0,
      maxPain: rawSummary.maxPain || 0,
    }));

    const summary: FlowSummary = {
      spot: rawSummary.spotPrice || 0,
      vix: rawSummary.indiaVIX || 0,
      indiaVIX: rawSummary.indiaVIX || 0,
      pcr: rawSummary.pcr || 0,
      maxPain: rawSummary.maxPain || 0,
      atmStrike: rawSummary.atmStrike || 0,
      totalOICE: rawSummary.totalCallOI || 0,
      totalOIPE: rawSummary.totalPutOI || 0,
    };

    const result = runGreekFlowEngine(strikes, summary, symbol);

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
