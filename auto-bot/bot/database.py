"""SQLite persistence for alerts, trades, and daily stats."""
import sqlite3
import json
from dataclasses import dataclass
from datetime import datetime, date
from pathlib import Path
from typing import List, Optional

DB_PATH = Path(__file__).parent.parent / "data" / "trades.db"


@dataclass
class Alert:
    id: str
    ticker: str
    market: str
    level: float
    stop: float
    target: float
    volume_ratio: float
    touches: int
    alert_time: str
    qty: int = 0
    status: str = "pending"  # pending | accepted | rejected


@dataclass
class Trade:
    id: int
    ticker: str
    market: str
    qty: int
    entry_price: float
    stop_loss: float
    target: float
    status: str  # open | closed_win | closed_loss
    entry_time: str
    exit_time: Optional[str] = None
    exit_price: Optional[float] = None
    pnl: Optional[float] = None


class Database:
    """Wraps a SQLite connection with helper methods for the bot's tables."""

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self):
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id TEXT PRIMARY KEY,
                    ticker TEXT NOT NULL,
                    market TEXT NOT NULL,
                    level REAL NOT NULL,
                    stop REAL NOT NULL,
                    target REAL NOT NULL,
                    volume_ratio REAL NOT NULL,
                    touches INTEGER NOT NULL,
                    alert_time TEXT NOT NULL,
                    qty INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending'
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    market TEXT NOT NULL,
                    qty INTEGER NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    target REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open',
                    entry_time TEXT NOT NULL,
                    exit_time TEXT,
                    exit_price REAL,
                    pnl REAL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS alerted_tickers (
                    ticker TEXT PRIMARY KEY,
                    market TEXT NOT NULL,
                    first_alert_date TEXT NOT NULL
                )
            """)
            conn.commit()

    # ---------- Alerts ----------
    def add_alert(self, alert: Alert):
        with self._connect() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO alerts
                   (id, ticker, market, level, stop, target, volume_ratio, touches, alert_time, qty, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (alert.id, alert.ticker, alert.market, alert.level, alert.stop,
                 alert.target, alert.volume_ratio, alert.touches, alert.alert_time, alert.qty, alert.status)
            )
            conn.execute(
                "INSERT OR IGNORE INTO alerted_tickers (ticker, market, first_alert_date) VALUES (?, ?, ?)",
                (alert.ticker, alert.market, date.today().isoformat())
            )
            conn.commit()

    def get_pending_alerts(self) -> List[Alert]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM alerts WHERE status='pending' ORDER BY alert_time DESC").fetchall()
            return [Alert(**dict(r)) for r in rows]

    def get_alert(self, alert_id: str) -> Optional[Alert]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
            return Alert(**dict(row)) if row else None

    def update_alert_status(self, alert_id: str, status: str):
        with self._connect() as conn:
            conn.execute("UPDATE alerts SET status=? WHERE id=?", (status, alert_id))
            conn.commit()

    def already_alerted(self, ticker: str) -> bool:
        """A ticker is only alerted once ever (per requirement)."""
        with self._connect() as conn:
            row = conn.execute("SELECT 1 FROM alerted_tickers WHERE ticker=?", (ticker,)).fetchone()
            return row is not None

    def has_open_position(self, ticker: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM trades WHERE ticker=? AND status='open'", (ticker,)
            ).fetchone()
            return row is not None

    # ---------- Trades ----------
    def add_trade(self, ticker: str, market: str, qty: int, entry_price: float,
                  stop_loss: float, target: float) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                """INSERT INTO trades (ticker, market, qty, entry_price, stop_loss, target, status, entry_time)
                   VALUES (?, ?, ?, ?, ?, ?, 'open', ?)""",
                (ticker, market, qty, entry_price, stop_loss, target, datetime.now().isoformat())
            )
            conn.commit()
            return cur.lastrowid

    def close_trade(self, trade_id: int, exit_price: float, reason: str):
        with self._connect() as conn:
            trade = conn.execute("SELECT * FROM trades WHERE id=?", (trade_id,)).fetchone()
            if not trade:
                return None
            pnl = (exit_price - trade["entry_price"]) * trade["qty"]
            status = "closed_win" if pnl > 0 else "closed_loss"
            conn.execute(
                """UPDATE trades SET status=?, exit_time=?, exit_price=?, pnl=? WHERE id=?""",
                (status, datetime.now().isoformat(), exit_price, pnl, trade_id)
            )
            conn.commit()
            return {"ticker": trade["ticker"], "pnl": pnl, "exit_price": exit_price, "reason": reason}

    def get_open_trades(self) -> List[Trade]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM trades WHERE status='open' ORDER BY entry_time DESC").fetchall()
            return [Trade(**dict(r)) for r in rows]

    def get_closed_trades(self, limit: int = 20) -> List[Trade]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM trades WHERE status!='open' ORDER BY exit_time DESC LIMIT ?", (limit,)
            ).fetchall()
            return [Trade(**dict(r)) for r in rows]

    # ---------- Stats ----------
    def get_today_stats(self) -> dict:
        today = date.today().isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM trades WHERE status!='open' AND exit_time LIKE ?", (f"{today}%",)
            ).fetchall()
            wins = sum(1 for r in rows if r["pnl"] and r["pnl"] > 0)
            losses = sum(1 for r in rows if r["pnl"] and r["pnl"] <= 0)
            total_pnl = sum(r["pnl"] or 0 for r in rows)
            return {"total_trades": len(rows), "wins": wins, "losses": losses, "total_pnl": total_pnl}

    def get_alltime_stats(self) -> dict:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM trades WHERE status!='open'").fetchall()
            wins = sum(1 for r in rows if r["pnl"] and r["pnl"] > 0)
            losses = sum(1 for r in rows if r["pnl"] and r["pnl"] <= 0)
            total_pnl = sum(r["pnl"] or 0 for r in rows)
            return {"total_trades": len(rows), "wins": wins, "losses": losses, "total_pnl": total_pnl}
