// app/api/sdm-chat/route.ts
//
// In-app SDM chat endpoint. Builds a live SDMContext from the real
// option-chain + news + gap + correlation APIs and runs it through
// handleSDMMessage(), the same logic the Telegram bot uses.

import { NextRequest, NextResponse } from "next/server";
import { handleSDMMessage, type SDMContext, type NewsSummary, type GapInfo, type CorrInfo } from "@/lib/sdmChat";
import { fetchNewsSentiment } from "@/lib/newsSentimentAdapter";
import { detectIntent } from "@/lib/tradeAlertEngine";
import { llmResolveIntent } from "@/lib/llmResolve";
import { getHistory, appendTurn } from "@/lib/historyStore";
import type { OptionChainRow } from "@/lib/tradeAlertEngine";

const CHAT_KEY = "web"; // in-app chat shares one conversation context

const BASE = process.env.INTERNAL_API_BASE || "";

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

  const ctx: SDMContext = { symbol, spot, pcr, vix, chain, expiryLabel, newsSentiment };

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
