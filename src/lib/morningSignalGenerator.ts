// lib/morningSignalGenerator.ts
//
// Morning signal generator — scans ALL instruments and sends high-accuracy
// trade recommendations to Telegram at market open. Deduplicates against
// signals sent today.

import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO } from "@/lib/trade-intelligence/index-fo-mode";
import { analyzeStockFO } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeEquitySwing } from "@/lib/trade-intelligence/equity-swing-mode";
import {
  buildSignalSignature,
  isSignalAlreadySent,
  markSignalSent,
  isSignalDuplicateOrLowerQuality,
} from "./signalTracker";
import { isTelegramSendWindow } from "./marketHours";
import { isTradeActive } from "./active-trade-lock";
import { addTrade } from "./activeTradeTracker";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";
const MIN_CONFIDENCE = 70; // Minimum confidence to include in morning digest

interface MorningSignal {
  symbol: string;
  name: string;
  sector: string;
  type: "CE" | "PE" | "FUT" | "EQ";
  direction: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  rr: number;
  confidence: number;
  instrument: string;
  reasoning: string;
  source: string;
  strike?: number;
  expiry?: string;
  premium?: number;
}

function fetchWithTimeout(url: string, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// Fetch MCX commodity signals (CRUDEOIL, GOLD, SILVER, NATURALGAS)
async function fetchMCXSignals(): Promise<MorningSignal[]> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/mcx?mode=scanner`);
    if (!res.ok) return [];
    const json = await res.json();
    const best = json?.data?.bestTrade || json?.bestTrade;
    if (!best) return [];
    return [
      {
        symbol: best.symbol || "CRUDEOIL",
        name: best.symbol || "Crude Oil",
        sector: "Commodity",
        type: "CE",
        direction: best.direction || "LONG",
        entry: best.entry || 0,
        stopLoss: best.stopLoss || 0,
        tp1: best.target1 || 0,
        tp2: best.target2 || 0,
        rr: best.riskReward || 1,
        confidence: best.confidence || 0,
        instrument: best.instrument || "MCX CRUDEOIL",
        reasoning: best.reasoning || "MCX commodity scan",
        source: "mcx-scanner",
        premium: best.premium,
      },
    ];
  } catch {
    return [];
  }
}

// Fetch FII/DII context for morning digest
async function fetchFIIDII(): Promise<{ fiiNet: string; diiNet: string } | null> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/fii-dii`);
    if (!res.ok) return null;
    const json = await res.json();
    return {
      fiiNet: json?.fiiNet ?? "N/A",
      diiNet: json?.diiNet ?? "N/A",
    };
  } catch {
    return null;
  }
}

// Fetch market regime
async function fetchRegime(): Promise<string> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/market/regime`);
    if (!res.ok) return "unknown";
    const json = await res.json();
    return json?.regime || json?.data?.regime || "unknown";
  } catch {
    return "unknown";
  }
}

function formatMorningDigest(
  signals: MorningSignal[],
  fii: { fiiNet: string; diiNet: string } | null,
  regime: string
): string {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const header = `🌅 <b>GOOD MORNING — MARKET SIGNALS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
📅 ${now}
${fii ? `📊 FII: <b>${fii.fiiNet}</b> | DII: <b>${fii.diiNet}</b>` : ""}
📈 Regime: <b>${regime.toUpperCase()}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━`;

  if (signals.length === 0) {
    return `${header}\n\n⚠️ No high-accuracy setups found today.\nMarket conditions may not favor trading right now.\n\n💡 Wait for setups with ≥${MIN_CONFIDENCE}% confidence.`;
  }

  const signalLines = signals.map((s, i) => {
    const emoji = s.direction.includes("BUY") || s.direction === "LONG" ? "🟢" : "🔴";
    const dir = s.direction.includes("BUY") || s.direction === "LONG" ? "BULLISH" : "BEARISH";
    const rrText = s.rr > 0 ? `1:${s.rr.toFixed(1)}` : "—";

    return `
${emoji} <b>${i + 1}. ${s.symbol}</b> — ${s.sector}
⚡ ${s.instrument}
📊 Direction: <b>${dir}</b> | Confidence: <b>${s.confidence}%</b>
💰 Entry: ₹${s.entry.toFixed(2)} | SL: ₹${s.stopLoss.toFixed(2)}
🎯 T1: ₹${s.tp1.toFixed(2)} | T2: ₹${s.tp2.toFixed(2)}
📐 R:R ${rrText}
📝 ${s.reasoning?.slice(0, 120) || "—"}`;
  });

  const footer = `
━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 Signals: ${signals.length} | Min confidence: ${MIN_CONFIDENCE}%
💡 <i>Trade with strict SL. Not financial advice.</i>`;

  return header + signalLines.join("\n") + footer;
}

// Also send individual signal alerts for each high-quality setup
async function sendIndividualSignals(
  signals: MorningSignal[],
  sendFn: (text: string) => Promise<boolean>
): Promise<number> {
  let sent = 0;
  for (const s of signals) {
    const sig = buildSignalSignature({
      symbol: s.symbol,
      strike: s.strike,
      optionType: s.type,
      direction: s.direction,
    });
    if (isSignalAlreadySent(sig)) continue;

    // ACTIVE-TRADE LOCK: skip if already have an active trade on this underlying
    const existingTrade = isTradeActive(s.symbol, "NFO");
    if (existingTrade) {
      console.log(`[MorningSignals] SKIP ${s.symbol} — active trade ${existingTrade.tradeId} exists (${existingTrade.strategy})`);
      continue;
    }

    const emoji = s.direction.includes("BUY") || s.direction === "LONG" ? "🟢" : "🔴";
    const dir = s.direction.includes("BUY") || s.direction === "LONG" ? "BULLISH" : "BEARISH";

    const text = `${emoji} <b>MORNING PICK — ${s.symbol}</b>

📊 ${s.instrument}
⚡ Direction: <b>${dir}</b> | Confidence: <b>${s.confidence}%</b>
💰 Entry: ₹${s.entry.toFixed(2)}
🛑 Stop Loss: ₹${s.stopLoss.toFixed(2)}
🎯 Target 1: ₹${s.tp1.toFixed(2)}
🎯 Target 2: ₹${s.tp2.toFixed(2)}
📐 R:R 1:${s.rr.toFixed(1)}
📝 ${s.reasoning?.slice(0, 150) || "—"}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

    const ok = await sendFn(text);
    if (ok) {
      markSignalSent(sig, s.confidence, "morning-digest");

      // TRADE REGISTRATION: register with active trade tracker + lock
      const tradeId = `morning-${s.symbol}-${Date.now()}`;
      await addTrade({
        id: tradeId,
        symbol: s.symbol,
        side: "BUY",
        instrument: s.instrument,
        strike: s.strike || 0,
        optionType: s.type,
        entry: s.entry,
        sl: s.stopLoss,
        tp1: s.tp1,
        tp2: s.tp2,
        status: "ACTIVE",
        sentAt: new Date().toISOString(),
        source: "morning-signal",
        confidence: s.confidence,
      }, true); // skipAlert=true — already sent above

      sent++;
    }
  }
  return sent;
}

export async function generateMorningSignals(): Promise<{
  success: boolean;
  signalsFound: number;
  signalsSent: number;
  digestSent: boolean;
  instruments: string[];
}> {
  console.log("[MorningSignals] Starting morning signal generation...");

  // Build market context
  const ctx = await buildMarketIntelligenceContext();

  // Run all scanners in parallel
  const [indexSignals, stockSignals, swingSignals, mcxFutures, fii, regime] =
    await Promise.all([
      analyzeIndexFO(ctx),
      analyzeStockFO(ctx, 15),
      analyzeEquitySwing(ctx, 15),
      fetchMCXSignals(),
      fetchFIIDII(),
      fetchRegime(),
    ]);

  // Combine all signals
  const allSignals = [
    ...indexSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s): MorningSignal => ({
        symbol: s.symbol,
        name: s.symbol,
        sector: "Index F&O",
        type: (s.direction === "SHORT" || s.direction === "PUT" ? "PE" : "CE") as "CE" | "PE",
        direction: String(s.direction),
        entry: s.entry,
        stopLoss: s.stopLoss,
        tp1: s.target1,
        tp2: s.target2,
        rr: s.riskReward,
        confidence: s.confidence,
        instrument: (s as any).recommendedInstrument || s.symbol,
        reasoning: Array.isArray(s.reasoning) ? s.reasoning.join("; ") : String(s.reasoning || ""),
        source: "index-fo",
        strike: s.strike,
        expiry: s.expiry,
        premium: s.premium,
      })),
    ...stockSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s): MorningSignal => ({
        symbol: s.symbol,
        name: s.name,
        sector: "Stock F&O",
        type: (s.direction === "BUY_CE"
          ? "CE"
          : s.direction === "BUY_PE"
            ? "PE"
            : "FUT") as "CE" | "PE" | "FUT",
        direction: String(s.direction),
        entry: s.entry,
        stopLoss: s.stopLoss,
        tp1: s.target1,
        tp2: s.target2,
        rr: s.riskReward,
        confidence: s.confidence,
        instrument: (s as any).recommendedInstrument || s.symbol,
        reasoning: Array.isArray(s.reasoning) ? s.reasoning.join("; ") : String((s as any).reasoning || ""),
        source: "stock-fo",
        strike: (s as any).strike,
        expiry: (s as any).expiry,
        premium: (s as any).premium,
      })),
    ...swingSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s): MorningSignal => ({
        symbol: s.symbol,
        name: s.name,
        sector: "Equity Swing",
        type: "EQ" as const,
        direction: String(s.direction),
        entry: s.entry,
        stopLoss: s.stopLoss,
        tp1: s.target1,
        tp2: s.target2,
        rr: s.riskReward,
        confidence: s.confidence,
        instrument: (s as any).recommendedInstrument || s.symbol,
        reasoning: Array.isArray((s as any).reasoning) ? (s as any).reasoning.join("; ") : String((s as any).reasoning || ""),
        source: "equity-swing",
      })),
    ...mcxFutures.filter((s) => s.confidence >= MIN_CONFIDENCE),
  ];

  // Deduplicate — skip signals already sent today (from option-chain auto-alerts etc.)
  // Also skip signals where an active trade already exists on the same underlying
  const freshSignals = allSignals.filter((s) => {
    const sig = buildSignalSignature({
      symbol: s.symbol,
      strike: s.strike,
      optionType: s.type,
      direction: s.direction,
    });
    if (isSignalDuplicateOrLowerQuality(sig, s.confidence)) return false;
    if (isTradeActive(s.symbol, "NFO")) return false;
    return true;
  });

  // Sort by confidence descending, take top 10
  freshSignals.sort((a, b) => b.confidence - a.confidence);
  const topSignals = freshSignals.slice(0, 10);

  console.log(
    `[MorningSignals] Found ${allSignals.length} raw signals, ${freshSignals.length} fresh, top ${topSignals.length}`
  );

  // Track which instruments are covered
  const instruments = [...new Set(topSignals.map((s) => s.sector))];

  return {
    success: true,
    signalsFound: freshSignals.length,
    signalsSent: 0,
    digestSent: false,
    instruments,
    topSignals,
    fii,
    regime,
  } as any;
}

// Full morning flow: generate + send digest + individual signals
export async function runMorningSignalFlow(
  sendFn: (text: string) => Promise<boolean>
): Promise<{
  success: boolean;
  signalsFound: number;
  signalsSent: number;
  digestSent: boolean;
  instruments: string[];
}> {
  const result = await generateMorningSignals();
  const topSignals = (result as any).topSignals || [];
  const fii = (result as any).fii || null;
  const regime = (result as any).regime || "unknown";

  // Send digest
  const digest = formatMorningDigest(topSignals, fii, regime);
  const digestSent = await sendFn(digest);

  // Send individual signals
  const signalsSent = await sendIndividualSignals(topSignals, sendFn);

  return {
    success: true,
    signalsFound: result.signalsFound,
    signalsSent,
    digestSent,
    instruments: result.instruments,
  };
}
