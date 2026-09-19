// MTF (Multi-Timeframe) Configuration
// Indicator parameters and signal weights — change here, affects all dashboards

// ─── Indicator Parameters ──────────────────────────────────────────

export interface IndicatorParams {
  supertrend: { period: number; multiplier: number };
  rsi: { period: number; overbought: number; oversold: number };
  bollinger: { period: number; multiplier: number };
  ema: { fast: number; slow: number };
  adx: { period: number; strong: number; weak: number };
  atr: { period: number };
  vwap: { enabled: boolean };
  pivots: { lookback: number };
}

export const DEFAULT_INDICATOR_PARAMS: IndicatorParams = {
  supertrend: { period: 10, multiplier: 3.0 },
  rsi: { period: 14, overbought: 70, oversold: 30 },
  bollinger: { period: 20, multiplier: 2 },
  ema: { fast: 9, slow: 21 },
  adx: { period: 14, strong: 25, weak: 20 },
  atr: { period: 14 },
  vwap: { enabled: true },
  pivots: { lookback: 10 },
};

// ─── Signal Weights (total = 100) ─────────────────────────────────

export interface SignalWeights {
  trend15m: number;    // 15M trend filter
  supertrend5m: number; // 5M SuperTrend
  rsi: number;          // RSI (5M)
  pivot: number;        // Pivot breakout (5M)
  bollinger: number;    // Bollinger bands (5M)
  vwapVolume: number;   // VWAP + Volume (5M)
  entry3m: number;      // 3M entry confirmation
  dataQuality: number;  // Data health / freshness
}

export const DEFAULT_SIGNAL_WEIGHTS: SignalWeights = {
  trend15m: 20,
  supertrend5m: 15,
  rsi: 15,
  pivot: 15,
  bollinger: 10,
  vwapVolume: 10,
  entry3m: 10,
  dataQuality: 5,
};

// ─── MTF Engine Config ────────────────────────────────────────────

export interface MTFEngineConfig {
  indicators: IndicatorParams;
  weights: SignalWeights;
  minScore: number;          // Minimum composite score to generate signal
  minCandles: number;        // Minimum candles per TF to compute indicators
  timeframes: {
    trend: string;           // Trend filter TF (default "15m")
    signal: string;          // Primary signal TF (default "5m")
    entry: string;           // Entry timing TF (default "3m" or "5m")
  };
}

export const DEFAULT_MTF_CONFIG: MTFEngineConfig = {
  indicators: DEFAULT_INDICATOR_PARAMS,
  weights: DEFAULT_SIGNAL_WEIGHTS,
  minScore: 65,
  minCandles: 20,
  timeframes: {
    trend: "15m",
    signal: "5m",
    entry: "5m",   // Yahoo doesn't support 3m; use 5m as closest
  },
};
