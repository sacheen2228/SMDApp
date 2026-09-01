// ─── Signal Card Component ────────────────────────────────────────────
// Detailed signal display with explainability

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Target,
  Shield,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Zap,
  Shield as ShieldIcon,
  ArrowUpRight,
  ArrowDownRight,
  Info,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Gauge,
  BarChart3,
  Flame,
  Zap as ZapIcon,
} from "lucide-react";
import { SignalExplanation, TradeSignal, TradeSignalType } from "@/lib/expiry-liquidity/types";

interface SignalCardProps {
  signal: TradeSignal;
  explanation?: SignalExplanation;
  compact?: boolean;
  onClose?: () => void;
}

function SignalTypeIcon({ type }: { type: TradeSignalType }) {
  const config: Record<string, { icon: any; color: string; label: string }> = {
    LONG_CALL: { icon: TrendingUp, color: "text-emerald-400", label: "LONG CALL" },
    LONG_PUT: { icon: TrendingDown, color: "text-red-400", label: "LONG PUT" },
    CALL_SHORT_COVERING: { icon: Zap, color: "text-emerald-300", label: "CALL SHORT COVER" },
    PUT_SHORT_COVERING: { icon: Zap, color: "text-red-300", label: "PUT SHORT COVER" },
    FUTURES_LONG: { icon: TrendingUp, color: "text-blue-400", label: "FUTURES LONG" },
    FUTURES_SHORT: { icon: TrendingDown, color: "text-orange-400", label: "FUTURES SHORT" },
    WATCH: { icon: Gauge, color: "text-yellow-400", label: "WATCH" },
    NO_TRADE: { icon: XCircle, color: "text-zinc-400", label: "NO TRADE" },
  };
  const cfg = signalConfig[type] || signalConfig.NO_TRADE;
  return (
    <span className="flex items-center gap-1">
      <cfg.icon className={`h-4 w-4 ${cfg.color}`} />
      <span className={`text-xs font-bold ${cfg.color}`}>{cfg.label}</span>
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const color = confidence === "VERY HIGH" ? "bg-emerald-600" :
    confidence === "HIGH" ? "bg-emerald-500/20 text-emerald-400" :
    confidence === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" :
    "bg-zinc-600 text-zinc-400";
  return <Badge variant="outline" className={`${color} text-[9px]`}>{confidence}</Badge>;
}

function ScoreBadge({ score }: { score: number }) {
  const grade = score >= 80 ? "A+" : score >= 65 ? "A" : score >= 50 ? "B" : "C";
  const color = score >= 80 ? "bg-emerald-600" : score >= 65 ? "bg-emerald-500/30 text-emerald-400" :
    score >= 50 ? "bg-yellow-500/30 text-yellow-400" : "bg-zinc-600 text-zinc-400";
  return <Badge className={`${color} text-xs font-bold`}>{score}/100 {grade}</Badge>;
}

const entryStateColors: Record<string, string> = {
  CONFIRMED: "bg-emerald-600 text-white",
  CONFIRMING: "bg-blue-600 text-white",
  TRIGGERED: "bg-emerald-600 text-white",
  ACTIVE: "bg-emerald-600 text-white",
  EXHAUSTED: "bg-orange-600 text-white",
  INVALIDATED: "bg-red-600 text-white",
  WATCH: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  WAITING: "bg-zinc-600 text-zinc-400",
  INVALIDATED: "bg-red-500/20 text-red-400 border-red-500/30",
};

const entryStateIcons: Record<string, string> = {
  CONFIRMED: "✓",
  CONFIRMING: "⟳",
  TRIGGERED: "⚡",
  ACTIVE: "▶",
  EXHAUSTED: "◼",
  INVALIDATED: "✗",
  WATCH: "👁",
  WAITING: "⏳",
};

function StateBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className={`${entryStateColors[state] || "bg-zinc-600"} text-[9px] font-bold`}>
      {entryStateIcons[state] || ""} {state}
    </Badge>
  );
}

function ReasonBadge({ reason }: { reason: string }) {
  return (
    <Badge className="bg-emerald-500/10 text-emerald-400 text-[8px] border-emerald-500/20">
      ✓ {reason}
    </Badge>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  return (
    <Badge className="bg-red-500/10 text-red-400 text-[8px] border-red-500/20">
      ⚠ {risk}
    </Badge>
  );
}

function ScoreBar({ label, score, max = 100 }: { label: string; score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color = score >= 70 ? "bg-emerald-500" : score >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="text-zinc-500 w-16">{label}</span>
      <div className="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-bold w-6 text-right">{score}</span>
    </div>
  );
}

export function SignalCard({ signal, explanation, compact = false, onClose }: SignalCardProps) {
  const [expanded, setExpanded] = useState(!compact);

  if (!signal || signal.type === "NO_TRADE") return null;

  const isBullish = signal.direction === "BULLISH";
  const directionColor = isBullish ? "text-emerald-400" : "text-red-400";
  const directionIcon = signal.direction === "BULLISH" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />;

  const config: Record<string, { icon: any; color: string; label: string }> = {
    LONG_CALL: { icon: TrendingUp, color: "text-emerald-400", label: "LONG CALL" },
    LONG_PUT: { icon: TrendingDown, color: "text-red-400", label: "LONG PUT" },
    CALL_SHORT_COVERING: { icon: Zap, color: "text-emerald-300", label: "CALL SHORT COVER" },
    PUT_SHORT_COVERING: { icon: Zap, color: "text-red-300", label: "PUT SHORT COVER" },
    FUTURES_LONG: { icon: TrendingUp, color: "text-blue-400", label: "FUTURES LONG" },
    FUTURES_SHORT: { icon: TrendingDown, color: "text-orange-400", label: "FUTURES SHORT" },
    WATCH: { icon: Gauge, color: "text-yellow-400", label: "WATCH" },
    NO_TRADE: { icon: XCircle, color: "text-zinc-400", label: "NO TRADE" },
  };

  const signalConfig = config[signal.type] || config.NO_TRADE;

return (
    <Card className="bg-[#0f1117] border-zinc-800 overflow-hidden">
      {/* Header */}
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <signalConfig.icon className={`h-4 w-4 ${signalConfig.color}`} />
            <span className="text-sm font-bold text-white">{signalConfig.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="text-white text-[9px] font-bold">{signal.symbol}</Badge>
            <Badge className="text-[9px] bg-zinc-700">{signal.expiry}</Badge>
            <Badge variant="outline" className="text-[9px] text-zinc-400">{signal.strike} {signal.optionType}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <ScoreBadge score={signal.score} />
            <div className="mt-1">
              <ConfidenceBadge confidence={signal.confidence} />
            </div>
          </div>
          <div className="text-right">
            <StateBadge state={signal.status} />
          </div>
          {onClose && (
            <button onClick={onClose} className="text-zinc-500 hover:text-white p-2 ml-2">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-0 space-y-4">
        {/* Trade Plan */}
        <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
          <div className="grid grid-cols-5 gap-2 text-[10px] mb-2">
            <div>
              <span className="text-zinc-500">Entry</span>
              <div className="font-bold text-white">₹{signal.entry.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-zinc-500">Stop</span>
              <div className="font-bold text-red-400">₹{signal.stop.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-zinc-500">Target 1</span>
              <div className="font-bold text-emerald-400">₹{signal.target1.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-zinc-500">Target 2</span>
              <div className="font-bold text-emerald-400">₹{signal.target2.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-zinc-500">R:R</span>
              <div className={`font-bold ${signal.riskReward >= 2 ? "text-emerald-400" : signal.riskReward >= 1.5 ? "text-yellow-400" : "text-red-400"}`}>
                1:{signal.riskReward.toFixed(1)}
              </div>
            </div>
          </div>

          {/* Entry State & Trigger */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Badge className="bg-emerald-600 text-white text-[9px]">LONG</Badge>
              <Badge variant="outline" className="text-[9px] text-zinc-400">{signal.setup}</Badge>
              <Badge variant="outline" className="text-[9px] text-zinc-400">{signal.optionType}</Badge>
              <Badge className={entryStateColors[signal.status] || "bg-zinc-600"} text-xs font-bold>
                {entryStateIcons[signal.status] || ""} {signal.status}
              </Badge>
            </div>
            <div className="text-right">
              <Badge variant="outline" className="text-[9px] text-zinc-400">{signal.sector}</Badge>
            </div>
          </div>

          {/* Reasons */}
          {signal.reasons?.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {signal.reasons.slice(0, 4).map((r, i) => (
                <ReasonBadge key={i} reason={r} />
              ))}
            </div>
          )}

          {/* Risks */}
          {signal.risks?.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {signal.risks.map((r, i) => (
                <RiskBadge key={i} risk={r} />
              ))}
            </div>
          )}

          {/* Invalidation */}
          {signal.invalidation && (
            <div className="bg-red-500/10 border border-red-500/20 rounded p-2 text-[10px]">
              <div className="flex items-center gap-1 text-red-400 mb-1">
                <AlertCircle className="h-3 w-3" />
                <span className="font-bold">INVALIDATION</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Condition</span>
                <span className="font-bold">{signal.invalidation.condition}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Price</span>
                <span className="font-bold text-red-400">₹{signal.invalidation.price.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Reason</span>
                <span className="text-zinc-400">{signal.invalidation.reason}</span>
              </div>
            </div>
          )}

          {/* Expandable Explainability */}
          {explanation && !compact && (
            <div className="border-t border-zinc-800 pt-3">
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center justify-between text-xs text-zinc-400 hover:text-white"
              >
                <span className="flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  WHY THIS SIGNAL?
                </span>
                <span className={expanded ? "text-emerald-400" : "text-zinc-400"}>
                  {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </span>
              </button>

              {expanded && (
                <div className="mt-3 space-y-2 animate-slide-down">
                  <div className="bg-emerald-500/5 border border-emerald-500/20 rounded p-2">
                    <div className="text-[10px] font-bold text-emerald-400 mb-1">CONFIRMING FACTORS</div>
                    <div className="space-y-1">
                      {explanation.why.map((r, i) => (
                        <div key={i} className="flex items-center gap-1 text-[10px]">
                          <CheckCircle className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                          <span className="text-zinc-300">{r}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {explanation.risks.length > 0 && (
                    <div className="bg-red-500/5 border border-red-500/20 rounded p-2">
                      <div className="text-[10px] font-bold text-red-400 mb-1">RISKS & CAUTIONS</div>
                      <div className="space-y-1">
                        {explanation.risks.map((r, i) => (
                          <div key={i} className="flex items-center gap-1 text-[10px]">
                            <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
                            <span className="text-zinc-300">{r}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )

                  {explanation.missingData.length > 0 && (
                    <div className="bg-yellow-500/5 border border-yellow-500/20 rounded p-2">
                      <div className="text-[10px] font-bold text-yellow-400 mb-1">MISSING DATA</div>
                      <div className="space-y-1">
                        {explanation.missingData.map((d, i) => (
                          <div key={i} className="flex items-center gap-1 text-[10px] text-yellow-400">
                            <AlertCircle className="h-3 w-3" />
                            <span>{d}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {explanation.assumptions.length > 0 && (
                    <div className="bg-blue-500/5 border border-blue-500/20 rounded p-2">
                      <div className="text-[10px] font-bold text-blue-400 mb-1">ASSUMPTIONS</div>
                      <div className="space-y-1">
                        {explanation.assumptions.map((a, i) => (
                          <div key={i} className="flex items-center gap-1 text-[10px] text-blue-300">
                            <Info className="h-3 w-3" />
                            <span>{a}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="text-right text-[9px] text-zinc-500 mt-2">
                    Data Quality: {explanation.dataQuality}%
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Data Quality & Timestamp */}
          <div className="flex items-center justify-between text-[9px] text-zinc-500 mt-2">
            <span>Data Quality: {signal.dataQuality}%</span>
            <span>Updated: {new Date(signal.timestamp).toLocaleTimeString()}</span>
          </div>
        </CardContent>
      </Card>
    );
  }
}

export default SignalCard;