"""FastAPI server: REST endpoints + WebSocket feed for the React dashboard."""
import asyncio
from pathlib import Path
from typing import List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from bot.database import Database


class DashboardServer:
    def __init__(self, engine=None, host: str = "0.0.0.0", port: int = 8000):
        self.engine = engine
        self.host = host
        self.port = port
        self.app = FastAPI(title="Breakout/Desk API")
        self.app.add_middleware(
            CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
        )
        self.clients: List[WebSocket] = []
        self.db = Database()
        self._setup_routes()

    def _setup_routes(self):
        @self.app.get("/api/stats")
        async def get_stats():
            today = self.db.get_today_stats()
            alltime = self.db.get_alltime_stats()
            return {
                "today_pnl": today["total_pnl"],
                "today_trades": today["total_trades"],
                "win_rate": (alltime["wins"] / alltime["total_trades"] * 100) if alltime["total_trades"] else 0,
                "alltime_pnl": alltime["total_pnl"],
                "open_positions": len(self.db.get_open_trades()),
                "wins": alltime["wins"],
                "losses": alltime["losses"],
            }

        @self.app.get("/api/alerts")
        async def get_alerts():
            return [self._alert_to_dict(a) for a in self.db.get_pending_alerts()]

        @self.app.get("/api/positions")
        async def get_positions():
            return [self._trade_to_dict(t) for t in self.db.get_open_trades()]

        @self.app.get("/api/closed")
        async def get_closed():
            return [self._trade_to_dict(t) for t in self.db.get_closed_trades()]

        @self.app.websocket("/ws")
        async def websocket_endpoint(websocket: WebSocket):
            await websocket.accept()
            self.clients.append(websocket)
            try:
                while True:
                    await websocket.send_json(self._get_dashboard_data())
                    await asyncio.sleep(5)
            except WebSocketDisconnect:
                if websocket in self.clients:
                    self.clients.remove(websocket)

        static_path = Path(__file__).parent.parent / "dashboard" / "build"
        if static_path.exists():
            self.app.mount("/", StaticFiles(directory=static_path, html=True), name="static")

    def _alert_to_dict(self, a):
        return {
            "id": a.id, "ticker": a.ticker, "market": a.market,
            "broke": a.level, "stop": a.stop, "target": a.target,
            "volume": f"{a.volume_ratio}x", "touches": a.touches,
            "qty": a.qty, "time": a.alert_time,
        }

    def _trade_to_dict(self, t):
        last = t.exit_price if t.exit_price is not None else t.entry_price
        pnl = t.pnl if t.pnl is not None else 0.0
        return {
            "id": t.id, "ticker": t.ticker, "market": t.market, "qty": t.qty,
            "entry": t.entry_price, "stop": t.stop_loss, "target": t.target,
            "last": last, "live_pnl": pnl, "status": t.status,
        }

    def _get_dashboard_data(self):
        today = self.db.get_today_stats()
        alltime = self.db.get_alltime_stats()
        open_trades = self.db.get_open_trades()
        closed_trades = self.db.get_closed_trades(limit=10)
        alerts = self.db.get_pending_alerts()

        return {
            "stats": {
                "today_pnl": today["total_pnl"],
                "win_rate": (alltime["wins"] / alltime["total_trades"] * 100) if alltime["total_trades"] else 0,
                "trades_today": today["total_trades"],
                "open_count": len(open_trades),
                "alltime_pnl": alltime["total_pnl"],
            },
            "alerts": [self._alert_to_dict(a) for a in alerts],
            "positions": [self._trade_to_dict(t) for t in open_trades],
            "closed": [self._trade_to_dict(t) for t in closed_trades],
            "winners_vs_losers": {"wins": alltime["wins"], "losses": alltime["losses"]},
        }

    async def start(self):
        import uvicorn
        config = uvicorn.Config(self.app, host=self.host, port=self.port, log_level="info")
        server = uvicorn.Server(config)
        await server.serve()
