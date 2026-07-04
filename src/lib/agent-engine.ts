// SDM Agent Engine
// Pattern-matching brain that answers questions using live market data + trade history

export interface AgentContext {
  symbol: string;
  spotPrice: number;
  analysis: any;
  trades: any[];
  session: { session: string; label: string; notes: string[] } | null;
  summary: any;
  gammaBlast: any;
  expiryDate: string;
}

interface Intent {
  patterns: RegExp[];
  handler: (ctx: AgentContext, match: RegExpMatchArray | null) => string;
}

// ─── Helpers ──────────────────────────────────────────────────────
function fmt(n: number | undefined | null): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function pnlStr(n: number): string {
  if (n >= 0) return `+₹${fmt(n)}`;
  return `-₹${fmt(Math.abs(n))}`;
}

function sentimentEmoji(s: string): string {
  if (s === "bullish") return "🟢";
  if (s === "bearish") return "🔴";
  return "🟡";
}

function sessionEmoji(s: string): string {
  const map: Record<string, string> = {
    pre_open: "🔔", opening: "⚡", trend_form: "📈", primary: "✅",
    low_liq: "⚠️", afternoon: "🕐", closing: "🏁", closed: "🔴",
  };
  return map[s] || "📊";
}

// ─── Intent Handlers ──────────────────────────────────────────────
const intents: Intent[] = [
  // ── Today's trades ──
  {
    patterns: [/today'?s?\s*trade/i, /trade\s*today/i, /what\s*did\s*i\s*trade/i, /my\s*trade/i, /positions?\s*today/i],
    handler: (ctx) => {
      const today = new Date().toISOString().split("T")[0];
      const todayTrades = ctx.trades.filter(t => t.entryTime?.startsWith(today));
      if (todayTrades.length === 0) return `📋 **No trades today yet** for ${ctx.symbol}.\n\nMarket is ${ctx.analysis?.sentiment || "neutral"} — SDM is watching. I'll alert you when a quality setup appears.`;

      const lines = todayTrades.map((t, i) => {
        const time = t.entryTime ? new Date(t.entryTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";
        const exitTime = t.exitTime ? new Date(t.exitTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "open";
        const status = t.status === "OPEN" ? "⏳ OPEN" : t.status === "TP_HIT" ? "✅ TP HIT" : t.status === "SL_HIT" ? "🛑 SL HIT" : t.status;
        return `${i + 1}. **${t.strike} ${t.type}** | Entry ₹${fmt(t.entryPrice)} → ${exitTime === "open" ? "—" : "Exit ₹" + fmt(t.exitPrice)} | ${status} | PnL: ${t.pnl != null ? pnlStr(t.pnl) : "—"} | SL ₹${fmt(t.stopLoss)} | T1 ₹${fmt(t.target1)} | ${time}`;
      });

      const closedTrades = todayTrades.filter(t => t.pnl != null && t.pnl !== 0);
      const totalPnL = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;

      return `📋 **Today's ${ctx.symbol} Trades** (${todayTrades.length} total)\n\n${lines.join("\n\n")}\n\n---\n💰 **Day PnL:** ${pnlStr(totalPnL)} | ✅ ${wins}W / ❌ ${closedTrades.length - wins}L`;
    },
  },

  // ── Trade history / all trades ──
  {
    patterns: [/trade\s*history/i, /all\s*trades/i, /past\s*trades/i, /show\s*trades/i, /trade\s*list/i],
    handler: (ctx) => {
      if (ctx.trades.length === 0) return `📋 **No trade history** yet for ${ctx.symbol}. Start trading and I'll track everything here.`;

      const last5 = ctx.trades.slice(0, 10);
      const lines = last5.map((t, i) => {
        const date = t.entryTime ? new Date(t.entryTime).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";
        return `${i + 1}. ${date} | **${t.strike} ${t.type}** | ₹${fmt(t.entryPrice)} → ${t.exitPrice ? "₹" + fmt(t.exitPrice) : "open"} | ${t.pnl != null ? pnlStr(t.pnl) : "—"} | ${t.status}`;
      });

      const totalPnL = ctx.trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const closed = ctx.trades.filter(t => t.pnl != null && t.pnl !== 0);
      const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
      const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : "0";

      return `📜 **Trade History** (${ctx.trades.length} total)\n\n${lines.join("\n")}\n\n---\n📊 **Win Rate:** ${winRate}% | **Total PnL:** ${pnlStr(totalPnL)} | **Trades:** ${closed.length} closed`;
    },
  },

  // ── Market trend / condition ──
  {
    patterns: [/market\s*(trend|condition|status|outlook)/i, /how.*market/i, /what.*market/i, /market.*doing/i, /trending/i, /sideways/i, /range/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "📊 Market data is loading...";

      const s = a.sentiment || "neutral";
      const emoji = sentimentEmoji(s);
      const pcr = a.pcr?.toFixed(2) || "—";
      const mp = fmt(a.maxPain);
      const atm = fmt(a.atmStrike);
      const spot = fmt(ctx.spotPrice);
      const distToMP = ctx.spotPrice - (a.maxPain || 0);
      const regime = a.sdm?.regime || "unknown";

      let trend = "Moving sideways";
      if (s === "bullish") trend = "Trending **BULLISH** — put writers are active";
      else if (s === "bearish") trend = "Trending **BEARISH** — call writers are dominant";

      let mpNote = "";
      if (Math.abs(distToMP) < 50) mpNote = "⚡ Spot is very close to Max Pain — expect a big move soon!";
      else if (distToMP > 0) mpNote = `Spot is **₹${fmt(Math.abs(distToMP))} ABOVE** Max Pain — bulls in control`;
      else mpNote = `Spot is **₹${fmt(Math.abs(distToMP))} BELOW** Max Pain — bears pressing`;

      return `${emoji} **${ctx.symbol} Market Status**\n\n**Trend:** ${trend}\n**Sentiment:** ${s.toUpperCase()}\n**PCR:** ${pcr} | **Max Pain:** ₹${mp}\n**ATM:** ₹${atm} | **Spot:** ₹${spot}\n**Regime:** ${regime}\n\n${mpNote}\n\n🎯 **SDM says:** ${a.recommendation?.action || "WAIT"}`;
    },
  },

  // ── PCR ──
  {
    patterns: [/pcr/i, /put.?call.?ratio/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "Loading...";

      const pcr = a.pcr?.toFixed(3) || "—";
      const ceOI = fmt(a.totalCallOI);
      const peOI = fmt(a.totalPutOI);
      let interpretation = "";
      if (a.pcr > 1.2) interpretation = "🟢 **BULLISH** — Heavy put writing = strong support below";
      else if (a.pcr > 1.0) interpretation = "🟢 Mildly bullish — put writers slightly active";
      else if (a.pcr < 0.8) interpretation = "🔴 **BEARISH** — Heavy call writing = strong resistance above";
      else if (a.pcr < 1.0) interpretation = "🔴 Mildly bearish — call writers slightly active";
      else interpretation = "🟡 **NEUTRAL** — Balanced market";

      return `📊 **Put-Call Ratio**\n\n**PCR:** ${pcr}\n**Call OI:** ${ceOI} | **Put OI:** ${peOI}\n\n${interpretation}\n\n💡 PCR > 1.2 = Support building (bullish)\nPCR < 0.8 = Resistance building (bearish)`;
    },
  },

  // ── Key levels / support / resistance ──
  {
    patterns: [/key\s*level/i, /support/i, /resistance/i, /pivot/i, /r1|r2|r3|s1|s2|s3/i, /level/i, /ce.*wall/i, /pe.*wall/i, /gamma.*wall/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "Loading...";

      const spot = ctx.spotPrice;
      const mp = a.maxPain || spot;
      const atm = a.atmStrike || spot;
      const ceWall = a.recommendation?.gammaWallResistance || mp + 200;
      const peWall = a.recommendation?.gammaWallSupport || mp - 200;

      // Simple pivot calc from spot
      const range = Math.abs(ceWall - peWall);
      const pp = spot;
      const r1 = pp + range * 0.382;
      const r2 = pp + range * 0.618;
      const r3 = pp + range * 1.0;
      const s1 = pp - range * 0.382;
      const s2 = pp - range * 0.618;
      const s3 = pp - range * 1.0;

      return `🎯 **${ctx.symbol} Key Levels**\n\n**Spot:** ₹${fmt(spot)} | **ATM:** ₹${fmt(atm)} | **Max Pain:** ₹${fmt(mp)}\n\n**Resistance:**\nR3 ₹${fmt(r3)} | R2 ₹${fmt(r2)} | R1 ₹${fmt(r1)}\n\n**Support:**\nS1 ₹${fmt(s1)} | S2 ₹${fmt(s2)} | S3 ₹${fmt(s3)}\n\n**Gamma Walls:**\nCE Wall (resistance): ₹${fmt(ceWall)}\nPE Wall (support): ₹${fmt(peWall)}\n\n💡 CE Wall = where call writers have max OI (expect selling)\nPE Wall = where put writers have max OI (expect buying)`;
    },
  },

  // ── Max Pain ──
  {
    patterns: [/max\s*pain/i, /where.*pain/i, /pain.*level/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "Loading...";

      const mp = a.maxPain || 0;
      const spot = ctx.spotPrice;
      const diff = spot - mp;
      let bias = "";
      if (Math.abs(diff) < 30) bias = "⚖️ Spot is AT Max Pain — market may explode either direction!";
      else if (diff > 0) bias = "🟢 Spot ABOVE Max Pain — market wants to drag DOWN to MP";
      else bias = "🔴 Spot BELOW Max Pain — market wants to drag UP to MP";

      return `🎯 **Max Pain Analysis**\n\n**Max Pain:** ₹${fmt(mp)}\n**Current Spot:** ₹${fmt(spot)}\n**Distance:** ${diff > 0 ? "+" : ""}₹${fmt(diff)}\n\n${bias}\n\n💡 Max Pain is where most option buyers lose money. Market tends to gravitate here near expiry.`;
    },
  },

  // ── VIX / volatility ──
  {
    patterns: [/vix/i, /volatil/i, /india\s*vix/i, /fear\s*index/i],
    handler: (ctx) => {
      const vix = ctx.summary?.indiaVIX || ctx.analysis?.greeks?.vix || 15;
      let mood = "";
      if (vix > 25) mood = "🔴 **HIGH FEAR** — Market is nervous. Big moves expected. Be cautious with entries.";
      else if (vix > 18) mood = "🟡 **ELEVATED** — Moderate fear. Good for option buyers if you catch the move.";
      else if (vix > 12) mood = "🟢 **CALM** — Low fear. Markets are stable. Good for momentum trades.";
      else mood = "🟢 **VERY CALM** — Complacency zone. Be ready for sudden volatility spike.";

      return `📊 **India VIX**\n\n**VIX:** ${fmt(vix)}\n\n${mood}\n\n💡 VIX > 25 = expensive premiums (good for sellers)\nVIX < 12 = cheap premiums (good for buyers)\nHigh VIX = wider stop losses needed`;
    },
  },

  // ── Sentiment ──
  {
    patterns: [/sentiment/i, /mood/i, /bull.*bear/i, /what.*feel/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "Loading...";

      const s = a.sentiment || "neutral";
      const emoji = sentimentEmoji(s);
      const pcr = a.pcr?.toFixed(2) || "—";
      const oibuildup = a.recommendation?.oibuildup || "neutral";

      let detail = "";
      if (s === "bullish") detail = "Put writers are aggressive — they expect support to hold. Market sentiment is **BULLISH**.";
      else if (s === "bearish") detail = "Call writers are aggressive — they expect resistance to hold. Market sentiment is **BEARISH**.";
      else detail = "Balanced OI — no clear direction. Market is **NEUTRAL**.";

      return `${emoji} **Market Sentiment**\n\n**Overall:** ${s.toUpperCase()}\n**PCR:** ${pcr}\n**OI Buildup:** ${oibuildup}\n\n${detail}\n\n💡 Sentiment is based on Put-Call Ratio and OI buildup patterns.`;
    },
  },

  // ── Best trade / recommendation ──
  {
    patterns: [/best\s*trade/i, /recommend/i, /what.*buy/i, /entry/i, /should.*i\s*(buy|enter|trade)/i, /call.*put/i, /which.*option/i, /trade.*idea/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a?.recommendation) return "📊 Analysis is loading...";

      const r = a.recommendation;
      const emoji = sentimentEmoji(a.sentiment || "neutral");

      return `${emoji} **SDM Recommendation for ${ctx.symbol}**\n\n**Action:** ${r.action}\n**Direction:** ${r.direction} ${r.optionType}\n**Strike:** ₹${fmt(r.strike)}\n**Entry:** ₹${fmt(r.entryPrice)} (buy range ₹${fmt(r.idealBuyRange?.low)} - ₹${fmt(r.idealBuyRange?.high)})\n**Confidence:** ${fmt(r.confidence)}%\n**Risk:** ${r.riskLevel}\n\n**Stop Loss:** ₹${fmt(r.stopLoss)} — ${r.stopLossReason || ""}\n**Target 1:** ₹${fmt(r.tp1)} (+${r.tp1Pct}%)\n**Target 2:** ₹${fmt(r.tp2)} (+${r.tp2Pct}%)\n**Target 3:** ₹${fmt(r.tp3)} (+${r.tp3Pct}%)\n\n**Why:** ${(r.reasons || []).join(" • ")}`;
    },
  },

  // ── Open positions ──
  {
    patterns: [/open\s*position/i, /open\s*trade/i, /current.*position/i, /what.*holding/i, /running/i],
    handler: (ctx) => {
      const openTrades = ctx.trades.filter(t => t.status === "OPEN");
      if (openTrades.length === 0) return `📭 **No open positions** for ${ctx.symbol}.\n\nThe market is ${ctx.analysis?.sentiment || "neutral"}. Want me to analyze the best entry?`;

      const lines = openTrades.map((t, i) => {
        const time = t.entryTime ? new Date(t.entryTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—";
        return `${i + 1}. **${t.strike} ${t.type}** | Entry ₹${fmt(t.entryPrice)} | SL ₹${fmt(t.stopLoss)} | T1 ₹${fmt(t.target1)} | Since ${time}`;
      });

      return `⏳ **Open Positions** (${openTrades.length})\n\n${lines.join("\n\n")}\n\n💡 Manage your exits based on SL and T1 levels. Never move SL further away.`;
    },
  },

  // ── SL / Stop loss ──
  {
    patterns: [/stop\s*loss/i, /\bsl\b/i, /where.*exit/i, /exit.*point/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a?.recommendation) return "Loading...";

      const r = a.recommendation;
      return `🛑 **Stop Loss Guide**\n\n**Recommended SL:** ₹${fmt(r.stopLoss)}\n**Reason:** ${r.stopLossReason || "Standard 15% below entry"}\n\n**Exit Rules:**\n• Exit immediately if SL hit — no exceptions\n• If T1 hit, move SL to cost (breakeven)\n• If T2 hit, book 50% and trail rest\n• Never add to a losing position\n\n💡 A 15% SL on option is standard. If spot crosses ${fmt(a.maxPain)}, the trade thesis is invalidated.`;
    },
  },

  // ── Session / timing ──
  {
    patterns: [/session/i, /timing/i, /when.*trade/i, /best.*time/i, /market.*open/i, /market.*close/i],
    handler: (ctx) => {
      const s = ctx.session;
      if (!s) return "📊 Session info loading...";

      const emoji = sessionEmoji(s.session);
      let advice = "";
      if (s.session === "primary") advice = "✅ **PRIME TIME** — Best liquidity, tightest spreads. This is when SDM makes its best calls.";
      else if (s.session === "opening") advice = "⚡ **OPENING** — Volatile first 15 min. Wait for direction to settle.";
      else if (s.session === "trend_form") advice = "📈 **TREND FORMING** — Direction emerging. Good entries possible.";
      else if (s.session === "low_liq") advice = "⚠️ **LOW LIQUIDITY** — Lunch hour. Wide spreads. Reduce position size.";
      else if (s.session === "afternoon") advice = "🕐 **AFTERNOON** — Second wind. Look for continuation moves.";
      else if (s.session === "closing") advice = "🏁 **CLOSING** — Last 30 min. Don't enter new trades. Manage exits.";
      else if (s.session === "closed") advice = "🔴 **MARKET CLOSED** — Next session starts at 9:15 AM IST.";
      else advice = "🔔 **PRE-OPEN** — Market opens in a few minutes. Get ready.";

      return `${emoji} **Market Session**\n\n**Current:** ${s.label}\n${advice}\n\n**Notes:**\n${(s.notes || []).map(n => `• ${n}`).join("\n")}`;
    },
  },

  // ── OI / Open Interest ──
  {
    patterns: [/open\s*interest/i, /\boi\b/i, /oi\s*buildup/i, /oi\s*change/i, /oi\s*data/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "Loading...";

      const ceOI = fmt(a.totalCallOI);
      const peOI = fmt(a.totalPutOI);
      const buildup = a.recommendation?.oibuildup || "neutral";

      // Top 5 OI strikes
      const strikes = ctx.analysis?.strikeList || [];
      const topCE = [...strikes].sort((a, b) => (b.callOI || 0) - (a.callOI || 0)).slice(0, 5);
      const topPE = [...strikes].sort((a, b) => (b.putOI || 0) - (a.putOI || 0)).slice(0, 5);

      const ceLines = topCE.map(s => `₹${fmt(s.strike)}: ${fmt(s.callOI)} (${s.callOIChange >= 0 ? "+" : ""}${fmt(s.callOIChange)})`).join("\n");
      const peLines = topPE.map(s => `₹${fmt(s.strike)}: ${fmt(s.putOI)} (${s.putOIChange >= 0 ? "+" : ""}${fmt(s.putOIChange)})`).join("\n");

      return `📊 **OI Analysis — ${ctx.symbol}**\n\n**Total Call OI:** ${ceOI} | **Total Put OI:** ${peOI}\n**OI Buildup:** ${buildup}\n\n**🔴 Highest Call OI (Resistance):**\n${ceLines}\n\n**🟢 Highest Put OI (Support):**\n${peLines}\n\n💡 High call OI = resistance. High put OI = support.\nOI increasing + price increasing = long buildup (bullish)`;
    },
  },

  // ── Gamma / gamma blast ──
  {
    patterns: [/gamma/i, /gamma\s*blast/i, /squeeze/i, /dealer/i, /gex/i],
    handler: (ctx) => {
      const g = ctx.gammaBlast;
      if (!g) return "📊 Gamma analysis loading...";

      if (!g.detected) return `📊 **Gamma Status: Normal**\n\nNo gamma squeeze detected. Market is in normal trading conditions.\n\n💡 Gamma blast happens when rapid price moves force dealers to hedge, accelerating the move further.`;

      return `🔥 **GAMMA BLAST DETECTED!**\n\n**Confidence:** ${fmt(g.confidence)}%\n**Dealer Bias:** ${g.dealerBias}\n**Squeeze Potential:** ${fmt(g.squeezePotential)}%\n**Gamma Wall:** ₹${fmt(g.gammaWallStrike)} (${g.gammaWallType})\n**Est. GEX:** ${fmt(g.estimatedGEX)}\n\n**Signals:**\n${(g.reasons || []).map(r => `• ${r}`).join("\n")}\n\n**Warnings:**\n${(g.warnings || []).map(w => `• ⚠️ ${w}`).join("\n")}\n\n🔥 Gamma squeeze = fast directional move. Ride the momentum with tight SL!`;
    },
  },

  // ── Expiry ──
  {
    patterns: [/expir/i, /days?\s*to\s*expir/i, /dte/i, /weekly/i, /monthly/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      const expiry = ctx.expiryDate;
      if (!expiry) return "📊 Expiry info loading...";

      const today = new Date();
      const exp = new Date(expiry);
      const dte = Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      let advice = "";
      if (dte <= 0) advice = "🔴 **EXPIRED** — This contract has expired.";
      else if (dte === 1) advice = "⚠️ **EXPIRY TOMORROW** — Extreme theta decay. Only for experienced traders. Very tight SL needed.";
      else if (dte <= 3) advice = "⚡ **NEAR EXPIRY** — High gamma, high theta decay. Fast moves but risky. Position size small.";
      else if (dte <= 7) advice = "📅 **WEEKLY** — Good balance of gamma and theta. SDM's sweet spot.";
      else advice = "📅 **MONTHLY** — Lower gamma, more time value. Better for swing trades.";

      return `📅 **Expiry Analysis**\n\n**Expiry:** ${expiry}\n**Days to Expiry:** ${dte}\n\n${advice}\n\n💡 Option value decays faster as expiry approaches:\n• 30→7 DTE: Slow decay\n• 7→3 DTE: Accelerating\n• 3→0 DTE: Rapid (theta crush)`;
    },
  },

  // ── Win rate / performance ──
  {
    patterns: [/win\s*rate/i, /performance/i, /how.*doing/i, /pnl/i, /profit.*loss/i, /winning/i],
    handler: (ctx) => {
      if (ctx.trades.length === 0) return "📊 No trades yet. Start trading to see your performance stats!";

      const closed = ctx.trades.filter(t => t.pnl != null && t.pnl !== 0);
      const wins = closed.filter(t => (t.pnl ?? 0) > 0);
      const losses = closed.filter(t => (t.pnl ?? 0) < 0);
      const totalPnL = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
      const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "0";
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length : 0;
      const pf = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : avgWin > 0 ? 99 : 0;

      let grade = "";
      const wr = parseFloat(winRate);
      if (wr >= 60) grade = "🟢 **EXCELLENT**";
      else if (wr >= 50) grade = "🟡 **DECENT**";
      else if (wr >= 40) grade = "🟠 **NEEDS IMPROVEMENT**";
      else grade = "🔴 **REVIEW YOUR STRATEGY**";

      return `📊 **Performance Report**\n\n**Win Rate:** ${winRate}% (${wins.length}W / ${losses.length}L)\n**Total PnL:** ${pnlStr(totalPnL)}\n**Avg Win:** ${pnlStr(avgWin)} | **Avg Loss:** ${pnlStr(avgLoss)}\n**Profit Factor:** ${pf.toFixed(2)}x\n\n${grade}\n\n💡 Target: >55% win rate with PF >1.5. Focus on quality over quantity.`;
    },
  },

  // ── Risk / position sizing ──
  {
    patterns: [/risk/i, /position\s*size/i, /lot\s*size/i, /how\s*much/i, /capital/i],
    handler: (ctx) => {
      const lotSizes: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };
      const lot = lotSizes[ctx.symbol] || 65;
      const price = ctx.analysis?.recommendation?.entryPrice || 0;
      const sl = ctx.analysis?.recommendation?.stopLoss || 0;
      const riskPerLot = price > 0 && sl > 0 ? (price - sl) * lot : 0;

      return `🛡️ **Risk Management — ${ctx.symbol}**\n\n**Lot Size:** ${lot} qty\n**Entry:** ₹${fmt(price)}\n**Stop Loss:** ₹${fmt(sl)}\n**Risk per Lot:** ₹${fmt(riskPerLot)}\n\n**Position Sizing Rule:**\n• Max 2% risk per trade\n• If capital = ₹1,00,000 → Max risk = ₹2,000\n• Max lots = ₹2,000 / ₹${fmt(riskPerLot)} = ${riskPerLot > 0 ? Math.floor(2000 / riskPerLot) : "—"} lots\n\n💡 Never risk more than 2% of capital on a single trade. This ensures you survive 50 consecutive losses.`;
    },
  },

  // ── Hello / help ──
  {
    patterns: [/^(hi|hello|hey|help|what can you do)/i, /^$/],
    handler: (ctx) => {
      return `👋 **Hi Sachin! I'm your SDM Trading Agent.**\n\nI can help you with:\n\n**Market Analysis:**\n• "What's the market trend?"\n• "What's the PCR?"\n• "Show me key levels"\n• "Where is max pain?"\n• "What's the VIX?"\n• "Show OI data"\n\n**Trading:**\n• "What's the best trade?"\n• "Give me a trade recommendation"\n• "Show today's trades"\n• "Show trade history"\n• "What are my open positions?"\n\n**Risk & Performance:**\n• "What's my win rate?"\n• "Show performance"\n• "Risk management guide"\n• "What's my stop loss?"\n\n**Timing:**\n• "What session is it?"\n• "Is it expiry?"\n• "Any gamma blast?"\n\nJust type naturally — I'll understand! 🎯`;
    },
  },

  // ── Fallback ──
  {
    patterns: [/.+/],
    handler: (ctx) => {
      const s = ctx.analysis?.sentiment || "neutral";
      const emoji = sentimentEmoji(s);
      return `${emoji} I'm not sure what you're asking, but here's what I know about **${ctx.symbol}** right now:\n\n**Sentiment:** ${s.toUpperCase()}\n**PCR:** ${ctx.analysis?.pcr?.toFixed(2) || "—"}\n**Spot:** ₹${fmt(ctx.spotPrice)}\n**Max Pain:** ₹${fmt(ctx.analysis?.maxPain)}\n\nTry asking about:\n• Market trend, PCR, key levels, max pain\n• Best trade, today's trades, trade history\n• VIX, OI data, gamma, session, risk\n• Win rate, performance, expiry`;
    },
  },
];

// ─── Main Agent Function ──────────────────────────────────────────
export function agentRespond(ctx: AgentContext, query: string): string {
  const q = query.trim();
  if (!q) return intents[intents.length - 1].handler(ctx, null);

  for (const intent of intents) {
    for (const pattern of intent.patterns) {
      const match = q.match(pattern);
      if (match) return intent.handler(ctx, match);
    }
  }

  return intents[intents.length - 1].handler(ctx, null);
}
