// CoinDCX WebSocket → SSE bridge
// CoinDCX's public Socket.IO stream rejects browser-origin WebSocket connections
// (Origin header check), but accepts Node server connections. This route holds a
// server-side socket.io-client connection and relays every price-change tick to
// the browser over SSE — so the NEXUS chart is truly tick-by-tick.
//
// Usage: GET /api/coindcx/stream?market=BTCUSDT
//
// Tick payload (parsed from price-change event):
//   { T: <epoch ms>, p: "<price>", pr: "spot" }

import { io, type Socket } from 'socket.io-client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ClientStream {
  socket: Socket;
  channel: string;
  clients: Set<ReadableStreamDefaultController>;
}

const streams = new Map<string, ClientStream>();

function closeStream(key: string) {
  const s = streams.get(key);
  if (s) {
    try { s.socket.disconnect(); } catch {}
    streams.delete(key);
  }
}

function toPair(market: string): string {
  if (!market) return '';
  const quote = market.endsWith('INR') ? 'INR' : market.endsWith('BTC') ? 'BTC' : 'USDT';
  const base = quote === 'INR' ? market.slice(0, -3) : quote === 'BTC' ? market.slice(0, -3) : market.slice(0, -4);
  if (!base) return '';
  return `B-${base}_${quote}`;
}

function broadcast(stream: ClientStream, payload: any) {
  const msg = `data: ${JSON.stringify({ type: "tick", data: payload })}\n\n`;
  for (const c of stream.clients) {
    try { c.enqueue(msg); } catch {}
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get('market') || 'BTCUSDT').toUpperCase();
  const pair = toPair(market);
  if (!pair) return new Response('data: {"type":"error","error":"invalid market"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });

  const key = pair;
  const encoder = new TextEncoder();

  if (!streams.has(key)) {
    try {
      const socket = io('wss://stream.coindcx.com', {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 30,
        reconnectionDelay: 2000,
        timeout: 10000,
      });
      const stream: ClientStream = { socket, channel: `${pair}@prices`, clients: new Set() };
      streams.set(key, stream);

      socket.on('connect', () => {
        socket.emit('join', { channelName: `${pair}@prices` });
      });
      socket.on('price-change', (payload: any) => {
        const raw = payload?.data;
        if (typeof raw === 'string') {
          try { broadcast(stream, JSON.parse(raw)); } catch {}
        } else if (payload?.p) {
          broadcast(stream, { T: payload.T, p: payload.p, pr: payload.pr || 'spot' });
        }
      });
      socket.on('disconnect', () => {
        if (stream.clients.size === 0) closeStream(key);
      });

      // Wait for the connection before streaming to avoid a burst of "pending".
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CoinDCX WS connect timeout')), 10000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', (e: any) => { clearTimeout(timer); reject(new Error(e?.message || 'CoinDCX WS error')); });
      });
    } catch (e: any) {
      console.error('[CoinDCX Stream] init error:', e.message);
      return new Response(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        status: 200,
      });
    }
  }

  const stream = streams.get(key)!;

  const responseStream = new ReadableStream({
    start(controller) {
      stream.clients.add(controller);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", market, pair })}\n\n`));
    },
    cancel() {
      stream.clients.delete(controller as any);
      if (stream.clients.size === 0) {
        closeStream(key);
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}