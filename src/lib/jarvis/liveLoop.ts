// Continuous "Jarvis" loop. Two ways to run it:
//
// A) Standalone worker (recommended): a small long-running Bun/Node process,
//    separate from your Next.js server, started by its own systemd unit —
//    same pattern your README already uses for `smdapp`. See jarvis.service
//    example in ../../../INTEGRATION.md.
//
// B) Inside Next.js via `instrumentation.ts` (register() hook) if you'd
//    rather not run a second process. Works, but ties the loop's lifetime to
//    the Next.js server process and its restarts.
//
// Either way, call `startJarvisLoop` once with your real adapters.

import type { DataSource, MemorySink, AlertSink, NewsSentimentProvider, Instrument } from "./types";
import { runJarvisCycle, DEFAULT_CONFIG, type JarvisConfig } from "./orchestrator";

export interface LiveLoopOptions {
  instruments: Instrument[];
  intervalMs?: number; // default 60s; NSE data doesn't usefully update faster than ~15-30s and aggressive polling risks IP blocks
  config?: Partial<JarvisConfig>;
  onError?: (instrument: Instrument, err: unknown) => void;
  onCycle?: (instrument: Instrument, signal: Awaited<ReturnType<typeof runJarvisCycle>>) => void;
}

export function startJarvisLoop(
  deps: { dataSource: DataSource; memory: MemorySink; alerts: AlertSink; newsProvider?: NewsSentimentProvider },
  opts: LiveLoopOptions
): { stop: () => void } {
  const interval = opts.intervalMs ?? 60_000;
  const config: JarvisConfig = { ...DEFAULT_CONFIG, ...opts.config };
  let stopped = false;

  async function tick() {
    if (stopped) return;
    for (const instrument of opts.instruments) {
      try {
        const signal = await runJarvisCycle(instrument, deps, config);
        opts.onCycle?.(instrument, signal);
      } catch (err) {
        opts.onError?.(instrument, err);
      }
    }
  }

  const timer = setInterval(tick, interval);
  void tick(); // fire once immediately instead of waiting a full interval
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
