// Standalone test: verify every strategy's trade alert reaches Telegram.
// Run:  bun --env-file=.env src/lib/__tests__/telegram-all-strategies.ts
process.env.TELEGRAM_ALLOW_OFFHOURS = "1";

import { sendTelegramMessage } from "../telegramSend";

const chatIds = (process.env.TELEGRAM_DIGEST_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (process.env.TELEGRAM_CHAT_ID) chatIds.push(process.env.TELEGRAM_CHAT_ID);
const uniq = [...new Set(chatIds)];

if (uniq.length === 0) {
  console.error("NO TELEGRAM CHAT IDS CONFIGURED");
  process.exit(1);
}

function band(score: number) {
  if (score >= 70) return { e: "🟢", l: "A+ Institutional Setup" };
  if (score >= 65) return { e: "🟢", l: "High Probability" };
  if (score >= 60) return { e: "🟡", l: "Good Setup" };
  if (score >= 55) return { e: "🟠", l: "Watchlist / Aggressive" };
  return { e: "⚪", l: "Below Threshold" };
}
const ts = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

const messages: Record<string, string> = {
  "SMC (Smart Money)": `${band(78).e} ${band(78).l} (78%)
🧠 SMC — NIFTY
🟢 BUY CE | NIFTY 24800
Entry: ₹42.10
Stop: ₹28.40
Target 1: ₹58.20
Target 2: ₹72.50
R:R 1:2.1
Confidence: 78%
OB+FVG confluence @ 24780 · BOS confirmed
⏰ ${ts()}`,

  "ZERO_HERO (Zero Hero AI)": `${band(72).e} ${band(72).l} (72%)
⚡ NIFTY
🟢 BUY CE | NIFTY 24800
Entry: ₹42.10
Stop: ₹29.50
Target 1: ₹57.80
Target 2: ₹71.30
R:R 1:1.9
Stars: ⭐⭐⭐⭐
OI Chg: +1,24,000 | IV: 14.2% | Δ: 0.52
⏰ ${ts()}`,

  "INTRADAY (SDM / Stock Option)": `${band(81).e} ${band(81).l} (81%)
📊 STOCK OPTION — RELIANCE
🟢 BUY CE | RELIANCE 3000
📅 Monthly Expiry: 25JUL
💰 Premium: ₹18.40
🛑 Stop Loss: ₹12.10
🎯 T1 ₹24.60 | T2 ₹30.20
📐 R:R 1:2.0
📈 Bullish | RVOL 2.3x · EMA bullish
⏰ ${ts()}`,

  "BTST (Buy Today Sell Tomorrow)": `🔵 *BTST Alert — INFY*
${band(74).e} ${band(74).l} (74%)
Grade: A | Conf: 74%
Entry ₹1820.50 | SL ₹1785.00 | TP1 ₹1890.00
R:R 2.0 | Gap Risk: Medium
Trend: Bullish | Sector: IT - Strong
_Holding: 1 Day_`,
};

async function main() {
  let allOk = true;
  for (const [name, text] of Object.entries(messages)) {
    try {
      const results = await Promise.all(uniq.map((id) => sendTelegramMessage(id, text)));
      const ok = results.some(Boolean);
      console.log(`${ok ? "✅" : "❌"} ${name} → delivered to ${results.filter(Boolean).length}/${uniq.length} chat(s)`);
      if (!ok) allOk = false;
    } catch (e: any) {
      console.log(`❌ ${name} → error: ${e?.message}`);
      allOk = false;
    }
  }
  console.log(allOk ? "\nALL STRATEGY TELEGRAM SENDS OK" : "\nSOME TELEGRAM SENDS FAILED");
  process.exit(allOk ? 0 : 1);
}
main();
