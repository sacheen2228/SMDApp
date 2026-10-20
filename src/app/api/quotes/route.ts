// API Route — arbitrary-symbol quotes (Watchlist tab LTP column)
// GET /api/quotes?symbols=NIFTY,RELIANCE,...
// Free NSE/BSE sources only (NSE index lists + Moneycontrol + NSE index
// quotes for indices). 30s in-memory cache keyed by the normalized symbol
// set. The response carries the source + age of the quotes — a cached or
// undated row is never presented as a live print.

import { NextRequest, NextResponse } from "next/server";
import { fetchStockQuotes, getStockQuoteProvenance } from "@/lib/nse-stock-data";
import { buildCardMeta, getMarketClock, unavailableMeta } from "@/lib/data-freshness";

const TTL = 30_000;
const cache = new Map<string, { ts: number; data: Record<string, any> }>();

export async function GET(req: NextRequest) {
  try {
    const raw = (new URL(req.url).searchParams.get("symbols") || "").split(",");
    const key = raw
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join(",");
    if (!key) {
      return NextResponse.json({ success: false, error: "symbols param required" }, { status: 400 });
    }

    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL) {
      const clock = await getMarketClock();
      const prov = getStockQuoteProvenance();
      const meta = buildCardMeta({
        source: prov.source === "moneycontrol" ? "moneycontrol" : "nse",
        providerTimestamp: prov.providerTimestamp ?? clock.tradeDate ?? null,
        ttlMs: 90_000,
        live: clock.isOpen,
        reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
      });
      const cachedCount = Object.keys(hit.data).length;
      return NextResponse.json({
        success: cachedCount > 0,
        status: cachedCount > 0 ? meta.status : "UNAVAILABLE",
        meta: cachedCount > 0 ? meta : unavailableMeta("No quote for the requested symbols", "none"),
        data: { quotes: hit.data, count: cachedCount, cached: true },
      });
    }

    const quotes = await fetchStockQuotes(raw);
    cache.set(key, { ts: Date.now(), data: quotes });
    if (cache.size > 50) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }

    const clock = await getMarketClock();
    const prov = getStockQuoteProvenance();
    const count = Object.keys(quotes).length;
    // No quote at all → an explicit unavailable state (never a silent 0).
    const meta =
      count > 0
        ? buildCardMeta({
            source: prov.source === "moneycontrol" ? "moneycontrol" : "nse",
            providerTimestamp: prov.providerTimestamp ?? clock.tradeDate ?? null,
            ttlMs: 90_000,
            live: clock.isOpen,
            reason: clock.isOpen ? undefined : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
          })
        : unavailableMeta(
            "No quote for the requested symbols (they are not in the free exchange lists)",
            "none",
          );

    return NextResponse.json({
      success: count > 0,
      status: meta.status,
      meta,
      data: { quotes, count },
      // Symbols the free feeds could not resolve — the card shows them as
      // unavailable instead of a blank/zero price.
      missing: raw.map((s) => s.trim().toUpperCase()).filter((s) => s && !quotes[s]),
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: error?.message || "quote fetch failed" },
      { status: 500 },
    );
  }
}
