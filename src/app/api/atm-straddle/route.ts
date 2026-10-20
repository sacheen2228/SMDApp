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
import { getGreeksAssumptions } from "@/lib/greeks";

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

    // The IV is EITHER the live India VIX or the chain's own average IV —
    // both are REAL numbers the exchange published. The old `?? 15` invented
    // a 15% volatility when the VIX feed was down, and every band derived
    // from it (support/resistance, the IV confidence) was then a guess.
    const chainLegs = d.data.flatMap((r: any) => [r.ce, r.pe]).filter(Boolean);
    const ivValues = chainLegs.map((l: any) => Number(l.iv)).filter((v: number) => Number.isFinite(v) && v > 0);
    const chainAvgIV = ivValues.length ? ivValues.reduce((a, b) => a + b, 0) / ivValues.length : null;
    const indiaVIX = d.summary.indiaVIX ?? null;
    const iv = indiaVIX ?? chainAvgIV ?? 0;
    const ivSource = indiaVIX != null ? "indiaVIX" : chainAvgIV != null ? "chain-avg-iv" : "unavailable";

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

    return NextResponse.json({
      success: true,
      symbol,
      range,
      containment,
      // The assumptions behind the bands: which IV was used and where the
      // greeks' risk-free rate came from. Never a fabricated 15.
      assumptions: {
        iv,
        ivSource,
        indiaVIX,
        vixAvailable: indiaVIX != null,
        ...getGreeksAssumptions(),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "straddle compute failed" }, { status: 500 });
  }
}
