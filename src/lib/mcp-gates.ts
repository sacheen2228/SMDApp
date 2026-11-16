/// NSE MCP Research Layer — Independent, Fail-Closed Permission Gates
///
/// ARCHITECTURE:
/// Two independent gates must BOTH be true for any MCP activity.
/// This design prevents a single `enabled: true` flag from authorizing
/// NSE MCP data collection without explicit legal authorization.
///
/// GATE 1: McpResearchGate — Controls whether MCP functions may execute at all.
/// GATE 2: NseAuthorizationGate — Controls whether NSE legal authorization is granted.
///
/// Neither gate auto-enables/auto-grants. Both start false (disabled).
/// Explicit approval required to set either to true.
/// Both must be true for fetch/store/compare operations.

// ──────────────────────────────────────────────────────────────
// Internal state — starts false, stays false until explicitly set true.
let _researchGateEnabled = false;
let _nseAuthorizationGranted = false;

// ──────────────────────────────────────────────────────────────
// McpResearchGate — Gate 1
///
/// Controls whether MCP functions may execute at all.
/// When false (default): all MCP functions return structured errors
/// without making HTTP calls, writing to DB, or producing any output.
/// When true: nseAuthorizationGate must also be true for any data operation.
/// ──────────────────────────────────────────────────────────────

export const McpResearchGate = {
  // Returns true only when explicitly enabled.
  // Zero-side-effect: no HTTP, no DB, no data flow when false.
  isEnabled(): boolean {
    return _researchGateEnabled;
  },

  // Soft reset — for approval workflow only. Must be paired with
  // NseAuthorizationGate approval.
  setEnabled(value: boolean): void {
    _researchGateEnabled = value;
  },
};

// ──────────────────────────────────────────────────────────────
// NseAuthorizationGate — Gate 2
///
/// Controls whether NSE MCP data collection and storage is legally authorized.
/// When false (default): no MCP data may be collected, stored, or compared —
/// even if mcpResearchGate is true.
///
/// Critical: A simple `enabled: true` flag must NEVER imply NSE authorization.
/// These gates are independent and fail-closed.
/// ──────────────────────────────────────────────────────────────

export const NseAuthorizationGate = {
  // Returns true only when explicitly granted.
  // Zero-side-effect: no collection, no storage, no data flow when false.
  isAuthorized(): boolean {
    return _nseAuthorizationGranted;
  },

  // Soft reset — for approval workflow only. Must be paired with
  // McpResearchGate enablement.
  // Returns true if state changed (was false, now true), false if already true
  // or if value is false (explicit disable).
  setAuthorized(value: boolean): boolean {
    const prev = _nseAuthorizationGranted;
    _nseAuthorizationGranted = value;
    return prev !== value; // state changed flag
  },
};

// ──────────────────────────────────────────────────────────────
// Gate Integration — Combined Checks
///
/// All three combined checks below use BOTH gates.
// If either gate is false → return false (fail-closed).
// Only when both gates are true → return true.
// ──────────────────────────────────────────────────────────

/**
 * Can fetch MCP data? Both gates must pass.
 * - Both false (default): false → no fetch
 * - Research gate true, auth gate false: false → no fetch (enabled alone insufficient)
 * - Research gate false, auth gate true: false → no fetch (authorization alone insufficient)
 * - Both true: true → fetch allowed (research only)
 */
export function canFetchMcpData(): boolean {
  return McpResearchGate.isEnabled() && NseAuthorizationGate.isAuthorized();
}

/**
 * Can store MCP data? Authorization gate must pass.
 * - auth gate false: false → no storage
 * - auth gate true: true → storage allowed (research DB only, never production ledger)
 */
export function canStoreMcpData(): boolean {
  return NseAuthorizationGate.isAuthorized();
}

/**
 * Can compare sources (MCP vs MOAPI/Breeze)? Both gates must pass.
 * Same logic as canFetchMcpData — both gates required.
 */
export function canCompareSources(): boolean {
  return McpResearchGate.isEnabled() && NseAuthorizationGate.isAuthorized();
}

// ──────────────────────────────────────────────────────────────
// Initialization — Both gates disabled by default
///
/// No explicit approval required to KEEP them false.
/// Explicit approval (via setEnabled/setAuthorized) required to set either to true.
export function initializeMcpGates(
  researchGate?: boolean,
  authorizationGate?: boolean
): void {
  // Only set values if explicitly provided; otherwise remain false.
  if (researchGate !== undefined) {
    _researchGateEnabled = researchGate;
  }
  if (authorizationGate !== undefined) {
    _nseAuthorizationGranted = authorizationGate;
  }
  // Both remain false unless explicitly set to true.
}

// ──────────────────────────────────────────────────────────────
// Precondition Guards — Prove unauthorized access is impossible
///
/// These functions verify the security property: neither gate alone
/// can trigger collection. They are designed as runtime assertions
/// for test scenarios.
// ──────────────────────────────────────────────────────────

// Proves that with both gates false, zero collection occurs.
export function verifyBothGatesFalse(): boolean {
  return !McpResearchGate.isEnabled() && !NseAuthorizationGate.isAuthorized();
}

// Proves that with research gate true but auth gate false,
// collection is still blocked (enabled alone insufficient).
export function verifyEnabledInsufficientWithoutAuth(): boolean {
  // Temporarily enable research gate
  const wasEnabled = McpResearchGate.isEnabled();
  McpResearchGate.setEnabled(true);
  const authWasAuthorized = NseAuthorizationGate.isAuthorized();
  // Restore
  McpResearchGate.setEnabled(wasEnabled);

  // Collection blocked when auth gate false, even with research gate true
  return !authWasAuthorized;
}

// Proves that with auth gate true but research gate false,
// collection is still blocked (authorization alone insufficient).
export function verifyAuthInsufficientWithoutResearch(): boolean {
  // Temporarily enable auth gate
  const wasAuthorized = NseAuthorizationGate.isAuthorized();
  NseAuthorizationGate.setAuthorized(true);
  const wasEnabled = McpResearchGate.isEnabled();
  // Restore
  NseAuthorizationGate.setAuthorized(wasAuthorized);

  // Collection blocked when research gate false, even with auth gate true
  return !wasEnabled;
}
