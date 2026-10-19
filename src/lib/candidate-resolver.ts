// candidate-resolver.ts
// Resolves the OUTCOME of every logged candidate so the veto can be measured
// out-of-sample instead of only on trades that were actually taken.
//
// Simulation rules (documented, deterministic):
//   - stop wins a same-bar tie (conservative: assume the adverse level first)
//   - intraday candidates are FLAT at the end of the trading day if neither
//     stop nor target was touched (R = 0)
//   - no costs by default; BRAIN_FLAGS.resolverCosts enables the cost model
//   - R is measured in units of risk: 1R = (entry - stop) for a long premium
//
// The resolver reads candles through the tech-read endpoint (CANDLE_URL) — never
// through the veto path, which must stay network-free.
import { GATE_CONFIG } from "./agent-brain-gate";
import { BRAIN_FLAGS, COST_MODEL } from "./brain-flags";
import { pendingCandidates, writeResolution, type Tier } from "./candidate-log";
import { fetchCandles, type Candle } from "./tech-read";

export interface ResolveOptions {
  base?: string;          // app base URL for the candle endpoint
  limit?: number;
  nowMs?: number;
  tf?: string;            // candle timeframe for the simulation
}

export interface Resolution {
  id: string;
  symbol: string;
  outcomeR: number;
  status: "target" | "stop" | "flat" | "unresolved";
  bars: number;
}

/** Trading-session end (15:30 IST) for a timestamp — intraday candidates are flat after this. */
function sessionEndMs(tsMs: number): number {
  const d = new Date(tsMs);
  const end = new Date(d);
  end.setUTCHours(10, 0, 0, 0); // 15:30 IST = 10:00 UTC
  if (end.getTime() < tsMs) end.setUTCDate(end.getUTCDate() + 1);
  return end.getTime();
}

/**
 * Simulate one candidate against the candles that follow it.
 * Pure function — the fetch happens in the caller.
 */
export function simulateOutcome(
  candles: Candle[],
  entry: number,
  stop: number,
  target: number,
  opts: { isLong: boolean; tsMs: number; costs?: boolean; intraday?: boolean } = { isLong: true, tsMs: 0 },
): { outcomeR: number; status: "target" | "stop" | "flat" | "unresolved" } {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
    return { outcomeR: 0, status: "unresolved" };
  }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { outcomeR: 0, status: "unresolved" };

  const after = candles.filter((c) => c.t > opts.tsMs).sort((a, b) => a.t - b.t);
  if (!after.length) return { outcomeR: 0, status: "unresolved" };

  const endMs = opts.intraday ? sessionEndMs(opts.tsMs) : Infinity;
  let hitStop = false;
  let hitTarget = false;
  for (const c of after) {
    if (c.t > endMs) break;
    const lowHit = opts.isLong ? c.l <= stop : c.h >= stop;
    const highHit = opts.isLong ? c.h >= target : c.l <= target;
    // stop wins a same-bar tie
    if (lowHit) { hitStop = true; break; }
    if (highHit) { hitTarget = true; break; }
  }
  // R is signed by direction: a stop hit is ALWAYS -1R, a target hit is the planned R.
  const pnlPts = opts.isLong
    ? (hitTarget ? target - entry : hitStop ? stop - entry : 0)
    : (hitTarget ? entry - target : hitStop ? entry - stop : 0);
  let r = pnlPts / risk;
  if (opts.costs) {
    const costPct = COST_MODEL.perTradePremiumPct * entry;
    r -= costPct / risk;
  }
  return { outcomeR: r, status: hitTarget ? "target" : hitStop ? "stop" : "flat" };
}

/** Resolve pending candidates. Uses the candle endpoint; never runs in the alert path. */
export async function resolvePendingCandidates(opts: ResolveOptions = {}): Promise<Resolution[]> {
  const base = opts.base ?? `http://127.0.0.1:${process.env.PORT || 3000}`;
  const tf = opts.tf ?? "5m";
  const pending = await pendingCandidates(opts.limit ?? 50);
  const out: Resolution[] = [];
  for (const c of pending) {
    if (c.entryPremium == null || c.stopPremium == null || c.targetPremium == null) {
      out.push({ id: c.id, symbol: c.symbol, outcomeR: 0, status: "unresolved", bars: 0 });
      continue;
    }
    const cr = await fetchCandles(base, c.symbol, tf);
    if (!cr.ok) {
      out.push({ id: c.id, symbol: c.symbol, outcomeR: 0, status: "unresolved", bars: 0 });
      continue;
    }
    const res = simulateOutcome(cr.candles, c.entryPremium, c.stopPremium, c.targetPremium, {
      isLong: !/SELL|PUT|PE/i.test(c.direction),
      tsMs: c.ts.getTime(),
      costs: BRAIN_FLAGS.resolverCosts,
      intraday: tf !== "1d",
    });
    out.push({ id: c.id, symbol: c.symbol, outcomeR: res.outcomeR, status: res.status, bars: cr.candles.length });
    if (res.status !== "unresolved") await writeResolution(c.id, res.outcomeR, new Date());
  }
  return out;
}

/** Promotion rule: tier C may be promoted only with enough resolved history and a
 *  Wilson lower bound on expectancy R above the configured floor. */
export function promotionEligible(
  rows: { tier: Tier | null; outcomeR: number | null }[],
  opts = BRAIN_FLAGS.promotion,
): { eligible: boolean; n: number; ciLowerR: number; expectancyR: number } {
  const c = rows.filter((r) => r.tier === "C" && r.outcomeR != null);
  const n = c.length;
  if (n < opts.minResolvedTrades) return { eligible: false, n, ciLowerR: 0, expectancyR: 0 };
  const rs = c.map((r) => r.outcomeR as number);
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rs.length - 1));
  const se = sd / Math.sqrt(n);
  const ciLowerR = mean - 1.96 * se;
  return { eligible: ciLowerR > opts.minExpectancyCiLowerR, n, ciLowerR, expectancyR: mean };
}

export const GATE = GATE_CONFIG;
