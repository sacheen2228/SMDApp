// app/api/atm-straddle/route.ts
//
// ATM Straddle Range Engine endpoint. Reuses the live option chain already
// served by /api/option-chain, resolves the ATM strike + CE/PE premiums, and
// returns the projected intraday Support/Resistance range plus a confidence
// score and breakout confirmation. Polled by the dashboard on every refresh.

import { NextRequest, NextResponse } from "next/server";
import {
  computeATMStraddleRange,
  resolveATM,
  recordRangeSnapshot,
  evaluateContainment,
  type StraddleChainInput,
} from "@/lib/atm-straddle-range";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  try {
    const res = await fetch(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "option-chain unavailable", status: res.status }, { status: 502 });
    }
    const json = await res.json();
    const d = json?.data;
    if (!d || !d.data?.length) {
      return NextResponse.json({ error: "no chain data" }, { status: 502 });
    }

    const spot = d.spotPrice || d.summary?.spotPrice || 0;
    const atmStrike = d.summary?.atmStrike || d.analysis?.atmStrike || 0;
    const pcr = d.summary?.pcr ?? d.analysis?.pcr ?? 1;
    const maxPain = d.summary?.maxPain ?? d.analysis?.maxPain ?? 0;
    const iv = d.summary?.indiaVIX ?? d.analysis?.greeks?.vix ?? 15;
    const chain = (d.data || []).map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0, theta: row.ce.theta || 0 }
        : null,
      pe: row.pe
        ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0, theta: row.pe.theta || 0 }
        : null,
    }));

    const atm = resolveATM(spot, chain);
    const atmCE = atm?.ce ?? 0;
    const atmPE = atm?.pe ?? 0;

    const input: StraddleChainInput = {
      symbol,
      spot,
      atmStrike: atm?.strike ?? atmStrike,
      atmCE,
      atmPE,
      chain,
      pcr,
      maxPain,
      iv,
      candles: (d.candles || []).map((c: any) => ({ time: new Date(c.time).getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 })),
    };

    const range = computeATMStraddleRange(input);
    recordRangeSnapshot(range);

    // Optional end-of-day containment evaluation (?close=price)
    const closeParam = req.nextUrl.searchParams.get("close");
    const containment = closeParam ? evaluateContainment(symbol, Number(closeParam)) : undefined;

    return NextResponse.json({ success: true, symbol, range, containment });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "straddle compute failed" }, { status: 500 });
  }
}
