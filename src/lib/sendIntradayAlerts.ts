// lib/sendIntradayAlerts.ts
//
// Runs during market hours every 15 min. Before scanning for new trades,
// checks active trades for SL/TP hits. Sends a Telegram push for each.
// Uses the SDM V2 engine (via /api/sdm-signal) for trade generation so
// Telegram alerts match the SMD bot's recommendations exactly.

import { sendTelegramMessage } from "./telegramSend";
import { recordIntradayTrade } from "./intraday-scanner";
import { isTelegramSendWindow } from "./marketHours";
import { alreadySentToday, markSentToday, buildSignature } from "./intradayState";
import { ALL_SYMBOLS, WEEKLY_SYMBOLS } from "./stockUniverse";
import { getNextMonthlyExpiry } from "./expiry-calculator";
import {
  checkSLTP, addTrade, formatSLTPHit,
  hasActiveTrade
} from "./activeTradeTracker";
import { runSMCWithEngine } from "./smc-strategy";
import type { SDMOptionStrike, CandleData } from "@/types/sdm";
import { analyzeZeroHeroChain, evaluateZeroHeroCandidate } from "./ProTradeEngine";
import { getDailyATR } from "./atr-daily";

const ZH_SYMBOLS = ["NIFTY", "SENSEX"];

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Hard cap on how many alerts a single scan run pushes to Telegram, so a
// healthy market (many valid setups) doesn't spam the channel. Only the
// highest-confidence setups across ALL strategies are sent.
const MAX_ALERTS_PER_SCAN = 8;

interface QueuedAlert {
  text: string;
  conf: number;
  sig: string;
  onSend?: () => Promise<void>; // record trade / audit side-effects
}

const alertQueue: QueuedAlert[] = [];

function queueAlert(text: string, conf: number, sig: string, onSend?: () => Promise<void>): void {
  alertQueue.push({ text, conf, sig, onSend });
}

function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function getQualityBand(score: number): { emoji: string; label: string } {
  if (score >= 70) return { emoji: "🟢", label: "A+ Institutional Setup" };
  if (score >= 65) return { emoji: "🟢", label: "High Probability" };
  if (score >= 60) return { emoji: "🟡", label: "Good Setup" };
  if (score >= 55) return { emoji: "🟠", label: "Watchlist / Aggressive Entry" };
  return { emoji: "⚪", label: "Below Threshold" };
}

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

    const res = await fetchWithTimeout(url);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !json.signal) return;

    const alert = sdmSignalToAlert(sym, json.signal);
    if (!alert) return;

    const conf = (alert.confidence || 0) / 100;
    const rr = alert.rr || 1;
    if (conf < 0.55 || rr < 1.5) return;

    candidates.push({ symbol: sym, alert });
  } catch {
    // skip if sdm-signal fails
  }
}

// Price fetcher for SL/TP checking — fetches live option price
async function getCurrentOptionPrice(symbol: string, strike: number, optionType: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`);
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
  const band = getQualityBand(alert.confidence);
  const pnlRisk = alert.entry > 0 ? Math.abs((alert.entry - alert.sl) / alert.entry * 100).toFixed(1) : "—";
  const pnlReward = alert.entry > 0 ? Math.abs((alert.tp1 - alert.entry) / alert.entry * 100).toFixed(1) : "—";

  return `${band.emoji} ${band.label} (${alert.confidence}%)
⚡ SDM Signal — ${alert.symbol}

${emoji} ${alert.side} ${alert.instrument}
${direction}

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
  if (!isTelegramSendWindow()) {
    console.error("[sendIntradayAlerts] outside 09:10-15:20 IST window — skipping");
    return { ran: false, newAlerts: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendIntradayAlerts] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { ran: false, newAlerts: 0 };
  }

  // 1. Check active trades for SL/TP hits
  const { hitSL, hitTP1, hitTP2, hitTP3 } = await checkSLTP(getCurrentOptionPrice);

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

  for (const trade of hitTP3) {
    const text = formatSLTPHit(trade, "TP3");
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

  // 3. Fetch SDM V2 recommendations (both CE and PE).
  //    Weekly expiry → NIFTY & SENSEX ONLY (liquid, tight spreads).
  //    Monthly expiry → full index universe (as before).
  const candidates: { symbol: string; alert: any }[] = [];

  const weeklySyms = WEEKLY_SYMBOLS.filter(sym => !hasActiveTrade(sym));
  const monthlySyms = symbolsToScan;

  for (const sym of weeklySyms) {
    for (const direction of ['CALL', 'PUT'] as const) {
      // Weekly expiry (no expiry param)
      await fetchAndPushSignal(sym, direction, candidates);
    }
  }

  for (const sym of monthlySyms) {
    const monthlyExpiry = getNextMonthlyExpiry(sym);
    if (!monthlyExpiry?.date) continue;
    for (const direction of ['CALL', 'PUT'] as const) {
      // Monthly expiry only
      await fetchAndPushSignal(sym, direction, candidates, monthlyExpiry.date);
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => (b.alert.confidence || 0) - (a.alert.confidence || 0));
  const topCandidates = candidates.slice(0, 12);

  // 4. Queue index-level SDM alerts (flushed + capped at the end)
  for (const c of topCandidates) {
    const signature = buildSignature(c.symbol, c.alert);
    if (alreadySentToday(signature)) continue;

    const text = formatSDMMessage(c.alert);
    queueAlert(text, c.alert.confidence || 0, signature, async () => {
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
      // Migration: also record executed intraday trades to Trade Audit sidecar.
      await recordIntradayTrade({
        id: c.alert.id,
        symbol: c.symbol,
        optionType: (c.alert.optionType as "CE" | "PE") || "CE",
        strike: c.alert.strike || 0,
        entry: c.alert.entry,
        stopLoss: c.alert.sl,
        tp1: c.alert.tp1,
        tp2: c.alert.tp2,
        confidence: c.alert.confidence,
        reason: c.alert.rationale,
        source: "sdm-v2-engine",
      });
    });
  }

  // 6. SMC (Smart Money) alerts — restricted to WEEKLY_SYMBOLS (NIFTY/SENSEX)
  //    like all weekly-expiry strategies. Monthly-expiry SMC for the other
  //    indices is paused here because the NSE fallback can't reliably return
  //    their true monthly chain while Breeze auth is down.
  try {
    const smcSymbols = WEEKLY_SYMBOLS.filter(sym => !hasActiveTrade(sym));
    for (const sym of smcSymbols) {
      const chainRes = await fetchWithTimeout(`${BASE}/api/option-chain?symbol=${encodeURIComponent(sym)}`);
      if (!chainRes.ok) continue;
      const chainJson = await chainRes.json();
      const chainData = chainJson?.data;
      if (!chainData?.data) continue;
      const spot = chainData.spotPrice || 0;
      const vix = chainData.summary?.indiaVIX || 15;
      const apiChain = chainData.data as any[];
      const optionChain: SDMOptionStrike[] = apiChain.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, theta: row.ce.theta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, theta: row.pe.theta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0 } : null,
      }));
      const rawCandles = (chainData.candles || []) as any[];
      const candles: CandleData[] = rawCandles
        .filter((c: any) => c.open && c.close)
        .map((c: any) => ({
          time: new Date(c.time).getTime(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0,
        }));
      const smcResult = runSMCWithEngine({ symbol: sym, spot, optionChain, candles, vix, capital: 100000, riskPercent: 2 });
      for (const c of smcResult.candidates) {
        if (c.confidence < 55) continue;
        const sig = `${sym}|${c.strike}|${c.type}|SMC`;
        if (alreadySentToday(sig)) continue;
        const band = getQualityBand(c.confidence);
        const text = `${band.emoji} ${band.label} (${c.confidence}%)
🧠 SMC — ${sym}

${c.type === "CE" ? "🟢" : "🔴"} BUY ${c.type} | ${sym} ${c.strike}

Entry: ₹${c.entry.toFixed(2)}
Stop: ₹${c.sl.toFixed(2)}
Target 1: ₹${c.tp1.toFixed(2)}
Target 2: ₹${c.tp2.toFixed(2)}
R:R 1:${c.rr.toFixed(1)}
Confidence: ${c.confidence}%

${(c.reasons || []).slice(0, 2).join(" · ")}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
        queueAlert(text, c.confidence, sig, async () => {
          markSentToday(sig);
        });
      }
    }
  } catch {
    // Non-blocking — SMC analysis may fail
  }

  // 7. ZERO_HERO alerts — confidence ≥ 55%
  try {
    for (const sym of ZH_SYMBOLS) {
      const dailyAtr = await getDailyATR(sym); // Option 1: real per-instrument ATR
      const chainRes = await fetchWithTimeout(`${BASE}/api/option-chain?symbol=${encodeURIComponent(sym)}`);
      if (!chainRes.ok) continue;
      const chainJson = await chainRes.json();
      const chainData = chainJson?.data;
      if (!chainData?.data) continue;
      const spot = chainData.spotPrice || 0;
      const vix = chainData.summary?.indiaVIX || 15;
      const apiChain = chainData.data as any[];
      const zhCandles = ((chainData.candles || []) as any[])
        .filter((c: any) => c.open && c.close)
        .map((c: any) => ({
          time: new Date(c.time).getTime(),
          open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
        }));
      const zhFullChain = apiChain.map((row: any) => ({
        strike: row.strike,
        ce: row.ce ? { ltp: row.ce.ltp || 0, oi: row.ce.oi || 0, oiChg: row.ce.oiChg || 0, volume: row.ce.volume || 0, iv: row.ce.iv || 0, delta: row.ce.delta || 0, theta: row.ce.theta || 0, gamma: row.ce.gamma || 0, vega: row.ce.vega || 0 } : null,
        pe: row.pe ? { ltp: row.pe.ltp || 0, oi: row.pe.oi || 0, oiChg: row.pe.oiChg || 0, volume: row.pe.volume || 0, iv: row.pe.iv || 0, delta: row.pe.delta || 0, theta: row.pe.theta || 0, gamma: row.pe.gamma || 0, vega: row.pe.vega || 0 } : null,
      }));
      const context = analyzeZeroHeroChain(apiChain, spot, vix, sym);
      const threshold = spot * 0.02;
      const nearStrikes = apiChain.filter((s: any) => Math.abs(s.strike - spot) <= threshold);
      for (const s of nearStrikes) {
        for (const type of ["CE", "PE"] as const) {
          const leg = type === "CE" ? s.ce : s.pe;
          if (!leg || !leg.ltp || leg.ltp <= 0) continue;
          const evalResult = evaluateZeroHeroCandidate({
            strike: s.strike,
            type,
            ltp: leg.ltp,
            delta: leg.delta || 0,
            iv: leg.iv || 0,
            oiChg: leg.oiChg || 0,
            oi: leg.oi || 0,
            volume: leg.volume || 0,
            bid: leg.bid,
            ask: leg.ask,
            spot,
            lotSize: 25,
            capital: 100000,
            riskPerTradePercent: 2,
            maxPositionSize: 10,
            context,
            atr: dailyAtr ?? undefined,
            candles: zhCandles,
            fullChain: zhFullChain,
          });
          const minConf = type === "PE" ? 45 : 55;
          if (evalResult.conf < minConf) continue;
          const sig = `${sym}|${s.strike}|${type}|ZH`;
          if (alreadySentToday(sig)) continue;
          const band = getQualityBand(evalResult.conf);
          const text = `${band.emoji} ${band.label} (${evalResult.conf}%)
⚡ ${sym}

${type === "CE" ? "🟢" : "🔴"} BUY ${type} | ${sym} ${s.strike}

Entry: ₹${leg.ltp.toFixed(2)}
Stop: ₹${evalResult.sl.toFixed(2)}
Target 1: ₹${evalResult.tp1.toFixed(2)}
Target 2: ₹${evalResult.tp2.toFixed(2)}
R:R 1:${evalResult.rr.toFixed(1)}
Stars: ${"⭐".repeat(evalResult.stars)}

OI Chg: ${leg.oiChg >= 0 ? "+" : ""}${leg.oiChg.toLocaleString()} | IV: ${(leg.iv || 0).toFixed(1)}% | Δ: ${(leg.delta || 0).toFixed(2)}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
          queueAlert(text, evalResult.conf, sig, async () => {
            markSentToday(sig);
          });
        }
      }
    }
  } catch {
    // Non-blocking — ZERO_HERO analysis may fail
  }

  // 5. Stock scanner alerts — monthly expiry
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
          (s: any) => s.monthlyOptionTrade && s.totalScore >= 55
        );

        for (const stock of highConfStocks) {
          const opt = stock.monthlyOptionTrade;
          const sig = `${stock.symbol}|${opt.strike}|${opt.optionType}|BUY|stock-scanner`;
          if (alreadySentToday(sig)) continue;

          const text = formatStockOptionAlert(stock, opt);
          queueAlert(text, stock.totalScore, sig, async () => {
            markSentToday(sig);
            const tradeId = `stk-${stock.symbol}-${Date.now()}`;
            await addTrade({
              id: tradeId,
              symbol: stock.symbol,
              side: "BUY",
              instrument: `${stock.symbol} ${opt.strike} ${opt.optionType}`,
              strike: opt.strike,
              optionType: opt.optionType,
              entry: opt.premium,
              sl: opt.stopLoss,
              tp1: opt.targets[0] || opt.premium,
              tp2: opt.targets[1] || opt.targets[0] || opt.premium,
              tp3: opt.targets[2] || opt.targets[1] || opt.targets[0] || opt.premium,
              status: "ACTIVE",
              sentAt: new Date().toISOString(),
              source: "stock-scanner",
            });
            // Migration: also record executed intraday trades to Trade Audit sidecar.
            await recordIntradayTrade({
              id: tradeId,
              symbol: stock.symbol,
              optionType: (opt.optionType as "CE" | "PE") || "CE",
              strike: opt.strike,
              entry: opt.premium,
              stopLoss: opt.stopLoss,
              tp1: opt.targets[0] || opt.premium,
              tp2: opt.targets[1] || opt.targets[0] || opt.premium,
              confidence: stock.totalScore,
              reason: (stock.reasons || []).slice(0, 3).join(" · "),
              source: "stock-scanner",
            });
          });
        }
      }
    }
  } catch {
    // Non-blocking — stock scanner may time out
  }

  // Flush queued new-signal alerts: send only the top MAX_ALERTS_PER_SCAN
  // by confidence so a busy market doesn't spam the channel. SL/TP exit
  // alerts above are sent immediately (few + time-critical).
  alertQueue.sort((a, b) => b.conf - a.conf);
  const toSend = alertQueue.slice(0, MAX_ALERTS_PER_SCAN);
  for (const a of toSend) {
    const results = await Promise.all(
      DIGEST_CHAT_IDS.map((id) => sendTelegramMessage(id, a.text))
    );
    if (results.some(Boolean)) {
      newAlerts++;
      if (a.onSend) {
        try {
          await a.onSend();
        } catch {
          /* non-blocking */
        }
      }
    }
  }

  return { ran: true, newAlerts };
}

function formatStockOptionAlert(stock: any, opt: any): string {
  const isCall = opt.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  const band = getQualityBand(stock.totalScore);
  const rr = stock.riskReward ? `1:${stock.riskReward.toFixed(1)}` : "—";
  const reasons = (stock.reasons || []).slice(0, 3).join(" · ") || "Scanner pick";
  const direction = isCall ? "Bullish" : "Bearish";
  const targets = opt.targets.map((t: number, i: number) => `T${i + 1} ₹${t.toFixed(2)}`).join(" | ");

  return `${band.emoji} ${band.label} (${stock.totalScore}%)
📊 STOCK OPTION — ${stock.symbol}

${emoji} BUY ${opt.optionType} | ${stock.symbol} ${opt.strike}

📅 Monthly Expiry: ${opt.expiryLabel}
💰 Premium: ₹${opt.premium.toFixed(2)}
🛑 Stop Loss: ₹${opt.stopLoss.toFixed(2)}
🎯 ${targets}
📐 R:R ${rr}
📈 ${direction} | ${reasons}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`.trim();
}
