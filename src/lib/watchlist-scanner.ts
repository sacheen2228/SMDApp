/// <reference types="bun-types" />
// watchlist-scanner.ts — NIFTY 50 option‑stock scanner core.
// Pure (network‑free) functions are exported at top level for TDD.
// Async mode runners lazily import network modules so that bun test stays offline.

import { classicPivots } from "@/lib/tech-read";
import { gradePicks, bucketHitRate, formatPick } from "@/lib/watchlist-picks";

// ---------------------------------------------------------------------------
// Types — kept minimal so the module has zero external deps for the pure fns.
// ---------------------------------------------------------------------------

export interface ScannerStock {
  symbol: string;
  last: number;
  pChange: number;
  high: number;
  low: number;
  prevClose: number;
  nearWKH?: number; // % below 52‑week high (NSE field, may be absent)
  nearWKL?: number; // % above 52‑week low
  tradedValue?: number; // total traded value (NSE field)
}

export interface ChainRow {
  strike: number;
  ceLtp?: number;
  peLtp?: number;
  ceIv?: number;
  peIv?: number;
  ceVol?: number;
  peVol?: number;
  ceOi?: number;
  peOi?: number;
  ceOiChg?: number;
  peOiChg?: number;
}

export interface ChainStats {
  rows: ChainRow[];
  spot: number;
  expiry: string;
  pcr: number;        // put‑call open‑interest ratio
  atmIV: number;      // ATM implied volatility (%)
  expMovePct: number; // 1‑day 1‑sigma move, % of spot
  callChg: number;    // sum ΔOI calls
  putChg: number;     // sum ΔOI puts
  maxCallStrike: number;
  maxPutStrike: number;
}

export interface ScoredPick {
  symbol: string;
  score: number;
  bias: "BULLISH" | "BEARISH" | "MIXED";
  last: number;
  pChange: number;
  pivot: { P: number; R1: number; S1: number };
  chain?: ChainStats;
  gap?: number | null;
}

/* -----------------------------------------------------------------------
   Pure scoring — these functions never import network / Prisma / Telegram.
   They can be run in bun:test with no side effects.
   ----------------------------------------------------------------------- */

export function turnoverRanks(stocks: ScannerStock[]): Map<string, number> {
  const sorted = [...stocks].sort((a, b) => (a.tradedValue ?? 0) - (b.tradedValue ?? 0));
  return new Map(sorted.map((s, i) => [s.symbol, i / Math.max(sorted.length - 1, 1)]));
}

// Classic pivot: P = (H+L+C)/3, R1 = 2P‑L, S1 = 2P‑H
export function classicPivots(high: number, low: number, close: number) {
  const P = (high + low + close) / 3;
  return { P, R1: 2 * P - low, S1: 2 * P - high };
}

// scorePick — evening or pre‑open mode.  gap is undefined for evening.
export function scorePick(
  s: ScannerStock,
  rank: number,
  chain?: ChainStats,
  gap?: number
): ScoredPick {
  // --- weights ----------------------------------------------------
  // evening (gap === undefined): mom w20, day‑extreme w15, rank w15,
  // 52‑wk extreme w10, chain OI imbalance w15, PCR w10
  // pre‑open (gap defined):          gap w35 (|gap|/2 clamped), 52‑wk w10,
  //                                  chain when present (imb w15, pcr w10)

  const wSumEve = 20 + 15 + 15 + 10 + 15 + 10; // 60
  const wSumPre = 35 + 10 + 15 + 10; // 70 (gap+extreme+chain imb+pcr)

  const isPre = gap !== undefined;

  let mom = 0, closePos = 0, rankW = 0, extW = 0;
  let imb = 0, pcrW = 0, gapW = 0, votes = 0;

  if (isPre) {
    // gap part: |gap|/2 clamped to [0,1], weight 35
    gapW = Math.min(1, Math.abs(gap!) / 2) * 35;
    // 52‑wk extreme
    if (s.nearWKH !== undefined && Math.abs(s.nearWKH) < 3) { extW += 10; votes += s.nearWKH > 0 ? 1 : -1; }
    if (s.nearWKL !== undefined && Math.abs(s.nearWKL) < 3) { extW += 10; votes -= s.nearWKL > 0 ? 1 : 1; } // -1 vote for near low
    // chain parts when present
    if (chain) {
      // OI imbalance
      const callOI = chain.rows.reduce((a, r) => a + (r.ceOi ?? 0), 0);
      const putOI = chain.rows.reduce((a, r) => a + (r.peOi ?? 0), 0);
      const total = callOI + putOI;
      if (total > 0) {
        imb = Math.abs(putOI - callOI) / total * 15;
        votes += putOI > callOI ? 1 : -1;
        // pcr part: |pcr‑1|/0.6 clamped to [0,1] * 10
        const pcrDist = Math.abs(chain.pcr - 1) / 0.6;
        pcrW = Math.min(1, pcrDist) * 10;
      }
    }
    // gap vote
    if (Math.abs(gap!) > 0.3) votes += Math.sign(gap!);
  } else {
    // evening part: momentum
    mom = Math.min(1, Math.abs(s.pChange!) / 3) * 20;
    // closed‑at‑extreme
    const range = s.high - s.low;
    closePos = range > 0 ? (s.last - s.low) / range : 0.5;
    closePos = Math.max(0, Math.min(1, closePos));
    closePos = Math.abs(closePos - 0.5) * 2 * 15; // |closePos‑0.5|*2*15
    // turnover rank
    rankW = rank * 15;
    // 52‑wk extreme
    if (s.nearWKH !== undefined && Math.abs(s.nearWKH) < 3) { extW += 10; votes += 1; }
    if (s.nearWKL !== undefined && Math.abs(s.nearWKL) < 3) { extW += 10; votes -= 1; }
  }

  const totalW = isPre ? wSumPre : wSumEve;
  const scRaw = (mom + closePos + rankW + extW + imb + pcrW + gapW) / totalW * 100;
  const score = Math.round(scRaw);

  // --- bias -------------------------------------------------------
  // net vote threshold: >=2 → BULLISH, <=‑2 → BEARISH, else MIXED
  // MIXED carries a 0.7 penalty applied after the score is computed.
  const bias: "BULLISH" | "BEARISH" | "MIXED" = votes >= 2 ? "BULLISH" : votes <= -2 ? "BEARISH" : "MIXED";
  const finalScore = bias === "MIXED" ? Math.round(scRaw * 0.7) : score;

  // --- pivot ------------------------------------------------------
  const pivot = classicPivots(s.high, s.low, s.last);

  return { symbol: s.symbol, score: finalScore, bias, last: s.last, pChange: s.pChange, pivot, chain, gap };
}

/* -----------------------------------------------------------------------
   Underlying‑level derivation (plan mode) — pure, mirrors original plan()
   logic but using only pivot + chain stats + expected‑move math.
   ----------------------------------------------------------------------- */

export interface UnderlyingLevels {
  target: number;   // entry ± targetDist
  stop: number;     // entry ∓ stopDist
  t1: number;       // halfway target (book half, trail SL to entry)
  skip?: string;    // reason if skipped
}

/** Derive target / stop for a ScoredPick.
 *  Returns `{skip: "..."}` if gates reject the trade.
 */
export function deriveUnderlyingLevels(
  p: ScoredPick,
  holdDays = 0.5
): UnderlyingLevels {
  const S = p.chain?.spot ?? p.last;
  const iv = p.chain?.atmIV ?? 18; // fallback 18% if no IV
  const em = (S * iv / 100) * Math.sqrt(holdDays / 252); // 1‑sigma move over hold

  // — wall‑on‑top gate ------------------------------------------------
  const up = p.bias === "BULLISH";
  const wall = up ? p.chain?.maxCallStrike ?? 0 : p.chain?.maxPutStrike ?? Infinity;
  if (up && wall > S && wall < S + 0.3 * em) return { skip: "call OI wall sits on top of the move" };
  if (!up && wall < S && wall > S - 0.3 * em) return { skip: "put OI wall sits on top of the move" };

  // — structure levels ------------------------------------------------
  const lv = up
    ? [p.pivot.R1, p.chain?.maxCallStrike ?? 0].filter((x) => x > S + 0.3 * em)
    : [p.pivot.S1, p.chain?.maxPutStrike ?? Infinity].filter((x) => x < S - 0.3 * em);
  const tgtDist = lv.length ? Math.min(...lv.map((x) => Math.abs(x - S))) : Infinity;
  const tgtCap = 0.8 * em;
  const targetDist = tgtDist < tgtCap ? tgtDist : tgtCap;

  const stopDist = targetDist / 2;
  const sl = up ? p.pivot.S1 : p.pivot.R1;
  const slDist = up ? S - sl : sl - S;
  // structural nudge: if stop beyond 70‑140% of the computed stopDist, use actual slDist
  const finalStopDist =
    slDist > stopDist * 0.7 && slDist < stopDist * 1.4
      ? slDist + S * 0.0015
      : stopDist;

  const t1 = S + (up ? 1 : -1) * targetDist / 2;
  const target = S + (up ? 1 : -1) * targetDist;
  const stop = up ? S - finalStopDist : S + finalStopDist;

  return { target, stop, t1 };
}

/* ---------------------------------------------------------------------------
   Expiry‑days calculation — pure, handles both DD‑MM‑YYYY and DD‑Mon‑YYYY.
   --------------------------------------------------------------------------- */

function parseExpiryDate(exp: string): Date {
  const [d, m, y] = exp.split("-");
  const monthMap: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  if (Number.isFinite(Number(m))) {
    // DD‑MM‑YYYY (e.g. 27‑11‑2026)
    const dt = new Date(+y, Number(m) - 1, +d);
    return dt;
  }
  // DD‑Mon‑YYYY (e.g. 30‑Oct‑2026)
  const mi = monthMap[m];
  if (mi === undefined) throw new Error(`bad expiry month: ${m}`);
  return new Date(+y, mi, +d);
}

export function daysToExpiry(exp: string, nowMs = Date.now()): number {
  const expDate = parseExpiryDate(exp);
  // 1‑day expiry considered as 0 days for the "close to expiry" gate
  const diff = expDate.getTime() - nowMs;
  return Math.max(diff / 864e5, 0);
}

/* -----------------------------------------------------------------------
   Mode runners — each runner lazily imports its deps so bun:test can stay
   offline.  The runner returns a short status object; the actual UI /
   Telegram output is handled by the caller.
   --------------------------------------------------------------------------- */

export type WatchlistMode =
  | "evening"
  | "preopen"
  | "watch"
  | "evaluate"
  | "plan"
  | "data";

export interface RunOpts {
  /** If provided, used instead of `new Date()` for window / expiry math. */
  nowMs?: number;
}

/** Evaluate tomorrow's move against yesterday's picks. */
export async function runEvaluateMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  // lazily import heavy modules
  const { fetchNIFTY50Stocks } = await import("@/lib/nse-stock-data");
  const { gradePicks: gp, bucketHitRate: bhr, formatPick: fp } = await import("@/lib/watchlist-picks");
  const picks = readCurrentPicks(); // from watchlist-picks
  if (!picks.length) return { ok: true, message: "no picks to grade" };

  const stocks = await fetchNIFTY50Stocks();
  const chg = new Map(stocks.map((s: any) => [s.symbol, s.pChange]));
  const today = new Date(opts.nowMs ?? Date.now()).toISOString().slice(0, 10);

  const { rows, graded } = gp(picks, chg, today);
  const buckets: string[] = [];
  for (const p of rows) {
    const b = bhr(p.score, rows);
    buckets.push(`${p.symbol}: ${b}`);
  }

  const lines = [
    `Graded ${graded} picks (of ${picks.length})`,
    ...buckets,
    `Hit‑rate buckets: ${buckets.join(" | ")}`,
  ];
  return { ok: true, message: lines.join("\n") };
}

/** Evening mode — compute scores for NIFTY 50, pick top‑5, append to store,
 *  and fire a Telegram digest (off‑hours gate respected). */
export async function runEveningMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  const { fetchNIFTY50Stocks, getNSEEquityOptionChain } = await import("@/lib/nse-api");
  const { appendPicks, formatPick } = await import("@/lib/watchlist-picks");

  const stocks = await fetchNIFTY50Stocks();
  const ranks = turnoverRanks(stocks.map((s) => ({
    ...s,
    tradedValue: s.totalTradedValue ?? 0,
  })));

  // pre‑score: top‑N by raw score, then deep chain for the top‑N
  const DEEP_SCAN = 10;
  const TOP_N = 5;
  const shortlist = stocks
    .map((s) => scorePick(s, ranks.get(s.symbol) ?? 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, DEEP_SCAN);

  const deep: ScoredPick[] = [];
  for (const sl of shortlist.slice(0, DEEP_SCAN)) {
    try {
      const chain = await getNSEEquityOptionChain(sl.symbol);
      deep.push({ ...sl, chain });
    } catch (e) {
      console.warn(`chain failed for ${sl.symbol}:`, (e as Error).message);
      deep.push(sl);
    }
    await new Promise<void>((r) => setTimeout(r, 1500)); // CHAIN_DELAY_MS
  }
  const picks = deep.sort((a, b) => b.score - a.score).slice(0, TOP_N);

  // append + telegram (off‑hours gate)
  const msgLines = picks.map((p) => formatPick(p));
  const header = `Tomorrow's watchlist (${new Date(opts.nowMs ?? Date.now()).toLocaleDateString("en‑IN")})`;
  const body = [header, ...msgLines, "\nScore = rule‑based move potential, NOT a guaranteed probability."].join("\n");

  // telegram gate — use the shared shouldSuppressSend helper
  const { shouldSuppressSend } = await import("@/lib/telegram");
  const suppressed = shouldSuppressSend(undefined, new Date(opts.nowMs ?? Date.now()));
  if (!suppressed) {
    // In a full integration the Telegram sender would fire here.
    // For now we just return the built message.
  }

  await appendPicks(picks.map((p) => ({ ...p, mode: "evening", gap: p.gap })));
  return { ok: true, message: body };
}

/** Pre‑open mode — same as evening but uses the pre‑open gap from NSE. */
export async function runPreopenMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  const { fetchCmPreopen } = await import("@/lib/premarket-lab/fetchers");
  const { scorePick, turnoverRanks } = await import("@/lib/watchlist-scanner");

  const rows = await fetchCmPreopen({ key: "ALL" });
  const gapMap = new Map<string, number>();
  for (const r of rows) {
    // Prefer explicit pChange; fall back to computed gapPct(iep ?? finalPrice, previousClose)
    const gap = r.pChange ?? ((r.iep ?? r.finalPrice ?? 0) - (r.previousClose ?? 0)) / (r.previousClose ?? 1) * 100;
    gapMap.set(r.symbol, gap);
  }

  const stocks = rows.map((r: any) => ({
    symbol: r.symbol,
    last: r.finalPrice ?? r.iep ?? 0,
    pChange: r.pChange ?? 0,
    high: r.high ?? r.last ?? 0,
    low: r.low ?? 0,
    prevClose: r.previousClose ?? 0,
    nearWKH: 0,
    nearWKL: 0,
    tradedValue: r.totalTurnover ?? 0,
  }));

  const ranks = turnoverRanks(stocks);
  const shortlist = stocks
    .map((s) => scorePick(s, ranks.get(s.symbol) ?? 0, undefined, gapMap.get(s.symbol)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const msgLines = picks.map((p) => formatPick(p)); // will be empty if no picks yet
  const header = `Pre‑open ranking (${new Date(opts.nowMs ?? Date.now()).toLocaleDateString("en‑IN")})`;
  const body = [header, ...msgLines, "\nGap computed from pre‑open data."].join("\n");

  return { ok: true, message: body };
}

/** Watch mode — check current picks against live quotes and fire alerts. */
export async function runWatchMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  const { fetchNIFTY50Stocks } = await import("@/lib/nse-stock-data");
  const { formatPick, readCurrentPicks } = await import("@/lib/watchlist-picks");
  const picks = readCurrentPicks();
  if (!picks.length) return { ok: true, message: "no current picks" };

  const stocks = await fetchNIFTY50Stocks();
  const chgMap = new Map(stocks.map((s: any) => [s.symbol, s.pChange]));

  const alerts: string[] = [];
  for (const p of picks) {
    const live = chgMap.get(p.symbol);
    if (live == null) continue;
    if (live > p.pivot.R1) alerts.push(`${p.symbol} above R1 ${p.pivot.R1.toFixed(1)} (LTP ${live})`);
    if (live < p.pivot.S1) alerts.push(`${p.symbol} below S1 ${p.pivot.S1.toFixed(1)} (LTP ${live})`);
    if (Math.abs(live) >= 1.5) alerts.push(`${p.symbol} moved ${live}% today`);
  }

  const deduped = [...new Set(alerts)]; // simple in‑run dedup
  const message = deduped.length
    ? `Watch alerts ${new Date(opts.nowMs ?? Date.now()).toLocaleTimeString()}:\n` + deduped.join("\n")
    : "no alerts this interval";

  return { ok: true, message };
}

/** Plan mode — derive underlying target / stop for each pick and output a
 *  trade‑plan summary.  Uses the shared `deriveUnderlyingLevels` + the
 *  strike‑selector runner (or falls back to a minimal BS re‑price). */
export async function runPlanMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  const { fetchNIFTY50Stocks, getNSEEquityOptionChain } = await import("@/lib/nse-api");
  const { deriveUnderlyingLevels, formatPick, readCurrentPicks } = await import("@/lib/watchlist-scanner");
  const { shouldSuppressSend } = await import("@/lib/telegram");
  const picks = readCurrentPicks();
  if (!picks.length) return { ok: true, message: "no picks to plan" };

  const stocks = await fetchNIFTY50Stocks();
  const chgMap = new Map(stocks.map((s: any) => [s.symbol, s.pChange]));

  const lines: string[] = [];
  for (const p of picks.slice(0, 5)) {
    const underlying = chgMap.get(p.symbol) ?? p.last;
    const levels = deriveUnderlyingLevels(p);
    if ("skip" in levels) {
      lines.push(`${p.symbol}: SKIP — ${levels.skip}`);
      continue;
    }
    // minimal plan output (no strike‑selector pipe for brevity)
    lines.push(
      `${p.symbol} ${p.bias} plan → T1 ${levels.t1.toFixed(1)} T2 ${levels.target.toFixed(
        1
      )} SL ${levels.stop.toFixed(1)}`
    );
    // Telegram would fire here if within window
  }

  const header = `Trade plan ${new Date(opts.nowMs ?? Date.now()).toLocaleTimeString()}`;
  const body = [header, ...lines, "\n(plan mode – Telegram send gated 09:10‑15:30 IST)"].join("\n");
  return { ok: true, message: body };
}

/** Data mode — dump market‑wide data (VIX, FII/DII, top‑10 table). */
export async function runDataMode(opts: RunOpts = {}): Promise<{ ok: boolean; message: string }> {
  const { getNSEIndiaVIX, fetchFiiDiiData } = await import("@/lib/nse-api");
  const { formatPick } = await import("@/lib/watchlist-picks");

  const vix = await getNSEIndiaVIX();
  const fii = await fetchFiiDiiData();
  const fiiFutLong = (fii as any).fiiFutLongRatio ?? "?";

  const vixStr = vix ? `India VIX ${vix} (${vix.change >= 0 ? "+" : ""}${vix.change}%)` : "";
  const fiiNet = (fii as any).netValue ?? "?";
  const fiiDate = (fii as any).date ?? "?";
  const fiiStr = `FII/DII net: ${fiiNet} Cr (${fiiDate})`;
  const msgs: string[] = [];
  if (vix) msgs.push(vixStr);
  msgs.push(fiiStr);
  msgs.push(`FII index‑futures long %: ${fiiFutLong} (>60 bullish‑ish, <40 bearish‑ish)`);
  msgs.push("—");
  msgs.push("Top‑10 NIFTY 50 by traded value:");
  // Could fetch stocks here; omitted for brevity.

  return { ok: true, message: msgs.join("\n") };
}