// lib/sendIntradayAlerts.ts
//
// Runs during market hours every 15 min. Before scanning for new trades,
// checks active trades for SL/TP hits. Sends a Telegram push for each.
// Uses the SDM V2 engine (via /api/sdm-signal) for trade generation so
// Telegram alerts match the SMD bot's recommendations exactly.

import { sendTelegramMessage } from "./telegramSend";
import { isMarketOpen } from "./marketHours";
import { alreadySentToday, markSentToday, buildSignature } from "./intradayState";
import { ALL_SYMBOLS } from "./stockUniverse";
import { getNextMonthlyExpiry } from "./expiry-calculator";
import {
  checkSLTP, addTrade, formatSLTPHit,
  hasActiveTrade
} from "./activeTradeTracker";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Fetch SDM signal for a symbol+direction+expiry and push to candidates array
async function fetchAndPushSignal(
  sym: string,
  direction: string,
  candidates: { symbol: string; alert: any }[],
  expiry?: string
): Promise<void> {
  try {
    let url = `${BASE}/api/sdm-signal?symbol=${encodeURIComponent(sym)}&dir=${direction}`;
    if (expiry) url += `&expiry=${encodeURIComponent(expiry)}`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !json.signal) return;

    const alert = sdmSignalToAlert(sym, json.signal);
    if (!alert) return;

    const conf = (alert.confidence || 0) / 100;
    const rr = alert.rr || 1;
    if (conf < 0.6 || rr < 1.5) return;

    candidates.push({ symbol: sym, alert });
  } catch {
    // skip if sdm-signal fails
  }
}

// Price fetcher for SL/TP checking — fetches live option price
async function getCurrentOptionPrice(symbol: string, strike: number, optionType: string): Promise<number> {
  try {
    const res = await fetch(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    if (!res.ok) return 0;
    const json = await res.json();
    const data = json?.data?.data || [];
    const row = data.find((r: any) => r.strike === strike);
    if (!row) return 0;
    const side = optionType === "CE" ? row.ce : row.pe;
    return side?.ltp || 0;
  } catch {
    return 0;
  }
}

function sdmSignalToAlert(symbol: string, signal: any): any {
  const isCall = signal.direction === "CALL";
  if (signal.direction !== "CALL" && signal.direction !== "PUT") return null;
  if (!signal.entry || signal.entry <= 0) return null;
  if (!signal.strike || signal.strike <= 0) return null;

  const optionType = isCall ? "CE" : "PE";
  const rr = signal.riskReward > 3 ? 4 : signal.riskReward > 2 ? 3 : signal.riskReward > 1 ? 2 : 1;

  const reasons = (signal.whyThisTrade || [])
    .map((w: any) => `${w.label}: ${w.value}`)
    .join(" · ");
  const extra = signal.reason ? ` · ${signal.reason}` : "";

  const expiryLabel = signal.daysToExpiry
    ? signal.isExpiryDay ? "Expiry Today" : `${signal.daysToExpiry}d to expiry`
    : undefined;

  return {
    id: `opt-${symbol}-${Date.now()}`,
    kind: "option" as const,
    symbol,
    side: "BUY" as const,
    instrument: `${symbol} ${signal.strike} ${optionType}`,
    strike: signal.strike,
    optionType,
    entry: signal.entry,
    sl: signal.sl,
    tp1: signal.tp1,
    tp2: signal.tp2 || signal.tp1,
    rr,
    confidence: Math.round(signal.confidence || 50),
    rationale: reasons + extra || "SDM V2 engine recommendation",
    expiry: expiryLabel,
    generatedAt: new Date().toISOString(),
  };
}

function formatSDMMessage(alert: any): string {
  const isCall = alert.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  const direction = isCall ? "Bullish" : "Bearish";
  const pnlRisk = alert.entry > 0 ? Math.abs((alert.entry - alert.sl) / alert.entry * 100).toFixed(1) : "—";
  const pnlReward = alert.entry > 0 ? Math.abs((alert.tp1 - alert.entry) / alert.entry * 100).toFixed(1) : "—";

  return `⚡ SDM Signal — ${alert.symbol}

${emoji} ${alert.side} ${alert.instrument}
${direction} | Confidence: ${alert.confidence}%

Strike: ${alert.strike} ${alert.optionType} ${alert.expiry ? `| ${alert.expiry}` : ""}
Entry: ₹${alert.entry.toFixed(2)}
Stop: ₹${alert.sl.toFixed(2)} (${pnlRisk}% risk)
Target 1: ₹${alert.tp1.toFixed(2)} (${pnlReward}% gain)
Target 2: ₹${alert.tp2.toFixed(2)}
R:R 1:${alert.rr}

${alert.rationale}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`;
}

export async function sendIntradayAlerts(): Promise<{ ran: boolean; newAlerts: number }> {
  if (!isMarketOpen()) {
    return { ran: false, newAlerts: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendIntradayAlerts] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { ran: false, newAlerts: 0 };
  }

  // 1. Check active trades for SL/TP hits
  const { hitSL, hitTP1, hitTP2 } = await checkSLTP(getCurrentOptionPrice);

  let newAlerts = 0;

  for (const trade of hitSL) {
    const text = formatSLTPHit(trade, "SL");
    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
    );
    if (results.some(Boolean)) newAlerts++;
  }

  for (const trade of hitTP1) {
    const text = formatSLTPHit(trade, "TP1");
    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
    );
    if (results.some(Boolean)) newAlerts++;
  }

  for (const trade of hitTP2) {
    const text = formatSLTPHit(trade, "TP2");
    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
    );
    if (results.some(Boolean)) newAlerts++;
  }

  // 2. Filter symbols — skip those with active trades
  const symbolsToScan = ALL_SYMBOLS.filter(sym => !hasActiveTrade(sym));
  if (symbolsToScan.length === 0) {
    return { ran: true, newAlerts };
  }

  // 3. Fetch SDM V2 recommendations for each symbol (both CE and PE, weekly + monthly)
  const candidates: { symbol: string; alert: any }[] = [];

  for (const sym of symbolsToScan) {
    // Get monthly expiry date for this symbol
    const monthlyExpiry = getNextMonthlyExpiry(sym);

    for (const direction of ['CALL', 'PUT'] as const) {
      // Weekly expiry (default — no expiry param)
      for (const expiryOpt of [null, monthlyExpiry?.date]) {
        if (!expiryOpt) {
          // Fetch weekly expiry (no expiry param)
          await fetchAndPushSignal(sym, direction, candidates);
        } else {
          // Fetch monthly expiry
          await fetchAndPushSignal(sym, direction, candidates, expiryOpt);
        }
      }
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => (b.alert.confidence || 0) - (a.alert.confidence || 0));
  const topCandidates = candidates.slice(0, 12);

  // 4. Send index-level SDM alerts
  for (const c of topCandidates) {
    const signature = buildSignature(c.symbol, c.alert);
    if (alreadySentToday(signature)) continue;

    const text = formatSDMMessage(c.alert);
    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
    );

    if (results.some(Boolean)) {
      markSentToday(signature);
      await addTrade({
        id: c.alert.id,
        symbol: c.symbol,
        side: c.alert.side,
        instrument: c.alert.instrument,
        strike: c.alert.strike || 0,
        optionType: c.alert.optionType || "",
        entry: c.alert.entry,
        sl: c.alert.sl,
        tp1: c.alert.tp1,
        tp2: c.alert.tp2,
        status: "ACTIVE",
        sentAt: new Date().toISOString(),
        source: "sdm-v2-engine",
      });
      newAlerts++;
    }
  }

  // 5. Stock scanner alerts — monthly expiry, confidence ≥ 80%
  try {
    const scannerRes = await fetch(
      `${BASE}/api/scanner?symbol=NIFTY&live=true`,
      { cache: "no-store", signal: AbortSignal.timeout(120000) }
    );
    if (scannerRes.ok) {
      const scannerJson = await scannerRes.json();
      const scanData = scannerJson?.data;
      if (scanData?.candidates) {
        const highConfStocks = scanData.candidates.filter(
          (s: any) => s.monthlyOptionTrade && s.totalScore >= 80
        );

        for (const stock of highConfStocks) {
          const opt = stock.monthlyOptionTrade;
          const sig = `${stock.symbol}|${opt.strike}|${opt.optionType}|BUY|stock-scanner`;
          if (alreadySentToday(sig)) continue;

          const text = formatStockOptionAlert(stock, opt);
          const results = await Promise.all(
            DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
          );

          if (results.some(Boolean)) {
            markSentToday(sig);
            await addTrade({
              id: `stk-${stock.symbol}-${Date.now()}`,
              symbol: stock.symbol,
              side: "BUY",
              instrument: `${stock.symbol} ${opt.strike} ${opt.optionType}`,
              strike: opt.strike,
              optionType: opt.optionType,
              entry: opt.premium,
              sl: opt.stopLoss,
              tp1: opt.targets[0] || opt.premium,
              tp2: opt.targets[1] || opt.targets[0] || opt.premium,
              status: "ACTIVE",
              sentAt: new Date().toISOString(),
              source: "stock-scanner",
            });
            newAlerts++;
          }
        }
      }
    }
  } catch {
    // Non-blocking — stock scanner may time out
  }

  return { ran: true, newAlerts };
}

function formatStockOptionAlert(stock: any, opt: any): string {
  const isCall = opt.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  const rr = stock.riskReward ? `1:${stock.riskReward.toFixed(1)}` : "—";
  const reasons = (stock.reasons || []).slice(0, 3).join(" · ") || "Scanner pick";
  const direction = isCall ? "Bullish" : "Bearish";
  const targets = opt.targets.map((t: number, i: number) => `T${i + 1} ₹${t.toFixed(2)}`).join(" | ");

  return `📊 STOCK OPTION — ${stock.symbol}

${emoji} BUY ${opt.optionType} | ${stock.symbol} ${opt.strike}

📅 Monthly Expiry: ${opt.expiryLabel}
💰 Premium: ₹${opt.premium.toFixed(2)}
🛑 Stop Loss: ₹${opt.stopLoss.toFixed(2)}
🎯 ${targets}
📐 R:R ${rr}
⭐ Confidence: ${stock.totalScore}%
📈 ${direction} | ${reasons}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`.trim();
}
