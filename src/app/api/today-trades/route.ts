// app/api/today-trades/route.ts
//
// "Today's Trade — Top 5" derivatives scan. Scores every near-ATM strike on
// both CE and PE sides using the Institutional Derivatives Engine, ranks them,
// and returns the top 5 candidates with entry, R:R and star rating.
// NIFTY / SENSEX only. Pure derivatives data (no SMC / TA indicators).

import { NextRequest, NextResponse } from "next/server";
import { rankStrikes, type ChainContext, type StrikeLeg } from "@/lib/institutional-derivatives-engine";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";
const IDE_SYMBOLS = new Set(["NIFTY", "SENSEX"]);

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();
  if (!IDE_SYMBOLS.has(symbol)) {
    return NextResponse.json({ error: "Top-5 scan supports NIFTY and SENSEX only" }, { status: 400 });
  }

  try {
    const [chainRes, fiiRes] = await Promise.all([
      fetch(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" }),
      fetch(`${BASE}/api/fii-dii`, { cache: "no-store" }).catch(() => null),
    ]);
    if (!chainRes.ok) return NextResponse.json({ error: "option-chain unavailable", status: chainRes.status }, { status: 502 });
    const json = await chainRes.json();
    const d = json?.data;
    if (!d || !d.data?.length) return NextResponse.json({ error: "no chain data" }, { status: 502 });

    const spot = d.spotPrice || d.summary?.spotPrice || 0;
    const atmStrike = d.summary?.atmStrike || d.analysis?.atmStrike || 0;
    const pcr = d.summary?.pcr ?? d.analysis?.pcr ?? 1;
    const iv = d.summary?.indiaVIX ?? d.analysis?.greeks?.vix ?? 15;

    const rows = (d.data || []).map((row: any) => ({
      strike: row.strike,
      ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0, theta: row.ce.theta || 0, bid: row.ce.bid || 0, ask: row.ce.ask || 0 } : null,
      pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0, theta: row.pe.theta || 0, bid: row.pe.bid || 0, ask: row.pe.ask || 0 } : null,
    }));

    // ATM expected move (for SL/TP scaling).
    let atm = rows[0];
    let best = Infinity;
    for (const s of rows) { const dd = Math.abs(s.strike - spot); if (dd < best) { best = dd; atm = s; } }
    const atmCE = atm.ce?.ltp ?? 0, atmPE = atm.pe?.ltp ?? 0;
    const atmEM = (atmCE + atmPE) * (iv > 22 ? 1.2 : iv > 18 ? 1.1 : 1);
    const atmGamma = Math.max(atm.ce?.gamma ?? 0, atm.pe?.gamma ?? 0);

    let highestCallOI = 0, highestPutOI = 0, totalVolume = 0;
    for (const s of rows) {
      if (s.ce?.oi) highestCallOI = Math.max(highestCallOI, s.ce.oi);
      if (s.pe?.oi) highestPutOI = Math.max(highestPutOI, s.pe.oi);
      totalVolume += (s.ce?.volume ?? 0) + (s.pe?.volume ?? 0);
    }
    // Boost the ATM expected move by gamma (matches engine factor).
    const expectedMove = round2(atmEM * (atmGamma > 0.03 ? 1.05 : 1));

    let fiiLong = 50, fiiShort = 50, diiBuy = 50, diiSell = 50;
    if (fiiRes && fiiRes.ok) {
      const f = await fiiRes.json();
      const fiiClamp = Math.max(-2000, Math.min(2000, typeof f.fiiNet === "number" ? f.fiiNet : 0));
      fiiLong = Math.round(50 + (fiiClamp / 2000) * 50); fiiShort = 100 - fiiLong;
      const diiClamp = Math.max(-2000, Math.min(2000, typeof f.diiNet === "number" ? f.diiNet : 0));
      diiBuy = Math.round(50 + (diiClamp / 2000) * 50); diiSell = 100 - diiBuy;
    }

    const ctx: ChainContext = {
      spot, atmStrike, pcr, iv,
      highestCallOI, highestPutOI, totalVolume, chainLen: rows.length,
      fiiLong, fiiShort, diiBuy, diiSell, expectedMove,
    };

    // Rank EVERY near-ATM strike on both sides via the full strike model,
    // then return only the single best (or top-2 if statistically tied).
    const scanThreshold = spot * 0.03;
    const strikes: { strike: number; type: "CE" | "PE"; leg: StrikeLeg }[] = [];
    for (const s of rows) {
      if (Math.abs(s.strike - spot) > scanThreshold) continue;
      if (s.ce && s.ce.ltp > 0) strikes.push({ strike: s.strike, type: "CE", leg: s.ce });
      if (s.pe && s.pe.ltp > 0) strikes.push({ strike: s.strike, type: "PE", leg: s.pe });
    }

    const daysToExpiry = parseExpiryDays(d?.selectedExpiry || d?.expiries?.[0]?.date);
    const ranked = rankStrikes(strikes, ctx, { daysToExpiry });

    // Top-1 only, plus a 2nd if its probability is within TIE_MARGIN of #1.
    const chosen = ranked.slice(0, 1);
    if (ranked.length > 1 && ranked[0].probability - ranked[1].probability <= 4) {
      chosen.push(ranked[1]);
    }
    const top = chosen.map((c, i) => ({ rank: i + 1, ...c }));

    return NextResponse.json({ success: true, symbol, expectedMove, top });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "today-trades failed" }, { status: 500 });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
