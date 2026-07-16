// app/api/sdm-chat/route.ts
//
// In-app SDM chat endpoint. Builds a live SDMContext from the real
// option-chain + news + gap + correlation APIs and runs it through
// handleSDMMessage(), the same logic the Telegram bot uses.

import { NextRequest, NextResponse } from "next/server";
import { handleSDMMessage, type SDMContext, type NewsSummary, type GapInfo, type CorrInfo } from "@/lib/sdmChat";
import { fetchNewsSentiment } from "@/lib/newsSentimentAdapter";
import { detectIntent, type OptionChainRow, type IndexChainData } from "@/lib/tradeAlertEngine";
import { llmResolveIntent } from "@/lib/llmResolve";
import { getHistory, appendTurn } from "@/lib/historyStore";

const CHAT_KEY = "web"; // in-app chat shares one conversation context

const BASE = process.env.INTERNAL_API_BASE || "";

const ALL_INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

async function fetchIndexChain(symbol: string, base: string): Promise<IndexChainData | null> {
  try {
    const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    const d = json?.data;
    if (!d) return null;
    return {
      symbol,
      spot: d.spotPrice || d.summary?.spotPrice || 0,
      pcr: d.summary?.pcr ?? 1,
      vix: d.summary?.indiaVIX ?? 15,
      expiryLabel: d.expiries?.[0]?.label || d.summary?.selectedExpiry,
      chain: (d.data || []).map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? {
          ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0,
          iv: row.ce.iv || 0, delta: row.ce.delta || 0, vol: row.ce.volume || row.ce.vol || 0,
        } : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
        pe: row.pe ? {
          ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0,
          iv: row.pe.iv || 0, delta: row.pe.delta || 0, vol: row.pe.volume || row.pe.vol || 0,
        } : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
      })),
    };
  } catch { return null; }
}

async function fetchAllIndexChains(base: string): Promise<IndexChainData[]> {
  const results = await Promise.allSettled(ALL_INDICES.map(sym => fetchIndexChain(sym, base)));
  return results
    .map((r, i) => r.status === "fulfilled" && r.value ? r.value : null)
    .filter((v): v is IndexChainData => v !== null && v.chain.length > 0);
}

function mapNews(json: any): NewsSummary | null {
  const m = json?.data;
  if (!m) return null;
  const labelMap: Record<string, string> = {
    EXTREME_GREED: "Extreme Greed", GREED: "Greed",
    NEUTRAL: "Neutral", FEAR: "Fear", EXTREME_FEAR: "Extreme Fear",
  };
  return {
    mood: labelMap[m.label] || m.label || "Neutral",
    score: m.overall ?? 50,
    topBullish: (m.topBullish || []).map((s: any) => s.symbol),
    topBearish: (m.topBearish || []).map((s: any) => s.symbol),
    headlines: (m.articles || []).slice(0, 6).map((a: any) => ({
      title: a.title,
      sentiment: a.sentimentLabel || "NEUTRAL",
    })),
  };
}

function mapGap(json: any): GapInfo {
  if (!json?.success) return { available: false };
  return {
    available: true,
    price: json.price,
    change: json.change,
    changePct: json.changePct,
    previousClose: json.previousClose,
    source: json.source,
  };
}

function mapCorr(json: any): CorrInfo | null {
  if (!json?.success) return null;
  return {
    overall: json.overallCorrelation,
    last5d: json.last5dCorrelation,
    beta: json.beta,
    signal: json.signal,
    reason: json.reason,
    tip: json.tip,
    niftyPrice: json.niftyPrice,
    sensexPrice: json.sensexPrice,
  };
}

async function buildContext(symbol: string, base = BASE): Promise<SDMContext> {
  let spot = 0;
  let pcr = 1;
  let vix = 15;
  let expiryLabel: string | undefined;
  let chain: OptionChainRow[] = [];

  try {
    const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
    });
    const json = await res.json();
    const d = json?.data;
    if (d) {
      spot = d.spotPrice || d.summary?.spotPrice || 0;
      pcr = d.summary?.pcr ?? 1;
      vix = d.summary?.indiaVIX ?? 15;
      expiryLabel = d.expiries?.[0]?.label || d.summary?.selectedExpiry;
      chain = (d.data || []).map((row: any) => ({
        strike: row.strike,
        ce: row.ce
          ? {
              ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0,
              iv: row.ce.iv || 0, delta: row.ce.delta || 0, vol: row.ce.volume || row.ce.vol || 0,
            }
          : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
        pe: row.pe
          ? {
              ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0,
              iv: row.pe.iv || 0, delta: row.pe.delta || 0, vol: row.pe.volume || row.pe.vol || 0,
            }
          : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
      }));
    }
  } catch (err) {
    console.error("[sdm-chat] option-chain fetch failed:", err);
  }

  const newsSentiment = await fetchNewsSentiment(symbol, base).catch(() => ({ score: 0 }));

  // Fetch all 5 index chains in parallel for multi-symbol trade scanning
  const allChains = await fetchAllIndexChains(base);

  const ctx: SDMContext = { symbol, spot, pcr, vix, chain, expiryLabel, newsSentiment, allChains };

  // Live lookups for the info intents (fetched on demand)
  ctx.newsLookup = async () => {
    try {
      const r = await fetch(`${base}/api/news`, { next: { revalidate: 120 } });
      return mapNews(await r.json());
    } catch { return null; }
  };
  ctx.gapLookup = async () => {
    try {
      const r = await fetch(`${base}/api/gift-nifty?spot=${spot}`, { cache: "no-store" });
      return mapGap(await r.json());
    } catch { return { available: false }; }
  };
  ctx.correlationLookup = async () => {
    try {
      const r = await fetch(`${base}/api/correlation`, { cache: "no-store" });
      return mapCorr(await r.json());
    } catch { return null; }
  };
  ctx.fiiDiiLookup = async () => {
    try {
      const r = await fetch(`${base}/api/fii-dii`, { cache: "no-store" });
      const d = await r.json();
      if (!d.success) return null;
      return {
        fiiNet: d.fiiNet ?? null,
        diiNet: d.diiNet ?? null,
        totalNet: d.totalNet ?? null,
        regime: d.regime ?? null,
        asOf: d.asOf ?? null,
        stale: d.stale ?? false,
      };
    } catch { return null; }
  };
  ctx.gapPredictionLookup = async () => {
    try {
      const r = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      const json = await r.json();
      const d = json?.data;
      if (!d) return null;
      const { predictGap } = await import("@/lib/gap-analysis/gap-engine");
      const { DEFAULT_WEIGHTS } = await import("@/lib/gap-analysis/types");
      const summary = d.summary || {};
      const candles = d.candles || [];
      const analysis = json.analysis || {};
      // Derive ATR + VWAP distance from candles (real data)
      let atr: number | null = null, vwapDistance: number | null = null;
      if (candles.length >= 2 && spot) {
        const rows = candles.map((c: any) => ({ h: +c.high, l: +c.low, c: +c.close, o: +c.open, v: +c.volume }))
          .filter((x: any) => isFinite(x.h) && isFinite(x.l) && isFinite(x.c) && x.h > 0);
        if (rows.length >= 2) {
          const trs: number[] = [];
          for (let i = 1; i < rows.length; i++) {
            const p = rows[i - 1].c;
            trs.push(Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - p), Math.abs(rows[i].l - p)));
          }
          atr = trs.reduce((a: number, b: number) => a + b, 0) / trs.length;
          let pv = 0, pvq = 0;
          for (const x of rows) { const typ = (x.h + x.l + x.c) / 3; const v = x.v > 0 ? x.v : 1; pv += typ * v; pvq += v; }
          const vwap = pvq > 0 ? pv / pvq : rows[rows.length - 1].c;
          vwapDistance = ((spot - vwap) / vwap) * 100;
        }
      }
      const fii = await ctx.fiiDiiLookup?.().catch(() => null) ?? null;
      const input = {
        prevClose: typeof summary.prevClose === "number" ? summary.prevClose : null,
        currentSpot: spot || null,
        currentFutures: analysis.futuresPrice ?? null,
        giftNiftyPrice: null,
        giftNiftyPrevClose: null,
        indiaVIX: typeof summary.indiaVIX === "number" ? summary.indiaVIX : null,
        pcrOI: summary.pcr ?? null,
        pcrVolume: null,
        maxPain: analysis.maxPain ?? summary.maxPain ?? null,
        ceOIChange: analysis.totalCallOI ?? null,
        peOIChange: analysis.totalPutOI ?? null,
        optionIV: null,
        futuresPremium: null,
        breadth: null,
        atr,
        vwapDistance,
        fiiNet: fii?.fiiNet ?? null,
        diiNet: fii?.diiNet ?? null,
        usMarketChange: null,
        asianMarketChange: null,
        usdinr: null,
        crudeChange: null,
        newsRiskScore: null,
        economicCalendarRisk: null,
        historicalGapUpPct: null,
        historicalGapDownPct: null,
        historicalGapStats: null,
        timestamp: new Date().toISOString(),
        symbol,
      };
      const pred = predictGap(input as any, DEFAULT_WEIGHTS);
      return {
        prediction: pred.prediction,
        probability: pred.probability,
        confidence: pred.confidence,
        bullScore: pred.bullScore,
        bearScore: pred.bearScore,
        insufficientData: pred.insufficientData,
        factors: pred.factors.map((f: any) => ({
          name: f.name, score: f.score, weightedScore: f.weightedScore,
          dataStatus: f.dataStatus, explanation: f.explanation,
        })),
      };
    } catch { return null; }
  };
  ctx.scannerLookup = async () => {
    try {
      const r = await fetch(`${base}/api/scanner`, { cache: "no-store" });
      const d = await r.json();
      return d.success ? d.data : null;
    } catch { return null; }
  };
  ctx.breakoutLookup = async (sym: string) => {
    try {
      const r = await fetch(`${base}/api/breakout?symbol=${encodeURIComponent(sym)}`, { cache: "no-store" });
      const d = await r.json();
      return d.success ? d.data : null;
    } catch { return null; }
  };
  ctx.btstLookup = async () => {
    try {
      const r = await fetch(`${base}/api/btst`, { cache: "no-store" });
      const d = await r.json();
      return d.success ? d.data : null;
    } catch { return null; }
  };
  ctx.tradesLookup = async () => {
    try {
      const r = await fetch(`${base}/api/trades/today`, { cache: "no-store" });
      const d = await r.json();
      return d.success ? d : null;
    } catch { return null; }
  };

  ctx.history = getHistory(CHAT_KEY);
  ctx.llmResolve = llmResolveIntent;

  return ctx;
}

export async function POST(req: NextRequest) {
  try {
    const { message, symbol = "NIFTY" } = await req.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    const base = process.env.INTERNAL_API_BASE || new URL(req.url).origin;
    // Use the symbol the user actually asked for (so "banknifty trade" hits BankNifty)
    const detected = detectIntent(message);
    const tradeSymbol = detected.symbol ?? symbol;
    const ctx = await buildContext(tradeSymbol, base);

    // If the primary symbol has no chain data, return "not available" immediately
    // so the trade card never shows wrong data from a different index.
    if (!ctx.chain.length) {
      return NextResponse.json({
        text: `Option chain data for ${tradeSymbol} isn't available right now — try again shortly.`,
        language: "en",
        alert: null,
        intentKind: "trade",
        symbol: tradeSymbol,
      });
    }

    const reply = await handleSDMMessage(message, ctx);

    // Persist this turn so follow-ups ("same for banknifty") resolve via context
    appendTurn(CHAT_KEY, { role: "user", text: message, intent: reply.intentKind, symbol: reply.symbol });
    appendTurn(CHAT_KEY, { role: "bot", text: reply.text, intent: reply.intentKind, symbol: reply.symbol });

    return NextResponse.json({
      text: reply.text,
      language: reply.language,
      alert: reply.alert ?? null,
      intentKind: reply.intentKind,
      symbol: reply.symbol ?? null,
    });
  } catch (err: any) {
    console.error("[sdm-chat] failed:", err);
    return NextResponse.json({
      text: "Something went wrong pulling live data — try again in a moment.",
      language: "en",
      alert: null,
    });
  }
}
