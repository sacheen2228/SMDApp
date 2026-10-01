---
Task ID: 1
Agent: Main
Task: Fix .env and MO API integration code for local deployment with live data

Work Log:
- Updated .env with correct MO API credentials including Secret Key
- Fixed MO API base URL (confirmed: https://openapi.motilaloswal.com)
- Researched official MO API docs for exact endpoint formats
- Fixed login endpoint: uses `userid` field (not `clientcode`), SHA-256(password + apiKey) hash
- Added `apisecretkey` header to all authenticated API calls
- Added `browsername` and `browserversion` headers (required for WEB source)
- Fixed LTP endpoint: uses `scripcode` (number) for options, separate index LTP endpoint
- Added paisa-to-rupees conversion (MO API returns values in paisa)
- Fixed Scrip Master endpoint: uses `exchangename` field (not `exchange`)
- Added LiveDataSetupDialog component to UI with setup guide
- Updated footer with Wifi/WifiOff icons for data source status
- App compiles and runs successfully

Stage Summary:
- MO API integration code is now fully corrected per official documentation
- Key fixes: apisecretkey header, paisa conversion, correct field names, 2FA support
- User needs to add MO_TWO_FA (date of birth in DD/MM/YYYY) for login to work
- App must run from whitelisted IP (100.89.231.43) for MO API to work
- Graceful fallback: MO API → Yahoo Finance → Simulation

---
Task ID: 2
Agent: Main
Task: Phantom-loss elimination (B2/B3/B4/907) + recorder guards + gate tuning (Oct 1 2026 session)

Work Log:
- B2 legacy exit repair executed: scripts/repair-legacy-exits.ts — 171 sidecar rows
  (157 OPT + 14 BTST) rewritten with real exchange closes; backup
  backups/trade_audit.db.bak-2026-09-30-18-48-39; post-verify idempotent
- Extended BTST scope (|move|>10% OR held>3d) covering Jul-20/Jul-22/Sep-11
  mass-stamp sweeps: 118 repaired, 78 tolerance-MATCH, 22 NO_DATA, 0 errors;
  backup backups/trade_audit.db.bak-2026-09-30-19-41-59
- B3 EOD square-off live: src/lib/eod-squareoff.ts (14 tests) +
  src/app/api/cron/eod-squareoff/route.ts + forceCloseTrade in activeTradeTracker;
  smdapp-cron schedule "31 15 * * 1-5"; smoke-tested (auth/window/dry modes)
- B4 journal stats: src/lib/journal-stats.ts — priced-only win/loss, EXPIRED
  terminal, unpriced reported; wired into GET /api/trade-journal
- 907 EXPIRED pnl-NULL repair: scripts/repair-null-pnl.ts + shared
  src/lib/null-pnl-repair.ts — 870 priced with real closes, 37 honest NO_DATA;
  backup backups/custom.db.bak-2026-09-30T19-36-42
- Prevention: instrumentation.ts boot stale-cleanup now prices each expired row
  via resolveRealExit (else exitReason stale_reload_cleanup_no_data)
- closeYesterdayBTST root-cause fix: planBtstSquareOff + per-row real
  next-trading-day close (day-2 retries use historical close, never today's
  stamp; no real price -> row left open with warning)
- Recorder guards: isStrikeOnSymbolScale 422 at /api/trade/register
  (SENSEX-24200 class); meetsConfidenceFloor closes conf-0 option bypass;
  TECHM-1550 path verified guarded (no chain -> no trade)
- Session gate: option-chain auto-signals now consult isTradeAllowed
  (POST_CLOSE class was 0/17 wins, -4429)
- Gate tuning: docs/GATE_TUNING_REPORT.md (542 closed trades post-repair:
  50.9% WR, +172.84 net, PF 1.01; SMART_MONEY 67%/PF5.2, BTST 59%/PF1.85 keepers)

Stage Summary:
- Gates: bun test 871/871 (was 845), tsc 713 = exact baseline, build exit 0
- Live smoke: journal stats unpriced=0 recent window; register rejects
  conf0 / PE<65 / off-scale strikes; EOD route auth + window guards OK
- Net book corrected: +11,470 phantom pre-repair -> +172.84 real post-repair
- Nothing committed (standing rule: commit only on explicit request)
