// null-pnl-repair — shared real-exit resolution for EXPIRED-with-null-pnl
// journal rows (stale_reload_cleanup boots). Two callers MUST agree:
//   1. scripts/repair-null-pnl.ts   — one-shot repair of the 907-row backlog
//   2. instrumentation.ts stale cleanup — stops writing new unpriced rows
//
// Semantics (mirrors scripts/repair-legacy-exits.ts / B2 approval):
//   - EQUITY / BTST: first trading day after entry (weekends skipped, walk ≤6)
//   - options (CE/PE/CALL/PUT): contract lifecycle — expiry chosen from the
//     created date's bhavcopy (walk-forward ≤4), effective exit =
//     min(expiry, recorded boot-stamp), premium close walked back ≤3 days
//     over non-trading dates, never before the created date.
//   - Fake strikes / dead contracts → NO_DATA (row stays unpriced, honest).

import { chooseContractExpiry, effExitDate } from "@/lib/ledger-repair";
import { computeEodClose } from "@/lib/eod-squareoff";
import {
  getPremiumOHLC,
  isWeekend,
  listExpiries,
  type PremiumCandle,
} from "@/lib/option-bhavcopy";
import { getDailyRange } from "@/lib/trade-validator";

// ── pure helpers ────────────────────────────────────────────────────────────

/** Calendar date in IST for a UTC instant (journal times are UTC). */
export function istDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return new Date(dt.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Journal uses both CE/PE and CALL/PUT (intraday-scan/manual rows). */
export function normalizeOptionType(type: string | null | undefined): "CE" | "PE" | null {
  if (!type) return null;
  const t = type.toUpperCase();
  if (t === "CE" || t === "CALL") return "CE";
  if (t === "PE" || t === "PUT") return "PE";
  return null;
}

export type RowExitPlan =
  | { kind: "option"; created: string; recordedExit: string }
  | { kind: "equity"; created: string; exitDate: string }
  | { kind: "unknown"; created: string; detail: string };

export function planRowExit(row: {
  strategy?: string;
  type?: string | null;
  entryTime: Date | string;
  exitTime?: Date | string | null;
}): RowExitPlan {
  const created = istDate(row.entryTime);
  if (normalizeOptionType(row.type ?? null)) {
    // recordedExit falls back to entry when exitTime is null; resolveRealExit
    // ignores it in that case and uses the expiry as the effective exit.
    return { kind: "option", created, recordedExit: istDate(row.exitTime ?? row.entryTime) };
  }
  if ((row.type ?? "").toUpperCase() === "EQUITY") {
    return { kind: "equity", created, exitDate: addDaysISO(created, 1) };
  }
  return { kind: "unknown", created, detail: `unhandled type ${row.type}` };
}

// ── IO resolution (memoized across rows: dates/symbols repeat) ──────────────

const expiryCache = new Map<string, string[]>();
async function getExpiriesCached(date: string, symbol: string): Promise<string[]> {
  const key = `${date}|${symbol}`;
  if (!expiryCache.has(key)) expiryCache.set(key, await listExpiries(date, symbol));
  return expiryCache.get(key)!;
}

const dailyCache = new Map<string, { high: number; low: number; close: number } | null>();
async function getDailyRangeCached(symbol: string, date: string) {
  const key = `${symbol}|${date}`;
  if (!dailyCache.has(key))
    dailyCache.set(key, await getDailyRange(symbol, new Date(`${date}T00:00:00Z`)));
  return dailyCache.get(key) ?? null;
}

export interface RepairableRow {
  symbol: string;
  strategy?: string;
  type?: string | null;
  side?: string;
  entryPrice: number;
  entryTime: Date | string;
  exitTime?: Date | string | null;
  strike?: number | null;
}

export type RealExit =
  | {
      outcome: "PRICED";
      exitPrice: number;
      exitDate: string;
      source: "daily_ohlc" | "bhavcopy";
      pnl: number;
      pnlPercent: number;
      detail: string;
    }
  | { outcome: "NO_DATA" | "NO_EXPIRY" | "STRIKE_MISSING" | "UNKNOWN_TYPE" | "ERROR"; detail: string };

/** Resolve the real close for one corrupted row. Never fabricates: outcomes
 *  are PRICED (real market close) or an honest failure reason. */
export async function resolveRealExit(row: RepairableRow): Promise<RealExit> {
  try {
    const plan = planRowExit(row);
    const side = (row.side || "BUY").toUpperCase();

    if (plan.kind === "unknown")
      return { outcome: "UNKNOWN_TYPE", detail: plan.detail };

    if (plan.kind === "equity") {
      let range: { high: number; low: number; close: number } | null = null;
      let realExit: string | null = null;
      for (let w = 1; w <= 6 && !range; w++) {
        const cand = addDaysISO(plan.created, w);
        if (isWeekend(cand)) continue;
        range = await getDailyRangeCached(row.symbol, cand);
        if (range) realExit = cand;
      }
      if (!range || !realExit)
        return { outcome: "NO_DATA", detail: `no daily close within 6d of ${plan.created}` };
      const calc = computeEodClose(side, row.entryPrice, range.close);
      if (!calc)
        return { outcome: "NO_DATA", detail: `bad prices entry=${row.entryPrice} close=${range.close}` };
      return {
        outcome: "PRICED",
        exitPrice: range.close,
        exitDate: realExit,
        source: "daily_ohlc",
        pnl: calc.pnl,
        pnlPercent: calc.pnlPercent,
        detail: `daily close ${realExit}`,
      };
    }

    // option
    const strike = Number(row.strike);
    if (row.strike == null || !Number.isFinite(strike))
      return { outcome: "STRIKE_MISSING", detail: "strike null" };
    const optionType = normalizeOptionType(row.type);
    if (!optionType)
      return { outcome: "UNKNOWN_TYPE", detail: `not an option type ${row.type}` };

    let expiries: string[] = [];
    let probeDate = plan.created;
    for (let w = 0; w <= 4 && expiries.length === 0; w++, probeDate = addDaysISO(plan.created, w)) {
      expiries = await getExpiriesCached(probeDate, row.symbol);
    }
    const expiry = chooseContractExpiry(expiries, plan.created);
    if (!expiry)
      return {
        outcome: "NO_EXPIRY",
        detail: `created=${plan.created} expiries=[${expiries.join(",")}]`,
      };

    const hasStamp = row.exitTime != null;
    const eff = hasStamp ? effExitDate(expiry, plan.recordedExit) : expiry;
    let real: PremiumCandle | null = null;
    let effUsed = eff;
    for (let back = 0; back <= 3 && !real; back++) {
      const cand = addDaysISO(eff, -back);
      if (cand < plan.created) break;
      effUsed = cand;
      if (isWeekend(cand)) continue;
      real = await getPremiumOHLC({
        date: cand,
        symbol: row.symbol,
        strike,
        optionType,
        expiry,
      });
    }
    if (!real)
      return {
        outcome: "NO_DATA",
        detail: `eff=${eff} exp=${expiry} strike=${strike}${optionType}`,
      };
    const calc = computeEodClose(side, row.entryPrice, real.close);
    if (!calc)
      return { outcome: "NO_DATA", detail: `bad prices entry=${row.entryPrice} close=${real.close}` };
    return {
      outcome: "PRICED",
      exitPrice: real.close,
      exitDate: effUsed,
      source: "bhavcopy",
      pnl: calc.pnl,
      pnlPercent: calc.pnlPercent,
      detail: `exp=${expiry} eff=${effUsed} strike=${strike}${optionType}`,
    };
  } catch (e: any) {
    return { outcome: "ERROR", detail: String(e?.message || e) };
  }
}
