// Jarvis live worker — the ONLY scheduled compute and the ONLY caller of
// AlertSink.send() (Telegram). The /api/jarvis route and the chat command
// only read the signal this worker writes to agent-memory.
//
// Run (systemd user unit `jarvis.service`):
//   bun --env-file=.env run scripts/jarvis-worker.ts
//
// Market-hours gate lives HERE, in the worker's scheduler tick: the loop is
// only started while the market is open (09:15-15:30 IST Mon-Fri), so no
// NSE/Breeze calls happen at all outside hours — the library's own
// isMarketHours() gate inside buildSignal() stays as the second line of
// defense, not the only one.

import { startJarvisLoop } from "../src/lib/jarvis/liveLoop";
import { smdDataSource, smdMemory, smdAlerts, smdNews } from "../src/lib/jarvis-adapters";

const INSTRUMENTS = (process.env.JARVIS_INSTRUMENTS || "NIFTY,BANKNIFTY")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INTERVAL_MS = 60_000;

function isMarketOpenIST(): boolean {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

let stopLoop: (() => void) | null = null;

function schedulerTick() {
  const open = isMarketOpenIST();
  if (open && !stopLoop) {
    console.log(
      `[jarvis-worker] market OPEN — starting live loop (${INSTRUMENTS.join(", ")}, every ${INTERVAL_MS / 1000}s)`
    );
    const handle = startJarvisLoop(
      {
        dataSource: smdDataSource,
        memory: smdMemory,
        alerts: smdAlerts, // sole AlertSink owner — runJarvisCycle sends only High+ confidence with cooldown
        newsProvider: smdNews,
      },
      {
        instruments: INSTRUMENTS,
        intervalMs: INTERVAL_MS,
        // DEFAULT_CONFIG: minScoreToTrade 40, 4-of-9 groups, High confidence
        // to alert, 20-min cooldown. Gates are never bypassed.
        onCycle: (instrument, signal) => {
          console.log(
            `[jarvis-worker] ${instrument} → ${signal.action} bias=${signal.biasScore} conf=${signal.confidence}` +
              `${signal.strategy ? ` ${signal.strategy}` : ""} gates=${signal.gatesFailed.length} source-write=memory`
          );
        },
        onError: (instrument, err) => {
          console.error(`[jarvis-worker] ${instrument} cycle failed:`, err instanceof Error ? err.message : err);
        },
      }
    );
    stopLoop = handle.stop;
  } else if (!open && stopLoop) {
    console.log("[jarvis-worker] market CLOSED — stopping loop (no market data calls off-hours)");
    stopLoop();
    stopLoop = null;
  }
}

console.log(
  `[jarvis-worker] started (pid ${process.pid}) — instruments: ${INSTRUMENTS.join(", ")}` +
    `, market ${isMarketOpenIST() ? "OPEN" : "CLOSED"}`
);
schedulerTick();
setInterval(schedulerTick, INTERVAL_MS);

process.on("SIGTERM", () => {
  if (stopLoop) stopLoop();
  process.exit(0);
});
process.on("SIGINT", () => {
  if (stopLoop) stopLoop();
  process.exit(0);
});
