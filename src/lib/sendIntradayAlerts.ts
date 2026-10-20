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
import { ALL_SYMBOLS } from "./stockUniverse";
import { getNextMonthlyExpiry } from "./expiry-calculator";
import {
  checkSLTP, addTrade, formatSLTPHit,
  hasActiveTrade, tickPx, fmtStrike
} from "./activeTradeTracker";
import { registerAgent, getAgentByName, createSignal } from "@/lib/agents/registry";
import { transitionSignal } from "@/lib/agents/signal-lifecycle";

const BASE = process.env.INTERNAL_API_BASE || "http://localhost:3000";

const DIGEST_CHAT_IDS = (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
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
    const rr = alert.rrGate || 1;
    if (conf < 0.6 || rr < 1.5) return;

    candidates.push({ symbol: sym, alert });
  } catch {
    // skip if sdm-signal fails
  }
}

// Price fetcher for SL/TP checking — fetches live option price
/**
 * The LIVE premium of the exact contract that was opened.
 *
 * Fail closed on anything that is not that contract's premium:
 *   • a chain for a DIFFERENT expiry is a different contract (its premium would
 *     silently move the stop/TP of this trade),
 *   • a premium worth more than its underlying is not a premium (that is the
 *     underlying itself leaking into the option price).
 */
export async function getCurrentOptionPrice(
  symbol: string,
  strike: number,
  optionType: string,
  expiry?: string
): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${BASE}/api/option-chain?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return 0;
    const json = await res.json();
    const data = json?.data?.data || [];

    // The chain must be the expiry we opened (when both are known).
    const chainExpiry = json?.data?.expiry || json?.data?.selectedExpiry || "";
    const wantExpiry = expiryKey(expiry);
    const haveExpiry = expiryKey(chainExpiry);
    if (wantExpiry && haveExpiry && wantExpiry !== haveExpiry) {
      console.warn(`[sendIntradayAlerts] ${symbol} chain expiry ${chainExpiry} ≠ trade expiry ${expiry} — no LTP`);
      return 0;
    }

    const row = data.find((r: any) => Number(r.strike) === Number(strike));
    if (!row) return 0;
    const side = optionType === "CE" ? row.ce : row.pe;
    const ltp = Number(side?.ltp || 0);
    if (!(ltp > 0)) return 0;

    // An option can never be worth more than its underlying. If the feed hands
    // back the spot, it is not a premium → fail closed.
    const spot = Number(json?.data?.spotPrice || 0);
    if (spot > 0 && ltp >= spot) {
      console.warn(`[sendIntradayAlerts] ${symbol} ${strike} ${optionType} ltp ${ltp} ≥ spot ${spot} — not a premium, ignoring`);
      return 0;
    }
    return ltp;
  } catch {
    return 0;
  }
}

/** Normalise an expiry label to YYYY-MM-DD ("27-Oct-2026" → "2026-10-27"). */
export function expiryKey(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = months[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function sdmSignalToAlert(symbol: string, signal: any): any {
  const isCall = signal.direction === "CALL";
  if (signal.direction !== "CALL" && signal.direction !== "PUT") return null;
  if (!signal.entry || signal.entry <= 0) return null;
  if (!signal.strike || signal.strike <= 0) return null;
  // FAIL CLOSED on a plan that cannot be monitored: no stop / no target means
  // the trade would sit open forever (and the alert would print "₹undefined").
  if (!signal.sl || signal.sl <= 0) return null;
  if (!signal.tp1 || signal.tp1 <= 0) return null;
  // The stop must be on the correct side of the entry for a BUY.
  if (signal.sl >= signal.entry) return null;
  // An option premium can never be worth more than its underlying — that is
  // the underlying leaking into the option price.
  const spot = Number(signal?.marketContext?.spot || 0);
  if (spot > 0 && signal.entry >= spot) return null;

  const optionType = isCall ? "CE" : "PE";
  // The gate keeps the engine's own R:R bucket (unchanged behaviour); the
  // DISPLAYED R:R is computed from the entry/stop/TP1 the alert actually shows,
  // so the number and the levels can never disagree.
  const rrGate = signal.riskReward > 3 ? 4 : signal.riskReward > 2 ? 3 : signal.riskReward > 1 ? 2 : 1;
  const long = signal.tp1 > signal.entry;
  const risk = long ? signal.entry - signal.sl : signal.sl - signal.entry;
  const reward = long ? signal.tp1 - signal.entry : signal.entry - signal.tp1;
  const rr = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;

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
    rrGate,
    confidence: Math.round(signal.confidence || 50),
    rationale: reasons + extra || "SDM V2 engine recommendation",
    expiry: expiryLabel,
    generatedAt: new Date().toISOString(),
    greeks: signal.greeks || null,
    dataSource: signal?.dataHealth?.source || signal?.source || "unknown",
  };
}

function formatSDMMessage(alert: any): string {
  const isCall = alert.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  const direction = isCall ? "Bullish" : "Bearish";
  const pnlRisk = alert.entry > 0 ? Math.abs((alert.entry - alert.sl) / alert.entry * 100).toFixed(1) : "—";
  const pnlReward = alert.entry > 0 ? Math.abs((alert.tp1 - alert.entry) / alert.entry * 100).toFixed(1) : "—";

  // Greeks section
  const g = alert.greeks;
  const greeksLine = g && (g.delta || g.gamma || g.theta || g.vega)
    ? `\nΔ ${g.delta?.toFixed(2) || "—"} · Γ ${g.gamma?.toFixed(4) || "—"} · Θ ${g.theta?.toFixed(2) || "—"} · ν ${g.vega?.toFixed(2) || "—"} · IV ${g.iv?.toFixed(1) || "—"}%`
    : "";

  return `⚡ SDM Signal — ${alert.symbol}

${emoji} ${alert.side} ${alert.instrument}
${direction} | Confidence: ${alert.confidence}%

Strike: ${fmtStrike(alert.strike)} ${alert.optionType} ${alert.expiry ? `| ${alert.expiry}` : ""}
Entry: ₹${tickPx(alert.entry)}
Stop: ₹${tickPx(alert.sl)} (${pnlRisk}% risk)
Target 1: ₹${tickPx(alert.tp1)} (${pnlReward}% gain)
Target 2: ₹${tickPx(alert.tp2)}
R:R 1:${alert.rr}${greeksLine}

${alert.rationale}
📡 Data: SDM V2 · ${alert.dataSource || "unknown"}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`;
}

/** Age of a chain in minutes (null when unknown). */
export function chainAgeMinutes(chainAsOf?: string): number | null {
  if (!chainAsOf) return null;
  const t = Date.parse(chainAsOf);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

/** A plan built on a chain older than this is not a trade (fail closed). */
export function isChainFresh(chainAsOf?: string, maxMinutes = 15): boolean {
  const age = chainAgeMinutes(chainAsOf);
  if (age == null) return true;         // unknown age → not provably stale
  return age <= maxMinutes;
}

export async function sendIntradayAlerts(): Promise<{ ran: boolean; newAlerts: number }> {
  if (!isTelegramSendWindow()) {
      console.error("[sendIntradayAlerts] outside 09:10-15:30 IST window — skipping");
    return { ran: false, newAlerts: 0 };
  }
  if (DIGEST_CHAT_IDS.length === 0) {
    console.error("[sendIntradayAlerts] TELEGRAM_DIGEST_CHAT_IDS not set — nowhere to send");
    return { ran: false, newAlerts: 0 };
  }

  // 1. Check active trades for SL/TP hits
  const { hitSL, hitTP1, hitTP2, hitTP3 } = await checkSLTP(
    (sym, strike, type, expiry) => getCurrentOptionPrice(sym, strike, type, expiry)
  );

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
        }, true); // skipAlert=true — SDM message already sent above
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

        // Record in Agent Signal Lifecycle
        try {
          let sdmAgent = getAgentByName('SDM_ENGINE');
          if (!sdmAgent) {
            sdmAgent = registerAgent({
              name: 'SDM_ENGINE',
              type: 'SMDAPP_ENGINE',
              version: '2.0',
              description: 'SDM V2 Scoring Engine',
            });
          }
          const optionType = (c.alert.optionType as 'CE' | 'PE') || 'CE';
          const signal = createSignal({
            agentId: sdmAgent.id,
            market: 'INDIA',
            exchange: 'NFO',
            underlying: c.symbol,
            signalType: 'FINAL',
            direction: optionType === 'CE' ? 'BUY_CE' : 'BUY_PE',
            optionType,
            strike: c.alert.strike || undefined,
            entryPrice: c.alert.entry,
            stopLoss: c.alert.sl,
            target1: c.alert.tp1,
            target2: c.alert.tp2,
            confidence: (c.alert.confidence || 0) / 100,
            thesis: c.alert.rationale || 'SDM V2 signal',
            evidence: {},
            dataSource: 'SDM_V2',
            dataFreshness: 'LIVE',
          });
          transitionSignal(signal.id, 'CANDIDATE');
          transitionSignal(signal.id, 'VALIDATING');
          transitionSignal(signal.id, 'VALIDATED');
          transitionSignal(signal.id, 'FINAL');
          transitionSignal(signal.id, 'ACTIVE');
        } catch {
          // Non-critical
        }

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
          (s: any) => s.monthlyOptionTrade && s.totalScore >= 60
        );

        for (const stock of highConfStocks) {
          const opt = stock.monthlyOptionTrade;
          // Fail closed on a stale chain: a plan built on an old premium is not a
          // trade. (The chain age is what "which data?" means in practice.)
          const chainAgeMin = chainAgeMinutes((opt as any)?.chainAsOf);
          if (!isChainFresh((opt as any)?.chainAsOf)) {
            console.warn(`[sendIntradayAlerts] skip ${stock.symbol} — chain ${chainAgeMin!.toFixed(0)}m old`);
            continue;
          }
          // Fail closed on an implausible plan: the premium must be a real
          // option premium (never the underlying's price) and the stop must sit
          // on the correct side of the entry.
          if (!isPlausibleOptionPlan(stock, opt)) {
            console.warn(`[sendIntradayAlerts] skip ${stock.symbol} — implausible option plan (premium ₹${opt?.premium} / stop ₹${opt?.stopLoss})`);
            continue;
          }
          const sig = `${stock.symbol}|${opt.strike}|${opt.optionType}|BUY|stock-scanner`;
          if (alreadySentToday(sig)) continue;

          const chainSrc = (opt as any)?.chainSource || scanData?.dataSources?.chain;
          const chainAge = (opt as any)?.chainAsOf
            ? ` (${Math.max(0, Math.round((Date.now() - Date.parse((opt as any).chainAsOf)) / 60000))}m ago)`
            : "";
          const text = formatStockOptionAlert(stock, opt, {
            ...(scanData?.dataSources || {}),
            chain: chainSrc ? `${chainSrc}${chainAge}` : undefined,
          });
          const results = await Promise.all(
            DIGEST_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, text))
          );

          if (results.some(Boolean)) {
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
              expiry: expiryKey(opt.expiry) || undefined,
            }, true); // skipAlert=true — stock alert already sent above
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
              tp3: opt.targets[2] || opt.targets[1] || opt.targets[0] || opt.premium,
              confidence: stock.totalScore,
              reason: (stock.reasons || []).slice(0, 3).join(" · "),
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

/** One line that says exactly where the numbers came from. */
function describeSources(sources?: { daily?: string; intraday?: string; quotes?: string; chain?: string }): string {
  if (!sources) return "scanner (source label unavailable)";
  const parts: string[] = [];
  if (sources.quotes) parts.push(`quotes ${sources.quotes}`);
  if (sources.daily) parts.push(`daily ${sources.daily}`);
  if (sources.intraday && sources.intraday !== "none") parts.push(`5m ${sources.intraday}`);
  if (sources.intraday === "none") parts.push("5m UNAVAILABLE (no intraday feed)");
  if (sources.chain) parts.push(`chain ${sources.chain}`);
  else parts.push("chain UNKNOWN");
  return parts.join(" · ") || "scanner";
}

/**
 * Fail closed on a plan that is not a trade:
 *   • the premium must be a real option premium — an option can never be worth
 *     more than its underlying, so a premium ≥ the underlying's price is the
 *     underlying leaking into the option price (the live "BHARTIARTL — PE /
 *     Strike 1875.2 / Entry ₹1875.20" contract that never existed),
 *   • the stop must sit on the opposite side of the entry from the target,
 *   • every level must be present.
 */
export function isPlausibleOptionPlan(stock: any, opt: any): boolean {
  const premium = Number(opt?.premium);
  const sl = Number(opt?.stopLoss);
  const tp1 = Number(opt?.targets?.[0]);
  if (!(premium > 0) || !(sl > 0) || !(tp1 > 0)) return false;
  if (tp1 === premium) return false;

  // The underlying's price, when the scanner knows it.
  const underlying = Number(stock?.currentPrice);
  if (underlying > 0 && premium >= underlying) return false;

  // The stop must be on the opposite side of the entry from the target.
  const long = tp1 > premium;
  if (long ? !(sl < premium) : !(sl > premium)) return false;
  return true;
}

export function formatStockOptionAlert(stock: any, opt: any, sources?: { daily?: string; intraday?: string; quotes?: string; chain?: string }): string {
  const isCall = opt.optionType === "CE";
  const emoji = isCall ? "🟢" : "🔴";
  // R:R must come from the OPTION's own plan (entry / stop / TP1) — the
  // underlying stock's riskReward is a different instrument's number and
  // produced values like "1:39.4" and "1:0.8" for the same 1:2 option plan.
  // The side comes from the plan GEOMETRY (a bought PE has its stop BELOW the
  // entry, a mirrored bearish PE has it ABOVE) — the option letter lies.
  const premium = Number(opt.premium);
  const stopLoss = Number(opt.stopLoss);
  const tp1 = Number(opt.targets?.[0] ?? premium);
  const long = tp1 > premium;
  const risk = long ? premium - stopLoss : stopLoss - premium;
  const reward = long ? tp1 - premium : premium - tp1;
  const rr = risk > 0 ? `1:${(reward / risk).toFixed(1)}` : "—";
  const reasons = (stock.reasons || []).slice(0, 3).join(" · ") || "Scanner pick";
  const direction = isCall ? "Bullish" : "Bearish";
  const targets = (opt.targets || []).map((t: number, i: number) => `T${i + 1} ₹${tickPx(t)}`).join(" | ");

  return `📊 STOCK OPTION — ${stock.symbol}

${emoji} BUY ${opt.optionType} | ${stock.symbol} ${fmtStrike(opt.strike)}

📅 Monthly Expiry: ${opt.expiryLabel}
💰 Premium: ₹${tickPx(premium)}
🛑 Stop Loss: ₹${tickPx(stopLoss)}
🎯 ${targets}
📐 R:R ${rr}
⭐ Confidence: ${stock.totalScore}%
📈 ${direction} | ${reasons}
📡 Data: ${describeSources(sources)}

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
`.trim();
}
