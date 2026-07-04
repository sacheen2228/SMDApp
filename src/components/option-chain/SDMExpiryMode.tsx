// SDM Expiry Mode Component
// Scalper UI for expiry days with gamma/theta/danger windows

import type { SDMRecommendation } from "@/types/sdm";
import { Badge } from "@/components/ui/badge";
import { SDMWatchList } from "./SDMWatchList";

interface SDMExpiryModeProps {
  recommendation: SDMRecommendation;
}

export function SDMExpiryMode({ recommendation }: SDMExpiryModeProps) {
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
    currentWindow,
    windowTimeRemaining,
    tradesTakenToday,
    tradesRemaining,
    gammaThetaData,
    sellerSLZone,
    marketContext,
    timeSensitiveNote,
    tradeGrade,
    dataHealth,
    smartEntry,
    smartExit,
    watchList,
    probabilities,
    positionSizing,
    premiumFairValue,
    expectedMove,
    whyThisTrade,
    smartEntryResult,
    smartExitResult,
    marketStructure,
  } = recommendation;

  const getWindowBadge = () => {
    switch (currentWindow) {
      case "gamma":
        return (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] animate-pulse">
            ⚡ GAMMA ZONE
          </Badge>
        );
      case "theta":
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[9px]">
            🧊 THETA ZONE
          </Badge>
        );
      case "danger":
        return (
          <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[9px] animate-pulse">
            🔥 DANGER ZONE
          </Badge>
        );
      default:
        return null;
    }
  };

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
        return { text: "⏸ WAIT", color: "text-muted-foreground" };
    }
  };

  const dirDisplay = getDirectionDisplay();
  const isCE = direction.includes("CALL");

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[9px] animate-pulse">
          🔴 EXPIRY DAY
        </Badge>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
          dataHealth.status === "LIVE" ? "bg-emerald-400" :
          dataHealth.status === "STALE" ? "bg-amber-400" :
          "bg-red-400"
        }`} title={`Data: ${dataHealth.status} (${dataHealth.score}/100)`} />
        {getWindowBadge()}
        <span className="text-[9px] text-muted-foreground">
          ⏰ {windowTimeRemaining}
        </span>
        <Badge className={`text-[9px] ${
          tradeGrade.startsWith("A") ? "bg-emerald-500/20 text-emerald-400" :
          tradeGrade === "B" ? "bg-yellow-500/20 text-yellow-400" :
          "bg-muted text-muted-foreground"
        }`}>
          Grade: {tradeGrade}
        </Badge>
        <span className="text-[9px] text-muted-foreground ml-auto">
          Trade {tradesTakenToday + 1}/{tradesTakenToday + tradesRemaining}
        </span>
      </div>

      {/* Main Signal Card */}
      {direction !== "WAIT" && (
        <div className="bg-accent/50 rounded-lg p-3 border border-border">
          <div className={`text-lg font-bold ${dirDisplay.color}`}>
            {dirDisplay.text}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            NIFTY {strike} {isCE ? "CE" : "PE"} ({strikeType})
          </div>
          <div className="flex gap-4 mt-2 text-[11px]">
            <span className="text-muted-foreground">
              Entry: <span className="text-foreground">₹{entry.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP1: <span className="text-foreground">₹{tp1.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP2: <span className="text-foreground">₹{tp2.toFixed(1)}</span>
            </span>
            <span className="text-emerald-400">
              TP3: <span className="text-foreground">₹{tp3.toFixed(1)}</span>
            </span>
            <span className="text-red-400">
              SL: <span className="text-foreground">₹{sl.toFixed(1)}</span>
            </span>
          </div>
          <div className="flex gap-4 mt-1 text-[10px]">
            <span className="text-muted-foreground">
              R:R 1:{riskReward.toFixed(1)}
            </span>
            <span className="text-muted-foreground">
              Confidence: {confidence.toFixed(1)}%
            </span>
            <span className="text-muted-foreground">
              P(TP1): {probabilities.tp1}% | P(TP2): {probabilities.tp2}% | P(SL): {probabilities.sl}%
            </span>
          </div>
          <div className="flex gap-4 mt-1 text-[10px]">
            <span className="text-muted-foreground">
              Entry: <span className={smartEntry === "ENTER_NOW" ? "text-emerald-400" : "text-yellow-400"}>{smartEntry.replace(/_/g, " ")}</span>
            </span>
            <span className="text-muted-foreground">
              Exit: <span className={smartExit === "HOLD" ? "text-emerald-400" : "text-yellow-400"}>{smartExit.replace(/_/g, " ")}</span>
            </span>
          </div>

          {/* Gamma Blast Alert */}
          {gammaThetaData.gammaBlastDetected && (
            <div className="mt-2 text-center">
              <div
                className="text-amber-400 font-bold text-sm animate-pulse"
                style={{
                  animation: "flash 0.5s infinite",
                }}
              >
                ⚡⚡⚡ GAMMA BLAST DETECTED ⚡⚡⚡
              </div>
            </div>
          )}

          {/* Time Warning */}
          <div className="mt-2 text-[10px] text-amber-400">
            ⚠️ {timeSensitiveNote}
          </div>
        </div>
      )}

      {/* Smart Entry Guidance */}
      {direction !== "WAIT" && smartEntry !== "ENTER_NOW" && (
        <div className="bg-amber-500/10 rounded-lg p-2 border border-amber-500/20">
          <div className="text-[9px] text-amber-400 uppercase tracking-wider mb-1">
            Entry Timing
          </div>
          <div className="text-[10px] text-amber-300">
            {smartEntryResult?.reason || smartEntry.replace(/_/g, " ")}
          </div>
          {smartEntryResult && (
            <div className="text-[9px] text-muted-foreground mt-0.5">
              Price: {smartEntryResult.currentPrice} | Ref: {smartEntryResult.referenceLevel} | ATR: {smartEntryResult.atr.toFixed(1)}
            </div>
          )}
        </div>
      )}

      {/* Smart Exit Action */}
      {direction !== "WAIT" && smartExit !== "HOLD" && (
        <div className="bg-red-500/10 rounded-lg p-2 border border-red-500/20">
          <div className="text-[9px] text-red-400 uppercase tracking-wider mb-1">
            Exit Signal
          </div>
          <div className="text-[10px] text-red-300">
            {smartExitResult?.reason || smartExit.replace(/_/g, " ")}
          </div>
          {smartExitResult && (
            <div className="text-[9px] text-muted-foreground mt-0.5">
              PnL: {smartExitResult.unrealizedPnLPercent.toFixed(1)}% | Target: T{smartExitResult.targetHit}
              {smartExitResult.gexRegimeFlipped ? " | GEX Flip" : ""}
              {smartExitResult.structureReversal ? " | Structure Rev" : ""}
            </div>
          )}
        </div>
      )}

      {/* Market Structure Event */}
      {marketStructure?.structureEvent && (
        <div className="bg-accent/50 rounded-lg p-2 border border-border">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
            Market Structure
          </div>
          <div className="flex items-center gap-2">
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
            <span className={`text-[10px] ${
              marketStructure.structureEvent.direction === "BULLISH" ? "text-emerald-400" : "text-red-400"
            }`}>
              {marketStructure.structureEvent.direction === "BULLISH" ? "↑" : "↓"} @ {marketStructure.structureEvent.price}
            </span>
            <span className="text-[9px] text-muted-foreground ml-auto">
              Trend: {marketStructure.trend}
            </span>
          </div>
        </div>
      )}

      {/* Expiry Time Windows */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Time Windows
        </div>
        {[
          { name: "GAMMA", time: "9:30-10:30", key: "gamma" as const },
          { name: "THETA", time: "10:30-13:30", key: "theta" as const },
          { name: "DANGER", time: "14:00-15:30", key: "danger" as const },
        ].map((w) => {
          const isCurrent = currentWindow === w.key;
          const windowIdx = ["gamma", "theta", "danger"].indexOf(w.key);
          const currentIdx = ["gamma", "theta", "danger"].indexOf(currentWindow);
          const isPast = currentIdx > windowIdx;

          return (
            <div
              key={w.key}
              className={`flex items-center gap-2 px-2 py-1 rounded text-[9px] ${
                isCurrent
                  ? "bg-white/10 border border-white/20"
                  : isPast
                    ? "bg-emerald-500/10"
                    : "bg-accent/50"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isPast
                    ? "bg-emerald-500"
                    : isCurrent
                      ? "bg-amber-500 animate-pulse"
                      : "bg-muted"
                }`}
              />
              <span
                className={`flex-1 ${
                  isCurrent ? "text-foreground font-medium" : "text-muted-foreground"
                }`}
              >
                {w.name}
              </span>
              <span className="text-muted-foreground">{w.time}</span>
              {isPast && <span className="text-emerald-400">✓</span>}
            </div>
          );
        })}
      </div>

      {/* Seller SL Zone Visual */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Seller SL Zone
        </div>
        <div className="flex items-center gap-1 text-[9px]">
          <span className="text-blue-400 w-20 text-right">
            PE SL: {sellerSLZone.peSellerSL}
          </span>
          <div className="flex-1 h-px bg-muted relative mx-1">
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
        <div className="text-center text-[10px] text-foreground">
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

      {/* Position Sizing */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Position Sizing (1% Risk)
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-accent/50 rounded p-2 text-center">
            <div className="text-[8px] text-muted-foreground">Lots</div>
            <div className="text-[11px] text-foreground font-medium">{positionSizing.lots}</div>
          </div>
          <div className="bg-accent/50 rounded p-2 text-center">
            <div className="text-[8px] text-muted-foreground">Qty</div>
            <div className="text-[11px] text-foreground font-medium">{positionSizing.quantity}</div>
          </div>
          <div className="bg-accent/50 rounded p-2 text-center">
            <div className="text-[8px] text-muted-foreground">Max Loss</div>
            <div className="text-[11px] text-foreground font-medium">₹{positionSizing.maxLoss.toFixed(0)}</div>
          </div>
        </div>
      </div>

      {/* Premium Fair Value */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Premium Fair Value
        </div>
        <div className="bg-accent/50 rounded p-2">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">Status:</span>
            <span className={premiumFairValue.status === "undervalued" ? "text-emerald-400" : premiumFairValue.status === "overpriced" ? "text-red-400" : "text-muted-foreground"}>
              {premiumFairValue.status.toUpperCase()}
            </span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">Difference:</span>
            <span className="text-foreground">{premiumFairValue.differencePercent.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Expected Move */}
      <div className="space-y-1.5">
        <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
          Expected Move
        </div>
        <div className="bg-accent/50 rounded p-2 text-center">
          <div className="text-[11px] text-foreground font-medium">±{expectedMove.toFixed(0)} points</div>
          <div className="text-[8px] text-muted-foreground">
            Range: {(marketContext.spot - expectedMove).toFixed(0)} — {(marketContext.spot + expectedMove).toFixed(0)}
          </div>
        </div>
      </div>

      {/* Why This Trade (Enhanced V2 Explainability) */}
      {whyThisTrade && whyThisTrade.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">
            Why This Trade
          </div>
          {whyThisTrade.slice(0, 8).map((item, i) => (
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
                  {item.type === "positive" ? "✅" : item.type === "warning" ? "⚠️" : "❌"}
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

      {/* Watchlist (when waiting) */}
      {direction === "WAIT" && watchList.length > 0 && (
        <SDMWatchList items={watchList} />
      )}
    </div>
  );
}
