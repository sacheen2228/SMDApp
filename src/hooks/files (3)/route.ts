// app/api/telegram/webhook/route.ts
//
// Telegram sends every message here. We run it through the exact same
// handleSDMMessage() used by the in-app chat, so "ask on chat" and
// "ask on Telegram" always produce the same trade.
//
// Set your webhook once (from a shell, not in this file):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://yourapp.com/api/telegram/webhook"

import { NextRequest, NextResponse } from "next/server";
import { handleSDMMessage, type SDMContext } from "@/lib/sdmChat";
import { fetchNewsSentiment } from "@/lib/newsSentimentAdapter";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// Replace this with your real live-data fetch (same source your
// dashboard/Gap Analysis tab already uses).
async function buildContext(symbol = "NIFTY 50"): Promise<SDMContext> {
  // TODO: swap for your actual option-chain / PCR / VIX / news fetchers.
  const liveData = await fetch(`${process.env.INTERNAL_API_BASE}/api/chain?symbol=${encodeURIComponent(symbol)}`)
    .then(r => r.json())
    .catch(() => null);

  return {
    symbol,
    spot: liveData?.spot ?? 24206.9,
    pcr: liveData?.pcr ?? 1.0,
    vix: liveData?.vix ?? 15,
    chain: liveData?.chain ?? [],
    expiryLabel: liveData?.expiryLabel,
    fiiNetCr: liveData?.fiiNetCr,
    diiNetCr: liveData?.diiNetCr,
    newsSentiment: liveData?.newsSentiment ?? await fetchNewsSentiment(symbol),
    equityLookup: async (sym: string) => {
      const d = await fetch(`${process.env.INTERNAL_API_BASE}/api/equity?symbol=${sym}`)
        .then(r => r.json())
        .catch(() => null);
      if (!d) return null;
      return {
        ltp: d.ltp,
        dayChangePct: d.dayChangePct,
        avgVolRatio: d.avgVolRatio,
        newsSentiment: await fetchNewsSentiment(sym),
      };
    },
  };
}

export async function POST(req: NextRequest) {
  const update = await req.json();
  const message = update?.message?.text as string | undefined;
  const chatId = update?.message?.chat?.id as number | undefined;

  if (!message || !chatId) {
    return NextResponse.json({ ok: true }); // ignore non-text updates
  }

  try {
    const ctx = await buildContext();
    const reply = await handleSDMMessage(message, ctx);
    await sendTelegramMessage(chatId, reply.text);
  } catch (err) {
    console.error("[telegram webhook] failed:", err);
    await sendTelegramMessage(chatId, "Something went wrong pulling live data — try again in a moment.");
  }

  return NextResponse.json({ ok: true });
}
