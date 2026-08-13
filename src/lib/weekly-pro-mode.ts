// Weekly Equity Scanner — Stage 2: Pro Mode deep research dossier
//
// Per the AI Pro Prompt spec, Stage 2 takes each shortlisted symbol and runs a
// full research dossier across five angles — technical, fundamental,
// news & sentiment, institutional & delivery, risk — then produces a
// BUY / WATCH / AVOID verdict. A clean chart alone is not enough: if the
// fundamental, news, or institutional picture contradicts the technical
// setup, the verdict is downgraded to WATCH regardless of chart quality.

import type { WeeklyCandidate } from "@/lib/weekly-equity-scanner";
import { getNewsScore, fetchStockNews } from "@/lib/news-engine";
import { fetchFiiDiiData } from "@/lib/fii-dii";

// ─── Types ────────────────────────────────────────────────────────
export interface FundamentalSnapshot {
  available: boolean;
  trailingPE: number | null;
  marketCap: number | null;
  revenueGrowth: number | null;
  profitMargins: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  note: string;
  redFlags: string[];
  score: number; // 0-100
}

export interface NewsSentimentSection {
  score: number; // 0-100
  label: string;
  articles: { title: string; source: string; sentiment: number; publishedAt: string }[];
  note: string;
}

export interface InstitutionalSection {
  score: number; // 0-100
  fiiNet: number | null;
  diiNet: number | null;
  note: string;
}

export interface RiskSection {
  score: number; // 0-100 (higher = safer)
  reasons: string[];
  invalidation: string;
  note: string;
}

export interface ProResearchDossier {
  symbol: string;
  name: string;
  sector: string;
  verdict: "BUY" | "WATCH" | "AVOID";
  confidence: number;
  whyNow: string;
  invalidates: string;
  // The five research angles
  technical: {
    price: number;
    weeklyTrend: string;
    rsi: number;
    adx: number;
    rvol: number;
    support: number;
    resistance: number;
    entryZone: { low: number; high: number };
    stopLoss: number;
    target1: number;
    target2: number;
    riskReward: number;
    note: string;
  };
  fundamental: FundamentalSnapshot;
  news: NewsSentimentSection;
  institutional: InstitutionalSection;
  risk: RiskSection;
  timestamp: string;
  dataSource: string;
}

// ─── Fundamentals via Yahoo quoteSummary (crumb flow) ────────────
let yahooCrumb: { value: string; cookies: string } | null = null;

async function getYahooCrumb(): Promise<{ value: string; cookies: string } | null> {
  if (yahooCrumb) return yahooCrumb;
  try {
    const jarRes = await fetch("https://fc.yahoo.com/", { signal: AbortSignal.timeout(8000) });
    // Extract only the A= / A3= cookie pairs — the raw header also carries
    // Expires/Path attributes whose values contain commas that break naive
    // split(",") parsing.
    const setCookies = jarRes.headers.get("set-cookie") || "";
    const pairs = [...setCookies.matchAll(/([A-Za-z0-9]+)=([^;]*);/g)]
      .map(m => `${m[1]}=${m[2].trim()}`)
      .join("; ");
    if (!pairs) return null;

    let crumb = "";
    for (let attempt = 0; attempt < 3 && !crumb; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        signal: AbortSignal.timeout(8000),
        headers: { Cookie: pairs, "User-Agent": "Mozilla/5.0" },
      });
      const text = (await crumbRes.text()).replace(/"/g, "").trim();
      if (text && !text.toLowerCase().includes("too many")) crumb = text;
    }
    if (!crumb) return null;

    yahooCrumb = { value: crumb, cookies: pairs };
    return yahooCrumb;
  } catch {
    return null;
  }
}

async function fetchFundamentals(symbol: string): Promise<FundamentalSnapshot> {
  const empty = (note: string): FundamentalSnapshot => ({
    available: false,
    trailingPE: null,
    marketCap: null,
    revenueGrowth: null,
    profitMargins: null,
    priceToBook: null,
    dividendYield: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    note,
    redFlags: [],
    score: 50,
  });

  try {
    const crumb = await getYahooCrumb();
    if (!crumb) return empty("Fundamental data unavailable (Yahoo crumb denied).");

    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}.NS?modules=summaryDetail,financialData,price,defaultKeyStatistics&crumb=${encodeURIComponent(crumb.value)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Cookie: crumb.cookies, "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return empty("Fundamental data unavailable (Yahoo quoteSummary HTTP " + res.status + ").");

    const r = res.json();
    const data = await r;
    const quote = data?.quoteSummary?.result?.[0];
    if (!quote) return empty("Fundamental data unavailable (no result from Yahoo).");

    const summ = quote.summaryDetail || {};
    const fin = quote.financialData || {};
    const price = quote.price || {};

    const trailingPE = summ.trailingPE?.raw ?? null;
    const marketCap = summ.marketCap?.raw ?? null;
    const revenueGrowth = fin.revenueGrowth?.raw ?? null;
    const profitMargins = fin.profitMargins?.raw ?? null;
    const priceToBook = summ.priceToBook?.raw ?? null;
    const dividendYield = summ.dividendYield?.raw ?? null;
    const fiftyTwoWeekHigh = summ.fiftyTwoWeekHigh?.raw ?? null;
    const fiftyTwoWeekLow = summ.fiftyTwoWeekLow?.raw ?? null;

    // Score + red flags
    let score = 55;
    const redFlags: string[] = [];
    if (revenueGrowth != null) {
      if (revenueGrowth > 0.15) score += 10;
      else if (revenueGrowth > 0.05) score += 5;
      else if (revenueGrowth < -0.05) score -= 12;
      if (revenueGrowth < -0.1) redFlags.push("Revenue contracting YoY");
    }
    if (profitMargins != null) {
      if (profitMargins > 0.15) score += 8;
      else if (profitMargins < 0.03) { score -= 8; redFlags.push("Thin profit margins"); }
    }
    if (trailingPE != null) {
      if (trailingPE > 50) { score -= 5; redFlags.push("Rich valuation (P/E > 50)"); }
      else if (trailingPE > 0 && trailingPE < 15) score += 5;
    }
    if (priceToBook != null && priceToBook > 10) { score -= 3; }
    score = Math.max(5, Math.min(95, Math.round(score)));

    const noteParts = [];
    if (revenueGrowth != null) noteParts.push(`rev growth ${(revenueGrowth * 100).toFixed(1)}%`);
    if (profitMargins != null) noteParts.push(`margin ${(profitMargins * 100).toFixed(1)}%`);
    if (trailingPE != null) noteParts.push(`P/E ${trailingPE.toFixed(1)}`);
    if (marketCap != null) noteParts.push(`mkt cap ${formatCrore(marketCap)}`);
    const note = noteParts.length ? noteParts.join(" · ") : "Key metrics unavailable.";

    return {
      available: true,
      trailingPE,
      marketCap,
      revenueGrowth,
      profitMargins,
      priceToBook,
      dividendYield,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      note,
      redFlags,
      score,
    };
  } catch {
    return empty("Fundamental data unavailable.");
  }
}

function formatCrore(n: number): string {
  if (n >= 1e12) return "₹" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return "₹" + (n / 1e9).toFixed(1) + "L Cr"; // 1e9 INR = 100 Cr
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(1) + "K Cr";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

// ─── News & sentiment ─────────────────────────────────────────────
async function fetchNewsSection(symbol: string): Promise<NewsSentimentSection> {
  try {
    const [articles, score] = await Promise.all([
      fetchStockNews(symbol).catch(() => [] as any[]),
      getNewsScore(symbol).catch(() => 50),
    ]);
    const list = (articles || []).slice(0, 5).map((a: any) => ({
      title: a.title || "",
      source: a.source || "",
      sentiment: a.sentiment ?? 0,
      publishedAt: a.publishedAt || "",
    }));
    const label = score >= 65 ? "Positive" : score >= 40 ? "Neutral" : "Negative";
    const note = list.length
      ? `${list.length} article(s) found; sentiment ${label.toLowerCase()} (${score}/100).`
      : `No recent news headlines matched ${symbol}. Sentiment treated as neutral.`;
    return { score, label, articles: list, note };
  } catch {
    return { score: 50, label: "Neutral", articles: [], note: "News feed unavailable — treated as neutral." };
  }
}

// ─── Institutional & delivery (FII/DII market context) ───────────
async function fetchInstitutionalSection(): Promise<InstitutionalSection> {
  try {
    const data = await fetchFiiDiiData();
    const latest = data.latest;
    if (!latest) {
      return { score: 50, fiiNet: null, diiNet: null, note: "Institutional flow data unavailable." };
    }
    const fiiNet = latest.fiiNet ?? null;
    const diiNet = latest.diiNet ?? null;
    let score = 50;
    const noteParts = [];
    if (fiiNet != null) {
      noteParts.push(`FII ${fiiNet >= 0 ? "+" : ""}${fiiNet.toFixed(0)} Cr`);
      score += fiiNet > 1000 ? 10 : fiiNet > 0 ? 4 : fiiNet < -1000 ? -10 : -4;
    }
    if (diiNet != null) {
      noteParts.push(`DII ${diiNet >= 0 ? "+" : ""}${diiNet.toFixed(0)} Cr`);
      score += diiNet > 1000 ? 6 : diiNet > 0 ? 2 : -4;
    }
    const note = noteParts.length ? noteParts.join(" · ") + " (market-wide)" : "Institutional flow unavailable.";
    return { score: Math.max(5, Math.min(95, score)), fiiNet, diiNet, note };
  } catch {
    return { score: 50, fiiNet: null, diiNet: null, note: "Institutional flow data unavailable." };
  }
}

// ─── Verdict synthesis ────────────────────────────────────────────
function synthesizeVerdict(d: Omit<ProResearchDossier, "verdict" | "confidence" | "whyNow" | "invalidates">): Pick<ProResearchDossier, "verdict" | "confidence" | "whyNow" | "invalidates"> {
  const t = d.technical;
  const f = d.fundamental;
  const n = d.news;
  const inst = d.institutional;
  const r = d.risk;

  // Directional agreement per research angle (need 2+ of 5 agreeing)
  const techBull = t.rvol >= 1.2 && t.adx >= 20 && t.weeklyTrend !== "DOWN" && t.riskReward >= 1.5;
  const fundBull = f.available && f.score >= 60;
  const fundBear = f.available && (f.score <= 35 || f.redFlags.length > 0);
  const newsBull = n.score >= 60;
  const newsBear = n.score <= 35;
  const instBull = inst.score >= 60;
  const instBear = inst.score <= 40;
  const riskGood = r.score >= 60;

  const bullCount = [techBull, fundBull, newsBull, instBull, riskGood].filter(Boolean).length;

  // Contradiction check: clean chart but fundamentals/news/institutional negative → WATCH
  const contradiction = (fundBear || newsBear || instBear) && techBull;

  let verdict: "BUY" | "WATCH" | "AVOID" = "BUY";
  if (contradiction) verdict = "WATCH";
  else if (bullCount < 2) verdict = bullCount <= 1 && (fundBear || newsBear || instBear) ? "AVOID" : "WATCH";

  // Confidence: base on technical confidence + agreement depth, capped by contradictions
  let confidence = Math.round(45 + bullCount * 10);
  if (techBull) confidence += 8;
  if (contradiction) confidence = Math.min(confidence, 55);
  confidence = Math.max(10, Math.min(95, confidence));

  const whyNow = techBull
    ? `Uptrend confirmed on daily + weekly with ${t.rvol.toFixed(1)}x relative volume and ADX ${t.adx.toFixed(0)}; entry ${fmtINR(t.entryZone.low)}–${fmtINR(t.entryZone.high)} near support ${fmtINR(t.support)}.`
    : `Setup is borderline — daily momentum without full weekly confirmation.`;

  const invalidates = r.invalidation || `Close below stop-loss ${fmtINR(t.stopLoss)} or a break below support ${fmtINR(t.support)}.`;

  return { verdict, confidence, whyNow, invalidates };
}

function fmtINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

// ─── Stage 2 entry point ──────────────────────────────────────────
export async function runProResearch(candidate: WeeklyCandidate): Promise<ProResearchDossier> {
  const timestamp = new Date().toISOString();

  const [fundamental, news, institutional] = await Promise.all([
    fetchFundamentals(candidate.symbol),
    fetchNewsSection(candidate.symbol),
    fetchInstitutionalSection(),
  ]);

  // Risk assessment
  const riskReasons: string[] = [];
  if (candidate.flags.length) riskReasons.push(...candidate.flags);
  if (candidate.bearCase) riskReasons.push(candidate.bearCase);
  if (fundamental.redFlags.length) riskReasons.push(...fundamental.redFlags);
  if (fundamental.available && fundamental.trailingPE != null && fundamental.trailingPE > 60) riskReasons.push("Elevated valuation");
  let riskScore = 70;
  riskScore -= riskReasons.length * 8;
  if (candidate.weeklyTrend === "UP") riskScore += 10;
  riskScore = Math.max(5, Math.min(95, Math.round(riskScore)));
  const invalidation = riskReasons[0]?.includes("stop")
    ? `Close below stop-loss ${fmtINR(candidate.stopLoss)}.`
    : `Break below support ${fmtINR(candidate.support)} or a close below the weekly 20-EMA invalidates the setup.`;

  const risk: RiskSection = {
    score: riskScore,
    reasons: riskReasons.slice(0, 6),
    invalidation,
    note: riskReasons.length
      ? `${riskReasons.length} risk factor(s) identified; score reflects the worst-case.`
      : "No material risk factors surfaced in the scan.",
  };

  const technical = {
    price: candidate.price,
    weeklyTrend: candidate.weeklyTrend,
    rsi: candidate.rsi,
    adx: candidate.adx,
    rvol: candidate.rvol,
    support: candidate.support,
    resistance: candidate.resistance,
    entryZone: candidate.entryZone,
    stopLoss: candidate.stopLoss,
    target1: candidate.target1,
    target2: candidate.target2,
    riskReward: candidate.riskReward,
    note: candidate.confidenceNote || candidate.bullCase,
  };

  const base = {
    symbol: candidate.symbol,
    name: candidate.name,
    sector: candidate.sector,
    technical,
    fundamental,
    news,
    institutional,
    risk,
    timestamp,
    dataSource: "Yahoo Finance + NSE announcements + news feeds",
  };

  const synth = synthesizeVerdict(base);
  return { ...base, ...synth };
}