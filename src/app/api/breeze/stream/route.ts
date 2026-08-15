// Breeze WebSocket → SSE bridge
// Breeze's live stream is a server-side Socket.IO connection (livestream.icicidirect.com).
// Browsers can't connect directly, so this route holds the Breeze WS connection and
// relays every tick to the client over Server-Sent Events.
//
// Usage: GET /api/breeze/stream?symbol=NIFTY&exchange=NSE
//
// Tick shape (from Breeze onTicks):
//   { time: "HH:mm:ss", ltp: 24423.45, exchange_code: "NSE", ... }
// We also send the first candle-close of the day so the client can seed the chart.

import { initSession, getBreezeClient, getConfig } from "@/lib/icici-breeze/auth";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EXCHANGE_CODE: Record<string, string> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  FINNIFTY: "NSE",
  MIDCPNIFTY: "NSE",
  SENSEX: "BSE",
  BANKEX: "BSE",
};

const STOCK_CODE: Record<string, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY",
  SENSEX: "SENSEX",
  BANKEX: "BANKEX",
};

// Keep a single Breeze WS subscription per symbol and fan it out to all SSE clients.
interface Stream {
  breeze: any;
  token: string;
  clients: Set<ReadableStreamDefaultController>;
  lastTick: any;
}
const streams = new Map<string, Stream>();

function closeStream(key: string) {
  const s = streams.get(key);
  if (s) {
    try { s.breeze.unwatch?.(s.token); } catch {}
    try { s.breeze.wsDisconnect?.(); } catch {}
    streams.delete(key);
  }
}

function attachTickHandler(stream: Stream, key: string) {
  stream.breeze.onTicks = (data: any) => {
    stream.lastTick = data;
    const msg = `data: ${JSON.stringify({ type: "tick", tick: data })}\n\n`;
    for (const c of stream.clients) {
      try { c.enqueue(msg); } catch {}
    }
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
  const exchange = EXCHANGE_CODE[symbol] || 'NSE';
  const stockCode = STOCK_CODE[symbol] || symbol;
  const key = `${exchange}:${stockCode}`;

  const encoder = new TextEncoder();

  // Lazily open the Breeze WS subscription if it isn't alive.
  if (!streams.has(key)) {
    try {
      await initSession();
      const breeze = getBreezeClient();
      // initSession() only validates the session — it does NOT populate the
      // client's WS auth fields (userId/sessionKey). The WebSocket handshake
      // needs those, so generate the session on the client explicitly.
      const { secretKey, sessionToken } = getConfig();
      if (!breeze.sessionKey || !breeze.userId) {
        await breeze.generateSession(secretKey, sessionToken);
      }
      breeze.wsConnect();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Breeze WS connect timeout')), 8000);
        const s = breeze.socket;
        if (!s) { clearTimeout(timer); reject(new Error('No Breeze socket')); return; }
        const onConnect = () => { clearTimeout(timer); s.off('connect', onConnect); resolve(); };
        const onErr = (e: any) => { clearTimeout(timer); s.off('connect', onConnect); reject(new Error(e?.message || 'Breeze WS error')); };
        s.on('connect', onConnect);
        s.once('connect_error', onErr);
        s.once('error', onErr);
      });

      const tokenInfo = breeze.getStockTokenValue({ exchangeCode: exchange, stockCode, getMarketDepth: false });
      const token = tokenInfo.exch_quote_token;
      const stream: Stream = { breeze, token, clients: new Set(), lastTick: null };
      streams.set(key, stream);
      attachTickHandler(stream, key);
      breeze.watch([token]);
      console.log(`[Breeze Stream] subscribed ${exchange}:${stockCode} token=${token}`);
    } catch (e: any) {
      console.error('[Breeze Stream] init error:', e.message);
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
      // Seed with the last known tick (if any) so a reconnecting client catches up.
      if (stream.lastTick) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "tick", tick: stream.lastTick })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", symbol, exchange })}\n\n`));
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