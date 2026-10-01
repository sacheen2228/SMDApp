// Provider Health Manager
// Circuit breaker, cooldown, health tracking for all external providers
// Used by: LLM client, Breeze session, NSE scraper, market data APIs

export type ProviderType = "tokenra" | "groq" | "openrouter" | "ollama" | "breeze" | "nse" | "moapi" | "yahoo";
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type ProviderStatus =
  | "ready"
  | "disabled"
  | "balance_exhausted"
  | "rate_limited"
  | "model_unavailable"
  | "offline"
  | "error"
  | "timeout"
  | "unknown";

export type ErrorClassification =
  | "AUTH"
  | "BALANCE"
  | "RATE_LIMIT"
  | "MODEL_NOT_FOUND"
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER"
  | "BAD_REQUEST"
  | "UNKNOWN";

interface ProviderHealth {
  provider: ProviderType;
  healthy: boolean;
  status: ProviderStatus;
  circuitState: CircuitState;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  cooldownUntil: number;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  lastError: string | null;
  lastErrorType: ErrorClassification | null;
  lastLatencyMs: number | null;
  avgLatencyMs: number;
  latencySamples: number[];
}

interface CooldownConfig {
  baseMs: number;
  maxMs: number;
  multiplier: number;
  maxConsecutiveFailures: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_COOLDOWN: CooldownConfig = {
  baseMs: 5_000,
  maxMs: 300_000, // 5 minutes
  multiplier: 2,
  maxConsecutiveFailures: 5,
  halfOpenMaxAttempts: 1,
};

// Per-provider cooldown configs
const PROVIDER_COOLDOWNS: Partial<Record<ProviderType, Partial<CooldownConfig>>> = {
  tokenra: { baseMs: 30_000, maxMs: 300_000 }, // 30s base, 5min max
  groq: { baseMs: 10_000, maxMs: 120_000 },    // 10s base, 2min max
  openrouter: { baseMs: 30_000, maxMs: 600_000 }, // 30s base, 10min max
  ollama: { baseMs: 5_000, maxMs: 60_000 },     // 5s base, 1min max
  breeze: { baseMs: 60_000, maxMs: 3600_000 },  // 1min base, 1hr max
  nse: { baseMs: 5_000, maxMs: 60_000 },        // 5s base, 1min max
};

class ProviderHealthManager {
  private providers: Map<ProviderType, ProviderHealth> = new Map();
  private static instance: ProviderHealthManager;

  private constructor() {
    // Initialize all providers
    const providers: ProviderType[] = ["tokenra", "groq", "openrouter", "ollama", "breeze", "nse", "moapi", "yahoo"];
    for (const p of providers) {
      this.providers.set(p, this.createInitialHealth(p));
    }
  }

  static getInstance(): ProviderHealthManager {
    if (!ProviderHealthManager.instance) {
      ProviderHealthManager.instance = new ProviderHealthManager();
    }
    return ProviderHealthManager.instance;
  }

  private createInitialHealth(provider: ProviderType): ProviderHealth {
    return {
      provider,
      healthy: true,
      status: "unknown",
      circuitState: "CLOSED",
      lastSuccessAt: null,
      lastFailureAt: null,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastError: null,
      lastErrorType: null,
      lastLatencyMs: null,
      avgLatencyMs: 0,
      latencySamples: [],
    };
  }

  // ─── Classify errors ───────────────────────────────────────────
  classifyError(statusCode: number, body: string): ErrorClassification {
    if (statusCode === 402) return "BALANCE";
    if (statusCode === 429) return "RATE_LIMIT";
    if (statusCode === 404) return "MODEL_NOT_FOUND";
    if (statusCode === 400) return "BAD_REQUEST";
    if (statusCode >= 500) return "SERVER";
    // Check body for specific patterns (before 401/403 since body may indicate balance)
    const lower = body.toLowerCase();
    if (lower.includes("insufficient") || lower.includes("余额不足") || lower.includes("balance") || lower.includes("quota")) return "BALANCE";
    if (lower.includes("rate limit") || lower.includes("429")) return "RATE_LIMIT";
    if (lower.includes("model") && (lower.includes("not found") || lower.includes("unavailable"))) return "MODEL_NOT_FOUND";
    if (lower.includes("timeout") || lower.includes("aborted")) return "TIMEOUT";
    if (lower.includes("network") || lower.includes("fetch failed") || lower.includes("econnrefused")) return "NETWORK";
    if (statusCode === 401 || statusCode === 403) return "AUTH";
    return "UNKNOWN";
  }

  // ─── Record success ────────────────────────────────────────────
  recordSuccess(provider: ProviderType, latencyMs: number): void {
    const h = this.providers.get(provider)!;
    h.lastSuccessAt = Date.now();
    h.consecutiveFailures = 0;
    h.totalSuccesses++;
    h.lastLatencyMs = latencyMs;
    h.lastError = null;
    h.lastErrorType = null;
    h.healthy = true;
    h.status = "ready";

    // A successful call proves the provider is up — close the circuit from
    // ANY state (OPEN/HALF_OPEN → CLOSED) and clear the cooldown, so a
    // manually applied fresh token (Breeze browser-OTP flow) is usable
    // immediately instead of waiting out a 1hr OPEN cooldown.
    h.circuitState = "CLOSED";
    h.cooldownUntil = 0;

    // Track latency (keep last 20 samples)
    h.latencySamples.push(latencyMs);
    if (h.latencySamples.length > 20) h.latencySamples.shift();
    h.avgLatencyMs = h.latencySamples.reduce((a, b) => a + b, 0) / h.latencySamples.length;
  }

  // ─── Record failure ────────────────────────────────────────────
  recordFailure(provider: ProviderType, errorType: ErrorClassification, errorMsg: string): void {
    const h = this.providers.get(provider)!;
    const now = Date.now();
    h.lastFailureAt = now;
    h.consecutiveFailures++;
    h.totalFailures++;
    // SDK rejections are sometimes plain strings (err.message === undefined) —
    // never let .substring crash the caller's error-handling path.
    h.lastError = String(errorMsg ?? "").substring(0, 200);
    h.lastErrorType = errorType;

    // Set status based on error type
    switch (errorType) {
      case "BALANCE":
        h.status = "balance_exhausted";
        h.healthy = false;
        break;
      case "RATE_LIMIT":
        h.status = "rate_limited";
        h.healthy = false;
        break;
      case "MODEL_NOT_FOUND":
        h.status = "model_unavailable";
        h.healthy = false;
        break;
      case "AUTH":
        h.status = "error";
        h.healthy = false;
        break;
      case "TIMEOUT":
        h.status = "timeout";
        break;
      case "NETWORK":
        h.status = "offline";
        h.healthy = false;
        break;
      case "SERVER":
        h.status = "error";
        break;
      default:
        h.status = "error";
    }

    // Calculate cooldown
    const config = { ...DEFAULT_COOLDOWN, ...PROVIDER_COOLDOWNS[provider] };
    if (h.consecutiveFailures >= config.maxConsecutiveFailures) {
      // Circuit OPEN — long cooldown
      const cooldownMs = Math.min(
        config.baseMs * Math.pow(config.multiplier, Math.min(h.consecutiveFailures - config.maxConsecutiveFailures, 6)),
        config.maxMs
      );
      h.cooldownUntil = now + cooldownMs;
      h.circuitState = "OPEN";
      h.healthy = false;
    } else if (h.consecutiveFailures >= 2) {
      // Short cooldown for repeated failures
      const cooldownMs = Math.min(
        config.baseMs * Math.pow(config.multiplier, h.consecutiveFailures - 1),
        config.maxMs
      );
      h.cooldownUntil = now + cooldownMs;
    }
  }

  // ─── Check if provider should be skipped ───────────────────────
  shouldSkip(provider: ProviderType): boolean {
    const h = this.providers.get(provider);
    if (!h) return true;

    // Circuit is OPEN — skip
    if (h.circuitState === "OPEN") {
      if (Date.now() >= h.cooldownUntil) {
        // Cooldown expired — try HALF_OPEN
        h.circuitState = "HALF_OPEN";
        return false;
      }
      return true;
    }

    // In cooldown — skip
    if (Date.now() < h.cooldownUntil) {
      return true;
    }

    // Permanently broken states — skip
    if (h.status === "balance_exhausted" || h.status === "disabled") {
      return true;
    }

    return false;
  }

  // ─── Get provider health ───────────────────────────────────────
  getHealth(provider: ProviderType): ProviderHealth {
    return { ...this.providers.get(provider)! };
  }

  // ─── Get all providers health ──────────────────────────────────
  getAllHealth(): Record<string, ProviderHealth> {
    const result: Record<string, ProviderHealth> = {};
    for (const [k, v] of this.providers) {
      result[k] = { ...v };
    }
    return result;
  }

  // ─── Reset provider (for manual recovery) ──────────────────────
  resetProvider(provider: ProviderType): void {
    const h = this.providers.get(provider)!;
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
    h.circuitState = "CLOSED";
    h.healthy = true;
    h.status = "unknown";
    h.lastError = null;
    h.lastErrorType = null;
  }

  // ─── Set provider status manually ──────────────────────────────
  setStatus(provider: ProviderType, status: ProviderStatus): void {
    const h = this.providers.get(provider)!;
    h.status = status;
    h.healthy = status === "ready" || status === "unknown";
    if (status === "disabled") {
      h.healthy = false;
      h.circuitState = "OPEN";
      h.cooldownUntil = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
    }
  }

  // ─── Get next available provider from ordered list ─────────────
  getNextProvider(ordered: ProviderType[]): ProviderType | null {
    for (const p of ordered) {
      if (!this.shouldSkip(p)) return p;
    }
    return null;
  }

  // ─── Extract retry-after from headers ──────────────────────────
  parseRetryAfter(headers: Headers): number | null {
    const ra = headers.get("retry-after");
    if (!ra) return null;
    const seconds = parseInt(ra, 10);
    if (!isNaN(seconds)) return seconds * 1000;
    // Try HTTP-date format
    const date = new Date(ra);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
    return null;
  }

  // ─── Export structured health for API ──────────────────────────
  exportHealth(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [k, v] of this.providers) {
      result[k] = {
        healthy: v.healthy,
        status: v.status,
        circuitState: v.circuitState,
        consecutiveFailures: v.consecutiveFailures,
        totalSuccesses: v.totalSuccesses,
        totalFailures: v.totalFailures,
        lastSuccessAt: v.lastSuccessAt ? new Date(v.lastSuccessAt).toISOString() : null,
        lastFailureAt: v.lastFailureAt ? new Date(v.lastFailureAt).toISOString() : null,
        cooldownRemainingMs: Math.max(0, v.cooldownUntil - Date.now()),
        lastLatencyMs: v.lastLatencyMs,
        avgLatencyMs: Math.round(v.avgLatencyMs),
        lastError: v.lastError,
        lastErrorType: v.lastErrorType,
      };
    }
    return result;
  }
}

// Singleton export
export const providerHealth = ProviderHealthManager.getInstance();
