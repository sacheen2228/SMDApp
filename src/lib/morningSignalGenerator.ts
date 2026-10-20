// lib/morningSignalGenerator.ts
//
// Morning signal generator — scans ALL instruments and sends high-accuracy
// trade recommendations to Telegram at market open. Deduplicates against
// signals sent today.
//
// ── TYPE INTEGRITY (2026-10-20) ─────────────────────────────────────────────
// The live Telegram alert "📊 BHARTIARTL — PE / BUY PUT / Strike 1875.2 /
// Entry ₹1875.20" was a CASH trade registered as an OPTION: the stock price
// was used as an option premium. Downstream, `optionType` decides whether a
// plan is MIRRORED (PE → stop above the entry, targets below) or LONG (CE →
// stop below the entry, targets above) and the tracker resolves an OPTION LTP
// for CE/PE — so the trade was monitored on the wrong side and its LTP could
// never be found ("LTP feed unavailable after 10 consecutive attempts",
// forever, with the trade open and the lock held).
//
// Rules enforced in this file:
//   1. CE/PE only for a REAL option trade: a real premium, a real strike, a
//      real expiry and a premium-priced entry (see isPlausibleOptionPremium).
//   2. Cash-equity signals are "EQ" with the correct BUY/SELL side.
//   3. Futures / index-underlying signals are "FUT" (underlying price space) —
//      never CE/PE.
//   4. Option levels are built by the house plan (option-plan.ts) because the
//      TP/SL monitor implements THAT convention (CE long, PE mirrored).
//   5. Only trades the TP/SL monitor can actually price are registered.

import { buildMarketIntelligenceContext } from "@/lib/trade-intelligence/market-context";
import { analyzeIndexFO, type IndexFOSignal } from "@/lib/trade-intelligence/index-fo-mode";
import { analyzeStockFO, type StockFOSignal } from "@/lib/trade-intelligence/stock-fo-mode";
import { analyzeEquitySwing, type EquitySwingSignal } from "@/lib/trade-intelligence/equity-swing-mode";
import {
  buildSignalSignature,
  isSignalAlreadySent,
  markSignalSent,
  isSignalDuplicateOrLowerQuality,
} from "./signalTracker";
import { isTelegramSendWindow } from "./marketHours";
import { isTradeActive } from "./active-trade-lock";
import { addTrade, type ActiveTrade } from "./activeTradeTracker";
import { buildOptionPlan } from "./option-plan";
import { getLotSize } from "./symbol-config";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";
const MIN_CONFIDENCE = 70; // Minimum confidence to include in morning digest

export type MorningSignalType = "CE" | "PE" | "FUT" | "EQ";
export type MorningSignalSide = "BUY" | "SELL";

export interface MorningSignal {
  symbol: string;
  name: string;
  sector: string;
  /** The instrument TYPE. CE/PE only for a real option contract; cash equity
   *  is "EQ"; futures / index-underlying is "FUT". */
  type: MorningSignalType;
  /** BUY/SELL of the instrument. An option buy is always BUY (the PE mirror
   *  lives in the levels); a cash/futures short is SELL — its stop sits ABOVE
   *  the entry. */
  side: MorningSignalSide;
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

/** True only for a REAL option contract. */
export function isOptionType(type: string | undefined | null): boolean {
  return type === "CE" || type === "PE";
}

const MCX_SYMBOLS = new Set([
  "CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI",
  "GOLD", "GOLDM", "GOLDGUINEA",
  "SILVER", "SILVERM", "SILVERMIC",
]);

function isMCXSymbol(symbol: string): boolean {
  return MCX_SYMBOLS.has((symbol || "").toUpperCase());
}

/**
 * GUARD — an option trade MUST be priced in PREMIUM space.
 *
 * The live incident: "BHARTIARTL — PE / Strike 1875.2 / Entry ₹1875.20" —
 * the STOCK price was used as an option premium, so the tracker chased a
 * contract that does not exist and mirrored the cash geometry as if it were
 * a put.
 *
 * Price-scale rules only (no network, no chain):
 *   1. the entry must be a positive number;
 *   2. the entry must NOT sit on the strike/underlying scale (within 1%);
 *   3. when the chain premium is known, the entry must not exceed 50x it;
 *   4. the entry must stay below the strike (a bought premium is worth less
 *      than its strike for every contract this app trades).
 */
export function isPlausibleOptionPremium(args: {
  entry: number;
  strike?: number;
  chainPremium?: number;
}): { ok: boolean; reason: string } {
  const entry = Number(args.entry);
  const strike = Number(args.strike || 0);
  const chainPremium = Number(args.chainPremium || 0);

  if (!(entry > 0)) {
    return { ok: false, reason: `entry ${entry} is not a positive premium` };
  }
  if (strike > 0 && Math.abs(entry - strike) / strike <= 0.01) {
    return {
      ok: false,
      reason:
        `entry ₹${entry.toFixed(2)} sits on the strike scale (strike ₹${strike}) — ` +
        `the underlying price was used as an option premium`,
    };
  }
  if (chainPremium > 0 && entry > chainPremium * 50) {
    return {
      ok: false,
      reason: `entry ₹${entry.toFixed(2)} is more than 50x the chain premium ₹${chainPremium.toFixed(2)}`,
    };
  }
  if (strike > 0 && entry > strike) {
    return {
      ok: false,
      reason: `entry ₹${entry.toFixed(2)} exceeds the strike ₹${strike} — not a plausible premium`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * A signal that must never be announced nor registered (null = it is fine).
 * Only option signals can fail here — cash/futures signals are honest by
 * construction (non-option type + underlying levels).
 */
export function signalIntegrityFailure(s: MorningSignal): string | null {
  if (!isOptionType(s.type)) return null;
  const strike = Number(s.strike || 0);
  if (!(strike > 0)) return "option signal without a strike";
  if (!s.expiry) return "option signal without an expiry";
  const guard = isPlausibleOptionPremium({
    entry: s.entry,
    strike,
    chainPremium: s.premium,
  });
  return guard.ok ? null : guard.reason;
}

/**
 * The TP/SL monitor (tiger-monitor.fetchLTP) can price:
 *   · CE/PE → the option premium from the chain
 *   · EQ    → the NSE cash quote
 * It CANNOT price index futures or MCX commodities — there is no LTP source
 * for them, so registering such a trade would leave it open forever and page
 * "LTP feed unavailable" on every poll (and hold the one-trade lock).
 */
export function isRegistrable(s: MorningSignal): boolean {
  if (signalIntegrityFailure(s)) return false;
  if (s.type === "FUT") return false;
  return true;
}

/** Lock/journal namespace for a signal (one lock per underlying per exchange). */
export function exchangeForSignal(s: { symbol: string; type: MorningSignalType }): string {
  if (s.type === "FUT" && isMCXSymbol(s.symbol)) return "MCX";
  if (s.symbol === "SENSEX" || s.symbol === "BANKEX") return "BSE";
  if (s.type === "EQ") return "NSE";
  return "NFO";
}

/**
 * The instrument string stored on the trade. Cash/futures use the house
 * machine strings ("EQUITY" / "FUTURES") — the monitor treats an instrument
 * containing "PE"/"PUT" as a mirrored put, and a symbol like "PETROCHEM"
 * would otherwise flip a cash long into a put.
 */
export function trackerInstrument(s: MorningSignal): string {
  if (s.type === "CE" || s.type === "PE") {
    return `${s.symbol} ${s.strike || ""} ${s.type}`.trim();
  }
  return s.type === "EQ" ? "EQUITY" : "FUTURES";
}

/** BULLISH/BEARISH view of the UNDERLYING (a bought put is a bearish view). */
export function directionLabel(s: MorningSignal): "BULLISH" | "BEARISH" {
  if (s.type === "PE") return "BEARISH";
  if (s.type === "CE") return "BULLISH";
  return s.side === "SELL" ? "BEARISH" : "BULLISH";
}

/**
 * The house option plan (rupee risk + 1:2 / 1:3 / 1:4 ladder). The TP/SL
 * monitor implements exactly this convention — CE: stop below the entry,
 * PE: stop above it — so every option trade registered here is built with it.
 */
function planForOption(symbol: string, type: "CE" | "PE", premium: number) {
  const lotSize = getLotSize(symbol) || 1;
  return buildOptionPlan({ symbol, optionType: type, entryPremium: premium, lotSize });
}

function joinReasoning(reasoning: unknown): string {
  return Array.isArray(reasoning) ? reasoning.join("; ") : String(reasoning || "");
}

/**
 * Index F&O signal → MorningSignal with an HONEST type.
 *   CALL / PUT → CE / PE, but ONLY with a real premium + strike + expiry
 *                 (the levels are then the house plan, priced from the
 *                 premium — never the underlying price).
 *   LONG / SHORT (or an option view without a real contract) → FUT with the
 *                 correct side; those levels are UNDERLYING levels.
 */
export function mapIndexFOSignal(s: IndexFOSignal): MorningSignal | null {
  if (!s) return null;
  const dir = String(s.direction || "");
  if (dir === "NO_TRADE") return null;

  const isCall = dir === "CALL";
  const isPut = dir === "PUT";
  const isLong = dir === "LONG";
  const isShort = dir === "SHORT";
  if (!isCall && !isPut && !isLong && !isShort) return null;

  const reasoning = joinReasoning(s.reasoning);

  if (isCall || isPut) {
    const type: MorningSignalType = isCall ? "CE" : "PE";
    const hasContract = s.premium > 0 && s.strike > 0 && !!s.expiry;
    if (hasContract) {
      const plan = planForOption(s.symbol, type, s.premium);
      if (plan) {
        return {
          symbol: s.symbol,
          name: s.symbol,
          sector: "Index F&O",
          type,
          side: "BUY",
          direction: dir,
          entry: plan.entry,
          stopLoss: plan.stopLoss,
          tp1: plan.targets[0] ?? plan.entry,
          tp2: plan.targets[1] ?? plan.targets[0] ?? plan.entry,
          rr: plan.rr,
          confidence: s.confidence,
          instrument: s.recommendedInstrument || `${s.symbol} ${s.strike} ${type}`,
          reasoning,
          source: "index-fo",
          strike: s.strike,
          expiry: s.expiry,
          premium: s.premium,
        };
      }
      // A contract exists but no honest plan can be built from it → no trade.
      console.log(
        `[MorningSignals] DROP ${s.symbol} — ${dir} contract without a valid option plan`
      );
      return null;
    }
    // No honest option contract → the levels are UNDERLYING levels → a
    // futures-style trade. It must NEVER be registered as CE/PE.
    const side: MorningSignalSide = isPut ? "SELL" : "BUY";
    return {
      symbol: s.symbol,
      name: s.symbol,
      sector: "Index F&O",
      type: "FUT",
      side,
      direction: dir,
      entry: s.entry,
      stopLoss: s.stopLoss,
      tp1: s.target1,
      tp2: s.target2,
      rr: s.riskReward,
      confidence: s.confidence,
      instrument: `${s.symbol} ${side === "SELL" ? "Short " : ""}Futures`,
      reasoning: reasoning + (s.premiumNote ? ` | premium reprice failed: ${s.premiumNote}` : ""),
      source: "index-fo",
    };
  }

  // LONG / SHORT — index futures, underlying levels.
  const side: MorningSignalSide = isShort ? "SELL" : "BUY";
  return {
    symbol: s.symbol,
    name: s.symbol,
    sector: "Index F&O",
    type: "FUT",
    side,
    direction: dir,
    entry: s.entry,
    stopLoss: s.stopLoss,
    tp1: s.target1,
    tp2: s.target2,
    rr: s.riskReward,
    confidence: s.confidence,
    instrument: `${s.symbol} ${side === "SELL" ? "Short " : ""}Futures`,
    reasoning,
    source: "index-fo",
  };
}

/**
 * Stock F&O signal → MorningSignal with an HONEST type.
 *   BUY_CE / BUY_PE → CE / PE (real premium + strike + expiry required).
 *   LONG / SHORT    → FUT (underlying levels).
 *   An option view WITHOUT a real contract is DROPPED — its levels live in
 *   an unknown price space, so it can be neither an option nor a cash trade.
 */
export function mapStockFOSignal(s: StockFOSignal): MorningSignal | null {
  if (!s) return null;
  const dir = String(s.direction || "");
  if (dir === "NO_TRADE") return null;

  const isCe = dir === "BUY_CE";
  const isPe = dir === "BUY_PE";
  const isLong = dir === "LONG";
  const isShort = dir === "SHORT";
  if (!isCe && !isPe && !isLong && !isShort) return null;

  const reasoning = joinReasoning((s as any).reasoning);

  if (isCe || isPe) {
    const type: MorningSignalType = isCe ? "CE" : "PE";
    if (s.premium > 0 && s.strike > 0 && s.expiry) {
      const plan = planForOption(s.symbol, type, s.premium);
      if (plan) {
        return {
          symbol: s.symbol,
          name: s.name,
          sector: "Stock F&O",
          type,
          side: "BUY",
          direction: dir,
          entry: plan.entry,
          stopLoss: plan.stopLoss,
          tp1: plan.targets[0] ?? plan.entry,
          tp2: plan.targets[1] ?? plan.targets[0] ?? plan.entry,
          rr: plan.rr,
          confidence: s.confidence,
          instrument: (s as any).recommendedInstrument || `${s.symbol} ${s.strike} ${type}`,
          reasoning,
          source: "stock-fo",
          strike: s.strike,
          expiry: s.expiry,
          premium: s.premium,
        };
      }
    }
    console.log(
      `[MorningSignals] DROP ${s.symbol} — ${dir} without a real premium/strike/expiry (no honest option contract)`
    );
    return null;
  }

  const side: MorningSignalSide = isShort ? "SELL" : "BUY";
  return {
    symbol: s.symbol,
    name: s.name,
    sector: "Stock F&O",
    type: "FUT",
    side,
    direction: dir,
    entry: s.entry,
    stopLoss: s.stopLoss,
    tp1: s.target1,
    tp2: s.target2,
    rr: s.riskReward,
    confidence: s.confidence,
    instrument: `${s.symbol} ${side === "SELL" ? "Short " : ""}Futures`,
    reasoning,
    source: "stock-fo",
  };
}

/**
 * Equity swing (CASH) signal → MorningSignal.
 * Cash levels, so the type is "EQ" and the side follows the direction:
 * a cash SELL has its stop ABOVE the entry (the tracker must not mirror it
 * as a put).
 */
export function mapEquitySwingSignal(s: EquitySwingSignal): MorningSignal {
  const side: MorningSignalSide = s.direction === "SELL" ? "SELL" : "BUY";
  return {
    symbol: s.symbol,
    name: s.name,
    sector: "Equity Swing",
    type: "EQ",
    side,
    direction: String(s.direction),
    entry: s.entry,
    stopLoss: s.stopLoss,
    tp1: s.target1,
    tp2: s.target2,
    rr: s.riskReward,
    confidence: s.confidence,
    instrument: (s as any).recommendedInstrument || `${s.symbol} (cash ${side === "SELL" ? "short" : "long"})`,
    reasoning: joinReasoning((s as any).reasoning),
    source: "equity-swing",
  };
}

function fetchWithTimeout(url: string, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// Fetch MCX commodity signals (CRUDEOIL, GOLD, SILVER, NATURALGAS)
// These are COMMODITY FUTURES — never an option contract, so the type is
// "FUT" and the levels are futures (underlying) levels.
async function fetchMCXSignals(): Promise<MorningSignal[]> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/mcx?mode=scanner`);
    if (!res.ok) return [];
    const json = await res.json();
    const best = json?.data?.bestTrade || json?.bestTrade;
    if (!best) return [];
    const dir = String(best.direction || "LONG").toUpperCase();
    const side: MorningSignalSide = dir === "SHORT" || dir === "SELL" ? "SELL" : "BUY";
    return [
      {
        symbol: best.symbol || "CRUDEOIL",
        name: best.symbol || "Crude Oil",
        sector: "Commodity",
        type: "FUT",
        side,
        direction: dir,
        entry: best.entry || 0,
        stopLoss: best.stopLoss || 0,
        tp1: best.target1 || best.target || 0,
        tp2: best.target2 || 0,
        rr: best.riskReward || 1,
        confidence: best.confidence || 0,
        instrument: best.instrument || `MCX ${best.symbol || "CRUDEOIL"} Futures`,
        reasoning: best.reasoning || "MCX commodity scan",
        source: "mcx-scanner",
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
    const dir = directionLabel(s);
    const emoji = dir === "BULLISH" ? "🟢" : "🔴";
    const rrText = s.rr > 0 ? `1:${s.rr.toFixed(1)}` : "—";

    return `
${emoji} <b>${i + 1}. ${s.symbol}</b> — ${s.sector}
⚡ ${s.instrument}
📊 Direction: <b>${dir}</b> | Side: <b>${s.side}</b> | Confidence: <b>${s.confidence}%</b>
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

/** The individual "MORNING PICK" alert for one signal. */
export function formatPick(s: MorningSignal): string {
  const dir = directionLabel(s);
  const emoji = dir === "BULLISH" ? "🟢" : "🔴";

  return `${emoji} <b>MORNING PICK — ${s.symbol}</b>

📊 ${s.instrument}
⚡ Direction: <b>${dir}</b> | Side: <b>${s.side}</b> | Confidence: <b>${s.confidence}%</b>
💰 Entry: ₹${s.entry.toFixed(2)}
🛑 Stop Loss: ₹${s.stopLoss.toFixed(2)}
🎯 Target 1: ₹${s.tp1.toFixed(2)}
🎯 Target 2: ₹${s.tp2.toFixed(2)}
📐 R:R 1:${s.rr.toFixed(1)}
📝 ${s.reasoning?.slice(0, 150) || "—"}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
}

/** Registration seam — the tests inject a collector instead of the tracker. */
export type TradeRegistrar = (trade: ActiveTrade) => Promise<void> | void;

// Also send individual signal alerts for each high-quality setup
export async function sendIndividualSignals(
  signals: MorningSignal[],
  sendFn: (text: string) => Promise<boolean>,
  register: TradeRegistrar = (trade) => addTrade(trade, true)
): Promise<number> {
  let sent = 0;
  for (const s of signals) {
    // 1. TYPE INTEGRITY — never announce a trade whose option type does not
    //    match its price space (e.g. a stock price used as an option premium).
    const integrity = signalIntegrityFailure(s);
    if (integrity) {
      console.log(`[MorningSignals] SKIP ${s.symbol} — ${integrity}`);
      continue;
    }

    const sig = buildSignalSignature({
      symbol: s.symbol,
      strike: s.strike,
      optionType: s.type,
      direction: s.direction,
    });
    if (isSignalAlreadySent(sig)) continue;

    // ACTIVE-TRADE LOCK: skip if already have an active trade on this underlying
    const exchange = exchangeForSignal(s);
    const existingTrade = isTradeActive(s.symbol, exchange);
    if (existingTrade) {
      console.log(`[MorningSignals] SKIP ${s.symbol} — active trade ${existingTrade.tradeId} exists (${existingTrade.strategy})`);
      continue;
    }

    const ok = await sendFn(formatPick(s));
    if (!ok) continue;

    markSignalSent(sig, s.confidence, "morning-digest");

    // 2. TRADE REGISTRATION: only for trades the TP/SL monitor can price
    //    (an option premium or an NSE cash quote). A futures/underlying trade
    //    has no LTP source → registering it would page "LTP feed unavailable"
    //    forever and hold the one-trade lock.
    if (!isRegistrable(s)) {
      console.log(
        `[MorningSignals] NOT REGISTERED ${s.symbol} — ${s.type} trade: the TP/SL monitor has no LTP source for it`
      );
      sent++;
      continue;
    }

    const tradeId = `morning-${s.symbol}-${Date.now()}`;
    await register({
      id: tradeId,
      symbol: s.symbol,
      side: s.side,
      instrument: trackerInstrument(s),
      strike: isOptionType(s.type) ? s.strike || 0 : 0,
      optionType: s.type,
      entry: s.entry,
      sl: s.stopLoss,
      tp1: s.tp1,
      tp2: s.tp2,
      status: "ACTIVE",
      sentAt: new Date().toISOString(),
      source: "morning-signal",
      confidence: s.confidence,
      expiry: isOptionType(s.type) ? s.expiry : undefined,
      exchange,
    }); // skipAlert=true — already sent above

    sent++;
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

  // Combine all signals — every branch maps through the honest type mapper
  // (CE/PE only for a real option contract, EQ for cash, FUT for underlying).
  const allSignals: MorningSignal[] = [
    ...indexSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s) => mapIndexFOSignal(s))
      .filter((s): s is MorningSignal => s !== null),
    ...stockSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s) => mapStockFOSignal(s))
      .filter((s): s is MorningSignal => s !== null),
    ...swingSignals
      .filter((s) => s.direction !== "NO_TRADE" && s.confidence >= MIN_CONFIDENCE)
      .map((s) => mapEquitySwingSignal(s)),
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
    if (isTradeActive(s.symbol, exchangeForSignal(s))) return false;
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
