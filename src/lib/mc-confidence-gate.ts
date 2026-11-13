/**
 * Monte-Carlo confidence gate — pure logic (no fs, no network, client-safe).
 *
 * Offline measurement (2026-11-13, 478 engine signals on real Breeze 5m):
 *   base accuracy 39.1% → MC gap (pTarget−pStop) ≥ 0.05 → 62.1% (n=29)
 *   gap ≥ 0.10 → 66.7% (n=12); gap ≥ 0.12 → 80% (n=10)
 * All passes were LONG; SHORT never cleared gap ≥ 0.05.
 *
 * Method (same as scripts/history-replay-gate.ts):
 *   - Prior-session 5m bar-ratio pool, bucketed by time-of-day slot (±2).
 *   - From entry: 1% risk stop, 2R target (conservative stop-before-target).
 *   - Deterministic mulberry32(seed=19), 2000 replays.
 *
 * Breeze fetch + candidate annotation live in mc-confidence-gate.server.ts
 * (server-only — must never be imported from client components).
 */

export interface McResult {
  pTarget: number;
  pStop: number;
  pNeither: number;
  avgR: number;
  /** pTarget − pStop. Measured pass threshold: ≥ 0.05. */
  gap: number;
  n: number;
  available: boolean;
}

export const MC_CONFIG = {
  replays: 2000,
  seed: 19,
  riskPct: 0.01,
  rewardMultiple: 2,
  /** Offline lift: 39.1% → 62.1% at this gap (n=29). */
  gapPass: 0.05,
  slotWindow: 2,
  minNonEmptySlots: 20,
  lookbackDays: 50,
  /** Only annotate the top-N directional candidates (Breeze budget). */
  maxCandidates: 12,
  /** Wall-clock budget for the whole annotate pass. */
  budgetMs: 8000,
} as const;

export type McDir = "LONG" | "SHORT";

export interface McBar {
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Deterministic mulberry32 — same seed → same path (reproducible offline). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Decision clock in IST minutes-from-midnight (scanner decisions are IST). */
export function istDecisionMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Clamp a wall-clock decision minute into the cash session so MC has a valid
 * entry slot. Pre-open → 09:20; after 15:25 → 15:20 (last safe 5m slot).
 * Without this, after-hours runs compute decisionMin past SESSION_SLOTS and
 * every candidate fails open (mcPass=null).
 */
export function clampToSession(min: number): number {
  const OPEN = 9 * 60 + 20; // 09:20
  const CLOSE = 15 * 60 + 20; // 15:20
  if (!Number.isFinite(min) || min < OPEN) return OPEN;
  if (min > CLOSE) return CLOSE;
  return min;
}

/** YYYY-MM-DD in IST (no toISOString UTC day-shift). */
export function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function slotOfTime(time: string): number {
  const hh = Number(time.slice(11, 13));
  const mm = Number(time.slice(14, 16));
  return Math.floor((hh * 60 + mm - (9 * 60 + 15)) / 5);
}

/**
 * Bar-ratio pool MC from prior sessions. `bars` must cover multiple prior
 * trading days (5m). `priorDates` = dates strictly before the signal day.
 * Returns available=false when the pool is too thin.
 */
export function monteCarloBracket(
  bars: McBar[],
  priorDates: string[],
  entry: number,
  dir: McDir,
  decisionMin: number,
  cfg: {
    replays: number;
    seed: number;
    riskPct: number;
    rewardMultiple: number;
    slotWindow: number;
    minNonEmptySlots: number;
  } = MC_CONFIG,
): McResult {
  const empty: McResult = {
    pTarget: 0, pStop: 0, pNeither: 0, avgR: 0, gap: 0, n: 0, available: false,
  };
  if (!bars.length || !priorDates.length || !(entry > 0) || decisionMin < 0) return empty;

  const SESSION_SLOTS = Math.ceil((15 * 60 + 30 - (9 * 60 + 15)) / 5);
  const pool: Array<Array<[number, number, number, number]>> = Array.from(
    { length: SESSION_SLOTS },
    () => [],
  );

  const priorSet = new Set(priorDates);
  const byDate = new Map<string, McBar[]>();
  for (const b of bars) {
    if (!priorSet.has(b.date)) continue;
    const list = byDate.get(b.date);
    if (list) list.push(b);
    else byDate.set(b.date, [b]);
  }

  for (const day of byDate.values()) {
    day.sort((a, b) => a.time.localeCompare(b.time));
    for (let i = 1; i < day.length; i++) {
      const prev = day[i - 1];
      const cur = day[i];
      if (!prev.close) continue;
      const s = slotOfTime(cur.time);
      if (s < 0 || s >= SESSION_SLOTS) continue;
      pool[s].push([
        cur.open / prev.close,
        cur.high / prev.close,
        cur.low / prev.close,
        cur.close / prev.close,
      ]);
    }
  }

  const nonEmpty = pool.filter((p) => p.length > 0).length;
  if (nonEmpty < cfg.minNonEmptySlots) return empty;

  const risk = entry * cfg.riskPct;
  const stop = dir === "LONG" ? entry - risk : entry + risk;
  const target = dir === "LONG"
    ? entry + cfg.rewardMultiple * risk
    : entry - cfg.rewardMultiple * risk;
  const entrySlot = Math.floor((decisionMin - (9 * 60 + 15)) / 5);
  const lastSlot = SESSION_SLOTS - 1;
  if (entrySlot < 0 || entrySlot >= lastSlot) return empty;

  const rand = mulberry32(cfg.seed);
  let hitT = 0;
  let hitS = 0;
  let neither = 0;
  let rSum = 0;
  const window = cfg.slotWindow;

  for (let n = 0; n < cfg.replays; n++) {
    let p = entry;
    let outcome: "T" | "S" | null = null;
    for (let s = entrySlot + 1; s <= lastSlot; s++) {
      let j = s + Math.floor(rand() * (2 * window + 1)) - window;
      j = Math.max(0, Math.min(SESSION_SLOTS - 1, j));
      const bucket = pool[j];
      if (!bucket.length) continue;
      const bar = bucket[Math.floor(rand() * bucket.length)];
      const hi = p * bar[1];
      const lo = p * bar[2];
      const cl = p * bar[3];
      if (outcome === null) {
        if (dir === "LONG") {
          if (lo <= stop) outcome = "S";
          else if (hi >= target) outcome = "T";
        } else {
          if (hi >= stop) outcome = "S";
          else if (lo <= target) outcome = "T";
        }
      }
      p = cl;
    }
    if (outcome === "T") {
      hitT++;
      rSum += cfg.rewardMultiple;
    } else if (outcome === "S") {
      hitS++;
      rSum += -1;
    } else {
      neither++;
      rSum += dir === "LONG" ? (p - entry) / risk : (entry - p) / risk;
    }
  }

  const pTarget = hitT / cfg.replays;
  const pStop = hitS / cfg.replays;
  return {
    pTarget,
    pStop,
    pNeither: neither / cfg.replays,
    avgR: rSum / cfg.replays,
    gap: pTarget - pStop,
    n: cfg.replays,
    available: true,
  };
}

/** True only when the gate was computed AND failed. Null/undefined = fail-open. */
export function mcBlocksAlert(mcPass: boolean | null | undefined): boolean {
  return mcPass === false;
}

/** Dates strictly before `today`, sorted ascending. */
export function priorDatesFrom(bars: McBar[], today: string): string[] {
  const dates = [...new Set(bars.map((b) => b.date))].sort();
  return dates.filter((d) => d < today);
}
