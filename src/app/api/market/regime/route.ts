// Market Regime API — Multi-factor regime detection
// Factors: Index trend, Breadth, Sector breadth, Volume, VWAP, EMA structure, Momentum, Volatility
//
// Provenance rules (2026-10-20 audit):
//   • Index levels come from the EXCHANGE (NSE allIndices; BSE for SENSEX).
//     Yahoo is banned (SOP §1) and Moneycontrol's index feed answers
//     "invalid combination" — both fallbacks are gone. An index that the
//     exchange does not publish is reported as UNAVAILABLE, never estimated
//     from an average of its constituents (an average of share prices is not
//     an index level).
//   • VIX comes from NSE. When NSE does not publish it, `vix` is null and the
//     volatility factor is DROPPED from the composite — it used to default to
//     15, which is a real number that changes the regime verdict.
//   • EMA structure and VWAP participation come from the exchange's own daily
//     history. They used to be fakes: ema20 = prevClose + change*0.3,
//     ema50 = ema200 = prevClose, vwap = (high+low+ltp)/3.

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks, getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { sweepDailyTechnicals } from "@/lib/daily-bars";
import { buildFreshnessMeta, withSessionAwareFreshness } from "@/lib/api-freshness";
import { getNSEIndiaVIX, getNSEIndices } from "@/lib/nse-api";
import { getTradingSession } from "@/lib/expiry-liquidity/market-session-config";
import { buildCardMeta, getMarketClock, round } from "@/lib/data-freshness";

const INDICES = [
  { key: "NIFTY", name: "NIFTY 50" },
  { key: "BANKNIFTY", name: "BANK NIFTY" },
  { key: "SENSEX", name: "SENSEX" },
  { key: "FINNIFTY", name: "FIN NIFTY" },
];

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

interface RegimeFactors {
  indexTrend: number | null;       // -100 to +100
  breadth: number | null;          // -100 to +100
  sectorBreadth: number | null;    // -100 to +100
  volume: number | null;           // -100 to +100
  vwapParticipation: number | null; // -100 to +100
  emaStructure: number | null;     // -100 to +100
  momentum: number | null;         // -100 to +100
  volatility: number | null; // 0 to 100 (VIX-based) — null when VIX unknown
  foPositioning: number | null; // null: no real participant-OI input
}

const FACTOR_WEIGHTS = {
  indexTrend: 0.20,
  breadth: 0.15,
  sectorBreadth: 0.15,
  volume: 0.10,
  vwapParticipation: 0.10,
  emaStructure: 0.10,
  momentum: 0.10,
  volatility: 0.05,
  foPositioning: 0.05,
};

function calculateRegime(factors: RegimeFactors, vix: number | null): {
  regime: string;
  bias: string;
  tradeEnv: string;
  score: number | null;
  usedFactors: string[];
} {
  // Weighted composite score over the factors that actually have data.
  const used: string[] = [];
  let weightSum = 0;
  let scoreSum = 0;
  for (const [key, weight] of Object.entries(FACTOR_WEIGHTS) as Array<[keyof RegimeFactors, number]>) {
    const value = factors[key];
    if (value == null || !Number.isFinite(value)) continue;
    used.push(key);
    weightSum += weight;
    scoreSum += value * weight;
  }
  if (weightSum === 0) {
    return { regime: "UNKNOWN", bias: "UNKNOWN", tradeEnv: "NO DATA — cannot classify the regime", score: null, usedFactors: [] };
  }
  const compositeScore = scoreSum / weightSum;

  // VIX override for high volatility (only when VIX is real)
  if (vix != null && vix > 30) {
    return {
      regime: "HIGH VOLATILITY",
      bias: "NEUTRAL",
      tradeEnv: "EXTREME CAUTION — REDUCE SIZE / STAY OUT",
      score: Math.round(compositeScore),
      usedFactors: used,
    };
  }
  if (vix != null && vix > 25) {
    return {
      regime: "HIGH VOLATILITY",
      bias: compositeScore > 0 ? "BULLISH" : "BEARISH",
      tradeEnv: "CAUTION — REDUCE SIZE",
      score: Math.round(compositeScore),
      usedFactors: used,
    };
  }

  let regime: string;
  let bias: string;
  let tradeEnv: string;

  if (compositeScore > 40) {
    regime = "STRONG BULLISH";
    bias = "BULLISH";
    tradeEnv = "FAVOR LONGS — AGGRESSIVE";
  } else if (compositeScore > 15) {
    regime = "BULLISH";
    bias = "BULLISH";
    tradeEnv = "FAVOR LONGS";
  } else if (compositeScore > -15) {
    regime = "NEUTRAL";
    bias = "NEUTRAL";
    tradeEnv = "SELECTIVE — WAIT FOR CLARITY";
  } else if (compositeScore > -40) {
    regime = "BEARISH";
    bias = "BEARISH";
    tradeEnv = "FAVOR SHORTS";
  } else {
    regime = "STRONG BEARISH";
    bias = "BEARISH";
    tradeEnv = "FAVOR SHORTS — DEFENSIVE";
  }

  return { regime, bias, tradeEnv, score: Math.round(compositeScore), usedFactors: used };
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    // Step 1: Fetch stocks (needed for breadth) + the exchange market clock.
    const [stocks, clock] = await Promise.all([fetchNIFTY50Stocks(), getMarketClock()]);

    // Step 2: Indices (exchange only) + VIX (NSE only) in parallel.
    const [indexData, vixData] = await Promise.all([
      (async () => {
        const nseIndices = await getNSEIndices();
        const result: any[] = [];
        for (const idx of INDICES) {
          const nseIdx = nseIndices.find((n) => n.key === idx.key);
          if (nseIdx) {
            result.push({ ...nseIdx, source: "nse" });
            continue;
          }
          // SENSEX lives on BSE.
          if (idx.key === "SENSEX") {
            try {
              const { getBSEIndexData } = await import("@/lib/bse-api");
              const bse = await getBSEIndexData("SENSEX");
              if (bse && bse.spotPrice && bse.previousClose) {
                const ltp = Number(bse.spotPrice);
                const prev = Number(bse.previousClose);
                result.push({
                  key: "SENSEX",
                  name: "SENSEX",
                  ltp,
                  change: round(ltp - prev),
                  changePct: round(((ltp - prev) / prev) * 100),
                  prevClose: prev,
                  source: "bse",
                });
              }
            } catch { /* BSE unavailable → SENSEX stays absent (honest) */ }
          }
        }
        return result;
      })(),

      (async () => {
        const nseVix = await getNSEIndiaVIX();
        if (nseVix && nseVix.value > 0) return { ...nseVix, source: "nse" };
        return null;
      })(),
    ]);

    const vix = vixData?.value ?? null;

    // Real technicals from the exchange's daily history (EMA + session VWAP).
    const tech = await sweepDailyTechnicals(stocks.map((s) => s.symbol), { deadlineMs: 12_000 });

    // ── 1. Index Trend ───────────────────────────────────────────────
    const indexChanges = indexData.map((i) => i.changePct);
    const avgIndexChange = indexChanges.length
      ? indexChanges.reduce((sum, c) => sum + c, 0) / indexChanges.length
      : null;
    const trendConsistency = indexChanges.length
      ? indexChanges.filter((c) => c > 0).length / indexChanges.length
      : null;
    const indexTrend =
      avgIndexChange != null && trendConsistency != null
        ? avgIndexChange * 10 + (trendConsistency - 0.5) * 40
        : null;

    // ── 2. Market Breadth (real quotes) ───────────────────────────────
    const advances = stocks.filter((s) => s.changePct > 0).length;
    const declines = stocks.filter((s) => s.changePct < 0).length;
    const total = stocks.length;
    const breadthRatio = declines > 0 ? advances / declines : advances > 0 ? null : null;
    const breadth = breadthRatio == null ? null : Math.max(-100, Math.min(100, (breadthRatio - 1) * 50));

    // ── 3. Sector Breadth ─────────────────────────────────────────────
    const sectorMap = new Map<string, number[]>();
    for (const s of stocks) {
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, []);
      sectorMap.get(s.sector)!.push(s.changePct);
    }
    const sectorBiases = Array.from(sectorMap.values()).map((changes) => {
      const pos = changes.filter((c) => c > 0).length;
      const neg = changes.filter((c) => c < 0).length;
      return (pos - neg) / (pos + neg);
    });
    const sectorBreadth = sectorBiases.length
      ? (sectorBiases.reduce((sum, b) => sum + b, 0) / sectorBiases.length) * 100
      : null;

    // ── 4. Volume ─────────────────────────────────────────────────────
    const volAdvancing = stocks.filter((s) => s.changePct > 0).reduce((sum, s) => sum + s.volume, 0);
    const volDeclining = stocks.filter((s) => s.changePct < 0).reduce((sum, s) => sum + s.volume, 0);
    const volume = volDeclining > 0 ? Math.max(-100, Math.min(100, ((volAdvancing / volDeclining) - 1) * 50)) : null;

    // ── 5. VWAP Participation (the exchange's own session VWAP) ────────
    const vwapRows = stocks.filter((s) => tech.bySymbol.get(s.symbol)?.vwap != null);
    const aboveVWAP = vwapRows.filter((s) => s.ltp > (tech.bySymbol.get(s.symbol)!.vwap as number)).length;
    const vwapParticipation = vwapRows.length ? (aboveVWAP / vwapRows.length) * 200 - 100 : null;

    // ── 6. EMA Structure (real EMAs of real closes) ───────────────────
    const emaRows = stocks.filter((s) => {
      const t = tech.bySymbol.get(s.symbol);
      return t?.ema20 != null && t?.ema50 != null && t?.ema200 != null;
    });
    const emaScore = emaRows.length
      ? (emaRows.reduce((sum, s) => {
          const t = tech.bySymbol.get(s.symbol)!;
          const above = (s.ltp > (t.ema20 as number) ? 1 : 0) + (s.ltp > (t.ema50 as number) ? 1 : 0) + (s.ltp > (t.ema200 as number) ? 1 : 0);
          return sum + above / 3;
        }, 0) / emaRows.length) * 200 - 100
      : null;

    // ── 7. Momentum ───────────────────────────────────────────────────
    const strongMomentum = stocks.filter((s) => s.changePct > 2).length;
    const weakMomentum = stocks.filter((s) => s.changePct < -2).length;
    const momentum = total > 0 ? ((strongMomentum - weakMomentum) / total) * 100 : null;

    // ── 8. Volatility (VIX-based; null when VIX is unavailable) ──────
    const volatility = vix == null ? null : Math.max(0, 100 - vix * 3);

    // ── 9. F&O Positioning — no real participant-OI input on this path ─
    const foPositioning: number | null = null;

    // ── 10. ADX proxy from the real breadth spread ────────────────────
    const absChanges = stocks.map((s) => Math.abs(s.changePct));
    const avgAbsChange = absChanges.length ? absChanges.reduce((a, b) => a + b, 0) / absChanges.length : null;
    const avgAdx = avgAbsChange == null ? null : Math.min(50, Math.max(10, avgAbsChange * 8 + 10));

    const factors: RegimeFactors = {
      indexTrend: indexTrend ?? null,
      breadth: breadth ?? null,
      sectorBreadth: sectorBreadth ?? null,
      volume: volume ?? null,
      vwapParticipation: vwapParticipation ?? null,
      emaStructure: emaScore ?? null,
      momentum: momentum ?? null,
      volatility,
      foPositioning,
    };

    const regimeResult = calculateRegime(factors, vix);

    const session = getTradingSession();

    // Collected just now — but "now" is outside market hours on a weekend /
    // holiday / after-hours. LIVE is only truthful while the exchange is open.
    const freshness = withSessionAwareFreshness(
      buildFreshnessMeta({
        provider: indexData.some((i: any) => i.source === "bse") ? "nse+bse" : "nse-india",
        dataTimestamp: clock.tradeDate ? new Date(clock.tradeDate) : new Date(),
        dataType: "regime",
      }),
      session,
    );

    const nifty = indexData.find((i) => i.key === "NIFTY");
    const bankNifty = indexData.find((i) => i.key === "BANKNIFTY");

    const prov = getStockQuoteProvenance();
    const cardMeta = buildCardMeta({
      source: prov.source === "moneycontrol" ? "moneycontrol" : "nse",
      providerTimestamp: prov.providerTimestamp ?? clock.tradeDate ?? null,
      ttlMs: 90_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const result = {
      regime: regimeResult.regime,
      bias: regimeResult.bias,
      tradeEnv: regimeResult.tradeEnv,
      regimeScore: regimeResult.score,
      // Which factors actually carried the verdict (null factors are dropped).
      factorsUsed: regimeResult.usedFactors,
      factorsUnavailable: (Object.keys(FACTOR_WEIGHTS) as Array<keyof RegimeFactors>).filter(
        (k) => !regimeResult.usedFactors.includes(k),
      ),
      freshness,
      data: cardMeta,
      marketClock: {
        state: clock.marketState,
        isOpen: clock.isOpen,
        tradeDate: clock.tradeDate,
        tradeDateLabel: clock.tradeDateLabel,
        ageMs: clock.tradeAgeMs,
      },
      // VIX Regime for Option Buyers (Section 5C)
      vixBuyerRegime: vix == null
        ? "UNKNOWN"
        : vix < 12 ? "COMPLACENT"
        : vix < 15 ? "CALM"
        : vix < 20 ? "NORMAL"
        : vix < 25 ? "ELEVATED" : "FEAR",
      vixBuyerAction: vix == null
        ? "NO DATA — VIX unavailable, do not size option trades off this"
        : vix < 12 ? "BEST buying zone — premiums cheap"
        : vix < 15 ? "Good directional buys with confluence"
        : vix < 20 ? "Only score >= 75 setups"
        : vix < 25 ? "Half size, ATM/ITM only"
        : "NO TRADE — expensive premiums + whipsaw",
      // ADX Regime (Section 5F)
      adxRegime: avgAdx == null ? "UNKNOWN" : avgAdx > 25 ? "TRENDING" : avgAdx < 20 ? "CHOPPY" : "MODERATE",
      adxAction: avgAdx == null
        ? "NO DATA — breadth unavailable"
        : avgAdx > 25 ? "Directional CE/PE buying allowed"
        : avgAdx < 20 ? "NO TRADE unless extreme + rejection"
        : "Selective buying with higher confluence",
      factors: {
        indexTrend: round(indexTrend, 0),
        breadth: round(breadth, 0),
        sectorBreadth: round(sectorBreadth, 0),
        volume: round(volume, 0),
        vwapParticipation: round(vwapParticipation, 0),
        emaStructure: round(emaScore, 0),
        momentum: round(momentum, 0),
        volatility: volatility == null ? null : round(volatility, 0),
        foPositioning: null,
      },
      coverage: {
        quotes: stocks.length,
        technicals: tech.covered,
        requested: stocks.length,
        complete: tech.complete,
        indices: indexData.length,
        indicesExpected: INDICES.length,
      },
      session,
      vix: vix == null ? null : { value: vix, change: vixData?.change ?? null, source: "nse" },
      indices: indexData,
      nifty: nifty?.ltp ?? null,
      niftyChange: nifty?.changePct ?? null,
      bankNifty: bankNifty?.ltp ?? null,
      bankNiftyChange: bankNifty?.changePct ?? null,
      avgIndexChange: round(avgIndexChange),
      timestamp: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Regime fetch failed" }, { status: 500 });
  }
}
