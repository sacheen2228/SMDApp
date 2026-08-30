// app/api/atm-straddle/route.ts
//
// ATM Straddle Range Engine endpoint. Uses the shared option chain fetcher
// (no HTTP self-fetch), resolves the ATM strike + CE/PE premiums, and
// returns the projected intraday Support/Resistance range.

import { NextRequest, NextResponse } from "next/server";
import {
  computeATMStraddleRange,
  resolveATM,
  recordRangeSnapshot,
  evaluateContainment,
  type StraddleChainInput,
} from "@/lib/atm-straddle-range";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  try {
    const result = await fetchLiveOptionChain(symbol, undefined, req.signal);
    if (!result.success || !result.data) {
      return NextResponse.json({ success: false, error: result.error || "option-chain unavailable" }, { status: 502 });
    }

    const d = result.data;
    if (!d.data.length) {
      return NextResponse.json({ success: false, error: "no chain data" }, { status: 502 });
    }

    const spot = d.summary.spotPrice;
    const atmStrike = d.summary.atmStrike;
    const pcr = d.summary.pcr;
    const maxPain = d.summary.maxPain;
    const iv = d.summary.indiaVIX ?? 15;
    const chain = d.data.map((row: any) => ({
      strike: row.strike,
      ce: row.ce
        ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0, theta: row.ce.theta || 0 }
        : null,
      pe: row.pe
        ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0, theta: row.pe.theta || 0 }
        : null,
    }));

    const atm = resolveATM(spot, chain);

    const input: StraddleChainInput = {
      symbol,
      spot,
      atmStrike: atm?.strike ?? atmStrike,
      atmCE: atm?.ce ?? 0,
      atmPE: atm?.pe ?? 0,
      chain,
      pcr,
      maxPain,
      iv,
      candles: (d.candles || []).map((c: any) => ({ time: new Date(c.time).getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 })),
    };

    const range = computeATMStraddleRange(input);
    recordRangeSnapshot(range);

    const closeParam = req.nextUrl.searchParams.get("close");
    const containment = closeParam ? evaluateContainment(symbol, Number(closeParam)) : undefined;

    return NextResponse.json({ success: true, symbol, range, containment });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "straddle compute failed" }, { status: 500 });
  }
}
