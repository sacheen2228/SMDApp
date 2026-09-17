// Hermes Paper Trading API — GET/POST endpoints
// Uses persistent singleton worker via paper-worker.ts
import { NextRequest, NextResponse } from "next/server";
import {
  startPaperEngine,
  stopPaperEngine,
  getPaperEngineStatus,
  getPaperEngineData,
  type PaperWorkerConfig,
} from "@/lib/hermes/paper-worker";
import { PaperPerformanceEngine } from "@/lib/hermes/paper-performance";

const performance = new PaperPerformanceEngine();

// GET /api/hermes/paper
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.pathname;
  const status = getPaperEngineStatus();

  // /api/hermes/paper/status
  if (path.endsWith("/status")) {
    return NextResponse.json({
      success: true,
      data: status,
    });
  }

  // /api/hermes/paper/open
  if (path.endsWith("/open")) {
    const data = await getPaperEngineData();
    return NextResponse.json({
      success: true,
      data: data.openTrades,
      count: data.openTrades.length,
    });
  }

  // /api/hermes/paper/history
  if (path.endsWith("/history")) {
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const data = await getPaperEngineData();
    const trades = data.closedTrades.slice(0, limit);
    return NextResponse.json({
      success: true,
      data: trades,
      count: trades.length,
    });
  }

  // /api/hermes/paper/performance
  if (path.endsWith("/performance")) {
    const data = await getPaperEngineData();
    const report = performance.generateReport(
      data.closedTrades,
      data.noTradeObservations
    );
    return NextResponse.json({
      success: true,
      data: report,
    });
  }

  // /api/hermes/paper/no-trade
  if (path.endsWith("/no-trade")) {
    const data = await getPaperEngineData();
    return NextResponse.json({
      success: true,
      data: data.noTradeObservations,
      count: data.noTradeObservations.length,
    });
  }

  // GET /api/hermes/paper — overview
  const data = await getPaperEngineData();
  const metrics = performance.calculateMetrics(data.closedTrades);

  return NextResponse.json({
    success: true,
    data: {
      status,
      account: data.account,
      metrics,
      openCount: data.openTrades.length,
      closedCount: data.closedTrades.length,
      noTradeCount: data.noTradeObservations.length,
      isRunning: status.status === "RUNNING",
    },
  });
}

// POST /api/hermes/paper
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action, config } = body;

  switch (action) {
    case "start": {
      const state = await startPaperEngine(config as Partial<PaperWorkerConfig>);
      return NextResponse.json({
        success: true,
        data: state,
      });
    }

    case "stop": {
      const state = await stopPaperEngine();
      return NextResponse.json({
        success: true,
        data: state,
      });
    }

    case "status": {
      const state = getPaperEngineStatus();
      return NextResponse.json({
        success: true,
        data: state,
      });
    }

    default:
      return NextResponse.json(
        { success: false, error: `Unknown action: ${action}` },
        { status: 400 }
      );
  }
}
