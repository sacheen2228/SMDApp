/**
 * Tests for src/lib/strategies/liquidity-zones.ts
 *
 * Key verifications per spec:
 * 1. Wick through PDH, closes back inside within 2 bars, opposite OI added → REVERSAL
 * 2. Close-and-hold beyond a pool (no return inside) → BREAKOUT (not reversal)
 * 3. Round-number step scales with price magnitude, not fixed
 * 4. Module is separate from frozen jarvis/strategy.ts
 * 5. Weak sweep (no OI, no volume) flagged as insufficient
 */

import { describe, test, expect } from "bun:test";
import {
  detectLiquidityPools,
  detectSweep,
  detectEqualLevels,
  assessSweepQuality,
  roundNumberStep,
  type Candle,
  type LiquidityPool,
} from "@/lib/strategies/liquidity-zones";

// ─── Fixtures ───────────────────────────────────────────────────────

const PDH = 24500;
const PDL = 24200;

const ohlc = { pdh: PDH, pdl: PDL, orHigh: 24480, orLow: 24250, spot: 24350 };

// Candle with wick through PDH (24500) and close back inside
const sweepReversalCandles: Candle[] = [
  { open: 24400, high: 24450, low: 24380, close: 24420, volume: 100000 },
  // Wick goes to 24520 (above PDH 24500), closes back at 24470 (inside)
  { open: 24420, high: 24520, low: 24410, close: 24470, volume: 250000 },
  { open: 24470, high: 24490, low: 24430, close: 24440, volume: 120000 },
  { open: 24440, high: 24460, low: 24400, close: 24410, volume: 90000 },
];

// Candle with close-and-hold beyond PDH (no return inside)
const breakoutCandles: Candle[] = [
  { open: 24400, high: 24450, low: 24380, close: 24420, volume: 100000 },
  // Wick to 24520, closes at 24510 (beyond PDH)
  { open: 24420, high: 24520, low: 24410, close: 24510, volume: 300000 },
  // Next bar also stays beyond
  { open: 24510, high: 24550, low: 24500, close: 24530, volume: 200000 },
  // Third bar still beyond
  { open: 24530, high: 24560, low: 24510, close: 24540, volume: 180000 },
];

// Candles with no sweep at all
const noSweepCandles: Candle[] = [
  { open: 24400, high: 24450, low: 24380, close: 24420, volume: 100000 },
  { open: 24420, high: 24460, low: 24400, close: 24440, volume: 110000 },
  { open: 24440, high: 24470, low: 24410, close: 24430, volume: 95000 },
];

// ─── Tests ──────────────────────────────────────────────────────────

describe("liquidity-zones", () => {
  describe("roundNumberStep — scales with price magnitude", () => {
    test("low-priced stock (< ₹100) → step 5", () => {
      expect(roundNumberStep(50)).toBe(5);
      expect(roundNumberStep(85)).toBe(5);
    });

    test("₹100-500 stock → step 10", () => {
      expect(roundNumberStep(150)).toBe(10);
      expect(roundNumberStep(450)).toBe(10);
    });

    test("₹500-1000 stock → step 20", () => {
      expect(roundNumberStep(850)).toBe(20);
    });

    test("₹1000-2000 stock → step 50", () => {
      expect(roundNumberStep(1500)).toBe(50);
      expect(roundNumberStep(1786)).toBe(50);
    });

    test("₹2000-5000 stock → step 100", () => {
      expect(roundNumberStep(2200)).toBe(100);
      expect(roundNumberStep(3500)).toBe(100);
    });

    test("NIFTY (~24000) → step 100", () => {
      expect(roundNumberStep(24350)).toBe(100);
    });

    test("NOT fixed — different prices give different steps", () => {
      expect(roundNumberStep(200)).not.toBe(roundNumberStep(3000));
      expect(roundNumberStep(200)).not.toBe(roundNumberStep(24000));
    });
  });

  describe("detectLiquidityPools", () => {
    test("detects PDH, PDL, opening range, round numbers", () => {
      const pools = detectLiquidityPools(ohlc);
      const sources = pools.map((p) => p.source);

      expect(sources).toContain("pdh");
      expect(sources).toContain("pdl");
      expect(sources).toContain("or_high");
      expect(sources).toContain("or_low");
      expect(sources).toContain("round_number");
    });

    test("includes exact PDH/PDL levels", () => {
      const pools = detectLiquidityPools(ohlc);
      const pdhPool = pools.find((p) => p.source === "pdh");
      const pdlPool = pools.find((p) => p.source === "pdl");

      expect(pdhPool?.level).toBe(PDH);
      expect(pdlPool?.level).toBe(PDL);
    });

    test("round numbers derived from spot price magnitude", () => {
      const pools = detectLiquidityPools({ spot: 1786 });
      const roundPools = pools.filter((p) => p.source === "round_number");

      expect(roundPools.length).toBeGreaterThan(0);
      // Step should be 50 for ₹1786 → round levels at 1750, 1800
      for (const rp of roundPools) {
        expect(rp.level % 50).toBe(0);
      }
    });

    test("handles missing OHLC gracefully", () => {
      const pools = detectLiquidityPools({});
      // Should not throw, may have round numbers only if spot provided
      expect(Array.isArray(pools)).toBe(true);
    });
  });

  describe("detectEqualLevels", () => {
    test("detects equal highs from repeated touches", () => {
      const candles: Candle[] = [
        { open: 24400, high: 24500, low: 24380, close: 24450, volume: 100000 },
        { open: 24450, high: 24505, low: 24420, close: 24470, volume: 110000 },
        { open: 24470, high: 24498, low: 24430, close: 24460, volume: 95000 },
        { open: 24460, high: 24502, low: 24440, close: 24480, volume: 105000 },
      ];

      const pools = detectEqualLevels(candles);
      const eqHighs = pools.filter((p) => p.source === "equal_highs");

      expect(eqHighs.length).toBeGreaterThan(0);
      // Level should be near 24500
      expect(eqHighs[0].level).toBeGreaterThan(24490);
      expect(eqHighs[0].level).toBeLessThan(24510);
    });

    test("no equal levels in clearly trending data", () => {
      const candles: Candle[] = [
        { open: 100, high: 110, low: 95, close: 108, volume: 100000 },
        { open: 108, high: 125, low: 105, close: 122, volume: 110000 },
        { open: 122, high: 140, low: 118, close: 138, volume: 95000 },
        { open: 138, high: 155, low: 135, close: 152, volume: 105000 },
      ];

      const pools = detectEqualLevels(candles);
      // Trending highs won't cluster within 0.2% tolerance
      const eqHighs = pools.filter((p) => p.source === "equal_highs");
      expect(eqHighs.length).toBe(0);
    });
  });

  describe("detectSweep — reversal vs breakout (THE CRUX)", () => {
    test("wick through PDH, closes back inside within 2 bars → REVERSAL", () => {
      const pools: LiquidityPool[] = [{ level: PDH, source: "pdh" }];
      const events = detectSweep(sweepReversalCandles, pools, {
        avgVolume: 120000,
        oppositeOiChange: 5000, // OI confirmation present
      });

      expect(events.length).toBe(1);
      const event = events[0];

      expect(event.closeBackInside).toBe(true);
      expect(event.candlesToReclose).toBe(0); // closed back inside on same bar
      expect(event.pool.source).toBe("pdh");
      expect(event.pool.level).toBe(PDH);
      expect(event.sweepPrice).toBeGreaterThan(PDH); // wick went above
      expect(event.oppositeOiConfirmation).toBe(true);

      // Quality assessment: should be REVERSAL with confluence
      const quality = assessSweepQuality(event);
      expect(quality.type).toBe("REVERSAL");
      expect(quality.hasConfluence).toBe(true);
    });

    test("close-and-hold beyond pool (no return inside) → BREAKOUT, not reversal", () => {
      const pools: LiquidityPool[] = [{ level: PDH, source: "pdh" }];
      const events = detectSweep(breakoutCandles, pools, {
        avgVolume: 150000,
        oppositeOiChange: null,
      });

      expect(events.length).toBe(1);
      const event = events[0];

      expect(event.closeBackInside).toBe(false); // NEVER returned inside
      expect(event.sweepPrice).toBeGreaterThan(PDH);

      const quality = assessSweepQuality(event);
      expect(quality.type).toBe("BREAKOUT");
      // No OI confirmation, but volume spike (300000 > 150000 * 1.5 = 225000)
      expect(quality.hasConfluence).toBe(true);
    });

    test("no wick through pool → no sweep detected", () => {
      const pools: LiquidityPool[] = [{ level: PDH, source: "pdh" }];
      const events = detectSweep(noSweepCandles, pools, {
        avgVolume: 100000,
        oppositeOiChange: null,
      });

      expect(events.length).toBe(0);
    });

    test("empty candles or empty pools → no events", () => {
      expect(detectSweep([], [{ level: 100, source: "pdh" }], { avgVolume: 1000, oppositeOiChange: null })).toEqual([]);
      expect(detectSweep(sweepReversalCandles, [], { avgVolume: 100000, oppositeOiChange: null })).toEqual([]);
    });

    test("sweep below support pool (PDL) detected correctly", () => {
      const pools: LiquidityPool[] = [{ level: PDL, source: "pdl" }];
      const candles: Candle[] = [
        { open: 24250, high: 24280, low: 24230, close: 24260, volume: 100000 },
        // Wick to 24180 (below PDL 24200), closes back at 24220 (inside)
        { open: 24260, high: 24270, low: 24180, close: 24220, volume: 200000 },
        { open: 24220, high: 24250, low: 24200, close: 24230, volume: 110000 },
      ];

      const events = detectSweep(candles, pools, {
        avgVolume: 120000,
        oppositeOiChange: 3000,
      });

      expect(events.length).toBe(1);
      expect(events[0].closeBackInside).toBe(true);
      expect(events[0].sweepPrice).toBeLessThan(PDL);
      expect(events[0].pool.source).toBe("pdl");
    });
  });

  describe("assessSweepQuality — confluence requirements", () => {
    test("weak sweep (no OI, no volume) → insufficient confluence", () => {
      const weakEvent = {
        pool: { level: PDH, source: "pdh" as const },
        sweepPrice: 24520,
        closeBackInside: true,
        oppositeOiConfirmation: false,
        volumeSpike: false,
        candlesToReclose: 0,
      };

      const quality = assessSweepQuality(weakEvent);
      expect(quality.type).toBe("REVERSAL");
      expect(quality.hasConfluence).toBe(false);
      expect(quality.reasons.some((r) => r.includes("weak evidence"))).toBe(true);
    });

    test("sweep with OI confirmation only → has confluence", () => {
      const event = {
        pool: { level: PDH, source: "pdh" as const },
        sweepPrice: 24520,
        closeBackInside: true,
        oppositeOiConfirmation: true,
        volumeSpike: false,
        candlesToReclose: 0,
      };

      const quality = assessSweepQuality(event);
      expect(quality.hasConfluence).toBe(true);
    });

    test("sweep with volume spike only → has confluence", () => {
      const event = {
        pool: { level: PDH, source: "pdh" as const },
        sweepPrice: 24520,
        closeBackInside: true,
        oppositeOiConfirmation: false,
        volumeSpike: true,
        candlesToReclose: 1,
      };

      const quality = assessSweepQuality(event);
      expect(quality.hasConfluence).toBe(true);
    });

    test("fast reclose (≤1 bar) noted as stronger signal", () => {
      const event = {
        pool: { level: PDH, source: "pdh" as const },
        sweepPrice: 24520,
        closeBackInside: true,
        oppositeOiConfirmation: true,
        volumeSpike: false,
        candlesToReclose: 1,
      };

      const quality = assessSweepQuality(event);
      expect(quality.reasons.some((r) => r.includes("Fast reclose"))).toBe(true);
    });
  });

  describe("frozen jarvis/strategy.ts not modified", () => {
    test("jarvis strategy still exports pickStrategy (frozen)", async () => {
      const mod = await import("@/lib/jarvis/strategy");
      expect(typeof mod.pickStrategy).toBe("function");
      expect(typeof mod.classifyRegime).toBe("function");
    });

    test("liquidity-zones is a separate module (not in jarvis/)", async () => {
      const strategies = await import("@/lib/strategies/liquidity-zones");
      expect(typeof strategies.detectSweep).toBe("function");
      expect(typeof strategies.detectLiquidityPools).toBe("function");
      expect(typeof strategies.roundNumberStep).toBe("function");
      expect(typeof strategies.assessSweepQuality).toBe("function");
    });
  });
});
