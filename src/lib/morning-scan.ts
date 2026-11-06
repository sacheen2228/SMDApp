// Morning Scan — High-accuracy trades at 9 AM
// Includes: Equity + NIFTY/SENSEX/BANKNIFTY options
// Dedup: same trade skipped unless price or accuracy changed

import { buildOptionPlan } from "./option-plan";
import { getLotSize } from "./symbol-config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { sendTelegramMessage } from "./telegram";
import { isPlausibleOptionPremium } from "./morningSignalGenerator";
import { isTelegramSendWindow } from "./marketHours";

const SCAN_FILE = process.env.MORNING_SCAN_HISTORY_FILE || "./data/morning-scan-history.json";
const SCAN_DIR = "./data";

const CHUNK_MAX_CHARS = 3800;

// Ensure the data directory exists
try {
  mkdirSync(SCAN_DIR, { recursive: true });
} catch { /* non-fatal */ }

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

// ── Index option plan (one builder for every leg) ──
// Plan: rupee risk (20% of the amount deployed) + 1:2 / 1:3 / 1:4 targets.
// The old 25%/30%/60% ladder was a 1.2:1 plan — under the gate's 1.5 floor.
//
// GUARD: the chain premium must be a PREMIUM. A row priced on the strike
// scale (the underlying price used as a premium) is a contract that does not
// exist — it would be monitored forever with no LTP.
//
// Exported so the 0-lot bail can be asserted offline (no network).
export function buildIndexOptionPlan(
  symbol: string,
  optionType: "CE" | "PE",
  premium: number,
  strike: number
): { entry: number; sl: number; tp1: number; tp2: number; rr: number } | null {
  const guard = isPlausibleOptionPremium({ entry: premium, strike });
  if (!guard.ok) {
    console.warn(`[MorningScan] skip ${symbol} ${optionType} strike ${strike} — ${guard.reason}`);
    return null;
  }

  const plan = buildOptionPlan({
    symbol, optionType, entryPremium: premium, lotSize: getLotSize(symbol) || 65,
  });
  if (!plan) {
    console.warn(`[MorningScan] skip ${symbol} ${optionType} strike ${strike} — no valid option plan`);
    return null;
  }
  // 0 lots = the contract does not fit the per-trade deployment budget →
  // NO TRADE (no alert, no tracker row). Never size it up to 1 lot.
  if (plan.lots < 1) {
    console.warn(
      `[MorningScan] skip ${symbol} ${optionType} strike ${strike} — 0 lots (${plan.notes.join("; ")})`
    );
    return null;
  }

  const entry = plan.entry;
  const sl = plan.stopLoss;
  const tp1 = plan.targets[0] ?? entry;
  const tp2 = plan.targets[1] ?? tp1;
  // SIGNED R:R (R1 geometry, both letters): risk = entry − sl > 0 and
  // reward = tp1 − entry > 0 for every current plan — a wrong-side stop
  // yields a negative ratio (blocked by the gate) instead of a masked 2.0.
  const rr = (tp1 - entry) / (entry - sl);
  return { entry, sl, tp1, tp2, rr };
}

// ── Scan NIFTY/SENSEX options from Motilal ──
async function scanIndexOptions(
  baseUrl: string,
  fetchWithTimeout: (url: string, timeoutMs?: number) => Promise<Response>
): Promise<IndexOption[]> {
  const options: IndexOption[] = [];

  try {
    // Get NIFTY option chain
    const niftyRes = await fetchWithTimeout(`${baseUrl}/api/option-chain?symbol=NIFTY`);
    if (!niftyRes.ok) throw new Error(`NIFTY chain returned ${niftyRes.status}`);
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
          const plan = buildIndexOptionPlan("NIFTY", "CE", premium, strike.strike);

          if (plan && plan.rr >= 1.2 && premium >= 10) {
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
              entry: plan.entry,
              stopLoss: plan.sl,
              target1: plan.tp1,
              target2: plan.tp2,
              riskReward: plan.rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }

        // PE trade
        if (strike.pe && strike.pe.ltp > 0) {
          const premium = strike.pe.ltp;
          const plan = buildIndexOptionPlan("NIFTY", "PE", premium, strike.strike);

          if (plan && plan.rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (isITM_PE) reasoning.push("ITM put");
            if (pcr > 0 && pcr < 0.8) reasoning.push(`Bearish PCR ${pcr.toFixed(2)}`);
            if (spot > 0) reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "NIFTY",
              strike: strike.strike,
              type: "PE",
              ltp: premium,
              entry: plan.entry,
              stopLoss: plan.sl,
              target1: plan.tp1,
              target2: plan.tp2,
              riskReward: plan.rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }
      }
    }

    // Get SENSEX option chain
    const sensexRes = await fetchWithTimeout(`${baseUrl}/api/option-chain?symbol=SENSEX`);
    if (!sensexRes.ok) throw new Error(`SENSEX chain returned ${sensexRes.status}`);
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
          // Same house plan as NIFTY — the old 25%/30%/60% ladder was 1.2:1
          // (under the gate's 1.5 floor) and it priced SENSEX with the NIFTY
          // lot size.
          const plan = buildIndexOptionPlan("SENSEX", "CE", premium, strike.strike);

          if (plan && plan.rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (pcr > 1.2) reasoning.push(`Bullish PCR ${pcr.toFixed(2)}`);
            reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "SENSEX",
              strike: strike.strike,
              type: "CE",
              ltp: premium,
              entry: plan.entry,
              stopLoss: plan.sl,
              target1: plan.tp1,
              target2: plan.tp2,
              riskReward: plan.rr,
              spotPrice: spot,
              pcr,
              reasoning,
            });
          }
        }

        if (strike.pe && strike.pe.ltp > 0) {
          const premium = strike.pe.ltp;
          // SENSEX lot size (the old call planned a SENSEX put with NIFTY's).
          const plan = buildIndexOptionPlan("SENSEX", "PE", premium, strike.strike);

          if (plan && plan.rr >= 1.2 && premium >= 10) {
            const reasoning: string[] = [];
            if (isATM) reasoning.push("ATM strike");
            if (pcr > 0 && pcr < 0.8) reasoning.push(`Bearish PCR ${pcr.toFixed(2)}`);
            reasoning.push(`Spot ${spot}`);

            options.push({
              symbol: "SENSEX",
              strike: strike.strike,
              type: "PE",
              ltp: premium,
              entry: plan.entry,
              stopLoss: plan.sl,
              target1: plan.tp1,
              target2: plan.tp2,
              riskReward: plan.rr,
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

  // Send window gate: no scanning, sending, or history writes outside market hours.
  if (!isTelegramSendWindow()) {
    results.message = "Outside Telegram send window (09:10–15:30 IST) — scan skipped";
    return results;
  }

  const baseUrl = process.env.APP_BASE_URL || "http://localhost:3000";
  const fetchWithTimeout = async (url: string, timeoutMs = 15_000): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    const history = loadHistory();
    let body = "";
    let rank = 0;

    // ── PART 1: Equity trades ──
    let scanData: any;
    try {
      const scanRes = await fetchWithTimeout(`${baseUrl}/api/challenge`);
      if (!scanRes.ok) {
        throw new Error(`challenge API returned ${scanRes.status}`);
      }
      scanData = await scanRes.json();
    } catch (error: any) {
      results.message = `Scan failed: ${error.message}`;
      return results;
    }
    const opportunities: ScanOpportunity[] = scanData.scan?.topOpportunities || [];
    results.totalScanned = opportunities.length;

    const highAccuracy = opportunities.filter((o) => o.score >= 70);

    for (const opp of highAccuracy) {
      if (rank >= 5) break;
      if (isDuplicate(opp.symbol, opp.direction, opp.entry, opp.entry, opp.score, history)) {
        results.skipped++;
        continue;
      }

      rank++;
      body += formatEquityMessage(opp, rank) + "\n\n";
    }

    // ── PART 2: Index options (NIFTY/SENSEX) ──
    let indexOptions: IndexOption[] = [];
    try {
      indexOptions = await scanIndexOptions(baseUrl, fetchWithTimeout);
    } catch (error: any) {
      results.message = `Scan failed: ${error.message}`;
      return results;
    }

    for (const opt of indexOptions) {
      if (rank >= 8) break; // Max 8 total trades
      const direction = opt.type === "CE" ? "BUY_CALL" : "BUY_PUT";
      if (isDuplicate(opt.symbol, direction, opt.strike, opt.entry, 80, history)) {
        results.skipped++;
        continue;
      }

      rank++;
      body += formatIndexOptionMessage(opt, rank) + "\n\n";
    }

    if (results.sent === 0 && body.trim() === "") {
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

    // Send via Telegram — split into chunks of at most CHUNK_MAX_CHARS.
    // A trade is added to history ONLY after its chunk is sent successfully.
    let allSent = true;
    const chunks: string[] = [];
    let current = "";
    const parts = fullMessage.split("\n");
    for (const part of parts) {
      if ((current + part + "\n").length > CHUNK_MAX_CHARS && current.length > 0) {
        chunks.push(current.trim());
        current = part + "\n";
      } else {
        current += part + "\n";
      }
    }
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = i === 0 ? `${header}${chunks[i]}${footer}` : chunks[i];
      const sent = await sendTelegramMessage(chunk);
      if (!sent) {
        allSent = false;
        console.error(`[MorningScan] chunk ${i + 1}/${chunks.length} failed to send`);
        break;
      }
    }

    if (allSent) {
      // Only now add trades to history — after successful delivery.
      for (const opp of highAccuracy) {
        if (rank <= 0) break;
        // Re-check duplicates against the history we already loaded
        // (we already skipped duplicates during the scan above, so just mark the ones we sent)
      }
      // Mark sent trades in history by re-scanning the opportunities we included
      for (const opp of highAccuracy) {
        if (isDuplicate(opp.symbol, opp.direction, opp.entry, opp.entry, opp.score, history)) continue;
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
      for (const opt of indexOptions) {
        const direction = opt.type === "CE" ? "BUY_CALL" : "BUY_PUT";
        if (isDuplicate(opt.symbol, direction, opt.strike, opt.entry, 80, history)) continue;
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

      // Save history (keep last 7 days)
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentHistory = history.filter(
        (h) => new Date(h.sentAt).getTime() > sevenDaysAgo
      );
      try {
        writeFileSync(SCAN_FILE, JSON.stringify(recentHistory, null, 2));
      } catch (error: any) {
        console.error(`[MorningScan] failed to save history: ${error.message}`);
      }

      results.message = `Sent ${results.sent} trades | ${results.skipped} skipped`;
    } else {
      results.message = `Scan completed but Telegram send failed — no history saved`;
    }
  } catch (error: any) {
    results.message = `Scan failed: ${error.message}`;
  }

  return results;
}
