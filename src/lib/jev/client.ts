// TypeSafe SystemOne (Jev) HTTP client — server-side only.
// Official contract: POST /v1/systemone { state, model, questions }
// Response: { model, answers, usage } — not OpenAI chat format.

import { getJevConfig, redactSecrets, type JevConfig } from "./config";

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  /** Optional allowed choices for type=choice */
  choices?: string[];
}

export interface JevQuestionMap {
  [id: string]: JevQuestion;
}

export interface JevAnswerNoul {
  type: "noul";
  noul: number;
}

export interface JevAnswerChoice {
  type?: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevAnswerScore {
  type?: "score";
  score: number;
  legend?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type JevAnswer = JevAnswerNoul | JevAnswerChoice | JevAnswerScore;

export interface JevResponseBody {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type JevClientErrorCode =
  | "MISSING_KEY"
  | "TIMEOUT"
  | "HTTP_401"
  | "HTTP_422"
  | "HTTP_429"
  | "HTTP_5XX"
  | "NETWORK"
  | "MALFORMED_RESPONSE"
  | "DISABLED";

export interface JevClientSuccess {
  ok: true;
  body: JevResponseBody;
  latencyMs: number;
  model: string;
}

export interface JevClientFailure {
  ok: false;
  code: JevClientErrorCode;
  /** Redacted message — never contains API key */
  message: string;
  status?: number;
  latencyMs: number;
}

export type JevClientResult = JevClientSuccess | JevClientFailure;

/** Default questions for market research classification (shadow). */
export const DEFAULT_JEV_QUESTIONS: JevQuestionMap = {
  data_quality: {
    type: "choice",
    instructions:
      "Rate the quality of this structured market evidence. Choose one: HIGH, MEDIUM, LOW, INSUFFICIENT.",
    choices: ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"],
  },
  directional_bias: {
    type: "choice",
    instructions:
      "Given only the evidence, classify option-buy bias for Indian index options. Choose one: BUY_CE, BUY_PE, NO_TRADE. Never choose SELL. If evidence is missing or conflicting, choose NO_TRADE.",
    choices: ["BUY_CE", "BUY_PE", "NO_TRADE"],
  },
  regime: {
    type: "choice",
    instructions:
      "Classify market regime from evidence. Choose one: TRENDING_UP, TRENDING_DOWN, RANGE, HIGH_VOLATILITY, LOW_VOLATILITY, UNCERTAIN.",
    choices: ["TRENDING_UP", "TRENDING_DOWN", "RANGE", "HIGH_VOLATILITY", "LOW_VOLATILITY", "UNCERTAIN"],
  },
  confluence_quality: {
    type: "score",
    instructions:
      "Score cross-confluence quality 0-100 from evidence relationships (not indicator count alone). 0 = conflicting/insufficient, 100 = strong aligned confluence.",
  },
  conflict_flag: {
    type: "noul",
    instructions:
      "Does this evidence contain material conflicts between price, OI, structure, or timeframes? 1 means conflict present.",
  },
};

export function buildJevRequest(
  state: unknown,
  questions: JevQuestionMap = DEFAULT_JEV_QUESTIONS,
  cfg: JevConfig = getJevConfig()
): { url: string; headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    state: typeof state === "string" ? state : JSON.stringify(state),
    model: cfg.model,
    questions,
  });
  return {
    url: cfg.baseUrl,
    headers: {
      Authorization: `Bearer ${cfg.apiKey ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  };
}

function classifyStatus(status: number): JevClientErrorCode {
  if (status === 401 || status === 403) return "HTTP_401";
  if (status === 422 || status === 400) return "HTTP_422";
  if (status === 429) return "HTTP_429";
  if (status >= 500) return "HTTP_5XX";
  return "NETWORK";
}

/**
 * Call TypeSafe SystemOne. Never throws for expected failures.
 * Never logs the API key.
 */
export async function callJev(
  state: unknown,
  options?: {
    questions?: JevQuestionMap;
    config?: JevConfig;
    fetchImpl?: typeof fetch;
  }
): Promise<JevClientResult> {
  const cfg = options?.config ?? getJevConfig();
  const started = Date.now();
  const fetchImpl = options?.fetchImpl ?? fetch;

  if (!cfg.enabled) {
    return { ok: false, code: "DISABLED", message: "JEV_ENABLED is false", latencyMs: 0 };
  }
  if (!cfg.apiKey) {
    return {
      ok: false,
      code: "MISSING_KEY",
      message: "TYPESAFE_API_KEY is not set",
      latencyMs: 0,
    };
  }

  const req = buildJevRequest(state, options?.questions ?? DEFAULT_JEV_QUESTIONS, cfg);

  try {
    const res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        code: classifyStatus(res.status),
        message: redactSecrets(`HTTP ${res.status}: ${detail.slice(0, 200)}`),
        status: res.status,
        latencyMs,
      };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        ok: false,
        code: "MALFORMED_RESPONSE",
        message: "Response was not valid JSON",
        latencyMs,
      };
    }

    const body = parsed as Partial<JevResponseBody>;
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") {
      return {
        ok: false,
        code: "MALFORMED_RESPONSE",
        message: "Response missing answers map",
        latencyMs,
      };
    }

    return {
      ok: true,
      body: body as JevResponseBody,
      latencyMs,
      model: body.model || cfg.model,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    const name = String(err?.name || "");
    const msg = String(err?.message || err);
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
      return { ok: false, code: "TIMEOUT", message: redactSecrets(msg), latencyMs };
    }
    return { ok: false, code: "NETWORK", message: redactSecrets(msg), latencyMs };
  }
}
