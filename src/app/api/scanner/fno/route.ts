// /api/scanner/fno — F&O scanner over the NIFTY F&O universe.
//
// Honesty notes (2026-10-20 audit) — this route used to fabricate almost
// every metric it showed:
//   • `avgVolume = stock.volume * 0.8` (or 500 000 when the quote was missing)
//   • `currentIv  = chain.indiaVIX || 25`  ← the INDEX VIX was used as each
//     STOCK's IV, and 25 was the fallback
//   • `estimatePremiumVelocity(oiChg * 10 || 50_000, volume || 1_000_000,
//     ltp || 1000)` — invented OI, volume and price
//   • `priceMomentum = 50 + changePct * 10` and `sectorStrength = 50 + …`
//     were produced even for symbols that had NO quote at all (ltp 0)
//   • `oiChg` came from the TARGET index's chain and was applied to every
//     stock, so "Long Buildup" was really the NIFTY's OI change
//   • the IV "percentile" was a fixed 10…60 band, not a percentile
//
// Every metric below now comes from the symbol's OWN real chain + the real
// quote. A symbol without both is reported as unavailable, never scored.

import { NextRequest, NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";
import { fetchAllOptionChains } from "@/lib/breeze-fno-data";
import type { OptionChainSnapshot } from "@/lib/auction-types";
import { buildCardMeta, getMarketClock, round } from "@/lib/data-freshness";

interface ScanCandidate {
  symbol: string;
  name: string;
  sector: string;
  ltp: number | null;
  changePct: number | null;
  volume: number | null;
  score: number | null;
  signals: string[];
  metrics: {
    oiSignal: string;
    /** Real OI change of this symbol's own chain (contracts). */
    oiChange: number | null;
    /** Real PCR of this symbol's own chain. */
    pcr: number | null;
    /** Real ATM IV (%) of this symbol's own chain. */
    atmIV: number | null;
    /** ATM IV's percentile inside this expiry's own IV distribution. */
    ivPercentile: number | null;
    /** Traded contracts / open interest on the chain (real). */
    premiumVelocity: number | null;
    unusualVolume: boolean | null;
    /** Real session move (%) — the raw number, not a synthetic score. */
    priceMomentumPct: number | null;
    /** Real sector average move (%). */
    sectorStrengthPct: number | null;
    relVolume: number | null;
    maxPain: number | null;
    atmStrike: number | null;
    expiry: string | null;
    chainSource: string | null;
    chainAsOf: string | null;
  };
}

/** OI classification from the symbol's OWN chain + its real price move. */
function calculateOISignal(oiChg: number | null, priceChange: number | null): {
  signal: string;
  score: number | null;
} {
  if (oiChg == null || priceChange == null) return { signal: "N/A", score: null };
  if (oiChg > 0 && priceChange > 0) return { signal: "Long Buildup", score: 80 };
  if (oiChg > 0 && priceChange < 0) return { signal: "Short Buildup", score: 30 };
  if (oiChg < 0 && priceChange > 0) return { signal: "Short Covering", score: 70 };
  if (oiChg < 0 && priceChange < 0) return { signal: "Long Unwinding", score: 40 };
  return { signal: "Neutral", score: 50 };
}

/** Total OI change (calls + puts) of the symbol's own chain. */
function chainOiChange(chain: OptionChainSnapshot): number | null {
  let total = 0;
  let any = false;
  for (const v of chain.callOiChangeMap.values()) { total += v || 0; any = true; }
  for (const v of chain.putOiChangeMap.values()) { total += v || 0; any = true; }
  return any ? total : null;
}

/** Traded contracts vs open interest on the chain (real). */
function chainVolumeOiRatio(chain: OptionChainSnapshot): number | null {
  let volume = 0;
  let oi = 0;
  for (const v of chain.callVolumeMap.values()) volume += v || 0;
  for (const v of chain.putVolumeMap.values()) volume += v || 0;
  for (const v of chain.callOiMap.values()) oi += v || 0;
  for (const v of chain.putOiMap.values()) oi += v || 0;
  if (!volume || !oi) return null;
  return round(volume / oi, 2);
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const targetSymbol = searchParams.get("symbol") || "NIFTY";
    const minScore = parseInt(searchParams.get("minScore") || "60", 10);

    const { FNO_SCAN_UNIVERSE } = await import("@/lib/sdm-chain-scanner");
    const topFnoSymbols: string[] = FNO_SCAN_UNIVERSE;

    const stocks = await fetchNIFTY50Stocks();
    const stockMap = new Map(stocks.map((s) => [s.symbol, s]));

    // Real per-symbol chains (Breeze → NSE). Empty map when both are down.
    const spotBySymbol = new Map<string, number>();
    for (const sym of topFnoSymbols) {
      const q = stockMap.get(sym);
      if (q?.ltp) spotBySymbol.set(sym, q.ltp);
    }
    const chains = await fetchAllOptionChains(topFnoSymbols, spotBySymbol);

    // Real sector averages (from the quotes we actually have)
    const sectorAverages: Record<string, number> = {};
    const sectorCounts: Record<string, number> = {};
    for (const stock of stocks) {
      if (sectorAverages[stock.sector] == null) sectorAverages[stock.sector] = 0;
      sectorAverages[stock.sector] += stock.changePct;
      sectorCounts[stock.sector] = (sectorCounts[stock.sector] || 0) + 1;
    }
    for (const sec of Object.keys(sectorAverages)) {
      const count = sectorCounts[sec];
      sectorAverages[sec] = count > 0 ? sectorAverages[sec] / count : 0;
    }

    const candidates: ScanCandidate[] = [];

    for (const symbol of topFnoSymbols) {
      const stock = stockMap.get(symbol);
      const chain = chains.get(symbol) || null;

      // No quote → no price, no score. The row is still listed, but with
      // nulls (the card shows "no quote"), never a synthetic 0.
      const hasQuote = !!stock && stock.ltp > 0;
      const ltp = hasQuote ? stock!.ltp : null;
      const changePct = hasQuote ? stock!.changePct : null;
      const volume = hasQuote ? stock!.volume : null;

      // Real relative volume: exchange-published 20-session average.
      const avgVolume = hasQuote ? stock!.avgVolume || null : null;
      const relVolume =
        volume != null && avgVolume != null && avgVolume > 0 ? round(volume / avgVolume) : null;
      const unusualVol =
        volume == null || avgVolume == null || avgVolume === 0 ? null : volume > avgVolume * 2;

      const oiChange = chain ? chainOiChange(chain) : null;
      const oiAnalysis = calculateOISignal(oiChange, changePct);
      const pcr = chain && chain.pcr > 0 ? round(chain.pcr) : null;
      const atmIV = chain && chain.atmIV > 0 ? chain.atmIV : null;
      const ivPercentile = chain && chain.ivPercentile > 0 ? chain.ivPercentile : null;
      const premiumVel = chain ? chainVolumeOiRatio(chain) : null;
      const sectorAvg = hasQuote ? sectorAverages[stock!.sector] : null;

      // Score: only from inputs that exist. Missing inputs are dropped and
      // the remaining weights are re-normalised.
      const priceScore = changePct == null ? null : Math.min(100, Math.max(0, 50 + changePct * 10));
      const sectorScore = sectorAvg == null ? null : Math.min(100, Math.max(0, 50 + sectorAvg * 5));
      const volumeScore =
        relVolume == null ? null : Math.min(100, Math.max(0, relVolume * 50));
      const ivScore = ivPercentile;
      const parts: Array<{ w: number; v: number | null }> = [
        { w: 0.3, v: oiAnalysis.score },
        { w: 0.2, v: ivScore },
        { w: 0.2, v: volumeScore },
        { w: 0.15, v: priceScore },
        { w: 0.15, v: sectorScore },
      ];
      const usable = parts.filter((p) => p.v != null) as Array<{ w: number; v: number }>;
      const weightSum = usable.reduce((s, p) => s + p.w, 0);
      const score =
        usable.length && weightSum > 0
          ? Math.round(usable.reduce((s, p) => s + p.v! * p.w, 0) / weightSum)
          : null;

      const signals: string[] = [];
      if (oiAnalysis.signal !== "Neutral" && oiAnalysis.signal !== "N/A") signals.push(oiAnalysis.signal);
      if (unusualVol === true) signals.push("Unusual Volume");
      if (changePct != null && changePct > 2) signals.push("Strong Momentum");
      if (changePct != null && changePct < -2) signals.push("Weakness");
      if (ivPercentile != null && ivPercentile > 70) signals.push("High IV");

      // Rupee-risk stop & targets: 20% of LTP risk → 2R / 3R ladder.
      // The stop sits on the OPPOSITE side of the trade from the targets:
      //   PUT  (bearish): stop above, targets below
      //   CALL (bullish): stop below, targets above
      // (The old code used 3.9R for TP1 and 2.0R for TP2 — an INVERTED ladder
      // where the first target sat further away than the second.)
      const riskPct = 0.20;
      const riskAmount = ltp * riskPct;
      const isBullish = changePct != null && changePct > 0;
      const isPut = !isBullish;
      const stopSide = isPut ? 1 : -1;   // +1 = stop above entry
      const targetSide = -stopSide;      // targets on the other side
      const stopMove = riskAmount * stopSide;
      const tp1Move = riskAmount * 2 * targetSide;   // 2R
      const tp2Move = riskAmount * 3 * targetSide;   // 3R

candidates.push({
        symbol,
        name: stock?.name || symbol,
        sector: stock?.sector || "Other",
        ltp,
        changePct,
        volume,
        score,
        stopLoss: Number(Math.max(ltp + stopMove, 0.05).toFixed(2)),
        tp1: Number((ltp + tp1Move).toFixed(2)),
        tp2: Number((ltp + tp2Move).toFixed(2)),
        rr: 2,
        signals,
        metrics: {
          oiSignal: oiAnalysis.signal,
          oiChange,
          pcr,
          atmIV,
          ivPercentile,
          premiumVelocity: premiumVel,
          unusualVolume: unusualVol,
          priceMomentumPct: changePct,
          sectorStrengthPct: sectorAvg == null ? null : round(sectorAvg),
          relVolume,
          maxPain: chain?.maxPain ?? null,
          atmStrike: chain?.atmStrike ?? null,
          expiry: chain?.expiry || null,
          chainSource: chain?.source ?? null,
          chainAsOf: chain?.asOf ?? null,
        },
      });
    }

    // Only rows with a real quote AND a real score can be "candidates".
    const scored = candidates.filter((c) => c.score != null && c.ltp != null);
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const filtered = scored.filter((c) => (c.score ?? 0) >= minScore);

    const clock = await getMarketClock();
    const chainsResolved = topFnoSymbols.filter((s) => chains.get(s)).length;
    const meta = buildCardMeta({
      source: chainsResolved ? "nse" : "none",
      providerTimestamp: clock.tradeDate,
      ttlMs: 5 * 60_000,
      live: clock.isOpen,
      reason: clock.isOpen
        ? chainsResolved === 0
          ? "No option chain resolved for the F&O universe"
          : undefined
        : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    return NextResponse.json({
      symbol: targetSymbol,
      minScore,
      candidates: filtered,
      total: filtered.length,
      scanned: topFnoSymbols.length,
      // Real coverage — how many names had a quote / a chain.
      coverage: {
        quoted: candidates.filter((c) => c.ltp != null).length,
        chained: chainsResolved,
        requested: topFnoSymbols.length,
        complete: chainsResolved === topFnoSymbols.length,
      },
      // Every symbol, so the card can show "unavailable" rows honestly.
      all: candidates,
      status: meta.status,
      meta,
      chainSource: chainsResolved ? "nse/breeze" : "none",
      marketClock: {
        state: clock.marketState,
        isOpen: clock.isOpen,
        tradeDateLabel: clock.tradeDateLabel,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: "UNAVAILABLE", error: err.message || "F&O scan failed" },
      { status: 500 },
    );
  }
}
