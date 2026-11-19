// Directional consistency check.
//
// Before recommending CE or PE, the engine verifies that the option leg's
// direction is supported by the price/EMA/MACD/structure/momentum evidence.
// A setup classification alone is not an entry trigger; conflicting evidence
// must be resolved with confirmed reversal evidence, never forced.

export interface DirectionalEvidence {
  ema: { alignment: string; direction: "BULLISH" | "BEARISH" | "NEUTRAL" };
  macd: { direction: "BULLISH" | "BEARISH" | "NEUTRAL" };
  structure: { direction: "BULLISH" | "BEARISH" | "NEUTRAL"; trend: string };
  momentum: { direction: "BULLISH" | "BEARISH" | "NEUTRAL" };
  vwap: { side: "ABOVE" | "BELOW" | "NA" };
  reversal?: { confirmed: boolean; evidence: string[] } | null;
}

export type ConsistencyVerdict = "CONSISTENT" | "REVERSAL_CONFIRMED" | "CONFLICT" | "INSUFFICIENT";

export interface DirectionalCheckResult {
  verdict: ConsistencyVerdict;
  conflicts: string[];
  supporting: string[];
  /** What independent evidence is required to convert a CONFLICT into a tradeable reversal. */
  requiredEvidence: string[];
}

const OPPOSITE: Record<string, string> = { BULLISH: "BEARISH", BEARISH: "BULLISH", NEUTRAL: "NEUTRAL" };

function sideOf(dir: "BULLISH" | "BEARISH" | "NEUTRAL", wanted: "BULLISH" | "BEARISH"): "support" | "oppose" | "neutral" {
  if (dir === wanted) return "support";
  if (dir === OPPOSITE[wanted]) return "oppose";
  return "neutral";
}

function vwapSide(side: "ABOVE" | "BELOW" | "NA", wanted: "BULLISH" | "BEARISH"): "support" | "oppose" | "neutral" {
  if (side === "NA") return "neutral";
  const dir = side === "ABOVE" ? "BULLISH" : "BEARISH";
  return sideOf(dir, wanted);
}

/** EMA opposition is "hard" only when the full EMA stack has turned against the
 *  leg (alignment fully opposite). A transitional / choppy stack is EMA50 lag
 *  and must not block a legitimate early reversal on its own. */
function emaOppositionIsHard(alignment: string, wanted: "BULLISH" | "BEARISH"): boolean {
  const fullyOpposite = wanted === "BULLISH" ? alignment === "BEARISH" : alignment === "BULLISH";
  return fullyOpposite;
}

export function checkDirectionalConsistency(
  leg: "CE" | "PE",
  ev: DirectionalEvidence,
): DirectionalCheckResult {
  const wanted = leg === "CE" ? "BULLISH" : "BEARISH";
  const opposite = OPPOSITE[wanted];

  const checks: { name: string; dir: "BULLISH" | "BEARISH" | "NEUTRAL"; side: "support" | "oppose" | "neutral"; hard: boolean }[] = [];

  const emaSide = sideOf(ev.ema.direction, wanted);
  checks.push({
    name: "EMA",
    dir: ev.ema.direction,
    side: emaSide,
    hard: emaSide === "oppose" && emaOppositionIsHard(ev.ema.alignment, wanted),
  });
  checks.push({ name: "MACD", dir: ev.macd.direction, side: sideOf(ev.macd.direction, wanted), hard: true });
  checks.push({ name: "structure", dir: ev.structure.direction, side: sideOf(ev.structure.direction, wanted), hard: true });
  checks.push({ name: "momentum", dir: ev.momentum.direction, side: sideOf(ev.momentum.direction, wanted), hard: true });
  checks.push({ name: "VWAP", dir: vwapSide(ev.vwap.side, wanted) === "neutral" ? "NEUTRAL" : vwapSide(ev.vwap.side, wanted) === "support" ? wanted : opposite, side: vwapSide(ev.vwap.side, wanted), hard: true });

  const supportive = checks.filter((c) => c.side === "support");
  const opposing = checks.filter((c) => c.side === "oppose");
  const available = supportive.length + opposing.length;
  const hardOpposing = opposing.filter((c) => c.hard);

  const conflicts: string[] = [];
  const supporting: string[] = [];
  const requiredEvidence: string[] = [];

  for (const c of supportive) supporting.push(`${c.name.toUpperCase()} ${c.dir.toLowerCase()}`);
  for (const c of opposing) conflicts.push(`${c.name.toUpperCase()} (${c.dir.toLowerCase()}) opposes ${leg}`);

  if (available < 2) {
    return { verdict: "INSUFFICIENT", conflicts: [], supporting, requiredEvidence: ["insufficient directional evidence to judge"] };
  }

  if (opposing.length === 0) {
    return { verdict: "CONSISTENT", conflicts: [], supporting, requiredEvidence: [] };
  }

  // Only soft opposition (e.g. EMA50 lag on a transitional stack) is not a block.
  if (hardOpposing.length === 0) {
    return { verdict: "CONSISTENT", conflicts, supporting, requiredEvidence: [] };
  }

  // Hard opposition requires confirmed reversal evidence.
  const reversal = ev.reversal;
  const reversalConfirmed = reversal != null && reversal.confirmed && reversal.evidence != null && reversal.evidence.length >= 2;

  if (reversalConfirmed) {
    for (const e of reversal.evidence) supporting.push(`reversal: ${e}`);
    requiredEvidence.push("");
    return {
      verdict: "REVERSAL_CONFIRMED",
      conflicts,
      supporting,
      requiredEvidence: [],
    };
  }

  requiredEvidence.push(
    `confirmed reversal evidence for ${leg} (e.g. structure CHoCH in the ${wanted.toLowerCase()} direction plus closed-candle confirmation)`,
  );
  return {
    verdict: "CONFLICT",
    conflicts,
    supporting,
    requiredEvidence,
  };
}
