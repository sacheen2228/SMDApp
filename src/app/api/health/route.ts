// /api/health — comprehensive system health check

import { NextResponse } from "next/server";
import { brokerSessionManager } from "@/lib/broker-session-manager";
import { marketDataManager } from "@/lib/market-data-manager";

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

  // Broker sessions
  const brokerStates = brokerSessionManager.getAllStates();
  for (const [broker, state] of Object.entries(brokerStates)) {
    checks[`broker_${broker}`] = {
      status: state.state,
      message: state.lastError,
    };
  }

  // Market data sources
  const sources = marketDataManager.getAllSources();
  for (const source of sources) {
    checks[`data_${source.name}`] = {
      status: source.status,
      message: source.error,
      latencyMs: source.latencyMs,
    };
  }

  // WebSocket
  checks.websocket = { status: "OK", message: "Socket.io server" };

  // Memory usage
  const mem = process.memoryUsage();
  checks.memory = {
    status: mem.heapUsed < 400 * 1024 * 1024 ? "OK" : "WARNING",
    message: `${Math.round(mem.heapUsed / 1024 / 1024)}MB used`,
  };

  const overallStatus = Object.values(checks).every(c => c.status === "OK" || c.status === "CONNECTED")
    ? "HEALTHY"
    : Object.values(checks).some(c => c.status === "ERROR")
      ? "DEGRADED"
      : "PARTIAL";

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
}
