// Sector Breadth — pure, testable sector breadth calculations.
//
// Takes verified universe entries with price data and computes:
//   • advances / declines / unchanged (only valid, non-stale prices)
//   • sector counts (12 spec sectors + Other/Unmapped, separate)
//   • unique company count (deduplicated by ISIN)
//   • duplicate / dual-listed counts
//
// Missing, null, or stale prices are NOT interpreted as zero returns or
// unchanged stocks. A stock without valid price data is excluded from
// breadth calculations entirely.
//
// No network calls. No production dependencies. Pure function of inputs.

import type { CashUniverseEntry, Sector } from "./cash-universe";
import { SPEC_12_SECTORS } from "./cash-universe";

export interface SectorBreadthResult {
  advances: number;
  declines: number;
  unchanged: number;
  totalWithPriceData: number;
  withoutPriceData: number;
  sectorCounts: Record<Sector, number>;
  otherUnmappedCount: number;
  sectorAdvances: Record<Sector, number>;
  sectorDeclines: Record<Sector, number>;
  uniqueCompanies: number;
  duplicateCount: number;
  dualListedCount: number;
}

const TWELVE_SECTORS: Sector[] = SPEC_12_SECTORS;

/** A price is valid only when LTP > 0 and changePct is a finite number. */
function hasValidPrice(entry: CashUniverseEntry): boolean {
  const p = entry.price;
  if (!p) return false;
  if (p.stale) return false;
  if (p.ltp == null || p.ltp <= 0) return false;
  if (p.changePct == null || !Number.isFinite(p.changePct)) return false;
  return true;
}

/** Classify a stock with valid price data as advancing / declining / unchanged. */
function classifyPrice(entry: CashUniverseEntry): "advancing" | "declining" | "unchanged" {
  const cp = entry.price!.changePct!;
  if (cp > 0) return "advancing";
  if (cp < 0) return "declining";
  return "unchanged";
}

/**
 * Compute sector breadth from verified universe entries.
 *
 * Companies are deduplicated by ISIN (preferred) or symbol (fallback).
 * For breadth, each unique company is counted once using its NSE instrument
 * (preferred over BSE). BSE-only instruments are counted if no NSE exists.
 *
 * Stocks without valid price data are excluded from advances/declines/
 * unchanged but still appear in the sector listing (without a direction).
 */
export function computeSectorBreadth(entries: CashUniverseEntry[]): SectorBreadthResult {
  // ── Deduplicate by company (ISIN preferred, symbol fallback) ──
  const byCompany = new Map<string, CashUniverseEntry[]>();
  for (const entry of entries) {
    const key = entry.isin ?? entry.symbol;
    const existing = byCompany.get(key);
    if (existing) existing.push(entry);
    else byCompany.set(key, [entry]);
  }

  let duplicateCount = 0;
  let dualListedCount = 0;
  for (const [, group] of byCompany) {
    if (group.length > 1) duplicateCount += group.length - 1;
    const exchanges = new Set(group.map((e) => e.exchange));
    if (exchanges.has("NSE") && exchanges.has("BSE")) dualListedCount++;
  }

  // ── Select representative entry per company for breadth ──
  // Prefer NSE (primary exchange), fall back to BSE, then first available.
  const representatives: CashUniverseEntry[] = [];
  for (const group of byCompany.values()) {
    const nse = group.find((e) => e.exchange === "NSE");
    const rep = nse ?? group[0];
    representatives.push(rep);
  }

  // ── Breadth calculation ──
  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  let totalWithPriceData = 0;
  let withoutPriceData = 0;

  const sectorCounts: Record<Sector, number> = {} as Record<Sector, number>;
  for (const s of TWELVE_SECTORS) sectorCounts[s] = 0;
  let otherUnmappedCount = 0;

  const sectorAdvances: Record<Sector, number> = {} as Record<Sector, number>;
  const sectorDeclines: Record<Sector, number> = {} as Record<Sector, number>;
  for (const s of TWELVE_SECTORS) {
    sectorAdvances[s] = 0;
    sectorDeclines[s] = 0;
  }

  for (const rep of representatives) {
    // Sector count — every company counted once in its sector
    if (rep.sector === "Other") {
      otherUnmappedCount++;
    } else {
      sectorCounts[rep.sector] = (sectorCounts[rep.sector] || 0) + 1;
    }

    // Price direction — only valid, non-stale prices
    if (hasValidPrice(rep)) {
      totalWithPriceData++;
      const direction = classifyPrice(rep);
      if (direction === "advancing") {
        advances++;
        sectorAdvances[rep.sector] = (sectorAdvances[rep.sector] || 0) + 1;
      } else if (direction === "declining") {
        declines++;
        sectorDeclines[rep.sector] = (sectorDeclines[rep.sector] || 0) + 1;
      } else {
        unchanged++;
      }
    } else {
      withoutPriceData++;
    }
  }

  return {
    advances,
    declines,
    unchanged,
    totalWithPriceData,
    withoutPriceData,
    sectorCounts,
    otherUnmappedCount,
    sectorAdvances,
    sectorDeclines,
    uniqueCompanies: byCompany.size,
    duplicateCount,
    dualListedCount,
  };
}
