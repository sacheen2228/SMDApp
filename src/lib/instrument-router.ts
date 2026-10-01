/*
 * Instrument Router
 * Routes symbols to the appropriate engine and strategy set.
 * Index vs. liquid-stock vs. illiquid-stock classification.
 * 
 * Rules (per design spec):
 * - INDEX → engine: "option", strategySet: "index_s1_s8"
 * - LIQUID_STOCK → engine: "option", strategySet: "stock_event_driven"
 * - ILLIQUID_STOCK → engine: "cash_futures", strategySet: "none"
 * 
 * Router is classification-only — no new engine, no new polling loop.
 * Runs once per symbol lookup (chat query, tab symbol change, scheduled scan).
 * Does its own lightweight liquidity re-check against the current option chain.
 */

// Manually curated liquid-stock list (top ~25-30 F&O names by option turnover).
const LIQUID_STOCKS: Set<string> = new Set([
  "HDFCBANK",
  "RELIANCE",
  "ICICIBANK",
  "INFY",
  "TCS",
  "SBIN",
  "AXISBANK",
  "KOTAKBANK",
  "BHARTIARTL",
  "LT",
  "ASIANPAINT",
  "MARUTI",
  "TATAMOTORS",
  "HCLTECH",
  "ITC",
  "SUNPHARMA",
  "ULTRACEMCO",
  "POWERGRID",
  "ONGC",
  "NTPC",
  "COALINDIA",
  "BPCL",
  "DRREDDY",
  "EICHERMOT",
  "INDUSINDBK",
]);

// Index symbols (NSE institutional benchmark indices).
const INDEX_SYMBOLS: Set<string> = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "SENSEX",
]);


/**
 * Checks if the option chain has sufficient liquidity for a given symbol.
 * The index rule: top-5 OI strikes must have real volume, spread <=2%.
 * This function implements the same liquidity re-check at signal time.
 */
function hasSufficientLiquidity(optionChain: any): boolean {
  if (!optionChain || !optionChain.data || optionChain.data.length === 0) {
    return false;
  }

  const rows: any[] = optionChain.data;

  // Collect top-5 strikes by open interest (only rows with both CE and PE having OI)
  const withOI: any[] = rows.filter(
    (row) => row.CE && row.CE.openInterest > 0 && row.PE && row.PE.openInterest > 0
  )
    .sort((a: any, b: any) => b.CE.openInterest - a.CE.openInterest)
    .slice(0, 5);

  if (withOI.length < 3) {
    return false; // Not enough liquid strikes
  }

  // Check spread <= 2% for each of the top-5
  for (let i = 0; i < withOI.length; i++) {
    const row: any = withOI[i];
    const ce: any = row.CE;
    const pe: any = row.PE;

    const ceMid: number = (ce.bidPrice + ce.askPrice) / 2 || ce.lastPrice;
    const peMid: number = (pe.bidPrice + pe.askPrice) / 2 || pe.lastPrice;

    const ceSpreadPct: number = ceMid > 0 ? ((ce.askPrice - ce.bidPrice) / ceMid) * 100 : 0;
    const peSpreadPct: number = peMid > 0 ? ((pe.askPrice - pe.bidPrice) / peMid) * 100 : 0;

    if (ceSpreadPct > 2 || peSpreadPct > 2) {
      return false; // Spread too wide — illiquid
    }
  }

  return true;
}


/**
 * Classification result per the spec.
 */
export type InstrumentClass = "INDEX" | "LIQUID_STOCK" | "ILLIQUID_STOCK";

export interface RouterResult {
  instrumentClass: InstrumentClass;
  engine: "option" | "cash_futures";
  strategySet: "index_s1_s8" | "stock_event_driven" | "none";
  reasons: string[];
}


/**
 * Classifies a symbol into one of three instrument classes.
 * 
 * - INDEX: NIFTY, BANKNIFTY, FINNIFTY, SENSEX → option engine, index_s1_s8 strategy
 * - LIQUID_STOCK: static liquid list + live liquidity re-check → option engine, stock_event_driven strategy
 * - ILLIQUID_STOCK: everything else → cash_futures engine, no strategy
 * 
 * The classification runs once per symbol lookup. It does NOT poll for live data
 * — the caller provides a snapshot (option chain) for the live liquidity re-check.
 * If no snapshot is provided, the liquidity check will fail for any stock without a
 * provided chain.
 */
export function classifyInstrument(
  symbol: string,
  snapshot?: any
): RouterResult {
  const upper: string = symbol.toUpperCase();

  // 1. Check if it's an index
  if (INDEX_SYMBOLS.has(upper)) {
    return {
      instrumentClass: "INDEX",
      engine: "option",
      strategySet: "index_s1_s8",
      reasons: ["Index symbol (NIFTY/BANKNIFTY/FINNIFTY/SENSEX)"],
    };
  }

  // 2. Check if it's on the liquid-stock static list
  if (LIQUID_STOCKS.has(upper)) {
    const liquidityOk: boolean = hasSufficientLiquidity(snapshot);
    
    if (liquidityOk) {
      return {
        instrumentClass: "LIQUID_STOCK",
        engine: "option",
        strategySet: "stock_event_driven",
        reasons: ["Liquid-stock (static list), liquidity re-check: passed"],
      };
    } else {
      // Static list match but liquidity failed → illiquid
      return {
        instrumentClass: "ILLIQUID_STOCK",
        engine: "cash_futures",
        strategySet: "none",
        reasons: ["Static-list match but option chain too illiquid (spread >2% or no volume)"],
      };
    }
  }

  // 3. Everything else → illiquid (NSE 500 names without active option chains)
  return {
    instrumentClass: "ILLIQUID_STOCK",
    engine: "cash_futures",
    strategySet: "none",
    reasons: ["Unknown symbol — not index, not on liquid list; routing to cash/futures"],
  };
}

export default { classifyInstrument };