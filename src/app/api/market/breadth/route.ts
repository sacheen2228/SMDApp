// Market Breadth API — Advance/Decline, % above EMAs/VWAP, Relative Volume, new highs/lows
//
// Every number here is derived from real data:
//   • quotes        → exchange/free feed quotes (NSE index lists → Moneycontrol)
//   • EMA20/50/200  → the exchange's OWN daily history (EMA of real closes)
//   • VWAP          → the exchange's published session VWAP
//   • RVOL          → real session volume vs the real 20-session average
//
// The previous implementation faked three of those:
//   aboveEMA20 = ltp > prevClose + change*0.3      (not an EMA)
//   aboveEMA50 = ltp > prevClose                   (not an EMA)
//   aboveEMA200= ltp > prevClose * 0.95            (not an EMA)
//   aboveVWAP  = (high + low + ltp) / 3            (a typical price, not a VWAP)
//   avgVolume  = 2_000_000                        (a constant)
// …and the failure path returned `score: 0, advances: 0, declines: 0`, which the
// dashboard rendered as a real "0 breadth" reading.
//
// When a feed is missing the card now gets an explicit UNAVAILABLE state with
// the reason, plus source + age for whatever IS real.

import { NextResponse } from "next/server";
import { getBreadthData, fetchNIFTY50Stocks, getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { sweepDailyTechnicals } from "@/lib/daily-bars";
import {
  buildCardMeta,
  unavailableMeta,
  getMarketClock,
  pct,
  round,
  type CardMeta,
} from "@/lib/data-freshness";

const QUOTE_TTL_MS = 90_000;

function weightedScore(parts: Array<{ weight: number; value: number | null }>): number | null {
  const usable = parts.filter((p) => p.value != null) as Array<{ weight: number; value: number }>;
  if (!usable.length) return null;
  const totalWeight = usable.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return null;
  const sum = usable.reduce((s, p) => s + p.value * p.weight, 0);
  return Math.round(sum / totalWeight);
}

export async function GET() {
  try {
    const [breadth, stocks, clock] = await Promise.all([
      getBreadthData(),
      fetchNIFTY50Stocks(),
      getMarketClock(),
    ]);

    if (stocks.length === 0) {
      const meta = unavailableMeta(
        "No quotes available from the exchange feeds (NSE index lists / Moneycontrol).",
        "nse",
      );
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: meta.reason,
        source: meta.source,
        timestamp: meta.collectedAt,
        providerTimestamp: meta.providerTimestamp,
        freshness: {
          provider: meta.source,
          source: meta.source,
          timestamp: meta.providerTimestamp ?? meta.collectedAt,
          ageMs: meta.ageMs,
          freshness: "UNAVAILABLE",
          delayed: true,
          fallbackUsed: false,
        },
        quality: "UNKNOWN",
        data: meta,
        breadth: null,
        stocks: [],
      });
    }

    const prov = getStockQuoteProvenance();
    const symbols = stocks.map((s) => s.symbol);

    // Real technicals from the exchange's daily history.
    const tech = await sweepDailyTechnicals(symbols, { deadlineMs: 12_000 });

    const { advances, declines, unchanged, total, newHighs, newLows, volAdvancing, volDeclining, topGainers, topLosers } = breadth;

    // ── EMA participation (REAL EMA of real closes) ───────────────────
    const ema20Rows = stocks.filter((s) => tech.bySymbol.get(s.symbol)?.ema20 != null);
    const ema50Rows = stocks.filter((s) => tech.bySymbol.get(s.symbol)?.ema50 != null);
    const ema200Rows = stocks.filter((s) => tech.bySymbol.get(s.symbol)?.ema200 != null);
    const aboveEMA20 = ema20Rows.filter((s) => s.ltp > (tech.bySymbol.get(s.symbol)!.ema20 as number)).length;
    const aboveEMA50 = ema50Rows.filter((s) => s.ltp > (tech.bySymbol.get(s.symbol)!.ema50 as number)).length;
    const aboveEMA200 = ema200Rows.filter((s) => s.ltp > (tech.bySymbol.get(s.symbol)!.ema200 as number)).length;

    // ── VWAP participation (the exchange's own session VWAP) ─────────
    const vwapRows = stocks.filter((s) => tech.bySymbol.get(s.symbol)?.vwap != null);
    const aboveVWAP = vwapRows.filter((s) => s.ltp > (tech.bySymbol.get(s.symbol)!.vwap as number)).length;

    // ── Relative volume (real session volume vs real 20-session mean) ─
    const relVolRows = stocks.filter((s) => {
      const t = tech.bySymbol.get(s.symbol);
      return t?.avgVolume20 != null && t.avgVolume20 > 0 && s.volume > 0;
    });
    const relVolOf = (s: (typeof stocks)[number]) => {
      const avg = tech.bySymbol.get(s.symbol)?.avgVolume20 ?? 0;
      return avg > 0 ? s.volume / avg : null;
    };
    const highRelVol = relVolRows.filter((s) => (relVolOf(s) ?? 0) > 2).length;
    const elevatedRelVol = relVolRows.filter((s) => {
      const rv = relVolOf(s) ?? 0;
      return rv > 1.5 && rv <= 2;
    }).length;
    const normalRelVol = relVolRows.filter((s) => {
      const rv = relVolOf(s) ?? 0;
      return rv >= 0.8 && rv <= 1.5;
    }).length;
    const lowRelVol = relVolRows.filter((s) => (relVolOf(s) ?? 0) < 0.8).length;

    // Volume advancing/declining
    const volRatio = volDeclining > 0 ? volAdvancing / volDeclining : volAdvancing > 0 ? null : null;

    // New 52W High/Low percentages
    const newHighsPct = pct(newHighs, total);
    const newLowsPct = pct(newLows, total);

    // Intraday highs/lows (stocks making fresh day highs/lows)
    const freshDayHighs = stocks.filter((s) => s.dayHigh > 0 && Math.abs(s.ltp - s.dayHigh) / s.dayHigh < 0.005).length;
    const freshDayLows = stocks.filter((s) => s.dayLow > 0 && Math.abs(s.ltp - s.dayLow) / s.dayLow < 0.005).length;

    // Breadth scoring — every sub-score is optional; missing inputs are
    // dropped from the weighted average instead of being faked as 50.
    const adRatio = declines > 0 ? advances / declines : advances > 0 ? null : null;
    const adScore =
      adRatio == null ? null : Math.min(100, Math.round((adRatio / 3) * 100));
    const volScore =
      volDeclining > 0 ? Math.min(100, Math.round((volAdvancing / volDeclining) * 50)) : null;
    const highLowScore =
      total > 0 ? Math.min(100, Math.round(((newHighs - newLows + total) / (2 * total)) * 100)) : null;
    const emaScore =
      ema20Rows.length > 0 ? Math.min(100, Math.round((aboveEMA20 / ema20Rows.length) * 100)) : null;
    const vwapScore =
      vwapRows.length > 0 ? Math.min(100, Math.round((aboveVWAP / vwapRows.length) * 100)) : null;
    const relVolScore =
      relVolRows.length > 0
        ? Math.min(100, Math.round(((highRelVol + elevatedRelVol) / relVolRows.length) * 100))
        : null;

    const breadthScore = weightedScore([
      { weight: 0.25, value: adScore },
      { weight: 0.20, value: volScore },
      { weight: 0.15, value: highLowScore },
      { weight: 0.15, value: emaScore },
      { weight: 0.15, value: vwapScore },
      { weight: 0.10, value: relVolScore },
    ]);

    let label: string | null = null;
    if (breadthScore != null) {
      if (breadthScore >= 75) label = "STRONG BULLISH";
      else if (breadthScore >= 60) label = "BULLISH";
      else if (breadthScore >= 40) label = "NEUTRAL";
      else if (breadthScore >= 25) label = "BEARISH";
      else label = "STRONG BEARISH";
    }

    // ── Provenance ────────────────────────────────────────────────────
    // The quote feed is the primary input; the technicals come from the
    // exchange's daily history. The card reports the OLDEST input, because
    // that is the one that can make the reading stale.
    // The quote provider publishes its own stamp (Moneycontrol `lastupd`);
    // when a feed is undated the exchange's own trade date is used instead.
    const quoteStamp = prov.providerTimestamp ?? clock.tradeDate ?? null;
    const quoteMeta = buildCardMeta({
      source: prov.source === "moneycontrol" ? "moneycontrol" : "nse",
      providerTimestamp: quoteStamp,
      ttlMs: QUOTE_TTL_MS,
      live: clock.isOpen,
      reason: clock.isOpen
        ? undefined
        : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });
    const techMeta = buildCardMeta({
      source: "nse",
      providerTimestamp: tech.newestBarAt,
      ttlMs: 36 * 3600_000,
      live: clock.isOpen,
      reason: tech.newestBarAt
        ? clock.isOpen
          ? undefined
          : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`
        : "No daily history returned by the exchange",
    });

    const data: CardMeta & {
      quotes: CardMeta;
      technicals: CardMeta;
      coverage: {
        quotes: number;
        technicals: number;
        requested: number;
        complete: boolean;
      };
    } = {
      ...(techMeta.stale ? techMeta : quoteMeta),
      quotes: quoteMeta,
      technicals: techMeta,
      coverage: {
        quotes: stocks.length,
        technicals: tech.covered,
        requested: symbols.length,
        complete: tech.complete,
      },
    };

    return NextResponse.json({
      success: true,
      status: data.status,
      // Top-level contract (was missing): which feed won, when it was collected,
      // how fresh it is, and an overall quality label derived from the same
      // card meta so the summary never contradicts `data`.
      source: data.source,
      timestamp: data.collectedAt,
      providerTimestamp: data.providerTimestamp,
      freshness: {
        provider: data.source,
        source: data.source,
        timestamp: data.providerTimestamp ?? data.collectedAt,
        ageMs: data.ageMs,
        freshness: data.status === "STALE" ? "STALE" : "FRESH",
        delayed: data.stale,
        fallbackUsed: data.source !== "nse",
      },
      quality: data.stale ? "DEGRADED" : "OK",
      data,
      breadth: {
        score: breadthScore,
        label,
        advances,
        declines,
        unchanged,
        total,
        adRatio: round(adRatio),
        newHighs,
        newLows,
        newHighsPct,
        newLowsPct,
        volAdvancing,
        volDeclining,
        volRatio: round(volRatio),
        freshDayHighs,
        freshDayLows,
        aboveEMA20: ema20Rows.length ? aboveEMA20 : null,
        aboveEMA50: ema50Rows.length ? aboveEMA50 : null,
        aboveEMA200: ema200Rows.length ? aboveEMA200 : null,
        aboveEMA20Pct: pct(aboveEMA20, ema20Rows.length),
        aboveEMA50Pct: pct(aboveEMA50, ema50Rows.length),
        aboveEMA200Pct: pct(aboveEMA200, ema200Rows.length),
        aboveVWAP: vwapRows.length ? aboveVWAP : null,
        aboveVWAPPct: pct(aboveVWAP, vwapRows.length),
        highRelVol: relVolRows.length ? highRelVol : null,
        elevatedRelVol: relVolRows.length ? elevatedRelVol : null,
        normalRelVol: relVolRows.length ? normalRelVol : null,
        lowRelVol: relVolRows.length ? lowRelVol : null,
        highRelVolPct: pct(highRelVol, relVolRows.length),
        adScore,
        volScore,
        highLowScore,
        emaScore,
        vwapScore,
        relVolScore,
        // Denominators used for the percentages above (null = not computable).
        emaCoverage: { ema20: ema20Rows.length, ema50: ema50Rows.length, ema200: ema200Rows.length, vwap: vwapRows.length, relVol: relVolRows.length },
      },
      stocks: stocks.map((s) => {
        const t = tech.bySymbol.get(s.symbol);
        const rv = relVolOf(s);
        return {
          symbol: s.symbol,
          name: s.name,
          changePct: s.changePct,
          ltp: s.ltp,
          sector: s.sector,
          volume: s.volume,
          avgVolume20: t?.avgVolume20 ?? null,
          relVolume: round(rv),
          ema20: t?.ema20 ?? null,
          ema50: t?.ema50 ?? null,
          ema200: t?.ema200 ?? null,
          vwap: t?.vwap ?? null,
        };
      }),
      topGainers,
      topLosers,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    const meta = unavailableMeta(error?.message || "Breadth fetch failed", "nse");
    return NextResponse.json({
      success: false,
      status: "UNAVAILABLE",
      error: meta.reason,
      data: meta,
      breadth: null,
      stocks: [],
      timestamp: new Date().toISOString(),
    });
  }
}
