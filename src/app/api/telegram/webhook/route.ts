// app/api/telegram/webhook/route.ts
//
// Telegram sends every message here. We run it through the exact same
// handleSDMMessage() used by the in-app chat, so "ask on chat" and
// "ask on Telegram" always produce the same trade.
//
// Set your webhook once (from a shell, not in this file):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://yourapp.com/api/telegram/webhook"

import { NextRequest, NextResponse } from "next/server";
import { handleSDMMessage, type SDMContext, type NewsSummary, type GapInfo, type CorrInfo } from "@/lib/sdmChat";
import { fetchNewsSentiment } from "@/lib/newsSentimentAdapter";
import { detectIntent } from "@/lib/tradeAlertEngine";
import { llmResolveIntent } from "@/lib/llmResolve";
import { getHistory, appendTurn } from "@/lib/historyStore";
import type { OptionChainRow } from "@/lib/tradeAlertEngine";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// Build live SDMContext from the real option-chain + news APIs that
// the dashboard already uses.
async function buildContext(chatId: number | string, symbol = "NIFTY", base = ""): Promise<SDMContext> {
  let spot = 0, pcr = 1, vix = 15;
  let expiryLabel: string | undefined;
  let chain: OptionChainRow[] = [];

  try {
    const res = await fetch(`${base}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
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
          ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, vol: row.ce.volume || row.ce.vol || 0 }
          : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
        pe: row.pe
          ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, vol: row.pe.volume || row.pe.vol || 0 }
          : { ltp: 0, oi: 0, oiChg: 0, iv: 0, delta: 0, vol: 0 },
      }));
    }
  } catch (err) {
    console.error("[telegram webhook] option-chain fetch failed:", err);
  }

  const newsSentiment = await fetchNewsSentiment(symbol, base).catch(() => ({ score: 0 }));

  const ctx: SDMContext = { symbol, spot, pcr, vix, chain, expiryLabel, newsSentiment };

  ctx.newsLookup = async () => {
    try {
      const r = await fetch(`${base}/api/news`, { next: { revalidate: 120 } });
      const m = (await r.json())?.data;
      if (!m) return null;
      const labelMap: Record<string, string> = {
        EXTREME_GREED: "Extreme Greed", GREED: "Greed", NEUTRAL: "Neutral",
        FEAR: "Fear", EXTREME_FEAR: "Extreme Fear",
      };
      return {
        mood: labelMap[m.label] || m.label || "Neutral",
        score: m.overall ?? 50,
        topBullish: (m.topBullish || []).map((s: any) => s.symbol),
        topBearish: (m.topBearish || []).map((s: any) => s.symbol),
        headlines: (m.articles || []).slice(0, 6).map((a: any) => ({ title: a.title, sentiment: a.sentimentLabel || "NEUTRAL" })),
      } as NewsSummary;
    } catch { return null; }
  };
  ctx.gapLookup = async () => {
    try {
      const r = await fetch(`${base}/api/gift-nifty?spot=${spot}`, { cache: "no-store" });
      const j = await r.json();
      if (!j?.success) return { available: false } as GapInfo;
      return { available: true, price: j.price, change: j.change, changePct: j.changePct, previousClose: j.previousClose, source: j.source } as GapInfo;
    } catch { return { available: false } as GapInfo; }
  };
  ctx.correlationLookup = async () => {
    try {
      const r = await fetch(`${base}/api/correlation`, { cache: "no-store" });
      const j = await r.json();
      if (!j?.success) return null;
      return {
        overall: j.overallCorrelation, last5d: j.last5dCorrelation, beta: j.beta,
        signal: j.signal, reason: j.reason, tip: j.tip, niftyPrice: j.niftyPrice, sensexPrice: j.sensexPrice,
      } as CorrInfo;
    } catch { return null; }
  };

  ctx.history = getHistory(String(chatId));
  ctx.llmResolve = llmResolveIntent;

  return ctx;
}

export async function POST(req: NextRequest) {
  const update = await req.json();
  const message = update?.message?.text as string | undefined;
  const chatId = update?.message?.chat?.id as number | undefined;

  if (!message || !chatId) {
    return NextResponse.json({ ok: true }); // ignore non-text updates
  }

  const base = process.env.INTERNAL_API_BASE || new URL(req.url).origin;

  try {
    const detected = detectIntent(message);
    const ctx = await buildContext(chatId, detected.symbol ?? "NIFTY", base);
    const reply = await handleSDMMessage(message, ctx);

    // Persist this turn so follow-ups resolve via context
    appendTurn(String(chatId), { role: "user", text: message, intent: reply.intentKind, symbol: reply.symbol });
    appendTurn(String(chatId), { role: "bot", text: reply.text, intent: reply.intentKind, symbol: reply.symbol });

    await sendTelegramMessage(chatId, reply.text);
  } catch (err) {
    console.error("[telegram webhook] failed:", err);
    await sendTelegramMessage(chatId, "Something went wrong pulling live data — try again in a moment.");
  }

  return NextResponse.json({ ok: true });
}
