// quant-runtime-config.ts — file-backed runtime overrides for UNIVERSAL_QUANT_V1.
//
// ISOLATION: quant-namespace config only. Reads data/quant-config.json on
// EVERY call (cheap, no cache) so an operator can flip mode/capital between
// cycles without a restart. Missing or corrupt file → {} (QUANT_FLAGS remain
// the source of truth). Writes are atomic (tmp file + rename).
//
// Precedence (effective* helpers): runtime file value ?? QUANT_FLAGS value.

import fs from "node:fs";
import path from "node:path";
import { QUANT_FLAGS } from "./quant-config";

export interface QuantRuntimeConfig {
  enabled?: boolean;
  mode?: "SHADOW" | "PAPER";
  paperCapital?: number | null;
  symbols?: string[];
  tuning?: QuantTuning;
  updatedAt?: string;
}

/**
 * High-accuracy tuning knobs. Defaults mirror QUANT_FLAGS (baseline behaviour);
 * strict values live ONLY in the runtime file so tests (which reset the file)
 * keep exercising the documented baseline, while production runs strict.
 */
export interface QuantTuning {
  /** Strategy winner gate — raw strategy score must clear this (default 55). */
  minScore?: number;
  /** Plan R:R gate (default QUANT_FLAGS.minRewardRisk = 1.5). */
  minRewardRisk?: number;
  /** Max new trades per day — null = unlimited (the default: quality gates only). */
  maxTradesPerDay?: number | null;
  /** Max concurrent open positions — null = unlimited (the default). */
  maxConcurrentPositions?: number | null;
  /**
   * DEEP-RESEARCH GATE — a candidate only reaches TRADE (and alerts) when the
   * live option-chain structure does not contradict the direction (OI walls /
   * PCR / writing activity via option-chain-reader). Unavailable chain ⇒ WAIT.
   */
  requireChainConfirm?: boolean;
}

export const QUANT_TUNING_DEFAULTS = {
  minScore: 55,
  minRewardRisk: QUANT_FLAGS.minRewardRisk,
  maxTradesPerDay: QUANT_FLAGS.maxTradesPerDay,
  maxConcurrentPositions: QUANT_FLAGS.maxConcurrentPositions,
  requireChainConfirm: false,
} as const;

export function effectiveTuning(): Required<QuantTuning> {
  const t = getQuantRuntimeConfig().tuning ?? {};
  return {
    minScore: typeof t.minScore === "number" && t.minScore >= 0 && t.minScore <= 100 ? t.minScore : QUANT_TUNING_DEFAULTS.minScore,
    minRewardRisk: typeof t.minRewardRisk === "number" && t.minRewardRisk >= 0 ? t.minRewardRisk : QUANT_TUNING_DEFAULTS.minRewardRisk,
    // null = unlimited (no trade-count / concurrency cap). An explicit null in
    // the runtime file is honoured — it is NOT "absent".
    maxTradesPerDay:
      t.maxTradesPerDay === null
        ? null
        : typeof t.maxTradesPerDay === "number" && t.maxTradesPerDay >= 0
          ? t.maxTradesPerDay
          : QUANT_TUNING_DEFAULTS.maxTradesPerDay,
    maxConcurrentPositions:
      t.maxConcurrentPositions === null
        ? null
        : typeof t.maxConcurrentPositions === "number" && t.maxConcurrentPositions >= 0
          ? t.maxConcurrentPositions
          : QUANT_TUNING_DEFAULTS.maxConcurrentPositions,
    requireChainConfirm: t.requireChainConfirm === true,
  };
}

const CONFIG_PATH = path.join(process.cwd(), "data", "quant-config.json");

/** Read the override file each call; missing/corrupt → {} (never throws). */
export function getQuantRuntimeConfig(): QuantRuntimeConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as QuantRuntimeConfig;
  } catch {
    return {};
  }
}

/** Merge a patch over the current file and write atomically. Never throws. */
export function setQuantRuntimeConfig(patch: Partial<QuantRuntimeConfig>): QuantRuntimeConfig {
  const current = getQuantRuntimeConfig();
  const next: QuantRuntimeConfig = {
    ...current,
    ...patch,
    // Tuning is deep-merged: a patch that touches ONE key (or contains only
    // invalid values) must not reset the other armed gates back to defaults.
    ...(patch.tuning ? { tuning: { ...(current.tuning ?? {}), ...patch.tuning } } : {}),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch {
    // best-effort — the merged value is still returned for observability
  }
  return next;
}

/** QUANT_FLAGS.enabled (env QUANT_ENABLED=1) OR the runtime file override. */
export function quantEnabled(): boolean {
  return QUANT_FLAGS.enabled || getQuantRuntimeConfig().enabled === true;
}

/** runtime.mode ?? QUANT_FLAGS.mode (SHADOW by default — never live either way). */
export function effectiveMode(): "SHADOW" | "PAPER" {
  const mode = getQuantRuntimeConfig().mode;
  return mode === "PAPER" ? "PAPER" : mode === "SHADOW" ? "SHADOW" : QUANT_FLAGS.mode;
}

/** runtime.paperCapital ?? QUANT_FLAGS.defaultPaperCapital (null — NEVER assume). */
export function effectivePaperCapital(): number | null {
  const cfg = getQuantRuntimeConfig();
  if (cfg.paperCapital !== undefined) {
    return typeof cfg.paperCapital === "number" && Number.isFinite(cfg.paperCapital) && cfg.paperCapital > 0
      ? cfg.paperCapital
      : null;
  }
  return QUANT_FLAGS.defaultPaperCapital;
}

/** runtime.symbols (max 10, non-empty strings) ?? ["NIFTY"]. */
export function effectiveSymbols(): string[] {
  const symbols = getQuantRuntimeConfig().symbols;
  if (Array.isArray(symbols)) {
    const clean = symbols
      .filter((s) => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim().toUpperCase())
      .slice(0, 10);
    if (clean.length > 0) return clean;
  }
  return ["NIFTY"];
}

/** Test seam: delete the override file so tests start from pure defaults. */
export function __resetQuantRuntimeConfigForTests(): void {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } catch {
    // ignore — absence is the reset state
  }
}
