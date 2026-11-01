import { runQuantBacktest } from "@/lib/quant/quant-backtest";
import type { Candle } from "@/lib/market/canonical";

function engineeredSeries(): Candle[] {
  const N = 300;
  const t0 = Date.parse("2026-10-26T09:15:00+05:30");
  const out: Candle[] = [];
  let close = 20000;
  for (let i = 0; i < N; i++) {
    let step: number;
    if (i < 120) step = 60;               // pure ramp 20000 → 27140
    else if (i < 160) step = -60;         // decline 27140 → 24740
    else step = i % 2 === 0 ? 1 : -1;     // flat tail at ~24740
    const open = close;
    close = close + step;
    out.push({
      timestamp: new Date(t0 + i * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 5000,
    });
  }
  return out;
}

const r = runQuantBacktest({ symbol: "NIFTY", candles: engineeredSeries(), options: { startIdx: 45, capital: 100000 } });
console.log("instrument:", r.instrument, "| candles:", r.totalCandles);
console.log("decisions:", r.decisions.length, "trades:", r.trades.length, "rejected:", r.rejected.length, "openAtEnd:", r.openAtEnd);
for (const d of r.decisions) {
  console.log(`D idx=${d.idx} ${d.verdict} regime=${d.regime} winner=${d.winner} dir=${d.direction} score=${d.score} entry=${d.entry ?? "-"} sl=${d.stopLoss ?? "-"} reason=${(d.blockReason ?? "").slice(0, 60)}`);
}
for (const t of r.trades) {
  console.log(`T idx=${t.idx} ${t.strategy} ${t.direction} entry=${t.entryPrice} sl=${t.stopLoss} tp1=${t.tp1} -> ${t.status} exit=${t.exitPrice} reason=${t.exitReason} exitIdx=${t.exitIdx} gross=${t.grossPnl} costs=${t.estCosts} net=${t.netPnl} events=[${t.events.join(",")}]`);
}
for (const rj of r.rejected.slice(0, 12)) console.log(`R idx=${rj.idx} ${rj.stage}: ${rj.reason.slice(0, 80)}`);
console.log("perf:", JSON.stringify({ n: r.performance.n, wins: r.performance.wins, losses: r.performance.losses, winRate: r.performance.winRate, netPnl: r.performance.netPnl, pf: r.performance.profitFactor, dd: r.performance.maxDrawdown }));
