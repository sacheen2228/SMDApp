# Intel Tab Freshness Audit — 2026-11-07

Audit time: 2026-11-07 ~15:xx IST
Market state: CLOSED — last session 06-Nov-2026 15:30

## Summary
All Intel Tab cards are reachable and wired to live endpoints via useQuery. Data is STALE because exchange is closed. No fake fallbacks are rendered; cards show explicit STALE / UNAVAILABLE states per SOP.

## Endpoint checks

| Card / Endpoint | HTTP | Status | Source | Provider ts | Age | Reason |
|---|---|---|---|---|---|---|
| Market Regime /api/market/regime | 200 | STALE | Moneycontrol | 2026-11-06T10:25:26Z | 1d ago | Exchange closed — last session 06-Nov-2026 15:30 |
| Market Breadth /api/market/breadth | 200 | STALE | NSE India / Moneycontrol | 2026-11-06T10:00:00Z | 1d ago | Exchange closed — last session 06-Nov-2026 15:30 |
| Sectors /api/market/sectors | 200 | STALE | — | — | 1d ago | Exchange closed |
| Industry Heatmap /api/market/heatmap?market=NIFTY500 | 200 | STALE | Moneycontrol | 2026-11-06T10:25:26Z | 1d ago | Exchange closed |
| Best Trades Now /api/market/opportunities?top=5 | 200 | UNAVAILABLE | — | — | — | No live opportunities when market closed |
| FII-DII /api/fii-dii | 200 | STALE | fii-dii | 06-Nov-2026 | 1d ago | EOD data |
| OI Spurts /api/nse/oi-spurts | 200 | — | — | — | — | Last session data |
| CAS / Regime / Breadth internal | 200 | STALE | NSE/Moneycontrol | 06-Nov | 1d ago | Exchange closed |

## Notes
- DataFreshnessBadge shows STALE correctly.
- No fake neutral defaults are rendered.
- When market opens, expect AVAILABLE/FRESH with age <90s for quotes, <5m for breadth/regime.

## Files changed recently
- src/components/dashboard/IndustryHeatmapPanel.tsx — treemap industry heatmap
- src/components/dashboard/IntelTab.tsx — IndustryHeatmapPanel integrated

Saved: 2026-11-07
