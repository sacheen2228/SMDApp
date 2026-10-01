// Evidence-aware backtest report — prints sample trades with the REAL
// option-chain (OI/PCR/walls), Greeks, and news evidence used at signal
// time, plus an Evidence Integrity Check section.
//
// Run: bun run scripts/backtest-evidence-report.ts [maxTrades]
// Exit code 2 if any news-evidence integrity failure is found.

import {
  backtestAllTrades,
  BacktestedTrade,
  fetchAllClosedTrades,
} from "@/lib/trade-backtest-engine";
import { getTrades, TradeRecord } from "@/lib/trade-audit-client";
import {
  formatEvidenceBlock,
  printEvidenceIntegrityReport,
} from "@/lib/evidence-verifier";

const maxTrades = parseInt(process.argv[2] || "30", 10);

function fmtMoney(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())} ${p(ist.getHours())}:${p(ist.getMinutes())}`;
  } catch {
    return iso;
  }
}

function printTrade(t: BacktestedTrade): void {
  const side =
    t.trendDirection?.toUpperCase().includes("BULL") ||
    t.trendDirection?.toUpperCase().includes("UP") ||
    t.optionType === "CE"
      ? "BUY"
      : "SELL";
  const optType = t.optionType || "?";

  console.log(
    `[${fmtTime(t.entryTime)}] ${t.symbol} | ${side} ${optType} | Spot ₹${Math.round(t.entrySpot ?? 0).toLocaleString("en-IN")} | Strike ${t.strikePrice ?? "?"} ${optType}`
  );
  console.log(
    `  Entry premium ₹${t.entryPrice} | SL ₹${t.stopLoss} | TP1 ₹${t.tp1}`
  );

  const outcome = t.actualExitReason || t.recordedStatus || "OPEN";
  const pnl =
    t.actualPnl !== null ? fmtMoney(t.actualPnl) : "n/a";
  console.log(
    `  Strategy: ${t.strategyId} | Outcome: ${outcome}${t.actualExitTime ? ` at ${fmtTime(t.actualExitTime).slice(11)}` : ""} | P&L: ${pnl}`
  );
  console.log("");

  // ── Evidence block: REAL snapshot at signal time, or explicit NOT AVAILABLE ──
  console.log(formatEvidenceBlock(t.evidence, { indent: "  " }));

  if (t.evidenceFlags.length > 0) {
    for (const f of t.evidenceFlags) {
      console.log(
        `  ⚠️ EVIDENCE FLAG [${f.category}/${f.severity}]: ${f.message}`
      );
    }
  }
  console.log(
    `  Evidence integrity: ${t.evidenceIntegrity}`
  );
  console.log("");
}

// ── Scope limitation (Q1): what these numbers do NOT cover ──
// Scans every closed trade's signal context for references to the evidence
// inputs (S1-S8, Jarvis, OI-wall, Greeks) — the count is computed live, not
// asserted — and states the evidence-coverage consequence explicitly.
async function printScopeLimitation(
  sampleReport: { totalTrades: number; priceOnlyTrades: number }
): Promise<void> {
  let raw: TradeRecord[] = [];
  try {
    raw = await fetchAllClosedTrades(
      (page, pageSize) => getTrades({ status: "closed", page, pageSize }),
      { maxTrades: 10000, pageSize: 500 }
    );
  } catch (e: any) {
    console.log(
      `  (signal-context scan unavailable: ${e?.message ?? e})`
    );
    return;
  }

  const KW = /\bS[1-8]\b|jarvis|oi[- ]?wall|greeks/i;
  const kwHits = raw.filter((t) =>
    KW.test(
      `${t.strategyId ?? ""} ${t.signalReason ?? ""} ${JSON.stringify(
        t.marketContext ?? {}
      )}`
    )
  );

  const byStrategy = new Map<string, number>();
  for (const t of raw)
    byStrategy.set(t.strategyId, (byStrategy.get(t.strategyId) ?? 0) + 1);
  const strategies = [...byStrategy.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} (${n})`)
    .join(", ");

  console.log("════════════════════════════════════════════════════════════");
  console.log("  SCOPE LIMITATION — what this backtest does NOT verify");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  Closed trades scanned: ${raw.length}`);
  console.log(`  Strategy families: ${strategies || "none"}`);
  console.log(
    `  Trades whose signal context references S1-S8/jarvis/OI-wall/Greeks: ` +
      `${kwHits.length} of ${raw.length}`
  );
  console.log(
    `  Evidence coverage in sample: ${sampleReport.priceOnlyTrades} of ` +
      `${sampleReport.totalTrades} trades are PRICE_ONLY (no recorded snapshot ` +
      `at/before entry).`
  );
  console.log(
    "  → Entries here are price-structure replays: OI/Greeks/news evidence is"
  );
  console.log(
    "    attached POST-HOC from the market recorder (earliest snapshot " +
      "2026-09-27T08:01Z;"
  );
  console.log(
    "    first trading-session capture 2026-09-28 09:15 IST), never consumed"
  );
  console.log(
    "    by the original signal. Trades entered before that window are"
  );
  console.log("    PRICE_ONLY by construction and always will be.");
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  TRADE EVIDENCE REPORT — OI / Greeks / News per trade     ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`Sample trades: up to ${maxTrades}`);
  console.log("");

  const { trades, summary } = await backtestAllTrades({ maxTrades });

  if (trades.length === 0) {
    console.log("No closed trades found in the audit sidecar.");
    return;
  }

  for (const t of trades) {
    printTrade(t);
  }

  // ── Evidence integrity check (section 3) ──
  const report = summary.evidenceIntegrity;
  console.log("════════════════════════════════════════════════════════════");
  for (const line of printEvidenceIntegrityReport(report)) {
    console.log(line);
  }

  // Per-category flag details
  if (report.flaggedTrades.length > 0) {
    console.log("    Flagged trades:");
    for (const ft of report.flaggedTrades.slice(0, 20)) {
      for (const f of ft.flags) {
        console.log(`      [${ft.tradeId}] ${f.category}/${f.severity}: ${f.message}`);
      }
    }
    if (report.flaggedTrades.length > 20) {
      console.log(`      ... and ${report.flaggedTrades.length - 20} more trades`);
    }
  }

  console.log("");
  if (report.newsFabricationFailures > 0) {
    console.log(
      "  ❌ NEWS EVIDENCE INTEGRITY FAILURES DETECTED — some headlines are fabricated or post-entry. Exclude these trades from headline-based results."
    );
    process.exitCode = 2;
  } else {
    console.log(
      "  ✅ No news evidence fabrication detected in this sample."
    );
  }

  // Q1 scope limitation — always printed, even when integrity is clean
  console.log("");
  await printScopeLimitation({
    totalTrades: report.totalTrades,
    priceOnlyTrades: report.priceOnlyTrades,
  });
}

main().catch((err) => {
  console.error("Report failed:", err);
  process.exit(1);
});
