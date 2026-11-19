// Phase 8B — EMA 9/21/50 shadow observation report.
//
// Reads CandidateLog shadow rows (intraday-scanner:shadow / weekly-scanner:shadow),
// dedupes per (symbol, source, IST date), counts clean trading sessions, and
// emits the observation aggregates required by Phase 8B.
//
// Run:  bun run scripts/ema-shadow-report.ts          (prints summary)
//       bun run scripts/ema-shadow-report.ts --emit    (also writes data/ema-shadow-report-<date>.json)
//
// Purely observational: no live strategy change, no new veto, no scoring change.

import { PrismaClient } from "@prisma/client";
import { isTradingDay } from "@/lib/marketHours";

const prisma = new PrismaClient();

const SHADOW_SOURCES = ["intraday-scanner:shadow", "weekly-scanner:shadow"] as const;
const LOOKBACK_DAYS = 30;
const CLEAN_SESSION_TARGET = 5;

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function istDateString(epochMs: number): string {
  return new Date(epochMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidObservation(r: any): boolean {
  // Valid confirmation requires non-stale, complete, market-hours EMA data.
  return !!r.emaAlignment &&
    (r.emaDataQuality === "LIVE" || r.emaDataQuality === "FRESH") &&
    !r.emaIsStale &&
    r.isMarketOpen;
}

function bucket(rows: any[], key: (r: any) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? "null";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function main() {
  const emit = process.argv.includes("--emit");
  const from = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  const rows = await prisma.candidateLog.findMany({
    where: {
      observationSource: { in: SHADOW_SOURCES },
      ts: { gte: new Date(from) },
    },
    orderBy: { ts: "asc" },
  });

  // Dedup per (symbol, source, IST date) — keep latest observation per group.
  const byKey = new Map<string, any>();
  for (const r of rows) {
    const k = `${r.symbol}|${r.observationSource}|${istDateString(r.ts.getTime())}`;
    const prev = byKey.get(k);
    if (!prev || r.ts.getTime() > prev.ts.getTime()) byKey.set(k, r);
  }
  const deduped = Array.from(byKey.values());

  // Clean trading sessions: NSE trading day with ≥1 valid EMA observation.
  const validRows = deduped.filter(isValidObservation);
  const cleanDates = new Set<string>();
  for (const r of validRows) {
    if (isTradingDay(new Date(r.ts.getTime()))) cleanDates.add(istDateString(r.ts.getTime()));
  }
  const cleanSessions = cleanDates.size;
  const ready = cleanSessions >= CLEAN_SESSION_TARGET;

  const bySource = bucket(deduped, (r) => r.observationSource);
  const alignment = bucket(deduped, (r) => r.emaAlignment);
  const instrumentType = bucket(deduped, (r) => r.instrumentType);
  const optionType = bucket(deduped, (r) => r.optionType);
  const expiryType = bucket(deduped, (r) => r.expiryType);
  const existingDir = bucket(deduped, (r) => r.existingSignalDirection);
  const outcome = bucket(deduped, (r) => r.outcome);
  const setupType = bucket(deduped, (r) => r.emaSetupType);

  // CE / PE research suggestions (outcome = BUY_RESEARCH).
  const cePeResearch = bucket(
    deduped.filter((r) => r.outcome === "BUY_RESEARCH"),
    (r) => r.optionType,
  );

  // Directional conflicts: existing engine direction vs shadow EMA alignment / verdict.
  const conflicts: any[] = [];
  let agree = 0, disagree = 0, neutral = 0;
  for (const r of deduped) {
    const ex = (r.existingSignalDirection || "").toUpperCase();
    const align = (r.emaAlignment || "").toUpperCase();
    const verdict = (r.emaDirectionalVerdict || "").toUpperCase();
    const isConflict = verdict === "CONFLICT" ||
      ((ex === "BULLISH" && align === "BEARISH") || (ex === "BEARISH" && align === "BULLISH"));
    if (isConflict) conflicts.push(r);
    if (r.existingSignalDirection === "NEUTRAL") neutral++;
    else if (isConflict) disagree++;
    else agree++;
  }

  const fakeoutReversalSetups: Record<string, number> = {};
  for (const k of Object.keys(setupType)) {
    const u = k.toUpperCase();
    if (u === "FAILED_BREAKOUT" || u === "TREND_REVERSAL" || u === "GAP_FAILURE" || u === "LIQUIDITY_SWEEP_RECLAIM") {
      fakeoutReversalSetups[k] = setupType[k];
    }
  }

  const staleRows = deduped.filter((r) => r.emaIsStale || r.emaDataQuality === "STALE" || r.emaDataQuality === "INSUFFICIENT");
  const missingRows = deduped.filter((r) => !r.emaAlignment);
  const marketClosedRows = deduped.filter((r) => !r.isMarketOpen);

  const sessions: any[] = [];
  for (const d of Array.from(cleanDates).sort()) {
    const dayRows = deduped.filter((r) => istDateString(r.ts.getTime()) === d);
    sessions.push({
      date: d,
      setups: dayRows.length,
      validEma: dayRows.filter(isValidObservation).length,
      buyResearch: dayRows.filter((r) => r.outcome === "BUY_RESEARCH").length,
      conflicts: dayRows.filter((r) => (r.emaDirectionalVerdict || "").toUpperCase() === "CONFLICT").length,
    });
  }

  const recommendations: string[] = [];
  if (!ready) {
    recommendations.push(`Only ${cleanSessions}/${CLEAN_SESSION_TARGET} clean sessions observed — continue shadow collection; do not activate live yet.`);
  } else {
    recommendations.push(`${cleanSessions} clean sessions observed — sufficient for B0/B1/B2 validation comparison.`);
  }
  if (missingRows.length > deduped.length * 0.5) {
    recommendations.push(`>50% of evaluated setups lack EMA data (<35 bars or shadow skipped) — check candle availability before drawing conclusions.`);
  }
  if (disagree > agree) {
    recommendations.push(`Shadow EMA disagrees with the existing engine on ${disagree} setups vs ${agree} agreements — review directional-consistency layer before any live promotion.`);
  }
  if (fakeoutReversalSetups && Object.values(fakeoutReversalSetups).reduce((a, b) => a + b, 0) > 0) {
    recommendations.push(`Fakeout/reversal setups recorded (${Object.values(fakeoutReversalSetups).reduce((a, b) => a + b, 0)}) — validate these against real outcomes before scoring-weight changes.`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    cleanSessions: { count: cleanSessions, target: CLEAN_SESSION_TARGET, dates: Array.from(cleanDates).sort(), readyForFullReport: ready },
    evaluatedSetups: deduped.length,
    bySource,
    alignmentDistribution: alignment,
    instrumentType,
    optionType,
    expiryType,
    existingSignalDirection: existingDir,
    outcome,
    cePeResearchSuggestions: cePeResearch,
    directionalConflicts: { count: conflicts.length, agree, disagree, neutral },
    fakeoutReversalSetups,
    existingVsShadowAgreement: { agree, disagree, neutral },
    dataCoverage: {
      total: deduped.length,
      validEma: validRows.length,
      staleOrInsufficient: staleRows.length,
      missingEma: missingRows.length,
      marketClosed: marketClosedRows.length,
    },
    sessions,
    recommendations,
  };

  const summary = [
    `EMA shadow report — ${deduped.length} evaluated setups across ${cleanSessions}/${CLEAN_SESSION_TARGET} clean sessions`,
    `Alignment: ${JSON.stringify(alignment)}`,
    `Outcome: ${JSON.stringify(outcome)} | CE/PE research: ${JSON.stringify(cePeResearch)}`,
    `Conflicts: ${conflicts.length} (agree ${agree} / disagree ${disagree} / neutral ${neutral})`,
    `Coverage: valid ${validRows.length} / stale ${staleRows.length} / missing ${missingRows.length} / closed ${marketClosedRows.length}`,
    `Ready for B0/B1/B2: ${ready}`,
  ].join("\n");

  console.log(summary);

  if (emit) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `ema-shadow-report-${istDateString(Date.now())}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`Wrote ${file}`);
  }

  await prisma.$disconnect();
  return report;
}

main().catch((err) => {
  console.error("[ema-shadow-report] failed:", err);
  process.exit(1);
});
