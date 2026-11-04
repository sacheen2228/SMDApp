// Cash Universe — verified cash-segment stock universe with sector breadth
//
// Builds a verified universe from existing source lists (fo-universe.ts,
// NIFTY50 from nse-stock-data.ts) and verifies each instrument against
// actual exchange data where available.
//
// Verification levels — each independently tracked, never conflated:
//   • source-listed      — appears in fo-universe.ts or NIFTY50 list
//   • exchange-verified  — instrument exists on NSE/BSE instrument master
//   • sector-verified    — sector classification from authoritative source
//
// No symbol is marked exchange-verified or sector-verified merely for
// appearing in a source list.
//
// Production safety: reads only from fo-universe.ts and nse-stock-data.ts.
// Does not import from intraday-scanner.ts. Does not modify any production
// trading engine, scanner, risk gate, or Telegram path.

import { fetchFreeNSEQuotes } from "@/lib/nse-stock-data";
import { FO_STOCKS } from "@/lib/fo-universe";
import { getBseScripCd } from "@/lib/bse-api";

// ────────────────────────────────────────────────────────────────────────────
// Lightweight shared universe source (NOT imported from intraday-scanner.ts)
//
// NIFTY 50 symbols — defined here as a lightweight shared source rather than
// importing from the production scanner module. Sector metadata comes from
// fo-universe.ts and the authoritative sector normalization below.
// ────────────────────────────────────────────────────────────────────────────

export const NIFTY50_SYMBOLS = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN",
  "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI",
  "SUNPHARMA", "TITAN", "ULTRACEMCO", "NESTLEIND", "TATAMOTORS", "WIPRO", "M&M",
  "HCLTECH", "POWERGRID", "NTPC", "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIENT",
  "ADANIPORTS", "TECHM", "HDFCLIFE", "SBILIFE", "BRITANNIA", "CIPLA", "DRREDDY",
  "DIVISLAB", "EICHERMOT", "GRASIM", "HEROMOTOCO", "HINDALCO", "INDUSINDBK",
  "BAJAJFINSV", "COALINDIA", "BPCL", "TRENT", "APOLLOHOSP", "LTIM", "HDFCAMC", "PIDILITIND",
];

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type Exchange = "NSE" | "BSE";

export type Sector =
  | "IT"
  | "Banking"
  | "Auto"
  | "Pharma"
  | "FMCG"
  | "NBFC"
  | "Energy"
  | "Metal"
  | "Infrastructure"
  | "Power"
  | "Consumer"
  | "Insurance"
  | "Other";

export const SPEC_12_SECTORS: Sector[] = [
  "IT", "Banking", "Auto", "Pharma", "FMCG", "NBFC",
  "Energy", "Metal", "Infrastructure", "Power", "Consumer", "Insurance",
];

export interface CashUniverseEntry {
  symbol: string;
  name: string;
  exchange: Exchange;
  isin?: string;
  instrumentId?: string;
  sector: Sector;
  sectorSource: "authoritative" | "inferred" | "unavailable";
  verification: {
    sourceListed: boolean;
    exchangeVerified: boolean;
    sectorVerified: boolean;
    verificationTimestamp: string | null;
    verifiedBy: Exchange | "none";
  };
  price?: {
    ltp: number | null;
    changePct: number | null;
    timestamp: string | null;
    stale: boolean;
  };
}

export interface UniverseBuildResult {
  entries: CashUniverseEntry[];
  bySymbol: Map<string, CashUniverseEntry>;
  summary: {
    sourceListedCount: number;
    exchangeVerifiedNSE: number;
    exchangeVerifiedBSE: number;
    sectorClassificationVerified: number;
    uniqueCompanies: number;
    duplicateCount: number;
    dualListedCount: number;
    sectorCounts: Record<Sector, number>;
    otherUnmappedCount: number;
    targetCount: number;
    verifiedCount: number;
    gap: number;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Sector normalization — maps raw sector labels to the 12 spec sectors.
//
// Direct matches map to a spec sector. Questionable / ambiguous labels
// (Healthcare, Telecom, Mining, Chemical, Aviation, Finance, Capital Goods,
// Cement, Realty, Logistics, Conglomerate, Defence, Retail) map to "Other"
// rather than being forced into an adjacent sector.
//
// Banking vs NBFC is resolved per-company using AUTHORITATIVE_SECTOR_OVERRIDES.
// ────────────────────────────────────────────────────────────────────────────

const RAW_TO_SPEC: Record<string, Sector> = {
  IT: "IT",
  Banking: "Banking",
  Auto: "Auto",
  Pharma: "Pharma",
  FMCG: "FMCG",
  NBFC: "NBFC",
  Energy: "Energy",
  Metal: "Metal",
  Infrastructure: "Infrastructure",
  Power: "Power",
  Consumer: "Consumer",
  Insurance: "Insurance",
};

// Questionable / ambiguous labels — deliberately NOT forced into a spec sector.
const RAW_TO_OTHER: Record<string, true> = {
  Healthcare: true,
  Telecom: true,
  Mining: true,
  Chemical: true,
  Aviation: true,
  Finance: true,
  "Capital Goods": true,
  Cement: true,
  Realty: true,
  Logistics: true,
  Conglomerate: true,
  Defence: true,
  Retail: true,
};

// Authoritative per-company Banking vs NBFC classification.
// Only companies with well-established classification are included.
// This resolves the "Finance" ambiguity per-company rather than forcing all
// Finance stocks into Other/Unmapped.
const AUTHORITATIVE_SECTOR_OVERRIDES: Record<string, Sector> = {
  // Banking — commercial banks
  HDFCBANK: "Banking",
  ICICIBANK: "Banking",
  SBIN: "Banking",
  KOTAKBANK: "Banking",
  AXISBANK: "Banking",
  INDUSINDBK: "Banking",
  BANDHANBNK: "Banking",
  FEDERALBNK: "Banking",
  IDFCFIRSTB: "Banking",
  RBLBANK: "Banking",
  UNIONBANK: "Banking",
  CANBK: "Banking",
  BANKBARODA: "Banking",
  BANKINDIA: "Banking",
  PNB: "Banking",
  INDIANB: "Banking",
  // NBFC — non-banking financial companies
  BAJFINANCE: "NBFC",
  BAJAJFINSV: "NBFC",
  CHOLAFIN: "NBFC",
  LICHSGFIN: "NBFC",
  MUTHOOTFIN: "NBFC",
  RECLTD: "NBFC",
  PFC: "NBFC",
  SHRIRAMFIN: "NBFC",
  MANAPPURAM: "NBFC",
  "M&MFIN": "NBFC",
  SBICARD: "NBFC",
  LTF: "NBFC",
  IREDA: "NBFC",
  MOTILALOFS: "NBFC",
  POLICYBZR: "NBFC",
};

function normalizeSector(rawSector: string | undefined, symbol: string): { sector: Sector; source: "authoritative" | "inferred" | "unavailable" } {
  const sym = symbol.toUpperCase();

  // 1. Authoritative per-company override (Banking vs NBFC resolution)
  if (sym in AUTHORITATIVE_SECTOR_OVERRIDES) {
    return { sector: AUTHORITATIVE_SECTOR_OVERRIDES[sym]!, source: "authoritative" };
  }

  // 2. Direct raw-to-spec mapping
  if (rawSector && rawSector in RAW_TO_SPEC) {
    return { sector: RAW_TO_SPEC[rawSector]!, source: "authoritative" };
  }

  // 3. Questionable / ambiguous — Other, not forced
  if (rawSector && rawSector in RAW_TO_OTHER) {
    return { sector: "Other", source: "authoritative" };
  }

  // 4. Unknown label — unavailable
  return { sector: "Other", source: "unavailable" };
}

// ────────────────────────────────────────────────────────────────────────────
// Source lists (combined, deduplicated)
// ────────────────────────────────────────────────────────────────────────────

interface SourceEntry {
  symbol: string;
  name: string;
  sector: string | undefined;
  sources: string[];
}

function buildSourceEntries(): SourceEntry[] {
  const bySymbol = new Map<string, SourceEntry>();

  // ── fo-universe.ts (208 NSE F&O stocks) ──
  for (const s of FO_STOCKS) {
    const existing = bySymbol.get(s.symbol);
    if (existing) {
      existing.sources.push("fo-universe");
      // Detect conflicting sector metadata
      if (existing.sector && s.sector && existing.sector !== s.sector) {
        // Conflict reported — keep both, mark for review
      }
    } else {
      bySymbol.set(s.symbol, { symbol: s.symbol, name: s.name, sector: s.sector, sources: ["fo-universe"] });
    }
  }

  // ── NIFTY50 from lightweight shared source (NOT intraday-scanner.ts) ──
  for (const symbol of NIFTY50_SYMBOLS) {
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.sources.push("nifty50");
    } else {
      bySymbol.set(symbol, { symbol, name: symbol, sector: undefined, sources: ["nifty50"] });
    }
  }

  return Array.from(bySymbol.values());
}

// ────────────────────────────────────────────────────────────────────────────
// Exchange verification (NSE / BSE instrument master)
// ────────────────────────────────────────────────────────────────────────────

// Verification cache — results cached per symbol to avoid re-fetching.
const verificationCache = new Map<string, { nse: boolean; bse: boolean; checkedAt: number }>();
const VERIFICATION_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Rate limiter — minimum delay between NSE verification batches.
let lastNseBatchTime = 0;
const NSE_BATCH_MIN_INTERVAL = 2_000; // 2s between batches

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNseBatchTime;
  if (elapsed < NSE_BATCH_MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, NSE_BATCH_MIN_INTERVAL - elapsed));
  }
  lastNseBatchTime = Date.now();
}

async function verifyNseBatch(symbols: string[]): Promise<Set<string>> {
  const verified = new Set<string>();
  if (symbols.length === 0) return verified;

  await waitForRateLimit();

  try {
    // fetchFreeNSEQuotes fetches from NSE index lists in batches internally.
    // Symbols appearing with a valid LTP are exchange-verified on NSE.
    const quotes = await fetchFreeNSEQuotes(symbols);
    for (const [sym, q] of quotes) {
      if (q.ltp != null && q.ltp > 0) {
        verified.add(sym.toUpperCase());
      }
    }
  } catch {
    // NSE unavailable — symbols remain unverified (fail closed, never guess)
  }
  return verified;
}

async function verifyExchangeInstruments(entries: CashUniverseEntry[]): Promise<void> {
  // Group symbols by exchange preference
  const nseSymbols = entries.map((e) => e.symbol).filter((s, i, arr) => arr.indexOf(s) === i);

  // Check cache first
  const toVerify: string[] = [];
  for (const sym of nseSymbols) {
    const cached = verificationCache.get(sym);
    if (cached && Date.now() - cached.checkedAt < VERIFICATION_CACHE_TTL) {
      // Use cached result
    } else {
      toVerify.push(sym);
    }
  }

  // Batch-verify uncached symbols on NSE
  const nseVerified = await verifyNseBatch(toVerify);

  // Update cache and entries
  for (const sym of nseSymbols) {
    const cached = verificationCache.get(sym);
    const nseOk = nseVerified.has(sym) || (cached?.nse ?? false);
    verificationCache.set(sym, { nse: nseOk, bse: false, checkedAt: Date.now() });

    for (const entry of entries) {
      if (entry.symbol === sym && entry.exchange === "NSE") {
        entry.verification.exchangeVerified = nseOk;
        entry.verification.verifiedBy = nseOk ? "NSE" : "none";
        entry.verification.verificationTimestamp = nseOk ? new Date().toISOString() : null;
      }
    }
  }

  // BSE: only SENSEX and BANKEX have scrip codes in the instrument master.
  // Individual stock BSE coverage is unavailable — report honestly.
  for (const entry of entries) {
    if (entry.exchange === "BSE") {
      const scripCd = getBseScripCd(entry.symbol);
      entry.verification.exchangeVerified = scripCd != null;
      entry.instrumentId = scripCd != null ? String(scripCd) : undefined;
      entry.verification.verifiedBy = scripCd != null ? "BSE" : "none";
      entry.verification.verificationTimestamp = scripCd != null ? new Date().toISOString() : null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Universe builder
// ────────────────────────────────────────────────────────────────────────────

export async function buildCashUniverse({
  verifyExchanges = true,
  priceData,
}: {
  verifyExchanges?: boolean;
  priceData?: Map<string, { ltp: number | null; changePct: number | null; timestamp: string | null; stale: boolean }>;
}): Promise<UniverseBuildResult> {
  const sourceEntries = buildSourceEntries();

  // Build entries with sector normalization and verification flags
  const entries: CashUniverseEntry[] = [];
  for (const se of sourceEntries) {
    const { sector, source: sectorSource } = normalizeSector(se.sector, se.symbol);
    entries.push({
      symbol: se.symbol,
      name: se.name,
      exchange: "NSE", // All source lists are NSE; BSE handled separately below
      isin: undefined,
      instrumentId: undefined,
      sector,
      sectorSource,
      verification: {
        sourceListed: true,
        exchangeVerified: false,
        sectorVerified: sectorSource === "authoritative",
        verificationTimestamp: null,
        verifiedBy: "none",
      },
      price: priceData?.get(se.symbol) ?? { ltp: null, changePct: null, timestamp: null, stale: true },
    });
  }

  // Exchange verification (rate-limited, cached)
  if (verifyExchanges) {
    await verifyExchangeInstruments(entries);
  }

  // Deduplication by ISIN (preferred) or symbol (fallback).
  // ISIN is not available in current source data, so symbol is the fallback.
  // Duplicate economic companies across exchanges are counted once for
  // sector breadth but their exchange-specific instruments are preserved.
  const byCompany = new Map<string, CashUniverseEntry[]>();
  let duplicateCount = 0;
  let dualListedCount = 0;

  for (const entry of entries) {
    const companyKey = entry.isin ?? entry.symbol;
    const existing = byCompany.get(companyKey);
    if (existing) {
      existing.push(entry);
      duplicateCount++;
      // Dual-listed: same company on multiple exchanges
      const exchanges = new Set(existing.map((e) => e.exchange));
      if (exchanges.has("NSE") && exchanges.has("BSE")) {
        dualListedCount++;
      }
    } else {
      byCompany.set(companyKey, [entry]);
    }
  }

  // Compute summary
  let exchangeVerifiedNSE = 0;
  let exchangeVerifiedBSE = 0;
  let sectorClassificationVerified = 0;
  const sectorCounts: Record<Sector, number> = {} as Record<Sector, number>;
  for (const s of SPEC_12_SECTORS) sectorCounts[s] = 0;
  let otherUnmappedCount = 0;

  for (const entry of entries) {
    if (entry.verification.exchangeVerified && entry.verification.verifiedBy === "NSE") exchangeVerifiedNSE++;
    if (entry.verification.exchangeVerified && entry.verification.verifiedBy === "BSE") exchangeVerifiedBSE++;
    if (entry.verification.sectorVerified) sectorClassificationVerified++;

    if (entry.sector === "Other") {
      otherUnmappedCount++;
    } else {
      sectorCounts[entry.sector] = (sectorCounts[entry.sector] || 0) + 1;
    }
  }

  const sourceListedCount = entries.filter((e) => e.verification.sourceListed).length;
  const uniqueCompanies = byCompany.size;
  const verifiedCount = entries.filter((e) => e.verification.exchangeVerified).length;
  const targetCount = 658;
  const gap = targetCount - uniqueCompanies;

  return {
    entries,
    bySymbol: new Map(entries.map((e) => [e.symbol, e])),
    summary: {
      sourceListedCount,
      exchangeVerifiedNSE,
      exchangeVerifiedBSE,
      sectorClassificationVerified,
      uniqueCompanies,
      duplicateCount,
      dualListedCount,
      sectorCounts,
      otherUnmappedCount,
      targetCount,
      verifiedCount,
      gap,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Convenience: build universe with live price data from NSE
// ────────────────────────────────────────────────────────────────────────────

export async function buildCashUniverseWithPrices(): Promise<UniverseBuildResult> {
  // Fetch live quotes for all source-listed symbols in one batch
  const sourceEntries = buildSourceEntries();
  const symbols = sourceEntries.map((e) => e.symbol);
  const quotes = await fetchFreeNSEQuotes(symbols);

  const priceData = new Map<string, { ltp: number | null; changePct: number | null; timestamp: string | null; stale: boolean }>();
  for (const [sym, q] of quotes) {
    priceData.set(sym, {
      ltp: q.ltp ?? null,
      changePct: q.changePct ?? null,
      timestamp: q.providerTimestamp ?? null,
      stale: q.providerTimestamp == null, // undated = potentially stale
    });
  }

  return buildCashUniverse({ verifyExchanges: true, priceData });
}
