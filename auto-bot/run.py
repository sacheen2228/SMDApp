"""
Main entry point for Breakout/Desk (paper mode).

Starts the trading engine (scans, paper trades, exit monitoring)
and the FastAPI dashboard server concurrently.

Usage:
    cd auto-bot && ./start.sh
"""
import asyncio
import os
import signal

from dotenv import load_dotenv

from bot.engine import TradingEngine
from bot.dashboard_server import DashboardServer

load_dotenv()


async def main():
    account_value = float(os.getenv("ACCOUNT_VALUE", "100000"))

    engine = TradingEngine(account_value=account_value)
    dashboard = DashboardServer(engine=engine, host="0.0.0.0", port=8000)

    stop_event = asyncio.Event()

    def _handle_signal():
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass

    engine_task = asyncio.create_task(engine.run())
    dashboard_task = asyncio.create_task(dashboard.start())

    print("[run] Breakout/Desk (paper mode) starting...")
    print("[run] Dashboard: http://localhost:8000")

    await stop_event.wait()

    print("[run] Shutting down...")
    await engine.shutdown()
    engine_task.cancel()
    dashboard_task.cancel()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[run] Stopped.")
