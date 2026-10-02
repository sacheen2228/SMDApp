// ═══════════════════════════════════════════════════════════════════════════
// Capital Manager — ₹15K → ₹1L Challenge
// FIXED: lot sizes, drawdown, position sizing for small accounts
// ═══════════════════════════════════════════════════════════════════════════

export interface CapitalConfig {
  startingCapital: number;
  targetCapital: number;
  maxRiskPerTradePct: number;
  maxDailyDrawdownPct: number;
  maxTotalDrawdownPct: number;
  maxConcurrentTrades: number;
  maxPositionPct: number;
  lotSizeBuffer: number;
  minTradeValue: number;
}

export const DEFAULT_CAPITAL_CONFIG: CapitalConfig = {
  startingCapital: 15000,
  targetCapital: 100000,
  // 10% risk/trade — one full loss stays inside the 10% daily stop. At 5%
  // (₹750) almost no option lot could ever fit the budget and the challenge
  // would sit NO_TRADE forever.
  maxRiskPerTradePct: 10,
  maxDailyDrawdownPct: 10,
  maxTotalDrawdownPct: 20,
  maxConcurrentTrades: 3,
  // 75% (rule set C): option buyers' deployed premium is bounded by the
  // position cap, actual loss is bounded by the 10% premium stop; 50% left
  // most lot-granular options unsizable at ₹15K (cost > ₹7,500)
  maxPositionPct: 75,
  lotSizeBuffer: 5,   // Reduced from 10% — was inflating costs
  minTradeValue: 500, // Reduced from 1000 — ₹15K needs smaller trades
};

export interface PositionSizing {
  quantity: number;
  lotSize: number;
  lots: number;
  totalCost: number;
  maxLoss: number;
  maxLossPct: number;
  riskAmount: number;
  canTrade: boolean;
  reason?: string;
  instrument: string;
}

export interface DrawdownState {
  currentCapital: number;
  peakCapital: number;
  dailyPnL: number;
  totalDrawdown: number;
  totalDrawdownPct: number;
  dailyDrawdown: number;
  dailyDrawdownPct: number;
  challengeFailed: boolean;
  failureReason?: string;
}

// ── SEBI F&O lot sizes ──
// SNAPSHOT of NSE fo_mktlots.csv (first/current expiry month column,
// OCT-26) taken 2026-10-02. Live fetch (fetchLiveLotSizes) overrides this;
// SENSEX/NIFTY_BANK are NOT in the NSE file (BSE / legacy alias) and keep
// their previous static values. Always verify against the exchange —
// SEBI revises these often (the old 2024 table was badly stale: NIFTY 25→65,
// RELIANCE 250→500, WIPRO 1500→3000).
const FNO_LOT_SIZES: Record<string, number> = {
  "360ONE": 500,
  ABB: 125,
  ABCAPITAL: 3100,
  ADANIENSOL: 675,
  ADANIENT: 309,
  ADANIGREEN: 600,
  ADANIPORTS: 475,
  ADANIPOWER: 3550,
  ALKEM: 125,
  AMBER: 100,
  AMBUJACEM: 1200,
  ANANDRATHI: 250,
  ANGELONE: 2500,
  APLAPOLLO: 350,
  APOLLOHOSP: 125,
  ASHOKLEY: 5000,
  ASIANPAINT: 250,
  ASTRAL: 425,
  ATHERENERG: 375,
  AUBANK: 1000,
  AUROPHARMA: 550,
  AXISBANK: 625,
  "BAJAJ-AUTO": 75,
  BAJAJFINSV: 300,
  BAJAJHLDNG: 75,
  BAJFINANCE: 750,
  BANDHANBNK: 3600,
  BANKBARODA: 2925,
  BANKINDIA: 5200,
  BANKNIFTY: 30,
  BDL: 425,
  BEL: 1425,
  BHARATFORG: 500,
  BHARTIARTL: 475,
  BHEL: 2625,
  BIOCON: 2500,
  BLUESTARCO: 325,
  BOSCHLTD: 25,
  BPCL: 1975,
  BRITANNIA: 125,
  BSE: 200,
  CAMS: 825,
  CANBK: 6750,
  CDSL: 475,
  CGPOWER: 850,
  CHOLAFIN: 625,
  CIPLA: 425,
  COALINDIA: 1350,
  COCHINSHIP: 400,
  COFORGE: 475,
  COLPAL: 275,
  CONCOR: 1250,
  CROMPTON: 2150,
  CUMMINSIND: 200,
  DABUR: 1250,
  DELHIVERY: 2075,
  DIVISLAB: 100,
  DIXON: 50,
  DLF: 950,
  DMART: 150,
  DRREDDY: 625,
  EICHERMOT: 100,
  ENRIN: 175,
  ETERNAL: 2425,
  FEDERALBNK: 2500,
  FINNIFTY: 60,
  FORCEMOT: 25,
  FORTIS: 775,
  GAIL: 3550,
  GLENMARK: 375,
  GMRAIRPORT: 6975,
  GODFRYPHLP: 275,
  GODREJCP: 500,
  GODREJPROP: 325,
  GRASIM: 250,
  "GVT&D": 125,
  HAL: 150,
  HAVELLS: 500,
  HCLTECH: 400,
  HDFCAMC: 300,
  HDFCBANK: 650,
  HDFCLIFE: 1100,
  HEROMOTOCO: 150,
  HINDALCO: 700,
  HINDPETRO: 2025,
  HINDUNILVR: 300,
  HINDZINC: 1225,
  HYUNDAI: 275,
  ICICIBANK: 700,
  ICICIGI: 325,
  ICICIPRULI: 925,
  IDEA: 71475,
  IDFCFIRSTB: 9275,
  IEX: 4350,
  INDHOTEL: 1000,
  INDIANB: 1000,
  INDIGO: 150,
  INDUSINDBK: 700,
  INDUSTOWER: 1700,
  INFY: 400,
  INOXWIND: 6400,
  IOC: 4875,
  IREDA: 4525,
  IRFC: 5425,
  ITC: 1725,
  JINDALSTEL: 625,
  JIOFIN: 2350,
  JSWENERGY: 1075,
  JSWSTEEL: 675,
  JUBLFOOD: 1250,
  KALYANKJIL: 1350,
  KAYNES: 150,
  KEI: 175,
  KFINTECH: 575,
  KOTAKBANK: 2000,
  KPITTECH: 775,
  LAURUSLABS: 850,
  LICHSGFIN: 1000,
  LICI: 1400,
  LODHA: 625,
  LT: 175,
  LTF: 2250,
  LTIM: 150,
  LTM: 150,
  LUPIN: 425,
  "M&M": 200,
  MAHABANK: 6500,
  MANAPPURAM: 3000,
  MANKIND: 250,
  MARICO: 1200,
  MARUTI: 50,
  MAXHEALTH: 525,
  MAZDOCK: 225,
  MCX: 225,
  MFSL: 400,
  MIDCPNIFTY: 120,
  MOTHERSON: 6150,
  MOTILALOFS: 775,
  MPHASIS: 275,
  MUTHOOTFIN: 275,
  "NAM-INDIA": 625,
  NATIONALUM: 1875,
  NAUKRI: 550,
  NBCC: 6500,
  NESTLEIND: 500,
  NHPC: 6950,
  NIFTY: 65,
  NIFTYFPI: 1100,
  NIFTYNXT50: 25,
  NIFTY_BANK: 15,
  NMDC: 6750,
  NTPC: 1500,
  NYKAA: 3125,
  OBEROIRLTY: 350,
  OFSS: 100,
  OIL: 1400,
  ONGC: 2250,
  PAGEIND: 20,
  PATANJALI: 1075,
  PAYTM: 725,
  PERSISTENT: 125,
  PETRONET: 1900,
  PFC: 1300,
  PGEL: 950,
  PHOENIXLTD: 350,
  PIDILITIND: 500,
  PIIND: 175,
  PNB: 8000,
  PNBHOUSING: 650,
  POLICYBZR: 350,
  POLYCAB: 125,
  POWERGRID: 1900,
  POWERINDIA: 25,
  PREMIERENE: 650,
  PRESTIGE: 450,
  RADICO: 150,
  RBLBANK: 3175,
  RECLTD: 1575,
  RELIANCE: 500,
  RVNL: 1925,
  SAGILITY: 12000,
  SAIL: 4700,
  SBICARD: 800,
  SBILIFE: 375,
  SBIN: 750,
  SENSEX: 15,
  SHREECEM: 25,
  SHRIRAMFIN: 825,
  SIEMENS: 175,
  SOLARINDS: 50,
  SONACOMS: 1225,
  SRF: 200,
  SUNPHARMA: 350,
  SUPREMEIND: 175,
  SUZLON: 12700,
  SWIGGY: 1825,
  TATACONSUM: 550,
  TATAELXSI: 125,
  TATAMOTORS: 1250,
  TATAPOWER: 1450,
  TATASTEEL: 2750,
  TCS: 225,
  TECHM: 600,
  TIINDIA: 200,
  TITAN: 175,
  TMPV: 1600,
  TORNTPHARM: 125,
  TRENT: 225,
  TVSMOTOR: 175,
  UJJIVANSFB: 8000,
  ULTRACEMCO: 50,
  UNIONBANK: 4425,
  UNITDSPR: 400,
  UNOMINDA: 550,
  UPL: 1355,
  VBL: 1275,
  VEDL: 1150,
  VMM: 4850,
  VOLTAS: 375,
  WAAREEENER: 175,
  WIPRO: 3000,
  YESBANK: 31100,
  ZOMATO: 6000,
  ZYDUSLIFE: 900,
};

// ── Live lot sizes (NSE fo_mktlots.csv) ──
// SEBI revises lots often; the static snapshot above is only a fallback.
let liveLotSizes: Record<string, number> = {};
let liveLotFetchAt = 0;
const LIVE_LOT_TTL_MS = 2 * 60 * 60 * 1000; // 2h — file changes rarely

/** Parse NSE fo_mktlots.csv → SYMBOL → lot size (first non-empty month column). */
export function parseMktLotsCsv(csv: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!csv || typeof csv !== "string") return out;
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const sym = parts[1];
    if (!/^[A-Z0-9&\-]{2,20}$/.test(sym)) continue; // header/notes rows
    for (const cell of parts.slice(2)) {
      if (/^\d+$/.test(cell) && Number(cell) > 0) {
        out[sym] = Number(cell);
        break;
      }
    }
  }
  return out;
}

/** Inject live lots (loader + tests). */
export function setLiveLotSizes(lots: Record<string, number>): void {
  liveLotSizes = { ...lots };
  liveLotFetchAt = Date.now();
}

export function getLiveLotSizes(): Record<string, number> {
  return { ...liveLotSizes };
}

/**
 * Fetch current lot sizes from NSE archives (fetches once per TTL).
 * Never throws — on any failure returns {} and keeps whatever is cached
 * (static snapshot still applies via getLotSize).
 */
export async function fetchLiveLotSizes(force = false): Promise<Record<string, number>> {
  const now = Date.now();
  if (!force && now - liveLotFetchAt < LIVE_LOT_TTL_MS && Object.keys(liveLotSizes).length > 0) {
    return getLiveLotSizes();
  }
  try {
    const res = await fetch("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv", {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Referer: "https://www.nseindia.com/",
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!res.ok) return getLiveLotSizes();
    const lots = parseMktLotsCsv(await res.text());
    if (Object.keys(lots).length === 0) return getLiveLotSizes();
    setLiveLotSizes(lots);
    console.log(`[Challenge] live lot sizes loaded: ${Object.keys(lots).length} symbols from NSE fo_mktlots.csv`);
    return getLiveLotSizes();
  } catch (e: any) {
    console.warn("[Challenge] live lot fetch failed, using static snapshot:", String(e?.message || e).slice(0, 120));
    return getLiveLotSizes();
  }
}

/** Live first, static snapshot fallback, 1 for unknown (never a guessed lot). */
export function getLotSize(symbol: string): number {
  return liveLotSizes[symbol] ?? FNO_LOT_SIZES[symbol] ?? 1;
}

// ── Calculate position size for equity trade ──
export function calculateEquityPosition(
  capital: number,
  entry: number,
  stopLoss: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): PositionSizing {
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0 || entry <= 0) {
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Invalid entry/SL", instrument: "EQUITY" };
  }

  const riskAmount = capital * (config.maxRiskPerTradePct / 100);
  const maxPositionValue = capital * (config.maxPositionPct / 100);
  const maxQuantity = Math.floor(maxPositionValue / entry);

  // Risk-based quantity
  const riskBasedQty = Math.floor(riskAmount / riskPerShare);
  const quantity = Math.min(riskBasedQty, maxQuantity);

  const totalCost = quantity * entry;
  const maxLoss = quantity * riskPerShare;
  const maxLossPct = (maxLoss / capital) * 100;

  if (quantity <= 0 || totalCost < config.minTradeValue) {
    return { quantity: 0, lotSize: 1, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: quantity <= 0 ? "Capital too small" : `Cost ₹${totalCost} below minimum ₹${config.minTradeValue}`, instrument: "EQUITY" };
  }

  return {
    quantity,
    lotSize: 1,
    lots: quantity,
    totalCost: Math.round(totalCost),
    maxLoss: Math.round(maxLoss),
    maxLossPct: Math.round(maxLossPct * 100) / 100,
    riskAmount: Math.round(riskAmount),
    canTrade: true,
    instrument: "EQUITY",
  };
}

// ── Calculate position size for F&O trade ──
export function calculateFOPosition(
  capital: number,
  entry: number,
  stopLoss: number,
  symbol: string,
  isOption = false,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): PositionSizing {
  const lotSize = getLotSize(symbol);
  const riskPerUnit = Math.abs(entry - stopLoss);

  if (riskPerUnit <= 0 || entry <= 0) {
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: 0, canTrade: false, reason: "Invalid entry/SL", instrument: isOption ? (symbol.includes("CE") ? "CALL" : "PUT") : "FUTURES" };
  }

  const riskPerLot = riskPerUnit * lotSize;
  const riskAmount = capital * (config.maxRiskPerTradePct / 100);
  const lotCost = entry * lotSize * (1 + config.lotSizeBuffer / 100);
  const maxLotsByRisk = Math.floor(riskAmount / riskPerLot);
  const maxLotsByCapital = Math.floor((capital * config.maxPositionPct / 100) / lotCost);

  const lots = Math.min(maxLotsByRisk, maxLotsByCapital);
  if (lots <= 0) {
    // Report the ACTUAL binder(s) — "min lot cost" alone was misleading when
    // the stop-risk budget was the real limit (options stay sizeable only if
    // the user can see why)
    const maxPosition = capital * config.maxPositionPct / 100;
    const fails: string[] = [];
    if (maxLotsByRisk < 1) fails.push(`Stop risk ₹${Math.round(riskPerLot)}/lot > ₹${Math.round(riskAmount)} risk budget`);
    if (maxLotsByCapital < 1) fails.push(`Min lot cost ₹${Math.round(lotCost)} > ₹${Math.round(maxPosition)} limit`);
    return { quantity: 0, lotSize, lots: 0, totalCost: 0, maxLoss: 0, maxLossPct: 0, riskAmount: Math.round(riskAmount), canTrade: false, reason: fails.join(" | "), instrument: isOption ? "OPTION" : "FUTURES" };
  }

  const quantity = lots * lotSize;
  const totalCost = lots * lotCost;
  const maxLoss = lots * riskPerLot;
  const maxLossPct = (maxLoss / capital) * 100;

  return {
    quantity,
    lotSize,
    lots,
    totalCost: Math.round(totalCost),
    maxLoss: Math.round(maxLoss),
    maxLossPct: Math.round(maxLossPct * 100) / 100,
    riskAmount: Math.round(riskAmount),
    canTrade: true,
    instrument: isOption ? "OPTION" : "FUTURES",
  };
}

// ── Check drawdown limits (FIXED: daily uses currentCapital, not startingCapital) ──
export function checkDrawdown(
  currentCapital: number,
  peakCapital: number,
  dailyPnL: number,
  startingCapital: number,
  config: CapitalConfig = DEFAULT_CAPITAL_CONFIG,
): DrawdownState {
  const totalDrawdown = peakCapital - currentCapital;
  const totalDrawdownPct = peakCapital > 0 ? (totalDrawdown / peakCapital) * 100 : 0;
  const dailyDrawdown = dailyPnL < 0 ? Math.abs(dailyPnL) : 0;
  // FIXED: daily drawdown measured against current capital, not starting capital
  const dailyDrawdownPct = currentCapital > 0 ? (dailyDrawdown / currentCapital) * 100 : 0;

  const challengeFailed = totalDrawdownPct >= config.maxTotalDrawdownPct || dailyDrawdownPct >= config.maxDailyDrawdownPct;
  const failureReason = totalDrawdownPct >= config.maxTotalDrawdownPct
    ? `Max total drawdown reached (${totalDrawdownPct.toFixed(1)}% >= ${config.maxTotalDrawdownPct}%)`
    : dailyDrawdownPct >= config.maxDailyDrawdownPct
    ? `Max daily drawdown reached (${dailyDrawdownPct.toFixed(1)}% >= ${config.maxDailyDrawdownPct}%)`
    : undefined;

  return {
    currentCapital,
    peakCapital,
    dailyPnL,
    totalDrawdown,
    totalDrawdownPct: Math.round(totalDrawdownPct * 100) / 100,
    dailyDrawdown,
    dailyDrawdownPct: Math.round(dailyDrawdownPct * 100) / 100,
    challengeFailed,
    failureReason,
  };
}

// ── Get milestone status ──
export function getMilestones(currentCapital: number, startingCapital: number) {
  const milestones = [20000, 30000, 50000, 75000, 100000];
  return milestones.map(target => ({
    target,
    label: `₹${(target / 1000).toFixed(0)}K`,
    reached: currentCapital >= target,
    progress: Math.min(100, Math.max(0, Math.round(((currentCapital - startingCapital) / (target - startingCapital)) * 100))),
  }));
}
