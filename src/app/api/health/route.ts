// /api/health — comprehensive system health check
// Includes: AI providers, market data sources, Breeze session, database, memory

import { NextResponse } from "next/server";
import { brokerSessionManager } from "@/lib/broker-session-manager";
import { marketDataManager } from "@/lib/market-data-manager";
import { providerHealth } from "@/lib/provider-health";
import { getSessionState as getBreezeState } from "@/lib/icici-breeze/auth";
import { probeLiveDataService } from "@/lib/agents/feed-gate";

export async function GET() {
  const checks: Record<string, { status: string; message?: string; latencyMs?: number }> = {};

  // Backend
  checks.backend = { status: "OK", message: `Node ${process.version}` };

  // Database
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    checks.database = { status: "OK" };
  } catch (error: any) {
    checks.database = { status: "ERROR", message: error.message };
  }

  // ─── AI Providers ───────────────────────────────────────────────
  const aiHealth = providerHealth.exportHealth();
  for (const [provider, health] of Object.entries(aiHealth)) {
    checks[`ai_${provider}`] = {
      status: health.status,
      message: health.lastError || undefined,
      latencyMs: health.avgLatencyMs || undefined,
    };
  }

  // ─── Breeze Session ─────────────────────────────────────────────
  try {
    const breezeState = getBreezeState();
    checks.breeze = {
      status: breezeState.status,
      message: breezeState.authenticated
        ? `Session active, expires: ${breezeState.expiresAt || "unknown"}`
        : "Not authenticated",
    };
  } catch {
    checks.breeze = { status: "UNKNOWN", message: "Could not get Breeze state" };
  }

  // ─── Broker Sessions (existing) ─────────────────────────────────
  const brokerStates = brokerSessionManager.getAllStates();
  for (const [broker, state] of Object.entries(brokerStates)) {
    checks[`broker_${broker}`] = {
      status: state.state,
      message: state.lastError,
    };
  }

  // ─── Market Data Sources (existing) ─────────────────────────────
  try {
    const sourceStatus = marketDataManager.getStatusSummary();
    checks.marketData = {
      status: sourceStatus ? 'OK' : 'UNKNOWN',
      message: JSON.stringify(sourceStatus),
    };
  } catch {
    checks.marketData = { status: 'UNKNOWN', message: 'Could not get market data status' };
  }

  // WebSocket
  checks.websocket = { status: "OK", message: "Socket.io server" };

  // ─── Live Data Service (feed-gate sidecar, 127.0.0.1:8765) ──────
  // Unconditional probe — visible even after hours, unlike the market-hours gate.
  try {
    const probe = await probeLiveDataService();
    checks.liveDataService = probe.reachable
      ? {
          status: "OK",
          message: `overall=${probe.overall ?? "?"} all_live=${probe.allLive} (${probe.latencyMs}ms)`,
          latencyMs: probe.latencyMs,
        }
      : {
          status: "ERROR",
          message: `127.0.0.1:8765 unreachable — ${probe.failNote || "no response"} (service not running?)`,
        };
  } catch (error: any) {
    checks.liveDataService = { status: "ERROR", message: `probe failed: ${error?.message || error}` };
  }

  // Memory usage
  const mem = process.memoryUsage();
  checks.memory = {
    status: mem.heapUsed < 400 * 1024 * 1024 ? "OK" : "WARNING",
    message: `${Math.round(mem.heapUsed / 1024 / 1024)}MB used`,
  };

  // ─── Overall Status ─────────────────────────────────────────────
  const overallStatus = Object.values(checks).every(c => c.status === "OK" || c.status === "CONNECTED" || c.status === "ready")
    ? "HEALTHY"
    : Object.values(checks).some(c => c.status === "ERROR" || c.status === "offline")
      ? "DEGRADED"
      : "PARTIAL";

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
}
