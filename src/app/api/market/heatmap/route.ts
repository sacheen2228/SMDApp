// Market Heatmap API — Stock data for treemap visualization
// Fast endpoint — never fetches F&O data (that's in /api/market/heatmap/fo)
//
// Honesty notes (2026-10-20 audit):
//   • `avgWeeklyChangePct` used to be a COPY of `avgChangePct` (the daily
//     change) presented as a weekly figure. It is now the average of the real
//     5-session change published by the exchange history, or null when the
//     feed has no weekly data.
//   • The provenance block listed "Yahoo Finance" as a possible source.
//     Yahoo is banned (SOP §1) and is not wired here at all — the sources are
//     the NSE index lists and Moneycontrol.
//   • A failed feed returns an explicit UNAVAILABLE state, never an empty
//     treemap that looks like "no market".

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks, getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { buildCardMeta, getMarketClock, unavailableMeta } from "@/lib/data-freshness";

const MARKET_SYMBOLS: Record<string, string[]> = {
  NIFTY50: [
    "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
    "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
    "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
    "ADANIPORTS","TECHM","HDFCLIFE","SBILIFE","BRITANNIA","CIPLA","DRREDDY",
    "DIVISLAB","EICHERMOT","GRASIM","HEROMOTOCO","HINDALCO","INDUSINDBK",
    "BAJAJFINSV","COALINDIA","BPCL","TRENT","APOLLOHOSP","LTIM","HDFCAMC","PIDILITIND",
  ],
  NIFTYNEXT50: [
    "ADANIGREEN","ADANITRANS","ADANIPOWER","ADANIENT","AMBUJACEM","APOLLOHOSP",
    "AUBANK","AVENUE","BANKBARODA","BEL","BERGEPAINT","BIOCON","BOSCHLTD",
    "CANBK","CHOLAFIN","COLPAL","CONCOR","DABUR","DMART","GAIL","GODREJCP",
    "HAVELLS","ICICIGI","ICICIPRULI","INDIGO","INDUSINDBK","INDUSTOWER",
    "IOC","JINDALSTEL","JUBLFOOD","LICI","LUPIN","M&MFIN","MARICO","MCDOWELL-N",
    "MFSL","MOTHERSON","NAUKRI","NMDC","PAGEIND","PEL","PETRONET","PFC",
    "PIDILITIND","PNB","POLYCAB","RECLTD","SAIL","SHREECEM","SIEMENS","SRF",
    "SUNTV","TATACOMM","TATACONSUM","TORNTPHARM","TORNTPOWER","TVSMOTOR","UBL","VEDL",
  ],
  BANKNIFTY: [
    "HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","INDUSINDBK","BANKBARODA",
    "PNB","CANBK","IDFCFIRSTB","FEDERALBNK","AUBANK",
  ],
  FINNIFTY: [
    "HDFCBANK","ICICIBANK","SBIN","KOTAKBANK","AXISBANK","BAJFINANCE","BAJAJFINSV",
    "HDFCLIFE","SBILIFE","ICICIGI","ICICIPRULI","HDFCAMC","CHOLAFIN","M&MFIN",
    "RECLTD","PFC","LICI","AUBANK","FEDERALBNK","INDUSINDBK","IDFCFIRSTB",
  ],
  MIDCAPNIFTY: [
    "ALKEM","APOLLOHOSP","AUROPHARMA","BALKRISIND","BANKBARODA","BEL","BERGEPAINT",
    "BHEL","BIOCON","BOSCHLTD","CANBK","CHOLAFIN","COLPAL","CONCOR","CUMMINSIND",
    "DABUR","DMART","GAIL","GODREJCP","HAVELLS","HINDPETRO","ICICIGI","ICICIPRULI",
    "INDIGO","INDUSINDBK","INDUSTOWER","IOC","JINDALSTEL","JUBLFOOD","LICI",
    "LUPIN","M&MFIN","MARICO","MCDOWELL-N","MFSL","MOTHERSON","NAUKRI","NMDC",
    "PAGEIND","PEL","PETRONET","PFC","PIDILITIND","PNB","POLYCAB","RECLTD",
    "SAIL","SHREECEM","SIEMENS","SRF","SUNTV","TATACOMM","TATACONSUM",
    "TORNTPHARM","TORNTPOWER","TVSMOTOR","UBL","VEDL","VOLTAS","WHIRLPOOL","ZYDUSLIFE",
  ],
  SENSEX: [
    "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN",
    "BHARTIARTL","KOTAKBANK","LT","AXISBANK","BAJFINANCE","ASIANPAINT","MARUTI",
    "SUNPHARMA","TITAN","ULTRACEMCO","NESTLEIND","TATAMOTORS","WIPRO","M&M",
    "HCLTECH","POWERGRID","NTPC","ONGC","TATASTEEL","JSWSTEEL","ADANIENT",
    "ADANIPORTS","TECHM",
  ],
};

function filterStocksByMarket(stocks: any[], market: string): any[] {
  const symbols = MARKET_SYMBOLS[market] || MARKET_SYMBOLS.NIFTY50;
  const symbolSet = new Set(symbols);
  return stocks.filter((s) => symbolSet.has(s.symbol));
}

/** Average of the real 5-session change — null when the feed has none. */
function avgWeekly(stocks: any[]): number | null {
  const vals = stocks
    .map((s) => (typeof s.weeklyChangePct === "number" ? s.weeklyChangePct : null))
    .filter((v): v is number => v != null);
  if (!vals.length) return null;
  return parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
}

function buildSectorData(stocks: any[]) {
  const sectors: Record<string, any[]> = {};
  for (const s of stocks) {
    if (!sectors[s.sector]) sectors[s.sector] = [];
    sectors[s.sector].push(s);
  }
  return Object.entries(sectors).map(([name, stks]) => ({
    name,
    stocks: stks,
    avgChangePct: parseFloat((stks.reduce((sum, s) => sum + (s.changePct || 0), 0) / stks.length).toFixed(2)),
    // Real weekly average (was a copy of the daily change).
    avgWeeklyChangePct: avgWeekly(stks),
    totalVolume: stks.reduce((sum, s) => sum + s.volume, 0),
    advanceCount: stks.filter((s) => s.changePct > 0).length,
    declineCount: stks.filter((s) => s.changePct < 0).length,
  }));
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const market = searchParams.get("market") || "NIFTY50";
    const allMarkets = searchParams.get("allMarkets") === "true";

    const [stocks, clock] = await Promise.all([fetchNIFTY50Stocks(), getMarketClock()]);

    if (stocks.length === 0) {
      const meta = unavailableMeta(
        "No quotes available from the exchange feeds (NSE index lists / Moneycontrol).",
        "nse",
      );
      return NextResponse.json({
        success: false,
        status: "UNAVAILABLE",
        error: meta.reason,
        data: meta,
        stocks: [],
        sectors: [],
        stockCount: 0,
        timestamp: new Date().toISOString(),
      });
    }

    const prov = getStockQuoteProvenance();
    const providerSource = prov.source === "moneycontrol" ? "moneycontrol" : "nse";
    const cardMeta = buildCardMeta({
      source: providerSource,
      providerTimestamp: prov.providerTimestamp ?? clock.tradeDate ?? null,
      ttlMs: 90_000,
      live: clock.isOpen,
      reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
    });

    const provenance = {
      source: providerSource,
      sourceLabel: cardMeta.sourceLabel,
      // The provider's own publication stamp (may be null for an undated feed).
      retrievedAt: prov.providerTimestamp,
      collectedAt: prov.retrievedAt,
      providerAgeMs: prov.providerAgeMs,
      freshness: cardMeta.status,
      ageLabel: cardMeta.ageLabel,
      isLive: cardMeta.status === "AVAILABLE",
      fallbackUsed: prov.fallbackUsed,
      marketState: clock.marketState,
      tradeDateLabel: clock.tradeDateLabel,
      status: "AVAILABLE" as const,
    };

    if (allMarkets) {
      const markets: Record<string, any> = {};
      for (const [mkt, symbols] of Object.entries(MARKET_SYMBOLS)) {
        const mktStocks = filterStocksByMarket(stocks, mkt);
        markets[mkt] = {
          stocks: mktStocks,
          sectors: buildSectorData(mktStocks),
          stockCount: mktStocks.length,
        };
      }
      return NextResponse.json({
        success: true,
        status: cardMeta.status,
        data: cardMeta,
        provenance,
        markets,
        timestamp: new Date().toISOString(),
      });
    }

    // Single market
    const filteredStocks = filterStocksByMarket(stocks, market);
    const sectorData = buildSectorData(filteredStocks);

    return NextResponse.json({
      success: true,
      status: cardMeta.status,
      data: cardMeta,
      stocks: filteredStocks,
      sectors: sectorData,
      market,
      stockCount: filteredStocks.length,
      timestamp: new Date().toISOString(),
      provenance: {
        ...provenance,
        status: filteredStocks.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
      },
    });
  } catch (error: any) {
    const meta = unavailableMeta(error.message || "Heatmap fetch failed", "nse");
    return NextResponse.json({
      success: false,
      status: "UNAVAILABLE",
      error: meta.reason,
      data: meta,
      stocks: [],
      sectors: [],
      timestamp: new Date().toISOString(),
    });
  }
}
