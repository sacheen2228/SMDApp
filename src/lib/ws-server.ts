import { Server as SocketIOServer } from "socket.io";
import { createServer } from "http";

export function initWebSocket(httpServer: any) {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket: any) => {
    console.log("WebSocket client connected");
    socket.on("disconnect", () => {
      console.log("WebSocket client disconnected");
    });
  });
}
