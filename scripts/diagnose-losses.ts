// scripts/diagnose-losses.ts
// WHY do trades lose? Uses the excursion data the audit ledger already records
// (highestPrice / lowestPrice → MFE/MAE) to classify the failure mode of every
// closed trade, then aggregates by strategy, premium bucket, session and time.
//
// Usage: bun scripts/diagnose-losses.ts
import { wilson } from "../src/lib/agent-brain-gate";

interface T {
  id: string; strategy: string; symbol: string; optionType: string | null;
  createdAtIst: string; exitTime: string | null; exitReason: string | null;
  entry: number; stop: number; tp1: number; exit: number;
  highest: number | null; lowest: number | null;
  pnl: number; gross: number; fees: number; rMultiple: number | null;
  mfe: number; mae: number; tp1Hit: boolean; slHit: boolean;
  confidence: number; marketSession: string | null; quantity: number;
  instrumentType: string; trendDirection: string;
}

const LEDGER = process.env.AUDIT_URL || "http://localhost:4001";

async function load(): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${LEDGER}/api/trades?status=closed&page=${page}&pageSize=200`);
    if (!res.ok) break;
    const d: any = await res.json();
    const items: any[] = d.items || [];
    for (const t of items) {
      out.push({
        id: String(t.id), strategy: String(t.strategyId || "?"), symbol: String(t.symbol || ""),
        optionType: t.optionType ?? null, createdAtIst: String(t.createdAtIst || ""),
        exitTime: t.exitTime ?? null, exitReason: t.exitReason ?? null,
        entry: Number(t.entryPrice), stop: Number(t.stopLoss), tp1: Number(t.tp1),
        exit: Number(t.exitPrice ?? t.lastPrice ?? t.entryPrice),
        highest: t.highestPrice ?? null, lowest: t.lowestPrice ?? null,
        pnl: Number(t.netPnl) || 0, gross: Number(t.grossPnl) || 0, fees: Number(t.fees) || 0,
        rMultiple: t.rMultiple ?? null, mfe: Number(t.mfe) || 0, mae: Number(t.mae) || 0,
        tp1Hit: !!t.tp1Hit, slHit: !!t.slHit, confidence: Number(t.signalConfidence) || 0,
        marketSession: t.marketSession ?? null, quantity: Number(t.quantity) || 0,
        instrumentType: String(t.instrumentType || ""), trendDirection: String(t.trendDirection || ""),
      });
    }
    if (items.length < 200 || page * 200 >= (d.total || 0)) break;
  }
  return out;
}

type Mode = "TP1 hit" | "stopped (never went)" | "stopped (went first)" | "profit→loss" | "flat/other";

function mode(t: T): Mode {
  const risk = Math.abs(t.entry - t.stop);
  if (risk <= 0) return "flat/other";
  const mfeR = (t.highest ?? t.entry) - t.entry;
  const maeR = t.entry - (t.lowest ?? t.entry);
  if (t.pnl > 0) return "TP1 hit";
  if (mfeR / risk >= 0.5) return "profit→loss";
  if (maeR / risk >= 0.8) return "stopped (never went)";
  if (t.slHit) return "stopped (went first)";
  return "flat/other";
}

function bucketPremium(p: number): string {
  if (p < 25) return "<₹25 (cheap)";
  if (p < 75) return "₹25-75";
  if (p < 150) return "₹75-150";
  if (p < 300) return "₹150-300";
  if (p < 600) return "₹300-600";
  return "₹600+";
}

function timeBucket(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "?";
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 9 * 60 + 30) return "pre-open/09:30";
  if (mins < 10 * 60) return "09:30-10:00 (first 30m)";
  if (mins < 11 * 60) return "10:00-11:00";
  if (mins < 13 * 60) return "11:00-13:00";
  if (mins < 15 * 60) return "13:00-15:00";
  return "after 15:00";
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function table(title: string, groups: Array<[string, T[]]>) {
  console.log(`\n${title}`);
  console.log("  group                          n     WR%   [95% CI]        net₹       PF   avgMFE_R  avgMAE_R  fees%");
  for (const [name, rows] of groups) {
    if (!rows.length) continue;
    const n = rows.length;
    const wins = rows.filter((r) => r.pnl > 0).length;
    const ci = wilson(wins, n);
    const gp = rows.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
    const gl = Math.abs(rows.filter((r) => r.pnl < 0).reduce((s, r) => s + r.pnl, 0));
    const pf = gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "inf" : "0";
    const avgMfe = rows.reduce((s, r) => s + r.mfe, 0) / n;
    const avgMae = rows.reduce((s, r) => s + r.mae, 0) / n;
    const feeShare = rows.reduce((s, r) => s + r.fees, 0) / Math.max(1, rows.reduce((s, r) => s + Math.abs(r.gross), 0));
    console.log(`  ${name.padEnd(26)} ${String(n).padStart(5)}  ${pct(wins / n).padStart(5)}   [${pct(ci.lo)}-${pct(ci.hi)}]  ${String(Math.round(rows.reduce((s, r) => s + r.pnl, 0))).padStart(10)}  ${pf.padStart(6)}  ${avgMfe.toFixed(1).padStart(8)}  ${avgMae.toFixed(1).padStart(8)}  ${pct(feeShare).padStart(6)}`);
  }
}

async function main() {
  const all = await load();
  console.log(`══════════ LOSS DIAGNOSIS — ${all.length} closed trades ══════════`);

  // 1) failure-mode mix
  const modes = new Map<Mode, T[]>();
  for (const t of all) {
    const m = mode(t);
    modes.set(m, [...(modes.get(m) || []), t]);
  }
  console.log("\nFAILURE MODE MIX (MFE/MAE vs the plan)");
  console.log("  mode                      n     WR%   net₹        avgR");
  for (const [m, rows] of [...modes.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const net = rows.reduce((s, r) => s + r.pnl, 0);
    const avgR = rows.reduce((s, r) => s + (r.rMultiple ?? 0), 0) / rows.length;
    console.log(`  ${m.padEnd(24)} ${String(rows.length).padStart(5)}  ${pct(rows.filter((r) => r.pnl > 0).length / rows.length).padStart(5)}  ${String(Math.round(net)).padStart(9)}  ${avgR.toFixed(2).padStart(6)}`);
  }

  // 2) per strategy
  const strategies = [...new Set(all.map((t) => t.strategy))].sort();
  table("PER STRATEGY", strategies.map((s) => [s, all.filter((t) => t.strategy === s)] as [string, T[]]));

  // 3) premium bucket (cheap options = noise stops?)
  const premB = ["<₹25 (cheap)", "₹25-75", "₹75-150", "₹150-300", "₹300-600", "₹600+"];
  table("BY ENTRY PREMIUM (the stop is a fixed % of premium — noise risk)", premB.map((b) => [b, all.filter((t) => bucketPremium(t.entry) === b)] as [string, T[]]));

  // 4) option chains only (exclude BTST equity noise)
  const opt = all.filter((t) => t.instrumentType === "OPTIONS" || t.optionType);
  table("OPTIONS ONLY", [
    ["all options", opt],
    ...strategies.map((s) => [s, opt.filter((t) => t.strategy === s)] as [string, T[]]),
  ]);

  // 5) time of entry (playbook: don't buy in the first 15 minutes)
  const tb = ["pre-open/09:30", "09:30-10:00 (first 30m)", "10:00-11:00", "11:00-13:00", "13:00-15:00", "after 15:00"];
  table("BY ENTRY TIME", tb.map((b) => [b, opt.filter((t) => timeBucket(t.createdAtIst) === b)] as [string, T[]]));

  // 6) plan geometry: is the stop/target symmetric (R:R ~ 1.0)?
  const rr = opt.map((t) => (t.tp1 - t.entry) / Math.max(1e-9, t.entry - t.stop)).filter((x) => Number.isFinite(x) && x > 0);
  const buckets = [[0.5, 1.05], [1.05, 1.5], [1.5, 2.0], [2.0, 2.5], [2.5, 99]];
  console.log("\nPLAN GEOMETRY (option trades) — symmetric ~1:1 plans need >50% WR after costs");
  console.log("  R:R band            n     WR%   net₹       PF   avgR   break-even%");
  for (const [lo, hi] of buckets) {
    const rows = opt.filter((t) => {
      const r = (t.tp1 - t.entry) / Math.max(1e-9, t.entry - t.stop);
      return r >= lo && r < hi;
    });
    if (!rows.length) continue;
    const gp = rows.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
    const gl = Math.abs(rows.filter((r) => r.pnl < 0).reduce((s, r) => s + r.pnl, 0));
    const avgWin = rows.filter((r) => r.pnl > 0).length ? gp / rows.filter((r) => r.pnl > 0).length : 0;
    const avgLoss = rows.filter((r) => r.pnl < 0).length ? gl / rows.filter((r) => r.pnl < 0).length : 0;
    const be = avgWin + avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0;
    console.log(`  ${`${lo}:${hi}`.padEnd(18)} ${String(rows.length).padStart(5)}  ${pct(rows.filter((r) => r.pnl > 0).length / rows.length).padStart(5)}  ${String(Math.round(rows.reduce((s, r) => s + r.pnl, 0))).padStart(9)}  ${(gl > 0 ? (gp / gl).toFixed(2) : "inf").padStart(6)}  ${(rows.reduce((s, r) => s + (r.rMultiple ?? 0), 0) / rows.length).toFixed(2).padStart(6)}  ${pct(be).padStart(9)}`);
  }

  // 7) the "went up then closed down" bucket — exit logic vs entry timing
  const flip = opt.filter((t) => mode(t) === "profit→loss");
  console.log(`\nPROFIT→LOSS (MFE ≥ 0.5R but closed negative): ${flip.length} option trades, net ₹${Math.round(flip.reduce((s, r) => s + r.pnl, 0))}`);
  console.log("  their exit reasons:", [...new Set(flip.map((t) => t.exitReason))].join(", "));
  const byExit = new Map<string, T[]>();
  for (const t of flip) byExit.set(String(t.exitReason), [...(byExit.get(String(t.exitReason)) || []), t]);
  for (const [k, v] of byExit) console.log(`    ${k.padEnd(14)} n=${String(v.length).padStart(3)} net ₹${Math.round(v.reduce((s, r) => s + r.pnl, 0))}`);

  // 8) cost drag
  const gross = all.reduce((s, t) => s + t.gross, 0);
  const net = all.reduce((s, t) => s + t.pnl, 0);
  const fees = all.reduce((s, t) => s + t.fees, 0);
  console.log(`\nCOST DRAG: gross ₹${Math.round(gross).toLocaleString("en-IN")} → net ₹${Math.round(net).toLocaleString("en-IN")} (fees ₹${Math.round(fees).toLocaleString("en-IN")})`);
}

if (import.meta.main) await main();
