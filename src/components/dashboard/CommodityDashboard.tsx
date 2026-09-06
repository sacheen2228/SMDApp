// MCX Commodity Dashboard — Market status, quotes, options, scanner, best trade
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle, Zap, BookOpen } from 'lucide-react';

interface MCXQuote {
  symbol: string;
  ltp: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  openInterest: number | null;
  changeInOI: number | null;
  bid: number | null;
  ask: number | null;
  dataStatus: string;
  dataSource: string;
  lotSize: number;
}

interface MCXOptionStrike {
  strike: number;
  ce: { ltp: number; bid: number; ask: number; volume: number; oi: number; token: number; expiry: string } | null;
  pe: { ltp: number; bid: number; ask: number; volume: number; oi: number; token: number; expiry: string } | null;
}

interface MCXOptionChain {
  symbol: string;
  expiry: string;
  spotPrice: number;
  strikes: MCXOptionStrike[];
  atmStrike: number;
  totalCEVolume: number;
  totalPEVolume: number;
  pcr: number;
  timestamp: string;
  dataSource: string;
}

interface MCXScannerResult {
  symbol: string;
  category: string;
  direction: string;
  score: number;
  grade: string;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  maxLoss: number;
  lotSize: number;
  liquidityStatus: string;
  dataStatus: string;
  reasons: string[];
  riskFlags: string[];
}

interface MCXData {
  session: {
    state: string;
    label: string;
    color: string;
    isActive: boolean;
    description: string;
    minutesRemaining: number;
  };
  data: {
    energy: MCXQuote[];
    preciousMetals: MCXQuote[];
  };
  health: {
    moapi: string;
    breeze: string;
    websocket: string;
    lastTickAge: number;
    status: string;
  };
}

export function CommodityDashboard() {
  const [mcxData, setMcxData] = useState<MCXData | null>(null);
  const [scannerResults, setScannerResults] = useState<MCXScannerResult[]>([]);
  const [optionChains, setOptionChains] = useState<Record<string, MCXOptionChain>>({});
  const [selectedOptionSymbol, setSelectedOptionSymbol] = useState<string>('CRUDEOIL');
  const [loading, setLoading] = useState(true);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [activeTab, setActiveTab] = useState<'market' | 'options' | 'scanner'>('market');

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [mcxRes, scannerRes, optionRes] = await Promise.all([
        fetch('/api/mcx'),
        fetch('/api/mcx/scanner?mode=full'),
        fetch('/api/mcx/option-chain'),
      ]);

      if (mcxRes.ok) {
        const mcxJson = await mcxRes.json();
        if (mcxJson.success) setMcxData(mcxJson);
      }

      if (scannerRes.ok) {
        const scannerJson = await scannerRes.json();
        if (scannerJson.success) setScannerResults(scannerJson.results || []);
      }

      if (optionRes.ok) {
        const optionJson = await optionRes.json();
        if (optionJson.success) setOptionChains(optionJson.chains || {});
      }

      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message || 'Failed to fetch MCX data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchData]);

  const runScanner = async () => {
    try {
      setScannerLoading(true);
      const res = await fetch('/api/mcx/scanner?mode=full');
      const json = await res.json();
      if (json.success) setScannerResults(json.results || []);
    } catch {
    } finally {
      setScannerLoading(false);
    }
  };

  if (loading && !mcxData) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading MCX data...</span>
      </div>
    );
  }

  if (error && !mcxData) {
    return (
      <div className="flex items-center justify-center h-64">
        <AlertTriangle className="h-6 w-6 text-red-500" />
        <span className="ml-2 text-red-500">{error}</span>
      </div>
    );
  }

  const session = mcxData?.session;
  const health = mcxData?.health;
  const energy = mcxData?.data?.energy || [];
  const metals = mcxData?.data?.preciousMetals || [];
  const bestTrade = scannerResults.find(r => r.grade !== 'NO_TRADE' && r.score > 0);

  return (
    <div className="space-y-4">
      {/* MCX Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">MCX COMMODITY</h2>
          {session && (
            <Badge variant="outline" style={{ borderColor: session.color, color: session.color }}>
              {session.label}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>MOAPI: {health?.moapi === 'CONNECTED' ? '✅' : '❌'}</span>
          <span>Last: {health?.lastTickAge}s ago</span>
          <Button variant="ghost" size="sm" onClick={fetchData}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b pb-1">
        {(['market', 'options', 'scanner'] as const).map(tab => (
          <Button key={tab} variant={activeTab === tab ? 'default' : 'ghost'} size="sm"
            className={`h-7 text-xs ${activeTab === tab ? 'bg-amber-600 text-white' : ''}`}
            onClick={() => setActiveTab(tab)}>
            {tab === 'market' ? 'MARKET' : tab === 'options' ? 'OPTIONS' : 'SCANNER'}
          </Button>
        ))}
      </div>

      {/* ═══════ MARKET TAB ═══════ */}
      {activeTab === 'market' && (
        <>
          {/* Energy */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-500" /> ENERGY
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">{energy.map(q => <QuoteRow key={q.symbol} quote={q} />)}</div>
            </CardContent>
          </Card>
          {/* Precious Metals */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-yellow-300" /> PRECIOUS METALS
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">{metals.map(q => <QuoteRow key={q.symbol} quote={q} />)}</div>
            </CardContent>
          </Card>
          {/* Best MCX Trade */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">BEST MCX TRADE</CardTitle>
            </CardHeader>
            <CardContent>
              {bestTrade ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-lg">{bestTrade.symbol}</span>
                    <Badge variant={bestTrade.direction === 'LONG' ? 'default' : 'destructive'}>
                      {bestTrade.direction === 'LONG' ? 'BUY FUTURES' : 'SELL FUTURES'}
                    </Badge>
                    <Badge variant="outline">{bestTrade.grade}</Badge>
                    <span className="text-sm font-medium">{bestTrade.score}/100</span>
                  </div>
                  <div className="grid grid-cols-5 gap-3 text-sm">
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground text-xs">ENTRY</span>
                      <p className="font-mono font-bold">{bestTrade.entry > 0 ? bestTrade.entry.toFixed(1) : '-'}</p>
                    </div>
                    <div className="bg-red-500/10 rounded p-2">
                      <span className="text-muted-foreground text-xs">STOP LOSS</span>
                      <p className="font-mono font-bold text-red-500">{bestTrade.stopLoss > 0 ? bestTrade.stopLoss.toFixed(1) : '-'}</p>
                    </div>
                    <div className="bg-green-500/10 rounded p-2">
                      <span className="text-muted-foreground text-xs">TARGET</span>
                      <p className="font-mono font-bold text-green-500">{bestTrade.target > 0 ? bestTrade.target.toFixed(1) : '-'}</p>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground text-xs">R:R</span>
                      <p className="font-mono font-bold">{bestTrade.riskReward > 0 ? bestTrade.riskReward.toFixed(2) : '-'}</p>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground text-xs">MAX LOSS</span>
                      <p className="font-mono font-bold text-red-500">{bestTrade.maxLoss > 0 ? `₹${bestTrade.maxLoss.toFixed(0)}` : '-'}</p>
                    </div>
                  </div>
                  {bestTrade.reasons.length > 0 && (
                    <div className="text-xs text-muted-foreground border-t pt-2">{bestTrade.reasons.join(' • ')}</div>
                  )}
                </div>
              ) : (
                <div className="text-center py-6">
                  <span className="text-muted-foreground font-medium text-lg">NO VALID MCX TRADE</span>
                  <p className="text-xs text-muted-foreground mt-1">No qualifying setups in the approved 10 contracts</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════ OPTIONS TAB ═══════ */}
      {activeTab === 'options' && (
        <>
          {/* Symbol selector */}
          <div className="flex gap-2 flex-wrap">
            {['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS'].map(sym => (
              <Button key={sym} variant={selectedOptionSymbol === sym ? 'default' : 'ghost'} size="sm"
                className={`h-7 text-xs ${selectedOptionSymbol === sym ? 'bg-amber-600 text-white' : ''}`}
                onClick={() => setSelectedOptionSymbol(sym)}>
                {sym}
              </Button>
            ))}
          </div>
          {/* Option Chain */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BookOpen className="h-4 w-4" /> {selectedOptionSymbol} OPTION CHAIN
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {optionChains[selectedOptionSymbol] ? (
                <OptionChainTable chain={optionChains[selectedOptionSymbol]} />
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <p>No option data available for {selectedOptionSymbol}</p>
                  <p className="text-xs mt-1">Connect Motilal Oswal API to view MCX option chains</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════ SCANNER TAB ═══════ */}
      {activeTab === 'scanner' && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">MCX SCANNER</CardTitle>
            <Button variant="ghost" size="sm" onClick={runScanner} disabled={scannerLoading}>
              <RefreshCw className={`h-3 w-3 ${scannerLoading ? 'animate-spin' : ''}`} />
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex items-center justify-between px-3 py-1 border-b text-[10px] text-muted-foreground font-medium">
              <div className="flex items-center gap-2 w-48">CONTRACT</div>
              <div className="flex items-center gap-4">
                <span className="w-12 text-right">SCORE</span>
                <span className="w-20 text-right">ENTRY</span>
                <span className="w-16 text-right">SL</span>
                <span className="w-16 text-right">TARGET</span>
                <span className="w-12 text-right">R:R</span>
                <span className="w-16 text-right">LIQ</span>
              </div>
            </div>
            <div className="divide-y">
              {scannerResults.map(r => <ScannerRow key={r.symbol} result={r} />)}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Option Chain Table ──
function OptionChainTable({ chain }: { chain: MCXOptionChain }) {
  const spot = chain.spotPrice;
  const atm = chain.atmStrike;
  // Show strikes near ATM (±5 strikes or all if fewer)
  const atmIndex = chain.strikes.findIndex(s => s.strike === atm);
  const start = Math.max(0, atmIndex - 5);
  const end = Math.min(chain.strikes.length, atmIndex + 6);
  const visibleStrikes = chain.strikes.slice(start, end);

  return (
    <div>
      {/* Chain header */}
      <div className="flex items-center justify-between px-3 py-2 border-b text-xs">
        <div className="flex items-center gap-4">
          <span className="text-muted-foreground">Spot: <span className="font-mono font-bold">{spot > 0 ? spot.toFixed(1) : '-'}</span></span>
          <span className="text-muted-foreground">ATM: <span className="font-mono font-bold">{atm > 0 ? atm.toFixed(1) : '-'}</span></span>
          <span className="text-muted-foreground">PCR: <span className="font-mono">{chain.pcr > 0 ? chain.pcr.toFixed(2) : '-'}</span></span>
        </div>
        <span className="text-muted-foreground">Expiry: {chain.expiry}</span>
      </div>
      {/* Column headers */}
      <div className="flex items-center px-3 py-1 border-b text-[10px] text-muted-foreground font-medium">
        <span className="w-16 text-right">CE VOL</span>
        <span className="w-16 text-right">CE OI</span>
        <span className="w-16 text-right">CE LTP</span>
        <span className="flex-1 text-center font-bold">STRIKE</span>
        <span className="w-16 text-right">PE LTP</span>
        <span className="w-16 text-right">PE OI</span>
        <span className="w-16 text-right">PE VOL</span>
      </div>
      <div className="divide-y">
        {visibleStrikes.map(s => (
          <div key={s.strike} className={`flex items-center px-3 py-1.5 text-xs ${s.strike === atm ? 'bg-amber-500/10 font-bold' : ''}`}>
            <span className="w-16 text-right text-green-600">{s.ce?.volume ? s.ce.volume.toLocaleString() : '-'}</span>
            <span className="w-16 text-right text-muted-foreground">{s.ce?.oi ? s.ce.oi.toLocaleString() : '-'}</span>
            <span className="w-16 text-right font-mono">{s.ce?.ltp ? s.ce.ltp.toFixed(1) : '-'}</span>
            <span className={`flex-1 text-center font-mono ${s.strike === atm ? 'text-amber-500' : ''}`}>{s.strike}</span>
            <span className="w-16 text-right font-mono">{s.pe?.ltp ? s.pe.ltp.toFixed(1) : '-'}</span>
            <span className="w-16 text-right text-muted-foreground">{s.pe?.oi ? s.pe.oi.toLocaleString() : '-'}</span>
            <span className="w-16 text-right text-red-600">{s.pe?.volume ? s.pe.volume.toLocaleString() : '-'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuoteRow({ quote }: { quote: MCXQuote }) {
  const isUp = (quote.change || 0) > 0;
  const isDown = (quote.change || 0) < 0;
  const noData = quote.dataStatus === 'DATA_UNAVAILABLE';

  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm w-24">{quote.symbol}</span>
        {noData ? (
          <Badge variant="secondary" className="text-xs">DATA UNAVAILABLE</Badge>
        ) : (
          <>
            {isUp && <TrendingUp className="h-3 w-3 text-green-500" />}
            {isDown && <TrendingDown className="h-3 w-3 text-red-500" />}
            {!isUp && !isDown && <Minus className="h-3 w-3 text-muted-foreground" />}
          </>
        )}
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="font-mono w-20 text-right">
          {quote.ltp !== null ? quote.ltp.toFixed(quote.ltp > 1000 ? 0 : 2) : '-'}
        </span>
        <span className={`font-mono w-16 text-right ${isUp ? 'text-green-500' : isDown ? 'text-red-500' : ''}`}>
          {quote.changePercent !== null ? `${quote.changePercent > 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%` : '-'}
        </span>
        <span className="text-muted-foreground w-16 text-right text-xs">
          {quote.volume !== null ? quote.volume.toLocaleString() : '-'}
        </span>
        <span className="text-muted-foreground w-8 text-right text-xs">
          {quote.dataSource}
        </span>
      </div>
    </div>
  );
}

function ScannerRow({ result }: { result: MCXScannerResult }) {
  const gradeColor = {
    'A+': 'text-green-500',
    'A': 'text-green-400',
    'B': 'text-yellow-500',
    'WATCH': 'text-orange-500',
    'NO_TRADE': 'text-muted-foreground',
  }[result.grade] || 'text-muted-foreground';

  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm w-24">{result.symbol}</span>
        <Badge variant={result.direction === 'LONG' ? 'default' : result.direction === 'SHORT' ? 'destructive' : 'secondary'} className="text-xs">
          {result.direction}
        </Badge>
        <span className={`text-sm font-bold ${gradeColor}`}>{result.grade}</span>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="font-mono w-12 text-right">{result.score}</span>
        <span className="font-mono w-20 text-right text-xs">
          {result.entry > 0 ? result.entry.toFixed(1) : '-'}
        </span>
        <span className="font-mono w-16 text-right text-xs text-red-500">
          {result.stopLoss > 0 ? result.stopLoss.toFixed(1) : '-'}
        </span>
        <span className="font-mono w-16 text-right text-xs text-green-500">
          {result.target > 0 ? result.target.toFixed(1) : '-'}
        </span>
        <span className="font-mono w-12 text-right text-xs">
          {result.riskReward > 0 ? result.riskReward.toFixed(1) : '-'}
        </span>
        <Badge variant={result.liquidityStatus === 'HIGH' ? 'default' : result.liquidityStatus === 'INSUFFICIENT' ? 'destructive' : 'secondary'} className="text-xs">
          {result.liquidityStatus}
        </Badge>
      </div>
    </div>
  );
}
