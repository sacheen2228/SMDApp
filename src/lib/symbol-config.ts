// Symbol Configuration — lot sizes, tick sizes, and market-specific settings
//
// SINGLE SOURCE OF TRUTH for lot sizes. Do not redefine LOT_SIZES /
// lotSizes / a hardcoded lot-size map anywhere else in the codebase —
// import getLotSize()/SYMBOL_CONFIGS from here instead. (This file
// replaced 4+ independently-drifting copies found across
// trades/today, backtest-audit, BacktestPanel, agent-engine,
// backtest-engine, SDMAIDashboard, and useTerminalStore — see
// AGENTS.md changelog.)
//
// THE FALLBACK NEVER GUESSES A LOT SIZE.
// getSymbolConfig() used to return the NIFTY config for EVERY unknown symbol,
// so every STOCK option's ₹ amounts were computed with NIFTY's lot size (65)
// while SBIN's real lot is 750 — the "%" of a trade was right, the ₹ was
// ~11× wrong. An unknown symbol now returns a config whose lotSize is
// EXPLICITLY UNKNOWN (0) and whose lotSizeKnown is false: a consumer must
// fail closed (or look the real lot up) instead of silently inheriting 65.
//
// The NSE F&O stock lots below are the real NewBrdLotQty values from the NSE
// F&O bhavcopy (19-Oct-2026) — the same file the chain reader parses. NSE
// revises lot sizes with notice; refresh this table from the bhavcopy
// (TckrSymb → NewBrdLotQty) when the exchange publishes a change, or push a
// live-resolved lot with setKnownLotSize() (see below).

export interface SymbolConfig {
  symbol: string;
  label: string;
  /** The contract lot size. 0 = UNKNOWN — never a guessed value. */
  lotSize: number;
  tickSize: number;
  maxLots: number;
  typicalPremium: number; // avg ATM premium for position sizing
  /** false → the lot size is NOT known (lotSize === 0). Fail closed. */
  lotSizeKnown?: boolean;
}

/** The lot size of a symbol we have no contract for. Never a guess. */
export const UNKNOWN_LOT_SIZE = 0;

/**
 * What getLotSize() returns for a symbol whose contract lot is NOT known:
 * ONE unit. The amount is then the honest PER-UNIT amount (and it keeps the
 * sign — a stop-out is still a loss), instead of the 4-11× overstated
 * NIFTY-sized position the old fallback produced. Consumers that must not
 * guess at all use getLotSizeStrict() (null) or the config's lotSize (0).
 */
export const PER_UNIT_LOT_SIZE = 1;

/**
 * NSE F&O stock-option lot sizes — NewBrdLotQty from the NSE F&O bhavcopy
 * (19-Oct-2026). Only the lot size is known for these; the other config
 * fields stay 0 (unknown) so nothing can size a position off a guess.
 */
export const NSE_FO_LOT_SIZES: Record<string, number> = {
  "360ONE": 500, ABB: 125, ABCAPITAL: 3100, ADANIENSOL: 675, ADANIENT: 309, ADANIGREEN: 600,
  ADANIPORTS: 475, ADANIPOWER: 3550, ALKEM: 125, AMBER: 100, AMBUJACEM: 1200, ANANDRATHI: 250,
  ANGELONE: 2500, APLAPOLLO: 350, APOLLOHOSP: 125, ASHOKLEY: 5000, ASIANPAINT: 250, ASTRAL: 425,
  ATHERENERG: 375, AUBANK: 1000, AUROPHARMA: 550, AXISBANK: 625, "BAJAJ-AUTO": 75, BAJAJFINSV: 300,
  BAJAJHLDNG: 75, BAJFINANCE: 750, BANDHANBNK: 3600, BANKBARODA: 2925, BANKINDIA: 5200, BDL: 425,
  BEL: 1425, BHARATFORG: 500, BHARTIARTL: 475, BHEL: 2625, BIOCON: 2500, BLUESTARCO: 325, BOSCHLTD: 25,
  BPCL: 1975, BRITANNIA: 125, BSE: 200, CAMS: 825, CANBK: 6750, CDSL: 475, CGPOWER: 850, CHOLAFIN: 625,
  CIPLA: 425, COALINDIA: 1350, COCHINSHIP: 400, COFORGE: 475, COLPAL: 275, CONCOR: 1250, CROMPTON: 2150,
  CUMMINSIND: 200, DABUR: 1250, DELHIVERY: 2075, DIVISLAB: 100, DIXON: 50, DLF: 950, DMART: 150,
  DRREDDY: 625, EICHERMOT: 100, ENRIN: 175, ETERNAL: 2425, FEDERALBNK: 2500, FORCEMOT: 25, FORTIS: 775,
  GAIL: 3550, GLENMARK: 375, GMRAIRPORT: 6975, GODFRYPHLP: 275, GODREJCP: 500, GODREJPROP: 325,
  GRASIM: 250, "GVT&D": 125, HAL: 150, HAVELLS: 500, HCLTECH: 400, HDFCAMC: 300, HDFCBANK: 650,
  HDFCLIFE: 1100, HEROMOTOCO: 150, HINDALCO: 700, HINDPETRO: 2025, HINDUNILVR: 300, HINDZINC: 1225,
  HYUNDAI: 275, ICICIBANK: 700, ICICIGI: 325, ICICIPRULI: 925, IDEA: 71475, IDFCFIRSTB: 9275, IEX: 4350,
  INDHOTEL: 1000, INDIANB: 1000, INDIGO: 150, INDUSINDBK: 700, INDUSTOWER: 1700, INFY: 400, INOXWIND: 6400,
  IOC: 4875, IREDA: 4525, IRFC: 5425, ITC: 1725, JINDALSTEL: 625, JIOFIN: 2350, JSWENERGY: 1075,
  JSWSTEEL: 675, JUBLFOOD: 1250, KALYANKJIL: 1350, KAYNES: 150, KEI: 175, KFINTECH: 575, KOTAKBANK: 2000,
  KPITTECH: 775, LAURUSLABS: 850, LICHSGFIN: 1000, LICI: 1400, LODHA: 625, LT: 175, LTF: 2250, LTM: 150,
  LUPIN: 425, "M&M": 200, MAHABANK: 6500, MANAPPURAM: 3000, MANKIND: 250, MARICO: 1200, MARUTI: 50,
  MAXHEALTH: 525, MAZDOCK: 225, MCX: 225, MFSL: 400, MOTHERSON: 6150, MOTILALOFS: 775, MPHASIS: 275,
  MUTHOOTFIN: 275, "NAM-INDIA": 625, NATIONALUM: 1875, NAUKRI: 550, NBCC: 6500, NESTLEIND: 500, NHPC: 6950,
  NIFTYFPI: 1100, NMDC: 6750, NTPC: 1500, NYKAA: 3125, OBEROIRLTY: 350, OFSS: 100, OIL: 1400, ONGC: 2250,
  PAGEIND: 20, PATANJALI: 1075, PAYTM: 725, PERSISTENT: 125, PETRONET: 1900, PFC: 1300, PGEL: 950,
  PHOENIXLTD: 350, PIDILITIND: 500, PIIND: 175, PNB: 8000, PNBHOUSING: 650, POLICYBZR: 350, POLYCAB: 125,
  POWERGRID: 1900, POWERINDIA: 25, PREMIERENE: 650, PRESTIGE: 450, RADICO: 150, RBLBANK: 3175, RECLTD: 1575,
  RELIANCE: 500, RVNL: 1925, SAGILITY: 12000, SAIL: 4700, SBICARD: 800, SBILIFE: 375, SBIN: 750,
  SHREECEM: 25, SHRIRAMFIN: 825, SIEMENS: 175, SOLARINDS: 50, SONACOMS: 1225, SRF: 200, SUNPHARMA: 350,
  SUPREMEIND: 175, SUZLON: 12700, SWIGGY: 1825, TATACONSUM: 550, TATAELXSI: 125, TATAPOWER: 1450,
  TATASTEEL: 2750, TCS: 225, TECHM: 600, TIINDIA: 200, TITAN: 175, TMPV: 1600, TORNTPHARM: 125, TRENT: 225,
  TVSMOTOR: 175, UJJIVANSFB: 8000, ULTRACEMCO: 50, UNIONBANK: 4425, UNITDSPR: 400, UNOMINDA: 550, UPL: 1355,
  VBL: 1275, VEDL: 1150, VMM: 4850, VOLTAS: 375, WAAREEENER: 175, WIPRO: 3000, YESBANK: 31100, ZYDUSLIFE: 900,
};

function stockConfig(symbol: string, lotSize: number): SymbolConfig {
  return {
    symbol,
    label: symbol,
    lotSize,
    tickSize: 0.05,
    maxLots: 0, // unknown — the lot size is the only thing the bhavcopy gives us
    typicalPremium: 0,
    lotSizeKnown: true,
  };
}

export const SYMBOL_CONFIGS: Record<string, SymbolConfig> = {
  NIFTY: {
    symbol: "NIFTY",
    label: "NIFTY 50",
    lotSize: 65,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 120,
    lotSizeKnown: true,
  },
  BANKNIFTY: {
    symbol: "BANKNIFTY",
    label: "BANK NIFTY",
    lotSize: 30,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 200,
    lotSizeKnown: true,
  },
  FINNIFTY: {
    symbol: "FINNIFTY",
    label: "FIN NIFTY",
    lotSize: 60,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 100,
    lotSizeKnown: true,
  },
  MIDCPNIFTY: {
    symbol: "MIDCPNIFTY",
    label: "MIDCAP NIFTY",
    lotSize: 120,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 80,
    lotSizeKnown: true,
  },
  SENSEX: {
    symbol: "SENSEX",
    label: "SENSEX",
    lotSize: 20,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 150,
    lotSizeKnown: true,
  },
  BANKEX: {
    symbol: "BANKEX",
    label: "BANKEX (BSE)",
    lotSize: 30,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 150,
    lotSizeKnown: true,
  },
  NIFTYNXT50: {
    symbol: "NIFTYNXT50",
    label: "NIFTY NEXT 50",
    lotSize: 25,
    tickSize: 0.05,
    maxLots: 25,
    typicalPremium: 100,
    lotSizeKnown: true,
  },
  // ── MCX Commodity (10 approved contracts) ──
  CRUDEOIL: {
    symbol: "CRUDEOIL",
    label: "CRUDE OIL",
    lotSize: 100,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 500,
    lotSizeKnown: true,
  },
  CRUDEOILM: {
    symbol: "CRUDEOILM",
    label: "CRUDE OIL MINI",
    lotSize: 10,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 50,
    lotSizeKnown: true,
  },
  NATURALGAS: {
    symbol: "NATURALGAS",
    label: "NATURAL GAS",
    lotSize: 1250,
    tickSize: 0.1,
    maxLots: 10,
    typicalPremium: 200,
    lotSizeKnown: true,
  },
  NATGASMINI: {
    symbol: "NATGASMINI",
    label: "NATURAL GAS MINI",
    lotSize: 250,
    tickSize: 0.1,
    maxLots: 25,
    typicalPremium: 40,
    lotSizeKnown: true,
  },
  GOLD: {
    symbol: "GOLD",
    label: "GOLD",
    lotSize: 1,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 1000,
    lotSizeKnown: true,
  },
  GOLDM: {
    symbol: "GOLDM",
    label: "GOLD MINI",
    lotSize: 100,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 100,
    lotSizeKnown: true,
  },
  GOLDGUINEA: {
    symbol: "GOLDGUINEA",
    label: "GOLD GUINEA",
    lotSize: 1,
    tickSize: 10,
    maxLots: 10,
    typicalPremium: 5000,
    lotSizeKnown: true,
  },
  SILVER: {
    symbol: "SILVER",
    label: "SILVER",
    lotSize: 30,
    tickSize: 1,
    maxLots: 10,
    typicalPremium: 800,
    lotSizeKnown: true,
  },
  SILVERM: {
    symbol: "SILVERM",
    label: "SILVER MINI",
    lotSize: 5,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 150,
    lotSizeKnown: true,
  },
  SILVERMIC: {
    symbol: "SILVERMIC",
    label: "SILVER MICRO",
    lotSize: 1,
    tickSize: 1,
    maxLots: 25,
    typicalPremium: 30,
    lotSizeKnown: true,
  },
  // ── NSE F&O stock options (real NewBrdLotQty, NSE F&O bhavcopy 19-Oct-2026) ──
  ...Object.fromEntries(
    Object.entries(NSE_FO_LOT_SIZES).map(([symbol, lotSize]) => [symbol, stockConfig(symbol, lotSize)])
  ),
};

/**
 * Live lot sizes pushed in by a server-side resolver (e.g. the NSE
 * fo_mktlots.csv or the F&O bhavcopy NewBrdLotQty). A symbol registered here
 * answers with its REAL lot size even when it is not in the static table —
 * this is the "look the lot up instead of guessing" path for the consumers
 * that must not fail closed.
 */
const liveLotSizes = new Map<string, number>();

export function setKnownLotSize(symbol: string, lotSize: number): void {
  const sym = String(symbol || "").toUpperCase().trim();
  if (!sym || !(Number(lotSize) > 0)) return;
  liveLotSizes.set(sym, Math.floor(Number(lotSize)));
}

export function getKnownLotSizes(): Record<string, number> {
  return Object.fromEntries(liveLotSizes);
}

function normalize(symbol: string): string {
  return String(symbol || "").toUpperCase().trim();
}

/**
 * The config for a symbol. NEVER falls back to NIFTY: an unknown symbol gets
 * an explicitly unknown lot size (0) so no consumer can silently size a
 * position with NIFTY's lot.
 */
export function getSymbolConfig(symbol: string): SymbolConfig {
  const key = normalize(symbol);
  const known = SYMBOL_CONFIGS[key];
  if (known) return known;
  const live = liveLotSizes.get(key);
  if (live) return stockConfig(key, live);
  return {
    symbol: key,
    label: key || "UNKNOWN",
    lotSize: UNKNOWN_LOT_SIZE, // explicitly unknown — never NIFTY's 65
    tickSize: 0.05,
    maxLots: 0,
    typicalPremium: 0,
    lotSizeKnown: false,
  };
}

/**
 * The lot size of a symbol, or ONE UNIT when the contract lot is NOT known.
 * A 0 must fail closed (or be resolved with setKnownLotSize()) — it must never
 * be turned into a plausible-looking number by a `|| 65` style fallback in a
 * consumer. One unit keeps the P&L per-unit and keeps its SIGN; NIFTY's 65
 * for a stock was 4-11× too big.
 */
export function getLotSize(symbol: string): number {
  const lot = getSymbolConfig(symbol).lotSize;
  return lot > 0 ? lot : PER_UNIT_LOT_SIZE;
}

/** The lot size, or null when it is not known. For consumers that fail closed. */
export function getLotSizeStrict(symbol: string): number | null {
  const lot = getSymbolConfig(symbol).lotSize;
  return lot > 0 ? lot : null;
}

/** Is the lot size of this symbol actually known? */
export function hasKnownLotSize(symbol: string): boolean {
  return getSymbolConfig(symbol).lotSize > 0;
}

export function getTickSize(symbol: string): number {
  return getSymbolConfig(symbol).tickSize;
}

/** Round price to nearest tick size (NSE default ₹0.05). Returns number with ≤2 decimals. */
export function roundToTick(price: number, tickSize = 0.05): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(2));
}
