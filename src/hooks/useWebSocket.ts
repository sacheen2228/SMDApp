'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

interface OptionChainUpdate {
  strikePrice: number;
  ceLtp: number;
  ceVolume: number;
  ceOi: number;
  peLtp: number;
  peVolume: number;
  peOi: number;
  iv: number;
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

interface PriceUpdate {
  symbol: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: number;
}

interface AiSignal {
  signal: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  reason: string;
  timestamp: number;
}

interface UseWebSocketReturn {
  optionChain: OptionChainUpdate[];
  price: PriceUpdate | null;
  signal: AiSignal | null;
  isConnected: boolean;
}

export function useWebSocket(symbol: string): UseWebSocketReturn {
  const [optionChain, setOptionChain] = useState<OptionChainUpdate[]>([]);
  const [price, setPrice] = useState<PriceUpdate | null>(null);
  const [signal, setSignal] = useState<AiSignal | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!symbol) return;

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join-room', symbol);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('option-chain-update', (data: OptionChainUpdate[]) => {
      setOptionChain(data);
    });

    socket.on('price-update', (data: PriceUpdate) => {
      setPrice(data);
    });

    socket.on('ai-signal', (data: AiSignal) => {
      setSignal(data);
    });

    return () => {
      socket.emit('leave-room', symbol);
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    };
  }, [symbol]);

  return { optionChain, price, signal, isConnected };
}
