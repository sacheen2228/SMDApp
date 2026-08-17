import { NextResponse } from "next/server";

// Simple liveness endpoint for Render's health check + container healthcheck.
// Also probes the two sidecars so a broken sidecar is visible in /health.
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, "up" | "down"> = {};

  const probe = async (url: string): Promise<"up" | "down"> => {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? "up" : "down";
    } catch {
      return "down";
    }
  };

  const ta = process.env.TRADE_AUDIT_BASE ?? "http://localhost:4001";
  const mh = process.env.MARKET_HISTORY_BASE ?? "http://localhost:4002";

  const [taStatus, mhStatus] = await Promise.all([
    probe(ta),
    probe(mh),
  ]);
  checks["trade-audit"] = taStatus;
  checks["market-history"] = mhStatus;

  return NextResponse.json({ ok: true, checks }, { status: 200 });
}