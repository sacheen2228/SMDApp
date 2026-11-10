// Shadow-mode endpoint for the option-chain provider race.
//
// Runs the legacy sequential provider tree (current production behaviour) and
// the new parallel provider race for the SAME symbol/expiry, then compares
// them. The production `/api/option-chain` route is NOT touched — this is a
// read-only verification tool. No production traffic is switched here.
//
// GET /api/market/option-chain-shadow?symbol=NIFTY&expiry=2026-11-12

import { NextRequest, NextResponse } from "next/server";
import {
  runLegacyOptionChain,
  runShadowComparison,
  type OptionChainRaceOpts,
} from "@/lib/market-data-race";
import { isBSEIndex } from "@/lib/bse-api";
import { toIsoDate } from "@/lib/data-layer/chains/option-chain";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") || "NIFTY").toUpperCase();
  const rawExpiry = searchParams.get("expiry") || undefined;
  const expiry = rawExpiry ? toIsoDate(rawExpiry) : undefined;

  if (rawExpiry && !expiry) {
    return NextResponse.json(
      { success: false, error: `Invalid expiry "${rawExpiry.slice(0, 40)}"` },
      { status: 400 },
    );
  }

  const opts: OptionChainRaceOpts = {
    symbol,
    exchange: isBSEIndex(symbol) ? "BSE" : "NSE",
    expiry,
    nowMs: Date.now(),
    shadow: true,
  };

  // Legacy sequential path (current production behaviour).
  const legacy = await runLegacyOptionChain(opts);

  // Parallel race in shadow mode (waits for all providers → complete report).
  const comparison = await runShadowComparison(
    opts,
    legacy.chain,
    legacy.rejected.map((r) => ({ provider: r.provider, reason: r.reason })),
  );

  return NextResponse.json({
    success: true,
    symbol,
    exchange: opts.exchange,
    requestedExpiry: rawExpiry ?? null,
    resolvedExpiry: comparison.expiry,
    comparison,
    legacy: {
      chain: legacy.chain
        ? {
            provider: legacy.chain.source,
            strikes: legacy.chain.strikes.length,
            spotPrice: legacy.chain.spotPrice,
            expiry: legacy.chain.expiry,
            bothLegStrikes: legacy.chain.strikes.filter(
              (s) => s.ce && s.pe && s.ce.ltp > 0 && s.pe.ltp > 0,
            ).length,
          }
        : null,
      rejected: legacy.rejected,
    },
  });
}
