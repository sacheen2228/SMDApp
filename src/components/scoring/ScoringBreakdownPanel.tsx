// Scoring Breakdown Panel — Unified Scoring Engine v2.0
// Shows factor-by-factor breakdown, hard gates, and trade decision.
// Score ≠ Probability — always shows disclaimer.

"use client";

import { useState } from "react";
import {
  type TradeDecision,
  type FactorScore,
  type HardGate,
  type StrategyProfile,
  type GateStatus,
  formatScoreDisplay,
  getScoreInterpretation,
} from "@/lib/unified-scoring-engine";
import {
  ChevronDown,
  ChevronUp,
  Shield,
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
} from "lucide-react";

interface ScoringBreakdownProps {
  decision: TradeDecision;
  expanded?: boolean;
  showProfileSwitch?: boolean;
}

const GRADE_COLORS: Record<string, string> = {
  "A+": "text-emerald-400 bg-emerald-500/20 border-emerald-500/40",
  A: "text-green-400 bg-green-500/20 border-green-500/40",
  B: "text-yellow-400 bg-yellow-500/20 border-yellow-500/40",
  WATCH: "text-orange-400 bg-orange-500/20 border-orange-500/40",
  NO_TRADE: "text-red-400 bg-red-500/20 border-red-500/40",
};

const DECISION_COLORS: Record<string, string> = {
  TRADE: "text-emerald-400",
  WATCH: "text-yellow-400",
  NO_TRADE: "text-red-400",
};

const GATE_COLORS: Record<GateStatus, { bg: string; text: string; icon: typeof Shield }> = {
  PASS: { bg: "bg-emerald-500/10", text: "text-emerald-400", icon: ShieldCheck },
  FAIL: { bg: "bg-red-500/10", text: "text-red-400", icon: ShieldX },
  WARN: { bg: "bg-yellow-500/10", text: "text-yellow-400", icon: AlertTriangle },
  SKIP: { bg: "bg-zinc-500/10", text: "text-zinc-400", icon: Shield },
};

function getFactorBarColor(score: number): string {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 50) return "bg-yellow-500";
  return "bg-red-500";
}

function getFactorIntensity(score: number): string {
  if (score >= 80) return "opacity-100";
  if (score >= 60) return "opacity-80";
  if (score >= 40) return "opacity-60";
  return "opacity-40";
}

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "LONG" || direction === "BULLISH")
    return <TrendingUp className="w-4 h-4 text-emerald-400" />;
  if (direction === "SHORT" || direction === "BEARISH")
    return <TrendingDown className="w-4 h-4 text-red-400" />;
  return <Minus className="w-4 h-4 text-zinc-400" />;
}

function FactorBar({ factor }: { factor: FactorScore }) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="group">
      <button
        onClick={() => setShowDetail(!showDetail)}
        className="w-full flex items-center gap-2 py-1.5 hover:bg-zinc-800/50 rounded px-2 transition-colors"
      >
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider w-16 text-left truncate">
          {factor.factor}
        </span>

        {/* Bar */}
        <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden relative">
          <div
            className={`h-full rounded-full transition-all duration-500 ${getFactorBarColor(factor.score)} ${getFactorIntensity(factor.score)}`}
            style={{ width: `${factor.weight}%` }}
          />
          <div
            className={`absolute top-0 h-full rounded-full ${getFactorBarColor(factor.score)}`}
            style={{ width: `${factor.score}%` }}
          />
        </div>

        {/* Score */}
        <span className={`text-xs font-mono w-8 text-right ${factor.available ? "text-zinc-300" : "text-zinc-600"}`}>
          {factor.available ? factor.score : "—"}
        </span>

        {/* Weight chip */}
        <span className="text-[9px] text-zinc-600 w-8 text-right">{factor.weight}%</span>

        {/* Expanded icon */}
        {showDetail ? (
          <ChevronUp className="w-3 h-3 text-zinc-600" />
        ) : (
          <ChevronDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100" />
        )}
      </button>

      {showDetail && (
        <div className="ml-20 mb-2 text-[11px] text-zinc-500 bg-zinc-900/50 rounded p-2 border border-zinc-800">
          <div className="flex justify-between">
            <span>{factor.reason}</span>
            <span className="text-zinc-400">
              {factor.weighted}/{factor.weight} pts
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function GateIndicator({ gate }: { gate: HardGate }) {
  const color = GATE_COLORS[gate.status];
  const Icon = color.icon;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded ${color.bg}`}>
      <Icon className={`w-4 h-4 ${color.text}`} />
      <span className={`text-xs font-medium ${color.text}`}>{gate.name}</span>
      <span className="text-[10px] text-zinc-500 flex-1">{gate.reason}</span>
      <span className={`text-[10px] font-mono ${color.text}`}>{gate.status}</span>
    </div>
  );
}

export function ScoringBreakdownPanel({
  decision,
  expanded: initialExpanded = false,
}: ScoringBreakdownProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [showGates, setShowGates] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const {
    score,
    grade,
    direction,
    decision: tradeDecision,
    scoreBreakdown,
    hardGateStatus,
    reasons,
    weightsUsed,
    scoringVersion,
    strategyProfile,
    entry,
    stopLoss,
    target1,
    target2,
    riskReward,
    maxLoss,
    expectedReward,
    symbol,
    marketRegime,
    newsImpact,
    liquidityStatus,
    invalidation,
  } = decision;

  const availableFactors = scoreBreakdown.filter((f) => f.available);
  const unavailableFactors = scoreBreakdown.filter((f) => !f.available);
  const totalWeighted = availableFactors.reduce((s, f) => s + f.weighted, 0);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 hover:bg-zinc-800/50 transition-colors"
      >
        {/* Score circle */}
        <div className="relative w-12 h-12 flex-shrink-0">
          <svg className="w-12 h-12 -rotate-90" viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3" className="text-zinc-800" />
            <circle
              cx="24"
              cy="24"
              r="20"
              fill="none"
              strokeWidth="3"
              strokeDasharray={`${(score / 100) * 125.6} 125.6`}
              className={
                score >= 80 ? "stroke-emerald-500" : score >= 60 ? "stroke-yellow-500" : "stroke-red-500"
              }
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-zinc-200">
            {score}
          </span>
        </div>

        {/* Title + grade */}
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-200">{symbol}</span>
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${GRADE_COLORS[grade]}`}
            >
              {grade}
            </span>
            <DirectionIcon direction={direction} />
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {strategyProfile} • {tradeDecision} • v{scoringVersion}
          </div>
        </div>

        {/* Expand */}
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-zinc-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-zinc-800">
          {/* Score ≠ Probability disclaimer */}
          <div className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 bg-blue-500/10 border border-blue-500/20 rounded text-[11px] text-blue-400">
            <Info className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              Score = setup quality (0–100), NOT probability. {getScoreInterpretation(score)}
            </span>
          </div>

          {/* Factor breakdown */}
          <div className="p-3 space-y-0.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                Factor Breakdown ({availableFactors.length}/{scoreBreakdown.length} available)
              </span>
              <span className="text-[10px] text-zinc-500">
                Weighted total: {totalWeighted}
              </span>
            </div>
            {scoreBreakdown.map((f) => (
              <FactorBar key={f.factor} factor={f} />
            ))}
          </div>

          {/* Hard Gates */}
          <div className="px-3 pb-3">
            <button
              onClick={() => setShowGates(!showGates)}
              className="flex items-center gap-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors mb-2"
            >
              {hardGateStatus.passed ? (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <ShieldX className="w-3.5 h-3.5 text-red-400" />
              )}
              <span>
                Hard Gates: {hardGateStatus.gates.filter((g) => g.status === "PASS").length}/
                {hardGateStatus.gates.length} passed
              </span>
              {showGates ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {showGates && (
              <div className="space-y-1.5">
                {hardGateStatus.gates.map((gate) => (
                  <GateIndicator key={gate.name} gate={gate} />
                ))}
                {hardGateStatus.failedGates.length > 0 && (
                  <div className="text-[10px] text-red-400 mt-1">
                    Failed: {hardGateStatus.failedGates.join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Trade parameters */}
          {tradeDecision === "TRADE" && (
            <div className="mx-3 mb-3 p-3 bg-zinc-800/50 rounded border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">
                Trade Parameters
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Entry</span>
                  <span className="text-zinc-300 font-mono">₹{entry}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Stop Loss</span>
                  <span className="text-red-400 font-mono">₹{stopLoss}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Target 1</span>
                  <span className="text-emerald-400 font-mono">₹{target1}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Target 2</span>
                  <span className="text-emerald-400 font-mono">₹{target2}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Risk:Reward</span>
                  <span className={`font-mono ${riskReward >= 2 ? "text-emerald-400" : riskReward >= 1 ? "text-yellow-400" : "text-red-400"}`}>
                    {riskReward}:1
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Max Loss</span>
                  <span className="text-red-400 font-mono">₹{maxLoss}</span>
                </div>
              </div>
            </div>
          )}

          {/* Context */}
          <div className="mx-3 mb-3 grid grid-cols-3 gap-2 text-[11px]">
            <div className="bg-zinc-800/50 rounded p-2 text-center">
              <div className="text-zinc-500">Regime</div>
              <div className="text-zinc-300 font-medium">{marketRegime}</div>
            </div>
            <div className="bg-zinc-800/50 rounded p-2 text-center">
              <div className="text-zinc-500">News</div>
              <div className={`font-medium ${newsImpact === "POSITIVE" ? "text-emerald-400" : newsImpact === "NEGATIVE" ? "text-red-400" : "text-zinc-300"}`}>
                {newsImpact}
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded p-2 text-center">
              <div className="text-zinc-500">Liquidity</div>
              <div className={`font-medium ${liquidityStatus === "PASS" ? "text-emerald-400" : "text-red-400"}`}>
                {liquidityStatus}
              </div>
            </div>
          </div>

          {/* Reasons */}
          {reasons.length > 0 && (
            <div className="mx-3 mb-3">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Decision Reasons</div>
              <div className="space-y-0.5">
                {reasons.map((r, i) => (
                  <div key={i} className="text-[11px] text-zinc-400">
                    {r}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Invalidation */}
          {invalidation && (
            <div className="mx-3 mb-3 text-[10px] text-red-400/80 bg-red-500/5 rounded px-2 py-1">
              Invalidation: {invalidation}
            </div>
          )}

          {/* Raw data toggle */}
          <div className="px-3 pb-3">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showRaw ? "Hide" : "Show"} raw weights
            </button>
            {showRaw && (
              <pre className="mt-1 text-[9px] text-zinc-600 bg-zinc-950 rounded p-2 overflow-x-auto">
                {JSON.stringify(weightsUsed, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Compact version for inline use ────────────────────────────────

export function ScoreBadge({ score, grade }: { score: number; grade: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border ${GRADE_COLORS[grade] ?? "text-zinc-400 bg-zinc-500/20 border-zinc-500/40"}`}>
      {score}/100
      <span className="opacity-70">{grade}</span>
    </span>
  );
}

// ─── Strategy Profile Selector ─────────────────────────────────────

export function StrategyProfileSelector({
  current,
  onChange,
}: {
  current: StrategyProfile;
  onChange: (p: StrategyProfile) => void;
}) {
  const profiles: { key: StrategyProfile; label: string; desc: string }[] = [
    { key: "EQUITY_SWING", label: "Equity Swing", desc: "Structure-heavy, no OI" },
    { key: "FO", label: "F&O", desc: "OI-dominant, structure-light" },
    { key: "OPTIONS", label: "Options", desc: "IV/Greeks weighted" },
    { key: "CAS", label: "CAS", desc: "Premium + IV + volume" },
    { key: "HERO_ZERO", label: "Hero-Zero", desc: "Volume + OI dominant" },
  ];

  return (
    <div className="flex gap-1 flex-wrap">
      {profiles.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          className={`px-2.5 py-1.5 rounded text-[11px] font-medium transition-colors ${
            current === p.key
              ? "bg-blue-500/20 text-blue-400 border border-blue-500/40"
              : "bg-zinc-800/50 text-zinc-500 border border-zinc-700/50 hover:text-zinc-300"
          }`}
          title={p.desc}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
