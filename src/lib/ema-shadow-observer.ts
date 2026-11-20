// Phase 8B — shadow-only observation recorder for the EMA 9/21/50
// market-structure read (Intraday + Weekly Scanners).
//
// Fire-and-forget: never blocks a scan response, never alters returned data,
// never emits alerts. Logging stays on while emaStructureShadow is true;
// emaStructureLive only gates Telegram delivery (ema-live-gate) and does not
// change what this recorder writes. Stale / closed-market / incomplete
// observations are still recorded (flagged) so the report can measure data
// coverage honestly — they are only excluded from "valid confirmation" counts
// at report time.

import { logCandidate } from "./candidate-log";
import { BRAIN_FLAGS } from "./brain-flags";
import { isMarketOpen } from "./marketHours";
import type { CandidateInput } from "./candidate-log";
import type { EmaStructure } from "./ema-structure";
import type { StockCandidate } from "./intraday-scanner";
import type { WeeklyCandidate } from "./weekly-equity-scanner";

export type ShadowSource = "intraday-scanner:shadow" | "weekly-scanner:shadow";

/** Index underlyings (from SYMBOL_CONFIGS). Everything else is a stock. */
const INDEX_SYMBOLS = new Set([
  "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX", "NIFTYNXT50",
]);

/** Candles older than this are treated as stale for observation purposes. */
const STALE_MS = 60 * 60 * 1000;

/** One observation per (symbol, source, UTC day) per server process. UTC day
 *  == IST day during market hours (09:15–15:30 IST = 03:45–10:00 UTC), so this
 *  dedupes repeated scanner polls within a session without cross-process state. */
const loggedToday = new Set<string>();

function utcDayKey(asOfMs: number): string {
  return String(Math.floor(asOfMs / (24 * 60 * 60 * 1000)));
}

function dedupeKey(symbol: string, source: ShadowSource, asOfMs: number): string {
  return `${symbol}|${source}|${utcDayKey(asOfMs)}`;
}

export function instrumentTypeOf(symbol: string): "INDEX" | "STOCK" {
  return INDEX_SYMBOLS.has(String(symbol || "").toUpperCase()) ? "INDEX" : "STOCK";
}

/** Normalise the scanner's own direction into BULLISH / BEARISH / NEUTRAL. */
export function normaliseDirection(value: string): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const v = String(value || "").toUpperCase();
  if (v === "BULLISH" || v === "UP" || v === "LONG" || v === "BUY") return "BULLISH";
  if (v === "BEARISH" || v === "DOWN" || v === "SHORT" || v === "SELL") return "BEARISH";
  return "NEUTRAL";
}

/** The existing engine's outcome for this candidate. */
export function outcomeFor(existingDirection: string, actionable: boolean): "BUY_RESEARCH" | "NO_TRADE" {
  return (normaliseDirection(existingDirection) !== "NEUTRAL" && actionable) ? "BUY_RESEARCH" : "NO_TRADE";
}

function confirmedSetupType(ema: EmaStructure): string | null {
  const confirmed = (ema.setups ?? []).filter((s) => s.confirmed);
  if (!confirmed || confirmed.length === 0) return null;
  return confirmed[0].type;
}

function isStaleEma(ema: EmaStructure | null, asOfMs: number): boolean {
  if (!ema) return true;
  if (ema.dataQuality === "STALE" || ema.dataQuality === "INSUFFICIENT") return true;
  if (ema.lastCandleTime != null && asOfMs - ema.lastCandleTime > STALE_MS) return true;
  return false;
}

/** Pure mapping of one evaluated candidate to its shadow-observation fields.
 *  Exported so it can be unit-tested without touching the database. */
export interface EmaShadowFields {
  emaAlignment: string | null;
  emaSetupType: string | null;
  emaDirection: string | null;
  emaDirectionalVerdict: string | null;
  emaOptionsConfirmation: string | null;
  emaDataQuality: string | null;
  emaIsStale: boolean;
  emaBars: number | null;
  existingSignalDirection: string;
  outcome: "BUY_RESEARCH" | "NO_TRADE";
  instrumentType: "INDEX" | "STOCK";
  expiryType: "WEEKLY" | "MONTHLY" | null;
  optionType: "CE" | "PE" | null;
  isMarketOpen: boolean;
  sessionWindow: "MARKET_ACTIVE" | "MARKET_CLOSED";
}

export function buildEmaShadowFields({
  symbol,
  ema,
  directionalCheck,
  optionsConfirmation,
  existingSignalDirection,
  actionable,
  optionType,
  expiryType,
  marketOpen,
  asOfMs,
}: {
  symbol: string;
  ema: EmaStructure | null;
  directionalCheck: string | null;
  optionsConfirmation: string | null;
  existingSignalDirection: string;
  actionable: boolean;
  optionType: "CE" | "PE" | null;
  expiryType: "WEEKLY" | "MONTHLY" | null;
  marketOpen: boolean;
  asOfMs: number;
}): EmaShadowFields {
  const dataQuality = ema?.dataQuality ?? "INSUFFICIENT";
  return {
    emaAlignment: ema?.alignment ?? null,
    emaSetupType: ema ? confirmedSetupType(ema) : null,
    emaDirection: ema?.direction ?? null,
    emaDirectionalVerdict: directionalCheck,
    emaOptionsConfirmation: optionsConfirmation,
    emaDataQuality: dataQuality,
    emaIsStale: isStaleEma(ema, asOfMs),
    emaBars: ema?.bars ?? null,
    existingSignalDirection,
    outcome: outcomeFor(existingSignalDirection, actionable),
    instrumentType: instrumentTypeOf(symbol),
    expiryType,
    optionType,
    isMarketOpen: marketOpen,
    sessionWindow: marketOpen ? "MARKET_ACTIVE" : "MARKET_CLOSED",
  };
}

/** Record one shadow observation per evaluated candidate. Returns void and
 *  never throws — a logging failure must never break a scan. */
export function recordEmaShadowObservations(
  candidates: ReadonlyArray<StockCandidate | WeeklyCandidate>,
  source: ShadowSource,
  opts: { asOfMs?: number } = {},
): void {
  if (!BRAIN_FLAGS.emaStructureShadow) return;
  const asOfMs = opts.asOfMs ?? Date.now();
  const open = isMarketOpen(new Date(asOfMs));

  for (const raw of candidates) {
    const c = raw as Record<string, unknown>;
    const key = dedupeKey(String(c.symbol ?? ""), source, asOfMs);
    if (loggedToday.has(key)) continue;
    loggedToday.add(key);

    try {
      const symbol = String(c.symbol ?? "");
      const ema = (c.emaStructure ?? null) as EmaStructure | null;
      const directionalCheck = (c.directionalCheck ?? null) as string | null;
      const optionsConfirmation = (c.optionsConfirmation ?? null) as string | null;

      let existingSignalDirection: string;
      let optionType: "CE" | "PE" | null = null;
      let expiryType: "WEEKLY" | "MONTHLY" | null = null;
      let actionable = false;

      if ("monthlyOptionTrade" in c) {
        // Intraday StockCandidate — its option trade is explicitly monthly.
        existingSignalDirection = String((c as StockCandidate).direction);
        const mo = (c as StockCandidate).monthlyOptionTrade;
        optionType = (mo?.optionType ?? null) as "CE" | "PE" | null;
        expiryType = mo ? "MONTHLY" : null;
        actionable =
          existingSignalDirection !== "NEUTRAL" &&
          (c as StockCandidate).grade !== "D" &&
          (c as StockCandidate).totalScore >= 40;
      } else {
        // Weekly WeeklyCandidate — carries no expiry field (observation
        // limitation: weekly vs monthly expiry not resolved here).
        existingSignalDirection = normaliseDirection(String((c as WeeklyCandidate).weeklyTrend));
        optionType = ((c as WeeklyCandidate).optionType ?? null) as "CE" | "PE" | null;
        expiryType = null;
        actionable =
          existingSignalDirection !== "NEUTRAL" &&
          (c as WeeklyCandidate).weeklyTrend !== "FLAT" &&
          (c as WeeklyCandidate).confidence >= 40;
      }

      const fields = buildEmaShadowFields({
        symbol,
        ema,
        directionalCheck,
        optionsConfirmation,
        existingSignalDirection,
        actionable,
        optionType,
        expiryType,
        marketOpen: open,
        asOfMs,
      });

      void logCandidate({
        source,
        symbol,
        direction: existingSignalDirection,
        underlyingSpot: null, // never the option premium
        entryPremium: null,
        stopPremium: null,
        targetPremium: null,
        confidence: null,
        rr: null,
        delta: null,
        regime: null,
        sessionWindow: fields.sessionWindow,
        gateVerdict: null,
        tier: null,
        emaAlignment: fields.emaAlignment,
        emaSetupType: fields.emaSetupType,
        emaDirection: fields.emaDirection,
        emaDirectionalVerdict: fields.emaDirectionalVerdict,
        emaOptionsConfirmation: fields.emaOptionsConfirmation,
        emaDataQuality: fields.emaDataQuality,
        emaIsStale: fields.emaIsStale,
        emaBars: fields.emaBars,
        existingSignalDirection: fields.existingSignalDirection,
        outcome: fields.outcome,
        observationSource: source,
        instrumentType: fields.instrumentType,
        expiryType: fields.expiryType,
        optionType: fields.optionType,
        isMarketOpen: fields.isMarketOpen,
      } as CandidateInput);
    } catch {
      // Never break the scan path.
    }
  }
}
