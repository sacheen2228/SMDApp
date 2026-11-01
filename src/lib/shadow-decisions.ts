// Shadow-Decision Logger — Phase 2 implementation (shadow-mode validation).
// Append-only JSONL log of proposed trade decisions (before the alert/action is
// dispatched), so the existing-vs-proposed comparison can be validated without
// placing orders, registering production trades, or sending alerts.

export interface ShadowDecision {
  timestamp: string;
  source: string;
  kind: "option" | "equity";
  symbol: string;
  side: string;
  instrument: string;
  strike?: number;
  optionType?: string;
  entry?: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  rr?: number;
  confidence?: number;
  rationale?: string;
  expiry?: string;
  generatedAt?: string;
  meta?: Record<string, any>;
}

const DEFAULT_PATH = "data/shadow-decisions.jsonl";

export function getShadowDecisionsPath(): string {
  const p = process.env.SHADOW_DECISIONS_PATH;
  return p || DEFAULT_PATH;
}

export function logShadowDecision(rec: ShadowDecision): void {
  try {
    const fs = require("fs");
    const path = getShadowDecisionsPath();
    fs.mkdirSync(require("path").dirname(path), { recursive: true });
    const line = JSON.stringify({ ...rec, loggedAt: new Date().toISOString() });
    fs.appendFileSync(path, line + "\n", "utf8");
  } catch {
    // Shadow logging must never break the decision path.
  }
}

export function getShadowDecisions(limit = 500): ShadowDecision[] {
  try {
    const fs = require("fs");
    const path = getShadowDecisionsPath();
    const raw = fs.readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l && !l.trim().startsWith("//"));
    const out: ShadowDecision[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip malformed lines */ } }
    return out.slice(-limit);
  } catch { return []; }
}
