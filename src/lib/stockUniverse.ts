// lib/stockUniverse.ts
//
// The universe the daily digest + intraday scanner sweep.
// Starts with the 5 indices that have live option-chain data via the
// Breeze/NSE APIs (the same ones the chat bot trades).
//
// To widen coverage later, add F&O stock symbols here — but only once
// fetchSnapshot() can return a real option chain (or equity alert) for
// them; right now it sources index option chains only.

export const INDICES = [
  "NIFTY",
  "BANKNIFTY",
  "SENSEX",
  "FINNIFTY",
  "MIDCPNIFTY",
] as const;

export const ALL_SYMBOLS: string[] = [...INDICES];

// ─── Option-chain symbol guard ─────────────────────────────────────────────
// Rejects synthetic/test IDs before any provider is contacted.
// Real NSE symbols: letters + & - . (e.g. M&M, BAJAJ-AUTO, 3MINDIA) and
// never embed a 6+ digit run — trade IDs embed epoch ms (TP1E17906240439251).
// Used by /api/option-chain to 400 fast instead of walking NSE + all
// Breeze expiries with garbage (60+ provider calls per test run).
export function isPlausibleOptionSymbol(symbol: string): boolean {
  const s = (symbol || "").trim();
  if (!s || s.length > 30) return false;
  if (!/^[A-Za-z0-9&.\-]+$/.test(s)) return false;
  if (/\d{6,}/.test(s)) return false; // epoch/timestamp runs = synthetic ID
  return true;
}
