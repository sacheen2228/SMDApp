'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Shield, ShieldCheck, ShieldAlert, RefreshCw, Wifi, WifiOff, Eye, EyeOff, MessageSquare, Send, RotateCcw, Key } from 'lucide-react';

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

  // Edit state
  const [editingBroker, setEditingBroker] = useState<string | null>(null);
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  // OTP state for Motilal
  const [otpStep, setOtpStep] = useState<'idle' | 'sent' | 'verifying' | 'verified'>('idle');
  const [otpCode, setOtpCode] = useState('');

  // Separate state for each credential field
  const [breezeCreds, setBreezeCreds] = useState({ apiKey: '', secretKey: '', username: '', password: '', sessionToken: '' });
  const [motilalCreds, setMotilalCreds] = useState({ apiKey: '', secretKey: '', username: '', password: '', dob: '', vendorId: '', totpKey: '' });

  const getCreds = (broker: string) => broker === 'MOTILAL' ? motilalCreds : breezeCreds;
  const setCreds = (broker: string, updater: (prev: any) => any) => {
    if (broker === 'MOTILAL') setMotilalCreds(prev => updater(prev));
    else setBreezeCreds(prev => updater(prev));
  };

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
      const creds = getCreds(broker);
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-credentials', broker, credentials: creds }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(`${broker} credentials saved (encrypted)`);
        setEditingBroker(null);
        fetchStatus();
      } else {
        setMessage(data.error || 'Save failed');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleSendOtp = async (broker: string) => {
    setLoading(true);
    setMessage('Sending OTP...');
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send-otp', broker }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('OTP sent to your phone');
        setOtpStep('sent');
        setOtpCode('');
      } else {
        setMessage(data.error || 'Failed to send OTP');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleVerifyOtp = async (broker: string) => {
    if (!otpCode || otpCode.length !== 6) {
      setMessage('Enter 6-digit OTP');
      return;
    }
    setLoading(true);
    setMessage('Verifying OTP...');
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-otp', broker, otp: otpCode }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('Motilal connected!');
        setOtpStep('verified');
        fetchStatus();
      } else {
        setMessage(data.error || 'Invalid OTP');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleResendOtp = async (broker: string) => {
    setLoading(true);
    setMessage('Resending OTP...');
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend-otp', broker }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('OTP resent');
        setOtpCode('');
      } else {
        setMessage(data.error || 'Failed to resend');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleConnect = async (broker: string) => {
    if (broker === 'MOTILAL') {
      await handleSendOtp(broker);
      return;
    }
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
      setOtpStep('idle');
      fetchStatus();
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleUpdateBreezeToken = async (broker: string) => {
    const token = breezeCreds.sessionToken;
    if (!token || token.trim() === '') {
      setMessage('Enter session token first');
      return;
    }
    setLoading(true);
    setMessage('Updating token...');
    try {
      const res = await fetch('/api/broker-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-breeze-token', broker, sessionToken: token }),
      });
      const data = await res.json();
      setMessage(data.success ? 'Token updated. Click Connect to re-auth.' : data.error || 'Failed to update');
      if (data.success) fetchStatus();
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

  const renderBrokerCard = (
    brokerName: string,
    label: string,
    status: BrokerStatus | null,
    fields: { key: string; label: string; isPassword?: boolean }[],
  ) => {
    const isEditing = editingBroker === brokerName;
    const creds = getCreds(brokerName);
    const isMotilal = brokerName === 'MOTILAL';

    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">{label}</CardTitle>
            {status ? getStatusBadge(status.status) : getStatusBadge('NOT_CONFIGURED')}
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
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

            {/* OTP Flow for Motilal */}
            {isMotilal && otpStep !== 'idle' && otpStep !== 'verified' && (
              <div className="space-y-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-blue-500" />
                  <span className="text-sm font-medium text-blue-500">OTP Verification</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter the 6-digit OTP sent to your registered phone number
                </p>
                <div className="flex gap-1">
                  <input
                    type="text"
                    placeholder="Enter 6-digit OTP"
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="flex h-7 w-full rounded-md border border-input bg-transparent px-3 py-1 text-lg text-center tracking-widest shadow-xs transition-colors file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
                    maxLength={6}
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs flex-1" onClick={() => handleVerifyOtp(brokerName)} disabled={loading || otpCode.length !== 6}>
                    <Send className="h-3 w-3 mr-1" /> Verify OTP
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleResendOtp(brokerName)} disabled={loading}>
                    <RotateCcw className="h-3 w-3 mr-1" /> Resend
                  </Button>
                </div>
              </div>
            )}

            {isEditing ? (
              <div className="space-y-3">
                {fields.map(({ key, label: fieldLabel, isPassword }) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">{fieldLabel}</Label>
                    <div className="flex gap-1">
                      <input
                        type={isPassword && !showPasswords[key] ? 'password' : 'text'}
                        placeholder={fieldLabel}
                        value={creds[key] || ''}
                        onChange={e => setCreds(brokerName, prev => ({ ...prev, [key]: e.target.value }))}
                        className="flex h-7 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-xs transition-colors file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
                      />
                      {isPassword && (
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-input hover:bg-accent hover:text-accent-foreground"
                          onClick={() => setShowPasswords(prev => ({ ...prev, [key]: !prev[key] }))}
                        >
                          {showPasswords[key] ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveCredentials(brokerName)} disabled={loading}>
                    Save Encrypted
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingBroker(null); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditingBroker(brokerName)}>
                  {status?.configured ? 'Update Credentials' : 'Configure'}
                </Button>
                {status?.configured && (
                  <>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleConnect(brokerName)} disabled={loading}>
                      <Wifi className="h-3 w-3 mr-1" /> {isMotilal && otpStep === 'idle' ? 'Send OTP' : 'Connect'}
                    </Button>
                    {brokerName === 'ICICI_BREEZE' && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleUpdateBreezeToken(brokerName)} disabled={loading}>
                        <Key className="h-3 w-3 mr-1" /> Update Token
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleDisconnect(brokerName)}>
                      <WifiOff className="h-3 w-3 mr-1" /> Disconnect
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

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
          { key: 'apiKey', label: 'API Key' },
          { key: 'secretKey', label: 'API Secret', isPassword: true },
          { key: 'username', label: 'Username' },
          { key: 'password', label: 'Password', isPassword: true },
          { key: 'sessionToken', label: 'Session Token (daily)', isPassword: true },
        ])}
        {renderBrokerCard('MOTILAL', 'Motilal Oswal', motilalStatus, [
          { key: 'apiKey', label: 'API Key' },
          { key: 'secretKey', label: 'API Secret', isPassword: true },
          { key: 'username', label: 'User ID' },
          { key: 'password', label: 'Password', isPassword: true },
          { key: 'dob', label: 'Date of Birth (DD/MM/YYYY)' },
          { key: 'vendorId', label: 'Vendor ID' },
          { key: 'totpKey', label: 'TOTP Key', isPassword: true },
        ])}
      </div>

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