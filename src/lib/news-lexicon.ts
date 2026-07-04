// Indian Financial Lexicon for News Sentiment Analysis
// Enhanced VADER-compatible lexicon with Indian market terms

// ─── Bullish Terms (positive sentiment) ─────────────────────────
export const BULLISH_TERMS: Record<string, number> = {
  // Fundamental (0.3 - 0.7)
  outperformance: 0.5, breakout: 0.6, upgrade: 0.7, buyback: 0.6,
  "order win": 0.5, "order book": 0.4, "credit growth": 0.5,
  "margin expansion": 0.5, "pat beat": 0.6, "ebitda growth": 0.5,
  "revenue growth": 0.5, "market share gain": 0.5, "new client": 0.4,
  "dividend increase": 0.5, "bonus issue": 0.5, "stock split": 0.4,
  "insider buying": 0.6, "promoter buying": 0.6, "fii buying": 0.5,
  "dii buying": 0.5, "mutual fund": 0.3, "fpi inflow": 0.5,

  // Technical (0.4 - 0.6)
  "52 week high": 0.4, "all time high": 0.5, "volume spike": 0.4,
  "golden cross": 0.5, "bullish engulfing": 0.5, "higher high": 0.4,

  // Macro (0.3 - 0.6)
  "rate cut": 0.6, "repo rate cut": 0.7, "fiscal stimulus": 0.6,
  "budget positive": 0.5, "gst reform": 0.4, "ease of doing business": 0.4,

  // Sector specific
  "credit growth": 0.5, "npa reduction": 0.6, "nim expansion": 0.5,
  "deposit growth": 0.4, "loan growth": 0.5, "car ratio": 0.3,
  "oil price drop": 0.4, "crude fall": 0.4, "dollar weak": 0.3,
  "rupee strengthening": 0.3, "export growth": 0.4, "import substitution": 0.3,

  // Event types (0.5 - 0.8)
  "merger approved": 0.7, "acquisition completed": 0.6, "sebi clearance": 0.6,
  "rbi approval": 0.6, "government approval": 0.5, "court ruling positive": 0.6,
  "settlement": 0.4, "partnership": 0.4, "joint venture": 0.5,
  "capacity expansion": 0.5, "new product launch": 0.4, "plant commissioning": 0.5,

  // Hinglish bullish
  tezi: 0.5, tej: 0.5, bull: 0.4, rally: 0.5, surge: 0.5,
  jump: 0.4, soar: 0.6, zoom: 0.5, "upper circuit": 0.6,
};

// ─── Bearish Terms (negative sentiment) ─────────────────────────
export const BEARISH_TERMS: Record<string, number> = {
  // Fundamental (negative 0.3 - 0.7)
  downgrade: -0.7, "pat miss": -0.6, "ebitda miss": -0.5,
  "revenue decline": -0.5, "margin contraction": -0.5, "market share loss": -0.5,
  "client loss": -0.5, "order cancellation": -0.5, "delay": -0.4,
  "cost overrun": -0.4, "inventory buildup": -0.4, "working capital pressure": -0.4,

  // NPA & Banking stress
  npa: -0.6, "npa rise": -0.7, "gnpa": -0.6, "stress asset": -0.5,
  "provisioning": -0.4, "slippage": -0.5, "restructuring": -0.5,
  "write off": -0.6, "bad loan": -0.6, "credit loss": -0.5,

  // Regulatory & Legal
  "sebi penalty": -0.7, "sebi investigation": -0.6, "rbi restriction": -0.6,
  "show cause notice": -0.5, "fraud": -0.7, "scam": -0.7,
  "litigation": -0.4, "lawsuit": -0.4, "regulatory risk": -0.5,
  "tax raid": -0.6, "enforcement directorate": -0.6, "cbi": -0.5,

  // Institutional flow
  "fii selling": -0.6, "fpi outflow": -0.6, "dii selling": -0.4,
  "promoter pledge": -0.5, "pledge increase": -0.5, "insider selling": -0.6,
  "bulk deal sell": -0.4, "block deal sell": -0.4,

  // Macro negative
  "rate hike": -0.6, "repo rate hike": -0.7, "inflation rise": -0.5,
  "gdp slowdown": -0.5, "recession": -0.7, "trade deficit": -0.4,
  "fiscal deficit": -0.4, "currency depreciation": -0.4, "rupee fall": -0.4,

  // Technical
  "52 week low": -0.4, "death cross": -0.5, "breakdown": -0.5,
  "bearish engulfing": -0.5, "lower low": -0.4,

  // Event types
  "demerger": -0.3, "delisting": -0.6, "bankruptcy": -0.8,
  "default": -0.7, "insolvency": -0.7, "liquidation": -0.8,
  "exit": -0.4, "resignation": -0.3, "management change": -0.2,

  // Hinglish bearish
  mandi: -0.5, mand: -0.5, bear: -0.4, crash: -0.6, fall: -0.4,
  decline: -0.4, drop: -0.4, "lower circuit": -0.6, plunge: -0.6,
  sink: -0.5, tumble: -0.5, bleed: -0.5, "heavy selling": -0.5,
};

// ─── Event Classifier ───────────────────────────────────────────
export interface EventClassification {
  type: string;
  sentimentBias: number; // -1 to +1
  confidence: number;   // 0 to 1
}

const EVENT_PATTERNS: { pattern: RegExp; type: string; bias: number }[] = [
  // Earnings
  { pattern: /q\d|quarterly|earnings|results|pat\b|ebitda|revenue/i, type: "EARNINGS", bias: 0 },
  { pattern: /beat|exceed|outperform|surpass|strong.*result/i, type: "EARNINGS_BEAT", bias: 0.6 },
  { pattern: /miss|disappoint|weak.*result|below.*expect/i, type: "EARNINGS_MISS", bias: -0.6 },

  // RBI / Monetary Policy
  { pattern: /rbi|repo rate|monetary policy|reverse repo|slr|clr/i, type: "RBI_POLICY", bias: 0 },
  { pattern: /rate cut|dovish|accommodative|easing/i, type: "RBI_CUT", bias: 0.7 },
  { pattern: /rate hike|hawkish|tightening|withdraw liquidity/i, type: "RBI_HIKE", bias: -0.6 },

  // Government / Budget
  { pattern: /budget|fiscal|government|modi|parliament|legislation/i, type: "GOVT_POLICY", bias: 0 },
  { pattern: /stimulus|reform|incentive|subsidy|tax.*cut|relief/i, type: "GOVT_POSITIVE", bias: 0.5 },
  { pattern: /tax.*hike|surcharge|ban|restriction|penalty|fine/i, type: "GOVT_NEGATIVE", bias: -0.5 },

  // SEBI / Regulatory
  { pattern: /sebi|regulator|compliance|disclosure/i, type: "REGULATORY", bias: 0 },
  { pattern: /sebi.*penalty|sebi.*ban|sebi.*investigation|show cause/i, type: "REGULATORY_NEGATIVE", bias: -0.7 },
  { pattern: /sebi.*clear|sebi.*approve|sebi.*ease/i, type: "REGULATORY_POSITIVE", bias: 0.5 },

  // M&A / Corporate Actions
  { pattern: /merger|amalgamation|consolidation/i, type: "MERGER", bias: 0.3 },
  { pattern: /acquisition|buyout|takeover/i, type: "ACQUISITION", bias: 0.3 },
  { pattern: /buyback|tender offer/i, type: "BUYBACK", bias: 0.6 },
  { pattern: /bonus|split|dividend/i, type: "CORPORATE_ACTION", bias: 0.4 },

  // Fund Flow
  { pattern: /fii|fpi|foreign.*investor|foreign.*fund/i, type: "FII_FLOW", bias: 0 },
  { pattern: /fii.*buy|fpi.*inflow|foreign.*inflow/i, type: "FII_BUY", bias: 0.5 },
  { pattern: /fii.*sell|fpi.*outflow|foreign.*outflow/i, type: "FII_SELL", bias: -0.5 },
  { pattern: /dii|domestic.*institution|mutual.*fund/i, type: "DII_FLOW", bias: 0 },
  { pattern: /dii.*buy|mutual.*fund.*buy|domestic.*inflow/i, type: "DII_BUY", bias: 0.4 },
  { pattern: /dii.*sell|mutual.*fund.*sell|domestic.*outflow/i, type: "DII_SELL", bias: -0.4 },

  // Promoter Activity
  { pattern: /promoter.*buy|insider.*buy|pledge.*reduc/i, type: "PROMOTER_POSITIVE", bias: 0.6 },
  { pattern: /promoter.*sell|insider.*sell|pledge.*increas/i, type: "PROMOTER_NEGATIVE", bias: -0.6 },

  // Global / Macro
  { pattern: /oil|crude|brent|wti|opec/i, type: "OIL_PRICE", bias: 0 },
  { pattern: /oil.*fall|crude.*drop|oil.*plunge/i, type: "OIL_BULLISH", bias: 0.4 },
  { pattern: /oil.*surge|crude.*rise|oil.*jump/i, type: "OIL_BEARISH", bias: -0.4 },
  { pattern: /dollar|usd|inr|rupee|forex/i, type: "FOREX", bias: 0 },
  { pattern: /dollar.*weak|rupee.*strength|inr.*rise/i, type: "FOREX_POSITIVE", bias: 0.3 },
  { pattern: /dollar.*strong|rupee.*fall|inr.*depreciat/i, type: "FOREX_NEGATIVE", bias: -0.3 },

  // Sentiment words
  { pattern: /surge|rally|jump|soar|zoom|breakout|bull/i, type: "BULLISH_SENTIMENT", bias: 0.5 },
  { pattern: /crash|plunge|tumble|crumble|collapse|bear|panic/i, type: "BEARISH_SENTIMENT", bias: -0.5 },
  { pattern: /steady|stable|flat|unchanged|range.*bound/i, type: "NEUTRAL_SENTIMENT", bias: 0 },
];

export function classifyEvent(headline: string): EventClassification {
  const matches = EVENT_PATTERNS.filter(ep => ep.pattern.test(headline));
  if (matches.length === 0) {
    return { type: "UNKNOWN", sentimentBias: 0, confidence: 0.3 };
  }

  // Sort by bias magnitude to find strongest signal
  matches.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));
  const strongest = matches[0];

  return {
    type: strongest.type,
    sentimentBias: strongest.bias,
    confidence: Math.min(0.9, 0.5 + matches.length * 0.1),
  };
}

// ─── Stock Entity Extraction ────────────────────────────────────
const NSE_STOCK_MAP: Record<string, string> = {
  "reliance": "RELIANCE", "ril": "RELIANCE", "jio": "RELIANCE",
  "tcs": "TCS", "tata consultancy": "TCS",
  "hdfc bank": "HDFCBANK", "hdfcbank": "HDFCBANK",
  "infosys": "INFY", "infy": "INFY",
  "icici bank": "ICICIBANK", "icicibank": "ICICIBANK",
  "hindustan unilever": "HINDUNILVR", "hul": "HINDUNILVR", "hindunilvr": "HINDUNILVR",
  "itc": "ITC",
  "sbi": "SBIN", "state bank": "SBIN", "sbin": "SBIN",
  "bharti airtel": "BHARTIARTL", "airtel": "BHARTIARTL", "bhartiartl": "BHARTIARTL",
  "kotak bank": "KOTAKBANK", "kotak": "KOTAKBANK", "kotakbank": "KOTAKBANK",
  "lt": "LT", "larsen": "LT", "l&t": "LT",
  "axis bank": "AXISBANK", "axisbank": "AXISBANK",
  "bajaj finance": "BAJFINANCE", "bajajfin": "BAJFINANCE", "bajajfinance": "BAJFINANCE",
  "asian paints": "ASIANPAINT", "asianpaint": "ASIANPAINT", "asianpaints": "ASIANPAINT",
  "maruti": "MARUTI", "maruti suzuki": "MARUTI",
  "sun pharma": "SUNPHARMA", "sunpharma": "SUNPHARMA",
  "titan": "TITAN", "titan company": "TITAN",
  "ultraTech": "ULTRACEMCO", "ultratech": "ULTRACEMCO", "ultratech cement": "ULTRACEMCO",
  "nestle": "NESTLEIND", "nestle india": "NESTLEIND",
  "tata motors": "TATAMOTORS", "tatamotors": "TATAMOTORS",
  "wipro": "WIPRO",
  "mahindra": "M&M", "m&m": "M&M", "mahindra & mahindra": "M&M",
  "hcl tech": "HCLTECH", "hcltech": "HCLTECH", "hcl technologies": "HCLTECH",
  "power grid": "POWERGRID", "powergrid": "POWERGRID",
  "ntpc": "NTPC",
  "ongc": "ONGC",
  "tata steel": "TATASTEEL", "tatasteel": "TATASTEEL",
  "jsw steel": "JSWSTEEL", "jswsteel": "JSWSTEEL",
  "adani enterprise": "ADANIENT", "adani": "ADANIENT", "adanient": "ADANIENT",
  "adani ports": "ADANIPORTS", "adanip": "ADANIPORTS", "adanip": "ADANIPORTS",
  "tech mahindra": "TECHM", "techm": "TECHM",
  "hdfc life": "HDFCLIFE", "hdfclife": "HDFCLIFE",
  "sbi life": "SBILIFE", "sbilife": "SBILIFE",
  "britannia": "BRITANNIA", "britannia industries": "BRITANNIA",
  "cipla": "CIPLA",
  "dr reddy": "DRREDDY", "dr. reddy": "DRREDDY", "drreddy": "DRREDDY",
  "divi's lab": "DIVISLAB", "divislab": "DIVISLAB",
  "eicher": "EICHERMOT", "eicher motors": "EICHERMOT", "eichermot": "EICHERMOT",
  "grasim": "GRASIM",
  "hero moto": "HEROMOTOCO", "hero": "HEROMOTOCO", "heromotoco": "HEROMOTOCO",
  "hindalco": "HINDALCO",
  "indusind bank": "INDUSINDBK", "indusind": "INDUSINDBK", "indusindbk": "INDUSINDBK",
  "bajaj finsv": "BAJAJFINSV", "bajajfinsv": "BAJAJFINSV",
  "coal india": "COALINDIA", "coalindia": "COALINDIA",
  "bpcl": "BPCL",
  "trent": "TRENT",
  "apollo hospitals": "APOLLOHOSP", "apollo": "APOLLOHOSP", "apollohosp": "APOLLOHOSP",
  "ltim": "LTIM", "ltimindtree": "LTIM",
  "hdfc amc": "HDFCAMC", "hdfcamc": "HDFCAMC",
  "pidilite": "PIDILITIND", "pidilite industries": "PIDILITIND",

  // Indices
  "nifty": "NIFTY", "nifty 50": "NIFTY", "nifty50": "NIFTY",
  "bank nifty": "BANKNIFTY", "banknifty": "BANKNIFTY",
  "fin nifty": "FINNIFTY", "finnifty": "FINNIFTY",
  "midcap nifty": "MIDCPNIFTY", "midcpnifty": "MIDCPNIFTY",
  "sensex": "SENSEX", "bse sensex": "SENSEX",

  // Sectors
  "banking": "_SECTOR_BANKING", "bank": "_SECTOR_BANKING", "banks": "_SECTOR_BANKING",
  "it sector": "_SECTOR_IT", "tech sector": "_SECTOR_IT",
  "pharma": "_SECTOR_PHARMA", "pharmaceutical": "_SECTOR_PHARMA",
  "fmcg": "_SECTOR_FFMCG", "fmcg sector": "_SECTOR_FFMCG",
  "auto": "_SECTOR_AUTO", "automobile": "_SECTOR_AUTO", "automotive": "_SECTOR_AUTO",
  "metal": "_SECTOR_METAL", "metals": "_SECTOR_METAL", "steel": "_SECTOR_METAL",
  "energy": "_SECTOR_ENERGY", "oil & gas": "_SECTOR_ENERGY",
  "real estate": "_SECTOR_REALTY", "realty": "_SECTOR_REALTY",
  "infra": "_SECTOR_INFRA", "infrastructure": "_SECTOR_INFRA",
  "nbfC": "_SECTOR_NBFC", "nbfc": "_SECTOR_NBFC", "housing finance": "_SECTOR_NBFC",
};

export function extractStockEntities(headline: string): string[] {
  const lower = headline.toLowerCase();
  const found = new Set<string>();

  for (const [term, symbol] of Object.entries(NSE_STOCK_MAP)) {
    if (lower.includes(term)) {
      found.add(symbol);
    }
  }

  return Array.from(found);
}

export function extractSectorEntities(headline: string): string[] {
  const lower = headline.toLowerCase();
  const sectors: string[] = [];

  for (const [term, symbol] of Object.entries(NSE_STOCK_MAP)) {
    if (symbol.startsWith("_SECTOR_") && lower.includes(term)) {
      sectors.push(symbol.replace("_SECTOR_", ""));
    }
  }

  return sectors;
}
