/// <reference types="bun-types" />
// stock-fo-mode pure helpers: parsing the /api/option-chain response envelope
// (summary lives at data.summary — a top-level read always returned null and
// stock F&O ran chainless), and the options-first direction policy (the mode
// has no real futures-positioning evidence, so directional signals map to
// CE/PE, never futures).

import { describe, it, expect } from "bun:test";
import {
  parseStockChainResponse,
  determineStockFODirection,
} from "@/lib/trade-intelligence/stock-fo-mode";

describe("parseStockChainResponse", () => {
  it("reads summary/strikes from the route's nested data envelope", () => {
    const routeShape = {
      success: true,
      source: "nse-api",
      data: {
        data: [{ strike: 1320, ce: { ltp: 30.4 }, pe: { ltp: 33.2 } }],
        spotPrice: 1321.7,
        selectedExpiry: "27-Oct-2026",
        summary: { spotPrice: 1321.7, pcr: 0.85, atmStrike: 1320 },
        strikes: [{ strike: 1320, ce: { ltp: 30.4, iv: 14.9 }, pe: { ltp: 33.2, iv: 15.1 } }],
      },
    };
    const parsed = parseStockChainResponse(routeShape);
    expect(parsed).not.toBeNull();
    expect(parsed.summary.pcr).toBe(0.85);
    expect(parsed.selectedExpiry).toBe("27-Oct-2026");
    expect(parsed.strikes).toHaveLength(1);
  });

  it("accepts an unwrapped chain object (legacy shape)", () => {
    const parsed = parseStockChainResponse({
      summary: { pcr: 1.2, atmStrike: 2500 },
      strikes: [{ strike: 2500 }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed.summary.pcr).toBe(1.2);
  });

  it("returns null when no summary or strikes exist (honest — no chain)", () => {
    expect(parseStockChainResponse(null)).toBeNull();
    expect(parseStockChainResponse({})).toBeNull();
    expect(parseStockChainResponse({ success: true, data: {} })).toBeNull();
    expect(parseStockChainResponse({ success: false, error: "all providers failed" })).toBeNull();
  });
});

describe("determineStockFODirection", () => {
  it("maps a strong bullish edge to BUY_CE at confidence ≥ 60", () => {
    const r = determineStockFODirection(80, 20);
    expect(r.direction).toBe("BUY_CE");
    expect(r.confidence).toBe(80);
  });

  it("maps a strong bearish edge to BUY_PE at confidence ≥ 60", () => {
    const r = determineStockFODirection(25, 75);
    expect(r.direction).toBe("BUY_PE");
    expect(r.confidence).toBe(75);
  });

  it("stays NO_TRADE below the 60 confidence gate", () => {
    expect(determineStockFODirection(55, 45).direction).toBe("NO_TRADE"); // conf 55 bullish edge
    expect(determineStockFODirection(45, 55).direction).toBe("NO_TRADE"); // conf 55 bearish edge
  });

  it("includes the 60 boundary as a trade", () => {
    // bull/(bull+bear) = 60/100 → exactly 60
    const r = determineStockFODirection(60, 40);
    expect(r.direction).toBe("BUY_CE");
    expect(r.confidence).toBe(60);
  });

  it("returns NO_TRADE with zero confidence when scores are empty", () => {
    expect(determineStockFODirection(0, 0)).toEqual({ direction: "NO_TRADE", confidence: 0 });
  });

  it("never emits LONG/SHORT futures directions (no futures evidence in this mode)", () => {
    expect(determineStockFODirection(95, 5).direction).toBe("BUY_CE");
    expect(determineStockFODirection(5, 95).direction).toBe("BUY_PE");
  });
});
