// GET /api/training — Training engine REST API
// Provides training stats, factor analysis, calibration, regime profiles

import { NextRequest, NextResponse } from "next/server";
import {
  computeTrainingStats,
  analyzeFactors,
  computeOptimalWeights,
  computeRegimeProfiles,
  getAllTrades,
  getResolvedTrades,
  recordTrade,
  resolveTrade,
  collectMarketSnapshot,
  type TradeRecord,
} from "@/lib/training/trade-trainer";
import { calibrateConfidence, getOptimalConfidenceThreshold, adjustConfidence } from "@/lib/training/confidence-calibrator";
import { findBestCombinations } from "@/lib/training/factor-analyzer";
import { getRegimeWeights, adaptScoreForRegime } from "@/lib/training/regime-learner";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "stats";

    switch (action) {
      case "stats": {
        const stats = computeTrainingStats();
        return NextResponse.json({ success: true, data: stats });
      }

      case "factors": {
        const factors = analyzeFactors();
        return NextResponse.json({ success: true, data: factors });
      }

      case "calibration": {
        const calibration = calibrateConfidence();
        return NextResponse.json({ success: true, data: calibration });
      }

      case "threshold": {
        const threshold = getOptimalConfidenceThreshold();
        return NextResponse.json({ success: true, data: threshold });
      }

      case "weights": {
        const weights = computeOptimalWeights();
        return NextResponse.json({ success: true, data: weights });
      }

      case "regimes": {
        const regimes = computeRegimeProfiles();
        return NextResponse.json({ success: true, data: regimes });
      }

      case "regime-weights": {
        const regime = searchParams.get("regime") || "UNKNOWN";
        const weights = getRegimeWeights(regime);
        return NextResponse.json({ success: true, data: weights });
      }

      case "combinations": {
        const maxFactors = parseInt(searchParams.get("maxFactors") || "3");
        const combinations = findBestCombinations(maxFactors);
        return NextResponse.json({ success: true, data: combinations });
      }

      case "trades": {
        const symbol = searchParams.get("symbol");
        const source = searchParams.get("source");
        const regime = searchParams.get("regime");
        const limit = parseInt(searchParams.get("limit") || "100");

        let trades = getResolvedTrades();
        if (symbol) trades = trades.filter(t => t.symbol === symbol);
        if (source) trades = trades.filter(t => t.source === source);
        if (regime) trades = trades.filter(t => t.regime === regime);

        return NextResponse.json({
          success: true,
          data: trades.slice(-limit),
          total: trades.length,
        });
      }

      case "snapshot": {
        const symbol = searchParams.get("symbol") || "NIFTY";
        const strike = searchParams.get("strike") ? parseInt(searchParams.get("strike")!) : undefined;
        const optionType = searchParams.get("optionType") || undefined;
        const snapshot = await collectMarketSnapshot(symbol, strike, optionType);
        return NextResponse.json({ success: true, data: snapshot });
      }

      case "adjust-confidence": {
        const raw = parseInt(searchParams.get("raw") || "75");
        const regime = searchParams.get("regime") || undefined;
        const adjusted = adjustConfidence(raw, regime);
        return NextResponse.json({ success: true, data: { raw, adjusted, regime } });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Training API error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "record-trade": {
        const trade: TradeRecord = body.trade;
        if (!trade || !trade.id || !trade.symbol) {
          return NextResponse.json(
            { success: false, error: "trade.id and trade.symbol required" },
            { status: 400 }
          );
        }
        recordTrade(trade);
        return NextResponse.json({ success: true, id: trade.id });
      }

      case "resolve-trade": {
        const { id, outcome, exitPrice, exitReason, mfe, mae } = body;
        if (!id || !outcome || exitPrice === undefined) {
          return NextResponse.json(
            { success: false, error: "id, outcome, and exitPrice required" },
            { status: 400 }
          );
        }
        const resolved = resolveTrade(id, outcome, exitPrice, exitReason || "manual", mfe, mae);
        if (!resolved) {
          return NextResponse.json(
            { success: false, error: `Trade ${id} not found` },
            { status: 404 }
          );
        }
        return NextResponse.json({ success: true, data: resolved });
      }

      case "record-snapshot": {
        const { symbol, strike, optionType } = body;
        if (!symbol) {
          return NextResponse.json(
            { success: false, error: "symbol required" },
            { status: 400 }
          );
        }
        const snapshot = await collectMarketSnapshot(symbol, strike, optionType);
        return NextResponse.json({ success: true, data: snapshot });
      }

      case "adapt-score": {
        const { rawScore, regime, factors } = body;
        if (rawScore === undefined || !regime) {
          return NextResponse.json(
            { success: false, error: "rawScore and regime required" },
            { status: 400 }
          );
        }
        const result = adaptScoreForRegime(rawScore, regime, factors || {});
        return NextResponse.json({ success: true, data: result });
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Training API error" },
      { status: 500 }
    );
  }
}
