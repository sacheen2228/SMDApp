// Market Heatmap API — Stock data for treemap visualization
// Fast endpoint — never fetches F&O data (that's in /api/market/heatmap/fo)

import { NextResponse } from "next/server";
import { fetchNIFTY50Stocks } from "@/lib/nse-stock-data";

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
  return stocks.filter(s => symbolSet.has(s.symbol));
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const market = searchParams.get("market") || "NIFTY50";
    const allMarkets = searchParams.get("allMarkets") === "true";

    const stocks = await fetchNIFTY50Stocks();

    if (stocks.length === 0) {
      return NextResponse.json({ stocks: [], sectors: [], stockCount: 0, error: "NSE data unavailable" });
    }

    if (allMarkets) {
      // Return all markets data
      const markets: Record<string, any> = {};
      for (const [mkt, symbols] of Object.entries(MARKET_SYMBOLS)) {
        const mktStocks = filterStocksByMarket(stocks, mkt);
        const sectors: Record<string, any[]> = {};
        for (const s of mktStocks) {
          if (!sectors[s.sector]) sectors[s.sector] = [];
          sectors[s.sector].push(s);
        }
        const sectorData = Object.entries(sectors).map(([name, stks]) => ({
          name,
          stocks: stks,
          avgChangePct: parseFloat((stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length).toFixed(2)),
          avgWeeklyChangePct: parseFloat((stks.reduce((sum, s) => sum + (s.weeklyChangePct || 0), 0) / stks.length).toFixed(2)),
          totalVolume: stks.reduce((sum, s) => sum + s.volume, 0),
          advanceCount: stks.filter(s => s.changePct > 0).length,
          declineCount: stks.filter(s => s.changePct < 0).length,
        }));
        markets[mkt] = {
          stocks: mktStocks,
          sectors: sectorData,
          stockCount: mktStocks.length,
        };
      }
      return NextResponse.json({
        markets,
        timestamp: new Date().toISOString(),
      });
    }

    // Single market
    const filteredStocks = filterStocksByMarket(stocks, market);

    const sectors: Record<string, any[]> = {};
    for (const s of filteredStocks) {
      if (!sectors[s.sector]) sectors[s.sector] = [];
      sectors[s.sector].push(s);
    }

    const sectorData = Object.entries(sectors).map(([name, stks]) => ({
      name,
      stocks: stks,
      avgChangePct: parseFloat((stks.reduce((sum, s) => sum + s.changePct, 0) / stks.length).toFixed(2)),
      avgWeeklyChangePct: parseFloat((stks.reduce((sum, s) => sum + s.weeklyChangePct, 0) / stks.length).toFixed(2)),
      totalVolume: stks.reduce((sum, s) => sum + s.volume, 0),
      advanceCount: stks.filter(s => s.changePct > 0).length,
      declineCount: stks.filter(s => s.changePct < 0).length,
    }));

    return NextResponse.json({
      stocks: filteredStocks,
      sectors: sectorData,
      market,
      stockCount: filteredStocks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ stocks: [], sectors: [], error: error.message || "Heatmap fetch failed" });
  }
}