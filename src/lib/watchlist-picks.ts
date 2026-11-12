/// <reference types="bun-types" />
// watchlist-picks.ts — append‑only JSONL store + grading + hit‑rate buckets.
// Pure (no network, no secrets). All I/O accepts an optional path; defaults
// resolve to `data/watchlist-picks.jsonl` and `data/watchlist-current.json`.
// The JSONL file is never overwritten — rows are appended. A companion JSON
// file holds the latest batch for "current" reads (mirroring the original
// picks.json behaviour).
//
// Grading maps a pick's next‑day % move and direction to a hit/miss flag.
// Hit‑rate buckets are the calibration analogue of `candidate-log`'s
// `calibrationBandFor` / `currentReliability` but scoped to watchlist picks
// only (the candidate_log resolver would pollute veto stats).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PICKS_DIR = path.join(os.tmpdir(), "wl-picks-data");
fs.mkdirSync(PICKS_DIR, { recursive: true });

const PICKS_FILE = (p: string | undefined) =>
  p ?? path.join(PICKS_DIR, "watchlist-picks.jsonl");
const CURRENT_FILE = (p: string | undefined) =>
  p ?? path.join(PICKS_DIR, "watchlist-current.json");

// ---------------------------------------------------------------------------
// Row shape — mirrors the original `predictions.csv` line minus the nextPct/hit
// columns (those are added during grading).
// ---------------------------------------------------------------------------

export interface WatchPickRow {
  predDate: string;        // ISO YYYY-MM-DD
  mode: string;            // "evening"|"preopen"|"watch"|"evaluate"|"plan"|"data"
  symbol: string;
  score: number;           // 0‑100 move‑potential
  bias: "BULLISH" | "BEARISH" | "MIXED";
  price: number;           // underlying last / strike entry
  pivot: { P: number; R1: number; S1: number };
  gap?: number | null;     // pre‑open gap % (null for evening)
  nextPct?: number | null; // next‑day % change (filled during evaluate)
  hit?: 0 | 1 | null;      // 1 = big move in predicted direction, 0 = otherwise
}

// ---------------------------------------------------------------------------
// Appending rows — never overwrites existing rows.
// ---------------------------------------------------------------------------

/** Append one or more rows to the JSONL picks file (and update current-set). */
export function appendPicks(
  rows: WatchPickRow[],
  picksPath?: string,
  currentPath?: string
): void {
  const file = PICKS_FILE(picksPath);
  const cur = CURRENT_FILE(currentPath);

  // Ensure the directory exists
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Append each row as a single‑line JSON object
  for (const row of rows) {
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  }

  // Rewrite the current‑set file with the latest batch (overwrites)
  if (rows.length > 0) {
    fs.writeFileSync(cur, JSON.stringify(rows));
  }
}

/** Read ALL rows from the JSONL picks file. */
export function readPicks(picksPath?: string): WatchPickRow[] {
  const file = PICKS_FILE(picksPath);
  if (!fs.existsSync(file)) return [];
  const contents = fs.readFileSync(file, "utf8").trim();
  if (!contents) return [];
  return contents
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as WatchPickRow);
}

/** Read the "current" set (the latest batch written by appendPicks). */
export function readCurrentPicks(currentPath?: string): WatchPickRow[] {
  const file = CURRENT_FILE(currentPath);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as WatchPickRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Grading (evaluate mode): given today's pChange map, mark ungraded picks
// and compute hit / nextPct.  Only rows with `hit === null && predDate < today`
// are considered.
// ---------------------------------------------------------------------------

/** Big‑move threshold — 2% (same as the original BIG_MOVE_PCT). */
const BIG_MOVE_PCT = 2;

/** Grade picks synchronously against live pChange.
 *  Returns `{ rows: WatchPickRow[], graded: number }` where `graded` is the
 *  count of newly‑graded rows.  Ungraded rows (already hit, future, missing
 *  symbol) are left untouched. */
export function gradePicks(
  picks: WatchPickRow[],
  chgBySymbol: Map<string, number>,
  today: string
): { rows: WatchPickRow[]; graded: number } {
  const out: WatchPickRow[] = [];
  let graded = 0;

  for (const p of picks) {
    // already graded / future / no live quote → pass through unchanged
    if (p.hit !== null || p.predDate >= today || !chgBySymbol.has(p.symbol)) {
      out.push(p);
      continue;
    }

    const mv = chgBySymbol.get(p.symbol)!; // next‑day % change
    const big = Math.abs(mv) >= BIG_MOVE_PCT;
    const dirOK =
      p.bias === "MIXED" || (p.bias === "BULLISH" ? mv > 0 : mv < 0);
    const hit = big && dirOK ? 1 : 0;

    out.push({
      ...p,
      nextPct: Number(mv.toFixed(2)),
      hit,
    });
    graded++;
  }

  return { rows: out, graded };
}

/** Bucket‑hit‑rate: given a score and the full graded‑picks array, compute the
 *  realised hit percentage for that score‑bucket.
 *
 *  Format matches the original `hitRate()` helper:
 *    •  >= 10 samples → "`X% hit over Y past picks`"
 *    •  < 10 samples  → "`uncalibrated (N/M samples)`"
 */
export function bucketHitRate(score: number, rows: WatchPickRow[]): string {
  const bucket = Math.floor(score / 20); // 0→0‑19, 1→20‑39, 2→40‑59, 3→60‑79, 4→80‑100
  const bucketRows = rows.filter((r) => Math.floor(r.score / 20) === bucket && r.hit !== null);
  const n = bucketRows.length;
  if (n < 10) return `uncalibrated (${n}/10 samples)`;
  const hits = bucketRows.filter((r) => r.hit === 1).length;
  const pct = Math.round((hits / n) * 100);
  return `${pct}% hit over ${n} past picks`;
}

// ---------------------------------------------------------------------------
// Helpers used by the scanner UI (formatPickLine omitted for brevity)
// ---------------------------------------------------------------------------

/** Return a single‑line description of a pick — useful for logging or display. */
export function formatPick(p: WatchPickRow): string {
  const gap = p.gap !== null ? ` gap ${p.gap >= 0 ? "+" : ""}${p.gap.toFixed(2)}%` : "";
  return `${p.symbol} ${p.bias} score ${p.score}/100${gap} pivot ${p.pivot.P.toFixed(
    1
  )} R1 ${p.pivot.R1.toFixed(1)} S1 ${p.pivot.S1.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Directory initialisation (called once at module load)
// ---------------------------------------------------------------------------

fs.mkdirSync(PICKS_DIR, { recursive: true });