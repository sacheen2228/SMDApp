// Socket.IO WebSocket Server
// Attaches to Next.js HTTP server and broadcasts live price/option data
// to browser clients via rooms (one room per symbol).

import type { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';

let io: Server | null = null;

export function initWebSocket(server: HTTPServer): Server {
  if (io) return io;

  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  console.log('[WS] Socket.IO server attached');

  io.on('connection', (socket) => {
    console.log('[WS] Client connected:', socket.id);

    socket.on('join-room', (symbol: string) => {
      if (symbol) {
        socket.join(symbol);
        console.log(`[WS] ${socket.id} joined ${symbol}`);
      }
    });

    socket.on('leave-room', (symbol: string) => {
      if (symbol) {
        socket.leave(symbol);
      }
    });

    socket.on('disconnect', () => {
      console.log('[WS] Client disconnected:', socket.id);
    });
  });

  // Broadcast price updates every 5s during market hours
  const broadcastLoop = setInterval(() => {
    if (!io) return;

    const now = new Date();
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60 * 1000));
    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const day = ist.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const timeNum = hours * 60 + minutes;
    const isOpen = isWeekday && timeNum >= 555 && timeNum <= 930; // 9:15 - 15:30

    // Broadcast market status to all connected clients
    io.emit('market-status', {
      isOpen,
      vix: 0,
      pcr: 1,
    });
  }, 5_000);

  // Clean up on server shutdown
  const cleanup = () => {
    clearInterval(broadcastLoop);
    if (io) {
      io.close();
      io = null;
    }
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return io;
}

export function getIO(): Server | null {
  return io;
}

// Broadcast to a specific symbol room
export function broadcastToSymbol(symbol: string, event: string, data: any) {
  if (io) {
    io.to(symbol).emit(event, data);
  }
}

// Broadcast to all connected clients
export function broadcastAll(event: string, data: any) {
  if (io) {
    io.emit(event, data);
  }
}
