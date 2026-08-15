'use client';

import { useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// CoinDCX real-time price feed via server-side SSE bridge.
// CoinDCX's Socket.IO stream rejects browser-origin WebSocket connections, so the
// Next.js route /api/coindcx/stream holds the socket.io connection server-side
// and relays every "price-change" tick to us over Server-Sent Events.
// ─────────────────────────────────────────────────────────────────────────────

export function useCoinDCXLivePrice(market: string) {
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!market) return;
    let es: EventSource | null = null;
    let disposed = false;

    es = new EventSource(`/api/coindcx/stream?market=${encodeURIComponent(market)}`);
    es.onmessage = (ev) => {
      if (disposed) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'connected') {
          setConnected(true);
        } else if (msg.type === 'tick' && msg.data) {
          const p = parseFloat(msg.data.p);
          if (!isNaN(p) && p > 0) setLivePrice(p);
        } else if (msg.type === 'error') {
          setConnected(false);
        }
      } catch {}
    };
    es.onerror = () => {
      if (!disposed) setConnected(false);
    };

    return () => {
      disposed = true;
      es?.close();
      setConnected(false);
    };
  }, [market]);

  return { livePrice, connected };
}