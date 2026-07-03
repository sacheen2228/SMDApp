// SDM Normal Mode Component
// Swing trading UI for non-expiry days with market context and watchlist

import type { SDMRecommendation } from "@/types/sdm";
import { Badge } from "@/components/ui/badge";
import { SDMWatchList } from "./SDMWatchList";

interface SDMNormalModeProps {
  recommendation: SDMRecommendation;
}

export function SDMNormalMode({ recommendation }: SDMNormalModeProps) {
  const {
    direction,
    strike,
    strikeType,
    entry,
    tp1,
    tp2,
    tp3,
    sl,
    confidence,
    riskReward,
    daysToExpiry,
    sellerSLZone,
    marketContext,
    watchList,
    whyThisTrade,
    timeSensitiveNote,
    tradeGrade,
    dataHealth,
    smartEntry,
    smartExit,
    probabilities,
    marketRegime,
    premiumFairValue,
    positionSizing,
    smartEntryResult,
    smartExitResult,
    marketStructure,
    qualityScore,
  } = recommendation;

  const getDirectionDisplay = () => {
    switch (direction) {
      case "CALL":
        return { text: "▶ BUY CALL", color: "text-emerald-400" };
      case "PUT":
        return { text: "▼ BUY PUT", color: "text-red-400" };
      case "SELL_CALL":
        return { text: "◀ SELL CALL", color: "text-blue-400" };
      case "SELL_PUT":
        return { text: "▲ SELL PUT", color: "text-purple-400" };
      default:
        return { text: "⏸ WAIT", color: "text-gray-400" };
    }
  };

  const dirDisplay = getDirectionDisplay();
  const isCE = direction.includes("CALL");

  const getTrendIcon = () => {
    switch (marketContext.trend) {
      case "bullish":
        return <span className="text-emerald-400">↑ Bullish</span>;
      case "bearish":
        return <span className="text-red-400">↓ Bearish</span>;
      default:
        return <span className="text-gray-400">→ Sideways</span>;
    }
  };

  const getPcrLabel = () => {
    if (marketContext.pcr > 1.3) return "Heavily Bullish";
    if (marketContext.pcr > 1.1) return "Slightly Bullish";
    if (marketContext.pcr < 0.7) return "Heavily Bearish";
    if (marketContext.pcr < 0.9) return "Slightly Bearish";
    return "Neutral";
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[9px]">
          📅 NORMAL DAY
        </Badge>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          dataHealth.status === "LIVE" ? "bg-emerald-400" :
          dataHealth.status === "STALE" ? "bg-amber-400" :
          "bg-red-400"
        }`} title={`Data: ${dataHealth.status} (${dataHealth.score}/100)`} />
        <span className="text-[9px] text-gray-400">
          {daysToExpiry} days to expiry
        </span>
        <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 text-[9px]">
          🧊 SWING MODE
        </Badge>
        <Badge className={`text-[9px] ${
          tradeGrade.startsWith("A") ? "bg-emerald-500/20 text-emerald-400" :
          tradeGrade === "B" ? "bg-yellow-500/20 text-yellow-400" :
          "bg-gray-500/20 text-gray-400"
        }`}>
          Grade: {tradeGrade}
        </Badge>
        <Badge className="text-[9px] bg-gray-500/20 text-gray-400">
          Regime: {marketRegime.replace(/_/g, " ")}
        </Badge>
      </div>

      {/* Main Signal Card */}
      {direction !== "WAIT" && (
        <div className="bg-white/5 rounded-lg p-3 border border-white/10">
          <div className={`text-lg font-bold ${dirDisplay.color}`}>
            {dirDisplay.text}
          </div>
          <div className="text-sm text-gray-300 mt-1">
            NIFTY {strike} {isCE ? "CE" : "PE"} ({strikeType})
          </div>
          <div className="flex gap-4 mt-2 text-[11px]">
            <span className="text-gray-400">
              Entry: <span className="text-white">₹{entry.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP1: <span className="text-white">₹{tp1.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP2: <span className="text-white">₹{tp2.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP3: <span className="text-white">₹{tp3.toFixed(1)}</span>
            </span>
            <span className="text-red-400">
              SL: <span className="text-white">₹{sl.toFixed(1)}</span>
            </span>
          </div>
          <div className="flex gap-4 mt-1 text-[10px]">
            <span className="text-gray-400">
              R:R 1:{riskReward.toFixed(1)}
            </span>
            <span className="text-gray-400">
              Confidence: {confidence.toFixed(1)}%
            </span>
            <span className="text-gray-400">
              P(TP1): {probabilities.tp1}% | P(TP2): {probabilities.tp2}% | P(SL): {probabilities.sl}%
            </span>
          </div>
          <div className="flex gap-4 mt-1 text-[10px]">
            <span className="text-gray-400">
              Entry: <span className={smartEntry === "ENTER_NOW" ? "text-emerald-400" : "text-yellow-400"}>{smartEntry.replace(/_/g, " ")}</span>
            </span>
            <span className="text-gray-400">
              Exit: <span className={smartExit === "HOLD" ? "text-emerald-400" : "text-yellow-400"}>{smartExit.replace(/_/g, " ")}</span>
            </span>
          </div>
          <div className="mt-2 text-[10px] text-blue-400">
            💡 {timeSensitiveNote}
          </div>
        </div>
      )}

      {/* Market Context */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">
          Market Context
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Spot</div>
            <div className="text-[11px] text-white font-medium">
              {marketContext.spot.toFixed(0)}
            </div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">PCR</div>
            <div className="text-[11px] text-white font-medium">
              {marketContext.pcr.toFixed(2)}
            </div>
            <div className="text-[8px] text-gray-400">{getPcrLabel()}</div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Max Pain</div>
            <div className="text-[11px] text-white font-medium">
              {marketContext.maxPain}
            </div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">VIX</div>
            <div className="text-[11px] text-white font-medium">
              {marketContext.vix > 0 ? marketContext.vix.toFixed(1) : "—"}
            </div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Trend</div>
            <div className="text-[11px]">{getTrendIcon()}</div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Bias</div>
            <div className="text-[11px] text-white font-medium">
              {marketContext.spot > marketContext.maxPain ? "↑ Above" : "↓ Below"}
            </div>
          </div>
        </div>
      </div>

      {/* Premium Fair Value */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">
          Premium Fair Value
        </div>
        <div className="bg-white/5 rounded p-2">
          <div className="flex justify-between text-[10px]">
            <span className="text-gray-400">Status:</span>
            <span className={premiumFairValue.status === "undervalued" ? "text-emerald-400" : premiumFairValue.status === "overpriced" ? "text-red-400" : "text-gray-400"}>
              {premiumFairValue.status.toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-gray-400">Difference:</span>
            <span className="text-white">{premiumFairValue.differencePercent.toFixed(1)}%</span>
          </div>
          <div className="text-[9px] text-gray-400 mt-1">{premiumFairValue.reason}</div>
        </div>
      </div>

      {/* Position Sizing */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">
          Position Sizing (1% Risk)
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Lots</div>
            <div className="text-[11px] text-white font-medium">{positionSizing.lots}</div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Quantity</div>
            <div className="text-[11px] text-white font-medium">{positionSizing.quantity}</div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Risk</div>
            <div className="text-[11px] text-white font-medium">₹{positionSizing.riskAmount.toFixed(0)}</div>
          </div>
          <div className="bg-white/5 rounded p-2 text-center">
            <div className="text-[8px] text-gray-500">Max Loss</div>
            <div className="text-[11px] text-white font-medium">₹{positionSizing.maxLoss.toFixed(0)}</div>
          </div>
        </div>
      </div>

      {/* Smart Entry / Exit Actions */}
      {direction !== "WAIT" && (
        <div className="space-y-1.5">
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Smart Actions
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-white/5 rounded p-2">
              <div className="text-[8px] text-gray-500">Entry Action</div>
              <div className={`text-[11px] font-medium ${
                smartEntry === "ENTER_NOW" ? "text-emerald-400" : "text-yellow-400"
              }`}>
                {smartEntry.replace(/_/g, " ")}
              </div>
              {smartEntryResult && (
                <div className="text-[8px] text-gray-400 mt-0.5">{smartEntryResult.reason}</div>
              )}
              {smartEntryResult && (
                <div className="text-[8px] text-gray-500 mt-px">
                  Price: {smartEntryResult.currentPrice} | Ref: {smartEntryResult.referenceLevel} | ATR: {smartEntryResult.atr.toFixed(1)}
                </div>
              )}
            </div>
            {smartExit !== "HOLD" && (
              <div className="bg-white/5 rounded p-2">
                <div className="text-[8px] text-gray-500">Exit Action</div>
                <div className="text-[11px] font-medium text-yellow-400">
                  {smartExit.replace(/_/g, " ")}
                </div>
                {smartExitResult && (
                  <div className="text-[8px] text-gray-400 mt-0.5">{smartExitResult.reason}</div>
                )}
                {smartExitResult && (
                  <div className="text-[8px] text-gray-500 mt-px">
                    PnL: {smartExitResult.unrealizedPnLPercent.toFixed(1)}% | T{smartExitResult.targetHit}
                    {smartExitResult.gexRegimeFlipped ? " | GEX Flip" : ""}
                    {smartExitResult.structureReversal ? " | Rev" : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Market Structure */}
      {marketStructure && (
        <div className="space-y-1.5">
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Market Structure
          </div>
          <div className="bg-white/5 rounded p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-medium ${
                marketStructure.trend === "UPTREND" ? "text-emerald-400" :
                marketStructure.trend === "DOWNTREND" ? "text-red-400" :
                "text-gray-400"
              }`}>
                {marketStructure.trend === "UPTREND" ? "↑" : marketStructure.trend === "DOWNTREND" ? "↓" : "→"} {marketStructure.trend}
              </span>
              <span className="text-[9px] text-gray-500">
                SH: {marketStructure.lastSwingHigh} | SL: {marketStructure.lastSwingLow}
              </span>
            </div>
            {marketStructure.structureEvent && (
              <div className="flex items-center gap-2 mt-1">
                <Badge className={`text-[9px] ${
                  marketStructure.structureEvent.type === "BOS"
                    ? marketStructure.structureEvent.direction === "BULLISH"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                    : marketStructure.structureEvent.direction === "BULLISH"
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-orange-500/20 text-orange-400"
                }`}>
                  {marketStructure.structureEvent.type}
                </Badge>
                <span className={`text-[9px] ${
                  marketStructure.structureEvent.direction === "BULLISH" ? "text-emerald-400" : "text-red-400"
                }`}>
                  {marketStructure.structureEvent.direction === "BULLISH" ? "↑" : "↓"} @ {marketStructure.structureEvent.price}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quality Score Breakdown */}
      {qualityScore && qualityScore.factors.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Quality Score ({qualityScore.overall} — Grade {qualityScore.grade})
          </div>
          <div className="space-y-1">
            {qualityScore.factors.map((factor) => (
              <div key={factor.name} className="flex items-center gap-2">
                <span className="text-[9px] text-gray-400 w-24 truncate">
                  {factor.name}
                </span>
                <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      factor.score >= 70 ? "bg-emerald-500" :
                      factor.score >= 50 ? "bg-yellow-500" :
                      "bg-red-500"
                    }`}
                    style={{ width: `${factor.score}%` }}
                  />
                </div>
                <span className={`text-[9px] w-6 text-right font-mono ${
                  factor.score >= 60 ? "text-emerald-400" :
                  factor.score >= 40 ? "text-yellow-400" :
                  "text-red-400"
                }`}>
                  {factor.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Health */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">
          Data Health
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <Badge className={`text-[9px] ${
            dataHealth.status === "LIVE" ? "bg-emerald-500/20 text-emerald-400" :
            dataHealth.status === "STALE" ? "bg-yellow-500/20 text-yellow-400" :
            "bg-red-500/20 text-red-400"
          }`}>
            {dataHealth.status}
          </Badge>
          <span className="text-gray-400">Score: {dataHealth.score}/100</span>
          <span className="text-gray-400">Latency: {dataHealth.latency}ms</span>
          <span className="text-gray-400">Source: {dataHealth.source}</span>
        </div>
      </div>

      {/* Why This Trade */}
      {whyThisTrade.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Signal Analysis
          </div>
          {whyThisTrade.slice(0, 6).map((item, i) => (
            <div
              key={i}
              className={`text-[9px] ${
                item.type === "positive"
                  ? "text-emerald-400"
                  : item.type === "warning"
                    ? "text-amber-400"
                    : "text-red-400"
              }`}
            >
              <div className="flex items-start gap-1">
                <span className="mt-px flex-shrink-0">
                  {item.type === "positive"
                    ? "✅"
                    : item.type === "warning"
                      ? "⚠️"
                      : "❌"}
                </span>
                <div>
                  <span className="font-medium">{item.label || item.signal}</span>
                  {item.detail && (
                    <div className="text-[8px] opacity-70 mt-px">{item.detail}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Seller SL Zone Visual */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-gray-400 uppercase tracking-wider">
          Seller SL Zone
        </div>
        <div className="flex items-center gap-1 text-[9px]">
          <span className="text-blue-400 w-20 text-right">
            PE SL: {sellerSLZone.peSellerSL}
          </span>
          <div className="flex-1 h-px bg-gray-600 relative mx-1">
            <div
              className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white"
              style={{
                left: `${Math.min(95, Math.max(5, ((marketContext.spot - sellerSLZone.peSellerSL) / (sellerSLZone.ceSellerSL - sellerSLZone.peSellerSL)) * 100))}%`,
              }}
            />
            {direction !== "WAIT" && (
              <div
                className={`absolute top-1/2 -translate-y-1/2 h-1 rounded ${
                  isCE ? "bg-emerald-500" : "bg-red-500"
                }`}
                style={{
                  left: isCE
                    ? `${Math.min(90, ((marketContext.spot - sellerSLZone.peSellerSL) / (sellerSLZone.ceSellerSL - sellerSLZone.peSellerSL)) * 100)}%`
                    : "5%",
                  right: isCE
                    ? "5%"
                    : `${Math.min(90, 100 - ((marketContext.spot - sellerSLZone.peSellerSL) / (sellerSLZone.ceSellerSL - sellerSLZone.peSellerSL)) * 100)}%`,
                }}
              />
            )}
          </div>
          <span className="text-red-400 w-20">
            CE SL: {sellerSLZone.ceSellerSL}
          </span>
        </div>
        <div className="text-center text-[10px] text-gray-300">
          ● SPOT {marketContext.spot.toFixed(0)}
        </div>
        {sellerSLZone.sellerExhaustion && (
          <div className="text-center">
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] animate-pulse">
              ⚡ SELLER PANIC
            </Badge>
          </div>
        )}
      </div>

      {/* Watchlist (when waiting) */}
      {direction === "WAIT" && watchList.length > 0 && (
        <SDMWatchList items={watchList} />
      )}

      {/* Normal Day Rules */}
      {direction !== "WAIT" && (
        <div className="space-y-1 text-[9px] text-gray-500">
          <div className="text-[9px] text-gray-400 uppercase tracking-wider">
            Rules
          </div>
          <div>• No time pressure — hold for structure</div>
          <div>
            • Target: Seller SL zone (
            {isCE ? sellerSLZone.ceSellerSL : sellerSLZone.peSellerSL})
          </div>
          <div>• SL: ₹{sl.toFixed(1)}</div>
          <div>• Re-evaluate after each 5-min candle close</div>
          <div>• If confidence drops below 50% → exit</div>
        </div>
      )}
    </div>
  );
}
