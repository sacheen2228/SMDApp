// quant-config.ts — single source of truth for the UNIVERSAL_QUANT_V1 engine.
//
// ISOLATION: this engine is a standalone paper-trading quant namespace. It
// never places broker orders, never reuses another engine's senders or
// config, and never inherits another strategy's behaviour. Everything
// tunable lives here. `enabled` defaults OFF (env QUANT_ENABLED=1 to arm).

export const QUANT_FLAGS = {
  enabled: process.env.QUANT_ENABLED === "1", // default OFF
  mode: (process.env.QUANT_MODE === "PAPER" ? "PAPER" : "SHADOW") as "SHADOW" | "PAPER", // default SHADOW
  minRewardRisk: 1.5,
  perTradeRiskPct: 2, // % of paper capital risked per trade (rupee risk model)
  dailyLossCapPct: 6,
  // Trade-count / concurrency caps are OFF by default (null = unlimited):
  // the engine gates on QUALITY (score, R:R, chain confirmation), not on
  // quantity. Set a number to reinstate a cap.
  maxConcurrentPositions: null as number | null,
  maxTradesPerDay: null as number | null,
  cooldownMinutesAfterLoss: 30,
  chainFreshnessMaxMs: 120_000, // option chain max age
  // Breeze publishes its 5m bar ~2 bars late (measured live 2026-10-26: last
  // bar 9-10 min old while the market ticks). A 5-min window classified the
  // ONLY real OHLC source as permanently STALE, so the engine could never
  // trade NIFTY. 15 min still rejects a dead feed (the chain re-fetches every
  // tick) while accepting Breeze's real-but-delayed OHLC. Entries still fill
  // at LIVE LTP; only the feature series lags.
  candleFreshnessMaxMs: 900_000,
  ltpFreshnessMaxMs: 60_000,
  minChainLiquidityOi: 500, // min OI on selected strike leg
  maxSpreadPctOfPremium: 0.25, // (ask-bid)/mid max for option entry
  minPremium: 8, // absolute floor — below this = lottery, reject
  maxPremiumPctOfSpot: 0.05,
  defaultPaperCapital: null as number | null, // NEVER assume — set via API/config; null → DATA_BLOCKED
  tickUrl: "/api/quant/tick",
} as const;

export type QuantMode = "SHADOW" | "PAPER";

export const QUANT_STRATEGIES = [
  "TREND_CONTINUATION",
  "BREAKOUT_RETEST",
  "MEAN_REVERSION",
  "EXPIRY_MOMENTUM",
] as const;

export type QuantStrategy = (typeof QUANT_STRATEGIES)[number];

export type Regime =
  | "TRENDING_UP"
  | "TRENDING_DOWN"
  | "RANGE_BOUND"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "BREAKOUT"
  | "EXPIRY_VOLATILE"
  | "UNCERTAIN";

/** Optional Telegram override for quant alerts; undefined → not configured (shared default chat is used only if configured upstream). */
export function quantTelegramChatId(): string | undefined {
  const v = process.env.QUANT_TELEGRAM_CHAT_ID;
  return v && v.trim() ? v.trim() : undefined;
}
