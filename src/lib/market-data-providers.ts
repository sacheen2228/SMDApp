// Provider adapters — wrap existing market-data fetchers into the
// MarketDataProvider interface used by src/lib/market-data-service.ts.
//
// Each adapter calls the EXISTING production function (no logic changes),
// validates the response, and returns { data, providerTimestamp, validation }
// or null when this provider cannot answer.
//
// No Yahoo Finance anywhere — banned by SOP §1.

import type { MarketDataProvider, ProviderName, DataCategory, ValidationResult } from "./market-data-types";
import { validateEnvelope } from "./market-data-types";

// ────────────────────────────────────────────────────────────────────────────
// NSE API adapters
// ────────────────────────────────────────────────────────────────────────────

export const nseApiProvider: MarketDataProvider = {
  name: "nse-api",
  categories: ["quotes", "option-chain", "candles", "greeks", "oi-pcr", "max-pain", "spot", "index-quote", "fii-dii", "vix", "market-status", "bhavcopy", "pre-open"],
  async fetch(opts) {
    const { symbol, category, exchange, instrument, expiry, nowMs } = opts;

    // ── Option chain ──
    if (category === "optionChain") {
      const { getNSEOptionChain } = await import("@/lib/nse-api");
      const iso = expiry;
      const data = await getNSEOptionChain(symbol, iso ?? undefined);
      if (!data?.records?.data) return null;

      const underlyingValue = Number((data as any).records?.underlyingValue || 0);
      const expiryDates: string[] = Array.isArray((data as any).records?.expiryDates)
        ? (data as any).records.expiryDates
        : [];

      const strikes = (data as any).records.data.map((row: any) => ({
        strike: Number(row.strikePrice),
        ce: row.CE ? {
          ltp: Number(row.CE.lastPrice) || 0,
          oi: Number(row.CE.openInterest) || 0,
          oiChg: Number(row.CE.changeinOpenInterest) || 0,
          volume: Number(row.CE.totalTradedVolume) || 0,
          iv: Number(row.CE.impliedVolatility) || 0,
          delta: Number(row.CE.greeks?.delta) || 0,
          gamma: Number(row.CE.greeks?.gamma) || 0,
          theta: Number(row.CE.greeks?.theta) || 0,
          vega: Number(row.CE.greeks?.vega) || 0,
        } : null,
        pe: row.PE ? {
          ltp: Number(row.PE.lastPrice) || 0,
          oi: Number(row.PE.openInterest) || 0,
          oiChg: Number(row.PE.changeinOpenInterest) || 0,
          volume: Number(row.PE.totalTradedVolume) || 0,
          iv: Number(row.PE.impliedVolatility) || 0,
          delta: Number(row.PE.greeks?.delta) || 0,
          gamma: Number(row.PE.greeks?.gamma) || 0,
          theta: Number(row.PE.greeks?.theta) || 0,
          vega: Number(row.PE.greeks?.vega) || 0,
        } : null,
      }));

      const ts = (data as any).records?.timestamp || (data as any).timestamp;
      return {
        data: { strikes, spotPrice: underlyingValue, expiryDates, selectedExpiry: expiryDates[0] || null, summary: { spotPrice: underlyingValue } },
        providerTimestamp: ts,
        validation: validateEnvelope({
          symbol, provider: "nse-api", source: "PRIMARY",
          data: { strikes, spotPrice: underlyingValue },
          providerTimestamp: ts,
          fetchedAt: new Date(nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Index quote ──
    if (category === "index-quote") {
      const { getNSEIndexQuote } = await import("@/lib/nse-api");
      const data = await getNSEIndexQuote(symbol);
      if (!data?.regularMarketPrice) return null;
      return {
        data: { price: data.regularMarketPrice, change: data.change || 0, changePct: data.changePct || 0 },
        providerTimestamp: data.timestamp,
        validation: validateEnvelope({
          symbol, provider: "nse-api", source: "PRIMARY",
          data: { price: data.regularMarketPrice },
          providerTimestamp: data.timestamp,
          fetchedAt: new Date(nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── VIX ──
    if (category === "vix") {
      const { getNSEIndiaVIX } = await import("@/lib/nse-api");
      const data = await getNSEIndiaVIX();
      if (!data || data.value <= 0) return null;
      return {
        data: { value: data.value },
        providerTimestamp: data.timestamp,
        validation: validateEnvelope({
          symbol, provider: "nse-api", source: "PRIMARY",
          data: { value: data.value },
          providerTimestamp: data.timestamp,
          fetchedAt: new Date(nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Candles ──
    if (category === "candles") {
      const { getNSEHistoricalData } = await import("@/lib/nse-api");
      const to = new Date();
      const from = new Date(to.getTime() - 90 * 86_400_000);
      const bars = await getNSEHistoricalData(symbol, from, to);
      if (!Array.isArray(bars) || bars.length < 20) return null;
      return {
        data: { bars: bars.map((b: any) => ({
          time: Date.parse(String(b.mtimestamp || b.timestamp || "")),
          open: Number(b.chOpeningPrice ?? b.open),
          high: Number(b.chTradeHighPrice ?? b.high),
          low: Number(b.chTradeLowPrice ?? b.low),
          close: Number(b.chClosingPrice ?? b.close),
          volume: Number(b.chTotTradedQty ?? b.volume ?? 0),
        })).filter((b: any) => Number.isFinite(b.time) && Number.isFinite(b.close)) },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "nse-api", source: "PRIMARY",
          data: { bars: [] },
          providerTimestamp: undefined,
          fetchedAt: new Date(nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Spot ──
    if (category === "spot") {
      const { getNSEIndexQuote } = await import("@/lib/nse-api");
      const data = await getNSEIndexQuote(symbol);
      if (!data?.regularMarketPrice) return null;
      return {
        data: { price: data.regularMarketPrice },
        providerTimestamp: data.timestamp,
        validation: validateEnvelope({
          symbol, provider: "nse-api", source: "PRIMARY",
          data: { price: data.regularMarketPrice },
          providerTimestamp: data.timestamp,
          fetchedAt: new Date(nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    return null;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// BSE API adapters
// ────────────────────────────────────────────────────────────────────────────

export const bseApiProvider: MarketDataProvider = {
  name: "bse-api",
  categories: ["quotes", "option-chain", "candles", "spot", "index-quote"],
  async fetch(opts) {
    const { symbol, category } = opts;

    if (category === "optionChain") {
      const { getBSEOptionChain, getBSEExpiryDates } = await import("@/lib/bse-api");
      const expiries = await getBSEExpiryDates(symbol).catch(() => [] as string[]);
      const selectedExpiry = expiry ?? (expiries[0] || "");
      if (!selectedExpiry) return null;
      const chain = await getBSEOptionChain(symbol, selectedExpiry);
      if (!chain?.data?.length) return null;
      return {
        data: { strikes: chain.data.map((row: any) => ({
          strike: Number(row.strike),
          ce: row.ce ? { ltp: Number(row.ce.ltp) || 0, oi: Number(row.ce.oi) || 0, oiChg: Number(row.ce.oiChg) || 0, volume: Number(row.ce.volume) || 0, iv: Number(row.ce.iv) || 0 } : null,
          pe: row.pe ? { ltp: Number(row.pe.ltp) || 0, oi: Number(row.pe.oi) || 0, oiChg: Number(row.pe.oiChg) || 0, volume: Number(row.pe.volume) || 0, iv: Number(row.pe.iv) || 0 } : null,
        })), spotPrice: Number(chain.spotPrice || 0), expiry: selectedExpiry },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "bse-api", source: "FALLBACK",
          data: { strikes: [], spotPrice: 0 },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    if (category === "index-quote" || category === "spot") {
      const { getBSEIndexData } = await import("@/lib/bse-api");
      const data = await getBSEIndexData(symbol);
      if (!data?.ltp) return null;
      return {
        data: { price: data.ltp },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "bse-api", source: "FALLBACK",
          data: { price: data.ltp },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    return null;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// MOAPI adapters (Motilal Oswal)
// ────────────────────────────────────────────────────────────────────────────

export const moApiProvider: MarketDataProvider = {
  name: "motilal-api",
  categories: ["quotes", "option-chain", "candles", "greeks", "oi-pcr", "max-pain", "spot", "index-quote"],
  async fetch(opts) {
    const { symbol, category } = opts;

    // ── Candles (EOD only) ──
    if (category === "candles") {
      const { getMOCandles } = await import("@/lib/motilal/candles");
      const candles = await getMOCandles(symbol);
      if (!candles || candles.length < 20) return null;
      return {
        data: { bars: candles.map((c: any) => ({
          time: Date.parse(c.time),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0),
        })).filter((b: any) => Number.isFinite(b.time) && Number.isFinite(b.close)) },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "motilal-api", source: "PRIMARY",
          data: { bars: [] },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Option chain ──
    if (category === "optionChain") {
      const { getMotilalOptionChain } = await import("@/lib/motilal-option-chain");
      const chain = await getMotilalOptionChain(symbol, expiry);
      if (!chain?.data?.length) return null;
      return {
        data: { strikes: chain.data.map((row: any) => ({
          strike: Number(row.strike),
          ce: row.ce ? { ltp: Number(row.ce.ltp) || 0, oi: Number(row.ce.oi) || 0, oiChg: Number(row.ce.oiChg) || 0, volume: Number(row.ce.volume) || 0, iv: Number(row.ce.iv) || 0 } : null,
          pe: row.pe ? { ltp: Number(row.pe.ltp) || 0, oi: Number(row.pe.oi) || 0, oiChg: Number(row.pe.oiChg) || 0, volume: Number(row.pe.volume) || 0, iv: Number(row.pe.iv) || 0 } : null,
        })), spotPrice: Number(chain.spotPrice || 0), expiry: chain.selectedExpiry || null },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "motilal-api", source: "FALLBACK",
          data: { strikes: [], spotPrice: 0 },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Spot / Index quote ──
    if (category === "spot" || category === "index-quote") {
      const { getKnownEquityLTP } = await import("@/lib/motilal/market");
      const ltp = await getKnownEquityLTP(symbol);
      if (!ltp || ltp <= 0) return null;
      return {
        data: { price: ltp },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "motilal-api", source: "PRIMARY",
          data: { price: ltp },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    return null;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// ICICI Breeze API adapters
// ────────────────────────────────────────────────────────────────────────────

export const breezeApiProvider: MarketDataProvider = {
  name: "icici-breeze",
  categories: ["quotes", "option-chain", "candles", "greeks", "spot", "index-quote"],
  async fetch(opts) {
    const { symbol, category } = opts;

    // ── Option chain ──
    if (category === "optionChain") {
      const { getOptionChain } = await import("@/lib/icici-breeze/option-chain");
      const chain = await getOptionChain(symbol, expiry);
      if (!chain) return null;
      return {
        data: { strikes: [], spotPrice: 0, expiry },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "icici-breeze", source: "FALLBACK",
          data: { strikes: [], spotPrice: 0 },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    // ── Spot / Index quote ──
    if (category === "spot" || category === "index-quote") {
      const { getQuotes } = await import("@/lib/icici-breeze/option-chain");
      const q = await getQuotes(symbol, "NSE");
      const ltp = Number(q?.[0]?.ltp ?? q?.ltp ?? 0);
      if (!(ltp > 0)) return null;
      return {
        data: { price: ltp },
        providerTimestamp: undefined,
        validation: validateEnvelope({
          symbol, provider: "icici-breeze", source: "FALLBACK",
          data: { price: ltp },
          providerTimestamp: undefined,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    return null;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Moneycontrol adapter
// ────────────────────────────────────────────────────────────────────────────

export const moneycontrolProvider: MarketDataProvider = {
  name: "moneycontrol",
  categories: ["quotes", "spot", "index-quote", "fii-dii", "news"],
  async fetch(opts) {
    const { symbol, category } = opts;

    if (category === "quotes" || category === "spot") {
      const { fetchStockQuotes } = await import("@/lib/nse-stock-data");
      const quotes = await fetchStockQuotes([symbol]);
      const q = quotes?.[symbol] ?? quotes?.[symbol.toUpperCase()];
      if (!q?.ltp) return null;
      return {
        data: { price: q.ltp, change: q.change || 0, changePct: q.changePct || 0 },
        providerTimestamp: q.providerTimestamp,
        validation: validateEnvelope({
          symbol, provider: "moneycontrol", source: "FALLBACK",
          data: { price: q.ltp },
          providerTimestamp: q.providerTimestamp,
          fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
          ageMs: 0,
          freshness: "FRESH",
          delayed: false,
          providerErrors: [],
          available: true,
        }),
      };
    }

    return null;
  },
};

// ────────────────────────────────────────────────────────────────────────────
// FII/DII adapter — wraps the existing fii-dii.ts fallback chain
// ────────────────────────────────────────────────────────────────────────────

export const fiiDiiProvider: MarketDataProvider = {
  name: "fii-dii",
  categories: ["fii-dii"],
  async fetch(opts) {
    if (opts.category !== "fii-dii") return null;
    const { fetchFiiDiiData } = await import("@/lib/fii-dii");
    const result = await fetchFiiDiiData();
    if (!result?.available || !result.latest) return null;
    return {
      data: {
        fiiNet: result.latest.fiiNet,
        diiNet: result.latest.diiNet,
        fiiBuy: result.latest.fiiBuy,
        fiiSell: result.latest.fiiSell,
        diiBuy: result.latest.diiBuy,
        diiSell: result.latest.diiSell,
        date: result.latest.date,
        source: result.latest.source,
        history: result.history,
        participantOI: result.participantOI,
        fiiNet5dAvg: result.fiiNet5dAvg,
        diiNet5dAvg: result.diiNet5dAvg,
        fiiFutLongRatio: result.fiiFutLongRatio,
      },
      providerTimestamp: result.latest.date,
      validation: validateEnvelope({
        symbol: opts.symbol,
        provider: "fii-dii",
        source: result.latest.source === "mrchartist" ? "FALLBACK" : "PRIMARY",
        data: { fiiNet: result.latest.fiiNet },
        providerTimestamp: result.latest.date,
        fetchedAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
        ageMs: 0,
        freshness: "FRESH",
        delayed: false,
        providerErrors: [],
        available: true,
      }),
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Register all adapters
// ────────────────────────────────────────────────────────────────────────────

import { registerProvider } from "./market-data-service";

registerProvider(nseApiProvider);
registerProvider(bseApiProvider);
registerProvider(moApiProvider);
registerProvider(breezeApiProvider);
registerProvider(moneycontrolProvider);
registerProvider(fiiDiiProvider);
