// lib/intradayState.ts
//
// Tracks which setups have already been pushed today, so the intraday
// scanner only alerts on genuinely NEW setups, not the same trade
// re-announced every 15 minutes.
//
// In-memory + resets automatically when the date rolls over. Swap for
// Redis/DB if you run multiple processes (same caveat as historyStore.ts).

let currentDateKey = "";
let sentSignatures = new Set<string>();

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

function ensureFreshDay(): void {
  const key = todayKey();
  if (key !== currentDateKey) {
    currentDateKey = key;
    sentSignatures = new Set();
  }
}

// Signature identifies "the same setup" — symbol + strike + option type + direction.
// Two runs producing the same signature won't both alert; a genuinely different
// strike or a flipped direction on the same symbol WILL alert again.
export function buildSignature(symbol: string, alert: unknown): string {
  const a = alert as any;
  const strike = a.strike ?? "EQ";
  const optionType = a.optionType ?? a.type ?? "";
  const action = a.side ?? a.action ?? a.direction ?? "BUY";
  return `${symbol}|${strike}|${optionType}|${action}`;
}

export function alreadySentToday(signature: string): boolean {
  ensureFreshDay();
  return sentSignatures.has(signature);
}

export function markSentToday(signature: string): void {
  ensureFreshDay();
  sentSignatures.add(signature);
}
