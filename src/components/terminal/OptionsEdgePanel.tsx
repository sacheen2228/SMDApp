'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowUp, ArrowDown, Minus, AlertTriangle, Zap, Target, Shield, TrendingUp, TrendingDown, Activity } from 'lucide-react';
import type { DynamicOptionsResult, DynamicStrikeAnalysis, StrikeCandidate, TradeDecision, PremiumMeltAlert, GammaAlert } from '@/lib/dynamic-options-engine';

const fmtNum = (n: number, d = 2) => {
  if (n === undefined || n === null || isNaN(n)) return '0';
  return n.toFixed(d);
};

const fmtPct = (n: number) => fmtNum(n) + '%';
const fmtRs = (n: number) => '₹' + fmtNum(n);
const fmtOI = (n: number) => {
  if (n >= 1e7) return (n / 1e5).toFixed(1) + 'L';
  if (n >= 1e5) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
};

const meltColor = (level: string) => {
  switch (level) {
    case 'EXTREME': return 'text-red-500 bg-red-500/10 border-red-500/30';
    case 'HIGH': return 'text-orange-500 bg-orange-500/10 border-orange-500/30';
    case 'MEDIUM': return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
    default: return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30';
  }
};

const ivStateColor = (state: string) => {
  switch (state) {
    case 'CRUSH': return 'text-red-500';
    case 'CONTRACTION': return 'text-orange-500';
    case 'EXPANSION': return 'text-emerald-500';
    default: return 'text-gray-400';
  }
};

const actionColor = (action: string) => {
  switch (action) {
    case 'BUY_CE': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
    case 'BUY_PE': return 'bg-red-500/20 text-red-400 border-red-500/50';
    case 'BUY_BOTH': return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
    default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
  }
};

interface OptionsEdgePanelProps {
  symbol?: string;
  onTrade?: (strike: number, type: 'CE' | 'PE', ltp: number) => void;
}

export default function OptionsEdgePanel({ symbol = 'NIFTY', onTrade }: OptionsEdgePanelProps) {
  const [data, setData] = useState<DynamicOptionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState(symbol);

  const fetchData = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/options-edge?symbol=${selectedSymbol}`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setError(null);
      } else {
        setError(json.error || 'Failed to load');
      }
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 300000);
    return () => clearInterval(interval);
  }, [selectedSymbol]);

  if (loading && !data) {
    return (
      <Card className="bg-black/50 border-gray-800">
        <CardContent className="p-6 text-center text-gray-400">
          <Activity className="h-6 w-6 animate-pulse mx-auto mb-2" />
          Loading Options Edge Engine...
        </CardContent>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card className="bg-black/50 border-gray-800">
        <CardContent className="p-6 text-center text-red-400">
          {error}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const { tradeDecision: td, strikeComparison: sc, strikeAnalyses: sa, directionResult: dr, heroZero: hz, straddleAnalysis: str, premiumMeltAlert: pma, gammaAlert: ga, expiryMode: em } = data;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-blue-500" />
          <h3 className="text-sm font-semibold">Dynamic Options Engine</h3>
        </div>
        <div className="flex gap-1">
          {['NIFTY', 'SENSEX', 'BANKNIFTY'].map(s => (
            <button
              key={s}
              onClick={() => setSelectedSymbol(s)}
              className={`px-2 py-0.5 text-xs rounded ${selectedSymbol === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {pma?.active && (
        <div className={`p-2 rounded border text-sm font-medium ${pma.level === 'EXTREME' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'}`}>
          {pma.message}
          <span className="text-xs font-normal ml-2">Theta: High | IV: {pma.ivFalling ? 'Falling' : 'Stable'} | Premium: {pma.premiumDeclining ? 'Declining' : 'Stable'}</span>
        </div>
      )}

      {ga?.active && (
        <div className="p-2 rounded border bg-purple-500/10 border-purple-500/30 text-purple-400 text-sm font-medium">
          {ga.message}
          <span className="text-xs font-normal ml-2">Delta accel: {ga.deltaAcceleration ? 'Yes' : 'No'} | Premium accel: {ga.premiumAcceleration ? 'Yes' : 'No'}</span>
        </div>
      )}

      <Card className="bg-black/50 border-gray-800">
        <CardContent className="p-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-xs text-gray-500">Action</div>
              <Badge variant="outline" className={`text-sm mt-1 ${actionColor(td.action)}`}>{td.action.replace('_', ' ')}</Badge>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500">Strike</div>
              <div className="text-lg font-bold text-white">{td.strike}</div>
              <div className="text-xs text-gray-400">{td.optionType} {td.strikeType}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500">Edge Score</div>
              <div className={`text-2xl font-bold ${td.optionsEdgeScore >= 70 ? 'text-emerald-400' : td.optionsEdgeScore >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                {td.optionsEdgeScore}<span className="text-xs">/100</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-gray-500">R:R</div>
              <div className="text-lg font-bold text-blue-400">1:{td.riskReward}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 md:grid-cols-7 gap-1 text-center">
        {[
          { label: 'Delta', value: fmtNum(td.delta, 4), icon: <ArrowUp className="h-3 w-3 inline" /> },
          { label: 'Gamma', value: fmtNum(td.gamma, 4), icon: <Zap className="h-3 w-3 inline" /> },
          { label: 'Theta', value: fmtNum(td.theta, 2), icon: <TrendingDown className="h-3 w-3 inline" /> },
          { label: 'Vega', value: fmtNum(td.vega, 2), icon: <Activity className="h-3 w-3 inline" /> },
          { label: 'IV', value: fmtPct(td.iv), icon: <TrendingUp className="h-3 w-3 inline" /> },
          { label: 'Melt', value: td.premiumMelt, icon: <AlertTriangle className="h-3 w-3 inline" />, color: meltColor(td.premiumMelt) },
          { label: 'Exp Move', value: fmtRs(td.expectedPremiumMove), icon: <Target className="h-3 w-3 inline" /> },
        ].map((item, i) => (
          <div key={i} className={`p-1.5 rounded border ${item.color || 'bg-gray-900 border-gray-800'}`}>
            <div className="text-xs text-gray-500">{item.icon} {item.label}</div>
            <div className="text-xs font-bold text-white truncate">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1 text-center text-xs">
        <div className="p-1.5 rounded bg-gray-900 border border-gray-800">
          <div className="text-gray-500">Entry</div>
          <div className="text-white font-bold">{fmtRs(td.entry)}</div>
        </div>
        <div className="p-1.5 rounded bg-red-900/20 border border-red-800/30">
          <div className="text-gray-500">Stop Loss</div>
          <div className="text-red-400 font-bold">{fmtRs(td.stopLoss)}</div>
        </div>
        <div className="p-1.5 rounded bg-emerald-900/20 border border-emerald-800/30">
          <div className="text-gray-500">Target 1</div>
          <div className="text-emerald-400 font-bold">{fmtRs(td.target1)}</div>
        </div>
      </div>

      <Tabs defaultValue="comparison">
        <TabsList className="grid grid-cols-5 h-7 text-xs bg-gray-900">
          <TabsTrigger value="comparison" className="text-xs">ITM/ATM/OTM</TabsTrigger>
          <TabsTrigger value="delta" className="text-xs">Delta Impact</TabsTrigger>
          <TabsTrigger value="gamma" className="text-xs">Gamma</TabsTrigger>
          <TabsTrigger value="melt" className="text-xs">Melt</TabsTrigger>
          <TabsTrigger value="extras" className="text-xs">More</TabsTrigger>
        </TabsList>

        <TabsContent value="comparison">
          <Card className="bg-black/50 border-gray-800">
            <CardContent className="p-2">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="p-1 text-left">Strike</th>
                      <th className="p-1 text-right">Delta</th>
                      <th className="p-1 text-right">Gamma</th>
                      <th className="p-1 text-right">Theta</th>
                      <th className="p-1 text-right">IV</th>
                      <th className="p-1 text-right">Melt</th>
                      <th className="p-1 text-right">Exp Move</th>
                      <th className="p-1 text-right">Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'ITM', data: sc.itm },
                      { label: 'ATM', data: sc.atm },
                      { label: 'OTM', data: sc.otm },
                    ].map(row => (
                      <tr key={row.label} className={`border-b border-gray-800/50 ${row.label === 'ATM' ? 'bg-amber-500/5' : ''}`}>
                        <td className="p-1">
                          <span className={`font-mono ${row.label === 'ATM' ? 'text-amber-400' : 'text-gray-300'}`}>{row.data.strike}</span>
                          <Badge variant="outline" className={`ml-1 text-[10px] ${row.label === 'ATM' ? 'text-amber-400 border-amber-500/30' : row.label === 'ITM' ? 'text-emerald-400 border-emerald-500/30' : 'text-gray-400 border-gray-600/30'}`}>
                            {row.label}
                          </Badge>
                        </td>
                        <td className="p-1 text-right font-mono text-gray-300">{fmtNum(row.data.delta, 4)}</td>
                        <td className="p-1 text-right font-mono text-gray-300">{fmtNum(row.data.gamma, 4)}</td>
                        <td className="p-1 text-right font-mono text-gray-300">{fmtNum(row.data.theta, 2)}</td>
                        <td className="p-1 text-right font-mono text-gray-300">{fmtPct(row.data.iv)}</td>
                        <td className="p-1 text-right">
                          <Badge variant="outline" className={`text-[10px] ${meltColor(row.data.meltRisk)}`}>{row.data.meltRisk}</Badge>
                        </td>
                        <td className="p-1 text-right font-mono text-blue-400">{fmtRs(row.data.expectedMove)}</td>
                        <td className="p-1 text-right font-mono text-white font-bold">{row.data.edgeScore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="delta">
          <Card className="bg-black/50 border-gray-800">
            <CardContent className="p-2">
              <div className="text-xs text-gray-500 mb-2">Dynamic Delta Impact — if underlying moves X points</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="p-1 text-left">Spot Move</th>
                      <th className="p-1 text-right">Premium Impact</th>
                      <th className="p-1 text-right">New Premium Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(td.optionType === 'PE'
                      ? sa.find(a => a.strike === td.strike)?.pe.dynamicDeltaImpact || []
                      : sa.find(a => a.strike === td.strike)?.ce.dynamicDeltaImpact || []
                    ).map((d, i) => (
                      <tr key={i} className={`border-b border-gray-800/50 ${d.spotMove > 0 ? 'bg-emerald-500/5' : d.spotMove < 0 ? 'bg-red-500/5' : ''}`}>
                        <td className="p-1 font-mono">
                          <span className={d.spotMove > 0 ? 'text-emerald-400' : d.spotMove < 0 ? 'text-red-400' : 'text-gray-400'}>
                            {d.spotMove > 0 ? '+' : ''}{d.spotMove} ({d.spotMovePct > 0 ? '+' : ''}{fmtPct(d.spotMovePct)})
                          </span>
                        </td>
                        <td className={`p-1 text-right font-mono ${d.premiumImpact > 0 ? 'text-emerald-400' : d.premiumImpact < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                          {d.premiumImpact > 0 ? '+' : ''}{fmtRs(d.premiumImpact)}
                        </td>
                        <td className="p-1 text-right font-mono text-white">{fmtRs(d.newPremiumEstimate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="gamma">
          <Card className="bg-black/50 border-gray-800">
            <CardContent className="p-2">
              <div className="text-xs text-gray-500 mb-2">Gamma Projection — second-order premium estimation (ΔPremium ≈ Δ × move + 0.5 × Γ × move²)</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="p-1 text-left">Move</th>
                      <th className="p-1 text-right">Δ Change</th>
                      <th className="p-1 text-right">1st Order</th>
                      <th className="p-1 text-right">2nd Order</th>
                      <th className="p-1 text-right">Total ΔPremium</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(td.optionType === 'PE'
                      ? sa.find(a => a.strike === td.strike)?.pe.gammaProjection || []
                      : sa.find(a => a.strike === td.strike)?.ce.gammaProjection || []
                    ).map((g, i) => (
                      <tr key={i} className={`border-b border-gray-800/50 ${g.totalPremiumChange > 0 ? 'bg-emerald-500/5' : 'bg-red-500/5'}`}>
                        <td className="p-1 font-mono text-gray-300">{g.spotMove > 0 ? '+' : ''}{g.spotMove}</td>
                        <td className="p-1 text-right font-mono text-yellow-400">{g.deltaChange > 0 ? '+' : ''}{fmtNum(g.deltaChange, 4)}</td>
                        <td className="p-1 text-right font-mono text-gray-300">{g.firstOrderPremium > 0 ? '+' : ''}{fmtRs(g.firstOrderPremium)}</td>
                        <td className="p-1 text-right font-mono text-purple-400">{g.secondOrderPremium > 0 ? '+' : ''}{fmtRs(g.secondOrderPremium)}</td>
                        <td className={`p-1 text-right font-mono font-bold ${g.totalPremiumChange > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {g.totalPremiumChange > 0 ? '+' : ''}{fmtRs(g.totalPremiumChange)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="melt">
          <Card className="bg-black/50 border-gray-800">
            <CardContent className="p-2 space-y-2">
              <div className="text-xs text-gray-500 mb-2">Premium Melt Analysis</div>
              {td.optionType === 'PE'
                ? sa.filter(a => [td.strike - 100, td.strike, td.strike + 100].includes(a.strike)).map(a => (
                    <div key={a.strike} className="p-2 rounded border border-gray-800 bg-gray-900/50">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-mono text-gray-300">{a.strike}</span>
                        <Badge variant="outline" className={`text-[10px] ${meltColor(a.pe.premiumMeltScore.level)}`}>{a.pe.premiumMeltScore.level}</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div><span className="text-gray-500">Theta/Day:</span> <span className="text-red-400">{fmtRs(a.pe.premiumMeltScore.thetaDecay1Day)}</span></div>
                        <div><span className="text-gray-500">Theta/Exp:</span> <span className="text-red-400">{fmtRs(a.pe.premiumMeltScore.thetaDecayToExpiry)}</span></div>
                        <div><span className="text-gray-500">Decay%:</span> <span className="text-yellow-400">{fmtPct(a.pe.premiumMeltScore.timeDecayPct)}</span></div>
                        <div><span className="text-gray-500">IV Risk:</span> <span className="text-orange-400">{fmtPct(a.pe.premiumMeltScore.ivRisk * 100)}</span></div>
                        <div><span className="text-gray-500">Liquidity:</span> <span className="text-yellow-400">{fmtPct(a.pe.premiumMeltScore.liquidityRisk * 100)}</span></div>
                        <div><span className="text-gray-500">Strike Dist:</span> <span className="text-orange-400">{fmtPct(a.pe.premiumMeltScore.strikeDistanceRisk * 100)}</span></div>
                      </div>
                      <div className="text-[10px] text-gray-400 mt-1">{a.pe.premiumMeltScore.meltDescription}</div>
                    </div>
                  ))
                : sa.filter(a => [td.strike - 100, td.strike, td.strike + 100].includes(a.strike)).map(a => (
                    <div key={a.strike} className="p-2 rounded border border-gray-800 bg-gray-900/50">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-mono text-gray-300">{a.strike}</span>
                        <Badge variant="outline" className={`text-[10px] ${meltColor(a.ce.premiumMeltScore.level)}`}>{a.ce.premiumMeltScore.level}</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div><span className="text-gray-500">Theta/Day:</span> <span className="text-red-400">{fmtRs(a.ce.premiumMeltScore.thetaDecay1Day)}</span></div>
                        <div><span className="text-gray-500">Theta/Exp:</span> <span className="text-red-400">{fmtRs(a.ce.premiumMeltScore.thetaDecayToExpiry)}</span></div>
                        <div><span className="text-gray-500">Decay%:</span> <span className="text-yellow-400">{fmtPct(a.ce.premiumMeltScore.timeDecayPct)}</span></div>
                        <div><span className="text-gray-500">IV Risk:</span> <span className="text-orange-400">{fmtPct(a.ce.premiumMeltScore.ivRisk * 100)}</span></div>
                        <div><span className="text-gray-500">Liquidity:</span> <span className="text-yellow-400">{fmtPct(a.ce.premiumMeltScore.liquidityRisk * 100)}</span></div>
                        <div><span className="text-gray-500">Strike Dist:</span> <span className="text-orange-400">{fmtPct(a.ce.premiumMeltScore.strikeDistanceRisk * 100)}</span></div>
                      </div>
                      <div className="text-[10px] text-gray-400 mt-1">{a.ce.premiumMeltScore.meltDescription}</div>
                    </div>
                  ))
              }
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="extras">
          <Card className="bg-black/50 border-gray-800">
            <CardContent className="p-2 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2 rounded bg-gray-900 border border-gray-800">
                  <div className="text-gray-500 mb-1">Direction Score</div>
                  <div className="flex justify-between"><span className="text-emerald-400">CALL: {dr.callScore}</span><span className="text-red-400">PUT: {dr.putScore}</span></div>
                  <div className="text-gray-400 mt-1">Rec: {dr.recommendedDirection}</div>
                </div>
                <div className="p-2 rounded bg-gray-900 border border-gray-800">
                  <div className="text-gray-500 mb-1">Hero-Zero</div>
                  <Badge variant="outline" className={hz.qualifies ? 'text-emerald-400 border-emerald-500/30' : 'text-red-400 border-red-500/30'}>
                    {hz.qualifies ? 'QUALIFIES' : 'DOES NOT QUALIFY'}
                  </Badge>
                  <div className="text-gray-400 mt-1">{hz.reasons.length} reasons / {hz.rejectionReasons.length} rejections</div>
                </div>
              </div>

              {str && str.strategy !== 'NO_TRADE' && (
                <div className="p-2 rounded bg-gray-900 border border-gray-800 text-xs">
                  <div className="text-gray-500 mb-1">Straddle Analysis</div>
                  <div className="grid grid-cols-2 gap-1">
                    <div>CE Premium: {fmtRs(str.cePremium)}</div>
                    <div>PE Premium: {fmtRs(str.pePremium)}</div>
                    <div>Total Premium: {fmtRs(str.totalPremium)}</div>
                    <div>Required Move: {fmtRs(str.requiredMove)}</div>
                    <div>Upper BE: {fmtRs(str.upperBreakeven)}</div>
                    <div>Lower BE: {fmtRs(str.lowerBreakeven)}</div>
                    <div>Move Realistic: <span className={str.moveRealistic ? 'text-emerald-400' : 'text-red-400'}>{str.moveRealistic ? 'Yes' : 'No'}</span></div>
                    <div>Capital: {fmtRs(str.capitalRequired)}</div>
                  </div>
                </div>
              )}

              <div className="p-2 rounded bg-gray-900 border border-gray-800 text-xs">
                <div className="text-gray-500 mb-1">Reasoning</div>
                <ul className="space-y-0.5">
                  {td.reasoning.map((r, i) => (
                    <li key={i} className="text-gray-300">• {r}</li>
                  ))}
                </ul>
              </div>

              {td.optionType && (
                <div className="flex gap-2">
                  <button
                    onClick={() => onTrade?.(td.strike, td.optionType as 'CE' | 'PE', td.entry)}
                    className="flex-1 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium"
                  >
                    Trade {td.strike} {td.optionType} @ {fmtRs(td.entry)}
                  </button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="bg-black/50 border-gray-800">
        <CardContent className="p-2">
          <div className="text-xs text-gray-500 mb-2">Strike Heatmap — all strikes ranked by edge score</div>
          <ScrollArea className="h-64">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-gray-900">
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="p-1 text-left">Strike</th>
                  <th className="p-1 text-right">CE Δ</th>
                  <th className="p-1 text-right">CE Γ</th>
                  <th className="p-1 text-right">CE Θ</th>
                  <th className="p-1 text-right">CE IV</th>
                  <th className="p-1 text-right">CE Melt</th>
                  <th className="p-1 text-right">PE Δ</th>
                  <th className="p-1 text-right">PE Γ</th>
                  <th className="p-1 text-right">PE Θ</th>
                  <th className="p-1 text-right">PE IV</th>
                  <th className="p-1 text-right">PE Melt</th>
                  <th className="p-1 text-right">CE LTP</th>
                  <th className="p-1 text-right">PE LTP</th>
                </tr>
              </thead>
              <tbody>
                {sa.map(a => (
                  <tr key={a.strike} className={`border-b border-gray-800/30 ${a.strike === td.strike ? 'bg-blue-500/10' : a.strike === data.atmStrike ? 'bg-amber-500/5' : ''}`}>
                    <td className="p-1 font-mono text-gray-300">
                      {a.strike}
                      {a.strike === td.strike && <Badge className="ml-1 text-[8px] bg-blue-600">BEST</Badge>}
                      {a.strike === data.atmStrike && <Badge className="ml-1 text-[8px] bg-amber-600">ATM</Badge>}
                    </td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtNum(a.ce.delta, 3)}</td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtNum(a.ce.gamma, 4)}</td>
                    <td className="p-1 text-right font-mono text-red-400">{fmtNum(a.ce.theta, 1)}</td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtPct(a.ce.iv)}</td>
                    <td className="p-1 text-right"><Badge variant="outline" className={`text-[8px] ${meltColor(a.ce.premiumMeltScore.level)}`}>{a.ce.premiumMeltScore.level}</Badge></td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtNum(a.pe.delta, 3)}</td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtNum(a.pe.gamma, 4)}</td>
                    <td className="p-1 text-right font-mono text-red-400">{fmtNum(a.pe.theta, 1)}</td>
                    <td className="p-1 text-right font-mono text-gray-300">{fmtPct(a.pe.iv)}</td>
                    <td className="p-1 text-right"><Badge variant="outline" className={`text-[8px] ${meltColor(a.pe.premiumMeltScore.level)}`}>{a.pe.premiumMeltScore.level}</Badge></td>
                    <td className="p-1 text-right font-mono text-emerald-400">{fmtRs(a.ce.ltp)}</td>
                    <td className="p-1 text-right font-mono text-red-400">{fmtRs(a.pe.ltp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
