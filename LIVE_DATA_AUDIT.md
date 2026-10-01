# LIVE DATA AUDIT — Phase 1

*Classification of every tab and card in SMDApp as:*
`- LIVE_MARKET` — needs price/OI/greeks/signal data changing during market hours
`- LIVE_SYSTEM` — needs system/health data independent of market hours
`- STATIC_OR_ON_DEMAND` — refreshes on user action/page load only

---

## Tab/Card Inventory & Classification

| Tab/Card | File | Classification | Reason |
|----------|------|----------------|--------|
| **Jarvis/Signal Card** | `src/components/dashboard/JarvisTab.tsx` | **LIVE_MARKET** | Shows bias score, component scores (optionChain, FII, greeks, heatmap, etc.), Greeks, levels, S1-S8 strategy, greeks/regime, real-time trade ideas. Data changes every minute during market hours. |
| **Enhanced Option Chain** | `src/components/terminal/EnhancedOptionChain.tsx` | **LIVE_MARKET** | Full option chain with Greeks, IV skew, OI bars. Updates per market tick during hours. |
| **Live Option Chain** | `src/components/terminal/LiveOptionChain.tsx` | **LIVE_MARKET** | Real-time option chain display. |
| **Greek Flow Heatmap** | `src/components/terminal/GreekFlowHeatmap.tsx` | **LIVE_MARKET** | 12 dashboard cards with premium race table, top 5 calls/puts, full heatmap. All Greek/flow data is live. |
| **OI Heatmap ECharts** | `src/components/terminal/OIHeatmapECharts.tsx` | **LIVE_MARKET** | Options flow heatmap. |
| **Options Edge Panel** | `src/components/terminal/OptionsEdgePanel.tsx` | **LIVE_MARKET** | Option buyer analysis, OI spurts. |
| **Smart Money Panel** | `src/components/terminal/SmartMoneyPanel.tsx` | **LIVE_MARKET** | Smart money tracking, live premium fed as tracking ticks. |
| **Market Status Bar** | `src/components/terminal/MarketStatusBar.tsx` | **LIVE_SYSTEM** | Shows market open/close status, CAS state. While it has market-hour info, the *connection status* is system-independent. |
| **Connection Status Bar** | `src/components/dashboard/ConnectionStatusBar.tsx` | **LIVE_SYSTEM** | MOAPI/NSE connection status, agent freshness. System health matters even when market closed. |
| **Motilal Status** | `src/components/dashboard/MotilalStatus.tsx` | **LIVE_SYSTEM** | Broker API connection status, session alive. Independent of market hours. |
| **Hermes Health Panel** | *(would be in dashboard)* | **LIVE_SYSTEM** | System health, kill-switch state, Grok backstop status. |
| **Active Trade P&L Monitor** | `src/components/terminal/` (trade monitor) | **LIVE_MARKET** | Live TP/SL detection, MFE/MAE, P&L tracking for active trades. |
| **Best Trades Now Card** | `src/components/dashboard/BestTradesNow.tsx` | **LIVE_MARKET** | 5 trade setups with entry/SL/TP. Timestamps show EOD analysis, but data changes when scanner runs. |
| **Option Buyer Panel** | `src/components/terminal/OptionBuyerPanel.tsx` | **LIVE_MARKET** | Option buyer flow, accumulation/distribution. |
| **CAS Panel** | `src/components/terminal/CASPanel.tsx` | **LIVE_MARKET** | CAS accumulation/distribution, price × CAS matrix. |
| **Greek Heatmap ECharts** | `src/components/terminal/GreekHeatmapECharts.tsx` | **LIVE_MARKET** | Dealer gamma exposure, gamma pressure. |
| **Institutional Positioning Panel** | `src/components/dashboard/InstitutionalPositioningPanel.tsx` | **LIVE_MARKET** | Participant-wise OI data, FII/DII flows. |
| **News Panel** | `src/components/dashboard/NewsPanel.tsx` | **LIVE_MARKET** / **LIVE_SYSTEM** | Market news with deterministic sentiment. News fetches on cycle but sentiment scoring is near-realtime. |
| **News Sentiment Panel** | `src/components/dashboard/NewsSentimentPanel.tsx` | **LIVE_MARKET** | Sentiment scoring (-100..+100), 80+ keywords. |
| **Market Heatmap** | `src/components/dashboard/MarketHeatmap.tsx` | **LIVE_MARKET** | Multi-market heatmap (NIFTY50, BANKNIFTY, SENSEX). Price changes during hours. |
| **Market Breadth** | `src/components/dashboard/MarketBreadth.tsx` | **LIVE_MARKET** | EMA20/50/200, VWAP participation, RelVol. Price/volume breadth data. |
| **Market Regime Panel** | `src/components/dashboard/MarketRegimePanel.tsx` | **LIVE_MARKET** | Regime detection (BULLISH/NEUTRAL/BEARISH), FII/DII confirmation. |
| **Index Comparison** | `src/components/dashboard/IndexComparison.tsx` | **LIVE_MARKET** | Compares multiple indices with live prices. |
| **Futures Dashboard** | `src/components/futures/FuturesDashboard.tsx` | **LIVE_MARKET** | Futures prices, OI, flow. |
| **AI Recommendation** | `src/components/terminal/AIRecommendation.tsx` | **LIVE_MARKET** | AI-generated trade recommendations. |
| **Zap Terminal (Zero Hero)** | `src/components/terminal/ZeroHeroTerminal.tsx` | **LIVE_MARKET** | Zero Hero / Smart Money candidates with live premium. |
| **Trade History** | `src/components/terminal/TradeHistory.tsx` | **STATIC_OR_ON_DEMAND** | Past trade ledger — historical, not current. Refreshes on user load. |
| **Backtest Report** | `src/components/backtest/BacktestDashboard.tsx` | **STATIC_OR_ON_DEMAND** | Historical backtest results — not live. |
| **Daily IDE / Cron Results** | `src/components/daily/` | **STATIC_OR_ON_DEMAND** | End-of-day scan results, cron-triggered. |
| **Alert History** | `src/components/dashboard/AlertCenter.tsx` | **LIVE_SYSTEM** | Alert lifecycle (fire/acknowledge/history). System state, not market data. |
| **Order Book** | `src/components/dashboard/OrderBook.tsx` | **LIVE_MARKET** | Current order book / pending orders. |
| **Order Panel** | `src/components/dashboard/OrderPanel.tsx` | **LIVE_MARKET** | Place/manage orders — needs live connection. |
| **Strategy Builder** | `src/components/dashboard/StrategyBuilder.tsx` | **STATIC_OR_ON_DEMAND** | Strategy configuration — set-and-forget. |
| **Scanner Panel** | `src/components/dashboard/ScannerPanel.tsx` | **LIVE_MARKET** | Intraday scanner results (Breeze → Yahoo). |
| **Weekly Equity Scanner** | `src/components/dashboard/WeeklyEquityScannerPanel.tsx` | **STATIC_OR_ON_DEMAND** | Weekly scan — EOD. |
| **ATM Straddle Range** | `src/components/dashboard/ATMStraddleRange.tsx` | **LIVE_MARKET** | ATM straddle data, Greeks. |
| **Gap Analysis** | `src/components/dashboard/GapAnalysis.tsx` | **LIVE_MARKET** | Overnight gap analysis. |
| **Expiry Plan Panel** | `src/components/dashboard/ExpiryPlanPanel.tsx` | **LIVE_MARKET** | Expiry-specific planning, liquidity shifts. |
| **Expiry Radar** | `src/components/dashboard/ExpiryRadar.tsx` | **LIVE_MARKET** | Expiry liquidity tracking. |
| **CAS Panel** | `src/components/terminal/CASPanel.tsx` | **LIVE_MARKET** | Accumulation/distribution matrix. |
| **Correlation Panel** | `src/components/dashboard/CorrelationPanel.tsx` | **LIVE_SYSTEM** | Symbol correlation — can update live but is structural/system data. |
| **SDM Options Panel** | `src/components/dashboard/SDMOptionsPanel.tsx` | **LIVE_MARKET** | SDM 14-factor scoring engine outputs. |
| **SDM AI Dashboard** | `src/components/dashboard/SDMDashboard.tsx` | **LIVE_MARKET** | SDM overall dashboard with all factor scores. |
| **SDM ID Dashboard** | `src/components/dashboard/SDIADashboard.tsx` | **LIVE_MARKET** | SDM index-level dashboard. |
| **SDM Options Panel** | `src/components/dashboard/SDMOptionsPanel.tsx` | **LIVE_MARKET** | SDM options-specific scoring. |
| **Commodity Dashboard** | `src/components/dashboard/CommodityDashboard.tsx` | **LIVE_MARKET** | MCX commodity data (CRUDEOIL/GOLD/SILVER/GAS). |
| **Commodity Panels** | Various | **LIVE_MARKET** | CRUDEOIL/GOLD/SILVER/GAS real-time prices. |
| **Commodity Panels** | Various | **LIVE_MARKET** | MCX real-time commodity prices. |
| **Challenge Panel** | `src/components/dashboard/ChallengePanel.tsx` | **STATIC_OR_ON_DEMAND** | Challenge configuration — not live data. |
| **Paper Trading Tab** | `src/components/terminal/PaperTradingTab.tsx` | **LIVE_MARKET** | Paper trading — simulated but live-updated. |
| ** most active contracts** | `src/components/terminal/MostActiveContracts.tsx` | **LIVE_MARKET** | Most active NSE contracts by volume. |
| **FII/DII Flow Panel** | `src/components/terminal/FIIDIIFlowPanel.tsx` | **LIVE_MARKET** | FII/DII flow data, net buying/selling. |
| **IV Surface** | `src/components/dashboard/IVSurface.tsx` | **LIVE_MARKET** | Implied volatility surface. |
| **SMC Panel** | *(Smart Money Comprehensive)* | **LIVE_MARKET** | SMC (Smart Money Concepts) analysis. |
| **Hedge Panel** | `src/components/dashboard/HedgePanel.tsx` | **LIVE_MARKET** | Hedge ratio, delta hedging info. |
| **SDM Recommendation** | `src/components/dashboard/SDMAIDashboard.tsx` | **LIVE_MARKET** | SDM V2 recommendation orchestrator outputs. |
| **Agent Intelligence** | `src/components/agent-intelligence/` | **LIVE_SYSTEM** | Agent status, patterns, predictions. |
| **Agent Status** | *(various)* | **LIVE_SYSTEM** | Agent freshness, health, last-run timestamps. |

