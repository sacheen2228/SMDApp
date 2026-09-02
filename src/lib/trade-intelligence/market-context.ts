// ═══════════════════════════════════════════════════════════════════════════
// Market Intelligence Context — Unified Data Layer
// Aggregates ALL existing SMD data sources into a single context object
// that feeds all three trade modes (Index F&O, Stock F&O, Equity Swing).
// ═══════════════════════════════════════════════════════════════════════════

// ── Types ──

export interface IndexData {
  symbol: string;
  spot: number;
  change: number;
  changePercent: number;
  vwap: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
}

export interface OptionChainSummary {
  symbol: string;
  expiry: string;
  spot: number;
  atmStrike: number;
  pcr: number;
  maxPain: number;
  totalCallOI: number;
  totalPutOI: number;
  pcrVolume: number;
  ivMedian: number;
  ivRank: number;
 支撑: number[];
  resistance: number[];
  callWall: number;
  putFloor: number;
}

export interface FuturesData {
  symbol: string;
  expiry: string;
  ltp: number;
  change: number;
  changePercent: number;
  oi: number;
  oiChange: number;
  volume: number;
  basis: number;
  basisPercent: number;
  annualizedBasis: number;
}

export interface MarketBreadthData {
  advances: number;
  declines: number;
  unchanged: number;
  totalStocks: number;
  advanceDeclineRatio: number;
  breadthScore: number;
  newHighs: number;
  newLows: number;
  ema20Participation: number;
  ema50Participation: number;
  vwapParticipation: number;
  relativeVolume: number;
}

export interface SectorData {
  sector: string;
  strength: number;
  change: number;
  leadingStocks: string[];
  laggards: string[];
}

export interface InstitutionalData {
  fii: { equity: number; derivatives: number; net: number };
  dii: { equity: number; derivatives: number; net: number };
  smartMoneyBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  retailTrap: boolean;
}

export interface TechnicalSnapshot {
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  adx: number;
  atr: number;
  macd: number;
  macdSignal: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerMid: number;
  volumeProfile: { poc: number; vah: number; val: number };
  marketStructure: "BULLISH" | "BEARISH" | "NEUTRAL";
  swingHigh: number;
  swingLow: number;
  support: number[];
  resistance: number[];
}

export interface RegimeData {
  regime: string;
  trend: "BULLISH" | "BEARISH" | "SIDEWAYS";
  confidence: number;
  factors: Record<string, number>;
}

export interface NewsSentiment {
  score: number;
  label: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  headlines: Array<{ title: string; sentiment: number; source: string }>;
}

export interface StockQuote {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  avgVolume: number;
  relativeVolume: number;
  marketCap: number;
  pe: number;
  week52High: number;
  week52Low: number;
  deliveryPercent: number;
}

export interface MarketIntelligenceContext {
  timestamp: string;
  indices: IndexData[];
  nifty: OptionChainSummary | null;
  banknifty: OptionChainSummary | null;
  sensex: OptionChainSummary | null;
  niftyFutures: FuturesData | null;
  bankniftyFutures: FuturesData | null;
  sensexFutures: FuturesData | null;
  breadth: MarketBreadthData;
  sectors: SectorData[];
  institutional: InstitutionalData;
  regime: RegimeData;
  news: NewsSentiment;
  stockQuotes: StockQuote[];
  technicals: Record<string, TechnicalSnapshot>;
  giftNifty: { spot: number; change: number; gapPercent: number } | null;
  indiaVix: number;
  fiiDii: InstitutionalData;
  expiry: string;
  sessionPhase: string;
  isMarketOpen: boolean;
  dataQuality: "REAL" | "PARTIAL" | "DEGRADED";
  sourcesUsed: string[];
}

// ── Cache ──
let cachedContext: MarketIntelligenceContext | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30_000; // 30 seconds

// ── Fetch helpers with timeout ──
async function fetchJSON<T>(url: string, timeout = 10000): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || json;
  } catch {
    return null;
  }
}

// ── Build context from internal API routes ──
async function fetchOptionChain(symbol: string): Promise<OptionChainSummary | null> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/option-chain?symbol=${symbol}`);
  if (!data?.summary) return null;
  const s = data.summary;
  return {
    symbol,
    expiry: s.expiry || "",
    spot: s.spot || 0,
    atmStrike: s.atmStrike || 0,
    pcr: s.pcr || 0,
    maxPain: s.maxPain || 0,
    totalCallOI: s.totalCallOI || 0,
    totalPutOI: s.totalPutOI || 0,
    pcrVolume: s.pcrVolume || 0,
    ivMedian: s.ivMedian || 0,
    ivRank: s.ivRank || 0,
    支撑: s.support || [],
    resistance: s.resistance || [],
    callWall: s.callWall || 0,
    putFloor: s.putFloor || 0,
  };
}

async function fetchFutures(symbol: string): Promise<FuturesData | null> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/index-derivatives?symbol=${symbol}`);
  if (!data?.futures) return null;
  const f = data.futures[0];
  if (!f) return null;
  return {
    symbol,
    expiry: f.expiry || "",
    ltp: f.ltp || 0,
    change: f.change || 0,
    changePercent: f.changePercent || 0,
    oi: f.oi || 0,
    oiChange: f.oiChange || 0,
    volume: f.volume || 0,
    basis: f.basis || 0,
    basisPercent: f.basisPercent || 0,
    annualizedBasis: f.annualizedBasis || 0,
  };
}

async function fetchBreadth(): Promise<MarketBreadthData> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/market/breadth`);
  if (!data?.breadth) {
    return {
      advances: 0, declines: 0, unchanged: 0, totalStocks: 50,
      advanceDeclineRatio: 1, breadthScore: 50, newHighs: 0, newLows: 0,
      ema20Participation: 50, ema50Participation: 50, vwapParticipation: 50,
      relativeVolume: 1,
    };
  }
  const b = data.breadth;
  return {
    advances: b.advances || 0,
    declines: b.declines || 0,
    unchanged: b.unchanged || 0,
    totalStocks: b.totalStocks || 50,
    advanceDeclineRatio: b.advanceDeclineRatio || 1,
    breadthScore: b.breadthScore || b.score || 50,
    newHighs: b.newHighs || 0,
    newLows: b.newLows || 0,
    ema20Participation: b.ema20Participation || 50,
    ema50Participation: b.ema50Participation || 50,
    vwapParticipation: b.vwapParticipation || 50,
    relativeVolume: b.relativeVolume || 1,
  };
}

async function fetchSectors(): Promise<SectorData[]> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/market/sectors`);
  if (!data?.sectors) return [];
  return data.sectors.map((s: any) => ({
    sector: s.sector || s.name || "",
    strength: s.strength || s.score || 50,
    change: s.change || s.changePercent || 0,
    leadingStocks: s.leadingStocks || [],
    laggards: s.laggards || [],
  }));
}

async function fetchRegime(): Promise<RegimeData> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/market/regime`);
  if (!data?.regime) {
    return { regime: "UNKNOWN", trend: "SIDEWAYS", confidence: 0, factors: {} };
  }
  const r = data.regime;
  return {
    regime: r.regime || r.label || "UNKNOWN",
    trend: r.trend || r.direction || "SIDEWAYS",
    confidence: r.confidence || r.score || 50,
    factors: r.factors || {},
  };
}

async function fetchNews(): Promise<NewsSentiment> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/news`);
  if (!data) {
    return { score: 0, label: "NEUTRAL", headlines: [] };
  }
  return {
    score: data.sentiment?.score || data.score || 0,
    label: data.sentiment?.label || data.label || "NEUTRAL",
    headlines: (data.headlines || data.articles || []).slice(0, 5).map((h: any) => ({
      title: h.title || "",
      sentiment: h.sentiment || 0,
      source: h.source || "",
    })),
  };
}

async function fetchFII(): Promise<InstitutionalData> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/fii-dii`);
  if (!data) {
    return {
      fii: { equity: 0, derivatives: 0, net: 0 },
      dii: { equity: 0, derivatives: 0, net: 0 },
      smartMoneyBias: "NEUTRAL",
      retailTrap: false,
    };
  }
  const fii = data.fii || {};
  const dii = data.dii || {};
  const fiiNet = (fii.equity || 0) + (fii.derivatives || 0);
  const diiNet = (dii.equity || 0) + (dii.derivatives || 0);
  return {
    fii: { equity: fii.equity || 0, derivatives: fii.derivatives || 0, net: fiiNet },
    dii: { equity: dii.equity || 0, derivatives: dii.derivatives || 0, net: diiNet },
    smartMoneyBias: fiiNet > 0 ? "BULLISH" : fiiNet < 0 ? "BEARISH" : "NEUTRAL",
    retailTrap: false,
  };
}

async function fetchGiftNifty() {
  const data = await fetchJSON<any>(`http://localhost:3000/api/gift-nifty`);
  if (!data) return null;
  return {
    spot: data.spot || data.price || 0,
    change: data.change || 0,
    gapPercent: data.gapPercent || data.changePercent || 0,
  };
}

async function fetchStockQuotes(): Promise<StockQuote[]> {
  const data = await fetchJSON<any>(`http://localhost:3000/api/scanner?live=true`);
  if (!data?.data?.candidates) return [];
  return (data.data.candidates || []).map((c: any) => ({
    symbol: c.symbol || "",
    name: c.name || c.symbol || "",
    sector: c.sector || "",
    price: c.price || c.ltp || 0,
    change: c.change || 0,
    changePercent: c.changePercent || c.change_pct || 0,
    volume: c.volume || 0,
    avgVolume: c.avgVolume || c.avg_volume || 0,
    relativeVolume: c.relativeVolume || c.rvol || 1,
    marketCap: c.marketCap || 0,
    pe: c.pe || 0,
    week52High: c.week52High || 0,
    week52Low: c.week52Low || 0,
    deliveryPercent: c.deliveryPercent || 0,
  }));
}

// ── Main: Build full context ──
export async function buildMarketIntelligenceContext(
  forceRefresh = false
): Promise<MarketIntelligenceContext> {
  const now = Date.now();
  if (!forceRefresh && cachedContext && now - cacheTimestamp < CACHE_TTL) {
    return cachedContext;
  }

  const sourcesUsed: string[] = [];

  // Parallel fetch all data
  const [
    niftyChain,
    bankniftyChain,
    sensexChain,
    niftyFut,
    bankniftyFut,
    sensexFut,
    breadth,
    sectors,
    regime,
    news,
    fii,
    giftNifty,
    stockQuotes,
  ] = await Promise.allSettled([
    fetchOptionChain("NIFTY"),
    fetchOptionChain("BANKNIFTY"),
    fetchOptionChain("SENSEX"),
    fetchFutures("NIFTY"),
    fetchFutures("BANKNIFTY"),
    fetchFutures("SENSEX"),
    fetchBreadth(),
    fetchSectors(),
    fetchRegime(),
    fetchNews(),
    fetchFII(),
    fetchGiftNifty(),
    fetchStockQuotes(),
  ]);

  // Extract results
  const extract = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === "fulfilled" ? r.value : fallback;

  const nifty = extract(niftyChain, null);
  const banknifty = extract(bankniftyChain, null);
  const sensex = extract(sensexChain, null);
  const niftyFutures = extract(niftyFut, null);
  const bankniftyFutures = extract(bankniftyFut, null);
  const sensexFutures = extract(sensexFut, null);
  const breadthData = extract(breadth, {
    advances: 0, declines: 0, unchanged: 0, totalStocks: 50,
    advanceDeclineRatio: 1, breadthScore: 50, newHighs: 0, newLows: 0,
    ema20Participation: 50, ema50Participation: 50, vwapParticipation: 50,
    relativeVolume: 1,
  });
  const sectorData = extract(sectors, []);
  const regimeData = extract(regime, {
    regime: "UNKNOWN", trend: "SIDEWAYS", confidence: 0, factors: {},
  });
  const newsData = extract(news, { score: 0, label: "NEUTRAL" as const, headlines: [] });
  const fiiData = extract(fii, {
    fii: { equity: 0, derivatives: 0, net: 0 },
    dii: { equity: 0, derivatives: 0, net: 0 },
    smartMoneyBias: "NEUTRAL" as const,
    retailTrap: false,
  });
  const giftNiftyData = extract(giftNifty, null);
  const stockQuotesData = extract(stockQuotes, []);

  // Count data sources
  if (nifty) sourcesUsed.push("Breeze/NSE:OptionChain");
  if (breadthData.advances > 0) sourcesUsed.push("NSE:Breadth");
  if (sectorData.length > 0) sourcesUsed.push("NSE:Sectors");
  if (regimeData.regime !== "UNKNOWN") sourcesUsed.push("Regime:Engine");
  if (newsData.headlines.length > 0) sourcesUsed.push("RSS:News");
  if (fiiData.fii.net !== 0 || fiiData.dii.net !== 0) sourcesUsed.push("NSE:FII-DII");
  if (giftNiftyData) sourcesUsed.push("Yahoo:GiftNifty");
  if (stockQuotesData.length > 0) sourcesUsed.push("Yahoo:StockQuotes");

  // Determine data quality
  let dataQuality: "REAL" | "PARTIAL" | "DEGRADED" = "REAL";
  if (!nifty && !banknifty && stockQuotesData.length === 0) {
    dataQuality = "DEGRADED";
  } else if (!nifty || !banknifty || breadthData.advances === 0) {
    dataQuality = "PARTIAL";
  }

  // Determine session
  const now2 = new Date();
  const ist = new Date(now2.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hour = ist.getHours();
  const minute = ist.getMinutes();
  const day = ist.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const timeMinutes = hour * 60 + minute;
  const isMarketOpen = isWeekday && timeMinutes >= 555 && timeMinutes <= 930; // 9:15-15:30
  const isPreMarket = isWeekday && timeMinutes >= 360 && timeMinutes < 555;
  const isPostMarket = isWeekday && timeMinutes > 930 && timeMinutes <= 1020;

  let sessionPhase = "CLOSED";
  if (isMarketOpen) sessionPhase = "MARKET_OPEN";
  else if (isPreMarket) sessionPhase = "PRE_MARKET";
  else if (isPostMarket) sessionPhase = "POST_MARKET";

  // Default indices
  const indices: IndexData[] = [
    {
      symbol: "NIFTY",
      spot: nifty?.spot || giftNiftyData?.spot || 0,
      change: giftNiftyData?.change || 0,
      changePercent: giftNiftyData?.gapPercent || 0,
      vwap: 0,
      prevClose: 0,
      dayHigh: 0,
      dayLow: 0,
      volume: 0,
    },
    {
      symbol: "BANKNIFTY",
      spot: banknifty?.spot || 0,
      change: 0,
      changePercent: 0,
      vwap: 0,
      prevClose: 0,
      dayHigh: 0,
      dayLow: 0,
      volume: 0,
    },
    {
      symbol: "SENSEX",
      spot: sensex?.spot || 0,
      change: 0,
      changePercent: 0,
      vwap: 0,
      prevClose: 0,
      dayHigh: 0,
      dayLow: 0,
      volume: 0,
    },
  ];

  const context: MarketIntelligenceContext = {
    timestamp: new Date().toISOString(),
    indices,
    nifty,
    banknifty,
    sensex,
    niftyFutures,
    bankniftyFutures,
    sensexFutures,
    breadth: breadthData,
    sectors: sectorData,
    institutional: fiiData,
    regime: regimeData,
    news: newsData,
    stockQuotes: stockQuotesData,
    technicals: {},
    giftNifty: giftNiftyData,
    indiaVix: 0,
    fiiDii: fiiData,
    expiry: nifty?.expiry || "",
    sessionPhase,
    isMarketOpen,
    dataQuality,
    sourcesUsed,
  };

  cachedContext = context;
  cacheTimestamp = now;

  return context;
}

// ── Get cached context (no fetch) ──
export function getCachedContext(): MarketIntelligenceContext | null {
  return cachedContext;
}

// ── Invalidate cache ──
export function invalidateContext(): void {
  cachedContext = null;
  cacheTimestamp = 0;
}
