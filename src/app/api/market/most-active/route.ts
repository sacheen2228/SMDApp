// /api/market/most-active — NSE Most Active Contracts
// GET: returns cached snapshot (auto-refreshes every 5 min during market hours)
// POST: force refresh
//
// Honesty note (2026-10-20 audit): the fetcher returns a snapshot object even
// when EVERY upstream request failed — all categories empty. The route used to
// answer `success: true` with empty arrays, which the card rendered as
// "Most Active F&O Contracts" with nothing in it (no error, no reason).
// An empty snapshot is now an explicit UNAVAILABLE state.

import { NextRequest, NextResponse } from "next/server";
import {
  getMostActiveCache,
  getMostActiveCacheAge,
  refreshMostActive,
  startMostActiveScheduler,
} from "@/lib/nse-most-active";
import { buildCardMeta, getMarketClock } from "@/lib/data-freshness";

// Start scheduler on first import
let schedulerStarted = false;
function ensureScheduler() {
  if (!schedulerStarted) {
    schedulerStarted = true;
    startMostActiveScheduler();
  }
}

/** True when every category of the snapshot came back empty. */
function isEmptySnapshot(snapshot: any): boolean {
  if (!snapshot) return true;
  const cats = [
    snapshot.contracts, snapshot.futures, snapshot.options,
    snapshot.callsIndex, snapshot.putsIndex, snapshot.callsStocks,
    snapshot.putsStocks, snapshot.calls, snapshot.puts, snapshot.oi,
  ];
  return cats.every((c) => !c || !Array.isArray(c.data) || c.data.length === 0);
}

/**
 * The skill's 19:05 EOD capture of the same NSE snapshot — the DAILY copy.
 * Used when the live endpoint is blocked/empty so the DD tab still has the
 * session's most-active strikes (both rankings).
 */
async function eodArtifactSnapshot(sessionIso: string): Promise<any | null> {
  try {
    const { readNseEodMostActive } = await import("@/lib/orchestrator/eod-artifacts");
    const eod = await readNseEodMostActive(sessionIso);
    if (!eod) return null;
    const cat = (rows: any[], timestamp: string) => ({
      data: rows, byVolume: rows, byValue: rows, timestamp,
    });
    const empty = { data: [], byVolume: [], byValue: [], timestamp: "" };
    return {
      contracts: cat(eod.byVolume.data, eod.byVolume.timestamp),
      futures: empty,
      options: empty,
      callsIndex: empty,
      putsIndex: empty,
      callsStocks: empty,
      putsStocks: empty,
      calls: empty,
      puts: empty,
      oi: empty,
      fetchedAt: Date.now(),
      marketStatus: "closed",
      source: "nse-eod",
      sessionDate: sessionIso,
      byValueContracts: cat(eod.byValue.data, eod.byValue.timestamp),
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    ensureScheduler();

    const snapshot = getMostActiveCache();
    const cacheAge = getMostActiveCacheAge();

    if (!snapshot || isEmptySnapshot(snapshot)) {
      // First load — fetch fresh
      const fresh = await refreshMostActive();
      if (fresh && !isEmptySnapshot(fresh)) {
        return buildResponse(fresh, 0);
      }
      // The live endpoint is blocked/empty → the DAILY EOD capture of the
      // same NSE snapshot (the skill's 19:05 job) serves the session.
      const { expectedPublishedSession } = await import("@/lib/fii-dii");
      const session = expectedPublishedSession(new Date(), 16 * 60);
      const eod = await eodArtifactSnapshot(session);
      if (eod) return buildResponse(eod, 0, session);
      return NextResponse.json(
        {
          success: false,
          status: "UNAVAILABLE",
          error: "Failed to fetch NSE most active contracts",
          data: { status: "UNAVAILABLE", source: "nse", reason: "NSE most-active snapshot unavailable" },
        },
        { status: 503 }
      );
    }

    return buildResponse(snapshot, cacheAge);
  } catch (err: any) {
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: err.message || "Most active contracts fetch failed" },
      { status: 500 }
    );
  }
}

async function buildResponse(snapshot: any, cacheAge: number, sessionDate?: string) {
  const clock = await getMarketClock();
  if (isEmptySnapshot(snapshot)) {
    return NextResponse.json(
      {
        success: false,
        status: "UNAVAILABLE",
        error: "NSE returned no most-active contracts (feed empty or blocked)",
        data: {
          status: "UNAVAILABLE",
          source: "nse",
          sourceLabel: "NSE India",
          reason: "NSE returned no most-active contracts (feed empty or blocked)",
        },
        data_available: false,
        cacheAge,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }

  const meta = buildCardMeta({
    source: snapshot.source === "nse-eod" ? "nse-eod" : "nse",
    providerTimestamp: clock.tradeDate,
    ttlMs: 10 * 60_000,
    live: clock.isOpen && snapshot.source !== "nse-eod",
    reason: clock.isOpen
      ? undefined
      : `Exchange closed — last session ${clock.tradeDateLabel || "unknown"}`,
  });

  return NextResponse.json({
    success: true,
    status: meta.status,
    meta,
    data_available: true,
    data: snapshot,
    cacheAge,
    source: snapshot.source === "nse-eod" ? "nse-eod" : "nse-india",
    sessionDate: sessionDate || snapshot.sessionDate || null,
    marketClock: {
      state: clock.marketState,
      isOpen: clock.isOpen,
      tradeDateLabel: clock.tradeDateLabel,
    },
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  try {
    ensureScheduler();
    const fresh = await refreshMostActive();
    if (!fresh) {
      return NextResponse.json(
        { success: false, status: "UNAVAILABLE", error: "Failed to refresh NSE most active contracts" },
        { status: 503 }
      );
    }
    return buildResponse(fresh, 0);
  } catch (err: any) {
    return NextResponse.json(
      { success: false, status: "UNAVAILABLE", error: err.message || "Most active contracts refresh failed" },
      { status: 500 }
    );
  }
}
