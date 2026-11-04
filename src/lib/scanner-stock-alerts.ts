// Scanner → Telegram bridge for CASH STOCK candidates.
//
// THE GAP THIS CLOSES:
//   • The Scanner tab (intraday scanner + Weekly Equity Scanner) finds stock
//     setups but never told the user — the intraday scanner only alerted
//     OPTION trades, and the weekly scanner did not alert at all.
//   • The setups were never registered with the tracker, so a TP or SL hit
//     could never be reported.
//
// THIS MODULE IS GLUE ONLY — it composes the two paths that already exist:
//   • sendTradeAlert()            → the central alert funnel: hybrid veto,
//     risk caps, full-day dedup, short-term throttle, calibrated confidence.
//   • activeTradeTracker.addTrade() → registers the trade so the TIGER monitor
//     (5s poll) watches it and sends the TP_HIT / SL_HIT card.
//
// No new engine, no new alert format, no new monitoring loop.

import { sendTradeAlert } from "./telegram";
import { addTrade } from "./activeTradeTracker";

export type ScannerStockSource = "intraday-scanner" | "weekly-equity-scanner";

export interface ScannerStockSetup {
  symbol: string;
  name?: string;
  side: "BUY";
  /** The entry price the alert quotes (the option/premium analogue for cash). */
  entry: number;
  /** Optional entry ZONE (weekly scanner) — shown in the alert, entry quotes the midpoint. */
  entryZone?: { low: number; high: number };
  stopLoss: number;
  target1: number;
  target2?: number;
  target3?: number;
  /** The UNDERLYING price — never the premium. */
  spot: number;
  confidence: number;
  source: ScannerStockSource;
  /** Stable per symbol + day so a re-scan never opens a second trade. */
  tradeId: string;
  expiry?: string;
  /** Rupee deployment → whole shares (cash equity). Defaults to the app's per-trade budget. */
  budget?: number;
  reason?: string;
}

/** The app's per-trade deployment cap (option-plan.PLAN_CONFIG.maxDeployedAmount). */
const DEFAULT_BUDGET = 20_000;

/** Minimum reward:risk for a stock setup (matches the option-path gate). */
const MIN_RR = 1.5;

export interface ScannerStockValidation {
  ok: boolean;
  reason?: string;
}

/**
 * The safety gate for a cash-stock setup. A setup that fails here is never
 * alerted and never registered — the numbers must be coherent on their face
 * (SL below entry for a BUY, targets above it, a real risk:reward).
 */
export function validateScannerStock(s: ScannerStockSetup): ScannerStockValidation {
  if (!s.symbol) return { ok: false, reason: "no symbol" };
  if (!(s.entry > 0)) return { ok: false, reason: "entry price missing" };
  if (!(s.spot > 0)) return { ok: false, reason: "spot price missing" };
  if (!(s.stopLoss > 0)) return { ok: false, reason: "stop loss missing" };
  if (!(s.target1 > 0)) return { ok: false, reason: "target missing" };
  if (s.side === "BUY") {
    if (s.stopLoss >= s.entry) return { ok: false, reason: `SL ${s.stopLoss} not below entry ${s.entry}` };
    if (s.target1 <= s.entry) return { ok: false, reason: `TP ${s.target1} not above entry ${s.entry}` };
  }
  const risk = Math.abs(s.entry - s.stopLoss);
  const reward = Math.abs(s.target1 - s.entry);
  if (risk <= 0) return { ok: false, reason: "zero risk" };
  const rr = reward / risk;
  if (rr < MIN_RR) return { ok: false, reason: `R:R ${rr.toFixed(2)} below ${MIN_RR}` };
  if (s.confidence < 50) return { ok: false, reason: `confidence ${s.confidence} too low` };
  return { ok: true };
}

/** Whole shares for the rupee budget — never fractional, and HONEST: a budget
 *  that cannot buy one share returns 0 (never a forced 1 over the cap). */
export function scannerStockQuantity(entry: number, budget: number = DEFAULT_BUDGET): number {
  if (!(entry > 0) || !(budget > 0)) return 0;
  return Math.floor(budget / entry);
}

/**
 * ₹ still free under the open-deployment cap.
 *
 * The cap is a TOTAL (₹20k across the open book), so a candidate must be
 * sized against what is LEFT, not the full budget — otherwise an open ₹7k
 * book permanently blocks every new alert. The maths lives in
 * risk-state.server.ts (the ONE home for the caps).
 *
 * Returns null when the risk state cannot be read → fail closed.
 */
export async function scannerStockHeadroom(nowMs?: number): Promise<number | null> {
  try {
    const { loadRiskState, deploymentHeadroom } = await import("./risk-state.server");
    const loaded = await loadRiskState(nowMs ?? Date.now());
    if (!loaded.ok) return null;
    return deploymentHeadroom(loaded.state).deployed;
  } catch {
    return null;
  }
}

/**
 * Send the stock setup to Telegram and register it for TP/SL monitoring.
 *
 * Returns true only when the alert was actually delivered. The trade is
 * registered ONLY on a delivered alert — an alert that the veto blocked or
 * the full-day dedup skipped must not open a position the user never saw.
 */
export async function alertScannerStock(s: ScannerStockSetup): Promise<boolean> {
  const validation = validateScannerStock(s);
  if (!validation.ok) {
    console.log(`[ScannerAlert] BLOCKED ${s.symbol}: ${validation.reason}`);
    return false;
  }

  // Size against the ₹ LEFT under the open-deployment cap (the cap is a
  // total across the open book, not a per-trade allowance).
  const headroom = await scannerStockHeadroom();
  if (headroom == null) {
    console.log(`[ScannerAlert] BLOCKED ${s.symbol}: risk state unreadable — fail closed`);
    return false;
  }
  const budget = Math.min(s.budget ?? DEFAULT_BUDGET, headroom);
  const quantity = scannerStockQuantity(s.entry, budget);
  if (quantity < 1) {
    console.log(`[ScannerAlert] BLOCKED ${s.symbol}: ₹${Math.round(budget)} headroom buys no share of ₹${s.entry}`);
    return false;
  }
  const deployedAmount = quantity * s.entry;
  const riskAmount = quantity * Math.abs(s.entry - s.stopLoss);

  const sent = await sendTradeAlert({
    symbol: s.symbol,
    action: s.side === "BUY" ? "BUY" : "SELL",
    strike: 0,
    type: "EQ",
    instrument: "EQUITY",
    confidence: s.confidence,
    entry: s.entry,
    stopLoss: s.stopLoss,
    target1: s.target1,
    target2: s.target2,
    spot: s.spot,
    source: s.source,
    requireSpot: true,
    // A stock setup has no contract expiry — the expiry gate must not apply.
    requireExpiry: false,
    entryZone: s.entryZone,
    // The REAL cash exposure: one share = one unit (lotSize 1), so the risk
    // check prices the candidate as cash instead of as an F&O lot.
    lots: quantity,
    lotSize: 1,
    deployedAmount,
    riskAmount,
  }).catch(() => false);

  if (!sent) return false;

  // Register with the tracker so the TIGER monitor (5s poll) watches the
  // position and sends the TP_HIT / SL_HIT card when a level is reached.
  try {
    await addTrade(
      {
        id: s.tradeId,
        symbol: s.symbol,
        side: s.side,
        instrument: "EQUITY",
        strike: 0,
        optionType: "EQ",
        entry: s.entry,
        sl: s.stopLoss,
        tp1: s.target1,
        tp2: s.target2 ?? s.target1,
        tp3: s.target3,
        status: "ACTIVE",
        sentAt: new Date().toISOString(),
        source: s.source,
        spotPrice: s.spot,
        confidence: s.confidence,
        exchange: "NSE",
        positionSize: quantity,
        expiry: s.expiry,
      },
      true // skipAlert — sendTradeAlert already sent it
    );
  } catch (err: any) {
    console.warn(`[ScannerAlert] ${s.symbol} — trade registration failed: ${err.message}`);
  }

  return true;
}

/** Stable trade id: one scanner trade per symbol per day. */
export function scannerTradeId(source: ScannerStockSource, symbol: string, ymd: string): string {
  return `SCAN-${source === "weekly-equity-scanner" ? "WEEK" : "INTRA"}-${symbol}-${ymd}`;
}
