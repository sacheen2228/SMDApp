// MCX Commodity Dashboard — Market status, quotes, scanner, best trade
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle, Zap } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);
  const [scannerLoading, setScannerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [mcxRes, scannerRes] = await Promise.all([
        fetch('/api/mcx'),
        fetch('/api/mcx/scanner?mode=full'),
      ]);

      if (mcxRes.ok) {
        const mcxJson = await mcxRes.json();
        if (mcxJson.success) setMcxData(mcxJson);
      }

      if (scannerRes.ok) {
        const scannerJson = await scannerRes.json();
        if (scannerJson.success) setScannerResults(scannerJson.results || []);
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
            <Badge
              variant="outline"
              style={{ borderColor: session.color, color: session.color }}
            >
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

      {/* Session Info */}
      {session && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium">{session.description}</span>
                {session.isActive && session.minutesRemaining > 0 && (
                  <span className="text-xs text-muted-foreground ml-2">
                    {Math.floor(session.minutesRemaining / 60)}h {session.minutesRemaining % 60}m remaining
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <Badge variant={health?.status === 'LIVE' ? 'default' : 'secondary'}>
                  DATA: {health?.status || 'UNKNOWN'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Energy */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-500" />
            ENERGY
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {energy.map(q => (
              <QuoteRow key={q.symbol} quote={q} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Precious Metals */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-yellow-300" />
            PRECIOUS METALS
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {metals.map(q => (
              <QuoteRow key={q.symbol} quote={q} />
            ))}
          </div>
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
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div>
                  <span className="text-muted-foreground">Lot Size: </span>
                  <span className="font-mono">{bestTrade.lotSize}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Capital: </span>
                  <span className="font-mono">{bestTrade.capitalRequired > 0 ? `₹${bestTrade.capitalRequired.toLocaleString()}` : '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Liquidity: </span>
                  <Badge variant={bestTrade.liquidityStatus === 'HIGH' ? 'default' : 'secondary'} className="text-[10px]">
                    {bestTrade.liquidityStatus}
                  </Badge>
                </div>
              </div>
              {bestTrade.reasons.length > 0 && (
                <div className="text-xs text-muted-foreground border-t pt-2">
                  {bestTrade.reasons.join(' • ')}
                </div>
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

      {/* Scanner Results */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">MCX SCANNER</CardTitle>
          <Button variant="ghost" size="sm" onClick={runScanner} disabled={scannerLoading}>
            <RefreshCw className={`h-3 w-3 ${scannerLoading ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {/* Column Headers */}
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
            {scannerResults.map(r => (
              <ScannerRow key={r.symbol} result={r} />
            ))}
          </div>
        </CardContent>
      </Card>
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
