/**
 * Order Book API — live futures depth for NIFTY (Breeze stream) and SENSEX
 * (MO API sidecar).
 *
 *    GET /api/book?index=NIFTY   → NIFTY futures depth (Breeze)
 *    GET /api/book?index=SENSEX  → SENSEX futures depth (MO API sidecar)
 *
 * Response: { ltp, expiry, low, high, bids: [[price, qty], ...], asks: [...], levels, ts }
 *
 * Fails closed: 400 (bad index) / 503 (no fresh data) — never fabricated depth.
 */

import { NextRequest, NextResponse } from "next/server";
import { ensureNiftyFeed, getNiftySnapshot } from "@/lib/order-book/nifty-feed";
import { fetchSensexBook } from "@/lib/order-book/sensex-feed";
import type { BookSnapshot } from "@/lib/order-book/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const index = (req.nextUrl.searchParams.get("index") || "NIFTY").toUpperCase();
  if (index !== "NIFTY" && index !== "SENSEX") {
    return NextResponse.json({ error: "index must be NIFTY or SENSEX" }, { status: 400 });
  }

  try {
    let snap: BookSnapshot | null = null;

    if (index === "NIFTY") {
      // Fire-and-forget warmup (memoized) + bounded wait for the first snapshot.
      void ensureNiftyFeed().catch(() => {});
      const deadline = Date.now() + 8_000;
      let waited: BookSnapshot | null = null;
      while (Date.now() < deadline) {
        waited = getNiftySnapshot();
        if (waited) {
          snap = waited;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      snap = waited;
      if (!snap) {
        // Feed connected but no fresh data yet (e.g. market closed / no ticks).
        return NextResponse.json(
          { error: "no fresh data" },
          { status: 503 }
        );
      }
    } else {
      snap = await fetchSensexBook();
      if (!snap) {
        return NextResponse.json(
          { error: "no fresh data" },
          { status: 503 }
        );
      }
    }

    return NextResponse.json({
      index,
      ltp: snap.ltp,
      expiry: snap.expiry,
      low: snap.low,
      high: snap.high,
      bids: snap.bids,
      asks: snap.asks,
      levels: snap.levels,
      ts: snap.ts,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    // Session / feed not ready yet — treat as "no fresh data" until the feed warms up.
    if (/NO_FUTURE_EXPIRY|NO_BOOK_TOKEN|SESSION|not authenticated|not ready/i.test(msg)) {
      return NextResponse.json({ error: "no fresh data" }, { status: 503 });
    }
    console.error("[API /api/book] error:", msg);
    return NextResponse.json(
      { error: "feed offline" },
      { status: 503 }
    );
  }
}
