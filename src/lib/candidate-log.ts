// candidate-log.ts
// Every trade candidate produced by ANY brain/scanner path is written here — sent,
// blocked, or paper — so the veto can be measured OUT-OF-SAMPLE instead of guessed.
//
// The writer is fire-and-forget: a logging failure must never break an alert.
// No network calls, no candle fetches, no secrets logged.
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";
import { GATE_CONFIG } from "./agent-brain-gate";
import { BRAIN_FLAGS } from "./brain-flags";
import { tierFromWarnings } from "./signal-veto";
import { reliabilityTable, bandCalibration, type ReliabilityBand } from "./confidence-calibration";

export { tierFromWarnings };

let prisma: PrismaClient | null = null;
function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

export type GateVerdict = "PASS" | "WARN" | "BLOCK" | "NONE";
/** The deterministic gate speaks in TRADE / WAIT / SKIP; the veto in PASS / WARN / BLOCK. */
export type GateVerdictLike = GateVerdict | "TRADE" | "WAIT" | "SKIP";
export type Tier = "A" | "B" | "C" | "NONE";

export interface CandidateInput {
  source: string;                 // brain + scanner name, e.g. "SMART_MONEY:terminal"
  symbol: string;
  direction: string;              // call | put | buy | sell
  strike?: number | null;
  expiry?: string | null;
  underlyingSpot?: number | null; // underlying level — NEVER the option premium
  entryPremium?: number | null;
  stopPremium?: number | null;
  targetPremium?: number | null;
  underlyingStop?: number | null;
  underlyingTarget?: number | null;
  confidence?: number | null;
  calibratedConfidence?: number | null;
  rr?: number | null;
  delta?: number | null;
  regime?: string | null;
  sessionWindow?: string | null;
  layerStates?: Record<string, string> | null;
  gateVerdict?: GateVerdictLike | null;
  tier?: Tier | null;
  warnings?: string[] | null;
  fails?: string[] | null;
  sent?: boolean;
  wouldBlock?: boolean;
}

/** Hash of the effective configuration — lets the replay prove which rules produced a row. */
export function configHash(): string {
  const payload = JSON.stringify({ gate: GATE_CONFIG, flags: BRAIN_FLAGS });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Tier from the gate/veto outcome:
 *   A = zero warnings → full size
 *   B = exactly 1 warning → 0.5x
 *   C = ≥2 warnings → paper/shadow only
 *   NONE = any hard fail
 * (implemented in signal-veto.ts, re-exported here for convenience)
 */

/** Fire-and-forget candidate write. Never throws. */
export async function logCandidate(c: CandidateInput): Promise<void> {
  if (!BRAIN_FLAGS.candidateLog) return;
  try {
    await db().candidateLog.create({
      data: {
        source: String(c.source || "unknown").slice(0, 120),
        symbol: String(c.symbol || "?").toUpperCase().slice(0, 40),
        direction: String(c.direction || "?").slice(0, 20),
        strike: c.strike ?? null,
        expiry: c.expiry ?? null,
        underlyingSpot: c.underlyingSpot ?? null,
        entryPremium: c.entryPremium ?? null,
        stopPremium: c.stopPremium ?? null,
        targetPremium: c.targetPremium ?? null,
        underlyingStop: c.underlyingStop ?? null,
        underlyingTarget: c.underlyingTarget ?? null,
        confidence: c.confidence ?? null,
        calibratedConfidence: c.calibratedConfidence ?? null,
        rr: c.rr ?? null,
        delta: c.delta ?? null,
        regime: c.regime ?? null,
        sessionWindow: c.sessionWindow ?? null,
        layerStates: c.layerStates ? JSON.stringify(c.layerStates) : null,
        gateVerdict: c.gateVerdict ?? null,
        tier: c.tier ?? null,
        warnings: c.warnings ? JSON.stringify(c.warnings) : null,
        fails: c.fails ? JSON.stringify(c.fails) : null,
        sent: !!c.sent,
        wouldBlock: !!c.wouldBlock,
        configHash: configHash(),
      },
    });
  } catch (err) {
    // Never let logging break a trade path. No payload (may contain sensitive data) is logged.
    console.warn(`[candidate-log] write failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

/** Rows that still need an outcome simulation. */
export async function pendingCandidates(limit = 200): Promise<{
  id: string; ts: Date; symbol: string; direction: string; strike: number | null; expiry: string | null;
  entryPremium: number | null; stopPremium: number | null; targetPremium: number | null;
  underlyingSpot: number | null; source: string;
}[]> {
  const rows = await db().candidateLog.findMany({
    where: { simOutcomeR: null },
    orderBy: { ts: "asc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id, ts: r.ts, symbol: r.symbol, direction: r.direction, strike: r.strike, expiry: r.expiry,
    entryPremium: r.entryPremium, stopPremium: r.stopPremium, targetPremium: r.targetPremium,
    underlyingSpot: r.underlyingSpot, source: r.source,
  }));
}

export async function writeResolution(id: string, outcomeR: number, resolvedTs: Date): Promise<void> {
  try {
    await db().candidateLog.update({ where: { id }, data: { simOutcomeR: outcomeR, simResolvedTs: resolvedTs } });
  } catch (err) {
    console.warn(`[candidate-log] resolve failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

// ─── Calibration cache ───────────────────────────────────────────────
// The veto must stay DB-free, so the reliability table is cached in-process and
// refreshed on a TTL. A stale/absent table simply means the default haircut applies.
const CAL_TTL_MS = 15 * 60_000;
let calCache: { at: number; table: ReliabilityBand[] } | null = null;

/** Realised win-rate of the stated-confidence band, from resolved candidates. */
export async function calibrationBandFor(stated: number): Promise<{ realizedHitPct?: number; n?: number }> {
  const now = Date.now();
  if (!calCache || now - calCache.at > CAL_TTL_MS) {
    try {
      const rows = await db().candidateLog.findMany({
        where: { simOutcomeR: { not: null } },
        select: { confidence: true, simOutcomeR: true },
        take: 5000,
        orderBy: { ts: "desc" },
      });
      const samples = rows.map((r) => ({
        stated: r.confidence ?? 0,
        won: (r.simOutcomeR ?? 0) > 0,
        r: r.simOutcomeR,
      }));
      calCache = { at: now, table: reliabilityTable(samples) };
    } catch {
      calCache = { at: now, table: [] };
    }
  }
  return bandCalibration(calCache.table, stated);
}

/** Current reliability table (for reports). */
export async function currentReliability(): Promise<ReliabilityBand[]> {
  await calibrationBandFor(50); // forces a refresh
  return calCache?.table ?? [];
}
