import { sendTradeAlert } from "@/lib/telegram";

const testAlert = {
  symbol: "TESTSTK",
  action: "BUY",
  strike: 100,
  type: "CE",
  entry: 100,
  stopLoss: 80,
  tp1: 150,
  tp2: 175,
  tp3: 200,
  confidence: 75,
  spot: 100,
  expiry: "2026-11-20",
  source: "test-script",
};

async function main() {
  const r1 = await sendTradeAlert(testAlert);
  console.log("1:", r1.sent ? "sent" : "blocked");
  const r2 = await sendTradeAlert(testAlert);
  console.log("2:", r2.sent ? "sent" : "duplicate/blocked");
}

main().catch((e) => console.error("fatal:", e.message));
