// app/api/ide/route.ts
//
// Institutional Derivatives Engine endpoint. Uses the shared option chain
// fetcher (no HTTP self-fetch), builds the DerivativeInput, and returns
// the engine decision. NIFTY / SENSEX only.

import { NextRequest, NextResponse } from "next/server";
import { runInstitutionalDerivativesEngine, type DerivativeInput, type StrikeLeg, type ChainContext } from "@/lib/institutional-derivatives-engine";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";

const IDE_SYMBOLS = new Set(["NIFTY", "SENSEX"]);

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  if (!IDE_SYMBOLS.has(symbol)) {
    return NextResponse.json({ success: false, error: "IDE supports NIFTY and SENSEX only" }, { status: 400 });
  }

  try {
    const [chainResult, fiiRes] = await Promise.all([
      fetchLiveOptionChain(symbol, undefined, req.signal),
      fetch(`${new URL(req.url).origin}/api/fii-dii`, { cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    if (!chainResult.success || !chainResult.data) {
      return NextResponse.json({ success: false, error: chainResult.error || "option-chain unavailable" }, { status: 502 });
    }
    const d = chainResult.data;
    if (!d.data.length) return NextResponse.json({ success: false, error: "no chain data" }, { status: 502 });

    const spot = d.summary.spotPrice;
    const atmStrike = d.summary.atmStrike;
    const pcr = d.summary.pcr;
    const iv = d.summary.indiaVIX ?? 15;
    const chain = d.data.map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0, theta: row.ce.theta || 0 } : null,
      pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0, theta: row.pe.theta || 0 } : null,
    }));

    // ATM resolution
    let atm = chain[0];
    let best = Infinity;
    for (const s of chain) { const dd = Math.abs(s.strike - spot); if (dd < best) { best = dd; atm = s; } }
    const atmCE = atm.ce?.ltp ?? 0;
    const atmPE = atm.pe?.ltp ?? 0;
    const atmDelta = ((atm.ce?.delta ?? 0) + (atm.pe?.delta ?? 0)) / 2;
    const atmGamma = Math.max(atm.ce?.gamma ?? 0, atm.pe?.gamma ?? 0);
    const atmVega = Math.max(atm.ce?.vega ?? 0, atm.pe?.vega ?? 0);
    const atmTheta = Math.min(atm.ce?.theta ?? 0, atm.pe?.theta ?? 0);

    let highestCallOI = 0, highestPutOI = 0;
    let totalCallVol = 0, totalPutVol = 0, atmCallVol = atm.ce?.volume ?? 0, atmPutVol = atm.pe?.volume ?? 0;
    for (const s of chain) {
      if (s.ce?.oi) highestCallOI = Math.max(highestCallOI, s.ce.oi);
      if (s.pe?.oi) highestPutOI = Math.max(highestPutOI, s.pe.oi);
      totalCallVol += s.ce?.volume ?? 0;
      totalPutVol += s.pe?.volume ?? 0;
    }
    const totalVol = totalCallVol + totalPutVol || 1;
    const volumeRatio = (atmCallVol + atmPutVol) / (totalVol / Math.max(1, chain.length));

    const ceOiChg = atm.ce?.oiChg ?? 0;
    const peOiChg = atm.pe?.oiChg ?? 0;

    // FII / DII
    let fiiLong = 50, fiiShort = 50, diiBuy = 50, diiSell = 50;
    if (fiiRes && fiiRes.ok) {
      const f = await fiiRes.json();
      const fiiClamp = Math.max(-2000, Math.min(2000, typeof f.fiiNet === "number" ? f.fiiNet : 0));
      fiiLong = Math.round(50 + (fiiClamp / 2000) * 50); fiiShort = 100 - fiiLong;
      const diiClamp = Math.max(-2000, Math.min(2000, typeof f.diiNet === "number" ? f.diiNet : 0));
      diiBuy = Math.round(50 + (diiClamp / 2000) * 50); diiSell = 100 - diiBuy;
    }

    const input: DerivativeInput = {
      spot,
      atm: atm.strike || atmStrike,
      ce: atmCE,
      pe: atmPE,
      pcr,
      iv,
      delta: atmDelta,
      gamma: atmGamma,
      vega: atmVega,
      theta: atmTheta,
      volumeRatio,
      callWriting: ceOiChg < 0,
      putWriting: peOiChg < 0,
      callUnwind: ceOiChg > 0,
      putUnwind: peOiChg > 0,
      fiiLong,
      fiiShort,
      diiBuy,
      diiSell,
      highestCallOI,
      highestPutOI,
    };

    const expectedMove = (atmCE + atmPE) * (iv > 22 ? 1.2 : iv > 18 ? 1.1 : 1) * (atmGamma > 0.03 ? 1.05 : 1);
    const ctx: ChainContext = {
      spot, atmStrike: atm.strike || atmStrike, pcr, iv,
      highestCallOI, highestPutOI, totalVolume: totalVol, chainLen: chain.length,
      fiiLong, fiiShort, diiBuy, diiSell, expectedMove,
    };
    const strikes: { strike: number; type: "CE" | "PE"; leg: StrikeLeg }[] = [];
    const scanThreshold = spot * 0.03;
    for (const s of chain) {
      if (Math.abs(s.strike - spot) > scanThreshold) continue;
      if (s.ce && s.ce.ltp > 0) strikes.push({ strike: s.strike, type: "CE", leg: s.ce });
      if (s.pe && s.pe.ltp > 0) strikes.push({ strike: s.strike, type: "PE", leg: s.pe });
    }

    const daysToExpiry = parseExpiryDays(d.selectedExpiry);
    const signal = runInstitutionalDerivativesEngine(symbol, input, { strikes, ctx, daysToExpiry });
    return NextResponse.json({ success: true, symbol, signal, expectedMove: Math.round(expectedMove * 100) / 100 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "IDE compute failed" }, { status: 500 });
  }
}

function parseExpiryDays(label: any): number | undefined {
  if (!label || typeof label !== "string") return undefined;
  const m = label.match(/(\d{1,2})[- ]?([A-Za-z]{3})[- ]?(\d{4})/);
  if (!m) return undefined;
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = months[m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()];
  if (mon === undefined) return undefined;
  const dt = new Date(parseInt(m[3]), mon, parseInt(m[1]));
  const days = Math.round((dt.getTime() - Date.now()) / 86400000);
  return days > 0 ? days : 1;
}
