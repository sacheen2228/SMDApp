// app/api/telegram/daily-scan/route.ts
//
// Hit this once a day (e.g. via Vercel Cron, or any external scheduler)
// shortly after market open (~9:20 AM IST) to auto-generate and push
// the day's option + equity trade ideas to your Telegram chat, without
// anyone having to ask in chat first.
//
// Vercel cron example (vercel.json):
// {
//   "crons": [{ "path": "/api/telegram/daily-scan", "schedule": "50 3 * * 1-5" }]
//   // 3:50 UTC = 9:20 AM IST, Mon-Fri
// }

import { NextResponse } from "next/server";
import { generateOptionAlert, generateEquityAlert, formatAlertMessage } from "@/lib/tradeAlertEngine";
import { fetchNewsSentiment } from "@/lib/newsSentimentAdapter";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DAILY_CHAT_ID = process.env.TELEGRAM_DAILY_CHAT_ID!; // your chat/group id

const WATCHLIST_INDEXES = ["NIFTY 50", "BANKNIFTY", "SENSEX"];
const WATCHLIST_EQUITY = ["RELIANCE", "HDFCBANK", "TCS", "INFY", "ICICIBANK"];

async function sendTelegramMessage(text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: DAILY_CHAT_ID, text, parse_mode: "Markdown" }),
  });
}

// TODO: replace with your real data fetchers — same ones the dashboard uses.
async function fetchIndexData(symbol: string) {
  return fetch(`${process.env.INTERNAL_API_BASE}/api/chain?symbol=${encodeURIComponent(symbol)}`)
    .then(r => r.json())
    .catch(() => null);
}
async function fetchEquityData(symbol: string) {
  return fetch(`${process.env.INTERNAL_API_BASE}/api/equity?symbol=${symbol}`)
    .then(r => r.json())
    .catch(() => null);
}

export async function GET() {
  const messages: string[] = [`*📅 Daily Trade Scan — ${new Date().toLocaleDateString("en-IN")}*`];

  for (const symbol of WATCHLIST_INDEXES) {
    const d = await fetchIndexData(symbol);
    if (!d?.chain?.length) continue;
    const alert = generateOptionAlert({
      symbol,
      spot: d.spot,
      pcr: d.pcr ?? 1,
      vix: d.vix ?? 15,
      chain: d.chain,
      newsSentiment: d.newsSentiment ?? await fetchNewsSentiment(symbol),
      fiiNetCr: d.fiiNetCr,
      diiNetCr: d.diiNetCr,
      expiryLabel: d.expiryLabel,
    });
    if (alert) messages.push(`\n*${symbol}*\n${formatAlertMessage(alert, { markdown: true })}`);
  }

  for (const symbol of WATCHLIST_EQUITY) {
    const d = await fetchEquityData(symbol);
    if (!d) continue;
    const alert = generateEquityAlert({
      symbol,
      ltp: d.ltp,
      dayChangePct: d.dayChangePct,
      newsSentiment: d.newsSentiment ?? await fetchNewsSentiment(symbol),
      avgVolRatio: d.avgVolRatio,
    });
    // Only surface equity ideas with real conviction, to avoid daily noise.
    if (alert && alert.confidence >= 65) {
      messages.push(`\n*${symbol}*\n${formatAlertMessage(alert, { markdown: true })}`);
    }
  }

  if (messages.length === 1) {
    messages.push("\nNo high-conviction setups today — sitting out.");
  }

  await sendTelegramMessage(messages.join("\n"));
  return NextResponse.json({ ok: true, sent: messages.length - 1 });
}
