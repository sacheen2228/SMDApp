// Jev / TypeSafe SystemOne — configuration (server-only)
// Phase 1: SHADOW MODE ONLY. Jev never registers, executes, or overrides trades.

export interface JevConfig {
  enabled: boolean;
  shadowMode: boolean;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/**
 * Read Jev config from environment.
 * Defaults: JEV_ENABLED=false, JEV_SHADOW_MODE=true.
 * API key is server-only — never NEXT_PUBLIC_TYPESAFE_API_KEY.
 */
export function getJevConfig(): JevConfig {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || null;
  return {
    enabled: envFlag("JEV_ENABLED", false),
    // Shadow mode defaults ON even if JEV_ENABLED is turned on later.
    shadowMode: envFlag("JEV_SHADOW_MODE", true),
    apiKey,
    baseUrl: process.env.JEV_BASE_URL?.trim() || "https://api.typesafe.ai/v1/systemone",
    model: process.env.JEV_MODEL?.trim() || "jev-latest",
    timeoutMs: envInt("JEV_TIMEOUT_MS", 4000),
  };
}

/** True only when Jev should be called at all (enabled + key present). */
export function isJevCallable(): boolean {
  const cfg = getJevConfig();
  return cfg.enabled && !!cfg.apiKey;
}

/**
 * Production influence is NEVER automatic.
 * Even if JEV_ENABLED=true, influence requires an explicit separate flag
 * that is off by default and not flipped by learning/analytics.
 */
export function isJevProductionInfluenceAllowed(): boolean {
  // Phase 1 hard-block: always false until manual approval change.
  return false;
}

/** Redact any string that might contain a secret for logs/errors. */
export function redactSecrets(text: string): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (key && key.length >= 8) {
    return text.split(key).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/TYPESAFE_API_KEY\s*=\s*\S+/gi, "TYPESAFE_API_KEY=[REDACTED]");
}
