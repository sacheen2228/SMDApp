"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Building2, TrendingUp, TrendingDown, RefreshCw, Activity,
  Users, Banknote, Shield, BarChart3, Zap, AlertTriangle, Target, MapPin,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const fmtNum = (n: number) => {
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(1) + 'Cr';
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(1) + 'L';
  return n.toLocaleString('en-IN');
};

const clsChg = (n: number) => n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-500';
const clsDelta = (c: string) =>
  c === 'aggressive_add' ? 'text-emerald-300' :
  c === 'moderate_add' ? 'text-emerald-500' :
  c === 'aggressive_reduce' ? 'text-red-300' :
  c === 'moderate_reduce' ? 'text-red-500' : 'text-zinc-500';

function DirectionBadge({ dir }: { dir: string }) {
  if (dir === 'bullish') return <Badge className="bg-emerald-600/20 text-emerald-400 border-emerald-600/30 text-[10px]"><TrendingUp className="h-2.5 w-2.5 mr-0.5" />Bullish</Badge>;
  if (dir === 'bearish') return <Badge className="bg-red-600/20 text-red-400 border-red-600/30 text-[10px]"><TrendingDown className="h-2.5 w-2.5 mr-0.5" />Bearish</Badge>;
  return <Badge className="bg-zinc-600/20 text-zinc-400 border-zinc-600/30 text-[10px]"><Activity className="h-2.5 w-2.5 mr-0.5" />Neutral</Badge>;
}

function ScoreBar({ score, label, color }: { score: number; label: string; color?: string }) {
  const isBullish = score >= 55;
  const isBearish = score <= 45;
  const c = color || (isBullish ? '#10B981' : isBearish ? '#EF4444' : '#71717A');
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-bold ${isBullish ? 'text-emerald-400' : isBearish ? 'text-red-400' : 'text-zinc-400'}`}>{label}</span>
        <span className="text-[11px] font-mono text-zinc-400">{score}/100</span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${score}%`, background: `linear-gradient(90deg, ${c}88, ${c})` }} />
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export default function InstitutionalPositioningPanel({ symbol: propSymbol }: { symbol?: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string>('forecast');

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pRes, cRes] = await Promise.all([
        fetch('/api/participant-oi'),
        fetch(`/api/option-chain?symbol=${encodeURIComponent(propSymbol || 'NIFTY')}`),
      ]);
      const pJson = await pRes.json();
      if (pJson.success) setData(pJson);
      else setError(pJson.error || 'Participant OI failed');
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }, [propSymbol]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return (
    <div className="flex-1 flex items-center justify-center p-8" style={{ background: '#0C131F' }}>
      <div className="flex flex-col items-center gap-3">
        <RefreshCw className="h-6 w-6 animate-spin" style={{ color: '#4FB3E8' }} />
        <span className="text-[11px] font-mono" style={{ color: '#4E5A6B' }}>Loading institutional positioning...</span>
      </div>
    </div>
  );

  if (error || !data) return (
    <div className="flex-1 flex items-center justify-center p-8" style={{ background: '#0C131F' }}>
      <div className="text-center max-w-md">
        <AlertTriangle className="h-8 w-8 mx-auto mb-2" style={{ color: '#F0566B' }} />
        <p className="text-[11px] font-mono mb-2" style={{ color: '#F0566B' }}>Data unavailable</p>
        <p className="text-[10px] font-mono" style={{ color: '#4E5A6B' }}>{error || 'No data received'}</p>
        <button onClick={fetchData} className="mt-3 px-3 py-1.5 rounded text-[10px] font-bold"
          style={{ background: '#1B2531', color: '#4FB3E8', border: '1px solid #232E3D' }}>Retry</button>
      </div>
    </div>
  );

  const { today, changes, strengthScores, bias, retailTrap, alignment, futures, options, prediction, confidence, dateLabel, source } = data;
  const isNse = source === 'nse';

  const toggleSection = (s: string) => setExpandedSection(expandedSection === s ? '' : s);
  const isOpen = (s: string) => expandedSection === s;

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3" style={{ background: '#0C131F' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4" style={{ color: '#F0566B' }} />
          <h2 className="text-xs font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif", color: '#E9EEF3' }}>
            Institutional Positioning Engine
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={`text-[8px] ${isNse ? 'bg-emerald-600/20 text-emerald-400' : 'bg-amber-600/20 text-amber-400'}`}>
            {isNse ? 'NSE' : 'DB'}
          </Badge>
          <span className="text-[9px] font-mono" style={{ color: '#4E5A6B' }}>{dateLabel}</span>
          <button onClick={fetchData} className="p-1 rounded hover:bg-white/5" title="Refresh">
            <RefreshCw className="h-3 w-3" style={{ color: '#4E5A6B' }} />
          </button>
        </div>
      </div>

      {/* ═══ AI Confidence Engine — Top Banner ═══ */}
      <Card className="border-0" style={{ background: `linear-gradient(135deg, ${confidence.overall >= 70 ? '#0A2E1E' : confidence.overall >= 40 ? '#1E1A0A' : '#2E0A0A'}, #111823)` }}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold" style={{ color: '#E9EEF3' }}>AI Confidence Engine</span>
            <div className="flex items-center gap-2">
              <DirectionBadge dir={prediction?.tomorrowBias || 'neutral'} />
              <span className={`text-[18px] font-bold font-mono ${confidence.overall >= 70 ? 'text-emerald-400' : confidence.overall >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
                {confidence.overall || 50}
              </span>
              <span className="text-[9px] font-mono" style={{ color: '#4E5A6B' }}>/ 100</span>
            </div>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width: `${confidence.overall || 50}%`, background: confidence.overall >= 70 ? 'linear-gradient(90deg, #059669, #10B981)' : confidence.overall >= 40 ? 'linear-gradient(90deg, #D97706, #F59E0B)' : 'linear-gradient(90deg, #DC2626, #EF4444)' }} />
          </div>
          <div className="grid grid-cols-6 gap-1 mt-1.5">
            {(confidence.breakdown || []).map((f: any) => (
              <div key={f.factor} className="text-[7px] font-mono text-center" style={{ color: '#4E5A6B' }}>
                <div className="truncate">{f.factor.substring(0, 14)}</div>
                <span className={`text-[9px] font-bold ${f.score >= 60 ? 'text-emerald-400' : f.score <= 40 ? 'text-red-400' : 'text-zinc-400'}`}>{f.score}</span>
                <span className="text-[7px]"> ({(f.weight * 100).toFixed(0)}%)</span>
              </div>
            ))}
          </div>
          {prediction?.summary && (
            <div className="mt-1.5 text-[9px] font-mono leading-relaxed p-1.5 rounded" style={{ background: '#09121A', color: '#8A97A8' }}>
              {prediction.summary}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══ Smart Money Bias + Strength Scores ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardContent className="p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold" style={{ color: '#E9EEF3' }}>Smart Money Bias</span>
            <div className="flex items-center gap-2 text-[9px] font-mono">
              <span className="text-emerald-400">Bull {bias?.bullishPct || 0}%</span>
              <span className="text-red-400">Bear {bias?.bearishPct || 0}%</span>
              <span className="text-zinc-400">Neu {bias?.neutralPct || 0}%</span>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {(strengthScores || []).map((s: any) => (
              <div key={s.participant} className="p-2 rounded" style={{ background: '#0D1520' }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-bold" style={{
                    color: s.participant === 'FII' ? '#F0566B' : s.participant === 'Pro' ? '#E3A23D' :
                    s.participant === 'DII' ? '#4FB3E8' : '#8A97A8'
                  }}>{s.participant}</span>
                  <DirectionBadge dir={s.direction} />
                </div>
                <ScoreBar score={s.score} label={s.label} />
                <div className="mt-0.5 text-[8px] font-mono" style={{ color: '#4E5A6B' }}>
                  Conviction: {s.conviction}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ═══ Retail Trap Detector ═══ */}
      {retailTrap?.detected && (
        <Card className="border-0" style={{ background: '#2E0A0A', border: '1px solid #4A1E1E' }}>
          <CardContent className="p-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: '#F0566B' }} />
            <div>
              <span className="text-[10px] font-bold text-red-400">
                {retailTrap.type === 'bull_trap' ? '⚠ Potential Bull Trap' : '⚠ Potential Bear Trap'}
              </span>
              <p className="text-[9px] font-mono" style={{ color: '#8A97A8' }}>{retailTrap.description}</p>
            </div>
            <Badge className={`ml-auto text-[8px] ${retailTrap.severity === 'high' ? 'bg-red-600/30 text-red-400' : 'bg-amber-600/30 text-amber-400'}`}>
              {retailTrap.severity}
            </Badge>
          </CardContent>
        </Card>
      )}

      {/* ═══ Market Prediction Engine ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardHeader className="px-3 py-2 cursor-pointer" onClick={() => toggleSection('forecast')}>
          <CardTitle className="flex items-center gap-1.5 text-[11px] font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif", color: '#E9EEF3' }}>
            {isOpen('forecast') ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Zap className="h-3 w-3" style={{ color: '#E3A23D' }} />
            Market Prediction — Tomorrow
          </CardTitle>
        </CardHeader>
        {isOpen('forecast') && prediction && (
          <CardContent className="px-3 pb-3">
            <div className="grid grid-cols-4 gap-2 mb-2">
              {[
                { label: 'Gap Up', prob: prediction.gapUpProb, color: '#10B981' },
                { label: 'Gap Down', prob: prediction.gapDownProb, color: '#EF4444' },
                { label: 'Trend Day', prob: prediction.trendDayProb, color: '#F59E0B' },
                { label: 'Reversal', prob: prediction.reversalProb, color: '#8B5CF6' },
              ].map(p => (
                <div key={p.label} className="text-center p-1.5 rounded" style={{ background: '#0D1520' }}>
                  <div className="text-[8px] font-mono" style={{ color: '#4E5A6B' }}>{p.label}</div>
                  <div className="text-[14px] font-bold font-mono" style={{ color: p.color }}>{p.prob}%</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-[9px] font-mono">
              {[
                { label: 'Liquidity Sweep', prob: prediction.liquiditySweepProb },
                { label: 'Gamma Flip', prob: prediction.gammaFlipProb },
                { label: 'Inside Day', prob: prediction.insideDayProb },
              ].map(p => (
                <div key={p.label} className="text-center" style={{ color: '#4E5A6B' }}>
                  {p.label}: <span className="text-zinc-300 font-bold">{p.prob}%</span>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ═══ Alignment + Conflict Report ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardHeader className="px-3 py-2 cursor-pointer" onClick={() => toggleSection('align')}>
          <CardTitle className="flex items-center gap-1.5 text-[11px] font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif", color: '#E9EEF3' }}>
            {isOpen('align') ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <BarChart3 className="h-3 w-3" />
            Position Alignment {alignment?.overallAlignment ? `${alignment.overallAlignment}%` : ''}
          </CardTitle>
        </CardHeader>
        {isOpen('align') && alignment && (
          <CardContent className="px-3 pb-3">
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div className="p-1.5 rounded" style={{ background: '#0D1520' }}>
                <span style={{ color: '#4E5A6B' }}>FII vs PRO: </span>
                <span className={alignment.fiiVsPro === 'aligned' ? 'text-emerald-400' : alignment.fiiVsPro === 'conflicting' ? 'text-red-400' : 'text-zinc-400'}>
                  {alignment.fiiVsPro.toUpperCase()}
                </span>
              </div>
              <div className="p-1.5 rounded" style={{ background: '#0D1520' }}>
                <span style={{ color: '#4E5A6B' }}>Institutional vs OI: </span>
                <span className={alignment.instVsOI === 'aligned' ? 'text-emerald-400' : 'text-zinc-400'}>
                  {alignment.instVsOI.toUpperCase()}
                </span>
              </div>
              {alignment.alignedSources.length > 0 && (
                <div className="col-span-2 p-1.5 rounded" style={{ background: '#0A2E1E' }}>
                  <span className="text-[9px]" style={{ color: '#4E5A6B' }}>Aligned: </span>
                  <span className="text-[10px] text-emerald-400">{alignment.alignedSources.join(', ')}</span>
                </div>
              )}
              {alignment.conflictingSources.length > 0 && (
                <div className="col-span-2 p-1.5 rounded" style={{ background: '#2E0A0A' }}>
                  <span className="text-[9px]" style={{ color: '#4E5A6B' }}>Conflicts: </span>
                  <span className="text-[10px] text-red-400">{alignment.conflictingSources.join(', ')}</span>
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ═══ Futures Engine + Options Engine ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardHeader className="px-3 py-2 cursor-pointer" onClick={() => toggleSection('derivatives')}>
          <CardTitle className="flex items-center gap-1.5 text-[11px] font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif", color: '#E9EEF3' }}>
            {isOpen('derivatives') ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Activity className="h-3 w-3" />
            Futures & Options Flow
          </CardTitle>
        </CardHeader>
        {isOpen('derivatives') && (
          <CardContent className="px-3 pb-3 space-y-2">
            {/* Futures */}
            {futures && (
              <div className="p-2 rounded" style={{ background: '#0D1520' }}>
                <div className="text-[9px] font-bold mb-1" style={{ color: '#4E5A6B' }}>Index Futures</div>
                <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
                  <div>
                    <span style={{ color: '#4E5A6B' }}>FII Long</span>
                    <div className="font-bold text-emerald-400">{fmtNum(futures.fiiNetLong)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#4E5A6B' }}>FII Short</span>
                    <div className="font-bold text-red-400">{fmtNum(futures.fiiNetShort)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#4E5A6B' }}>Pro Long</span>
                    <div className="font-bold text-emerald-400">{fmtNum(futures.proNetLong)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#4E5A6B' }}>Pro Short</span>
                    <div className="font-bold text-red-400">{fmtNum(futures.proNetShort)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {futures.aggressiveBuild !== 'none' && (
                    <Badge className={`text-[8px] ${futures.aggressiveBuild === 'long' ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'}`}>
                      Aggressive {futures.aggressiveBuild} build
                    </Badge>
                  )}
                  {futures.coveringDetected !== 'none' && (
                    <Badge className="text-[8px] bg-amber-600/20 text-amber-400">{futures.coveringDetected}</Badge>
                  )}
                  <Badge className={`text-[8px] ${futures.netMarketDirection === 'bullish' ? 'bg-emerald-600/20 text-emerald-400' : futures.netMarketDirection === 'bearish' ? 'bg-red-600/20 text-red-400' : 'bg-zinc-600/20 text-zinc-400'}`}>
                    {futures.netMarketDirection}
                  </Badge>
                </div>
              </div>
            )}

            {/* Options */}
            {options && (
              <div className="p-2 rounded" style={{ background: '#0D1520' }}>
                <div className="text-[9px] font-bold mb-1" style={{ color: '#4E5A6B' }}>Index Options</div>
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                  <div>
                    <span style={{ color: '#10B981' }}>Call Buying</span>
                    <div className="text-[9px]">FII {fmtNum(options.fiiCallBuying)} · Pro {fmtNum(options.proCallBuying)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#EF4444' }}>Call Writing</span>
                    <div className="text-[9px]">FII {fmtNum(options.fiiCallWriting)} · Pro {fmtNum(options.proCallWriting)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#10B981' }}>Put Buying</span>
                    <div className="text-[9px]">FII {fmtNum(options.fiiPutBuying)} · Pro {fmtNum(options.proPutBuying)}</div>
                  </div>
                  <div>
                    <span style={{ color: '#EF4444' }}>Put Writing</span>
                    <div className="text-[9px]">FII {fmtNum(options.fiiPutWriting)} · Pro {fmtNum(options.proPutWriting)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className={`text-[8px] ${options.expectedDirection === 'bullish' ? 'bg-emerald-600/20 text-emerald-400' : options.expectedDirection === 'bearish' ? 'bg-red-600/20 text-red-400' : 'bg-zinc-600/20 text-zinc-400'}`}>
                    Options: {options.expectedDirection}
                  </Badge>
                  <Badge className={`text-[8px] ${options.dealerGammaRisk === 'long' ? 'bg-emerald-600/20 text-emerald-400' : options.dealerGammaRisk === 'short' ? 'bg-red-600/20 text-red-400' : 'bg-zinc-600/20 text-zinc-400'}`}>
                    Dealer Gamma: {options.dealerGammaRisk}
                  </Badge>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ═══ Participant OI Table ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardHeader className="px-3 py-2 cursor-pointer" onClick={() => toggleSection('table')}>
          <CardTitle className="flex items-center gap-1.5 text-[11px] font-bold" style={{ fontFamily: "'Space Grotesk',sans-serif", color: '#E9EEF3' }}>
            {isOpen('table') ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Users className="h-3 w-3" />
            Participant-wise OI
          </CardTitle>
        </CardHeader>
        {isOpen('table') && (
          <CardContent className="px-3 pb-3">
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono" style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th className="px-1 py-0.5 text-left text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Type</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Idx Fut Long</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Idx Fut Short</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Call Long</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Put Long</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Call Short</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Put Short</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Total L</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Total S</th>
                    <th className="px-1 py-0.5 text-right text-[8px] uppercase" style={{ color: '#4E5A6B' }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {['FII', 'Pro', 'DII', 'Client'].map(type => {
                    const row = today?.[type];
                    if (!row) return null;
                    const net = (row.totalLong || 0) - (row.totalShort || 0);
                    return (
                      <tr key={type} style={{ borderBottom: '1px solid #1B2531' }}>
                        <td className="px-1 py-0.5 text-left">
                          <span className="font-bold text-[11px]" style={{
                            color: type === 'FII' ? '#F0566B' : type === 'Pro' ? '#E3A23D' : type === 'DII' ? '#4FB3E8' : '#8A97A8'
                          }}>{type}</span>
                        </td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.futureIndexLong)}</td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.futureIndexShort)}</td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.optionIndexCallLong)}</td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.optionIndexPutLong)}</td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.optionIndexCallShort)}</td>
                        <td className="px-1 py-0.5 text-right">{fmtNum(row.optionIndexPutShort)}</td>
                        <td className="px-1 py-0.5 text-right font-bold">{fmtNum(row.totalLong)}</td>
                        <td className="px-1 py-0.5 text-right font-bold">{fmtNum(row.totalShort)}</td>
                        <td className={`px-1 py-0.5 text-right font-bold ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-zinc-500'}`}>{fmtNum(net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Day-oD Changes */}
            {changes?.length > 0 && (
              <div className="mt-2">
                <div className="text-[9px] font-bold mb-1" style={{ color: '#4E5A6B' }}>Day-over-Day Change</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[9px] font-mono">
                    <thead>
                      <tr>
                        <th className="px-1 py-0.5 text-left text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Type</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Idx Fut Long</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Idx Fut Short</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Call Long</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Put Long</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Call Short</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Put Short</th>
                        <th className="px-1 py-0.5 text-right text-[7px] uppercase" style={{ color: '#4E5A6B' }}>Net Δ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c: any) => (
                        <tr key={c.clientType} style={{ borderBottom: '1px solid #1B2531' }}>
                          <td className="px-1 py-0.5 text-left font-bold text-[10px]" style={{
                            color: c.clientType === 'FII' ? '#F0566B' : c.clientType === 'Pro' ? '#E3A23D' : c.clientType === 'DII' ? '#4FB3E8' : '#8A97A8'
                          }}>{c.clientType}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.futureIndexLong.classification)}`}>{c.dailyDelta.futureIndexLong.raw > 0 ? '+' : ''}{c.dailyDelta.futureIndexLong.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.futureIndexShort.classification)}`}>{c.dailyDelta.futureIndexShort.raw > 0 ? '+' : ''}{c.dailyDelta.futureIndexShort.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.optionIndexCallLong.classification)}`}>{c.dailyDelta.optionIndexCallLong.raw > 0 ? '+' : ''}{c.dailyDelta.optionIndexCallLong.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.optionIndexPutLong.classification)}`}>{c.dailyDelta.optionIndexPutLong.raw > 0 ? '+' : ''}{c.dailyDelta.optionIndexPutLong.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.optionIndexCallShort.classification)}`}>{c.dailyDelta.optionIndexCallShort.raw > 0 ? '+' : ''}{c.dailyDelta.optionIndexCallShort.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right ${clsDelta(c.dailyDelta.optionIndexPutShort.classification)}`}>{c.dailyDelta.optionIndexPutShort.raw > 0 ? '+' : ''}{c.dailyDelta.optionIndexPutShort.raw.toLocaleString('en-IN')}</td>
                          <td className={`px-1 py-0.5 text-right font-bold ${c.dailyDelta.netPosition.raw > 0 ? 'text-emerald-400' : c.dailyDelta.netPosition.raw < 0 ? 'text-red-400' : 'text-zinc-500'}`}>{c.dailyDelta.netPosition.raw > 0 ? '+' : ''}{c.dailyDelta.netPosition.raw.toLocaleString('en-IN')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ═══ Interpretation Guide ═══ */}
      <Card className="border-0" style={{ background: '#111823' }}>
        <CardContent className="p-3">
          <div className="text-[9px] font-mono leading-relaxed" style={{ color: '#4E5A6B' }}>
            <p className="mb-1"><span style={{ color: '#E9EEF3' }}>Institutional Positioning Engine</span> combines NSE Participant-wise OI, option chain OI change, Greeks, PCR, Max Pain, GEX, dealer positioning, and smart money concepts into a unified confidence score.</p>
            <p className="mb-1"><span style={{ color: '#E9EEF3' }}>Confidence ≥ 70</span>: Institutional alignment confirmed — proceed with direction. <span style={{ color: '#E9EEF3' }}>Confidence 40-70</span>: Partial alignment — apply normal risk management. <span style={{ color: '#E9EEF3' }}>Confidence &lt; 40</span>: Conflicting signals — reduce size or wait.</p>
            <p><span style={{ color: '#E9EEF3' }}>Data source:</span> NSE Participant-wise OI CSV (published ~6 PM IST) · Historical DB (Prisma SQLite, append-only).</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
