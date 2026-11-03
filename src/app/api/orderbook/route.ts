// Stage 5 — Order Book / Market Depth API
//
// NSE India publishes free public depth via /api/quote-equity, but its
// anti-bot gating returns 403 for most automated access. ICICI Breeze is
// tried as a broker fallback — it carries bid/ask on its quote feed. If
// neither source answers, the endpoint reports "unavailable" honestly rather
// than fabricating depth numbers (per the Stage 5 spec: never guess order-book
// data).
//
// Additional broker APIs (Zerodha Kite Connect, Upstox, Angel One, Dhan) can
// be wired here; the response shape below is broker-agnostic.

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
      nseCookieCache = setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
      nseCookieTime = now;
      return nseCookieCache;
    }
  } catch {}
  return null;
}

// ── Breeze broker fallback ────────────────────────────────────────────────
// Breeze's getQuotes returns LTP + bid/ask on its quote feed. Faster than NSE
// (no cookie dance, no 403 wall) and works when a Breeze session is active.
async function fetchBreezeDepth(symbol: string): Promise<{ bidLevels: any[]; askLevels: any[]; totalBuyQty: number; totalSellQty: number; lastPrice: number; timestamp: string; source: string } | null> {
  try {
    const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
    const q = await getQuotes(symbol, "NSE");
    const quotes = Array.isArray(q) ? q : q ? [q] : [];
    const quote = quotes.find((item: any) => {
      const sc = String(item?.stock_code || item?.symbol || "").toUpperCase();
      return sc === symbol || sc === symbol.replace(/^NSE:/, "");
    });
    if (!quote) return null;

    const ltp = Number(quote.ltp || quote.last_traded_price || 0);
    const bid = Number(quote.best_bid_price || quote.bid || 0);
    const ask = Number(quote.best_offer_price || quote.ask || 0);
    const bidQty = Number(quote.best_bid_qty || quote.bidQty || 0);
    const askQty = Number(quote.best_offer_qty || quote.askQty || 0);

    if (!(bid > 0) && !(ask > 0)) return null;

    const bidLevels = bid > 0 ? [{ price: bid, qty: bidQty }] : [];
    const askLevels = ask > 0 ? [{ price: ask, qty: askQty }] : [];

    return {
      bidLevels,
      askLevels,
      totalBuyQty: bidQty,
      totalSellQty: askQty,
      lastPrice: ltp > 0 ? ltp : bid || ask || 0,
      timestamp: new Date().toISOString(),
      source: "ICICI Breeze (broker feed)",
    };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || "").toUpperCase();
    if (!symbol) return NextResponse.json({ success: false, error: "Missing ?symbol=" }, { status: 400 });

    let depth: any = null;
    let errorNote = "";

    // 1. Try Breeze broker first — faster, no NSE 403 wall
    try {
      const breeze = await Promise.race([
        fetchBreezeDepth(symbol),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("BREEZE_TIMEOUT")), 6000)),
      ]);
      if (breeze) {
        depth = {
          symbol,
          bidLevels: breeze.bidLevels,
          askLevels: breeze.askLevels,
          totalBuyQty: breeze.totalBuyQty,
          totalSellQty: breeze.totalSellQty,
          lastPrice: breeze.lastPrice,
          timestamp: breeze.timestamp,
          source: breeze.source,
        };
      }
    } catch {
      /* fall through to NSE */
    }

    // 2. Try NSE depth fetch (best-effort; usually 403 from server IPs).
    if (!depth) {
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
    }

    // If depth unavailable, be honest about it (spec: never fabricate depth).
    if (!depth) {
      return NextResponse.json({
        success: false,
        symbol,
        available: false,
        error: "Order-book data unavailable for this source.",
        reason: errorNote || "NSE depth feed did not return data and Breeze depth was unavailable.",
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
