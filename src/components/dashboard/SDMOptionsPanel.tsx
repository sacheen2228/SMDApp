'use client';

import React from 'react';
import type { FullAnalysis, StrikeOI } from '@/lib/sdm-strategy';

interface SDMOptionsPanelProps {
  analysis: FullAnalysis | null;
  chainData?: any[];
  loading?: boolean;
}

function fmt(n: number): string {
  if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function fclass(c: string): string {
  if (!c) return 'N/A';
  return c.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function SDMOptionsPanel({ analysis, chainData, loading }: SDMOptionsPanelProps) {
  if (loading || !analysis) {
    return (
      <div className="flex items-center justify-center h-full min-h-[500px]">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-xl text-muted-foreground font-medium">
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

  const actionColor = isBullish ? 'emerald' : isBearish ? 'red' : 'gray';
  const actionBg = isBullish ? 'bg-emerald-500/10' : isBearish ? 'bg-red-500/10' : 'bg-muted/30';
  const actionBorder = isBullish ? 'border-emerald-500/30' : isBearish ? 'border-red-500/30' : 'border-border';

  const totalCallOI = analysis?.totalCallOI ?? 0;
  const totalCallVolume = analysis?.totalCallVolume ?? 0;
  const totalPutVolume = analysis?.totalPutVolume ?? 0;
  const totalPutOI = analysis?.totalPutOI ?? 0;

  const breakdownItems = [
    { label: 'PCR', value: sdm.breakdown["PCR"] || oiAnalysis.pcr.toFixed(2), color: oiAnalysis.pcr > 1.2 ? 'text-emerald-400' : oiAnalysis.pcr < 0.7 ? 'text-red-400' : 'text-amber-400' },
    { label: 'CE OI', value: sdm.breakdown["CE OI"] || fmt(totalCallOI), color: 'text-red-400' },
    { label: 'PE OI', value: sdm.breakdown["PE OI"] || fmt(totalPutOI), color: 'text-emerald-400' },
    { label: 'Call Vol', value: sdm.breakdown["Call Vol"] || fmt(totalCallVolume), color: 'text-muted-foreground' },
    { label: 'Put Vol', value: sdm.breakdown["Put Vol"] || fmt(totalPutVolume), color: 'text-muted-foreground' },
    { label: 'Max Pain', value: sdm.breakdown["Max Pain"] || oiAnalysis.maxPain.toLocaleString('en-IN'), color: 'text-blue-400' },
    { label: 'Sentiment', value: (sdm.breakdown["Sentiment"] || oiAnalysis.sentiment).toUpperCase(), color: oiAnalysis.sentiment === 'bullish' ? 'text-emerald-400' : oiAnalysis.sentiment === 'bearish' ? 'text-red-400' : 'text-amber-400' },
    { label: 'Money Flow', value: moneyFlow.direction.toUpperCase(), color: moneyFlow.direction === 'bullish' ? 'text-emerald-400' : moneyFlow.direction === 'bearish' ? 'text-red-400' : 'text-muted-foreground' },
    { label: 'OI Build-up', value: fclass(recommendation.oibuildup || 'NEUTRAL'), color: 'text-muted-foreground' },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between bg-muted/20 rounded-xl px-4 py-3 border border-border">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/25">
              <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight">SDM OPTIONS AI</h1>
              <p className="text-sm text-muted-foreground">Smart Decision Matrix Engine · {expiry.label} · {expiry.daysToExpiry}d left</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full border border-border">{spot.spot.toLocaleString('en-IN')}</span>
            <span className="text-sm font-bold bg-primary/10 px-3 py-1.5 rounded-full border border-primary/30">ATM {spot.atmStrike}</span>
          </div>
        </div>

        {/* Recommendation Card */}
        <div className={`rounded-xl border-2 ${actionBorder} ${actionBg} overflow-hidden`}>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm uppercase tracking-widest font-bold text-muted-foreground">Trade Signal</span>
                <span className={`text-sm font-bold ${recommendation.confidence >= 80 ? 'text-emerald-400' : recommendation.confidence >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                  {recommendation.confidence}% confidence
                </span>
              </div>
              <span className={`px-3 py-1 rounded-lg text-sm font-black ${
                recommendation.confidence >= 80 ? 'bg-emerald-600 text-white' :
                recommendation.confidence >= 60 ? 'bg-amber-600 text-white' :
                'bg-red-600 text-white'
              }`}>
                SDM {sdm.total}/100
              </span>
            </div>

            <div className="grid grid-cols-12 gap-3 items-center">
              <div className="col-span-3 text-center">
                <div className={`text-3xl font-black ${isBullish ? 'text-emerald-400' : isBearish ? 'text-red-400' : 'text-muted-foreground'}`}>
                  {recommendation.action}
                </div>
                {recommendation.optionType && (
                  <div className="flex items-center justify-center gap-2 mt-1">
                    <span className="text-xl font-black">{recommendation.strike}</span>
                    <span className={`px-2 py-0.5 rounded text-sm font-black ${isBullish ? 'bg-emerald-600 text-white' : isBearish ? 'bg-red-600 text-white' : 'bg-gray-600 text-white'}`}>
                      {recommendation.optionType}
                    </span>
                  </div>
                )}
                <span className={`text-sm font-bold mt-1 inline-block ${recommendation.riskLevel === 'LOW' ? 'text-emerald-400' : recommendation.riskLevel === 'MEDIUM' ? 'text-amber-400' : recommendation.riskLevel === 'HIGH' ? 'text-orange-400' : 'text-red-400'}`}>
                  {recommendation.riskLevel || 'MEDIUM'} RISK
                </span>
              </div>

              <div className="col-span-1 flex justify-center">
                <div className="w-px h-20 bg-border" />
              </div>

              <div className="col-span-3 space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">OI Sentiment</span>
                  <span className={`font-bold ${oiAnalysis.sentiment === 'bullish' ? 'text-emerald-400' : oiAnalysis.sentiment === 'bearish' ? 'text-red-400' : 'text-amber-400'}`}>
                    {oiAnalysis.sentiment.toUpperCase()}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">PCR</span>
                  <span className={`font-bold ${oiAnalysis.pcr > 1.2 ? 'text-emerald-400' : oiAnalysis.pcr < 0.7 ? 'text-red-400' : 'text-amber-400'}`}>{oiAnalysis.pcr.toFixed(2)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Max Pain</span>
                  <span className="font-bold">{oiAnalysis.maxPain.toLocaleString('en-IN')}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Money Flow</span>
                  <span className={`font-bold ${moneyFlow.direction === 'bullish' ? 'text-emerald-400' : moneyFlow.direction === 'bearish' ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {moneyFlow.direction.toUpperCase()}
                  </span>
                </div>
              </div>

              <div className="col-span-1 flex justify-center">
                <div className="w-px h-20 bg-border" />
              </div>

              <div className="col-span-4 space-y-1.5">
                {recommendation.gammaWallSupport && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Gamma Support</span>
                    <span className="font-bold text-emerald-400">{recommendation.gammaWallSupport.toLocaleString('en-IN')}</span>
                  </div>
                )}
                {recommendation.gammaWallResistance && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Gamma Resistance</span>
                    <span className="font-bold text-red-400">{recommendation.gammaWallResistance.toLocaleString('en-IN')}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">OI Build-up</span>
                  <span className="font-bold">{fclass(recommendation.oibuildup || 'NEUTRAL')}</span>
                </div>
                {recommendation.sdmScore !== undefined && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">SDM Score</span>
                    <span className="font-bold">{recommendation.sdmScore}/100</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Entry / SL / Targets / Reasons */}
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-muted/20 rounded-xl border border-primary/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              <span className="text-sm font-bold uppercase tracking-wider text-primary">Entry</span>
            </div>
            <div className="text-2xl font-black">₹{recommendation.entryPrice ?? '—'}</div>
            <div className="text-sm text-muted-foreground mt-1">
              Range: ₹{recommendation.idealBuyRange?.low ?? '—'} – ₹{recommendation.idealBuyRange?.high ?? '—'}
            </div>
            {recommendation.lateEntryWarning && (
              <div className="flex items-center gap-1.5 text-sm text-amber-400 mt-1 bg-amber-500/10 rounded-lg px-2 py-1">
                <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                Late entry — expiry within 24h
              </div>
            )}
          </div>

          <div className="bg-muted/20 rounded-xl border border-red-500/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              <span className="text-sm font-bold uppercase tracking-wider text-red-400">Stop Loss</span>
            </div>
            <div className="text-2xl font-black text-red-400">₹{recommendation.stopLoss ?? '—'}</div>
            <div className="text-sm text-muted-foreground mt-1 leading-snug">{recommendation.stopLossReason || 'No SL reason provided'}</div>
          </div>

          <div className="bg-muted/20 rounded-xl border border-emerald-500/20 p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
              <span className="text-sm font-bold uppercase tracking-wider text-emerald-400">Targets</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">TP1 (+{recommendation.tp1Pct ?? '?'}%)</span>
                <span className="text-lg font-black">₹{recommendation.tp1 ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">TP2 (+{recommendation.tp2Pct ?? '?'}%)</span>
                <span className="text-lg font-black">₹{recommendation.tp2 ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">TP3 (+{recommendation.tp3Pct ?? '?'}%)</span>
                <span className="text-lg font-black">₹{recommendation.tp3 ?? '—'}</span>
              </div>
              {recommendation.trailingTarget && (
                <span className="inline-block text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-lg mt-1">Trailing Target</span>
              )}
            </div>
          </div>

          <div className="bg-muted/20 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
              <span className="text-sm font-bold uppercase tracking-wider">Reasons</span>
            </div>
            <div className="space-y-1.5">
              {recommendation.reasons.length > 0 ? recommendation.reasons.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <svg className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span>{r}</span>
                </div>
              )) : (
                <span className="text-sm text-muted-foreground">No reasons provided</span>
              )}
            </div>
          </div>
        </div>

        {/* Greeks + Score row */}
        <div className="grid grid-cols-3 gap-2">
          {/* SDM Score Breakdown */}
          <div className="col-span-2 bg-muted/20 rounded-xl border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                <span className="text-base font-bold uppercase tracking-wider">Market Data</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-40 bg-muted rounded-full overflow-hidden border border-border">
                  <div className="h-full bg-gradient-to-r from-red-500 via-amber-500 to-emerald-500 rounded-full transition-all" style={{ width: `${sdm.total}%` }} />
                </div>
                <span className="text-base font-bold">{sdm.total}/100</span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {breakdownItems.map(item => (
                <div key={item.label} className="flex items-center justify-between bg-muted/30 rounded-lg px-2.5 py-2 border border-border/50">
                  <span className="text-sm text-muted-foreground">{item.label}</span>
                  <span className={`text-sm font-bold ${item.color}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Greeks Dashboard */}
          <div className="bg-muted/20 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /></svg>
              <span className="text-base font-bold uppercase tracking-wider">Greeks</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="bg-muted/30 rounded-lg border border-border/50 p-2.5 text-center">
                <div className="text-sm text-muted-foreground">IV Rank</div>
                <div className="text-lg font-black">{greeks.ivRank ?? '—'}%</div>
              </div>
              <div className="bg-muted/30 rounded-lg border border-border/50 p-2.5 text-center">
                <div className="text-sm text-muted-foreground">IV Pctl</div>
                <div className="text-lg font-black">{greeks.ivPercentile ?? '—'}%</div>
              </div>
              <div className="bg-muted/30 rounded-lg border border-border/50 p-2.5 text-center">
                <div className="text-sm text-muted-foreground">Greeks Σ</div>
                <div className="text-lg font-black">{greeks.overallGreeksScore ?? '—'}</div>
              </div>
              <div className="bg-muted/30 rounded-lg border border-border/50 p-2.5 text-center">
                <div className="text-sm text-muted-foreground">IV Score</div>
                <div className="text-lg font-black">{greeks.ivScore ?? '—'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Strike Intelligence */}
        <div className="bg-muted/20 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
              <span className="text-base font-bold uppercase tracking-wider">Strike Intelligence</span>
              <span className="text-sm text-muted-foreground bg-muted/30 px-2 py-0.5 rounded-full border border-border">{strikes.length} strikes</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-sm font-bold text-muted-foreground uppercase tracking-wider">
                  <th className="px-2.5 py-2 text-right">Call OI</th>
                  <th className="px-2.5 py-2 text-right">Chg</th>
                  <th className="px-2.5 py-2 text-right">LTP</th>
                  <th className="px-2.5 py-2 text-right">Δ</th>
                  <th className="px-2.5 py-2 text-center text-base text-primary">Strike</th>
                  <th className="px-2.5 py-2 text-left">Δ</th>
                  <th className="px-2.5 py-2 text-left">LTP</th>
                  <th className="px-2.5 py-2 text-left">Chg</th>
                  <th className="px-2.5 py-2 text-left">Put OI</th>
                  <th className="px-2.5 py-2 text-center">Signal</th>
                </tr>
              </thead>
              <tbody>
                {strikes.map((s: StrikeOI) => {
                  const isATM = s.strike === spot.atmStrike;
                  const isRecommended = s.strike === recommendation.strike;
                  const row = chainData?.find((c: any) => c.strike === s.strike);
                  return (
                    <tr key={s.strike} className={`border-b border-border/30 ${
                      isATM ? 'bg-primary/10' : isRecommended ? 'bg-emerald-500/10' : 'hover:bg-muted/30'
                    }`}>
                      <td className="px-2.5 py-2 text-right font-mono font-bold">{fmt(s.callOI)}</td>
                      <td className={`px-2.5 py-2 text-right font-mono font-bold ${s.callOIChange > 0 ? 'text-red-400' : s.callOIChange < 0 ? 'text-emerald-400' : ''}`}>
                        {s.callOIChange > 0 ? '+' : ''}{fmt(s.callOIChange)}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono font-bold">{row?.ce?.ltp?.toFixed(1) ?? '—'}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-muted-foreground">{row?.ce?.delta?.toFixed(2) ?? '—'}</td>
                      <td className={`px-2.5 py-2 text-center font-black text-base ${
                        isATM ? 'text-primary' : isRecommended ? 'text-emerald-400' : ''
                      }`}>
                        {s.strike}
                        {isATM && <span className="ml-1 text-xs text-primary/60 font-normal">ATM</span>}
                        {isRecommended && <span className="ml-1 text-xs text-emerald-400">★</span>}
                      </td>
                      <td className="px-2.5 py-2 text-left font-mono text-muted-foreground">{row?.pe?.delta?.toFixed(2) ?? '—'}</td>
                      <td className="px-2.5 py-2 text-left font-mono font-bold">{row?.pe?.ltp?.toFixed(1) ?? '—'}</td>
                      <td className={`px-2.5 py-2 text-left font-mono font-bold ${s.putOIChange > 0 ? 'text-red-400' : s.putOIChange < 0 ? 'text-emerald-400' : ''}`}>
                        {s.putOIChange > 0 ? '+' : ''}{fmt(s.putOIChange)}
                      </td>
                      <td className="px-2.5 py-2 text-left font-mono font-bold">{fmt(s.putOI)}</td>
                      <td className="px-2.5 py-2 text-center">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className={`text-sm font-bold ${s.sentiment === 'bullish' ? 'text-emerald-400' : s.sentiment === 'bearish' ? 'text-red-400' : 'text-muted-foreground'}`}>
                            {s.sentiment === 'bullish' ? '▲' : s.sentiment === 'bearish' ? '▼' : '◆'} {s.sentiment.toUpperCase()}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${
                            s.classification === 'long-buildup' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                            s.classification === 'short-buildup' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                            s.classification === 'long-unwinding' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' :
                            s.classification === 'short-covering' ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                            'bg-muted/30 text-muted-foreground border-border'
                          }`}>
                            {fclass(s.classification)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Gamma Walls */}
        {gammaWalls.length > 0 && (
          <div className="bg-muted/20 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              <span className="text-base font-bold uppercase tracking-wider">Gamma Walls</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {gammaWalls.slice(0, 6).map((wall, i) => (
                <div key={i} className={`rounded-xl border px-3 py-2.5 ${
                  wall.type === 'support' ? 'bg-emerald-500/[0.03] border-emerald-500/30' :
                  wall.type === 'resistance' ? 'bg-red-500/[0.03] border-red-500/30' :
                  'bg-amber-500/[0.03] border-amber-500/30'
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-lg font-black">{wall.strike.toLocaleString('en-IN')}</span>
                    <span className={`text-sm font-bold px-2 py-0.5 rounded-lg ${
                      wall.type === 'support' ? 'bg-emerald-500/15 text-emerald-400' :
                      wall.type === 'resistance' ? 'bg-red-500/15 text-red-400' :
                      'bg-amber-500/15 text-amber-400'
                    }`}>
                      {wall.type === 'support' ? '▲' : wall.type === 'resistance' ? '▼' : '◎'} {wall.type.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">{wall.description || '—'}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
