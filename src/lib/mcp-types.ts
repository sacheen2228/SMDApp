/// NSE MCP Research Layer — Type Definitions
/// All enums and interfaces are pure (no runtime side effects).
/// MCP starts disabled-by-default; gates control all access.

export enum McpFreshness {
  FRESH = "FRESH",
  DELAYED = "DELAYED",
  STALE = "STALE",
  CLOSED = "CLOSED",
  FUTURE = "FUTURE",
  UNKNOWN = "UNKNOWN",
}

export enum McpSource {
  NSE_MCP = "NSE_MCP",
  MOAPI = "MOAPI",
  BREEZE = "BREEZE",
  NSE_API = "NSE_API",
}

export enum McpDataType {
  REFERENCE_QUOTE = "reference_quote",
  BHAVCOPY_EOD = "bhavcopy_eod",
}

export interface PriceComparisonTolerances {
  absoluteThreshold: number; // points (e.g., 2.0)
  percentageThreshold: number; // e.g., 1.0
  classifications: {
    noDiscrepancy: number; // ≤ this many points = NONE
    smallDiscrepancy: number; // > noDiscrepancy and < percentageThreshold = SMALL
    largeDiscrepancy: number; // ≥ percentageThreshold = LARGE
  };
}

export const DEFAULT_PRICE_TOLERANCES: PriceComparisonTolerances = {
  absoluteThreshold: 2.0,
  percentageThreshold: 1.0,
  classifications: {
    noDiscrepancy: 0.5,
    smallDiscrepancy: 2.0,
    largeDiscrepancy: 1.0,
  },
}

export interface McpHealthReport {
  source: McpSource;
  uptimePct: number; // 0 when disabled; calculated when enabled
  avgLatencyMs: number; // 0 when disabled
  errorRatePct: number; // 100 when disabled (all attempts blocked)
  lastSuccess: string; // epoch when disabled; actual timestamp when enabled
  lastFailure: string; // actual timestamp
  recentDiscrepancies: ReadonlyArray<{
    symbol: string;
    discrepancy: "NONE" | "SMALL" | "LARGE" | "MISSING" | "STALE";
  }>;
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  // Research-only metadata — never propagates to production ledger
  researchOnly: true;
}

export interface McpReferenceQuote {
  symbol: string;
  spotPrice: number;
  changePct: number;
  volume: number;
  timestamp: string; // ISO format, IST
  open?: number;
  high?: number;
  low?: number;
  expiryDate?: string; // YYYY-MM-DD
  openInterest?: number;
  totalTradedQuantity?: number;
  markedPrice?: number;
  freshness: McpFreshness;
  source: McpSource;
  collectionTimestamp: string; // when we fetched it
  provenance: {
    collector: "mcp-normalization";
    httpStatus: number;
    cacheKey: string;
    fetchDurationMs: number;
    errorType?: "HTTP_ERROR" | "PARSE_ERROR" | "VALIDATION_ERROR";
  };
}

export interface McpBhavcopyEod {
  symbolIdentifier: string;
  expiryDate: string; // YYYY-MM-DD
  openInterest: number;
  totalTradedQuantity: number;
  markedPrice: number;
  timestamp: string; // EOD timestamp
  freshness: McpFreshness;
  source: McpSource;
  collectionTimestamp: string; // when we fetched it
  provenance: {
    collector: "mcp-normalization";
    httpStatus: number;
    cacheKey: string;
    fetchDurationMs: number;
    errorType?: "HTTP_ERROR" | "PARSE_ERROR" | "VALIDATION_ERROR";
  };
}

// ──────────────────────────────────────────────────────────────
// Gate Interfaces — Two independent, fail-closed gates
// ──────────────────────────────────────────────────────────────

// McpResearchGate controls whether MCP functions may execute at all.
// When false (default), all MCP functions return structured errors
// without making HTTP calls, writing to DB, or producing any output.
// When true, nseAuthorizationGate must also be true for any data operation.

export interface McpResearchGate {
  // Returns true only when research gate is explicitly enabled.
  // Never auto-enables; always fail-closed.
  isEnabled(): boolean;
  // Soft reset — for approval workflow only. Must be paired with
  // nseAuthorizationGate approval.
  setEnabled(value: boolean): void;
}

// NseAuthorizationGate controls whether NSE MCP data collection and storage
// is legally authorized. When false (default), no MCP data may be collected,
// stored, or compared — even if mcpResearchGate is true.
// This gate is independent: setting mcpResearchGate = true without
// nseAuthorizationGate = true does NOT grant access.

export interface NseAuthorizationGate {
  // Returns true only when NSE authorization is explicitly granted.
  // Never auto-grants; always fail-closed.
  isAuthorized(): boolean;
  // Soft reset — for approval workflow only. Must be paired with
  // mcpResearchGate enablement.
  setAuthorized(value: boolean): boolean;
}

// Combined gate check — both must pass for any MCP activity.

export function canFetchMcpData(
  researchGate: McpResearchGate,
  authGate: NseAuthorizationGate
): boolean {
  return researchGate.isEnabled() && authGate.isAuthorized();
}

export function canStoreMcpData(authGate: NseAuthorizationGate): boolean {
  return authGate.isAuthorized();
}

export function canCompareSources(
  researchGate: McpResearchGate,
  authGate: NseAuthorizationGate
): boolean {
  return researchGate.isEnabled() && authGate.isAuthorized();
}

// ──────────────────────────────────────────────────────────────
// Gate Implementations — In-memory, initialized disabled
// ──────────────────────────────────────────────────────────────

let researchGateEnabled = false;
let authGateAuthorized = false;

// Initialize both gates to false (safe defaults — NO explicit approval
// required to keep disabled; explicit approval required to enable)

export function initializeMcpGates(
  researchGate?: boolean,
  authorizationGate?: boolean
): void {
  // Only set values if explicitly provided; otherwise remain false.
  // This is a no-op if called without arguments — gates stay false.
  if (researchGate !== undefined) {
    researchGateEnabled = researchGate;
  }
  if (authorizationGate !== undefined) {
    authGateAuthorized = authorizationGate;
  }
  // Both remain false unless explicitly set to true (approval workflow).
}

// --- McpResearchGate implementation ---

export class McpResearchGateImpl implements McpResearchGate {
  isEnabled(): boolean {
    return researchGateEnabled;
  }

  setEnabled(value: boolean): void {
    researchGateEnabled = value;
  }
}

// --- NseAuthorizationGate implementation ---

export class NseAuthorizationGateImpl implements NseAuthorizationGate {
  isAuthorized(): boolean {
    return authGateAuthorized;
  }

  setAuthorized(value: boolean): boolean {
    const prev = authGateAuthorized;
    authGateAuthorized = value;
    return prev !== value; // return whether state changed
  }
}

// Singleton convenience instances (initialized disabled)

export const mcpResearchGate: McpResearchGate = new McpResearchGateImpl();
export const nseAuthorizationGate: NseAuthorizationGate = new NseAuthorizationGateImpl();

// ──────────────────────────────────────────────────────────────
// Core Validation: Impossible for unauthorized/enabled gate
// to trigger collection. Both gates must be true.
// ──────────────────────────────────────────────────────────────

// When both gates are false (default): zero HTTP, zero DB writes
// When either gate is false: zero HTTP, zero DB writes
// When both gates are true: HTTP fetch + DB write allowed (research only)

// Export types for external use (e.g., tests)
export type { McpFreshness, McpSource, McpDataType, PriceComparisonTolerances };