// Stage 5 — Order Book / Market Depth API
//
// Yahoo Finance (our primary equity source) does not provide Level 2 depth.
// NSE India publishes free public depth via /api/quote-equity, but its
// anti-bot gating returns 403 for most automated access. This endpoint
// attempts the NSE flow with a session cookie and — when blocked — reports
// "data unavailable" honestly rather than fabricating depth numbers (per the
// Stage 5 spec: never guess order-book data).
//
// A broker API (Zerodha Kite Connect, Upstox, Angel One, Dhan) can replace
// the NSE fetch here later; the response shape below is broker-agnostic.

import { NextRequest, NextResponse } from "next/server";

const NSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/market-data/equity-stock-quotes",
};

let nseCookieCache: string | null = null;
let nseCookieTime = 0;
const COOKIE_TTL = 5 * 60 * 1000;

async function establishSession(): Promise<string | null> {
  const now = Date.now();
  if (nseCookieCache && now - nseCookieTime < COOKIE_TTL) return nseCookieCache;
  try {
    const initRes = await fetch("https://www.nseindia.com", {
      headers: NSE_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = initRes.headers.get("set-cookie");
    if (setCookie) {
      nseCookieCache = setCookie.split(",").map(c => c.split(";")[0].trim()).join("; ");
      nseCookieTime = now;
      return nseCookieCache;
    }
  } catch {}
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "").toUpperCase();
    if (!symbol) return NextResponse.json({ success: false, error: "Missing ?symbol=" }, { status: 400 });

    // Attempt NSE depth fetch (best-effort; usually 403 from server IPs).
    let depth: any = null;
    let errorNote = "";
    try {
      const cookie = await establishSession();
      if (!cookie) throw new Error("Could not establish NSE session cookie");
      const res = await fetch(
        `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}&section=all`,
        { headers: { ...NSE_HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(10000) }
      );
      if (res.status === 403 || res.status === 429) {
        errorNote = `NSE blocked this request (HTTP ${res.status}) — rate-limited or IP-fingerprinted.`;
      } else if (!res.ok) {
        errorNote = `NSE returned HTTP ${res.status}.`;
      } else {
        const data = await res.json();
        const ob = data?.marketDeptOrderBook;
        if (ob?.bid) {
          const map = (entries: any[]) => (entries || []).map((e) => ({
            price: Number(e.price),
            qty: Number(e.quantity || 0),
          }));
          const bids = map(ob.bid);
          const asks = map(ob.ask);
          depth = {
            symbol,
            bidLevels: bids.slice(0, 5),
            askLevels: asks.slice(0, 5),
            totalBuyQty: ob.totalBuyQtty ?? bids.reduce((s, e) => s + e.qty, 0),
            totalSellQty: ob.totalSellQtty ?? asks.reduce((s, e) => s + e.qty, 0),
            lastPrice: Number(data.lastPrice || 0),
            timestamp: new Date().toISOString(),
            source: "NSE India public feed (free, delayed)",
          };
        } else {
          errorNote = "NSE returned no market-depth payload.";
        }
      }
    } catch (err: any) {
      errorNote = (err?.message || "network error").substring(0, 120);
    }

    // If depth unavailable, be honest about it (spec: never fabricate depth).
    if (!depth) {
      return NextResponse.json({
        success: false,
        symbol,
        available: false,
        error: "Order-book data unavailable for this source.",
        reason: errorNote || "NSE depth feed did not return data.",
        alternative: "Wire a broker API (Zerodha Kite Connect / Upstox / Angel One / Dhan) for real-time Level 2 depth.",
      }, { status: 503 });
    }

    return NextResponse.json({ success: true, available: true, data: depth });
  } catch (error: any) {
    console.error("[OrderBook API] Error:", error);
    return NextResponse.json(
      { success: false, available: false, error: error?.message || "Order book failed" },
      { status: 500 }
    );
  }
}