/**
 * Order Book feed — NIFTY futures via the ICICI Breeze live stream.
 *
 * Reuses the shared Breeze session (auth.ts) and joins the shared Socket.IO
 * connection via raw `join` emits + a raw `stock` listener. It does NOT touch
 * the shared SSE fan-out in /api/breeze/stream (that sets `breeze.onTicks`),
 * so the existing Terminal chart path is unaffected.
 *
 * The broker only streams a SHALLOW book (~5 levels per side), which the UI
 * detects from the `levels` field and renders in shallow-book mode.
 */

import { initSession, getBreezeClient, getConfig } from "@/lib/icici-breeze/auth";
import { getNearestExpiry } from "@/lib/expiry-calculator";
import type { BookSnapshot } from "./types";

export const FRESH_MS = 15_000;

export const ORDER_BOOK_DEBUG =
  process.env.ORDER_BOOK_DEBUG === "1" || process.env.DEBUG === "1";

interface FeedState {
  starting: Promise<FeedState> | null;
  snap: BookSnapshot | null;
  quoteToken: string;
  depthToken: string;
  expiry: string;
  socket: any;
}

function feedState(): FeedState {
  const g = globalThis as any;
  if (!g.__orderBookNifty) {
    g.__orderBookNifty = {
      starting: null,
      snap: null,
      quoteToken: "",
      depthToken: "",
      expiry: "",
      socket: null,
    } as FeedState;
  }
  return g.__orderBookNifty;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** "23-Nov-2026" → epoch ms (local time parts, no TZ drift). */
function parseDdmmyyyy(s: string): number {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || ""));
  if (!m) return NaN;
  const mon = MONTHS[String(m[2]).toUpperCase().slice(0, 3)];
  if (mon === undefined) return NaN;
  const d = new Date(Number(m[3]), mon, Number(m[1]));
  return d.getTime();
}

function dayStartIstMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Pick the nearest NIFTY futures expiry (Breeze format "DD-MMM-YYYY"). */
function pickNiftyExpiry(breeze: any): string {
  const masterArr: any[] = breeze?.stockScriptDictList || [];
  const nfoDict: Record<string, string> =
    Array.isArray(masterArr) && masterArr[4] ? masterArr[4] : {};
  const all: Record<string, string> = masterArr[4] || (masterArr[0] as any) || {};

  const keyFor = (date: string) => `FUT-NIFTY-${date}`;

  // 1) Single source of truth: the expiry calculator (holiday-aware).
  const nearest = getNearestExpiry("NIFTY");
  const cand = nearest?.date;
  if (cand && (all as any)[keyFor(cand)]) {
    return cand;
  }

  // 2) Fallback: scan the fetched security master for nearest-future >= today (IST).
  const startTs = dayStartIstMs();
  let best: string | null = null;
  let bestTs = Infinity;
  for (const [k, token] of Object.entries<any>(all)) {
    if (!token) continue;
    if (!k.startsWith("FUT-NIFTY-")) continue;
    const exp = k.slice("FUT-NIFTY-".length);
    const ts = parseDdmmyyyy(exp);
    if (Number.isNaN(ts)) continue;
    if (ts < startTs) continue;
    if (ts < bestTs) {
      bestTs = ts;
      best = exp;
    }
  }
  if (!best) throw new Error("NO_FUTURE_EXPIRY_IN_MASTER");
  return best;
}

function waitForSocket(breeze: any, timeoutMs = 12_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = breeze?.socket;
    if (!s) {
      reject(new Error("No Breeze socket"));
      return;
    }
    if (s.connected) {
      resolve(s);
      return;
    }
    let timer: any = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeout(timer);
      try {
        s.off("connect", onConnect);
        s.off("error", onErr);
        s.off("disconnect", onErr);
      } catch {}
    };
    const onConnect = () => {
      cleanup();
      resolve(s);
    };
    const onErr = (e: any) => {
      cleanup();
      reject(new Error(e?.message || "Breeze WS error"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Breeze WS connect timeout"));
    }, timeoutMs);
    s.on("connect", onConnect);
    s.once("connect_error", onErr);
    s.once("error", onErr);
  });
}

function num(t: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = t?.[k];
    if (v !== null && v !== undefined && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function applyTick(st: FeedState, t: any) {
  if (ORDER_BOOK_DEBUG) {
    try {
      console.log("[OrderBook] TICK", JSON.stringify(t));
    } catch {}
  }
  const s = st.snap;
  if (!s) return;
  const now = Date.now();

  const depthArr = Array.isArray(t?.depth) ? t.depth : null;
  if (depthArr && depthArr.length) {
    const bids: Array<[number, number]> = [];
    const asks: Array<[number, number]> = [];
    depthArr.forEach((lv: any, idx: number) => {
      const i = idx + 1;
      const bp = num(lv, `BestBuyRate-${i}`, "BestBuyRate", "bPrice");
      const bq = num(lv, `BestBuyQty-${i}`, "BestBuyQty", "bQty");
      const sp = num(lv, `BestSellRate-${i}`, "BestSellRate", "sPrice");
      const sq = num(lv, `BestSellQty-${i}`, "BestSellQty", "sQty");
      if (bp > 0 && bq > 0) bids.push([bp, bq]);
      if (sp > 0 && sq > 0) asks.push([sp, sq]);
    });
    if (bids.length && asks.length) {
      s.bids = bids;
      s.asks = asks;
      s.ts = now;
    }
  }

  const ltp = num(t, "last", "ltp", "lastTradedPrice");
  if (ltp > 0) {
    s.ltp = ltp;
    const hi = num(t, "high", "dayHigh", "HighPrice");
    const lo = num(t, "low", "dayLow", "LowPrice");
    s.high = hi > 0 ? hi : s.high || ltp;
    s.low = lo > 0 ? lo : s.low || ltp;
    s.ts = now;
  }
}

function startEnsure(): Promise<FeedState> {
  const st = feedState();
  if (st.starting) return st.starting;
  const p = (async (): Promise<FeedState> => {
    await initSession();
    const breeze = getBreezeClient();
    const cfg = getConfig();
    if (!breeze?.sessionKey || !breeze?.userId) {
      await breeze.generateSession(cfg?.secretKey, cfg?.sessionToken);
    }
    const masterArr: any[] = breeze?.stockScriptDictList || [];
    const nfoDict: Record<string, string> =
      Array.isArray(masterArr) && masterArr[4] ? masterArr[4] : {};
    const hasMaster = Object.keys(nfoDict).some((k) => String(k).startsWith("FUT-NIFTY-"));
    if (!hasMaster) {
      await breeze.getStockScriptList();
    }
    const expiry = pickNiftyExpiry(breeze);
    const tokInfo = breeze.getStockTokenValue({
      exchangeCode: "NFO",
      stockCode: "NIFTY",
      productType: "futures",
      expiryDate: expiry,
      strikePrice: "0",
      right: "others",
      getExchangeQuotes: true,
      getMarketDepth: true,
    });
    const quoteToken: string = tokInfo?.exch_quote_token || "";
    const depthToken: string = tokInfo?.market_depth_token || "";
    if (!quoteToken || !depthToken) {
      throw new Error("NO_BOOK_TOKEN_FOR_FUTURE");
    }

    breeze.wsConnect();
    const sock = await waitForSocket(breeze);
    st.socket = sock;
    st.quoteToken = quoteToken;
    st.depthToken = depthToken;
    st.expiry = expiry;
    st.snap = st.snap || {
      ltp: 0,
      expiry,
      low: 0,
      high: 0,
      bids: [],
      asks: [],
      levels: 0,
      ts: 0,
    };

    const onStock = (raw: any) => {
      try {
        const tok = Array.isArray(raw) ? raw?.[0] : raw;
        if (tok !== quoteToken && tok !== depthToken) return;
        const tick = breeze.parseData(raw);
        const list = Array.isArray(tick) ? tick : [tick];
        for (const t of list) {
          if (t && typeof t === "object") applyTick(st, t);
        }
      } catch (e: any) {
        if (ORDER_BOOK_DEBUG) console.log("[OrderBook] tick error:", String(e?.message || e));
      }
    };
    sock.on("stock", onStock);
    const onReconnect = () => {
      try {
        sock.emit("join", quoteToken);
        sock.emit("join", depthToken);
      } catch {}
    };
    sock.on("connect", onReconnect);

    try {
      sock.emit("join", quoteToken);
      sock.emit("join", depthToken);
    } catch (e: any) {
      throw new Error("Breeze join failed: " + String(e?.message || e));
    }

    return st;
  })();
  st.starting = p;
  return p;
}

export async function ensureNiftyFeed(): Promise<FeedState> {
  const st = feedState();
  if (st.starting) return st.starting;
  const p = startEnsure();
  st.starting = p;
  try {
    const s = await p;
    st.starting = null;
    return s;
  } catch (e: any) {
    st.starting = null;
    throw e;
  }
}

/** Fresh snapshot for NIFTY or null (not yet received / stale / incomplete). */
export function getNiftySnapshot(): BookSnapshot | null {
  const st = feedState();
  const s = st.snap;
  if (!s) return null;
  if (!s.ltp || !s.bids?.length || !s.asks?.length) return null;
  if (Date.now() - s.ts > FRESH_MS) return null;
  const levels = Math.max(s.bids.length, s.asks.length);
  if (levels <= 0) return null;
  return {
    ltp: s.ltp,
    expiry: s.expiry || "",
    low: s.low || 0,
    high: s.high || 0,
    bids: s.bids,
    asks: s.asks,
    levels,
    ts: s.ts,
  };
}
