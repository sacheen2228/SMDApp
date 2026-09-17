// ═══════════════════════════════════════════════════════════════════════════
// Agent Intelligence Tab — Full agent system dashboard
// ═══════════════════════════════════════════════════════════════════════════

'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Users, Signal, Zap, RefreshCw, TrendingUp, AlertTriangle } from 'lucide-react';

interface AgentHealth {
  totalAgents: number;
  activeAgents: number;
  degradedAgents: number;
  offlineAgents: number;
  lastHeartbeat: string | null;
  currentTasks: number;
  failedTasks: number;
  averageLatency: number;
}

interface AgentInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  healthStatus: string;
  lastHeartbeatAt: string | null;
  version: string;
}

interface SignalInfo {
  id: string;
  agentId: string;
  underlying: string;
  direction: string;
  confidence: number;
  lifecycle: string;
  timestamp: string;
  thesis: string;
}

interface LeaderboardEntry {
  agentId: string;
  name: string;
  rank: string;
  score: number;
  winRate: number;
  totalTrades: number;
}

export function AgentIntelligence() {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [signals, setSignals] = useState<SignalInfo[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = async () => {
    setLoading(true);
    try {
      const [healthRes, signalsRes, leaderboardRes] = await Promise.allSettled([
        fetch('/api/agents/health'),
        fetch('/api/signals/feed?limit=20'),
        fetch('/api/agents/leaderboard'),
      ]);

      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const data = await healthRes.value.json();
        setHealth(data.systemHealth);
        setAgents(data.agents);
      }

      if (signalsRes.status === 'fulfilled' && signalsRes.value.ok) {
        const data = await signalsRes.value.json();
        setSignals(data.signals);
      }

      if (leaderboardRes.status === 'fulfilled' && leaderboardRes.value.ok) {
        const data = await leaderboardRes.value.json();
        setLeaderboard(data.leaderboard);
      }

      setLastRefresh(new Date());
    } catch (error) {
      console.error('Failed to fetch agent data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const getHealthColor = (status: string) => {
    switch (status) {
      case 'HEALTHY': return 'bg-green-500';
      case 'DEGRADED': return 'bg-yellow-500';
      case 'UNHEALTHY': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE': return 'bg-green-500';
      case 'IDLE': return 'bg-blue-500';
      case 'BUSY': return 'bg-yellow-500';
      case 'OFFLINE': return 'bg-gray-500';
      case 'ERROR': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getLifecycleColor = (lifecycle: string) => {
    switch (lifecycle) {
      case 'RESEARCH': return 'bg-blue-500';
      case 'CANDIDATE': return 'bg-purple-500';
      case 'VALIDATING': return 'bg-yellow-500';
      case 'VALIDATED': return 'bg-green-500';
      case 'FINAL': return 'bg-emerald-500';
      case 'ACTIVE': return 'bg-green-600';
      case 'TP1': case 'TP2': return 'bg-green-400';
      case 'SL': return 'bg-red-500';
      case 'EXIT': case 'CLOSED': return 'bg-gray-500';
      default: return 'bg-gray-400';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-purple-500" />
          <h2 className="text-lg font-semibold">Agent Intelligence</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* System Health Cards */}
      {health && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Agents</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{health.totalAgents}</div>
              <div className="text-xs text-muted-foreground">
                {health.activeAgents} active
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Tasks</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{health.currentTasks}</div>
              <div className="text-xs text-muted-foreground">
                {health.failedTasks} failed
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Avg Latency</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{health.averageLatency}ms</div>
              <div className="text-xs text-muted-foreground">
                Last: {health.lastHeartbeat ? new Date(health.lastHeartbeat).toLocaleTimeString() : 'N/A'}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">System Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${health.degradedAgents > 0 ? 'bg-yellow-500' : 'bg-green-500'}`} />
                <span className="font-bold">
                  {health.degradedAgents > 0 ? 'DEGRADED' : 'HEALTHY'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {health.offlineAgents} offline
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Agents Grid */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Registered Agents
          </CardTitle>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No agents registered yet. Start the agent system to see agents here.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map(agent => (
                <div key={agent.id} className="border rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{agent.name}</div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{agent.type}</Badge>
                      <div className={`w-2 h-2 rounded-full ${getStatusColor(agent.status)}`} />
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    v{agent.version} · {agent.healthStatus}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Last heartbeat: {agent.lastHeartbeatAt
                      ? new Date(agent.lastHeartbeatAt).toLocaleTimeString()
                      : 'Never'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Signals */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Signal className="h-4 w-4" />
            Recent Signals
          </CardTitle>
        </CardHeader>
        <CardContent>
          {signals.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No signals published yet.
            </div>
          ) : (
            <div className="space-y-3">
              {signals.slice(0, 10).map(signal => (
                <div key={signal.id} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={signal.direction === 'BUY_CE' ? 'default' : 'secondary'}>
                        {signal.direction}
                      </Badge>
                      <span className="font-medium">{signal.underlying}</span>
                      <Badge variant="outline" className="text-xs">
                        {signal.confidence.toFixed(0)}%
                      </Badge>
                    </div>
                    <Badge className={`${getLifecycleColor(signal.lifecycle)} text-white`}>
                      {signal.lifecycle}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground line-clamp-2">
                    {signal.thesis}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(signal.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Leaderboard */}
      {leaderboard.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Agent Leaderboard
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {leaderboard.map((entry, idx) => (
                <div key={entry.agentId} className="flex items-center justify-between p-2 border rounded">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-muted-foreground">#{idx + 1}</span>
                    <div>
                      <div className="font-medium">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">{entry.rank}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">{entry.score.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground">
                      {entry.winRate.toFixed(1)}% WR · {entry.totalTrades} trades
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Feature Flags */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Feature Flags
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[
              'AGENT_SYSTEM_ENABLED',
              'EXTERNAL_AGENT_ENABLED',
              'AI_TRADER_ENABLED',
              'AGENT_WEBSOCKET_ENABLED',
              'AGENT_SIGNAL_FEED_ENABLED',
              'AGENT_PERFORMANCE_ENABLED',
            ].map(flag => (
              <div key={flag} className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${flag.includes('ENABLED') ? 'bg-green-500' : 'bg-gray-500'}`} />
                <span className="text-sm">{flag}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
