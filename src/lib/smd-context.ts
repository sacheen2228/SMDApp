// SMDContext — centralized market context for Hermes Agent
// Aggregates ALL SMD data sources into a single compact context object.
// Does NOT duplicate engine logic — calls existing APIs.

export interface SMDContext {
  timestamp: string;
  symbol: string;
  market: {
    status: string;
    session: string;
    isExpiryDay: boolean;
    daysToExpiry: number;
  };
  spot: {
    price: number;
    change: number;
    changePct: number;
    prevClose: number;
  };
  indices: {
    nifty: { price: number; change: number } | null;
    sensex: { price: number; change: number } | null;
    banknifty: { price: number; change: number } | null;
  };
  options: {
    spot: number;
    atmStrike: number;
    maxPain: number;
    pcr: number;
    totalCallOI: number;
    totalPutOI: number;
    callOiChg: number;
    putOiChg: number;
    vix: number;
    futuresPrice: number;
    // Strike-level OI data for trade decisions
    strikes: {
      strike: number;
      ceOi: number;
      ceOiChg: number;
      ceVol: number;
      ceLtp: number;
      peOi: number;
      peOiChg: number;
      peVol: number;
      peLtp: number;
    }[];
    // Support/Resistance from OI walls
    supportLevels: { strike: number; peOi: number }[];
    resistanceLevels: { strike: number; ceOi: number }[];
    // Top OI movers (biggest OI changes)
    topOiMovers: { strike: number; type: "CE" | "PE"; oiChg: number; classification: string }[];
  } | null;
  institutional: {
    fiiNet: number;
    diiNet: number;
    fiiBias: string;
    participantOI?: {
      date: string;
      fii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
      dii: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
      pro: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
      client: { indexLong: number; indexShort: number; stockLong: number; stockShort: number; totalLong: number; totalShort: number };
    };
  } | null;
  news: {
    sentiment: string;
    score: number;
    headlines: string[];
  } | null;
  regime: {
    type: string;
    bias: string;
    confidence: number;
  } | null;
  risk: {
    openTrades: number;
    dailyPnL: number;
    maxDrawdown: number;
    capitalUsed: number;
  } | null;
  dataQuality: {
    overall: string;
    optionChain: string;
    marketData: string;
    age: string;
  };
  mostActive: {
    topContracts: { underlying: string; instrument: string; volume: number; oi: number; ltp: number; pChange: number }[];
    topFutures: { underlying: string; volume: number; oi: number; ltp: number; pChange: number }[];
    topCalls: { underlying: string; strike: number; volume: number; ltp: number; pChange: number }[];
    topPuts: { underlying: string; strike: number; volume: number; ltp: number; pChange: number }[];
    sentiment: string;
  } | null;
}

export async function buildSMDContext(
  symbol: string,
  apiBase: string
): Promise<SMDContext> {
  const now = new Date();
  const ctx: SMDContext = {
    timestamp: now.toISOString(),
    symbol,
    market: { status: "UNKNOWN", session: "UNKNOWN", isExpiryDay: false, daysToExpiry: 0 },
    spot: { price: 0, change: 0, changePct: 0, prevClose: 0 },
    indices: { nifty: null, sensex: null, banknifty: null },
    options: null,
    institutional: null,
    news: null,
    regime: null,
    risk: null,
    dataQuality: { overall: "UNKNOWN", optionChain: "UNKNOWN", marketData: "UNKNOWN", age: "0s" },
    mostActive: null,
  };

  const fetchJSON = async (path: string, timeout = 10000) => {
    try {
      const res = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  const [chainRes, fiiRes, newsRes, regimeRes, healthRes, gifRes, mostActiveRes] = await Promise.allSettled([
    fetchJSON(`/api/option-chain?symbol=${symbol}`, 12000),
    fetchJSON("/api/fii-dii", 8000),
    fetchJSON("/api/news", 8000),
    fetchJSON("/api/market/regime", 10000),
    fetchJSON("/api/health", 5000),
    fetchJSON("/api/gift-nifty", 5000),
    fetchJSON("/api/market/most-active", 8000),
  ]);

  // Parse option chain
  if (chainRes.status === "fulfilled" && chainRes.value?.success) {
    const data = chainRes.value.data;
    const summary = data?.summary || {};
    const strikes = data?.strikes || data?.optionChainStrikes || [];

    // Build strike-level OI data
    const strikeData = strikes.map((s: any) => ({
      strike: s.strike || s.strikePrice || 0,
      ceOi: s.ce?.oi || 0,
      ceOiChg: s.ce?.oiChg || s.ce?.oiChange || 0,
      ceVol: s.ce?.volume || 0,
      ceLtp: s.ce?.ltp || 0,
      peOi: s.pe?.oi || 0,
      peOiChg: s.pe?.oiChg || s.pe?.oiChange || 0,
      peVol: s.pe?.volume || 0,
      peLtp: s.pe?.ltp || 0,
    }));

    // Support: strikes with highest PE OI (price floor)
    const supportLevels = strikeData
      .filter((s: any) => s.peOi > 0)
      .sort((a: any, b: any) => b.peOi - a.peOi)
      .slice(0, 5)
      .map((s: any) => ({ strike: s.strike, peOi: s.peOi }));

    // Resistance: strikes with highest CE OI (price ceiling)
    const resistanceLevels = strikeData
      .filter((s: any) => s.ceOi > 0)
      .sort((a: any, b: any) => b.ceOi - a.ceOi)
      .slice(0, 5)
      .map((s: any) => ({ strike: s.strike, ceOi: s.ceOi }));

    // Top OI movers (biggest OI changes — where positions are building)
    // Classification: OI increase = buildup, OI decrease = unwinding
    // Without per-strike price direction, we classify by OI change sign
    const topOiMovers: { strike: number; type: "CE" | "PE"; oiChg: number; classification: string }[] = [];
    for (const s of strikeData) {
      if (s.ceOiChg > 0) {
        topOiMovers.push({ strike: s.strike, type: "CE", oiChg: s.ceOiChg, classification: "LONG_BUILDUP" });
      } else if (s.ceOiChg < 0) {
        topOiMovers.push({ strike: s.strike, type: "CE", oiChg: s.ceOiChg, classification: "SHORT_COVERING" });
      }
      if (s.peOiChg > 0) {
        topOiMovers.push({ strike: s.strike, type: "PE", oiChg: s.peOiChg, classification: "LONG_BUILDUP" });
      } else if (s.peOiChg < 0) {
        topOiMovers.push({ strike: s.strike, type: "PE", oiChg: s.peOiChg, classification: "SHORT_COVERING" });
      }
    }
    topOiMovers.sort((a, b) => Math.abs(b.oiChg) - Math.abs(a.oiChg));

    ctx.options = {
      spot: summary.spotPrice || data?.spotPrice || 0,
      atmStrike: summary.atmStrike || 0,
      maxPain: summary.maxPain || 0,
      pcr: summary.pcr || 0,
      totalCallOI: summary.totalCallOI || 0,
      totalPutOI: summary.totalPutOI || 0,
      callOiChg: summary.callOiChange || 0,
      putOiChg: summary.putOiChange || 0,
      vix: summary.indiaVIX || 0,
      futuresPrice: summary.futuresPrice || 0,
      strikes: strikeData,
      supportLevels,
      resistanceLevels,
      topOiMovers: topOiMovers.slice(0, 10),
    };
    ctx.spot.price = ctx.options.spot;
    ctx.spot.prevClose = summary.prevClose || 0;
    ctx.spot.change = ctx.spot.price - ctx.spot.prevClose;
    ctx.spot.changePct = ctx.spot.prevClose > 0 ? (ctx.spot.change / ctx.spot.prevClose) * 100 : 0;
    ctx.dataQuality.optionChain = "LIVE";
  }

  // Parse FII/DII — API returns data at top level, NOT under .latest
  if (fiiRes.status === "fulfilled" && fiiRes.value?.success) {
    const d = fiiRes.value;
    const fiiNet = d.fiiNet ?? d.latest?.fiiNet ?? 0;
    const diiNet = d.diiNet ?? d.latest?.diiNet ?? 0;
    ctx.institutional = {
      fiiNet,
      diiNet,
      fiiBias: fiiNet > 0 ? "BUYING" : fiiNet < 0 ? "SELLING" : "NEUTRAL",
      participantOI: d.participantOI || undefined,
    };
  }

  // Parse news
  if (newsRes.status === "fulfilled" && newsRes.value?.success) {
    const d = newsRes.value.data;
    ctx.news = {
      sentiment: d?.market?.sentiment || "NEUTRAL",
      score: d?.market?.score || 0,
      headlines: (d?.articles || []).slice(0, 3).map((a: any) => a.title?.substring(0, 80) || ""),
    };
  }

  // Parse regime
  if (regimeRes.status === "fulfilled" && regimeRes.value?.success) {
    const d = regimeRes.value;
    ctx.regime = {
      type: d.regime || "UNKNOWN",
      bias: d.bias || "NEUTRAL",
      confidence: d.confidence || 0,
    };
  }

  // Parse health
  if (healthRes.status === "fulfilled" && healthRes.value) {
    const checks = healthRes.value.checks || {};
    ctx.dataQuality.overall = healthRes.value.status || "UNKNOWN";
    ctx.dataQuality.marketData = checks.data_ICICI_BREEZE?.status || checks.data_NSE?.status || "UNKNOWN";
  }

  // Parse Gift Nifty
  if (gifRes.status === "fulfilled" && gifRes.value?.success) {
    const g = gifRes.value.data;
    ctx.indices.nifty = { price: g.price || 0, change: g.change || 0 };
  }

  // Parse Most Active Contracts
  if (mostActiveRes.status === "fulfilled" && mostActiveRes.value?.success) {
    const d = mostActiveRes.value.data;
    const callVol = (d.callsIndex?.data || []).reduce((s: number, c: any) => s + (c.numberOfContractsTraded || 0), 0);
    const putVol = (d.putsIndex?.data || []).reduce((s: number, c: any) => s + (c.numberOfContractsTraded || 0), 0);
    const ratio = callVol > 0 ? putVol / callVol : 1;
    let sentiment = "Neutral";
    if (ratio > 1.5) sentiment = "Bearish";
    else if (ratio > 1.1) sentiment = "Mildly Bearish";
    else if (ratio < 0.67) sentiment = "Bullish";
    else if (ratio < 0.9) sentiment = "Mildly Bullish";

    ctx.mostActive = {
      topContracts: (d.contracts?.data || []).slice(0, 10).map((c: any) => ({
        underlying: c.underlying, instrument: c.instrument, volume: c.numberOfContractsTraded,
        oi: c.openInterest, ltp: c.lastPrice, pChange: c.pChange,
      })),
      topFutures: (d.futures?.data || []).slice(0, 10).map((c: any) => ({
        underlying: c.underlying, volume: c.numberOfContractsTraded,
        oi: c.openInterest, ltp: c.lastPrice, pChange: c.pChange,
      })),
      topCalls: (d.callsIndex?.data || []).slice(0, 5).map((c: any) => ({
        underlying: c.underlying, strike: c.strikePrice, volume: c.numberOfContractsTraded,
        ltp: c.lastPrice, pChange: c.pChange,
      })),
      topPuts: (d.putsIndex?.data || []).slice(0, 5).map((c: any) => ({
        underlying: c.underlying, strike: c.strikePrice, volume: c.numberOfContractsTraded,
        ltp: c.lastPrice, pChange: c.pChange,
      })),
      sentiment,
    };
  }

  // Session
  try {
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const day = ist.getDay();
    if (day === 0 || day === 6) ctx.market.status = "CLOSED";
    else if (mins < 555) ctx.market.status = "PRE_OPEN";
    else if (mins <= 570) ctx.market.status = "OPENING";
    else if (mins <= 930) ctx.market.status = "OPEN";
    else ctx.market.status = "CLOSED";
    ctx.market.session = `${ist.getHours()}:${String(ist.getMinutes()).padStart(2, "0")} IST`;
  } catch {}

  return ctx;
}

export function summarizeContext(ctx: SMDContext): string {
  const parts: string[] = [];
  const spotPrice = ctx.spot?.price || ctx.options?.spot || 0;
  parts.push(`=== ${ctx.symbol} TRADE CONTEXT ===`);
  parts.push(`Spot: ₹${spotPrice.toLocaleString("en-IN")} (${ctx.spot?.change >= 0 ? "+" : ""}${(ctx.spot?.changePct || 0).toFixed(2)}%) | Market: ${ctx.market?.status || "UNKNOWN"} | ${ctx.market?.session || ""}`);

  if (ctx.options) {
    const o = ctx.options;
    parts.push(`\n--- OPTION CHAIN ---`);
    parts.push(`ATM: ₹${o.atmStrike.toLocaleString("en-IN")} | Max Pain: ₹${o.maxPain.toLocaleString("en-IN")} | VIX: ${o.vix || "N/A"}`);
    parts.push(`PCR: ${o.pcr != null && Number.isFinite(o.pcr) ? o.pcr.toFixed(2) : "N/A"} | Call OI: ${o.totalCallOI.toLocaleString("en-IN")} (${o.callOiChg >= 0 ? "+" : ""}${o.callOiChg.toLocaleString("en-IN")}) | Put OI: ${o.totalPutOI.toLocaleString("en-IN")} (${o.putOiChg >= 0 ? "+" : ""}${o.putOiChg.toLocaleString("en-IN")})`);
    if (o.futuresPrice > 0) parts.push(`Futures: ₹${o.futuresPrice.toLocaleString("en-IN")} (basis: ${((o.futuresPrice - spotPrice) / spotPrice * 100).toFixed(2)}%)`);

    // Support from PE OI walls
    if (o.supportLevels?.length > 0) {
      parts.push(`\nSUPPORT (PE OI walls): ${o.supportLevels.map((s: any) => `₹${s.strike.toLocaleString("en-IN")}(${(s.peOi / 1000).toFixed(0)}K)`).join(" < ")}`);
    }
    // Resistance from CE OI walls
    if (o.resistanceLevels?.length > 0) {
      parts.push(`RESISTANCE (CE OI walls): ${o.resistanceLevels.map((s: any) => `₹${s.strike.toLocaleString("en-IN")}(${(s.ceOi / 1000).toFixed(0)}K)`).join(" > ")}`);
    }
    // Top OI movers
    if (o.topOiMovers?.length > 0) {
      parts.push(`OI MOVERS: ${o.topOiMovers.slice(0, 5).map((m: any) => `${m.strike}${m.type} ${m.classification.replace("_", " ")} +${(m.oiChg / 1000).toFixed(0)}K`).join(" | ")}`);
    }
    // Strike range around ATM
    const atmIdx = o.strikes.findIndex((s: any) => s.strike === o.atmStrike);
    if (atmIdx >= 0) {
      const nearStrikes = o.strikes.slice(Math.max(0, atmIdx - 3), atmIdx + 4);
      parts.push(`STRIKES: ${nearStrikes.map((s: any) => `${s.strike}(C:${(s.ceOi/1000).toFixed(0)}K/P:${(s.peOi/1000).toFixed(0)}K)`).join(" | ")}`);
    }
  }

  if (ctx.institutional) {
    parts.push(`\n--- INSTITUTIONAL ---`);
    parts.push(`FII: ${ctx.institutional.fiiNet >= 0 ? "+" : ""}₹${ctx.institutional.fiiNet}Cr (${ctx.institutional.fiiBias}) | DII: ${ctx.institutional.diiNet >= 0 ? "+" : ""}₹${ctx.institutional.diiNet}Cr`);
    if (ctx.institutional.participantOI) {
      const poi = ctx.institutional.participantOI;
      const fiiNetOI = (poi.fii.totalLong || 0) - (poi.fii.totalShort || 0);
      const diiNetOI = (poi.dii.totalLong || 0) - (poi.dii.totalShort || 0);
      const clientNetOI = (poi.client.totalLong || 0) - (poi.client.totalShort || 0);
      parts.push(`FII OI: ${fiiNetOI > 0 ? "LONG" : "SHORT"} (${fiiNetOI > 0 ? "+" : ""}${fiiNetOI.toLocaleString("en-IN")}) | DII: ${diiNetOI > 0 ? "LONG" : "SHORT"} | CLIENT: ${clientNetOI > 0 ? "LONG" : "SHORT"}`);
    }
  }

  if (ctx.mostActive) {
    parts.push(`\n--- MOST ACTIVE F&O ---`);
    parts.push(`Sentiment: ${ctx.mostActive.sentiment}`);
    if (ctx.mostActive.topContracts.length > 0) {
      parts.push(`Top: ${ctx.mostActive.topContracts.slice(0, 5).map((c: any) => `${c.underlying}(vol:${(c.volume/1000).toFixed(0)}K,OI:${(c.oi/1000).toFixed(0)}K)`).join(" | ")}`);
    }
    if (ctx.mostActive.topCalls.length > 0) {
      parts.push(`Calls: ${ctx.mostActive.topCalls.slice(0, 3).map((c: any) => `${c.underlying}₹${c.strike}(vol:${(c.volume/1000).toFixed(0)}K)`).join(" | ")}`);
    }
    if (ctx.mostActive.topPuts.length > 0) {
      parts.push(`Puts: ${ctx.mostActive.topPuts.slice(0, 3).map((c: any) => `${c.underlying}₹${c.strike}(vol:${(c.volume/1000).toFixed(0)}K)`).join(" | ")}`);
    }
  }

  if (ctx.regime) {
    parts.push(`\n--- MARKET ---`);
    parts.push(`Regime: ${ctx.regime.type} (${ctx.regime.bias}, ${ctx.regime.confidence}% conf)`);
  }
  if (ctx.news) {
    parts.push(`News: ${ctx.news.sentiment} (${ctx.news.score}) | ${ctx.news.headlines.slice(0, 2).join("; ")}`);
  }

  return parts.join("\n");
}
