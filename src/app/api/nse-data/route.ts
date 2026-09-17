// ═══════════════════════════════════════════════════════════════════════════
// NSE Data Receiver — stores option chain snapshots from local scraper
// GET:  latest snapshots for all symbols
// POST: receive new snapshot from scraper (local machine)
// Data stored in-memory + JSON file for persistence across restarts
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data', 'nse-snapshots');
const MAX_SNAPSHOTS = 50; // keep last 50 per symbol (≈50 hours of hourly data)

interface NSESnapshot {
  symbol: string;
  timestamp: string;
  spotPrice: number;
  indiaVIX: number | null;
  maxPain: number;
  pcr: number;
  totalCallOI: number;
  totalPutOI: number;
  callOiChange: number;
  putOiChange: number;
  atmStrike: number;
  expiries: string[];
  selectedExpiry: string;
  strikes: Array<{
    strike: number;
    ce: {
      ltp: number; oi: number; oiChg: number; volume: number;
      iv: number; delta: number; gamma: number; theta: number; vega: number;
    } | null;
    pe: {
      ltp: number; oi: number; oiChg: number; volume: number;
      iv: number; delta: number; gamma: number; theta: number; vega: number;
    } | null;
  }>;
}

// In-memory cache
const snapshotCache: Map<string, NSESnapshot[]> = new Map();

async function ensureDir() {
  try { await mkdir(DATA_DIR, { recursive: true }); } catch {}
}

async function loadSnapshots(symbol: string): Promise<NSESnapshot[]> {
  if (snapshotCache.has(symbol)) return snapshotCache.get(symbol)!;
  try {
    const raw = await readFile(join(DATA_DIR, `${symbol}.json`), 'utf-8');
    const data = JSON.parse(raw);
    snapshotCache.set(symbol, data);
    return data;
  } catch {
    return [];
  }
}

async function saveSnapshots(symbol: string, snapshots: NSESnapshot[]) {
  snapshotCache.set(symbol, snapshots);
  await ensureDir();
  await writeFile(join(DATA_DIR, `${symbol}.json`), JSON.stringify(snapshots, null, 0));
}

// ── POST: Receive snapshot from local scraper ──
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, spotPrice, indiaVIX, maxPain, pcr, totalCallOI, totalPutOI,
      callOiChange, putOiChange, atmStrike, expiries, selectedExpiry, strikes } = body;

    if (!symbol || !strikes || !Array.isArray(strikes)) {
      return NextResponse.json({ success: false, error: 'Missing required fields: symbol, strikes[]' }, { status: 400 });
    }

    const snapshot: NSESnapshot = {
      symbol: symbol.toUpperCase(),
      timestamp: new Date().toISOString(),
      spotPrice: spotPrice || 0,
      indiaVIX: indiaVIX || null,
      maxPain: maxPain || 0,
      pcr: pcr || 0,
      totalCallOI: totalCallOI || 0,
      totalPutOI: totalPutOI || 0,
      callOiChange: callOiChange || 0,
      putOiChange: putOiChange || 0,
      atmStrike: atmStrike || 0,
      expiries: expiries || [],
      selectedExpiry: selectedExpiry || '',
      strikes,
    };

    const existing = await loadSnapshots(snapshot.symbol);
    existing.unshift(snapshot);
    if (existing.length > MAX_SNAPSHOTS) existing.pop();
    await saveSnapshots(snapshot.symbol, existing);

    console.log(`[NSE-Data] Received ${snapshot.symbol}: ${strikes.length} strikes, spot=${spotPrice}, VIX=${indiaVIX}`);
    return NextResponse.json({
      success: true,
      symbol: snapshot.symbol,
      strikes: strikes.length,
      snapshotsStored: existing.length,
      timestamp: snapshot.timestamp,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// ── GET: Latest snapshots ──
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')?.toUpperCase();
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '1');

  if (symbol) {
    const snapshots = await loadSnapshots(symbol);
    const latest = snapshots.slice(0, limit);
    const prev = snapshots.length > 1 ? snapshots[1] : null;

    // Compute OI change from previous snapshot if available
    let oiDelta: Record<string, number> | null = null;
    if (prev && latest[0]) {
      const curr = latest[0];
      oiDelta = {
        totalCallOI: curr.totalCallOI - prev.totalCallOI,
        totalPutOI: curr.totalPutOI - prev.totalPutOI,
        callOiChange: curr.callOiChange - prev.callOiChange,
        putOiChange: curr.putOiChange - prev.putOiChange,
      };
    }

    return NextResponse.json({
      success: true,
      symbol,
      latest: latest[0] || null,
      previous: prev || null,
      oiDelta,
      totalSnapshots: snapshots.length,
      ageMs: latest[0] ? Date.now() - new Date(latest[0].timestamp).getTime() : null,
    });
  }

  // All symbols summary
  const symbols = Array.from(snapshotCache.keys());
  const summary: Record<string, { latest: NSESnapshot | null; count: number; ageMs: number | null }> = {};
  for (const sym of symbols) {
    const snaps = snapshotCache.get(sym) || [];
    const latest = snaps[0] || null;
    summary[sym] = {
      latest,
      count: snaps.length,
      ageMs: latest ? Date.now() - new Date(latest.timestamp).getTime() : null,
    };
  }

  return NextResponse.json({ success: true, symbols, summary, totalSymbols: symbols.length });
}
