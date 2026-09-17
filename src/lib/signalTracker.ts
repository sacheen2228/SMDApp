// lib/signalTracker.ts
//
// Persistent signal deduplication — tracks every signal sent to Telegram
// so the same trade is NEVER re-announced. Stores in-memory with daily reset.
// Signature = symbol|strike|optionType|direction (core setup identity).

const sentSignals = new Map<string, { sentAt: string; confidence: number; source: string }>();
let currentDateKey = "";

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function ensureFreshDay(): void {
  const key = todayKey();
  if (key !== currentDateKey) {
    currentDateKey = key;
    sentSignals.clear();
  }
}

// Build a unique signature for a trade setup
export function buildSignalSignature(params: {
  symbol: string;
  strike?: number;
  optionType?: string;
  direction?: string;
  side?: string;
  action?: string;
}): string {
  const strike = params.strike ?? "EQ";
  const optType = params.optionType ?? "";
  const dir = params.direction ?? params.side ?? params.action ?? "BUY";
  return `${params.symbol}|${strike}|${optType}|${dir}`;
}

// Check if this exact signal was already sent today
export function isSignalAlreadySent(signature: string): boolean {
  ensureFreshDay();
  return sentSignals.has(signature);
}

// Mark a signal as sent
export function markSignalSent(
  signature: string,
  confidence: number,
  source: string
): void {
  ensureFreshDay();
  sentSignals.set(signature, {
    sentAt: new Date().toISOString(),
    confidence,
    source,
  });
}

// Get all signals sent today (for reporting)
export function getTodaySignals(): Map<string, { sentAt: string; confidence: number; source: string }> {
  ensureFreshDay();
  return new Map(sentSignals);
}

// Check if a signal was sent with same or higher confidence (skip lower-quality re-runs)
export function isSignalDuplicateOrLowerQuality(
  signature: string,
  currentConfidence: number
): boolean {
  ensureFreshDay();
  const existing = sentSignals.get(signature);
  if (!existing) return false;
  // If we already sent this signal with >= confidence, skip
  return existing.confidence >= currentConfidence;
}

// Build a human-readable summary of today's sent signals
export function getTodaySignalSummary(): string {
  ensureFreshDay();
  if (sentSignals.size === 0) return "No signals sent today.";
  const lines: string[] = [];
  for (const [sig, info] of sentSignals) {
    lines.push(`  ${sig} — ${info.confidence}% (${info.source}) @ ${info.sentAt}`);
  }
  return `Today's signals (${sentSignals.size}):\n${lines.join("\n")}`;
}
