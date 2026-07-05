import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';

let io: Server;

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

    socket.on('join-room', (newSymbol: string) => {
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }
      socket.join(newSymbol);
      console.log(`[WS] ${socket.id} joined room: ${newSymbol}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Client disconnected: ${socket.id} — ${reason}`);
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
