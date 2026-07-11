"""
backtest_analyzer.py
Options backtest engine: LIVE mode (real trade data) and DEMO mode (simulation).
Audit-grade: reads actual trade data, verifies TP/SL levels, produces
deterministic daily reports.

Usage:
  python backtest_analyzer.py --live -i trades.csv   # Live mode (real data)
  python backtest_analyzer.py --demo                   # Demo mode (simulated)
"""

import argparse, csv, json, sys, os
from datetime import datetime
from io import StringIO
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd
import numpy as np

# ─── Lot size mapping ───────────────────────────────────────────
LOT_SIZES = {
    "NIFTY": 65, "BANKNIFTY": 25, "FINNIFTY": 20, "MIDCPNIFTY": 50,
    "SENSEX": 20, "BANKEX": 15,
}

# ─── Column aliases ─────────────────────────────────────────────
COL_ALIASES = {
    "symbol": ["symbol", "scrip", "ticker", "index", "instrument", "name", "asset"],
    "type": ["type", "option_type", "side", "direction", "opt_type", "optiontype"],
    "strike": ["strike", "strikeprice", "strike_price", "stk", "k"],
    "entry": ["entry", "entry_price", "buy_price", "entryprice", "price", "premium", "ltp"],
    "exit": ["exit", "exit_price", "sell_price", "exitprice", "close_price", "close"],
    "time": ["time", "datetime", "timestamp", "date", "entry_time", "entrytime", "bar_time"],
    "qty": ["qty", "quantity", "lots", "lot", "shares", "size"],
    "status": ["status", "result", "outcome", "trade_status"],
    "pnl": ["pnl", "profit_loss", "pl", "net_pl", "realized_pl"],
    "stopLoss": ["stopLoss", "stop_loss", "sl", "stoploss"],
    "target1": ["target1", "target_1", "tp1", "tp_1"],
    "target2": ["target2", "target_2", "tp2", "tp_2"],
    "target3": ["target3", "target_3", "tp3", "tp_3"],
    "exitReason": ["exitReason", "exit_reason", "reason", "exit_note"],
    "tpHitLevel": ["tpHitLevel", "tp_hit_level", "hit_level", "tp_level"],
    "lotSize": ["lotSize", "lot_size", "lotsize", "position_size", "positionSize"],
}


def find_col(df: pd.DataFrame, candidates: list) -> Optional[str]:
    for c in candidates:
        for col in df.columns:
            if col.strip().lower() == c.lower():
                return col
    return None


def normalize_csv(df: pd.DataFrame, live_mode: bool = False) -> pd.DataFrame:
    """Map flexible CSV column names to standard names."""
    mapping = {}
    for standard, aliases in COL_ALIASES.items():
        col = find_col(df, aliases)
        if col:
            mapping[col] = standard
    df = df.rename(columns=mapping)

    if "type" in df.columns:
        df["type"] = df["type"].astype(str).str.upper().str.strip()
        df["type"] = df["type"].replace({"CALL": "CE", "PUT": "PE", "C": "CE", "P": "PE"})
    elif "type" not in df.columns:
        for c in df.columns:
            cl = c.lower().strip()
            if cl in ("ce", "pe", "call", "put"):
                df = df.rename(columns={c: "type"})
                break

    if "symbol" in df.columns:
        df["symbol"] = df["symbol"].astype(str).str.upper().str.strip()
    if "strike" in df.columns:
        df["strike"] = pd.to_numeric(df["strike"], errors="coerce")
    if "entry" in df.columns:
        df["entry"] = pd.to_numeric(df["entry"], errors="coerce")
    else:
        df["entry"] = 0
    if "exit" in df.columns:
        df["exit"] = pd.to_numeric(df["exit"], errors="coerce")
    else:
        df["exit"] = 0
    if "time" in df.columns:
        df["time"] = pd.to_datetime(df["time"], errors="coerce")
    if "qty" not in df.columns:
        df["qty"] = 1
    else:
        df["qty"] = pd.to_numeric(df["qty"], errors="coerce").fillna(1)

    # Live mode fields
    if live_mode:
        if "status" in df.columns:
            df["status"] = df["status"].astype(str).str.lower().str.strip()
        if "pnl" in df.columns:
            df["pnl"] = pd.to_numeric(df["pnl"], errors="coerce").fillna(0)
        for col in ["stopLoss", "target1", "target2", "target3"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        if "lotSize" in df.columns:
            df["lotSize"] = pd.to_numeric(df["lotSize"], errors="coerce").fillna(50)
        else:
            df["lotSize"] = 50

    return df


# ─── Demo data ──────────────────────────────────────────────────
DEMO_CSV = """time,symbol,type,strike,entry,exit
09:20:00,NIFTY,CE,24500,150.5,185.2
10:15:00,NIFTY,PE,24400,120.0,95.5
11:30:00,BANKNIFTY,CE,52500,320.0,300.0
12:45:00,NIFTY,CE,24600,85.0,125.0
14:00:00,FINNIFTY,PE,23400,95.0,55.0
14:30:00,NIFTY,CE,24500,110.0,90.0
15:00:00,NIFTY,CE,24700,75.0,115.0
15:15:00,SENSEX,PE,79000,250.0,220.0
10:30:00,BANKNIFTY,CE,52600,280.0,310.0
11:00:00,NIFTY,PE,24300,130.0,170.0
"""


# ─── Data models ────────────────────────────────────────────────
@dataclass
class AuditEntry:
    """Per-trade audit trail entry."""
    time: str = ""
    symbol: str = ""
    opt_type: str = ""
    strike: float = 0
    entry: float = 0
    exit: float = 0
    stop_loss: float = 0
    target1: float = 0
    target2: float = 0
    target3: float = 0
    status: str = ""
    pnl: float = 0
    tpHitLevel: str = ""
    exitReason: str = ""
    lot_size: int = 50
    direction: str = ""
    audit_log: list[str] = field(default_factory=list)


@dataclass
class DailyReport:
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    open_trades: int = 0
    expired: int = 0
    partial: int = 0
    win_rate: float = 0
    total_pnl: float = 0
    gross_profit: float = 0
    gross_loss: float = 0
    profit_factor: float = 0
    max_drawdown: float = 0
    max_consecutive_wins: int = 0
    max_consecutive_losses: int = 0
    avg_rr_achieved: float = 0
    best_trade: float = 0
    worst_trade: float = 0
    avg_win: float = 0
    avg_loss: float = 0
    tp1_hits: int = 0
    tp2_hits: int = 0
    tp3_hits: int = 0
    trailing_sl_hits: int = 0
    sl_hits: int = 0


# ─── Live mode: process real trade data ─────────────────────────
def process_live_trades(df: pd.DataFrame) -> tuple[list[AuditEntry], DailyReport]:
    """Read actual trade data from DB. No simulation — reports what happened."""
    entries: list[AuditEntry] = []
    report = DailyReport()

    for _, row in df.iterrows():
        a = AuditEntry()
        a.time = str(row.get("time", ""))
        a.symbol = str(row.get("symbol", "NIFTY"))
        a.opt_type = str(row.get("type", "CE"))
        a.strike = float(row.get("strike", 0))
        a.entry = float(row.get("entry", 0))
        a.exit = float(row.get("exit", 0))
        a.stop_loss = float(row.get("stopLoss", 0) or 0)
        a.target1 = float(row.get("target1", 0) or 0)
        a.target2 = float(row.get("target2", 0) or 0)
        a.target3 = float(row.get("target3", 0) or 0)
        a.status = str(row.get("status", "active")).lower()
        a.pnl = float(row.get("pnl", 0) or 0)
        a.tpHitLevel = str(row.get("tpHitLevel", "") or "")
        a.exitReason = str(row.get("exitReason", "") or "")
        a.direction = "long" if a.opt_type in ("CE", "CALL") else "short"

        # Lot size
        lot_raw = row.get("lotSize", 50)
        try:
            a.lot_size = int(float(str(lot_raw)))
        except (ValueError, TypeError):
            a.lot_size = LOT_SIZES.get(a.symbol.upper(), 50)

        # ─── Build audit trail ────────────────────────────
        a.audit_log.append(f"ENTRY: {a.symbol} {a.opt_type} @ {a.strike} | Premium: {a.entry} | Lot: {a.lot_size}")

        if a.target1 > 0:
            a.audit_log.append(f"  TP1: {a.target1} | TP2: {a.target2 or 'N/A'} | TP3: {a.target3 or 'N/A'} | SL: {a.stop_loss}")
        else:
            a.audit_log.append(f"  No TP levels set | SL: {a.stop_loss}")

        # Status & exit analysis
        if a.status in ("tp", "tp_hit"):
            a.audit_log.append(f"  EXIT: TP HIT | Exit price: {a.exit} | P&L: {a.pnl}")
            if a.tpHitLevel:
                a.audit_log.append(f"  HIT LEVEL: {a.tpHitLevel}")
                if a.tpHitLevel == "TP1":
                    report.tp1_hits += 1
                elif a.tpHitLevel == "TP2":
                    report.tp2_hits += 1
                elif a.tpHitLevel == "TP3":
                    report.tp3_hits += 1
                elif a.tpHitLevel == "TRAILING_SL":
                    report.trailing_sl_hits += 1
            else:
                # Infer level from exit price
                if a.target3 > 0 and a.exit >= a.target3:
                    a.audit_log.append("  → INFERRED: TP3 (exit >= tp3)")
                    report.tp3_hits += 1
                elif a.target2 > 0 and a.exit >= a.target2:
                    a.audit_log.append("  → INFERRED: TP2 (exit >= tp2)")
                    report.tp2_hits += 1
                else:
                    a.audit_log.append("  → INFERRED: TP1")
                    report.tp1_hits += 1
            report.wins += 1
            report.gross_profit += a.pnl

        elif a.status in ("sl", "sl_hit"):
            a.audit_log.append(f"  EXIT: SL HIT | Exit price: {a.exit} | P&L: {a.pnl}")
            report.losses += 1
            report.gross_loss += abs(a.pnl)
            report.sl_hits += 1

        elif a.status in ("active", "open"):
            a.audit_log.append(f"  STATUS: Active (not yet closed) | Current P&L: {a.pnl}")
            report.open_trades += 1

        elif a.status in ("expired",):
            a.audit_log.append(f"  STATUS: Expired | Exit reason: {a.exitReason} | P&L: {a.pnl}")
            report.expired += 1

        elif a.status in ("partial", "partial_exit"):
            a.audit_log.append(f"  STATUS: Partial exit | P&L: {a.pnl}")
            report.partial += 1

        if a.exitReason:
            a.audit_log.append(f"  EXIT REASON: {a.exitReason}")

        # Verify P&L
        if a.status in ("tp", "tp_hit", "sl", "sl_hit"):
            if a.direction == "long":
                expected_pnl = round((a.exit - a.entry) * a.lot_size, 2)
            else:
                expected_pnl = round((a.entry - a.exit) * a.lot_size, 2)

            # Status consistency check
            is_profit = expected_pnl > 0
            if a.status in ("tp", "tp_hit") and not is_profit:
                a.audit_log.append(f"  ⚠️ STATUS MISMATCH: TP status but calculated P&L is negative ({expected_pnl:.2f})")
            elif a.status in ("sl", "sl_hit") and is_profit:
                a.audit_log.append(f"  ⚠️ STATUS MISMATCH: SL status but calculated P&L is positive ({expected_pnl:.2f})")

            diff = round(abs(expected_pnl - a.pnl), 2)
            if diff > 1.0:
                a.audit_log.append(f"  ⚠️ P&L MISMATCH: stored={a.pnl:.2f}, calculated={expected_pnl:.2f} (diff={diff:.2f})")
            else:
                a.audit_log.append(f"  ✅ P&L VERIFIED: stored={a.pnl:.2f} == calculated={expected_pnl:.2f}")

        entries.append(a)

    # ─── Compute daily stats ──────────────────────────────
    report.total_trades = len(entries)
    closed = report.wins + report.losses
    report.win_rate = round(report.wins / closed * 100, 1) if closed > 0 else 0
    report.total_pnl = round(report.gross_profit - report.gross_loss, 2)
    report.profit_factor = round(report.gross_profit / report.gross_loss, 2) if report.gross_loss > 0 else (
        round(report.gross_profit, 2) if report.gross_profit > 0 else 0
    )

    wins_list = [a.pnl for a in entries if a.status in ("tp", "tp_hit")]
    losses_list = [abs(a.pnl) for a in entries if a.status in ("sl", "sl_hit")]

    report.best_trade = round(max(wins_list), 2) if wins_list else 0
    report.worst_trade = round(max(losses_list), 2) if losses_list else 0  # worst = biggest losing amount
    report.avg_win = round(np.mean(wins_list), 2) if wins_list else 0
    report.avg_loss = round(np.mean(losses_list), 2) if losses_list else 0

    # Max drawdown (running PnL)
    running_pnl = 0
    peak = 0
    dd = 0
    for a in entries:
        if a.status in ("tp", "tp_hit", "sl", "sl_hit"):
            running_pnl += a.pnl
            if running_pnl > peak:
                peak = running_pnl
            drawdown = peak - running_pnl
            if drawdown > dd:
                dd = drawdown
    report.max_drawdown = round(dd, 2)

    # Consecutive streaks
    streak = 0
    max_win_streak = 0
    max_loss_streak = 0
    for a in entries:
        if a.status in ("tp", "tp_hit"):
            streak = streak + 1 if streak >= 0 else 1
            max_win_streak = max(max_win_streak, streak)
        elif a.status in ("sl", "sl_hit"):
            streak = streak - 1 if streak <= 0 else -1
            max_loss_streak = max(max_loss_streak, abs(streak))
    report.max_consecutive_wins = max_win_streak
    report.max_consecutive_losses = max_loss_streak

    # Avg R:R achieved
    rr_list = []
    for a in entries:
        if a.status in ("tp", "tp_hit", "sl", "sl_hit") and a.stop_loss > 0:
            risk = abs(a.entry - a.stop_loss) if a.direction == "long" else abs(a.stop_loss - a.entry)
            actual_move = abs(a.exit - a.entry)
            if risk > 0:
                rr_list.append(round(actual_move / risk, 2))
    report.avg_rr_achieved = round(np.mean(rr_list), 2) if rr_list else 0

    return entries, report


# ─── Demo mode: simulate SL/TP ──────────────────────────────────
@dataclass
class TradeResult:
    time: str = ""
    symbol: str = ""
    opt_type: str = ""
    strike: float = 0
    entry: float = 0
    exit: float = 0
    sl_points: float = 0
    tp_points: float = 0
    direction: str = ""
    status: str = ""
    pnl_per_lot: float = 0
    pnl_total: float = 0
    rr_achieved: float = 0
    bars_held: int = 0
    stopLoss: float = 0
    target1: float = 0
    audit_log: list[str] = field(default_factory=list)


def simulate_backtest(df: pd.DataFrame, sl_pts: float, rr: float, lot_size: int = 50) -> list[TradeResult]:
    """Simulate SL/TP for each trade. SL/TP in premium points, direction-aware."""
    results = []
    for _, row in df.iterrows():
        t = TradeResult()
        t.time = str(row.get("time", ""))
        t.symbol = str(row.get("symbol", "NIFTY"))
        t.opt_type = str(row.get("type", "CE"))
        t.strike = float(row.get("strike", 0))
        t.entry = float(row.get("entry", 0))
        t.exit = float(row.get("exit", 0))

        ls = LOT_SIZES.get(t.symbol.upper(), lot_size)
        entry = t.entry
        if entry == 0:
            continue

        tp_pts = sl_pts * rr
        t.sl_points = sl_pts
        t.tp_points = tp_pts
        t.stopLoss = entry - sl_pts if t.opt_type == "CE" else entry + sl_pts
        t.target1 = entry + tp_pts if t.opt_type == "CE" else entry - tp_pts

        t.audit_log.append(f"ENTRY: {t.symbol} {t.opt_type} @ {t.strike} | Premium: {entry} | Lot: {ls}")
        t.audit_log.append(f"  SIM SL: {t.stopLoss:.2f} | SIM TP1: {t.target1:.2f}")

        if t.opt_type == "CE":
            sl_price = entry - sl_pts
            tp_price = entry + tp_pts
            if t.exit <= sl_price:
                t.status = "SL"
                exit_price = sl_price
                t.audit_log.append(f"  EXIT: SL HIT at {sl_price} (exit={t.exit}, sl={sl_price})")
            elif t.exit >= tp_price:
                t.status = "TP"
                exit_price = tp_price
                t.audit_log.append(f"  EXIT: TP HIT at {tp_price} (exit={t.exit}, tp={tp_price})")
            else:
                t.status = "OPEN"
                exit_price = t.exit
                t.audit_log.append(f"  EXIT: OPEN at {exit_price} (no SL/TP hit)")
        else:
            sl_price = entry + sl_pts
            tp_price = entry - tp_pts
            if t.exit >= sl_price:
                t.status = "SL"
                exit_price = sl_price
                t.audit_log.append(f"  EXIT: SL HIT at {sl_price} (exit={t.exit}, sl={sl_price})")
            elif t.exit <= tp_price:
                t.status = "TP"
                exit_price = tp_price
                t.audit_log.append(f"  EXIT: TP HIT at {tp_price} (exit={t.exit}, tp={tp_price})")
            else:
                t.status = "OPEN"
                exit_price = t.exit
                t.audit_log.append(f"  EXIT: OPEN at {exit_price} (no SL/TP hit)")

        t.exit = exit_price

        if t.opt_type == "CE":
            t.pnl_per_lot = exit_price - entry
        else:
            t.pnl_per_lot = entry - exit_price

        t.pnl_total = round(t.pnl_per_lot * ls, 2)

        risk = sl_pts
        actual_move = abs(exit_price - entry)
        t.rr_achieved = round(actual_move / risk, 2) if risk > 0 else 0

        results.append(t)
    return results


# ─── Stats calculation (demo mode) ──────────────────────────────
@dataclass
class BacktestStats:
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    open_trades: int = 0
    win_rate: float = 0
    total_pnl: float = 0
    gross_profit: float = 0
    gross_loss: float = 0
    profit_factor: float = 0
    max_drawdown: float = 0
    max_consecutive_wins: int = 0
    max_consecutive_losses: int = 0
    avg_rr_achieved: float = 0
    best_trade: float = 0
    worst_trade: float = 0
    avg_win: float = 0
    avg_loss: float = 0


def compute_stats(results: list[TradeResult]) -> BacktestStats:
    s = BacktestStats()
    s.total_trades = len(results)
    if not results:
        return s

    wins_list = []
    losses_list = []
    for t in results:
        if t.status == "TP":
            s.wins += 1
            wins_list.append(t.pnl_total)
            s.gross_profit += t.pnl_total
        elif t.status == "SL":
            s.losses += 1
            losses_list.append(t.pnl_total)
            s.gross_loss += abs(t.pnl_total)
        else:
            s.open_trades += 1

    closed = s.wins + s.losses
    s.win_rate = round(s.wins / closed * 100, 1) if closed > 0 else 0
    s.total_pnl = round(s.gross_profit - s.gross_loss, 2)
    s.profit_factor = round(s.gross_profit / s.gross_loss, 2) if s.gross_loss > 0 else 0
    s.best_trade = round(max(wins_list), 2) if wins_list else 0
    s.worst_trade = round(min(losses_list), 2) if losses_list else 0
    s.avg_win = round(np.mean(wins_list), 2) if wins_list else 0
    s.avg_loss = round(np.mean(losses_list), 2) if losses_list else 0

    running_pnl = 0
    peak = 0
    dd = 0
    for t in results:
        if t.status in ("TP", "SL"):
            running_pnl += t.pnl_total
            if running_pnl > peak:
                peak = running_pnl
            drawdown = peak - running_pnl
            if drawdown > dd:
                dd = drawdown
    s.max_drawdown = round(dd, 2)

    streak = 0
    max_win_streak = 0
    max_loss_streak = 0
    for t in results:
        if t.status == "TP":
            streak = streak + 1 if streak >= 0 else 1
            max_win_streak = max(max_win_streak, streak)
        elif t.status == "SL":
            streak = streak - 1 if streak <= 0 else -1
            max_loss_streak = max(max_loss_streak, abs(streak))
    s.max_consecutive_wins = max_win_streak
    s.max_consecutive_losses = max_loss_streak

    rr_list = [t.rr_achieved for t in results if t.status in ("TP", "SL")]
    s.avg_rr_achieved = round(np.mean(rr_list), 2) if rr_list else 0

    return s


# ─── Formatters ─────────────────────────────────────────────────
def format_inr(val: float) -> str:
    return f"₹{val:,.2f}"


def build_daily_report(report: DailyReport, entries: list[AuditEntry], source: str) -> str:
    lines = []
    lines.append("=" * 72)
    lines.append(f"  DAILY TRADE REPORT — {source}")
    lines.append("=" * 72)
    lines.append("")
    lines.append(f"{'Metric':<42} {'Value':>15}")
    lines.append("  " + "-" * 57)
    lines.append(f"{'Total trades':<42} {report.total_trades:>15}")
    lines.append(f"{'Wins (TP hits)':<42} {report.wins:>15}")
    lines.append(f"{'Losses (SL hits)':<42} {report.losses:>15}")
    lines.append(f"{'Open trades':<42} {report.open_trades:>15}")
    lines.append(f"{'Expired':<42} {report.expired:>15}")
    lines.append(f"{'Win rate':<42} {report.win_rate:>14}%")
    lines.append("")
    lines.append(f"{'Total P&L':<42} {format_inr(report.total_pnl):>15}")
    lines.append(f"{'Gross profit':<42} {format_inr(report.gross_profit):>15}")
    lines.append(f"{'Gross loss':<42} {format_inr(report.gross_loss):>15}")
    lines.append(f"{'Profit factor':<42} {report.profit_factor:>15}")
    lines.append("")
    lines.append(f"{'Max drawdown':<42} {format_inr(report.max_drawdown):>15}")
    lines.append(f"{'Max consecutive wins':<42} {report.max_consecutive_wins:>15}")
    lines.append(f"{'Max consecutive losses':<42} {report.max_consecutive_losses:>15}")
    lines.append(f"{'Avg R:R achieved':<42} {report.avg_rr_achieved:>15}")
    lines.append(f"{'Best trade':<42} {format_inr(report.best_trade):>15}")
    lines.append(f"{'Worst trade':<42} {format_inr(report.worst_trade):>15}")
    lines.append(f"{'Avg win':<42} {format_inr(report.avg_win):>15}")
    lines.append(f"{'Avg loss':<42} {format_inr(report.avg_loss):>15}")
    lines.append("")
    lines.append(f"{'TP1 hits':<42} {report.tp1_hits:>15}")
    lines.append(f"{'TP2 hits':<42} {report.tp2_hits:>15}")
    lines.append(f"{'TP3 hits':<42} {report.tp3_hits:>15}")
    lines.append(f"{'Trailing SL hits':<42} {report.trailing_sl_hits:>15}")
    lines.append(f"{'SL hits':<42} {report.sl_hits:>15}")
    lines.append("")
    return "\n".join(lines)


def build_audit_trail(entries: list[AuditEntry]) -> str:
    lines = []
    lines.append("=" * 72)
    lines.append("  TRADE AUDIT TRAIL")
    lines.append("=" * 72)
    for i, a in enumerate(entries, 1):
        lines.append(f"\n  ── Trade #{i} ──")
        for log_line in a.audit_log:
            lines.append(f"    {log_line}")
    return "\n".join(lines)


def build_demo_report(stats: BacktestStats, results: list[TradeResult], sl_pts: float, rr: float, tf: str) -> str:
    lines = []
    lines.append("=" * 72)
    lines.append("  DEMO BACKTEST REPORT — Simulated Data")
    lines.append(f"  Timeframe: {tf}  |  SL: {sl_pts} pts  |  R:R: 1:{rr}")
    lines.append("=" * 72)
    lines.append("")
    lines.append(f"{'Metric':<42} {'Value':>15}")
    lines.append("  " + "-" * 57)
    lines.append(f"{'Total trades':<42} {stats.total_trades:>15}")
    lines.append(f"{'Wins (TP hits)':<42} {stats.wins:>15}")
    lines.append(f"{'Losses (SL hits)':<42} {stats.losses:>15}")
    lines.append(f"{'Open trades':<42} {stats.open_trades:>15}")
    lines.append(f"{'Win rate':<42} {stats.win_rate:>14}%")
    lines.append("")
    lines.append(f"{'Total P&L':<42} {format_inr(stats.total_pnl):>15}")
    lines.append(f"{'Gross profit':<42} {format_inr(stats.gross_profit):>15}")
    lines.append(f"{'Gross loss':<42} {format_inr(stats.gross_loss):>15}")
    lines.append(f"{'Profit factor':<42} {stats.profit_factor:>15}")
    lines.append("")
    lines.append(f"{'Max drawdown':<42} {format_inr(stats.max_drawdown):>15}")
    lines.append(f"{'Max consecutive wins':<42} {stats.max_consecutive_wins:>15}")
    lines.append(f"{'Max consecutive losses':<42} {stats.max_consecutive_losses:>15}")
    lines.append(f"{'Avg R:R achieved':<42} {stats.avg_rr_achieved:>15}")
    lines.append(f"{'Best trade':<42} {format_inr(stats.best_trade):>15}")
    lines.append(f"{'Worst trade':<42} {format_inr(stats.worst_trade):>15}")
    lines.append(f"{'Avg win':<42} {format_inr(stats.avg_win):>15}")
    lines.append(f"{'Avg loss':<42} {format_inr(stats.avg_loss):>15}")
    lines.append("")
    return "\n".join(lines)


# ─── JSON builders ──────────────────────────────────────────────
def build_live_json(report: DailyReport, entries: list[AuditEntry], source: str, symbols: list) -> dict:
    return {
        "success": True,
        "source": source,
        "dataSource": "live",
        "is_demo": False,
        "stats": {
            "total_trades": report.total_trades,
            "wins": report.wins,
            "losses": report.losses,
            "open": report.open_trades,
            "expired": report.expired,
            "partial": report.partial,
            "win_rate": report.win_rate,
            "total_pnl": report.total_pnl,
            "gross_profit": report.gross_profit,
            "gross_loss": report.gross_loss,
            "profit_factor": report.profit_factor,
            "max_drawdown": report.max_drawdown,
            "max_consecutive_wins": report.max_consecutive_wins,
            "max_consecutive_losses": report.max_consecutive_losses,
            "avg_rr_achieved": report.avg_rr_achieved,
            "best_trade": report.best_trade,
            "worst_trade": report.worst_trade,
            "avg_win": report.avg_win,
            "avg_loss": report.avg_loss,
            "tp1_hits": report.tp1_hits,
            "tp2_hits": report.tp2_hits,
            "tp3_hits": report.tp3_hits,
            "trailing_sl_hits": report.trailing_sl_hits,
            "sl_hits": report.sl_hits,
        },
        "trades": [
            {
                "time": a.time,
                "symbol": a.symbol,
                "type": a.opt_type,
                "strike": a.strike,
                "entry": a.entry,
                "exit": a.exit,
                "stopLoss": a.stop_loss,
                "target1": a.target1,
                "target2": a.target2,
                "target3": a.target3,
                "status": a.status,
                "pnl": a.pnl,
                "tpHitLevel": a.tpHitLevel,
                "exitReason": a.exitReason,
                "lotSize": a.lot_size,
                "direction": a.direction,
                "audit_log": a.audit_log,
                "pnl_verified": "✅" if "P&L VERIFIED" in str(a.audit_log) else ("⚠️" if "P&L MISMATCH" in str(a.audit_log) else "—"),
            }
            for a in entries
        ],
        "symbols": symbols,
    }


def build_demo_json(stats: BacktestStats, results: list[TradeResult], sl_pts: float, rr: float, tf: str, symbols: list) -> dict:
    return {
        "success": True,
        "source": "demo",
        "dataSource": "demo",
        "is_demo": True,
        "stats": {
            "total_trades": stats.total_trades,
            "wins": stats.wins,
            "losses": stats.losses,
            "open": stats.open_trades,
            "win_rate": stats.win_rate,
            "total_pnl": stats.total_pnl,
            "gross_profit": stats.gross_profit,
            "gross_loss": stats.gross_loss,
            "profit_factor": stats.profit_factor,
            "max_drawdown": stats.max_drawdown,
            "max_consecutive_wins": stats.max_consecutive_wins,
            "max_consecutive_losses": stats.max_consecutive_losses,
            "avg_rr_achieved": stats.avg_rr_achieved,
            "best_trade": stats.best_trade,
            "worst_trade": stats.worst_trade,
            "avg_win": stats.avg_win,
            "avg_loss": stats.avg_loss,
        },
        "trades": [
            {
                "time": t.time,
                "symbol": t.symbol,
                "type": t.opt_type,
                "strike": t.strike,
                "entry": t.entry,
                "exit": t.exit,
                "status": t.status,
                "pnl": t.pnl_total,
                "rr_achieved": t.rr_achieved,
                "stopLoss": t.stopLoss,
                "target1": t.target1,
                "audit_log": t.audit_log,
            }
            for t in results
        ],
        "symbols": symbols,
    }


# ─── Main CLI ───────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Options Backtest Analyzer")
    parser.add_argument("-i", "--input", help="Input CSV file")
    parser.add_argument("--live", action="store_true", help="Live mode: read real trade data")
    parser.add_argument("--demo", action="store_true", help="Demo mode: simulated data")
    parser.add_argument("--sl", type=float, default=20, help="Stop loss in points (demo mode)")
    parser.add_argument("--rr", type=float, default=3, help="Risk-reward ratio (demo mode)")
    parser.add_argument("-tf", "--timeframe", default="15m", help="Timeframe")
    parser.add_argument("--lot-size", type=int, default=50, help="Default lot size")
    parser.add_argument("--json-out", action="store_true", help="Output JSON to stdout (for API)")
    parser.add_argument("--detail", action="store_true", help="Show detailed audit trail")
    parser.add_argument("--source", default="Trade Database", help="Data source label for report")

    args = parser.parse_args()

    # ─── Load data ────────────────────────────────────────
    if args.demo:
        df = pd.read_csv(StringIO(DEMO_CSV))
        df = normalize_csv(df)
    elif args.live:
        if args.input:
            df = pd.read_csv(args.input)
        else:
            raw = sys.stdin.read()
            if raw.strip():
                df = pd.read_csv(StringIO(raw))
            else:
                print(json.dumps({"success": False, "error": "No input data for live mode"}))
                return
        df = normalize_csv(df, live_mode=True)
    elif args.input:
        df = pd.read_csv(args.input)
        df = normalize_csv(df, live_mode=("live" in args.input.lower()))
    else:
        raw = sys.stdin.read()
        if raw.strip():
            df = pd.read_csv(StringIO(raw))
            df = normalize_csv(df, live_mode=True)
        else:
            print(json.dumps({"success": False, "error": "No input data"}))
            return

    symbols = list(df["symbol"].unique()) if "symbol" in df.columns else []
    source = f"LIVE — {args.source}" if args.live else f"DEMO — {args.source}"

    # ─── LIVE MODE ────────────────────────────────────────
    if args.live:
        entries, report = process_live_trades(df)

        if args.json_out:
            out = build_live_json(report, entries, source, symbols)
            print(json.dumps(out, default=str))
        else:
            print(build_daily_report(report, entries, source))
            if args.detail:
                print(build_audit_trail(entries))

    # ─── DEMO MODE ────────────────────────────────────────
    else:
        results = simulate_backtest(df, args.sl, args.rr, args.lot_size)
        stats = compute_stats(results)

        if args.json_out:
            out = build_demo_json(stats, results, args.sl, args.rr, args.timeframe, symbols)
            print(json.dumps(out, default=str))
        else:
            print(build_demo_report(stats, results, args.sl, args.rr, args.timeframe))
            if args.detail:
                lines = []
                lines.append("\n" + "=" * 72)
                lines.append("  TRADE LOG")
                lines.append("=" * 72)
                for i, t in enumerate(results, 1):
                    lines.append(f"\n  ── Trade #{i}: {t.symbol} {t.opt_type} @ {t.strike} ──")
                    for log_line in t.audit_log:
                        lines.append(f"    {log_line}")
                print("\n".join(lines))


if __name__ == "__main__":
    main()
