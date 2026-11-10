// One switch for the intraday SDM gate, plus counters for the log-only mode.
// INTRADAY_GATES is the ONLY mode input: "log" (default) or "enforce".

export type IntradayGateMode = "log" | "enforce";

export function getIntradayGateMode(): IntradayGateMode {
  return String(process.env.INTRADAY_GATES || "log").trim().toLowerCase() === "enforce"
    ? "enforce"
    : "log";
}

let wouldHaveBlocked = 0;
let enforcedBlocks = 0;
let gateChecks = 0;

export function recordGateDecision(blocked: boolean, mode: IntradayGateMode): void {
  gateChecks++;
  if (!blocked) return;
  if (mode === "enforce") enforcedBlocks++;
  else wouldHaveBlocked++;
}

export function getIntradayGateCounters(): {
  mode: IntradayGateMode;
  checks: number;
  wouldHaveBlocked: number;
  enforcedBlocks: number;
} {
  return {
    mode: getIntradayGateMode(),
    checks: gateChecks,
    wouldHaveBlocked,
    enforcedBlocks,
  };
}

export function resetIntradayGateCounters(): void {
  wouldHaveBlocked = 0;
  enforcedBlocks = 0;
  gateChecks = 0;
}
