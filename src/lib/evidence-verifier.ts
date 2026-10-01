// ═════════════════════════════════════════════════════════════
// Evidence Verifier — REAL OI/Greeks/news evidence for backtest trades.
// Pure logic: plausibility checks + integrity report + print formatting.
// No network. Fetching lives in evidence-fetcher.ts.
//
// Rule: NEVER fabricate an evidence value. If historical data is missing
// the trade must say "Evidence: NOT AVAILABLE" — a printed placeholder
// OI/Greeks number is a bug, not a graceful fallback.
// ═════════════════════════════════════════════════════════════

// ─── Evidence types ─────────────────────────────────────────────

export interface NewsHeadline {
  title: string;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
}

export interface OIEvidence {
  pcr: number | null;
  oiResistance: { strike: number; ceOi: number } | null;
  oiSupport: { strike: number; peOi: number } | null;
  oiChangeNearSpot: { peChange: number; ceChange: number } | null;
  maxPain: number | null;
  atmOis: { strike: number; ceOi: number; peOi: number } | null;
}

export interface GreeksEvidence {
  atmIv: number | null;
  skew: number | null;
  gammaFlip: number | null;
  regime: string | null;
  expectedMove: number | null;
  atmThetaPct: number | null;
  // ATM leg delta for the trade's option type (builder fills CE and PE;
  // 0 is never a real ATM delta — builder emits null when greeks are uncomputed)
  atmDeltaCe: number | null;
  atmDeltaPe: number | null;
}

export interface NewsEvidence {
  score: number | null;
  headlines: NewsHeadline[];
  origin: "recorded" | "live" | null;
}

export interface TradeEvidence {
  available: boolean;
  unavailableReason: string | null;
  oi: OIEvidence | null;
  greeks: GreeksEvidence | null;
  news: NewsEvidence | null;
  biasScore: number | null;
  groupsAgreeing: number | null;
  groupsTotal: number | null;
  confidence: string | null;
}

export function emptyEvidence(reason: string): TradeEvidence {
  return {
    available: false,
    unavailableReason: reason,
    oi: null,
    greeks: null,
    news: null,
    biasScore: null,
    groupsAgreeing: null,
    groupsTotal: null,
    confidence: null,
  };
}

// ─── Flags ─────────────────────────────────────────────────────

export type FlagCategory = "OI" | "GREEKS" | "NEWS";
export type FlagSeverity = "CRITICAL" | "REVIEW";

export interface PlausibilityFlag {
  category: FlagCategory;
  severity: FlagSeverity;
  tradeId?: string;
  message: string;
}

// ─── OI plausibility ───────────────────────────────────────────
// Positive values, sane PCR band, zero-ATM-OI = data gap not quiet market.

export const PCR_SANE_LOW = 0.3;
export const PCR_SANE_HIGH = 3.0;

export function checkOiPlausibility(oi: OIEvidence): PlausibilityFlag[] {
  const flags: PlausibilityFlag[] = [];

  if (oi.pcr !== null) {
    if (!isFinite(oi.pcr) || oi.pcr < 0) {
      flags.push({
        category: "OI",
        severity: "CRITICAL",
        message: `PCR is not a finite positive number: ${oi.pcr}`,
      });
    } else if (oi.pcr < PCR_SANE_LOW || oi.pcr > PCR_SANE_HIGH) {
      flags.push({
        category: "OI",
        severity: "REVIEW",
        message: `PCR ${oi.pcr.toFixed(2)} outside sane band ${PCR_SANE_LOW}-${PCR_SANE_HIGH} — extreme regime or bad data, manual review`,
      });
    }
  }

  if (oi.oiResistance && oi.oiResistance.ceOi < 0) {
    flags.push({
      category: "OI",
      severity: "CRITICAL",
      message: `Negative CE OI at resistance ${oi.oiResistance.strike}: ${oi.oiResistance.ceOi}`,
    });
  }
  if (oi.oiSupport && oi.oiSupport.peOi < 0) {
    flags.push({
      category: "OI",
      severity: "CRITICAL",
      message: `Negative PE OI at support ${oi.oiSupport.strike}: ${oi.oiSupport.peOi}`,
    });
  }

  // Zero OI on the ATM strike of a liquid index is a data gap, not a quiet market.
  if (oi.atmOis && oi.atmOis.ceOi === 0 && oi.atmOis.peOi === 0) {
    flags.push({
      category: "OI",
      severity: "REVIEW",
      message: `ATM strike ${oi.atmOis.strike} shows 0 OI on both sides — almost certainly a data gap, not a real quiet market`,
    });
  }

  return flags;
}

// ─── Greeks plausibility ───────────────────────────────────────
// Violations here are math/data bugs, not market conditions → CRITICAL.

export const IV_SANE_LOW = 5;
export const IV_SANE_HIGH = 150;

export function checkGreeksPlausibility(
  greeks: GreeksEvidence,
  optionType: "CE" | "PE" | null,
  thetaIsLong: boolean = true
): PlausibilityFlag[] {
  const flags: PlausibilityFlag[] = [];

  if (greeks.atmIv !== null) {
    if (!isFinite(greeks.atmIv) || greeks.atmIv <= 0) {
      flags.push({
        category: "GREEKS",
        severity: "CRITICAL",
        message: `ATM IV is not positive: ${greeks.atmIv}`,
      });
    } else if (greeks.atmIv < IV_SANE_LOW || greeks.atmIv > IV_SANE_HIGH) {
      flags.push({
        category: "GREEKS",
        severity: "CRITICAL",
        message: `ATM IV ${greeks.atmIv}% outside sane band ${IV_SANE_LOW}%-${IV_SANE_HIGH}%`,
      });
    }
  }

  if (greeks.atmThetaPct !== null && thetaIsLong && greeks.atmThetaPct > 0) {
    flags.push({
      category: "GREEKS",
      severity: "CRITICAL",
      message: `Long option theta is positive (${greeks.atmThetaPct}%/day) — long options must decay, sign is wrong`,
    });
  }

  // Delta bounds are checked on the raw chain leg in checkDeltaBounds.
  return flags;
}

export function checkDeltaBounds(
  delta: number | null,
  optionType: "CE" | "PE"
): PlausibilityFlag[] {
  if (delta === null || !isFinite(delta)) return [];
  const flags: PlausibilityFlag[] = [];
  if (optionType === "CE" && (delta <= 0 || delta >= 1)) {
    flags.push({
      category: "GREEKS",
      severity: "CRITICAL",
      message: `CE delta ${delta} must be in (0,1)`,
    });
  }
  if (optionType === "PE" && (delta >= 0 || delta <= -1)) {
    flags.push({
      category: "GREEKS",
      severity: "CRITICAL",
      message: `PE delta ${delta} must be in (-1,0)`,
    });
  }
  return flags;
}

// ─── News plausibility (the severe one) ────────────────────────
// A headline without a real source/URL/timestamp, or published AFTER the
// trade's entry, could not have influenced the decision → fabricated evidence.

const GENERIC_HEADLINE_PATTERNS: RegExp[] = [
  /^(market|trading|stock|nifty|sensex|bank nifty|equity)\s*(update|news|report|signal|outlook|summary)?$/i,
  /^(breaking\s+)?news$/i,
  /^(today'?s|daily)\s+(market|trading|update|news)$/i,
  /^lorem ipsum/i,
  /\{\{.*\}\}/,
  /\[headline\]/i,
  /^(sample|test|example|dummy|placeholder)\b/i,
  /^(signal|trade)\s+(alert|update|triggered)$/i,
];

export function looksLikeGenericHeadline(title: string): boolean {
  const t = title.trim();
  if (t.length < 15) return true;
  return GENERIC_HEADLINE_PATTERNS.some((p) => p.test(t));
}

export function checkNewsPlausibility(
  news: NewsEvidence,
  entryTimeIso: string
): PlausibilityFlag[] {
  const flags: PlausibilityFlag[] = [];
  const entryMs = new Date(entryTimeIso).getTime();

  for (const h of news.headlines) {
    const label = `"${h.title.slice(0, 60)}"`;

    if (!h.source || !String(h.source).trim()) {
      flags.push({
        category: "NEWS",
        severity: "CRITICAL",
        message: `Headline ${label} has no source — cannot be a real fetched article`,
      });
    }
    if (!h.url || !String(h.url).trim()) {
      flags.push({
        category: "NEWS",
        severity: "CRITICAL",
        message: `Headline ${label} has no URL — cannot be a real fetched article`,
      });
    }

    if (!h.publishedAt) {
      flags.push({
        category: "NEWS",
        severity: "CRITICAL",
        message: `Headline ${label} has no publish timestamp`,
      });
    } else if (isFinite(entryMs)) {
      const pubMs = new Date(h.publishedAt).getTime();
      if (!isFinite(pubMs)) {
        flags.push({
          category: "NEWS",
          severity: "CRITICAL",
          message: `Headline ${label} has unparseable publish time "${h.publishedAt}"`,
        });
      } else if (pubMs > entryMs) {
        flags.push({
          category: "NEWS",
          severity: "CRITICAL",
          message: `Headline ${label} published ${h.publishedAt} — AFTER trade entry ${entryTimeIso}; could not have influenced the decision (fabricated evidence)`,
        });
      }
    }

    if (looksLikeGenericHeadline(h.title || "")) {
      flags.push({
        category: "NEWS",
        severity: "CRITICAL",
        message: `Headline ${label} looks generic/generated, not an actual fetched article`,
      });
    }
  }

  return flags;
}

// ─── Per-trade verification ────────────────────────────────────

export interface TradeEvidenceResult {
  tradeId: string;
  evidence: TradeEvidence;
  flags: PlausibilityFlag[];
  integrity: "FULL" | "PARTIAL" | "PRICE_ONLY" | "FAILED";
}

export function verifyTradeEvidence(input: {
  tradeId: string;
  entryTime: string;
  optionType: "CE" | "PE" | null;
  evidence: TradeEvidence;
}): TradeEvidenceResult {
  const { tradeId, entryTime, optionType, evidence } = input;
  const flags: PlausibilityFlag[] = [];

  if (evidence.oi) flags.push(...tag(checkOiPlausibility(evidence.oi), tradeId));
  if (evidence.greeks) {
    flags.push(
      ...tag(checkGreeksPlausibility(evidence.greeks, optionType), tradeId)
    );
    // ATM delta bounds: judge only the leg matching the trade's option type
    if (optionType) {
      const delta =
        optionType === "CE"
          ? evidence.greeks.atmDeltaCe
          : evidence.greeks.atmDeltaPe;
      if (typeof delta === "number") {
        flags.push(...tag(checkDeltaBounds(delta, optionType), tradeId));
      }
    }
  }
  if (evidence.news && evidence.news.headlines.length > 0) {
    flags.push(...tag(checkNewsPlausibility(evidence.news, entryTime), tradeId));
  }

  const hasOi = !!evidence.oi;
  const hasGreeks = !!evidence.greeks;
  const hasNews = !!evidence.news && evidence.news.headlines.length > 0;
  const hasAny = hasOi || hasGreeks || hasNews;
  const critical = flags.some((f) => f.severity === "CRITICAL");

  let integrity: TradeEvidenceResult["integrity"];
  if (!evidence.available && !hasAny) integrity = "PRICE_ONLY";
  else if (critical) integrity = "FAILED";
  else if (hasOi && hasGreeks && hasNews) integrity = "FULL";
  else integrity = "PARTIAL";

  return { tradeId, evidence, flags, integrity };
}

function tag(flags: PlausibilityFlag[], tradeId: string): PlausibilityFlag[] {
  return flags.map((f) => ({ ...f, tradeId }));
}

// ─── Aggregate report ──────────────────────────────────────────

export interface EvidenceIntegrityReport {
  totalTrades: number;
  fullEvidenceTrades: number;
  partialEvidenceTrades: number;
  priceOnlyTrades: number;
  failedIntegrityTrades: number;
  oiPlausibilityFlags: number;
  greeksPlausibilityFlags: number;
  newsPlausibilityFlags: number;
  newsFabricationFailures: number;
  flaggedTrades: Array<{ tradeId: string; flags: PlausibilityFlag[] }>;
}

export function buildEvidenceIntegrityReport(
  results: TradeEvidenceResult[]
): EvidenceIntegrityReport {
  const report: EvidenceIntegrityReport = {
    totalTrades: results.length,
    fullEvidenceTrades: 0,
    partialEvidenceTrades: 0,
    priceOnlyTrades: 0,
    failedIntegrityTrades: 0,
    oiPlausibilityFlags: 0,
    greeksPlausibilityFlags: 0,
    newsPlausibilityFlags: 0,
    newsFabricationFailures: 0,
    flaggedTrades: [],
  };

  for (const r of results) {
    if (r.integrity === "FULL") report.fullEvidenceTrades++;
    else if (r.integrity === "PARTIAL") report.partialEvidenceTrades++;
    else if (r.integrity === "PRICE_ONLY") report.priceOnlyTrades++;
    else report.failedIntegrityTrades++;

    if (r.flags.length) {
      report.flaggedTrades.push({ tradeId: r.tradeId, flags: r.flags });
    }
    for (const f of r.flags) {
      if (f.category === "OI") report.oiPlausibilityFlags++;
      else if (f.category === "GREEKS") report.greeksPlausibilityFlags++;
      else if (f.category === "NEWS") {
        report.newsPlausibilityFlags++;
        // Fabrication = a CRITICAL news flag (missing provenance, post-entry
        // publish time, or generic text) — distinct and more severe than
        // an OI/Greeks bug.
        if (f.severity === "CRITICAL") report.newsFabricationFailures++;
      }
    }
  }

  return report;
}

// ─── Print formatting (section 1 printout) ─────────────────────

const NOT_AVAILABLE =
  "Evidence: NOT AVAILABLE — historical OI/Greeks data not accessible for this date, signal generated from price-structure only";

export function formatEvidenceBlock(
  evidence: TradeEvidence,
  opts: { indent?: string } = {}
): string {
  const pad = opts.indent ?? "  ";
  if (!evidence.available && !evidence.oi && !evidence.greeks && !evidence.news) {
    return `${pad}${NOT_AVAILABLE}`;
  }

  const lines: string[] = [];

  if (evidence.oi) {
    const oi = evidence.oi;
    lines.push(`${pad}Option chain evidence:`);
    const parts: string[] = [];
    if (oi.pcr !== null) parts.push(`PCR ${oi.pcr.toFixed(2)}`);
    if (oi.oiResistance)
      parts.push(
        `OI resistance ${fmtNum(oi.oiResistance.strike)} (CE OI ${fmtLakh(oi.oiResistance.ceOi)})`
      );
    if (oi.oiSupport)
      parts.push(
        `OI support ${fmtNum(oi.oiSupport.strike)} (PE OI ${fmtLakh(oi.oiSupport.peOi)})`
      );
    lines.push(`${pad}  ${parts.join(" | ")}`);

    const chg: string[] = [];
    if (oi.oiChangeNearSpot) {
      chg.push(`PE ${fmtSignedLakh(oi.oiChangeNearSpot.peChange)}`);
      chg.push(`CE ${fmtSignedLakh(oi.oiChangeNearSpot.ceChange)}`);
    }
    if (chg.length)
      lines.push(
        `${pad}  OI change near spot: ${chg.join(", ")} | Max pain ${
          oi.maxPain !== null ? fmtNum(oi.maxPain) : "n/a"
        }`
      );
  }

  if (evidence.greeks) {
    const g = evidence.greeks;
    lines.push(`${pad}Greeks evidence:`);
    const parts: string[] = [];
    if (g.atmIv !== null) parts.push(`ATM IV ${g.atmIv.toFixed(1)}%`);
    if (g.atmDeltaCe !== null) parts.push(`ATM CE delta ${g.atmDeltaCe.toFixed(2)}`);
    if (g.atmDeltaPe !== null) parts.push(`ATM PE delta ${g.atmDeltaPe.toFixed(2)}`);
    if (g.skew !== null) parts.push(`Skew (put-call) ${g.skew >= 0 ? "+" : ""}${g.skew.toFixed(2)}`);
    if (g.gammaFlip !== null) parts.push(`Gamma flip ${fmtNum(g.gammaFlip)}`);
    if (g.regime) parts.push(`Regime: ${g.regime}`);
    lines.push(`${pad}  ${parts.join(" | ")}`);

    const more: string[] = [];
    if (g.expectedMove !== null)
      more.push(`Expected move (1-sigma) ±${Math.round(g.expectedMove)} pts`);
    if (g.atmThetaPct !== null)
      more.push(`ATM theta/day ${g.atmThetaPct.toFixed(1)}% of premium`);
    if (more.length) lines.push(`${pad}  ${more.join(" | ")}`);
  }

  if (evidence.news) {
    lines.push(`${pad}News/sentiment evidence:`);
    if (evidence.news.score !== null) {
      const label =
        evidence.news.score > 0
          ? "mildly bullish"
          : evidence.news.score < 0
          ? "mildly bearish"
          : "neutral";
      lines.push(`${pad}  Score: ${evidence.news.score >= 0 ? "+" : ""}${evidence.news.score} (${label})`);
    }
    if (evidence.news.headlines.length === 0) {
      lines.push(`${pad}  Headlines used: none recorded`);
    } else {
      for (const h of evidence.news.headlines) {
        const meta = `source: ${h.source ?? "?"}, published ${h.publishedAt ?? "?"}`;
        lines.push(`${pad}  Headline: "${h.title}" (${meta})`);
      }
    }
  }

  const biasParts: string[] = [];
  if (evidence.biasScore !== null) biasParts.push(`Bias score: ${evidence.biasScore}`);
  if (evidence.groupsAgreeing !== null && evidence.groupsTotal !== null)
    biasParts.push(`Groups agreeing: ${evidence.groupsAgreeing}/${evidence.groupsTotal}`);
  if (evidence.confidence) biasParts.push(`Confidence: ${evidence.confidence}`);
  if (biasParts.length) lines.push(`${pad}${biasParts.join(" | ")}`);

  if (lines.length === 0) return `${pad}${NOT_AVAILABLE}`;
  return lines.join("\n");
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtLakh(n: number): string {
  if (Math.abs(n) >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtSignedLakh(n: number): string {
  const s = fmtLakh(Math.abs(n));
  return n >= 0 ? `+${s}` : `-${s}`;
}

export function printEvidenceIntegrityReport(
  report: EvidenceIntegrityReport
): string[] {
  const lines: string[] = [];
  lines.push("  EVIDENCE INTEGRITY CHECK");
  lines.push(`    Trades scanned:              ${report.totalTrades}`);
  lines.push(`    Full evidence (OI+Greek+news): ${report.fullEvidenceTrades}`);
  lines.push(`    Partial evidence:            ${report.partialEvidenceTrades}`);
  lines.push(
    `    Evidence NOT AVAILABLE (price-only): ${report.priceOnlyTrades}`
  );
  lines.push(`    Failed integrity (any CRITICAL): ${report.failedIntegrityTrades}`);
  lines.push("    Plausibility flags by type:");
  lines.push(`      OI flags:                  ${report.oiPlausibilityFlags}`);
  lines.push(`      Greeks flags:              ${report.greeksPlausibilityFlags}`);
  lines.push(`      News flags:                ${report.newsPlausibilityFlags}`);
  lines.push(
    `    News evidence integrity failures: ${report.newsFabricationFailures}${report.newsFabricationFailures > 0 ? "  ← SEVERE (fabricated headlines)" : ""}`
  );
  const evidencePct =
    report.totalTrades > 0
      ? (
          ((report.fullEvidenceTrades + report.partialEvidenceTrades) /
            report.totalTrades) *
          100
        ).toFixed(1)
      : "0.0";
  lines.push(
    `    Verified reasoning vs price-only: ${evidencePct}% of trades carry OI/Greeks/news evidence`
  );
  return lines;
}
