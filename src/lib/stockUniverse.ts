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
