// /api/tech-cache — refresh the technical snapshot cache (called on bar close / by cron)
//   GET  → cache status + health
//   POST → recompute the snapshots (uses the candle API; never called by the alert path)
import { NextRequest, NextResponse } from "next/server";
import { getJSON, type Layer } from "@/lib/agent-brain-gate";
import { fetchCandles, triggerLayer, type Candle } from "@/lib/tech-read";
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

/** GET ?symbol=NIFTY → the REAL technical reads the SimpleMode card scores:
 *  15m trend (SuperTrend/EMA/structure), 5m trigger evidence (closed-bar),
 *  real vsVwap and real RVOL — straight from the cached TfRead snapshots.
 *  A missing/stale snapshot is refreshed server-side first (TTL = one bar
 *  interval), so the card's state changes land on candle closes. No
 *  snapshot → read: null with the real reason. Never a fabricated value.
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) {
    return NextResponse.json({
      ok: true,
      stats: cacheStats(),
      ttlMs: TF_TTL_MS,
      symbols: CACHE_SYMBOLS,
    });
  }

  const tfs: TechTf[] = ["15m", "5m"];
  const stale = tfs.filter((tf) => !isFresh(getSnapshot(symbol, tf), tf));
  if (stale.length) {
    await refresh([symbol], stale);
    prune();
  }

  const snapshots: Record<string, any> = {};
  for (const tf of tfs) {
    const snap = getSnapshot(symbol, tf);
    if (!snap || snap.error) {
      snapshots[tf] = { fresh: false, read: null, reason: snap?.error || "no snapshot (no candles)" };
      continue;
    }
    const r = snap.read;
    snapshots[tf] = {
      fresh: isFresh(snap, tf),
      asOf: snap.asOf,
      computedAt: snap.computedAt,
      bars: r.bars,
      close: r.close,
      warnings: r.warnings,
      trend: {
        stDir: r.st.dir,
        emaRel: r.ema.rel,
        emaChop: r.ema.chop,
        structureTrend: r.structure.trend,
        structureEvent: r.structure.event ?? null,
        structureEventBarsAgo: r.structure.eventBarsAgo ?? null,
        adx: r.adx ?? null,
        pdi: r.pdi ?? null,
        mdi: r.mdi ?? null,
      },
      // Real volatility — informational on the card, never a pass/fail check.
      atr: r.atr ?? null,
      atrPct: r.atr && r.close > 0 ? r.atr / r.close : null,
      vsVwap: r.vsVwap,
      // Real closed-bar trigger evidence per direction (state + evidence string).
      triggers: {
        call: triggerLayer(r, "call"),
        put: triggerLayer(r, "put"),
      } as Record<"call" | "put", Layer>,
    };
  }

  const snap5 = getSnapshot(symbol, "5m");
  return NextResponse.json({
    ok: true,
    symbol,
    snapshots,
    // REAL relative volume from the 5m candles; null when they carry no volume.
    rvol: snap5?.rvol ?? null,
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
