// Morning Scan — High-accuracy trades at 9 AM
// Includes: Equity + NIFTY/SENSEX/BANKNIFTY options
// Dedup: same trade skipped unless price or accuracy changed

import { readFileSync, writeFileSync, existsSync } from "fs";
import { sendTelegramMessage } from "./telegram";

const SCAN_FILE = "/tmp/morning-scan-history.json";

interface SentTrade {
  symbol: string;
  direction: string;
  strike: number;
  entry: number;
  score: number;
  sentAt: string;
}

interface ScanOpportunity {
  symbol: string;
  name: string;
  instrument: string;
  strategy: string;
  score: number;
  confidence: number;
  direction: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  reasoning: string[];
  position: {
    quantity: number;
    totalCost: number;
    maxLoss: number;
    maxLossPct: number;
  };
  data: {
    ltp: number;
    changePct: number;
  };
}

interface IndexOption {
  symbol: string;
  strike: number;
  type: "CE" | "PE";
  ltp: number;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  spotPrice: number;
  pcr: number;
  reasoning: string[];
}

// ── Load sent trades history ──
function loadHistory(): SentTrade[] {
  try {
    if (existsSync(SCAN_FILE)) {
      return JSON.parse(readFileSync(SCAN_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

// ── Save sent trades history ──
function saveHistory(trades: SentTrade[]): void {
  writeFileSync(SCAN_FILE, JSON.stringify(trades, null, 2));
}

// ── Check if trade is duplicate ──
function isDuplicate(
  symbol: string,
  direction: string,
  strike: number,
  entry: number,
  score: number,
  history: SentTrade[]
): boolean {
  const match = history.find(
    (h) =>
      h.symbol === symbol &&
      h.direction === direction &&
      h.strike === strike
  );

  if (!match) return false;

  // Allow re-send if price changed > 1% or accuracy changed > 5 points
  const priceChanged = Math.abs(match.entry - entry) / match.entry > 0.01;
  const scoreChanged = Math.abs(match.score - score) > 5;

  return !priceChanged && !scoreChanged;
}

// ── Format equity trade message ──
function formatEquityMessage(opp: ScanOpportunity, rank: number): string {
  const emoji = opp.direction === "BUY" ? "🟢" : "🔴";

  let msg = `${emoji} <b>#${rank} ${opp.symbol}</b> — ${opp.direction}\n`;
  msg += `📊 Score: <b>${opp.score}/100</b> | Conf: ${opp.confidence}%\n`;
  msg += `📈 ${opp.strategy}\n`;
  msg += `💰 Entry: ₹${opp.entry.toFixed(2)}\n`;
  msg += `🛑 SL: ₹${opp.stopLoss.toFixed(2)}\n`;
  msg += `🎯 TP1: ₹${opp.target1.toFixed(2)} | TP2: ₹${opp.target2.toFixed(2)}\n`;
  msg += `📐 R:R 1:${opp.riskReward.toFixed(1)}\n`;

  if (opp.position.quantity > 0) {
    msg += `📦 Qty: ${opp.position.quantity} | Cost: ₹${opp.position.totalCost.toLocaleString()}\n`;
  }

  if (opp.reasoning.length > 0) {
    msg += `📝 ${opp.reasoning.join(" • ")}\n`;
  }

  msg += `🔄 ₹${opp.data.ltp} (${opp.data.changePct > 0 ? "+" : ""}${opp.data.changePct.toFixed(1)}%)`;
  return msg;
}

// ── Format index option message ──
function formatIndexOptionMessage(opt: IndexOption, rank: number): string {
  const emoji = opt.type === "CE" ? "🟢 CALL" : "🔴 PUT";

  let msg = `${emoji} <b>#${rank} ${opt.symbol} ${opt.strike} ${opt.type}</b>\n`;
  msg += `💰 Entry: ₹${opt.entry.toFixed(2)}\n`;
  msg += `🛑 SL: ₹${opt.stopLoss.toFixed(2)}\n`;
  msg += `🎯 TP1: ₹${opt.target1.toFixed(2)} | TP2: ₹${opt.target2.toFixed(2)}\n`;
  msg += `📐 R:R 1:${opt.riskReward.toFixed(1)}\n`;
  msg += `📊 Spot: ${opt.spotPrice} | PCR: ${opt.pcr.toFixed(2)}\n`;

  if (opt.reasoning.length > 0) {
    msg += `📝 ${opt.reasoning.join(" • ")}\n`;
  }

  msg += `🔄 Premium: ₹${opt.ltp}`;
  return msg;
}

// ── Scan NIFTY/SENSEX options from Motilal ──
async function scanIndexOptions(): Promise<IndexOption[]> {
  const options: IndexOption[] = [];

  try {
    // Get NIFTY option chain
    const niftyRes = await fetch("http://localhost:3000/api/option-chain?symbol=NIFTY");
    const niftyData = await niftyRes.json();

    if (niftyData.data?.data) {
      const spot = niftyData.analysis?.spotPrice || niftyData.data.spotPrice || 0;
      const pcr = niftyData.analysis?.oiAnalysis?.pcr || 0;
      const strikes = niftyData.data.data;

      // Find ATM strike
      const atmStrike = strikes.reduce((best: any, s: any) =>
        Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
      )?.strike || 0;

      // Find ITM and slightly OTM options with good LTP
      for (const strike of strikes) {
        if (!strike.ce && !strike.pe) continue;
        const dist = Math.abs(strike.strike - atmStrike);

        // Only consider strikes within 500 points of ATM for NIFTY
        if (dist > 500) continue;

        const isATM = strike.strike === atmStrike;
        const isITM_CE = strike.strike < atmStrike;
        const isITM_PE = strike.strike > atmStrike;

        // CE trade
        if (strike.ce && strike.ce.ltp > 0) {
          const premium = strike.ce.ltp;
          const sl = premium * 0.75; // 25% SL
          const tp1 = premium * 1.30; // 30% target
          const tp2 = premium * 1.60; // 60% target
          const rr = (tp1 - premium) / (premium - sl);

          if (rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (isITM_CE) reasoning.push("ITM call");
            if (pcr > 1.2) reasoning.push(`Bullish PCR ${pcr.toFixed(2)}`);
            if (spot > 0) reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "NIFTY",
              strike: strike.strike,
              type: "CE",
              ltp: premium,
              entry: premium,
              stopLoss: sl,
              target1: tp1,
              target2: tp2,
              riskReward: rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }

        // PE trade
        if (strike.pe && strike.pe.ltp > 0) {
          const premium = strike.pe.ltp;
          const sl = premium * 0.75;
          const tp1 = premium * 1.30;
          const tp2 = premium * 1.60;
          const rr = (tp1 - premium) / (premium - sl);

          if (rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (isITM_PE) reasoning.push("ITM put");
            if (pcr < 0.8) reasoning.push(`Bearish PCR ${pcr.toFixed(2)}`);
            if (spot > 0) reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "NIFTY",
              strike: strike.strike,
              type: "PE",
              ltp: premium,
              entry: premium,
              stopLoss: sl,
              target1: tp1,
              target2: tp2,
              riskReward: rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }
      }
    }

    // Get SENSEX option chain
    const sensexRes = await fetch("http://localhost:3000/api/option-chain?symbol=SENSEX");
    const sensexData = await sensexRes.json();

    if (sensexData.data?.data) {
      const spot = sensexData.analysis?.spotPrice || sensexData.data.spotPrice || 0;
      const pcr = sensexData.analysis?.oiAnalysis?.pcr || 0;
      const strikes = sensexData.data.data;

      const atmStrike = strikes.reduce((best: any, s: any) =>
        Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
      )?.strike || 0;

      for (const strike of strikes) {
        if (!strike.ce && !strike.pe) continue;
        const dist = Math.abs(strike.strike - atmStrike);
        if (dist > 500) continue;

        const isATM = strike.strike === atmStrike;

        if (strike.ce && strike.ce.ltp > 0) {
          const premium = strike.ce.ltp;
          const sl = premium * 0.75;
          const tp1 = premium * 1.30;
          const tp2 = premium * 1.60;
          const rr = (tp1 - premium) / (premium - sl);

          if (rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (pcr > 1.2) reasoning.push(`Bullish PCR ${pcr.toFixed(2)}`);
            reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "SENSEX",
              strike: strike.strike,
              type: "CE",
              ltp: premium,
              entry: premium,
              stopLoss: sl,
              target1: tp1,
              target2: tp2,
              riskReward: rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }

        if (strike.pe && strike.pe.ltp > 0) {
          const premium = strike.pe.ltp;
          const sl = premium * 0.75;
          const tp1 = premium * 1.30;
          const tp2 = premium * 1.60;
          const rr = (tp1 - premium) / (premium - sl);

          if (rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (pcr < 0.8) reasoning.push(`Bearish PCR ${pcr.toFixed(2)}`);
            reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "SENSEX",
              strike: strike.strike,
              type: "PE",
              ltp: premium,
              entry: premium,
              stopLoss: sl,
              target1: tp1,
              target2: tp2,
              riskReward: rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }
      }
    }
  } catch (error: any) {
    console.warn("[MorningScan] Index options scan error:", error.message);
  }

  // Sort by R:R (best first), take top 3
  return options.sort((a, b) => b.riskReward - a.riskReward).slice(0, 3);
}

// ── Main morning scan ──
export async function runMorningScan(): Promise<{
  sent: number;
  skipped: number;
  totalScanned: number;
  message: string;
}> {
  const results = { sent: 0, skipped: 0, totalScanned: 0, message: "" };

  try {
    const history = loadHistory();
    let body = "";
    let rank = 0;

    // ── PART 1: Equity trades ──
    const scanRes = await fetch("http://localhost:3000/api/challenge");
    const scanData = await scanRes.json();
    const opportunities: ScanOpportunity[] = scanData.scan?.topOpportunities || [];

    const highAccuracy = opportunities.filter((o) => o.score >= 70);
    results.totalScanned = opportunities.length;

    for (const opp of highAccuracy) {
      if (rank >= 5) break;
      if (isDuplicate(opp.symbol, opp.direction, opp.entry, opp.entry, opp.score, history)) {
        results.skipped++;
        continue;
      }

      rank++;
      body += formatEquityMessage(opp, rank) + "\n\n";

      history.push({
        symbol: opp.symbol,
        direction: opp.direction,
        strike: opp.entry,
        entry: opp.entry,
        score: opp.score,
        sentAt: new Date().toISOString(),
      });
      results.sent++;
    }

    // ── PART 2: Index options (NIFTY/SENSEX) ──
    const indexOptions = await scanIndexOptions();

    for (const opt of indexOptions) {
      if (rank >= 8) break; // Max 8 total trades
      const direction = opt.type === "CE" ? "BUY_CALL" : "BUY_PUT";
      if (isDuplicate(opt.symbol, direction, opt.strike, opt.entry, 80, history)) {
        results.skipped++;
        continue;
      }

      rank++;
      body += formatIndexOptionMessage(opt, rank) + "\n\n";

      history.push({
        symbol: opt.symbol,
        direction,
        strike: opt.strike,
        entry: opt.entry,
        score: 80,
        sentAt: new Date().toISOString(),
      });
      results.sent++;
    }

    if (results.sent === 0) {
      results.message = `Scanned ${results.totalScanned} | ${results.skipped} duplicates | No new trades`;
      return results;
    }

    // ── Build full message ──
    const today = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    let header = `☀️ <b>MORNING SCAN — ${today}</b>\n`;
    header += `━━━━━━━━━━━━━━━━━━━\n`;
    header += `📊 Equity: ${highAccuracy.length} high-accuracy | Index Options: ${indexOptions.length}\n\n`;

    const footer = `\n━━━━━━━━━━━━━━━━━━━\n⏰ ${new Date().toLocaleTimeString("en-IN")} | ⚠️ Not financial advice`;

    const fullMessage = header + body + footer;

    // Send via Telegram
    await sendTelegramMessage(fullMessage);

    // Save history (keep last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentHistory = history.filter(
      (h) => new Date(h.sentAt).getTime() > sevenDaysAgo
    );
    saveHistory(recentHistory);

    results.message = `Sent ${results.sent} trades | ${results.skipped} skipped`;
  } catch (error: any) {
    results.message = `Scan failed: ${error.message}`;
  }

  return results;
}
