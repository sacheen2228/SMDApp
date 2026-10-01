// Map Jev SystemOne answers → shadow classification.
// Never produces SELL options. Never authoritative for prices/strikes/SL/TP.

import type { JevAnswer, JevResponseBody } from "./client";
import type { JevNormalizedContext } from "./context";

export type JevOptionCall = "BUY_CE" | "BUY_PE" | "NO_TRADE";

export type JevReasonCode =
  | "JEV_DISABLED"
  | "JEV_NO_KEY"
  | "JEV_CALL_FAILED"
  | "JEV_MALFORMED"
  | "JEV_INSUFFICIENT_DATA"
  | "JEV_DATA_QUALITY_LOW"
  | "JEV_MARKET_CLOSED"
  | "JEV_LOW_CONFIDENCE"
  | "JEV_CONFLICT"
  | "JEV_NO_TRADE"
  | "JEV_BUY_CE"
  | "JEV_BUY_PE"
  | "JEV_SELL_REJECTED";

export interface JevClassification {
  call: JevOptionCall;
  reasonCode: JevReasonCode;
  reason: string;
  confidence: number;
  regime: string | null;
  dataQuality: string | null;
  confluenceScore: number | null;
  conflictScore: number | null;
  rawDirection: string | null;
  /** Shadow only — never feed into production decision */
  shadow: true;
}

const ALLOWED_CALLS = new Set<string>(["BUY_CE", "BUY_PE", "NO_TRADE"]);
const SELL_MARKERS = /SELL|SHORT|WRITE|WRITING/i;

function asChoice(ans: unknown): string | null {
  if (!ans || typeof ans !== "object") return null;
  const a = ans as JevAnswer & { choice?: unknown };
  if (typeof a.choice === "string") return a.choice.trim().toUpperCase();
  return null;
}

function asScore(ans: unknown): number | null {
  if (!ans || typeof ans !== "object") return null;
  const a = ans as { score?: unknown };
  if (typeof a.score === "number" && Number.isFinite(a.score)) return a.score;
  return null;
}

function asNoul(ans: unknown): number | null {
  if (!ans || typeof ans !== "object") return null;
  const a = ans as { noul?: unknown };
  if (typeof a.noul === "number" && Number.isFinite(a.noul)) return a.noul;
  return null;
}

function asConfidence(ans: unknown): number | null {
  if (!ans || typeof ans !== "object") return null;
  const a = ans as { confidence?: unknown };
  if (typeof a.confidence === "number" && Number.isFinite(a.confidence)) return a.confidence;
  return null;
}

export function emptyClassification(
  call: JevOptionCall,
  reasonCode: JevReasonCode,
  reason: string
): JevClassification {
  return {
    call,
    reasonCode,
    reason,
    confidence: 0,
    regime: null,
    dataQuality: null,
    confluenceScore: null,
    conflictScore: null,
    rawDirection: null,
    shadow: true,
  };
}

/**
 * Classify Jev answers into BUY_CE | BUY_PE | NO_TRADE.
 * Hard rules:
 * - Never SELL
 * - Prefer NO_TRADE when context quality insufficient or market closed
 * - Prefer NO_TRADE when confidence too low or conflict present
 */
export function classifyJevAnswers(
  body: JevResponseBody,
  context: JevNormalizedContext,
  opts?: { minConfidence?: number }
): JevClassification {
  const minConfidence = opts?.minConfidence ?? 40;

  if (context.quality.overall === "INSUFFICIENT") {
    return emptyClassification(
      "NO_TRADE",
      "JEV_INSUFFICIENT_DATA",
      "Critical market data missing — NO_TRADE"
    );
  }
  if (
    context.marketStatus === "MARKET_CLOSED" ||
    context.marketStatus === "WEEKEND" ||
    context.marketStatus === "HOLIDAY"
  ) {
    if (context.exchange !== "MCX") {
      return emptyClassification(
        "NO_TRADE",
        "JEV_MARKET_CLOSED",
        `Market status ${context.marketStatus} — NO_TRADE`
      );
    }
  }

  const answers = body.answers || {};
  const rawDir = asChoice(answers.directional_bias);
  const dataQuality = asChoice(answers.data_quality);
  const regime = asChoice(answers.regime);
  const confluence = asScore(answers.confluence_quality);
  const conflictNoul = asNoul(answers.conflict_flag);
  const conf =
    asConfidence(answers.directional_bias) ??
    asConfidence(answers.confluence_quality) ??
    50;

  if (dataQuality === "INSUFFICIENT" || dataQuality === "LOW") {
    return {
      ...emptyClassification(
        "NO_TRADE",
        "JEV_DATA_QUALITY_LOW",
        `Jev data quality ${dataQuality} — NO_TRADE`
      ),
      confidence: conf,
      regime,
      dataQuality,
      confluenceScore: confluence,
      conflictScore: conflictNoul,
      rawDirection: rawDir,
    };
  }

  if (conflictNoul != null && conflictNoul >= 0.7) {
    return {
      ...emptyClassification(
        "NO_TRADE",
        "JEV_CONFLICT",
        "Material evidence conflict flagged — NO_TRADE"
      ),
      confidence: conf,
      regime,
      dataQuality,
      confluenceScore: confluence,
      conflictScore: conflictNoul,
      rawDirection: rawDir,
    };
  }

  if (!rawDir) {
    return emptyClassification(
      "NO_TRADE",
      "JEV_MALFORMED",
      "directional_bias answer missing — NO_TRADE"
    );
  }

  // Hard reject any SELL language from the model
  if (SELL_MARKERS.test(rawDir) && !ALLOWED_CALLS.has(rawDir)) {
    return {
      ...emptyClassification(
        "NO_TRADE",
        "JEV_SELL_REJECTED",
        `Jev returned sell-like direction "${rawDir}" — forced NO_TRADE`
      ),
      confidence: conf,
      regime,
      dataQuality,
      confluenceScore: confluence,
      conflictScore: conflictNoul,
      rawDirection: rawDir,
    };
  }

  let call: JevOptionCall = "NO_TRADE";
  let reasonCode: JevReasonCode = "JEV_NO_TRADE";
  let reason = "Jev classified NO_TRADE";

  if (rawDir === "BUY_CE" || rawDir === "CALL" || rawDir === "CE") {
    call = "BUY_CE";
    reasonCode = "JEV_BUY_CE";
    reason = "Jev classified BUY_CE (shadow)";
  } else if (rawDir === "BUY_PE" || rawDir === "PUT" || rawDir === "PE") {
    call = "BUY_PE";
    reasonCode = "JEV_BUY_PE";
    reason = "Jev classified BUY_PE (shadow)";
  } else if (rawDir === "NO_TRADE" || rawDir === "NONE" || rawDir === "WAIT") {
    call = "NO_TRADE";
    reasonCode = "JEV_NO_TRADE";
    reason = "Jev classified NO_TRADE";
  } else {
    call = "NO_TRADE";
    reasonCode = "JEV_MALFORMED";
    reason = `Unrecognized direction "${rawDir}" — NO_TRADE`;
  }

  // Low confidence → NO_TRADE even if directional
  if (call !== "NO_TRADE" && conf < minConfidence) {
    return {
      ...emptyClassification(
        "NO_TRADE",
        "JEV_LOW_CONFIDENCE",
        `Confidence ${conf} below ${minConfidence} — NO_TRADE`
      ),
      confidence: conf,
      regime,
      dataQuality,
      confluenceScore: confluence,
      conflictScore: conflictNoul,
      rawDirection: rawDir,
    };
  }

  if (
    call !== "NO_TRADE" &&
    context.quality.overall !== "HIGH" &&
    context.quality.overall !== "MEDIUM"
  ) {
    return {
      ...emptyClassification(
        "NO_TRADE",
        "JEV_INSUFFICIENT_DATA",
        "Context quality too low for directional call — NO_TRADE"
      ),
      confidence: conf,
      regime,
      dataQuality,
      confluenceScore: confluence,
      conflictScore: conflictNoul,
      rawDirection: rawDir,
    };
  }

  return {
    call,
    reasonCode,
    reason,
    confidence: conf,
    regime,
    dataQuality,
    confluenceScore: confluence,
    conflictScore: conflictNoul,
    rawDirection: rawDir,
    shadow: true,
  };
}
