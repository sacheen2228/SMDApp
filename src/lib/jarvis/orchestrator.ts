// One function, `buildSignal`, turns a MarketSnapshot into a JarvisSignal:
// runs every scorer, picks a strategy, applies every no-trade gate from
// SKILL.md / strategies.md, and constructs entry/SL/TP when a trade clears.
// `runJarvisCycle` wraps that for the live loop: dedupes repeat alerts,
// writes to memory, and only fires the alert sink above a confidence bar.
import type {
  MarketSnapshot, JarvisSignal, ComponentScores, Action, TradeIdea,
  DataSource, MemorySink, AlertSink, NewsSentimentProvider, Instrument,
} from "./types";
import { analyseGreeks } from "./greeks";
import { buildLevels } from "./levels";
import { optionChainScore, fiiScore, bseFiiAdjustment, breadthScore, heatmapScore } from "./scoring";
import { classifyRegime, pickStrategy } from "./strategy";

export interface JarvisConfig {
  agentId: string;
  riskPctPerTrade: number; // e.g. 0.01
  capital: number;
  lotSize: Record<Instrument, number>;
  minScoreToTrade: number; // default 40
  minGroupsAgreeing: number; // default 4 of 9
  minConfidenceToAlert: "Moderate" | "High" | "Very high"; // don't spam on Moderate if you want fewer, louder alerts
  cooldownMinutesBetweenAlerts: number; // don't re-alert the same direction every cycle
}

export const DEFAULT_CONFIG: JarvisConfig = {
  agentId: "jarvis",
  riskPctPerTrade: 0.01,
  capital: 200000,
  lotSize: { NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 65 },
  minScoreToTrade: 40,
  minGroupsAgreeing: 4,
  minConfidenceToAlert: "High",
  cooldownMinutesBetweenAlerts: 20,
};

function isMarketHours(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}
function minutesSinceOpenIst(): number {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist.getHours() * 60 + ist.getMinutes() - (9 * 60 + 15);
}

export async function buildSignal(
  snap: MarketSnapshot,
  news: { score: number; headlines: string[]; notes: string[] } | null,
  config: JarvisConfig
): Promise<JarvisSignal> {
  const gates: string[] = [];
  const reasons: string[] = [];

  const fetchedMin = (Date.now() - new Date(snap.fetchedAtIso).getTime()) / 60000;
  if (fetchedMin > 15) gates.push(`data is ${Math.round(fetchedMin)} min old (>15 min limit)`);
  if (!isMarketHours()) gates.push("outside market hours");
  const mins = minutesSinceOpenIst();
  if (mins >= 0 && mins < 15) gates.push("within first 15 min of open (09:15-09:30): observe only");
  if (mins > 330) gates.push("after 14:45 IST: no fresh entry"); // 330 = 5h30m after 09:15

  let greeks;
  try {
    greeks = analyseGreeks(snap.optionChain, { indiaVix: snap.indiaVix });
  } catch (e) {
    return noTrade(config, snap, [`option chain unusable: ${(e as Error).message}`], []);
  }
  gates.push(...greeks.gatesFailed);

  const levels = buildLevels(snap.optionChain, snap.ohlc);
  const oc = optionChainScore(snap.optionChain);
  const fii = fiiScore(snap.fiiDii) + bseFiiAdjustment(snap.bseFiiAgrees ?? null);
  const heat = heatmapScore(snap.heatmap);
  // Breadth/OI-spurts/pre-open/52wk need extra feeds not modelled generically here;
  // pass gainersCount/losersCount etc from your smd-context if you have them, else 0.
  const breadth = 0;
  const oiSpurts = 0;
  const preopenClose = 0;
  const week52 = 0;
  const newsScore = news?.score ?? 0;

  const componentScores: ComponentScores = {
    optionChain: oc.score, fii, greeks: greeks.greekScore, heatmap: heat.score,
    oiSpurts, preopenClose, breadth, week52, newsSentiment: newsScore,
  };
  const biasScore = Math.max(-100, Math.min(100,
    Object.values(componentScores).reduce((a, b) => a + b, 0)
  ));
  const groupsAgreeing = Object.values(componentScores).filter(
    (v) => (biasScore >= 0 ? v > 0 : v < 0)
  ).length;

  const regime = classifyRegime(greeks, snap.indiaVix, ((snap.ohlc?.orHigh ?? snap.optionChain.underlyingValue) - snap.optionChain.underlyingValue) / snap.optionChain.underlyingValue * 100);
  const spot = snap.optionChain.underlyingValue;
  const nearRes = oc.resistance !== undefined && Math.abs(spot - oc.resistance) / spot < 0.0015;
  const nearSup = oc.support !== undefined && Math.abs(spot - oc.support) / spot < 0.0015;

  const strat = pickStrategy({
    regime,
    levels,
    greeks,
    atWall: nearRes ? "resistance" : nearSup ? "support" : null,
    wallOiRising: null, // needs previous-cycle OI delta at the wall; wire from your OI-spurts feed if available
    sweptLevel: null, // needs intraday high/low vs pdh/pdl; wire from your candle feed
    priceHeldBeyondWall: false,
    orBreakout: snap.ohlc?.orHigh && spot > snap.ohlc.orHigh ? "up" : snap.ohlc?.orLow && spot < snap.ohlc.orLow ? "down" : null,
    vwapPullbackDirection: null,
    shortCoveringDirection: null,
    isPostClose: mins > 375, // ~15:30
    vix: snap.indiaVix,
  });

  if (Math.abs(biasScore) < config.minScoreToTrade) gates.push(`|score| ${biasScore} below ${config.minScoreToTrade}`);
  if (groupsAgreeing < config.minGroupsAgreeing) gates.push(`only ${groupsAgreeing}/9 groups agree (need ${config.minGroupsAgreeing})`);
  if (!strat) gates.push("no named strategy fits current price/levels");
  if (levels.confluenceZones.length === 0) gates.push("no confluence zone near spot");

  reasons.push(`PCR ${oc.pcr}, support ${oc.support}, resistance ${oc.resistance}`);
  reasons.push(`Greek score ${greeks.greekScore} (skew ${greeks.skewPutMinusCall}, regime ${greeks.regime}, gamma flip ${greeks.gammaFlip})`);
  reasons.push(`Heatmap weighted move ${heat.weightedPct}%${heat.narrow ? " (narrow rally)" : ""}`);
  if (news) reasons.push(`News sentiment ${news.score}: ${news.notes.join("; ")}`);
  if (strat) reasons.push(`Strategy ${strat.id}: ${strat.rationale}`);

  if (gates.length > 0) {
    return noTrade(config, snap, gates, reasons, componentScores, biasScore, groupsAgreeing, oc, greeks, news);
  }

  const action: Action = biasScore >= config.minScoreToTrade ? "BUY_CE" : "BUY_PE";
  const optionType = action === "BUY_CE" ? "CE" : "PE";
  const atmStrike = greeks.atmStrike;
  const step = 50; // adjust for BANKNIFTY (100) if instrument !== NIFTY
  const strike = optionType === "CE" ? atmStrike : atmStrike; // ATM by default; swap to atmStrike-step / +step for 1-ITM per your delta target
  const row = snap.optionChain.data.find((r) => r.strikePrice === strike && r.expiryDate === greeks.expiry);
  const leg = row?.[optionType];
  const entry = leg?.lastPrice ?? 0;
  const sl = round(entry * 0.75, 1);
  const tp1 = round(entry * 1.4, 1);
  const tp2 = round(entry * 1.8, 1);
  const underlyingInvalidation = optionType === "CE" ? (oc.support ?? spot * 0.995) : (oc.resistance ?? spot * 1.005);
  const rr = sl < entry ? round((tp1 - entry) / (entry - sl), 2) : 0;

  const confidence =
    Math.abs(biasScore) >= 80 ? "Very high" : Math.abs(biasScore) >= 60 ? "High" : "Moderate";

  const trade: TradeIdea = {
    expiry: greeks.expiry,
    strike,
    optionType,
    entryZone: [round(entry * 0.97, 1), round(entry * 1.03, 1)],
    stopLossPremium: sl,
    tp1Premium: tp1,
    tp2Premium: tp2,
    underlyingInvalidation,
    underlyingTargets: optionType === "CE" ? [levels.levels.oiResistance ?? spot, levels.levels.expMoveUp ?? spot] : [levels.levels.oiSupport ?? spot, levels.levels.expMoveDown ?? spot],
    riskRewardTp1: rr,
    timeStopIso: new Date(Date.now() + 45 * 60000).toISOString(),
  };

  if (rr < 1.5) {
    return noTrade(config, snap, [`reward:risk at TP1 is ${rr}, below 1.5 minimum`], reasons, componentScores, biasScore, groupsAgreeing, oc, greeks, news);
  }

  return {
    agentId: config.agentId,
    timestampIso: new Date().toISOString(),
    instrument: snap.instrument,
    spot,
    biasScore: Math.round(biasScore),
    componentScores,
    groupsAgreeing,
    strategy: strat!.id,
    strategyName: strat!.name,
    levelsUsed: levels.levelsNearSpot,
    confluenceZone: levels.confluenceZones[0]?.priceRange ?? null,
    action,
    confidence,
    trade,
    keyLevels: { support: oc.support, resistance: oc.resistance, maxPain: levels.levels.maxPain, pcr: oc.pcr },
    greeks: {
      atmIv: greeks.atmIv, skewPutMinusCall: greeks.skewPutMinusCall, gammaFlip: greeks.gammaFlip,
      regime: greeks.regime, expectedMove1Sigma: greeks.expectedMove1Sigma, hoursToExpiry: greeks.hoursToExpiry,
    },
    newsHeadlinesUsed: news?.headlines ?? [],
    reasons,
    gatesFailed: [],
    dataFreshnessMinutes: Math.round(fetchedMin),
    disclaimer: "Educational analysis based on public market data, not investment advice.",
  };
}

function noTrade(
  config: JarvisConfig, snap: MarketSnapshot, gates: string[], reasons: string[],
  componentScores?: ComponentScores, biasScore = 0, groupsAgreeing = 0,
  oc?: ReturnType<typeof optionChainScore>, greeks?: ReturnType<typeof analyseGreeks>,
  news?: { score: number; headlines: string[]; notes: string[] } | null
): JarvisSignal {
  return {
    agentId: config.agentId,
    timestampIso: new Date().toISOString(),
    instrument: snap.instrument,
    spot: snap.optionChain?.underlyingValue ?? 0,
    biasScore: Math.round(biasScore),
    componentScores: componentScores ?? {
      optionChain: 0, fii: 0, greeks: 0, heatmap: 0, oiSpurts: 0, preopenClose: 0, breadth: 0, week52: 0, newsSentiment: 0,
    },
    groupsAgreeing,
    strategy: null,
    strategyName: null,
    levelsUsed: [],
    confluenceZone: null,
    action: "NO_TRADE",
    confidence: "NA",
    trade: null,
    keyLevels: { support: oc?.support, resistance: oc?.resistance, pcr: oc?.pcr },
    greeks: greeks
      ? { atmIv: greeks.atmIv, skewPutMinusCall: greeks.skewPutMinusCall, gammaFlip: greeks.gammaFlip, regime: greeks.regime, expectedMove1Sigma: greeks.expectedMove1Sigma, hoursToExpiry: greeks.hoursToExpiry }
      : null,
    newsHeadlinesUsed: news?.headlines ?? [],
    reasons,
    gatesFailed: gates,
    dataFreshnessMinutes: 0,
    disclaimer: "Educational analysis based on public market data, not investment advice.",
  };
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

// ---------------------------------------------------------------------------
// Live loop
// ---------------------------------------------------------------------------

const confidenceRank = { NA: 0, Low: 1, Moderate: 2, High: 3, "Very high": 4 } as const;

export async function runJarvisCycle(
  instrument: Instrument,
  deps: { dataSource: DataSource; memory: MemorySink; alerts: AlertSink; newsProvider?: NewsSentimentProvider },
  config: JarvisConfig = DEFAULT_CONFIG
): Promise<JarvisSignal> {
  const snap = await deps.dataSource.getSnapshot(instrument);
  const news = deps.newsProvider ? await deps.newsProvider.getSentiment(instrument) : null;
  const signal = await buildSignal(
    snap,
    news ? { score: news.score, headlines: news.headlines.map((h) => h.title), notes: news.notes } : null,
    config
  );

  await deps.memory.saveSignal(signal);

  if (signal.action !== "NO_TRADE" && confidenceRank[signal.confidence] >= confidenceRank[config.minConfidenceToAlert]) {
    const lastTs = await deps.memory.getLastAlertTimestamp(instrument);
    const cooledDown = !lastTs || (Date.now() - new Date(lastTs).getTime()) / 60000 >= config.cooldownMinutesBetweenAlerts;
    if (cooledDown) {
      await deps.alerts.send(signal, formatAlertMessage(signal));
    }
  }
  return signal;
}

export function formatAlertMessage(s: JarvisSignal): string {
  if (s.action === "NO_TRADE" || !s.trade) return `${s.instrument}: NO TRADE — ${s.gatesFailed.join("; ") || "conditions not met"}`;
  const t = s.trade;
  return [
    `${s.instrument} | ${new Date(s.timestampIso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST | Bias ${s.biasScore} (${s.confidence})`,
    `${s.action} ${t.strike} ${t.optionType} (${t.expiry}) via ${s.strategy} — ${s.strategyName}`,
    `Entry ${t.entryZone[0]}-${t.entryZone[1]} | SL ${t.stopLossPremium} | TP1 ${t.tp1Premium} | TP2 ${t.tp2Premium} | RR ${t.riskRewardTp1}`,
    `Invalidation: underlying ${t.underlyingInvalidation} | Time stop ${new Date(t.timeStopIso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `Why: ${s.reasons.slice(0, 3).join(" | ")}`,
    s.disclaimer,
  ].join("\n");
}
