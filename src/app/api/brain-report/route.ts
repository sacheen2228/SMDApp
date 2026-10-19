// /api/brain-report — daily brain report (per tier, per source, calibration drift)
//   GET ?days=30 → the same numbers as scripts/brain-report.ts
import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { wilson } from "@/lib/agent-brain-gate";
import { reliabilityTable, calibrationDrift, type CalibrationSample } from "@/lib/confidence-calibration";
import { cacheStats } from "@/lib/tech-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") || 30);
  const since = new Date(Date.now() - days * 86_400_000);
  const prevSince = new Date(since.getTime() - days * 86_400_000);
  const p = new PrismaClient();
  const rows = await p.candidateLog.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "asc" }, take: 20000 });
  const prevRows = await p.candidateLog.findMany({ where: { ts: { gte: prevSince, lt: since } }, take: 20000 });
  await p.$disconnect();

  const agg = (list: typeof rows) => {
    const resolved = list.filter((r) => r.simOutcomeR != null);
    const n = resolved.length;
    const wins = resolved.filter((r) => (r.simOutcomeR ?? 0) > 0).length;
    const ci = wilson(wins, n);
    const rs = resolved.map((r) => r.simOutcomeR as number);
    return {
      n: list.length,
      resolved: n,
      sent: list.filter((r) => r.sent).length,
      wouldBlock: list.filter((r) => r.wouldBlock).length,
      wr: n ? wins / n : 0,
      wrLo: ci.lo,
      wrHi: ci.hi,
      expectancyR: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : null,
      netR: rs.reduce((s, x) => s + x, 0),
    };
  };

  const byTier: Record<string, unknown> = {};
  for (const t of ["A", "B", "C", "NONE"]) byTier[t] = agg(rows.filter((r) => (r.tier || "NONE") === t));

  const bySource: Record<string, unknown> = {};
  for (const src of [...new Set(rows.map((r) => r.source))].sort()) {
    bySource[src] = agg(rows.filter((r) => r.source === src));
  }

  const samplesNow: CalibrationSample[] = rows.filter((r) => r.simOutcomeR != null).map((r) => ({ stated: r.confidence ?? 0, won: (r.simOutcomeR ?? 0) > 0, r: r.simOutcomeR }));
  const samplesPrev: CalibrationSample[] = prevRows.filter((r) => r.simOutcomeR != null).map((r) => ({ stated: r.confidence ?? 0, won: (r.simOutcomeR ?? 0) > 0, r: r.simOutcomeR }));
  const now = reliabilityTable(samplesNow);
  const prev = reliabilityTable(samplesPrev);
  const drift = calibrationDrift(now, prev);

  const resolved = rows.filter((r) => r.simOutcomeR != null);
  const blocked = resolved.filter((r) => r.wouldBlock);
  const losers = resolved.filter((r) => (r.simOutcomeR ?? 0) < 0);

  return NextResponse.json({
    ok: true,
    days,
    counts: { candidates: rows.length, resolved: resolved.length },
    byTier,
    bySource,
    wouldBlockPrecision: blocked.length ? blocked.filter((r) => (r.simOutcomeR ?? 0) < 0).length / blocked.length : null,
    wouldBlockRecall: losers.length ? blocked.filter((r) => (r.simOutcomeR ?? 0) < 0).length / losers.length : null,
    calibration: { current: now, previous: prev, drift },
    techCache: cacheStats(),
  });
}
