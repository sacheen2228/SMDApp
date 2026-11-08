// futures-oi — REAL EOD futures OI history from the NSE F&O bhavcopy archive.
//
// The recorder captures option-chain ticks intraday but never futures OI, so
// the Simple tab's "Fut OI vs Time" chart is fed from the daily bhavcopy
// (db/bhavcopy/*.csv, UDiFF format — same files option-bhavcopy.ts caches).
// Daily granularity only; nothing is interpolated or invented.
//
// UNITS: OpnIntrst/ChngInOpnIntrst are in UNDERLYING UNITS (contracts × lot;
// ÷lot reproduces the exchange's participant-wise totals) — rows are returned
// in CONTRACTS (the canonical chain unit), see src/lib/oi-units.ts.

import { toContracts } from "@/lib/oi-units";

export interface FuturesOiRow {
  date: string; // YYYY-MM-DD (TradDt)
  symbol: string; // TckrSymb
  expiry: string; // XpryDt YYYY-MM-DD
  oi: number; // OpnIntrst — CONTRACTS (converted)
  oiChg: number; // ChngInOpnIntrst — CONTRACTS (converted)
  close: number; // ClsPric
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a UDiFF F&O bhavcopy CSV into futures-OI rows for one symbol.
 * Options (IDO/STO) and other symbols are skipped. Unknown schema → [].
 */
export function parseFuturesOiCsv(csv: string, symbol: string): FuturesOiRow[] {
  const lines = csv.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("TradDt");
  const iType = idx("FinInstrmTp");
  const iSym = idx("TckrSymb");
  const iExp = idx("XpryDt");
  const iClose = idx("ClsPric");
  const iOi = idx("OpnIntrst");
  const iChg = idx("ChngInOpnIntrst");
  if (iDate < 0 || iType < 0 || iSym < 0 || iExp < 0 || iOi < 0) return [];

  const want = symbol.toUpperCase();
  const out: FuturesOiRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const f = line.split(",");
    const type = (f[iType] || "").trim();
    // IDF = index futures, STF = stock futures. Options (IDO/STO) excluded.
    if (type !== "IDF" && type !== "STF") continue;
    if ((f[iSym] || "").trim().toUpperCase() !== want) continue;
    out.push({
      date: (f[iDate] || "").trim(),
      symbol: want,
      expiry: (f[iExp] || "").trim(),
      oi: toContracts(num(f[iOi]), want),
      oiChg: iChg >= 0 ? toContracts(num(f[iChg]), want) : 0,
      close: iClose >= 0 ? num(f[iClose]) : 0,
    });
  }
  return out;
}

/**
 * Keep only the nearest listed expiry per date (the front month) and return
 * the series sorted ascending by date — the shape a time-series chart wants.
 */
export function pickFrontMonth(rows: FuturesOiRow[]): FuturesOiRow[] {
  if (rows.length === 0) return [];
  const byDate = new Map<string, FuturesOiRow>();
  for (const r of rows) {
    const cur = byDate.get(r.date);
    // Lexicographic expiry compare is safe: YYYY-MM-DD.
    if (!cur || r.expiry < cur.expiry) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
