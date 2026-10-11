/**
 * Position sizing + P&L math for the audit engine.
 *
 * The engine historically recorded every trade at quantity = 1, so ₹ totals
 * were "points", not rupees — win rates were right, money was fake. These
 * helpers make P&L rupee-honest:
 *
 *   grossPnl = (exit - entry) × quantity        [sign by long/short]
 *   netPnl   = grossPnl - fees
 *   rMultiple stays size-independent: netPnl / (risk-per-unit × quantity)
 *
 * INDEX_LOT_SIZES mirrors src/lib/symbol-config.ts (single source of truth
 * on the app side; the sidecar stays standalone). Stock-option lots vary per
 * symbol — callers must pass `quantity` explicitly for those; unknown
 * symbols default to 1 rather than guessing.
 */

const INDEX_LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  SENSEX: 20,
  BANKEX: 30,
  NIFTYNXT50: 25,
};

/**
 * Per-trade budget. Real trading rule: max ₹20,000 deployed per trade,
 * buying as many lots/shares as fit in that budget regardless of premium
 * price — applies to ALL options (NIFTY/SENSEX index + stock F&O) and equity.
 * (Override via AUDIT_TRADE_BUDGET.)
 */
export function tradeBudget(): number {
  const raw = Number(process.env.AUDIT_TRADE_BUDGET ?? 20000);
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
}

/**
 * Fallback quantity when the caller doesn't pass one — sizes to the
 * ₹20K trade budget:
 * - OPTIONS/FUTURES (index) → lot × floor(budget / (premium × lot));
 *   minimum 1 lot even if that alone exceeds the budget (SENSEX-size premiums)
 * - OPTIONS/FUTURES (stock, lot unknown) → floor(budget / premium) units
 * - EQUITY → floor(budget / price) shares
 */
export function defaultQuantity(
  instrumentType: string,
  symbol: string,
  entryPrice: number
): number {
  const budget = tradeBudget();
  const upper = (symbol || "").toUpperCase();
  if (instrumentType === "OPTIONS" || instrumentType === "FUTURES") {
    const lot = INDEX_LOT_SIZES[upper] ?? 1;
    if (!(entryPrice > 0)) return lot;
    const lots = Math.max(1, Math.floor(budget / (entryPrice * lot)));
    return lot * lots;
  }
  if (instrumentType === "EQUITY" || instrumentType === "INDEX") {
    const qty = entryPrice > 0 ? Math.floor(budget / entryPrice) : 1;
    return Math.max(1, qty);
  }
  return 1;
}

/**
 * Discount-broker round-trip fee approximation:
 * ₹20 brokerage per side (₹40 flat) + ~1.5 bps of turnover per side.
 * Deliberately simple — the goal is "costs exist", not broker-exact.
 */
export function estimateFees(
  entryPrice: number,
  exitPrice: number,
  quantity: number
): number {
  const qty = quantity > 0 ? quantity : 1;
  const turnover = (Math.abs(entryPrice) + Math.abs(exitPrice)) * qty;
  return Math.round((40 + turnover * 0.00015) * 100) / 100;
}

export interface ClosePnlInput {
  isLong: boolean;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: number;
  stopLoss: number;
}

export interface ClosePnlResult {
  grossPnl: number;
  netPnl: number;
  roiPct: number;
  rMultiple: number;
}

export function computeClosePnl(input: ClosePnlInput): ClosePnlResult {
  const qty = input.quantity > 0 ? input.quantity : 1;
  const points = input.isLong
    ? input.exitPrice - input.entryPrice
    : input.entryPrice - input.exitPrice;
  const grossPnl = points * qty;
  const netPnl = grossPnl - (input.fees || 0);
  const invested = input.entryPrice * qty;
  const roiPct = invested !== 0 ? (netPnl / invested) * 100 : 0;
  const riskPerUnit = Math.abs(input.entryPrice - input.stopLoss);
  const rMultiple =
    riskPerUnit > 0 ? Number((netPnl / (riskPerUnit * qty)).toFixed(3)) : 0;
  return { grossPnl, netPnl, roiPct, rMultiple };
}
