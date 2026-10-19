// scripts/replay-veto.ts
// Replays the veto over the CLOSED ledger and over RESOLVED candidates, then reports
// per source × verdict with confidence intervals, expectancy in R, and an explicit
// in-sample / out-of-sample split.
//
// Usage:
//   bun scripts/replay-veto.ts                     # ledger (sidecar) + candidate_log
//   bun scripts/replay-veto.ts --out-of-sample-only
//   bun scripts/replay-veto.ts --json out.json
//
// Reading the ledger: spot_price holds the OPTION PREMIUM, never the underlying.
// The underlying is only used when underlying_spot is present (added 2026-10-19).
import { evaluateSignalVeto, type VetoResult } from "../src/lib/signal-veto";
import { reliabilityTable, type CalibrationSample } from "../src/lib/confidence-calibration";
import { wilson, GATE_CONFIG } from "../src/lib/agent-brain-gate";
import { PrismaClient } from "@prisma/client";

const LEDGER = process.env.AUDIT_URL || "http://localhost:4001";
const OUT_ONLY = process.argv.includes("--out-of-sample-only");
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

interface Row {
  id: string;
  source: string;
  date: string;          // YYYY-MM-DD
  symbol: string;
  side: "call" | "put" | "other";
  pnl: number;           // ₹ net P&L (ledger) — R proxy when no candles
  r: number | null;      // resolved R (candidate_log) if available
  confidence: number;
  rr: number | null;
  placeholder: boolean;  // R:R == 1.00 or confidence == 0
  instrument: "option" | "equity" | "other";
  expiry: string | null;
  direction: "BUY" | "SELL" | "UNKNOWN";
  time: string;              // HH:MM of the signal (IST)
  spot: number | null;   // underlying — ONLY from underlying_spot
  entry: number | null;
  stop: number | null;
  target: number | null;
}

function sideOf(optionType: string | null, action: string): Row["side"] {
  const ot = String(optionType || "").toUpperCase();
  if (ot === "CE" || ot === "PE") return ot === "CE" ? "call" : "put";
  const a = String(action || "").toUpperCase();
  if (a.includes("CE")) return "call";
  if (a.includes("PE")) return "put";
  return "other";
}

async function loadLedger(): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${LEDGER}/api/trades?status=closed&page=${page}&pageSize=200`);
    if (!res.ok) break;
    const data: any = await res.json();
    const items: any[] = data.items || [];
    for (const t of items) {
      const entry = Number(t.entryPrice);
      const stop = Number(t.stopLoss);
      const tp1 = t.tp1 != null ? Number(t.tp1) : null;
      const rr = tp1 != null && entry > stop ? (tp1 - entry) / (entry - stop) : null;
      const conf = Number(t.signalConfidence) || 0;
      const underlying = t.underlyingSpot != null ? Number(t.underlyingSpot) : null;
      out.push({
        id: String(t.id),
        source: String(t.strategyId || "unknown"),
        date: String(t.createdAtIst || "").slice(0, 10),
        symbol: String(t.symbol || ""),
        side: sideOf(t.optionType, ""),
        pnl: Number(t.netPnl) || 0,
        r: null,
        confidence: conf,
        rr,
        placeholder: (rr != null && Math.abs(rr - 1) < 0.005) || conf === 0,
        instrument: t.optionType ? "option" : t.instrumentType === "EQUITY" ? "equity" : "other",
        expiry: t.expiry ?? null,
        direction: String(t.trendDirection || "").toUpperCase() === "BEARISH" ? "SELL" : String(t.trendDirection || "").toUpperCase() === "BULLISH" ? "BUY" : "UNKNOWN",
        time: /T(\d{2}:\d{2})/.exec(String(t.createdAtIst || ""))?.[1] || "10:00",
        spot: underlying,
        entry: Number.isFinite(entry) ? entry : null,
        stop: Number.isFinite(stop) ? stop : null,
        target: tp1,
      });
    }
    if (items.length < 200 || page * 200 >= (data.total || 0)) break;
  }
  return out;
}

async function loadCandidates(): Promise<Row[]> {
  const p = new PrismaClient();
  try {
    const rows = await p.candidateLog.findMany({ where: { simOutcomeR: { not: null } }, orderBy: { ts: "asc" }, take: 5000 });
    return rows.map((r) => {
      const conf = r.confidence ?? 0;
      return {
        id: r.id,
        source: r.source,
        date: r.ts.toISOString().slice(0, 10),
        symbol: r.symbol,
        side: sideOf(r.direction, r.direction),
        pnl: 0,
        r: r.simOutcomeR,
        confidence: conf,
        rr: r.rr,
        placeholder: (r.rr != null && Math.abs(r.rr - 1) < 0.005) || conf === 0,
        instrument: r.strike != null ? "option" : "equity",
        expiry: r.expiry,
        direction: /SELL|PUT|PE/i.test(r.direction) ? "SELL" : /BUY|CALL|CE/i.test(r.direction) ? "BUY" : "UNKNOWN",
        time: r.ts.toISOString().slice(11, 16),
        spot: r.underlyingSpot,
        entry: r.entryPremium,
        stop: r.stopPremium,
        target: r.targetPremium,
      } as Row;
    });
  } finally {
    await p.$disconnect();
  }
}

/** Re-run the veto over a row, using ONLY verified fields. */
export function verdictFor(row: Row): VetoResult {
  // Direction comes from the RECORDED trendDirection — never assumed.
  const action =
    row.side === "put" ? "SELL PE"
      : row.side === "call" ? "BUY CE"
        : row.direction === "SELL" ? "SELL"
          : row.direction === "BUY" ? "BUY"
            : "UNKNOWN";
  return evaluateSignalVeto({
    symbol: row.symbol,
    action,
    optionType: row.side === "call" ? "CE" : row.side === "put" ? "PE" : undefined,
    strike: undefined,
    entry: row.entry ?? undefined,
    stopLoss: row.stop ?? undefined,
    tp1: row.target ?? undefined,
    confidence: row.confidence,
    expiry: row.expiry ?? undefined,
    spot: row.spot ?? undefined,
    source: row.source,
    // the session cutoff must be judged at the SIGNAL time, not "now"
    nowMs: Date.parse(row.date + "T" + (row.time || "10:00") + ":00+05:30") || undefined,
  });
}

interface Stats {
  n: number; wr: number; wrLo: number; wrHi: number; breakevenWR: number;
  avgWin: number; avgLoss: number; expectancyR: number | null; netPnl: number; pf: number;
}

export function stats(rows: Row[]): Stats {
  const n = rows.length;
  if (!n) return { n: 0, wr: 0, wrLo: 0, wrHi: 0, breakevenWR: 0, avgWin: 0, avgLoss: 0, expectancyR: null, netPnl: 0, pf: 0 };
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl < 0);
  const gp = wins.reduce((s, r) => s + r.pnl, 0);
  const gl = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 0;
  const wr = wins.length / n;
  const ci = wilson(wins.length, n);
  // break-even WR for the observed payoff ratio
  const breakevenWR = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0;
  const rVals = rows.map((r) => r.r).filter((x): x is number => x != null);
  return {
    n, wr, wrLo: ci.lo, wrHi: ci.hi, breakevenWR, avgWin, avgLoss,
    expectancyR: rVals.length ? rVals.reduce((s, x) => s + x, 0) / rVals.length : null,
    netPnl: rows.reduce((s, r) => s + r.pnl, 0),
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
  };
}

function table(title: string, groups: Array<[string, Row[]]>): string {
  const L: string[] = [`\n${title}`];
  L.push("  group                        n    WR%   [95% CI]        breakEv%   avgWin  avgLoss    expR      netP&L      PF");
  for (const [name, rows] of groups) {
    if (!rows.length) { L.push(`  ${name.padEnd(26)}   0`); continue; }
    const s = stats(rows);
    const f = (x: string | number, w: number) => String(x).padStart(w);
    L.push(
      `  ${name.padEnd(26)} ${f(s.n, 4)}  ${f((s.wr * 100).toFixed(1), 5)}  [${f((s.wrLo * 100).toFixed(1), 4)}-${f((s.wrHi * 100).toFixed(1), 4)}] ` +
      `${f((s.breakevenWR * 100).toFixed(1), 8)} ${f(s.avgWin.toFixed(0), 8)} ${f(s.avgLoss.toFixed(0), 8)} ` +
      `${f(s.expectancyR == null ? "—" : s.expectancyR.toFixed(2), 6)} ${f(Math.round(s.netPnl), 11)} ${f(s.pf === Infinity ? "inf" : s.pf.toFixed(2), 6)}`
    );
  }
  return L.join("\n");
}

async function main() {
  const ledger = await loadLedger();
  const candidates = await loadCandidates();
  const all = [...ledger, ...candidates];

  console.log("══════════ VETO REPLAY — source-stratified ══════════");
  console.log(`ledger closed trades: ${ledger.length} | resolved candidates: ${candidates.length}`);
  console.log(`veto config: minOptionRR ${GATE_CONFIG.minOptionRR} | minConfidence ${GATE_CONFIG.minConfidence} | minAbsDelta ${GATE_CONFIG.minAbsDelta} | maxOtmSteps ${GATE_CONFIG.maxOtmSteps}`);

  // 1) per source × verdict
  const sources = [...new Set(all.map((r) => r.source))].sort();
  for (const src of sources) {
    const rows = all.filter((r) => r.source === src);
    const v = rows.map((r) => ({ r, v: verdictFor(r) }));
    const groups: Array<[string, Row[]]> = [];
    for (const verdict of ["PASS", "WARN", "BLOCK"] as const) {
      groups.push([`${src} · ${verdict}`, v.filter((x) => x.v.verdict === verdict).map((x) => x.r)]);
    }
    groups.push([`${src} · ALL`, rows]);
    console.log(table(`SOURCE: ${src}`, groups));
    // why were they blocked? (quality signal vs missing data)
    const reasons = new Map<string, number>();
    for (const x of v.filter((x) => x.v.hardFail)) {
      for (const r of x.v.fails) reasons.set(r.split(" (")[0], (reasons.get(r.split(" (")[0]) || 0) + 1);
    }
    if (reasons.size) {
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(" | ");
      console.log(`     HARD block reasons: ${top}`);
    }
  }

  // 2) does the separation survive stratification / placeholder removal?
  console.log("\n────────── SEPARATION CHECK (is the veto real or a data-completeness proxy?) ──────────");
  const allV = all.map((r) => ({ r, v: verdictFor(r) }));
  const sep = (rows: typeof allV) => {
    const pass = rows.filter((x) => x.v.verdict === "PASS" || x.v.verdict === "WARN");
    const block = rows.filter((x) => x.v.verdict === "BLOCK");
    return { pass: stats(pass.map((x) => x.r)), block: stats(block.map((x) => x.r)) };
  };
  const raw = sep(allV);
  const noPlaceholder = sep(allV.filter((x) => !x.r.placeholder));
  const confOnly = sep(allV.filter((x) => x.r.confidence > 0));
  const perSource = sources.map((src) => {
    const s = sep(allV.filter((x) => x.r.source === src));
    return { src, ...s };
  });
  console.log(`  raw            PASS/WARN n=${raw.pass.n} WR ${(raw.pass.wr * 100).toFixed(1)}% net ${Math.round(raw.pass.netPnl)} | BLOCK n=${raw.block.n} WR ${(raw.block.wr * 100).toFixed(1)}% net ${Math.round(raw.block.netPnl)}`);
  console.log(`  no placeholders PASS/WARN n=${noPlaceholder.pass.n} WR ${(noPlaceholder.pass.wr * 100).toFixed(1)}% net ${Math.round(noPlaceholder.pass.netPnl)} | BLOCK n=${noPlaceholder.block.n} WR ${(noPlaceholder.block.wr * 100).toFixed(1)}% net ${Math.round(noPlaceholder.block.netPnl)}`);
  console.log(`  confidence>0   PASS/WARN n=${confOnly.pass.n} WR ${(confOnly.pass.wr * 100).toFixed(1)}% net ${Math.round(confOnly.pass.netPnl)} | BLOCK n=${confOnly.block.n} WR ${(confOnly.block.wr * 100).toFixed(1)}% net ${Math.round(confOnly.block.netPnl)}`);
  const persrc = perSource.filter((x) => x.pass.n >= 5 && x.block.n >= 3);
  const sepSurvives = persrc.filter((x) => x.pass.wr > x.block.wr).length;
  console.log(`  per-source (≥5 pass / ≥3 block): ${sepSurvives}/${persrc.length} sources keep PASS>BLOCK win-rate ordering`);
  if (persrc.length) {
    for (const x of persrc) console.log(`    ${x.src.padEnd(16)} PASS/WARN WR ${(x.pass.wr * 100).toFixed(1)}% (n=${x.pass.n}) | BLOCK WR ${(x.block.wr * 100).toFixed(1)}% (n=${x.block.n})`);
  } else {
    console.log("    (no source has enough PASS and BLOCK samples to stratify)");
  }

  // 3) time split — first 70% by date (tune), last 30% (report)
  const dates = [...new Set(all.map((r) => r.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.7)] || dates[dates.length - 1];
  const isRow = allV.filter((x) => x.r.date <= cut);
  const oos = allV.filter((x) => x.r.date > cut);
  console.log(`\n────────── TIME SPLIT (in-sample ≤ ${cut} | out-of-sample > ${cut}) ──────────`);
  console.log(table("IN-SAMPLE (first 70% by date — where rules may be read)", [
    ["IS PASS/WARN", isRow.filter((x) => x.v.verdict !== "BLOCK").map((x) => x.r)],
    ["IS BLOCK", isRow.filter((x) => x.v.verdict === "BLOCK").map((x) => x.r)],
  ]));
  console.log(table("OUT-OF-SAMPLE (last 30% — report only)", [
    ["OOS PASS/WARN", oos.filter((x) => x.v.verdict !== "BLOCK").map((x) => x.r)],
    ["OOS BLOCK", oos.filter((x) => x.v.verdict === "BLOCK").map((x) => x.r)],
  ]));

  // 3b) RELIABILITY TABLE — stated confidence band → realised WR, n, expectancy R
  const samples: CalibrationSample[] = all.map((r) => ({
    stated: r.confidence,
    won: r.pnl > 0,
    r: r.r,
  }));
  const rel = reliabilityTable(samples);
  console.log("\n────────── RELIABILITY (stated band → realised) ──────────");
  console.log("  band        n     wins    WR%    expR     note");
  for (const b of rel) {
    const note = b.n === 0 ? "no history" : b.n < 20 ? "too few for calibration" : b.realizedWR < 0.65 ? "BELOW the 65 floor" : "usable";
    console.log(`  ${b.band.padEnd(9)} ${String(b.n).padStart(5)} ${String(b.wins).padStart(7)} ${(b.realizedWR * 100).toFixed(1).padStart(7)} ${(b.expectancyR == null ? "—" : b.expectancyR.toFixed(2)).padStart(8)}   ${note}`);
  }
  console.log("  NOTE: expectancy R needs RESOLVED candidates (candidate_log). Rows are only");
  console.log("        resolved once the resolver job has simulated them — currently 0.");

  // 4) would-block precision / recall on the OOS slice
  const oosRows = oos.map((x) => x.r);
  const blocked = oosRows.filter((r) => verdictFor(r).verdict === "BLOCK");
  const losers = oosRows.filter((r) => r.pnl < 0);
  const blockedLosers = blocked.filter((r) => r.pnl < 0).length;
  const blockedTotal = blocked.length;
  const recall = losers.length ? blockedLosers / losers.length : 0;
  const precision = blockedTotal ? blockedLosers / blockedTotal : 0;
  console.log(`\n  OOS would-block precision: ${blockedTotal ? (precision * 100).toFixed(1) : "—"}% of blocked rows lost money (n=${blockedTotal})`);
  console.log(`  OOS would-block recall:    ${losers.length ? (recall * 100).toFixed(1) : "—"}% of losing rows were blocked (n=${losers.length} losers)`);

  if (JSON_OUT) {
    const payload = {
      generatedAt: new Date().toISOString(),
      counts: { ledger: ledger.length, candidates: candidates.length },
      bySource: Object.fromEntries(sources.map((s) => [s, stats(all.filter((r) => r.source === s))])),
      separation: { raw, noPlaceholder, confOnly },
      timeSplit: { cut, inSample: stats(isRow.map((x) => x.r)), outOfSample: stats(oos.map((x) => x.r)) },
    };
    await (await import("fs/promises")).writeFile(JSON_OUT, JSON.stringify(payload, null, 2));
    console.log(`\n  wrote ${JSON_OUT}`);
  }
}

if (import.meta.main) await main();
