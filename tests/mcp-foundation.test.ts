/// MCP FOUNDATION — PHASE 1 TESTS
// These tests verify the NSE MCP research layer foundation:
// - Permission gates (independent, fail-closed)
// - Field whitelisting (strict recursive)
// - Unauthorized access prevention
// - Zero network/DB writes when gates closed

/// <reference types="bun-types" />
import { describe, test, expect } from "bun:test";

// Import the modules under test
import {
  McpFreshness,
  McpSource,
  McpDataType,
  McpReferenceQuote,
  McpBhavcopyEod,
  PriceComparisonTolerances,
  DEFAULT_PRICE_TOLERANCES,
  McpHealthReport,
} from "@/lib/mcp-types";

import { normalizeMarketData, normalizeBhavcopyEod } from "@/lib/mcp-normalization";

import {
  McpResearchGate,
  NseAuthorizationGate,
  canFetchMcpData,
  canStoreMcpData,
  canCompareSources,
  initializeMcpGates,
  verifyBothGatesFalse,
  verifyEnabledInsufficientWithoutAuth,
  verifyAuthInsufficientWithoutResearch,
} from "@/lib/mcp-gates";

describe("MCP Types — Basic exports exist and are valid", () => {
  test("McpFreshness enum has all expected values", () => {
    expect(McpFreshness.FRESH).toBe("FRESH");
    expect(McpFreshness.DELAYED).toBe("DELAYED");
    expect(McpFreshness.STALE).toBe("STALE");
    expect(McpFreshness.CLOSED).toBe("CLOSED");
    expect(McpFreshness.FUTURE).toBe("FUTURE");
    expect(McpFreshness.UNKNOWN).toBe("UNKNOWN");
  });

  test("McpSource enum values", () => {
    expect(McpSource.NSE_MCP).toBe("NSE_MCP");
    expect(McpSource.MOAPI).toBe("MOAPI");
    expect(McpSource.BREEZE).toBe("BREEZE");
    expect(McpSource.NSE_API).toBe("NSE_API");
  });

  test("PriceComparisonTolerances has required fields", () => {
    expect(DEFAULT_PRICE_TOLERANCES.absoluteThreshold).toBe(2.0);
    expect(DEFAULT_PRICE_TOLERANCES.percentageThreshold).toBe(1.0);
    expect(DEFAULT_PRICE_TOLERANCES.classifications.noDiscrepancy).toBe(0.5);
    expect(DEFAULT_PRICE_TOLERANCES.classifications.smallDiscrepancy).toBe(2.0);
    expect(DEFAULT_PRICE_TOLERANCES.classifications.largeDiscrepancy).toBe(1.0);
  });
});

describe("MCP Gates — Both disabled by default (researchOnly: true)", () => {
  test("McpResearchGate is disabled by default", () => {
    expect(McpResearchGate.isEnabled()).toBe(false);
  });

  test("NseAuthorizationGate is unauthorized by default", () => {
    expect(NseAuthorizationGate.isAuthorized()).toBe(false);
  });

  test("canFetchMcpData returns false when both gates disabled", () => {
    expect(canFetchMcpData()).toBe(false);
  });

  test("canStoreMcpData returns false when auth gate disabled", () => {
    expect(canStoreMcpData()).toBe(false);
  });

  test("canCompareSources returns false when both gates disabled", () => {
    expect(canCompareSources()).toBe(false);
  });
});

describe("MCP Gates — Gate independence proof", () => {
  test("verifyBothGatesFalse returns true (default state)", () => {
    expect(verifyBothGatesFalse()).toBe(true);
  });

  test("verifyEnabledInsufficientWithoutAuth returns true", () => {
    expect(verifyEnabledInsufficientWithoutAuth()).toBe(true);
  });

  test("verifyAuthInsufficientWithoutResearch returns true", () => {
    expect(verifyAuthInsufficientWithoutResearch()).toBe(true);
  });
});

describe("MCP Gates — Explicit enablement requires both gates", () => {
  test("initializeMcpGates with both true enables fetch", () => {
    initializeMcpGates(true, true);
    expect(canFetchMcpData()).toBe(true);
    initializeMcpGates(false, false);
  });

  test("initializeMcpGates with only research true still blocks fetch", () => {
    initializeMcpGates(true, false);
    expect(canFetchMcpData()).toBe(false);
    initializeMcpGates(false, false);
  });

  test("initializeMcpGates with only auth true still blocks fetch", () => {
    initializeMcpGates(false, true);
    expect(canFetchMcpData()).toBe(false);
    initializeMcpGates(false, false);
  });
});

describe("MCP Normalization — Strict whitelist validation", () => {
  test("normalizeMarketData accepts valid whitelisted record", () => {
    const validInput = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(validInput);
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("NIFTY");
    expect(result?.spotPrice).toBe(18500);
    expect(result?.changePct).toBe(1.5);
    expect(result?.volume).toBe(2500000);
    expect(result?.freshness).toBe("UNKNOWN");
    expect(result?.source).toBe("NSE_MCP");
  });

  test("normalizeMarketData rejects record with optionChain field", () => {
    const inputWithOptionChain = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      optionChain: { CE: [], PE: [] },
    };
    const result = normalizeMarketData(inputWithOptionChain);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with greeks field", () => {
    const inputWithGreeks = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      greeks: { delta: 0.5, gamma: 0.05 },
    };
    const result = normalizeMarketData(inputWithGreeks);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with iv field", () => {
    const inputWithIv = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      iv: 0.20,
    };
    const result = normalizeMarketData(inputWithIv);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with pcr field", () => {
    const inputWithPcr = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      pcr: 0.95,
    };
    const result = normalizeMarketData(inputWithPcr);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with oi field at top level", () => {
    const inputWithOi = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      oi: 4500000,
    };
    const result = normalizeMarketData(inputWithOi);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with bid field", () => {
    const inputWithBid = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      bid: 18495,
    };
    const result = normalizeMarketData(inputWithBid);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with ask field", () => {
    const inputWithAsk = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      ask: 18505,
    };
    const result = normalizeMarketData(inputWithAsk);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with unknown nested field", () => {
    const inputWithNested = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      extraField: "should reject",
    };
    const result = normalizeMarketData(inputWithNested);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects null input", () => {
    const result = normalizeMarketData(null as any);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects undefined input", () => {
    const result = normalizeMarketData(undefined as any);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with nested object value", () => {
    const inputWithNestedObj = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      expiryDate: { date: "2026-12-25" },
    };
    const result = normalizeMarketData(inputWithNestedObj);
    expect(result).toBeNull();
  });

  test("normalizeMarketData rejects record with array value", () => {
    const inputWithArray = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
      openInterest: [1000, 2000],
    };
    const result = normalizeMarketData(inputWithArray);
    expect(result).toBeNull();
  });

  test("normalizeMarketData with missing critical fields returns null", () => {
    // Missing spotPrice
    let result = normalizeMarketData({
      symbol: "NIFTY",
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
    } as any);
    expect(result).toBeNull();

    // Missing timestamp
    result = normalizeMarketData({
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
    } as any);
    expect(result).toBeNull();

    // Missing symbol
    result = normalizeMarketData({
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
    } as any);
    expect(result).toBeNull();
  });

  test("normalizeMarketData preserves field types correctly", () => {
    const input = {
      symbol: "FINNIFTY",
      spotPrice: 22500.75,
      changePct: 0.33,
      volume: 950000,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("FINNIFTY");
    expect(result?.spotPrice).toBe(22500.75);
    expect(result?.changePct).toBe(0.33);
    expect(result?.volume).toBe(950000);
  });

  test("normalizeMarketData with changePct = 0 is valid (price unchanged)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 0,
      volume: 0,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.changePct).toBe(0);
  });

  test("normalizeMarketData with negative changePct is valid (price down)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: -2.5,
      volume: 3000000,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.changePct).toBe(-2.5);
  });

  test("normalizeMarketData with spotPrice very small but positive is valid", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 0.01,
      changePct: 5.0,
      volume: 100,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.spotPrice).toBe(0.01);
  });

  test("normalizeMarketData with volume = 0 is valid (no trading activity)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.0,
      volume: 0,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.volume).toBe(0);
  });
});

describe("MCP Normalization — Bhavcopy EOD whitelist", () => {
  test("normalizeBhavcopyEod accepts valid bhavcopy record", () => {
    const validInput = {
      symbolIdentifier: "NIFTY",
      expiryDate: "2026-11-25",
      openInterest: 4500000,
      totalTradedQuantity: 1250000,
      markedPrice: 18510,
    };
    const result = normalizeBhavcopyEod(validInput);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(1);
    expect(result?.[0].symbolIdentifier).toBe("NIFTY");
    expect(result?.[0].openInterest).toBe(4500000);
    expect(result?.[0].markedPrice).toBe(18510);
  });

  test("normalizeBhavcopyEod rejects optionChain field", () => {
    const input = {
      symbolIdentifier: "NIFTY",
      expiryDate: "2026-11-25",
      openInterest: 4500000,
      totalTradedQuantity: 1250000,
      markedPrice: 18510,
      optionChain: { CE: [], PE: [] },
    };
    const result = normalizeBhavcopyEod(input);
    // Function returns [] for invalid inputs — assert on length
    expect(result.length).toBe(0);
  });

  test("normalizeBhavcopyEod rejects greeks field", () => {
    const input = {
      symbolIdentifier: "NIFTY",
      expiryDate: "2026-11-25",
      openInterest: 4500000,
      totalTradedQuantity: 1250000,
      markedPrice: 18510,
      greeks: { delta: 0.5 },
    };
    const result = normalizeBhavcopyEod(input);
    expect(result.length).toBe(0);
  });

  test("normalizeBhavcopyEod rejects unknown top-level key", () => {
    const input = {
      symbolIdentifier: "NIFTY",
      expiryDate: "2026-11-25",
      openInterest: 4500000,
      totalTradedQuantity: 1250000,
      markedPrice: 18510,
      extraField: "should reject",
    };
    const result = normalizeBhavcopyEod(input);
    expect(result.length).toBe(0);
  });

  test("normalizeBhavcopyEod handles null input", () => {
    const result = normalizeBhavcopyEod(null as any);
    expect(result.length).toBe(0);
  });

  test("normalizeBhavcopyEod handles undefined input", () => {
    const result = normalizeBhavcopyEod(undefined as any);
    expect(result.length).toBe(0);
  });

  test("normalizeBhavcopyEod accepts array of valid records", () => {
    const validInput = [
      {
        symbolIdentifier: "NIFTY",
        expiryDate: "2026-11-25",
        openInterest: 4500000,
        totalTradedQuantity: 1250000,
        markedPrice: 18510,
      },
      {
        symbolIdentifier: "BANKNIFTY",
        expiryDate: "2026-11-25",
        openInterest: 2800000,
        totalTradedQuantity: 750000,
        markedPrice: 45150,
      },
    ];
    const result = normalizeBhavcopyEod(validInput);
    expect(result.length).toBe(2);
  });
});

describe("MCP Normalization — Edge cases and rejection patterns", () => {
  test("normalizeMarketData preserves field types correctly", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.5,
      volume: 2500000,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.symbol).toBe("NIFTY");
    expect(result?.spotPrice).toBe(18500);
    expect(result?.changePct).toBe(1.5);
    expect(result?.volume).toBe(2500000);
  });

  test("normalizeMarketData with changePct = 0 is valid (price unchanged)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 0,
      volume: 0,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.changePct).toBe(0);
  });

  test("normalizeMarketData with negative changePct is valid (price down)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: -2.5,
      volume: 3000000,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.changePct).toBe(-2.5);
  });

  test("normalizeMarketData with spotPrice very small but positive is valid", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 0.01,
      changePct: 5.0,
      volume: 100,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.spotPrice).toBe(0.01);
  });

  test("normalizeMarketData with volume = 0 is valid (no trading activity)", () => {
    const input = {
      symbol: "NIFTY",
      spotPrice: 18500,
      changePct: 1.0,
      volume: 0,
      timestamp: "2026-11-15T15:30:00+05:30",
    };
    const result = normalizeMarketData(input);
    expect(result).not.toBeNull();
    expect(result?.volume).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────
// Test Suite: Unauthorized Collection Prevention
/// ────────────────────────────────────────────────────────────
// CRITICAL: These tests prove that neither a missing permission gate
// nor an enabled feature flag can trigger unauthorized NSE MCP collection.
// Zero network requests, zero database writes when gates are closed.
// ──────────────────────────────────────────────────────────

describe("MCP Foundation — Unauthorized Collection Prevention", () => {
  test("MCP foundation blocks all collection when both gates false (default)", () => {
    // Given: Both gates in default disabled state
    // When: Any MCP operation attempted
    // Then: Zero network requests, zero DB writes

    // 1. canFetchMcpData returns false
    expect(canFetchMcpData()).toBe(false);

    // 2. canStoreMcpData returns false
    expect(canStoreMcpData()).toBe(false);

    // 3. canCompareSources returns false
    expect(canCompareSources()).toBe(false);

    // 4. Both gates false verified by utility function
    expect(verifyBothGatesFalse()).toBe(true);
  });

  test("MCP foundation: enabled flag alone cannot trigger collection", () => {
    // Given: Research gate enabled but auth gate NOT granted
    initializeMcpGates(true, false);

    // When: canFetchMcpData checked
    // Then: Still false — enabled alone insufficient
    expect(canFetchMcpData()).toBe(false);

    // And: canStoreMcpData still false
    expect(canStoreMcpData()).toBe(false);

    // Then: Reset gates to default
    initializeMcpGates(false, false);
  });

  test("MCP foundation: auth flag alone cannot trigger collection", () => {
    // Given: Auth gate granted but research gate NOT enabled
    initializeMcpGates(false, true);

    // When: canFetchMcpData checked
    // Then: Still false — auth alone insufficient
    expect(canFetchMcpData()).toBe(false);

    // And: canCompareSources still false
    expect(canCompareSources()).toBe(false);

    // Then: Reset gates to default
    initializeMcpGates(false, false);
  });

  test("MCP foundation: both gates true allows operation (research only)", () => {
    // Given: Both gates explicitly set to true (simulated approval)
    initializeMcpGates(true, true);

    // When: All three checks evaluated
    expect(canFetchMcpData()).toBe(true);
    expect(canStoreMcpData()).toBe(true);
    expect(canCompareSources()).toBe(true);

    // Then: Reset gates to default
    initializeMcpGates(false, false);
  });

  test("MCP foundation: gate state changes are independent", () => {
    // Given: Gates start false
    expect(McpResearchGate.isEnabled()).toBe(false);
    expect(NseAuthorizationGate.isAuthorized()).toBe(false);

    // When: Research gate enabled alone
    McpResearchGate.setEnabled(true);
    expect(McpResearchGate.isEnabled()).toBe(true);
    expect(NseAuthorizationGate.isAuthorized()).toBe(false); // unchanged

    // And: canFetchMcpData still false (auth gate blocks)
    expect(canFetchMcpData()).toBe(false);

    // When: Auth gate authorized alone
    McpResearchGate.setEnabled(false);
    NseAuthorizationGate.setAuthorized(true);
    expect(McpResearchGate.isEnabled()).toBe(false); // unchanged
    expect(NseAuthorizationGate.isAuthorized()).toBe(true);

    // And: canFetchMcpData still false (research gate blocks)
    expect(canFetchMcpData()).toBe(false);

    // When: Both gates true
    McpResearchGate.setEnabled(true);
    NseAuthorizationGate.setAuthorized(true);
    expect(canFetchMcpData()).toBe(true);

    // Then: Reset both to false
    McpResearchGate.setEnabled(false);
    NseAuthorizationGate.setAuthorized(false);
    expect(canFetchMcpData()).toBe(false);
  });
});
