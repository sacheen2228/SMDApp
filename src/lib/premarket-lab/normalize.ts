// Normalization of raw NSE CM / F&O pre-open payloads → typed rows.
// Pure functions — no network, no fabrication.

import type { CmPreopenRow, FuturesPreopenRow } from "./types";
import { finiteOrNull, findDuplicates } from "./quality";
import { parseNseDateToIso } from "./calendar";

function extractBookLevels(detail: any): { bestBid: number | null; bestAsk: number | null; bestBidQty: number | null; bestAskQty: number | null } {
  const preopen: any[] = detail?.preOpenMarket?.preopen || detail?.preopen || [];
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  let bestBidQty: number | null = null;
  let bestAskQty: number | null = null;
  for (const lvl of preopen) {
    const price = finiteOrNull(lvl.price);
    const buy = finiteOrNull(lvl.buyQty) ?? 0;
    const sell = finiteOrNull(lvl.sellQty) ?? 0;
    if (price == null) continue;
    if (buy > 0 && (bestBid == null || price > bestBid)) {
      bestBid = price;
      bestBidQty = buy;
    }
    if (sell > 0 && (bestAsk == null || price < bestAsk)) {
      bestAsk = price;
      bestAskQty = sell;
    }
  }
  return { bestBid, bestAsk, bestBidQty, bestAskQty };
}

export function normalizeCmRow(raw: any): CmPreopenRow | null {
  const meta = raw?.metadata || raw;
  const detail = raw?.detail || {};
  const sym = String(meta?.symbol || meta?.SYMBOL || "").trim();
  if (!sym) return null;
  const book = extractBookLevels(detail);
  const pre = detail.preOpenMarket || detail;
  return {
    symbol: sym,
    series: meta.series,
    purpose: meta.purpose,
    previousClose: finiteOrNull(meta.previousClose ?? pre?.prevClose),
    iep: finiteOrNull(meta.iep ?? pre?.IEP),
    finalPrice: finiteOrNull(meta.lastPrice ?? pre?.finalPrice),
    change: finiteOrNull(meta.change ?? pre?.Change),
    pChange: finiteOrNull(meta.pChange ?? pre?.perChange),
    finalQuantity: finiteOrNull(meta.finalQuantity ?? pre?.finalQuantity),
    totalTurnover: finiteOrNull(meta.totalTurnover),
    totalBuyQuantity: finiteOrNull(pre?.totalBuyQuantity),
    totalSellQuantity: finiteOrNull(pre?.totalSellQuantity),
    atoBuyQty: finiteOrNull(pre?.atoBuyQty),
    atoSellQty: finiteOrNull(pre?.atoSellQty),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bestBidQty: book.bestBidQty,
    bestAskQty: book.bestAskQty,
    marketCap: meta.marketCap,
    yearHigh: finiteOrNull(meta.yearHigh),
    yearLow: finiteOrNull(meta.yearLow),
  };
}

export function normalizeCmPayload(payload: any): { rows: CmPreopenRow[]; timestamp: string | null; duplicates: string[] } {
  const data: any[] = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const rows: CmPreopenRow[] = [];
  for (const raw of data) {
    const row = normalizeCmRow(raw);
    if (row) rows.push(row);
  }
  const timestamp = payload?.timestamp || payload?.maxtimestamp || null;
  const duplicates = findDuplicates(rows, (r) => r.symbol);
  return { rows, timestamp, duplicates };
}

export function normalizeFuturesRow(raw: any): FuturesPreopenRow | null {
  const meta = raw?.metadata || raw;
  const detail = raw?.detail || {};
  const instrumentType = String(meta?.instrumentType || "").toUpperCase();
  if (instrumentType !== "FUTIDX" && instrumentType !== "FUTSTK") return null;
  const sym = String(meta?.symbol || "").trim();
  if (!sym) return null;
  const book = extractBookLevels(detail);
  const pre = detail.preOpenMarket || detail;
  const expiry = String(meta?.expiryDate || "");
  if (!expiry) return null; // never accept futures without expiry
  return {
    instrumentType: instrumentType as "FUTIDX" | "FUTSTK",
    symbol: sym,
    identifier: String(meta?.identifier || `${instrumentType}${sym}${expiry}`),
    expiryDate: expiry,
    previousClose: finiteOrNull(meta.previousClose ?? pre?.prevClose),
    iep: finiteOrNull(meta.iep ?? pre?.IEP),
    finalPrice: finiteOrNull(meta.lastPrice ?? pre?.finalPrice),
    change: finiteOrNull(meta.change ?? pre?.Change),
    pChange: finiteOrNull(meta.pChange ?? pre?.perChange),
    finalQuantity: finiteOrNull(meta.finalQuantity ?? pre?.finalQuantity),
    totalTurnover: finiteOrNull(meta.totalTurnover),
    totalBuyQuantity: finiteOrNull(pre?.totalBuyQuantity),
    totalSellQuantity: finiteOrNull(pre?.totalSellQuantity),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bestBidQty: book.bestBidQty,
    bestAskQty: book.bestAskQty,
  };
}

export function normalizeFuturesPayload(payload: any): { rows: FuturesPreopenRow[]; timestamp: string | null; duplicates: string[] } {
  const data: any[] = Array.isArray(payload?.data) ? payload.data : [];
  const rows: FuturesPreopenRow[] = [];
  for (const raw of data) {
    const row = normalizeFuturesRow(raw);
    if (row) rows.push(row);
  }
  const timestamp = payload?.maxtimestamp || payload?.timestamp || null;
  const duplicates = findDuplicates(rows, (r) => r.identifier);
  return { rows, timestamp, duplicates };
}

/**
 * Select nearest eligible futures contract (current month first, then next).
 * Never returns a contract already expired relative to tradeDate.
 */
export function selectNearestFutures(
  rows: FuturesPreopenRow[],
  symbol: string,
  tradeDate: string,
): FuturesPreopenRow | null {
  const candidates = rows.filter((r) => r.symbol === symbol);
  if (candidates.length === 0) return null;
  const tradeMs = Date.parse(tradeDate + "T12:00:00+05:30");
  const eligible = candidates.filter((r) => {
    const exp = parseNseDateToIso(r.expiryDate);
    if (!exp) return false;
    // expiry on or after trade date (same-day expiry still eligible until close)
    return Date.parse(exp + "T12:00:00+05:30") >= tradeMs - 0;
  });
  const pool = eligible.length > 0 ? eligible : [];
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    const ea = parseNseDateToIso(a.expiryDate) || "9999";
    const eb = parseNseDateToIso(b.expiryDate) || "9999";
    return ea.localeCompare(eb);
  });
  return pool[0];
}

/** Imbalance quantity = buy − sell (indicative). Null when either side missing. */
export function imbalanceQty(buy: number | null, sell: number | null): number | null {
  if (buy == null || sell == null) return null;
  return buy - sell;
}

/** Normalized imbalance in [-1, 1]: (buy−sell)/(buy+sell). Null when denom 0 or missing. */
export function normalizedImbalance(buy: number | null, sell: number | null): number | null {
  if (buy == null || sell == null) return null;
  const denom = buy + sell;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return (buy - sell) / denom;
}
