// Shared primitives for the Dynamic Institutional TP/SL Engine.
// Each sub-engine owns its own input/output types; this file holds only the
// common data shapes that flow between them.

export interface Candle {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type StructureClarity = 'CLEAR' | 'UNCLEAR';
export type OptionType = 'CE' | 'PE';
export type ExpiryKind = 'WEEKLY' | 'MONTHLY';
