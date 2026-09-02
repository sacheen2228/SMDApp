// app/api/ide/route.ts
//
// Institutional Derivatives Engine endpoint.
// Falls back to trade intelligence engine when live option chain is unavailable.

import { NextRequest, NextResponse } from "next/server";
import { runInstitutionalDerivativesEngine, type DerivativeInput, type StrikeLeg, type ChainContext } from "@/lib/institutional-derivatives-engine";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";
import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "NIFTY").toUpperCase();

  try {
    // Try live option chain first
    const [chainResult, fiiRes] = await Promise.all([
      fetchLiveOptionChain(symbol, undefined, req.signal),
      fetch(`${new URL(req.url).origin}/api/fii-dii`, { cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null),
    ]);

    // If live chain data is available, use the full IDE engine
    if (chainResult.success && chainResult.data && chainResult.data.data.length > 0) {
      const d = chainResult.data;
      const spot = d.summary.spotPrice;
      const atmStrike = d.summary.atmStrike;
      const pcr = d.summary.pcr;
      const iv = d.summary.indiaVIX ?? 15;
      const chain = d.data.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0, theta: row.ce.theta || 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0, theta: row.pe.theta || 0 } : null,
      }));

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

      let fiiLong = 50, fiiShort = 50, diiBuy = 50, diiSell = 50;
      if (fiiRes && fiiRes.ok) {
        const f = await fiiRes.json();
        const fiiClamp = Math.max(-2000, Math.min(2000, typeof f.fiiNet === "number" ? f.fiiNet : 0));
        fiiLong = Math.round(50 + (fiiClamp / 2000) * 50); fiiShort = 100 - fiiLong;
        const diiClamp = Math.max(-2000, Math.min(2000, typeof f.diiNet === "number" ? f.diiNet : 0));
        diiBuy = Math.round(50 + (diiClamp / 2000) * 50); diiSell = 100 - diiBuy;
      }

      const input: DerivativeInput = {
        spot, atm: atm.strike || atmStrike, ce: atmCE, pe: atmPE, pcr, iv,
        delta: atmDelta, gamma: atmGamma, vega: atmVega, theta: atmTheta,
        volumeRatio, callWriting: ceOiChg < 0, putWriting: peOiChg < 0,
        callUnwind: ceOiChg > 0, putUnwind: peOiChg > 0,
        fiiLong, fiiShort, diiBuy, diiSell, highestCallOI, highestPutOI,
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
      return NextResponse.json({ success: true, symbol, signal, expectedMove: Math.round(expectedMove * 100) / 100, source: "live-chain" });
    }

    // Fallback: use trade intelligence engine
    const ctx = await buildMarketIntelligenceContext();
    const signals = await analyzeIndexFO(ctx);
    const matched = signals.find(s => s.symbol === symbol) || signals[0];

    if (matched && matched.direction !== "NO_TRADE") {
      return NextResponse.json({
        success: true,
        symbol,
        signal: {
          symbol: matched.symbol,
          marketBias: matched.direction === "LONG" || matched.direction === "CALL" ? "BULLISH" : "BEARISH",
          action: matched.direction,
          recommendation: {
            action: matched.direction,
            strike: matched.strike || matched.entry,
            strikeType: matched.direction === "CALL" || matched.direction === "PUT" ? matched.direction === "CALL" ? "CE" : "PE" : "FUT",
            entry: matched.entry,
            stopLoss: matched.stopLoss,
            target1: matched.target1,
            target2: matched.target2,
            target3: matched.target2 * 1.1,
            riskReward: matched.riskReward,
            reasons: matched.reasoning,
          },
          confidence: {
            total: matched.confidence,
            level: matched.confidence >= 80 ? "HIGH" : matched.confidence >= 60 ? "MODERATE" : "LOW",
          },
          oi: { pcr: ctx.nifty?.pcr || 1, maxPain: ctx.nifty?.maxPain || 0 },
          greeks: { dealerRegime: "NEUTRAL" },
          flow: { volumeSpike: false, institutionalOrders: false },
          smartMoney: { liquiditySweep: { detected: false } },
          alerts: [],
          zeroDte: { active: false },
          factors: matched.factors,
          reasoning: matched.reasoning,
        },
        expectedMove: 0,
        source: "trade-intelligence",
      });
    }

    // No data at all — return contextual info instead of error
    return NextResponse.json({
      success: true,
      symbol,
      signal: {
        symbol,
        marketBias: ctx.regime.trend || "NEUTRAL",
        action: "NO_TRADE",
        recommendation: {
          action: "NO_TRADE",
          strike: 0,
          strikeType: "N/A",
          entry: 0,
          stopLoss: 0,
          target1: 0,
          target2: 0,
          target3: 0,
          riskReward: 0,
          reasons: ["No high-conviction setup available", `Market regime: ${ctx.regime.regime}`, `Breadth: ${ctx.breadth.breadthScore}/100`, `FII: ${ctx.fiiDii.fii.net > 0 ? "inflow" : ctx.fiiDii.fii.net < 0 ? "outflow" : "neutral"}`],
        },
        confidence: { total: 0, level: "NO_TRADE" },
        oi: { pcr: ctx.nifty?.pcr || 1, maxPain: ctx.nifty?.maxPain || 0 },
        greeks: { dealerRegime: "NEUTRAL" },
        flow: { volumeSpike: false, institutionalOrders: false },
        smartMoney: { liquiditySweep: { detected: false } },
        alerts: [],
        zeroDte: { active: false },
        factors: {},
        reasoning: ["Live option chain data unavailable", "Showing market context from trade intelligence engine"],
      },
      expectedMove: 0,
      source: "context-fallback",
    });
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
