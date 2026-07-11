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
  correlation?: any;
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

  // ── Greeks questions ──
  {
    patterns: [/greek/i, /delta/i, /gamma/i, /theta/i, /vega/i, /iv\b/i, /implied\s*vol/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "📊 Greeks data loading...";
      return `📊 **Greeks Analysis — ${ctx.symbol}**\n\n**Delta:** Measures how much option moves when stock moves ₹1\n• ATM Delta ≈ 0.50\n• High delta = more responsive\n\n**Gamma:** How fast Delta changes\n• Highest for ATM options near expiry\n• High gamma = big swings\n\n**Theta:** Time decay (your ENEMY when buying)\n• Option loses value each day\n• Theta accelerates near expiry\n• Buy options with MORE days left\n\n**Vega:** Sensitivity to volatility\n• High IV = expensive options\n• After events: IV crashes (IV crush)\n\n💡 **Rule:** Buy when IV is LOW (<30th percentile). Sell when IV is HIGH (>70th percentile).`;
    },
  },

  // ── Strategy questions ──
  {
    patterns: [/strateg/i, /which.*trade/i, /what.*trade/i, /best.*setup/i, /setup/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      const s = a?.sentiment || "neutral";
      let rec = "";
      if (s === "bullish") {
        rec = "• **Long Call** — Buy ATM CE if bullish\n• **Bull Call Spread** — Buy lower CE + Sell higher CE (cheaper)\n• **Bull Put Spread** — Sell OTM PE + Buy lower PE";
      } else if (s === "bearish") {
        rec = "• **Long Put** — Buy ATM PE if bearish\n• **Bear Put Spread** — Buy higher PE + Sell lower PE (cheaper)\n• **Bear Call Spread** — Sell OTM CE + Buy higher CE";
      } else {
        rec = "• **Iron Condor** — Sell both sides if range-bound\n• **Straddle** — Buy both sides if big move expected\n• Wait for clearer direction before entering";
      }
      return `🎯 **Strategy Guide — ${ctx.symbol}**\n\n**Current Sentiment:** ${s.toUpperCase()}\n\n**Best strategies for ${s} market:**\n${rec}\n\n**Always remember:**\n• Risk max 2% per trade\n• Set SL before entering\n• Minimum 1:2 risk:reward\n• Close by 3:15 PM on expiry`;
    },
  },

  // ── Entry / exit questions ──
  {
    patterns: [/entry/i, /enter/i, /should.*buy/i, /should.*sell/i, /exit/i, /close/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "📊 Loading market data...";
      const r = a.recommendation || {};
      return `⚡ **Entry Check — ${ctx.symbol}**\n\n**Action:** ${r.action || "WAIT"}\n**Strike:** ₹${r.strike || "—"} ${r.optionType || ""}\n**Entry:** ₹${r.entryPrice || "—"}\n**Stop Loss:** ₹${r.stopLoss || "—"}\n**Target:** ₹${r.target1 || "—"}\n**Confidence:** ${r.confidence || 0}%\n\n**Entry Rules:**\n• Only enter if confidence > 85%\n• SL must be set BEFORE entering\n• Max 2% risk per trade\n• If SL hits on trade #1, NO trade #2\n\n💡 If confidence < 85%, the answer is NO TRADE.`;
    },
  },

  // ── OI questions ──
  {
    patterns: [/oi\b/i, /open\s*interest/i, /buildup/i, /call.*oi/i, /put.*oi/i, /pcr/i],
    handler: (ctx) => {
      const a = ctx.analysis;
      if (!a) return "📊 OI data loading...";
      return `📊 **OI Analysis — ${ctx.symbol}**\n\n**Total Call OI:** ${fmt(a.totalCallOI)} | **Total Put OI:** ${fmt(a.totalPutOI)}\n**PCR:** ${a.pcr?.toFixed(2) || "—"}\n**Max Pain:** ₹${fmt(a.maxPain)}\n**ATM Strike:** ₹${fmt(ctx.analysis?.atmStrike)}\n\n**How to read OI:**\n• PCR > 1.2 = Bullish (more puts = protection buying)\n• PCR < 0.8 = Bearish (more calls = bearish bets)\n• PCR 0.8-1.2 = Neutral\n\n**OI Build-up:**\n• Price ↑ + OI ↑ = Long Build-up (bullish)\n• Price ↓ + OI ↑ = Short Build-up (bearish)\n• Price ↑ + OI ↓ = Short Covering (bullish)\n• Price ↓ + OI ↓ = Long Unwinding (bearish)`;
    },
  },

  // ── Risk / position sizing ──
  {
    patterns: [/risk/i, /position\s*size/i, /lot\s*size/i, /how\s*much/i, /capital/i, /stop\s*loss/i, /sl\b/i],
    handler: (ctx) => {
      const lotSizes: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };
      const lot = lotSizes[ctx.symbol] || 65;
      const price = ctx.analysis?.recommendation?.entryPrice || 70;
      const sl = ctx.analysis?.recommendation?.stopLoss || 45;
      const riskPerLot = Math.abs(price - sl) * lot;
      const capital = 100000;
      const maxRisk = capital * 0.02;
      const lots = riskPerLot > 0 ? Math.floor(maxRisk / riskPerLot) : 0;

      return `🛡️ **Risk Management — ${ctx.symbol}**\n\n**Lot Size:** ${lot} qty\n**Entry:** ₹${fmt(price)} | **SL:** ₹${fmt(sl)}\n**Risk per Lot:** ₹${fmt(riskPerLot)}\n\n**Position Sizing (₹1L capital):**\n• Max risk = ₹1,00,000 × 2% = ₹2,000\n• Lots = ₹2,000 ÷ ₹${fmt(riskPerLot)} = ${lots} lots\n• Max loss = ₹${fmt(riskPerLot * lots)}\n\n**Stop Loss Rule:**\n• SL = Entry × 0.65 (lose 35% max)\n• Or SL = Entry - (1.5 × ATR)\n• ALWAYS set SL before entering\n\n**Take Profit Rule:**\n• TP = Entry + (Risk × 2) → min 1:2 R:R\n• Example: Buy ₹100, SL ₹65 → TP ₹170\n\n💡 Never risk more than 2% of capital per trade.`;
    },
  },

  // ── Correlation questions ──
  {
    patterns: [/correlat/i, /nifty.*sensex/i, /sensex.*nifty/i],
    handler: (ctx) => {
      const corr = ctx.correlation;
      if (corr && corr.success) {
        const sig = corr.signal;
        const icon = sig === "TRADE" ? "⚡" : sig === "WATCH" ? "👀" : "💤";
        return `📊 **Nifty-Sensex Correlation**\n\n${icon} **Signal: ${sig}**\n\n**Prices:**\n• Nifty: ₹${corr.niftyPrice?.toLocaleString("en-IN")}\n• Sensex: ₹${corr.sensexPrice?.toLocaleString("en-IN")}\n\n**Correlation:**\n• Overall: ${corr.overallCorrelation?.toFixed(4)}\n• 5-day: ${corr.last5dCorrelation?.toFixed(4)} (${corr.last5dCorrelation >= 0.97 ? "🔒 Locked" : corr.last5dCorrelation >= 0.94 ? "📊 Normal" : corr.last5dCorrelation >= 0.90 ? "⚠️ Drifting" : "🔴 Fighting"})\n• 20-day: ${corr.last20dCorrelation?.toFixed(4)}\n\n**Beta:** ${corr.beta?.toFixed(3)} (Sensex +1% → Nifty +${corr.beta?.toFixed(3)}%)\n\n**Today's Gap:** ${corr.todayReturnDiff > 0 ? "+" : ""}${corr.todayReturnDiff?.toFixed(3)}% (normal: ±${corr.diffStd?.toFixed(3)}%)\n\n**Action:** ${corr.action}\n**Reason:** ${corr.reason}\n\n${corr.tip ? `💡 ${corr.tip}` : ""}`;
      }
      return `📊 **Nifty-Sensex Correlation**\n\nUse the **Corr** tab for live correlation analysis.\n\n**What it tells you:**\n• When Nifty & Sensex move together (correlation > 0.97)\n• When they drift apart (correlation < 0.94) — trade the comeback\n• Beta: If Sensex +1%, how much does Nifty move\n\n**Signal:**\n• Correlation < 0.94 + gap > 0.15% = TRADE\n• Buy the one BEHIND, sell the one AHEAD\n• Hold 1-3 days until correlation returns to 0.97+`;
    },
  },

  // ── Hello / help ──
  {
    patterns: [/^(hi|hello|hey|help|what can you do)/i, /^$/],
    handler: (ctx) => {
      return `👋 **Hi! I'm SDM — Your SDM Trading AI.**\n\nI know EVERYTHING about options trading. Ask me:\n\n**📊 Market:** "What's the trend?", "PCR?", "Max pain?", "VIX?"\n**🎯 Trade:** "Best trade?", "Entry check?", "SDM signal?"\n**📈 Greeks:** "Explain Delta", "What is Theta?", "IV?"\n**📋 Strategy:** "Which strategy?", "Iron Condor?", "Straddle?"\n**🛡️ Risk:** "Position sizing?", "Stop loss formula?"\n**📊 OI:** "OI buildup?", "PCR meaning?"\n**🔗 Correlation:** "Nifty vs Sensex?"\n\nI can explain like you're 5 years old or give professional analysis. Just ask! 💡`;
    },
  },

  // ── Fallback — always use live data ──
  {
    patterns: [/.+/],
    handler: (ctx) => {
      const a = ctx.analysis;
      const s = a?.sentiment || "neutral";
      const emoji = sentimentEmoji(s);
      const r = a?.recommendation || {};
      const pcr = a?.pcr?.toFixed(3) || "—";
      const mp = fmt(a?.maxPain);
      const spot = fmt(ctx.spotPrice);
      const atm = fmt(a?.atmStrike);

      let action = "WAIT";
      let strikeInfo = "";
      if (r.action && r.action !== "WAIT") {
        action = r.action;
        strikeInfo = `**Action:** ${r.action} ${r.direction || ""} ${r.optionType || ""}\n**Strike:** ₹${fmt(r.strike)}\n**Entry:** ₹${fmt(r.entryPrice)}\n**SL:** ₹${fmt(r.stopLoss)} | **T1:** ₹${fmt(r.tp1)} | **T2:** ₹${fmt(r.tp2)}\n**Confidence:** ${fmt(r.confidence)}%`;
      }

      const ceOI = fmt(a?.totalCallOI);
      const peOI = fmt(a?.totalPutOI);

      return `${emoji} **${ctx.symbol} Live Market Data**\n\n**Sentiment:** ${s.toUpperCase()}\n**Spot:** ₹${spot} | **ATM:** ₹${atm}\n**PCR:** ${pcr} | **Max Pain:** ₹${mp}\n**Call OI:** ${ceOI} | **Put OI:** ${peOI}\n\n${strikeInfo ? `🎯 **SDM Recommendation:**\n${strikeInfo}\n\n` : ""}**Ask me about:**\n• "Best trade right now?" — full recommendation\n• "Market trend?" — trend analysis\n• "OI buildup?" — open interest details\n• "Greeks?" — delta/gamma/theta/vega\n• "Stop loss?" — exit strategy\n• "Strategy?" — which setup to use\n• "Position sizing?" — risk management`;
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
