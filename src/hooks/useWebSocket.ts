'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// ─── Existing Types ────────────────────────────────────────────────

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

// ─── New Types ─────────────────────────────────────────────────────

interface OptionTick {
  strike: number;
  ltp: number;
  oi: number;
  oiChg: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface OptionChainTick {
  symbol: string;
  spot: number;
  calls: OptionTick[];
  puts: OptionTick[];
  atmStrike: number;
  timestamp: number;
}

interface MarketStatus {
  isOpen: boolean;
  vix: number;
  pcr: number;
}

interface UseOptionChainWSReturn {
  data: OptionChainTick | null;
  isConnected: boolean;
  lastUpdate: number;
}

interface UseMarketStatusWSReturn {
  isOpen: boolean;
  vix: number;
  pcr: number;
  isConnected: boolean;
}

// ─── Shared Socket Manager ────────────────────────────────────────

let sharedSocket: Socket | null = null;
let refCount = 0;

function getSharedSocket(): Socket {
  if (!sharedSocket) {
    sharedSocket = io(typeof window !== 'undefined' ? window.location.origin : '', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  refCount++;
  return sharedSocket;
}

function releaseSharedSocket() {
  refCount--;
  if (refCount <= 0 && sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
    refCount = 0;
  }
}

// ─── Original Hook ────────────────────────────────────────────────

export function useWebSocket(symbol: string): UseWebSocketReturn {
  const [optionChain, setOptionChain] = useState<OptionChainUpdate[]>([]);
  const [price, setPrice] = useState<PriceUpdate | null>(null);
  const [signal, setSignal] = useState<AiSignal | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!symbol) return;

    const socket = getSharedSocket();
    socketRef.current = socket;

    const onConnect = () => {
      setIsConnected(true);
      socket.emit('join-room', symbol);
    };
    const onDisconnect = () => setIsConnected(false);
    const onOptionChain = (data: OptionChainUpdate[]) => setOptionChain(data);
    const onPrice = (data: PriceUpdate) => setPrice(data);
    const onSignal = (data: AiSignal) => setSignal(data);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('option-chain-update', onOptionChain);
    socket.on('price-update', onPrice);
    socket.on('ai-signal', onSignal);

    if (socket.connected) {
      setIsConnected(true);
      socket.emit('join-room', symbol);
    }

    return () => {
      socket.emit('leave-room', symbol);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('option-chain-update', onOptionChain);
      socket.off('price-update', onPrice);
      socket.off('ai-signal', onSignal);
      socketRef.current = null;
      setIsConnected(false);
      releaseSharedSocket();
    };
  }, [symbol]);

  return { optionChain, price, signal, isConnected };
}

// ─── Option Chain WS Hook (tick-based) ────────────────────────────

export function useOptionChainWS(symbol: string): UseOptionChainWSReturn {
  const [data, setData] = useState<OptionChainTick | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);

  useEffect(() => {
    if (!symbol) return;

    const socket = getSharedSocket();

    const onConnect = () => {
      setIsConnected(true);
      socket.emit('join-room', symbol);
    };
    const onDisconnect = () => setIsConnected(false);
    const onTick = (tick: OptionChainTick) => {
      setData(tick);
      setLastUpdate(tick.timestamp || Date.now());
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('tick', onTick);

    if (socket.connected) {
      setIsConnected(true);
      socket.emit('join-room', symbol);
    }

    return () => {
      socket.emit('leave-room', symbol);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('tick', onTick);
      setIsConnected(false);
      releaseSharedSocket();
    };
  }, [symbol]);

  return { data, isConnected, lastUpdate };
}

// ─── Market Status WS Hook ────────────────────────────────────────

export function useMarketStatusWS(): UseMarketStatusWSReturn {
  const [status, setStatus] = useState<MarketStatus>({
    isOpen: false,
    vix: 0,
    pcr: 1,
  });
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const socket = getSharedSocket();

    const onConnect = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);
    const onMarketStatus = (data: MarketStatus) => setStatus(data);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('market-status', onMarketStatus);

    if (socket.connected) setIsConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('market-status', onMarketStatus);
      setIsConnected(false);
      releaseSharedSocket();
    };
  }, []);

  return { ...status, isConnected };
}
