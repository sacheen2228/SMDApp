// option-bhavcopy — REAL option-premium daily history from exchange bhavcopies.
//
// Why this exists: Breeze getHistoricalDatav2 returns empty Success for ALL
// F&O products (options + futures) on this account — only cash spot works —
// so the trade backtest had no premium data and replayed premium SL/TP
// against SPOT candles (garbage instant-TP wins for CE, sign-flipped for PE).
// The daily bhavcopy publishes per-strike OHLC for every F&O security
// (216 symbols incl. stock options), plus underlying price and lot size.
//
// Two exchanges, both UDiFF format (same column names → one parser):
//   NSE: nsearchives …/content/fo/BhavCopy_NSE_FO_0_0_0_<ymd>_F_0000.csv.zip
//        — NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY + stock options
//   BSE: www.bseindia.com/download/BhavCopy/Derivative/
//          BhavCopy_BSE_FO_0_0_0_<ymd>_F_0000.CSV  (plain CSV, no zip)
//        — SENSEX/BANKEX options (BSE-only, absent from NSE)
//        BSE serves its SPA HTML with HTTP 200 for missing files → detect
//        by content sniff, not status. File appears ~17:00 IST.
//
// Data reality: daily granularity only. Same-day SL+TP ambiguity must be
// resolved conservatively (SL first) by the caller — never fake intraday paths.

import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

export interface PremiumCandle {
  date: string; // YYYY-MM-DD (TradDt)
  symbol: string; // TckrSymb — NIFTY, RELIANCE, ...
  strike: number; // StrkPric
  optionType: "CE" | "PE"; // OptnTp
  expiry: string; // XpryDt YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  underlying: number | null; // UndrlygPric
  lotSize: number; // NewBrdLotQty
  volume: number; // TtlTradgVol
  oi: number; // OpnIntrst
}

export interface PremiumQuery {
  symbol: string;
  strike?: number;
  optionType?: "CE" | "PE";
  expiry?: string;
}

const ARCHIVE_BASE = "https://nsearchives.nseindia.com/content/fo";
const BSE_ARCHIVE_BASE = "https://www.bseindia.com/download/BhavCopy/Derivative";
const CACHE_DIR = path.join(process.cwd(), "db", "bhavcopy");

// In-memory memo: parsed files by date ("2026-09-29" → candles). One bhavcopy
// is ~38k option rows / ~7 MB CSV — parsing once per process is enough.
const parsedCache = new Map<string, PremiumCandle[]>();
const missCache = new Set<string>(); // past dates known to 404 (holiday/weekend)
const parsedCacheBse = new Map<string, PremiumCandle[]>();
const missCacheBse = new Set<string>();

/** Indices with no NSE F&O series — options trade only on BSE. */
const BSE_ONLY_SYMBOLS = new Set(["SENSEX", "BANKEX"]);

export function bhavcopyZipUrl(dateStr: string): string {
  const ymd = dateStr.replace(/-/g, "");
  return `${ARCHIVE_BASE}/BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`;
}

export function bseBhavcopyUrl(dateStr: string): string {
  const ymd = dateStr.replace(/-/g, "");
  return `${BSE_ARCHIVE_BASE}/BhavCopy_BSE_FO_0_0_0_${ymd}_F_0000.CSV`;
}

export function isWeekend(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function todayIst(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

function csvPath(dateStr: string): string {
  const ymd = dateStr.replace(/-/g, "");
  return path.join(CACHE_DIR, `BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv`);
}

function bseCsvPath(dateStr: string): string {
  const ymd = dateStr.replace(/-/g, "");
  return path.join(CACHE_DIR, `BhavCopy_BSE_FO_0_0_0_${ymd}_F_0000.csv`);
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse the 2026+ SEBI F&O bhavcopy CSV into premium candles (CE/PE only). */
export function parseBhavcopyCsv(csv: string): PremiumCandle[] {
  const lines = csv.split("\n");
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("TradDt");
  const iSym = idx("TckrSymb");
  const iExp = idx("XpryDt");
  const iStrike = idx("StrkPric");
  const iType = idx("OptnTp");
  const iOpen = idx("OpnPric");
  const iHigh = idx("HghPric");
  const iLow = idx("LwPric");
  const iClose = idx("ClsPric");
  const iLast = idx("LastPric");
  const iPrev = idx("PrvsClsgPric");
  const iUnd = idx("UndrlygPric");
  const iLot = idx("NewBrdLotQty");
  const iVol = idx("TtlTradgVol");
  const iOi = idx("OpnIntrst");
  if (iDate < 0 || iSym < 0 || iType < 0 || iClose < 0) return []; // unknown schema

  const out: PremiumCandle[] = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const f = line.split(",");
    const type = (f[iType] || "").trim();
    if (type !== "CE" && type !== "PE") continue; // futures/etc.
    const und = iUnd >= 0 ? num(f[iUnd]) : NaN;
    let close = num(f[iClose]);
    let low = num(f[iLow]);
    let high = num(f[iHigh]);
    if (!Number.isFinite(close) || !Number.isFinite(low) || !Number.isFinite(high)) continue;
    // Some BSE files (2026-07-16) stamp the underlying/index price into
    // ClsPric — a listed option can never close at the spot value. Recover
    // the real close from LastPric, else PrvsClsgPric; never trust the stamp.
    if (Number.isFinite(und) && und > 0 && close === und) {
      const last = iLast >= 0 ? num(f[iLast]) : NaN;
      const prev = iPrev >= 0 ? num(f[iPrev]) : NaN;
      if (Number.isFinite(last) && last > 0) close = last;
      else if (Number.isFinite(prev) && prev > 0) close = prev;
    }
    let open = Number.isFinite(num(f[iOpen])) ? num(f[iOpen]) : close;
    // Illiquid contracts sometimes publish 0/0 OHLC with only a settlement
    // close — a zero low would make every SL "hit". Normalize to close-only.
    if (high <= 0 || low <= 0 || low > high) {
      open = close;
      high = close;
      low = close;
    }
    out.push({
      date: (f[iDate] || "").trim(),
      symbol: (f[iSym] || "").trim().toUpperCase(),
      strike: num(f[iStrike]),
      optionType: type,
      expiry: (f[iExp] || "").trim(),
      open,
      high,
      low,
      close,
      underlying: Number.isFinite(num(f[iUnd])) ? num(f[iUnd]) : null,
      lotSize: Number.isFinite(num(f[iLot])) ? num(f[iLot]) : 0,
      volume: Number.isFinite(num(f[iVol])) ? num(f[iVol]) : 0,
      oi: Number.isFinite(num(f[iOi])) ? num(f[iOi]) : 0,
    });
  }
  return out;
}

/** Filter premium candles by symbol / strike / option type / expiry. */
export function selectPremiumCandles(rows: PremiumCandle[], q: PremiumQuery): PremiumCandle[] {
  const sym = q.symbol.toUpperCase();
  return rows.filter((r) => {
    if (r.symbol !== sym) return false;
    if (q.strike !== undefined && Math.abs(r.strike - q.strike) > 0.005) return false;
    if (q.optionType && r.optionType !== q.optionType) return false;
    if (q.expiry && r.expiry !== q.expiry) return false;
    return true;
  });
}

async function downloadCsv(dateStr: string): Promise<"ok" | "missing" | "error"> {
  const ymd = dateStr.replace(/-/g, "");
  const url = bhavcopyZipUrl(dateStr);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0" },
    });
    if (res.status === 404) return "missing";
    if (!res.ok) return "error";
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    if (!entries.length) return "error";
    const csv = entries[0].getData().toString("utf8");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(csvPath(dateStr), csv);
    parsedCache.set(dateStr, parseBhavcopyCsv(csv));
    return "ok";
  } catch {
    return "error";
  }
}

/** Load one day's premium candles (cache → disk → network). Non-trading days → []. */
export async function loadBhavcopy(dateStr: string): Promise<PremiumCandle[]> {
  const memo = parsedCache.get(dateStr);
  if (memo) return memo;
  if (missCache.has(dateStr)) return [];
  if (isWeekend(dateStr)) return [];

  const file = csvPath(dateStr);
  if (fs.existsSync(file)) {
    const rows = parseBhavcopyCsv(fs.readFileSync(file, "utf8"));
    parsedCache.set(dateStr, rows);
    return rows;
  }

  const result = await downloadCsv(dateStr);
  if (result === "ok") return parsedCache.get(dateStr) ?? [];
  if (result === "missing" && dateStr < todayIst()) {
    // Persist misses only for past dates (today's file appears after ~18:00 IST).
    missCache.add(dateStr);
  }
  return [];
}

async function downloadBseCsv(dateStr: string): Promise<"ok" | "missing" | "error"> {
  try {
    const res = await fetch(bseBhavcopyUrl(dateStr), {
      signal: AbortSignal.timeout(30000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
        "Referer": "https://www.bseindia.com/markets/MarketInfo/BhavCopy",
        "Origin": "https://www.bseindia.com",
      },
    });
    if (res.status === 404) return "missing";
    if (!res.ok) return "error";
    const text = await res.text();
    // BSE answers missing files with its SPA shell — HTTP 200 + HTML.
    if (/^\s*<(!doctype|html)/i.test(text)) return "missing";
    if (!/^\s*TradDt,/i.test(text)) return "error";
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(bseCsvPath(dateStr), text);
    parsedCacheBse.set(dateStr, parseBhavcopyCsv(text));
    return "ok";
  } catch {
    return "error";
  }
}

/** Load one day's BSE F&O premium candles (SENSEX/BANKEX). Non-trading days → []. */
export async function loadBseBhavcopy(dateStr: string): Promise<PremiumCandle[]> {
  const memo = parsedCacheBse.get(dateStr);
  if (memo) return memo;
  if (missCacheBse.has(dateStr)) return [];
  if (isWeekend(dateStr)) return [];

  const file = bseCsvPath(dateStr);
  if (fs.existsSync(file)) {
    const rows = parseBhavcopyCsv(fs.readFileSync(file, "utf8"));
    parsedCacheBse.set(dateStr, rows);
    return rows;
  }

  const result = await downloadBseCsv(dateStr);
  if (result === "ok") return parsedCacheBse.get(dateStr) ?? [];
  if (result === "missing" && dateStr < todayIst()) missCacheBse.add(dateStr);
  return [];
}

/**
 * Merge NSE rows with BSE rows when the symbol is BSE-only (SENSEX/BANKEX).
 * Pure — unit-testable without network.
 */
export function mergeForSymbol(
  nseRows: PremiumCandle[],
  bseRows: PremiumCandle[],
  symbol: string
): PremiumCandle[] {
  const sym = symbol.toUpperCase();
  if (nseRows.some((r) => r.symbol === sym)) return nseRows;
  if (!bseRows.length) return nseRows;
  return [...nseRows, ...bseRows];
}

/** NSE rows, falling back to BSE for BSE-only symbols (SENSEX/BANKEX). */
export async function loadBhavcopyForTrade(
  dateStr: string,
  symbol: string
): Promise<PremiumCandle[]> {
  const sym = symbol.toUpperCase();
  if (BSE_ONLY_SYMBOLS.has(sym)) return loadBseBhavcopy(dateStr);
  const nse = await loadBhavcopy(dateStr);
  if (nse.some((r) => r.symbol === sym)) return nse;
  const bse = await loadBseBhavcopy(dateStr);
  return mergeForSymbol(nse, bse, sym);
}

export async function getPremiumOHLC(q: PremiumQuery & { date: string }): Promise<PremiumCandle | null> {
  const rows = await loadBhavcopyForTrade(q.date, q.symbol);
  const hits = selectPremiumCandles(rows, q);
  return hits.length ? hits[0] : null;
}

/**
 * Premium candles for a trade's replay window. missingDays = non-trading dates
 * (holidays/404s) so the caller can report partial coverage honestly.
 */
export async function getPremiumDailyCandles(
  q: PremiumQuery & { fromDate: string; toDate: string }
): Promise<{ candles: PremiumCandle[]; missingDays: string[] }> {
  const candles: PremiumCandle[] = [];
  const missingDays: string[] = [];
  const start = new Date(`${q.fromDate}T00:00:00Z`).getTime();
  const end = new Date(`${q.toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { candles, missingDays };
  }
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isWeekend(d)) continue;
    const rows = await loadBhavcopyForTrade(d, q.symbol);
    const hits = selectPremiumCandles(rows, q);
    if (hits.length) {
      // One row per day for a given strike/expiry (first match wins).
      candles.push(hits[0]);
    } else {
      missingDays.push(d); // holiday/404 or strike not listed that day
    }
  }
  // When expiry is not pinned we may have multiple expiries per day — keep order.
  candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { candles, missingDays };
}

/** Unique expiries published for a symbol on a date. */
export async function listExpiries(dateStr: string, symbol?: string): Promise<string[]> {
  const rows = symbol ? await loadBhavcopyForTrade(dateStr, symbol) : await loadBhavcopy(dateStr);
  const set = new Set<string>();
  for (const r of rows) {
    if (symbol && r.symbol !== symbol.toUpperCase()) continue;
    if (r.expiry) set.add(r.expiry);
  }
  return [...set].sort();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Normalize an expiry string to `YYYY-MM-DD` (bhavcopy's format).
 * Handles the NSE option-chain style `29-Sep-2026` (what selectedExpiry
 * records), ISO passthrough, and `YYYYMMDD`. Unparseable → null.
 */
export function normalizeExpiry(exp: string | null | undefined): string | null {
  if (!exp || typeof exp !== "string") return null;
  const s = exp.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
  }
  // NSE row-level expiryDate uses DD-MM-YYYY (e.g. "27-10-2026") while
  // expiryDates[] uses "27-Oct-2026" — parse the numeric form too.
  const n = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (n) {
    const day = Number(n[1]);
    const mo = Number(n[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return `${n[3]}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Resolve which expiry a historical trade used. The audit sidecar never stored
 * expiry (recordAuditSignal sends `expiry: ''`), so we match the recorded
 * ENTRY PREMIUM against each candidate expiry's real entry-day OHLC range:
 *   1. prefer candidates whose [low, high] contains the entry (±1%)
 *   2. else closest close — but only within 30% of entry (otherwise the match
 *      is not trustworthy and we return null → honest NO_DATA).
 */
export function pickPremiumExpiry(
  rows: PremiumCandle[],
  entryPrice: number
): { expiry: string; match: "range" | "closest" } | null {
  if (!rows.length || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  const byExpiry = new Map<string, PremiumCandle[]>();
  for (const r of rows) {
    if (!r.expiry) continue;
    if (!byExpiry.has(r.expiry)) byExpiry.set(r.expiry, []);
    byExpiry.get(r.expiry)!.push(r);
  }
  if (byExpiry.size === 0) return null;

  const scored = [...byExpiry.entries()].map(([expiry, rs]) => {
    const low = Math.min(...rs.map((r) => r.low));
    const high = Math.max(...rs.map((r) => r.high));
    const close = rs.reduce((s, r) => s + r.close, 0) / rs.length;
    const contains = entryPrice >= low * 0.99 && entryPrice <= high * 1.01;
    return { expiry, close, contains, diff: Math.abs(close - entryPrice) };
  });

  const inRange = scored.filter((s) => s.contains);
  if (inRange.length) {
    inRange.sort((a, b) => a.diff - b.diff);
    return { expiry: inRange[0].expiry, match: "range" };
  }
  scored.sort((a, b) => a.diff - b.diff);
  if (scored[0].diff <= entryPrice * 0.3) {
    return { expiry: scored[0].expiry, match: "closest" };
  }
  return null;
}
