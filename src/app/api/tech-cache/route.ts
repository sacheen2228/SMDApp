// /api/tech-cache — refresh the technical snapshot cache (called on bar close / by cron)
//   GET  → cache status + health
//   POST → recompute the snapshots (uses the candle API; never called by the alert path)
import { NextRequest, NextResponse } from "next/server";
import { getJSON } from "@/lib/agent-brain-gate";
import { fetchCandles, type Candle } from "@/lib/tech-read";
import {
  CACHE_SYMBOLS, TF_TTL_MS, buildSnapshot, cacheStats, getSnapshot, isFresh, prune, type TechTf,
} from "@/lib/tech-cache";

export const dynamic = "force-dynamic";

const BASE = process.env.NEXT_PUBLIC_BASE_URL || "http://127.0.0.1:3000";

async function loadCandles(symbol: string, tf: TechTf): Promise<Candle[]> {
  const r = await fetchCandles(BASE, symbol, tf);
  return r.ok ? r.candles : [];
}

/** Recompute the snapshots for the given symbols/tfs. */
export async function refresh(symbols: string[], tfs: TechTf[]): Promise<{ refreshed: number; failed: number; detail: string[] }> {
  let refreshed = 0, failed = 0;
  const detail: string[] = [];
  for (const sym of symbols) {
    for (const tf of tfs) {
      const candles = await loadCandles(sym, tf);
      if (!candles.length) { failed++; detail.push(`${sym}:${tf} no candles`); continue; }
      const snap = buildSnapshot(sym, tf, candles);
      if (!snap) { failed++; detail.push(`${sym}:${tf} warmup insufficient (${candles.length} bars)`); continue; }
      refreshed++;
    }
  }
  return { refreshed, failed, detail };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    stats: cacheStats(),
    ttlMs: TF_TTL_MS,
    snapshots: [...cacheStats().byTf ? [] : []],
    symbols: CACHE_SYMBOLS,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const symbols: string[] = Array.isArray(body?.symbols) && body.symbols.length ? body.symbols : CACHE_SYMBOLS;
  const tfs: TechTf[] = Array.isArray(body?.tfs) && body.tfs.length ? body.tfs : ["15m", "5m"];
  const out = await refresh(symbols, tfs);
  prune();
  return NextResponse.json({ ok: true, ...out, stats: cacheStats() });
}
