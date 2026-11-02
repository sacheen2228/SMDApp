// Data-quality scoring, duplicate detection, outlier flags.
// Never fabricates values — only scores what is present.

import type { DataQuality, QualityReport, SourceId } from "./types";

export const STALE_MS = 24 * 60 * 60 * 1000; // pre-open snapshot older than 1 trading day → STALE
export const PREOPEN_STALE_MS = 6 * 60 * 60 * 1000; // same-session pre-open older than 6h → STALE intraday

export function classifyAge(ageMs: number, nowInSession: boolean): DataQuality {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "MISSING";
  const limit = nowInSession ? PREOPEN_STALE_MS : STALE_MS;
  if (ageMs > limit) return "STALE";
  if (ageMs > limit / 2) return "DEGRADED";
  return "OK";
}

export function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Relative z-score style outlier flag vs a rolling reference (mean/std). */
export function isOutlier(value: number, mean: number, std: number, z = 4): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return false;
  return Math.abs((value - mean) / std) > z;
}

/** Detect duplicate keys in snapshot rows. */
export function findDuplicates<T>(rows: T[], keyFn: (r: T) => string): string[] {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const r of rows) {
    const k = keyFn(r);
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  }
  return dups;
}

export interface SourceInput {
  present: boolean;
  ageMs?: number | null;
  nowInSession?: boolean;
  reason?: string;
}

export function buildQualityReport(
  sources: Partial<Record<SourceId, SourceInput>>,
  required: SourceId[] = ["NSE_CM_PREOPEN"],
): QualityReport {
  const perSource: QualityReport["perSource"] = {};
  let sum = 0;
  let n = 0;
  let allMissingRequired = true;

  for (const [id, inp] of Object.entries(sources) as [SourceId, SourceInput][]) {
    let quality: DataQuality;
    let reason = inp.reason;
    if (!inp.present) {
      quality = "MISSING";
      reason = reason || "not present";
    } else {
      const age = inp.ageMs ?? 0;
      quality = classifyAge(age, !!inp.nowInSession);
      if (quality !== "OK") reason = reason || `age ${Math.round(age / 1000)}s`;
    }
    perSource[id] = { quality, reason, ageMs: inp.ageMs ?? undefined };
    const pts = quality === "OK" ? 100 : quality === "DEGRADED" ? 60 : quality === "STALE" ? 25 : 0;
    sum += pts;
    n++;
  }

  for (const req of required) {
    if (perSource[req]?.quality === "OK" || perSource[req]?.quality === "DEGRADED") {
      allMissingRequired = false;
    }
  }

  const score = n === 0 ? 0 : Math.round(sum / n);
  let overall: DataQuality;
  if (allMissingRequired || score === 0) overall = "MISSING";
  else if (score >= 85) overall = "OK";
  else if (score >= 50) overall = "DEGRADED";
  else overall = "STALE";

  return { overall, perSource, score };
}

/** Fail-closed gate: research outputs blocked when critical sources missing/stale. */
export function canProduceResearchScore(report: QualityReport, required: SourceId[] = ["NSE_CM_PREOPEN"]): boolean {
  for (const req of required) {
    const q = report.perSource[req]?.quality;
    if (q !== "OK" && q !== "DEGRADED") return false;
  }
  return report.score >= 40;
}
