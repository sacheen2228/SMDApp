'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Shield, ShieldCheck, ShieldAlert, RefreshCw, Wifi, WifiOff, Eye, EyeOff } from 'lucide-react';

interface BrokerStatus {
  broker: string;
  configured: boolean;
  credentialsValid?: boolean;
  maskedCredentials?: Record<string, string>;
  status: string;
  connectionState: string;
  lastConnectedAt?: string;
  lastError?: string;
  sessionState?: any;
}

interface HealthStatus {
  status: string;
  checks: Record<string, { status: string; message?: string; latencyMs?: number }>;
}

export function AdminSettings() {
  const [breezeStatus, setBreezeStatus] = useState<BrokerStatus | null>(null);
  const [motilalStatus, setMotilalStatus] = useState<BrokerStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  // Edit mode for credentials
  const [editing, setEditing] = useState<string | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  const fetchStatus = useCallback(async () => {
    try {
      const [breezeRes, motilalRes, healthRes] = await Promise.allSettled([
        fetch('/api/broker-config?broker=ICICI_BREEZE').then(r => r.json()),
        fetch('/api/broker-config?broker=MOTILAL').then(r => r.json()),
        fetch('/api/health').then(r => r.json()),
      ]);

      if (breezeRes.status === 'fulfilled') setBreezeStatus(breezeRes.value);
      if (motilalRes.status === 'fulfilled') setMotilalStatus(motilalRes.value);
      if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleSaveCredentials = async (broker: string) => {
    setLoading(true);
    setMessage('Encrypting and saving...');
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-credentials', broker, credentials: creds }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(`${broker} credentials saved (encrypted)`);
        setEditing(null);
        setCreds({});
        fetchStatus();
      } else {
        setMessage(data.error || 'Save failed');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleConnect = async (broker: string) => {
    setLoading(true);
    setMessage(`Connecting to ${broker}...`);
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', broker }),
      });
      const data = await res.json();
      setMessage(data.success ? `${broker} connected!` : data.error || 'Connection failed');
      fetchStatus();
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleDisconnect = async (broker: string) => {
    setLoading(true);
    try {
      await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', broker }),
      });
      setMessage(`${broker} disconnected`);
      fetchStatus();
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'CONNECTED': return <Badge className="bg-green-500/10 text-green-500"><ShieldCheck className="h-3 w-3 mr-1" />CONNECTED</Badge>;
      case 'RECONNECTING': return <Badge className="bg-yellow-500/10 text-yellow-500"><RefreshCw className="h-3 w-3 mr-1 animate-spin" />RECONNECTING</Badge>;
      case 'DISCONNECTED': return <Badge variant="outline"><WifiOff className="h-3 w-3 mr-1" />DISCONNECTED</Badge>;
      case 'AUTH_ERROR': return <Badge className="bg-red-500/10 text-red-500"><ShieldAlert className="h-3 w-3 mr-1" />AUTH ERROR</Badge>;
      case 'CONFIGURED': return <Badge className="bg-blue-500/10 text-blue-500"><Shield className="h-3 w-3 mr-1" />CONFIGURED</Badge>;
      default: return <Badge variant="outline"><WifiOff className="h-3 w-3 mr-1" />NOT CONFIGURED</Badge>;
    }
  };

  const renderBrokerCard = (name: string, label: string, status: BrokerStatus | null, fields: string[]) => (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{label}</CardTitle>
          {status ? getStatusBadge(status.status) : getStatusBadge('NOT_CONFIGURED')}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.configured && status.maskedCredentials && (
          <div className="text-xs text-muted-foreground space-y-1">
            {Object.entries(status.maskedCredentials).map(([key, val]) => (
              <div key={key} className="flex justify-between">
                <span>{key}:</span>
                <span className="font-mono">{val}</span>
              </div>
            ))}
          </div>
        )}

        {status?.lastConnectedAt && (
          <div className="text-xs text-muted-foreground">
            Last connected: {new Date(status.lastConnectedAt).toLocaleString()}
          </div>
        )}

        {status?.lastError && (
          <div className="text-xs text-red-500">Error: {status.lastError}</div>
        )}

        <Separator />

        {editing === name ? (
          <div className="space-y-2">
            {fields.map(field => (
              <div key={field} className="space-y-1">
                <Label className="text-xs">{field}</Label>
                <div className="flex gap-1">
                  <Input
                    type={showPasswords[field] ? 'text' : 'password'}
                    placeholder={field}
                    value={creds[field] || ''}
                    onChange={e => setCreds(prev => ({ ...prev, [field]: e.target.value }))}
                    className="h-7 text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0"
                    onClick={() => setShowPasswords(prev => ({ ...prev, [field]: !prev[field] }))}
                  >
                    {showPasswords[field] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveCredentials(name)} disabled={loading}>
                Save Encrypted
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditing(null); setCreds({}); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(name)}>
              {status?.configured ? 'Update Credentials' : 'Configure'}
            </Button>
            {status?.configured && (
              <>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleConnect(name)} disabled={loading}>
                  <Wifi className="h-3 w-3 mr-1" /> Connect
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleDisconnect(name)}>
                  <WifiOff className="h-3 w-3 mr-1" /> Disconnect
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Broker Connections</h2>
        <Button variant="outline" size="sm" onClick={fetchStatus} disabled={loading}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>

      {message && (
        <div className="text-sm text-muted-foreground bg-muted p-2 rounded">{message}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {renderBrokerCard('ICICI_BREEZE', 'ICICI Direct Breeze', breezeStatus, [
          'apiKey', 'secretKey', 'username', 'password',
        ])}
        {renderBrokerCard('MOTILAL', 'Motilal Oswal', motilalStatus, [
          'apiKey', 'secretKey', 'username', 'password', 'dob', 'vendorId', 'totpKey',
        ])}
      </div>

      {/* System Health */}
      {health && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">System Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(health.checks).map(([key, check]) => (
                <div key={key} className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${
                    check.status === 'OK' || check.status === 'CONNECTED' || check.status === 'LIVE'
                      ? 'bg-green-500'
                      : check.status === 'WARNING'
                        ? 'bg-yellow-500'
                        : 'bg-red-500'
                  }`} />
                  <span className="text-xs">{key.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
