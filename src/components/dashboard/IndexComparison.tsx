'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface IndexComparisonData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  regime: string;
  regimeBias: string;
  auctionState: string;
  poc: number;
  vah: number;
  val: number;
  volume: number;
  relativeVolume: number;
  liquidity: string;
  structure: string;
  vwapState: string;
  vwapDistance: number;
  signalStrength: number;
  signalLabel: string;
  historicalExpectancy: number;
  timestamp: number;
}

interface RelativeStrengthData {
  base: string;
  target: string;
  ratio: number;
  change: number;
  status: string;
  interpretation: string;
}

interface MarketRankingData {
  rank: number;
  symbol: string;
  name: string;
  signalStrength: number;
  signalLabel: string;
  regime: string;
  bestInstrument: string;
  instrumentReason: string;
  liquidity: number;
  rr: number;
  expectedMove: number;
  capitalEfficiency: number;
  historicalExpectancy: number;
  totalScore: number;
}

interface ComparisonResponse {
  success: boolean;
  data: {
    comparison: IndexComparisonData[];
    relativeStrength: RelativeStrengthData[];
    ranking: MarketRankingData[];
    timestamp: number;
  };
}

export function IndexComparison() {
  const [data, setData] = useState<ComparisonResponse['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState('5m');

  const COLORS = {
    BULLISH: '#26a69a',
    BEARISH: '#ef5350',
    NEUTRAL: '#ffa726',
    TRANSITION: '#78909c',
  };

  const SIGNAL_COLORS = {
    'A+': '#00e676',
    'A': '#26a69a',
    'B': '#ffa726',
    'WATCH': '#ff9800',
    'NO_TRADE': '#78909c',
  };

  const REGIME_COLORS: Record<string, string> = {
    TRENDING_UP: '#26a69a',
    TRENDING_DOWN: '#ef5350',
    BREAKOUT: '#00e676',
    FAILED_BREAKOUT: '#ef5350',
    REVERSAL: '#ff5722',
    ACCUMULATION: '#4caf50',
    DISTRIBUTION: '#f44336',
    BALANCED: '#ffa726',
    RANGING: '#ffa726',
    HIGH_VOLATILITY: '#ff5722',
    LOW_VOLATILITY: '#64b5f6',
    TRANSITION: '#78909c',
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/index-comparison?interval=${interval}&limit=300`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || 'Failed to fetch');
      }
    } catch (e) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 30000);
    return () => clearInterval(timer);
  }, [interval]);

  const getBiasColor = (bias: string) => COLORS[bias as keyof typeof COLORS] || COLORS.NEUTRAL;
  const getSignalColor = (label: string) => SIGNAL_COLORS[label as keyof typeof SIGNAL_COLORS] || SIGNAL_COLORS.NO_TRADE;
  const getRegimeColor = (regime: string) => REGIME_COLORS[regime] || REGIME_COLORS.TRANSITION;

  const formatNumber = (n: number, decimals = 0) => {
    if (n >= 1e9) return (n / 1e9).toFixed(decimals) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
    return n.toFixed(decimals);
  };

  if (loading && !data) return <div className="p-4 text-center text-gray-400">Loading index comparison...</div>;
  if (error) return <div className="p-4 text-center text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#0d1321] border border-[#1e222d] rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e222d]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Index Comparison</span>
          <span className="text-xs text-gray-400">5 Primary Indices</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={interval}
            onChange={e => setInterval(e.target.value)}
            className="text-xs px-2 py-1 rounded bg-[#131722] border border-[#1e222d] text-white"
          >
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
          </select>
          {data?.timestamp && (
            <span className="text-xs text-gray-500">
              Updated: {new Date(data.timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* Comparison Table */}
      <div className="flex-1 overflow-auto p-3">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-400 border-b border-[#1e222d]">
              <th className="px-2 py-1 text-left">Index</th>
              <th className="px-2 py-1 text-right">Price</th>
              <th className="px-2 py-1 text-right">Chg%</th>
              <th className="px-2 py-1 text-center">Regime</th>
              <th className="px-2 py-1 text-center">Auction</th>
              <th className="px-2 py-1 text-right">POC</th>
              <th className="px-2 py-1 text-right">VAH</th>
              <th className="px-2 py-1 text-right">VAL</th>
              <th className="px-2 py-1 text-right">Vol</th>
              <th className="px-2 py-1 text-right">RV</th>
              <th className="px-2 py-1 text-center">Structure</th>
              <th className="px-2 py-1 text-center">VWAP</th>
              <th className="px-2 py-1 text-center">Signal</th>
              <th className="px-2 py-1 text-center">Exp</th>
            </tr>
          </thead>
          <tbody>
            {data.comparison.map((row, i) => (
              <tr key={row.symbol} className={`hover:bg-[#131722] ${i % 2 === 0 ? 'bg-[#0f1419]' : ''}`}>
                <td className="px-2 py-1 font-bold text-white">{row.symbol}</td>
                <td className="px-2 py-1 text-right text-gray-300">{formatNumber(row.price, 2)}</td>
                <td className="px-2 py-1 text-right" style={{ color: row.changePct >= 0 ? '#26a69a' : '#ef5350' }}>
                  {row.changePct >= 0 ? '+' : ''}{row.changePct.toFixed(2)}%
                </td>
                <td className="px-2 py-1 text-center">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                    style={{ background: getRegimeColor(row.regime) + '22', color: getRegimeColor(row.regime), border: `1px solid ${getRegimeColor(row.regime)}55` }}>
                    {row.regime.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-2 py-1 text-center" style={{ color: getBiasColor(row.regimeBias) }}>
                  {row.auctionState.replace('PRICE_', '').replace('_', ' ')}
                </td>
                <td className="px-2 py-1 text-right text-gray-400">{formatNumber(row.poc, 1)}</td>
                <td className="px-2 py-1 text-right text-gray-400">{formatNumber(row.vah, 1)}</td>
                <td className="px-2 py-1 text-right text-gray-400">{formatNumber(row.val, 1)}</td>
                <td className="px-2 py-1 text-right text-gray-400">{formatNumber(row.volume)}</td>
                <td className="px-2 py-1 text-right text-cyan-400">{row.relativeVolume.toFixed(2)}x</td>
                <td className="px-2 py-1 text-center text-gray-400">{row.structure}</td>
                <td className="px-2 py-1 text-center" style={{ color: row.vwapState === 'VWAP_RECLAIM' ? '#26a69a' : row.vwapState === 'VWAP_REJECTION' ? '#ef5350' : '#78909c' }}>
                  {row.vwapState.replace('_', ' ')}
                </td>
                <td className="px-2 py-1 text-center">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                    style={{ background: getSignalColor(row.signalLabel) + '22', color: getSignalColor(row.signalLabel), border: `1px solid ${getSignalColor(row.signalLabel)}55` }}>
                    {row.signalLabel}
                  </span>
                </td>
                <td className="px-2 py-1 text-center text-gray-400">{row.historicalExpectancy.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Relative Strength */}
      <div className="border-t border-[#1e222d] p-3">
        <h4 className="text-xs font-bold text-gray-400 mb-2">Relative Strength vs NIFTY</h4>
        <div className="grid grid-cols-2 gap-2">
          {data.relativeStrength.map(rs => (
            <div key={rs.target} className="p-2 bg-[#0f1419] rounded border border-[#1e222d]">
              <div className="flex justify-between text-xs">
                <span className="text-white">{rs.target} vs {rs.base}</span>
                <span style={{ color: rs.status === 'LEADER' ? '#26a69a' : rs.status === 'IMPROVING' ? '#ffa726' : rs.status === 'WEAKENING' ? '#ff9800' : '#ef5350' }}>
                  {rs.status}
                </span>
              </div>
              <div className="text-xs text-gray-400 mt-1">{rs.interpretation}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Market Opportunity Ranking */}
      <div className="border-t border-[#1e222d] p-3">
        <h4 className="text-xs font-bold text-gray-400 mb-2">Market Opportunity Ranking</h4>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-gray-400 border-b border-[#1e222d]">
              <th className="px-2 py-1 text-center">#</th>
              <th className="px-2 py-1 text-left">Index</th>
              <th className="px-2 py-1 text-center">Signal</th>
              <th className="px-2 py-1 text-center">Regime</th>
              <th className="px-2 py-1 text-center">Best Inst</th>
              <th className="px-2 py-1 text-right">R:R</th>
              <th className="px-2 py-1 text-right">ExpMove</th>
              <th className="px-2 py-1 text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {data.ranking.map(r => (
              <tr key={r.symbol} className="hover:bg-[#131722]">
                <td className="px-2 py-1 text-center font-bold text-white">{r.rank}</td>
                <td className="px-2 py-1 font-bold text-white">{r.symbol}</td>
                <td className="px-2 py-1 text-center">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                    style={{ background: getSignalColor(r.signalLabel) + '22', color: getSignalColor(r.signalLabel) }}>
                    {r.signalLabel}
                  </span>
                </td>
                <td className="px-2 py-1 text-center">
                  <span className="px-1.5 py-0.5 rounded text-[8px] font-bold"
                    style={{ background: getRegimeColor(r.regime) + '22', color: getRegimeColor(r.regime) }}>
                    {r.regime.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-2 py-1 text-center text-cyan-400">{r.bestInstrument}</td>
                <td className="px-2 py-1 text-right text-cyan-400">{r.rr.toFixed(1)}</td>
                <td className="px-2 py-1 text-right text-gray-400">{(r.expectedMove * 100).toFixed(1)}%</td>
                <td className="px-2 py-1 text-right font-bold text-white">{r.totalScore.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}