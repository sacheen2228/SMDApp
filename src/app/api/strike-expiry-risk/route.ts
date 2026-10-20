import { NextResponse } from 'next/server';
import { runStrikeExpiryRiskEngine } from '@/lib/strike-expiry-risk-engine';
import type { StrikeInput } from '@/lib/strike-expiry-risk-engine';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get("strategy") || "ordinary";
    if (strategy !== "ordinary" && strategy !== "zero_hero") {
      return NextResponse.json(
        { status: "ERROR", reason: `Invalid strategy: ${strategy}` },
        { status: 400 }
      );
    }

    return NextResponse.json({
      status: "ENGINE_READY",
      strategy,
      message: `Strike Expiry-Risk Engine in ${strategy} mode`,
      gates: [
        "GATE 0: Data Integrity (quote age > 3s, NaN, bid/ask ≤ 0, spread > 0.08, lot/multiplier ≤ 0, expiry mismatch, timestamp sync > 1s)",
        "GATE 1: Strike Distance (ordinary: −0.005 ≤ d ≤ 0.015; zero_hero: −0.010 ≤ d ≤ 0.010)",
        "GATE 2: Delta Band + Calibrated Probability (ordinary: 0.55 ≤ |Δ| ≤ 0.70; zero_hero: 0.60 ≤ |Δ| ≤ 0.75; risk ≤ budget)",
        "GATE 3: Time-to-Expiry & Expected Move (τ < 0.4/365 special handling)",
        "GATE 4: Premium-Collapse Detection (mid > 40% collapse, underlying move > 0.6×expected_move, IV crush > 15%, extreme θ_norm OTM)",
        "GATE 5: Ranking & Output (ascending risk, higher |Δ|, tighter spread)",
      ],
      riskBudgets: {
        ordinary: "P(not zero) ≥ 65% (risk ≤ 35%)",
        zero_hero: "P(not zero) ≥ 75% (risk ≤ 25%)",
      },
      requirements: {
        liveData: "All inputs must be live and verified (quote age < 3s, timestamps synced < 1s)",
        underlyingSpot: "Current spot S with timestamp",
        optionChain: "Option chain for current expiry with bid/ask/mid/delta/gamma/theta/vega/IV/OI/volume",
        contractMaster: "Expiry datetime, lot_size, multiplier, option_type (CE/PE)",
        riskBudgets: "ordinary_risk_max=0.35, zero_hero_risk_max=0.25",
      },
      thresholdTables: {
        ordinary: {
          strikeDistance: "[−0.005, 0.015]",
          deltaBand: "[0.55, 0.70]",
          riskBudget: "0.35 (P(not zero) ≥ 65%)",
        },
        zero_hero: {
          strikeDistance: "[−0.010, 0.010]",
          deltaBand: "[0.60, 0.75]",
          riskBudget: "0.25 (P(not zero) ≥ 75%)",
        },
      },
      backtestRequirements: {
        universe: "last 20–30 expiry days of NIFTY, BANKNIFTY and liquid single-stock options",
        frequency: "1-minute or tick-level chain + underlying",
        mandatoryMetrics: [
          "Realized % of selected strikes that finished ITM",
          "Average premium retained at expiry (% of entry mid)",
          "Maximum adverse excursion",
          "Brier score of P_ITM predictions (must be < 0.15)",
          "False-positive rate of Gate 4",
          "Count of Gate 0 forced NO_TRADE events",
        ],
        stressTests: [
          "Stale quotes, missing IV/delta, spread > 8%",
          "Sudden 20%+ IV crush",
          "Adverse gaps",
        ],
      },
    });
  } catch (error) {
    return NextResponse.json(
      { status: "ERROR", reason: (error as Error).message },
      { status: 500 }
    );
  }
}
