// scripts/brain-report.ts
// Daily report for the trading brain: per tier and per source — n, WR with CI,
// expectancy R, would-block precision/recall, and calibration drift vs the last 30 days.
//
// Usage: bun scripts/brain-report.ts [--days 30]
import { PrismaClient } from "@prisma/client";
import { wilson } from "../src/lib/agent-brain-gate";
import { reliabilityTable, calibrationDrift, type CalibrationSample } from "../src/lib/confidence-calibration";
import { tierFromWarnings } from "../src/lib/signal-veto";
import { cacheStats } from "../src/lib/tech-cache";

const LEDGER = process.env.AUDIT_URL || "http://localhost:4001";
const DAYS = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;

interface Cand {
  ts: Date; source: string; tier: string | null; verdict: string | null;
  sent: boolean; wouldBlock: boolean; r: number | null;
  stated: number | null; calibrated: number | null; warnings: string | null; fails: string | null;
}

function stats(rows: { won: boolean; r: number | null }[]) {
  const n = rows.length;
  if (!n) return { n: 0, wr: 0, lo: 0, hi: 0, expR: null, ci: null };
  const wins = rows.filter((r) => r.won).length;
  const ci = wilson(wins, n);
  const rs = rows.map((r) => r.r).filter((x): x is number => x != null);
  return { n, wr: wins / n, lo: ci.lo, hi: ci.hi, expR: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : null };
}

async function main() {
  const p = new PrismaClient();
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const raw = await p.candidateLog.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "asc" }, take: 20000 });
  const rows: Cand[] = raw.map((r) => ({
    ts: r.ts, source: r.source, tier: r.tier, verdict: r.gateVerdict,
    sent: r.sent, wouldBlock: r.wouldBlock, r: r.simOutcomeR,
    stated: r.confidence, calibrated: r.calibratedConfidence,
    warnings: r.warnings, fails: r.fails,
  }));
  await p.$disconnect();

  console.log(`══════════ BRAIN REPORT — last ${DAYS} days ══════════`);
  console.log(`candidates logged: ${rows.length} | resolved: ${rows.filter((r) => r.r != null).length}`);
  console.log(`tech cache: ${JSON.stringify(cacheStats())}`);

  // per tier
  const tiers = ["A", "B", "C", "NONE"];
  console.log("\nPER TIER");
  console.log("  tier      n   sent   blocked    WR%   [95% CI]        expR");
  for (const t of tiers) {
    const list = rows.filter((r) => (r.tier || "NONE") === t);
    const s = stats(list.map((r) => ({ won: (r.r ?? 0) > 0, r: r.r })));
    console.log(`  ${t.padEnd(6)} ${String(s.n).padStart(5)} ${String(list.filter((r) => r.sent).length).padStart(6)} ${String(list.filter((r) => r.wouldBlock).length).padStart(9)} ${(s.wr * 100).toFixed(1).padStart(7)}   [${(s.lo * 100).toFixed(1)}-${(s.hi * 100).toFixed(1)}]  ${s.expR == null ? "—" : s.expR.toFixed(2)}`);
  }

  // per source
  const sources = [...new Set(rows.map((r) => r.source))].sort();
  console.log("\nPER SOURCE");
  console.log("  source                          n   sent   blocked    WR%   [95% CI]        expR     netR");
  for (const src of sources) {
    const list = rows.filter((r) => r.source === src);
    const s = stats(list.map((r) => ({ won: (r.r ?? 0) > 0, r: r.r })));
    const netR = list.reduce((acc, r) => acc + (r.r ?? 0), 0);
    console.log(`  ${src.padEnd(28)} ${String(s.n).padStart(5)} ${String(list.filter((r) => r.sent).length).padStart(6)} ${String(list.filter((r) => r.wouldBlock).length).padStart(9)} ${(s.wr * 100).toFixed(1).padStart(7)}   [${(s.lo * 100).toFixed(1)}-${(s.hi * 100).toFixed(1)}]  ${s.expR == null ? "—" : s.expR.toFixed(2).padStart(6)} ${netR.toFixed(2).padStart(8)}`);
  }

  // would-block precision / recall (resolved rows only)
  const resolved = rows.filter((r) => r.r != null);
  const blocked = resolved.filter((r) => r.wouldBlock);
  const losers = resolved.filter((r) => (r.r ?? 0) < 0);
  const precision = blocked.length ? blocked.filter((r) => (r.r ?? 0) < 0).length / blocked.length : null;
  const recall = losers.length ? blocked.filter((r) => (r.r ?? 0) < 0).length / losers.length : null;
  console.log(`\n  would-block precision: ${precision == null ? "—" : (precision * 100).toFixed(1) + "%"} (of ${blocked.length} blocked, share that lost)`);
  console.log(`  would-block recall:    ${recall == null ? "—" : (recall * 100).toFixed(1) + "%"} (of ${losers.length} losers, share that were blocked)`);

  // calibration + drift vs the previous 30 days
  const samplesNow: CalibrationSample[] = resolved.map((r) => ({ stated: r.stated ?? 0, won: (r.r ?? 0) > 0, r: r.r }));
  const prevSince = new Date(since.getTime() - DAYS * 86_400_000);
  const p2 = new PrismaClient();
  const rawPrev = await p2.candidateLog.findMany({ where: { ts: { gte: prevSince, lt: since } }, take: 20000 });
  const prevRows: Cand[] = rawPrev.map((r) => ({
    ts: r.ts, source: r.source, tier: r.tier, verdict: r.gateVerdict,
    sent: r.sent, wouldBlock: r.wouldBlock, r: r.simOutcomeR,
    stated: r.confidence, calibrated: r.calibratedConfidence,
    warnings: r.warnings, fails: r.fails,
  }));
  await p2.$disconnect();
  const samplesPrev: CalibrationSample[] = prevRows.filter((r) => r.r != null).map((r) => ({ stated: r.stated ?? 0, won: (r.r ?? 0) > 0, r: r.r }));
  const now = reliabilityTable(samplesNow);
  const prev = reliabilityTable(samplesPrev);
  console.log("\nCALIBRATION (stated band → realised) + drift vs previous window");
  console.log("  band        n   WR%   expR    drift   prevWR%");
  for (const [i, b] of now.entries()) {
    const d = calibrationDrift(now, prev)[i];
    console.log(`  ${b.band.padEnd(9)} ${String(b.n).padStart(5)} ${(b.realizedWR * 100).toFixed(1).padStart(6)} ${(b.expectancyR == null ? "—" : b.expectancyR.toFixed(2)).padStart(7)} ${(d.drift * 100).toFixed(1).padStart(8)} ${(prev[i].realizedWR * 100).toFixed(1).padStart(9)}`);
  }
  if (!resolved.length) console.log("\n  (no resolved candidates yet — run the resolver to fill simOutcomeR)");
}

if (import.meta.main) await main();
