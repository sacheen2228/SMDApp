// lib/sdmChat.ts
//
// SDM's reply logic. Called from your chat panel's send handler AND
// from the Telegram webhook, so both surfaces behave identically.

import {
  detectTradeIntent,
  generateOptionAlert,
  generateEquityAlert,
  formatAlertMessage,
  type TradeAlert,
  type OptionChainRow,
  type NewsSentiment,
} from "./tradeAlertEngine";

export interface SDMContext {
  symbol: string;         // currently selected instrument, e.g. "NIFTY 50"
  spot: number;
  pcr: number;
  vix: number;
  chain: OptionChainRow[];
  expiryLabel?: string;
  fiiNetCr?: number;
  diiNetCr?: number;
  newsSentiment: NewsSentiment;
  // For equity fallback when the user asks for a stock trade
  equityLookup?: (symbol: string) => Promise<{
    ltp: number;
    dayChangePct: number;
    avgVolRatio?: number;
    newsSentiment: NewsSentiment;
  } | null>;
}

export interface SDMReply {
  text: string;
  alert?: TradeAlert;
  language: "en" | "hi";
}

function isHindi(message: string): boolean {
  // crude Devanagari check + common romanized Hindi trading words
  return /[\u0900-\u097F]/.test(message) || /\b(kya|kaisa|batao|acha|kharido|becho)\b/i.test(message);
}

export async function handleSDMMessage(message: string, ctx: SDMContext): Promise<SDMReply> {
  const language: "en" | "hi" = isHindi(message) ? "hi" : "en";
  const intent = detectTradeIntent(message);

  if (!intent.wantsTrade) {
    return {
      language,
      text: language === "hi"
        ? "main yahan hoon! trade, signal, greeks, ya OI ke baare mein poocho — main turant bataunga."
        : "I'm here! Ask me for a trade, signal, greeks, or OI read — I'll pull it live.",
    };
  }

  // Equity request with a named symbol that isn't an index
  const indexNames = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
  if (intent.kind === "equity" && intent.symbol && !indexNames.includes(intent.symbol) && ctx.equityLookup) {
    const data = await ctx.equityLookup(intent.symbol);
    if (!data) {
      return { language, text: `Couldn't fetch live data for ${intent.symbol} right now — try again in a moment.` };
    }
    const alert = generateEquityAlert({
      symbol: intent.symbol,
      ltp: data.ltp,
      dayChangePct: data.dayChangePct,
      newsSentiment: data.newsSentiment,
      avgVolRatio: data.avgVolRatio,
    });
    if (!alert) return { language, text: `No clean setup on ${intent.symbol} right now.` };
    return { language, alert, text: formatAlertMessage(alert) };
  }

  // Default: options trade on the currently selected/detected instrument
  const alert = generateOptionAlert({
    symbol: intent.symbol ?? ctx.symbol,
    spot: ctx.spot,
    pcr: ctx.pcr,
    vix: ctx.vix,
    chain: ctx.chain,
    newsSentiment: ctx.newsSentiment,
    fiiNetCr: ctx.fiiNetCr,
    diiNetCr: ctx.diiNetCr,
    expiryLabel: ctx.expiryLabel,
  });

  if (!alert) {
    return {
      language,
      text: language === "hi"
        ? "abhi option chain data available nahi hai, thodi der mein try karo."
        : "Option chain data isn't available right now — try again shortly.",
    };
  }

  const text = language === "hi"
    ? `yeh raha aapka trade:\n\n${formatAlertMessage(alert)}`
    : `Here's your trade:\n\n${formatAlertMessage(alert)}`;

  return { language, alert, text };
}
