// /api/signal-explain — read-only: recent trade candidates with their gate
// verdicts, warnings, layer states and tier (TheTradeCartel "why this signal"
// equivalent, embedded in the Terminal tab).
//
// Reads the Prisma candidate_log written by signal-veto / agent-brain at
// signal time. No writes, no network calls, no signal generation.
//   GET ?symbol=NIFTY&limit=20 → latest rows (newest first)

import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { GATE_CONFIG } from "@/lib/agent-brain-gate";

export const dynamic = "force-dynamic";

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw as T;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return (parsed ?? fallback) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** candidate_log row → safe API shape. Pure — tested in tests/signal-explain.test.ts. */
export function serializeCandidate(row: any) {
  return {
    ts: row.ts ?? null,
    source: row.source ?? null,
    symbol: row.symbol ?? null,
    direction: row.direction ?? null,
    strike: row.strike ?? null,
    expiry: row.expiry ?? null,
    underlyingSpot: row.underlyingSpot ?? null,
    entryPremium: row.entryPremium ?? null,
    stopPremium: row.stopPremium ?? null,
    targetPremium: row.targetPremium ?? null,
    confidence: row.confidence ?? null,
    calibratedConfidence: row.calibratedConfidence ?? null,
    rr: row.rr ?? null,
    delta: row.delta ?? null,
    regime: row.regime ?? null,
    sessionWindow: row.sessionWindow ?? null,
    gateVerdict: row.gateVerdict ?? null,
    tier: row.tier ?? null,
    warnings: parseJson<string[]>(row.warnings, []),
    fails: parseJson<string[]>(row.fails, []),
    layerStates: parseJson<Record<string, string> | null>(row.layerStates, null),
    sent: Boolean(row.sent),
    wouldBlock: Boolean(row.wouldBlock),
    simOutcomeR: row.simOutcomeR ?? null,
    configHash: row.configHash ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const symbol = (req.nextUrl.searchParams.get("symbol") || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 20);
    const limit = Math.min(
      Math.max(Number(req.nextUrl.searchParams.get("limit") || 20) || 20, 1),
      100
    );

    const p = new PrismaClient();
    const rows = await p.candidateLog.findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { ts: "desc" },
      take: limit,
    });
    await p.$disconnect();

    return NextResponse.json({
      ok: true,
      count: rows.length,
      candidates: rows.map(serializeCandidate),
      gateConfig: {
        minConfidence: GATE_CONFIG.minConfidence,
        minOptionRR: GATE_CONFIG.minOptionRR,
        minAbsDelta: GATE_CONFIG.minAbsDelta,
        maxOtmSteps: GATE_CONFIG.maxOtmSteps,
        minLayersAgree: GATE_CONFIG.minLayersAgree,
        tradeBudget: GATE_CONFIG.tradeBudget,
        freshnessMaxMin: GATE_CONFIG.freshnessMaxMin,
        allowExpiryDay: GATE_CONFIG.allowExpiryDay,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "candidate_log read failed" },
      { status: 500 }
    );
  }
}
