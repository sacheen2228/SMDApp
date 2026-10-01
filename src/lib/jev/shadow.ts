// Jev shadow mode — compare only. Never mutates production decisions,
// locks, registration, Telegram, or validators.

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getJevConfig, isJevCallable, isJevProductionInfluenceAllowed } from "./config";
import { callJev, DEFAULT_JEV_QUESTIONS, type JevClientResult } from "./client";
import { buildJevContext, jevStatePayload, type JevNormalizedContext } from "./context";
import {
  classifyJevAnswers,
  emptyClassification,
  type JevClassification,
} from "./classifier";
import type { HermesContext, HermesDecision } from "@/lib/hermes/types";
import type { GrokDecision, AgentResearchOutput, CrossConfluenceOutput } from "@/lib/agents/agent-contract";

export type ShadowSource = "HERMES" | "AGENT_PIPELINE";

export interface ShadowComparisonInput {
  source: ShadowSource;
  symbol: string;
  /** Production/deterministic decision being compared against */
  productionDecision: string;
  /** Optional Hermes full decision */
  hermesDecision?: Pick<
    HermesDecision,
    "decision" | "score" | "grade" | "confidence" | "marketRegime" | "dataHealth" | "timestamp"
  >;
  /** Optional local Grok supervisor decision */
  grokDirection?: string;
  agentOutputs?: AgentResearchOutput[];
  crossConfluence?: CrossConfluenceOutput;
}

export interface ShadowRecord {
  type: "jev_shadow";
  source: ShadowSource;
  symbol: string;
  timestamp: string;
  shadowMode: boolean;
  productionInfluenceAllowed: boolean;
  productionDecision: string;
  grokDirection?: string;
  jevStatus: "SKIPPED" | "OK" | "ERROR";
  jevSkipReason?: string;
  jevErrorCode?: string;
  jevCall?: JevOptionCallAlias;
  jevReasonCode?: string;
  jevReason?: string;
  jevConfidence?: number;
  jevRegime?: string | null;
  jevDataQuality?: string | null;
  jevConfluenceScore?: number | null;
  jevConflictScore?: number | null;
  /** Agreement of Jev vs production (options path) */
  agreesWithProduction?: boolean;
  agreesWithGrok?: boolean;
  contextQuality?: string;
  contextMissing?: string[];
  latencyMs?: number;
  model?: string;
  /** Always true in Phase 1 */
  note: string;
}

type JevOptionCallAlias = "BUY_CE" | "BUY_PE" | "NO_TRADE";

const LOG_FILE = "jev-shadow.jsonl";

function logPath(): string {
  return join(process.cwd(), "data", "agent-logs", LOG_FILE);
}

export function appendShadowRecord(record: ShadowRecord): void {
  try {
    const dir = join(process.cwd(), "data", "agent-logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath(), JSON.stringify(record) + "\n");
  } catch {
    // Logging must never break the trading path
  }
}

/** Normalize production/hermes decision into options-safe bucket for comparison. */
export function normalizeOptionCall(decision: string): JevOptionCallAlias {
  const d = String(decision || "").toUpperCase();
  if (d === "BUY_CE" || d === "CE" || d === "CALL" || d === "BUY_CALL") return "BUY_CE";
  if (d === "BUY_PE" || d === "PE" || d === "PUT" || d === "BUY_PUT") return "BUY_PE";
  // SELL options and anything else map to NO_TRADE for comparison only
  return "NO_TRADE";
}

export function agreements(
  jev: JevOptionCallAlias,
  production: string,
  grok?: string
): { agreesWithProduction: boolean; agreesWithGrok?: boolean } {
  const prod = normalizeOptionCall(production);
  const result: { agreesWithProduction: boolean; agreesWithGrok?: boolean } = {
    agreesWithProduction: jev === prod,
  };
  if (grok) {
    result.agreesWithGrok = jev === normalizeOptionCall(grok);
  }
  return result;
}

/**
 * Run one shadow evaluation. Pure research — does not change productionDecision.
 * Returns the record for tests; always safe to call.
 */
export async function runJevShadowEvaluation(
  input: ShadowComparisonInput,
  hermesCtx?: HermesContext,
  fetchImpl?: typeof fetch
): Promise<ShadowRecord> {
  const cfg = getJevConfig();
  const base: ShadowRecord = {
    type: "jev_shadow",
    source: input.source,
    symbol: input.symbol,
    timestamp: new Date().toISOString(),
    shadowMode: cfg.shadowMode,
    productionInfluenceAllowed: isJevProductionInfluenceAllowed(),
    productionDecision: input.productionDecision,
    grokDirection: input.grokDirection,
    jevStatus: "SKIPPED",
    note: "Shadow only — Jev does not execute, register, or override trades.",
  };

  if (isJevProductionInfluenceAllowed()) {
    // Defensive: Phase 1 must never be production-influencing.
    base.note = "WARNING: production influence flag unexpectedly true — ignored in Phase 1.";
  }

  if (!cfg.enabled) {
    base.jevSkipReason = "JEV_ENABLED=false";
    return base;
  }
  if (!cfg.apiKey) {
    base.jevSkipReason = "TYPESAFE_API_KEY missing";
    return base;
  }

  let context: JevNormalizedContext;
  if (hermesCtx) {
    context = buildJevContext(hermesCtx);
  } else {
    // Pipeline path without HermesContext — minimal context from production decision metadata
    context = {
      schemaVersion: "jev-context-v1",
      symbol: input.symbol,
      exchange: "NSE",
      instrument: "index",
      marketStatus: "UNKNOWN",
      timestamp: new Date().toISOString(),
      spot: { price: null, changePct: null, prevClose: null, open: null, high: null, low: null, meta: { availability: "UNAVAILABLE" } },
      optionChain: {
        available: false, atmStrike: null, expiry: null, daysToExpiry: null, maxPain: null,
        pcrOI: null, totalCallOI: null, totalPutOI: null, callOiChange: null, putOiChange: null,
        callWall: null, putWall: null, futuresPrice: null, strikes: [],
        meta: { availability: "UNAVAILABLE" },
      },
      greeks: { available: false, delta: null, gamma: null, theta: null, vega: null, iv: null, meta: { availability: "UNAVAILABLE" } },
      gammaIntel: { available: false, dealerBias: null, regime: null, gammaWallStrike: null, meta: { availability: "UNAVAILABLE" } },
      structure: {
        available: false, trend: null, swingHigh: null, swingLow: null,
        supportLevels: [], resistanceLevels: [], lastEvent: null, pdh: null, pdl: null,
        meta: { availability: "UNAVAILABLE" },
      },
      volumeProfile: { available: false, poc: null, vah: null, val: null, totalVolume: null, meta: { availability: "UNAVAILABLE" } },
      vix: { available: false, value: null, meta: { availability: "UNAVAILABLE" } },
      fiiDII: { available: false, fiiNet: null, diiNet: null, meta: { availability: "UNAVAILABLE" } },
      regime: { available: false, regime: null, bias: null, meta: { availability: "UNAVAILABLE" } },
      news: { available: false, sentiment: null, headlines: [], meta: { availability: "UNAVAILABLE" } },
      quality: {
        criticalFieldsAvailable: [],
        criticalFieldsMissing: ["spot", "option_chain", "greeks", "structure"],
        overall: "INSUFFICIENT",
      },
      constraints: [
        "Options: BUY_CE, BUY_PE, or NO_TRADE only. Never SELL options.",
        "Research only — not authoritative for entry, SL, TP, strike, or size.",
      ],
    };

    // Enrich with agent summary if present (no fabricated market numbers)
    if (input.agentOutputs?.length) {
      const biases = input.agentOutputs.map((a) => a.bias);
      const bullish = biases.filter((b) => b === "BULLISH").length;
      const bearish = biases.filter((b) => b === "BEARISH").length;
      const conflicts = input.crossConfluence?.conflicts || [];
      context.regime = {
        available: true,
        regime: input.grokDirection ? null : null,
        bias: bullish > bearish ? "BULLISH" : bearish > bullish ? "BEARISH" : "NEUTRAL",
        meta: { availability: "AVAILABLE", source: "agent_outputs" },
      };
      context.constraints.push(
        `Agent bias counts: bullish=${bullish} bearish=${bearish} conflicts=${conflicts.length}`,
        `Production decision under test: ${input.productionDecision}`,
        `Grok direction: ${input.grokDirection || "n/a"}`
      );
      // Agent-only context is still low quality for option trading evidence
      context.quality.overall = "LOW";
      context.quality.criticalFieldsMissing = ["spot", "option_chain", "greeks", "structure"];
    }
  }

  base.contextQuality = context.quality.overall;
  base.contextMissing = context.quality.criticalFieldsMissing;

  if (context.quality.overall === "INSUFFICIENT" && !hermesCtx) {
    const cls = emptyClassification(
      "NO_TRADE",
      "JEV_INSUFFICIENT_DATA",
      "No Hermes context and insufficient pipeline evidence — NO_TRADE without calling Jev"
    );
    const agr = agreements(cls.call, input.productionDecision, input.grokDirection);
    return {
      ...base,
      jevStatus: "SKIPPED",
      jevSkipReason: cls.reason,
      jevCall: cls.call,
      jevReasonCode: cls.reasonCode,
      jevReason: cls.reason,
      ...agr,
    };
  }

  if (!isJevCallable()) {
    base.jevSkipReason = !cfg.enabled ? "JEV_ENABLED=false" : "TYPESAFE_API_KEY missing";
    return base;
  }

  const state = jevStatePayload(context);
  let result: JevClientResult;
  try {
    result = await callJev(state, { questions: DEFAULT_JEV_QUESTIONS, config: cfg, fetchImpl });
  } catch (err: any) {
    base.jevStatus = "ERROR";
    base.jevErrorCode = "NETWORK";
    base.jevSkipReason = String(err?.message || err).slice(0, 200);
    return base;
  }

  if (!result.ok) {
    base.jevStatus = result.code === "DISABLED" || result.code === "MISSING_KEY" ? "SKIPPED" : "ERROR";
    base.jevErrorCode = result.code;
    base.jevSkipReason = result.message;
    base.latencyMs = result.latencyMs;
    return base;
  }

  const cls = classifyJevAnswers(result.body, context);
  const agr = agreements(cls.call, input.productionDecision, input.grokDirection);

  return {
    ...base,
    jevStatus: "OK",
    jevCall: cls.call,
    jevReasonCode: cls.reasonCode,
    jevReason: cls.reason,
    jevConfidence: cls.confidence,
    jevRegime: cls.regime,
    jevDataQuality: cls.dataQuality,
    jevConfluenceScore: cls.confluenceScore,
    jevConflictScore: cls.conflictScore,
    latencyMs: result.latencyMs,
    model: result.model,
    ...agr,
  };
}

/**
 * Fire-and-forget hook for production paths.
 * MUST NOT await in a way that changes or delays the trade decision path
 * beyond best-effort logging. Errors are swallowed.
 */
export function maybeRecordJevShadow(
  input: ShadowComparisonInput,
  hermesCtx?: HermesContext,
  fetchImpl?: typeof fetch
): void {
  try {
    void runJevShadowEvaluation(input, hermesCtx, fetchImpl)
      .then((record) => appendShadowRecord(record))
      .catch(() => {
        /* never break production */
      });
  } catch {
    /* never break production */
  }
}

/**
 * Test helper: await shadow evaluation and append (for integration tests).
 */
export async function recordJevShadowAwaited(
  input: ShadowComparisonInput,
  hermesCtx?: HermesContext,
  fetchImpl?: typeof fetch
): Promise<ShadowRecord> {
  const record = await runJevShadowEvaluation(input, hermesCtx, fetchImpl);
  appendShadowRecord(record);
  return record;
}

/**
 * Safety assertion for tests: shadow records never claim production influence.
 */
export function assertShadowIsInert(record: ShadowRecord): void {
  if (record.productionInfluenceAllowed) {
    throw new Error("Shadow record must not allow production influence in Phase 1");
  }
  if (!record.shadowMode) {
    throw new Error("Shadow record must remain in shadowMode");
  }
}
