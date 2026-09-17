// /api/market/most-active — NSE Most Active Contracts
// GET: returns cached snapshot (auto-refreshes every 5 min during market hours)
// POST: force refresh

import { NextRequest, NextResponse } from "next/server";
import {
  getMostActiveCache,
  getMostActiveCacheAge,
  refreshMostActive,
  startMostActiveScheduler,
} from "@/lib/nse-most-active";

// Start scheduler on first import
let schedulerStarted = false;
function ensureScheduler() {
  if (!schedulerStarted) {
    schedulerStarted = true;
    startMostActiveScheduler();
  }
}

export async function GET(req: NextRequest) {
  try {
    ensureScheduler();

    const snapshot = getMostActiveCache();
    const cacheAge = getMostActiveCacheAge();

    if (!snapshot) {
      // First load — fetch fresh
      const fresh = await refreshMostActive();
      if (!fresh) {
        return NextResponse.json(
          { success: false, error: "Failed to fetch NSE most active contracts" },
          { status: 503 }
        );
      }
      return NextResponse.json({
        success: true,
        data: fresh,
        cacheAge: 0,
        source: "nse-india",
      });
    }

    return NextResponse.json({
      success: true,
      data: snapshot,
      cacheAge,
      source: "nse-india",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || "Most active contracts fetch failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureScheduler();
    const fresh = await refreshMostActive();
    if (!fresh) {
      return NextResponse.json(
        { success: false, error: "Failed to refresh NSE most active contracts" },
        { status: 503 }
      );
    }
    return NextResponse.json({
      success: true,
      data: fresh,
      cacheAge: 0,
      source: "nse-india",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || "Most active contracts refresh failed" },
      { status: 500 }
    );
  }
}
