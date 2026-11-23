// daily-derivatives-knowledge.ts
// The Daily Derivatives dashboard logic + strategy, packaged so BOTH bots can
// use it truthfully:
//   · Hermes  — prompt knowledge block + the get_daily_derivatives tool
//   · Grok     — DD_STRATEGY_RULES (the deterministic rules) + the shared
//                futures-flow read (src/lib/market/futures-flow.ts)
//
// NOTHING here invents a number: every value comes from the live
// /api/daily-derivatives report, and an unavailable feed says so plainly.
//
// Educational framework, not financial advice.

import { getJSON, safeSymbol, enc, GATE_CONFIG } from "./agent-brain-gate";
import { PLAN_CONFIG } from "./option-plan";
import { LATE_OPTION_BUY_CUTOFF_IST_MINUTES } from "./market-session";

// ─────────────────────────────────────────────────────────────
// Strategy rules — derived from the canonical configs (never a copy)
// ─────────────────────────────────────────────────────────────
export const DD_STRATEGY_RULES = {
  /** Rupee risk as a fraction of the amount DEPLOYED (₹10k deployed → ₹2k risk). */
  riskPctOfDeployed: PLAN_CONFIG.riskPctOfDeployed,
  /** TP ladder in R multiples: TP1 2R, TP2 3R, TP3 4R (R:R 1:2 / 1:3 / 1:4). */
  targetMultipliers: PLAN_CONFIG.targetMultipliers,
  /** Option R:R floor the plan must clear. */
  minOptionRR: PLAN_CONFIG.minOptionRR,
  /** The stop may never exceed this % of the premium (the rupee risk shrinks). */
  maxStopPctOfPremium: PLAN_CONFIG.maxStopPctOfPremium,
  /** Stop floor — noise ticks for cheap options. */
  minStopTicks: PLAN_CONFIG.minStopTicks,
  /** The DEFAULT ₹ DEPLOYED in one trade — a size, never a cap. */
  defaultDeployedAmount: PLAN_CONFIG.defaultDeployedAmount,
  /** |delta| floor — below this an option is a lottery ticket. */
  minAbsDelta: GATE_CONFIG.minAbsDelta,
  /** OTM strikes from ATM — never deep OTM. */
  maxOtmSteps: GATE_CONFIG.maxOtmSteps,
  /** Layers that must agree before a trade is even considered. */
  minLayersAgree: GATE_CONFIG.minLayersAgree,
  /** Expiry-day index option buys are blocked. */
  allowExpiryDay: GATE_CONFIG.allowExpiryDay,
  /** No NEW option premium buys after this IST time (13:00). */
  noOptionBuysAfterIst:
    `${String(Math.floor(LATE_OPTION_BUY_CUTOFF_IST_MINUTES / 60)).padStart(2, "0")}:${String(
      LATE_OPTION_BUY_CUTOFF_IST_MINUTES % 60
    ).padStart(2, "0")}`,
  /** Two stops end the trading day. */
  maxConsecutiveLosses: GATE_CONFIG.maxConsecutiveLosses,
  maxDailyLossPct: GATE_CONFIG.maxDailyLossPct,
} as const;

const DD_SYMBOLS = ["NIFTY", "SENSEX"];

const n0 = (v: any): string => {
  const num = Number(v);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-IN", { maximumFractionDigits: 0 });
};

const n2 = (v: any): string => {
  const num = Number(v);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const pct = (v: any): string => {
  const num = Number(v);
  if (!Number.isFinite(num)) return "—";
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
};

const signed = (v: any): string => {
  const num = Number(v);
  if (!Number.isFinite(num)) return "—";
  return `${num >= 0 ? "+" : ""}${num.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
};

/** Format the live DD report for the agent (numbers only — never invented). */
export function formatDailyDerivativesReport(report: any): string {
  if (!report || typeof report !== "object") {
    return "Daily derivatives payload unreadable — do NOT invent levels.";
  }

  const L: string[] = [];
  const sym = String(report.underlying || report.symbol || "UNKNOWN");
  L.push(`DAILY DERIVATIVES — ${sym} | spot ₹${n2(report.spot)} | as of ${report.timestamp || "unknown timestamp"}`);
  L.push(
    `Feed: ${report.dataSource || "unknown"} | chain freshness ${report.freshness || "UNKNOWN"} | candles ${report.candleSource || "none"} ${
      report.candleInterval || ""
    } (${n0(report.candleCount)} bars)${report.candleDegraded ? ` | DEGRADED: ${report.candleDegraded}` : ""}`
  );
  L.push(
    `CHAIN: PCR ${Number.isFinite(Number(report.pcr)) ? Number(report.pcr).toFixed(2) : "—"} | Max pain ₹${n0(
      report.maxPain
    )} | Call wall ₹${n0(report.callWall)} | Put wall ₹${n0(report.putWall)} | ATM ₹${n0(report.atmStrike)} | ATM IV ${
      Number.isFinite(Number(report.atmIV)) ? Number(report.atmIV).toFixed(2) : "—"
    }%`
  );
  if (report.atmGreeks) {
    L.push(
      `ATM Greeks: delta ${n2(report.atmGreeks.delta)} | gamma ${report.atmGreeks.gamma} | theta ${n2(
        report.atmGreeks.theta
      )} | vega ${n2(report.atmGreeks.vega)}`
    );
  }
  L.push(
    `Sentiment: ${report.sentiment || "—"} (${n0(report.sentimentScore)}) | expiry ${report.expiry || "—"} | DTE ${
      report.daysToExpiry ?? "—"
    }`
  );

  const bias = report.directionBias;
  if (bias) {
    L.push(
      `DIRECTION BIAS: ${bias.side || "—"} (${n0(bias.callVotes)} CALL / ${n0(bias.putVotes)} PUT votes${
        bias.confidence != null ? `, ${Math.round(Number(bias.confidence) * 100)}% of cast votes` : ""
      })`
    );
    for (const v of bias.votes || []) {
      L.push(`  - [${v.factor}] ${v.vote} — ${v.detail}`);
    }
  }

  const cvd = report.cvd;
  if (cvd && cvd.available) {
    L.push("");
    L.push(
      `FUTURES FLOW (context only — never a trade vote): ${cvd.contract || "futures contract"} | ${
        cvd.bars || 0
      } bars | source ${cvd.source || "unknown"}`
    );
    L.push(
      `  CVD ${signed(cvd.cumulative)} (${Number(cvd.deltaPercent ?? 0).toFixed(2)}% of ${n0(
        cvd.totalVolume
      )} traded volume) | verdict ${cvd.verdict || "—"}`
    );
    const rel = report.futuresRelVol;
    if (rel && Number.isFinite(rel.ratio)) {
      L.push(
        `  Relative volume ${rel.ratio.toFixed(2)}x (last CLOSED bar ${n0(rel.current)} vs 20-bar avg ${n0(
          rel.average
        )}) — ${rel.ratio >= 2 ? "conviction bar" : rel.ratio >= 1 ? "above average" : "below average"}`
      );
    } else {
      L.push("  Relative volume: unavailable (never a fabricated 1.0)");
    }
    if (cvd.oiChange != null) {
      L.push(
        `  Open interest ${n0(cvd.oiFirst)} → ${n0(cvd.oiLast)} | ΔOI ${signed(cvd.oiChange)} (${pct(
          cvd.oiChangePct
        )}) | build-up ${cvd.buildup || "—"} | divergence ${cvd.divergence || "—"}`
      );
    } else {
      L.push("  Open interest: unavailable on this feed (never a fabricated zero)");
    }
    L.push(
      "  LIMIT: CVD here is candle-signed (up-bar volume counts as buy) — it cannot by itself falsify a breakout. Pair it with relative volume + ΔOI."
    );
  } else if (report.cvdFallback) {
    L.push("");
    L.push(
      `FUTURES FLOW DEGRADED: ${report.cvdFallback.contract} | day volume ${n0(
        report.cvdFallback.dayVolume
      )} | source ${report.cvdFallback.source} | ${report.cvdFallback.note}`
    );
  } else {
    L.push("");
    L.push("FUTURES FLOW: unavailable — no CVD / ΔOI read for this session.");
  }

  const plans = Array.isArray(report.tradePlans) ? report.tradePlans : [];
  if (plans.length) {
    L.push("");
    L.push("PLAN (canonical rupee-risk ladder):");
    for (const p of plans) {
      const targets = (p.targets || []).map((t: number) => `₹${n2(t)}`).join(" / ");
      L.push(
        `  ${p.optionType} ${n0(p.strike)} — entry ₹${n2(p.entry)} | stop ₹${n2(p.stopLoss)} | TP ${targets} | R:R 1:${
          p.rr ?? "—"
        } | ${n0(p.lots)} lot(s) | deployed ₹${n0(p.deployed)} | risk ₹${n0(p.riskAmount)}${
          p.tradable ? "" : " | NOT TRADABLE"
        }${p.setup ? ` | setup ${p.setup}` : ""}${p.reason ? ` | ${p.reason}` : ""}`
      );
    }
  }

  L.push("");
  L.push(
    `RULES: risk = ${Math.round(DD_STRATEGY_RULES.riskPctOfDeployed * 100)}% of the amount deployed | TP ladder 1:${DD_STRATEGY_RULES.targetMultipliers.join(
      " / 1:"
    )} | stop capped at ${Math.round(DD_STRATEGY_RULES.maxStopPctOfPremium * 100)}% of premium | 0 lots = NO TRADE (never force 1 lot) | no new option buys after ${
      DD_STRATEGY_RULES.noOptionBuysAfterIst
    } IST | |delta| ≥ ${DD_STRATEGY_RULES.minAbsDelta} | OTM ≤ ${DD_STRATEGY_RULES.maxOtmSteps} strikes | expiry day ${
      DD_STRATEGY_RULES.allowExpiryDay ? "allowed" : "blocked"
    }`
  );
  L.push(
    "Every trade still has to clear evaluate_trade_gate (layers + freshness + R:R + budget). Educational, not financial advice."
  );

  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Persisted desk knowledge — the strategy/rules both bots must remember
// ─────────────────────────────────────────────────────────────
export const DAILY_DERIVATIVES_KNOWLEDGE_NOTE = {
  topic: "daily-derivatives",
  title: "Daily Derivatives dashboard logic + strategy (canonical)",
  tags: ["derivatives", "cvd", "open-interest", "plan-ladder", "veto"],
  body: [
    "WHAT THE DASHBOARD READS: PCR, max pain, call/put walls, ATM IV + Greeks, sentiment, five visible direction votes (PCR, OI change, max-pain pull, walls, candle signals), the futures-leg CVD + ΔOI build-up, and the canonical trade-plan ladder.",
    `PLAN LADDER (canonical, one builder for every engine): risk = ${Math.round(
      DD_STRATEGY_RULES.riskPctOfDeployed * 100
    )}% of the amount DEPLOYED (₹10,000 deployed → ₹2,000 at risk); stop capped at ${Math.round(
      DD_STRATEGY_RULES.maxStopPctOfPremium * 100
    )}% of the premium (the rupee risk shrinks, never grows); floor ${DD_STRATEGY_RULES.minStopTicks} ticks; targets = 2R / 3R / 4R (R:R 1:2 / 1:3 / 1:4); option R:R floor 1:${DD_STRATEGY_RULES.minOptionRR}; |delta| ≥ ${
      DD_STRATEGY_RULES.minAbsDelta
    }; OTM ≤ ${DD_STRATEGY_RULES.maxOtmSteps} strikes; hard deployment cap ₹${DD_STRATEGY_RULES.defaultDeployedAmount.toLocaleString(
      "en-IN"
    )} per trade.`,
    "NO FIXED-CAPITAL GATE. A valid contract is never refused because of capital or lot count: the deployment budget decides the SIZE (1 lot floor), the market stop decides the RISK, and both are shown on the card.",
    `SESSION RULE: no NEW option premium buys after ${DD_STRATEGY_RULES.noOptionBuysAfterIst} IST — the ledger shows afternoon option entries went 0 wins / 34 trades.`,
    "CVD IS CANDLE-SIGNED (an up-bar's volume counts as buying), so it can NEVER by itself prove a breakout is fake — a breakout bar is positive CVD by construction. The honest fake-breakout test = futures RELATIVE VOLUME (move bar vs its own prior 20-bar average) + ΔOI at the signal bar: price↑+OI↑ = fresh longs; price↑+OI↓ = SHORT COVERING (squeeze, less durable); price↓+OI↑ = fresh shorts; price↓+OI↓ = LONG UNWINDING.",
    "DATA HONESTY: index SPOT carries no volume (the CVD proxy had nothing to sign) → the futures leg is read instead. MOAPI has no intraday futures series and no futures OI (day volume only). SENSEX/BFO futures carry no OI → ΔOI stays unknown, never zero. No aggressor-side tape exists for these indices.",
    "VETO LAYERS (signal-veto + evaluate_trade_gate): wrong-side stop, R:R below the floor, expiry-day index option, |delta| too low, too many OTM steps, capital/lot caps (removed), loss streak, daily-loss cap, stale feed — all fail closed.",
  ].join("\n"),
} as const;

/** Write the canonical DD knowledge into the agent memory store (idempotent). */
export async function persistDailyDerivativesKnowledge(): Promise<void> {
  try {
    // Lazy import keeps this module usable in contexts without the file store.
    const { ensureKnowledgeNote } = await import("./agent-memory");
    ensureKnowledgeNote({
      topic: DAILY_DERIVATIVES_KNOWLEDGE_NOTE.topic,
      title: DAILY_DERIVATIVES_KNOWLEDGE_NOTE.title,
      body: DAILY_DERIVATIVES_KNOWLEDGE_NOTE.body,
      tags: [...DAILY_DERIVATIVES_KNOWLEDGE_NOTE.tags],
    });
  } catch {
    /* memory store unavailable — the knowledge still lives in the prompt + tool */
  }
}

// ─────────────────────────────────────────────────────────────
// Tool definition + executor
// ─────────────────────────────────────────────────────────────
export const DAILY_DERIVATIVES_TOOL = {
  type: "function",
  function: {
    name: "get_daily_derivatives",
    description:
      "Read the Daily Derivatives dashboard: PCR, max pain, call/put walls, ATM IV + Greeks, sentiment, the deterministic direction-bias votes, the futures-leg CVD + open-interest build-up, and the canonical rupee-risk trade-plan ladder (entry / stop / TP1-3, lots, deployed, risk). Use for: PCR, max pain, walls, CVD, cumulative delta, open interest build-up, derivatives dashboard, 'is the move real or short covering'. Prefer this over guessing levels from get_option_chain.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "NIFTY or SENSEX" },
      },
      required: [],
    },
  },
};

export async function runGetDailyDerivatives(args: any, baseUrl: string): Promise<string> {
  const symbol = safeSymbol(args?.symbol, "NIFTY");
  if (!DD_SYMBOLS.includes(symbol)) {
    return `Daily derivatives is available for NIFTY and SENSEX only (got ${symbol}). Do NOT invent PCR, walls, CVD or plan levels.`;
  }
  const r = await getJSON(`${baseUrl}/api/daily-derivatives?symbol=${enc(symbol)}`, {
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!r.ok) {
    return `Daily derivatives unavailable (${r.error}). Do NOT invent PCR, walls, CVD or plan levels — say the feed is down and ask for pasted data.`;
  }
  const payload: any = r.data;
  if (payload?.success === false) {
    return `Daily derivatives unavailable (${payload?.error || "unknown error"}). Do NOT invent PCR, walls, CVD or plan levels.`;
  }
  const report = payload?.data ?? payload;
  if (!report || typeof report !== "object") {
    return "Daily derivatives payload unreadable — do NOT invent levels.";
  }
  return formatDailyDerivativesReport(report);
}

// ─────────────────────────────────────────────────────────────
// Prompt knowledge block (Hermes)
// ─────────────────────────────────────────────────────────────
export const DAILY_DERIVATIVES_KNOWLEDGE = `## DAILY DERIVATIVES DASHBOARD (use get_daily_derivatives; explain it in plain words)
This is the desk's own derivatives read — PCR, max pain, call/put walls, ATM IV + Greeks, sentiment, the visible direction-bias votes, the futures-leg flow, and the trade-plan ladder.
- PCR: >1 put-heavy (bullish lean), <0.85 call-heavy (bearish lean), 0.85-1 neutral. The TREND in PCR matters more than the level; max pain is a weak predictor. Never trade PCR alone.
- Walls: the highest CALL OI above price is resistance, the highest PUT OI below is support. A wall that is STRENGTHENING (fresh OI) matters more than an old one. Price breaking a wall AND HOLDING is where the buys are.
- Direction bias: the dashboard shows every factor's vote (PCR, OI change, max-pain pull, walls, candle signals) and the side with the majority. Read the votes out loud — don't hide them.
- Futures flow (CONTEXT ONLY — it is never a trade vote by itself): CVD is CANDLE-SIGNED (an up-bar's volume counts as buying), so it can NEVER by itself prove a breakout is fake — a breakout bar is positive CVD by construction. The honest fake-breakout test is futures RELATIVE VOLUME (the move bar vs its own prior 20-bar average) plus ΔOI at the signal bar:
  • price ↑ + OI ↑ = fresh longs (real build-up) • price ↑ + OI ↓ = SHORT COVERING (squeeze — less durable, higher fakeout risk)
  • price ↓ + OI ↑ = fresh shorts (real sell build-up) • price ↓ + OI ↓ = LONG UNWINDING (not fresh selling)
  CVD is still useful for: exhaustion/divergence at extremes, absorption, session delta vs the bias, and OI-based S/R confirmation.
- Plan ladder (canonical, one builder for every engine): the risk is a RUPEE amount = 20% of what the trade DEPLOYS (₹10,000 deployed → ₹2,000 at risk), the stop is capped at 35% of the premium, and the targets are clean R multiples — TP1 2R, TP2 3R, TP3 4R (R:R 1:2 / 1:3 / 1:4). A contract that doesn't fit the ₹45,000 per-trade deployment budget is 0 lots = NO TRADE — never force it to 1 lot.
- Other hard rules: no new option premium buys after 13:00 IST (the ledger says afternoon option entries went 0 wins / 34 trades), |delta| ≥ 0.35, OTM ≤ 3 strikes from ATM, expiry-day index options are blocked, and every candidate still has to clear evaluate_trade_gate.
- Honest limits: OI can't prove buyer vs writer, CVD isn't aggressor-side, the MOAPI fallback only has day volume (no intraday series, no OI), and SENSEX futures carry no OI at all. If a number is missing, say it's missing. Educational, not financial advice.`;
