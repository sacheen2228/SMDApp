// ═══════════════════════════════════════════════════════════
// Backtest Data Provider — M6 + provider-run metadata (pre-M7)
//
// Single integration point for the Backtest Engine. The strategy
// engine receives candles + option-chain from ONE interface and NEVER
// knows whether they came from:
//   • live Breeze  (LiveBreezeProvider)
//   • Market History DB (MarketHistoryProvider)
//   • Replay Engine (ReplayProvider)
//
// Every backtest execution records provider-run metadata
// (requested/resolved provider, fallback, snapshot/candle/chain
// counts, replay session ids) so each result is fully reproducible.
// The metadata is attached to the backtest report by the caller.
//
// Source selection: BACKTEST_DATA_SOURCE = live | history | replay | auto
//   default = "auto" (recorded history first, live Breeze fallback)
// ═══════════════════════════════════════════════════════════

import type { OptionChainData, OptionQuote } from "@/types";
import {
  getSessionCandles,
  getSnapshotsForSymbol,
} from "@/lib/market-history-client";
import {
  getSnapshotById,
  getSessionCandlesForReplay,
} from "@/lib/market/replay-engine";
import {
  getIntradayCandles,
  type HistoricalCandle,
  type IntradayCandleResult,
} from "@/lib/breeze-historical";
import {
  getOptionChain as liveGetOptionChain,
  getOptionChainExpiries as liveGetOptionChainExpiries,
} from "@/lib/icici-breeze/option-chain";
import type { CanonicalMarketSnapshot } from "@/lib/market/canonical";

export type BacktestDataSource = "live" | "history" | "replay" | "auto";

// Metadata recorded for every backtest execution (part of the report).
export interface BacktestProviderMeta {
  requested: BacktestDataSource;
  resolved: BacktestDataSource;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  snapshotCount: number;
  candleCount: number;
  optionChainCount: number;
  replaySessionIds: string[];
}

export function createBacktestRunMeta(
  requested: BacktestDataSource
): BacktestProviderMeta {
  return {
    requested,
    resolved: requested,
    fallbackUsed: false,
    fallbackReason: null,
    snapshotCount: 0,
    candleCount: 0,
    optionChainCount: 0,
    replaySessionIds: [],
  };
}

export interface BacktestDataProvider {
  getIntradayCandles(
    symbol: string,
    interval: "1minute" | "5minute" | "15minute",
    dateStr: string
  ): Promise<IntradayCandleResult>;
  getOptionChain(symbol: string, expiryDate: string): Promise<OptionChainData | null>;
  getOptionChainExpiries(symbol: string): Promise<string[]>;
}

// ── Shared helpers ──────────────────────────────────────────────

interface RawCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function candleToHistorical(c: RawCandle): HistoricalCandle {
  return {
    time: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
  };
}

// Reconstruct an OptionChainData from a canonical snapshot.
// The SDM consumer (sdm-oianalysis) reads ce.oi / ce.oiChg / ce.ltp /
// ce.volume / ce.iv / ce.delta / ce.theta / ce.gamma / ce.vega, while the
// backtest maps strikes via calls.find(c => c.strikePrice === strike).
// Both field sets are provided so the reconstructed quote is usable by the
// unchanged trading logic.
function buildOptionChainData(
  symbol: string,
  snap: CanonicalMarketSnapshot | null
): OptionChainData | null {
  if (!snap || !snap.optionChain || snap.optionChain.length === 0) return null;

  const calls: any[] = [];
  const puts: any[] = [];
  const strikeSet = new Set<number>();

  for (const leg of snap.optionChain) {
    const g = leg.greeks || { delta: 0, theta: 0, gamma: 0, vega: 0 };
    const quote: any = {
      symbol,
      strikePrice: leg.strike,
      expiryDate: "",
      optionType: leg.type === "CE" ? "call" : "put",
      ltp: leg.ltp ?? 0,
      bid: 0,
      ask: 0,
      volume: leg.volume ?? 0,
      openInterest: leg.oi ?? 0,
      oiChange: leg.oiChg ?? 0,
      // Fields the SDM consumer actually reads:
      oi: leg.oi ?? 0,
      oiChg: leg.oiChg ?? 0,
      iv: 0,
      delta: g.delta ?? 0,
      gamma: g.gamma ?? 0,
      theta: g.theta ?? 0,
      vega: g.vega ?? 0,
    };
    if (quote.optionType === "call") calls.push(quote);
    else puts.push(quote);
    strikeSet.add(leg.strike);
  }

  const strikes = Array.from(strikeSet).sort((a, b) => a - b);
  const atm =
    strikes.length > 0
      ? strikes.reduce(
          (best, s) =>
            Math.abs(s - snap.spot) < Math.abs(best - snap.spot) ? s : best,
          strikes[0]
        )
      : snap.spot;

  return {
    symbol,
    expiryDate: "",
    spotPrice: snap.spot,
    strikes,
    calls: calls as unknown as OptionQuote[],
    puts: puts as unknown as OptionQuote[],
    atmStrike: atm,
    timestamp: snap.timestamp,
  };
}

function latestSnapshotForDate(
  symbol: string,
  dateStr: string
): Promise<CanonicalMarketSnapshot | null> {
  return getSnapshotsForSymbol(symbol, dateStr).then((snaps) =>
    snaps.length ? snaps[snaps.length - 1] : null
  );
}

function replaySnapshotForDate(
  symbol: string,
  dateStr: string
): Promise<CanonicalMarketSnapshot | null> {
  return latestSnapshotForDate(symbol, dateStr).then(async (snap) => {
    if (!snap) return null;
    return (await getSnapshotById(`${snap.symbol}-${snap.timestamp}`)) ?? snap;
  });
}

// ── Providers (each writes into the shared run metadata) ─────────

function makeLiveProvider(meta: BacktestProviderMeta): BacktestDataProvider {
  return {
    async getIntradayCandles(symbol, interval, dateStr) {
      const res = await getIntradayCandles(symbol, dateStr, interval);
      meta.candleCount += res.candles.length;
      return res;
    },
    async getOptionChain(symbol, expiryDate) {
      const chain = await liveGetOptionChain(symbol, expiryDate);
      if (chain) meta.optionChainCount += 1;
      return chain;
    },
    async getOptionChainExpiries(symbol) {
      return liveGetOptionChainExpiries(symbol);
    },
  };
}

function makeHistoryProvider(meta: BacktestProviderMeta): BacktestDataProvider {
  return {
    async getIntradayCandles(symbol, interval, dateStr) {
      const rows = (await getSessionCandles(symbol, interval, dateStr)) as RawCandle[];
      const candles = rows.map(candleToHistorical);
      meta.candleCount += candles.length;
      return {
        candles,
        source: "history",
      } as unknown as IntradayCandleResult;
    },
    async getOptionChain(symbol, expiryDate) {
      const snap = await latestSnapshotForDate(symbol, expiryDate);
      if (snap) {
        meta.snapshotCount += 1;
        const chain = buildOptionChainData(symbol, snap);
        if (chain) meta.optionChainCount += 1;
        return chain;
      }
      return null;
    },
    async getOptionChainExpiries() {
      return [];
    },
  };
}

function makeReplayProvider(meta: BacktestProviderMeta): BacktestDataProvider {
  return {
    async getIntradayCandles(symbol, interval, dateStr) {
      const rows = (await getSessionCandlesForReplay(symbol, dateStr, interval)) as RawCandle[];
      const candles = rows.map(candleToHistorical);
      meta.candleCount += candles.length;
      return {
        candles,
        source: "replay",
      } as unknown as IntradayCandleResult;
    },
    async getOptionChain(symbol, expiryDate) {
      const snap = await replaySnapshotForDate(symbol, expiryDate);
      if (snap) {
        meta.snapshotCount += 1;
        meta.replaySessionIds.push(`${snap.symbol}-${snap.timestamp}`);
        const chain = buildOptionChainData(symbol, snap);
        if (chain) meta.optionChainCount += 1;
        return chain;
      }
      return null;
    },
    async getOptionChainExpiries() {
      return [];
    },
  };
}

function makeCompositeProvider(meta: BacktestProviderMeta): BacktestDataProvider {
  const history = makeHistoryProvider(meta);
  const live = makeLiveProvider(meta);
  return {
    async getIntradayCandles(symbol, interval, dateStr) {
      const hist = await history.getIntradayCandles(symbol, interval, dateStr);
      if (hist.candles.length > 0) return hist;
      const res = await live.getIntradayCandles(symbol, interval, dateStr);
      meta.fallbackUsed = true;
      meta.fallbackReason = `no recorded candles for ${symbol} on ${dateStr}`;
      return res;
    },
    async getOptionChain(symbol, expiryDate) {
      const hist = await history.getOptionChain(symbol, expiryDate);
      if (hist) return hist;
      const chain = await live.getOptionChain(symbol, expiryDate);
      meta.fallbackUsed = true;
      meta.fallbackReason = `no recorded option chain for ${symbol}${
        expiryDate ? " on " + expiryDate : ""
      }`;
      return chain;
    },
    async getOptionChainExpiries(symbol) {
      return live.getOptionChainExpiries(symbol);
    },
  };
}

export function getBacktestDataProvider(
  mode?: BacktestDataSource,
  meta?: BacktestProviderMeta
): BacktestDataProvider {
  const m = (mode || process.env.BACKTEST_DATA_SOURCE || "auto") as BacktestDataSource;
  const useMeta = meta ?? createBacktestRunMeta(m);
  switch (m) {
    case "live":
      return makeLiveProvider(useMeta);
    case "history":
      return makeHistoryProvider(useMeta);
    case "replay":
      return makeReplayProvider(useMeta);
    case "auto":
    default:
      return makeCompositeProvider(useMeta);
  }
}
