// ═══════════════════════════════════════════════════════════════════
// EQUITY STRATEGY ADAPTERS — BTST & Intraday
// Both call the SAME Institutional Engine as SMC / Zero Hero. The engine
// owns price action, market structure, liquidity, risk and TP/SL. For
// equities the engine runs on a synthetic delta=1 leg so its SL/TP math
// yields PRICE levels. Each strategy keeps its NON-OVERLAPPING scoring
// (BTST 6-factor, Intraday momentum) as the strategy `gate`.
// ═══════════════════════════════════════════════════════════════════

import {
  evaluateWithStrategy,
  STRATEGY_CONFIGS,
  StrategyConfig,
  StrategyEvaluation,
  InstitutionalRequest,
} from '@/lib/institutional-tpsl';
import { BTSTStockInput, BTSTAnalysis, analyzeBTST, BTSTGrade } from '@/lib/btst-engine';
import { computeATR } from '@/lib/institutional-tpsl/volatility-engine';

// ─── BTST ────────────────────────────────────────────────────────
function btstGate(ctx: { engine: any; extras: Record<string, any> }): { pass: boolean; reasons: string[] } {
  const i = ctx.extras.input as BTSTStockInput;
  const volRatio = i.avgVolume > 0 ? i.volume / i.avgVolume : 0;
  const bullish =
    i.rsi >= 45 && i.macdHist > 0 && volRatio >= 1.3 && i.adx >= 20 &&
    i.relativeStrength > 0 && i.breadth > 0.5;
  return { pass: bullish, reasons: [bullish ? 'BTST confluence ✓ (RSI/MACD/Vol/ADX/RS/Breadth)' : 'BTST confluence ✗'] };
}

export const BTST_STRATEGY_CONFIG: StrategyConfig = { ...STRATEGY_CONFIGS.BTST, gate: btstGate };

function gradeToBTST(g: string): BTSTGrade {
  if (g === 'A+' || g === 'A') return 'A+';
  if (g === 'B') return 'B';
  if (g === 'C') return 'C';
  return 'SKIP';
}

// Engine-backed BTST. Returns the SAME BTSTAnalysis shape (analyzeBTST keeps
// the 6-factor scoring); the engine overrides entry/SL/TP + confidence/grade.
export function runBTSTWithEngine(
  input: BTSTStockInput,
  candles?: any[],
  atr?: number,
): BTSTAnalysis {
  const base = analyzeBTST(input);
  if (!candles || candles.length < 5) return base; // legacy path — no candles

  const req: InstitutionalRequest = {
    symbol: input.symbol,
    spot: input.price,
    vix: 15,
    dte: 2,
    expiryKind: 'WEEKLY',
    dayOfWeek: new Date().getDay(),
    lotSize: 1,
    candles: candles as any,
    atr: atr ?? (candles.length >= 15 ? computeATR(candles, 14) : undefined),
    chain: [],
  };

  const se = evaluateWithStrategy(req, BTST_STRATEGY_CONFIG, {
    volume: input.volume,
    avgVolume: input.avgVolume,
    input,
  });

  if (!se.eligible) {
    base.grade = 'SKIP';
    base.confidence = 0;
    base.reasons = [...base.reasons, ...se.reasons];
    return base;
  }

  base.entry = se.entry;
  base.sl = se.sl;
  base.tp1 = se.tp1;
  base.tp2 = se.tp2;
  base.tp3 = se.tp3;
  base.confidence = Math.round(se.finalScore);
  base.grade = gradeToBTST(se.grade);
  base.riskReward = Math.round(se.rr * 10) / 10;
  base.expectedRiskPct = se.entry > 0 ? Math.abs(se.entry - se.sl) / se.entry * 100 : 0;
  base.reasons = [...base.reasons, ...se.reasons];
  return base;
}

// ─── Intraday ────────────────────────────────────────────────────
function intradayGate(ctx: { engine: any; extras: Record<string, any> }): { pass: boolean; reasons: string[] } {
  const e = ctx.extras as any;
  const volRatio = e.avgVolume > 0 ? e.volume / e.avgVolume : 0;
  const ok = (e.adx ?? 0) >= 20 && (e.rsi ?? 0) >= 50 && volRatio >= 1.2;
  return { pass: ok, reasons: [ok ? 'Intraday momentum ✓ (ADX/RSI/Vol)' : 'Intraday momentum ✗'] };
}

export const INTRADAY_STRATEGY_CONFIG: StrategyConfig = { ...STRATEGY_CONFIGS.INTRADAY, gate: intradayGate };

// Engine-backed intraday evaluation for a single equity. Returns the unified
// StrategyEvaluation; the intraday scanner maps it to a StockCandidate.
export function runIntradayWithEngine(
  price: number,
  candles: any[],
  atr: number | undefined,
  extras: Record<string, any> = {},
): StrategyEvaluation {
  const req: InstitutionalRequest = {
    symbol: extras.symbol ?? 'EQ',
    spot: price,
    vix: extras.vix ?? 15,
    dte: 1,
    expiryKind: 'WEEKLY',
    dayOfWeek: new Date().getDay(),
    lotSize: extras.lotSize ?? 1,
    candles: candles as any,
    atr: atr ?? (candles.length >= 15 ? computeATR(candles, 14) : undefined),
    chain: [],
  };
  return evaluateWithStrategy(req, INTRADAY_STRATEGY_CONFIG, {
    volume: extras.volume ?? 0,
    avgVolume: extras.avgVolume ?? 1,
    ...extras,
  });
}
