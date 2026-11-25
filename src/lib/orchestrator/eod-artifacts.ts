// Server-only reader for the nse-options-signal skill's EOD artifacts.
//
// The skill's 19:05 EOD job captures NSE's own published figures to disk
// (skills/nse-options-signal/data/eod/<YYYY-MM-DD>/). When the live NSE
// endpoint is rate-limited (403/429) those files are the SAME NSE numbers,
// already collected — a first-class source, not a fallback guess.
//
// This module touches node:fs, so it must stay OUT of the client bundle:
// src/lib/fii-dii.ts is imported by a client component and therefore keeps
// its file reads out (the provider adapter calls this module instead).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SKILL_ROOT } from './skill-jobs';
import type { FiiDiiSnapshot } from '@/lib/fii-dii';
import type { MostActiveContract } from '@/lib/nse-most-active';

const EOD_DIR = path.join(SKILL_ROOT, 'data', 'eod');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-25" → "25-Nov-2026" (the format NSE/MrChartist use). */
export function isoToChartistDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
  if (!m) return String(iso || '');
  const day = Number(m[3]);
  const month = MONTHS[Number(m[2]) - 1];
  return `${String(day).padStart(2, '0')}-${month}-${m[1]}`;
}

/**
 * The NSE FII/DII figure the skill captured for a session.
 * Returns null when the artifact is missing or unreadable — never a guess.
 */
export async function readNseEodFiiDii(sessionIso: string): Promise<FiiDiiSnapshot | null> {
  const iso = String(sessionIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  try {
    const raw = await readFile(path.join(EOD_DIR, iso, 'fii_dii.json'), 'utf8');
    const data = JSON.parse(raw);
    const fii = data?.FII ?? data?.fii;
    const dii = data?.DII ?? data?.dii;
    if (!fii || !dii) return null;
    const dataDate = String(data?.data_date ?? iso).slice(0, 10);
    return {
      fiiNet: Number(fii.net ?? 0),
      diiNet: Number(dii.net ?? 0),
      fiiBuy: Number(fii.buy ?? 0),
      fiiSell: Number(fii.sell ?? 0),
      diiBuy: Number(dii.buy ?? 0),
      diiSell: Number(dii.sell ?? 0),
      date: isoToChartistDate(dataDate),
      source: 'nse-eod',
    };
  } catch {
    return null;
  }
}

/** One captured ranking (rows + the exchange's own snapshot timestamp). */
export interface EodMostActiveCategory {
  data: MostActiveContract[];
  timestamp: string;
}

export interface EodMostActive {
  byVolume: EodMostActiveCategory;
  byValue: EodMostActiveCategory;
  timestamp: string;
}

function mapMostActiveRow(d: any): MostActiveContract {
  return {
    instrument: d?.instrument || d?.instrumentType || "",
    underlying: d?.underlying || "",
    expiryDate: d?.expiryDate || "",
    optionType: d?.optionType || "",
    strikePrice: Number(d?.strikePrice ?? 0),
    lastPrice: Number(d?.lastPrice ?? 0),
    pChange: Number(d?.pChange ?? 0),
    numberOfContractsTraded: Number(d?.numberOfContractsTraded ?? 0),
    totalTurnover: Number(d?.totalTurnover ?? 0),
    openInterest: Number(d?.openInterest ?? 0),
    underlyingValue: Number(d?.underlyingValue ?? 0),
  };
}

/**
 * The NSE most-active contracts the skill captured for a session (the
 * 19:05 EOD job) — BOTH rankings ("Sort By Volume" and "Sort By Value").
 * Returns null when the artifact is missing.
 */
export async function readNseEodMostActive(sessionIso: string): Promise<EodMostActive | null> {
  const iso = String(sessionIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  try {
    const raw = await readFile(path.join(EOD_DIR, iso, 'most_active.json'), 'utf8');
    const data = JSON.parse(raw);
    // Current shape: { by_volume: {data, timestamp}, by_value: {…} }.
    // Legacy shape (before the split): { by_value: { volume: {…}, value: {…} } }.
    const volume = data?.by_volume ?? data?.by_value?.volume ?? data?.volume ?? null;
    const value = data?.by_value?.value ?? data?.by_value ?? data?.value ?? null;
    const rowsOf = (cat: any): any[] => (Array.isArray(cat?.data) ? cat.data : []);
    const byVolumeRows = rowsOf(volume);
    const byValueRows = rowsOf(value);
    if (!byVolumeRows.length && !byValueRows.length) return null;
    return {
      byVolume: {
        data: byVolumeRows.map(mapMostActiveRow),
        timestamp: String(volume?.timestamp || data?.timestamp || ""),
      },
      byValue: {
        data: byValueRows.map(mapMostActiveRow),
        timestamp: String(value?.timestamp || data?.timestamp || ""),
      },
      timestamp: String(data?.timestamp || volume?.timestamp || value?.timestamp || ""),
    };
  } catch {
    return null;
  }
}
