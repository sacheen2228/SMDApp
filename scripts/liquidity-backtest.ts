/*
 * Liquidity Sweep Backtest — 1-2 day mock simulation
 * Uses synthetic candles (realistic OHLCV) to demonstrate how the
 * liquidity-zones module detects sweeps and generates signals.
 *
 * Run: bun run scripts/liquidity-backtest.ts
 */

import {
  detectLiquidityPools,
  detectSweep,
  detectEqualLevels,
  assessSweepQuality,
  roundNumberStep,
  type Candle,
} from "@/lib/strategies/liquidity-zones";

// ─── Synthetic candle generator (seeded, deterministic) ─────────────

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DayData {
  date: string;
  candles: Candle[]; // 5-min bars, 9:15–15:30 = 75 bars
  pdh: number;
  pdl: number;
  spotOpen: number;
}

function generateDay(
  seed: number,
  date: string,
  prevClose: number,
  pdh: number,
  pdl: number,
  baseVolume: number
): DayData {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let price = prevClose;

  // 75 five-minute bars: 9:15 to 15:30
  for (let i = 0; i < 75; i++) {
    const hour = 9 + Math.floor((15 + i * 5) / 60);
    const min = (15 + i * 5) % 60;
    const drift = (rand() - 0.5) * (prevClose * 0.001); // ±0.1% per bar
    const open = price;
    const close = open + drift;
    const high = Math.max(open, close) + rand() * (prevClose * 0.0005);
    const low = Math.min(open, close) - rand() * (prevClose * 0.0005);
    const volume = Math.round(
      baseVolume * (0.5 + rand() * 1.5) * (i < 10 || i > 65 ? 1.8 : 1)
    );
    candles.push({
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
    price = close;
  }

  return { date, candles, pdh, pdl, spotOpen: prevClose };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Inject specific sweep scenarios into a day ─────────────────────

function injectSweepAt(
  day: DayData,
  barIndex: number,
  poolLevel: number,
  direction: "up" | "down",
  type: "reversal" | "breakout"
): void {
  const bar = day.candles[barIndex];
  if (!bar) return;

  if (direction === "up") {
    // Wick above pool
    bar.high = poolLevel + (day.spotOpen * 0.001);
    if (type === "reversal") {
      bar.close = poolLevel - (day.spotOpen * 0.0008); // close back inside
      bar.open = poolLevel - (day.spotOpen * 0.0015);
      bar.volume = Math.round(bar.volume * 2.5); // volume spike
    } else {
      bar.close = poolLevel + (day.spotOpen * 0.0012); // close beyond
      bar.open = poolLevel - (day.spotOpen * 0.001);
      bar.volume = Math.round(bar.volume * 3.0);
    }
  } else {
    // Wick below pool
    bar.low = poolLevel - (day.spotOpen * 0.001);
    if (type === "reversal") {
      bar.close = poolLevel + (day.spotOpen * 0.0008);
      bar.open = poolLevel + (day.spotOpen * 0.0015);
      bar.volume = Math.round(bar.volume * 2.5);
    } else {
      bar.close = poolLevel - (day.spotOpen * 0.0012);
      bar.open = poolLevel + (day.spotOpen * 0.001);
      bar.volume = Math.round(bar.volume * 3.0);
    }
  }
}

// ─── Run backtest ───────────────────────────────────────────────────

function runBacktest(): void {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  LIQUIDITY SWEEP BACKTEST — 2-Day Mock Simulation  ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Day 1: NIFTY-like (prevClose 24350, PDH 24450, PDL 24250)
  const day1 = generateDay(42, "2026-09-25", 24350, 24450, 24250, 500000);
  const day2 = generateDay(99, "2026-09-26", 24380, 24500, 24300, 600000);

  // Inject scenarios into Day 1
  injectSweepAt(day1, 20, 24450, "up", "reversal"); // PDH sweep → reversal
  injectSweepAt(day1, 45, 24250, "down", "breakout"); // PDL sweep → breakout

  // Inject scenarios into Day 2
  injectSweepAt(day2, 15, 24500, "up", "breakout"); // PDH sweep → breakout
  injectSweepAt(day2, 55, 24300, "down", "reversal"); // PDL sweep → reversal

  // ─── Analysis per day ───
  const results = [day1, day2].map((day) => {
    console.log(`━━━ ${day.date} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  Open: ₹${day.spotOpen}  PDH: ₹${day.pdh}  PDL: ₹${day.pdl}`
    );

    const step = roundNumberStep(day.spotOpen);
    console.log(`  Round-number step: ₹${step} (derived from price ₹${day.spotOpen})`);

    // Detect pools
    const pools = detectLiquidityPools({
      pdh: day.pdh,
      pdl: day.pdl,
      orHigh: Math.max(...day.candles.slice(0, 12).map((c) => c.high)),
      orLow: Math.min(...day.candles.slice(0, 12).map((c) => c.low)),
      spot: day.spotOpen,
    });

    const equalLevels = detectEqualLevels(day.candles);
    const allPools = [...pools, ...equalLevels];

    console.log(`  Liquidity pools detected: ${allPools.length}`);
    for (const p of allPools) {
      console.log(`    • ${p.source}: ₹${p.level}`);
    }

    // Detect sweeps
    const avgVolume =
      day.candles.reduce((s, c) => s + c.volume, 0) / day.candles.length;

    const events = detectSweep(day.candles, allPools, {
      avgVolume,
      oppositeOiChange: 2500, // mock: OI added near strike
    });

    console.log(`  Sweep events detected: ${events.length}`);

    const sweepResults = events.map((ev) => {
      const quality = assessSweepQuality(ev);
      return { ev, quality };
    });

    for (const { ev, quality } of sweepResults) {
      const emoji = quality.type === "REVERSAL" ? "↩️" : "↗️";
      console.log(`    ${emoji} ${quality.type} @ ₹${ev.pool.level} (${ev.pool.source})`);
      console.log(`       sweepPrice: ₹${ev.sweepPrice}`);
      console.log(`       reclose: ${ev.candlesToReclose} bar(s)`);
      console.log(`       OI confirm: ${ev.oppositeOiConfirmation ? "✓" : "✗"}  Vol spike: ${ev.volumeSpike ? "✓" : "✗"}`);
      console.log(`       confluence: ${quality.hasConfluence ? "✓ YES" : "✗ WEAK (no signal)"}`);
      for (const r of quality.reasons) {
        console.log(`         → ${r}`);
      }
    }

    console.log();
    return { day, allPools, sweepResults };
  });

  // ─── Summary ───
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════");

  let totalSweeps = 0;
  let reversals = 0;
  let breakouts = 0;
  let withConfluence = 0;

  for (const r of results) {
    for (const { ev, quality } of r.sweepResults) {
      totalSweeps++;
      if (quality.type === "REVERSAL") reversals++;
      else breakouts++;
      if (quality.hasConfluence) withConfluence++;
    }
  }

  console.log(`  Total sweeps detected:  ${totalSweeps}`);
  console.log(`  Reversal candidates:    ${reversals}`);
  console.log(`  Breakout candidates:    ${breakouts}`);
  console.log(`  With confluence (tradeable): ${withConfluence}`);
  console.log(`  Weak (no signal):       ${totalSweeps - withConfluence}`);
  console.log();

  // ─── Sample trade plan from a reversal signal ───
  const firstReversal = results
    .flatMap((r) => r.sweepResults)
    .find(({ quality }) => quality.type === "REVERSAL" && quality.hasConfluence);

  if (firstReversal) {
    const { ev } = firstReversal;
    const entry = ev.pool.level;
    const sweep = ev.sweepPrice;
    const stopLoss = sweep > entry ? sweep + (entry * 0.002) : sweep - (entry * 0.002);
    const tp1 = entry + (entry - stopLoss) * 1.5;
    const tp2 = entry + (entry - stopLoss) * 2.5;

    console.log("  SAMPLE TRADE PLAN (first reversal signal):");
    console.log(`    Signal:  ${firstReversal.quality.type} at ₹${ev.pool.level} (${ev.pool.source})`);
    console.log(`    Entry:   ₹${round(entry)}`);
    console.log(`    Stop:    ₹${round(stopLoss)}`);
    console.log(`    TP1:     ₹${round(tp1)}  (R:R 1:1.5)`);
    console.log(`    TP2:     ₹${round(tp2)}  (R:R 1:2.5)`);
    console.log(`    Risk:    ${round(((stopLoss - entry) / entry) * 100)}%`);
  }

  console.log();
  console.log("  ⚠️  MOCK DATA — synthetic candles, not real market data.");
  console.log("  ⚠️  This strategy is NEW — needs its own 30-trade expectancy");
  console.log("      review before being trusted. Does NOT inherit index S3 status.");
  console.log();
}

runBacktest();
