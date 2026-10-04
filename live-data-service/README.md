# Live Option Data Service

Keeps Nifty/Bank Nifty spot, India VIX, option chain (OI, change in OI, PCR, walls, max pain, ATM IV),
FII/DII cash and participant OI up to date while your PC is on. Your app or bot reads it from
`http://127.0.0.1:8765/snapshot` or from the file `live_data.json` (rewritten every 2 seconds).
Pure Python 3.8+, nothing to install.

## Setup (Windows)
1. Install Python from python.org (tick "Add python.exe to PATH").
2. Double-click **check.bat**. Each feed should say OK. If a feed says FAIL, see Troubleshooting.
3. Double-click **start.bat** and open http://127.0.0.1:8765 to see the dashboard.
4. Double-click **install_autostart.bat** so it starts by itself every time you log in.
   (Undo with remove_autostart.bat.) Mac/Linux: run `./start.sh`.
Try `python live_service.py --demo` first if you only want to see the dashboard (data is labelled DEMO).

## How you can be sure data is live
- Every feed carries NSE's own timestamp. Status is computed when you READ it: `LIVE` only if the market is
  open AND the exchange timestamp is newer than `max_age_sec` (spot/VIX 45 s, chain 180 s by default).
- If the network drops, NSE blocks you, a fetch hangs, or the PC wakes from sleep, the feed turns `STALE` by itself.
- Outside 09:15-15:30 IST Mon-Fri (and listed holidays) feeds show `CLOSED`; they hold the last close.
- FII/DII and participant OI exist only after the close (evening), so they show `EOD_OK` (matches the last session)
  or `EOD_OLD`. They are next-day bias, never intraday triggers.
- `all_live` is true only when spot/VIX and every chain are `LIVE`. Your app should gate trading analysis on it.
- Keep your PC clock synced (Windows: Settings > Time > Sync now). A wrong clock breaks the age check.

## Endpoints (localhost only)
`/` dashboard | `/snapshot` everything | `/health` overall + all_live |
`/selector?symbol=NIFTY&direction=call&target=25200&stop=25070&hold_days=0.25&capital=300000&lot_size=75`
returns spot, VIX, days to expiry, live premiums and a ready `strike_selector.py` command, but only when data is LIVE
(`ok:false` with a reason otherwise; add `&allow_closed=1` to analyse last-close data).

## Config (config.json)
Symbols, ports, polling intervals, max ages, `holidays` (list of "YYYY-MM-DD"; NSE holidays are NOT built in, add them).
`force_market_open` is for testing only; the dashboard shows a red warning when it is on.

## Troubleshooting
- NSE endpoints are unofficial and may change or block (403, empty data). The service re-fetches cookies automatically,
  backs off after failures, and shows the error on the dashboard. Do not lower the intervals; aggressive polling gets blocked.
- A VPN, office firewall or cloud IP is often blocked by NSE. Try your home connection.
- Participant OI column names are read from the NSE CSV header ("Future Index Long/Short"); if NSE renames them, the
  long % shows null until the parser is updated.
- The PC sleeping stops updates; data turns STALE and recovers after wake.
- Logs: `live_service.log` in this folder.

## Using a broker API instead (more reliable)
Implement `BrokerProvider` in live_service.py (same five methods, NSE-shaped output) for Upstox, Dhan, Kite Connect, Fyers or
Angel One, put keys in environment variables, set `"provider": "broker"`. Broker websockets are faster and not scraped.

Educational tool, not financial advice. Not affiliated with NSE.
