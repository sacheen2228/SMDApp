'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Shield, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';

interface MotilalSession {
  valid: boolean;
  verified: boolean;
  hasAccessToken: boolean;
  expiresAt: number;
}

export function MotilalStatus() {
  const [session, setSession] = useState<MotilalSession | null>(null);
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showOtpInput, setShowOtpInput] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/motilal');
      const data = await res.json();
      setSession({
        valid: data.valid || false,
        verified: data.verified || false,
        hasAccessToken: data.hasAccessToken || false,
        expiresAt: data.expiresAt || 0,
      });
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleAutoLogin = async () => {
    setLoading(true);
    setMessage('Sending OTP to your phone...');
    try {
      const res = await fetch('/api/motilal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-login' }),
      });
      const data = await res.json();
      if (data.success) {
        setShowOtpInput(true);
        setMessage('OTP sent! Check your phone.');
      } else {
        setMessage(data.error || 'Login failed');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleVerifyOtp = async () => {
    if (!otp || otp.length !== 6) {
      setMessage('Enter 6-digit OTP');
      return;
    }
    setLoading(true);
    setMessage('Verifying...');
    try {
      const res = await fetch('/api/motilal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-otp', otp }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('Connected!');
        setShowOtpInput(false);
        setOtp('');
        checkStatus();
      } else {
        setMessage(data.error || 'Verification failed');
      }
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const handleResendOtp = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/motilal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend-otp' }),
      });
      const data = await res.json();
      setMessage(data.success ? 'OTP resent!' : data.error);
    } catch {
      setMessage('Network error');
    }
    setLoading(false);
  };

  const isConnected = session?.valid && session?.verified;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 text-[9px] px-2 gap-1">
          {isConnected ? (
            <>
              <ShieldCheck className="h-2.5 w-2.5 text-green-500" />
              <Badge variant="outline" className="text-[8px] border-green-500/50 text-green-500">MOAPI</Badge>
            </>
          ) : (
            <>
              <ShieldAlert className="h-2.5 w-2.5 text-amber-500" />
              <Badge variant="outline" className="text-[8px] border-amber-500/50 text-amber-500">MOAPI</Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="end">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Motilal Oswal API</span>
            {isConnected ? (
              <Badge className="bg-green-500/10 text-green-500 text-[10px]">Connected</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">Disconnected</Badge>
            )}
          </div>

          {session && (
            <div className="text-xs text-muted-foreground space-y-1">
              <div>Verified: {session.verified ? 'Yes' : 'No'}</div>
              <div>Access Token: {session.hasAccessToken ? 'Yes' : 'No'}</div>
              {session.expiresAt > 0 && (
                <div>Expires: {new Date(session.expiresAt).toLocaleString()}</div>
              )}
            </div>
          )}

          {!isConnected && !showOtpInput && (
            <Button
              size="sm"
              className="w-full"
              onClick={handleAutoLogin}
              disabled={loading}
            >
              {loading ? (
                <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Shield className="h-3 w-3 mr-1" />
              )}
              Login with OTP
            </Button>
          )}

          {showOtpInput && (
            <div className="space-y-2">
              <Input
                type="text"
                placeholder="Enter 6-digit OTP"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && handleVerifyOtp()}
                className="text-center text-lg tracking-widest"
                maxLength={6}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={handleVerifyOtp}
                  disabled={loading || otp.length !== 6}
                >
                  Verify
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleResendOtp}
                  disabled={loading}
                >
                  Resend
                </Button>
              </div>
            </div>
          )}

          {message && (
            <p className="text-xs text-muted-foreground">{message}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
