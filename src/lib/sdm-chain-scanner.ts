// SDM chain scanner — background poller that keeps /api/option-chain
// analysis running for the instruments you trade WITHOUT the dashboard open.
//
// Ownership split (do not duplicate elsewhere):
//   - /api/option-chain route  → SDM analysis + ENTRY alerts (sendTradeAlert
//     full-day signature dedup + alreadyActive guard) + trade registration
//   - tiger-monitor             → TP1/TP2/SL hit cards (5s LTP loop)
//   - THIS module               → only supplies the requests that trigger
//     the route's existing analysis during market hours
//
// Cadence: every tick (default 60s, SDM_SCAN_INTERVAL_MS) fetches all
// indices (default NIFTY + SENSEX — your approved set) plus ONE stock from
// the F&O universe in round-robin, so each stock's chain is analysed once
// per full rotation (~20 min for20 names) instead of every tick — keeps
// Breeze API quota sane.
//
// Env:
//   SDM_SCAN_INDICES   comma list | "0" to disable   (default NIFTY,SENSEX)
//   SDM_SCAN_STOCKS    comma list | "0" to disable   (default FNO_SCAN_UNIVERSE)
//   SDM_SCAN_INTERVAL_MS                             (default 60000)

import { isMarketOpen } from "@/lib/marketHours";

// Liquid NSE F&O option stocks — same universe the F&O scanner ranks.
export const FNO_SCAN_UNIVERSE: string[] = [
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
  "HINDUNILVR", "ITC", "SBIN", "BHARTIARTL", "KOTAKBANK",
  "LT", "AXISBANK", "BAJFINANCE", "ASIANPAINT", "MARUTI",
  "SUNPHARMA", "TITAN", "ULTRACEMCO", "TATAMOTORS", "WIPRO",
];

/**
 * Symbols to fetch on tick `tickIndex`: every configured index plus one
 * round-robin stock (none when the stock list is empty).
 */
export function getScanPlan(tickIndex: number, indices: string[], stocks: string[]): string[] {
  const plan = [...indices];
  if (stocks.length > 0) {
    plan.push(stocks[((tickIndex % stocks.length) + stocks.length) % stocks.length]);
  }
  return plan;
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (raw === undefined) return fallback;
  const v = raw.trim();
  if (v === "" || v === "0") return [];
  return v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function readConfig() {
  return {
    indices: parseList(process.env.SDM_SCAN_INDICES, ["NIFTY", "SENSEX"]),
    stocks: parseList(process.env.SDM_SCAN_STOCKS, FNO_SCAN_UNIVERSE),
    intervalMs: Math.max(10_000, Number(process.env.SDM_SCAN_INTERVAL_MS) || 60_000),
  };
}

// ── Loop state ──
let timer: ReturnType<typeof setInterval> | null = null;
let tickIndex = 0;
let started = false;

async function fetchChain(symbol: string): Promise<void> {
  try {
    const base = process.env.SMD_API_BASE || "http://127.0.0.1:3000";
    const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.warn(`[sdm-scan] ${symbol} → HTTP ${res.status}`);
    }
  } catch (e: any) {
    console.warn(`[sdm-scan] ${symbol} failed:`, e?.message || e);
  }
}

async function tick(): Promise<void> {
  if (!isMarketOpen()) return;
  const { indices, stocks } = readConfig();
  const plan = getScanPlan(tickIndex, indices, stocks);
  tickIndex++;

  // Indices first (the always-on set), then the rotating stock.
  if (plan.length === 0) return;
  const indexSymbols = plan.slice(0, indices.length);
  const stockSymbols = plan.slice(indices.length);

  await Promise.all(indexSymbols.map(fetchChain));
  for (const s of stockSymbols) await fetchChain(s);

  // Quiet logging: heartbeat every10 ticks, errors logged in fetchChain.
  if (tickIndex % 10 === 1) {
    console.log(`[sdm-scan] tick ${tickIndex} | plan: ${plan.join(", ")} | stock rotation ${stocks.length} names`);
  }
}

/**
 * Start the background scanner (idempotent). Called from instrumentation.ts
 * on server boot — each tick self-gates on market hours.
 */
export function startSdmChainScanner(): void {
  if (started) return;
  started = true;
  const { intervalMs } = readConfig();
  timer = setInterval(() => {
    tick().catch((e) => console.warn("[sdm-scan] tick error:", e?.message || e));
  }, intervalMs);
  // First cycle shortly after boot (market-hours gated inside tick).
  setTimeout(() => {
    tick().catch((e) => console.warn("[sdm-scan] tick error:", e?.message || e));
  }, 5_000);
  console.log(`[sdm-scan] started (every ${intervalMs}ms, market hours only)`);
}

export function stopSdmChainScanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
