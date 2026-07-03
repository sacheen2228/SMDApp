// SDM Options Intelligence Panel
// Full institutional AI dashboard — dedicated tab view

'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Shield,
  Zap,
  BarChart3,
  Activity,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Lock,
  Layers,
  Brain,
  Crosshair,
} from 'lucide-react';
import type { FullAnalysis, StrikeOI, GammaWall, MoneyFlow, SDMScore, TradeRecommendation } from '@/lib/sdm-engine';

interface SDMOptionsPanelProps {
  analysis: FullAnalysis | null;
  chainData?: any[];
  loading?: boolean;
}

// ─── Main Component ──────────────────────────────────────────────
export function SDMOptionsPanel({ analysis, chainData, loading }: SDMOptionsPanelProps) {
  if (loading || !analysis) {
    return (
      <div className="flex items-center justify-center h-full min-h-[500px]">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground">
            {loading ? 'Running SDM Analysis...' : 'Select expiry to start analysis'}
          </p>
        </div>
      </div>
    );
  }

  const { recommendation, sdm, spot, expiry, oiAnalysis, gammaWalls, moneyFlow, greeks, strikes } = analysis;
  const isBullish = recommendation.action === 'BUY CALL';
  const isBearish = recommendation.action === 'BUY PUT';
  const isNoTrade = recommendation.action === 'NO TRADE' || recommendation.action === 'WAIT';

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* ═══════ SDM Header ═══════ */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/25">
              <Brain className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-2xl font-black tracking-tight">SDM OPTIONS AI</h1>
          </div>
          <p className="text-xs text-muted-foreground">Institutional Smart Decision Matrix Engine</p>
        </div>

        {/* ═══════ Top Metrics Strip ═══════ */}
        <div className="grid grid-cols-3 gap-3">
          <MetricCard label="Spot" value={spot.spot.toLocaleString('en-IN')} icon={<Activity className="h-3.5 w-3.5" />} />
          <MetricCard label="Current Expiry" value={expiry.label} sub={`${expiry.daysToExpiry}d left`} icon={<Clock className="h-3.5 w-3.5" />} />
          <MetricCard label="ATM" value={spot.atmStrike.toLocaleString('en-IN')} icon={<Crosshair className="h-3.5 w-3.5" />} highlight />
        </div>

        {/* ═══════ Recommendation Card ═══════ */}
        <Card className={`border-2 overflow-hidden ${
          isBullish ? 'border-emerald-500/40 shadow-lg shadow-emerald-500/10' :
          isBearish ? 'border-red-500/40 shadow-lg shadow-red-500/10' :
          'border-border'
        }`}>
          <div className={`px-4 py-2 ${
            isBullish ? 'bg-gradient-to-r from-emerald-500/10 to-emerald-500/5' :
            isBearish ? 'bg-gradient-to-r from-red-500/10 to-red-500/5' :
            'bg-muted/30'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className={`h-4 w-4 ${isBullish ? 'text-emerald-500' : isBearish ? 'text-red-500' : 'text-muted-foreground'}`} />
                <span className="text-xs font-bold tracking-widest uppercase">Recommendation</span>
              </div>
              <Badge className={`${getConfidenceBadge(recommendation.confidence)} text-white text-xs`}>
                {recommendation.confidence}% Confidence
              </Badge>
            </div>
          </div>
          <CardContent className="p-4">
            <div className="grid grid-cols-12 gap-4 items-center">
              {/* Action */}
              <div className="col-span-3 text-center">
                <div className={`text-2xl font-black ${
                  isBullish ? 'text-emerald-500' : isBearish ? 'text-red-500' : 'text-muted-foreground'
                }`}>
                  {recommendation.action}
                </div>
                {recommendation.optionType && (
                  <div className="text-lg font-bold mt-1">
                    {recommendation.strike} {recommendation.optionType}
                  </div>
                )}
              </div>

              <div className="col-span-1"><Separator orientation="vertical" className="h-16 mx-auto" /></div>

              {/* Key Stats */}
              <div className="col-span-2 space-y-1.5">
                <StatRow label="SDM" value={`${recommendation.sdmScore}/100`} />
                <StatRow label="Risk" value={recommendation.riskLevel || 'MEDIUM'} color={getRiskColor(recommendation.riskLevel || 'MEDIUM')} />
                <StatRow label="PCR" value={oiAnalysis.pcr.toFixed(2)} color={oiAnalysis.pcr > 1.2 ? 'text-emerald-500' : oiAnalysis.pcr < 0.7 ? 'text-red-500' : ''} />
              </div>

              <div className="col-span-1"><Separator orientation="vertical" className="h-16 mx-auto" /></div>

              {/* Money Flow & Build-up */}
              <div className="col-span-2 space-y-1.5">
                <StatRow label="OI" value={oiAnalysis.sentiment.toUpperCase()} color={oiAnalysis.sentiment === 'bullish' ? 'text-emerald-500' : oiAnalysis.sentiment === 'bearish' ? 'text-red-500' : ''} />
                <StatRow label="Money Flow" value={moneyFlow.direction.toUpperCase()} color={moneyFlow.direction === 'bullish' ? 'text-emerald-500' : moneyFlow.direction === 'bearish' ? 'text-red-500' : ''} />
                <StatRow label="OI Build-up" value={formatClassification(recommendation.oibuildup || 'NEUTRAL')} />
              </div>

              <div className="col-span-1"><Separator orientation="vertical" className="h-16 mx-auto" /></div>

              {/* Gamma Walls */}
              <div className="col-span-2 space-y-1.5">
                <StatRow label="Gamma Wall" value={`${recommendation.gammaWallSupport} Support`} color="text-emerald-500" />
                <StatRow label="" value={`${recommendation.gammaWallResistance} Resistance`} color="text-red-500" />
                <StatRow label="Max Pain" value={oiAnalysis.maxPain.toLocaleString('en-IN')} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ═══════ Entry / SL / Targets ═══════ */}
        {recommendation.optionType && (
          <div className="grid grid-cols-4 gap-3">
            {/* Entry */}
            <Card className="border-primary/20">
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-xs font-bold flex items-center gap-1 text-primary">
                  <Target className="h-3 w-3" /> Entry
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-1 space-y-1.5">
                <div className="text-2xl font-black">₹{recommendation.entryPrice}</div>
                <div className="text-xs text-muted-foreground">
                  Range: ₹{recommendation.idealBuyRange?.low ?? '—'} – ₹{recommendation.idealBuyRange?.high ?? '—'}
                </div>
                {recommendation.lateEntryWarning && (
                  <div className="flex items-center gap-1 text-[10px] text-amber-500">
                    <AlertTriangle className="h-2.5 w-2.5" /> Late entry — expiry within 24h
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Stop Loss */}
            <Card className="border-red-500/20">
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-xs font-bold flex items-center gap-1 text-red-500">
                  <Shield className="h-3 w-3" /> Stop Loss
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-1 space-y-1.5">
                <div className="text-2xl font-black text-red-500">₹{recommendation.stopLoss}</div>
                <div className="text-[10px] text-muted-foreground leading-tight">{recommendation.stopLossReason}</div>
              </CardContent>
            </Card>

            {/* TP1 & TP2 */}
            <Card className="border-emerald-500/20">
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-xs font-bold flex items-center gap-1 text-emerald-500">
                  <TrendingUp className="h-3 w-3" /> Targets
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-1 space-y-1">
                <div className="flex justify-between items-baseline">
                  <span className="text-xs text-muted-foreground">TP1 (+{recommendation.tp1Pct}%)</span>
                  <span className="text-lg font-black">₹{recommendation.tp1}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-xs text-muted-foreground">TP2 (+{recommendation.tp2Pct}%)</span>
                  <span className="text-lg font-black">₹{recommendation.tp2}</span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-xs text-muted-foreground">TP3 (+{recommendation.tp3Pct}%)</span>
                  <span className="text-lg font-black">₹{recommendation.tp3}</span>
                </div>
                {recommendation.trailingTarget && (
                  <div className="text-[10px] text-primary font-medium">Trailing Target Enabled</div>
                )}
              </CardContent>
            </Card>

            {/* Reasons */}
            <Card>
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-xs font-bold flex items-center gap-1">
                  <Layers className="h-3 w-3" /> Reasons
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 pt-1">
                <div className="space-y-1">
                  {recommendation.reasons.map((reason, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs">
                      <CheckCircle className="h-3 w-3 text-emerald-500 shrink-0" />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ═══════ SDM Score Breakdown ═══════ */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              SDM Score Breakdown
              <Badge className="ml-auto bg-primary/20 text-primary">{sdm.total}/100</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <Progress value={sdm.total} className="h-3 mb-4" />
            <div className="grid grid-cols-3 gap-3">
              {SDM_WEIGHTS.map(([key, weight, label]) => (
                <div key={key} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                  <div>
                    <div className="text-xs font-medium">{label}</div>
                    <div className="text-[10px] text-muted-foreground">{weight}%</div>
                  </div>
                  <div className="text-sm font-bold">{sdm.breakdown[key] || 0}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ═══════ Greeks Dashboard ═══════ */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Greeks Dashboard
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="grid grid-cols-4 gap-4">
              <GreeksCard label="IV Rank" value={`${greeks.ivRank}%`} sub="Implied Volatility Rank" />
              <GreeksCard label="IV Percentile" value={`${greeks.ivPercentile}%`} sub="IV Percentile" />
              <GreeksCard label="Greeks Score" value={`${greeks.overallGreeksScore}`} sub="Combined Score" />
              <GreeksCard label="IV Score" value={`${greeks.ivScore}`} sub="Volatility Score" />
            </div>
          </CardContent>
        </Card>

        {/* ═══════ Strike List with OI & Greeks ═══════ */}
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" />
              Strike Intelligence
              <span className="text-xs font-normal text-muted-foreground ml-auto">
                Showing {strikes.length} strikes
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] font-semibold text-muted-foreground">
                    <th className="px-2 py-1.5 text-right">Call OI</th>
                    <th className="px-2 py-1.5 text-right">Call Chg</th>
                    <th className="px-2 py-1.5 text-right">Call Vol</th>
                    <th className="px-2 py-1.5 text-right">Call LTP</th>
                    <th className="px-2 py-1.5 text-right">Δ</th>
                    <th className="px-2 py-1.5 text-right">Θ</th>
                    <th className="px-2 py-1.5 text-center font-bold text-primary">Strike</th>
                    <th className="px-2 py-1.5 text-left">Δ</th>
                    <th className="px-2 py-1.5 text-left">Θ</th>
                    <th className="px-2 py-1.5 text-left">Put LTP</th>
                    <th className="px-2 py-1.5 text-left">Put Vol</th>
                    <th className="px-2 py-1.5 text-left">Put Chg</th>
                    <th className="px-2 py-1.5 text-left">Put OI</th>
                    <th className="px-2 py-1.5 text-center">Sentiment</th>
                    <th className="px-2 py-1.5 text-center">Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {strikes.map((s) => {
                    const isATM = s.strike === spot.atmStrike;
                    const isRecommended = s.strike === recommendation.strike;
                    return (
                      <tr
                        key={s.strike}
                        className={`border-b border-border/30 transition-colors ${
                          isATM ? 'bg-primary/8' : isRecommended ? 'bg-emerald-500/8' : 'hover:bg-accent/20'
                        }`}
                      >
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatOI(s.callOI)}</td>
                        <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${s.callOIChange > 0 ? 'text-red-500' : s.callOIChange < 0 ? 'text-emerald-500' : ''}`}>
                          {s.callOIChange > 0 ? '+' : ''}{formatOI(s.callOIChange)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{formatOI(s.callVolume)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold">
                          {chainData?.find((c: any) => c.strike === s.strike)?.ce?.ltp?.toFixed(1) || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground/60">
                          {chainData?.find((c: any) => c.strike === s.strike)?.ce?.delta?.toFixed(3) || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground/60">
                          {chainData?.find((c: any) => c.strike === s.strike)?.ce?.theta?.toFixed(2) || '—'}
                        </td>

                        <td className={`px-2 py-1.5 text-center font-bold font-mono tabular-nums ${
                          isATM ? 'bg-primary/15 text-primary text-sm' : isRecommended ? 'text-emerald-500 text-sm' : ''
                        }`}>
                          {s.strike}
                          {isATM && <span className="ml-1 text-[8px] text-primary/70">ATM</span>}
                          {isRecommended && <span className="ml-1 text-[8px] text-emerald-500">★</span>}
                        </td>

                        <td className="px-2 py-1.5 text-left font-mono text-muted-foreground/60">
                          {chainData?.find((c: any) => c.strike === s.strike)?.pe?.delta?.toFixed(3) || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-left font-mono text-muted-foreground/60">
                          {chainData?.find((c: any) => c.strike === s.strike)?.pe?.theta?.toFixed(2) || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-left font-mono tabular-nums font-semibold">
                          {chainData?.find((c: any) => c.strike === s.strike)?.pe?.ltp?.toFixed(1) || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-left font-mono tabular-nums text-muted-foreground">{formatOI(s.putVolume)}</td>
                        <td className={`px-2 py-1.5 text-left font-mono tabular-nums ${s.putOIChange > 0 ? 'text-red-500' : s.putOIChange < 0 ? 'text-emerald-500' : ''}`}>
                          {s.putOIChange > 0 ? '+' : ''}{formatOI(s.putOIChange)}
                        </td>
                        <td className="px-2 py-1.5 text-left font-mono tabular-nums">{formatOI(s.putOI)}</td>

                        <td className="px-2 py-1.5 text-center">
                          <Badge variant="outline" className={`text-[9px] ${getSentimentBadge(s.sentiment)}`}>
                            {s.sentiment === 'bullish' ? '▲' : s.sentiment === 'bearish' ? '▼' : '—'} {s.sentiment.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <Badge variant="outline" className={`text-[9px] ${getClassificationBadge(s.classification)}`}>
                            {formatClassification(s.classification)}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ═══════ Gamma Walls ═══════ */}
        {gammaWalls.length > 0 && (
          <Card>
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Lock className="h-4 w-4 text-primary" />
                Gamma Walls
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 pt-0">
              <div className="grid grid-cols-3 gap-3">
                {gammaWalls.slice(0, 6).map((wall, i) => (
                  <div key={i} className={`p-2 rounded-lg border ${
                    wall.type === 'support' ? 'border-emerald-500/30 bg-emerald-500/5' :
                    wall.type === 'resistance' ? 'border-red-500/30 bg-red-500/5' :
                    'border-amber-500/30 bg-amber-500/5'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold">{wall.strike}</span>
                      <Badge variant="outline" className={`text-[9px] ${
                        wall.type === 'support' ? 'text-emerald-500' :
                        wall.type === 'resistance' ? 'text-red-500' : 'text-amber-500'
                      }`}>
                        {wall.type === 'support' ? '▲' : wall.type === 'resistance' ? '▼' : '◎'} {wall.type.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">{wall.description}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Helper Sub-components ──────────────────────────────────────
function MetricCard({ label, value, sub, icon, highlight }: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={`p-3 rounded-lg border ${highlight ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-black ${highlight ? 'text-primary' : ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className={`font-bold ${color || ''}`}>{value}</span>
    </div>
  );
}

function GreeksCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="p-3 rounded-lg bg-muted/30 text-center">
      <div className="text-[10px] text-muted-foreground mb-1">{label}</div>
      <div className="text-xl font-black">{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────
const SDM_WEIGHTS: [string, number, string][] = [
  ['trend', 20, 'Trend'],
  ['optionChain', 20, 'Option Chain'],
  ['greeks', 15, 'Greeks'],
  ['oiBuildup', 15, 'OI Build-up'],
  ['gammaWall', 10, 'Gamma Wall'],
  ['liquiditySweep', 5, 'Liquidity Sweep'],
  ['orderBlock', 5, 'Order Block'],
  ['volume', 5, 'Volume'],
  ['moonCycle', 5, 'Moon Cycle'],
];

function formatOI(oi: number): string {
  if (oi >= 10000000) return (oi / 10000000).toFixed(1) + ' Cr';
  if (oi >= 100000) return (oi / 100000).toFixed(1) + ' L';
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return oi.toString();
}

function formatClassification(c: string): string {
  if (!c) return 'N/A';
  return c.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getConfidenceBadge(conf: number): string {
  if (conf >= 80) return 'bg-emerald-600';
  if (conf >= 60) return 'bg-amber-600';
  return 'bg-red-600';
}

function getRiskColor(risk: string): string {
  switch (risk) {
    case 'LOW': return 'text-emerald-500';
    case 'MEDIUM': return 'text-amber-500';
    case 'HIGH': return 'text-orange-500';
    case 'EXTREME': return 'text-red-500';
    default: return '';
  }
}

function getSentimentBadge(s: string): string {
  if (s === 'bullish') return 'text-emerald-500';
  if (s === 'bearish') return 'text-red-500';
  return 'text-muted-foreground';
}

function getClassificationBadge(c: string): string {
  if (c === 'long-buildup') return 'text-emerald-500';
  if (c === 'short-buildup') return 'text-red-500';
  if (c === 'long-unwinding') return 'text-amber-500';
  if (c === 'short-covering') return 'text-blue-500';
  return 'text-muted-foreground';
}
