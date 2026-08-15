// Breeze WebSocket → SSE bridge
// Breeze's live stream is a server-side Socket.IO connection (livestream.icicidirect.com).
// Browsers can't connect directly, so this route holds the Breeze WS connection and
// relays every tick to the client over Server-Sent Events.
//
// Usage: GET /api/breeze/stream?symbol=NIFTY
//
// Breeze allows only ONE live WS connection per session, so we keep a single
// shared connection and `watch()` every requested symbol's token on it. Ticks are
// fanned out to the per-symbol SSE client sets.
//
// Tick shape (from Breeze onTicks):
//   { time: "HH:mm:ss", ltp: 24423.45, exchange_code: "NSE", ... }

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
  BANKNIFTY: "CNXBAN",
  FINNIFTY: "NIFFIN",
  MIDCPNIFTY: "NIFMID",
  SENSEX: "BSESEN",
  BANKEX: "BSESEN",
};

// Token lookup exchange — NIFTY lives on NSE, SENSEX/BANKEX on BSE;
// BANKNIFTY/FINNIFTY/MIDCPNIFTY cash indices are also NSE.
const TOKEN_EXCHANGE: Record<string, string> = {
  NIFTY: "NSE",
  BANKNIFTY: "NSE",
  FINNIFTY: "NSE",
  MIDCPNIFTY: "NSE",
  SENSEX: "BSE",
  BANKEX: "BSE",
};

// A single shared Breeze WS connection + per-symbol client fan-out.
interface SharedStream {
  breeze: any;
  tokens: Map<string, string>; // key -> token
  clients: Map<string, Set<ReadableStreamDefaultController>>; // key -> SSE clients
  lastTick: Map<string, any>; // key -> last tick
  connecting: boolean;
}
let shared: SharedStream | null = null;
let connectPromise: Promise<void> | null = null;

function tokenKey(symbol: string): string {
  const exchange = EXCHANGE_CODE[symbol] || 'NSE';
  const stockCode = STOCK_CODE[symbol] || symbol;
  return `${exchange}:${stockCode}`;
}

function closeShared() {
  if (shared) {
    try { shared.breeze.wsDisconnect?.(); } catch {}
    shared = null;
    connectPromise = null;
  }
}

async function ensureConnected(): Promise<SharedStream> {
  if (shared) return shared;
  if (connectPromise) return connectPromise.then(() => shared!);
  connectPromise = (async () => {
    await initSession();
    const breeze = getBreezeClient();
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
    shared = {
      breeze,
      tokens: new Map(),
      clients: new Map(),
      lastTick: new Map(),
      connecting: false,
    };
    breeze.onTicks = (data: any) => {
      // Breeze ticks carry the token in data[0] when it's an array.
      let token: string | undefined;
      let tick: any = data;
      if (Array.isArray(data)) {
        tick = data[0];
        token = data[0]?.[0];
      } else {
        token = data?.token || data?.exch_quote_token;
      }
      if (!token) return;
      for (const [key, t] of shared!.tokens) {
        if (t === token) {
          shared!.lastTick.set(key, tick);
          const msg = `data: ${JSON.stringify({ type: "tick", tick })}\n\n`;
          for (const c of shared!.clients.get(key) || []) {
            try { c.enqueue(msg); } catch {}
          }
        }
      }
    };
    breeze.onClose = () => {
      shared = null;
      connectPromise = null;
    };
    console.log('[Breeze Stream] shared WS connected');
  })();
  try {
    await connectPromise;
  } catch (e) {
    connectPromise = null;
    throw e;
  }
  return shared!;
}

async function subscribeToken(symbol: string): Promise<string> {
  const s = await ensureConnected();
  const key = tokenKey(symbol);
  let token = s.tokens.get(key);
  if (!token) {
    const stockCode = STOCK_CODE[symbol] || symbol;
    const tokenInfo = s.breeze.getStockTokenValue({ exchangeCode: TOKEN_EXCHANGE[symbol] || 'NSE', stockCode, getMarketDepth: false });
    token = tokenInfo.exch_quote_token;
    s.tokens.set(key, token);
    s.breeze.watch([token]);
    console.log(`[Breeze Stream] subscribed ${key} token=${token}`);
  }
  return token;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') || 'NIFTY').toUpperCase();
  const exchange = EXCHANGE_CODE[symbol] || 'NSE';
  const key = tokenKey(symbol);

  const encoder = new TextEncoder();

  // Subscribe the symbol to the shared connection (lazy).
  try {
    await subscribeToken(symbol);
  } catch (e: any) {
    console.error('[Breeze Stream] init error:', e.message);
    return new Response(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      status: 200,
    });
  }

  const s = shared!;
  if (!s.clients.has(key)) s.clients.set(key, new Set());

  let activeController: ReadableStreamDefaultController | null = null;
  const responseStream = new ReadableStream({
    start(controller) {
      activeController = controller;
      s.clients.get(key)!.add(controller);
      // Seed with the last known tick (if any) so a reconnecting client catches up.
      const last = s.lastTick.get(key);
      if (last) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "tick", tick: last })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", symbol, exchange })}\n\n`));
    },
    cancel() {
      const set = s.clients.get(key);
      if (set && activeController) set.delete(activeController);
      activeController = null;
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