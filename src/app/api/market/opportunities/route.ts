// Trade Opportunity Engine — technical detection engines on REAL data.
//
// Honesty notes (2026-10-20 audit):
//   • `estimateIndicators()` invented every indicator it fed the detection
//     engines: ema20 = prevClose + change*0.3, ema50 = ema200 = prevClose,
//     vwap = (high+low+ltp)/3, rsi = a step function of changePct,
//     macd = changePct*0.5, avgVolume = 2 000 000. The scanners therefore
//     fired on made-up "EMA crossovers" — this is one of the sources of the
//     WRONG SIGNALS. Every indicator now comes from the exchange's own daily
//     bars.
//   • The market context was fetched from `${INTERNAL_API_BASE}/api/market/
//     regime` with an empty base URL, so the fetch always failed and the
//     catch returned a hardcoded NEUTRAL / VIX 15 / CLOSED context. The
//     regime route is now called in-process.
//   • Entry / SL / TP fell back to ltp*0.985 / ltp*1.03 / ltp*1.05 when the
//     engine found no setup. They are null now.

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";
import {
  detectBreakout,
  detectPullback,
  detectMomentum,
  detectBreakdown,
  detectReversal,
  scanStock,
  rrFromLevels,
  pickOptionLeg,
  type ScanContext,
  type TechnicalIndicators,
} from "@/lib/technical-analysis";
import { getNSEEquityOptionChain } from "@/lib/nse-api";
import { buildOptionPlan } from "@/lib/option-plan";
import { getLotSizeStrict } from "@/lib/symbol-config";
import { isTradingDay } from "@/lib/expiry-liquidity/market-session-config";
import { getDailyBars, buildIndicators } from "@/lib/daily-bars";
import { buildCardMeta, getMarketClock, round } from "@/lib/data-freshness";

// ─── Option leg enrichment (live NSE equity chain) ─────────────────
// Top rows of the card show the option strike to trade. Chain comes from
// the LIVE NSE Equity v3 endpoint (Breeze data APIs currently 401
// "Unauthorized User" — entitlement missing server-side; wire Breeze
// back as fallback when that's restored). 90s cache incl. negative hits
// so non-F&O symbols don't hammer NSE on every 60s poll. Failures are
// silent → option: null → UI shows "chain unavailable" honestly.
const OPTION_CHAIN_TTL_MS = 90_000;
const optionChainCache = new Map<
  string,
  { ts: number; chain: Awaited<ReturnType<typeof getNSEEquityOptionChain>> }
>();

async function getCachedEquityChain(symbol: string) {
  const hit = optionChainCache.get(symbol);
  if (hit && Date.now() - hit.ts < OPTION_CHAIN_TTL_MS) return hit.chain;
  const chain = await getNSEEquityOptionChain(symbol);
  optionChainCache.set(symbol, { ts: Date.now(), chain });
  return chain;
}

/**
 * Market context for the detection engines. The regime route is called
 * in-process (a self-fetch to an empty base URL always failed and produced
 * a hardcoded NEUTRAL / VIX 15 / CLOSED context).
 */
async function getMarketContext(): Promise<ScanContext | null> {
  try {
    const { GET: regimeGet } = await import("@/app/api/market/regime/route");
    const res = await regimeGet();
    const data: any = await res.json();
    const regime = String(data?.regime || "");
    const allowed = ["STRONG_BULLISH", "BULLISH", "NEUTRAL", "BEARISH", "STRONG_BEARISH", "HIGH VOLATILITY"];
    return {
      marketRegime: (allowed.includes(regime) ? regime : "NEUTRAL") as ScanContext["marketRegime"],
      marketBreadth: typeof data?.breadthScore === "number" ? data.breadthScore : 50,
      vix: typeof data?.vix?.value === "number" ? data.vix.value : 0,
      session: (data?.session || "CLOSED") as ScanContext["session"],
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    // Intraday opportunity detection needs a live tape. On a weekend or
    // exchange holiday NSE publishes no new prices, so scanning would re-read
    // Friday's close and report stale moves as fresh setups.
    if (!isTradingDay()) {
      return NextResponse.json({
        success: true,
        status: "UNAVAILABLE",
        opportunities: [],
        totalStocks: 0,
        avgScore: null,
        topOppCount: 0,
        marketContext: null,
        reason: "Non-trading day — no new prices are published on weekends or exchange holidays",
        timestamp: new Date().toISOString(),
      });
    }

    const { searchParams } = new URL(request.url);
    const topN = parseInt(searchParams.get("top") || "10");

    const [stocks, context] = await Promise.all([
      fetchNIFTY50Stocks(),
      getMarketContext(),
    ]);

    if (stocks.length === 0) {
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        opportunities: [],
        stockCount: 0,
        reason: "No quotes available from the exchange feeds",
        timestamp: new Date().toISOString(),
      });
    }

    // Sector averages (real)
    const sectorMap: Record<string, any[]> = {};
    for (const s of stocks) {
      if (!sectorMap[s.sector]) sectorMap[s.sector] = [];
      sectorMap[s.sector].push(s);
    }
    const sectorAvg: Record<string, number> = {};
    for (const [sec, stks] of Object.entries(sectorMap)) {
      sectorAvg[sec] = stks.reduce((sum: number, s: any) => sum + s.changePct, 0) / stks.length;
    }
    const marketAvg = stocks.reduce((sum: number, s: any) => sum + s.changePct, 0) / stocks.length;

    // Real daily bars for every symbol (cached 15 min).
    const symbols = stocks.map((s) => s.symbol);
    const barLists = await Promise.all(
      symbols.map(async (sym) => [sym, await getDailyBars(sym)] as const),
    );
    const barsBySymbol = new Map(barLists);

    const opportunities: any[] = [];
    const noData: any[] = [];

    for (const s of stocks) {
      const bars = barsBySymbol.get(s.symbol) || [];
      if (bars.length < 20) {
        // No real history → no indicators, no setups. Listed separately so
        // the card can say "no data" instead of scoring invented numbers.
        noData.push({ symbol: s.symbol, name: s.name, reason: "No daily history from the exchange" });
        continue;
      }

      const indicators = buildIndicators({
        quote: {
          ltp: s.ltp,
          prevClose: s.prevClose,
          changePct: s.changePct,
          volume: s.volume,
          dayHigh: s.dayHigh,
          dayLow: s.dayLow,
          weekHigh52: s.weekHigh52,
          weekLow52: s.weekLow52,
          sector: s.sector,
          sectorChangePct: sectorAvg[s.sector] ?? 0,
          marketChangePct: marketAvg,
        },
        bars,
      });

      const scan = context
        ? scanStock(indicators as unknown as TechnicalIndicators, context)
        : scanStock(indicators as unknown as TechnicalIndicators);

      const setup = scan.bestSetup;
      const entry = setup?.entryZone?.low ?? null;
      const sl = setup?.stopLoss ?? null;
      const tp1 = setup?.targets?.[0] ?? null;
      const tp2 = setup?.targets?.[1] ?? null;

      opportunities.push({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        ltp: s.ltp,
        changePct: s.changePct,
        volume: s.volume,
        relVolume: round(indicators.relVolume),
        score: scan.overallScore,
        setup: setup?.type || "WATCH",
        entryState: scan.entryState,
        confidence:
          setup?.confidence == null
            ? "N/A"
            : setup.confidence >= 75
            ? "VERY HIGH"
            : setup.confidence >= 60
            ? "HIGH"
            : setup.confidence >= 45
            ? "MEDIUM"
            : "LOW",
        reasons: setup?.confirmations || [],
        risks: setup?.warnings || [],
        // Real levels only — no ltp*1.03 fallbacks.
        entry,
        sl,
        tp1,
        tp2,
        rr: entry != null && sl != null && tp1 != null ? rrFromLevels(entry, sl, tp1) : null,
        falseBreakoutRisk: setup ? "LOW" : "N/A",
        source: "TECHNICAL_ANALYSIS",
        // The real inputs behind the score (auditable).
        indicators: {
          ema20: indicators.ema20,
          ema50: indicators.ema50,
          ema200: indicators.ema200,
          vwap: indicators.vwap,
          rsi: indicators.rsi,
          macd: indicators.macd,
          atr: indicators.atr,
          avgVolume: indicators.avgVolume,
        },
        bars: bars.length,
        option: null,
      });
    }

    // Sort by score, then by entryState priority
    const statePriority: Record<string, number> = { CONFIRMED: 4, CONFIRMING: 3, WATCH: 2, INVALIDATED: 1 };
    opportunities.sort((a, b) => {
      const pa = statePriority[a.entryState] ?? 0;
      const pb = statePriority[b.entryState] ?? 0;
      if (pb !== pa) return pb - pa;
      return b.score - a.score;
    });

    const topOpps = opportunities.slice(0, Math.min(topN, 15));

    // Attach the live option leg to the visible card rows (sequential —
    // gentle on NSE; ~0.7s each cold, cached for 90s after that).
    const optionBudget = Math.min(topOpps.length, 5);
    for (let i = 0; i < optionBudget; i++) {
      const opp: any = topOpps[i];
      opp.option = null;
      try {
        const chain = await getCachedEquityChain(opp.symbol);
        // Long structure = stop below entry → CE; below → PE
        const direction = opp.sl != null && opp.entry != null && opp.sl < opp.entry ? "LONG" : "SHORT";
        const leg = pickOptionLeg(chain?.rows, opp.entry ?? opp.ltp, direction);
        if (leg) {
          opp.option = { ...leg, expiry: chain?.expiry };
          // Playbook: stop lives on the underlying, then re-priced to
          // premium space (IV inversion + BS re-price). applyStopFloor:false
          // = skill-faithful conversion — the Rule Set C 10% cap (Today's
          // Trade) exits before the underlying stop and inflates R:R.
          // Absent on failure → card shows strike only, never fake levels.
          if (opp.entry != null && opp.sl != null && opp.tp1 != null && opp.tp2 != null && leg.premium > 0) {
            const plan = buildOptionPlan({
              symbol: opp.symbol,
              optionType: leg.side === "CE" ? "CE" : "PE",
              entryPremium: leg.premium,
              lotSize: getLotSizeStrict(opp.symbol) ?? 50,
            });
            if (plan && plan.tradable && plan.targets.length >= 2) {
              opp.option.sl = plan.stopLoss;
              opp.option.tp1 = plan.targets[0];
              opp.option.tp2 = plan.targets[1];
              opp.option.rr = plan.rr;
            }
          }
        }
      } catch {
        // optional enrichment — stay null
      }
    }

    const clock = await getMarketClock();
    const newestBar = [...barsBySymbol.values()]
      .map((b) => b.at(-1)?.t ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    const meta = buildCardMeta({
      source: "nse",
      providerTimestamp: newestBar ? new Date(newestBar) : new Date(),
      ttlMs: 36 * 3600_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    return NextResponse.json({
      success: true,
      status: meta.status,
      meta,
      opportunities: topOpps,
      totalStocks: stocks.length,
      // Guard the divisor: an empty scan produced NaN before.
      avgScore: opportunities.length
        ? Math.round(opportunities.reduce((sum: number, o: any) => sum + o.score, 0) / opportunities.length)
        : null,
      topOppCount: opportunities.filter((o: any) => o.score >= 70).length,
      coverage: {
        scanned: stocks.length,
        analysed: opportunities.length,
        noData: noData.length,
        noDataSymbols: noData,
      },
      marketContext: context
        ? {
            regime: context.marketRegime,
            vix: context.vix,
            session: context.session,
            breadth: context.marketBreadth,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: error.message || "Opportunities fetch failed" },
      { status: 500 },
    );
  }
}
