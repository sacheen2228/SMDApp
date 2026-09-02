// ═══════════════════════════════════════════════════════════════════════════
// Trade Intelligence — Export All
// ═══════════════════════════════════════════════════════════════════════════

export {
  buildMarketIntelligenceContext,
  getCachedContext,
  invalidateContext,
  type MarketIntelligenceContext,
} from "./market-context";

export {
  analyzeIndexFO,
  type IndexFOSignal,
  type IndexTradeDirection,
} from "./index-fo-mode";

export {
  analyzeStockFO,
  type StockFOSignal,
  type StockTradeDirection,
} from "./stock-fo-mode";

export {
  analyzeEquitySwing,
  type EquitySwingSignal,
  type SwingDirection,
} from "./equity-swing-mode";

export {
  buildUnifiedRanking,
  type UnifiedRankingResult,
  type UnifiedTradeSetup,
  type TradeMode,
  type ConvictionBand,
} from "./unified-ranking";

export {
  registerTrade,
  updateTrade,
  getActiveTrades,
  getTrade,
  getAllTrades,
  cleanupTrades,
  getTrackingStats,
  type TrackedTrade,
  type TradeStage,
} from "./trade-tracker";
