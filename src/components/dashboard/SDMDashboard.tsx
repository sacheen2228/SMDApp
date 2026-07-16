// SDM AI Dashboard Component
// Displays institutional option chain analysis

'use client';

import React, { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
} from 'lucide-react';
import type { FullAnalysis, TradeRecommendation } from '@/lib/sdm-strategy';

interface SDMDashboardProps {
  analysis: FullAnalysis | null;
  loading?: boolean;
}

export function SDMDashboard({ analysis, loading }: SDMDashboardProps) {
  if (loading || !analysis) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        {loading ? 'Analyzing market data...' : 'Select expiry to run SDM analysis'}
      </div>
    );
  }
  
  const { recommendation, sdm, spot, expiry, oiAnalysis, gammaWalls, moneyFlow, greeks } = analysis;
  
  return (
    <div className="space-y-3 p-3">
      {/* ─── Header Card ─── */}
      <Card className="border-2 border-primary/20">
        <CardHeader className="p-3 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              SDM OPTIONS AI
            </CardTitle>
            <Badge className={`${getConfidenceColor(recommendation.confidence)} text-white`}>
              {recommendation.confidence}%
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          {/* Key Metrics */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Spot</span>
              <span className="font-bold">{spot.spot.toLocaleString('en-IN')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">ATM</span>
              <span className="font-bold">{spot.atmStrike}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expiry</span>
              <span className="font-bold">{expiry.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Days</span>
              <span className="font-bold">{expiry.daysToExpiry}d</span>
            </div>
          </div>
          
          <Separator />
          
          {/* Recommendation */}
          <div className={`p-3 rounded-lg text-center ${
            recommendation.action === 'BUY CALL' ? 'bg-emerald-500/10 border border-emerald-500/30' :
            recommendation.action === 'BUY PUT' ? 'bg-red-500/10 border border-red-500/30' :
            'bg-muted/50 border border-border'
          }`}>
            <div className={`text-lg font-black ${
              recommendation.action === 'BUY CALL' ? 'text-emerald-500' :
              recommendation.action === 'BUY PUT' ? 'text-red-500' :
              'text-muted-foreground'
            }`}>
              {recommendation.action}
            </div>
            {recommendation.optionType && (
              <div className="text-2xl font-black mt-1">
                {recommendation.strike} {recommendation.optionType}
              </div>
            )}
            <div className="flex items-center justify-center gap-2 mt-2">
              <Badge className={getRiskColor(recommendation.riskLevel || 'MEDIUM')}>
                Risk: {recommendation.riskLevel || 'MEDIUM'}
              </Badge>
              <Badge className="bg-primary/20 text-primary">
                SDM: {recommendation.sdmScore}/100
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* ─── Entry / SL / Targets ─── */}
      {recommendation.optionType && (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold flex items-center gap-1">
              <Target className="h-3 w-3" /> Trade Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-2">
            {/* Entry */}
            <div className="bg-muted/30 rounded-lg p-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Entry</span>
                <span className="font-bold">₹{recommendation.entryPrice}</span>
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>Ideal Range</span>
                <span>
                  ₹{recommendation.idealBuyRange?.low ?? '—'} – ₹{recommendation.idealBuyRange?.high ?? '—'}
                </span>
              </div>
              {recommendation.lateEntryWarning && (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-500">
                  <AlertTriangle className="h-2.5 w-2.5" /> Late entry - expiry within 24h
                </div>
              )}
            </div>
            
            {/* Stop Loss */}
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1">
                <Shield className="h-3 w-3" /> Stop Loss
              </span>
              <span className="font-bold text-red-500">₹{recommendation.stopLoss}</span>
            </div>
            
            {/* Targets */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-emerald-500">TP1 (+{recommendation.tp1Pct}%)</span>
                <span className="font-bold">₹{recommendation.tp1}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-emerald-500">TP2 (+{recommendation.tp2Pct}%)</span>
                <span className="font-bold">₹{recommendation.tp2}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-emerald-500">TP3 (+{recommendation.tp3Pct}%)</span>
                <span className="font-bold">₹{recommendation.tp3}</span>
              </div>
              {recommendation.trailingTarget && (
                <div className="text-[10px] text-primary">Trailing Target Enabled</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* ─── SDM Score Breakdown ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold flex items-center gap-1">
            <BarChart3 className="h-3 w-3" /> SDM Score: {sdm.total}/100
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <Progress value={sdm.total} className="h-2 mb-2" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(sdm.breakdown).map(([key, value]) => (
              <div key={key} className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">{key}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      
      {/* ─── OI Analysis ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold flex items-center gap-1">
            <Activity className="h-3 w-3" /> Option Chain Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">PCR</span>
              <span className={`font-bold ${oiAnalysis.pcr > 1.2 ? 'text-emerald-500' : oiAnalysis.pcr < 0.7 ? 'text-red-500' : ''}`}>
                {oiAnalysis.pcr.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Max Pain</span>
              <span className="font-bold">{oiAnalysis.maxPain}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">CE OI</span>
              <span className="font-bold text-red-500">{formatOI(oiAnalysis.totalCallOI)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">PE OI</span>
              <span className="font-bold text-emerald-500">{formatOI(oiAnalysis.totalPutOI)}</span>
            </div>
          </div>
          
          <Separator />
          
          {/* Money Flow */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Money Flow</span>
            <Badge className={moneyFlow.direction === 'bullish' ? 'bg-emerald-600' : moneyFlow.direction === 'bearish' ? 'bg-red-600' : 'bg-muted'}>
              {moneyFlow.direction === 'bullish' ? <TrendingUp className="h-2.5 w-2.5 mr-1" /> : 
               moneyFlow.direction === 'bearish' ? <TrendingDown className="h-2.5 w-2.5 mr-1" /> :
               <Minus className="h-2.5 w-2.5 mr-1" />}
              {moneyFlow.direction.toUpperCase()}
            </Badge>
          </div>
          <div className="text-[10px] text-muted-foreground">{moneyFlow.smartMoneyDirection}</div>
          
          {/* Sentiment */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">OI Sentiment</span>
            <Badge className={oiAnalysis.sentiment === 'bullish' ? 'bg-emerald-600' : oiAnalysis.sentiment === 'bearish' ? 'red-600' : 'bg-muted'}>
              {oiAnalysis.sentiment.toUpperCase()}
            </Badge>
          </div>
        </CardContent>
      </Card>
      
      {/* ─── Gamma Walls ─── */}
      {gammaWalls.length > 0 && (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold">Gamma Walls</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 space-y-1">
            {gammaWalls.slice(0, 3).map((wall, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1">
                  {wall.type === 'support' ? (
                    <TrendingUp className="h-3 w-3 text-emerald-500" />
                  ) : wall.type === 'resistance' ? (
                    <TrendingDown className="h-3 w-3 text-red-500" />
                  ) : (
                    <Minus className="h-3 w-3 text-amber-500" />
                  )}
                  <span>{wall.strike}</span>
                </div>
                <Badge variant="outline" className="text-[9px]">
                  {wall.type.toUpperCase()}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      
      {/* ─── Greeks ─── */}
      <Card>
        <CardHeader className="p-3 pb-2">
          <CardTitle className="text-xs font-bold">Greeks Dashboard</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="text-center">
              <div className="text-muted-foreground text-[10px]">IV Rank</div>
              <div className="font-bold">{greeks.ivRank}%</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px]">IV Percentile</div>
              <div className="font-bold">{greeks.ivPercentile}%</div>
            </div>
            <div className="text-center">
              <div className="text-muted-foreground text-[10px]">Greeks Score</div>
              <div className="font-bold">{greeks.overallGreeksScore}</div>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* ─── Reasons ─── */}
      {recommendation.reasons.length > 0 && (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-bold">Analysis Reasons</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="space-y-1">
              {recommendation.reasons.map((reason, i) => (
                <div key={i} className="flex items-center gap-1 text-xs">
                  {reason.includes('Bullish') || reason.includes('Support') ? (
                    <CheckCircle className="h-3 w-3 text-emerald-500" />
                  ) : reason.includes('Bearish') || reason.includes('Resistance') ? (
                    <XCircle className="h-3 w-3 text-red-500" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  )}
                  <span>{reason}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────
function formatOI(oi: number): string {
  if (oi >= 10000000) return (oi / 10000000).toFixed(1) + ' Cr';
  if (oi >= 100000) return (oi / 100000).toFixed(1) + ' L';
  if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
  return oi.toString();
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 80) return 'bg-emerald-600';
  if (confidence >= 60) return 'bg-amber-600';
  return 'bg-red-600';
}

function getRiskColor(risk: string): string {
  switch (risk) {
    case 'LOW': return 'bg-emerald-600';
    case 'MEDIUM': return 'bg-amber-600';
    case 'HIGH': return 'bg-orange-600';
    case 'EXTREME': return 'bg-red-600';
    default: return 'bg-muted';
  }
}
