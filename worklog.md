---
Task ID: 1
Agent: Main
Task: Add SENSEX support and OI Analysis feature to Option Chain

Work Log:
- Added SENSEX to SYMBOL_CONFIG in backend data generator (basePrice: 79000, stepSize: 100, lotSize: 10)
- Added SENSEX to symbol dropdown in frontend page
- Added new "OI Analysis" view with tab navigation (Option Chain / OI Analysis)
- Added OI Change bar chart (Sensibull-style) with red/green bars for call/put OI changes
- Added Open Interest visualization mode in OI Analysis
- Added strike range filter (All, 5, 10, 15, 20 strikes above/below ATM)
- Added Show OI toggle switch
- Added summary cards (Call Resistance, Put Support, CE OI Change, PE OI Change)
- Added OI data table in analysis view
- Fixed PM2 process management issue (replaced standalone server with dev server)
- Verified all symbols work: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX

Stage Summary:
- SENSEX now appears in the dropdown and generates realistic data (~79000 base price, 100 step size)
- New OI Analysis tab provides Sensibull-style OI Change chart with interactive features
- Server running stably on PM2 with dev mode
