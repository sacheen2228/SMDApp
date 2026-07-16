// ─── Per-Stock Option Chain Fetcher ────────────────────────────────
// Fetches NSE option chain data for individual F&O stocks.
// Used by the scanner to feed real per-stock option data to the AI engine.
// Caches results in-memory to avoid re-fetching during the same scan.
// Also reads from DB (domAnalysis table) for pre-market analysis.

import type { OptionData } from "@/lib/institutional-ai/types";

// Lazy-loaded server-only imports — avoids bundling nse-bse-api/adm-zip → fs into client
let _getSingleStockDOM: ((symbol: string) => Promise<any>) | null = null;
type DOMStrike = {
  strike: number;
  ce: { oi: number; oiChg: number; volume: number; ltp: number; iv: number; bid: number; ask: number; bidQty: number; askQty: number; totalBuyQty: number; totalSellQty: number; } | null;
  pe: { oi: number; oiChg: number; volume: number; ltp: number; iv: number; bid: number; ask: number; bidQty: number; askQty: number; totalBuyQty: number; totalSellQty: number; } | null;
};

async function getSingleStockDOM(symbol: string): Promise<any> {
  if (!_getSingleStockDOM) {
    const mod = await import("./dom-analysis");
    _getSingleStockDOM = mod.getSingleStockDOM;
  }
  return _getSingleStockDOM(symbol);
}

let _prisma: any = null;
async function getPrisma() {
  if (!_prisma) {
    const { PrismaClient } = await import("@prisma/client");
    const g = globalThis as unknown as { prisma: any };
    _prisma = g.prisma || new PrismaClient();
    if (process.env.NODE_ENV !== "production") g.prisma = _prisma;
  }
  return _prisma;
}

// ─── In-Memory Cache ──────────────────────────────────────────────
interface CacheEntry {
  strikes: DOMStrike[];
  spot: number;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(symbol: string): DOMStrike[] | null {
  const entry = cache.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(symbol);
    return null;
  }
  return entry.strikes;
}

function setCache(symbol: string, strikes: DOMStrike[]): void {
  cache.set(symbol, { strikes, spot: 0, timestamp: Date.now() });
}

// ─── Pre-Market: Read from DB ─────────────────────────────────────
/**
 * Check if it's pre-market hours (before 9:15 AM IST).
 * NSE pre-market session: 9:00-9:15 AM IST.
 * Market hours: 9:15 AM - 3:30 PM IST.
 */
export function isPreMarket(): boolean {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const hours = istTime.getUTCHours();
  const minutes = istTime.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;
  // Before 9:15 AM IST (555 minutes)
  return totalMinutes < 555;
}

/**
 * Read per-stock option chains from the domAnalysis table.
 * Used for pre-market analysis when live data isn't available yet.
 */
async function readFromDB(symbols: string[]): Promise<Map<string, PerStockOptionChain>> {
  const results = new Map<string, PerStockOptionChain>();
  const prisma = await getPrisma();

  // Get today's IST date
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  istDate.setHours(0, 0, 0, 0);

  // Also check yesterday's data (in case today's cron hasn't run yet)
  const yesterday = new Date(istDate);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const sym of symbols) {
    try {
      // Try today first, then yesterday
      let record = await prisma.domAnalysis.findUnique({
        where: { symbol_date: { symbol: sym, date: istDate } },
      });
      if (!record) {
        record = await prisma.domAnalysis.findUnique({
          where: { symbol_date: { symbol: sym, date: yesterday } },
        });
      }

      if (record && record.strikes) {
        const strikes = record.strikes as unknown as DOMStrike[];
        const optionData = domStrikesToOptionData(strikes);
        const pcr = record.pcr || calculatePCR(strikes);
        const maxPain = record.maxPain || calculateMaxPain(strikes);
        results.set(sym, {
          symbol: sym,
          strikes,
          optionData,
          spot: record.spot,
          pcr,
          maxPain,
        });
      }
    } catch {
      // DB read failure is non-blocking
    }
  }

  return results;
}

// ─── Conversion: DOMStrike[] → OptionData[] ───────────────────────
export function domStrikesToOptionData(strikes: DOMStrike[]): OptionData[] {
  return strikes
    .filter((s) => s.ce || s.pe)
    .map((s) => ({
      strike: s.strike,
      callOI: s.ce?.oi ?? 0,
      putOI: s.pe?.oi ?? 0,
      callOIChange: s.ce?.oiChg ?? 0,
      putOIChange: s.pe?.oiChg ?? 0,
      callVolume: s.ce?.volume ?? 0,
      putVolume: s.pe?.volume ?? 0,
      callIV: s.ce?.iv ?? 0,
      putIV: s.pe?.iv ?? 0,
    }));
}

// ─── Batch Fetcher ────────────────────────────────────────────────
export interface PerStockOptionChain {
  symbol: string;
  strikes: DOMStrike[];
  optionData: OptionData[];
  spot: number;
  pcr: number;
  maxPain: number;
}

/**
 * Fetch per-stock option chains for a list of symbols.
 * During pre-market: reads from DB (domAnalysis table).
 * During market hours: fetches live from NSE API with batch processing.
 * Returns a Map of symbol → option chain data.
 */
export async function fetchPerStockOptionChains(
  symbols: string[]
): Promise<Map<string, PerStockOptionChain>> {
  const results = new Map<string, PerStockOptionChain>();

  // Check cache first
  const toFetch: string[] = [];
  for (const sym of symbols) {
    const cached = getCached(sym);
    if (cached) {
      const optionData = domStrikesToOptionData(cached);
      const pcr = calculatePCR(cached);
      const maxPain = calculateMaxPain(cached);
      const spot = cached[0]?.strike || 0;
      results.set(sym, { symbol: sym, strikes: cached, optionData, spot, pcr, maxPain });
    } else {
      toFetch.push(sym);
    }
  }

  if (toFetch.length === 0) return results;

  // Pre-market: read from DB instead of live API
  if (isPreMarket()) {
    console.log("[PerStockOC] Pre-market mode — reading from DB");
    const dbResults = await readFromDB(toFetch);
    for (const [sym, data] of dbResults) {
      setCache(sym, data.strikes);
      results.set(sym, data);
    }
    // Return what we have (some symbols may not have DB data)
    return results;
  }

  // Market hours: batch fetch from NSE API.
  // NSE aggressively rate-limits / IP-blocks during market hours, so we:
  //  - fetch sequentially (concurrency 1) to stay under NSE's radar
  //  - retry each symbol up to 2× with backoff
  //  - insert a delay between symbols and between batches
  const BATCH_SIZE = 3;
  const DELAY_MS = 1500;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    for (const sym of batch) {
      let success = false;
      for (let attempt = 0; attempt < 2 && !success; attempt++) {
        try {
          const dom = await getSingleStockDOM(sym);
          if (dom && dom.strikes.length > 0) {
            setCache(sym, dom.strikes);
            const optionData = domStrikesToOptionData(dom.strikes);
            results.set(sym, {
              symbol: sym,
              strikes: dom.strikes,
              optionData,
              spot: dom.spot,
              pcr: dom.pcr,
              maxPain: dom.maxPain,
            });
            success = true;
          } else if (attempt < 1) {
            await sleep(1000);
          }
        } catch (e: any) {
          console.warn(`[PerStockOC] ${sym} attempt ${attempt + 1} failed:`, e?.message);
          if (attempt < 1) await sleep(1000);
        }
      }
      // Inter-symbol delay to avoid rapid-fire NSE requests
      await sleep(500);
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function calculatePCR(strikes: DOMStrike[]): number {
  const totalCallOI = strikes.reduce((sum, s) => sum + (s.ce?.oi || 0), 0);
  const totalPutOI = strikes.reduce((sum, s) => sum + (s.pe?.oi || 0), 0);
  return totalCallOI > 0 ? totalPutOI / totalCallOI : 1;
}

function calculateMaxPain(strikes: DOMStrike[]): number {
  let maxPain = 0;
  let minLoss = Infinity;

  for (const s of strikes) {
    let totalLoss = 0;
    for (const k of strikes) {
      if (k.ce) totalLoss += k.ce.oi * Math.max(0, k.strike - s.strike);
      if (k.pe) totalLoss += k.pe.oi * Math.max(0, s.strike - k.strike);
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPain = s.strike;
    }
  }
  return maxPain;
}

/**
 * Clear the in-memory cache (useful for testing or force-refresh).
 */
export function clearOptionChainCache(): void {
  cache.clear();
}
