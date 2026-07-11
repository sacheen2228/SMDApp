import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { getOptionChain, getOptionChainExpiries } from './icici-breeze/option-chain';
import { initSession } from './icici-breeze/auth';
import { getNSEOptionChain } from './nse-api';

let io: Server;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 5000;
let sessionInitialized = false;

// ─── Polling: Fetch option chain & broadcast ticks ────────────────
async function fetchAndBroadcast() {
  if (!io) return;
  const clientCount = io.engine.clientsCount ?? 0;
  if (clientCount === 0) {
    stopPolling();
    return;
  }

  const symbols = ['NIFTY', 'BANKNIFTY'];
  for (const symbol of symbols) {
    try {
      let chainData: any = null;

      // Init Breeze session once
      if (!sessionInitialized) {
        sessionInitialized = true;
        await initSession().catch(() => {});
      }

      // Try Breeze API
      try {
        const expiries = await getOptionChainExpiries(symbol);
        for (const exp of expiries) {
          const chain = await getOptionChain(symbol, exp);
          if (chain) {
            chainData = chain;
            break;
          }
        }
      } catch {
        // Breeze failed, try NSE
      }

      // Fallback to NSE
      if (!chainData) {
        try {
          const nseData = await getNSEOptionChain(symbol);
          if (nseData?.records?.data) {
            const callMap = new Map<number, any>();
            const putMap = new Map<number, any>();

            for (const row of nseData.records.data) {
              if (row.CE) {
                callMap.set(row.strikePrice, {
                  strikePrice: row.strikePrice,
                  ltp: row.CE.lastPrice || 0,
                  openInterest: row.CE.openInterest || 0,
                  oiChange: row.CE.changeinOpenInterest || 0,
                  volume: row.CE.totalTradedVolume || 0,
                  iv: row.CE.impliedVolatility || 0,
                  delta: (row.CE as any).delta || (row.CE as any).greeks?.delta || 0,
                  gamma: (row.CE as any).gamma || (row.CE as any).greeks?.gamma || 0,
                  theta: (row.CE as any).theta || (row.CE as any).greeks?.theta || 0,
                  vega: (row.CE as any).vega || (row.CE as any).greeks?.vega || 0,
                });
              }
              if (row.PE) {
                putMap.set(row.strikePrice, {
                  strikePrice: row.strikePrice,
                  ltp: row.PE.lastPrice || 0,
                  openInterest: row.PE.openInterest || 0,
                  oiChange: row.PE.changeinOpenInterest || 0,
                  volume: row.PE.totalTradedVolume || 0,
                  iv: row.PE.impliedVolatility || 0,
                  delta: (row.PE as any).delta || (row.PE as any).greeks?.delta || 0,
                  gamma: (row.PE as any).gamma || (row.PE as any).greeks?.gamma || 0,
                  theta: (row.PE as any).theta || (row.PE as any).greeks?.theta || 0,
                  vega: (row.PE as any).vega || (row.PE as any).greeks?.vega || 0,
                });
              }
            }

            const spotPrice = nseData.records?.underlyingValue || 0;
            const allStrikes = [...new Set([...callMap.keys(), ...putMap.keys()])].sort((a, b) => a - b);
            const calls = allStrikes.map((s) => callMap.get(s)).filter(Boolean);
            const puts = allStrikes.map((s) => putMap.get(s)).filter(Boolean);
            const atmStrike = allStrikes.reduce((prev, curr) =>
              Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
            );

            chainData = {
              symbol,
              spotPrice,
              strikes: allStrikes,
              calls,
              puts,
              atmStrike,
              timestamp: new Date().toISOString(),
            };
          }
        } catch {
          // NSE also failed — skip this symbol
        }
      }

      if (!chainData) continue;

      const { spotPrice, calls, puts, atmStrike } = chainData;

      // Compute market status data
      const totalCallOI = calls.reduce((sum: number, c: any) => sum + (c.openInterest || 0), 0);
      const totalPutOI = puts.reduce((sum: number, p: any) => sum + (p.openInterest || 0), 0);
      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

      // Broadcast tick
      io.to(symbol).emit('tick', {
        symbol,
        spot: spotPrice,
        calls: calls.map((c: any) => ({
          strike: c.strikePrice,
          ltp: c.ltp,
          oi: c.openInterest,
          oiChg: c.oiChange,
          volume: c.volume,
          iv: c.iv,
          delta: c.delta,
          gamma: c.gamma,
          theta: c.theta,
          vega: c.vega,
        })),
        puts: puts.map((p: any) => ({
          strike: p.strikePrice,
          ltp: p.ltp,
          oi: p.openInterest,
          oiChg: p.oiChange,
          volume: p.volume,
          iv: p.iv,
          delta: p.delta,
          gamma: p.gamma,
          theta: p.theta,
          vega: p.vega,
        })),
        atmStrike,
        timestamp: Date.now(),
      });

      // Broadcast market status (once per cycle, on NIFTY)
      if (symbol === 'NIFTY') {
        const now = new Date();
        const hours = now.getHours();
        const mins = now.getMinutes();
        const dayOfWeek = now.getDay();
        const timeVal = hours * 60 + mins;
        const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
        const isOpen = isWeekday && timeVal >= 555 && timeVal <= 930; // 9:15-15:30

        io.emit('market-status', {
          isOpen,
          vix: 15, // VIX from NSE would require separate API; use reasonable default
          pcr,
        });
      }
    } catch (err) {
      console.error(`[WS Poll] Error fetching ${symbol}:`, err);
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  console.log('[WS] Starting option chain poller');
  pollTimer = setInterval(fetchAndBroadcast, POLL_INTERVAL_MS);
  // Initial fetch
  fetchAndBroadcast();
}

function stopPolling() {
  if (pollTimer) {
    console.log('[WS] Stopping option chain poller (no clients)');
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Socket.IO Server ─────────────────────────────────────────────
export function initWebSocket(server: HttpServer): Server {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket: Socket) => {
    const symbol = (socket.handshake.query.symbol as string) || 'NIFTY';
    socket.join(symbol);
    console.log(`[WS] Client connected: ${socket.id} → room: ${symbol}`);

    // Start polling on first client
    startPolling();

    socket.on('join-room', (newSymbol: string) => {
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }
      socket.join(newSymbol);
      console.log(`[WS] ${socket.id} joined room: ${newSymbol}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Client disconnected: ${socket.id} — ${reason}`);
      // Stop polling if no clients remain
      const remaining = io.engine.clientsCount ?? 0;
      if (remaining <= 1) { // <= 1 because disconnect hasn't fully processed yet
        setTimeout(() => {
          const count = io.engine.clientsCount ?? 0;
          if (count === 0) stopPolling();
        }, 1000);
      }
    });
  });

  console.log('[WS] Socket.IO server attached');
  return io;
}

export function broadcastOptionChain(symbol: string, data: any): void {
  if (!io) return;
  io.to(symbol).emit('option-chain-update', { symbol, data, timestamp: Date.now() });
}

export function broadcastPrice(symbol: string, price: any): void {
  if (!io) return;
  io.to(symbol).emit('price-update', { symbol, price, timestamp: Date.now() });
}

export function broadcastSignal(signal: any): void {
  if (!io) return;
  io.emit('ai-signal', { signal, timestamp: Date.now() });
}
