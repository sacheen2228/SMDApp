// GET /api/futures-oi?symbol=NIFTY
// EOD futures-OI history (front month) from the local NSE F&O bhavcopy archive.
// Powers the Simple tab's "Fut OI vs Time" chart — daily granularity, real
// data only. Missing files (weekends/holidays) are skipped, never faked.

import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { parseFuturesOiCsv, pickFrontMonth } from "@/lib/futures-oi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_DIR = path.join(process.cwd(), "db", "bhavcopy");

// Parse-once memo keyed by file+symbol (a bhavcopy is ~7 MB / 40k rows, and
// rows are symbol-scoped at parse time so one file serves many keys).
const scopedCache = new Map<string, ReturnType<typeof parseFuturesOiCsv>>();

function loadScoped(symbol: string): ReturnType<typeof parseFuturesOiCsv> {
  const want = symbol.toUpperCase();
  let files: string[];
  try {
    files = fs.readdirSync(CACHE_DIR).filter((f) => f.includes("BhavCopy_NSE_FO") && f.endsWith(".csv"));
  } catch {
    return [];
  }
  const out: ReturnType<typeof parseFuturesOiCsv> = [];
  for (const f of files.sort()) {
    const key = `${f}|${want}`;
    let rows = scopedCache.get(key);
    if (!rows) {
      try {
        rows = parseFuturesOiCsv(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"), want);
      } catch {
        rows = [];
      }
      scopedCache.set(key, rows);
    }
    out.push(...rows);
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();
    if (!/^[A-Z0-9&]{1,15}$/.test(symbol)) {
      return NextResponse.json({ success: false, error: "invalid_symbol" }, { status: 400 });
    }
    const series = pickFrontMonth(loadScoped(symbol));
    return NextResponse.json({
      success: true,
      symbol,
      source: "nse-bhavcopy-eod",
      count: series.length,
      series,
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
